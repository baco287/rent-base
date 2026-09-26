// Befehl 20.6: PDF „Bestätigung kontaktlose Rückgabe“ – die Kundenmeldung, ausdrücklich NICHT das Rückgabeprotokoll.
import { COLORS, Pdf, type PdfTrace } from "@/lib/pdf/layout";
import type { KeyDropDocument } from "@/lib/key-drop-document";

export type KeyDropPdfAssets = { photos: Map<string, Uint8Array>; signature: Uint8Array | null; logo: Uint8Array | null };

/** Fotoraster (auch im Rückgabeprotokoll verwendet): Seitenverhältnis bleibt, fehlende Bilder werden benannt statt still ausgelassen. */
export function photoGrid(pdf: Pdf, photos: { id: string; caption: string }[], images: Map<string, Uint8Array>) {
  const cols = 3;
  const gap = 10;
  const cellW = (pdf.width - gap * (cols - 1)) / cols;
  const imgH = cellW * 0.72;
  for (let i = 0; i < photos.length; i += cols) {
    pdf.ensureSpace(imgH + 22);
    const rowY = pdf.y;
    photos.slice(i, i + cols).forEach((p, c) => {
      const x = pdf.left + c * (cellW + gap);
      const img = images.get(p.id);
      let ok = false;
      if (img) { try { pdf.imageFit("photo", img, x, rowY, cellW, imgH); ok = true; } catch { /* Hinweis statt Abbruch */ } }
      if (!ok) { pdf.textAt("Foto nicht eingebettet, Original liegt im Archiv", x, rowY + imgH / 2 - 6, cellW, { size: 8, color: COLORS.ink3, align: "center" }); pdf.note(`Foto ${p.id} nicht eingebettet`); }
      pdf.textAt(p.caption, x, rowY + imgH + 3, cellW, { size: 8, color: COLORS.ink2 });
    });
    pdf.y = rowY + imgH + 18;
  }
}

export async function renderKeyDropConfirmationPdf(data: KeyDropDocument, assets: KeyDropPdfAssets): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const title = "Bestätigung kontaktlose Rückgabe";
  const pdf = new Pdf({ title, number: data.bookingNumber, landlord: { ...data.landlord, logoImage: assets.logo }, footerNote: { label: "Prüfsumme der bestätigten Kundenangaben (SHA-256)", value: data.confirmationHash } });
  pdf.documentTitle(title, [[`Buchung ${data.bookingNumber}`, data.contractNumber ? `Mietvertrag ${data.contractNumber}` : null].filter(Boolean).join("  ·  "), `Gemeldet am ${data.confirmedAt}`]);
  pdf.paragraph("Dieses Dokument hält die Angaben des Kunden zur kontaktlosen Rückgabe fest. Es ist nicht das Rückgabeprotokoll und keine gemeinsame Zustandsprüfung. Die Fahrzeugkontrolle durch den Vermieter erfolgt nachträglich und wird gesondert protokolliert.", { size: 8.5, color: COLORS.ink2, gapAfter: 8 });

  pdf.sectionTitle("Mieter und Fahrzeug");
  pdf.keyValues([
    { label: "Mieter", value: data.renterName },
    { label: "Fahrzeug", value: data.vehicleTitle || "–" },
    { label: "Kennzeichen", value: data.plate || "–" },
    { label: "Rückgabeart", value: `Kontaktlos (${data.label})` },
    { label: "Vereinbarter Ort", value: data.agreedLocation },
    { label: "Voraussichtlich", value: data.expectedAt },
  ]);

  pdf.sectionTitle("Angaben des Kunden");
  pdf.keyValues(data.rows, 1);

  pdf.sectionTitle("Bestätigung des Kunden", 120);
  pdf.paragraph(data.confirmationText, { size: 9.5, gapAfter: 8 });
  pdf.ensureSpace(110);
  const y = pdf.y;
  const boxW = pdf.width / 2;
  let drawn = false;
  if (assets.signature) {
    try { pdf.imageFit("signature", assets.signature, pdf.left, y, boxW, 64); drawn = true; } catch { /* Hinweis statt Abbruch */ }
  }
  if (!drawn) pdf.textAt("Unterschriftsbild nicht verfügbar", pdf.left, y + 26, boxW, { size: 8, color: COLORS.ink3 });
  pdf.doc.moveTo(pdf.left, y + 67).lineTo(pdf.left + boxW, y + 67).lineWidth(0.7).strokeColor(COLORS.ink2).stroke();
  pdf.textAt(`Kunde: ${data.signerName}`, pdf.left, y + 71, boxW, { size: 9, bold: true });
  pdf.textAt(`Digital bestätigt am ${data.signedAt}`, pdf.left, y + 84, boxW, { size: 8, color: COLORS.ink3 });
  pdf.y = y + 102;

  pdf.sectionTitle("Fotos des Kunden", 160);
  if (data.photos.length > 0) photoGrid(pdf, data.photos, assets.photos);
  else pdf.paragraph("Der Kunde hat keine Fotos hochgeladen.", { size: 9, color: COLORS.ink2 });
  return pdf.finish();
}
