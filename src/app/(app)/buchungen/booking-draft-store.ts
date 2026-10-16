"use client";

// Buchungsentwurf im Browser: Zugriff auf localStorage (in try/catch – privates Fenster, gesperrter Speicher) und Abonnement für
// React (useSyncExternalStore). Die Logik selbst steht rein in lib/booking-draft.ts.
import { useSyncExternalStore } from "react";
import { parseDrafts, readDraftsRaw, type BookingDraft, type DraftScope, type DraftStorage } from "@/lib/booking-draft";

const EVENT = "rb-buchung-entwurf";

export function browserDraftStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Andere Komponenten dieses Fensters informieren (andere Fenster über das storage-Ereignis). */
export function notifyDrafts() {
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** Gespeicherter Text der Entwürfe dieses Mandanten und Benutzers; null auf dem Server und vor der Hydrierung. */
export function useDraftsRaw(scope: DraftScope): string | null {
  return useSyncExternalStore(subscribe, () => readDraftsRaw(browserDraftStorage(), scope), () => null);
}

/** Geprüfte, nicht abgelaufene Entwürfe (neueste zuerst). */
export function draftsOf(raw: string | null, scope: DraftScope): BookingDraft[] {
  return parseDrafts(raw, scope, Date.now());
}

/** Zufällige Entwurfskennung (UUID). */
export function newDraftId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
}

/** Aktuelle Ortszeit im Format von datetime-local (für den Hinweis „Abholung liegt in der Vergangenheit“). */
export function localNowInput(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** „15.10.2026, 14:32“ */
export function savedAtText(ms: number): string {
  return new Date(ms).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Aktuelle Zeit in Millisekunden (nur in Ereignis-Handlern aufrufen, nie beim Rendern). */
export function nowMs(): number {
  return Date.now();
}
