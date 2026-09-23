"use server";

// Auszahlungen: Entwurf, Abschluss („als tatsächlich erfolgt erfassen“), Storno mit Grund, PDF, E-Mail – nur Inhaber und Disponent.
// Hofmitarbeiter sehen den Stand; sie erfassen, finalisieren und stornieren nichts. Jede Aktion prüft die Rolle serverseitig.
// Rent-Base führt keine Überweisung, Karten- oder Providertransaktion aus; es dokumentiert den Vorgang.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { PAYOUT_METHODS } from "@/lib/constants";
import { ensurePayoutDocument } from "@/lib/documents";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { fmtCents } from "@/lib/money";
import { cancelPayout, completePayout, createPayout, previewPayout, sendPayoutReceipt, updatePayoutDraft, type PayoutInput, type PayoutPreview, type SourceRef } from "@/lib/payouts";
import { parseLocalDateTime } from "@/lib/time";

export type PayoutState = { error?: string; ok?: string; payoutId?: string } | undefined;

function refresh(bookingId: string | null) {
  for (const p of ["/auszahlungen", "/rechnungen", "/heute", "/kunden"]) revalidatePath(p);
  if (bookingId) for (const p of [`/buchungen/${bookingId}`, `/buchungen/${bookingId}/rechnung`]) revalidatePath(p);
}

function failure(e: unknown): PayoutState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Diese Auszahlung ist abgeschlossen und kann nicht mehr geändert werden. Korrektur nur über Storno und neue Auszahlung." };
  console.error("[auszahlungen] Aktion fehlgeschlagen", { fehler: e instanceof Error ? e.name : "unbekannt", code: (e as { code?: unknown })?.code ?? null });
  return { error: "Das hat technisch nicht geklappt. Bitte die Seite neu laden und erneut versuchen." };
}

const refSchema = z.union([z.object({ sourceType: z.literal("INVOICE_REFUND"), invoiceId: z.string().min(1) }), z.object({ sourceType: z.literal("SECURITY_DEPOSIT_REFUND"), bookingId: z.string().min(1) })]);
const text = (max: number) => z.string().trim().max(max).optional();
const inputSchema = z.object({
  amount: z.string().trim().min(1, "Bitte einen Betrag eingeben."),
  method: z.enum(Object.keys(PAYOUT_METHODS) as [string, ...string[]], { message: "Bitte den Auszahlungsweg wählen." }),
  methodDescription: text(200),
  executedAt: z.string().optional(),
  recipientName: text(200),
  recipientReason: text(300),
  iban: text(60),
  reference: text(140),
  receiptConfirmed: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional(),
  historicalEntry: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional(),
  customerNote: text(1000),
  internalNote: text(2000),
  nonce: z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "Die Seite ist veraltet. Bitte neu laden.").optional(),
  mode: z.enum(["draft", "complete"]).optional(),
  confirmed: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional(),
});

function toInput(d: z.infer<typeof inputSchema>): PayoutInput & { executedAtInvalid: boolean } {
  const executedAt = d.executedAt ? parseLocalDateTime(d.executedAt) : null;
  return { amount: d.amount, method: d.method, methodDescription: d.methodDescription, executedAt, recipientName: d.recipientName, recipientReason: d.recipientReason, iban: d.iban, reference: d.reference, receiptConfirmed: d.receiptConfirmed, historicalEntry: d.historicalEntry, customerNote: d.customerNote, internalNote: d.internalNote, idempotencyKey: d.nonce, executedAtInvalid: !!d.executedAt && !executedAt };
}

/** Vorschau (serverseitig gerechnet, bucht nichts). Betragsgrenzen kommen aus der zentralen Summierung. */
export async function previewPayoutAction(ref: unknown, payload: unknown): Promise<PayoutPreview | { error: string }> {
  const { tenant } = await requireRole("DISPO");
  const r = refSchema.safeParse(ref);
  const p = inputSchema.safeParse(payload);
  if (!r.success) return { error: "Unbekannte Quelle." };
  if (!p.success) return { error: p.error.issues[0].message };
  const input = toInput(p.data);
  if (input.executedAtInvalid) return { error: "Bitte einen gültigen Zeitpunkt angeben." };
  try {
    return await previewPayout(tenant.id, r.data as SourceRef, input);
  } catch (e) {
    return { error: e instanceof DomainError ? e.message : "Vorschau nicht möglich." };
  }
}

/** Anlegen: als Entwurf (kein Geldfluss) oder direkt als tatsächlich erfolgt (mit Nummer, Beleg). */
export async function createPayoutAction(ref: unknown, bookingId: string, _prev: PayoutState, formData: FormData): Promise<PayoutState> {
  const { tenant, user } = await requireRole("DISPO");
  const r = refSchema.safeParse(ref);
  const p = inputSchema.safeParse(Object.fromEntries(formData));
  if (!r.success) return { error: "Unbekannte Quelle." };
  if (!p.success) return { error: p.error.issues[0].message };
  const input = toInput(p.data);
  if (input.executedAtInvalid) return { error: "Bitte einen gültigen Zeitpunkt angeben." };
  const complete = p.data.mode === "complete";
  try {
    const res = await createPayout(tenant.id, { id: user.id, name: user.name }, r.data as SourceRef, input, { complete, confirmed: !!p.data.confirmed });
    if (complete && res.created) await ensurePayoutDocument(tenant.id, res.payout.id, user.id).catch(() => null);
    refresh(bookingId);
    if (!res.created) return { ok: "Diese Auszahlung war bereits erfasst. Es wurde nichts doppelt gebucht.", payoutId: res.payout.id };
    return { ok: complete ? `Auszahlung ${res.payout.number} über ${fmtCents(res.payout.amountCents)} als erfolgt erfasst.` : `Entwurf über ${fmtCents(res.payout.amountCents)} gespeichert. Es ist noch kein Geld geflossen.`, payoutId: res.payout.id };
  } catch (e) {
    return failure(e);
  }
}

export async function updatePayoutDraftAction(payoutId: string, bookingId: string, _prev: PayoutState, formData: FormData): Promise<PayoutState> {
  const { tenant, user } = await requireRole("DISPO");
  const p = inputSchema.safeParse(Object.fromEntries(formData));
  if (!p.success) return { error: p.error.issues[0].message };
  const input = toInput(p.data);
  if (input.executedAtInvalid) return { error: "Bitte einen gültigen Zeitpunkt angeben." };
  try {
    const row = await updatePayoutDraft(tenant.id, { id: user.id, name: user.name }, payoutId, input);
    // Entwurf direkt als tatsächlich erfolgt erfassen (Bestätigung Pflicht, Rest unter Sperre neu gerechnet)
    if (p.data.mode === "complete") {
      const done = await completePayout(tenant.id, { id: user.id, name: user.name }, payoutId, { confirmed: !!p.data.confirmed });
      await ensurePayoutDocument(tenant.id, done.id, user.id).catch(() => null);
      refresh(bookingId);
      return { ok: `Auszahlung ${done.number} über ${fmtCents(done.amountCents)} als erfolgt erfasst.`, payoutId: done.id };
    }
    refresh(bookingId);
    return { ok: `Entwurf über ${fmtCents(row.amountCents)} gespeichert.`, payoutId: row.id };
  } catch (e) {
    return failure(e);
  }
}

const completeSchema = z.object({ confirmed: z.preprocess((v) => v === "1" || v === "on", z.boolean()), executedAt: z.string().optional() });

/** Entwurf als tatsächlich erfolgt erfassen (Sperre auf der Quelle, Rest neu gerechnet, Nummer, Beleg). */
export async function completePayoutAction(payoutId: string, bookingId: string, _prev: PayoutState, formData: FormData): Promise<PayoutState> {
  const { tenant, user } = await requireRole("DISPO");
  const p = completeSchema.safeParse(Object.fromEntries(formData));
  if (!p.success) return { error: "Ungültige Eingabe." };
  const executedAt = p.data.executedAt ? parseLocalDateTime(p.data.executedAt) : undefined;
  if (p.data.executedAt && !executedAt) return { error: "Bitte einen gültigen Zeitpunkt angeben." };
  try {
    const row = await completePayout(tenant.id, { id: user.id, name: user.name }, payoutId, { confirmed: p.data.confirmed, executedAt });
    await ensurePayoutDocument(tenant.id, row.id, user.id).catch(() => null);
    refresh(bookingId);
    return { ok: `Auszahlung ${row.number} über ${fmtCents(row.amountCents)} als erfolgt erfasst.`, payoutId: row.id };
  } catch (e) {
    return failure(e);
  }
}

const cancelSchema = z.object({ reason: z.string().trim().min(3, "Bitte den Grund des Stornos angeben.").max(500) });

export async function cancelPayoutAction(payoutId: string, bookingId: string, _prev: PayoutState, formData: FormData): Promise<PayoutState> {
  const { tenant, user } = await requireRole("DISPO");
  const p = cancelSchema.safeParse(Object.fromEntries(formData));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const row = await cancelPayout(tenant.id, { id: user.id, name: user.name }, payoutId, p.data.reason);
    refresh(bookingId);
    return { ok: row.number ? `Auszahlung ${row.number} storniert. Der Betrag steht wieder zur Auszahlung zur Verfügung; der Vorgang bleibt sichtbar.` : "Entwurf aufgehoben.", payoutId: row.id };
  } catch (e) {
    return failure(e);
  }
}

/** Auszahlungsbeleg-PDF nachträglich erzeugen (nur erfolgte Auszahlungen). */
export async function generatePayoutPdfAction(payoutId: string, bookingId: string, _prev: PayoutState, _formData: FormData): Promise<PayoutState> {
  void _formData;
  const { tenant, user } = await requireRole("DISPO");
  try {
    const res = await ensurePayoutDocument(tenant.id, payoutId, user.id);
    refresh(bookingId);
    return { ok: res.created ? "Auszahlungsbeleg wurde erzeugt." : "Der Auszahlungsbeleg war bereits vorhanden.", payoutId };
  } catch (e) {
    return failure(e);
  }
}

/** Auszahlungsbeleg per E-Mail senden: bewusst manuell, einmaliger nonce, EmailLog. */
export async function sendPayoutReceiptAction(payoutId: string, bookingId: string, _prev: PayoutState, formData: FormData): Promise<PayoutState> {
  const { tenant, user } = await requireRole("DISPO");
  try {
    const res = await sendPayoutReceipt(tenant.id, { id: user.id, name: user.name }, payoutId, { nonce: String(formData.get("nonce") ?? "") });
    refresh(bookingId);
    if (res.status === "SENT") return { ok: `Auszahlungsbeleg wurde an ${res.log.recipient} versendet.`, payoutId };
    if (res.status === "DUPLICATE") return res.log.status === "SENT" ? { ok: "Diese Anfrage wurde bereits versendet. Es wurde nichts doppelt verschickt.", payoutId } : { error: "Diese Anfrage wurde bereits verarbeitet. Bitte den Stand prüfen." };
    return { error: `E-Mail konnte nicht versendet werden: ${(res.log.error ?? "unbekannter Fehler").replace(/\.+$/, "")}.` };
  } catch (e) {
    return failure(e);
  }
}
