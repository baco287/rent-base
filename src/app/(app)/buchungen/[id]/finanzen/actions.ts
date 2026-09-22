"use server";

// Zahlungen und Kaution: alle Rechte serverseitig.
//   Zahlung erfassen / stornieren:            Inhaber, Disponent
//   Kaution als erhalten dokumentieren:        Inhaber, Disponent, Hofmitarbeiter (operativ bei der Übergabe)
//   Kaution freigeben / einbehalten / korrigieren: Inhaber, Disponent
// Jede Aktion trägt einen einmaligen Formularschlüssel (nonce): Doppelklick bucht nie doppelt.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { PAYMENT_METHODS } from "@/lib/constants";
import { cancelDepositEvent, previewDepositSettlement, recordDepositReceived, settleDeposit, type SettlePreview } from "@/lib/deposits";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { fmtCents } from "@/lib/money";
import { cancelPayment, previewInvoicePayment, recordInvoicePayment, type PaymentPreview } from "@/lib/payments";
import { parseLocalDateTime } from "@/lib/time";

export type MoneyState = { error?: string; ok?: string } | undefined;

function refresh(bookingId: string) {
  for (const p of [`/buchungen/${bookingId}`, `/buchungen/${bookingId}/rechnung`, `/buchungen/${bookingId}/uebergabe`, `/buchungen/${bookingId}/rueckgabe`, "/rechnungen", "/heute"]) revalidatePath(p);
}

function failure(e: unknown): MoneyState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Dieser Eintrag ist abgeschlossen und kann nicht mehr geändert werden." };
  console.error("[finanzen] Aktion fehlgeschlagen", { fehler: e instanceof Error ? e.name : "unbekannt", code: (e as { code?: unknown })?.code ?? null });
  return { error: "Das hat technisch nicht geklappt. Bitte die Seite neu laden und erneut versuchen." };
}

const method = z.enum(Object.keys(PAYMENT_METHODS) as [string, ...string[]], { message: "Bitte eine Zahlungsart wählen." });
const nonce = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "Die Seite ist veraltet. Bitte neu laden.");
const when = z.string().min(1, "Bitte Datum und Uhrzeit angeben.");
const text = (max: number) => z.string().trim().max(max).optional();

const paymentSchema = z.object({ invoiceId: z.string().min(1), amount: z.string().trim().min(1, "Bitte einen Betrag eingeben."), method, paidAt: when, reference: text(120), note: text(500), nonce });

/** Vorschau für den Bestätigungsschritt (serverseitig gerechnet, bucht nichts). */
export async function previewPaymentAction(invoiceId: string, amount: string, methodKey: string): Promise<PaymentPreview | { error: string }> {
  const { tenant } = await requireRole("DISPO");
  try {
    return await previewInvoicePayment(tenant.id, invoiceId, amount, methodKey);
  } catch (e) {
    return { error: e instanceof DomainError ? e.message : "Vorschau nicht möglich." };
  }
}

export async function recordPaymentAction(bookingId: string, _prev: MoneyState, formData: FormData): Promise<MoneyState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = paymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const paidAt = parseLocalDateTime(parsed.data.paidAt);
  if (!paidAt) return { error: "Bitte ein gültiges Zahlungsdatum angeben." };
  try {
    const res = await recordInvoicePayment(tenant.id, { id: user.id, name: user.name }, { ...parsed.data, paidAt, idempotencyKey: parsed.data.nonce });
    refresh(bookingId);
    return { ok: res.created ? `Zahlung über ${fmtCents(res.payment.amountCents)} erfasst.` : "Diese Zahlung war bereits erfasst. Es wurde nichts doppelt gebucht." };
  } catch (e) {
    return failure(e);
  }
}

const cancelSchema = z.object({ id: z.string().min(1), reason: z.string().trim().min(3, "Bitte den Grund der Korrektur angeben.").max(500) });

export async function cancelPaymentAction(bookingId: string, _prev: MoneyState, formData: FormData): Promise<MoneyState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = cancelSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const p = await cancelPayment(tenant.id, { id: user.id, name: user.name }, parsed.data.id, parsed.data.reason);
    refresh(bookingId);
    return { ok: `Zahlung über ${fmtCents(p.amountCents)} storniert. Der offene Betrag wurde neu berechnet.` };
  } catch (e) {
    return failure(e);
  }
}

const receiveSchema = z.object({ amount: z.string().trim().min(1, "Bitte einen Betrag eingeben."), method, occurredAt: when, reference: text(120), note: text(500), nonce });

export async function recordDepositReceivedAction(bookingId: string, _prev: MoneyState, formData: FormData): Promise<MoneyState> {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const parsed = receiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const occurredAt = parseLocalDateTime(parsed.data.occurredAt);
  if (!occurredAt) return { error: "Bitte einen gültigen Zeitpunkt angeben." };
  try {
    const res = await recordDepositReceived(tenant.id, { id: user.id, name: user.name }, { bookingId, ...parsed.data, occurredAt, idempotencyKey: parsed.data.nonce });
    refresh(bookingId);
    return { ok: res.created ? `Kaution über ${fmtCents(res.event.amountCents)} als erhalten dokumentiert.` : "Dieser Eingang war bereits dokumentiert. Es wurde nichts doppelt erfasst." };
  } catch (e) {
    return failure(e);
  }
}

export async function previewDepositSettleAction(bookingId: string, releaseAmount: string): Promise<SettlePreview | { error: string }> {
  const { tenant } = await requireRole("DISPO");
  try {
    return await previewDepositSettlement(tenant.id, bookingId, releaseAmount);
  } catch (e) {
    return { error: e instanceof DomainError ? e.message : "Vorschau nicht möglich." };
  }
}

const settleSchema = z.object({ releaseAmount: z.string().trim().min(1, "Bitte den Freigabebetrag angeben (0 = alles einbehalten)."), method: z.string().optional(), reason: text(500), note: text(500), occurredAt: when, nonce });

export async function settleDepositAction(bookingId: string, _prev: MoneyState, formData: FormData): Promise<MoneyState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = settleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const occurredAt = parseLocalDateTime(parsed.data.occurredAt);
  if (!occurredAt) return { error: "Bitte einen gültigen Zeitpunkt angeben." };
  try {
    const res = await settleDeposit(tenant.id, { id: user.id, name: user.name }, { bookingId, ...parsed.data, occurredAt, idempotencyKey: parsed.data.nonce });
    refresh(bookingId);
    if (!res.created) return { ok: "Diese Entscheidung war bereits dokumentiert. Es wurde nichts doppelt erfasst." };
    const released = res.events.find((e) => e.type === "RELEASED")?.amountCents ?? 0;
    const retained = res.events.find((e) => e.type === "RETAINED")?.amountCents ?? 0;
    return { ok: res.kind === "RELEASE" ? `Kaution über ${fmtCents(released)} als freigegeben dokumentiert.` : res.kind === "RETAIN" ? `Einbehalt über ${fmtCents(retained)} dokumentiert.` : `${fmtCents(released)} freigegeben, ${fmtCents(retained)} einbehalten – dokumentiert.` };
  } catch (e) {
    return failure(e);
  }
}

export async function cancelDepositEventAction(bookingId: string, _prev: MoneyState, formData: FormData): Promise<MoneyState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = cancelSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const ev = await cancelDepositEvent(tenant.id, { id: user.id, name: user.name }, parsed.data.id, parsed.data.reason);
    refresh(bookingId);
    return { ok: `Kautionsbewegung über ${fmtCents(ev.amountCents)} storniert. Der Kautionsstand wurde neu berechnet.` };
  } catch (e) {
    return failure(e);
  }
}
