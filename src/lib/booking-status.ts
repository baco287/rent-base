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

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { BOOKING_STATUS, type BookingStage, type BookingStatus } from "@/lib/constants";
import { balanceOf } from "@/lib/deposit-balance";
import { DomainError } from "@/lib/integrity";
import { fmtCents, type Cents } from "@/lib/money";

type Tx = Prisma.TransactionClient;

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

async function cancelContractOf(tx: Tx, tenantId: string, bookingId: string) {
  const contract = await tx.rentalContract.findFirst({ where: { tenantId, bookingId } });
  if (!contract) return;
  if (contract.status === "DRAFT") {
    await tx.signature.deleteMany({ where: { tenantId, contractId: contract.id } });
    await tx.contractDriver.deleteMany({ where: { tenantId, contractId: contract.id } });
    await tx.rentalContract.delete({ where: { id: contract.id } });
  } else if (contract.status === "SIGNED") {
    // Inhalt, Unterschriften und Dokumente bleiben als Historie erhalten; nur der Status wechselt
    await tx.rentalContract.update({ where: { id: contract.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  }
}

/** Übergabe-Entwürfe verwerfen. Finalisierte Protokolle gibt es bei RESERVED nicht (sonst wäre die Buchung ACTIVE). */
async function discardHandoverDrafts(tx: Tx, tenantId: string, bookingId: string): Promise<string[]> {
  const drafts = await tx.handover.findMany({ where: { tenantId, bookingId, status: "DRAFT" }, select: { id: true } });
  const keys: string[] = [];
  for (const d of drafts) {
    const photos = await tx.photo.findMany({ where: { tenantId, handoverId: d.id }, select: { id: true, storageKey: true } });
    keys.push(...photos.map((p) => p.storageKey));
    await tx.photo.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.signature.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.extraCharge.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.handoverChecklistItem.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.handoverDamage.deleteMany({ where: { tenantId, handoverId: d.id } });
    await tx.handover.delete({ where: { id: d.id } });
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Befehl 27: Storno nur mit Grund, Benutzer und Audit; nie still, wenn dadurch Geld ohne Abrechnungsweg zurückbliebe.
// Das vollständige Storno-Finanzmodell (Stornogebühr, Erstattung einer Vorauszahlung) folgt in Befehl 28.
// ---------------------------------------------------------------------------

export const CANCELLATION_REASON_MAX = 500;

export type CancellationCheck = {
  booking: { id: string; number: string; status: string; startAt: Date; endAt: Date; customerName: string; vehicle: string; plate: string };
  allowed: boolean;
  /** Gründe, aus denen der Server das Storno ablehnt */
  blockers: string[];
  /** Hinweise, die im Dialog deutlich angezeigt werden, das Storno aber nicht verhindern */
  warnings: string[];
};

/**
 * Was hängt an der Buchung? Dieselbe Prüfung für Dialog und Server (dort unter der Buchungssperre).
 * - Bestätigte Mietzahlungen ohne Rechnung: nach einem Storno gäbe es weder Mietrechnung noch Auszahlungsquelle → gesperrt.
 * - Erhaltene Kaution: bestehender Weg nach Storno (Freigabe und Auszahlung sind bei stornierten Buchungen erlaubt) → Hinweis.
 * - Unterschriebener Vertrag, Vertrags- oder Übergabe-Entwurf, Rechnungen mit Buchungsbezug, offener Nachtrag → Hinweis.
 */
export async function cancellationCheck(tenantId: string, bookingId: string, client: Tx | typeof db = db): Promise<CancellationCheck> {
  const b = await client.booking.findFirst({
    where: { id: bookingId, tenantId },
    select: {
      id: true, number: true, status: true, startAt: true, endAt: true,
      customer: { select: { type: true, firstName: true, lastName: true, companyName: true } },
      vehicle: { select: { make: true, model: true, plate: true } },
      contract: { select: { number: true, status: true } },
      securityDeposit: { select: { expectedAmountCents: true, events: { select: { type: true, amountCents: true, status: true } } } },
    },
  });
  if (!b) throw new DomainError("Buchung nicht gefunden.");
  const [rentalPaid, handoverDrafts, invoices, amendmentDraft] = await Promise.all([
    client.payment.aggregate({ where: { tenantId, bookingId, type: "RENTAL_PAYMENT", invoiceId: null, status: "CONFIRMED" }, _sum: { amountCents: true }, _count: true }),
    client.handover.count({ where: { tenantId, bookingId, status: "DRAFT" } }),
    client.invoice.findMany({ where: { tenantId, bookingId, status: { in: ["DRAFT", "FINALIZED"] } }, select: { number: true, status: true } }),
    client.contractAmendment.count({ where: { tenantId, bookingId, status: "DRAFT" } }),
  ]);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (b.status === "CANCELLED") blockers.push("Diese Buchung ist bereits storniert.");
  else if (b.status === "ACTIVE") blockers.push("Das Fahrzeug ist bereits übergeben. Eine laufende Miete wird über die Rückgabe beendet, nicht storniert.");
  else if (b.status === "RETURNED") blockers.push("Diese Miete ist abgeschlossen und kann nicht mehr storniert werden.");
  const paid: Cents = rentalPaid._sum.amountCents ?? 0;
  if (paid > 0) {
    blockers.push(`An dieser Buchung hängen bestätigte Mietzahlungen über ${fmtCents(paid)}. Nach einem Storno gäbe es dafür weder eine Mietrechnung noch einen Erstattungsweg. Erstattung und Stornogebühr kommen mit der nächsten Ausbaustufe; bis dahin ist das Storno gesperrt. War die Zahlung ein Erfassungsfehler, bitte zuerst die Zahlung stornieren.`);
  }
  if (b.contract?.status === "SIGNED") warnings.push(`Für diese Buchung wurde bereits ein Mietvertrag erstellt (${b.contract.number}). Er wird mit storniert und bleibt als Historie erhalten.`);
  else if (b.contract?.status === "DRAFT") warnings.push("Der Mietvertragsentwurf wird verworfen.");
  if (handoverDrafts > 0) warnings.push("Ein begonnener Übergabe-Entwurf wird verworfen.");
  if (amendmentDraft > 0) warnings.push("Ein offener Nachtrag-Entwurf bleibt ohne Wirkung; er kann nicht mehr unterschrieben werden.");
  if (b.securityDeposit) {
    const bal = balanceOf(b.securityDeposit.expectedAmountCents, b.securityDeposit.events);
    if (bal.remainingCents > 0) warnings.push(`Es ist Kaution über ${fmtCents(bal.remainingCents)} erhalten und noch nicht freigegeben. Nach dem Storno bitte im Bereich „Kaution“ freigeben und auszahlen.`);
  }
  if (invoices.length > 0) warnings.push(`Zu dieser Buchung gibt es Rechnungen (${invoices.map((i) => i.number ?? "Entwurf").join(", ")}). Sie bleiben unverändert bestehen.`);
  const customerName = b.customer.type === "COMPANY" && b.customer.companyName ? b.customer.companyName : `${b.customer.firstName} ${b.customer.lastName}`.trim();
  return {
    booking: { id: b.id, number: b.number, status: b.status, startAt: b.startAt, endAt: b.endAt, customerName, vehicle: `${b.vehicle.make} ${b.vehicle.model}`.trim(), plate: b.vehicle.plate },
    allowed: blockers.length === 0,
    blockers,
    warnings,
  };
}

/**
 * Statuswechsel per Knopf. Gibt die Speicherschlüssel verworfener Entwurfsfotos zurück (Aufräumen durch den Aufrufer).
 * Die Zeile wird gesperrt, damit ein gleichzeitiger Übergabeabschluss und ein Storno nacheinander laufen.
 * Befehl 27: CANCELLED nur mit Grund und Benutzer (opts), Prüfung „Geld hängt an der Buchung“ unter der Sperre, Audit.
 */
export async function changeBookingStatus(tenantId: string, bookingId: string, target: "ACTIVE" | "RETURNED" | "CANCELLED", opts: { actor?: Actor; reason?: string } = {}): Promise<{ orphanedStorageKeys: string[] }> {
  return db.$transaction(async (tx) => {
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
      const reason = (opts.reason ?? "").replace(/\s+/g, " ").trim();
      if (!opts.actor) throw new DomainError("Ein Storno braucht einen angemeldeten Benutzer.");
      if (reason.length < 3) throw new DomainError("Bitte den Grund der Stornierung angeben.");
      if (reason.length > CANCELLATION_REASON_MAX) throw new DomainError(`Der Grund ist zu lang (höchstens ${CANCELLATION_REASON_MAX} Zeichen).`);
      // unter der Buchungssperre: gleichzeitig erfasste Mietzahlungen sperren dieselbe Zeile und laufen davor oder danach
      const check = await cancellationCheck(tenantId, booking.id, tx);
      if (!check.allowed) throw new DomainError(check.blockers[0]);
      const contractNumber = (await tx.rentalContract.findFirst({ where: { tenantId, bookingId: booking.id }, select: { number: true, status: true } }));
      await cancelContractOf(tx, tenantId, booking.id);
      const orphanedStorageKeys = await discardHandoverDrafts(tx, tenantId, booking.id);
      const now = new Date();
      await tx.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED", cancelledAt: now, cancellationReason: reason, cancelledById: opts.actor.id, cancelledByName: opts.actor.name } });
      await recordAudit(tx, tenantId, opts.actor, { action: "BOOKING_CANCELLED", bookingId: booking.id, details: { bookingNumber: booking.number, reason, previousStatus: BOOKING_STATUS[booking.status as BookingStatus] ?? booking.status, contract: contractNumber ? `${contractNumber.number} (${contractNumber.status})` : null, warnings: check.warnings.length } });
      return { orphanedStorageKeys };
    }
    // RETURNED per Knopf: nur Altfälle ohne Übergabeprotokoll
    if (!canTransition(booking.status, "RETURNED", "HANDOVER")) throw new DomainError("Nur laufende Mieten können zurückgenommen werden.");
    const pickup = await tx.handover.count({ where: { tenantId, bookingId: booking.id, type: "PICKUP", status: "FINALIZED" } });
    if (pickup > 0) throw new DomainError("Zu dieser Miete gibt es ein Übergabeprotokoll. Die Rücknahme läuft deshalb über das Rückgabeprotokoll.");
    await tx.booking.update({ where: { id: booking.id }, data: { status: "RETURNED", actualReturnAt: new Date() } });
    return { orphanedStorageKeys: [] };
  });
}
