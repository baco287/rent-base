"use server";

// Aktionen der Schadenakte. Rollen: OWNER und DISPO alle Vorgänge; YARD nur Notizen (Fotos und Dokumente laufen über die
// API-Routen, ebenfalls für alle Rollen). Jede Aktion prüft Rolle und Mandant serverseitig; Beträge rechnet der Server.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { DAMAGE_CASE_PRIORITY, DAMAGE_CASE_STATUS, DAMAGE_TAX_TREATMENTS, LIABILITY_STATUS } from "@/lib/constants";
import { addCaseNote, blockVehicleForCase, changeCaseStatus, chargeCustomer, closeCase, openDamageCase, releaseVehicleForCase, reopenCase, setCaseCosts, setCasePriority, setCaseRepair, setInternalNote, setLiability } from "@/lib/damage-cases";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { parseLocalDateTime } from "@/lib/time";

export type CaseState = { error?: string; ok?: string } | undefined;

const text = (max: number) => z.string().trim().max(max).optional();
const keys = <T extends object>(o: T) => Object.keys(o) as [string, ...string[]];

async function ctx(caseId: string, ...roles: ("DISPO" | "YARD")[]) {
  const { tenant, user } = roles.length ? await requireRole(...roles) : await requireRole("DISPO");
  const c = await db.damageCase.findFirst({ where: { id: caseId, tenantId: tenant.id }, select: { id: true, bookingId: true, vehicleId: true } });
  if (!c) return null;
  return { tenant, user, c, actor: { id: user.id, name: user.name } };
}

function refresh(caseId: string, bookingId?: string | null, vehicleId?: string | null) {
  for (const p of [`/schaeden/${caseId}`, "/schaeden", "/heute", "/fahrzeuge", "/rechnungen"]) revalidatePath(p);
  if (bookingId) { revalidatePath(`/buchungen/${bookingId}`); revalidatePath(`/buchungen/${bookingId}/rechnung`); revalidatePath(`/buchungen/${bookingId}/rueckgabe`); }
  if (vehicleId) revalidatePath(`/fahrzeuge/${vehicleId}`);
}

function asState(e: unknown): CaseState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Dieser Teil der Akte ist festgeschrieben und kann nicht mehr geändert werden." };
  throw e;
}

/** „Schadenakte eröffnen“ – aus Fahrzeugakte, Buchung oder Rückgabe. Alle Rollen; liefert bei Doppelklick dieselbe Akte. */
export async function openDamageCaseAction(damageId: string, _prev: CaseState, _fd: FormData): Promise<CaseState> {
  void _fd;
  const { tenant, user } = await requireRole("DISPO", "YARD");
  let target: string;
  try {
    const { damageCase } = await openDamageCase(tenant.id, damageId, { id: user.id, name: user.name });
    target = damageCase.id;
    refresh(damageCase.id, damageCase.bookingId, damageCase.vehicleId);
  } catch (e) {
    return asState(e);
  }
  redirect(`/schaeden/${target}?neu=1`);
}

const statusSchema = z.object({ to: z.enum(keys(DAMAGE_CASE_STATUS)), note: text(500) });
export async function changeStatusAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = statusSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültiger Status." };
  try {
    const c = await changeCaseStatus(x.tenant.id, caseId, x.actor, p.data.to, p.data.note);
    refresh(caseId, c.bookingId, c.vehicleId);
    return { ok: `Status: ${DAMAGE_CASE_STATUS[c.status as keyof typeof DAMAGE_CASE_STATUS]}.` };
  } catch (e) {
    return asState(e);
  }
}

const prioSchema = z.object({ priority: z.enum(keys(DAMAGE_CASE_PRIORITY)) });
export async function setPriorityAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = prioSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Priorität." };
  try {
    await setCasePriority(x.tenant.id, caseId, x.actor, p.data.priority);
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
    return { ok: "Priorität gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

const liabilitySchema = z.object({ status: z.enum(keys(LIABILITY_STATUS)), note: text(1000) });
export async function setLiabilityAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = liabilitySchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültiger Haftungsstatus." };
  try {
    const c = await setLiability(x.tenant.id, caseId, x.actor, p.data.status, p.data.note);
    refresh(caseId, c.bookingId, c.vehicleId);
    return { ok: `Haftung: ${LIABILITY_STATUS[c.liabilityStatus as keyof typeof LIABILITY_STATUS]}.` };
  } catch (e) {
    return asState(e);
  }
}

const costSchema = z.object({ estimated: text(20), actual: text(20) });
export async function setCostsAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = costSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  try {
    await setCaseCosts(x.tenant.id, caseId, x.actor, { estimated: p.data.estimated ?? null, actual: p.data.actual ?? null });
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
    return { ok: "Kosten gespeichert. Es wurde keine Forderung und keine Rechnung erzeugt." };
  } catch (e) {
    return asState(e);
  }
}

const repairSchema = z.object({ provider: text(200), appointmentAt: text(30), completedAt: text(30) });
export async function setRepairAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = repairSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  const appointmentAt = p.data.appointmentAt ? parseLocalDateTime(p.data.appointmentAt) : null;
  const completedAt = p.data.completedAt ? parseLocalDateTime(p.data.completedAt) : null;
  if ((p.data.appointmentAt && !appointmentAt) || (p.data.completedAt && !completedAt)) return { error: "Bitte gültige Zeitpunkte angeben." };
  try {
    await setCaseRepair(x.tenant.id, caseId, x.actor, { provider: p.data.provider ?? null, appointmentAt, completedAt });
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
    return { ok: "Reparaturdaten gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

const noteSchema = z.object({ note: z.string().trim().min(2, "Bitte eine Notiz eingeben.").max(2000) });
/** Operative Notiz: auch Hofmitarbeiter. */
export async function addNoteAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId, "DISPO", "YARD");
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = noteSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await addCaseNote(x.tenant.id, caseId, x.actor, p.data.note);
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
    return { ok: "Notiz gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

const internalSchema = z.object({ note: text(4000) });
export async function setInternalNoteAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = internalSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  try {
    await setInternalNote(x.tenant.id, caseId, x.actor, p.data.note ?? null);
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
    return { ok: "Interne Notiz gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

const reasonSchema = z.object({ reason: z.string().trim().min(3, "Bitte einen Grund angeben.").max(500) });
export async function closeCaseAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = reasonSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await closeCase(x.tenant.id, caseId, x.actor, p.data.reason);
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
    return { ok: "Die Schadenakte ist geschlossen. Das Fahrzeug wurde dadurch nicht freigegeben." };
  } catch (e) {
    return asState(e);
  }
}

export async function reopenCaseAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = reasonSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await reopenCase(x.tenant.id, caseId, x.actor, p.data.reason);
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
    return { ok: "Die Schadenakte ist wieder geöffnet." };
  } catch (e) {
    return asState(e);
  }
}

const noteOptSchema = z.object({ note: text(500) });
export async function blockVehicleAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = noteOptSchema.safeParse(Object.fromEntries(fd));
  try {
    const r = await blockVehicleForCase(x.tenant.id, caseId, x.actor, p.success ? p.data.note : null);
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
    return { ok: r.futureBookings > 0 ? `Fahrzeug gesperrt. Achtung: ${r.futureBookings} ${r.futureBookings === 1 ? "laufende oder künftige Buchung ist" : "laufende oder künftige Buchungen sind"} betroffen – bitte in der Dispo prüfen (nichts wurde storniert).` : "Fahrzeug gesperrt. Es ist nicht mehr buchbar und nicht übergebbar." };
  } catch (e) {
    return asState(e);
  }
}

export async function releaseVehicleAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = noteOptSchema.safeParse(Object.fromEntries(fd));
  try {
    await releaseVehicleForCase(x.tenant.id, caseId, x.actor, p.success ? p.data.note : null);
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
    return { ok: "Fahrzeug wieder freigegeben (Status Verfügbar)." };
  } catch (e) {
    return asState(e);
  }
}

const chargeSchema = z.object({
  amount: z.string().trim().min(1, "Bitte den Betrag eingeben."),
  basis: z.string().trim().min(5, "Bitte die Grundlage der Kundenbelastung beschreiben (Pflichtfeld).").max(500),
  taxTreatment: z.enum(keys(DAMAGE_TAX_TREATMENTS), { message: "Bitte die steuerliche Behandlung auswählen." }),
  confirm: z.literal("1", { message: "Bitte die Belastung ausdrücklich bestätigen." }),
  nonce: z.string().min(8),
});

/** „Schaden dem Kunden berechnen“: erzeugt die Kundenbelastung und die Schadenabrechnung als Entwurf, dann weiter zum Rechnungsentwurf. */
export async function chargeCustomerAction(caseId: string, _prev: CaseState, fd: FormData): Promise<CaseState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Schadenakte nicht gefunden." };
  const p = chargeSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  let target: string;
  try {
    const r = await chargeCustomer(x.tenant.id, caseId, x.actor, { amount: p.data.amount, basis: p.data.basis, taxTreatment: p.data.taxTreatment, nonce: p.data.nonce });
    target = r.invoiceId;
    refresh(caseId, x.c.bookingId, x.c.vehicleId);
  } catch (e) {
    return asState(e);
  }
  redirect(`/buchungen/${x.c.bookingId}/rechnung?nr=${target}`);
}
