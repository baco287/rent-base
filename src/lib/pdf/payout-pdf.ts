// Auszahlungsbeleg als PDF: Nachweis, dass eine Auszahlung in Rent-Base als erfolgt erfasst wurde. Keine Bankbestätigung:
// Rent-Base führt keine Überweisung aus. IBAN nur verschleiert; keine internen Notizen.

import type { PayoutDocumentData } from "@/lib/payout-view";
import { COLORS, Pdf, type PdfTrace } from "@/lib/pdf/layout";

export async function renderPayoutPdf(data: PayoutDocumentData, logo: Uint8Array | null = null): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const pdf = new Pdf({
    title: data.title,
    number: data.number,
    landlord: { name: data.company.name, address: data.company.addressLines.join(", "), contact: data.company.contact, logoImage: logo },
    footerNote: data.contentHash ? { label: "Prüfsumme des Auszahlungsbelegs (SHA-256)", value: data.contentHash } : undefined,
  });

  const y0 = pdf.y;
  const leftW = pdf.width * 0.55;
  pdf.textAt([data.company.name, ...data.company.addressLines].join(" · "), pdf.left, y0, leftW, { size: 7, color: COLORS.ink3 });
  let y = y0 + 12;
  y += pdf.textAt(data.recipientName, pdf.left, y, leftW, { size: 10.5, bold: true });
  if (data.recipientDeviates) y += pdf.textAt(`(abweichender Empfänger; Kunde: ${data.customer.name})`, pdf.left, y, leftW, { size: 8.5, color: COLORS.ink3 });
  const rx = pdf.left + pdf.width * 0.6;
  const rw = pdf.width * 0.4;
  const meta: [string, string | null][] = [
    ["Auszahlungsnummer", data.number],
    ["Auszahlungsdatum", data.executedAt],
    ["Quelle", data.sourceLabel],
    [data.sourceType === "INVOICE_REFUND" ? "Rechnung" : "Mietvertrag", data.sourceType === "INVOICE_REFUND" ? data.snapshot.invoiceNumber : data.snapshot.contractNumber],
    ["Buchung", data.snapshot.bookingNumber],
  ];
  let ry = y0;
  for (const [label, value] of meta) {
    if (!value) continue;
    pdf.textAt(label, rx, ry, rw * 0.45, { size: 8, color: COLORS.ink3 });
    ry += pdf.textAt(value, rx + rw * 0.45, ry, rw * 0.55, { size: 9, bold: label === "Auszahlungsnummer" }) + 1;
  }
  pdf.y = Math.max(y, ry) + 14;

  pdf.textAt(`${data.title} ${data.number}`, pdf.left, pdf.y, pdf.width, { size: 16, bold: true, color: COLORS.brand });
  pdf.y += 4;
  pdf.textAt(data.referenceLine, pdf.left, pdf.y, pdf.width, { size: 9, color: COLORS.ink2 });
  pdf.y += 10;
  if (data.cancelled) pdf.paragraph(`STORNIERT am ${data.cancelled.at}: ${data.cancelled.reason}. Diese Auszahlung zählt nicht mehr als erfolgt.`, { size: 10, bold: true, color: COLORS.bad, gapAfter: 6 });
  if (data.historicalEntry) pdf.paragraph("Nachträglich in Rent-Base dokumentiert: Die Auszahlung erfolgte außerhalb von Rent-Base vor der Erfassung. Rent-Base hat sie nicht selbst durchgeführt.", { size: 9, bold: true, gapAfter: 6 });

  pdf.sectionTitle("Auszahlung");
  const rows: { label: string; value: string }[] = [
    { label: "Betrag", value: data.amount },
    { label: "Auszahlungsweg", value: data.method === "OTHER" && data.methodDescription ? `${data.methodLabel}: ${data.methodDescription}` : data.methodLabel },
    { label: "Empfänger", value: data.recipientName },
    ...(data.ibanMasked ? [{ label: "IBAN (verkürzt)", value: data.ibanMasked }] : []),
    ...(data.reference ? [{ label: "Referenz", value: data.reference }] : []),
    { label: "Erfasst als ausgezahlt", value: `${data.completedAt ?? "–"}${data.completedByName ? ` von ${data.completedByName}` : ""}` },
    ...(data.method === "CASH" ? [{ label: "Empfang bestätigt", value: data.receiptConfirmed ? "Ja, vom Empfänger bestätigt" : "Keine Empfangsbestätigung hinterlegt" }] : []),
    ...(data.recipientDeviates && data.recipientReason ? [{ label: "Grund abweichender Empfänger", value: data.recipientReason }] : []),
  ];
  pdf.keyValues(rows, 1);

  pdf.sectionTitle(data.sourceType === "INVOICE_REFUND" ? "Stand der Rechnung vor dieser Auszahlung" : "Stand der Kaution vor dieser Auszahlung");
  const s = data.snapshot;
  const eur = (c: number | undefined) => (c == null ? "–" : (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" }));
  if (data.sourceType === "INVOICE_REFUND") {
    pdf.keyValues([
      { label: "Rechnungsbetrag", value: eur(s.invoiceCents) },
      { label: "Wirksame Forderung", value: eur(s.effectiveCents) },
      { label: "Zahlungen des Kunden", value: eur(s.paidCents) },
      { label: "Kundenguthaben", value: eur(s.customerCreditCents) },
      { label: "Bereits ausgezahlt", value: eur(s.paidOutBeforeCents) },
    ], 2);
  } else {
    pdf.keyValues([
      { label: "Vereinbarte Kaution", value: eur(s.expectedCents) },
      { label: "Erhalten", value: eur(s.receivedCents) },
      { label: "Einbehalten", value: eur(s.retainedCents) },
      { label: "Zur Rückzahlung freigegeben", value: eur(s.releasedCents) },
      { label: "Bereits ausgezahlt", value: eur(s.paidOutBeforeCents) },
    ], 2);
  }
  pdf.gap(4);
  const lines: string[] = [];
  lines.push(data.method === "BANK_TRANSFER"
    ? "Dieser Beleg dokumentiert, dass die Auszahlung in Rent-Base als erfolgt erfasst wurde. Die Überweisung wurde außerhalb von Rent-Base ausgeführt; ein Nachweis der Bank ist dieser Beleg nicht."
    : data.method === "CARD"
    ? "Dieser Beleg dokumentiert, dass die Auszahlung in Rent-Base als erfolgt erfasst wurde. Die Kartenrückbuchung wurde außerhalb von Rent-Base ausgeführt; ein Terminal- oder Anbieterbeleg ist dieser Beleg nicht."
    : "Dieser Beleg dokumentiert, dass die Auszahlung in Rent-Base als erfolgt erfasst wurde.");
  if (data.customerNote) lines.push(data.customerNote);
  for (const l of lines) pdf.paragraph(l, { size: 9, gapAfter: 5 });
  pdf.gap(6);
  pdf.paragraph([data.company.name, data.company.addressLines.join(", "), data.company.contact].filter(Boolean).join(" · "), { size: 7.5, color: COLORS.ink3 });
  return pdf.finish();
}
