// Schadenakten (Phase 12). Damage bleibt die objektive Schadensinformation aus Übergabe/Rückgabe/Hof; DamageCase ist die
// operative Akte: Prüfung, Haftung, Kosten, Reparatur, Dokumente, Kundenbelastung, Abschluss.
// Harte Regeln: Kein Schaden setzt automatisch eine Haftung. Keine Kostenangabe erzeugt eine Forderung. Erst eine
// ausdrücklich bestätigte Kundenverantwortung erlaubt „Schaden dem Kunden berechnen“; den Betrag bestimmt der Mitarbeiter.
// Eine offene Akte sperrt kein Fahrzeug; sperren und freigeben sind eigene Aktionen über den zentralen Fahrzeugstatus.
// Kaution, Zusatzkosten und Mietrechnung bleiben unberührt; es gibt keine automatische Verrechnung.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DAMAGE_CASE_PRIORITY, DAMAGE_CASE_STATUS, DAMAGE_CASE_TRANSITIONS, DAMAGE_TAX_NOTES, DAMAGE_TAX_TREATMENTS, LIABILITY_STATUS, type DamageCaseStatus, type DamageTaxTreatment } from "@/lib/constants";
import { balanceOf } from "@/lib/deposits";
import { DomainError } from "@/lib/integrity";
import { createDamageInvoiceDraft } from "@/lib/invoices";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation, nextDamageCaseNumber, withNumberRetry } from "@/lib/numbering";
import { summarizePayment } from "@/lib/payments";
import { recordVehicleEvent } from "@/lib/vehicle-events";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type CaseRow = Prisma.DamageCaseGetPayload<object>;

function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_(?:DOMAIN|IMMUTABLE): ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}

async function lockCase(tx: Tx, tenantId: string, caseId: string): Promise<CaseRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "DamageCase" WHERE "id" = ${caseId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Schadenakte nicht gefunden.");
  return tx.damageCase.findUniqueOrThrow({ where: { id: caseId } });
}

function event(tx: Tx, tenantId: string, caseId: string, actor: Actor | null, data: { type: string; fromValue?: string | null; toValue?: string | null; reason?: string | null; note?: string | null }) {
  return tx.damageCaseEvent.create({ data: { tenantId, caseId, type: data.type, fromValue: data.fromValue ?? null, toValue: data.toValue ?? null, reason: data.reason ?? null, note: data.note ?? null, userId: actor?.id ?? null, userName: actor?.name ?? null } });
}

const assertOpen = (c: CaseRow) => { if (c.status === "CLOSED") throw new DomainError(`Die Schadenakte ${c.caseNumber} ist geschlossen. Bitte zuerst wieder öffnen.`); };

// ---------------------------------------------------------------------------
// Eröffnen
// ---------------------------------------------------------------------------

/**
 * „Schadenakte eröffnen“ für einen dokumentierten Schaden. Genau eine Akte je Schaden (Index): Doppelklick und parallele
 * Mitarbeiter bekommen dieselbe Akte. Start immer OPEN / Haftung UNASSESSED – ein bei Rückgabe neuer Schaden heißt nur
 * „bei Rückgabe neu festgestellt“, nie „vom Mieter verursacht“.
 */
export async function openDamageCase(tenantId: string, damageId: string, actor: Actor): Promise<{ damageCase: CaseRow; created: boolean }> {
  const existing = await db.damageCase.findFirst({ where: { tenantId, damageId } });
  if (existing) return { damageCase: existing, created: false };
  try {
    const result = await withNumberRetry(() =>
      db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Damage" WHERE "id" = ${damageId} AND "tenantId" = ${tenantId} FOR UPDATE`;
        if (locked.length === 0) throw new DomainError("Schaden nicht gefunden.");
        const again = await tx.damageCase.findFirst({ where: { tenantId, damageId } });
        if (again) return { row: again, created: false };
        const d = await tx.damage.findUniqueOrThrow({ where: { id: damageId }, include: { discoveredIn: { select: { id: true, type: true, bookingId: true } } } });
        const returnHandoverId = d.discoveredIn?.type === "RETURN" ? d.discoveredIn.id : null;
        const bookingId = d.bookingId ?? (returnHandoverId ? d.discoveredIn!.bookingId : null);
        const caseNumber = await nextDamageCaseNumber(tx, tenantId);
        const created = await tx.damageCase.create({
          data: { tenantId, damageId, vehicleId: d.vehicleId, bookingId, returnHandoverId, caseNumber, reportedAt: d.discoveredAt, reportedById: actor.id, reportedByName: actor.name, description: d.description, priority: "NORMAL" },
        });
        await event(tx, tenantId, created.id, actor, { type: "CREATED", toValue: "OPEN", note: returnHandoverId ? "Bei Rückgabe neu festgestellt" : d.discoveredIn ? "Vorschaden aus Übergabeprotokoll" : "Auf dem Hof erfasst" });
        await recordAudit(tx, tenantId, actor, { action: "DAMAGE_CASE_CREATED", bookingId, details: { caseNumber, damageId, vehicleId: d.vehicleId } });
        return { row: created, created: true };
      }, TX),
    );
    return { damageCase: result.row, created: result.created };
  } catch (e) {
    if (isUniqueViolation(e, "damageId")) {
      const winner = await db.damageCase.findFirst({ where: { tenantId, damageId } });
      if (winner) return { damageCase: winner, created: false };
    }
    return domainFromDb(e);
  }
}

// ---------------------------------------------------------------------------
// Status, Priorität, Haftung, Kosten, Reparatur, Notizen
// ---------------------------------------------------------------------------

/**
 * Der Fahrzeugschaden (Damage) führt den Reparaturstand für Fahrzeugakte und künftige Protokolle. Die Schadenakte
 * spiegelt die Reparaturphasen dorthin; Protokollkopien (HandoverDamage) bleiben davon unberührt.
 */
async function mirrorDamageStatus(tx: Tx, tenantId: string, c: CaseRow, to: string, actor: Actor, note?: string | null) {
  const map: Record<string, string> = { REPAIR_PLANNED: "REPAIR_PLANNED", IN_REPAIR: "IN_REPAIR", REPAIRED: "REPAIRED" };
  const target = map[to];
  if (!target) return;
  const damage = await tx.damage.findFirst({ where: { id: c.damageId, tenantId } });
  if (!damage || damage.status === target) return;
  const repairedNow = target === "REPAIRED" && damage.status !== "REPAIRED";
  await tx.damage.update({ where: { id: damage.id }, data: { status: target, repairedAt: target === "REPAIRED" ? damage.repairedAt ?? new Date() : null } });
  if (repairedNow) await recordVehicleEvent(tx, { tenantId, vehicleId: damage.vehicleId, type: "DAMAGE_REPAIRED", damageId: damage.id, bookingId: damage.bookingId, actor, description: note?.trim() || `Schadenakte ${c.caseNumber}: repariert` });
}

/** Statuswechsel nur entlang der zentralen Übergangstabelle. Schließen und Wiederöffnen sind eigene Aktionen mit Grund. */
export async function changeCaseStatus(tenantId: string, caseId: string, actor: Actor, to: string, note?: string | null): Promise<CaseRow> {
  if (!(to in DAMAGE_CASE_STATUS) || to === "CLOSED") throw new DomainError("Ungültiger Zielstatus.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    assertOpen(c);
    const allowed = DAMAGE_CASE_TRANSITIONS[c.status as DamageCaseStatus] ?? [];
    if (!allowed.includes(to as DamageCaseStatus)) throw new DomainError(`Von „${DAMAGE_CASE_STATUS[c.status as DamageCaseStatus]}“ ist kein Wechsel nach „${DAMAGE_CASE_STATUS[to as DamageCaseStatus]}“ vorgesehen.`);
    const updated = await tx.damageCase.update({ where: { id: c.id }, data: { status: to, ...(to === "REPAIRED" && !c.repairCompletedAt ? { repairCompletedAt: new Date() } : {}) } });
    await mirrorDamageStatus(tx, tenantId, c, to, actor, note);
    await event(tx, tenantId, c.id, actor, { type: "STATUS_CHANGED", fromValue: c.status, toValue: to, note: note?.trim() || null });
    await recordAudit(tx, tenantId, actor, { action: "DAMAGE_CASE_STATUS_CHANGED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, from: c.status, to } });
    return updated;
  }, TX);
}

export async function setCasePriority(tenantId: string, caseId: string, actor: Actor, priority: string): Promise<CaseRow> {
  if (!(priority in DAMAGE_CASE_PRIORITY)) throw new DomainError("Ungültige Priorität.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    assertOpen(c);
    if (c.priority === priority) return c;
    const updated = await tx.damageCase.update({ where: { id: c.id }, data: { priority } });
    await event(tx, tenantId, c.id, actor, { type: "NOTE_ADDED", note: `Priorität: ${DAMAGE_CASE_PRIORITY[c.priority as keyof typeof DAMAGE_CASE_PRIORITY]} → ${DAMAGE_CASE_PRIORITY[priority as keyof typeof DAMAGE_CASE_PRIORITY]}` });
    return updated;
  }, TX);
}

/**
 * Haftungsentscheidung – ausdrücklich durch einen berechtigten Mitarbeiter. „Kunde verantwortlich“ nur mit Begründung.
 * Nach einer festgelegten Kundenbelastung ist die Haftung nicht mehr änderbar (DB-Regel); Korrekturen laufen über die Abrechnung.
 */
export async function setLiability(tenantId: string, caseId: string, actor: Actor, status: string, note?: string | null): Promise<CaseRow> {
  if (!(status in LIABILITY_STATUS)) throw new DomainError("Ungültiger Haftungsstatus.");
  const why = note?.trim() || null;
  if (status === "CUSTOMER_RESPONSIBILITY_CONFIRMED" && (!why || why.length < 3)) throw new DomainError("Bitte die Haftungsentscheidung begründen (Pflicht bei „Kunde verantwortlich“).");
  try {
    return await db.$transaction(async (tx) => {
      const c = await lockCase(tx, tenantId, caseId);
      assertOpen(c);
      if (c.customerChargeCents != null && status !== "CUSTOMER_RESPONSIBILITY_CONFIRMED") throw new DomainError("Zu dieser Akte wurde bereits eine Kundenbelastung festgelegt. Die Haftung kann nicht mehr geändert werden; Korrekturen laufen über die Schadenabrechnung.");
      const updated = await tx.damageCase.update({ where: { id: c.id }, data: { liabilityStatus: status, liabilityNote: why } });
      await event(tx, tenantId, c.id, actor, { type: "LIABILITY_CHANGED", fromValue: c.liabilityStatus, toValue: status, reason: why });
      await recordAudit(tx, tenantId, actor, { action: "DAMAGE_LIABILITY_CHANGED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, from: c.liabilityStatus, to: status, reason: why } });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

function parseCost(v: string | number | null | undefined, what: string): Cents | null {
  if (v == null || String(v).trim() === "") return null;
  let cents: Cents;
  try {
    cents = toCents(v);
  } catch {
    throw new DomainError(`${what}: bitte einen gültigen Betrag eingeben (z. B. 1.250,00).`);
  }
  if (cents < 0) throw new DomainError(`${what} darf nicht negativ sein.`);
  if (cents > 100_000_000_00) throw new DomainError(`${what} ist unplausibel hoch.`);
  return cents;
}

/** Kostenschätzung und tatsächliche Reparaturkosten: reine Information, erzeugen nie Forderung, Rechnung, Zahlung oder Kautionsbewegung. */
export async function setCaseCosts(tenantId: string, caseId: string, actor: Actor, input: { estimated?: string | number | null; actual?: string | number | null }): Promise<CaseRow> {
  const estimated = input.estimated === undefined ? undefined : parseCost(input.estimated, "Die Kostenschätzung");
  const actual = input.actual === undefined ? undefined : parseCost(input.actual, "Die tatsächlichen Reparaturkosten");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    assertOpen(c);
    const data: Prisma.DamageCaseUpdateInput = {};
    const changes: string[] = [];
    if (estimated !== undefined && estimated !== c.estimatedCostCents) { data.estimatedCostCents = estimated; changes.push(`Schätzung ${c.estimatedCostCents == null ? "–" : fmtCents(c.estimatedCostCents)} → ${estimated == null ? "–" : fmtCents(estimated)}`); }
    if (actual !== undefined && actual !== c.actualCostCents) { data.actualCostCents = actual; changes.push(`Reparaturkosten ${c.actualCostCents == null ? "–" : fmtCents(c.actualCostCents)} → ${actual == null ? "–" : fmtCents(actual)}`); }
    if (changes.length === 0) return c;
    const updated = await tx.damageCase.update({ where: { id: c.id }, data });
    await event(tx, tenantId, c.id, actor, { type: "COST_CHANGED", note: changes.join("; ") });
    await recordAudit(tx, tenantId, actor, { action: "DAMAGE_COST_CHANGED", bookingId: c.bookingId, amountCents: actual ?? estimated ?? null, details: { caseNumber: c.caseNumber, estimated: estimated ?? c.estimatedCostCents ?? null, actual: actual ?? c.actualCostCents ?? null } });
    return updated;
  }, TX);
}

export async function setCaseRepair(tenantId: string, caseId: string, actor: Actor, input: { provider?: string | null; appointmentAt?: Date | null; completedAt?: Date | null }): Promise<CaseRow> {
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    assertOpen(c);
    const updated = await tx.damageCase.update({ where: { id: c.id }, data: { repairProviderName: input.provider?.trim() || null, repairAppointmentAt: input.appointmentAt ?? null, repairCompletedAt: input.completedAt ?? null } });
    await event(tx, tenantId, c.id, actor, { type: "REPAIR_CHANGED", note: [input.provider?.trim() ? `Werkstatt: ${input.provider.trim()}` : null, input.appointmentAt ? `Termin: ${input.appointmentAt.toISOString()}` : null, input.completedAt ? `Fertig: ${input.completedAt.toISOString()}` : null].filter(Boolean).join("; ") || "Reparaturdaten geleert" });
    return updated;
  }, TX);
}

/** Operative Notiz (auch Hofmitarbeiter): landet nur in der Historie, nie auf Kundenunterlagen. */
export async function addCaseNote(tenantId: string, caseId: string, actor: Actor, note: string) {
  const text = note.trim();
  if (text.length < 2) throw new DomainError("Bitte eine Notiz eingeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    return event(tx, tenantId, c.id, actor, { type: "NOTE_ADDED", note: text.slice(0, 2000) });
  }, TX);
}

export async function setInternalNote(tenantId: string, caseId: string, actor: Actor, note: string | null) {
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    const updated = await tx.damageCase.update({ where: { id: c.id }, data: { internalNote: note?.trim() || null } });
    await event(tx, tenantId, c.id, actor, { type: "NOTE_ADDED", note: "Interne Notiz aktualisiert" });
    return updated;
  }, TX);
}

// ---------------------------------------------------------------------------
// Schließen / Wiederöffnen
// ---------------------------------------------------------------------------

export async function closeCase(tenantId: string, caseId: string, actor: Actor, reason: string): Promise<CaseRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Abschlussgrund angeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    assertOpen(c);
    const now = new Date();
    const updated = await tx.damageCase.update({ where: { id: c.id }, data: { status: "CLOSED", closedAt: now, closedById: actor.id, closedByName: actor.name, closeReason: why } });
    await event(tx, tenantId, c.id, actor, { type: "CLOSED", fromValue: c.status, toValue: "CLOSED", reason: why });
    await recordAudit(tx, tenantId, actor, { action: "DAMAGE_CASE_CLOSED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, from: c.status, reason: why } });
    return updated;
  }, TX);
}

export async function reopenCase(tenantId: string, caseId: string, actor: Actor, reason: string): Promise<CaseRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund für das Wiederöffnen angeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    if (c.status !== "CLOSED") throw new DomainError("Die Schadenakte ist nicht geschlossen.");
    const to = c.repairCompletedAt ? "REPAIRED" : "UNDER_REVIEW";
    const updated = await tx.damageCase.update({ where: { id: c.id }, data: { status: to, closedAt: null, closedById: null, closedByName: null, closeReason: null } });
    await event(tx, tenantId, c.id, actor, { type: "REOPENED", fromValue: "CLOSED", toValue: to, reason: why });
    await recordAudit(tx, tenantId, actor, { action: "DAMAGE_CASE_REOPENED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, to, reason: why } });
    return updated;
  }, TX);
}

// ---------------------------------------------------------------------------
// Fahrzeug sperren / freigeben (zentraler Fahrzeugstatus, keine eigene Sperre)
// ---------------------------------------------------------------------------

export async function futureBookingsOf(tenantId: string, vehicleId: string) {
  return db.booking.findMany({ where: { tenantId, vehicleId, status: { in: ["RESERVED", "ACTIVE"] }, endAt: { gt: new Date() } }, orderBy: { startAt: "asc" }, select: { id: true, number: true, startAt: true, endAt: true, status: true, customer: { select: { type: true, companyName: true, firstName: true, lastName: true } } } });
}

/** „Fahrzeug wegen Schaden sperren“: setzt den zentralen Status BLOCKED (nicht buchbar, nicht übergebbar). Zukünftige Buchungen bleiben unverändert. */
export async function blockVehicleForCase(tenantId: string, caseId: string, actor: Actor, note?: string | null): Promise<{ vehicleStatus: string; futureBookings: number }> {
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    assertOpen(c);
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Vehicle" WHERE "id" = ${c.vehicleId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Fahrzeug nicht gefunden.");
    if (locked[0].status === "BLOCKED") throw new DomainError("Das Fahrzeug ist bereits gesperrt.");
    if (locked[0].status === "INACTIVE") throw new DomainError("Ein inaktives Fahrzeug wird nicht gesperrt.");
    await tx.vehicle.update({ where: { id: c.vehicleId }, data: { status: "BLOCKED" } });
    const future = await tx.booking.count({ where: { tenantId, vehicleId: c.vehicleId, status: { in: ["RESERVED", "ACTIVE"] }, endAt: { gt: new Date() } } });
    await event(tx, tenantId, c.id, actor, { type: "VEHICLE_BLOCKED", fromValue: locked[0].status, toValue: "BLOCKED", note: note?.trim() || null });
    await recordAudit(tx, tenantId, actor, { action: "VEHICLE_BLOCKED_FOR_DAMAGE", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, vehicleId: c.vehicleId, from: locked[0].status, futureBookings: future } });
    return { vehicleStatus: "BLOCKED", futureBookings: future };
  }, TX);
}

/** „Fahrzeug wieder freigeben“: bewusste Entscheidung, nie automatisch bei REPAIRED oder CLOSED. */
export async function releaseVehicleForCase(tenantId: string, caseId: string, actor: Actor, note?: string | null): Promise<{ vehicleStatus: string }> {
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Vehicle" WHERE "id" = ${c.vehicleId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Fahrzeug nicht gefunden.");
    if (locked[0].status !== "BLOCKED" && locked[0].status !== "WORKSHOP") throw new DomainError("Das Fahrzeug ist nicht gesperrt.");
    await tx.vehicle.update({ where: { id: c.vehicleId }, data: { status: "AVAILABLE" } });
    await event(tx, tenantId, c.id, actor, { type: "VEHICLE_RELEASED", fromValue: locked[0].status, toValue: "AVAILABLE", note: note?.trim() || null });
    await recordAudit(tx, tenantId, actor, { action: "VEHICLE_RELEASED_AFTER_DAMAGE", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, vehicleId: c.vehicleId, from: locked[0].status } });
    return { vehicleStatus: "AVAILABLE" };
  }, TX);
}

// ---------------------------------------------------------------------------
// Kundenbelastung → Schadenabrechnung (eigene Rechnung, kind DAMAGE)
// ---------------------------------------------------------------------------

export type CustomerChargeInput = { amount: string | number; basis: string; taxTreatment: string; nonce?: string | null };

/**
 * „Schaden dem Kunden berechnen“: nur bei ausdrücklich bestätigter Kundenverantwortung. Betrag, sachliche Grundlage und
 * steuerliche Behandlung werden bewusst eingegeben – keine min()-Logik aus Kosten, Selbstbeteiligung oder Kaution.
 * Ergebnis: Kundenbelastung an der Akte (einmalig) und Schadenabrechnung als Entwurf (Fassung 1). Genau eine je Akte
 * (Zeilensperre + Index); Doppelklick liefert die vorhandene Abrechnung.
 */
export async function chargeCustomer(tenantId: string, caseId: string, actor: Actor, input: CustomerChargeInput): Promise<{ invoiceId: string; created: boolean }> {
  const basis = input.basis.trim();
  if (basis.length < 5) throw new DomainError("Bitte die Grundlage der Kundenbelastung sachlich beschreiben (Pflichtfeld).");
  if (!(input.taxTreatment in DAMAGE_TAX_TREATMENTS)) throw new DomainError("Bitte die steuerliche Behandlung der Kundenbelastung auswählen.");
  const treatment = input.taxTreatment as DamageTaxTreatment;
  const amountCents = parseCost(input.amount, "Der Belastungsbetrag");
  if (amountCents == null || amountCents <= 0) throw new DomainError("Der dem Kunden zu berechnende Betrag muss größer als 0,00 € sein.");
  try {
    return await db.$transaction(async (tx) => {
      const c = await lockCase(tx, tenantId, caseId);
      assertOpen(c);
      const existingInvoice = await tx.invoice.findFirst({ where: { tenantId, damageCaseId: c.id, status: { in: ["DRAFT", "FINALIZED"] } } });
      if (existingInvoice) return { invoiceId: existingInvoice.id, created: false };
      if (c.liabilityStatus !== "CUSTOMER_RESPONSIBILITY_CONFIRMED") throw new DomainError("Eine Kundenbelastung ist erst möglich, wenn die Haftung ausdrücklich auf „Kunde verantwortlich“ gesetzt wurde.");
      if (!c.bookingId) throw new DomainError("Diese Schadenakte gehört zu keiner Vermietung; ohne Mietvertrag gibt es keinen Rechnungsempfänger.");
      const invoice = await createDamageInvoiceDraft(tx, tenantId, actor, { bookingId: c.bookingId, damageCaseId: c.id, damageId: c.damageId, caseNumber: c.caseNumber, amountCents, basis, taxTreatment: treatment, taxNote: DAMAGE_TAX_NOTES[treatment] });
      const now = new Date();
      await tx.damageCase.update({ where: { id: c.id }, data: { customerChargeCents: amountCents, customerChargeBasis: basis, customerChargeTaxTreatment: treatment, customerChargeAt: now, customerChargeByName: actor.name, ...(c.status === "OPEN" ? { status: "UNDER_REVIEW" } : {}) } });
      await event(tx, tenantId, c.id, actor, { type: "CUSTOMER_CHARGE_CREATED", toValue: String(amountCents), reason: basis, note: DAMAGE_TAX_TREATMENTS[treatment] });
      await event(tx, tenantId, c.id, actor, { type: "INVOICE_CREATED", toValue: invoice.id, note: "Schadenabrechnung als Entwurf erstellt" });
      await recordAudit(tx, tenantId, actor, { action: "DAMAGE_CUSTOMER_CHARGE_CREATED", bookingId: c.bookingId, invoiceId: invoice.id, amountCents, details: { caseNumber: c.caseNumber, taxTreatment: treatment } });
      await recordAudit(tx, tenantId, actor, { action: "DAMAGE_INVOICE_CREATED", bookingId: c.bookingId, invoiceId: invoice.id, amountCents, details: { caseNumber: c.caseNumber } });
      return { invoiceId: invoice.id, created: true };
    }, TX);
  } catch (e) {
    if (isUniqueViolation(e, "damageCaseId")) {
      const winner = await db.invoice.findFirst({ where: { tenantId, damageCaseId: caseId, status: { in: ["DRAFT", "FINALIZED"] } } });
      if (winner) return { invoiceId: winner.id, created: false };
    }
    return domainFromDb(e);
  }
}

// ---------------------------------------------------------------------------
// Fotos und Dokumente (Registrierung; Upload und Prüfung laufen über die API-Routen)
// ---------------------------------------------------------------------------

export async function registerCasePhoto(tenantId: string, caseId: string, actor: Actor, input: { storageKey: string; contentType: string; sizeBytes: number; checksum: string; caption?: string | null }) {
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    assertOpen(c);
    const photo = await tx.photo.create({ data: { tenantId, damageId: c.damageId, damageCaseId: c.id, category: "DAMAGE", caption: input.caption?.trim().slice(0, 120) || null, storageKey: input.storageKey, contentType: input.contentType, sizeBytes: input.sizeBytes, checksum: input.checksum, takenAt: new Date(), createdById: actor.id } });
    await event(tx, tenantId, c.id, actor, { type: "PHOTO_ADDED", note: input.caption?.trim() || null });
    await recordAudit(tx, tenantId, actor, { action: "DAMAGE_PHOTO_ADDED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, photoId: photo.id } });
    return photo;
  }, TX);
}

export async function registerCaseDocument(tenantId: string, caseId: string, actor: Actor, input: { type: string; fileName: string; storageKey: string; contentType: string; sizeBytes: number; checksum: string; note?: string | null }) {
  if (!["ESTIMATE", "REPAIR_INVOICE", "OTHER"].includes(input.type)) throw new DomainError("Unbekannter Dokumenttyp.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    assertOpen(c);
    const doc = await tx.damageCaseDocument.create({ data: { tenantId, caseId: c.id, type: input.type, fileName: input.fileName.slice(0, 200), storageKey: input.storageKey, contentType: input.contentType, sizeBytes: input.sizeBytes, checksum: input.checksum, note: input.note?.trim() || null, createdById: actor.id, createdByName: actor.name } });
    await event(tx, tenantId, c.id, actor, { type: "DOCUMENT_ADDED", toValue: input.type, note: input.fileName });
    await recordAudit(tx, tenantId, actor, { action: "DAMAGE_DOCUMENT_ADDED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, type: input.type, documentId: doc.id } });
    return doc;
  }, TX);
}

// ---------------------------------------------------------------------------
// Ansicht und Liste
// ---------------------------------------------------------------------------

export type CaseView = Awaited<ReturnType<typeof caseView>>;

/** Alles für die Akte: Schaden, Fahrzeug, Vermietung (mit Selbstbeteiligung aus der Vertragskopie), Vorher/Nachher, Fotos, Dokumente, Kaution, Abrechnung, Historie. */
export async function caseView(tenantId: string, caseId: string) {
  const c = await db.damageCase.findFirst({
    where: { id: caseId, tenantId },
    include: {
      damage: { include: { discoveredIn: { select: { id: true, type: true, number: true, bookingId: true } }, photos: { orderBy: { uploadedAt: "asc" } }, snapshots: { include: { handover: { select: { id: true, type: true, number: true, finalizedAt: true, bookingId: true } }, photos: { select: { id: true } } } } } },
      vehicle: { select: { id: true, plate: true, make: true, model: true, status: true, mileage: true, vin: true } },
      booking: { include: { customer: { select: { id: true, type: true, companyName: true, firstName: true, lastName: true } }, contract: { select: { id: true, number: true, status: true, deductible: true, deposit: true } } } },
      returnHandover: { select: { id: true, number: true, finalizedAt: true, mileage: true } },
      photos: { orderBy: { uploadedAt: "asc" } },
      documents: { orderBy: { createdAt: "desc" } },
      events: { orderBy: { createdAt: "desc" } },
      invoices: { where: { status: { in: ["DRAFT", "FINALIZED"] } }, include: { currentVersion: { select: { id: true, versionNo: true, grossTotal: true } } } },
    },
  });
  if (!c) throw new DomainError("Schadenakte nicht gefunden.");
  const invoice = c.invoices[0] ?? null;
  let payment: ReturnType<typeof summarizePayment> | null = null;
  if (invoice && invoice.status === "FINALIZED" && invoice.currentVersion) {
    const paid = await db.payment.aggregate({ where: { tenantId, invoiceId: invoice.id, status: "CONFIRMED" }, _sum: { amountCents: true } });
    payment = summarizePayment(toCents(invoice.currentVersion.grossTotal), paid._sum.amountCents ?? 0);
  }
  let deposit: ReturnType<typeof balanceOf> | null = null;
  if (c.bookingId) {
    const dep = await db.securityDeposit.findFirst({ where: { tenantId, bookingId: c.bookingId }, include: { events: { select: { type: true, amountCents: true, status: true } } } });
    const expected = dep ? dep.expectedAmountCents : c.booking?.contract?.status === "SIGNED" ? toCents(c.booking.contract.deposit) : 0;
    deposit = balanceOf(expected, dep?.events ?? []);
  }
  const otherCharges = c.bookingId ? await db.extraCharge.findMany({ where: { tenantId, damageId: c.damageId }, select: { id: true, description: true, amount: true } }) : [];
  // Vorher/Nachher aus den versiegelten Protokollkopien (HandoverDamage), keine Live-Daten
  const pickupSnap = c.damage.snapshots.find((s) => s.handover.type === "PICKUP");
  const returnSnap = c.damage.snapshots.find((s) => s.handover.type === "RETURN");
  const ret = returnSnap ?? c.damage.snapshots.find((s) => s.handover.id === c.returnHandoverId) ?? null;
  return {
    ...c,
    invoice,
    payment,
    deposit,
    otherCharges,
    deductibleCents: c.booking?.contract?.status === "SIGNED" ? toCents(c.booking.contract.deductible) : null,
    comparison: {
      pickup: pickupSnap ? { number: pickupSnap.handover.number, marker: pickupSnap.marker, description: pickupSnap.description, photos: pickupSnap.photos.length, view: pickupSnap.view, posX: pickupSnap.posX, posY: pickupSnap.posY } : null,
      return: ret ? { number: ret.handover.number, marker: ret.marker, description: ret.description, photos: ret.photos.length, view: ret.view, posX: ret.posX, posY: ret.posY } : null,
    },
  };
}

export type CaseFilter = "alle" | "offen" | "pruefung" | "geplant" | "reparatur" | "repariert" | "geschlossen" | "haftung_ungeklaert" | "kunde" | "keine_kundenverantwortung" | "gesperrt" | "belastung" | "rechnung_offen";
export const CASE_FILTERS: { key: CaseFilter; label: string }[] = [
  { key: "offen", label: "Offen" }, { key: "pruefung", label: "In Prüfung" }, { key: "geplant", label: "Reparatur geplant" }, { key: "reparatur", label: "In Reparatur" }, { key: "repariert", label: "Repariert" }, { key: "geschlossen", label: "Geschlossen" },
  { key: "haftung_ungeklaert", label: "Haftung ungeklärt" }, { key: "kunde", label: "Kunde verantwortlich" }, { key: "keine_kundenverantwortung", label: "Keine Kundenverantwortung" }, { key: "gesperrt", label: "Fahrzeug gesperrt" }, { key: "belastung", label: "Kundenbelastung vorhanden" }, { key: "rechnung_offen", label: "Schadensrechnung offen" }, { key: "alle", label: "Alle" },
];

function filterWhere(filter: CaseFilter): Prisma.DamageCaseWhereInput {
  switch (filter) {
    case "offen": return { status: { not: "CLOSED" } };
    case "pruefung": return { status: "UNDER_REVIEW" };
    case "geplant": return { status: "REPAIR_PLANNED" };
    case "reparatur": return { status: "IN_REPAIR" };
    case "repariert": return { status: "REPAIRED" };
    case "geschlossen": return { status: "CLOSED" };
    case "haftung_ungeklaert": return { liabilityStatus: { in: ["UNASSESSED", "UNCLEAR"] }, status: { not: "CLOSED" } };
    case "kunde": return { liabilityStatus: "CUSTOMER_RESPONSIBILITY_CONFIRMED" };
    case "keine_kundenverantwortung": return { liabilityStatus: { in: ["NOT_CUSTOMER_RESPONSIBILITY", "THIRD_PARTY", "INTERNAL"] } };
    case "gesperrt": return { vehicle: { status: "BLOCKED" }, status: { not: "CLOSED" } };
    case "belastung": return { customerChargeCents: { not: null } };
    case "rechnung_offen": return { invoices: { some: { kind: "DAMAGE", status: "FINALIZED" } } };
    default: return {};
  }
}

/** Liste mit serverseitiger Seitenaufteilung und Suche (Aktennummer, Kennzeichen, Fahrzeug, Buchungsnummer, Kundenname). */
export async function listCases(tenantId: string, opts: { filter?: CaseFilter; q?: string; page?: number; pageSize?: number } = {}) {
  const filter = opts.filter ?? "offen";
  const q = opts.q?.trim() ?? "";
  const pageSize = Math.min(100, Math.max(10, opts.pageSize ?? 30));
  const page = Math.max(1, opts.page ?? 1);
  const search: Prisma.DamageCaseWhereInput = q
    ? { OR: [
        { caseNumber: { contains: q, mode: "insensitive" } },
        { vehicle: { OR: [{ plate: { contains: q, mode: "insensitive" } }, { make: { contains: q, mode: "insensitive" } }, { model: { contains: q, mode: "insensitive" } }] } },
        { booking: { OR: [{ number: { contains: q, mode: "insensitive" } }, { customer: { OR: [{ lastName: { contains: q, mode: "insensitive" } }, { firstName: { contains: q, mode: "insensitive" } }, { companyName: { contains: q, mode: "insensitive" } }] } }] } },
      ] }
    : {};
  const where: Prisma.DamageCaseWhereInput = { tenantId, AND: [filterWhere(filter), search] };
  const [total, rows] = await Promise.all([
    db.damageCase.count({ where }),
    db.damageCase.findMany({
      where,
      orderBy: [{ status: "asc" }, { reportedAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        vehicle: { select: { id: true, plate: true, make: true, model: true, status: true } },
        damage: { select: { kind: true, view: true, description: true, discoveredIn: { select: { type: true, number: true } } } },
        booking: { select: { id: true, number: true } },
        invoices: { where: { kind: "DAMAGE", status: { in: ["DRAFT", "FINALIZED"] } }, select: { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true } } } },
      },
    }),
  ]);
  const invoiceIds = rows.flatMap((r) => r.invoices.filter((i) => i.status === "FINALIZED").map((i) => i.id));
  const paid = invoiceIds.length ? await db.payment.groupBy({ by: ["invoiceId"], where: { tenantId, invoiceId: { in: invoiceIds }, status: "CONFIRMED" }, _sum: { amountCents: true } }) : [];
  const paidMap = new Map(paid.map((p) => [p.invoiceId, p._sum.amountCents ?? 0]));
  const items = rows.map((r) => {
    const inv = r.invoices[0] ?? null;
    const pay = inv && inv.status === "FINALIZED" && inv.currentVersion ? summarizePayment(toCents(inv.currentVersion.grossTotal), paidMap.get(inv.id) ?? 0) : null;
    return { ...r, invoice: inv, payment: pay };
  });
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), filter, q };
}

export async function caseCounts(tenantId: string) {
  const [open, inRepair, blocked, liability, openInvoices] = await Promise.all([
    db.damageCase.count({ where: { tenantId, status: { not: "CLOSED" } } }),
    db.damageCase.count({ where: { tenantId, status: "IN_REPAIR" } }),
    db.vehicle.count({ where: { tenantId, status: "BLOCKED", damageCases: { some: { status: { not: "CLOSED" } } } } }),
    db.damageCase.count({ where: { tenantId, status: { not: "CLOSED" }, liabilityStatus: { in: ["UNASSESSED", "UNCLEAR"] } } }),
    db.invoice.count({ where: { tenantId, kind: "DAMAGE", status: "FINALIZED" } }),
  ]);
  return { open, inRepair, blocked, liability, openInvoices };
}

/** Schäden einer Buchung mit dem Stand ihrer Akte (für Buchungs-, Rückgabe- und Fahrzeugseite). */
export async function damagesWithCases(tenantId: string, where: Prisma.DamageWhereInput) {
  return db.damage.findMany({ where: { tenantId, ...where }, orderBy: { discoveredAt: "desc" }, include: { discoveredIn: { select: { id: true, type: true, number: true, bookingId: true } }, damageCase: { select: { id: true, caseNumber: true, status: true, liabilityStatus: true, customerChargeCents: true, invoices: { where: { kind: "DAMAGE", status: { in: ["DRAFT", "FINALIZED"] } }, select: { id: true, number: true, status: true, bookingId: true } } } } } });
}
