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
import { changeBookingPeriod, previewBookingPeriodChange, type PeriodPriceDecision } from "@/lib/booking-period";
import { cancelBooking, previewCancellation, type CancellationInput } from "@/lib/cancellation";
import { sendCancellationConfirmation } from "@/lib/cancellation-mail";
import { ensureCancellationDocument } from "@/lib/documents";
import { runCancellationFollowUp } from "@/lib/followup";
import { fmtCents, toCents } from "@/lib/money";
import { DomainError } from "@/lib/integrity";
import { getStorage } from "@/lib/storage";
import { parseLocalDateTime } from "@/lib/time";
import { PAYMENT_METHODS, RENTAL_PAYMENT_INTENTS, type RentalPaymentIntent } from "@/lib/constants";
import { insertRentalPayment, parseRentalAmount, type RentalPaymentInput } from "@/lib/rental-payments";
import { checkReceiveInput, depositAgreedAmountConflict, insertDepositReceived, type ReceiveInput } from "@/lib/deposits";
import { recordAudit } from "@/lib/audit";
import { refreshContractDraft } from "@/lib/contracts";
import { describePrice } from "@/lib/pricing";
import { bookingQuote } from "@/lib/booking-price";
import { bookingTariffFor, choicesOf, keepBookingTariff, kmRuleText, priceSourceText, quoteTariff, readTariffSnapshot, vehicleTariffs, type BookingTariffResult, type TariffChoices } from "@/lib/tariffs";
import { tariffChoicesFromForm, tariffSelectionFromForm } from "./tariff-form-data";

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

const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

// Befehl 29: Mietpreis, Kaution und Kilometer kommen aus dem gewählten Miettarif (Abweichungen nur mit Grund, siehe tariff-form-data)
const bookingSchema = z
  .object({
    vehicleId: z.string().min(1, "Bitte ein Fahrzeug wählen."),
    customerId: z.string().optional(),
    startAt: z.preprocess(parseLocalDateTime, z.date({ message: "Bitte Abholung mit Datum und Uhrzeit angeben." })),
    endAt: z.preprocess(parseLocalDateTime, z.date({ message: "Bitte Rückgabe mit Datum und Uhrzeit angeben." })),
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
  const selection = tariffSelectionFromForm(formData);
  if ("error" in selection) return selection;
  if (selection.mode !== "PLAN") return { error: "Bitte einen Miettarif wählen." };
  const choices = tariffChoicesFromForm(formData);
  if ("error" in choices) return choices;

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
    // Befehl 29: Tarif unter Sperre auflösen; hat er sich seit der Vorschau geändert, wird nichts gespeichert (keine versteckte Preisänderung)
    const actor = { id: user.id, name: user.name };
    const discount = customerData ? customerData.discountPercent ?? 0 : refs.customer?.discountPercent ?? 0;
    const tariff = await bookingTariffFor(tx, tenant.id, actor, { vehicleId: d.vehicleId, ratePlanId: selection.ratePlanId, startAt: d.startAt, endAt: d.endAt, discountPercent: discount, choices, previous: null, seenRevisionId: selection.seenRevisionId, seenRegularCents: selection.seenRegularCents });
    if (dep.input && tariff.data.deposit <= 0) return { error: "Kaution: Ohne vereinbarte Kaution (Betrag 0) kann kein Eingang dokumentiert werden." };
    const customerId = customerData ? (await tx.customer.create({ data: { tenantId: tenant.id, number: await nextCustomerNumber(tx, tenant.id), ...customerData } })).id : d.customerId!;
    const number = await nextBookingNumber(tx, tenant.id, d.startAt);
    const b = await tx.booking.create({
      data: { tenantId: tenant.id, number, vehicleId: d.vehicleId, customerId, startAt: d.startAt, endAt: d.endAt, notes: d.notes ?? null, ...tariff.data },
    });
    id = b.id;
    for (const a of tariff.audits) await recordAudit(tx, tenant.id, actor, { ...a, bookingId: b.id });
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
  const { tenant, user } = await requireRole("DISPO");
  const parsed = bookingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  const selection = tariffSelectionFromForm(formData);
  if ("error" in selection) return selection;
  const choices = tariffChoicesFromForm(formData);
  if ("error" in choices) return choices;

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
    // Befehl 29: Tarif der Buchung. „KEEP“ = eingefrorenen Tarif behalten (nur Abweichungen ändern), „LEGACY“ = Buchung ohne Tarif
    // unverändert lassen, sonst bewusst (neuen) Tarif übernehmen. Ein Fahrzeugwechsel braucht immer eine neue Tarifauflösung.
    const actor = { id: user.id, name: user.name };
    const vehicleChanged = existing.vehicleId !== d.vehicleId;
    const previous = readTariffSnapshot(existing.tariffSnapshot);
    const discount = refs.customer?.discountPercent ?? 0;
    let tariff: BookingTariffResult | null = null;
    if (selection.mode === "LEGACY") {
      if (existing.ratePlanId || vehicleChanged) return { error: "Bitte einen Miettarif wählen." };
    } else if (selection.mode === "KEEP") {
      if (!previous || vehicleChanged) return { error: "Bitte einen Miettarif wählen." };
      tariff = keepBookingTariff(previous, { startAt: existing.startAt, endAt: existingEnd, discountPercent: discount, choices, actor });
    } else {
      // bewusste Entscheidung über einen vereinbarten Sonderpreis bei Tarif- oder Fahrzeugwechsel (nie still übernehmen)
      if (previous?.agreed.price && choices.price.mode === "INDIVIDUAL" && formData.get("priceConfirm") !== "KEEP") return { error: "Für diese Buchung wurde ein individueller Preis vereinbart. Bitte bestätigen: individuellen Preis beibehalten oder neuen Tarifpreis übernehmen." };
      tariff = await bookingTariffFor(tx, tenant.id, actor, { vehicleId: d.vehicleId, ratePlanId: selection.ratePlanId, startAt: existing.startAt, endAt: existingEnd, discountPercent: discount, choices, previous, seenRevisionId: selection.seenRevisionId, seenRegularCents: selection.seenRegularCents });
    }
    if (tariff) {
      // Befehl 20.9: eine bei der Buchung als erhalten dokumentierte Kaution legt den vereinbarten Betrag fest
      const conflict = await depositAgreedAmountConflict(tx, tenant.id, id, Math.round(tariff.data.deposit * 100));
      if (conflict) return { error: conflict };
    }
    await tx.booking.update({ where: { id }, data: { vehicleId: d.vehicleId, customerId: d.customerId!, notes: d.notes ?? null, ...(tariff?.data ?? {}) } });
    for (const a of tariff?.audits ?? []) await recordAudit(tx, tenant.id, actor, { ...a, bookingId: id });
    // ein Vertragsentwurf übernimmt Preis, Kaution und Kilometer der Buchung (führende Quelle bis zur Unterschrift)
    if (contract?.status === "DRAFT") {
      const c = await tx.rentalContract.findFirst({ where: { bookingId: id, tenantId: tenant.id }, select: { id: true } });
      if (c) await refreshContractDraft(tx, tenant.id, c.id);
    }
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

export type PeriodPreviewResult = { error: string | null; before: { range: string; days: number; price: string }; after: { range: string; days: number; price: string; diff: string } | null; paid: string; overpaid: boolean; /** Befehl 29: individuell vereinbarter Preis → Entscheidung Pflicht */ agreed: { price: string; reason: string } | null; tariffName: string | null };

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
    overpaid: !!p.after && p.paidCents > (p.agreed ? p.agreed.cents : p.after.priceCents),
    agreed: p.agreed ? { price: fmtCents(p.agreed.cents), reason: p.agreed.reason } : null,
    tariffName: p.tariffName,
  };
}

export async function changePeriodAction(id: string, _prev: CancelState, formData: FormData): Promise<CancelState> {
  const { tenant, user } = await requireRole("DISPO");
  const startAt = parseLocalDateTime(str(formData, "startAt"));
  const endAt = parseLocalDateTime(str(formData, "endAt"));
  if (!startAt || !endAt) return { error: "Bitte Abholung und Rückgabe mit Datum und Uhrzeit angeben." };
  try {
    // Befehl 29: Preisentscheidung bei individuell vereinbartem Preis (behalten / Tarifpreis / neuer Preis mit Grund)
    const mode = str(formData, "priceDecision");
    let priceDecision: PeriodPriceDecision | null = null;
    if (mode === "KEEP" || mode === "TARIFF") priceDecision = { mode };
    else if (mode === "INDIVIDUAL") {
      const c = (() => { try { return toCents(str(formData, "newPrice")); } catch { return null; } })();
      if (c == null || c < 0) return { error: "Neuer Mietpreis: bitte einen Betrag ab 0,00 € angeben." };
      priceDecision = { mode: "INDIVIDUAL", cents: c, reason: str(formData, "newPriceReason") };
    }
    await changeBookingPeriod(tenant.id, { id: user.id, name: user.name }, id, { startAt, endAt, reason: str(formData, "reason"), priceDecision });
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  revalidate(id);
  revalidatePath("/dispo");
  redirect(`/buchungen/${id}?zeitraum=1`);
}

/** Befehl 29: ein Tarifangebot für die Buchungsmaske (serverseitig berechnet – dieselbe Engine wie beim Speichern). */
export type TariffOffer = {
  ratePlanId: string;
  revisionId: string;
  revision: number;
  name: string;
  code: string | null;
  regularCents: number;
  priceText: string;
  days: number;
  kmPolicy: "FREE_KILOMETERS" | "UNLIMITED";
  kmText: string;
  includedKm: number | null;
  extraKmRateCents: number | null;
  depositCents: number;
  isDefault: boolean;
  priceSource: string;
};
export type TariffQuoteResult = {
  offers: TariffOffer[];
  defaultRatePlanId: string | null;
  days: number;
  discountPercent: number;
  problem: string | null;
  /** bestehende Tarifbuchung: eingefrorener Tarif für den Zeitraum der Buchung */
  current: (Omit<TariffOffer, "isDefault" | "priceSource"> & { stale: boolean; agreedCents: number | null; agreedReason: string | null; kmAgreed: string | null; kmReason: string | null; depositAgreedCents: number | null; depositReason: string | null }) | null;
};

/** Preisvorschau aller aktiven Tarife eines Fahrzeugs für einen Zeitraum (OWNER/DISPO). Nichts wird gespeichert. */
export async function quoteTariffsAction(input: { vehicleId: string; startAt: string; endAt: string; customerId?: string | null; bookingId?: string | null }): Promise<TariffQuoteResult> {
  const { tenant } = await requireRole("DISPO");
  const empty = (problem: string | null): TariffQuoteResult => ({ offers: [], defaultRatePlanId: null, days: 0, discountPercent: 0, problem, current: null });
  const startAt = parseLocalDateTime(input.startAt);
  const endAt = parseLocalDateTime(input.endAt);
  if (!input.vehicleId) return empty("Bitte zuerst ein Fahrzeug wählen.");
  if (!startAt || !endAt || !(endAt > startAt)) return empty("Bitte Abholung und Rückgabe angeben (Rückgabe nach der Abholung).");
  const customer = input.customerId ? await db.customer.findFirst({ where: { id: input.customerId, tenantId: tenant.id }, select: { discountPercent: true } }) : null;
  const discountPercent = customer?.discountPercent ?? 0;
  let vt;
  try {
    vt = await vehicleTariffs(tenant.id, input.vehicleId);
  } catch (e) {
    if (e instanceof DomainError) return empty(e.message);
    throw e;
  }
  const offers: TariffOffer[] = vt.bases.map((b) => {
    const q = quoteTariff(b, startAt, endAt, discountPercent);
    return { ratePlanId: b.ratePlanId, revisionId: b.revisionId, revision: b.revision, name: b.ratePlanName, code: b.ratePlanCode, regularCents: q.regularCents, priceText: describePrice(q.breakdown), days: q.days, kmPolicy: b.km.policy, kmText: kmRuleText(b.km), includedKm: q.includedKm, extraKmRateCents: b.km.extraKmRateCents, depositCents: b.depositCents, isDefault: b.ratePlanId === vt.defaultRatePlanId, priceSource: priceSourceText(b) };
  });
  let current: TariffQuoteResult["current"] = null;
  if (input.bookingId) {
    const bk = await db.booking.findFirst({ where: { id: input.bookingId, tenantId: tenant.id } });
    const snap = bk ? readTariffSnapshot(bk.tariffSnapshot) : null;
    if (bk && snap && bk.vehicleId === input.vehicleId && bk.endAt) {
      const q = bookingQuote(bk, bk.startAt, bk.endAt, discountPercent);
      const live = vt.bases.find((b) => b.ratePlanId === snap.ratePlanId);
      current = {
        ratePlanId: snap.ratePlanId, revisionId: snap.revisionId, revision: snap.revision, name: snap.ratePlanName, code: snap.ratePlanCode, regularCents: q.regularCents, priceText: describePrice(q.breakdown), days: q.days,
        kmPolicy: snap.km.policy, kmText: kmRuleText(snap.km), includedKm: snap.km.policy === "UNLIMITED" ? null : q.days * (snap.km.kmIncludedPerDay ?? 0), extraKmRateCents: snap.km.extraKmRateCents, depositCents: snap.deposit.cents,
        stale: !live || live.revisionId !== snap.revisionId || JSON.stringify(live.tiers) !== JSON.stringify(snap.tiers),
        agreedCents: snap.agreed.price?.cents ?? null, agreedReason: snap.agreed.price?.reason ?? null,
        kmAgreed: snap.agreed.km ? kmRuleText(snap.agreed.km) : null, kmReason: snap.agreed.km?.reason ?? null,
        depositAgreedCents: snap.agreed.deposit?.cents ?? null, depositReason: snap.agreed.deposit?.reason ?? null,
      };
    }
  }
  return { offers, defaultRatePlanId: vt.defaultRatePlanId, days: offers[0]?.days ?? 0, discountPercent, problem: vt.problem, current };
}

/** Für das Formular einer bestehenden Buchung: bisherige Abweichungen als Vorbelegung. */
export async function bookingChoicesFor(tenantId: string, bookingId: string): Promise<TariffChoices> {
  const bk = await db.booking.findFirst({ where: { id: bookingId, tenantId }, select: { tariffSnapshot: true } });
  return choicesOf(readTariffSnapshot(bk?.tariffSnapshot));
}
