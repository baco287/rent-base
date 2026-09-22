// Rechnung als PDF. Liest ausschließlich InvoiceDocumentData (versiegelte Kopien). Keine internen Notizen.

import type { InvoiceDocumentData } from "@/lib/invoice-view";
import { COLORS, Pdf, type Cell, type PdfTrace } from "@/lib/pdf/layout";

export async function renderInvoicePdf(data: InvoiceDocumentData): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const v = data.version;
  const correction = v.kind === "CORRECTION";
  const damage = data.kind === "DAMAGE";
  const baseTitle = damage ? "Schadenabrechnung" : "Rechnung";
  const pdf = new Pdf({
    title: correction ? `Berichtigte ${baseTitle}` : baseTitle,
    number: v.versionNo > 1 ? `${data.number} · Fassung ${v.versionNo}` : data.number,
    landlord: { name: data.company.fullName, address: data.company.addressLines.join(", "), contact: [data.company.phone, data.company.email].filter(Boolean).join(" · ") },
    footerNote: data.contentHash ? { label: "Prüfsumme der Rechnung (SHA-256)", value: data.contentHash } : undefined,
  });

  // Anschriftenblock links, Rechnungsdaten rechts
  const y0 = pdf.y;
  const leftW = pdf.width * 0.55;
  pdf.textAt([data.company.fullName, ...data.company.addressLines].join(" · "), pdf.left, y0, leftW, { size: 7, color: COLORS.ink3 });
  let y = y0 + 12;
  y += pdf.textAt(data.customer.name, pdf.left, y, leftW, { size: 10.5, bold: true });
  for (const line of data.customer.addressLines) y += pdf.textAt(line, pdf.left, y, leftW, { size: 10 });

  const rx = pdf.left + pdf.width * 0.6;
  const rw = pdf.width * 0.4;
  const meta: [string, string | null][] = [
    ["Rechnungsnummer", data.number],
    ["Rechnungsdatum", data.issueDate],
    ["Kundennummer", data.customer.number],
    [damage ? "Mietzeitraum" : "Leistungszeitraum", data.servicePeriod],
    ["Mietvertrag", data.reference.contractNumber],
    ["Buchung", data.reference.bookingNumber],
    ["Schadenakte", damage ? data.reference.caseNumber : null],
  ];
  let ry = y0;
  for (const [label, value] of meta) {
    if (!value) continue;
    pdf.textAt(label, rx, ry, rw * 0.45, { size: 8, color: COLORS.ink3 });
    ry += pdf.textAt(value, rx + rw * 0.45, ry, rw * 0.55, { size: 9, bold: label === "Rechnungsnummer" }) + 1;
  }
  pdf.y = Math.max(y, ry) + 14;

  pdf.textAt(`${correction ? `Berichtigte ${baseTitle}` : baseTitle} ${data.number}`, pdf.left, pdf.y, pdf.width, { size: 16, bold: true, color: COLORS.brand });
  pdf.y += 4;
  const subtitle = damage
    ? `Schadenabrechnung zur Vermietung${data.reference.bookingNumber ? ` ${data.reference.bookingNumber}` : ""}${data.reference.contractNumber ? `, Mietvertrag ${data.reference.contractNumber}` : ""}, Mietzeitraum ${data.servicePeriod}`
    : `Fahrzeugmiete${data.reference.contractNumber ? ` gemäß Mietvertrag ${data.reference.contractNumber}` : ""}, Leistungszeitraum ${data.servicePeriod}`;
  pdf.textAt(subtitle, pdf.left, pdf.y, pdf.width, { size: 9, color: COLORS.ink2 });
  pdf.y += 10;
  // Fassungsinformation: Neufassung unaufdringlich, Berichtigung deutlich (Bezug auf die ersetzte Fassung, § 31 Abs. 5 UStDV)
  if (v.versionNo > 1) {
    const supersedes = v.supersedes ? `Diese Fassung ersetzt Fassung ${v.supersedes.versionNo}${v.supersedes.finalizedAt ? ` vom ${v.supersedes.finalizedAt}` : ""} der Rechnung ${data.number}.` : "";
    if (correction) {
      pdf.paragraph(`Berichtigte Rechnung · Fassung ${v.versionNo}${v.correctionDate ? ` · Berichtigt am ${v.correctionDate}` : ""}`, { size: 10, bold: true, gapAfter: 2 });
      if (supersedes) pdf.paragraph(supersedes, { size: 9, gapAfter: 2 });
      if (v.reason) pdf.paragraph(`Grund der Berichtigung: ${v.reason}`, { size: 9, gapAfter: 8 });
      else pdf.gap(6);
    } else {
      pdf.paragraph(`Fassung ${v.versionNo}${v.correctionDate ? ` vom ${v.correctionDate}` : ""}${supersedes ? ` – ${supersedes}` : ""}`, { size: 8, color: COLORS.ink3, gapAfter: 8 });
    }
  }

  const priceHeader = data.pricesIncludeTax ? "Einzelpreis (brutto)" : "Einzelpreis (netto)";
  pdf.table(
    [{ header: "Pos.", width: 5 }, { header: "Beschreibung", width: 36 }, { header: "Menge", width: 12, align: "right" }, { header: priceHeader, width: 13, align: "right" }, { header: "USt.", width: 10, align: "right" }, { header: "Netto", width: 12, align: "right" }, { header: "Brutto", width: 12, align: "right" }],
    data.items.map((i): Cell[] => [String(i.index), i.description, `${i.quantity} ${i.unit}`, i.unitPrice, i.taxRate, i.net, { text: i.gross, bold: true }]),
    { zebra: true },
  );

  // Steuerzusammenfassung und Gesamt rechts
  const sx = pdf.left + pdf.width * 0.45;
  const sw = pdf.width * 0.55;
  pdf.ensureSpace(30 + data.taxSummary.length * 14 + 40);
  let sy = pdf.y;
  const row = (label: string, value: string, opts: { bold?: boolean; size?: number } = {}) => {
    pdf.textAt(label, sx, sy, sw * 0.6, { size: opts.size ?? 9, bold: opts.bold, color: opts.bold ? COLORS.ink : COLORS.ink2 });
    pdf.textAt(value, sx + sw * 0.6, sy, sw * 0.4, { size: opts.size ?? 9, bold: opts.bold, align: "right" });
    sy += (opts.size ?? 9) + 5;
  };
  row("Nettobetrag", data.totals.net);
  for (const t of data.taxSummary) row(t.rate.startsWith("0,00") ? `${t.rate} USt. auf ${t.net} (siehe Hinweis)` : `zzgl. ${t.rate} USt. auf ${t.net}`, t.tax);
  pdf.doc.moveTo(sx, sy - 1).lineTo(sx + sw, sy - 1).lineWidth(0.8).strokeColor(COLORS.ink).stroke();
  sy += 3;
  row("Rechnungsbetrag", data.totals.gross, { bold: true, size: 11 });
  pdf.y = sy + 6;

  const lines: string[] = [];
  if (data.paymentDueDate) lines.push(`Zahlbar bis ${data.paymentDueDate}${data.paymentTermDays != null ? ` (${data.paymentTermDays} Tage nach Rechnungsdatum)` : ""} ohne Abzug.`);
  else if (data.company.bankLines.length > 0) lines.push("Bitte überweisen Sie den Rechnungsbetrag unter Angabe der Rechnungsnummer.");
  if (data.taxNote && data.hasZeroRate) lines.push(data.taxNote);
  if (data.customerNote) lines.push(data.customerNote);
  for (const l of lines) pdf.paragraph(l, { size: 9, gapAfter: 5 });
  if (data.company.bankLines.length > 0) {
    pdf.gap(2);
    pdf.keyValues(data.company.bankLines.map((l) => { const [label, ...rest] = l.split(": "); return { label, value: rest.join(": ") }; }), 1);
  }
  if (data.company.invoiceFooter) {
    pdf.gap(8);
    pdf.paragraph(data.company.invoiceFooter, { size: 8, color: COLORS.ink2 });
  }
  pdf.gap(6);
  pdf.paragraph([data.company.fullName, data.company.addressLines.join(", "), data.company.taxLine, [data.company.phone, data.company.email].filter(Boolean).join(" · ")].filter(Boolean).join(" · "), { size: 7.5, color: COLORS.ink3 });
  return pdf.finish();
}
