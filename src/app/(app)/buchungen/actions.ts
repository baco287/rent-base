"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { agreedEndOf, occupiedUntil, assertVehicleBookable, nextBookingNumber, vehicleStatusProblem, type OccupancyLike } from "@/lib/bookings";
import { customerName, fmtDateTime } from "@/lib/format";
import { customerFieldsFromForm, customerSchema, customerToData } from "@/lib/customer-schema";
import { nextCustomerNumber, withNumberRetry } from "@/lib/numbering";
import { changeBookingStatus } from "@/lib/booking-status";
import { changeBookingPeriod, previewBookingPeriodChange } from "@/lib/booking-period";
import { cancelBooking, previewCancellation, type CancellationInput } from "@/lib/cancellation";
import { sendCancellationConfirmation } from "@/lib/cancellation-mail";
import { ensureCancellationDocument } from "@/lib/documents";
import { runCancellationFollowUp } from "@/lib/followup";
import { fmtCents } from "@/lib/money";
import { DomainError } from "@/lib/integrity";
import { getStorage } from "@/lib/storage";
import { parseLocalDateTime } from "@/lib/time";
import { PAYMENT_METHODS, RENTAL_PAYMENT_INTENTS, type RentalPaymentIntent } from "@/lib/constants";
import { insertRentalPayment, parseRentalAmount, type RentalPaymentInput } from "@/lib/rental-payments";
import { checkReceiveInput, insertDepositReceived, type ReceiveInput } from "@/lib/deposits";

export type FormState = { error?: string } | undefined;

/**
 * Befehl 20.9: Bereich „Kaution“ der neuen Buchung. Die Buchung existiert beim Absenden noch nicht, deshalb wird hier nur die
 * Absicht geprüft; dokumentiert wird der Eingang erst in derselben Transaktion nach dem Anlegen der Buchung
 * (insertDepositReceived). Kaution ist nie Mietzahlung und verringert den offenen Mietpreis nicht.
 */
function initialDepositFromForm(formData: FormData): { input: Omit<ReceiveInput, "bookingId"> | null } | { error: string } {
  if (String(formData.get("depIntent") ?? "NONE") !== "RECEIVED") return { input: null };
  const amount = String(formData.get("depAmount") ?? "").trim();
  if (!amount) return { error: "Kaution: Bitte den erhaltenen Betrag eingeben." };
  const occurredAt = parseLocalDateTime(String(formData.get("depOccurredAt") ?? ""));
  if (!occurredAt) return { error: "Kaution: Bitte einen gültigen Zeitpunkt angeben." };
  const nonce = String(formData.get("depNonce") ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return { error: "Die Seite ist veraltet. Bitte neu laden." };
  const text = (k: string, max: number) => String(formData.get(k) ?? "").trim().slice(0, max) || null;
  const input = { amount, method: String(formData.get("depMethod") ?? ""), occurredAt, reference: text("depReference", 120), note: text("depNote", 500), idempotencyKey: nonce };
  try {
    checkReceiveInput(input);
  } catch (e) {
    return { error: `Kaution: ${e instanceof DomainError ? e.message : "Ungültige Eingabe."}` };
  }
  return { input };
}

/**
 * Bereich „Zahlung“ der neuen Buchung. „Offen“ = keine Zahlung; sonst genau eine Zahlungsbewegung.
 * Der Status der Buchung wird danach aus den Zahlungen berechnet, nicht aus dieser Auswahl gespeichert.
 */
function initialPaymentFromForm(formData: FormData): { intent: RentalPaymentIntent; input: RentalPaymentInput | null } | { error: string } {
  const raw = String(formData.get("payIntent") ?? "NONE");
  if (!(raw in RENTAL_PAYMENT_INTENTS)) return { error: "Bitte einen Zahlungsstatus wählen." };
  const intent = raw as RentalPaymentIntent;
  if (intent === "NONE") return { intent, input: null };
  const amount = String(formData.get("payAmount") ?? "").trim();
  if (!amount) return { error: "Zahlung: Bitte den tatsächlich gezahlten Betrag eingeben." };
  try {
    parseRentalAmount(amount);
  } catch (e) {
    return { error: `Zahlung: ${e instanceof DomainError ? e.message : "Ungültiger Betrag."}` };
  }
  const method = String(formData.get("payMethod") ?? "");
  if (!(method in PAYMENT_METHODS)) return { error: "Zahlung: Bitte eine Zahlungsart wählen." };
  const paidAt = parseLocalDateTime(String(formData.get("payPaidAt") ?? ""));
  if (!paidAt) return { error: "Zahlung: Bitte ein gültiges Zahlungsdatum angeben." };
  const nonce = String(formData.get("payNonce") ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return { error: "Die Seite ist veraltet. Bitte neu laden." };
  const text = (k: string, max: number) => String(formData.get(k) ?? "").trim().slice(0, max) || null;
  return { intent, input: { amount, method, paidAt, reference: text("payReference", 120), note: text("payNote", 500), idempotencyKey: nonce } };
}

const num = z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number().min(0));
const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const bookingSchema = z
  .object({
    vehicleId: z.string().min(1, "Bitte ein Fahrzeug wählen."),
    customerId: z.string().optional(),
    startAt: z.preprocess(parseLocalDateTime, z.date({ message: "Bitte Abholung mit Datum und Uhrzeit angeben." })),
    endAt: z.preprocess(parseLocalDateTime, z.date({ message: "Bitte Rückgabe mit Datum und Uhrzeit angeben." })),
    dailyRate: num,
    deposit: num,
    // Befehl 20.7: Kilometervereinbarung der Buchung (Vorschlag aus dem Fahrzeug, hier änderbar)
    kmIncludedPerDay: z.preprocess((v) => (typeof v === "string" ? v.replace(/\./g, "").trim() : v), z.coerce.number({ message: "Freikilometer: bitte eine Zahl ab 0 eingeben." }).int("Freikilometer: bitte eine ganze Zahl eingeben.").min(0, "Freikilometer: bitte einen Wert ab 0 eingeben.")),
    extraKmRate: z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: "Mehrkilometerpreis: bitte eine Zahl ab 0 eingeben." }).min(0, "Mehrkilometerpreis: bitte einen Wert ab 0 eingeben.")),
    notes: optStr,
  })
  .refine((d) => d.endAt > d.startAt, { message: "Die Rückgabe muss nach der Abholung liegen.", path: ["endAt"] });

/** Belegt bis: Zeitpunkt oder – bei offenem Mietende (Unfallersatz) – „bis zur Rückgabe“. */
function occupiedUntilText(c: OccupancyLike) {
  const until = occupiedUntil(c);
  return until ? fmtDateTime(until) : "zur Rückgabe (offenes Mietende)";
}

function revalidate(id?: string) {
  revalidatePath("/buchungen");
  revalidatePath("/dispo");
  revalidatePath("/heute");
  if (id) revalidatePath(`/buchungen/${id}`);
}

async function validateRefs(tenantId: string, vehicleId: string, customerId: string | undefined) {
  const [vehicle, customer] = await Promise.all([
    db.vehicle.findFirst({ where: { id: vehicleId, tenantId } }),
    customerId ? db.customer.findFirst({ where: { id: customerId, tenantId } }) : Promise.resolve(null),
  ]);
  if (!vehicle) return { error: "Fahrzeug nicht gefunden." };
  const statusProblem = vehicleStatusProblem(vehicle.status);
  if (statusProblem) return { error: statusProblem };
  if (!customerId) return { vehicle, customer: null }; // neuer Kunde wird mit der Buchung angelegt
  if (!customer) return { error: "Kunde nicht gefunden." };
  if (customer.blocked) return { error: `${customerName(customer)} ist gesperrt${customer.blockReason ? `: ${customer.blockReason}` : "."}` };
  return { vehicle, customer };
}

export async function createBookingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = bookingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  const pay = initialPaymentFromForm(formData);
  if ("error" in pay) return pay;
  const dep = initialDepositFromForm(formData);
  if ("error" in dep) return dep;
  if (dep.input && Math.round(d.deposit * 100) <= 0) return { error: "Kaution: Ohne vereinbarte Kaution (Betrag 0) kann kein Eingang dokumentiert werden." };

  // Kunde direkt in der Buchung anlegen: Kundendaten kommen mit Präfix "c_"
  const newCustomer = formData.get("customerMode") === "new";
  let customerData: ReturnType<typeof customerToData> | null = null;
  if (newCustomer) {
    const c = customerSchema.safeParse(customerFieldsFromForm(formData, "c_"));
    if (!c.success) return { error: `Neuer Kunde: ${c.error.issues[0].message}` };
    customerData = customerToData(c.data);
  } else if (!d.customerId) {
    return { error: "Bitte einen Kunden wählen oder einen neuen Kunden anlegen." };
  }

  const refs = await validateRefs(tenant.id, d.vehicleId, newCustomer ? undefined : d.customerId);
  if ("error" in refs) return refs;

  let id = "";
  const result = await withNumberRetry(() => db.$transaction(async (tx) => {
    const { conflicts } = await assertVehicleBookable(tx, tenant.id, d.vehicleId, d.startAt, d.endAt);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      return { error: `Doppelbelegung: ${refs.vehicle.plate} ist von ${fmtDateTime(c.startAt)} bis ${occupiedUntilText({ ...c, agreedEndAt: agreedEndOf(c) })} an ${customerName(c.customer)} vergeben (Nr. ${c.number})${agreedEndOf(c) ? " – Verlängerung vereinbart, Unterschrift ausstehend" : ""}.` };
    }
    // Erst nach bestandener Konfliktprüfung den Kunden anlegen, damit bei Ablehnung kein Kunde übrig bleibt.
    const customerId = customerData ? (await tx.customer.create({ data: { tenantId: tenant.id, number: await nextCustomerNumber(tx, tenant.id), ...customerData } })).id : d.customerId!;
    const number = await nextBookingNumber(tx, tenant.id, d.startAt);
    const b = await tx.booking.create({
      data: {
        tenantId: tenant.id, number, vehicleId: d.vehicleId, customerId, startAt: d.startAt, endAt: d.endAt, dailyRate: d.dailyRate, deposit: d.deposit, notes: d.notes ?? null,
        kmIncludedPerDay: d.kmIncludedPerDay, extraKmRate: d.extraKmRate,
        // Preisstufen des Fahrzeugs zum Buchungszeitpunkt festhalten
        workWeekRate: refs.vehicle.workWeekRate, weeklyRate: refs.vehicle.weeklyRate, monthlyRate: refs.vehicle.monthlyRate,
      },
    });
    id = b.id;
    // Erste Mietzahlung in derselben Transaktion: wird sie abgelehnt (z. B. Überzahlung), entsteht auch keine Buchung
    if (pay.input) await insertRentalPayment(tx, tenant.id, { id: user.id, name: user.name }, b.id, pay.input, { expectFull: pay.intent === "FULL" });
    // Befehl 20.9: Kautionseingang in derselben Transaktion über die bestehende Kautionserfassung – vereinbart ist die Kaution der
    // Buchung; wird der Eingang abgelehnt (z. B. mehr als vereinbart), entsteht auch keine Buchung. Getrennt von der Mietzahlung.
    if (dep.input) await insertDepositReceived(tx, tenant.id, { id: user.id, name: user.name }, { ...dep.input, bookingId: b.id }, { fromBooking: true });
    return undefined;
  })).catch((e) => (e instanceof DomainError ? { error: e.message } : Promise.reject(e)));
  if (result?.error) return result;

  revalidate(id);
  if (newCustomer) revalidatePath("/kunden");
  redirect(`/buchungen/${id}`);
}

export async function updateBookingAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("DISPO");
  const parsed = bookingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;

  const existing = await db.booking.findFirst({ where: { id, tenantId: tenant.id } });
  if (!existing) return { error: "Buchung nicht gefunden." };
  if (existing.status === "RETURNED" || existing.status === "CANCELLED") return { error: "Abgeschlossene oder stornierte Buchungen können nicht mehr geändert werden." };
  if (!d.customerId) return { error: "Bitte einen Kunden wählen." };
  const contract = await db.rentalContract.findFirst({ where: { bookingId: id, tenantId: tenant.id }, select: { number: true, status: true } });
  if (contract && contract.status === "SIGNED") return { error: `Zu dieser Buchung gibt es den unterschriebenen Vertrag ${contract.number}. Zeitraum, Fahrzeug und Preis sind damit festgeschrieben.` };
  // Befehl 29: Unfallersatz-Buchungen (ggf. offenes Mietende) werden in der Fallakte bearbeitet, nicht über das Buchungsformular
  if (existing.rentalType === "ACCIDENT_REPLACEMENT") return { error: "Diese Buchung gehört zu einem Unfallersatzfall und wird in der Fallakte bearbeitet." };
  const existingEnd = existing.endAt;
  if (!existingEnd) return { error: "Diese Buchung hat kein Mietende." };
  // Befehl 28: der Zeitraum ändert sich nur über „Zeitraum ändern“ (Pflichtgrund, Preisvorschlag, Audit BOOKING_PERIOD_CHANGED)
  const minute = (x: Date) => Math.floor(x.getTime() / 60_000);
  if (minute(d.startAt) !== minute(existing.startAt) || minute(d.endAt) !== minute(existingEnd)) return { error: "Der Zeitraum wird über „Zeitraum ändern“ geändert (mit Grund und Verfügbarkeitsprüfung). Bitte dort anpassen." };

  const refs = await validateRefs(tenant.id, d.vehicleId, d.customerId);
  if ("error" in refs) return refs;

  const result = await db.$transaction(async (tx) => {
    const { conflicts } = await assertVehicleBookable(tx, tenant.id, d.vehicleId, existing.startAt, existingEnd, id);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      return { error: `Doppelbelegung: ${refs.vehicle.plate} ist von ${fmtDateTime(c.startAt)} bis ${occupiedUntilText({ ...c, agreedEndAt: agreedEndOf(c) })} an ${customerName(c.customer)} vergeben (Nr. ${c.number})${agreedEndOf(c) ? " – Verlängerung vereinbart, Unterschrift ausstehend" : ""}.` };
    }
    await tx.booking.update({
      where: { id },
      data: {
        vehicleId: d.vehicleId, customerId: d.customerId!, dailyRate: d.dailyRate, deposit: d.deposit, notes: d.notes ?? null,
        // Kilometervereinbarung: immer der eingegebene Wert (auch bei Fahrzeugwechsel – das Formular schlägt die Fahrzeugwerte nur vor)
        kmIncludedPerDay: d.kmIncludedPerDay, extraKmRate: d.extraKmRate,
        // Nur bei Fahrzeugwechsel die Stufen des neuen Fahrzeugs übernehmen, sonst bleibt der Snapshot der Buchung
        ...(existing.vehicleId !== d.vehicleId ? { workWeekRate: refs.vehicle.workWeekRate, weeklyRate: refs.vehicle.weeklyRate, monthlyRate: refs.vehicle.monthlyRate } : {}),
      },
    });
    return undefined;
  }).catch((e) => (e instanceof DomainError ? { error: e.message } : Promise.reject(e)));
  if (result?.error) return result;

  revalidate(id);
  redirect(`/buchungen/${id}?gespeichert=1`);
}

/**
 * Statuswechsel per Knopf. Die Regeln stehen in lib/booking-status.ts:
 * "Unterwegs" ist hier nicht mehr möglich, das entsteht nur durch Mietvertrag und Übergabeprotokoll.
 */
export async function setBookingStatusAction(id: string, status: "ACTIVE" | "RETURNED") {
  // Altfall-Rücknahme ist eine Dispositionsentscheidung; Storno nur über cancelBookingAction (Befehl 27: mit Grund)
  const { tenant } = await requireRole("DISPO");
  try {
    const { orphanedStorageKeys } = await changeBookingStatus(tenant.id, id, status);
    // Fotos verworfener Entwürfe aufräumen; ein Fehler hier darf den Statuswechsel nicht rückgängig machen
    await Promise.all(orphanedStorageKeys.map((k) => Promise.resolve().then(() => getStorage().remove(k)).catch(() => {})));
  } catch (e) {
    if (e instanceof DomainError) redirect(`/buchungen/${id}?hinweis=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidate(id);
  redirect(`/buchungen/${id}`);
}

export type CancelState = { error?: string; ok?: string } | undefined;
export type CancellationPreviewResult = { errors: string[]; lines: { label: string; value: string; bold?: boolean }[] };

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const checked = (fd: FormData, k: string) => fd.get(k) === "1" || fd.get(k) === "on";

/** Befehl 28: Formular des Storno-Assistenten → Eingabe für lib/cancellation (keine Fachlogik hier). */
function cancellationInputOf(fd: FormData): CancellationInput {
  const payout = (prefix: string) => ({
    amount: str(fd, `${prefix}Amount`) || null,
    method: str(fd, `${prefix}Method`),
    methodDescription: str(fd, `${prefix}MethodDescription`) || null,
    executedAt: parseLocalDateTime(str(fd, `${prefix}When`)) ?? new Date(),
    iban: str(fd, `${prefix}Iban`) || null,
    reference: str(fd, `${prefix}Reference`) || null,
    customerNote: str(fd, `${prefix}Note`) || null,
    receiptConfirmed: str(fd, `${prefix}Method`) === "CASH" && checked(fd, `${prefix}Confirmed`),
    confirmed: checked(fd, `${prefix}Confirmed`),
  });
  const refundMode = str(fd, "refundMode");
  const depositMode = str(fd, "depositMode");
  return {
    reason: str(fd, "reason"),
    idempotencyKey: str(fd, "key") || null,
    fee: checked(fd, "feeEnabled") ? { amount: str(fd, "feeAmount"), description: str(fd, "feeDescription"), taxTreatment: str(fd, "feeTaxTreatment") } : null,
    refund: refundMode === "PAYOUT" ? { mode: "PAYOUT", payout: payout("refund") } : refundMode === "CREDIT" ? { mode: "CREDIT" } : null,
    deposit: depositMode === "RELEASE" ? { mode: "RELEASE", method: checked(fd, "depositPayout") ? str(fd, "depositPayoutMethod") || null : null, payout: checked(fd, "depositPayout") ? payout("depositPayout") : null } : depositMode === "KEEP" ? { mode: "KEEP" } : null,
  };
}

/** Befehl 28: Vorschau der Storno-Abrechnung – rechnet serverseitig, bucht nichts. */
export async function previewCancellationAction(id: string, formData: FormData): Promise<CancellationPreviewResult> {
  const { tenant } = await requireRole("DISPO");
  try {
    const { plan } = await previewCancellation(tenant.id, id, cancellationInputOf(formData));
    const e = fmtCents;
    const lines: CancellationPreviewResult["lines"] = [];
    lines.push({ label: "Geleistete Mietvorauszahlung", value: e(plan.prepaidCents) });
    if (plan.fee) lines.push({ label: plan.fee.taxRateBp > 0 ? "Stornogebühr (netto + USt = brutto)" : "Stornogebühr (ohne Umsatzsteuer)", value: plan.fee.taxRateBp > 0 ? `${e(plan.fee.netCents)} + ${e(plan.fee.taxCents)} = ${e(plan.fee.grossCents)}` : e(plan.fee.grossCents), bold: true });
    if (plan.stillOwedCents > 0) lines.push({ label: "Noch zu zahlen (offene Stornogebühr-Rechnung)", value: e(plan.stillOwedCents), bold: true });
    if (plan.refund.mode === "PAYOUT") lines.push({ label: "Erstattung als Auszahlung", value: e(plan.refund.amountCents), bold: true });
    if (plan.refund.remainingCreditCents > 0 && plan.refund.mode !== "NONE") lines.push({ label: "Verbleibt als Kundenguthaben", value: e(plan.refund.remainingCreditCents), bold: true });
    if (plan.deposit.mode === "RELEASE") lines.push({ label: "Kaution freigegeben", value: e(plan.deposit.releaseCents) });
    if (plan.deposit.payoutCents > 0) lines.push({ label: "davon als zurückgezahlt dokumentiert", value: e(plan.deposit.payoutCents) });
    if (plan.deposit.mode === "KEEP") lines.push({ label: "Kaution vorerst behalten", value: e(plan.deposit.keptCents) });
    if (!plan.fee && plan.prepaidCents === 0 && plan.deposit.mode === "NONE") lines.push({ label: "Finanzielle Folgen", value: "keine" });
    return { errors: plan.errors, lines };
  } catch (err) {
    if (err instanceof DomainError) return { errors: [err.message], lines: [] };
    throw err;
  }
}

/** Befehl 28: Storno-Abschluss (eine Transaktion), danach Dokumente archivieren (wirft nie), Entwurfsfotos aufräumen. */
export async function cancelBookingAction(id: string, _prev: CancelState, formData: FormData): Promise<CancelState> {
  const { tenant, user } = await requireRole("DISPO");
  const actor = { id: user.id, name: user.name };
  let result;
  try {
    result = await cancelBooking(tenant.id, actor, id, cancellationInputOf(formData));
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  await runCancellationFollowUp(tenant.id, result, user.id);
  await Promise.all(result.orphanedStorageKeys.map((k) => Promise.resolve().then(() => getStorage().remove(k)).catch(() => {})));
  revalidate(id);
  revalidatePath("/auszahlungen");
  revalidatePath("/dispo");
  redirect(`/buchungen/${id}?storniert=1#storno`);
}

/** Befehl 28: Stornobestätigung (erneut) archivieren, falls die Nachbearbeitung ausgefallen ist. */
export async function ensureCancellationDocumentAction(id: string) {
  const { tenant, user } = await requireRole("DISPO");
  try {
    await ensureCancellationDocument(tenant.id, id, user.id);
  } catch (e) {
    if (e instanceof DomainError) redirect(`/buchungen/${id}?hinweis=${encodeURIComponent(e.message)}#storno`);
    throw e;
  }
  revalidate(id);
  redirect(`/buchungen/${id}#storno`);
}

/** Befehl 28: Stornobestätigung per E-Mail – nur nach bewusstem Klick, derselbe nonce sendet nie zweimal. */
export async function sendCancellationAction(id: string, _prev: CancelState, formData: FormData): Promise<CancelState> {
  const { tenant, user } = await requireRole("DISPO");
  try {
    const r = await sendCancellationConfirmation(tenant.id, { id: user.id, name: user.name }, id, { nonce: String(formData.get("nonce") ?? "") });
    revalidate(id);
    if (r.status === "FAILED") return { error: `Versand fehlgeschlagen: ${r.log.error ?? "unbekannter Fehler"}. Bitte später erneut versuchen.` };
    return { ok: r.status === "DUPLICATE" ? "Diese Stornobestätigung wurde bereits versendet." : "Die Stornobestätigung wurde versendet." };
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
}

export type PeriodPreviewResult = { error: string | null; before: { range: string; days: number; price: string }; after: { range: string; days: number; price: string; diff: string } | null; paid: string; overpaid: boolean };

/** Befehl 28: Zeitraum vor der Vertragsunterschrift – Vorschau (alt/neu, Preis, Verfügbarkeit). */
export async function previewPeriodChangeAction(id: string, formData: FormData): Promise<PeriodPreviewResult> {
  const { tenant } = await requireRole("DISPO");
  const p = await previewBookingPeriodChange(tenant.id, id, parseLocalDateTime(str(formData, "startAt")), parseLocalDateTime(str(formData, "endAt")));
  const range = (a: Date, b: Date | null) => `${fmtDateTime(a)} – ${b ? fmtDateTime(b) : "offen"}`;
  return {
    error: p.error,
    before: { range: range(p.before.startAt, p.before.endAt), days: p.before.days, price: fmtCents(p.before.priceCents) },
    after: p.after ? { range: range(p.after.startAt, p.after.endAt), days: p.after.days, price: fmtCents(p.after.priceCents), diff: `${p.after.priceCents - p.before.priceCents >= 0 ? "+" : "−"}${fmtCents(Math.abs(p.after.priceCents - p.before.priceCents))}` } : null,
    paid: fmtCents(p.paidCents),
    overpaid: !!p.after && p.paidCents > p.after.priceCents,
  };
}

export async function changePeriodAction(id: string, _prev: CancelState, formData: FormData): Promise<CancelState> {
  const { tenant, user } = await requireRole("DISPO");
  const startAt = parseLocalDateTime(str(formData, "startAt"));
  const endAt = parseLocalDateTime(str(formData, "endAt"));
  if (!startAt || !endAt) return { error: "Bitte Abholung und Rückgabe mit Datum und Uhrzeit angeben." };
  try {
    await changeBookingPeriod(tenant.id, { id: user.id, name: user.name }, id, { startAt, endAt, reason: str(formData, "reason") });
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  revalidate(id);
  revalidatePath("/dispo");
  redirect(`/buchungen/${id}?zeitraum=1`);
}
