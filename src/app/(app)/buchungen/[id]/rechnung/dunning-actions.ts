"use server";

// Befehl 23: Mahnwesen auf der Rechnungsseite. Jede Aktion verlangt Disposition oder Inhaber (requireRole blockiert auch
// Support-Sitzungen); der Mandant kommt immer aus der Sitzung. Nichts wird automatisch versendet – nur nach Bestätigung.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { dunningLevelLabel, type DunningLevel } from "@/lib/constants";
import { ensureDunningDocument } from "@/lib/documents";
import { createDunningNotice, markDunningDelivered, previewDunning } from "@/lib/dunning";
import { sendDunningNotice } from "@/lib/dunning-mail";
import { fmtDate } from "@/lib/format";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { fmtCents } from "@/lib/money";

export type DunningState = { error?: string; ok?: string } | undefined;
export type DunningPlanView = { level: number; levelLabel: string; allowed: boolean; reason: string | null; principalOpenCents: number; priorFeesOpenCents: number; feeCents: number; totalCents: number; deadlineDays: number; deadline: string; recipientName: string; recipientEmail: string | null; dueDate: string | null; daysOverdue: number; invoiceNumber: string | null };

function refresh(bookingId: string | null) {
  for (const p of [...(bookingId ? [`/buchungen/${bookingId}`, `/buchungen/${bookingId}/rechnung`] : []), "/forderungen", "/rechnungen", "/heute"]) revalidatePath(p);
  revalidatePath("/rechnungen", "layout");
}

function failure(e: unknown): DunningState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Dieses Mahnschreiben ist abgeschlossen und kann nicht mehr geändert werden." };
  console.error("[mahnwesen] Aktion fehlgeschlagen", { fehler: e instanceof Error ? e.name : "unbekannt", code: (e as { code?: unknown })?.code ?? null });
  return { error: "Das hat technisch nicht geklappt. Bitte die Seite neu laden und erneut versuchen." };
}

const nonce = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "Die Seite ist veraltet. Bitte neu laden.");
const levelSchema = z.coerce.number().int().min(1).max(3);

/** Vorschau der Stufe: berechnet aus der zentralen Summierung, nichts wird gespeichert. */
export async function previewDunningAction(invoiceId: string, level: number): Promise<DunningPlanView | { error: string }> {
  const { tenant } = await requireRole("DISPO");
  try {
    const lv = levelSchema.parse(level) as DunningLevel;
    const p = await previewDunning(tenant.id, invoiceId, { level: lv });
    return { level: p.level, levelLabel: p.levelLabel, allowed: p.allowed, reason: p.reason, principalOpenCents: p.principalOpenCents, priorFeesOpenCents: p.priorFeesOpenCents, feeCents: p.feeCents, totalCents: p.totalCents, deadlineDays: p.deadlineDays, deadline: fmtDate(p.deadlineAt), recipientName: p.recipientName, recipientEmail: p.recipientEmail, dueDate: p.dueDate ? fmtDate(p.dueDate) : null, daysOverdue: p.daysOverdue, invoiceNumber: p.invoiceNumber };
  } catch (e) {
    return { error: e instanceof DomainError ? e.message : "Vorschau nicht möglich." };
  }
}

const createSchema = z.object({ expectedTotalCents: z.coerce.number().int().positive("Bitte zuerst die Vorschau aufrufen."), nonce, delivery: z.enum(["EMAIL", "POST"]) });

/** Erstellt das Mahnschreiben (ggf. mit Gebührenrechnung), archiviert das PDF und versendet es nur bei „per E-Mail senden“. */
export async function createDunningAction(bookingId: string | null, invoiceId: string, level: number, _prev: DunningState, fd: FormData): Promise<DunningState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = createSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const lv = levelSchema.safeParse(level);
  if (!lv.success) return { error: "Unbekannte Mahnstufe." };
  const actor = { id: user.id, name: user.name };
  try {
    const res = await createDunningNotice(tenant.id, actor, { invoiceId, level: lv.data as DunningLevel, expectedTotalCents: parsed.data.expectedTotalCents, idempotencyKey: parsed.data.nonce });
    const label = `${dunningLevelLabel(res.notice.level)} ${res.notice.number}`;
    refresh(bookingId);
    if (!res.created) return { ok: `${label} war bereits erstellt. Es wurde nichts doppelt angelegt.` };
    try {
      await ensureDunningDocument(tenant.id, res.notice.id, user.id);
    } catch {
      return { ok: `${label} über ${fmtCents(res.notice.totalCents)} erstellt. Das PDF konnte noch nicht erzeugt werden; es wird beim Versand erneut versucht.` };
    }
    if (parsed.data.delivery === "POST") return { ok: `${label} über ${fmtCents(res.notice.totalCents)} erstellt. Bitte das PDF übermitteln und die Übermittlung vermerken.` };
    const sent = await sendDunningNotice(tenant.id, actor, res.notice.id, { nonce: `${parsed.data.nonce.slice(0, 55)}-mail` });
    refresh(bookingId);
    return sent.status === "FAILED"
      ? { error: `${label} wurde erstellt, der Versand ist fehlgeschlagen: ${sent.log.error ?? "unbekannter Fehler"}. Bitte erneut senden oder per Post übermitteln.` }
      : { ok: `${label} über ${fmtCents(res.notice.totalCents)} erstellt und an ${sent.log.recipient} versendet.` };
  } catch (e) {
    return failure(e);
  }
}

const sendSchema = z.object({ id: z.string().min(1), nonce });

/** Versand bzw. erneuter Versand desselben archivierten PDFs – keine neue Stufe, keine neue Gebühr, keine neue Nummer. */
export async function sendDunningAction(bookingId: string | null, _prev: DunningState, fd: FormData): Promise<DunningState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = sendSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const res = await sendDunningNotice(tenant.id, { id: user.id, name: user.name }, parsed.data.id, { nonce: parsed.data.nonce });
    refresh(bookingId);
    if (res.status === "DUPLICATE") return { ok: "Dieser Versand wurde bereits ausgeführt. Es wurde nichts doppelt gesendet." };
    if (res.status === "FAILED") return { error: `Versand fehlgeschlagen: ${res.log.error ?? "unbekannter Fehler"}.` };
    return { ok: `${res.resend ? "Erneut versendet" : "Versendet"} an ${res.log.recipient}.` };
  } catch (e) {
    return failure(e);
  }
}

const deliveredSchema = z.object({ id: z.string().min(1), note: z.string().trim().max(300).optional() });

/** Übermittlung per Post oder persönlich einmalig vermerken. */
export async function markDunningDeliveredAction(bookingId: string | null, _prev: DunningState, fd: FormData): Promise<DunningState> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = deliveredSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const n = await markDunningDelivered(tenant.id, { id: user.id, name: user.name }, parsed.data.id, parsed.data.note ?? null);
    refresh(bookingId);
    return { ok: `Übermittlung von ${dunningLevelLabel(n.level)} ${n.number} vermerkt.` };
  } catch (e) {
    return failure(e);
  }
}
