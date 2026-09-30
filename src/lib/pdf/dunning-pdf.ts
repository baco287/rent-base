// Befehl 23: Zahlungserinnerung und Mahnungen als PDF. Liest ausschließlich DunningDocumentData (Snapshot). Sachlicher Ton,
// keine Drohungen, keine Aussagen über Inkasso, Anwalt, Gericht oder Verzugszinsen, keine Zulässigkeitsbehauptung zu Gebühren.

import type { DunningDocumentData } from "@/lib/dunning-document";
import { COLORS, Pdf, type PdfTrace } from "@/lib/pdf/layout";

function intro(data: DunningDocumentData): string[] {
  const last = data.priorNotices[data.priorNotices.length - 1];
  if (data.level === 1) {
    return [
      `nach unseren Unterlagen ist zu unserer Rechnung ${data.invoice.number} vom ${data.invoice.issueDate}${data.invoice.dueDate ? ` (fällig am ${data.invoice.dueDate})` : ""} noch ein Betrag offen. Sicher ist die Zahlung nur übersehen worden.`,
      `Wir bitten Sie freundlich, den offenen Betrag von ${data.total} bis zum ${data.deadline} zu überweisen.`,
      "Sollten Sie die Zahlung inzwischen veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.",
    ];
  }
  if (data.level === 2) {
    return [
      `trotz unserer ${last ? `${last.label} ${last.number} vom ${last.date}` : "Zahlungserinnerung"} ist die Forderung aus unserer Rechnung ${data.invoice.number} vom ${data.invoice.issueDate} nach unseren Unterlagen weiterhin offen.`,
      `Bitte begleichen Sie die unten aufgeführte Gesamtforderung von ${data.total} bis spätestens ${data.deadline}.`,
      "Falls Sie in der Zwischenzeit gezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.",
    ];
  }
  return [
    `die Forderung aus unserer Rechnung ${data.invoice.number} vom ${data.invoice.issueDate} ist trotz ${data.priorNotices.map((n) => `${n.label} ${n.number} vom ${n.date}`).join(" und ") || "vorheriger Schreiben"} nach unseren Unterlagen weiterhin offen.`,
    `Wir fordern Sie auf, die unten aufgeführte Gesamtforderung von ${data.total} bis spätestens ${data.deadline} zu begleichen. Nach Ablauf dieser Frist kann eine weitere Bearbeitung der Forderung erforderlich werden.`,
    "Falls Sie in der Zwischenzeit gezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.",
  ];
}

export async function renderDunningPdf(data: DunningDocumentData, logo: Uint8Array | null = null): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const pdf = new Pdf({
    title: data.title,
    number: data.number,
    landlord: { name: data.company.fullName, address: data.company.addressLines.join(", "), contact: data.company.contact, logoImage: logo },
    footerNote: { label: "Prüfsumme des Mahnschreibens (SHA-256)", value: data.contentHash },
  });

  const y0 = pdf.y;
  const leftW = pdf.width * 0.55;
  pdf.textAt([data.company.fullName, ...data.company.addressLines].join(" · "), pdf.left, y0, leftW, { size: 7, color: COLORS.ink3 });
  let y = y0 + 12;
  y += pdf.textAt(data.customer.name, pdf.left, y, leftW, { size: 10.5, bold: true });
  for (const line of data.customer.addressLines) y += pdf.textAt(line, pdf.left, y, leftW, { size: 10 });
  const rx = pdf.left + pdf.width * 0.6;
  const rw = pdf.width * 0.4;
  const meta: [string, string | null][] = [
    ["Schreiben", data.number],
    ["Datum", data.issueDate],
    ["Rechnung", `${data.invoice.number} vom ${data.invoice.issueDate}`],
    ["Fällig seit", data.invoice.dueDate],
    ["Kundennummer", data.customer.number],
    ["Mietvertrag", data.contractNumber],
    ["Buchung", data.bookingNumber],
  ];
  let ry = y0;
  for (const [label, value] of meta) {
    if (!value) continue;
    pdf.textAt(label, rx, ry, rw * 0.45, { size: 8, color: COLORS.ink3 });
    ry += pdf.textAt(value, rx + rw * 0.45, ry, rw * 0.55, { size: 9, bold: label === "Schreiben" }) + 1;
  }
  pdf.y = Math.max(y, ry) + 14;

  pdf.textAt(`${data.title} ${data.number}`, pdf.left, pdf.y, pdf.width, { size: 16, bold: true, color: COLORS.brand });
  pdf.y += 4;
  pdf.textAt(`zu Rechnung ${data.invoice.number} vom ${data.invoice.issueDate}`, pdf.left, pdf.y, pdf.width, { size: 9, color: COLORS.ink2 });
  pdf.y += 12;

  pdf.paragraph(`Guten Tag ${data.customer.name},`, { size: 10, gapAfter: 5 });
  for (const p of intro(data)) pdf.paragraph(p, { size: 10, gapAfter: 5 });

  pdf.sectionTitle("Forderung");
  pdf.keyValues(data.rows.map((r) => ({ label: r.label, value: r.value })), 1);
  pdf.gap(2);
  pdf.flowingValue("Gesamtforderung", data.total, { bold: true });
  pdf.flowingValue("Zahlbar bis", data.deadline, { bold: true });
  pdf.gap(6);

  if (data.priorNotices.length > 0) {
    pdf.sectionTitle("Bisherige Schreiben");
    pdf.keyValues(data.priorNotices.map((n) => ({ label: n.label, value: `${n.number} vom ${n.date}` })), 1);
  }

  pdf.sectionTitle("Zahlung");
  const pay: string[] = [];
  if (data.company.bankLines.length > 0) pay.push(`Bitte überweisen Sie auf: ${data.company.bankLines.join(" · ")}.`);
  pay.push(`Verwendungszweck: ${data.reference}`);
  if (data.fee?.invoiceNumber) pay.push(`Die Mahngebühr ist als eigene Rechnung ${data.fee.invoiceNumber} ausgewiesen. Bitte geben Sie bei einer Zahlung an, auf welche Rechnung sie sich bezieht.`);
  for (const l of pay) pdf.paragraph(l, { size: 9, gapAfter: 4 });
  pdf.gap(6);
  pdf.paragraph("Bei Fragen zur Forderung melden Sie sich gern bei uns.", { size: 9, gapAfter: 8 });
  pdf.paragraph("Freundliche Grüße", { size: 10, gapAfter: 2 });
  pdf.paragraph(data.company.fullName, { size: 10, gapAfter: 10 });
  const foot = [data.company.fullName, data.company.addressLines.join(", "), data.company.contact, data.company.taxLine, data.company.footer].filter(Boolean).join(" · ");
  pdf.paragraph(foot, { size: 7.5, color: COLORS.ink3 });
  return pdf.finish();
}
