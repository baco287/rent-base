// Rechnungsdarstellung (ViewModel) für Ansicht und PDF. Liest ausschließlich eine Rechnungsfassung (InvoiceVersion mit
// Positionen) und die Nummer der logischen Rechnung; nichts wird nachgerechnet oder aus Stammdaten nachgeladen. Frei von Server-Importen.

import type { Prisma } from "@prisma/client";
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

export type InvoiceDocumentData = {
  title: string;
  number: string;
  status: string;
  version: VersionInfo;
  issueDate: string | null;
  servicePeriod: string;
  reference: { contractNumber: string | null; bookingNumber: string | null; returnNumber: string | null };
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
  contentHash: string | null;
};

const date = (d: Date | null | undefined) => (d ? d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }) : null);
const dateTime = (d: Date) => d.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const qty = (v: unknown) => Number(String(v)).toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

type VersionFull = Prisma.InvoiceVersionGetPayload<{ include: { items: true } }>;
export type DocumentRefs = { number: string | null; contractNumber: string | null; bookingNumber: string | null; returnNumber: string | null; isCurrent: boolean; supersedes: { versionNo: number; finalizedAt: Date | null } | null };

export function buildInvoiceDocument(inv: VersionFull, refs: DocumentRefs): InvoiceDocumentData {
  const company = inv.companySnapshot as CompanySnapshot;
  const c = inv.customerSnapshot as InvoiceCustomerSnapshot;
  const items = [...inv.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const sums = summarize(items.map((i) => ({ taxRateBp: toBasisPoints(i.taxRate), amounts: { net: toCents(i.netAmount), tax: toCents(i.taxAmount), gross: toCents(i.grossAmount) } })));
  const personName = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  const kind = inv.kind as VersionInfo["kind"];
  return {
    title: kind === "CORRECTION" ? "Berichtigte Rechnung" : "Rechnung",
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
    reference: refs,
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
    items: items.map((i, n) => ({ index: n + 1, description: i.description, quantity: qty(i.quantity), unit: i.unit, unitPrice: fmtCents(toCents(i.unitPrice)), taxRate: fmtRate(toBasisPoints(i.taxRate)), net: fmtCents(toCents(i.netAmount)), tax: fmtCents(toCents(i.taxAmount)), gross: fmtCents(toCents(i.grossAmount)), source: i.source })),
    taxSummary: sums.byRate.map((r) => ({ rate: fmtRate(r.taxRateBp), net: fmtCents(r.net), tax: fmtCents(r.tax), gross: fmtCents(r.gross) })),
    totals: { net: fmtCents(toCents(inv.netTotal)), tax: fmtCents(toCents(inv.taxTotal)), gross: fmtCents(toCents(inv.grossTotal)) },
    paymentDueDate: date(inv.paymentDueDate),
    paymentTermDays: inv.paymentTermDays,
    customerNote: inv.customerNote,
    taxNote: inv.taxNote,
    hasZeroRate: items.some((i) => toBasisPoints(i.taxRate) === 0),
    contentHash: inv.contentHash,
  };
}
