// Antwort auf eine Behördenanfrage als PDF. Liest ausschließlich die freigegebene Antwortfassung (Snapshot):
// keine Live-Daten, keine internen Notizen, nur die bewusst ausgewählten Personendaten. Keine rechtlichen Erklärungen.

import { COLORS, Pdf, type PdfTrace } from "@/lib/pdf/layout";

export type AuthorityResponsePdfData = {
  caseNumber: string;
  version: number;
  date: string;
  sender: { name: string; addressLines: string[]; contact: string };
  recipient: { name: string; department: string | null; addressLines: string[]; email: string | null };
  authorityReference: string;
  vehicle: { plate: string; description: string | null };
  offense: { typeLabel: string; atText: string; location: string | null };
  responseTypeLabel: string;
  statement: string;
  rental: { bookingNumber: string; contractNumber: string | null; windowText: string; basisText: string } | null;
  persons: { role: string; fields: { label: string; value: string }[] }[];
  freeText: string | null;
  contentHash: string | null;
};

export async function renderAuthorityResponsePdf(data: AuthorityResponsePdfData, logo: Uint8Array | null = null): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const pdf = new Pdf({
    title: "Antwort auf Behördenanfrage",
    number: data.version > 1 ? `${data.caseNumber} · Fassung ${data.version}` : data.caseNumber,
    landlord: { name: data.sender.name, address: data.sender.addressLines.join(", "), contact: data.sender.contact, logoImage: logo },
    footerNote: data.contentHash ? { label: "Prüfsumme der Antwortfassung (SHA-256)", value: data.contentHash } : undefined,
  });

  const y0 = pdf.y;
  const leftW = pdf.width * 0.55;
  pdf.textAt([data.sender.name, ...data.sender.addressLines].join(" · "), pdf.left, y0, leftW, { size: 7, color: COLORS.ink3 });
  let y = y0 + 12;
  y += pdf.textAt(data.recipient.name, pdf.left, y, leftW, { size: 10.5, bold: true });
  if (data.recipient.department) y += pdf.textAt(data.recipient.department, pdf.left, y, leftW, { size: 10 });
  for (const line of data.recipient.addressLines) y += pdf.textAt(line, pdf.left, y, leftW, { size: 10 });

  const rx = pdf.left + pdf.width * 0.6;
  const rw = pdf.width * 0.4;
  let ry = y0;
  for (const [label, value] of [["Ihr Aktenzeichen", data.authorityReference], ["Unser Zeichen", data.caseNumber], ["Datum", data.date]] as const) {
    pdf.textAt(label, rx, ry, rw * 0.45, { size: 8, color: COLORS.ink3 });
    ry += pdf.textAt(value, rx + rw * 0.45, ry, rw * 0.55, { size: 9, bold: label === "Ihr Aktenzeichen" }) + 1;
  }
  pdf.y = Math.max(y, ry) + 14;

  pdf.textAt(`Antwort auf Ihre Anfrage – Aktenzeichen ${data.authorityReference}`, pdf.left, pdf.y, pdf.width, { size: 14, bold: true, color: COLORS.brand });
  pdf.y += 8;
  pdf.paragraph(`${data.offense.typeLabel} · Kennzeichen ${data.vehicle.plate} · ${data.offense.atText}${data.offense.location ? ` · ${data.offense.location}` : ""}`, { size: 9, color: COLORS.ink2, gapAfter: 10 });

  pdf.sectionTitle("Fahrzeug und Tatzeit", 40);
  pdf.keyValues([
    { label: "Kennzeichen laut Schreiben", value: data.vehicle.plate },
    { label: "Fahrzeug", value: data.vehicle.description ?? "–" },
    { label: "Tatzeit", value: data.offense.atText },
    { label: "Tatort", value: data.offense.location ?? "–" },
  ], 2);

  if (data.rental) {
    pdf.sectionTitle("Vermietung", 40);
    pdf.keyValues([
      { label: "Buchung", value: data.rental.bookingNumber },
      { label: "Mietvertrag", value: data.rental.contractNumber ?? "–" },
      { label: "Mietzeitraum", value: data.rental.windowText },
      { label: "Grundlage", value: data.rental.basisText },
    ], 2);
  }

  pdf.sectionTitle(`Unsere Angabe: ${data.responseTypeLabel}`, 40);
  pdf.paragraph(data.statement, { size: 10, gapAfter: 8 });
  for (const p of data.persons) {
    pdf.paragraph(p.role, { size: 9.5, bold: true, gapAfter: 2 });
    pdf.keyValues(p.fields, 2);
  }
  if (data.freeText) {
    pdf.sectionTitle("Ergänzende Angaben", 30);
    pdf.paragraph(data.freeText, { size: 10, gapAfter: 8 });
  }
  pdf.gap(6);
  pdf.paragraph("Diese Antwort wurde nach Prüfung durch einen Mitarbeiter freigegeben. Sie enthält ausschließlich die für diesen Vorgang ausgewählten Angaben.", { size: 8, color: COLORS.ink3, gapAfter: 4 });
  pdf.paragraph([data.sender.name, data.sender.addressLines.join(", "), data.sender.contact].filter(Boolean).join(" · "), { size: 7.5, color: COLORS.ink3 });
  return pdf.finish();
}
