// Rechnungsdarstellung (ViewModel) für Ansicht und PDF. Liest ausschließlich eine Rechnungsfassung (InvoiceVersion mit
// Positionen) und die Nummer der logischen Rechnung; nichts wird nachgerechnet oder aus Stammdaten nachgeladen. Frei von Server-Importen.

import type { Prisma } from "@prisma/client";
import { DAMAGE_TAX_NOTES, DAMAGE_TAX_TREATMENTS, type DamageTaxTreatment } from "@/lib/constants";
import { fmtCents, fmtRate, summarize, toBasisPoints, toCents } from "@/lib/money";
import { APP_TIME_ZONE } from "@/lib/time";
import type { CompanySnapshot, InvoiceCustomerSnapshot } from "@/lib/invoices";

export type VersionInfo = {
  versionNo: number;
  kind: "ORIGINAL" | "REVISION" | "CORRECTION";
  /** Datum der Berichtigung/Neufassung (Fassung >= 2) */
  correctionDate: string | null;
  /** Vorfassung, die diese Fassung ersetzt */
  supersedes: { versionNo: number; finalizedAt: string | null } | null;
  reason: string | null;
  isCurrent: boolean;
};

/** Bezug eines Gegenbelegs auf seine Originalrechnung (aus dem unveränderlichen Snapshot) */
export type OriginalRef = { number: string; date: string | null; versionNo: number; gross: string; customerName: string };

export type InvoiceDocumentData = {
  title: string;
  /** INVOICE = Rechnung, CREDIT_NOTE = Gutschrift, CANCELLATION = Stornobeleg (Phase 17) */
  documentType: "INVOICE" | "CREDIT_NOTE" | "CANCELLATION";
  /** nur Gegenbelege: „Zu Rechnung RE-… vom …“ */
  original: OriginalRef | null;
  /** nur Gegenbelege: Grund der Gutschrift / des Stornos (erscheint auf dem Beleg) */
  reason: string | null;
  /** RENTAL = Mietrechnung, DAMAGE = Schadenabrechnung */
  kind: "RENTAL" | "DAMAGE";
  number: string;
  status: string;
  version: VersionInfo;
  issueDate: string | null;
  servicePeriod: string;
  reference: { contractNumber: string | null; bookingNumber: string | null; returnNumber: string | null; caseNumber: string | null };
  company: CompanySnapshot & { fullName: string; addressLines: string[]; taxLine: string | null; bankLines: string[] };
  customer: { name: string; number: string | null; addressLines: string[]; email: string | null };
  pricesIncludeTax: boolean;
  items: { index: number; description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; net: string; tax: string; gross: string; source: string }[];
  taxSummary: { rate: string; net: string; tax: string; gross: string }[];
  totals: { net: string; tax: string; gross: string };
  paymentDueDate: string | null;
  paymentTermDays: number | null;
  customerNote: string | null;
  taxNote: string | null;
  hasZeroRate: boolean;
  /** Steuerliche Behandlung der Fassung (nur Schadenabrechnung); nonTaxable = echter Schadensersatz: kein Steuersatz, kein USt-Ausweis */
  taxTreatment: DamageTaxTreatment | null;
  taxTreatmentLabel: string | null;
  taxTreatmentNote: string | null;
  nonTaxable: boolean;
  contentHash: string | null;
};

const date = (d: Date | null | undefined) => (d ? d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }) : null);
const dateTime = (d: Date) => d.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const qty = (v: unknown) => Number(String(v)).toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

type VersionFull = Prisma.InvoiceVersionGetPayload<{ include: { items: true } }>;
export type DocumentRefs = { number: string | null; kind: string; contractNumber: string | null; bookingNumber: string | null; returnNumber: string | null; caseNumber: string | null; isCurrent: boolean; supersedes: { versionNo: number; finalizedAt: Date | null } | null; documentType?: string; original?: { number: string; issueDate: string | null; versionNo: number; grossTotal: string; customerName: string } | null };

export const DOCUMENT_TITLES = { INVOICE: "Rechnung", CREDIT_NOTE: "Gutschrift", CANCELLATION: "Stornobeleg" } as const;

export function buildInvoiceDocument(inv: VersionFull, refs: DocumentRefs): InvoiceDocumentData {
  const company = inv.companySnapshot as CompanySnapshot;
  const c = inv.customerSnapshot as InvoiceCustomerSnapshot;
  const items = [...inv.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const sums = summarize(items.map((i) => ({ taxRateBp: toBasisPoints(i.taxRate), amounts: { net: toCents(i.netAmount), tax: toCents(i.taxAmount), gross: toCents(i.grossAmount) } })));
  const personName = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  const kind = inv.kind as VersionInfo["kind"];
  const invoiceKind = refs.kind === "DAMAGE" ? "DAMAGE" : "RENTAL";
  const taxTreatment = inv.taxTreatment && inv.taxTreatment in DAMAGE_TAX_TREATMENTS ? (inv.taxTreatment as DamageTaxTreatment) : null;
  const nonTaxable = taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION";
  const documentType = refs.documentType === "CREDIT_NOTE" || refs.documentType === "CANCELLATION" ? refs.documentType : "INVOICE";
  const baseTitle = documentType !== "INVOICE" ? DOCUMENT_TITLES[documentType] : invoiceKind === "DAMAGE" ? "Schadenabrechnung" : "Rechnung";
  const o = refs.original ?? null;
  return {
    title: kind === "CORRECTION" ? `Berichtigte ${baseTitle}` : baseTitle,
    documentType,
    original: o ? { number: o.number, date: date(o.issueDate ? new Date(o.issueDate) : null), versionNo: o.versionNo, gross: fmtCents(toCents(o.grossTotal)), customerName: o.customerName } : null,
    reason: documentType !== "INVOICE" ? inv.reason : null,
    kind: invoiceKind,
    number: refs.number ?? "Entwurf",
    status: inv.status,
    version: {
      versionNo: inv.versionNo,
      kind,
      correctionDate: date(inv.correctionDate),
      supersedes: refs.supersedes ? { versionNo: refs.supersedes.versionNo, finalizedAt: date(refs.supersedes.finalizedAt) } : null,
      reason: kind === "CORRECTION" ? inv.reason : null,
      isCurrent: refs.isCurrent,
    },
    issueDate: date(inv.issueDate),
    servicePeriod: `${dateTime(inv.servicePeriodStart)} bis ${dateTime(inv.servicePeriodEnd)}`,
    reference: { contractNumber: refs.contractNumber, bookingNumber: refs.bookingNumber, returnNumber: refs.returnNumber, caseNumber: refs.caseNumber },
    company: {
      ...company,
      fullName: [company.name, company.legalForm].filter(Boolean).join(" "),
      addressLines: [company.street, [company.zip, company.city].filter(Boolean).join(" "), company.country && company.country !== "DE" ? company.country : null].filter((x): x is string => !!x),
      taxLine: [company.vatId ? `USt-IdNr. ${company.vatId}` : null, company.taxNumber ? `Steuernummer ${company.taxNumber}` : null].filter(Boolean).join(" · ") || null,
      bankLines: [company.bankName ? `Bank: ${company.bankName}` : null, company.iban ? `IBAN: ${company.iban}` : null, company.bic ? `BIC: ${company.bic}` : null].filter((x): x is string => !!x),
    },
    customer: {
      name: c.type === "COMPANY" && c.companyName ? (personName ? `${c.companyName}, ${personName}` : c.companyName) : personName,
      number: c.number,
      addressLines: [c.street, [c.zip, c.city].filter(Boolean).join(" "), c.country && c.country !== "DE" ? c.country : null].filter((x): x is string => !!x),
      email: c.email,
    },
    pricesIncludeTax: inv.pricesIncludeTax,
    items: items.map((i, n) => ({ index: n + 1, description: i.description, quantity: qty(i.quantity), unit: i.unit, unitPrice: fmtCents(toCents(i.unitPrice)), taxRate: nonTaxable ? "–" : fmtRate(toBasisPoints(i.taxRate)), net: fmtCents(toCents(i.netAmount)), tax: fmtCents(toCents(i.taxAmount)), gross: fmtCents(toCents(i.grossAmount)), source: i.source })),
    taxSummary: nonTaxable ? [] : sums.byRate.map((r) => ({ rate: fmtRate(r.taxRateBp), net: fmtCents(r.net), tax: fmtCents(r.tax), gross: fmtCents(r.gross) })),
    totals: { net: fmtCents(toCents(inv.netTotal)), tax: fmtCents(toCents(inv.taxTotal)), gross: fmtCents(toCents(inv.grossTotal)) },
    paymentDueDate: date(inv.paymentDueDate),
    paymentTermDays: inv.paymentTermDays,
    customerNote: inv.customerNote,
    taxNote: nonTaxable ? null : inv.taxNote,
    hasZeroRate: !nonTaxable && items.some((i) => toBasisPoints(i.taxRate) === 0),
    taxTreatment,
    taxTreatmentLabel: taxTreatment ? DAMAGE_TAX_TREATMENTS[taxTreatment] : null,
    taxTreatmentNote: taxTreatment ? DAMAGE_TAX_NOTES[taxTreatment] || null : null,
    nonTaxable,
    contentHash: inv.contentHash,
  };
}
