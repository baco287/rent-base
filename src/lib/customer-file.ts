// Kundenakte 360° (Phase 19): eine Person, alle Vorgänge – zusammengeführt aus den vorhandenen Modulen. Hier wird
// nichts neu berechnet, was ein Modul schon zentral rechnet: Rechnungsstand aus financialsFor (Phase 17/18),
// Kautionen aus balanceOf/computeDepositFinancials (Phase 15/18), Auszahlungen aus dem Payout-Modell,
// Behördenvorgänge nur über die bewusste Fahrerbestimmung (driverCustomerId). Historische Snapshots bleiben unberührt.
// Die Akte erfindet keine Ereignisse: Die Historie entsteht ausschließlich aus gespeicherten Zeitstempeln.

import { zonedDayStart } from "@/lib/time";
import { bookingLabel, invoiceHref } from "@/lib/invoice-links";
import { invoiceKindWord } from "@/lib/constants";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { financialsFor, type InvoiceFinancials } from "@/lib/counter-documents";
import { balanceOf, computeDepositFinancials, type DepositFinancials } from "@/lib/deposits";
import { customerName } from "@/lib/format";
import { toCents, type Cents } from "@/lib/money";
import { dunningLevelLabel } from "@/lib/constants";
import { SIGNED_AMENDMENTS_SELECT, effectiveTotalCents } from "@/lib/amendments";
import { prepaymentBalances } from "@/lib/rental-payments";

/**
 * Befehl 27: Ziel eines Zahlungslinks. Zahlung zu einer Rechnung → deren Seite (Buchungsrechnung oder freie Rechnung);
 * Mietzahlung vor der Rechnung → Bereich „Mietzahlung“ der Buchung. (Die frühere Adresse /buchungen/…/finanzen gibt es nicht.)
 */
export function paymentHref(p: { bookingId: string | null; invoice: { id: string; bookingId: string | null; kind: string } | null }): string | null {
  if (p.invoice) return invoiceHref(p.invoice);
  return p.bookingId ? `/buchungen/${p.bookingId}#mietzahlung` : null;
}

export type CustomerRow = Prisma.CustomerGetPayload<object>;

const custSel = { id: true, type: true, firstName: true, lastName: true, companyName: true } as const;
const vehSel = { id: true, plate: true, make: true, model: true } as const;

// ---------------------------------------------------------------------------
// Kopf und Übersicht
// ---------------------------------------------------------------------------

export type CustomerHeader = {
  customer: CustomerRow;
  name: string;
  /** letzte Aktivität = jüngster gespeicherter Zeitstempel über alle Vorgänge (berechnet, nicht gespeichert) */
  lastActivityAt: Date | null;
  lastActivityWhat: string | null;
  /** Phase 19.5: letzte bestätigte Original-Führerscheinprüfung dieser Person (historischer Stand, keine Aussage über heutige Gültigkeit). */
  licenseLastChecked: { verifiedAt: Date; validUntilThen: Date | null; expiredAtCheckTime: boolean } | null;
};

export type CustomerOverview = {
  bookingsTotal: number;
  activeRentals: number;
  lastRental: { id: string; number: string; endAt: Date; actualReturnAt: Date | null; vehicle: string; plate: string } | null;
  nextBooking: { id: string; number: string; startAt: Date; vehicle: string; plate: string } | null;
  /** offene Forderungen aus abgeschlossenen Rechnungen (financialsFor) */
  openReceivablesCents: Cents;
  openInvoices: number;
  /** Kundenguthaben, noch nicht ausgezahlt (financialsFor) */
  refundOpenCents: Cents;
  refundsOpen: number;
  /** Kautionen: freigegeben, noch nicht ausgezahlt (computeDepositFinancials) */
  depositPayoutOpenCents: Cents;
  depositPayoutsOpen: number;
  depositsHeld: number;
  openDamageCases: number;
  openAuthorityCases: number;
  driverOnlyContracts: number;
  tasks: OpenTask[];
};

export type OpenTask = { key: string; title: string; detail: string; href: string; tone: "bad" | "amber" | "info" | "grey" };

/** Kopfzeile: Stammdaten plus berechnete letzte Aktivität. */
export async function customerHeader(tenantId: string, customerId: string): Promise<CustomerHeader | null> {
  const customer = await db.customer.findFirst({ where: { id: customerId, tenantId } });
  if (!customer) return null;
  const [last, lastCheck] = await Promise.all([
    lastActivity(tenantId, customerId, customer),
    db.driverVerification.findFirst({ where: { tenantId, customerId, status: "CONFIRMED" }, orderBy: { verifiedAt: "desc" }, select: { verifiedAt: true, licenseValidUntilSnapshot: true } }),
  ]);
  const licenseLastChecked = lastCheck?.verifiedAt
    ? { verifiedAt: lastCheck.verifiedAt, validUntilThen: lastCheck.licenseValidUntilSnapshot, expiredAtCheckTime: !!lastCheck.licenseValidUntilSnapshot && lastCheck.licenseValidUntilSnapshot < lastCheck.verifiedAt }
    : null;
  return { customer, name: customerName(customer), lastActivityAt: last?.at ?? null, lastActivityWhat: last?.what ?? null, licenseLastChecked };
}

/** Jüngster Zeitstempel über die Vorgänge der Person – bewusst berechnet, keine neue Spalte. */
async function lastActivity(tenantId: string, customerId: string, customer: CustomerRow): Promise<{ at: Date; what: string } | null> {
  const c = { tenantId, customerId };
  const [booking, handover, payment, payout, mail, contract] = await Promise.all([
    db.booking.findFirst({ where: c, orderBy: { updatedAt: "desc" }, select: { updatedAt: true, number: true } }),
    db.handover.findFirst({ where: { tenantId, status: "FINALIZED", booking: { customerId } }, orderBy: { finalizedAt: "desc" }, select: { finalizedAt: true, type: true } }),
    db.payment.findFirst({ where: { tenantId, OR: [{ booking: { customerId } }, { bookingId: null, invoice: { customerId } }] }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.payout.findFirst({ where: c, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.emailLog.findFirst({ where: { tenantId, OR: [{ booking: { customerId } }, { payout: { customerId } }, { bookingId: null, invoiceVersion: { invoice: { customerId } } }, { bookingId: null, dunningNotice: { customerId } }] }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.rentalContract.findFirst({ where: { tenantId, customerId, status: "SIGNED" }, orderBy: { signedAt: "desc" }, select: { signedAt: true } }),
  ]);
  const candidates: { at: Date | null | undefined; what: string }[] = [
    { at: customer.updatedAt, what: "Stammdaten geändert" },
    { at: booking?.updatedAt, what: `Buchung ${booking?.number ?? ""}` },
    { at: handover?.finalizedAt, what: handover?.type === "RETURN" ? "Rückgabe" : "Übergabe" },
    { at: payment?.createdAt, what: "Zahlung" },
    { at: payout?.createdAt, what: "Auszahlung" },
    { at: mail?.createdAt, what: "E-Mail" },
    { at: contract?.signedAt, what: "Mietvertrag abgeschlossen" },
  ];
  let best: { at: Date; what: string } | null = null;
  for (const x of candidates) if (x.at && (!best || x.at > best.at)) best = { at: x.at, what: x.what };
  return best;
}

/** Übersichtskennzahlen und abgeleitete offene Punkte – keine Lebenszeit-Umsätze, nur handlungsrelevante Größen. */
export async function customerOverview(tenantId: string, customerId: string, customer: CustomerRow, now = new Date()): Promise<CustomerOverview> {
  const [bookingsTotal, activeRentals, lastRental, nextBooking, invoices, deposits, openDamageCases, authority, driverOnlyContracts, overdueActive] = await Promise.all([
    db.booking.count({ where: { tenantId, customerId } }),
    db.booking.count({ where: { tenantId, customerId, status: "ACTIVE" } }),
    db.booking.findFirst({ where: { tenantId, customerId, status: { in: ["ACTIVE", "RETURNED"] } }, orderBy: [{ actualPickupAt: "desc" }, { startAt: "desc" }], select: { id: true, number: true, endAt: true, actualReturnAt: true, vehicle: { select: vehSel } } }),
    db.booking.findFirst({ where: { tenantId, customerId, status: "RESERVED", startAt: { gte: now } }, orderBy: { startAt: "asc" }, select: { id: true, number: true, startAt: true, vehicle: { select: vehSel } } }),
    db.invoice.findMany({ where: { tenantId, status: "FINALIZED", documentType: "INVOICE", currentVersionId: { not: null }, OR: [{ booking: { customerId } }, { customerId, bookingId: null }] }, select: { id: true, number: true, kind: true, bookingId: true, currentVersion: { select: { grossTotal: true, paymentDueDate: true } } } }),
    db.securityDeposit.findMany({ where: { tenantId, booking: { customerId } }, select: { id: true, bookingId: true, expectedAmountCents: true, events: { select: { type: true, amountCents: true, status: true } }, booking: { select: { number: true, status: true } } } }),
    db.damageCase.count({ where: { tenantId, status: { not: "CLOSED" }, booking: { customerId } } }),
    db.authorityCase.findMany({ where: { tenantId, driverCustomerId: customerId }, select: { id: true, caseNumber: true, status: true, responseDeadline: true } }),
    db.contractDriver.count({ where: { tenantId, customerId, contract: { customerId: { not: customerId } } } }),
    db.booking.findMany({ where: { tenantId, customerId, status: "ACTIVE", endAt: { lt: now } }, select: { id: true, number: true, endAt: true } }),
  ]);
  const fin = await financialsFor(tenantId, invoices.map((i) => ({ id: i.id, grossTotal: i.currentVersion!.grossTotal })));
  const paidOut = deposits.length ? await db.payout.groupBy({ by: ["securityDepositId"], where: { tenantId, securityDepositId: { in: deposits.map((d) => d.id) }, status: "COMPLETED" }, _sum: { amountCents: true } }) : [];
  const paidMap = new Map(paidOut.map((g) => [g.securityDepositId, g._sum.amountCents ?? 0]));

  const tasks: OpenTask[] = [];
  let openReceivablesCents = 0, openInvoices = 0, refundOpenCents = 0, refundsOpen = 0;
  for (const i of invoices) {
    const f = fin.get(i.id)!;
    const word = invoiceKindWord(i.kind);
    if (f.openCents > 0) {
      openInvoices++; openReceivablesCents += f.openCents;
      const due = i.currentVersion!.paymentDueDate;
      // Befehl 23.1: dieselbe Tagesgrenze wie das Mahnwesen (überfällig ab dem Tag nach der Fälligkeit)
      const overdue = !!due && due < zonedDayStart(now);
      tasks.push({ key: `inv-${i.id}`, title: `${word} ${i.number} offen`, detail: `${fmt(f.openCents)}${due ? ` · fällig ${dateText(due)}` : ""}`, href: invoiceHref(i), tone: overdue ? "bad" : "amber" });
    }
    if (f.refundOpen) { refundsOpen++; refundOpenCents += f.refundRemainingCents; tasks.push({ key: `ref-${i.id}`, title: `Erstattung zu ${word} ${i.number} offen`, detail: `Kundenguthaben ${fmt(f.refundRemainingCents)} noch nicht ausgezahlt`, href: invoiceHref(i), tone: "amber" }); }
  }
  // Befehl 28: Mietvorauszahlung stornierter Buchungen ohne Rechnung = Kundenguthaben (zentral aus prepaymentBalances)
  for (const p of await cancelledPrepayments(tenantId, customerId)) {
    if (p.remainingCents <= 0) continue;
    refundsOpen++; refundOpenCents += p.remainingCents;
    tasks.push({ key: `pre-${p.bookingId}`, title: `Guthaben aus Storno der Buchung ${p.bookingNumber}`, detail: `Mietvorauszahlung ${fmt(p.remainingCents)} noch nicht erstattet`, href: `/buchungen/${p.bookingId}#storno`, tone: "amber" });
  }
  let depositPayoutOpenCents = 0, depositPayoutsOpen = 0, depositsHeld = 0;
  for (const d of deposits) {
    const f = computeDepositFinancials(balanceOf(d.expectedAmountCents, d.events), paidMap.get(d.id) ?? 0);
    if (f.payoutRemainingCents > 0) { depositPayoutsOpen++; depositPayoutOpenCents += f.payoutRemainingCents; tasks.push({ key: `depout-${d.id}`, title: `Kautionsauszahlung zu Buchung ${d.booking.number} offen`, detail: `freigegeben, noch nicht ausgezahlt ${fmt(f.payoutRemainingCents)}`, href: `/buchungen/${d.bookingId}#kaution`, tone: "amber" }); }
    if ((d.booking.status === "RETURNED" || d.booking.status === "CANCELLED") && f.remainingCents > 0) { depositsHeld++; tasks.push({ key: `dephold-${d.id}`, title: `Kaution zu Buchung ${d.booking.number} nach Rückgabe noch nicht entschieden`, detail: `${fmt(f.remainingCents)} weder freigegeben noch einbehalten`, href: `/buchungen/${d.bookingId}#kaution`, tone: "info" }); }
  }
  for (const b of overdueActive) tasks.push({ key: `overdue-${b.id}`, title: `Rückgabe zu Buchung ${b.number} überfällig`, detail: `sollte am ${dateText(b.endAt)} zurück sein`, href: `/buchungen/${b.id}`, tone: "bad" });
  const openAuthority = authority.filter((a) => !["SUBMITTED", "CLOSED", "CANCELLED"].includes(a.status));
  for (const a of openAuthority) tasks.push({ key: `auth-${a.id}`, title: `Behördenvorgang ${a.caseNumber} offen`, detail: a.responseDeadline ? `Antwortfrist ${dateText(a.responseDeadline)}` : "als Fahrer benannt", href: `/behoerden/${a.id}`, tone: a.responseDeadline && a.responseDeadline < now ? "bad" : "info" });
  if (openDamageCases > 0) tasks.push({ key: "damage", title: `${openDamageCases} offene Schadenakte${openDamageCases === 1 ? "" : "n"} zu Vermietungen dieser Person`, detail: "Haftung ist eine Entscheidung in der Akte – keine automatische Zuordnung", href: `/kunden/${customerId}?tab=schaeden`, tone: "grey" });
  if (customer.blocked) tasks.push({ key: "blocked", title: "Kunde gesperrt", detail: customer.blockReason ?? "ohne Grundangabe", href: `/kunden/${customerId}?tab=stammdaten`, tone: "bad" });
  if (!customer.licenseNumber) tasks.push({ key: "license", title: "Führerschein nicht erfasst", detail: "vor der nächsten Übergabe ergänzen", href: `/kunden/${customerId}?tab=stammdaten`, tone: "amber" });
  else if (customer.licenseValidUntil && customer.licenseValidUntil < now) tasks.push({ key: "license-exp", title: "Führerschein abgelaufen", detail: `gültig bis ${dateText(customer.licenseValidUntil)}`, href: `/kunden/${customerId}?tab=stammdaten`, tone: "bad" });
  if (customer.idValidUntil && customer.idValidUntil < now) tasks.push({ key: "id-exp", title: "Ausweis abgelaufen", detail: `gültig bis ${dateText(customer.idValidUntil)}`, href: `/kunden/${customerId}?tab=stammdaten`, tone: "amber" });

  return {
    bookingsTotal, activeRentals,
    lastRental: lastRental ? { id: lastRental.id, number: lastRental.number, endAt: lastRental.endAt, actualReturnAt: lastRental.actualReturnAt, vehicle: `${lastRental.vehicle.make} ${lastRental.vehicle.model}`, plate: lastRental.vehicle.plate } : null,
    nextBooking: nextBooking ? { id: nextBooking.id, number: nextBooking.number, startAt: nextBooking.startAt, vehicle: `${nextBooking.vehicle.make} ${nextBooking.vehicle.model}`, plate: nextBooking.vehicle.plate } : null,
    openReceivablesCents, openInvoices, refundOpenCents, refundsOpen, depositPayoutOpenCents, depositPayoutsOpen, depositsHeld,
    openDamageCases, openAuthorityCases: openAuthority.length, driverOnlyContracts, tasks,
  };
}

// ---------------------------------------------------------------------------
// Buchungen & Fahrerrollen
// ---------------------------------------------------------------------------

export const BOOKINGS_PAGE = 25;

/** Buchungen als Mieter, neueste zuerst, serverseitig geblättert. */
export async function customerBookings(tenantId: string, customerId: string, page = 1, pageSize = BOOKINGS_PAGE) {
  const where = { tenantId, customerId };
  const skip = (Math.max(1, page) - 1) * pageSize;
  const [total, rows] = await Promise.all([
    db.booking.count({ where }),
    db.booking.findMany({ where, orderBy: { startAt: "desc" }, skip, take: pageSize, select: { id: true, number: true, status: true, startAt: true, endAt: true, actualPickupAt: true, actualReturnAt: true, vehicle: { select: vehSel }, contract: { select: { number: true, status: true, totalAmount: true, amendments: SIGNED_AMENDMENTS_SELECT } }, invoices: { where: { kind: "RENTAL", documentType: "INVOICE", status: "FINALIZED" }, select: { id: true, number: true, currentVersion: { select: { grossTotal: true } } }, take: 1 } } }),
  ]);
  // Befehl 27: Vertragsbetrag laut wirksamem Vertragsstand (Vertrag + unterschriebene Nachträge), zentral abgeleitet
  return { rows: rows.map((r) => ({ ...r, contractTotalCents: r.contract?.status === "SIGNED" ? effectiveTotalCents(r.contract.totalAmount, r.contract.amendments) : null })), total, page: Math.max(1, page), pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Verträge, in denen die Person als Fahrer oder Zusatzfahrer steht, ohne selbst Mieter zu sein (ContractDriver-Snapshots). */
export function customerDriverRoles(tenantId: string, customerId: string) {
  return db.contractDriver.findMany({ where: { tenantId, customerId, contract: { customerId: { not: customerId } } }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, role: true, createdAt: true, contract: { select: { id: true, number: true, status: true, startAt: true, endAt: true, bookingId: true, customer: { select: custSel }, booking: { select: { number: true, status: true, vehicle: { select: vehSel } } } } } } });
}

// ---------------------------------------------------------------------------
// Finanzen
// ---------------------------------------------------------------------------

export type CustomerFinance = {
  /** eine Zeile je abgeschlossenem Beleg (Rechnung, Gutschrift, Stornobeleg); Gegenbelege tragen ihr Original */
  documents: { dunning: { level: number; label: string; number: string } | null; id: string; number: string | null; documentType: string; kind: string; issueDate: Date | null; finalizedAt: Date | null; grossCents: Cents; bookingId: string | null; bookingNumber: string | null; original: { id: string; number: string | null } | null; financials: InvoiceFinancials | null; href: string }[];
  drafts: { id: string; documentType: string; kind: string; bookingId: string | null; bookingNumber: string | null; href: string }[];
  payments: { href: string | null; id: string; paidAt: Date; amountCents: Cents; method: string; status: string; reference: string | null; invoiceNumber: string | null; bookingId: string | null; bookingNumber: string | null; cancellationReason: string | null }[];
  payouts: { id: string; number: string | null; status: string; sourceType: string; amountCents: Cents; method: string; executedAt: Date | null; plannedAt: Date | null; invoiceNumber: string | null; bookingId: string | null; bookingNumber: string | null; ibanMasked: string | null }[];
  /** Befehl 28: Guthaben aus stornierten Mietvorauszahlungen (je Buchung) */
  prepayments: { bookingId: string; bookingNumber: string; paidCents: Cents; refundedCents: Cents; draftCents: Cents; remainingCents: Cents }[];
  sums: {
    /** wirksames Rechnungsvolumen = Rechnungen − Gutschriften − Storno (financialsFor); Kautionen sind kein Umsatz */
    effectiveInvoiceCents: Cents; invoiceCents: Cents; creditedCents: Cents; cancelledCents: Cents;
    /** davon Schadenabrechnungen (Schadenersatz ist kein gewöhnlicher Umsatz) */
    effectiveDamageCents: Cents;
    paidCents: Cents; openCents: Cents; creditCents: Cents; refundOpenCents: Cents; refundedCents: Cents; payoutsCompletedCents: Cents;
    /** davon aus Kautionen verrechnet (Befehl 20.7) – Teil von paidCents, kein Geldeingang */
    offsetCents: Cents;
  };
};

/** Finanzen der Person über alle ihre Buchungen – Stand ausschließlich aus financialsFor; stornierte Zahlungen/Auszahlungen sichtbar, nie summiert. */
export async function customerFinance(tenantId: string, customerId: string): Promise<CustomerFinance> {
  const [invoices, payments, payouts] = await Promise.all([
    db.invoice.findMany({ where: { tenantId, status: { in: ["DRAFT", "FINALIZED"] }, OR: [{ booking: { customerId } }, { customerId, bookingId: null }] }, orderBy: [{ finalizedAt: "desc" }, { createdAt: "desc" }], take: 500, select: { id: true, number: true, status: true, documentType: true, kind: true, bookingId: true, finalizedAt: true, booking: { select: { number: true } }, original: { select: { id: true, number: true } }, currentVersion: { select: { grossTotal: true, issueDate: true } } } }),
    db.payment.findMany({ where: { tenantId, OR: [{ booking: { customerId } }, { bookingId: null, invoice: { customerId } }] }, orderBy: { paidAt: "desc" }, take: 500, select: { id: true, paidAt: true, amountCents: true, method: true, status: true, reference: true, cancellationReason: true, bookingId: true, booking: { select: { number: true } }, invoice: { select: { id: true, number: true, bookingId: true, kind: true } } } }),
    db.payout.findMany({ where: { tenantId, OR: [{ customerId }, { booking: { customerId } }] }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, number: true, status: true, sourceType: true, amountCents: true, method: true, executedAt: true, plannedAt: true, ibanMasked: true, bookingId: true, booking: { select: { number: true } }, invoice: { select: { number: true } } } }),
  ]);
  const finalized = invoices.filter((i) => i.status === "FINALIZED" && i.currentVersion);
  const originals = finalized.filter((i) => i.documentType === "INVOICE");
  const fin = await financialsFor(tenantId, originals.map((i) => ({ id: i.id, grossTotal: i.currentVersion!.grossTotal })));
  // Befehl 27: höchste Mahnstufe je offener Rechnung (nur Anzeige; die Forderung selbst kommt aus financialsFor)
  const openIds = originals.filter((i) => (fin.get(i.id)?.openCents ?? 0) > 0).map((i) => i.id);
  const notices = openIds.length ? await db.dunningNotice.findMany({ where: { tenantId, invoiceId: { in: openIds } }, orderBy: { level: "asc" }, select: { invoiceId: true, level: true, number: true } }) : [];
  const dunningByInvoice = new Map(notices.map((n) => [n.invoiceId, { level: n.level, label: dunningLevelLabel(n.level), number: n.number }]));
  const sums = { effectiveInvoiceCents: 0, invoiceCents: 0, creditedCents: 0, cancelledCents: 0, effectiveDamageCents: 0, paidCents: 0, openCents: 0, creditCents: 0, refundOpenCents: 0, refundedCents: 0, payoutsCompletedCents: 0, offsetCents: 0 };
  for (const i of originals) {
    const f = fin.get(i.id)!;
    sums.invoiceCents += f.invoiceCents; sums.creditedCents += f.creditedCents; sums.cancelledCents += f.cancelledCents; sums.effectiveInvoiceCents += f.effectiveCents;
    if (i.kind === "DAMAGE") sums.effectiveDamageCents += f.effectiveCents;
    sums.paidCents += f.paidCents; sums.offsetCents += f.offsetCents; sums.openCents += f.openCents; sums.creditCents += f.customerCreditCents; sums.refundOpenCents += f.refundRemainingCents; sums.refundedCents += f.completedRefundCents;
  }
  // Befehl 28: Guthaben aus stornierten Mietvorauszahlungen (ohne Rechnung) – dieselbe Bedeutung wie Rechnungsguthaben
  const prepayments = await cancelledPrepayments(tenantId, customerId);
  for (const p of prepayments) { sums.creditCents += p.paidCents; sums.refundOpenCents += p.remainingCents; sums.refundedCents += p.refundedCents; }
  sums.payoutsCompletedCents = payouts.filter((p) => p.status === "COMPLETED").reduce((a, p) => a + p.amountCents, 0);
  return {
    documents: finalized.map((i) => ({ id: i.id, number: i.number, documentType: i.documentType, kind: i.kind, issueDate: i.currentVersion!.issueDate, finalizedAt: i.finalizedAt, grossCents: toCents(i.currentVersion!.grossTotal), bookingId: i.bookingId, bookingNumber: i.booking?.number ?? null, original: i.original, financials: fin.get(i.id) ?? null, href: invoiceHref(i), dunning: dunningByInvoice.get(i.id) ?? null })),
    drafts: invoices.filter((i) => i.status === "DRAFT").map((i) => ({ id: i.id, documentType: i.documentType, kind: i.kind, bookingId: i.bookingId, bookingNumber: i.booking?.number ?? null, href: invoiceHref(i) })),
    payments: payments.map((p) => ({ id: p.id, paidAt: p.paidAt, amountCents: p.amountCents, method: p.method, status: p.status, reference: p.reference, invoiceNumber: p.invoice?.number ?? null, bookingId: p.bookingId, bookingNumber: p.booking?.number ?? null, cancellationReason: p.cancellationReason, href: paymentHref(p) })),
    payouts: payouts.map((p) => ({ id: p.id, number: p.number, status: p.status, sourceType: p.sourceType, amountCents: p.amountCents, method: p.method, executedAt: p.executedAt, plannedAt: p.plannedAt, invoiceNumber: p.invoice?.number ?? null, bookingId: p.bookingId, bookingNumber: p.booking?.number ?? null, ibanMasked: p.ibanMasked })),
    sums,
    prepayments,
  };
}

/** Befehl 28: stornierte Buchungen der Person mit Mietvorauszahlung ohne Rechnung (Kundenguthaben an der Buchung). */
async function cancelledPrepayments(tenantId: string, customerId: string) {
  const rows = await db.booking.findMany({ where: { tenantId, customerId, status: "CANCELLED", payments: { some: { type: "RENTAL_PAYMENT", invoiceId: null, status: "CONFIRMED" } } }, select: { id: true, number: true }, take: 200 });
  const bal = await prepaymentBalances(tenantId, rows.map((r) => r.id));
  return rows.map((r) => ({ ...bal.get(r.id)!, bookingId: r.id, bookingNumber: r.number }));
}

// ---------------------------------------------------------------------------
// Kautionen
// ---------------------------------------------------------------------------

export type CustomerDeposit = DepositFinancials & { depositId: string; bookingId: string; bookingNumber: string; bookingStatus: string; plate: string; events: { id: string; type: string; amountCents: Cents; status: string; occurredAt: Date; method: string | null; cancellationReason: string | null }[] };

/** Kautionen je Buchung – Stand aus balanceOf/computeDepositFinancials, Auszahlungen aus abgeschlossenen Payouts. */
export async function customerDeposits(tenantId: string, customerId: string): Promise<CustomerDeposit[]> {
  const rows = await db.securityDeposit.findMany({ where: { tenantId, booking: { customerId } }, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, bookingId: true, expectedAmountCents: true, booking: { select: { number: true, status: true, vehicle: { select: { plate: true } } } }, events: { orderBy: { occurredAt: "asc" }, select: { id: true, type: true, amountCents: true, status: true, occurredAt: true, method: true, cancellationReason: true } } } });
  if (rows.length === 0) return [];
  const paidOut = await db.payout.groupBy({ by: ["securityDepositId"], where: { tenantId, securityDepositId: { in: rows.map((d) => d.id) }, status: "COMPLETED" }, _sum: { amountCents: true } });
  const paidMap = new Map(paidOut.map((g) => [g.securityDepositId, g._sum.amountCents ?? 0]));
  return rows.map((d) => ({ ...computeDepositFinancials(balanceOf(d.expectedAmountCents, d.events), paidMap.get(d.id) ?? 0), depositId: d.id, bookingId: d.bookingId, bookingNumber: d.booking.number, bookingStatus: d.booking.status, plate: d.booking.vehicle.plate, events: d.events }));
}

// ---------------------------------------------------------------------------
// Schäden – nur Akten mit echtem Bezug (Buchung der Person); Haftung bleibt die Entscheidung der Akte
// ---------------------------------------------------------------------------

export function customerDamageCases(tenantId: string, customerId: string) {
  return db.damageCase.findMany({ where: { tenantId, booking: { customerId } }, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, caseNumber: true, status: true, liabilityStatus: true, description: true, createdAt: true, closedAt: true, customerChargeCents: true, bookingId: true, booking: { select: { number: true } }, vehicle: { select: vehSel }, invoices: { where: { kind: "DAMAGE", documentType: "INVOICE", status: "FINALIZED" }, select: { id: true, number: true } } } });
}

// ---------------------------------------------------------------------------
// Dokumente – nur mit Bezug zur Person: Buchungsdokumente (Vertrag, Protokolle, Belege, Auszahlungen), Schadendokumente
// zu ihren Buchungen; Behördendokumente nur für Rollen mit Behördenzugriff. Immer über die geschützten Adressen.
// ---------------------------------------------------------------------------

export type CustomerDocument = { id: string; kind: "BOOKING" | "DAMAGE" | "AUTHORITY"; type: string; fileName: string; contentType: string; sizeBytes: number; createdAt: Date; href: string; context: string; contextHref: string };

export async function customerDocuments(tenantId: string, customerId: string, role: string): Promise<CustomerDocument[]> {
  const canAuthority = role !== "YARD";
  const [docs, damageDocs, authorityDocs] = await Promise.all([
    db.document.findMany({ where: { tenantId, OR: [{ booking: { customerId } }, { payout: { customerId } }, { bookingId: null, invoice: { customerId } }, { bookingId: null, dunningNotice: { customerId } }] }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, type: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, version: true, bookingId: true, booking: { select: { number: true } }, invoice: { select: { number: true } }, payout: { select: { id: true, number: true } } } }),
    db.damageCaseDocument.findMany({ where: { tenantId, case: { booking: { customerId } } }, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, type: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, case: { select: { id: true, caseNumber: true } } } }),
    canAuthority ? db.authorityCaseDocument.findMany({ where: { tenantId, case: { driverCustomerId: customerId } }, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, type: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, case: { select: { id: true, caseNumber: true } } } }) : [],
  ]);
  const out: CustomerDocument[] = [
    ...docs.map((d) => ({ id: d.id, kind: "BOOKING" as const, type: d.type, fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, createdAt: d.createdAt, href: `/api/documents/${d.id}`, context: d.payout ? `Auszahlung ${d.payout.number ?? ""}` : d.invoice?.number ? `${d.invoice.number} · ${bookingLabel(d.booking?.number)}` : bookingLabel(d.booking?.number), contextHref: d.payout ? `/auszahlungen/${d.payout.id}` : d.bookingId ? `/buchungen/${d.bookingId}` : "/rechnungen" })),
    ...damageDocs.map((d) => ({ id: d.id, kind: "DAMAGE" as const, type: d.type, fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, createdAt: d.createdAt, href: `/api/damage-documents/${d.id}`, context: `Schadenakte ${d.case.caseNumber}`, contextHref: `/schaeden/${d.case.id}` })),
    ...authorityDocs.map((d) => ({ id: d.id, kind: "AUTHORITY" as const, type: d.type, fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, createdAt: d.createdAt, href: `/api/authority-documents/${d.id}`, context: `Behördenvorgang ${d.case.caseNumber}`, contextHref: `/behoerden/${d.case.id}` })),
  ];
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// ---------------------------------------------------------------------------
// Kommunikation – Versandprotokoll (EmailLog); der Inhalt einer Mail wird nicht gespeichert, nur Betreff, Vorlage, Stand
// ---------------------------------------------------------------------------

export function customerEmails(tenantId: string, customerId: string) {
  return db.emailLog.findMany({ where: { tenantId, OR: [{ booking: { customerId } }, { payout: { customerId } }, { bookingId: null, invoiceVersion: { invoice: { customerId } } }, { bookingId: null, dunningNotice: { customerId } }] }, orderBy: { createdAt: "desc" }, take: 300, select: { id: true, createdAt: true, sentAt: true, lastAttemptAt: true, recipient: true, template: true, subject: true, status: true, error: true, trigger: true, attemptNo: true, bookingId: true, payoutId: true, booking: { select: { number: true } }, invoiceVersion: { select: { invoice: { select: { number: true } } } } } });
}



// ---------------------------------------------------------------------------
// Historie – operative Zeitleiste aus gespeicherten Zeitstempeln; das Audit-Protokoll bleibt getrennt
// ---------------------------------------------------------------------------

export type TimelineEntry = { key: string; at: Date; kind: string; title: string; detail: string | null; href: string | null };

export async function customerTimeline(tenantId: string, customerId: string, limit = 200): Promise<TimelineEntry[]> {
  return timelineFor(tenantId, { customerId }, limit);
}

/** Befehl 28: chronologische Historie einer Buchung – dieselbe Ableitung wie die Kundenakte (gespeicherte Zeitstempel und Audit), keine eigene Ereignistabelle. */
export async function bookingTimeline(tenantId: string, bookingId: string, limit = 200): Promise<TimelineEntry[]> {
  return timelineFor(tenantId, { bookingId }, limit);
}

type TimelineScope = { customerId: string } | { bookingId: string };

/** Zeitleiste aus gespeicherten Zeitstempeln (Buchung, Vertrag, Protokolle, Belege, Zahlungen, Kaution, Auszahlungen, Nachträge, Storno, Mails). */
async function timelineFor(tenantId: string, scope: TimelineScope, limit: number): Promise<TimelineEntry[]> {
  const byCustomer = "customerId" in scope;
  const customerId = byCustomer ? scope.customerId : null;
  const bookingId = byCustomer ? null : scope.bookingId;
  const viaBooking = byCustomer ? { booking: { customerId: customerId! } } : { bookingId: bookingId! };
  const [customer, bookings, contracts, handovers, invoices, payments, depositEvents, payouts, damageCases, authority, mails, amendments] = await Promise.all([
    byCustomer ? db.customer.findFirst({ where: { id: customerId!, tenantId }, select: { createdAt: true } }) : null,
    db.booking.findMany({ where: { tenantId, ...(byCustomer ? { customerId: customerId! } : { id: bookingId! }) }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, number: true, status: true, createdAt: true, updatedAt: true, cancelledAt: true, cancellationReason: true, cancelledByName: true, vehicle: { select: { plate: true } } } }),
    db.rentalContract.findMany({ where: { tenantId, status: { not: "DRAFT" }, ...(byCustomer ? { customerId: customerId! } : { bookingId: bookingId! }) }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, number: true, status: true, signedAt: true, createdAt: true, bookingId: true } }),
    db.handover.findMany({ where: { tenantId, status: "FINALIZED", ...viaBooking }, orderBy: { finalizedAt: "desc" }, take: limit, select: { id: true, number: true, type: true, finalizedAt: true, bookingId: true, mileage: true } }),
    db.invoice.findMany({ where: { tenantId, status: "FINALIZED", ...(byCustomer ? { OR: [{ booking: { customerId: customerId! } }, { customerId: customerId!, bookingId: null }] } : { bookingId: bookingId! }) }, orderBy: { finalizedAt: "desc" }, take: limit, select: { id: true, number: true, documentType: true, kind: true, finalizedAt: true, bookingId: true, currentVersion: { select: { grossTotal: true } } } }),
    db.payment.findMany({ where: { tenantId, ...(byCustomer ? { OR: [{ booking: { customerId: customerId! } }, { bookingId: null, invoice: { customerId: customerId! } }] } : { bookingId: bookingId! }) }, orderBy: { paidAt: "desc" }, take: limit, select: { id: true, paidAt: true, amountCents: true, status: true, cancelledAt: true, bookingId: true, invoice: { select: { id: true, bookingId: true, kind: true, number: true } } } }),
    db.securityDepositEvent.findMany({ where: { tenantId, deposit: byCustomer ? { booking: { customerId: customerId! } } : { bookingId: bookingId! } }, orderBy: { occurredAt: "desc" }, take: limit, select: { id: true, type: true, amountCents: true, status: true, occurredAt: true, cancelledAt: true, deposit: { select: { bookingId: true, booking: { select: { number: true } } } } } }),
    db.payout.findMany({ where: { tenantId, ...(byCustomer ? { OR: [{ customerId: customerId! }, { booking: { customerId: customerId! } }] } : { bookingId: bookingId! }) }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, number: true, status: true, sourceType: true, amountCents: true, completedAt: true, executedAt: true, cancelledAt: true, createdAt: true } }),
    db.damageCase.findMany({ where: { tenantId, ...viaBooking }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, caseNumber: true, createdAt: true, closedAt: true, description: true } }),
    db.authorityCase.findMany({ where: { tenantId, ...(byCustomer ? { driverCustomerId: customerId! } : { bookingId: bookingId! }) }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, caseNumber: true, createdAt: true, authorityName: true } }),
    db.emailLog.findMany({ where: { tenantId, status: "SENT", ...(byCustomer ? { OR: [{ booking: { customerId: customerId! } }, { payout: { customerId: customerId! } }, { bookingId: null, invoiceVersion: { invoice: { customerId: customerId! } } }, { bookingId: null, dunningNotice: { customerId: customerId! } }] } : { bookingId: bookingId! }) }, orderBy: { sentAt: "desc" }, take: limit, select: { id: true, sentAt: true, createdAt: true, subject: true, bookingId: true, payoutId: true } }),
    // Befehl 28: Nachträge mit Vereinbarung, Unterschrift und Zurücknahme
    db.contractAmendment.findMany({ where: { tenantId, status: { in: ["AGREED", "SIGNED", "DISCARDED"] }, ...viaBooking }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, bookingId: true, number: true, status: true, newEndAt: true, newStartAt: true, agreedAt: true, agreedChannel: true, signedAt: true, discardedAt: true, discardReason: true, booking: { select: { number: true } } } }),
  ]);
  // Befehl 28: Zeitraumänderungen vor dem Vertrag und bewusst stehen gelassenes Guthaben stehen nur im Audit (keine Doppelhaltung)
  const bookingIds = bookings.map((b) => b.id);
  const audits = bookingIds.length ? await db.auditLog.findMany({ where: { tenantId, bookingId: { in: bookingIds }, action: { in: ["BOOKING_PERIOD_CHANGED", "RENTAL_PAYMENT_TO_CREDIT"] } }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, action: true, bookingId: true, amountCents: true, createdAt: true, details: true } }) : [];
  const bookingNo = new Map(bookings.map((b) => [b.id, b.number]));
  const e: TimelineEntry[] = [];
  if (customer) e.push({ key: "created", at: customer.createdAt, kind: "Kunde", title: "Kunde angelegt", detail: null, href: null });
  for (const b of bookings) {
    e.push({ key: `b-${b.id}`, at: b.createdAt, kind: "Buchung", title: `Buchung ${b.number} angelegt`, detail: b.vehicle.plate, href: `/buchungen/${b.id}` });
    // Befehl 28: Storno mit Zeitpunkt und Grund (seit Befehl 27 gespeichert); ältere Stornos ohne Zeitpunkt nur als Zustand
    if (b.status === "CANCELLED" && b.cancelledAt) e.push({ key: `bc-${b.id}`, at: b.cancelledAt, kind: "Storno", title: `Buchung ${b.number} storniert`, detail: `${b.cancellationReason ?? "ohne erfassten Grund"}${b.cancelledByName ? ` · ${b.cancelledByName}` : ""}`, href: `/buchungen/${b.id}#storno` });
    else if (b.status === "CANCELLED") e[e.length - 1] = { ...e[e.length - 1], detail: `${b.vehicle.plate} · später storniert` };
  }
  for (const a of audits) {
    const d = (a.details ?? {}) as { startBefore?: string; endBefore?: string; startAfter?: string; endAfter?: string; reason?: string; source?: string };
    const href = `/buchungen/${a.bookingId}`;
    if (a.action === "BOOKING_PERIOD_CHANGED") e.push({ key: `bp-${a.id}`, at: a.createdAt, kind: "Buchung", title: `Zeitraum geändert · Buchung ${bookingNo.get(a.bookingId!) ?? ""}`, detail: `${d.startBefore ? dateTimeText(new Date(d.startBefore)) : "–"} – ${d.endBefore ? dateTimeText(new Date(d.endBefore)) : "–"} → ${d.startAfter ? dateTimeText(new Date(d.startAfter)) : "–"} – ${d.endAfter ? dateTimeText(new Date(d.endAfter)) : "–"}${d.reason ? ` · ${d.reason}` : ""}`, href });
    if (a.action === "RENTAL_PAYMENT_TO_CREDIT") e.push({ key: `bg-${a.id}`, at: a.createdAt, kind: "Guthaben", title: `Mietvorauszahlung als Kundenguthaben belassen ${fmt(a.amountCents ?? 0)}`, detail: `Buchung ${bookingNo.get(a.bookingId!) ?? ""} storniert`, href: `${href}#storno` });
  }
  for (const a of amendments) {
    const href = `/buchungen/${a.bookingId}/nachtrag/${a.id}`;
    const period = a.newEndAt ? `Rückgabe bis ${dateTimeText(a.newEndAt)}` : a.newStartAt ? `Abholung ${dateTimeText(a.newStartAt)}` : null;
    if (a.agreedAt) e.push({ key: `na-${a.id}`, at: a.agreedAt, kind: "Nachtrag", title: `Vertragsänderung vereinbart (${a.agreedChannel === "PHONE" ? "telefonisch" : "vorab"}) · Buchung ${a.booking.number}`, detail: [period, "Unterschrift ausstehend"].filter(Boolean).join(" · "), href });
    if (a.status === "SIGNED" && a.signedAt) e.push({ key: `ns-${a.id}`, at: a.signedAt, kind: "Nachtrag", title: `Nachtrag ${a.number} unterschrieben · Buchung ${a.booking.number}`, detail: period, href });
    if (a.status === "DISCARDED" && a.discardedAt && a.agreedAt) e.push({ key: `nd-${a.id}`, at: a.discardedAt, kind: "Nachtrag", title: `Vereinbarte Vertragsänderung zurückgenommen · Buchung ${a.booking.number}`, detail: a.discardReason, href });
  }
  for (const c of contracts) if (c.status === "SIGNED" && c.signedAt) e.push({ key: `c-${c.id}`, at: c.signedAt, kind: "Vertrag", title: `Mietvertrag ${c.number} abgeschlossen`, detail: null, href: `/buchungen/${c.bookingId}/vertrag` });
  for (const h of handovers) if (h.finalizedAt) e.push({ key: `h-${h.id}`, at: h.finalizedAt, kind: h.type === "PICKUP" ? "Übergabe" : "Rückgabe", title: `${h.type === "PICKUP" ? "Übergabe" : "Rückgabe"} ${h.number}`, detail: h.mileage != null ? `${h.mileage.toLocaleString("de-DE")} km` : null, href: `/buchungen/${h.bookingId}/${h.type === "PICKUP" ? "uebergabe" : "rueckgabe"}` });
  for (const i of invoices) if (i.finalizedAt) e.push({ key: `i-${i.id}`, at: i.finalizedAt, kind: i.documentType === "INVOICE" ? (invoiceKindWord(i.kind)) : i.documentType === "CREDIT_NOTE" ? "Gutschrift" : "Stornobeleg", title: `${i.documentType === "INVOICE" ? (invoiceKindWord(i.kind)) : i.documentType === "CREDIT_NOTE" ? "Gutschrift" : "Stornobeleg"} ${i.number ?? ""} abgeschlossen`, detail: fmt(toCents(i.currentVersion?.grossTotal ?? 0)), href: invoiceHref(i) });
  for (const p of payments) {
    e.push({ key: `p-${p.id}`, at: p.paidAt, kind: "Zahlung", title: `Zahlung ${fmt(p.amountCents)}${p.invoice?.number ? ` zu ${p.invoice.number}` : ""}`, detail: p.status === "CANCELLED" ? "storniert" : null, href: paymentHref(p) });
    if (p.status === "CANCELLED" && p.cancelledAt) e.push({ key: `pc-${p.id}`, at: p.cancelledAt, kind: "Zahlung", title: `Zahlung ${fmt(p.amountCents)} storniert`, detail: null, href: paymentHref(p) });
  }
  for (const d of depositEvents) {
    const word = d.type === "RECEIVED" ? "Kaution erhalten" : d.type === "RELEASED" ? "Kaution freigegeben" : "Kaution einbehalten";
    e.push({ key: `d-${d.id}`, at: d.occurredAt, kind: "Kaution", title: `${word} ${fmt(d.amountCents)}`, detail: `Buchung ${d.deposit.booking.number}${d.status === "CANCELLED" ? " · storniert" : ""}`, href: `/buchungen/${d.deposit.bookingId}#kaution` });
    if (d.status === "CANCELLED" && d.cancelledAt) e.push({ key: `dc-${d.id}`, at: d.cancelledAt, kind: "Kaution", title: `Kautionsbuchung ${fmt(d.amountCents)} storniert`, detail: `Buchung ${d.deposit.booking.number}`, href: `/buchungen/${d.deposit.bookingId}#kaution` });
  }
  for (const p of payouts) {
    if (p.status !== "DRAFT" && (p.completedAt ?? p.executedAt)) e.push({ key: `az-${p.id}`, at: p.completedAt ?? p.executedAt!, kind: "Auszahlung", title: `Auszahlung ${p.number ?? ""} ${fmt(p.amountCents)} erfasst`, detail: p.sourceType === "RENTAL_PREPAYMENT_REFUND" ? "Erstattung der Mietvorauszahlung (Storno)" : p.sourceType === "SECURITY_DEPOSIT_REFUND" ? "Kautionsrückzahlung" : null, href: `/auszahlungen/${p.id}` });
    if (p.status === "CANCELLED" && p.cancelledAt) e.push({ key: `azc-${p.id}`, at: p.cancelledAt, kind: "Auszahlung", title: `Auszahlung ${p.number ?? "(Entwurf)"} storniert`, detail: null, href: `/auszahlungen/${p.id}` });
  }
  for (const d of damageCases) {
    e.push({ key: `sch-${d.id}`, at: d.createdAt, kind: "Schaden", title: `Schadenakte ${d.caseNumber} eröffnet`, detail: d.description, href: `/schaeden/${d.id}` });
    if (d.closedAt) e.push({ key: `schc-${d.id}`, at: d.closedAt, kind: "Schaden", title: `Schadenakte ${d.caseNumber} geschlossen`, detail: null, href: `/schaeden/${d.id}` });
  }
  for (const a of authority) e.push({ key: `bh-${a.id}`, at: a.createdAt, kind: "Behörde", title: `Als Fahrer benannt · ${a.caseNumber}`, detail: a.authorityName, href: `/behoerden/${a.id}` });
  for (const m of mails) e.push({ key: `m-${m.id}`, at: m.sentAt ?? m.createdAt, kind: "E-Mail", title: `E-Mail versendet`, detail: m.subject, href: m.payoutId ? `/auszahlungen/${m.payoutId}` : m.bookingId ? `/buchungen/${m.bookingId}` : null });
  return e.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

// ---------------------------------------------------------------------------

const dFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" });
const dateText = (d: Date) => dFmt.format(d);
const dtFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dateTimeText = (d: Date) => dtFmt.format(d);
const fmt = (c: Cents) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
