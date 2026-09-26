"use server";

// Befehl 20.6: kontaktlose Rückgabe vereinbaren, Rückgabe-Mail versenden/erneut senden, Link widerrufen, Vereinbarung
// aufheben. Nur Inhaber und Disposition (requireRole("DISPO")); Hofmitarbeiter sehen, lösen aber nichts aus.
// Der Mandant kommt aus der Sitzung; jede Aktion prüft zusätzlich, dass die Rückgabe zu dieser Buchung gehört.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { authorizeKeyDrop, cancelKeyDrop, revokeKeyDropLink, sendKeyDropLink } from "@/lib/key-drop";
import { requestBaseUrl } from "@/lib/request-url";
import { parseLocalDateTime } from "@/lib/time";

export type KeyDropState = { error?: string; ok?: string } | undefined;

function asState(e: unknown): KeyDropState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Diese kontaktlose Rückgabe kann in ihrem Zustand nicht mehr geändert werden." };
  throw e;
}

async function ownKeyDrop(tenantId: string, bookingId: string, keyDropId: string) {
  const kd = await db.keyDropReturn.findFirst({ where: { id: keyDropId, tenantId, bookingId }, select: { id: true } });
  if (!kd) throw new DomainError("Kontaktlose Rückgabe nicht gefunden.");
  return kd;
}

const refresh = (bookingId: string) => { revalidatePath(`/buchungen/${bookingId}`); revalidatePath("/heute"); };

export async function authorizeKeyDropAction(bookingId: string, _prev: KeyDropState, fd: FormData): Promise<KeyDropState> {
  const { tenant, user } = await requireRole("DISPO");
  try {
    await authorizeKeyDrop(tenant.id, { id: user.id, name: user.name }, bookingId, {
      location: String(fd.get("location") ?? ""),
      instructions: String(fd.get("instructions") ?? ""),
      expectedReturnAt: fd.get("expectedReturnAt") ? parseLocalDateTime(String(fd.get("expectedReturnAt"))) : null,
      internalNote: String(fd.get("internalNote") ?? ""),
      agreedWithCustomer: fd.get("agreed") === "on",
    });
  } catch (e) { return asState(e); }
  refresh(bookingId);
  return { ok: "Kontaktlose Rückgabe vereinbart. Es wurde noch keine E-Mail versendet." };
}

export async function sendKeyDropLinkAction(bookingId: string, keyDropId: string, _prev: KeyDropState, fd: FormData): Promise<KeyDropState> {
  const { tenant, user } = await requireRole("DISPO");
  try {
    await ownKeyDrop(tenant.id, bookingId, keyDropId);
    const res = await sendKeyDropLink(tenant.id, { id: user.id, name: user.name }, keyDropId, { nonce: String(fd.get("nonce") ?? ""), baseUrl: await requestBaseUrl() });
    refresh(bookingId);
    if (res.status === "DUPLICATE") return { ok: "Diese Anfrage wurde bereits verarbeitet. Es wurde nichts doppelt verschickt." };
    if (res.status === "FAILED") return { error: `Die Rückgabe-Mail konnte nicht versendet werden: ${res.error ?? "unbekannter Fehler"}` };
    return { ok: res.resent ? "Rückgabe-Mail erneut versendet. Der vorherige Link ist ungültig." : "Rückgabe-Mail versendet." };
  } catch (e) { return asState(e); }
}

export async function revokeKeyDropLinkAction(bookingId: string, keyDropId: string, _prev: KeyDropState, _fd: FormData): Promise<KeyDropState> {
  void _fd;
  const { tenant, user } = await requireRole("DISPO");
  try {
    await ownKeyDrop(tenant.id, bookingId, keyDropId);
    const n = await revokeKeyDropLink(tenant.id, { id: user.id, name: user.name }, keyDropId);
    refresh(bookingId);
    return { ok: n > 0 ? "Der Rückgabelink ist ungültig." : "Es gab keinen gültigen Link." };
  } catch (e) { return asState(e); }
}

export async function cancelKeyDropAction(bookingId: string, keyDropId: string, _prev: KeyDropState, fd: FormData): Promise<KeyDropState> {
  const { tenant, user } = await requireRole("DISPO");
  try {
    await ownKeyDrop(tenant.id, bookingId, keyDropId);
    await cancelKeyDrop(tenant.id, { id: user.id, name: user.name }, keyDropId, String(fd.get("reason") ?? ""));
  } catch (e) { return asState(e); }
  refresh(bookingId);
  return { ok: "Kontaktlose Rückgabe aufgehoben. Die normale Rückgabe ist wieder möglich." };
}
