// Kundenakte 360° (Phase 19): eine Person, alle Vorgänge – zusammengeführt aus den vorhandenen Modulen. Hier wird
// nichts neu berechnet, was ein Modul schon zentral rechnet: Rechnungsstand aus financialsFor (Phase 17/18),
// Kautionen aus balanceOf/computeDepositFinancials (Phase 15/18), Auszahlungen aus dem Payout-Modell,
// Behördenvorgänge nur über die bewusste Fahrerbestimmung (driverCustomerId). Historische Snapshots bleiben unberührt.
// Die Akte erfindet keine Ereignisse: Die Historie entsteht ausschließlich aus gespeicherten Zeitstempeln.

import { invoiceKindWord } from "@/lib/constants";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { financialsFor, type InvoiceFinancials } from "@/lib/counter-documents";
import { balanceOf, computeDepositFinancials, type DepositFinancials } from "@/lib/deposits";
import { customerName } from "@/lib/format";
import { toCents, type Cents } from "@/lib/money";

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
    db.payment.findFirst({ where: { tenantId, booking: { customerId } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.payout.findFirst({ where: c, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.emailLog.findFirst({ where: { tenantId, OR: [{ booking: { customerId } }, { payout: { customerId } }] }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
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
    db.invoice.findMany({ where: { tenantId, status: "FINALIZED", documentType: "INVOICE", currentVersionId: { not: null }, booking: { customerId } }, select: { id: true, number: true, kind: true, bookingId: true, currentVersion: { select: { grossTotal: true, paymentDueDate: true } } } }),
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
      const overdue = !!due && due < now;
      tasks.push({ key: `inv-${i.id}`, title: `${word} ${i.number} offen`, detail: `${fmt(f.openCents)}${due ? ` · fällig ${dateText(due)}` : ""}`, href: `/buchungen/${i.bookingId}/rechnung?nr=${i.id}`, tone: overdue ? "bad" : "amber" });
    }
    if (f.refundOpen) { refundsOpen++; refundOpenCents += f.refundRemainingCents; tasks.push({ key: `ref-${i.id}`, title: `Erstattung zu ${word} ${i.number} offen`, detail: `Kundenguthaben ${fmt(f.refundRemainingCents)} noch nicht ausgezahlt`, href: `/buchungen/${i.bookingId}/rechnung?nr=${i.id}`, tone: "amber" }); }
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
    db.booking.findMany({ where, orderBy: { startAt: "desc" }, skip, take: pageSize, select: { id: true, number: true, status: true, startAt: true, endAt: true, actualPickupAt: true, actualReturnAt: true, vehicle: { select: vehSel }, contract: { select: { number: true, status: true, totalAmount: true } }, invoices: { where: { kind: "RENTAL", documentType: "INVOICE", status: "FINALIZED" }, select: { id: true, number: true, currentVersion: { select: { grossTotal: true } } }, take: 1 } } }),
  ]);
  return { rows, total, page: Math.max(1, page), pages: Math.max(1, Math.ceil(total / pageSize)) };
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
  documents: { id: string; number: string | null; documentType: string; kind: string; issueDate: Date | null; finalizedAt: Date | null; grossCents: Cents; bookingId: string; bookingNumber: string; original: { id: string; number: string | null } | null; financials: InvoiceFinancials | null; href: string }[];
  drafts: { id: string; documentType: string; kind: string; bookingId: string; bookingNumber: string; href: string }[];
  payments: { id: string; paidAt: Date; amountCents: Cents; method: string; status: string; reference: string | null; invoiceNumber: string | null; bookingId: string; bookingNumber: string; cancellationReason: string | null }[];
  payouts: { id: string; number: string | null; status: string; sourceType: string; amountCents: Cents; method: string; executedAt: Date | null; plannedAt: Date | null; invoiceNumber: string | null; bookingId: string; bookingNumber: string; ibanMasked: string | null }[];
  sums: {
    /** wirksames Rechnungsvolumen = Rechnungen − Gutschriften − Storno (financialsFor); Kautionen sind kein Umsatz */
    effectiveInvoiceCents: Cents; invoiceCents: Cents; creditedCents: Cents; cancelledCents: Cents;
    /** davon Schadenabrechnungen (Schadenersatz ist kein gewöhnlicher Umsatz) */
    effectiveDamageCents: Cents;
    paidCents: Cents; openCents: Cents; creditCents: Cents; refundOpenCents: Cents; refundedCents: Cents; payoutsCompletedCents: Cents;
  };
};

/** Finanzen der Person über alle ihre Buchungen – Stand ausschließlich aus financialsFor; stornierte Zahlungen/Auszahlungen sichtbar, nie summiert. */
export async function customerFinance(tenantId: string, customerId: string): Promise<CustomerFinance> {
  const [invoices, payments, payouts] = await Promise.all([
    db.invoice.findMany({ where: { tenantId, status: { in: ["DRAFT", "FINALIZED"] }, booking: { customerId } }, orderBy: [{ finalizedAt: "desc" }, { createdAt: "desc" }], take: 500, select: { id: true, number: true, status: true, documentType: true, kind: true, bookingId: true, finalizedAt: true, booking: { select: { number: true } }, original: { select: { id: true, number: true } }, currentVersion: { select: { grossTotal: true, issueDate: true } } } }),
    db.payment.findMany({ where: { tenantId, booking: { customerId } }, orderBy: { paidAt: "desc" }, take: 500, select: { id: true, paidAt: true, amountCents: true, method: true, status: true, reference: true, cancellationReason: true, bookingId: true, booking: { select: { number: true } }, invoice: { select: { number: true } } } }),
    db.payout.findMany({ where: { tenantId, OR: [{ customerId }, { booking: { customerId } }] }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, number: true, status: true, sourceType: true, amountCents: true, method: true, executedAt: true, plannedAt: true, ibanMasked: true, bookingId: true, booking: { select: { number: true } }, invoice: { select: { number: true } } } }),
  ]);
  const finalized = invoices.filter((i) => i.status === "FINALIZED" && i.currentVersion);
  const originals = finalized.filter((i) => i.documentType === "INVOICE");
  const fin = await financialsFor(tenantId, originals.map((i) => ({ id: i.id, grossTotal: i.currentVersion!.grossTotal })));
  const sums = { effectiveInvoiceCents: 0, invoiceCents: 0, creditedCents: 0, cancelledCents: 0, effectiveDamageCents: 0, paidCents: 0, openCents: 0, creditCents: 0, refundOpenCents: 0, refundedCents: 0, payoutsCompletedCents: 0 };
  for (const i of originals) {
    const f = fin.get(i.id)!;
    sums.invoiceCents += f.invoiceCents; sums.creditedCents += f.creditedCents; sums.cancelledCents += f.cancelledCents; sums.effectiveInvoiceCents += f.effectiveCents;
    if (i.kind === "DAMAGE") sums.effectiveDamageCents += f.effectiveCents;
    sums.paidCents += f.paidCents; sums.openCents += f.openCents; sums.creditCents += f.customerCreditCents; sums.refundOpenCents += f.refundRemainingCents; sums.refundedCents += f.completedRefundCents;
  }
  sums.payoutsCompletedCents = payouts.filter((p) => p.status === "COMPLETED").reduce((a, p) => a + p.amountCents, 0);
  return {
    documents: finalized.map((i) => ({ id: i.id, number: i.number, documentType: i.documentType, kind: i.kind, issueDate: i.currentVersion!.issueDate, finalizedAt: i.finalizedAt, grossCents: toCents(i.currentVersion!.grossTotal), bookingId: i.bookingId, bookingNumber: i.booking.number, original: i.original, financials: fin.get(i.id) ?? null, href: `/buchungen/${i.bookingId}/rechnung?nr=${i.id}` })),
    drafts: invoices.filter((i) => i.status === "DRAFT").map((i) => ({ id: i.id, documentType: i.documentType, kind: i.kind, bookingId: i.bookingId, bookingNumber: i.booking.number, href: `/buchungen/${i.bookingId}/rechnung?nr=${i.id}` })),
    payments: payments.map((p) => ({ id: p.id, paidAt: p.paidAt, amountCents: p.amountCents, method: p.method, status: p.status, reference: p.reference, invoiceNumber: p.invoice?.number ?? null, bookingId: p.bookingId, bookingNumber: p.booking.number, cancellationReason: p.cancellationReason })),
    payouts: payouts.map((p) => ({ id: p.id, number: p.number, status: p.status, sourceType: p.sourceType, amountCents: p.amountCents, method: p.method, executedAt: p.executedAt, plannedAt: p.plannedAt, invoiceNumber: p.invoice?.number ?? null, bookingId: p.bookingId, bookingNumber: p.booking.number, ibanMasked: p.ibanMasked })),
    sums,
  };
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
    db.document.findMany({ where: { tenantId, OR: [{ booking: { customerId } }, { payout: { customerId } }] }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, type: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, version: true, bookingId: true, booking: { select: { number: true } }, invoice: { select: { number: true } }, payout: { select: { id: true, number: true } } } }),
    db.damageCaseDocument.findMany({ where: { tenantId, case: { booking: { customerId } } }, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, type: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, case: { select: { id: true, caseNumber: true } } } }),
    canAuthority ? db.authorityCaseDocument.findMany({ where: { tenantId, case: { driverCustomerId: customerId } }, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, type: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, case: { select: { id: true, caseNumber: true } } } }) : [],
  ]);
  const out: CustomerDocument[] = [
    ...docs.map((d) => ({ id: d.id, kind: "BOOKING" as const, type: d.type, fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, createdAt: d.createdAt, href: `/api/documents/${d.id}`, context: d.payout ? `Auszahlung ${d.payout.number ?? ""}` : d.invoice?.number ? `${d.invoice.number} · Buchung ${d.booking.number}` : `Buchung ${d.booking.number}`, contextHref: d.payout ? `/auszahlungen/${d.payout.id}` : `/buchungen/${d.bookingId}` })),
    ...damageDocs.map((d) => ({ id: d.id, kind: "DAMAGE" as const, type: d.type, fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, createdAt: d.createdAt, href: `/api/damage-documents/${d.id}`, context: `Schadenakte ${d.case.caseNumber}`, contextHref: `/schaeden/${d.case.id}` })),
    ...authorityDocs.map((d) => ({ id: d.id, kind: "AUTHORITY" as const, type: d.type, fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, createdAt: d.createdAt, href: `/api/authority-documents/${d.id}`, context: `Behördenvorgang ${d.case.caseNumber}`, contextHref: `/behoerden/${d.case.id}` })),
  ];
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// ---------------------------------------------------------------------------
// Kommunikation – Versandprotokoll (EmailLog); der Inhalt einer Mail wird nicht gespeichert, nur Betreff, Vorlage, Stand
// ---------------------------------------------------------------------------

export function customerEmails(tenantId: string, customerId: string) {
  return db.emailLog.findMany({ where: { tenantId, OR: [{ booking: { customerId } }, { payout: { customerId } }] }, orderBy: { createdAt: "desc" }, take: 300, select: { id: true, createdAt: true, sentAt: true, lastAttemptAt: true, recipient: true, template: true, subject: true, status: true, error: true, trigger: true, attemptNo: true, bookingId: true, payoutId: true, booking: { select: { number: true } }, invoiceVersion: { select: { invoice: { select: { number: true } } } } } });
}



// ---------------------------------------------------------------------------
// Historie – operative Zeitleiste aus gespeicherten Zeitstempeln; das Audit-Protokoll bleibt getrennt
// ---------------------------------------------------------------------------

export type TimelineEntry = { key: string; at: Date; kind: string; title: string; detail: string | null; href: string | null };

export async function customerTimeline(tenantId: string, customerId: string, limit = 200): Promise<TimelineEntry[]> {
  const [customer, bookings, contracts, handovers, invoices, payments, depositEvents, payouts, damageCases, authority, mails] = await Promise.all([
    db.customer.findFirst({ where: { id: customerId, tenantId }, select: { createdAt: true } }),
    db.booking.findMany({ where: { tenantId, customerId }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, number: true, status: true, createdAt: true, updatedAt: true, vehicle: { select: { plate: true } } } }),
    db.rentalContract.findMany({ where: { tenantId, customerId, status: { not: "DRAFT" } }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, number: true, status: true, signedAt: true, createdAt: true, bookingId: true } }),
    db.handover.findMany({ where: { tenantId, status: "FINALIZED", booking: { customerId } }, orderBy: { finalizedAt: "desc" }, take: limit, select: { id: true, number: true, type: true, finalizedAt: true, bookingId: true, mileage: true } }),
    db.invoice.findMany({ where: { tenantId, status: "FINALIZED", booking: { customerId } }, orderBy: { finalizedAt: "desc" }, take: limit, select: { id: true, number: true, documentType: true, kind: true, finalizedAt: true, bookingId: true, currentVersion: { select: { grossTotal: true } } } }),
    db.payment.findMany({ where: { tenantId, booking: { customerId } }, orderBy: { paidAt: "desc" }, take: limit, select: { id: true, paidAt: true, amountCents: true, status: true, cancelledAt: true, bookingId: true, invoice: { select: { number: true } } } }),
    db.securityDepositEvent.findMany({ where: { tenantId, deposit: { booking: { customerId } } }, orderBy: { occurredAt: "desc" }, take: limit, select: { id: true, type: true, amountCents: true, status: true, occurredAt: true, cancelledAt: true, deposit: { select: { bookingId: true, booking: { select: { number: true } } } } } }),
    db.payout.findMany({ where: { tenantId, OR: [{ customerId }, { booking: { customerId } }] }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, number: true, status: true, amountCents: true, completedAt: true, executedAt: true, cancelledAt: true, createdAt: true } }),
    db.damageCase.findMany({ where: { tenantId, booking: { customerId } }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, caseNumber: true, createdAt: true, closedAt: true, description: true } }),
    db.authorityCase.findMany({ where: { tenantId, driverCustomerId: customerId }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, caseNumber: true, createdAt: true, authorityName: true } }),
    db.emailLog.findMany({ where: { tenantId, status: "SENT", OR: [{ booking: { customerId } }, { payout: { customerId } }] }, orderBy: { sentAt: "desc" }, take: limit, select: { id: true, sentAt: true, createdAt: true, subject: true, bookingId: true, payoutId: true } }),
  ]);
  const e: TimelineEntry[] = [];
  if (customer) e.push({ key: "created", at: customer.createdAt, kind: "Kunde", title: "Kunde angelegt", detail: null, href: null });
  for (const b of bookings) {
    e.push({ key: `b-${b.id}`, at: b.createdAt, kind: "Buchung", title: `Buchung ${b.number} angelegt`, detail: b.vehicle.plate, href: `/buchungen/${b.id}` });
    // Ein Storno-Zeitpunkt ist an der Buchung nicht gespeichert (nur der Status) – deshalb kein erfundenes Ereignis, nur der Zustand im Titel
    if (b.status === "CANCELLED") e[e.length - 1] = { ...e[e.length - 1], detail: `${b.vehicle.plate} · später storniert` };
  }
  for (const c of contracts) if (c.status === "SIGNED" && c.signedAt) e.push({ key: `c-${c.id}`, at: c.signedAt, kind: "Vertrag", title: `Mietvertrag ${c.number} abgeschlossen`, detail: null, href: `/buchungen/${c.bookingId}/vertrag` });
  for (const h of handovers) if (h.finalizedAt) e.push({ key: `h-${h.id}`, at: h.finalizedAt, kind: h.type === "PICKUP" ? "Übergabe" : "Rückgabe", title: `${h.type === "PICKUP" ? "Übergabe" : "Rückgabe"} ${h.number}`, detail: h.mileage != null ? `${h.mileage.toLocaleString("de-DE")} km` : null, href: `/buchungen/${h.bookingId}/${h.type === "PICKUP" ? "uebergabe" : "rueckgabe"}` });
  for (const i of invoices) if (i.finalizedAt) e.push({ key: `i-${i.id}`, at: i.finalizedAt, kind: i.documentType === "INVOICE" ? (invoiceKindWord(i.kind)) : i.documentType === "CREDIT_NOTE" ? "Gutschrift" : "Stornobeleg", title: `${i.documentType === "INVOICE" ? (invoiceKindWord(i.kind)) : i.documentType === "CREDIT_NOTE" ? "Gutschrift" : "Stornobeleg"} ${i.number ?? ""} abgeschlossen`, detail: fmt(toCents(i.currentVersion?.grossTotal ?? 0)), href: `/buchungen/${i.bookingId}/rechnung?nr=${i.id}` });
  for (const p of payments) {
    e.push({ key: `p-${p.id}`, at: p.paidAt, kind: "Zahlung", title: `Zahlung ${fmt(p.amountCents)}${p.invoice?.number ? ` zu ${p.invoice.number}` : ""}`, detail: p.status === "CANCELLED" ? "storniert" : null, href: `/buchungen/${p.bookingId}/finanzen` });
    if (p.status === "CANCELLED" && p.cancelledAt) e.push({ key: `pc-${p.id}`, at: p.cancelledAt, kind: "Zahlung", title: `Zahlung ${fmt(p.amountCents)} storniert`, detail: null, href: `/buchungen/${p.bookingId}/finanzen` });
  }
  for (const d of depositEvents) {
    const word = d.type === "RECEIVED" ? "Kaution erhalten" : d.type === "RELEASED" ? "Kaution freigegeben" : "Kaution einbehalten";
    e.push({ key: `d-${d.id}`, at: d.occurredAt, kind: "Kaution", title: `${word} ${fmt(d.amountCents)}`, detail: `Buchung ${d.deposit.booking.number}${d.status === "CANCELLED" ? " · storniert" : ""}`, href: `/buchungen/${d.deposit.bookingId}#kaution` });
    if (d.status === "CANCELLED" && d.cancelledAt) e.push({ key: `dc-${d.id}`, at: d.cancelledAt, kind: "Kaution", title: `Kautionsbuchung ${fmt(d.amountCents)} storniert`, detail: `Buchung ${d.deposit.booking.number}`, href: `/buchungen/${d.deposit.bookingId}#kaution` });
  }
  for (const p of payouts) {
    if (p.status !== "DRAFT" && (p.completedAt ?? p.executedAt)) e.push({ key: `az-${p.id}`, at: p.completedAt ?? p.executedAt!, kind: "Auszahlung", title: `Auszahlung ${p.number ?? ""} ${fmt(p.amountCents)} erfasst`, detail: null, href: `/auszahlungen/${p.id}` });
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
const fmt = (c: Cents) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
