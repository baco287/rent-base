// Befehl 29: Verwaltung der Miettarife (nur OWNER – die Server Actions prüfen die Rolle, die Datenbank Mandant und Historie).
//
// - Tarif = Stammdaten (Name, Code, Beschreibung, aktiv, Reihenfolge) + unveränderliche Revisionen (Inhalt).
// - Inhaltsänderung = neue Revision unter Tarifsperre (FOR UPDATE); identischer Inhalt erzeugt keine Revision (Doppelklick).
//   Wer auf einem veralteten Stand speichert (andere Revision inzwischen aktuell), bekommt eine klare Meldung statt zu überschreiben.
// - Standardtarif je Fahrzeuggruppe: VehicleGroup.defaultRatePlanId (höchstens einer per Konstruktion; DB prüft aktiv/zugeordnet).
// - Fahrzeugabweichung: nur abweichende Stufen (+ optional Kaution/km), Änderung unter Tarifsperre, Audit alt/neu.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError } from "@/lib/integrity";
import { fmtCents } from "@/lib/money";
import { isUniqueViolation } from "@/lib/numbering";
import { normalizeTiers, tierLabel, type TierDef } from "@/lib/pricing";
import { checkKmRule, kmRuleText, type KmRule } from "@/lib/tariffs";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };

export type GroupContent = {
  groupId: string;
  tiers: TierDef[];
  /** optional abweichend für diese Gruppe (null = wie Tarif) */
  depositCents: number | null;
  km: KmRule | null;
};
export type TariffContent = { km: KmRule; depositCents: number; groups: GroupContent[] };
export type TariffMeta = { name: string; code: string | null; description: string | null; sortOrder: number };

const MAX_CENTS = 100_000_000;
const MAX_DEPOSIT = 10_000_000;

function checkMeta(m: TariffMeta): TariffMeta {
  const name = (m.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > 60) throw new DomainError("Bitte einen Tarifnamen mit 1 bis 60 Zeichen angeben.");
  const code = (m.code ?? "").trim() || null;
  if (code && code.length > 30) throw new DomainError("Interner Code: höchstens 30 Zeichen.");
  const description = (m.description ?? "").trim() || null;
  if (description && description.length > 500) throw new DomainError("Beschreibung: höchstens 500 Zeichen.");
  const sortOrder = Number.isInteger(m.sortOrder) ? Math.max(-9999, Math.min(9999, m.sortOrder)) : 0;
  return { name, code, description, sortOrder };
}

function checkDeposit(c: number, label: string) {
  if (!Number.isInteger(c) || c < 0 || c > MAX_DEPOSIT) throw new DomainError(`${label}: bitte einen Betrag ab 0,00 € angeben.`);
  return c;
}

/** Prüft und normalisiert den Inhalt (Stufen je Gruppe in Cent, keine doppelte Dauer, km widerspruchsfrei, nichts negativ). */
export function checkContent(c: TariffContent): TariffContent {
  const km = checkKmRule(c.km, "Kilometer des Tarifs");
  const depositCents = checkDeposit(c.depositCents, "Kaution des Tarifs");
  const seen = new Set<string>();
  const groups = c.groups.map((g) => {
    if (seen.has(g.groupId)) throw new DomainError("Eine Fahrzeuggruppe ist doppelt zugeordnet.");
    seen.add(g.groupId);
    let tiers: TierDef[];
    try {
      tiers = normalizeTiers(g.tiers);
    } catch (e) {
      throw new DomainError(e instanceof Error ? e.message : "Ungültige Preisstufen.");
    }
    for (const t of tiers) {
      if (t.days > 3650) throw new DomainError("Eine Preisstufe darf höchstens 3.650 Tage umfassen.");
      if (t.cents > MAX_CENTS) throw new DomainError(`Preis für ${tierLabel(t.days)} ist unplausibel hoch.`);
      if (t.label && t.label.length > 40) throw new DomainError("Bezeichnung einer Preisstufe: höchstens 40 Zeichen.");
    }
    return {
      groupId: g.groupId,
      tiers: tiers.map((t) => ({ days: t.days, cents: t.cents, ...(t.label?.trim() ? { label: t.label.trim() } : {}) })),
      depositCents: g.depositCents == null ? null : checkDeposit(g.depositCents, "Kaution der Fahrzeuggruppe"),
      km: g.km ? checkKmRule(g.km, "Kilometer der Fahrzeuggruppe") : null,
    };
  });
  return { km, depositCents, groups: groups.sort((a, b) => a.groupId.localeCompare(b.groupId)) };
}

const canon = (c: TariffContent) => JSON.stringify(checkContent(c));

async function assertGroupsOfTenant(tx: Tx, tenantId: string, groupIds: string[]) {
  if (groupIds.length === 0) return;
  const n = await tx.vehicleGroup.count({ where: { tenantId, id: { in: groupIds } } });
  if (n !== new Set(groupIds).size) throw new DomainError("Fahrzeuggruppe nicht gefunden.");
}

async function lockPlan(tx: Tx, tenantId: string, ratePlanId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "RatePlan" WHERE "id" = ${ratePlanId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (rows.length === 0) throw new DomainError("Miettarif nicht gefunden.");
  return tx.ratePlan.findUniqueOrThrow({ where: { id: ratePlanId } });
}

/** Aktueller Inhalt eines Tarifs (aus der aktuellen Revision) – Grundlage für Vergleich und Editor. */
export async function currentContent(client: Tx | typeof db, tenantId: string, revisionId: string | null): Promise<TariffContent | null> {
  if (!revisionId) return null;
  const r = await client.ratePlanRevision.findFirst({ where: { id: revisionId, tenantId }, include: { groups: { include: { tiers: { orderBy: { durationDays: "asc" } } } } } });
  if (!r) return null;
  const km = (src: { kmPolicy: string | null; kmIncludedPerDay: number | null; extraKmRateCents: number | null }): KmRule => ({ policy: src.kmPolicy as KmRule["policy"], kmIncludedPerDay: src.kmIncludedPerDay, extraKmRateCents: src.extraKmRateCents });
  return {
    km: km(r),
    depositCents: r.depositCents,
    groups: r.groups.map((g) => ({ groupId: g.groupId, tiers: g.tiers.map((t) => ({ days: t.durationDays, cents: t.priceCents, ...(t.label ? { label: t.label } : {}) })), depositCents: g.depositCents, km: g.kmPolicy ? km(g) : null })),
  };
}

async function insertRevision(tx: Tx, tenantId: string, ratePlanId: string, revision: number, content: TariffContent, actor: Actor, note: string | null) {
  const rev = await tx.ratePlanRevision.create({
    data: { tenantId, ratePlanId, revision, kmPolicy: content.km.policy, kmIncludedPerDay: content.km.kmIncludedPerDay, extraKmRateCents: content.km.extraKmRateCents, depositCents: content.depositCents, note, createdById: actor.id, createdByName: actor.name },
  });
  for (const g of content.groups) {
    await tx.ratePlanGroupPrice.create({
      data: {
        tenantId,
        revisionId: rev.id,
        groupId: g.groupId,
        depositCents: g.depositCents,
        kmPolicy: g.km?.policy ?? null,
        kmIncludedPerDay: g.km?.kmIncludedPerDay ?? null,
        extraKmRateCents: g.km?.extraKmRateCents ?? null,
        tiers: { create: g.tiers.map((t) => ({ tenantId, durationDays: t.days, priceCents: t.cents, label: t.label ?? null })) },
      },
    });
  }
  return rev;
}

const summary = (c: TariffContent, groupNames: Map<string, string>) =>
  [`Kilometer: ${kmRuleText(c.km)}`, `Kaution: ${fmtCents(c.depositCents)}`, ...c.groups.map((g) => `${groupNames.get(g.groupId) ?? "Gruppe"}: ${g.tiers.map((t) => `${t.label || tierLabel(t.days)} ${fmtCents(t.cents)}`).join(", ")}${g.depositCents != null ? `, Kaution ${fmtCents(g.depositCents)}` : ""}${g.km ? `, ${kmRuleText(g.km)}` : ""}`)].join(" | ").slice(0, 1500);

async function groupNamesOf(tx: Tx, tenantId: string) {
  return new Map((await tx.vehicleGroup.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((g) => [g.id, g.name]));
}

function nameConflict(e: unknown) {
  if (isUniqueViolation(e) || (e instanceof Error && /rb_rateplan_name_unique/.test(e.message))) return new DomainError("Ein Tarif mit diesem Namen existiert bereits.");
  if (e instanceof Error && /rb_rateplan_code_unique/.test(e.message)) return new DomainError("Dieser interne Code ist bereits vergeben.");
  return null;
}

/** Legt einen Tarif mit Revision 1 an. createKey (Formular-Nonce) verhindert doppelte Anlage bei Doppelklick. */
export async function createRatePlan(tenantId: string, actor: Actor, input: { meta: TariffMeta; content: TariffContent; active: boolean; createKey: string }): Promise<{ id: string; created: boolean }> {
  const meta = checkMeta(input.meta);
  const content = checkContent(input.content);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.createKey)) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const existing = await db.ratePlan.findFirst({ where: { tenantId, createKey: input.createKey }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };
  try {
    return await db.$transaction(async (tx) => {
      await assertGroupsOfTenant(tx, tenantId, content.groups.map((g) => g.groupId));
      const plan = await tx.ratePlan.create({ data: { tenantId, ...meta, active: false, createKey: input.createKey, createdById: actor.id, createdByName: actor.name, updatedById: actor.id, updatedByName: actor.name } });
      const rev = await insertRevision(tx, tenantId, plan.id, 1, content, actor, null);
      await tx.ratePlan.update({ where: { id: plan.id }, data: { currentRevisionId: rev.id, active: input.active } });
      const names = await groupNamesOf(tx, tenantId);
      await recordAudit(tx, tenantId, actor, { action: "RATE_PLAN_CREATED", details: { ratePlan: meta.name, code: meta.code, active: input.active, revision: 1, content: summary(content, names) } });
      for (const g of content.groups) await recordAudit(tx, tenantId, actor, { action: "RATE_PLAN_GROUP_ASSIGNED", details: { ratePlan: meta.name, group: names.get(g.groupId) ?? g.groupId, revision: 1 } });
      return { id: plan.id, created: true };
    }, TX);
  } catch (e) {
    if (isUniqueViolation(e, "createKey")) {
      const again = await db.ratePlan.findFirst({ where: { tenantId, createKey: input.createKey }, select: { id: true } });
      if (again) return { id: again.id, created: false };
    }
    throw nameConflict(e) ?? e;
  }
}

/**
 * Speichert einen geänderten Inhalt als neue Revision. expectedRevisionId = Revision, auf der der Editor beruhte; ist inzwischen
 * eine andere aktuell, wird nichts überschrieben. Identischer Inhalt → keine neue Revision (created=false).
 * Wird eine Gruppe entfernt, deren Standardtarif dies ist, wird der Standard dort aufgehoben (protokolliert).
 */
export async function reviseRatePlan(tenantId: string, actor: Actor, ratePlanId: string, input: { content: TariffContent; expectedRevisionId: string; note?: string | null }): Promise<{ revision: number; created: boolean }> {
  const content = checkContent(input.content);
  const note = (input.note ?? "").trim().slice(0, 300) || null;
  return db.$transaction(async (tx) => {
    const plan = await lockPlan(tx, tenantId, ratePlanId);
    if (plan.currentRevisionId !== input.expectedRevisionId) {
      const cur = plan.currentRevisionId ? await tx.ratePlanRevision.findUnique({ where: { id: plan.currentRevisionId }, select: { revision: true, createdByName: true } }) : null;
      throw new DomainError(`Der Tarif wurde inzwischen geändert (Revision ${cur?.revision ?? "?"}${cur?.createdByName ? ` von ${cur.createdByName}` : ""}). Bitte die Seite neu laden und die Änderung erneut eintragen.`);
    }
    const before = await currentContent(tx, tenantId, plan.currentRevisionId);
    const current = before ? await tx.ratePlanRevision.findUniqueOrThrow({ where: { id: plan.currentRevisionId! }, select: { revision: true } }) : { revision: 0 };
    if (before && canon(before) === canon(content)) return { revision: current.revision, created: false };
    await assertGroupsOfTenant(tx, tenantId, content.groups.map((g) => g.groupId));
    const names = await groupNamesOf(tx, tenantId);
    const kept = new Set(content.groups.map((g) => g.groupId));
    const removed = (before?.groups ?? []).filter((g) => !kept.has(g.groupId)).map((g) => g.groupId);
    const added = content.groups.filter((g) => !(before?.groups ?? []).some((b) => b.groupId === g.groupId)).map((g) => g.groupId);
    // Standard aufheben, wo die Gruppe nicht mehr zugeordnet ist (sonst verweigert die Datenbank die neue Revision)
    for (const gid of removed) {
      const cleared = await tx.vehicleGroup.updateMany({ where: { tenantId, id: gid, defaultRatePlanId: ratePlanId }, data: { defaultRatePlanId: null } });
      if (cleared.count > 0) await recordAudit(tx, tenantId, actor, { action: "RATE_PLAN_DEFAULT_SET", details: { group: names.get(gid) ?? gid, before: plan.name, after: null, reason: "Gruppe aus dem Tarif entfernt" } });
    }
    const rev = await insertRevision(tx, tenantId, ratePlanId, current.revision + 1, content, actor, note);
    await tx.ratePlan.update({ where: { id: ratePlanId }, data: { currentRevisionId: rev.id, updatedById: actor.id, updatedByName: actor.name } });
    await recordAudit(tx, tenantId, actor, { action: "RATE_PLAN_REVISED", details: { ratePlan: plan.name, revision: rev.revision, note, before: { content: before ? summary(before, names) : null }, after: { content: summary(content, names) } } });
    for (const gid of added) await recordAudit(tx, tenantId, actor, { action: "RATE_PLAN_GROUP_ASSIGNED", details: { ratePlan: plan.name, group: names.get(gid) ?? gid, revision: rev.revision } });
    for (const gid of removed) await recordAudit(tx, tenantId, actor, { action: "RATE_PLAN_GROUP_REMOVED", details: { ratePlan: plan.name, group: names.get(gid) ?? gid, revision: rev.revision } });
    return { revision: rev.revision, created: true };
  }, TX);
}

/** Stammdaten (Name, Code, Beschreibung, Reihenfolge) – kein Preisinhalt, daher keine Revision. Bestehende Buchungen tragen den Namen im Snapshot. */
export async function updateRatePlanMeta(tenantId: string, actor: Actor, ratePlanId: string, input: TariffMeta): Promise<{ changed: boolean }> {
  const meta = checkMeta(input);
  try {
    return await db.$transaction(async (tx) => {
      const plan = await lockPlan(tx, tenantId, ratePlanId);
      const before = { name: plan.name, code: plan.code, description: plan.description, sortOrder: plan.sortOrder };
      if (JSON.stringify(before) === JSON.stringify(meta)) return { changed: false };
      await tx.ratePlan.update({ where: { id: ratePlanId }, data: { ...meta, updatedById: actor.id, updatedByName: actor.name } });
      await recordAudit(tx, tenantId, actor, { action: "RATE_PLAN_UPDATED", details: { ratePlan: meta.name, before: { name: before.name, code: before.code, sortOrder: before.sortOrder }, after: { name: meta.name, code: meta.code, sortOrder: meta.sortOrder } } });
      return { changed: true };
    }, TX);
  } catch (e) {
    throw nameConflict(e) ?? e;
  }
}

/** Aktivieren/Deaktivieren. Ein deaktivierter Tarif bleibt historisch erhalten; als Standard eingetragene Gruppen verlieren den Standard. */
export async function setRatePlanActive(tenantId: string, actor: Actor, ratePlanId: string, active: boolean): Promise<{ changed: boolean }> {
  return db.$transaction(async (tx) => {
    const plan = await lockPlan(tx, tenantId, ratePlanId);
    if (plan.active === active) return { changed: false };
    if (active && !plan.currentRevisionId) throw new DomainError("Der Tarif hat noch keinen Inhalt.");
    if (!active) {
      const groups = await tx.vehicleGroup.findMany({ where: { tenantId, defaultRatePlanId: ratePlanId }, select: { id: true, name: true } });
      if (groups.length > 0) {
        await tx.vehicleGroup.updateMany({ where: { tenantId, defaultRatePlanId: ratePlanId }, data: { defaultRatePlanId: null } });
        for (const g of groups) await recordAudit(tx, tenantId, actor, { action: "RATE_PLAN_DEFAULT_SET", details: { group: g.name, before: plan.name, after: null, reason: "Tarif deaktiviert" } });
      }
    }
    await tx.ratePlan.update({ where: { id: ratePlanId }, data: { active, updatedById: actor.id, updatedByName: actor.name } });
    await recordAudit(tx, tenantId, actor, { action: active ? "RATE_PLAN_ACTIVATED" : "RATE_PLAN_DEACTIVATED", details: { ratePlan: plan.name } });
    return { changed: true };
  }, TX);
}

/** Standardtarif einer Fahrzeuggruppe setzen oder aufheben (null). Der Tarif muss aktiv und der Gruppe zugeordnet sein. */
export async function setGroupDefaultRatePlan(tenantId: string, actor: Actor, groupId: string, ratePlanId: string | null): Promise<{ changed: boolean }> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; defaultRatePlanId: string | null }[]>`SELECT "id", "defaultRatePlanId" FROM "VehicleGroup" WHERE "id" = ${groupId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("Fahrzeuggruppe nicht gefunden.");
    if (rows[0].defaultRatePlanId === ratePlanId) return { changed: false };
    let planName: string | null = null;
    if (ratePlanId) {
      // Tarif sperren, bevor „aktiv“ und Zuordnung geprüft werden: FOR KEY SHARE ist die Stufe, die das Setzen des Standards über den
      // Fremdschlüssel ohnehin nimmt. Deaktivieren und neue Revision (lockPlan, FOR UPDATE) laufen so vorher oder nachher, nie dazwischen.
      await tx.$queryRaw`SELECT "id" FROM "RatePlan" WHERE "id" = ${ratePlanId} AND "tenantId" = ${tenantId} FOR KEY SHARE`;
      const plan = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, select: { name: true, active: true, currentRevisionId: true } });
      if (!plan) throw new DomainError("Miettarif nicht gefunden.");
      if (!plan.active) throw new DomainError("Ein deaktivierter Tarif kann nicht Standardtarif sein.");
      const assigned = await tx.ratePlanGroupPrice.count({ where: { revisionId: plan.currentRevisionId ?? "", groupId } });
      if (!assigned) throw new DomainError("Der Tarif ist dieser Fahrzeuggruppe nicht zugeordnet.");
      planName = plan.name;
    }
    const before = rows[0].defaultRatePlanId ? (await tx.ratePlan.findUnique({ where: { id: rows[0].defaultRatePlanId }, select: { name: true } }))?.name ?? null : null;
    await tx.vehicleGroup.update({ where: { id: groupId }, data: { defaultRatePlanId: ratePlanId } });
    const group = await tx.vehicleGroup.findUniqueOrThrow({ where: { id: groupId }, select: { name: true } });
    await recordAudit(tx, tenantId, actor, { action: "RATE_PLAN_DEFAULT_SET", details: { group: group.name, before, after: planName } });
    return { changed: true };
  }, TX);
}

/** Kopie eines Tarifs (aktueller Inhalt) unter neuem Namen – inaktiv, damit sie erst nach Prüfung angeboten wird. */
export async function duplicateRatePlan(tenantId: string, actor: Actor, ratePlanId: string, input: { name: string; createKey: string }): Promise<{ id: string; created: boolean }> {
  const plan = await db.ratePlan.findFirst({ where: { id: ratePlanId, tenantId } });
  if (!plan) throw new DomainError("Miettarif nicht gefunden.");
  const content = await currentContent(db, tenantId, plan.currentRevisionId);
  if (!content) throw new DomainError("Der Tarif hat noch keinen Inhalt.");
  return createRatePlan(tenantId, actor, { meta: { name: input.name, code: null, description: plan.description, sortOrder: plan.sortOrder + 1 }, content, active: false, createKey: input.createKey });
}

// ---------------------------------------------------------------------------
// Fahrzeugabweichungen
// ---------------------------------------------------------------------------

export type VehicleOverrideInput = { tiers: { days: number; cents: number | null }[]; depositCents: number | null; km: KmRule | null; note: string | null };

function checkOverride(o: VehicleOverrideInput): VehicleOverrideInput {
  const seen = new Set<number>();
  const tiers = o.tiers.map((t) => {
    if (!Number.isInteger(t.days) || t.days < 1 || t.days > 3650) throw new DomainError("Die Dauer einer Preisstufe muss eine ganze Zahl über 0 sein.");
    if (seen.has(t.days)) throw new DomainError(`Die Dauer ${tierLabel(t.days)} ist doppelt vergeben.`);
    seen.add(t.days);
    if (t.cents != null && (!Number.isInteger(t.cents) || t.cents < 0 || t.cents > MAX_CENTS)) throw new DomainError(`Fahrzeugpreis für ${tierLabel(t.days)}: bitte einen Betrag ab 0,00 € angeben.`);
    return { days: t.days, cents: t.cents };
  }).sort((a, b) => a.days - b.days);
  const note = (o.note ?? "").trim().slice(0, 300) || null;
  return { tiers, depositCents: o.depositCents == null ? null : checkDeposit(o.depositCents, "Fahrzeugkaution"), km: o.km ? checkKmRule(o.km, "Fahrzeugkilometer") : null, note };
}

const overrideText = (o: VehicleOverrideInput | null) =>
  !o ? "keine" : [o.tiers.map((t) => `${tierLabel(t.days)} ${t.cents == null ? "nicht angeboten" : fmtCents(t.cents)}`).join(", "), o.depositCents != null ? `Kaution ${fmtCents(o.depositCents)}` : "", o.km ? kmRuleText(o.km) : ""].filter(Boolean).join(" | ").slice(0, 800);

/** Setzt/ändert die Abweichung eines Fahrzeugs für einen Tarif (leere Abweichung = entfernen). Unter Tarifsperre, Audit alt/neu. */
export async function setVehicleRateOverride(tenantId: string, actor: Actor, input: { vehicleId: string; ratePlanId: string } & VehicleOverrideInput): Promise<{ changed: boolean }> {
  const o = checkOverride(input);
  return db.$transaction(async (tx) => {
    const plan = await lockPlan(tx, tenantId, input.ratePlanId);
    const vehicle = await tx.vehicle.findFirst({ where: { id: input.vehicleId, tenantId }, select: { id: true, plate: true, groupId: true } });
    if (!vehicle) throw new DomainError("Fahrzeug nicht gefunden.");
    if (!vehicle.groupId || !(await tx.ratePlanGroupPrice.count({ where: { revisionId: plan.currentRevisionId ?? "", groupId: vehicle.groupId } }))) throw new DomainError(`Der Tarif „${plan.name}“ gilt nicht für die Fahrzeuggruppe dieses Fahrzeugs.`);
    const cur = await tx.vehicleRateOverride.findUnique({ where: { vehicleId_ratePlanId: { vehicleId: vehicle.id, ratePlanId: plan.id } }, include: { tiers: { orderBy: { durationDays: "asc" } } } });
    const before: VehicleOverrideInput | null = cur ? { tiers: cur.tiers.map((t) => ({ days: t.durationDays, cents: t.priceCents })), depositCents: cur.depositCents, km: cur.kmPolicy ? { policy: cur.kmPolicy as KmRule["policy"], kmIncludedPerDay: cur.kmIncludedPerDay, extraKmRateCents: cur.extraKmRateCents } : null, note: cur.note } : null;
    const empty = o.tiers.length === 0 && o.depositCents == null && !o.km;
    if (empty) {
      if (!cur) return { changed: false };
      await tx.vehicleRateOverride.delete({ where: { id: cur.id } });
      await recordAudit(tx, tenantId, actor, { action: "VEHICLE_RATE_OVERRIDE_REMOVED", details: { ratePlan: plan.name, vehicle: vehicle.plate, before: { override: overrideText(before) } } });
      return { changed: true };
    }
    if (before && JSON.stringify(checkOverride(before)) === JSON.stringify(o)) return { changed: false };
    const data = { depositCents: o.depositCents, kmPolicy: o.km?.policy ?? null, kmIncludedPerDay: o.km?.kmIncludedPerDay ?? null, extraKmRateCents: o.km?.extraKmRateCents ?? null, note: o.note, updatedById: actor.id, updatedByName: actor.name };
    const row = cur ? await tx.vehicleRateOverride.update({ where: { id: cur.id }, data }) : await tx.vehicleRateOverride.create({ data: { tenantId, vehicleId: vehicle.id, ratePlanId: plan.id, ...data } });
    if (cur) await tx.vehicleRateOverrideTier.deleteMany({ where: { overrideId: row.id } });
    if (o.tiers.length) await tx.vehicleRateOverrideTier.createMany({ data: o.tiers.map((t) => ({ tenantId, overrideId: row.id, durationDays: t.days, priceCents: t.cents })) });
    await recordAudit(tx, tenantId, actor, { action: "VEHICLE_RATE_OVERRIDE_SET", details: { ratePlan: plan.name, vehicle: vehicle.plate, before: { override: overrideText(before) }, after: { override: overrideText(o) } } });
    return { changed: true };
  }, TX);
}

// ---------------------------------------------------------------------------
// Lesen (Übersicht, Editor, Fahrzeug, Gruppe)
// ---------------------------------------------------------------------------

export async function listRatePlans(tenantId: string) {
  const plans = await db.ratePlan.findMany({
    where: { tenantId },
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    include: { currentRevision: { select: { revision: true, createdAt: true, kmPolicy: true, kmIncludedPerDay: true, extraKmRateCents: true, depositCents: true, groups: { select: { group: { select: { id: true, name: true } } } } } }, defaultForGroups: { select: { name: true } }, _count: { select: { bookings: true, vehicleOverrides: true } } },
  });
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code,
    description: p.description,
    active: p.active,
    revision: p.currentRevision?.revision ?? 0,
    updatedAt: p.currentRevision && p.currentRevision.createdAt > p.updatedAt ? p.currentRevision.createdAt : p.updatedAt,
    updatedByName: p.updatedByName,
    km: p.currentRevision ? ({ policy: p.currentRevision.kmPolicy, kmIncludedPerDay: p.currentRevision.kmIncludedPerDay, extraKmRateCents: p.currentRevision.extraKmRateCents } as KmRule) : null,
    depositCents: p.currentRevision?.depositCents ?? 0,
    groups: (p.currentRevision?.groups ?? []).map((g) => g.group.name).sort((a, b) => a.localeCompare(b, "de")),
    defaultFor: p.defaultForGroups.map((g) => g.name),
    bookings: p._count.bookings,
    vehicleOverrides: p._count.vehicleOverrides,
  }));
}

export async function ratePlanEditorState(tenantId: string, ratePlanId: string) {
  const plan = await db.ratePlan.findFirst({
    where: { id: ratePlanId, tenantId },
    include: {
      revisions: { orderBy: { revision: "desc" }, take: 30, select: { id: true, revision: true, createdAt: true, createdByName: true, note: true } },
      defaultForGroups: { select: { id: true } },
      vehicleOverrides: { include: { vehicle: { select: { id: true, plate: true, make: true, model: true } }, tiers: { orderBy: { durationDays: "asc" } } } },
      _count: { select: { bookings: true } },
    },
  });
  if (!plan) return null;
  const content = await currentContent(db, tenantId, plan.currentRevisionId);
  const groups = await db.vehicleGroup.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, defaultRatePlanId: true, _count: { select: { vehicles: true } } } });
  return { plan, content, groups, defaultGroupIds: plan.defaultForGroups.map((g) => g.id) };
}

/** Tarife und Preise eines Fahrzeugs: je Tarif der Gruppenpreis und die Fahrzeugabweichung. */
export async function vehicleRateView(tenantId: string, vehicleId: string) {
  const v = await db.vehicle.findFirst({ where: { id: vehicleId, tenantId }, select: { id: true, groupId: true, group: { select: { name: true, defaultRatePlanId: true } } } });
  if (!v?.groupId) return { groupName: v?.group?.name ?? null, rows: [] };
  const plans = await db.ratePlan.findMany({
    where: { tenantId, currentRevision: { groups: { some: { groupId: v.groupId } } } },
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    include: { currentRevision: { include: { groups: { where: { groupId: v.groupId }, include: { tiers: { orderBy: { durationDays: "asc" } } } } } }, vehicleOverrides: { where: { vehicleId }, include: { tiers: { orderBy: { durationDays: "asc" } } } } },
  });
  return {
    groupName: v.group?.name ?? null,
    rows: plans.map((p) => {
      const gp = p.currentRevision!.groups[0];
      const ov = p.vehicleOverrides[0] ?? null;
      return {
        ratePlanId: p.id,
        name: p.name,
        active: p.active,
        isDefault: v.group?.defaultRatePlanId === p.id,
        groupTiers: gp.tiers.map((t) => ({ days: t.durationDays, cents: t.priceCents, label: t.label })),
        override: ov ? { tiers: ov.tiers.map((t) => ({ days: t.durationDays, cents: t.priceCents })), depositCents: ov.depositCents, km: ov.kmPolicy ? ({ policy: ov.kmPolicy, kmIncludedPerDay: ov.kmIncludedPerDay, extraKmRateCents: ov.extraKmRateCents } as KmRule) : null, note: ov.note, updatedAt: ov.updatedAt, updatedByName: ov.updatedByName } : null,
      };
    }),
  };
}

/** Tarife einer Fahrzeuggruppe (aktuelle Revision) für die Gruppenansicht. */
export async function groupRatePlans(tenantId: string) {
  const plans = await db.ratePlan.findMany({ where: { tenantId }, orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, active: true, currentRevision: { select: { groups: { select: { groupId: true } } } } } });
  const byGroup = new Map<string, { id: string; name: string; active: boolean }[]>();
  for (const p of plans) for (const g of p.currentRevision?.groups ?? []) byGroup.set(g.groupId, [...(byGroup.get(g.groupId) ?? []), { id: p.id, name: p.name, active: p.active }]);
  return byGroup;
}
