// Flotten- und Wartungsmanagement (Phase 13). MaintenancePlan = wiederkehrende Fälligkeit (Datum und/oder Kilometer),
// MaintenanceRecord = konkreter Werkstatt-/Servicevorgang mit Nummer WA-JJJJ-NNNNNN. Harte Regeln:
// - Eine Fälligkeit warnt nur; sie sperrt kein Fahrzeug. Sperren („Werkstatt“) und Freigeben sind eigene Entscheidungen
//   über den zentralen Fahrzeugstatus – Abschluss eines Vorgangs gibt das Fahrzeug nie automatisch frei.
// - Kosten sind interne Betriebskosten. Sie erzeugen nie Rechnung, Zahlung, Zusatzkosten, Kautionsbewegung oder eine
//   Änderung an der Schadenakte; die Übernahme in die Schadenakte ist eine ausdrückliche Aktion mit Vorschau.
// - Kilometerstände werden nie zurückgedreht: ein niedrigerer Servicestand bleibt historischer Wert am Vorgang.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { MAINTENANCE_PRIORITY, MAINTENANCE_STATUS, MAINTENANCE_TRANSITIONS, MAINTENANCE_TYPES, VEHICLE_DOCUMENT_TYPES, type MaintenanceStatus, type MaintenanceType } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { dueStatus, proposeNextDue, type DueResult } from "@/lib/maintenance-due";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation, nextMaintenanceNumber, withNumberRetry } from "@/lib/numbering";
import { recordVehicleEvent } from "@/lib/vehicle-events";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type PlanRow = Prisma.MaintenancePlanGetPayload<object>;
export type RecordRow = Prisma.MaintenanceRecordGetPayload<object>;

function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_(?:DOMAIN|IMMUTABLE): ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}

function parseMoney(v: string | number | null | undefined, what: string): Cents | null {
  if (v == null || String(v).trim() === "") return null;
  let cents: Cents;
  try {
    cents = toCents(v);
  } catch {
    throw new DomainError(`${what}: bitte einen gültigen Betrag eingeben (z. B. 684,32).`);
  }
  if (cents < 0) throw new DomainError(`${what} darf nicht negativ sein.`);
  if (cents > 100_000_000_00) throw new DomainError(`${what} ist unplausibel hoch.`);
  return cents;
}

function parseKm(v: string | number | null | undefined, what: string): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/\./g, "").replace(",", ".").trim());
  if (!Number.isInteger(n) || n < 0) throw new DomainError(`${what}: bitte einen ganzzahligen Kilometerstand eingeben.`);
  if (n > 5_000_000) throw new DomainError(`${what} ist unplausibel hoch.`);
  return n;
}

function parseIntervalMonths(v: string | number | null | undefined): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n <= 0 || n > 240) throw new DomainError("Das Intervall in Monaten muss zwischen 1 und 240 liegen.");
  return n;
}

async function vehicleOf(tx: Tx, tenantId: string, vehicleId: string) {
  const v = await tx.vehicle.findFirst({ where: { id: vehicleId, tenantId } });
  if (!v) throw new DomainError("Fahrzeug nicht gefunden.");
  return v;
}

async function lockRecord(tx: Tx, tenantId: string, id: string): Promise<RecordRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MaintenanceRecord" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Wartungsvorgang nicht gefunden.");
  return tx.maintenanceRecord.findUniqueOrThrow({ where: { id } });
}

function event(tx: Tx, tenantId: string, maintenanceId: string, actor: Actor | null, data: { type: string; fromValue?: string | null; toValue?: string | null; note?: string | null }) {
  return tx.maintenanceEvent.create({ data: { tenantId, maintenanceId, type: data.type, fromValue: data.fromValue ?? null, toValue: data.toValue ?? null, note: data.note ?? null, userId: actor?.id ?? null, userName: actor?.name ?? null } });
}

const isFinal = (r: RecordRow) => r.status === "COMPLETED" || r.status === "CANCELLED";
const assertOpen = (r: RecordRow) => { if (isFinal(r)) throw new DomainError(`Der Wartungsvorgang ${r.maintenanceNumber} ist ${MAINTENANCE_STATUS[r.status as MaintenanceStatus].toLowerCase()} und kann nicht mehr geändert werden.`); };

/** HU/AU: die nächste Fälligkeit des HU-Plans ist auch das HU-Datum am Fahrzeug (Dashboard, Fahrzeugliste, Formular). */
async function syncHuDate(tx: Tx, tenantId: string, vehicleId: string, nextDueDate: Date | null) {
  await tx.vehicle.updateMany({ where: { id: vehicleId, tenantId }, data: { huDate: nextDueDate } });
}

// ---------------------------------------------------------------------------
// Wartungspläne
// ---------------------------------------------------------------------------

export type PlanInput = { vehicleId: string; type: string; title?: string | null; intervalMonths?: string | number | null; intervalKilometers?: string | number | null; nextDueDate?: Date | null; nextDueMileage?: string | number | null; warningDaysBefore?: number | null; warningKilometersBefore?: number | null; note?: string | null; isActive?: boolean };

function planData(input: PlanInput) {
  if (!(input.type in MAINTENANCE_TYPES)) throw new DomainError("Ungültige Wartungsart.");
  const intervalMonths = parseIntervalMonths(input.intervalMonths);
  const intervalKilometers = parseKm(input.intervalKilometers, "Das Kilometerintervall");
  if (intervalKilometers === 0) throw new DomainError("Das Kilometerintervall muss größer als 0 sein.");
  const nextDueMileage = parseKm(input.nextDueMileage, "Der nächste Kilometerstand");
  const nextDueDate = input.nextDueDate ?? null;
  if (!nextDueDate && nextDueMileage == null) throw new DomainError("Bitte mindestens ein nächstes Fälligkeitsdatum oder einen Kilometerstand angeben.");
  const warningDaysBefore = input.warningDaysBefore ?? 30;
  const warningKilometersBefore = input.warningKilometersBefore ?? 1000;
  if (warningDaysBefore < 0 || warningDaysBefore > 365 || warningKilometersBefore < 0 || warningKilometersBefore > 100_000) throw new DomainError("Die Vorwarnung liegt zwischen 0 und 365 Tagen bzw. 0 und 100.000 km.");
  const title = input.title?.trim() || MAINTENANCE_TYPES[input.type as MaintenanceType];
  return { type: input.type, title, intervalMonths, intervalKilometers, nextDueDate, nextDueMileage, warningDaysBefore, warningKilometersBefore, note: input.note?.trim() || null };
}

export async function createPlan(tenantId: string, actor: Actor, input: PlanInput): Promise<PlanRow> {
  const data = planData(input);
  try {
    return await db.$transaction(async (tx) => {
      const vehicle = await vehicleOf(tx, tenantId, input.vehicleId);
      const plan = await tx.maintenancePlan.create({ data: { tenantId, vehicleId: vehicle.id, ...data } });
      if (plan.type === "HU_AU" && plan.nextDueDate) await syncHuDate(tx, tenantId, vehicle.id, plan.nextDueDate);
      await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_PLAN_CREATED", details: { planId: plan.id, vehicleId: vehicle.id, type: plan.type, nextDueDate: plan.nextDueDate?.toISOString() ?? null, nextDueMileage: plan.nextDueMileage } });
      return plan;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

export async function updatePlan(tenantId: string, planId: string, actor: Actor, input: Omit<PlanInput, "vehicleId">): Promise<PlanRow> {
  try {
    return await db.$transaction(async (tx) => {
      const plan = await tx.maintenancePlan.findFirst({ where: { id: planId, tenantId } });
      if (!plan) throw new DomainError("Wartungsplan nicht gefunden.");
      const data = planData({ ...input, vehicleId: plan.vehicleId });
      const updated = await tx.maintenancePlan.update({ where: { id: plan.id }, data: { ...data, isActive: input.isActive ?? plan.isActive } });
      if (updated.type === "HU_AU") await syncHuDate(tx, tenantId, plan.vehicleId, updated.isActive ? updated.nextDueDate : null);
      await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_PLAN_UPDATED", details: { planId: plan.id, vehicleId: plan.vehicleId, type: updated.type, isActive: updated.isActive, nextDueDate: updated.nextDueDate?.toISOString() ?? null, nextDueMileage: updated.nextDueMileage } });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

export async function setPlanActive(tenantId: string, planId: string, actor: Actor, isActive: boolean): Promise<PlanRow> {
  return db.$transaction(async (tx) => {
    const plan = await tx.maintenancePlan.findFirst({ where: { id: planId, tenantId } });
    if (!plan) throw new DomainError("Wartungsplan nicht gefunden.");
    const updated = await tx.maintenancePlan.update({ where: { id: plan.id }, data: { isActive } });
    if (updated.type === "HU_AU") await syncHuDate(tx, tenantId, plan.vehicleId, isActive ? updated.nextDueDate : null);
    await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_PLAN_UPDATED", details: { planId: plan.id, vehicleId: plan.vehicleId, isActive } });
    return updated;
  }, TX);
}

// ---------------------------------------------------------------------------
// Buchungsprüfungen (nur Hinweise, nie automatische Änderungen)
// ---------------------------------------------------------------------------

export type BookingHint = { id: string; number: string; startAt: Date; endAt: Date; status: string };

/** Laufende und künftige Buchungen des Fahrzeugs – vor einer Sperre deutlich anzeigen. */
export async function activeAndFutureBookings(tx: Tx | typeof db, tenantId: string, vehicleId: string): Promise<BookingHint[]> {
  return tx.booking.findMany({ where: { tenantId, vehicleId, status: { in: ["RESERVED", "ACTIVE"] }, endAt: { gt: new Date() } }, orderBy: { startAt: "asc" }, select: { id: true, number: true, startAt: true, endAt: true, status: true } });
}

/** Buchungen, die sich mit einem Werkstatttermin überschneiden (Termin ohne Ende = ein Tag). */
export async function overlappingBookings(tx: Tx | typeof db, tenantId: string, vehicleId: string, scheduledAt: Date | null, scheduledEndAt: Date | null): Promise<BookingHint[]> {
  if (!scheduledAt) return [];
  const end = scheduledEndAt ?? new Date(scheduledAt.getTime() + 86_400_000);
  return tx.booking.findMany({ where: { tenantId, vehicleId, status: { in: ["RESERVED", "ACTIVE"] }, startAt: { lt: end }, endAt: { gt: scheduledAt } }, orderBy: { startAt: "asc" }, select: { id: true, number: true, startAt: true, endAt: true, status: true } });
}

// ---------------------------------------------------------------------------
// Wartungsvorgänge
// ---------------------------------------------------------------------------

export type MaintenanceInput = {
  vehicleId: string; type: string; title: string; description?: string | null; priority?: string | null; planId?: string | null; damageCaseId?: string | null;
  workshopName?: string | null; workshopContact?: string | null; scheduledAt?: Date | null; scheduledEndAt?: Date | null;
  mileageAtService?: string | number | null; estimatedCostCents?: string | number | null; internalNote?: string | null; blockVehicle?: boolean;
};

async function checkLinks(tx: Tx, tenantId: string, vehicleId: string, planId: string | null | undefined, damageCaseId: string | null | undefined) {
  if (planId) {
    const p = await tx.maintenancePlan.findFirst({ where: { id: planId, tenantId, vehicleId } });
    if (!p) throw new DomainError("Der Wartungsplan gehört nicht zu diesem Fahrzeug.");
  }
  if (damageCaseId) {
    const c = await tx.damageCase.findFirst({ where: { id: damageCaseId, tenantId, vehicleId } });
    if (!c) throw new DomainError("Die Schadenakte gehört nicht zu diesem Fahrzeug.");
  }
}

export type CreateResult = { record: RecordRow; overlaps: BookingHint[]; blocked: boolean; futureBookings: BookingHint[] };

/** „Wartung / Werkstatt hinzufügen“: kompakt, mit optionalem Termin, Kosten und bewusster Fahrzeugsperre. */
export async function createMaintenance(tenantId: string, actor: Actor, input: MaintenanceInput): Promise<CreateResult> {
  if (!(input.type in MAINTENANCE_TYPES)) throw new DomainError("Ungültige Wartungsart.");
  const title = input.title.trim();
  if (title.length < 2) throw new DomainError("Bitte einen Titel angeben.");
  const priority = input.priority ?? "NORMAL";
  if (!(priority in MAINTENANCE_PRIORITY)) throw new DomainError("Ungültige Priorität.");
  if (input.scheduledEndAt && input.scheduledAt && input.scheduledEndAt < input.scheduledAt) throw new DomainError("Das Terminende liegt vor dem Terminbeginn.");
  if (input.scheduledEndAt && !input.scheduledAt) throw new DomainError("Ein Terminende braucht einen Terminbeginn.");
  const mileageAtService = parseKm(input.mileageAtService, "Der Kilometerstand");
  const estimatedCostCents = parseMoney(input.estimatedCostCents, "Die Kostenschätzung");
  try {
    return await withNumberRetry(() =>
      db.$transaction(async (tx) => {
        const vehicle = await vehicleOf(tx, tenantId, input.vehicleId);
        await checkLinks(tx, tenantId, vehicle.id, input.planId, input.damageCaseId);
        const maintenanceNumber = await nextMaintenanceNumber(tx, tenantId);
        const status = input.scheduledAt ? "SCHEDULED" : "PLANNED";
        const record = await tx.maintenanceRecord.create({
          data: {
            tenantId, vehicleId: vehicle.id, planId: input.planId || null, damageCaseId: input.damageCaseId || null, maintenanceNumber, type: input.type, status, priority, title,
            description: input.description?.trim() || null, workshopName: input.workshopName?.trim() || null, workshopContact: input.workshopContact?.trim() || null,
            scheduledAt: input.scheduledAt ?? null, scheduledEndAt: input.scheduledEndAt ?? null, mileageAtService, estimatedCostCents, internalNote: input.internalNote?.trim() || null,
            createdById: actor.id, createdByName: actor.name,
          },
        });
        await event(tx, tenantId, record.id, actor, { type: "CREATED", toValue: status, note: `${MAINTENANCE_TYPES[input.type as MaintenanceType]}: ${title}` });
        if (input.scheduledAt) await event(tx, tenantId, record.id, actor, { type: "SCHEDULED", toValue: input.scheduledAt.toISOString(), note: input.workshopName?.trim() || null });
        if (input.damageCaseId) await event(tx, tenantId, record.id, actor, { type: "DAMAGE_LINKED", toValue: input.damageCaseId });
        await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_CREATED", details: { maintenanceNumber, vehicleId: vehicle.id, type: input.type, status, damageCaseId: input.damageCaseId || null } });
        if (input.scheduledAt) await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_SCHEDULED", details: { maintenanceNumber, scheduledAt: input.scheduledAt.toISOString() } });
        if (input.damageCaseId) await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_DAMAGE_LINKED", details: { maintenanceNumber, damageCaseId: input.damageCaseId } });
        const overlaps = await overlappingBookings(tx, tenantId, vehicle.id, input.scheduledAt ?? null, input.scheduledEndAt ?? null);
        let blocked = false;
        let futureBookings: BookingHint[] = [];
        if (input.blockVehicle) {
          const r = await blockInTx(tx, tenantId, record, actor, null);
          blocked = r.blocked;
          futureBookings = r.futureBookings;
        }
        return { record, overlaps, blocked, futureBookings };
      }, TX),
    );
  } catch (e) {
    return domainFromDb(e);
  }
}

export type MaintenancePatch = { title?: string; description?: string | null; priority?: string; type?: string; workshopName?: string | null; workshopContact?: string | null; scheduledAt?: Date | null; scheduledEndAt?: Date | null; internalNote?: string | null; estimatedCostCents?: string | number | null };

/** Stammdaten des Vorgangs ändern; Termin setzen/ändern wechselt in „Werkstatttermin“. Abgeschlossene Vorgänge: nur interne Notiz. */
export async function updateMaintenance(tenantId: string, id: string, actor: Actor, patch: MaintenancePatch): Promise<{ record: RecordRow; overlaps: BookingHint[] }> {
  try {
    return await db.$transaction(async (tx) => {
      const r = await lockRecord(tx, tenantId, id);
      if (isFinal(r)) {
        if (patch.internalNote === undefined) assertOpen(r);
        const updated = await tx.maintenanceRecord.update({ where: { id: r.id }, data: { internalNote: patch.internalNote?.trim() || null } });
        await event(tx, tenantId, r.id, actor, { type: "NOTE_ADDED", note: "Interne Notiz aktualisiert" });
        return { record: updated, overlaps: [] };
      }
      const data: Prisma.MaintenanceRecordUpdateInput = {};
      const changes: string[] = [];
      if (patch.title !== undefined) { const t = patch.title.trim(); if (t.length < 2) throw new DomainError("Bitte einen Titel angeben."); if (t !== r.title) { data.title = t; changes.push("Titel"); } }
      if (patch.description !== undefined && (patch.description?.trim() || null) !== r.description) { data.description = patch.description?.trim() || null; changes.push("Beschreibung"); }
      if (patch.internalNote !== undefined && (patch.internalNote?.trim() || null) !== r.internalNote) { data.internalNote = patch.internalNote?.trim() || null; changes.push("Interne Notiz"); }
      if (patch.priority !== undefined) { if (!(patch.priority in MAINTENANCE_PRIORITY)) throw new DomainError("Ungültige Priorität."); if (patch.priority !== r.priority) { data.priority = patch.priority; changes.push(`Priorität ${MAINTENANCE_PRIORITY[patch.priority as keyof typeof MAINTENANCE_PRIORITY]}`); } }
      if (patch.type !== undefined) { if (!(patch.type in MAINTENANCE_TYPES)) throw new DomainError("Ungültige Wartungsart."); if (patch.type !== r.type) { data.type = patch.type; changes.push(`Art ${MAINTENANCE_TYPES[patch.type as MaintenanceType]}`); } }
      if (patch.workshopName !== undefined && (patch.workshopName?.trim() || null) !== r.workshopName) { data.workshopName = patch.workshopName?.trim() || null; changes.push("Werkstatt"); }
      if (patch.workshopContact !== undefined && (patch.workshopContact?.trim() || null) !== r.workshopContact) { data.workshopContact = patch.workshopContact?.trim() || null; changes.push("Werkstattkontakt"); }
      if (patch.estimatedCostCents !== undefined) {
        const c = parseMoney(patch.estimatedCostCents, "Die Kostenschätzung");
        if (c !== r.estimatedCostCents) { data.estimatedCostCents = c; changes.push(`Schätzung ${c == null ? "–" : fmtCents(c)}`); await event(tx, tenantId, r.id, actor, { type: "COST_CHANGED", note: `Schätzung ${r.estimatedCostCents == null ? "–" : fmtCents(r.estimatedCostCents)} → ${c == null ? "–" : fmtCents(c)}` }); await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_COST_CHANGED", amountCents: c ?? null, details: { maintenanceNumber: r.maintenanceNumber, estimated: c } }); }
      }
      let scheduledChanged = false;
      const scheduledAt = patch.scheduledAt === undefined ? r.scheduledAt : patch.scheduledAt;
      const scheduledEndAt = patch.scheduledEndAt === undefined ? r.scheduledEndAt : patch.scheduledEndAt;
      if (scheduledEndAt && !scheduledAt) throw new DomainError("Ein Terminende braucht einen Terminbeginn.");
      if (scheduledEndAt && scheduledAt && scheduledEndAt < scheduledAt) throw new DomainError("Das Terminende liegt vor dem Terminbeginn.");
      if ((scheduledAt?.getTime() ?? null) !== (r.scheduledAt?.getTime() ?? null) || (scheduledEndAt?.getTime() ?? null) !== (r.scheduledEndAt?.getTime() ?? null)) {
        data.scheduledAt = scheduledAt; data.scheduledEndAt = scheduledEndAt; scheduledChanged = true; changes.push(scheduledAt ? "Termin" : "Termin entfernt");
        if (scheduledAt && r.status === "PLANNED") data.status = "SCHEDULED";
        if (!scheduledAt && r.status === "SCHEDULED") data.status = "PLANNED";
      }
      if (changes.length === 0) return { record: r, overlaps: await overlappingBookings(tx, tenantId, r.vehicleId, scheduledAt, scheduledEndAt) };
      const updated = await tx.maintenanceRecord.update({ where: { id: r.id }, data });
      await event(tx, tenantId, r.id, actor, { type: scheduledChanged ? "SCHEDULED" : "UPDATED", toValue: scheduledChanged ? scheduledAt?.toISOString() ?? null : null, note: changes.join(", ") });
      await recordAudit(tx, tenantId, actor, { action: scheduledChanged ? "MAINTENANCE_SCHEDULED" : "MAINTENANCE_UPDATED", details: { maintenanceNumber: r.maintenanceNumber, changes: changes.join(", "), scheduledAt: scheduledAt?.toISOString() ?? null } });
      return { record: updated, overlaps: await overlappingBookings(tx, tenantId, r.vehicleId, scheduledAt, scheduledEndAt) };
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** Statuswechsel entlang der zentralen Übergänge (ohne Abschluss/Abbruch). „In Arbeit“ darf auch der Hof setzen. */
export async function changeMaintenanceStatus(tenantId: string, id: string, actor: Actor, to: string): Promise<RecordRow> {
  if (!(to in MAINTENANCE_STATUS) || to === "COMPLETED" || to === "CANCELLED") throw new DomainError("Ungültiger Zielstatus.");
  return db.$transaction(async (tx) => {
    const r = await lockRecord(tx, tenantId, id);
    assertOpen(r);
    const allowed = MAINTENANCE_TRANSITIONS[r.status as MaintenanceStatus] ?? [];
    if (!allowed.includes(to as MaintenanceStatus)) throw new DomainError(`Von „${MAINTENANCE_STATUS[r.status as MaintenanceStatus]}“ ist kein Wechsel nach „${MAINTENANCE_STATUS[to as MaintenanceStatus]}“ vorgesehen.`);
    if (to === "SCHEDULED" && !r.scheduledAt) throw new DomainError("Bitte zuerst einen Werkstatttermin eintragen.");
    const updated = await tx.maintenanceRecord.update({ where: { id: r.id }, data: { status: to, ...(to === "IN_PROGRESS" && !r.startedAt ? { startedAt: new Date() } : {}) } });
    await event(tx, tenantId, r.id, actor, { type: to === "IN_PROGRESS" ? "STARTED" : "UPDATED", fromValue: r.status, toValue: to });
    await recordAudit(tx, tenantId, actor, { action: to === "IN_PROGRESS" ? "MAINTENANCE_STARTED" : "MAINTENANCE_UPDATED", details: { maintenanceNumber: r.maintenanceNumber, from: r.status, to } });
    return updated;
  }, TX);
}

export async function setMaintenanceCosts(tenantId: string, id: string, actor: Actor, input: { estimated?: string | number | null; actual?: string | number | null }): Promise<RecordRow> {
  const estimated = input.estimated === undefined ? undefined : parseMoney(input.estimated, "Die Kostenschätzung");
  const actual = input.actual === undefined ? undefined : parseMoney(input.actual, "Die tatsächlichen Kosten");
  try {
    return await db.$transaction(async (tx) => {
      const r = await lockRecord(tx, tenantId, id);
      assertOpen(r);
      const data: Prisma.MaintenanceRecordUpdateInput = {};
      const changes: string[] = [];
      if (estimated !== undefined && estimated !== r.estimatedCostCents) { data.estimatedCostCents = estimated; changes.push(`Schätzung ${r.estimatedCostCents == null ? "–" : fmtCents(r.estimatedCostCents)} → ${estimated == null ? "–" : fmtCents(estimated)}`); }
      if (actual !== undefined && actual !== r.actualCostCents) { data.actualCostCents = actual; changes.push(`Tatsächlich ${r.actualCostCents == null ? "–" : fmtCents(r.actualCostCents)} → ${actual == null ? "–" : fmtCents(actual)}`); }
      if (changes.length === 0) return r;
      const updated = await tx.maintenanceRecord.update({ where: { id: r.id }, data });
      await event(tx, tenantId, r.id, actor, { type: "COST_CHANGED", note: changes.join("; ") });
      await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_COST_CHANGED", amountCents: actual ?? estimated ?? null, details: { maintenanceNumber: r.maintenanceNumber, estimated: estimated ?? r.estimatedCostCents ?? null, actual: actual ?? r.actualCostCents ?? null } });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/**
 * Kilometerstand am Vorgang dokumentieren (auch Hof). Zentrale Regel: höher als der Fahrzeugstand → Fahrzeug fortschreiben
 * (mit Historie), niedriger → nur historischer Wert am Vorgang, Fahrzeugstand wird nie reduziert.
 */
async function applyMileage(tx: Tx, tenantId: string, r: RecordRow, mileage: number, actor: Actor, occurredAt: Date): Promise<string[]> {
  const warnings: string[] = [];
  const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: r.vehicleId } });
  if (mileage > vehicle.mileage) {
    if (mileage - vehicle.mileage > 50_000) warnings.push(`Auffälliger Kilometersprung: ${vehicle.mileage.toLocaleString("de-DE")} km → ${mileage.toLocaleString("de-DE")} km. Bitte prüfen.`);
    await tx.vehicle.update({ where: { id: vehicle.id }, data: { mileage } });
    await recordVehicleEvent(tx, { tenantId, vehicleId: vehicle.id, type: "MILEAGE", occurredAt, mileage, actor, description: `Kilometerstand aus Wartungsvorgang ${r.maintenanceNumber}` });
  } else if (mileage < vehicle.mileage) {
    warnings.push(`Der Servicekilometerstand (${mileage.toLocaleString("de-DE")} km) liegt unter dem aktuellen Fahrzeugstand (${vehicle.mileage.toLocaleString("de-DE")} km). Er wurde als historischer Wert am Vorgang gespeichert; der Fahrzeugstand wurde nicht reduziert.`);
  }
  return warnings;
}

export async function documentMileage(tenantId: string, id: string, actor: Actor, mileageInput: string | number): Promise<{ record: RecordRow; warnings: string[] }> {
  const mileage = parseKm(mileageInput, "Der Kilometerstand");
  if (mileage == null) throw new DomainError("Bitte einen Kilometerstand eingeben.");
  return db.$transaction(async (tx) => {
    const r = await lockRecord(tx, tenantId, id);
    assertOpen(r);
    const updated = await tx.maintenanceRecord.update({ where: { id: r.id }, data: { mileageAtService: mileage } });
    const warnings = await applyMileage(tx, tenantId, r, mileage, actor, new Date());
    await event(tx, tenantId, r.id, actor, { type: "MILEAGE", toValue: String(mileage) });
    return { record: updated, warnings };
  }, TX);
}

export type CompleteInput = { completedAt: Date; mileage?: string | number | null; actualCost?: string | number | null; workDone?: string | null; nextDueDate?: Date | null; nextDueMileage?: string | number | null; setNextDue?: boolean };
export type CompleteResult = { record: RecordRow; warnings: string[]; vehicleStatus: string; plan: PlanRow | null };

/**
 * „Als erledigt markieren“: Datum, Kilometer, tatsächliche Kosten, Arbeiten, Dokumente (separat) und nächste Fälligkeit.
 * Mit Plan: der Mitarbeiter bestätigt die nächste Fälligkeit (Vorschlag aus dem Intervall), der Plan wird fortgeschrieben.
 * COMPLETED gibt das Fahrzeug nicht frei; ist es für die Wartung gesperrt, bleibt es gesperrt.
 */
export async function completeMaintenance(tenantId: string, id: string, actor: Actor, input: CompleteInput): Promise<CompleteResult> {
  const mileage = parseKm(input.mileage, "Der Kilometerstand");
  const actualCostCents = parseMoney(input.actualCost, "Die tatsächlichen Kosten");
  const nextDueMileage = parseKm(input.nextDueMileage, "Der nächste Kilometerstand");
  if (input.completedAt.getTime() > Date.now() + 86_400_000) throw new DomainError("Das Abschlussdatum liegt in der Zukunft.");
  try {
    return await db.$transaction(async (tx) => {
      const r = await lockRecord(tx, tenantId, id);
      assertOpen(r);
      const warnings: string[] = [];
      const setNext = input.setNextDue ?? (!!input.nextDueDate || nextDueMileage != null);
      const updated = await tx.maintenanceRecord.update({
        where: { id: r.id },
        data: {
          status: "COMPLETED", completedAt: input.completedAt, completedById: actor.id, completedByName: actor.name,
          mileageAtService: mileage ?? r.mileageAtService, actualCostCents: actualCostCents ?? r.actualCostCents, workDone: input.workDone?.trim() || null,
          nextDueDate: setNext ? input.nextDueDate ?? null : null, nextDueMileage: setNext ? nextDueMileage : null, startedAt: r.startedAt ?? input.completedAt,
        },
      });
      if (mileage != null) warnings.push(...(await applyMileage(tx, tenantId, r, mileage, actor, input.completedAt)));
      await recordVehicleEvent(tx, { tenantId, vehicleId: r.vehicleId, type: "MAINTENANCE_COMPLETED", occurredAt: input.completedAt, mileage: mileage ?? r.mileageAtService ?? null, actor, description: `${MAINTENANCE_TYPES[r.type as MaintenanceType] ?? r.type}: ${r.title}${updated.workshopName ? ` (${updated.workshopName})` : ""} · ${r.maintenanceNumber}` });
      let plan: PlanRow | null = null;
      if (r.planId) {
        const p = await tx.maintenancePlan.findFirst({ where: { id: r.planId, tenantId } });
        if (p) {
          if (setNext) {
            plan = await tx.maintenancePlan.update({ where: { id: p.id }, data: { nextDueDate: input.nextDueDate ?? null, nextDueMileage, lastMaintenanceId: r.id } });
            await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_PLAN_UPDATED", details: { planId: p.id, vehicleId: r.vehicleId, nextDueDate: plan.nextDueDate?.toISOString() ?? null, nextDueMileage: plan.nextDueMileage, fromMaintenance: r.maintenanceNumber } });
          } else {
            plan = await tx.maintenancePlan.update({ where: { id: p.id }, data: { lastMaintenanceId: r.id } });
            warnings.push("Die nächste Fälligkeit des Wartungsplans wurde nicht gesetzt. Bitte im Plan nachtragen.");
          }
        }
      }
      // HU/AU: neues HU-Datum am Fahrzeug (Plan und Fahrzeug bleiben synchron)
      if (r.type === "HU_AU" && setNext && input.nextDueDate) await syncHuDate(tx, tenantId, r.vehicleId, input.nextDueDate);
      await event(tx, tenantId, r.id, actor, { type: "COMPLETED", fromValue: r.status, toValue: "COMPLETED", note: [mileage != null ? `${mileage.toLocaleString("de-DE")} km` : null, actualCostCents != null ? fmtCents(actualCostCents) : null, input.workDone?.trim() || null].filter(Boolean).join(" · ") || null });
      await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_COMPLETED", amountCents: updated.actualCostCents ?? null, details: { maintenanceNumber: r.maintenanceNumber, vehicleId: r.vehicleId, type: r.type, mileage: updated.mileageAtService, nextDueDate: updated.nextDueDate?.toISOString() ?? null, nextDueMileage: updated.nextDueMileage } });
      const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: r.vehicleId }, select: { status: true } });
      return { record: updated, warnings, vehicleStatus: vehicle.status, plan };
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

export async function cancelMaintenance(tenantId: string, id: string, actor: Actor, reason: string): Promise<RecordRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund für den Abbruch angeben.");
  return db.$transaction(async (tx) => {
    const r = await lockRecord(tx, tenantId, id);
    assertOpen(r);
    const updated = await tx.maintenanceRecord.update({ where: { id: r.id }, data: { status: "CANCELLED", cancelReason: why } });
    await event(tx, tenantId, r.id, actor, { type: "CANCELLED", fromValue: r.status, toValue: "CANCELLED", note: why });
    await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_CANCELLED", details: { maintenanceNumber: r.maintenanceNumber, reason: why } });
    return updated;
  }, TX);
}

// ---------------------------------------------------------------------------
// Fahrzeug für Wartung sperren / freigeben (zentraler Fahrzeugstatus WORKSHOP)
// ---------------------------------------------------------------------------

async function blockInTx(tx: Tx, tenantId: string, r: RecordRow, actor: Actor, note: string | null): Promise<{ blocked: boolean; futureBookings: BookingHint[] }> {
  const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Vehicle" WHERE "id" = ${r.vehicleId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Fahrzeug nicht gefunden.");
  const status = locked[0].status;
  if (status === "WORKSHOP") throw new DomainError("Das Fahrzeug ist bereits für die Werkstatt gesperrt.");
  if (status === "BLOCKED") throw new DomainError("Das Fahrzeug ist wegen eines Schadens gesperrt (Status „Gesperrt“). Bitte dort freigeben oder den Status in der Fahrzeugakte prüfen.");
  if (status === "INACTIVE") throw new DomainError("Ein inaktives Fahrzeug wird nicht gesperrt.");
  await tx.vehicle.update({ where: { id: r.vehicleId }, data: { status: "WORKSHOP" } });
  const futureBookings = await activeAndFutureBookings(tx, tenantId, r.vehicleId);
  await event(tx, tenantId, r.id, actor, { type: "VEHICLE_BLOCKED", fromValue: status, toValue: "WORKSHOP", note });
  await recordAudit(tx, tenantId, actor, { action: "VEHICLE_BLOCKED_FOR_MAINTENANCE", details: { maintenanceNumber: r.maintenanceNumber, vehicleId: r.vehicleId, from: status, futureBookings: futureBookings.length } });
  return { blocked: true, futureBookings };
}

/** „Fahrzeug für Wartung sperren“: Status Werkstatt – nicht buchbar, nicht übergebbar. Buchungen bleiben unverändert (Warnung). */
export async function blockVehicleForMaintenance(tenantId: string, id: string, actor: Actor, note?: string | null): Promise<{ futureBookings: BookingHint[] }> {
  return db.$transaction(async (tx) => {
    const r = await lockRecord(tx, tenantId, id);
    assertOpen(r);
    const res = await blockInTx(tx, tenantId, r, actor, note?.trim() || null);
    return { futureBookings: res.futureBookings };
  }, TX);
}

/** „Fahrzeug freigeben“: bewusste Entscheidung, nie automatisch beim Abschluss. */
export async function releaseVehicleAfterMaintenance(tenantId: string, id: string, actor: Actor, note?: string | null): Promise<void> {
  await db.$transaction(async (tx) => {
    const r = await lockRecord(tx, tenantId, id);
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Vehicle" WHERE "id" = ${r.vehicleId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Fahrzeug nicht gefunden.");
    if (locked[0].status !== "WORKSHOP") throw new DomainError("Das Fahrzeug ist nicht für die Werkstatt gesperrt.");
    await tx.vehicle.update({ where: { id: r.vehicleId }, data: { status: "AVAILABLE" } });
    await event(tx, tenantId, r.id, actor, { type: "VEHICLE_RELEASED", fromValue: "WORKSHOP", toValue: "AVAILABLE", note: note?.trim() || null });
    await recordAudit(tx, tenantId, actor, { action: "VEHICLE_RELEASED_AFTER_MAINTENANCE", details: { maintenanceNumber: r.maintenanceNumber, vehicleId: r.vehicleId } });
  }, TX);
}

// ---------------------------------------------------------------------------
// Schadenakte: Verknüpfung, bewusste Kostenübernahme
// ---------------------------------------------------------------------------

export async function linkDamageCase(tenantId: string, id: string, actor: Actor, damageCaseId: string | null): Promise<RecordRow> {
  try {
    return await db.$transaction(async (tx) => {
      const r = await lockRecord(tx, tenantId, id);
      if (damageCaseId) await checkLinks(tx, tenantId, r.vehicleId, null, damageCaseId);
      if ((damageCaseId || null) === r.damageCaseId) return r;
      const updated = await tx.maintenanceRecord.update({ where: { id: r.id }, data: { damageCaseId: damageCaseId || null } });
      await event(tx, tenantId, r.id, actor, { type: "DAMAGE_LINKED", fromValue: r.damageCaseId, toValue: damageCaseId });
      await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_DAMAGE_LINKED", details: { maintenanceNumber: r.maintenanceNumber, damageCaseId } });
      if (damageCaseId) await tx.damageCaseEvent.create({ data: { tenantId, caseId: damageCaseId, type: "NOTE_ADDED", note: `Reparaturvorgang ${r.maintenanceNumber} verknüpft`, userId: actor.id, userName: actor.name } });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** „Reparaturkosten in Schadenakte übernehmen“: ausdrücklich, mit Vorschau in der Oberfläche; überschreibt nie still. */
export async function adoptCostsIntoDamageCase(tenantId: string, id: string, actor: Actor): Promise<{ caseId: string; caseNumber: string; before: Cents | null; after: Cents }> {
  try {
    return await db.$transaction(async (tx) => {
      const r = await lockRecord(tx, tenantId, id);
      if (!r.damageCaseId) throw new DomainError("Der Vorgang ist mit keiner Schadenakte verknüpft.");
      if (r.actualCostCents == null) throw new DomainError("Am Vorgang sind noch keine tatsächlichen Kosten erfasst.");
      const lockedCase = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "DamageCase" WHERE "id" = ${r.damageCaseId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (lockedCase.length === 0) throw new DomainError("Schadenakte nicht gefunden.");
      const c = await tx.damageCase.findUniqueOrThrow({ where: { id: r.damageCaseId } });
      if (c.status === "CLOSED") throw new DomainError(`Die Schadenakte ${c.caseNumber} ist geschlossen.`);
      await tx.damageCase.update({ where: { id: c.id }, data: { actualCostCents: r.actualCostCents } });
      await tx.damageCaseEvent.create({ data: { tenantId, caseId: c.id, type: "COST_CHANGED", note: `Reparaturkosten ${c.actualCostCents == null ? "–" : fmtCents(c.actualCostCents)} → ${fmtCents(r.actualCostCents)} aus Wartungsvorgang ${r.maintenanceNumber} übernommen`, userId: actor.id, userName: actor.name } });
      await recordAudit(tx, tenantId, actor, { action: "DAMAGE_COST_CHANGED", bookingId: c.bookingId, amountCents: r.actualCostCents, details: { caseNumber: c.caseNumber, source: r.maintenanceNumber, actual: r.actualCostCents } });
      await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_COSTS_ADOPTED", amountCents: r.actualCostCents, details: { maintenanceNumber: r.maintenanceNumber, caseNumber: c.caseNumber } });
      return { caseId: c.id, caseNumber: c.caseNumber, before: c.actualCostCents, after: r.actualCostCents };
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

// ---------------------------------------------------------------------------
// Dokumente: eigene Uploads (VehicleDocument) und Verknüpfung vorhandener Schadendokumente (keine Dateikopie)
// ---------------------------------------------------------------------------

export type VehicleDocumentInput = { vehicleId: string; maintenanceId?: string | null; type: string; fileName: string; storageKey: string; contentType: string; sizeBytes: number; checksum: string; documentDate?: Date | null; description?: string | null };

export async function registerVehicleDocument(tenantId: string, actor: Actor, input: VehicleDocumentInput) {
  if (!(input.type in VEHICLE_DOCUMENT_TYPES)) throw new DomainError("Unbekannter Dokumenttyp.");
  try {
    return await db.$transaction(async (tx) => {
      const vehicle = await vehicleOf(tx, tenantId, input.vehicleId);
      let record: RecordRow | null = null;
      if (input.maintenanceId) {
        record = await lockRecord(tx, tenantId, input.maintenanceId);
        if (record.vehicleId !== vehicle.id) throw new DomainError("Der Wartungsvorgang gehört nicht zu diesem Fahrzeug.");
        if (record.status === "CANCELLED") throw new DomainError("Zu einem abgebrochenen Vorgang werden keine Dokumente mehr hinzugefügt.");
      }
      const doc = await tx.vehicleDocument.create({ data: { tenantId, vehicleId: vehicle.id, maintenanceId: record?.id ?? null, type: input.type, fileName: input.fileName.slice(0, 200), storageKey: input.storageKey, contentType: input.contentType, sizeBytes: input.sizeBytes, checksum: input.checksum, documentDate: input.documentDate ?? null, description: input.description?.trim() || null, createdById: actor.id, createdByName: actor.name } });
      if (record) {
        await event(tx, tenantId, record.id, actor, { type: "DOCUMENT_ADDED", toValue: input.type, note: doc.fileName });
        await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_DOCUMENT_ADDED", details: { maintenanceNumber: record.maintenanceNumber, documentId: doc.id, type: input.type } });
      } else {
        await recordAudit(tx, tenantId, actor, { action: "VEHICLE_DOCUMENT_ADDED", details: { vehicleId: vehicle.id, documentId: doc.id, type: input.type } });
      }
      return doc;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** Archivieren statt löschen: Datei und Zeile bleiben; abgeschlossene Vorgänge nur durch den Inhaber (prüft die Action). */
export async function archiveVehicleDocument(tenantId: string, documentId: string, actor: Actor, reason: string, opts: { allowCompleted: boolean }) {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund für die Archivierung angeben.");
  try {
    return await db.$transaction(async (tx) => {
      const doc = await tx.vehicleDocument.findFirst({ where: { id: documentId, tenantId } });
      if (!doc) throw new DomainError("Dokument nicht gefunden.");
      if (doc.archivedAt) throw new DomainError("Das Dokument ist bereits archiviert.");
      if (doc.maintenanceId) {
        const r = await tx.maintenanceRecord.findUniqueOrThrow({ where: { id: doc.maintenanceId } });
        if (r.status === "COMPLETED" && !opts.allowCompleted) throw new DomainError("Belege eines abgeschlossenen Vorgangs kann nur der Inhaber archivieren.");
        await event(tx, tenantId, r.id, actor, { type: "DOCUMENT_ARCHIVED", note: `${doc.fileName}: ${why}` });
      }
      const updated = await tx.vehicleDocument.update({ where: { id: doc.id }, data: { archivedAt: new Date(), archivedById: actor.id, archivedByName: actor.name, archiveReason: why } });
      await recordAudit(tx, tenantId, actor, { action: "VEHICLE_DOCUMENT_ARCHIVED", details: { vehicleId: doc.vehicleId, documentId: doc.id, reason: why } });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** Vorhandenes Schadendokument mit dem Vorgang verknüpfen – dieselbe Datei, kein zweiter Upload; doppelte Verknüpfung ist wirkungslos. */
export async function linkDamageDocument(tenantId: string, id: string, actor: Actor, damageCaseDocumentId: string) {
  try {
    return await db.$transaction(async (tx) => {
      const r = await lockRecord(tx, tenantId, id);
      if (r.status === "CANCELLED") throw new DomainError("Zu einem abgebrochenen Vorgang werden keine Dokumente mehr verknüpft.");
      const doc = await tx.damageCaseDocument.findFirst({ where: { id: damageCaseDocumentId, tenantId }, include: { case: { select: { vehicleId: true, caseNumber: true } } } });
      if (!doc) throw new DomainError("Schadendokument nicht gefunden.");
      if (doc.case.vehicleId !== r.vehicleId) throw new DomainError("Das Schadendokument gehört zu einem anderen Fahrzeug.");
      const existing = await tx.maintenanceDocumentLink.findFirst({ where: { maintenanceId: r.id, damageCaseDocumentId: doc.id } });
      if (existing) return { link: existing, created: false };
      const link = await tx.maintenanceDocumentLink.create({ data: { tenantId, maintenanceId: r.id, damageCaseDocumentId: doc.id, createdById: actor.id, createdByName: actor.name } });
      await event(tx, tenantId, r.id, actor, { type: "DOCUMENT_LINKED", toValue: doc.id, note: `${doc.fileName} (Schadenakte ${doc.case.caseNumber})` });
      await recordAudit(tx, tenantId, actor, { action: "MAINTENANCE_DOCUMENT_ADDED", details: { maintenanceNumber: r.maintenanceNumber, damageCaseDocumentId: doc.id, linked: true } });
      return { link, created: true };
    }, TX);
  } catch (e) {
    if (isUniqueViolation(e, "damageCaseDocumentId")) {
      const link = await db.maintenanceDocumentLink.findFirst({ where: { maintenanceId: id, damageCaseDocumentId } });
      if (link) return { link, created: false };
    }
    return domainFromDb(e);
  }
}

export async function addMaintenanceNote(tenantId: string, id: string, actor: Actor, note: string) {
  const text = note.trim();
  if (text.length < 2) throw new DomainError("Bitte eine Notiz eingeben.");
  return db.$transaction(async (tx) => {
    const r = await lockRecord(tx, tenantId, id);
    return event(tx, tenantId, r.id, actor, { type: "NOTE_ADDED", note: text.slice(0, 2000) });
  }, TX);
}

// ---------------------------------------------------------------------------
// Sichten
// ---------------------------------------------------------------------------

export type PlanWithDue = PlanRow & { due: DueResult; lastMaintenance: { id: string; maintenanceNumber: string; completedAt: Date | null; mileageAtService: number | null } | null };

export function planWithDue(plan: PlanRow & { lastMaintenance?: PlanWithDue["lastMaintenance"] }, vehicleMileage: number | null, now = new Date()): PlanWithDue {
  return { ...plan, lastMaintenance: plan.lastMaintenance ?? null, due: dueStatus({ nextDueDate: plan.nextDueDate, nextDueMileage: plan.nextDueMileage, warningDaysBefore: plan.warningDaysBefore, warningKilometersBefore: plan.warningKilometersBefore, isActive: plan.isActive }, vehicleMileage, now) };
}

const planInclude = { lastMaintenance: { select: { id: true, maintenanceNumber: true, completedAt: true, mileageAtService: true } } } as const;

export type MaintenanceView = Awaited<ReturnType<typeof maintenanceView>>;

export async function maintenanceView(tenantId: string, id: string) {
  const r = await db.maintenanceRecord.findFirst({
    where: { id, tenantId },
    include: {
      vehicle: { select: { id: true, plate: true, make: true, model: true, status: true, mileage: true, huDate: true } },
      plan: { include: planInclude },
      damageCase: { select: { id: true, caseNumber: true, status: true, liabilityStatus: true, actualCostCents: true, estimatedCostCents: true, description: true, documents: { orderBy: { createdAt: "desc" } } } },
      documents: { orderBy: { createdAt: "desc" } },
      documentLinks: { include: { damageCaseDocument: { include: { case: { select: { id: true, caseNumber: true } } } } }, orderBy: { createdAt: "desc" } },
      events: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!r) throw new DomainError("Wartungsvorgang nicht gefunden.");
  const [overlaps, futureBookings, cases] = await Promise.all([
    overlappingBookings(db, tenantId, r.vehicleId, r.scheduledAt, r.scheduledEndAt),
    activeAndFutureBookings(db, tenantId, r.vehicleId),
    db.damageCase.findMany({ where: { tenantId, vehicleId: r.vehicleId, status: { not: "CLOSED" } }, orderBy: { createdAt: "desc" }, select: { id: true, caseNumber: true, description: true, status: true } }),
  ]);
  const proposal = r.plan && !isFinal(r) ? proposeNextDue(r.plan, new Date(), r.mileageAtService ?? r.vehicle.mileage) : null;
  const linkedIds = new Set(r.documentLinks.map((l) => l.damageCaseDocumentId));
  return {
    ...r,
    plan: r.plan ? planWithDue(r.plan, r.vehicle.mileage) : null,
    overlaps,
    futureBookings,
    openCases: cases,
    proposal,
    /** Schadendokumente der verknüpften Akte, die noch nicht verknüpft sind (zum Verknüpfen ohne erneuten Upload) */
    linkableDamageDocuments: r.damageCase ? r.damageCase.documents.filter((d) => !linkedIds.has(d.id)) : [],
    activeDocuments: r.documents.filter((d) => !d.archivedAt),
    archivedDocuments: r.documents.filter((d) => !!d.archivedAt),
  };
}

export type YearCosts = { year: number; byType: { type: string; cents: Cents; count: number }[]; total: Cents };

/** Interne Wartungs-/Reparaturkosten je Jahr: nur tatsächliche Kosten erledigter Vorgänge. Keine Kundenrechnungen, keine Forderungen. */
export function costsByYear(records: { status: string; type: string; completedAt: Date | null; actualCostCents: number | null }[], years: number[]): YearCosts[] {
  return years.map((year) => {
    const rows = records.filter((r) => r.status === "COMPLETED" && r.completedAt && r.completedAt.getFullYear() === year && r.actualCostCents != null);
    const map = new Map<string, { cents: Cents; count: number }>();
    for (const r of rows) { const cur = map.get(r.type) ?? { cents: 0, count: 0 }; map.set(r.type, { cents: cur.cents + (r.actualCostCents ?? 0), count: cur.count + 1 }); }
    const byType = [...map.entries()].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.cents - a.cents);
    return { year, byType, total: byType.reduce((s, t) => s + t.cents, 0) };
  });
}

export type VehicleMaintenanceOverview = Awaited<ReturnType<typeof vehicleMaintenanceOverview>>;

/** Alles für die Fahrzeugakte: Pläne mit Warnstand, Vorgänge, Kosten je Jahr, Dokumente (eigene + Schadendokumente), HU-Stand. */
export async function vehicleMaintenanceOverview(tenantId: string, vehicleId: string, now = new Date()) {
  const vehicle = await db.vehicle.findFirst({ where: { id: vehicleId, tenantId }, select: { id: true, mileage: true, huDate: true, status: true } });
  if (!vehicle) throw new DomainError("Fahrzeug nicht gefunden.");
  const [plans, records, documents, damageDocuments] = await Promise.all([
    db.maintenancePlan.findMany({ where: { tenantId, vehicleId }, include: planInclude, orderBy: { createdAt: "asc" } }),
    db.maintenanceRecord.findMany({ where: { tenantId, vehicleId }, orderBy: [{ completedAt: "desc" }, { scheduledAt: "desc" }, { createdAt: "desc" }], include: { documents: { where: { archivedAt: null }, select: { id: true, fileName: true, type: true } }, damageCase: { select: { id: true, caseNumber: true } } } }),
    db.vehicleDocument.findMany({ where: { tenantId, vehicleId }, orderBy: { createdAt: "desc" }, include: { maintenance: { select: { id: true, maintenanceNumber: true, title: true } } } }),
    db.damageCaseDocument.findMany({ where: { tenantId, case: { vehicleId } }, orderBy: { createdAt: "desc" }, include: { case: { select: { id: true, caseNumber: true } } } }),
  ]);
  const dues = plans.map((p) => planWithDue(p, vehicle.mileage, now)).sort((a, b) => a.due.sortKey - b.due.sortKey);
  const open = records.filter((r) => !isFinal({ status: r.status } as RecordRow));
  const done = records.filter((r) => r.status === "COMPLETED");
  const lastHu = done.find((r) => r.type === "HU_AU") ?? null;
  const huPlan = dues.find((p) => p.type === "HU_AU" && p.isActive) ?? null;
  const huNext = huPlan?.nextDueDate ?? vehicle.huDate ?? null;
  const hu = { last: lastHu, next: huNext, due: huNext ? dueStatus({ nextDueDate: huNext, nextDueMileage: null, warningDaysBefore: huPlan?.warningDaysBefore ?? 30, warningKilometersBefore: 0 }, vehicle.mileage, now) : null };
  const year = now.getFullYear();
  return { vehicle, plans: dues, records, open, done, hu, costs: costsByYear(records, [year, year - 1]), documents, damageDocuments };
}

export type FleetFilter = "alle" | "ueberfaellig" | "bald" | "geplant" | "termin" | "in_arbeit" | "erledigt" | "hu" | "inspektion" | "reifen" | "reparatur" | "schaden";
export const FLEET_FILTERS: { key: FleetFilter; label: string }[] = [
  { key: "ueberfaellig", label: "Überfällig" }, { key: "bald", label: "Bald fällig" }, { key: "geplant", label: "Geplant" }, { key: "termin", label: "Werkstatttermin" }, { key: "in_arbeit", label: "In Arbeit" }, { key: "erledigt", label: "Erledigt" },
  { key: "hu", label: "HU/AU" }, { key: "inspektion", label: "Inspektion" }, { key: "reifen", label: "Reifen" }, { key: "reparatur", label: "Reparatur" }, { key: "schaden", label: "Schadenreparatur" }, { key: "alle", label: "Alle" },
];

/** Fälligkeiten aller aktiven Pläne des Mandanten mit Warnstand, dringendste zuerst. */
export async function fleetDues(tenantId: string, now = new Date()) {
  const plans = await db.maintenancePlan.findMany({ where: { tenantId, isActive: true, vehicle: { status: { not: "INACTIVE" } } }, include: { ...planInclude, vehicle: { select: { id: true, plate: true, make: true, model: true, mileage: true, status: true } } } });
  return plans.map((p) => ({ ...planWithDue(p, p.vehicle.mileage, now), vehicle: p.vehicle })).sort((a, b) => a.due.sortKey - b.due.sortKey);
}

/** Wartungsübersicht: Vorgänge nach Filter (Fälligkeitsfilter arbeiten auf den Plänen). */
export async function listMaintenance(tenantId: string, opts: { filter?: FleetFilter; q?: string; page?: number; pageSize?: number } = {}) {
  const filter = opts.filter ?? "alle";
  const q = opts.q?.trim() ?? "";
  const pageSize = Math.min(100, Math.max(10, opts.pageSize ?? 30));
  const page = Math.max(1, opts.page ?? 1);
  const byFilter: Record<FleetFilter, Prisma.MaintenanceRecordWhereInput> = {
    alle: {}, ueberfaellig: {}, bald: {}, geplant: { status: "PLANNED" }, termin: { status: "SCHEDULED" }, in_arbeit: { status: "IN_PROGRESS" }, erledigt: { status: "COMPLETED" },
    hu: { type: "HU_AU" }, inspektion: { type: "INSPECTION" }, reifen: { type: "TIRES" }, reparatur: { type: { in: ["REPAIR", "BRAKES", "AIR_CONDITIONING", "OTHER", "OIL_SERVICE"] } }, schaden: { type: "DAMAGE_REPAIR" },
  };
  const search: Prisma.MaintenanceRecordWhereInput = q ? { OR: [{ maintenanceNumber: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }, { workshopName: { contains: q, mode: "insensitive" } }, { vehicle: { OR: [{ plate: { contains: q, mode: "insensitive" } }, { make: { contains: q, mode: "insensitive" } }, { model: { contains: q, mode: "insensitive" } }] } }] } : {};
  const where: Prisma.MaintenanceRecordWhereInput = { tenantId, AND: [byFilter[filter], search] };
  const [total, items] = await Promise.all([
    db.maintenanceRecord.count({ where }),
    db.maintenanceRecord.findMany({ where, orderBy: [{ status: "asc" }, { scheduledAt: "asc" }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize, include: { vehicle: { select: { id: true, plate: true, make: true, model: true, status: true } }, damageCase: { select: { id: true, caseNumber: true } } } }),
  ]);
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), filter, q };
}

/** Kennzahlen für Dashboard und Heute-Seite. */
export async function maintenanceCounts(tenantId: string, now = new Date()) {
  const dues = await fleetDues(tenantId, now);
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
  const weekEnd = new Date(startOfDay.getTime() + 7 * 86_400_000);
  const [appointmentsWeek, appointmentsToday, inWorkshop, inProgress] = await Promise.all([
    db.maintenanceRecord.count({ where: { tenantId, status: { in: ["SCHEDULED", "IN_PROGRESS"] }, scheduledAt: { gte: startOfDay, lt: weekEnd } } }),
    db.maintenanceRecord.findMany({ where: { tenantId, status: { in: ["SCHEDULED", "IN_PROGRESS"] }, scheduledAt: { gte: startOfDay, lt: endOfDay } }, orderBy: { scheduledAt: "asc" }, include: { vehicle: { select: { id: true, plate: true, make: true, model: true } } } }),
    db.vehicle.count({ where: { tenantId, status: "WORKSHOP" } }),
    db.maintenanceRecord.count({ where: { tenantId, status: "IN_PROGRESS" } }),
  ]);
  return {
    overdue: dues.filter((d) => d.due.level === "OVERDUE" || d.due.level === "DUE").length,
    soon: dues.filter((d) => d.due.level === "SOON").length,
    overdueList: dues.filter((d) => d.due.level === "OVERDUE" || d.due.level === "DUE"),
    huSoonList: dues.filter((d) => d.type === "HU_AU" && d.due.level !== "OK" && d.due.level !== "NONE"),
    appointmentsWeek,
    appointmentsToday,
    inWorkshop,
    inProgress,
  };
}
