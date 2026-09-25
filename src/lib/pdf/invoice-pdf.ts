// Rechnung als PDF. Liest ausschließlich InvoiceDocumentData (versiegelte Kopien). Keine internen Notizen.

import type { InvoiceDocumentData } from "@/lib/invoice-view";
import { COLORS, Pdf, type Cell, type PdfTrace } from "@/lib/pdf/layout";

export async function renderInvoicePdf(data: InvoiceDocumentData, logo: Uint8Array | null = null): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const v = data.version;
  const correction = v.kind === "CORRECTION";
  const damage = data.kind === "DAMAGE";
  // Gegenbelege (Gutschrift, Stornobeleg): eigener Titel, eigene Nummer, Bezug auf die Originalrechnung, kein Zahlungsziel,
  // keine Aussage über eine Erstattung – aus dem Beleg kann sich ein Kundenguthaben ergeben.
  const counter = data.documentType !== "INVOICE";
  const credit = data.documentType === "CREDIT_NOTE";
  const baseTitle = counter ? (credit ? "Gutschrift" : "Stornobeleg") : damage ? "Schadenabrechnung" : "Rechnung";
  const numberLabel = counter ? (credit ? "Gutschriftnummer" : "Belegnummer") : "Rechnungsnummer";
  const amountLabel = counter ? (credit ? "Gutschriftbetrag" : "Stornobetrag") : "Rechnungsbetrag";
  const pdf = new Pdf({
    title: correction ? `Berichtigte ${baseTitle}` : baseTitle,
    number: v.versionNo > 1 ? `${data.number} · Fassung ${v.versionNo}` : data.number,
    landlord: { name: data.company.fullName, address: data.company.addressLines.join(", "), contact: [data.company.phone, data.company.email, data.company.website?.replace(/^https?:\/\//i, "")].filter(Boolean).join(" · "), logoImage: logo },
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
    [numberLabel, data.number],
    [counter ? "Belegdatum" : "Rechnungsdatum", data.issueDate],
    ["Zu Rechnung", counter && data.original ? `${data.original.number}${data.original.date ? ` vom ${data.original.date}` : ""}` : null],
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
    ry += pdf.textAt(value, rx + rw * 0.45, ry, rw * 0.55, { size: 9, bold: label === numberLabel }) + 1;
  }
  pdf.y = Math.max(y, ry) + 14;

  pdf.textAt(`${correction ? `Berichtigte ${baseTitle}` : baseTitle} ${data.number}`, pdf.left, pdf.y, pdf.width, { size: 16, bold: true, color: COLORS.brand });
  pdf.y += 4;
  const subtitle = counter && data.original
    ? `${credit ? "Gutschrift" : "Storno"} zu ${damage ? "Schadenabrechnung" : "Rechnung"} ${data.original.number}${data.original.date ? ` vom ${data.original.date}` : ""}${data.original.versionNo > 1 ? ` (Fassung ${data.original.versionNo})` : ""}, ${damage ? "Mietzeitraum" : "Leistungszeitraum"} ${data.servicePeriod}`
    : damage
    ? `Schadenabrechnung zur Vermietung${data.reference.bookingNumber ? ` ${data.reference.bookingNumber}` : ""}${data.reference.contractNumber ? `, Mietvertrag ${data.reference.contractNumber}` : ""}, Mietzeitraum ${data.servicePeriod}`
    : `Fahrzeugmiete${data.reference.contractNumber ? ` gemäß Mietvertrag ${data.reference.contractNumber}` : ""}, Leistungszeitraum ${data.servicePeriod}`;
  pdf.textAt(subtitle, pdf.left, pdf.y, pdf.width, { size: 9, color: COLORS.ink2 });
  pdf.y += 10;
  if (counter) {
    pdf.paragraph(credit
      ? `Mit diesem Beleg schreiben wir Ihnen die unten aufgeführten Beträge zur Rechnung ${data.original?.number ?? ""} gut. Die Rechnung selbst bleibt unverändert bestehen; dieser Beleg mindert die Forderung aus der Rechnung.`
      : `Mit diesem Beleg heben wir die Forderung aus der Rechnung ${data.original?.number ?? ""} in Höhe des unten aufgeführten Betrags auf. Die Rechnung selbst bleibt als Beleg unverändert bestehen.`, { size: 9, gapAfter: 3 });
    if (data.reason) pdf.paragraph(`Grund: ${data.reason}`, { size: 9, gapAfter: 8 });
    else pdf.gap(5);
  }
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
  if (data.nonTaxable) {
    // Echter Schadensersatz: keine Steuerspalten, keine Steuerzeile – der Betrag ist nicht steuerbar, nicht „mit 0 %“
    pdf.table(
      [{ header: "Pos.", width: 5 }, { header: "Beschreibung", width: 55 }, { header: "Menge", width: 12, align: "right" }, { header: "Einzelbetrag", width: 14, align: "right" }, { header: "Betrag", width: 14, align: "right" }],
      data.items.map((i): Cell[] => [String(i.index), i.description, `${i.quantity} ${i.unit}`, i.unitPrice, { text: i.gross, bold: true }]),
      { zebra: true },
    );
  } else {
    pdf.table(
      [{ header: "Pos.", width: 5 }, { header: "Beschreibung", width: 36 }, { header: "Menge", width: 12, align: "right" }, { header: priceHeader, width: 13, align: "right" }, { header: "USt.", width: 10, align: "right" }, { header: "Netto", width: 12, align: "right" }, { header: "Brutto", width: 12, align: "right" }],
      data.items.map((i): Cell[] => [String(i.index), i.description, `${i.quantity} ${i.unit}`, i.unitPrice, i.taxRate, i.net, { text: i.gross, bold: true }]),
      { zebra: true },
    );
  }

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
  if (data.nonTaxable) {
    row(counter ? "Nicht steuerbarer Betrag (Schadensersatz)" : "Nicht steuerbarer Schadensersatz", data.totals.gross);
    pdf.doc.moveTo(sx, sy - 1).lineTo(sx + sw, sy - 1).lineWidth(0.8).strokeColor(COLORS.ink).stroke();
    sy += 3;
    row(counter ? amountLabel : "Gesamtforderung", data.totals.gross, { bold: true, size: 11 });
  } else {
    row("Nettobetrag", data.totals.net);
    for (const t of data.taxSummary) row(t.rate.startsWith("0,00") ? `${t.rate} USt. auf ${t.net} (siehe Hinweis)` : `zzgl. ${t.rate} USt. auf ${t.net}`, t.tax);
    pdf.doc.moveTo(sx, sy - 1).lineTo(sx + sw, sy - 1).lineWidth(0.8).strokeColor(COLORS.ink).stroke();
    sy += 3;
    row(amountLabel, data.totals.gross, { bold: true, size: 11 });
  }
  pdf.y = sy + 6;

  const lines: string[] = [];
  // Steuerliche Behandlung der Schadenabrechnung: bei echtem Schadensersatz der feste Hinweis, sonst die gewählte Einordnung
  if (data.taxTreatmentNote) lines.push(data.taxTreatmentNote);
  else if (data.taxTreatmentLabel) lines.push(`Steuerliche Behandlung: ${data.taxTreatmentLabel}.`);
  if (counter) lines.push("Aus diesem Beleg kann sich ein Guthaben zu Ihren Gunsten ergeben, soweit die Rechnung bereits bezahlt wurde. Eine Erstattung ist mit diesem Beleg nicht verbunden; sie wird gesondert abgestimmt.");
  else if (data.paymentDueDate) lines.push(`Zahlbar bis ${data.paymentDueDate}${data.paymentTermDays != null ? ` (${data.paymentTermDays} Tage nach Rechnungsdatum)` : ""} ohne Abzug.`);
  else if (data.company.bankLines.length > 0) lines.push("Bitte überweisen Sie den Rechnungsbetrag unter Angabe der Rechnungsnummer.");
  if (data.taxNote && data.hasZeroRate) lines.push(data.taxNote);
  if (data.customerNote) lines.push(data.customerNote);
  for (const l of lines) pdf.paragraph(l, { size: 9, gapAfter: 5 });
  if (data.company.bankLines.length > 0 && !counter) {
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
