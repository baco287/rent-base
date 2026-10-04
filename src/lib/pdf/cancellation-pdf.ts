// Befehl 28: Stornobestätigung als PDF. Liest ausschließlich CancellationDocumentData (eingefrorene Storno-Abrechnung).
// Kein Rechnungs-Stornobeleg: Kopf mit Buchungsnummer, Parteien, Mietgegenstand und ursprünglichem Zeitraum, Stornogrund,
// finanzielle Zusammenfassung (Vorauszahlung, Stornogebühr, Erstattung/Guthaben, Kaution), Hinweise auf erhalten bleibende Belege.

import type { CancellationDocumentData } from "@/lib/cancellation-document";
import { COLORS, Pdf, type PdfTrace } from "@/lib/pdf/layout";

export async function renderCancellationPdf(data: CancellationDocumentData, logo: Uint8Array | null = null): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const pdf = new Pdf({
    title: data.title,
    number: data.bookingNumber,
    landlord: { name: data.company.fullName, address: data.company.addressLines.join(", "), contact: data.company.contact, logoImage: logo },
    footerNote: { label: "Prüfsumme der Storno-Abrechnung (SHA-256)", value: data.contentHash },
  });

  pdf.documentTitle(`${data.title} zur Buchung ${data.bookingNumber}`, [`Storniert am ${data.cancelledAt}`]);

  pdf.sectionTitle("Buchung");
  pdf.keyValues([
    { label: "Vermieter", value: [data.company.fullName, ...data.company.addressLines].join(", ") },
    { label: "Kunde", value: [data.customer.name, ...data.customer.addressLines].join(", ") + (data.customer.number ? ` · Kundennummer ${data.customer.number}` : "") },
    { label: "Fahrzeug", value: data.vehicle },
    { label: "Ursprünglicher Mietzeitraum", value: data.period },
    ...(data.contract ? [{ label: "Mietvertrag", value: data.contract }] : []),
    { label: "Stornodatum", value: data.cancelledAt },
    { label: "Stornogrund", value: data.reason },
  ], 1);

  pdf.sectionTitle("Finanzielle Zusammenfassung", 80);
  pdf.table(
    [{ header: "Position", width: 70 }, { header: "Betrag", width: 30, align: "right" }],
    data.finances.map((r) => [r.bold ? { text: r.label, bold: true } : r.label, r.bold ? { text: r.value, bold: true } : r.value]),
  );
  if (data.deposit.length > 0) {
    pdf.sectionTitle("Kaution");
    pdf.table([{ header: "Kaution", width: 70 }, { header: "Betrag", width: 30, align: "right" }], data.deposit.map((r) => [r.label, r.value]));
  }
  pdf.gap(4);
  for (const n of data.notes) pdf.paragraph(n, { size: 9, gapAfter: 4 });

  const foot = [data.company.fullName, data.company.addressLines.join(", "), data.company.contact, data.company.taxLine, data.company.footer].filter(Boolean).join(" · ");
  pdf.gap(6);
  pdf.paragraph(foot, { size: 7.5, color: COLORS.ink3 });
  return pdf.finish();
}
