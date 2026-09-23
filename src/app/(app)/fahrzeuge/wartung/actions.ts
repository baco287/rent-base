"use server";

// Aktionen des Wartungsmanagements. Rollen: OWNER und DISPO alle Vorgänge (Pläne, Vorgänge, Termine, Kosten, Sperren/
// Freigeben, Schadenakte, Abschluss, Archivierung). YARD: Kilometer dokumentieren, Notizen, „In Arbeit“ setzen; Belege
// laufen über die API-Route. Jede Aktion prüft Rolle und Mandant serverseitig; Beträge rechnet der Server.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { MAINTENANCE_PRIORITY, MAINTENANCE_STATUS, MAINTENANCE_TYPES } from "@/lib/constants";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { addMaintenanceNote, adoptCostsIntoDamageCase, archiveVehicleDocument, blockVehicleForMaintenance, cancelMaintenance, changeMaintenanceStatus, completeMaintenance, createMaintenance, createPlan, documentMileage, linkDamageCase, linkDamageDocument, releaseVehicleAfterMaintenance, setMaintenanceCosts, setPlanActive, updateMaintenance, updatePlan } from "@/lib/maintenance";
import { parseLocalDateTime } from "@/lib/time";

export type MaintState = { error?: string; ok?: string; warnings?: string[] } | undefined;

const text = (max: number) => z.string().trim().max(max).optional();
const keys = <T extends object>(o: T) => Object.keys(o) as [string, ...string[]];
const dateTime = (v: string | undefined) => (v ? parseLocalDateTime(v) : null);
const date = (v: string | undefined) => (v ? parseLocalDateTime(`${v}T12:00`) : null);

function refresh(vehicleId?: string | null, maintenanceId?: string | null, caseId?: string | null) {
  for (const p of ["/fahrzeuge/wartung", "/fahrzeuge", "/heute"]) revalidatePath(p);
  if (vehicleId) revalidatePath(`/fahrzeuge/${vehicleId}`);
  if (maintenanceId) revalidatePath(`/fahrzeuge/wartung/${maintenanceId}`);
  if (caseId) revalidatePath(`/schaeden/${caseId}`);
}

function asState(e: unknown): MaintState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Dieser Vorgang ist abgeschlossen und kann nicht mehr geändert werden." };
  throw e;
}

async function ctx(maintenanceId: string, ...roles: ("DISPO" | "YARD")[]) {
  const { tenant, user } = roles.length ? await requireRole(...roles) : await requireRole("DISPO");
  const r = await db.maintenanceRecord.findFirst({ where: { id: maintenanceId, tenantId: tenant.id }, select: { id: true, vehicleId: true, damageCaseId: true } });
  if (!r) return null;
  return { tenant, user, r, actor: { id: user.id, name: user.name } };
}

// ---------------------------------------------------------------------------
// Wartungspläne
// ---------------------------------------------------------------------------

const planSchema = z.object({
  type: z.enum(keys(MAINTENANCE_TYPES)),
  title: text(120),
  intervalMonths: text(4),
  intervalKilometers: text(10),
  nextDueDate: text(10),
  nextDueMileage: text(10),
  warningDaysBefore: z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().int().min(0).max(365).optional()),
  warningKilometersBefore: z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().int().min(0).max(100000).optional()),
  note: text(500),
});

export async function createPlanAction(vehicleId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const { tenant, user } = await requireRole("DISPO");
  const p = planSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await createPlan(tenant.id, { id: user.id, name: user.name }, { vehicleId, ...p.data, nextDueDate: date(p.data.nextDueDate) });
    refresh(vehicleId);
    return { ok: "Wartungsplan angelegt." };
  } catch (e) {
    return asState(e);
  }
}

export async function updatePlanAction(planId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const { tenant, user } = await requireRole("DISPO");
  const p = planSchema.extend({ isActive: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional() }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const plan = await updatePlan(tenant.id, planId, { id: user.id, name: user.name }, { ...p.data, nextDueDate: date(p.data.nextDueDate), isActive: p.data.isActive });
    refresh(plan.vehicleId);
    return { ok: "Wartungsplan gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

export async function setPlanActiveAction(planId: string, isActive: boolean, _prev: MaintState, _fd: FormData): Promise<MaintState> {
  void _fd;
  const { tenant, user } = await requireRole("DISPO");
  try {
    const plan = await setPlanActive(tenant.id, planId, { id: user.id, name: user.name }, isActive);
    refresh(plan.vehicleId);
    return { ok: isActive ? "Wartungsplan aktiviert." : "Wartungsplan deaktiviert – er erzeugt keine Warnung mehr." };
  } catch (e) {
    return asState(e);
  }
}

// ---------------------------------------------------------------------------
// Wartungsvorgänge
// ---------------------------------------------------------------------------

const createSchema = z.object({
  type: z.enum(keys(MAINTENANCE_TYPES)),
  title: z.string().trim().min(2, "Bitte einen Titel angeben.").max(160),
  description: text(2000),
  priority: z.enum(keys(MAINTENANCE_PRIORITY)).optional(),
  planId: text(40),
  damageCaseId: text(40),
  workshopName: text(160),
  workshopContact: text(200),
  scheduledAt: text(20),
  scheduledEndAt: text(20),
  mileageAtService: text(12),
  estimatedCostCents: text(20),
  internalNote: text(2000),
  blockVehicle: z.preprocess((v) => v === "1" || v === "on", z.boolean()).optional(),
});

/** „Wartung / Werkstatt hinzufügen“ – leitet danach zum Vorgang weiter; Warnungen (Überschneidung, Buchungen) zeigt die Vorgangsseite. */
export async function createMaintenanceAction(vehicleId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const { tenant, user } = await requireRole("DISPO");
  const p = createSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  const scheduledAt = dateTime(p.data.scheduledAt);
  const scheduledEndAt = dateTime(p.data.scheduledEndAt);
  if ((p.data.scheduledAt && !scheduledAt) || (p.data.scheduledEndAt && !scheduledEndAt)) return { error: "Bitte einen gültigen Termin angeben." };
  let id: string;
  try {
    const res = await createMaintenance(tenant.id, { id: user.id, name: user.name }, { vehicleId, ...p.data, planId: p.data.planId || null, damageCaseId: p.data.damageCaseId || null, scheduledAt, scheduledEndAt });
    id = res.record.id;
    refresh(vehicleId, id, p.data.damageCaseId || null);
  } catch (e) {
    return asState(e);
  }
  redirect(`/fahrzeuge/wartung/${id}?neu=1`);
}

const updateSchema = createSchema.omit({ planId: true, damageCaseId: true, blockVehicle: true, mileageAtService: true }).partial();

export async function updateMaintenanceAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = updateSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  const scheduledAt = dateTime(p.data.scheduledAt);
  const scheduledEndAt = dateTime(p.data.scheduledEndAt);
  if ((p.data.scheduledAt && !scheduledAt) || (p.data.scheduledEndAt && !scheduledEndAt)) return { error: "Bitte einen gültigen Termin angeben." };
  try {
    const res = await updateMaintenance(x.tenant.id, maintenanceId, x.actor, { ...p.data, scheduledAt, scheduledEndAt });
    refresh(x.r.vehicleId, maintenanceId, x.r.damageCaseId);
    return { ok: "Vorgang gespeichert.", warnings: res.overlaps.map((b) => `Werkstatttermin überschneidet sich mit Buchung ${b.number}.`) };
  } catch (e) {
    return asState(e);
  }
}

const statusSchema = z.object({ to: z.enum(keys(MAINTENANCE_STATUS)) });
/** Statuswechsel; „In Arbeit“ darf auch der Hofmitarbeiter setzen, alles andere die Disposition. */
export async function changeStatusAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const p = statusSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültiger Status." };
  const x = p.data.to === "IN_PROGRESS" ? await ctx(maintenanceId, "DISPO", "YARD") : await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  try {
    const r = await changeMaintenanceStatus(x.tenant.id, maintenanceId, x.actor, p.data.to);
    refresh(x.r.vehicleId, maintenanceId, x.r.damageCaseId);
    return { ok: `Status: ${MAINTENANCE_STATUS[r.status as keyof typeof MAINTENANCE_STATUS]}.` };
  } catch (e) {
    return asState(e);
  }
}

const costSchema = z.object({ estimated: text(20), actual: text(20) });
export async function setCostsAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = costSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  try {
    await setMaintenanceCosts(x.tenant.id, maintenanceId, x.actor, { estimated: p.data.estimated ?? null, actual: p.data.actual ?? null });
    refresh(x.r.vehicleId, maintenanceId, x.r.damageCaseId);
    return { ok: "Kosten gespeichert. Es wurde keine Rechnung, Forderung oder Schadenakte verändert." };
  } catch (e) {
    return asState(e);
  }
}

const mileageSchema = z.object({ mileage: z.string().trim().min(1, "Bitte einen Kilometerstand eingeben.").max(12) });
/** Kilometerstand dokumentieren – auch Hofmitarbeiter. */
export async function documentMileageAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId, "DISPO", "YARD");
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = mileageSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const res = await documentMileage(x.tenant.id, maintenanceId, x.actor, p.data.mileage);
    refresh(x.r.vehicleId, maintenanceId);
    return { ok: "Kilometerstand dokumentiert.", warnings: res.warnings };
  } catch (e) {
    return asState(e);
  }
}

const completeSchema = z.object({
  completedAt: z.string().trim().min(1, "Bitte das Abschlussdatum angeben."),
  mileage: text(12),
  actualCost: text(20),
  workDone: text(2000),
  setNextDue: z.preprocess((v) => v === "1" || v === "on", z.boolean()).optional(),
  nextDueDate: text(10),
  nextDueMileage: text(12),
});

/** „Als erledigt markieren“. */
export async function completeMaintenanceAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = completeSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  const completedAt = dateTime(p.data.completedAt);
  if (!completedAt) return { error: "Bitte ein gültiges Abschlussdatum angeben." };
  const nextDueDate = date(p.data.nextDueDate);
  if (p.data.nextDueDate && !nextDueDate) return { error: "Bitte ein gültiges Fälligkeitsdatum angeben." };
  try {
    const res = await completeMaintenance(x.tenant.id, maintenanceId, x.actor, { completedAt, mileage: p.data.mileage ?? null, actualCost: p.data.actualCost ?? null, workDone: p.data.workDone ?? null, setNextDue: p.data.setNextDue, nextDueDate, nextDueMileage: p.data.nextDueMileage ?? null });
    refresh(x.r.vehicleId, maintenanceId, x.r.damageCaseId);
    const warnings = [...res.warnings];
    if (res.vehicleStatus === "WORKSHOP") warnings.push("Das Fahrzeug ist weiterhin für die Werkstatt gesperrt. Freigeben ist eine eigene Entscheidung (unten unter „Fahrzeug“).");
    return { ok: `Vorgang ${res.record.maintenanceNumber} ist erledigt.`, warnings };
  } catch (e) {
    return asState(e);
  }
}

const reasonSchema = z.object({ reason: z.string().trim().min(3, "Bitte einen Grund angeben.").max(500) });
export async function cancelMaintenanceAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = reasonSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await cancelMaintenance(x.tenant.id, maintenanceId, x.actor, p.data.reason);
    refresh(x.r.vehicleId, maintenanceId, x.r.damageCaseId);
    return { ok: "Vorgang abgebrochen. Das Fahrzeug wurde dadurch nicht freigegeben." };
  } catch (e) {
    return asState(e);
  }
}

const noteOptSchema = z.object({ note: text(500) });
export async function blockVehicleAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = noteOptSchema.safeParse(Object.fromEntries(fd));
  try {
    const res = await blockVehicleForMaintenance(x.tenant.id, maintenanceId, x.actor, p.success ? p.data.note : null);
    refresh(x.r.vehicleId, maintenanceId);
    const n = res.futureBookings.length;
    return { ok: "Fahrzeug für die Werkstatt gesperrt. Es ist nicht mehr buchbar und nicht übergebbar.", warnings: n > 0 ? [`Dieses Fahrzeug ist noch in ${n} ${n === 1 ? "laufenden/künftigen Buchung" : "laufenden/künftigen Buchungen"} eingeplant (${res.futureBookings.slice(0, 3).map((b) => b.number).join(", ")}${n > 3 ? ", …" : ""}). Nichts wurde storniert oder umgebucht.`] : [] };
  } catch (e) {
    return asState(e);
  }
}

export async function releaseVehicleAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = noteOptSchema.safeParse(Object.fromEntries(fd));
  try {
    await releaseVehicleAfterMaintenance(x.tenant.id, maintenanceId, x.actor, p.success ? p.data.note : null);
    refresh(x.r.vehicleId, maintenanceId);
    return { ok: "Fahrzeug freigegeben (Status Verfügbar)." };
  } catch (e) {
    return asState(e);
  }
}

const linkSchema = z.object({ damageCaseId: text(40) });
export async function linkDamageCaseAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = linkSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  try {
    const r = await linkDamageCase(x.tenant.id, maintenanceId, x.actor, p.data.damageCaseId || null);
    refresh(x.r.vehicleId, maintenanceId, x.r.damageCaseId ?? r.damageCaseId);
    if (r.damageCaseId) revalidatePath(`/schaeden/${r.damageCaseId}`);
    return { ok: r.damageCaseId ? "Schadenakte verknüpft. Haftung, Kosten und Kundenbelastung der Akte bleiben unverändert." : "Verknüpfung entfernt." };
  } catch (e) {
    return asState(e);
  }
}

const confirmSchema = z.object({ confirm: z.literal("1", { message: "Bitte die Übernahme ausdrücklich bestätigen." }) });
/** „Reparaturkosten in Schadenakte übernehmen“ – mit Vorschau in der Oberfläche und ausdrücklicher Bestätigung. */
export async function adoptCostsAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = confirmSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const res = await adoptCostsIntoDamageCase(x.tenant.id, maintenanceId, x.actor);
    refresh(x.r.vehicleId, maintenanceId, res.caseId);
    return { ok: `Tatsächliche Reparaturkosten in Schadenakte ${res.caseNumber} übernommen. Haftung und Kundenbelastung bleiben unverändert.` };
  } catch (e) {
    return asState(e);
  }
}

const docLinkSchema = z.object({ damageCaseDocumentId: z.string().min(1) });
export async function linkDamageDocumentAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId);
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = docLinkSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  try {
    const res = await linkDamageDocument(x.tenant.id, maintenanceId, x.actor, p.data.damageCaseDocumentId);
    refresh(x.r.vehicleId, maintenanceId, x.r.damageCaseId);
    return { ok: res.created ? "Dokument verknüpft – dieselbe Datei, kein zweiter Upload." : "Das Dokument war bereits verknüpft." };
  } catch (e) {
    return asState(e);
  }
}

const noteSchema = z.object({ note: z.string().trim().min(2, "Bitte eine Notiz eingeben.").max(2000) });
/** Operative Notiz – auch Hofmitarbeiter. */
export async function addNoteAction(maintenanceId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const x = await ctx(maintenanceId, "DISPO", "YARD");
  if (!x) return { error: "Wartungsvorgang nicht gefunden." };
  const p = noteSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await addMaintenanceNote(x.tenant.id, maintenanceId, x.actor, p.data.note);
    refresh(x.r.vehicleId, maintenanceId);
    return { ok: "Notiz gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

/** Dokument archivieren statt löschen: Disposition vor Abschluss, nach Abschluss nur der Inhaber. */
export async function archiveDocumentAction(documentId: string, _prev: MaintState, fd: FormData): Promise<MaintState> {
  const { tenant, user } = await requireRole("DISPO");
  const p = reasonSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const doc = await archiveVehicleDocument(tenant.id, documentId, { id: user.id, name: user.name }, p.data.reason, { allowCompleted: user.role === "OWNER" });
    refresh(doc.vehicleId, doc.maintenanceId);
    return { ok: "Dokument archiviert. Datei und Eintrag bleiben nachvollziehbar erhalten." };
  } catch (e) {
    return asState(e);
  }
}
