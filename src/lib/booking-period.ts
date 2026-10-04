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
import { toCents, type Cents } from "@/lib/money";
import { calculateRentalPrice, rateCardFrom, rentalDays } from "@/lib/pricing";

const TX = { timeout: 20_000, maxWait: 10_000 };

export type PeriodChangePreview = {
  before: { startAt: Date; endAt: Date; days: number; priceCents: Cents };
  after: { startAt: Date; endAt: Date; days: number; priceCents: Cents } | null;
  paidCents: Cents;
  error: string | null;
};

type BookingForPeriod = { id: string; status: string; startAt: Date; endAt: Date; vehicleId: string; dailyRate: unknown; workWeekRate: unknown; weeklyRate: unknown; monthlyRate: unknown; customer: { discountPercent: number } };

const priceOf = (b: BookingForPeriod, startAt: Date, endAt: Date): Cents => toCents(calculateRentalPrice({ start: startAt, end: endAt, rates: rateCardFrom(b), discountPercent: b.customer.discountPercent }).total.toFixed(2));

function rule(b: { status: string }, contract: { status: string; number: string | null } | null): string | null {
  if (b.status !== "RESERVED") return b.status === "ACTIVE" ? "Das Fahrzeug ist übergeben. Änderungen der Mietdauer laufen jetzt über einen Nachtrag." : "Diese Buchung ist abgeschlossen oder storniert.";
  if (contract?.status === "SIGNED") return `Zu dieser Buchung gibt es den unterschriebenen Mietvertrag ${contract.number}. Zeitraumänderungen laufen über einen Nachtrag zum Mietvertrag.`;
  return null;
}

export async function previewBookingPeriodChange(tenantId: string, bookingId: string, startAt: Date | null, endAt: Date | null): Promise<PeriodChangePreview> {
  const b = await db.booking.findFirst({ where: { id: bookingId, tenantId }, include: { customer: { select: { discountPercent: true } }, contract: { select: { status: true, number: true } } } });
  if (!b) throw new DomainError("Buchung nicht gefunden.");
  const paid = await db.payment.aggregate({ where: { tenantId, bookingId, type: "RENTAL_PAYMENT", invoiceId: null, status: "CONFIRMED" }, _sum: { amountCents: true } });
  const before = { startAt: b.startAt, endAt: b.endAt, days: rentalDays(b.startAt, b.endAt), priceCents: priceOf(b, b.startAt, b.endAt) };
  let error = rule(b, b.contract);
  let after: PeriodChangePreview["after"] = null;
  if (!error) {
    if (!startAt || !endAt || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) error = "Bitte Abholung und Rückgabe mit Datum und Uhrzeit angeben.";
    else if (!(endAt > startAt)) error = "Die Rückgabe muss nach der Abholung liegen.";
    else if (startAt.getTime() === b.startAt.getTime() && endAt.getTime() === b.endAt.getTime()) error = "Der Zeitraum ist unverändert.";
    else {
      after = { startAt, endAt, days: rentalDays(startAt, endAt), priceCents: priceOf(b, startAt, endAt) };
      const conflicts = await findConflicts(db, tenantId, b.vehicleId, startAt, endAt, b.id);
      if (conflicts.length > 0) error = `Das Fahrzeug ist ab ${fmtDateTime(conflicts[0].startAt)} bereits für Buchung ${conflicts[0].number} vorgesehen.`;
    }
  }
  return { before, after, paidCents: paid._sum.amountCents ?? 0, error };
}

export async function changeBookingPeriod(tenantId: string, actor: Actor, bookingId: string, input: { startAt: Date; endAt: Date; reason: string }): Promise<{ startAt: Date; endAt: Date }> {
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
    if (input.startAt.getTime() === b.startAt.getTime() && input.endAt.getTime() === b.endAt.getTime()) throw new DomainError("Der Zeitraum ist unverändert.");
    const { conflicts } = await assertVehicleBookable(tx, tenantId, b.vehicleId, input.startAt, input.endAt, b.id);
    if (conflicts.length > 0) throw new DomainError(`Das Fahrzeug ist ab ${fmtDateTime(conflicts[0].startAt)} bereits für Buchung ${conflicts[0].number} vorgesehen.`);
    const priceBefore = priceOf(b, b.startAt, b.endAt);
    const priceAfter = priceOf(b, input.startAt, input.endAt);
    await tx.booking.update({ where: { id: b.id }, data: { startAt: input.startAt, endAt: input.endAt } });
    // ein Vertragsentwurf übernimmt den neuen Zeitraum (wie beim Öffnen des Vertrags); ein unterschriebener Vertrag ist ausgeschlossen
    if (b.contract?.status === "DRAFT") await refreshContractDraft(tx, tenantId, b.contract.id);
    await recordAudit(tx, tenantId, actor, { action: "BOOKING_PERIOD_CHANGED", bookingId: b.id, amountCents: priceAfter, details: { bookingNumber: b.number, startBefore: b.startAt.toISOString(), endBefore: b.endAt.toISOString(), startAfter: input.startAt.toISOString(), endAfter: input.endAt.toISOString(), priceBeforeCents: priceBefore, priceAfterCents: priceAfter, reason, contractDraft: b.contract?.status === "DRAFT" } });
    return { startAt: input.startAt, endAt: input.endAt };
  }, TX);
}
