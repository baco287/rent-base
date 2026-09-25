// Auszahlungsbeleg (ViewModel) für Ansicht, PDF und E-Mail. Liest ausschließlich den versiegelten Auszahlungsdatensatz mit seinem
// Quellen-Snapshot; nichts wird nachgerechnet. Frei von Server-Importen. IBAN erscheint nur verschleiert.

import { PAYOUT_METHODS, PAYOUT_SOURCE_TYPES, type PayoutMethod, type PayoutSourceType } from "@/lib/constants";
import { fmtCents } from "@/lib/money";
import { APP_TIME_ZONE } from "@/lib/time";

export type PayoutSourceSnapshot = {
  sourceType: PayoutSourceType;
  bookingNumber: string | null;
  contractNumber: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  /** Belegkette des Originals (Nummern der Gegenbelege) */
  chain: string[];
  customerName: string;
  customerEmail: string | null;
  /** Rechnung: Stand vor dieser Auszahlung */
  invoiceCents?: number;
  effectiveCents?: number;
  paidCents?: number;
  customerCreditCents?: number;
  paidOutBeforeCents?: number;
  /** Kaution: Stand vor dieser Auszahlung */
  expectedCents?: number;
  receivedCents?: number;
  retainedCents?: number;
  releasedCents?: number;
};

export type PayoutDocumentData = {
  number: string;
  status: string;
  sourceType: PayoutSourceType;
  sourceLabel: string;
  title: string;
  executedAt: string | null;
  completedAt: string | null;
  amount: string;
  method: PayoutMethod;
  methodLabel: string;
  methodDescription: string | null;
  recipientName: string;
  recipientDeviates: boolean;
  recipientReason: string | null;
  ibanMasked: string | null;
  reference: string | null;
  receiptConfirmed: boolean;
  historicalEntry: boolean;
  customerNote: string | null;
  referenceLine: string;
  snapshot: PayoutSourceSnapshot;
  company: { name: string; addressLines: string[]; contact: string };
  customer: { name: string };
  contentHash: string | null;
  cancelled: { at: string; reason: string } | null;
  completedByName: string | null;
};

const date = (d: Date | null | undefined) => (d ? d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }) : null);
const dateTime = (d: Date | null | undefined) => (d ? d.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null);

export type PayoutLike = {
  number: string | null;
  status: string;
  sourceType: string;
  amountCents: number;
  method: string;
  methodDescription: string | null;
  executedAt: Date | null;
  completedAt: Date | null;
  completedByName: string | null;
  recipientName: string;
  recipientDeviates: boolean;
  recipientReason: string | null;
  ibanMasked: string | null;
  reference: string | null;
  receiptConfirmed: boolean;
  historicalEntry: boolean;
  customerNote: string | null;
  sourceSnapshot: unknown;
  contentHash: string | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
};

export type CompanyLike = { name: string; legalForm?: string | null; street: string | null; zip: string | null; city: string | null; phone: string | null; email: string | null; website?: string | null };

export function buildPayoutDocument(p: PayoutLike, company: CompanyLike): PayoutDocumentData {
  const sourceType = (p.sourceType === "SECURITY_DEPOSIT_REFUND" ? "SECURITY_DEPOSIT_REFUND" : "INVOICE_REFUND") as PayoutSourceType;
  const method = (p.method in PAYOUT_METHODS ? p.method : "OTHER") as PayoutMethod;
  const snapshot = (p.sourceSnapshot ?? { sourceType, bookingNumber: null, contractNumber: null, invoiceNumber: null, invoiceDate: null, chain: [], customerName: p.recipientName, customerEmail: null }) as PayoutSourceSnapshot;
  const referenceLine = sourceType === "INVOICE_REFUND"
    ? `Erstattung zu Rechnung ${snapshot.invoiceNumber ?? "–"}${snapshot.invoiceDate ? ` vom ${snapshot.invoiceDate}` : ""}${snapshot.chain.length ? ` (Belegkette: ${snapshot.chain.join(", ")})` : ""}`
    : `Kautionsrückzahlung zu Mietvertrag ${snapshot.contractNumber ?? "–"}${snapshot.bookingNumber ? ` / Buchung ${snapshot.bookingNumber}` : ""}`;
  return {
    number: p.number ?? "Entwurf",
    status: p.status,
    sourceType,
    sourceLabel: PAYOUT_SOURCE_TYPES[sourceType],
    title: "Auszahlungsbeleg",
    executedAt: dateTime(p.executedAt),
    completedAt: dateTime(p.completedAt),
    amount: fmtCents(p.amountCents),
    method,
    methodLabel: PAYOUT_METHODS[method],
    methodDescription: p.methodDescription,
    recipientName: p.recipientName,
    recipientDeviates: p.recipientDeviates,
    recipientReason: p.recipientReason,
    ibanMasked: method === "BANK_TRANSFER" ? p.ibanMasked : null,
    reference: p.reference,
    receiptConfirmed: p.receiptConfirmed,
    historicalEntry: p.historicalEntry,
    customerNote: p.customerNote,
    referenceLine,
    snapshot,
    company: {
      name: [company.name, company.legalForm].filter(Boolean).join(" "),
      addressLines: [company.street, [company.zip, company.city].filter(Boolean).join(" ")].filter((x): x is string => !!x),
      contact: [company.phone, company.email, company.website?.replace(/^https?:\/\//i, "")].filter(Boolean).join(" · "),
    },
    customer: { name: snapshot.customerName },
    contentHash: p.contentHash,
    cancelled: p.cancelledAt ? { at: dateTime(p.cancelledAt) ?? "", reason: p.cancellationReason ?? "" } : null,
    completedByName: p.completedByName,
  };
}

export const payoutDateLabel = date;
