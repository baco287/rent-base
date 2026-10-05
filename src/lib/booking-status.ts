// Statuswechsel einer Buchung und der abgeleitete Stand im Ablauf.
//
// Die eine Statusmaschine (ALLOWED_TRANSITIONS):
//   RESERVED  -> ACTIVE     nur durch finalizeHandover (PICKUP)
//   ACTIVE    -> RETURNED   nur durch finalizeHandover (RETURN); Altfälle ohne Übergabeprotokoll per Knopf
//   RESERVED  -> CANCELLED  Storno vor der Übergabe (siehe cancelRules)
// Alles andere ist kein normaler Weg: RESERVED -> RETURNED, ACTIVE -> RESERVED, CANCELLED -> irgendwas,
// RETURNED -> irgendwas. Ein administrativer Sonderprozess dafür existiert bewusst nicht.
//
// Storno nach Phase:
//   A) ohne Vertrag                      erlaubt
//   B) Vertragsentwurf                   erlaubt, Entwurf wird verworfen
//   C) finalisierter Vertrag, keine Übergabe  erlaubt; Vertrag und Dokumente bleiben erhalten (Status CANCELLED)
//   D) Übergabe-Entwurf                  erlaubt, der Entwurf wird verworfen
//   E) unterwegs                         nicht erlaubt (Fahrzeug ist übergeben)
//   F) Rückgabe-Entwurf                  nicht erlaubt
//   G) zurückgegeben                     nicht erlaubt
// Nach einem Storno wird für dieselbe Buchung kein neuer Vertrag angelegt (ensureContractDraft verlangt RESERVED).

import { db } from "@/lib/db";
import type { Actor } from "@/lib/audit";
import type { BookingStage, BookingStatus } from "@/lib/constants";
import { cancelBooking } from "@/lib/cancellation";
import { DomainError } from "@/lib/integrity";
import { assertAccidentCaseOpen } from "@/lib/accident-replacement-events";

export const ALLOWED_TRANSITIONS: Record<BookingStatus, { to: BookingStatus; via: "HANDOVER" | "BUTTON" }[]> = {
  RESERVED: [{ to: "ACTIVE", via: "HANDOVER" }, { to: "CANCELLED", via: "BUTTON" }],
  ACTIVE: [{ to: "RETURNED", via: "HANDOVER" }],
  RETURNED: [],
  CANCELLED: [],
};

export function canTransition(from: string, to: BookingStatus, via: "HANDOVER" | "BUTTON") {
  return (ALLOWED_TRANSITIONS[from as BookingStatus] ?? []).some((t) => t.to === to && t.via === via);
}

/** Stand im Ablauf, abgeleitet aus Buchungsstatus und Vertrag. */
export function bookingStage(booking: { status: string }, contract: { status: string } | null | undefined): BookingStage {
  if (booking.status === "CANCELLED") return "CANCELLED";
  if (booking.status === "RETURNED") return "RETURNED";
  if (booking.status === "ACTIVE") return "ACTIVE";
  if (contract?.status === "SIGNED") return "READY_FOR_PICKUP";
  if (contract?.status === "DRAFT") return "CONTRACT_DRAFT";
  return "NEEDS_CONTRACT";
}

export type HandoverRef = { type: string; status: string };
export type ProcessAction = { kind: "START" | "CONTINUE" | "VIEW" | "NONE"; label: string };

/**
 * Befehl 21: Übergabe als nächster Schritt einer Buchung. Reine Ableitung aus Buchung, Vertrag und vorhandenen Protokollen –
 * dieselbe Regel für Buchungsseite und Vertragsabschluss. Ein bestehender Entwurf wird fortgesetzt (nie ein zweiter angelegt),
 * nach abgeschlossener Übergabe gibt es keine „Übergabe starten“-Aktion mehr.
 */
export function pickupAction(booking: { status: string }, contract: { status: string } | null | undefined, handovers: HandoverRef[]): ProcessAction {
  const pickups = handovers.filter((h) => h.type === "PICKUP");
  if (pickups.some((h) => h.status === "FINALIZED")) return { kind: "VIEW", label: "Übergabeprotokoll anzeigen" };
  if (booking.status !== "RESERVED" || contract?.status !== "SIGNED") return { kind: "NONE", label: "" };
  return pickups.some((h) => h.status === "DRAFT") ? { kind: "CONTINUE", label: "Übergabe fortsetzen" } : { kind: "START", label: "Übergabe starten" };
}

/** Befehl 21: Rückgabe einer laufenden Miete – nur mit Vertrag und abgeschlossener Übergabe, begonnene Rückgabe wird fortgesetzt. */
export function returnAction(booking: { status: string }, contract: { status: string } | null | undefined, handovers: HandoverRef[]): ProcessAction {
  if (handovers.some((h) => h.type === "RETURN" && h.status === "FINALIZED")) return { kind: "VIEW", label: "Rückgabeprotokoll anzeigen" };
  if (booking.status !== "ACTIVE" || contract?.status !== "SIGNED") return { kind: "NONE", label: "" };
  if (!handovers.some((h) => h.type === "PICKUP" && h.status === "FINALIZED")) return { kind: "NONE", label: "" };
  return handovers.some((h) => h.type === "RETURN" && h.status === "DRAFT") ? { kind: "CONTINUE", label: "Rückgabe fortsetzen" } : { kind: "START", label: "Rückgabe starten" };
}

/** Darf diese Buchung per Knopf storniert werden? Dieselbe Regel für Oberfläche und Server. */
export function canCancel(booking: { status: string }) {
  return canTransition(booking.status, "CANCELLED", "BUTTON");
}

// Befehl 28: Storno-Abschluss (Vertrag, Entwürfe, Geld, Kaution, Abrechnung) zentral in lib/cancellation.ts
export { CANCELLATION_REASON_MAX, cancellationCheck } from "@/lib/cancellation";

/**
 * Statuswechsel per Knopf. Gibt die Speicherschlüssel verworfener Entwurfsfotos zurück (Aufräumen durch den Aufrufer).
 * Die Zeile wird gesperrt, damit ein gleichzeitiger Übergabeabschluss und ein Storno nacheinander laufen.
 * Befehl 27: CANCELLED nur mit Grund und Benutzer (opts), Prüfung „Geld hängt an der Buchung“ unter der Sperre, Audit.
 */
export async function changeBookingStatus(tenantId: string, bookingId: string, target: "ACTIVE" | "RETURNED" | "CANCELLED", opts: { actor?: Actor; reason?: string } = {}): Promise<{ orphanedStorageKeys: string[] }> {
  const pre = await changeBookingStatusIn(tenantId, bookingId, target, opts);
  if (pre) return pre;
  // Befehl 28: Storno ohne Geldentscheidungen über den zentralen Abschluss; hängt Geld an der Buchung, verlangt er eine Entscheidung (Storno-Assistent)
  const res = await cancelBooking(tenantId, opts.actor!, bookingId, { reason: opts.reason ?? "" });
  return { orphanedStorageKeys: res.orphanedStorageKeys };
}

async function changeBookingStatusIn(tenantId: string, bookingId: string, target: "ACTIVE" | "RETURNED" | "CANCELLED", opts: { actor?: Actor; reason?: string }): Promise<{ orphanedStorageKeys: string[] } | null> {
  return db.$transaction(async (tx) => {
    // Befehl 29 Phase E: geschlossener Unfallersatzfall – kein Statuswechsel (vor der Buchungssperre: Fall → Buchung)
    await assertAccidentCaseOpen(tx, tenantId, bookingId);
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const booking = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId } });

    if (target === "ACTIVE") {
      throw new DomainError("Ein Fahrzeug geht nur über Mietvertrag und Übergabeprotokoll auf „Unterwegs“. Bitte zuerst den Mietvertrag abschließen und dann die Übergabe starten.");
    }
    if (target === "CANCELLED") {
      if (!canCancel(booking)) {
        throw new DomainError(
          booking.status === "ACTIVE" ? "Das Fahrzeug ist bereits übergeben. Eine laufende Miete wird über die Rückgabe beendet, nicht storniert." : booking.status === "RETURNED" ? "Diese Miete ist abgeschlossen und kann nicht mehr storniert werden." : "Diese Buchung ist bereits storniert.",
        );
      }
      if (!opts.actor) throw new DomainError("Ein Storno braucht einen angemeldeten Benutzer.");
      return null;
    }
    // RETURNED per Knopf: nur Altfälle ohne Übergabeprotokoll
    if (!canTransition(booking.status, "RETURNED", "HANDOVER")) throw new DomainError("Nur laufende Mieten können zurückgenommen werden.");
    const pickup = await tx.handover.count({ where: { tenantId, bookingId: booking.id, type: "PICKUP", status: "FINALIZED" } });
    if (pickup > 0) throw new DomainError("Zu dieser Miete gibt es ein Übergabeprotokoll. Die Rücknahme läuft deshalb über das Rückgabeprotokoll.");
    await tx.booking.update({ where: { id: booking.id }, data: { status: "RETURNED", actualReturnAt: new Date() } });
    return { orphanedStorageKeys: [] };
  });
}
