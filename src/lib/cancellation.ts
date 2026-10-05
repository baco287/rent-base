// Befehl 28: Buchungsstorno mit Geldbezug – ein fachlicher Abschluss in EINER Transaktion.
//
// Grundsätze:
// - Historie bleibt: keine Zahlung, Rechnung, Kautionsbewegung, Auszahlung, kein Vertrag und kein Dokument wird gelöscht oder
//   rückwirkend verändert. Finanzielle Folgen entstehen nur als neue, nachvollziehbare Bewegungen über die bestehenden Wege:
//   · Stornogebühr = eigene Rechnung (kind CANCELLATION_FEE, Steuer je Storno bewusst gewählt); die Mietvorauszahlungen werden ihr
//     über den bestehenden Zuordnungsweg (rental-payment-link) zugeordnet → Rest = Kundenguthaben der Rechnung (financialsFor).
//   · ohne Gebühr bleibt die Vorauszahlung an der Buchung (Kundenguthaben ohne Hilfsrechnung, Auszahlungsquelle RENTAL_PREPAYMENT_REFUND).
//   · Erstattung = Auszahlung (Payout) als tatsächlich erfolgt – oder bewusst als Kundenguthaben stehen lassen.
//   · Kaution = bestehende Freigabe (settleDeposit) und optional Kautionsauszahlung; nie automatisch mit der Gebühr verrechnet.
// - Sperrfolge wie überall: Buchung → Kaution → Rechnung → Zahlung/Auszahlung. Ein Idempotenzschlüssel je Abschluss (Doppelklick,
//   zwei Tabs): genau ein fachlicher Storno; der zweite Aufruf liefert den ersten Abschluss bzw. „bereits storniert“.
// - Die Storno-Abrechnung wird an der Buchung eingefroren (cancellationSnapshot + Prüfsumme) und ist Grundlage der
//   Stornobestätigung; sie wird nie aus Live-Daten neu berechnet. PDF und Mail laufen danach und rollen nichts zurück.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { discardAmendmentIn } from "@/lib/amendments";
import { BOOKING_STATUS, CANCELLATION_FEE_TAX_TREATMENTS, PAYOUT_METHODS, type BookingStatus, type CancellationFeeTaxTreatment, type PayoutMethod } from "@/lib/constants";
import { financialsFor, invoiceFinancials } from "@/lib/counter-documents";
import { balanceOf, type DepositBalance } from "@/lib/deposit-balance";
import { settleDepositIn } from "@/lib/deposits";
import { DomainError, contentHash } from "@/lib/integrity";
import { ACCIDENT_CASE_CLOSED_MESSAGE, accidentCaseClosed, assertAccidentCaseOpen } from "@/lib/accident-replacement-events";
import { companySnapshotOf, createCancellationFeeInvoiceDraft, finalizeInvoiceIn, invoiceSettingsMissing, type CompanySnapshot } from "@/lib/invoices";
import { fmtCents, lineAmounts, toBasisPoints, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation, withNumberRetry } from "@/lib/numbering";
import { createPayoutIn, type PayoutInput, type SourceRef } from "@/lib/payouts";
import { prepaymentBalance, rentalPaymentSummary } from "@/lib/rental-payments";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;
const TX = { timeout: 45_000, maxWait: 15_000 };

export const CANCELLATION_REASON_MAX = 500;

// ---------------------------------------------------------------------------
// Übergänge (Vertrag, Entwürfe) – unverändert aus Befehl 27, jetzt hier zentral
// ---------------------------------------------------------------------------

/** Vertragsentwurf verwerfen; ein unterschriebener Vertrag bleibt mit Inhalt, Unterschriften und Dokumenten erhalten (Status CANCELLED). */
export async function cancelContractOf(tx: Tx, tenantId: string, bookingId: string) {
  const contract = await tx.rentalContract.findFirst({ where: { tenantId, bookingId } });
  if (!contract) return null;
  if (contract.status === "DRAFT") {
    await tx.signature.deleteMany({ where: { tenantId, contractId: contract.id } });
    await tx.contractDriver.deleteMany({ where: { tenantId, contractId: contract.id } });
    await tx.rentalContract.delete({ where: { id: contract.id } });
  } else if (contract.status === "SIGNED") {
    await tx.rentalContract.update({ where: { id: contract.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  }
  return contract;
}

/** Übergabe-Entwürfe verwerfen (finalisierte Protokolle gibt es bei RESERVED nicht). Liefert Speicherschlüssel verworfener Fotos. */
export async function discardHandoverDrafts(tx: Tx, tenantId: string, bookingId: string): Promise<string[]> {
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
// Übersicht (Storno-Assistent) – alle Werte aus den zentralen Summierungen
// ---------------------------------------------------------------------------

export type CancellationOverview = {
  booking: { id: string; number: string; status: string; statusLabel: string; startAt: Date; endAt: Date | null; customerId: string; customerName: string; vehicle: string; plate: string };
  contract: { state: "NONE" | "DRAFT" | "SIGNED" | "CANCELLED"; number: string | null };
  finances: {
    /** ACCIDENT (Befehl 29 Phase E): Unfallersatz – kein Mietpreis im Voraus (Abrechnung nach tatsächlicher Mietdauer ab Übergabe); agreedCents 0 ist nur Platzhalter */
    agreedCents: Cents; agreedSource: "CONTRACT" | "ESTIMATE" | "INVOICE" | "ACCIDENT";
    /** bestätigte, keiner Rechnung zugeordnete Mietzahlungen (Vorauszahlung) */
    prepaidCents: Cents;
    invoices: { id: string; number: string | null; kind: string; status: string; grossCents: Cents; openCents: Cents; creditCents: Cents }[];
    openReceivableCents: Cents;
    customerCreditCents: Cents;
    deposit: (DepositBalance & { depositId: string }) | null;
  };
  amendments: { id: string; status: string; number: string | null; newEndAt: Date | null; agreedAt: Date | null }[];
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  needs: { refundDecision: boolean; depositDecision: boolean };
  fee: { available: boolean; blockedReason: string | null; pricesIncludeTax: boolean; standardRateBp: number };
};

const nameOf = (c: { type?: string | null; companyName?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined) => {
  if (!c) return "";
  const person = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  return c.type === "COMPANY" && c.companyName ? c.companyName : c.companyName?.trim() && !person ? c.companyName : person;
};

export async function cancellationOverview(tenantId: string, bookingId: string, client: Client = db): Promise<CancellationOverview> {
  const b = await client.booking.findFirst({
    where: { id: bookingId, tenantId },
    select: {
      id: true, number: true, status: true, startAt: true, endAt: true, customerId: true, rentalType: true,
      customer: { select: { type: true, firstName: true, lastName: true, companyName: true } },
      vehicle: { select: { make: true, model: true, plate: true } },
      contract: { select: { number: true, status: true } },
      securityDeposit: { select: { id: true, expectedAmountCents: true, events: { select: { type: true, amountCents: true, status: true } } } },
      tenant: true,
      contractAmendments: { where: { status: { in: ["DRAFT", "AGREED", "SIGNED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, number: true, newEndAt: true, agreedAt: true } },
    },
  });
  if (!b) throw new DomainError("Buchung nicht gefunden.");
  const [summary, pre, handoverDrafts, invoiceRows] = await Promise.all([
    rentalPaymentSummary(tenantId, bookingId, client),
    prepaymentBalance(tenantId, bookingId, client),
    client.handover.count({ where: { tenantId, bookingId, status: "DRAFT" } }),
    client.invoice.findMany({ where: { tenantId, bookingId, documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, select: { id: true, number: true, kind: true, status: true, currentVersion: { select: { grossTotal: true } } } }),
  ]);
  const finalized = invoiceRows.filter((i) => i.status === "FINALIZED" && i.currentVersion);
  const fin = await financialsFor(tenantId, finalized.map((i) => ({ id: i.id, grossTotal: i.currentVersion!.grossTotal })), client);
  const invoices = invoiceRows.map((i) => {
    const f = fin.get(i.id);
    return { id: i.id, number: i.number, kind: i.kind, status: i.status, grossCents: toCents(i.currentVersion?.grossTotal ?? 0), openCents: f?.openCents ?? 0, creditCents: f?.refundRemainingCents ?? 0 };
  });
  const deposit = b.securityDeposit ? { ...balanceOf(b.securityDeposit.expectedAmountCents, b.securityDeposit.events), depositId: b.securityDeposit.id } : null;
  const blockers: string[] = [];
  const warnings: string[] = [];
  // Befehl 29 Phase E: geschlossener Unfallersatzfall – kein Storno, bis der Fall wieder geöffnet ist (Vorschau, Prüfung und Abschluss)
  if (await accidentCaseClosed(client, tenantId, b.id)) blockers.push(ACCIDENT_CASE_CLOSED_MESSAGE);
  if (b.status === "CANCELLED") blockers.push("Diese Buchung ist bereits storniert.");
  else if (b.status === "ACTIVE") blockers.push("Das Fahrzeug ist bereits übergeben. Eine laufende Miete wird über die Rückgabe beendet, nicht storniert.");
  else if (b.status === "RETURNED") blockers.push("Diese Miete ist abgeschlossen und kann nicht mehr storniert werden.");
  const contractState = !b.contract ? "NONE" : (b.contract.status as CancellationOverview["contract"]["state"]);
  if (b.contract?.status === "SIGNED") warnings.push(`Für diese Buchung wurde bereits ein Mietvertrag erstellt (${b.contract.number}). Der unterschriebene Mietvertrag bleibt unverändert archiviert; er wird als zur stornierten Buchung gehörend gekennzeichnet.`);
  else if (b.contract?.status === "DRAFT") warnings.push("Der Mietvertragsentwurf wird verworfen.");
  if (handoverDrafts > 0) warnings.push("Ein begonnener Übergabe-Entwurf wird verworfen.");
  const openAmendments = b.contractAmendments.filter((a) => a.status === "DRAFT" || a.status === "AGREED");
  if (openAmendments.some((a) => a.status === "AGREED")) warnings.push("Eine vereinbarte, noch nicht unterschriebene Vertragsänderung wird zurückgenommen; die Fahrzeugreservierung entfällt.");
  else if (openAmendments.length > 0) warnings.push("Ein offener Nachtrag-Entwurf wird verworfen.");
  if (invoiceRows.length > 0) warnings.push(`Zu dieser Buchung gibt es Rechnungen (${invoiceRows.map((i) => i.number ?? "Entwurf").join(", ")}). Sie bleiben unverändert bestehen.`);
  const missing = invoiceSettingsMissing(b.tenant);
  return {
    booking: { id: b.id, number: b.number, status: b.status, statusLabel: BOOKING_STATUS[b.status as BookingStatus] ?? b.status, startAt: b.startAt, endAt: b.endAt, customerId: b.customerId, customerName: nameOf(b.customer), vehicle: `${b.vehicle.make} ${b.vehicle.model}`.trim(), plate: b.vehicle.plate },
    contract: { state: contractState, number: b.contract?.number ?? null },
    finances: {
      // Unfallersatz: storniert wird nur vor der Übergabe – es gibt keinen Mietwert und keinen Schätzpreis (nie „0,00 €“ als Mietpreis)
      ...(b.rentalType === "ACCIDENT_REPLACEMENT" ? { agreedCents: 0, agreedSource: "ACCIDENT" as const } : { agreedCents: summary.grossCents, agreedSource: summary.source }),
      prepaidCents: pre.paidCents,
      invoices,
      openReceivableCents: invoices.reduce((a, i) => a + i.openCents, 0),
      customerCreditCents: invoices.reduce((a, i) => a + i.creditCents, 0),
      deposit,
    },
    amendments: b.contractAmendments,
    allowed: blockers.length === 0,
    blockers,
    warnings,
    needs: { refundDecision: pre.remainingCents > 0, depositDecision: (deposit?.remainingCents ?? 0) > 0 },
    fee: { available: missing.length === 0, blockedReason: missing.length ? `Für eine Stornogebühr muss der Inhaber zuerst in den Einstellungen ergänzen: ${missing.join("; ")}.` : null, pricesIncludeTax: b.tenant.pricesIncludeTax ?? true, standardRateBp: toBasisPoints(b.tenant.defaultTaxRate ?? 0) },
  };
}

// ---------------------------------------------------------------------------
// Abrechnungsplan (rein, für Vorschau und Abschluss)
// ---------------------------------------------------------------------------

type PayoutChoice = Omit<PayoutInput, "amount" | "idempotencyKey"> & { amount?: string | number | null; confirmed: boolean };
export type RefundDecision = { mode: "PAYOUT"; payout: PayoutChoice } | { mode: "CREDIT" };
export type DepositDecision = { mode: "RELEASE"; method?: string | null; payout?: PayoutChoice | null } | { mode: "KEEP" };
export type CancellationInput = {
  reason: string;
  /** einmaliger Formularschlüssel (8–56 Zeichen); ohne Schlüssel wird einer erzeugt (nur interne Aufrufe) */
  idempotencyKey?: string | null;
  fee?: { amount: string | number; description: string; taxTreatment: string } | null;
  refund?: RefundDecision | null;
  deposit?: DepositDecision | null;
};

export type CancellationPlan = {
  fee: { unitPriceCents: Cents; netCents: Cents; taxCents: Cents; grossCents: Cents; taxRateBp: number; taxTreatment: CancellationFeeTaxTreatment; description: string } | null;
  prepaidCents: Cents;
  creditCents: Cents;
  stillOwedCents: Cents;
  refund: { mode: "PAYOUT" | "CREDIT" | "NONE"; amountCents: Cents; remainingCreditCents: Cents };
  deposit: { mode: "RELEASE" | "KEEP" | "NONE"; availableCents: Cents; releaseCents: Cents; payoutCents: Cents; keptCents: Cents };
  errors: string[];
};

function parseCents(v: string | number | null | undefined, what: string): Cents {
  try { return toCents(v ?? ""); } catch { throw new DomainError(`Bitte einen gültigen Betrag für ${what} eingeben (z. B. 90,00).`); }
}

/** Was der Abschluss tun würde – ohne Datenbank. Fehler werden gesammelt (Vorschau) bzw. beim Abschluss geworfen. */
export function planCancellation(ov: CancellationOverview, input: CancellationInput): CancellationPlan {
  const errors: string[] = [];
  const reason = (input.reason ?? "").replace(/\s+/g, " ").trim();
  if (reason.length < 3) errors.push("Bitte den Grund der Stornierung angeben.");
  if (reason.length > CANCELLATION_REASON_MAX) errors.push(`Der Grund ist zu lang (höchstens ${CANCELLATION_REASON_MAX} Zeichen).`);
  errors.push(...ov.blockers);
  let fee: CancellationPlan["fee"] = null;
  if (input.fee) {
    try {
      if (!ov.fee.available) throw new DomainError(ov.fee.blockedReason ?? "Eine Stornogebühr ist derzeit nicht möglich.");
      const amount = parseCents(input.fee.amount, "die Stornogebühr");
      if (amount <= 0) throw new DomainError("Die Stornogebühr muss größer als 0,00 € sein.");
      if (amount > 100_000_000) throw new DomainError("Die Stornogebühr ist unplausibel hoch.");
      if (!(input.fee.taxTreatment in CANCELLATION_FEE_TAX_TREATMENTS)) throw new DomainError("Bitte die steuerliche Behandlung der Stornogebühr auswählen.");
      const description = (input.fee.description ?? "").replace(/\s+/g, " ").trim();
      if (description.length < 3) throw new DomainError("Bitte die Stornogebühr kurz beschreiben (z. B. „Stornogebühr laut Mietbedingungen“).");
      if (description.length > 300) throw new DomainError("Die Beschreibung der Stornogebühr ist zu lang (höchstens 300 Zeichen).");
      const taxTreatment = input.fee.taxTreatment as CancellationFeeTaxTreatment;
      const taxRateBp = taxTreatment === "NON_TAXABLE_FEE" ? 0 : ov.fee.standardRateBp;
      const a = lineAmounts(ov.fee.pricesIncludeTax ? "GROSS" : "NET", 100, amount, taxRateBp);
      fee = { unitPriceCents: amount, netCents: a.net, taxCents: a.tax, grossCents: a.gross, taxRateBp, taxTreatment, description };
    } catch (e) {
      errors.push(e instanceof DomainError ? e.message : "Ungültige Stornogebühr.");
    }
  }
  const prepaid = ov.finances.prepaidCents;
  const credit = fee ? Math.max(0, prepaid - fee.grossCents) : prepaid;
  const owed = fee ? Math.max(0, fee.grossCents - prepaid) : 0;
  const refund: CancellationPlan["refund"] = { mode: "NONE", amountCents: 0, remainingCreditCents: credit };
  if (credit > 0) {
    if (!input.refund) errors.push(`Bitte festlegen, was mit der Mietvorauszahlung geschieht: ${fmtCents(credit)} auszahlen oder als Kundenguthaben stehen lassen.`);
    else if (input.refund.mode === "CREDIT") refund.mode = "CREDIT";
    else {
      try {
        const amt = input.refund.payout.amount == null || input.refund.payout.amount === "" ? credit : parseCents(input.refund.payout.amount, "die Erstattung");
        if (amt <= 0) throw new DomainError("Der Erstattungsbetrag muss größer als 0,00 € sein.");
        if (amt > credit) throw new DomainError(`Zu erstatten sind höchstens ${fmtCents(credit)}; eingegeben wurden ${fmtCents(amt)}.`);
        if (!input.refund.payout.confirmed) throw new DomainError("Bitte bestätigen, dass die Erstattung tatsächlich ausgezahlt wurde.");
        if (!(input.refund.payout.method in PAYOUT_METHODS)) throw new DomainError("Bitte den Auszahlungsweg der Erstattung wählen.");
        refund.mode = "PAYOUT"; refund.amountCents = amt; refund.remainingCreditCents = credit - amt;
      } catch (e) {
        errors.push(e instanceof DomainError ? e.message : "Ungültige Erstattung.");
      }
    }
  }
  const available = ov.finances.deposit?.remainingCents ?? 0;
  const deposit: CancellationPlan["deposit"] = { mode: "NONE", availableCents: available, releaseCents: 0, payoutCents: 0, keptCents: 0 };
  if (available > 0) {
    if (!input.deposit) errors.push(`Bitte entscheiden, was mit der erhaltenen Kaution (${fmtCents(available)}) geschieht: freigeben oder vorerst behalten.`);
    else if (input.deposit.mode === "KEEP") { deposit.mode = "KEEP"; deposit.keptCents = available; }
    else {
      deposit.mode = "RELEASE"; deposit.releaseCents = available;
      if (input.deposit.payout) {
        try {
          const amt = input.deposit.payout.amount == null || input.deposit.payout.amount === "" ? available : parseCents(input.deposit.payout.amount, "die Kautionsrückzahlung");
          if (amt <= 0) throw new DomainError("Der Rückzahlungsbetrag der Kaution muss größer als 0,00 € sein.");
          if (amt > available) throw new DomainError(`Zurückgezahlt werden können höchstens ${fmtCents(available)} Kaution.`);
          if (!input.deposit.payout.confirmed) throw new DomainError("Bitte bestätigen, dass die Kaution tatsächlich zurückgezahlt wurde.");
          if (!(input.deposit.payout.method in PAYOUT_METHODS)) throw new DomainError("Bitte den Auszahlungsweg der Kautionsrückzahlung wählen.");
          deposit.payoutCents = amt;
        } catch (e) {
          errors.push(e instanceof DomainError ? e.message : "Ungültige Kautionsrückzahlung.");
        }
      }
    }
  }
  return { fee, prepaidCents: prepaid, creditCents: credit, stillOwedCents: owed, refund, deposit, errors };
}

export async function previewCancellation(tenantId: string, bookingId: string, input: CancellationInput): Promise<{ overview: CancellationOverview; plan: CancellationPlan }> {
  const overview = await cancellationOverview(tenantId, bookingId);
  return { overview, plan: planCancellation(overview, input) };
}

/** Befehl 27 (Dialog): kompakte Prüfung – bleibt als schlanke Sicht auf die Übersicht erhalten. */
export async function cancellationCheck(tenantId: string, bookingId: string, client: Client = db) {
  const ov = await cancellationOverview(tenantId, bookingId, client);
  return { booking: { id: ov.booking.id, number: ov.booking.number, status: ov.booking.status, startAt: ov.booking.startAt, endAt: ov.booking.endAt, customerName: ov.booking.customerName, vehicle: ov.booking.vehicle, plate: ov.booking.plate }, allowed: ov.allowed, blockers: ov.blockers, warnings: ov.warnings };
}

// ---------------------------------------------------------------------------
// Eingefrorene Storno-Abrechnung (Grundlage der Stornobestätigung)
// ---------------------------------------------------------------------------

export type CancellationSnapshot = {
  v: 1;
  bookingNumber: string;
  cancelledAt: string;
  cancelledByName: string;
  reason: string;
  previousStatus: string;
  company: CompanySnapshot;
  customer: { name: string; number: string | null; addressLines: string[]; email: string | null };
  vehicle: { label: string; plate: string };
  period: { startAt: string; endAt: string | null }; // endAt null = offenes Mietende (Unfallersatz)
  contract: { number: string; signed: boolean } | null;
  finances: {
    agreedCents: Cents;
    agreedSource: string;
    prepaidCents: Cents;
    fee: { invoiceNumber: string | null; netCents: Cents; taxCents: Cents; grossCents: Cents; taxRateBp: number; taxTreatment: string; taxTreatmentLabel: string; description: string } | null;
    creditCents: Cents;
    stillOwedCents: Cents;
    refund: { mode: "PAYOUT" | "CREDIT" | "NONE"; amountCents: Cents; payoutNumber: string | null; methodLabel: string | null; remainingCreditCents: Cents };
    deposit: { receivedCents: Cents; releasedCents: Cents; payoutCents: Cents; payoutNumber: string | null; keptCents: Cents; mode: "RELEASE" | "KEEP" | "NONE"; earlierReleasedCents: Cents; retainedCents: Cents; offsetCents: Cents } | null;
  };
  /** Belege, die unverändert bestehen bleiben (Rechnungsnummern) */
  keptDocuments: string[];
  discardedAmendments: number;
};

export type CancellationResult = {
  bookingId: string;
  created: boolean;
  snapshot: CancellationSnapshot | null;
  feeInvoiceId: string | null;
  feeVersionId: string | null;
  payoutIds: string[];
  orphanedStorageKeys: string[];
};

function customerOf(contractSnapshot: unknown, customer: { number: string | null; type: string; companyName: string | null; firstName: string; lastName: string; street: string | null; zip: string | null; city: string | null; country: string | null; email: string | null }) {
  const c = (contractSnapshot ?? customer) as { number?: string | null; type?: string | null; companyName?: string | null; firstName?: string | null; lastName?: string | null; street?: string | null; zip?: string | null; city?: string | null; country?: string | null; email?: string | null };
  const person = [c.firstName, c.lastName].filter(Boolean).join(" ");
  const name = c.companyName?.trim() ? `${c.companyName.trim()}${person ? ` (${person})` : ""}` : person || "Mieter";
  return { name, number: c.number ?? customer.number ?? null, addressLines: [c.street, [c.zip, c.city].filter(Boolean).join(" "), c.country && c.country !== "DE" ? c.country : null].filter((x): x is string => !!x), email: c.email?.trim() || null };
}

// ---------------------------------------------------------------------------
// Abschluss
// ---------------------------------------------------------------------------

function checkKey(key: string | null | undefined): string {
  const k = key?.trim() || randomUUID();
  if (!/^[A-Za-z0-9-]{8,56}$/.test(k)) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  return k;
}

async function existingResult(tenantId: string, key: string): Promise<CancellationResult | null> {
  const b = await db.booking.findUnique({ where: { tenantId_cancellationKey: { tenantId, cancellationKey: key } }, select: { id: true, cancellationSnapshot: true } });
  if (!b) return null;
  const fee = await db.invoice.findFirst({ where: { tenantId, bookingId: b.id, kind: "CANCELLATION_FEE", documentType: "INVOICE" }, select: { id: true, currentVersionId: true } });
  const payouts = await db.payout.findMany({ where: { tenantId, bookingId: b.id, idempotencyKey: { startsWith: key } }, select: { id: true } });
  return { bookingId: b.id, created: false, snapshot: b.cancellationSnapshot as unknown as CancellationSnapshot, feeInvoiceId: fee?.id ?? null, feeVersionId: fee?.currentVersionId ?? null, payoutIds: payouts.map((p) => p.id), orphanedStorageKeys: [] };
}

const payoutInputOf = (p: PayoutChoice, amountCents: Cents, key: string, now: Date): PayoutInput => ({
  amount: (amountCents / 100).toFixed(2), method: p.method, methodDescription: p.methodDescription ?? null, executedAt: p.executedAt ?? now,
  recipientName: p.recipientName ?? null, recipientReason: p.recipientReason ?? null, iban: p.iban ?? null, reference: p.reference ?? null,
  receiptConfirmed: p.receiptConfirmed ?? false, historicalEntry: false, customerNote: p.customerNote ?? null, internalNote: p.internalNote ?? null, idempotencyKey: key,
});

/**
 * Storno abschließen. Alles oder nichts: Status, Vertrag, Entwürfe, Stornogebühr, Zuordnung der Vorauszahlung, Erstattung,
 * Kautionsfreigabe, eingefrorene Abrechnung und Audit entstehen in einer Transaktion. Nachbearbeitung (PDF) über
 * runCancellationFollowUp danach.
 */
export async function cancelBooking(tenantId: string, actor: Actor, bookingId: string, input: CancellationInput): Promise<CancellationResult> {
  if (!actor?.id) throw new DomainError("Ein Storno braucht einen angemeldeten Benutzer.");
  const key = checkKey(input.idempotencyKey);
  const reason = (input.reason ?? "").replace(/\s+/g, " ").trim();
  if (reason.length < 3) throw new DomainError("Bitte den Grund der Stornierung angeben.");
  if (reason.length > CANCELLATION_REASON_MAX) throw new DomainError(`Der Grund ist zu lang (höchstens ${CANCELLATION_REASON_MAX} Zeichen).`);
  const done = await existingResult(tenantId, key);
  if (done) {
    if (done.bookingId !== bookingId) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
    return done;
  }
  const run = () => db.$transaction(async (tx) => {
    // Sperrfolge: (Unfallersatzfall →) Buchung → Kaution (danach Rechnung, Zahlungen, Auszahlungen)
    await assertAccidentCaseOpen(tx, tenantId, bookingId);
    const locked = await tx.$queryRaw<{ id: string; cancellationKey: string | null }[]>`SELECT "id", "cancellationKey" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    if (locked[0].cancellationKey === key) return null; // paralleler Klick mit demselben Schlüssel war schneller
    await tx.$queryRaw`SELECT "id" FROM "SecurityDeposit" WHERE "bookingId" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const ov = await cancellationOverview(tenantId, bookingId, tx);
    if (ov.blockers.length > 0) throw new DomainError(ov.blockers[0]);
    const plan = planCancellation(ov, { ...input, reason });
    if (plan.errors.length > 0) throw new DomainError(plan.errors[0]);
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { tenant: true, customer: true, vehicle: true, contract: { select: { id: true, number: true, status: true, customerSnapshot: true } } } });
    const now = new Date();

    // 1) Vertrag, Übergabe-Entwürfe, offene Nachträge
    const contract = await cancelContractOf(tx, tenantId, bookingId);
    const orphanedStorageKeys = await discardHandoverDrafts(tx, tenantId, bookingId);
    const open = ov.amendments.filter((a) => a.status === "DRAFT" || a.status === "AGREED");
    for (const a of open) await discardAmendmentIn(tx, tenantId, actor, a.id, `Buchung storniert: ${reason}`.slice(0, 500));

    // 2) Buchungsstatus (Voraussetzung für Stornogebühr und Erstattung der Vorauszahlung – DB-Regeln)
    await tx.booking.update({ where: { id: bookingId }, data: { status: "CANCELLED", cancelledAt: now, cancellationReason: reason, cancelledById: actor.id, cancelledByName: actor.name, cancellationKey: key } });

    // 3) Stornogebühr: eigene Rechnung; Mietvorauszahlungen werden ihr zugeordnet (bestehender Weg beim Abschluss)
    let feeInvoice: { id: string; number: string | null; versionId: string } | null = null;
    if (plan.fee) {
      const draft = await createCancellationFeeInvoiceDraft(tx, tenantId, actor, { bookingId, amountCents: plan.fee.unitPriceCents, description: plan.fee.description, taxTreatment: plan.fee.taxTreatment });
      const v = await finalizeInvoiceIn(tx, tenantId, draft.id, actor, { confirmOverpayment: true });
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: draft.id }, select: { id: true, number: true } });
      feeInvoice = { id: inv.id, number: inv.number, versionId: v.id };
      await recordAudit(tx, tenantId, actor, { action: "CANCELLATION_FEE_CREATED", bookingId, invoiceId: inv.id, amountCents: plan.fee.grossCents, details: { bookingNumber: booking.number, invoiceNumber: inv.number, netCents: plan.fee.netCents, taxCents: plan.fee.taxCents, taxTreatment: plan.fee.taxTreatment, prepaidCents: plan.prepaidCents } });
    }

    // 4) Mietvorauszahlung: Erstattung (Auszahlung, tatsächlich erfolgt) oder bewusst als Kundenguthaben stehen lassen
    const payoutIds: string[] = [];
    const credit = feeInvoice ? (await invoiceFinancials(tenantId, feeInvoice.id, tx)).refundRemainingCents : (await prepaymentBalance(tenantId, bookingId, tx)).remainingCents;
    if (credit !== plan.creditCents) throw new DomainError("Der Stand der Mietzahlungen hat sich geändert. Bitte den Storno-Assistenten neu laden.");
    let refundPayout: { id: string; number: string | null; method: string } | null = null;
    const refundRef: SourceRef = feeInvoice ? { sourceType: "INVOICE_REFUND", invoiceId: feeInvoice.id } : { sourceType: "RENTAL_PREPAYMENT_REFUND", bookingId };
    if (plan.refund.mode === "PAYOUT" && input.refund?.mode === "PAYOUT") {
      const r = await createPayoutIn(tx, tenantId, actor, refundRef, payoutInputOf(input.refund.payout, plan.refund.amountCents, `${key}-r`, now), { complete: true, confirmed: input.refund.payout.confirmed });
      refundPayout = { id: r.payout.id, number: r.payout.number, method: r.payout.method };
      payoutIds.push(r.payout.id);
      await recordAudit(tx, tenantId, actor, { action: "RENTAL_PAYMENT_REFUND_CREATED", bookingId, invoiceId: feeInvoice?.id ?? null, amountCents: plan.refund.amountCents, details: { bookingNumber: booking.number, payoutId: r.payout.id, payoutNumber: r.payout.number, source: refundRef.sourceType, creditCents: credit, remainingCreditCents: plan.refund.remainingCreditCents } });
    }
    if (plan.refund.remainingCreditCents > 0 && (plan.refund.mode === "CREDIT" || plan.refund.mode === "PAYOUT")) {
      await recordAudit(tx, tenantId, actor, { action: "RENTAL_PAYMENT_TO_CREDIT", bookingId, invoiceId: feeInvoice?.id ?? null, amountCents: plan.refund.remainingCreditCents, details: { bookingNumber: booking.number, source: refundRef.sourceType, invoiceNumber: feeInvoice?.number ?? null } });
    }

    // 5) Kaution: freigeben (bestehender Weg) und optional Rückzahlung dokumentieren – nie mit der Gebühr verrechnet
    let depositPayout: { id: string; number: string | null } | null = null;
    if (plan.deposit.mode === "RELEASE" && input.deposit?.mode === "RELEASE") {
      await settleDepositIn(tx, tenantId, actor, { bookingId, releaseAmount: (plan.deposit.releaseCents / 100).toFixed(2), method: input.deposit.method ?? input.deposit.payout?.method ?? null, note: "Freigabe beim Storno der Buchung", occurredAt: now, idempotencyKey: `${key}-d` });
      if (input.deposit.payout && plan.deposit.payoutCents > 0) {
        const r = await createPayoutIn(tx, tenantId, actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId }, payoutInputOf(input.deposit.payout, plan.deposit.payoutCents, `${key}-dp`, now), { complete: true, confirmed: input.deposit.payout.confirmed });
        depositPayout = { id: r.payout.id, number: r.payout.number };
        payoutIds.push(r.payout.id);
      }
      await recordAudit(tx, tenantId, actor, { action: "DEPOSIT_RELEASED_ON_CANCELLATION", bookingId, depositId: ov.finances.deposit?.depositId ?? null, amountCents: plan.deposit.releaseCents, details: { bookingNumber: booking.number, releasedCents: plan.deposit.releaseCents, payoutId: depositPayout?.id ?? null, payoutNumber: depositPayout?.number ?? null } });
    }

    // 6) eingefrorene Storno-Abrechnung + Prüfsumme
    const dep = ov.finances.deposit;
    const snapshot: CancellationSnapshot = {
      v: 1,
      bookingNumber: booking.number,
      cancelledAt: now.toISOString(),
      cancelledByName: actor.name,
      reason,
      previousStatus: BOOKING_STATUS[booking.status as BookingStatus] ?? booking.status,
      company: companySnapshotOf(booking.tenant),
      customer: customerOf(booking.contract && booking.contract.status !== "DRAFT" ? booking.contract.customerSnapshot : null, booking.customer),
      vehicle: { label: `${booking.vehicle.make} ${booking.vehicle.model}`.trim(), plate: booking.vehicle.plate },
      period: { startAt: booking.startAt.toISOString(), endAt: booking.endAt?.toISOString() ?? null },
      contract: contract && contract.status !== "DRAFT" ? { number: contract.number, signed: contract.status === "SIGNED" } : null,
      finances: {
        agreedCents: ov.finances.agreedCents,
        agreedSource: ov.finances.agreedSource,
        prepaidCents: plan.prepaidCents,
        fee: plan.fee ? { invoiceNumber: feeInvoice?.number ?? null, netCents: plan.fee.netCents, taxCents: plan.fee.taxCents, grossCents: plan.fee.grossCents, taxRateBp: plan.fee.taxRateBp, taxTreatment: plan.fee.taxTreatment, taxTreatmentLabel: CANCELLATION_FEE_TAX_TREATMENTS[plan.fee.taxTreatment], description: plan.fee.description } : null,
        creditCents: plan.creditCents,
        stillOwedCents: plan.stillOwedCents,
        refund: { mode: plan.refund.mode, amountCents: plan.refund.amountCents, payoutNumber: refundPayout?.number ?? null, methodLabel: refundPayout ? PAYOUT_METHODS[refundPayout.method as PayoutMethod] ?? refundPayout.method : null, remainingCreditCents: plan.refund.remainingCreditCents },
        deposit: dep ? { receivedCents: dep.receivedCents, releasedCents: plan.deposit.releaseCents, payoutCents: plan.deposit.payoutCents, payoutNumber: depositPayout?.number ?? null, keptCents: plan.deposit.keptCents, mode: plan.deposit.mode, earlierReleasedCents: dep.releasedCents, retainedCents: dep.retainedCents, offsetCents: dep.offsetCents } : null,
      },
      keptDocuments: ov.finances.invoices.filter((i) => i.number).map((i) => i.number!),
      discardedAmendments: open.length,
    };
    await tx.booking.update({ where: { id: bookingId }, data: { cancellationSnapshot: snapshot as unknown as Prisma.InputJsonValue, cancellationHash: contentHash(snapshot) } });

    // 7) Audit des Stornos (fachliche IDs und Beträge, keine Personendaten im Klartext)
    await recordAudit(tx, tenantId, actor, {
      action: "BOOKING_CANCELLED", bookingId,
      details: {
        bookingNumber: booking.number, reason, previousStatus: snapshot.previousStatus,
        contract: contract ? `${contract.number ?? "Entwurf"} (${contract.status})` : null,
        prepaidCents: plan.prepaidCents, feeCents: plan.fee?.grossCents ?? 0, feeInvoiceNumber: feeInvoice?.number ?? null,
        refundMode: plan.refund.mode, refundCents: plan.refund.amountCents, creditCents: plan.refund.remainingCreditCents, stillOwedCents: plan.stillOwedCents,
        depositMode: plan.deposit.mode, depositReleasedCents: plan.deposit.releaseCents, depositPayoutCents: plan.deposit.payoutCents, depositKeptCents: plan.deposit.keptCents,
        warnings: ov.warnings.length, discardedAmendments: open.length,
      },
    });
    return { bookingId, created: true, snapshot, feeInvoiceId: feeInvoice?.id ?? null, feeVersionId: feeInvoice?.versionId ?? null, payoutIds, orphanedStorageKeys } satisfies CancellationResult;
  }, TX);
  try {
    const res = await withNumberRetry(run);
    if (res) return res;
  } catch (e) {
    if (!isUniqueViolation(e, "cancellationKey")) throw e;
  }
  const again = await existingResult(tenantId, key);
  if (again) return again;
  throw new DomainError("Diese Buchung ist bereits storniert.");
}
