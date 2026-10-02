// Befehl 25: Nachtrag zum Mietvertrag als PDF. Liest ausschließlich AmendmentDocumentData (Snapshot). Aufbau: Kopf mit
// Nachtrags-, Vertrags- und Buchungsnummer, Parteien, GEÄNDERTE VEREINBARUNGEN (alt/neu), Stand nach dem Nachtrag,
// neutraler Schlusssatz, Unterschriften – dieselbe Darstellung und Unterschriftslogik wie der Mietvertrag.

import type { AmendmentDocumentData } from "@/lib/amendment-document";
import { drawSignatures, type SignatureImages } from "@/lib/pdf/contract-pdf";
import { COLORS, Pdf, type PdfTrace } from "@/lib/pdf/layout";

export async function renderAmendmentPdf(data: AmendmentDocumentData, signatureImages: SignatureImages, logo: Uint8Array | null = null): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const pdf = new Pdf({
    title: data.title,
    number: data.number,
    landlord: { name: data.company.fullName, address: data.company.addressLines.join(", "), contact: data.company.contact, logoImage: logo },
    footerNote: { label: "Prüfsumme des unterschriebenen Nachtragsinhalts (SHA-256)", value: data.contentHash },
  });

  pdf.documentTitle(`${data.title} ${data.number}`, [
    `${data.sequenceNo}. Nachtrag zum Mietvertrag ${data.contract.number}${data.contract.signedAt ? ` vom ${data.contract.signedAt}` : ""} · Buchung ${data.bookingNumber}`,
    `Wirksam seit ${data.signedAt}`,
    ...(data.priorAmendments.length ? [`Frühere Nachträge: ${data.priorAmendments.map((p) => `${p.number} (${p.date})`).join(", ")}`] : []),
  ]);

  pdf.sectionTitle("Vertragsparteien");
  pdf.keyValues([
    { label: "Vermieter", value: [data.company.fullName, ...data.company.addressLines].join(", ") },
    { label: "Mieter", value: [data.customer.name, ...data.customer.addressLines].join(", ") + (data.customer.number ? ` · Kundennummer ${data.customer.number}` : "") },
    { label: "Fahrzeug", value: data.vehicle },
    { label: "Mietbeginn", value: data.contract.startAt },
  ], 1);

  pdf.sectionTitle("Geänderte Vereinbarungen", 80);
  pdf.paragraph("Die Parteien vereinbaren zum oben genannten Mietvertrag folgende Änderungen:", { size: 9.5, gapAfter: 6 });
  pdf.table(
    [{ header: "Vereinbarung", width: 26, bold: true }, { header: "bisher", width: 32 }, { header: "neu", width: 42, bold: true }],
    data.changes.map((c) => [c.label, c.before, { text: c.note ? `${c.after}\n${c.note}` : c.after, bold: true }]),
  );

  pdf.sectionTitle("Stand nach diesem Nachtrag");
  pdf.keyValues([
    { label: "Geplante Rückgabe", value: data.after.endAt },
    { label: "Gesamtmietpreis", value: data.after.total },
    { label: "Kilometer", value: data.after.km },
    { label: "Vereinbarte Kaution", value: data.after.deposit },
    { label: "Rückgabeort", value: data.after.returnLocation },
    { label: "Fahrer", value: data.after.drivers.join(", ") || "–" },
  ], 2);
  pdf.gap(4);
  pdf.paragraph(data.closing, { size: 9.5, gapAfter: 10 });

  drawSignatures(pdf, data.signatures, signatureImages);
  if (data.signatures.length === 0) pdf.paragraph("Keine Unterschrift zum versiegelten Inhalt vorhanden.", { size: 8.5, color: COLORS.ink3 });

  const foot = [data.company.fullName, data.company.addressLines.join(", "), data.company.contact, data.company.taxLine, data.company.footer].filter(Boolean).join(" · ");
  pdf.gap(6);
  pdf.paragraph(foot, { size: 7.5, color: COLORS.ink3 });
  return pdf.finish();
}
