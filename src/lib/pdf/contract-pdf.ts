// Mietvertrag als PDF. Liest ausschließlich ContractDocumentData, dieselbe Struktur wie die Vertragsansicht.
// Hier steht keine Geschäftslogik: keine Preisberechnung, keine Stammdaten, nur Darstellung.
// Aufbau: Vertragsseiten (Parteien, Fahrzeug, Zeitraum, Preis, Konditionen, Geschäftsregeln, individuelle Vereinbarungen,
// Unterschriften), danach die Allgemeinen Mietbedingungen in genau der eingefrorenen Fassung – ein zusammenhängendes Dokument.

import type { ContractDocumentData, DocSection } from "@/lib/contract-view";
import { COLORS, Pdf, type PdfTrace } from "@/lib/pdf/layout";
import type { TermsBlock } from "@/lib/terms-markdown";

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

/** Mietbedingungen aus der Markdown-Struktur: Überschriften bleiben bei ihrem Folgetext, Listen mit Einzug, fett im Fließtext. */
export function drawTermsBlocks(pdf: Pdf, blocks: TermsBlock[]) {
  for (const b of blocks) {
    if (b.type === "heading") {
      const size = b.level === 1 ? 11 : b.level === 2 ? 9.6 : 9;
      pdf.ensureSpace(pdf.measure(b.text, pdf.width, { size, bold: true }) + 34); // Überschrift nie allein am Seitenende
      pdf.gap(b.level === 1 ? 6 : 4);
      pdf.richParagraph([{ text: b.text, bold: true }], { size, gapAfter: 3, color: b.level === 1 ? COLORS.brand : COLORS.ink });
    } else if (b.type === "paragraph") {
      pdf.richParagraph(b.runs, { size: 8.6, gapAfter: 5 });
    } else {
      b.items.forEach((runs, i) => pdf.richParagraph(runs, { size: 8.6, gapAfter: 2.5, indent: 16, bullet: b.ordered ? `${i + 1}.` : "•" }));
      pdf.gap(3);
    }
  }
}

export async function renderContractPdf(data: ContractDocumentData, signatureImages: SignatureImages, logo: Uint8Array | null = null): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const pdf = new Pdf({
    title: data.title,
    number: data.number,
    landlord: { name: data.landlord.name, address: data.landlord.address, contact: data.landlord.contact, logoImage: logo },
    footerNote: data.contentHash ? { label: "Prüfsumme des unterschriebenen Vertragsinhalts (SHA-256)", value: data.contentHash } : undefined,
    footerLine: data.terms.version ? `Mietbedingungen Version ${data.terms.version}` : undefined,
  });

  pdf.documentTitle(data.title, [
    `Vertragsnummer ${data.number}`,
    data.signedAt ? `Abgeschlossen am ${data.signedAt}` : `Erstellt am ${data.createdAt}`,
    ...(data.terms.version ? [`Mietbedingungen: Version ${data.terms.version}${data.terms.legacy ? "" : " (Bestandteil dieses Vertrags, siehe Anhang)"}`] : []),
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
    ...data.price.extras.map((e) => [e.text, e.amount]),
  ];
  pdf.table(
    [{ header: `Position (Mietdauer ${data.price.days} ${data.price.days === 1 ? "Tag" : "Tage"})`, width: 75 }, { header: "Betrag", width: 25, align: "right" }],
    [...rows, [{ text: "Gesamtmietpreis", bold: true }, { text: data.price.total, bold: true }], ["Kaution", data.price.deposit]],
  );

  const conditions = byKey.get("conditions");
  if (conditions) section(pdf, conditions);
  if (data.rules) section(pdf, data.rules);

  pdf.sectionTitle("Individuelle Vereinbarungen", 30);
  if (data.individualAgreements) {
    for (const p of data.individualAgreements.replace(/\r\n/g, "\n").split(/\n{2,}/)) { const t = p.trim(); if (t) pdf.paragraph(t, { size: 9.5, gapAfter: 5 }); }
  } else {
    pdf.paragraph("Keine individuellen Vereinbarungen.", { size: 9, color: COLORS.ink2 });
  }

  if (data.terms.version && !data.terms.legacy) {
    pdf.paragraph(`Die Allgemeinen Mietbedingungen in der Version ${data.terms.version} sind Bestandteil dieses Vertrags und diesem Dokument beigefügt.${data.terms.acknowledgedAt ? ` Zur Kenntnisnahme bereitgestellt am ${data.terms.acknowledgedAt}.` : ""}`, { size: 8.6, color: COLORS.ink2, gapAfter: 6 });
  }

  drawSignatures(pdf, data.signatures, signatureImages);

  // Anhang: Allgemeine Mietbedingungen – exakt die eingefrorene Fassung, auf neuer Seite
  if (data.terms.text && data.terms.text.trim()) {
    pdf.newPage();
    pdf.textAt(data.terms.title, pdf.left, pdf.y, pdf.width, { size: 14, bold: true, color: COLORS.brand });
    pdf.y += 4;
    pdf.paragraph(`Anlage zum Mietvertrag ${data.number}${data.terms.version ? ` · Version ${data.terms.version}` : ""}`, { size: 8.5, color: COLORS.ink3, gapAfter: 8 });
    if (data.terms.blocks) drawTermsBlocks(pdf, data.terms.blocks);
    else {
      for (const p of data.terms.text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
        const text = p.trim();
        if (!text) continue;
        const heading = text.length < 90 && /^(§|\d+[.)]|[A-ZÄÖÜ][A-ZÄÖÜ \-]{4,}$)/.test(text);
        pdf.paragraph(text, { size: 8.6, bold: heading, gapAfter: heading ? 2 : 5 });
      }
    }
  } else {
    pdf.sectionTitle(data.terms.title, 30);
    pdf.paragraph("Zu diesem Vertrag wurden keine gesonderten Mietbedingungen hinterlegt.", { size: 9, color: COLORS.ink2 });
  }
  return pdf.finish();
}
