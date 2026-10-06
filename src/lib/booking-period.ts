// Befehl 28: Zeitraum einer Buchung VOR der Vertragsunterschrift kontrolliert ändern („Ich komme erst um 15:00“).
// Kein freies Stammdaten-Bearbeiten: alt/neu mit Preisvorschlag, Pflichtgrund, Verfügbarkeit unter Fahrzeugsperre
// (assertVehicleBookable), Audit BOOKING_PERIOD_CHANGED. Zahlungen und Kaution bleiben an derselben Buchung und werden nie
// verändert – nur der erwartete Mietpreis (abgeleitet) folgt dem neuen Zeitraum. Nach der Unterschrift: nur per Nachtrag.

import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { assertVehicleBookable, findConflicts } from "@/lib/bookings";
import { refreshContractDraft } from "@/lib/contracts";
import { fmtDateTime } from "@/lib/format";
import { DomainError } from "@/lib/integrity";
import { fmtCents, type Cents } from "@/lib/money";
import { rentalDays } from "@/lib/pricing";
import { bookingQuote } from "@/lib/booking-price";
import { basisFromSnapshot, buildBookingTariff, choicesOf, readTariffSnapshot, type TariffChoices } from "@/lib/tariffs";

const TX = { timeout: 20_000, maxWait: 10_000 };

export type PeriodChangePreview = {
  /** endAt null = offenes Mietende (Unfallersatz; Änderung dort nur in der Fallakte) */
  before: { startAt: Date; endAt: Date | null; days: number; priceCents: Cents };
  /** priceCents = neuer regulärer Preis (Tarif aus dem Buchungs-Snapshot bzw. Altfelder) */
  after: { startAt: Date; endAt: Date; days: number; priceCents: Cents } | null;
  paidCents: Cents;
  /** Befehl 29: individuell vereinbarter Preis der Buchung – dann ist eine bewusste Preisentscheidung Pflicht */
  agreed: { cents: Cents; reason: string } | null;
  /** Name des Miettarifs (null = Buchung ohne Tarif) */
  tariffName: string | null;
  error: string | null;
};

/** Befehl 29: Preisentscheidung bei einer Zeitraumänderung mit individuell vereinbartem Preis (nie still überschreiben). */
export type PeriodPriceDecision = { mode: "KEEP" } | { mode: "TARIFF" } | { mode: "INDIVIDUAL"; cents: number; reason: string };

type BookingForPeriod = { id: string; status: string; rentalType: string; startAt: Date; endAt: Date | null; vehicleId: string; dailyRate: unknown; workWeekRate: unknown; weeklyRate: unknown; monthlyRate: unknown; tariffSnapshot: unknown; agreedPriceCents: number | null; customer: { discountPercent: number } };

// Befehl 29: zentrale Buchungspreisfunktion – Tarifbuchungen aus ihrem eingefrorenen Snapshot, sonst Altfelder
const quoteOf = (b: BookingForPeriod, startAt: Date, endAt: Date) => bookingQuote(b, startAt, endAt, b.customer.discountPercent);
/** regulärer Preis für einen Zeitraum */
const priceOf = (b: BookingForPeriod, startAt: Date, endAt: Date): Cents => quoteOf(b, startAt, endAt).regularCents;

function rule(b: { status: string; rentalType: string }, contract: { status: string; number: string | null } | null): string | null {
  // Befehl 29: Unfallersatz – Mietbeginn und geplantes Ende werden in der Fallakte geändert (eigene Konfliktprüfung und Audit)
  if (b.rentalType === "ACCIDENT_REPLACEMENT") return "Bei einer Unfallersatzmiete wird das geplante Mietende in der Fallakte geändert.";
  if (b.status !== "RESERVED") return b.status === "ACTIVE" ? "Das Fahrzeug ist übergeben. Änderungen der Mietdauer laufen jetzt über einen Nachtrag." : "Diese Buchung ist abgeschlossen oder storniert.";
  if (contract?.status === "SIGNED") return `Zu dieser Buchung gibt es den unterschriebenen Mietvertrag ${contract.number}. Zeitraumänderungen laufen über einen Nachtrag zum Mietvertrag.`;
  return null;
}

export async function previewBookingPeriodChange(tenantId: string, bookingId: string, startAt: Date | null, endAt: Date | null): Promise<PeriodChangePreview> {
  const b = await db.booking.findFirst({ where: { id: bookingId, tenantId }, include: { customer: { select: { discountPercent: true } }, contract: { select: { status: true, number: true } } } });
  if (!b) throw new DomainError("Buchung nicht gefunden.");
  const paid = await db.payment.aggregate({ where: { tenantId, bookingId, type: "RENTAL_PAYMENT", invoiceId: null, status: "CONFIRMED" }, _sum: { amountCents: true } });
  const before = { startAt: b.startAt, endAt: b.endAt, days: b.endAt ? rentalDays(b.startAt, b.endAt) : 0, priceCents: b.endAt ? quoteOf(b, b.startAt, b.endAt).totalCents : 0 };
  const tariff = readTariffSnapshot(b.tariffSnapshot);
  const agreed = b.agreedPriceCents != null && b.priceOverrideReason ? { cents: b.agreedPriceCents, reason: b.priceOverrideReason } : null;
  let error = rule(b, b.contract);
  let after: PeriodChangePreview["after"] = null;
  if (!error) {
    if (!startAt || !endAt || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) error = "Bitte Abholung und Rückgabe mit Datum und Uhrzeit angeben.";
    else if (!(endAt > startAt)) error = "Die Rückgabe muss nach der Abholung liegen.";
    else if (startAt.getTime() === b.startAt.getTime() && endAt.getTime() === b.endAt?.getTime()) error = "Der Zeitraum ist unverändert.";
    else {
      after = { startAt, endAt, days: rentalDays(startAt, endAt), priceCents: priceOf(b, startAt, endAt) };
      const conflicts = await findConflicts(db, tenantId, b.vehicleId, startAt, endAt, b.id);
      if (conflicts.length > 0) error = `Das Fahrzeug ist ab ${fmtDateTime(conflicts[0].startAt)} bereits für Buchung ${conflicts[0].number} vorgesehen.`;
    }
  }
  return { before, after, paidCents: paid._sum.amountCents ?? 0, agreed, tariffName: tariff?.ratePlanName ?? null, error };
}

export async function changeBookingPeriod(tenantId: string, actor: Actor, bookingId: string, input: { startAt: Date; endAt: Date; reason: string; priceDecision?: PeriodPriceDecision | null }): Promise<{ startAt: Date; endAt: Date }> {
  const reason = (input.reason ?? "").replace(/\s+/g, " ").trim();
  if (reason.length < 3) throw new DomainError("Bitte den Grund der Zeitraumänderung angeben.");
  if (reason.length > 500) throw new DomainError("Der Grund ist zu lang (höchstens 500 Zeichen).");
  if (!(input.startAt instanceof Date) || !(input.endAt instanceof Date) || Number.isNaN(input.startAt.getTime()) || Number.isNaN(input.endAt.getTime())) throw new DomainError("Bitte Abholung und Rückgabe mit Datum und Uhrzeit angeben.");
  if (!(input.endAt > input.startAt)) throw new DomainError("Die Rückgabe muss nach der Abholung liegen.");
  return db.$transaction(async (tx) => {
    // Sperrfolge: Buchung → Fahrzeug (assertVehicleBookable); parallele Buchungen desselben Fahrzeugs laufen nacheinander
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const b = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { customer: { select: { discountPercent: true } }, contract: { select: { id: true, status: true, number: true } } } });
    const problem = rule(b, b.contract);
    if (problem) throw new DomainError(problem);
    // nach rule(): keine Unfallersatzmiete, also immer ein gesetztes Ende (DB-CHECK rb_booking_open_end)
    const endBefore = b.endAt;
    if (!endBefore) throw new DomainError("Diese Buchung hat kein Mietende.");
    if (input.startAt.getTime() === b.startAt.getTime() && input.endAt.getTime() === endBefore.getTime()) throw new DomainError("Der Zeitraum ist unverändert.");
    const { conflicts } = await assertVehicleBookable(tx, tenantId, b.vehicleId, input.startAt, input.endAt, b.id);
    if (conflicts.length > 0) throw new DomainError(`Das Fahrzeug ist ab ${fmtDateTime(conflicts[0].startAt)} bereits für Buchung ${conflicts[0].number} vorgesehen.`);
    const priceBefore = quoteOf(b, b.startAt, endBefore).totalCents;
    let priceAfter = priceOf(b, input.startAt, input.endAt);
    // Befehl 29: Tarifbuchung – regulären Preis aus dem eingefrorenen Snapshot neu rechnen; ein individuell vereinbarter Preis
    // wird nie still überschrieben: behalten, Tarifpreis übernehmen oder neu festlegen (Pflichtentscheidung, Audit)
    const snap = readTariffSnapshot(b.tariffSnapshot);
    let tariffData = {};
    let decision: string | null = null;
    if (snap) {
      const d = input.priceDecision ?? null;
      if (snap.agreed.price && !d) throw new DomainError(`Für diese Buchung wurde ein individueller Preis vereinbart (${fmtCents(snap.agreed.price.cents)}). Bitte entscheiden: individuellen Preis beibehalten, neuen Tarifpreis übernehmen oder neuen Preis festlegen.`);
      const prev = choicesOf(snap);
      // ein ausdrücklich neuer Preis gilt immer; sonst Tarifpreis bzw. (Entscheidung „beibehalten“) der bisherige individuelle Preis
      const price: TariffChoices["price"] = d?.mode === "INDIVIDUAL" ? { mode: "INDIVIDUAL", cents: d.cents, reason: d.reason } : !snap.agreed.price || d?.mode === "TARIFF" ? { mode: "TARIFF" } : { mode: "INDIVIDUAL", cents: snap.agreed.price.cents, reason: snap.agreed.price.reason };
      decision = d?.mode === "INDIVIDUAL" ? "INDIVIDUAL" : !snap.agreed.price ? null : d?.mode ?? null;
      const built = buildBookingTariff({
        basis: basisFromSnapshot(snap),
        start: input.startAt,
        end: input.endAt,
        discountPercent: b.customer.discountPercent,
        choices: {
          price,
          km: prev.km,
          deposit: prev.deposit,
        },
        previous: snap,
        actor,
      });
      // Zeitraumänderung ändert Tarif, Kilometer und Kaution nicht – nur Preisstand und ggf. die Preisentscheidung
      tariffData = { tariffSnapshot: built.data.tariffSnapshot, regularPriceCents: built.data.regularPriceCents, agreedPriceCents: built.data.agreedPriceCents, priceOverrideReason: built.data.priceOverrideReason, overrideInfo: built.data.overrideInfo };
      priceAfter = built.data.agreedPriceCents ?? built.data.regularPriceCents;
      for (const a of built.audits) if (a.action !== "BOOKING_TARIFF_CHANGED") await recordAudit(tx, tenantId, actor, { ...a, bookingId: b.id, details: { ...(a.details ?? {}), context: "Zeitraumänderung" } });
    }
    await tx.booking.update({ where: { id: b.id }, data: { startAt: input.startAt, endAt: input.endAt, ...tariffData } });
    // ein Vertragsentwurf übernimmt den neuen Zeitraum (wie beim Öffnen des Vertrags); ein unterschriebener Vertrag ist ausgeschlossen
    if (b.contract?.status === "DRAFT") await refreshContractDraft(tx, tenantId, b.contract.id);
    await recordAudit(tx, tenantId, actor, { action: "BOOKING_PERIOD_CHANGED", bookingId: b.id, amountCents: priceAfter, details: { bookingNumber: b.number, priceDecision: decision, startBefore: b.startAt.toISOString(), endBefore: endBefore.toISOString(), startAfter: input.startAt.toISOString(), endAfter: input.endAt.toISOString(), priceBeforeCents: priceBefore, priceAfterCents: priceAfter, reason, contractDraft: b.contract?.status === "DRAFT" } });
    return { startAt: input.startAt, endAt: input.endAt };
  }, TX);
}
