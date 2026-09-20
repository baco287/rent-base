// Mietvertrag als PDF. Liest ausschließlich ContractDocumentData, dieselbe Struktur wie die Vertragsansicht.
// Hier steht keine Geschäftslogik: keine Preisberechnung, keine Stammdaten, nur Darstellung.

import type { ContractDocumentData, DocSection } from "@/lib/contract-view";
import { COLORS, Pdf, type PdfTrace } from "@/lib/pdf/layout";

export type SignatureImages = Map<string, Uint8Array>; // Signature.id -> PNG

export function drawSignatures(pdf: Pdf, signatures: ContractDocumentData["signatures"], images: SignatureImages) {
  if (signatures.length === 0) return;
  const boxW = (pdf.width - 24) / 2;
  const boxH = 64;
  pdf.sectionTitle("Unterschriften", boxH + 50);
  for (let i = 0; i < signatures.length; i += 2) {
    const pair = signatures.slice(i, i + 2);
    const captions = pair.map((s) => `${s.roleLabel}: ${s.signerName}`);
    const capH = Math.max(...captions.map((c) => pdf.measure(c, boxW, { size: 9, bold: true })));
    pdf.ensureSpace(boxH + capH + 28);
    const y = pdf.y;
    pair.forEach((s, c) => {
      const x = pdf.left + c * (boxW + 24);
      const img = images.get(s.id);
      let drawn = false;
      if (img) {
        try { pdf.imageFit("signature", img, x, y, boxW, boxH); drawn = true; } catch { /* beschädigtes Bild: Hinweis statt Abbruch */ }
      }
      if (!drawn) { pdf.textAt("Unterschriftsbild nicht verfügbar", x, y + boxH / 2 - 5, boxW, { size: 8, color: COLORS.ink3 }); pdf.note(`Unterschrift ${s.role} ohne Bild`); }
      pdf.doc.moveTo(x, y + boxH + 3).lineTo(x + boxW, y + boxH + 3).lineWidth(0.7).strokeColor(COLORS.ink2).stroke();
      pdf.textAt(captions[c], x, y + boxH + 7, boxW, { size: 9, bold: true });
      pdf.textAt(`Digital unterschrieben am ${s.signedAt}`, x, y + boxH + 8 + capH, boxW, { size: 8, color: COLORS.ink3 });
    });
    pdf.y = y + boxH + capH + 26;
  }
}

function section(pdf: Pdf, s: DocSection) {
  pdf.sectionTitle(s.title);
  pdf.keyValues(s.rows.map((r) => ({ label: r.label, value: r.value })));
}

export async function renderContractPdf(data: ContractDocumentData, signatureImages: SignatureImages): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const pdf = new Pdf({
    title: data.title,
    number: data.number,
    landlord: data.landlord,
    footerNote: data.contentHash ? { label: "Prüfsumme des unterschriebenen Vertragsinhalts (SHA-256)", value: data.contentHash } : undefined,
  });

  pdf.documentTitle(data.title, [
    `Vertragsnummer ${data.number}`,
    data.signedAt ? `Abgeschlossen am ${data.signedAt}` : `Erstellt am ${data.createdAt}`,
  ]);

  pdf.sectionTitle("Vermieter");
  pdf.keyValues([
    { label: "Firma", value: data.landlord.name },
    { label: "Anschrift", value: data.landlord.address || "–" },
    ...(data.landlord.contact ? [{ label: "Kontakt", value: data.landlord.contact }] : []),
  ], 1);

  const byKey = new Map(data.sections.map((s) => [s.key, s]));
  for (const key of ["renter", "driver"]) { const s = byKey.get(key); if (s) section(pdf, s); }
  for (const d of data.additionalDrivers) section(pdf, d);
  for (const key of ["vehicle", "period"]) { const s = byKey.get(key); if (s) section(pdf, s); }

  pdf.sectionTitle("Mietpreis", 80);
  const rows = [
    ...data.price.lines.map((l) => [l.text, l.amount]),
    ["Zwischensumme", data.price.subtotal],
    ...(data.price.discount ? [[data.price.discount.text, data.price.discount.amount]] : []),
    ...(data.price.agreed ? [["Berechneter Mietpreis", data.price.calculated], [data.price.agreed.text, data.price.agreed.amount]] : []),
  ];
  pdf.table(
    [{ header: `Position (Mietdauer ${data.price.days} ${data.price.days === 1 ? "Tag" : "Tage"})`, width: 75 }, { header: "Betrag", width: 25, align: "right" }],
    [...rows, [{ text: "Gesamtmietpreis", bold: true }, { text: data.price.total, bold: true }], ["Kaution", data.price.deposit]],
  );

  const conditions = byKey.get("conditions");
  if (conditions) section(pdf, conditions);

  pdf.sectionTitle(data.terms.version ? `Mietbedingungen (Fassung ${data.terms.version})` : "Mietbedingungen", 40);
  if (data.terms.text && data.terms.text.trim()) {
    for (const p of data.terms.text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
      const text = p.trim();
      if (!text) continue;
      const heading = text.length < 90 && /^(§|\d+[.)]|[A-ZÄÖÜ][A-ZÄÖÜ \-]{4,}$)/.test(text);
      pdf.paragraph(text, { size: 8.6, bold: heading, gapAfter: heading ? 2 : 5 });
    }
  } else {
    pdf.paragraph("Zu diesem Vertrag wurden keine gesonderten Mietbedingungen hinterlegt.", { size: 9, color: COLORS.ink2 });
  }

  drawSignatures(pdf, data.signatures, signatureImages);
  return pdf.finish();
}
