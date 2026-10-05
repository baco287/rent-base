"use server";

// Befehl 29 Phase D: Aktionen der Unfallersatz-Fallakte. Rollen: OWNER und DISPO verwalten den Fall; YARD sieht nur die operative
// Sicht und hat hier keine Aktion. Jede Aktion prüft zuerst Rolle und Freischaltung (ctx), dann die Zugehörigkeit des Falls zum
// Mandanten. Fachregeln (offene Akte, Fahrzeugkonflikte, Pflichtgründe, Wiedervorlage gehört zum Fall) prüft lib/accident-replacement.
// Das globale Adressbuch ändert sich nur, wenn im Formular ausdrücklich „ins Adressbuch übernehmen“ gewählt ist.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireFeature, requireRole } from "@/lib/auth";
import {
  archiveAccidentDocument, cancelFollowUp, closeCase, completeFollowUp, createFollowUp, previewPlannedEnd, reopenCase, setLiability, updateAccident, updateDamagedVehicle, updateInsurer,
  updateLawyer, updatePlannedEnd, updateWorkshop,
} from "@/lib/accident-replacement";
import { parseAmount } from "@/lib/deposits";
import { cancelInvoiceAdjustment, recordInvoiceAdjustment } from "@/lib/invoice-adjustments";
import { invoiceHref } from "@/lib/invoice-links";
import { createAccidentInvoiceDraft, createAccidentRemainderDraft, previewAccidentInvoice } from "@/lib/invoices";
import { cancelPayment, previewInvoicePayment, recordInvoicePayment, type PaymentPreview } from "@/lib/payments";
import { quotaField } from "@/lib/accident-wizard";
import { db } from "@/lib/db";
import { fmtCents } from "@/lib/money";
import { fmtDateTime } from "@/lib/format";
import { DomainError } from "@/lib/integrity";
import { parseLocalDateTime, toDateInputValue } from "@/lib/time";

export type CaseFileState = { error?: string; ok?: string } | undefined;

async function ctx(caseId: string) {
  const { tenant, user } = await requireRole("DISPO");
  await requireFeature("ACCIDENT_REPLACEMENT");
  const c = await db.accidentReplacementCase.findFirst({ where: { id: caseId, tenantId: tenant.id }, select: { id: true, bookingId: true } });
  if (!c) return null;
  return { tenantId: tenant.id, actor: { id: user.id, name: user.name }, c };
}

const NOT_FOUND: CaseFileState = { error: "Unfallersatzfall nicht gefunden." };

function refresh(c: { id: string; bookingId: string }) {
  revalidatePath(`/unfallersatz/${c.id}`);
  revalidatePath(`/buchungen/${c.bookingId}`);
  revalidatePath("/heute");
}

/** Fachliche Meldung anzeigen; Unbekanntes nur allgemein (im Log nur die Fehlerart, keine Eingaben). */
function asState(e: unknown): CaseFileState {
  if (e instanceof DomainError) return { error: e.message };
  console.error("[unfallersatz] Fallakte: Aktion fehlgeschlagen", { fehler: e instanceof Error ? e.name : "unbekannt" });
  return { error: "Die Änderung konnte nicht gespeichert werden. Bitte erneut versuchen." };
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** Datum aus <input type="date"> als Mitternacht Europe/Berlin; leer = null; ungültig = undefined. */
function dateField(fd: FormData, k: string): Date | null | undefined {
  const v = str(fd, k);
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? parseLocalDateTime(`${v}T00:00`) ?? undefined : undefined;
}

// ---------------------------------------------------------------------------
// Schadenfall: beschädigtes Fahrzeug, Unfall, Versicherung, Haftung, Werkstatt, Rechtsanwalt (immer die Kopie im Fall)
// ---------------------------------------------------------------------------

export async function updateDamagedVehicleAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const firstRegistration = dateField(fd, "damagedFirstRegistration");
  if (firstRegistration === undefined) return { error: "Die Erstzulassung ist kein gültiges Datum." };
  if (firstRegistration && firstRegistration > new Date()) return { error: "Die Erstzulassung liegt in der Zukunft." };
  const drivable = str(fd, "damagedDrivable");
  if (drivable !== "1" && drivable !== "0") return { error: "Bitte angeben, ob das beschädigte Fahrzeug fahrbereit ist." };
  try {
    await updateDamagedVehicle(x.tenantId, x.c.id, x.actor, { plate: str(fd, "damagedPlate"), make: str(fd, "damagedMake"), model: str(fd, "damagedModel"), drivable: drivable === "1", firstRegistration, vehicleClass: str(fd, "damagedVehicleClass") || null, location: str(fd, "damagedLocation") || null, damageKind: str(fd, "damageKind") });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: "Beschädigtes Fahrzeug gespeichert." };
}

export async function updateAccidentAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const accidentAt = dateField(fd, "accidentDate");
  if (!accidentAt) return { error: accidentAt === null ? "Bitte das Unfalldatum angeben." : "Das Unfalldatum ist kein gültiges Datum." };
  try {
    await updateAccident(x.tenantId, x.c.id, x.actor, { accidentAt, place: str(fd, "accidentPlace") || null, opponentPlate: str(fd, "opponentPlate") || null, opponentName: str(fd, "opponentName") || null, policeFileNumber: str(fd, "policeFileNumber") || null, note: str(fd, "accidentNote") || null });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: "Unfalldaten gespeichert." };
}

export async function updateInsurerAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  // ohne Namen würde die Fachlogik alle Versicherungsangaben leeren – das ist hier nie gewollt
  if (!str(fd, "insurerName")) return { error: "Bitte die gegnerische Versicherung angeben." };
  const addressBook = str(fd, "addressBook") === "1";
  try {
    await updateInsurer(x.tenantId, x.c.id, x.actor, {
      insurer: { name: str(fd, "insurerName"), claimNumber: str(fd, "insurerClaimNumber") || null, contactName: str(fd, "insurerContactName") || null, phone: str(fd, "insurerPhone") || null, email: str(fd, "insurerEmail") || null, street: str(fd, "insurerStreet") || null, zip: str(fd, "insurerZip") || null, city: str(fd, "insurerCity") || null },
      addressBook,
    });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: addressBook ? "Versicherung gespeichert und ins Adressbuch übernommen." : "Versicherung gespeichert." };
}

export async function setLiabilityAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const status = str(fd, "liabilityStatus") || "UNKNOWN";
  let quotaPercent: number | null = null;
  if (status === "QUOTA") {
    const q = quotaField(str(fd, "liabilityQuotaPercent"));
    if (q.error) return { error: q.error };
    quotaPercent = q.value;
  }
  try {
    await setLiability(x.tenantId, x.c.id, x.actor, { status, quotaPercent, note: str(fd, "liabilityNote") || null });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: "Haftungsstatus gespeichert." };
}

export async function updateWorkshopAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const remove = str(fd, "remove") === "1";
  const addressBook = !remove && str(fd, "addressBook") === "1";
  const repairStartAt = dateField(fd, "repairStartAt"), repairEndAt = dateField(fd, "repairEndAt");
  if (!remove) {
    if (!str(fd, "workshopName")) return { error: "Werkstatt: bitte den Namen angeben (oder die Angaben entfernen)." };
    if (repairStartAt === undefined) return { error: "Der Reparaturbeginn ist kein gültiges Datum." };
    if (repairEndAt === undefined) return { error: "Das Reparaturende ist kein gültiges Datum." };
  }
  try {
    await updateWorkshop(x.tenantId, x.c.id, x.actor, remove ? null : { name: str(fd, "workshopName"), contactName: str(fd, "workshopContactName") || null, phone: str(fd, "workshopPhone") || null, email: str(fd, "workshopEmail") || null, repairStartAt: repairStartAt ?? null, repairEndAt: repairEndAt ?? null }, { addressBook });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: remove ? "Werkstattangaben entfernt." : addressBook ? "Werkstatt gespeichert und ins Adressbuch übernommen." : "Werkstatt gespeichert." };
}

export async function updateLawyerAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const remove = str(fd, "remove") === "1";
  const addressBook = !remove && str(fd, "addressBook") === "1";
  if (!remove && !str(fd, "lawyerFirm")) return { error: "Rechtsanwalt: bitte Kanzlei bzw. Firma angeben (oder die Angaben entfernen)." };
  try {
    await updateLawyer(x.tenantId, x.c.id, x.actor, remove ? null : { firm: str(fd, "lawyerFirm"), contactName: str(fd, "lawyerContactName") || null, phone: str(fd, "lawyerPhone") || null, email: str(fd, "lawyerEmail") || null }, { addressBook });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: remove ? "Angaben zum Rechtsanwalt entfernt." : addressBook ? "Rechtsanwalt gespeichert und ins Adressbuch übernommen." : "Rechtsanwalt gespeichert." };
}

// ---------------------------------------------------------------------------
// Mietdauer aktualisieren (geplantes Ende setzen, ändern oder öffnen) – ohne neue Buchung und ohne Nachtrag
// ---------------------------------------------------------------------------

export type PlannedEndPreviewResult = { error?: string; conflict?: string | null; before?: string; after?: string; estimateBefore?: string; estimateAfter?: string; unchanged?: boolean };

function plannedEndFrom(endMode: string, raw: string): { value: Date | null } | { error: string } {
  if (endMode === "open") return { value: null };
  if (endMode !== "known") return { error: "Bitte wählen: Datum bekannt oder Mietende offen." };
  const d = parseLocalDateTime(raw);
  return d ? { value: d } : { error: "Bitte das geplante Mietende mit Datum und Uhrzeit angeben oder „Mietende offen“ wählen." };
}

export async function previewPlannedEndAction(caseId: string, input: { endMode: string; plannedEndAt: string }): Promise<PlannedEndPreviewResult> {
  const x = await ctx(caseId);
  if (!x) return { error: "Unfallersatzfall nicht gefunden." };
  const end = plannedEndFrom(String(input?.endMode ?? ""), String(input?.plannedEndAt ?? ""));
  if ("error" in end) return { error: end.error };
  try {
    const p = await previewPlannedEnd(x.tenantId, x.c.id, end.value);
    const text = (d: Date | null) => (d ? fmtDateTime(d) : "offen (bis zur Rückgabe)");
    return { conflict: p.conflict, before: text(p.before), after: text(p.after), estimateBefore: fmtCents(p.estimateBeforeCents), estimateAfter: fmtCents(p.estimateAfterCents), unchanged: (p.before?.getTime() ?? null) === (p.after?.getTime() ?? null) };
  } catch (e) { return { error: asState(e)?.error }; }
}

export async function updatePlannedEndAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const end = plannedEndFrom(str(fd, "endMode"), str(fd, "plannedEndAt"));
  if ("error" in end) return { error: end.error };
  try {
    const r = await updatePlannedEnd(x.tenantId, x.c.id, x.actor, { plannedEndAt: end.value, reason: str(fd, "reason") });
    refresh(x.c);
    return { ok: r.after ? `Geplantes Mietende auf ${fmtDateTime(r.after)} gesetzt.` : "Mietende ist jetzt offen (bis zur Rückgabe)." };
  } catch (e) { return asState(e); }
}

// ---------------------------------------------------------------------------
// Wiedervorlagen
// ---------------------------------------------------------------------------

export async function createFollowUpAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const day = str(fd, "dueDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Bitte das Fälligkeitsdatum angeben." };
  if (day < toDateInputValue(new Date())) return { error: "Das Fälligkeitsdatum liegt in der Vergangenheit." };
  // Fälligkeit ist ein Tag; gespeichert als 09:00 Uhr (Europe/Berlin)
  const dueAt = parseLocalDateTime(`${day}T09:00`);
  if (!dueAt) return { error: "Das Fälligkeitsdatum ist ungültig." };
  try {
    await createFollowUp(x.tenantId, x.c.id, x.actor, { title: str(fd, "title"), dueAt, assigneeUserId: str(fd, "assigneeUserId") || null, note: str(fd, "note") || null });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: "Wiedervorlage angelegt." };
}

export async function completeFollowUpAction(caseId: string, followUpId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  try {
    await completeFollowUp(x.tenantId, followUpId, x.actor, str(fd, "note") || null, { caseId: x.c.id });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: "Wiedervorlage erledigt." };
}

export async function cancelFollowUpAction(caseId: string, followUpId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  try {
    await cancelFollowUp(x.tenantId, followUpId, x.actor, str(fd, "reason"), { caseId: x.c.id });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: "Wiedervorlage verworfen." };
}

// ---------------------------------------------------------------------------
// Fall abschließen / wieder öffnen (Phase B: mit Grund; offene Punkte nur nach bewusster Bestätigung)
// ---------------------------------------------------------------------------

export async function closeCaseAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  try {
    await closeCase(x.tenantId, x.c.id, x.actor, { reason: str(fd, "reason"), acknowledgeWarnings: str(fd, "acknowledge") === "1" });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: "Der Fall ist abgeschlossen." };
}

export async function reopenCaseAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  try {
    await reopenCase(x.tenantId, x.c.id, x.actor, str(fd, "reason"));
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: "Der Fall ist wieder geöffnet." };
}

// ---------------------------------------------------------------------------
// Phase F: Abrechnung, Zahlungen, Kürzungen, Restforderung, Dokumente – immer nur Rechnungen/Belege genau dieses Falls
// (Mandant + Buchung des Falls + Rechnungsart Unfallersatz). Die Fachregeln (Fallsperre, Abrechnungskette, Obergrenzen,
// Empfängerrolle) prüfen lib/invoices, lib/payments, lib/invoice-adjustments und lib/accident-replacement.
// ---------------------------------------------------------------------------

/** Rechnung dieses Falls (sonst null – fremde oder erratene IDs führen zu „nicht gefunden“). */
async function caseInvoice(x: NonNullable<Awaited<ReturnType<typeof ctx>>>, invoiceId: string) {
  return db.invoice.findFirst({ where: { id: invoiceId, tenantId: x.tenantId, bookingId: x.c.bookingId, kind: "ACCIDENT_REPLACEMENT", documentType: "INVOICE" }, select: { id: true, number: true, status: true } });
}

function refreshBilling(c: { id: string; bookingId: string }) {
  refresh(c);
  for (const p of [`/buchungen/${c.bookingId}/rechnung`, "/rechnungen", "/forderungen", "/unfallersatz"]) revalidatePath(p);
}

export type AccidentPreviewResult = { error?: string; typeLabel?: string; period?: string; days?: number; totalDays?: number; priorDays?: number; items?: { description: string; quantity: string; unit: string; unitPrice: string; gross: string }[]; net?: string; tax?: string; gross?: string; pricesIncludeTax?: boolean };

/** Vorschau einer Zwischenrechnung bis zum Stichtag (rechnet nur, legt nichts an) – dieselbe Rechnung wie das Erstellen. */
export async function previewAccidentInvoiceAction(caseId: string, input: { periodEnd: string }): Promise<AccidentPreviewResult> {
  const x = await ctx(caseId);
  if (!x) return { error: "Unfallersatzfall nicht gefunden." };
  const raw = String(input?.periodEnd ?? "");
  const periodEnd = raw ? parseLocalDateTime(raw) : null;
  if (raw && !periodEnd) return { error: "Bitte einen gültigen Stichtag angeben." };
  try {
    const p = await previewAccidentInvoice(x.tenantId, { caseId: x.c.id, periodEnd });
    return { typeLabel: p.typeLabel, period: `${fmtDateTime(p.periodStart)} bis ${fmtDateTime(p.end)}`, days: p.days, totalDays: p.totalDays, priorDays: p.priorDays, items: p.items.map((i) => ({ description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: fmtCents(i.unitPriceCents), gross: fmtCents(i.grossCents) })), net: fmtCents(p.netCents), tax: fmtCents(p.taxCents), gross: fmtCents(p.grossCents), pricesIncludeTax: p.pricesIncludeTax };
  } catch (e) { return { error: asState(e)?.error }; }
}

/** Zwischen- oder Schlussrechnung als Entwurf; danach weiter in den Rechnungsentwurf (Prüfen, Abschließen). */
export async function createAccidentInvoiceAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const role = str(fd, "recipientRole");
  if (role !== "INSURER" && role !== "RENTER" && role !== "OTHER") return { error: "Bitte den Rechnungsempfänger wählen." };
  const rawEnd = str(fd, "periodEnd");
  const periodEnd = rawEnd ? parseLocalDateTime(rawEnd) : null;
  if (rawEnd && !periodEnd) return { error: "Bitte einen gültigen Stichtag angeben." };
  let invoiceId: string;
  try {
    const res = await createAccidentInvoiceDraft(x.tenantId, x.actor, {
      caseId: x.c.id, recipientRole: role, periodEnd, nonce: str(fd, "nonce"),
      other: role === "OTHER" ? { type: str(fd, "otherType"), companyName: str(fd, "otherCompanyName"), firstName: str(fd, "otherFirstName"), lastName: str(fd, "otherLastName"), street: str(fd, "otherStreet"), zip: str(fd, "otherZip"), city: str(fd, "otherCity"), country: str(fd, "otherCountry"), email: str(fd, "otherEmail") } : null,
    });
    invoiceId = res.invoice.id;
  } catch (e) { return asState(e); }
  refreshBilling(x.c);
  redirect(invoiceHref({ id: invoiceId, bookingId: x.c.bookingId, kind: "ACCIDENT_REPLACEMENT" }));
}

/** Restforderung an den Mieter zu einer gekürzten Versicherungsrechnung – bewusst, mit Bestätigung, nie automatisch. */
export async function createAccidentRemainderAction(caseId: string, invoiceId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const inv = await caseInvoice(x, invoiceId);
  if (!inv) return { error: "Rechnung nicht gefunden." };
  if (str(fd, "acknowledge") !== "1") return { error: "Bitte bestätigen, dass der Betrag zugleich in der Versicherungsrechnung enthalten bleibt." };
  let amountCents: number;
  try { amountCents = parseAmount(str(fd, "amount"), "Der Betrag der Restforderung"); } catch (e) { return asState(e); }
  let newId: string;
  try {
    newId = (await createAccidentRemainderDraft(x.tenantId, x.actor, { caseId: x.c.id, invoiceId: inv.id, amountCents, nonce: str(fd, "nonce") })).invoice.id;
  } catch (e) { return asState(e); }
  refreshBilling(x.c);
  redirect(invoiceHref({ id: newId, bookingId: x.c.bookingId, kind: "ACCIDENT_REPLACEMENT" }));
}

/** Kürzung der Versicherung dokumentieren (mindert weder Rechnung noch Forderung). */
export async function recordAccidentAdjustmentAction(caseId: string, invoiceId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const inv = await caseInvoice(x, invoiceId);
  if (!inv) return { error: "Rechnung nicht gefunden." };
  const day = str(fd, "decidedAt");
  const decidedAt = /^\d{4}-\d{2}-\d{2}$/.test(day) ? parseLocalDateTime(`${day}T12:00`) : null;
  if (!decidedAt) return { error: "Bitte das Datum der Kürzung angeben." };
  try {
    const amountCents = parseAmount(str(fd, "amount"), "Der Kürzungsbetrag");
    await recordInvoiceAdjustment(x.tenantId, x.actor, { invoiceId: inv.id, reasonKind: str(fd, "reasonKind"), amountCents, decidedAt, note: str(fd, "note") || null, documentId: str(fd, "documentId") || null });
  } catch (e) { return asState(e); }
  refreshBilling(x.c);
  return { ok: "Kürzung dokumentiert. Rechnungsbetrag und offene Forderung bleiben unverändert." };
}

/** Kürzung stornieren (mit Grund); die Zeile bleibt nachvollziehbar erhalten. */
export async function cancelAccidentAdjustmentAction(caseId: string, adjustmentId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const a = await db.invoiceAdjustment.findFirst({ where: { id: adjustmentId, tenantId: x.tenantId, invoice: { bookingId: x.c.bookingId, kind: "ACCIDENT_REPLACEMENT" } }, select: { id: true } });
  if (!a) return { error: "Kürzung nicht gefunden." };
  try {
    await cancelInvoiceAdjustment(x.tenantId, x.actor, a.id, str(fd, "reason"));
  } catch (e) { return asState(e); }
  refreshBilling(x.c);
  return { ok: "Kürzung storniert. Sie bleibt im Verlauf sichtbar." };
}

/** Zahlungsvorschau zu einer Rechnung dieses Falls (rechnet nur). */
export async function previewAccidentPaymentAction(caseId: string, invoiceId: string, amount: string, method: string): Promise<PaymentPreview | { error: string }> {
  const x = await ctx(caseId);
  if (!x) return { error: "Unfallersatzfall nicht gefunden." };
  const inv = await caseInvoice(x, invoiceId);
  if (!inv) return { error: "Rechnung nicht gefunden." };
  try {
    return await previewInvoicePayment(x.tenantId, inv.id, amount, method);
  } catch (e) { return { error: asState(e)?.error ?? "Vorschau nicht möglich." }; }
}

/** Zahlung (auch Teilzahlung) zu einer abgeschlossenen Rechnung dieses Falls – bestehende Zahlungslogik, keine Überzahlung. */
export async function recordAccidentPaymentAction(caseId: string, invoiceId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const inv = await caseInvoice(x, invoiceId);
  if (!inv) return { error: "Rechnung nicht gefunden." };
  const paidAt = parseLocalDateTime(str(fd, "paidAt"));
  if (!paidAt) return { error: "Bitte ein gültiges Zahlungsdatum angeben." };
  try {
    const res = await recordInvoicePayment(x.tenantId, x.actor, { invoiceId: inv.id, amount: str(fd, "amount"), method: str(fd, "method"), paidAt, reference: str(fd, "reference") || null, note: str(fd, "note") || null, idempotencyKey: str(fd, "nonce") });
    refreshBilling(x.c);
    return { ok: res.created ? `Zahlung über ${fmtCents(res.payment.amountCents)} erfasst.` : "Diese Zahlung war bereits erfasst. Es wurde nichts doppelt gebucht." };
  } catch (e) { return asState(e); }
}

/** Zahlung stornieren (mit Grund) – nur Zahlungen zu Rechnungen dieses Falls. */
export async function cancelAccidentPaymentAction(caseId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  const p = await db.payment.findFirst({ where: { id: str(fd, "id"), tenantId: x.tenantId, invoice: { bookingId: x.c.bookingId, kind: "ACCIDENT_REPLACEMENT" } }, select: { id: true } });
  if (!p) return { error: "Zahlung nicht gefunden." };
  try {
    const row = await cancelPayment(x.tenantId, x.actor, p.id, str(fd, "reason"));
    refreshBilling(x.c);
    return { ok: `Zahlung über ${fmtCents(row.amountCents)} storniert. Der offene Betrag wurde neu berechnet.` };
  } catch (e) { return asState(e); }
}

/** Dokument archivieren (mit Grund) – nur Dokumente dieses Falls; nichts wird gelöscht. */
export async function archiveAccidentDocumentAction(caseId: string, documentId: string, _prev: CaseFileState, fd: FormData): Promise<CaseFileState> {
  const x = await ctx(caseId);
  if (!x) return NOT_FOUND;
  try {
    await archiveAccidentDocument(x.tenantId, documentId, x.actor, str(fd, "reason"), { caseId: x.c.id });
  } catch (e) { return asState(e); }
  refresh(x.c);
  return { ok: "Dokument archiviert. Es bleibt in der Fallakte sichtbar und abrufbar." };
}
