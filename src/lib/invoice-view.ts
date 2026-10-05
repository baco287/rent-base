// Rechnungsdarstellung (ViewModel) für Ansicht und PDF. Liest ausschließlich eine Rechnungsfassung (InvoiceVersion mit
// Positionen) und die Nummer der logischen Rechnung; nichts wird nachgerechnet oder aus Stammdaten nachgeladen. Frei von Server-Importen.

import type { Prisma } from "@prisma/client";
import { ACCIDENT_BILLING_TYPES, DAMAGE_TAX_NOTES, CANCELLATION_FEE_TAX_NOTE, CANCELLATION_FEE_TAX_TREATMENTS, INVOICE_RECIPIENT_ROLES, accidentBillingOf, type AccidentBillingType, type CancellationFeeTaxTreatment, DAMAGE_TAX_TREATMENTS, type DamageTaxTreatment } from "@/lib/constants";
import { fmtCents, fmtRate, summarize, toBasisPoints, toCents } from "@/lib/money";
import { APP_TIME_ZONE } from "@/lib/time";
import { recipientRoleOf, type CompanySnapshot, type InvoiceCustomerSnapshot } from "@/lib/invoices";

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
  /** Befehl 23: Mahngebühr (eigene Nebenrechnung) – eigener Untertitel statt „Fahrzeugmiete“ */
  dunningFee?: boolean;
  /** Befehl 23.1: freie Rechnung – neutraler Untertitel („Rechnung“), die Leistung ergibt sich aus den Positionen */
  general?: boolean;
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
  /** Befehl 29: roleLabel nur, wenn der Empfänger nicht der Mieter ist (Versicherung / anderer Empfänger); insuredName = Geschädigter/Mieter */
  customer: { name: string; number: string | null; addressLines: string[]; email: string | null; roleLabel: string | null; claimNumber: string | null; insuredName: string | null; accidentDate: string | null; caseNumber: string | null };
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
  taxTreatment: DamageTaxTreatment | CancellationFeeTaxTreatment | null;
  taxTreatmentLabel: string | null;
  taxTreatmentNote: string | null;
  nonTaxable: boolean;
  /** Befehl 28: Bezeichnung der Summenzeile ohne Steuer (Schadensersatz bzw. nicht steuerbare Stornogebühr) */
  nonTaxableLabel?: string;
  contentHash: string | null;
  /**
   * Befehl 27: Zahlungsstand zum Erzeugungszeitpunkt (nur Rechnungen, nur die aktuelle Fassung). Kein Teil der versiegelten
   * Fassung und keine Rechnungsposition: Rechnungsbetrag und Positionen bleiben unverändert.
   */
  paymentStatus?: InvoicePaymentBlock | null;
  /**
   * Befehl 29 Phase F: Unfallersatz – Abrechnungsart und Miettage aus der versiegelten Empfängerkopie, dazu ein sachlicher
   * Erläuterungstext (keine Aussage zur Erstattungsfähigkeit oder Haftung).
   */
  accident?: { type: AccidentBillingType; typeLabel: string; days: number | null; totalDays: number | null; priorDays: number | null; note: string } | null;
};

const date = (d: Date | null | undefined) => (d ? d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }) : null);
const dateTime = (d: Date) => d.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const qty = (v: unknown) => Number(String(v)).toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

type VersionFull = Prisma.InvoiceVersionGetPayload<{ include: { items: true } }>;
export type DocumentRefs = { number: string | null; kind: string; contractNumber: string | null; bookingNumber: string | null; returnNumber: string | null; caseNumber: string | null; isCurrent: boolean; supersedes: { versionNo: number; finalizedAt: Date | null } | null; documentType?: string; original?: { number: string; issueDate: string | null; versionNo: number; grossTotal: string; customerName: string } | null };

export const DOCUMENT_TITLES = { INVOICE: "Rechnung", CREDIT_NOTE: "Gutschrift", CANCELLATION: "Stornobeleg" } as const;

export type InvoicePaymentBlock = { asOf: string; lines: { label: string; value: string; bold?: boolean }[]; open: string; openCents: number; settled: boolean; creditCents: number; credit: string };

/**
 * Befehl 27: Saldoblock aus der zentralen Summierung (counter-documents financialsFor). Zahlungen und Kautionsverrechnung
 * getrennt (Verrechnung ist kein Geldeingang), Gutschriften/Storno mindern die Forderung. null, wenn nichts die Forderung
 * mindert – dann bleibt die bisherige Zahlungsaufforderung über den Rechnungsbetrag.
 */
export function invoicePaymentBlock(f: { invoiceCents: number; creditedCents: number; cancelledCents: number; paidCents: number; offsetCents: number; openCents: number; customerCreditCents: number }, asOf: Date): InvoicePaymentBlock | null {
  const moneyPaid = Math.max(0, f.paidCents - f.offsetCents);
  if (moneyPaid <= 0 && f.offsetCents <= 0 && f.creditedCents <= 0 && f.cancelledCents <= 0) return null;
  const lines: InvoicePaymentBlock["lines"] = [{ label: "Rechnungsbetrag", value: fmtCents(f.invoiceCents) }];
  if (f.creditedCents > 0) lines.push({ label: "abzüglich Gutschriften", value: `− ${fmtCents(f.creditedCents)}` });
  if (f.cancelledCents > 0) lines.push({ label: "abzüglich Storno", value: `− ${fmtCents(f.cancelledCents)}` });
  if (moneyPaid > 0) lines.push({ label: "Bereits bezahlt", value: `− ${fmtCents(moneyPaid)}` });
  if (f.offsetCents > 0) lines.push({ label: "Mit Kaution verrechnet", value: `− ${fmtCents(f.offsetCents)}` });
  const open = Math.max(0, f.openCents);
  lines.push({ label: "Noch offen", value: fmtCents(open), bold: true });
  const asOfText = asOf.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" });
  return { asOf: asOfText, lines, open: fmtCents(open), openCents: open, settled: open === 0, creditCents: Math.max(0, f.customerCreditCents), credit: fmtCents(Math.max(0, f.customerCreditCents)) };
}

const dayText = (n: number) => `${n} ${n === 1 ? "Miettag" : "Miettage"}`;
/** Phase F: Erläuterung einer Unfallersatz-Rechnung aus der versiegelten Kopie – nachvollziehbar, ohne rechtliche Bewertung. */
function accidentBlock(c: InvoiceCustomerSnapshot, items: readonly { source: string; unit: string; quantity: unknown }[]): InvoiceDocumentData["accident"] {
  const b = accidentBillingOf(c);
  if (!b) return null;
  // Miettage dieser Rechnung aus den Positionen (Grundmiete) – auch nach einer bewusst geänderten Menge stimmt der Text mit der Rechnung überein
  const inItems = items.filter((i) => i.source === "RENTAL" && i.unit === "Tag").reduce((s, i) => s + Number(i.quantity), 0);
  const days = b.type === "REMAINDER" ? null : inItems, total = typeof b.totalDays === "number" ? b.totalDays : null, prior = typeof b.priorDays === "number" ? b.priorDays : null;
  const priorText = prior && b.prior?.length ? `, davon ${dayText(prior)} zuvor mit ${b.prior.length === 1 ? "Rechnung" : "den Rechnungen"} ${b.prior.join(", ")} berechnet` : prior ? `, davon ${dayText(prior)} zuvor berechnet` : "";
  const count = "Miettage zählen ab der Fahrzeugübergabe nach Ortszeit; jeder angefangene Zeitraum bis zur gleichen Uhrzeit des Folgetags ist ein Miettag.";
  const note = b.type === "REMAINDER"
    ? `Restforderung zur Rechnung ${b.remainderOf?.number ?? ""}${b.remainderOf?.insurerName ? ` an ${b.remainderOf.insurerName}` : ""}: Betrag aus derselben Unfallersatzmiete, den die Versicherung nicht übernommen hat.`.replace("  ", " ")
    : b.type === "INTERIM"
      ? `Zwischenrechnung über die tatsächliche Mietdauer bis zum Ende des Leistungszeitraums${total != null ? ` (seit der Übergabe ${dayText(total)}${priorText})` : ""}. Diese Rechnung umfasst ${dayText(days ?? 0)}. Die Miete läuft weiter; abgerechnet wird abschließend mit der Schlussrechnung nach der Rückgabe. ${count}`
      : `Schlussrechnung über die tatsächliche Mietdauer von der Übergabe bis zur Rückgabe${total != null ? `: ${dayText(total)}${priorText}` : ""}. Diese Rechnung umfasst ${dayText(days ?? 0)}. ${count}`;
  return { type: b.type, typeLabel: ACCIDENT_BILLING_TYPES[b.type], days, totalDays: total, priorDays: prior, note };
}

export function buildInvoiceDocument(inv: VersionFull, refs: DocumentRefs): InvoiceDocumentData {
  const company = inv.companySnapshot as CompanySnapshot;
  const c = inv.customerSnapshot as InvoiceCustomerSnapshot;
  const items = [...inv.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const sums = summarize(items.map((i) => ({ taxRateBp: toBasisPoints(i.taxRate), amounts: { net: toCents(i.netAmount), tax: toCents(i.taxAmount), gross: toCents(i.grossAmount) } })));
  const personName = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  const kind = inv.kind as VersionInfo["kind"];
  const invoiceKind = refs.kind === "DAMAGE" ? "DAMAGE" : "RENTAL";
  const taxTreatment = inv.taxTreatment && (inv.taxTreatment in DAMAGE_TAX_TREATMENTS || inv.taxTreatment in CANCELLATION_FEE_TAX_TREATMENTS) ? (inv.taxTreatment as DamageTaxTreatment | CancellationFeeTaxTreatment) : null;
  // Befehl 28: nicht steuerbar = Schadensersatz (Schadenabrechnung) oder nicht steuerbare Stornogebühr – kein Steuersatz, kein USt-Ausweis
  const nonTaxable = taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION" || taxTreatment === "NON_TAXABLE_FEE";
  const documentType = refs.documentType === "CREDIT_NOTE" || refs.documentType === "CANCELLATION" ? refs.documentType : "INVOICE";
  const baseTitle = documentType !== "INVOICE" ? DOCUMENT_TITLES[documentType] : invoiceKind === "DAMAGE" ? "Schadenabrechnung" : "Rechnung";
  const o = refs.original ?? null;
  const accident = refs.kind === "ACCIDENT_REPLACEMENT" && documentType === "INVOICE" ? accidentBlock(c, items) : null;
  const title0 = accident && accident.type !== "REMAINDER" ? accident.typeLabel : baseTitle;
  return {
    title: kind === "CORRECTION" ? `Berichtigte ${title0}` : title0,
    accident,
    dunningFee: refs.kind === "DUNNING_FEE",
    general: refs.kind === "GENERAL",
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
      roleLabel: recipientRoleOf(c) === "RENTER" ? null : INVOICE_RECIPIENT_ROLES[recipientRoleOf(c)],
      claimNumber: c.claimNumber ?? null,
      insuredName: c.insuredName ?? null,
      accidentDate: c.accidentDate ? date(new Date(c.accidentDate)) : null,
      caseNumber: c.caseNumber ?? null,
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
    taxTreatmentLabel: taxTreatment ? (taxTreatment in CANCELLATION_FEE_TAX_TREATMENTS && refs.kind === "CANCELLATION_FEE" ? CANCELLATION_FEE_TAX_TREATMENTS[taxTreatment as CancellationFeeTaxTreatment] : DAMAGE_TAX_TREATMENTS[taxTreatment as DamageTaxTreatment] ?? null) : null,
    taxTreatmentNote: taxTreatment === "NON_TAXABLE_FEE" ? CANCELLATION_FEE_TAX_NOTE : taxTreatment && taxTreatment in DAMAGE_TAX_NOTES ? DAMAGE_TAX_NOTES[taxTreatment as DamageTaxTreatment] || null : null,
    nonTaxable,
    nonTaxableLabel: taxTreatment === "NON_TAXABLE_FEE" ? "Nicht steuerbarer Betrag (ohne Umsatzsteuer)" : "Nicht steuerbarer Schadensersatz",
    contentHash: inv.contentHash,
  };
}
