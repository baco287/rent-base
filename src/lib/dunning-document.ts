// Befehl 23: Daten eines Mahnschreibens für PDF und Mail – ausschließlich aus dem beim Erstellen eingefrorenen Snapshot.
// Spätere Änderungen an Kunde, Firmendaten, Bankverbindung, Geschäftsregeln oder Gebühren verändern ein Mahnschreiben nie.

import { db } from "@/lib/db";
import type { LogoRef } from "@/lib/branding-ref";
import { dunningLevelLabel, type DunningLevel } from "@/lib/constants";
import type { DunningSnapshot } from "@/lib/dunning";
import { fmtDate } from "@/lib/format";
import { DomainError } from "@/lib/integrity";
import { fmtCents } from "@/lib/money";

export type DunningDocumentData = {
  level: DunningLevel;
  title: string;
  number: string;
  issueDate: string;
  deadline: string;
  company: { fullName: string; addressLines: string[]; contact: string; bankLines: string[]; taxLine: string | null; footer: string | null };
  customer: { name: string; number: string | null; addressLines: string[] };
  invoice: { number: string; issueDate: string; dueDate: string | null };
  bookingNumber: string;
  contractNumber: string | null;
  priorNotices: { label: string; number: string; date: string }[];
  rows: { label: string; value: string; bold?: boolean }[];
  total: string;
  principalOpen: string;
  fee: { amount: string; invoiceNumber: string | null } | null;
  reference: string;
  contentHash: string;
};

export function buildDunningDocument(s: DunningSnapshot, hash: string): DunningDocumentData {
  const c = s.company;
  const cust = s.customer;
  const eur = (v: number) => fmtCents(v);
  const d = (iso: string | null) => (iso ? fmtDate(new Date(iso)) : "–");
  const rows: DunningDocumentData["rows"] = [
    { label: `Rechnungsbetrag ${s.invoice.number}`, value: eur(s.balance.invoiceCents) },
    ...(s.balance.creditedCents > 0 ? [{ label: "abzüglich Gutschriften", value: `− ${eur(s.balance.creditedCents)}` }] : []),
    ...(s.balance.cancelledCents > 0 ? [{ label: "abzüglich Storno", value: `− ${eur(s.balance.cancelledCents)}` }] : []),
    ...(s.balance.paidCents > 0 ? [{ label: s.balance.offsetCents > 0 ? `bereits ausgeglichen (Zahlungen, davon ${eur(s.balance.offsetCents)} mit der Kaution verrechnet)` : "bereits gezahlt", value: `− ${eur(Math.min(s.balance.paidCents, s.balance.effectiveCents))}` }] : []),
    { label: "offener Rechnungsbetrag", value: eur(s.principalOpenCents), bold: true },
    ...s.priorFees.filter((f) => f.openCents > 0).map((f) => ({ label: `offene Mahngebühr ${f.number ?? ""} (zu ${f.noticeNumber})`.replace("  ", " "), value: eur(f.openCents) })),
    ...(s.feeCents > 0 ? [{ label: `Mahngebühr dieses Schreibens${s.fee.invoiceNumber ? ` (Rechnung ${s.fee.invoiceNumber})` : ""}`, value: eur(s.feeCents) }] : []),
  ];
  return {
    level: s.level,
    title: dunningLevelLabel(s.level),
    number: s.number,
    issueDate: d(s.issuedAt),
    deadline: d(s.deadlineAt),
    company: {
      fullName: [c.name, c.legalForm].filter(Boolean).join(" "),
      addressLines: [c.street, [c.zip, c.city].filter(Boolean).join(" "), c.country && c.country !== "DE" ? c.country : null].filter((x): x is string => !!x),
      contact: [c.phone, c.email, c.website?.replace(/^https?:\/\//i, "")].filter(Boolean).join(" · "),
      bankLines: [c.bankName ? `Bank: ${c.bankName}` : null, c.iban ? `IBAN: ${c.iban}` : null, c.bic ? `BIC: ${c.bic}` : null].filter((x): x is string => !!x),
      taxLine: [c.vatId ? `USt-IdNr. ${c.vatId}` : null, c.taxNumber ? `Steuernummer ${c.taxNumber}` : null].filter(Boolean).join(" · ") || null,
      footer: c.invoiceFooter ?? null,
    },
    customer: { name: s.recipient.name, number: cust?.number ?? null, addressLines: [cust?.street, [cust?.zip, cust?.city].filter(Boolean).join(" "), cust?.country && cust.country !== "DE" ? cust.country : null].filter((x): x is string => !!x) },
    invoice: { number: s.invoice.number, issueDate: d(s.invoice.issueDate), dueDate: s.invoice.dueDate ? d(s.invoice.dueDate) : null },
    bookingNumber: s.bookingNumber,
    contractNumber: s.contractNumber,
    priorNotices: s.priorNotices.map((n) => ({ label: dunningLevelLabel(n.level), number: n.number, date: d(n.issuedAt) })),
    rows,
    total: eur(s.totalCents),
    principalOpen: eur(s.principalOpenCents),
    fee: s.feeCents > 0 ? { amount: eur(s.feeCents), invoiceNumber: s.fee.invoiceNumber } : null,
    reference: [s.invoice.number, s.number].join(" / "),
    contentHash: hash,
  };
}

export async function loadDunningDocumentData(tenantId: string, noticeId: string): Promise<{ bookingId: string; contentHash: string; fileWord: string; doc: DunningDocumentData; logoRef: LogoRef | null; recipientEmail: string | null; snapshot: DunningSnapshot }> {
  const n = await db.dunningNotice.findFirst({ where: { id: noticeId, tenantId } });
  if (!n) throw new DomainError("Mahnschreiben nicht gefunden.");
  const s = n.snapshot as unknown as DunningSnapshot;
  const fileWord = n.level === 1 ? "Zahlungserinnerung" : n.level === 2 ? "1-Mahnung" : "2-Mahnung";
  return { bookingId: n.bookingId, contentHash: n.contentHash, fileWord, doc: buildDunningDocument(s, n.contentHash), logoRef: s.company.logo ?? null, recipientEmail: n.recipientEmail, snapshot: s };
}
