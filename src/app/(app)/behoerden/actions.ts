"use server";

// Aktionen des Behörden- und Bußgeldmanagements. Rollen: OWNER und DISPO alle Vorgangsschritte (Erfassen, Zuordnen,
// Fahrerbestimmung, Antwort vorbereiten/freigeben/übermitteln, Nachweise, Abschluss/Wiederöffnen). YARD: nur lesen –
// keine Fahrerfreigabe, keine Antwortfreigabe, keine Übermittlung. Jede Aktion prüft Rolle und Mandant serverseitig.
// Kein Schritt dieses Moduls erzeugt eine Zahlung, Zusatzkosten oder Kautionsbewegung; eine Rechnung nur als Entwurf für ein im
// Mietvertrag vereinbartes Bearbeitungsentgelt.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { AUTHORITY_CASE_TYPES, AUTHORITY_RESPONSE_TYPES, SUBMISSION_METHODS } from "@/lib/constants";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { addAuthorityNote, approveResponse, archiveAuthorityDocument, assignBooking, assignVehicle, cancelAuthorityCase, closeAuthorityCase, createAuthorityCase, prepareResponse, rematchCase, reopenAuthorityCase, setDriver, setInternalNote, submitResponse, updateAuthorityCase, type CaseInput } from "@/lib/authority";
import { parseLocalDateTime } from "@/lib/time";
import { recordAudit } from "@/lib/audit";
import { isValidEmail } from "@/lib/mail";
import { runQuickResponse } from "@/lib/authority-quick";
import { ensureAuthorityFeeInvoice, type FeeOutcome } from "@/lib/authority-fee";
import { deleteContact, updateContact } from "@/lib/authority-contacts";
import { sendAuthorityReminders } from "@/lib/authority-reminders";

export type AuthState = { error?: string; ok?: string; warnings?: string[] } | undefined;

const text = (max: number) => z.string().trim().max(max).optional();
const keys = <T extends object>(o: T) => Object.keys(o) as [string, ...string[]];
const date = (v: string | undefined) => (v ? parseLocalDateTime(`${v}T12:00`) : null);
const flag = z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional();

function refresh(caseId?: string | null, vehicleId?: string | null, bookingId?: string | null, customerId?: string | null) {
  for (const p of ["/behoerden", "/heute"]) revalidatePath(p);
  if (caseId) revalidatePath(`/behoerden/${caseId}`);
  if (vehicleId) revalidatePath(`/fahrzeuge/${vehicleId}`);
  if (bookingId) revalidatePath(`/buchungen/${bookingId}`);
  if (customerId) revalidatePath(`/kunden/${customerId}`);
}

function asState(e: unknown): AuthState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Diese Fassung ist freigegeben oder übermittelt und kann nicht mehr geändert werden." };
  throw e;
}

/** Nur OWNER/DISPO; liefert den Vorgang des eigenen Mandanten. */
async function ctx(caseId: string) {
  const { tenant, user } = await requireRole("DISPO");
  const c = await db.authorityCase.findFirst({ where: { id: caseId, tenantId: tenant.id }, select: { id: true, vehicleId: true, bookingId: true, driverCustomerId: true } });
  if (!c) return null;
  return { tenant, user, c, actor: { id: user.id, name: user.name } };
}

// ---------------------------------------------------------------------------
// Erfassen und Stammdaten
// ---------------------------------------------------------------------------

const caseSchema = z.object({
  type: z.enum(keys(AUTHORITY_CASE_TYPES)),
  authorityName: z.string().trim().min(2, "Bitte die Behörde angeben.").max(160),
  authorityDepartment: text(160),
  authorityReference: z.string().trim().min(1, "Bitte das behördliche Aktenzeichen angeben.").max(80),
  authorityAddress: text(400),
  authorityEmail: text(160),
  authorityPortalUrl: text(300),
  offenseType: text(160),
  offenseDescription: text(2000),
  offenseDate: z.string().trim().min(1, "Bitte das Tatdatum angeben.").max(10),
  offenseTime: text(5),
  offenseLocation: text(200),
  licensePlate: z.string().trim().min(1, "Bitte das Kennzeichen laut Schreiben angeben.").max(20),
  responseDeadline: text(10),
  noticeAmount: text(20),
  notes: text(2000),
  uploadId: text(40),
});

function toInput(d: z.infer<typeof caseSchema>): CaseInput {
  const responseDeadline = date(d.responseDeadline);
  if (d.responseDeadline && !responseDeadline) throw new DomainError("Bitte eine gültige Antwortfrist angeben.");
  return { ...d, responseDeadline, noticeAmount: d.noticeAmount ?? null };
}

/** Schreiben manuell erfassen – danach automatische Zuordnung; leitet zum Vorgang weiter. */
export async function createCaseAction(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const { tenant, user } = await requireRole("DISPO");
  const p = caseSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  let id: string;
  try {
    const c = await createAuthorityCase(tenant.id, { id: user.id, name: user.name }, toInput(p.data));
    id = c.id;
    refresh(id, c.vehicleId, c.bookingId);
  } catch (e) {
    return asState(e);
  }
  redirect(`/behoerden/${id}?neu=1`);
}

export async function updateCaseAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = caseSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const c = await updateAuthorityCase(x.tenant.id, caseId, x.actor, toInput(p.data));
    refresh(caseId, x.c.vehicleId ?? c.vehicleId, x.c.bookingId ?? c.bookingId);
    if (c.vehicleId !== x.c.vehicleId) refresh(null, c.vehicleId);
    if (c.bookingId !== x.c.bookingId) refresh(null, null, c.bookingId);
    return { ok: "Vorgangsdaten gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

export async function rematchAction(caseId: string, _prev: AuthState, _fd: FormData): Promise<AuthState> {
  void _fd;
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  try {
    const c = await rematchCase(x.tenant.id, caseId, x.actor);
    refresh(caseId, x.c.vehicleId, x.c.bookingId);
    refresh(null, c.vehicleId, c.bookingId);
    return { ok: "Zuordnung neu geprüft." };
  } catch (e) {
    return asState(e);
  }
}

const vehicleSchema = z.object({ vehicleId: text(40) });
export async function assignVehicleAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = vehicleSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  try {
    const c = await assignVehicle(x.tenant.id, caseId, x.actor, p.data.vehicleId || null);
    refresh(caseId, x.c.vehicleId, x.c.bookingId);
    refresh(null, c.vehicleId, c.bookingId);
    return { ok: c.vehicleId ? "Fahrzeug zugeordnet; die Vermietung wurde neu gesucht." : "Fahrzeugzuordnung entfernt." };
  } catch (e) {
    return asState(e);
  }
}

const bookingSchema = z.object({ bookingId: text(40) });
export async function assignBookingAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = bookingSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  try {
    const c = await assignBooking(x.tenant.id, caseId, x.actor, p.data.bookingId || null);
    refresh(caseId, x.c.vehicleId, x.c.bookingId, x.c.driverCustomerId);
    refresh(null, c.vehicleId, c.bookingId);
    return { ok: c.bookingId ? "Vermietung zugeordnet. Damit ist noch kein Fahrer bestimmt." : "Zuordnung der Vermietung entfernt." };
  } catch (e) {
    return asState(e);
  }
}

// ---------------------------------------------------------------------------
// Fahrerbestimmung – bewusste Entscheidung eines berechtigten Mitarbeiters
// ---------------------------------------------------------------------------

const driverSchema = z.object({
  mode: z.enum(["CONTRACT", "OTHER", "NOT_IDENTIFIABLE", "NO_INFORMATION", "UNDETERMINED"]),
  contractDriverId: text(40),
  confirmed: flag,
  firstName: text(80),
  lastName: text(80),
  birthDate: text(10),
  street: text(120),
  zip: text(12),
  city: text(80),
  country: text(2),
  note: text(1000),
});

export async function setDriverAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = driverSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  const d = p.data;
  try {
    const c = d.mode === "CONTRACT"
      ? await setDriver(x.tenant.id, caseId, x.actor, { mode: "CONTRACT", contractDriverId: d.contractDriverId ?? "", confirmed: !!d.confirmed, note: d.note })
      : d.mode === "OTHER"
        ? await setDriver(x.tenant.id, caseId, x.actor, { mode: "OTHER", person: { firstName: d.firstName ?? "", lastName: d.lastName ?? "", birthDate: d.birthDate, street: d.street, zip: d.zip, city: d.city, country: d.country }, confirmed: !!d.confirmed, note: d.note })
        : await setDriver(x.tenant.id, caseId, x.actor, { mode: d.mode, note: d.note });
    refresh(caseId, x.c.vehicleId, x.c.bookingId, x.c.driverCustomerId);
    if (c.driverCustomerId) refresh(null, null, null, c.driverCustomerId);
    return { ok: d.mode === "CONTRACT" || d.mode === "OTHER" ? "Fahrerbestimmung gespeichert. Sie wird erst mit einer freigegebenen Antwort nach außen wirksam." : "Fahrerbestimmung gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

// ---------------------------------------------------------------------------
// Antwortfassung: vorbereiten → prüfen → freigeben → übermitteln
// ---------------------------------------------------------------------------

const responseSchema = z.object({
  responseType: z.enum(keys(AUTHORITY_RESPONSE_TYPES)),
  submissionMethod: z.enum(keys(SUBMISSION_METHODS)),
  freeText: text(4000),
  includeBirthDate: flag,
  includeAddress: flag,
});

export async function prepareResponseAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = responseSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const r = await prepareResponse(x.tenant.id, caseId, x.actor, p.data);
    refresh(caseId, x.c.vehicleId, x.c.bookingId);
    return { ok: `Antwortentwurf (Fassung ${r.version}) erstellt. Bitte die Vorschau prüfen und dann ausdrücklich freigeben.` };
  } catch (e) {
    return asState(e);
  }
}

const approveSchema = z.object({ responseId: z.string().min(1), confirm: z.literal("1", { message: "Bitte die Freigabe ausdrücklich bestätigen." }) });
/** „Angaben geprüft und Antwort freigeben“ – danach unveränderlich, PDF wird erzeugt. */
export async function approveResponseAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = approveSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const r = await approveResponse(x.tenant.id, p.data.responseId, x.actor);
    if (r.caseId !== caseId) return { error: "Die Fassung gehört nicht zu diesem Vorgang." };
    refresh(caseId, x.c.vehicleId, x.c.bookingId);
    return { ok: `Fassung ${r.version} freigegeben und als PDF abgelegt. Korrekturen sind ab jetzt nur als neue Fassung möglich.` };
  } catch (e) {
    return asState(e);
  }
}

const submitSchema = z.object({ responseId: z.string().min(1), submittedAt: text(20), reference: text(120), note: text(500), receiptDocumentId: text(40), nonce: text(40), confirm: z.literal("1", { message: "Bitte die Übermittlung ausdrücklich bestätigen." }) });
/** Übermittlung: E-Mail sendet Rent-Base (nur an die erfasste Behördenadresse); Post/Portal/Sonstiges markiert der Mitarbeiter. */
export async function submitResponseAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = submitSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  const r = await db.authorityResponse.findFirst({ where: { id: p.data.responseId, tenantId: x.tenant.id, caseId }, select: { id: true } });
  if (!r) return { error: "Die Fassung gehört nicht zu diesem Vorgang." };
  const submittedAt = p.data.submittedAt ? parseLocalDateTime(p.data.submittedAt) : null;
  if (p.data.submittedAt && !submittedAt) return { error: "Bitte ein gültiges Übermittlungsdatum angeben." };
  try {
    const res = await submitResponse(x.tenant.id, r.id, x.actor, { submittedAt, reference: p.data.reference, note: p.data.note, receiptDocumentId: p.data.receiptDocumentId || null, nonce: p.data.nonce || null });
    refresh(caseId, x.c.vehicleId, x.c.bookingId);
    if (res.outcome === "FAILED") return { error: `Der Versand ist fehlgeschlagen: ${res.error ?? "unbekannter Fehler"}. Der Vorgang bleibt offen; ein erneuter Versuch ist möglich.` };
    if (res.outcome === "ALREADY_SUBMITTED") return { ok: "Diese Fassung war bereits übermittelt – es wurde nichts erneut gesendet." };
    return { ok: `${res.response.submissionMethod === "EMAIL" ? "Per E-Mail gesendet" : "Als übermittelt markiert"} und Nachweis angelegt.${feeText(res.fee)}` };
  } catch (e) {
    return asState(e);
  }
}

// ---------------------------------------------------------------------------
// Abschluss, Wiederöffnen, Storno, Notizen, Dokumente
// ---------------------------------------------------------------------------

const reasonSchema = z.object({ reason: z.string().trim().min(3, "Bitte einen Grund angeben.").max(500) });

export async function closeCaseAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = reasonSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await closeAuthorityCase(x.tenant.id, caseId, x.actor, p.data.reason);
    refresh(caseId, x.c.vehicleId, x.c.bookingId, x.c.driverCustomerId);
    return { ok: "Vorgang abgeschlossen." };
  } catch (e) {
    return asState(e);
  }
}

export async function reopenCaseAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = reasonSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await reopenAuthorityCase(x.tenant.id, caseId, x.actor, p.data.reason);
    refresh(caseId, x.c.vehicleId, x.c.bookingId, x.c.driverCustomerId);
    return { ok: "Vorgang wieder geöffnet." };
  } catch (e) {
    return asState(e);
  }
}

export async function cancelCaseAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = reasonSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await cancelAuthorityCase(x.tenant.id, caseId, x.actor, p.data.reason);
    refresh(caseId, x.c.vehicleId, x.c.bookingId, x.c.driverCustomerId);
    return { ok: "Vorgang storniert. Er bleibt in der Historie sichtbar." };
  } catch (e) {
    return asState(e);
  }
}

const noteSchema = z.object({ note: z.string().trim().min(2, "Bitte eine Notiz eingeben.").max(2000) });
export async function addNoteAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = noteSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await addAuthorityNote(x.tenant.id, caseId, x.actor, p.data.note);
    refresh(caseId);
    return { ok: "Notiz gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

const internalSchema = z.object({ internalNote: text(4000) });
export async function setInternalNoteAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = internalSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  try {
    await setInternalNote(x.tenant.id, caseId, x.actor, p.data.internalNote ?? null);
    refresh(caseId);
    return { ok: "Interne Notiz gespeichert. Sie erscheint nie in einer Antwort." };
  } catch (e) {
    return asState(e);
  }
}

export async function archiveDocumentAction(caseId: string, documentId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = reasonSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const doc = await archiveAuthorityDocument(x.tenant.id, documentId, x.actor, p.data.reason);
    if (doc.caseId !== caseId) return { error: "Das Dokument gehört nicht zu diesem Vorgang." };
    refresh(caseId);
    return { ok: "Dokument archiviert. Datei und Eintrag bleiben nachvollziehbar erhalten." };
  } catch (e) {
    return asState(e);
  }
}

// ---------------------------------------------------------------------------
// Schnellweg „Prüfen & senden“, Bearbeitungsentgelt
// ---------------------------------------------------------------------------

const quickSchema = z.object({ fingerprint: z.string().min(8).max(100), confirmed: flag, includeBirthDate: flag, includeAddress: flag });

function feeText(fee: FeeOutcome | undefined): string {
  return fee && (fee.status === "CREATED" || fee.status === "FAILED") ? ` ${fee.message}` : "";
}

/** Vorschlag bestätigen: Fahrer (falls nötig) → Entwurf → Freigabe → bei E-Mail Versand – jeweils die normalen, geprüften Schritte. */
export async function quickRespondAction(caseId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const p = quickSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  let target: string;
  try {
    const r = await runQuickResponse(x.tenant.id, caseId, x.actor, { fingerprint: p.data.fingerprint, confirmed: !!p.data.confirmed, includeBirthDate: !!p.data.includeBirthDate, includeAddress: !!p.data.includeAddress });
    const c = await db.authorityCase.findFirst({ where: { id: caseId, tenantId: x.tenant.id }, select: { driverCustomerId: true } });
    refresh(caseId, x.c.vehicleId, x.c.bookingId, c?.driverCustomerId ?? x.c.driverCustomerId);
    // Ergebnis als Hinweis oben auf der Seite – die Vorschlagskarte verschwindet nach dem Klick
    const code = r.submit?.outcome === "FAILED" ? "fehler" : r.submit?.outcome === "SUBMITTED" ? "gesendet" : r.method === "POST" ? "post" : "portal";
    target = `/behoerden/${caseId}?schnell=${code}${r.submit?.fee?.status === "CREATED" ? "&entgelt=1" : ""}`;
  } catch (e) {
    return asState(e);
  }
  redirect(target);
}

export async function createFeeInvoiceAction(caseId: string, _prev: AuthState, _fd: FormData): Promise<AuthState> {
  void _fd;
  const x = await ctx(caseId);
  if (!x) return { error: "Behördenvorgang nicht gefunden." };
  const r = await ensureAuthorityFeeInvoice(x.tenant.id, caseId, x.actor);
  refresh(caseId, null, x.c.bookingId);
  if (r.invoiceId && x.c.bookingId) revalidatePath(`/buchungen/${x.c.bookingId}/rechnung`);
  return r.status === "CREATED" || r.status === "EXISTS" ? { ok: r.message } : { error: r.message };
}

// ---------------------------------------------------------------------------
// Adressbuch und Fristen-Erinnerung
// ---------------------------------------------------------------------------

const contactSchema = z.object({ name: z.string().trim().min(2, "Bitte den Namen der Behörde angeben.").max(160), department: text(160), address: text(400), email: text(160), portalUrl: text(300) });

export async function updateContactAction(contactId: string, _prev: AuthState, fd: FormData): Promise<AuthState> {
  const { tenant, user } = await requireRole("DISPO");
  const p = contactSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    await updateContact(tenant.id, contactId, { id: user.id, name: user.name }, p.data);
    revalidatePath("/behoerden/einstellungen");
    return { ok: "Adressbucheintrag gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

export async function deleteContactAction(contactId: string, _prev: AuthState, _fd: FormData): Promise<AuthState> {
  void _fd;
  const { tenant, user } = await requireRole("DISPO");
  try {
    await deleteContact(tenant.id, contactId, { id: user.id, name: user.name });
    revalidatePath("/behoerden/einstellungen");
    return { ok: "Eintrag gelöscht. Bestehende Vorgänge behalten ihre Behördendaten." };
  } catch (e) {
    return asState(e);
  }
}

const reminderSchema = z.object({ days: z.coerce.number().int().min(0).max(30), email: text(160) });

/** Fristen-Erinnerung: Tage vor Ablauf (0 = aus) und optional eine feste Empfängeradresse. Nur Inhaber. */
export async function saveReminderSettingsAction(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const { tenant, user } = await requireRole("OWNER");
  const p = reminderSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Bitte eine Zahl zwischen 0 und 30 angeben." };
  const email = p.data.email?.trim() || null;
  if (email && !isValidEmail(email)) return { error: "Die E-Mail-Adresse ist ungültig." };
  await db.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenant.id }, data: { authorityReminderDays: p.data.days, authorityReminderEmail: email } });
    await recordAudit(tx, tenant.id, { id: user.id, name: user.name }, { action: "AUTHORITY_REMINDER_SETTINGS_UPDATED", details: { days: p.data.days, customRecipient: !!email } });
  });
  revalidatePath("/behoerden/einstellungen");
  return { ok: p.data.days === 0 ? "Fristen-Erinnerung ausgeschaltet." : `Gespeichert: tägliche Erinnerung ab 7 Uhr für Fristen innerhalb von ${p.data.days} ${p.data.days === 1 ? "Tag" : "Tagen"} und überfällige Vorgänge.` };
}

/** Heutige Erinnerung sofort auslösen (sonst ab 7 Uhr automatisch); je Tag und Empfänger höchstens einmal. */
export async function sendReminderNowAction(_prev: AuthState, _fd: FormData): Promise<AuthState> {
  void _fd;
  const { tenant } = await requireRole("OWNER");
  const res = await sendAuthorityReminders({ tenantId: tenant.id });
  if (res.length === 0) return { error: "Die Erinnerung ist ausgeschaltet." };
  if (res.some((r) => r.status === "NOTHING_DUE")) return { ok: "Heute steht keine Frist an – es wurde nichts gesendet." };
  if (res.some((r) => r.status === "NO_RECIPIENT")) return { error: "Es gibt keinen Empfänger mit gültiger E-Mail-Adresse." };
  const sent = res.filter((r) => r.status === "SENT").map((r) => r.recipient);
  const already = res.filter((r) => r.status === "ALREADY").map((r) => r.recipient);
  const failed = res.filter((r) => r.status === "FAILED").map((r) => r.recipient);
  if (failed.length) return { error: `Versand fehlgeschlagen an: ${failed.join(", ")}.` };
  return { ok: [sent.length ? `Gesendet an ${sent.join(", ")}.` : null, already.length ? `Heute bereits gesendet an ${already.join(", ")}.` : null].filter(Boolean).join(" ") };
}
