// Fahrzeug-Übergabeprotokoll als PDF. Liest ausschließlich HandoverDocumentData, dieselbe Struktur wie die Ansicht
// des finalisierten Protokolls. Bilder und Skizze werden als fertige Bytes hereingereicht; hier wird nur dargestellt.

import type { DamageSymbol, DocDamage, HandoverDocumentData } from "@/lib/handover-view";
import { drawSignatures, type SignatureImages } from "@/lib/pdf/contract-pdf";
import { COLORS, Pdf, type Cell, type PdfTrace } from "@/lib/pdf/layout";
import { drawMarker, drawSketchView, parseSketchSvg } from "@/lib/pdf/sketch";

export type HandoverPdfAssets = {
  /** Inhalt der SVG-Datei genau der Skizzenfassung, die im Protokoll festgehalten ist. null = Skizze nicht verfügbar. */
  sketchSvg: string | null;
  /** Photo.id -> für das PDF verkleinertes JPEG oder PNG. Fehlt ein Eintrag, erscheint ein Hinweis statt des Bildes. */
  photos: Map<string, Uint8Array>;
  signatures: SignatureImages;
  /** Hinweis, warum keine Fotos eingebettet wurden, z. B. Dateispeicher nicht eingerichtet */
  photoNotice?: string | null;
};

function damageTable(pdf: Pdf, title: string, status: string, color: string, list: DocDamage[], emptyText: string) {
  pdf.sectionTitle(title, 60);
  if (list.length === 0) { pdf.paragraph(emptyText, { size: 9, color: COLORS.ink2 }); return; }
  pdf.table(
    [{ header: "Nr.", width: 5 }, { header: "Einstufung", width: 20 }, { header: "Ansicht", width: 18 }, { header: "Art", width: 12 }, { header: "Beschreibung", width: 25 }, { header: "Schwere", width: 10 }, { header: "Größe", width: 10 }],
    list.map((d): Cell[] => [String(d.index), { text: status, bold: true, color }, d.viewLabel, d.kindLabel, d.description, d.severityLabel, d.size || "–"]),
    { zebra: true },
  );
}

/** Rückgabe: Kilometer, Tank und Batterie im Vergleich zur Übergabe, dazu Mietdauer und Verspätung. */
function comparison(pdf: Pdf, data: HandoverDocumentData) {
  const c = data.comparison;
  if (!c) return;
  pdf.sectionTitle(`Vergleich mit der Übergabe (${c.pickupNumber})`, 80);
  pdf.table(
    [{ header: "", width: 22 }, { header: "Übergabe", width: 24, align: "right" }, { header: "Rückgabe", width: 24, align: "right" }, { header: "Differenz", width: 30, align: "right" }],
    c.rows.map((r): Cell[] => [{ text: r.label, bold: true }, r.pickup, r.ret, { text: r.diff, bold: r.attention, color: r.attention ? COLORS.bad : undefined }]),
  );
  pdf.keyValues([
    { label: "Mietbeginn", value: c.time.start },
    { label: "Geplante Rückgabe", value: c.time.plannedEnd },
    { label: "Tatsächliche Rückgabe", value: c.time.actualEnd },
    { label: "Verspätung", value: c.time.late ?? "keine" },
    ...(c.mileageBasis ? [{ label: "Kilometer laut Vertrag", value: c.mileageBasis }] : []),
    { label: "Tankregelung", value: c.fuelPolicy },
  ]);
}

/** Rückgabe: bestätigte Zusatzkosten und Kaution, getrennt ausgewiesen. */
function charges(pdf: Pdf, data: HandoverDocumentData) {
  const c = data.comparison;
  if (!c) return;
  pdf.sectionTitle("Zusatzkosten", 60);
  if (c.charges.length === 0) pdf.paragraph("Es wurden keine Zusatzkosten erfasst.", { size: 9, color: COLORS.ink2 });
  else {
    pdf.table(
      [{ header: "Position", width: 20 }, { header: "Beschreibung", width: 38 }, { header: "Menge", width: 14, align: "right" }, { header: "Einzelpreis", width: 14, align: "right" }, { header: "Betrag", width: 14, align: "right" }],
      [
        ...c.charges.map((x): Cell[] => [{ text: x.typeLabel, bold: true }, `${x.description}${x.damageIndex ? ` (Schaden Nr. ${x.damageIndex})` : ""}\n${x.formula}`, x.quantity, x.unitPrice, x.amount]),
        [{ text: "Gesamt Zusatzkosten", bold: true }, "", "", "", { text: c.chargesTotal, bold: true }],
      ],
      { zebra: true },
    );
    if (c.charges.some((x) => x.damageIndex)) pdf.paragraph("Eine Kostenposition zu einem Schaden hält nur die vom Vermieter erfasste Position fest. Sie ist keine Feststellung darüber, wer den Schaden verursacht hat.", { size: 8, color: COLORS.ink2 });
  }
  pdf.keyValues([
    { label: "Kaution laut Vertrag", value: c.deposit },
    { label: "Selbstbeteiligung laut Vertrag", value: c.deductible },
    { label: "Kautionsabrechnung", value: "offen, wird gesondert abgerechnet" },
  ]);
}

function drawResultIcon(pdf: Pdf, ok: boolean | null, x: number, y: number) {
  const doc = pdf.doc;
  const s = 8;
  doc.save();
  doc.undash().lineWidth(1.2).lineCap("round");
  if (ok === true) { doc.rect(x, y, s, s).fill(COLORS.good); doc.moveTo(x + 1.8, y + 4.2).lineTo(x + 3.4, y + 5.9).lineTo(x + 6.3, y + 2.3).strokeColor("#ffffff").stroke(); }
  else if (ok === false) { doc.rect(x, y, s, s).fill(COLORS.bad); doc.moveTo(x + 2.2, y + 2.2).lineTo(x + 5.8, y + 5.8).moveTo(x + 5.8, y + 2.2).lineTo(x + 2.2, y + 5.8).strokeColor("#ffffff").stroke(); }
  else { doc.rect(x + 0.4, y + 0.4, s - 0.8, s - 0.8).lineWidth(0.8).strokeColor(COLORS.ink3).stroke(); doc.moveTo(x + 2.2, y + 4).lineTo(x + 5.8, y + 4).strokeColor(COLORS.ink3).stroke(); }
  doc.restore();
}

function checklist(pdf: Pdf, items: HandoverDocumentData["checklist"]) {
  pdf.sectionTitle("Checkliste", 50);
  if (items.length === 0) { pdf.paragraph("Für diese Übergabe wurde keine Checkliste geführt.", { size: 9, color: COLORS.ink2 }); return; }
  const labelW = pdf.width * 0.5;
  const resultW = pdf.width * 0.2;
  const noteW = pdf.width - labelW - resultW - 16;
  const issues = items.filter((i) => i.ok === false).length;
  if (issues > 0) pdf.paragraph(`${issues} ${issues === 1 ? "Punkt wurde" : "Punkte wurden"} als auffällig vermerkt und ${issues === 1 ? "ist" : "sind"} unten hervorgehoben.`, { size: 9, bold: true, color: COLORS.bad });
  for (const item of items) {
    const result = item.result ? item.result.toUpperCase() : item.missing ? "NICHT BEANTWORTET" : "–";
    const flagged = item.ok === false;
    const h = Math.max(pdf.measure(item.label, labelW - 14, { size: 9, bold: flagged }), pdf.measure(result, resultW, { size: 8.5, bold: true }), pdf.measure(item.note ?? "", noteW, { size: 8.5 })) + 7;
    pdf.ensureSpace(h);
    const y = pdf.y;
    if (flagged) pdf.doc.rect(pdf.left, y, pdf.width, h).fill("#fbeceb");
    drawResultIcon(pdf, item.ok, pdf.left + 2, y + 4.2);
    pdf.textAt(item.label, pdf.left + 14, y + 3, labelW - 14, { size: 9, bold: flagged });
    pdf.textAt(result, pdf.left + labelW + 8, y + 3.3, resultW, { size: 8.5, bold: true, color: flagged ? COLORS.bad : item.ok === true ? COLORS.good : COLORS.ink2 });
    if (item.note) pdf.textAt(item.note, pdf.left + labelW + resultW + 16, y + 3.3, noteW, { size: 8.5, color: COLORS.ink2 });
    pdf.doc.moveTo(pdf.left, y + h).lineTo(pdf.left + pdf.width, y + h).lineWidth(0.4).strokeColor(COLORS.line).stroke();
    pdf.y = y + h;
  }
  pdf.gap(4);
}

function sketch(pdf: Pdf, data: HandoverDocumentData, svg: string | null) {
  pdf.sectionTitle("Fahrzeugskizze", 150);
  if (!data.sketch || !svg) {
    pdf.paragraph("Die Fahrzeugskizze dieser Fassung ist nicht verfügbar. Die Schäden sind unten vollständig aufgeführt.", { size: 9, color: COLORS.ink2 });
    pdf.note("Skizze nicht verfügbar");
    return;
  }
  const model = parseSketchSvg(svg);
  if (model.skipped.length > 0) pdf.note(`Skizze: nicht unterstützte Elemente übersprungen (${[...new Set(model.skipped)].join(", ")})`);
  const perRow = 3;
  const gapX = 12;
  const cellW = (pdf.width - gapX * (perRow - 1)) / perRow;
  const views = data.sketch.views;
  for (let i = 0; i < views.length; i += perRow) {
    const row = views.slice(i, i + perRow);
    const drawH = Math.min(128, Math.max(...row.map((v) => (cellW - 8) * (v.box[3] / v.box[2]))));
    const cellH = drawH + 24;
    pdf.ensureSpace(cellH + 4);
    const y = pdf.y;
    row.forEach((v, c) => {
      const x = pdf.left + c * (cellW + gapX);
      pdf.doc.roundedRect(x, y, cellW, cellH, 3).lineWidth(0.5).strokeColor(COLORS.line).stroke();
      const count = data.damages.filter((d) => d.view === v.key).length;
      pdf.textAt(`${v.label}${count > 0 ? ` (${count})` : ""}`, x + 5, y + 4, cellW - 10, { size: 8, bold: true, color: COLORS.ink2 });
      drawSketchView(pdf, model, v, { x: x + 4, y: y + 18, w: cellW - 8, h: drawH }, data.damages);
    });
    pdf.y = y + cellH + 6;
  }
  // Legende: Form und Farbe unterscheiden sich, damit die Einstufung auch im Schwarz-Weiß-Druck erkennbar bleibt
  const legend: [DamageSymbol, string][] = data.type === "PICKUP"
    ? [["circle", "Kreis: bestehender Schaden, bereits vor dieser Übergabe dokumentiert"], ["diamond", "Raute: bei dieser Übergabe dokumentierter Vorschaden"]]
    : [["circle", "Kreis: bereits vor Mietbeginn dokumentiert"], ["diamond", "Raute: bei der Übergabe dieser Miete dokumentierter Vorschaden"], ["triangle", "Dreieck: bei dieser Rückgabe neu festgestellt"]];
  pdf.ensureSpace(14 * legend.length + 20);
  let y = pdf.y + 2;
  for (const [symbol, text] of legend) {
    drawMarker(pdf, symbol, null, pdf.left + 6, y + 5, 4.2);
    y += pdf.textAt(text, pdf.left + 16, y, pdf.width - 16, { size: 8, color: COLORS.ink2 }) + 3;
  }
  y += 1;
  y += pdf.textAt(`Skizze: ${data.sketch.name}, Fassung ${data.sketch.version}. Die Nummern entsprechen den Schadenlisten.`, pdf.left, y, pdf.width, { size: 7.5, color: COLORS.ink3 });
  pdf.y = y + 4;
}

function photos(pdf: Pdf, data: HandoverDocumentData, assets: HandoverPdfAssets) {
  const general = data.photos.map((p) => ({ id: p.id, caption: p.categoryLabel }));
  const damage = data.damages.flatMap((d) => d.photos.map((p, i) => ({ id: p.id, caption: `Schaden ${d.index}: ${d.kindLabel}, ${d.viewLabel}${d.photos.length > 1 ? ` (${i + 1}/${d.photos.length})` : ""}` })));
  const all = [...general, ...damage];
  pdf.sectionTitle("Fotos", 60);
  if (all.length === 0) { pdf.paragraph("Zu dieser Übergabe sind keine Fotos gespeichert.", { size: 9, color: COLORS.ink2 }); pdf.note("keine Fotos"); return; }
  if (assets.photoNotice) pdf.paragraph(assets.photoNotice, { size: 9, color: COLORS.ink2 });
  const perRow = 3;
  const gapX = 10;
  const cellW = (pdf.width - gapX * (perRow - 1)) / perRow;
  const imgH = cellW * 0.75;
  for (let i = 0; i < all.length; i += perRow) {
    const row = all.slice(i, i + perRow);
    const capH = Math.max(...row.map((p) => pdf.measure(p.caption, cellW, { size: 8 })));
    pdf.ensureSpace(imgH + capH + 12);
    const y = pdf.y;
    row.forEach((p, c) => {
      const x = pdf.left + c * (cellW + gapX);
      const bytes = assets.photos.get(p.id);
      pdf.doc.rect(x, y, cellW, imgH).fill(COLORS.soft);
      if (bytes) {
        try { pdf.imageFit("photo", bytes, x, y, cellW, imgH); } catch { pdf.textAt("Foto kann nicht dargestellt werden", x + 6, y + imgH / 2 - 5, cellW - 12, { size: 8, color: COLORS.ink3, align: "center" }); pdf.note(`Foto ${p.id} nicht darstellbar`); }
      } else {
        pdf.textAt("Foto nicht eingebettet, Original liegt im Archiv", x + 6, y + imgH / 2 - 10, cellW - 12, { size: 8, color: COLORS.ink3, align: "center" });
        pdf.note(`Foto ${p.id} nicht eingebettet`);
      }
      pdf.textAt(p.caption, x, y + imgH + 3, cellW, { size: 8, color: COLORS.ink2 });
    });
    pdf.y = y + imgH + capH + 10;
  }
}

export async function renderHandoverPdf(data: HandoverDocumentData, assets: HandoverPdfAssets): Promise<{ bytes: Buffer; trace: PdfTrace }> {
  const ctx = data.context;
  const title = data.type === "PICKUP" ? "Fahrzeug-Übergabeprotokoll" : "Fahrzeug-Rückgabeprotokoll";
  const pdf = new Pdf({
    title,
    number: data.number,
    landlord: ctx?.landlord ?? { name: "", address: "", contact: "" },
    footerNote: data.contentHash ? { label: "Prüfsumme des versiegelten Protokolls (SHA-256)", value: data.contentHash } : undefined,
  });

  pdf.documentTitle(title, [
    [`Protokoll ${data.number}`, ctx?.contractNumber ? `Mietvertrag ${ctx.contractNumber}` : null, ctx ? `Buchung ${ctx.bookingNumber}` : null].filter(Boolean).join("  ·  "),
    data.finalizedAt ? `${data.type === "PICKUP" ? "Übergabe" : "Rückgabe"} abgeschlossen am ${data.finalizedAt}` : `Begonnen am ${data.startedAt}`,
  ]);

  if (ctx) {
    pdf.sectionTitle("Mieter und Fahrzeug");
    pdf.keyValues([
      { label: "Mieter", value: ctx.renterName || "–" },
      { label: "Fahrzeug", value: ctx.vehicleTitle || "–" },
      { label: "Kundennummer", value: ctx.renterNumber || "–" },
      { label: "Kennzeichen", value: ctx.plate || "–" },
      { label: "Mietvertrag", value: ctx.contractNumber || "–" },
      { label: "Fahrzeuggruppe", value: ctx.vehicleGroup || "–" },
    ]);
  }

  pdf.sectionTitle(data.type === "PICKUP" ? "Übergabedaten" : "Rückgabedaten");
  pdf.keyValues([
    { label: data.type === "PICKUP" ? "Übergabe am" : "Rückgabe am", value: data.finalizedAt ?? data.startedAt },
    { label: "Mitarbeiter", value: data.employeeName },
    ...data.readings.map((r) => ({ label: r.label, value: r.missing ? "nicht erfasst" : r.value })),
  ]);
  if (data.notes) { pdf.gap(2); pdf.keyValues([{ label: "Bemerkung", value: data.notes }], 1); }

  comparison(pdf, data);
  sketch(pdf, data, assets.sketchSvg);

  const existing = data.damages.filter((d) => d.marker === "EXISTING");
  const pickupNew = data.damages.filter((d) => d.marker === "PICKUP_NEW");
  const fresh = data.damages.filter((d) => d.marker === "NEW");
  if (data.type === "PICKUP") {
    damageTable(pdf, "Bestehende Schäden (vor dieser Übergabe bereits dokumentiert)", "BESTEHENDER SCHADEN", COLORS.ink2, existing, "Vor dieser Übergabe waren keine Schäden dokumentiert.");
    damageTable(pdf, "Bei Übergabe dokumentierte Vorschäden", "BEI ÜBERGABE DOKUMENTIERTER VORSCHADEN", COLORS.bad, fresh, "Bei dieser Übergabe wurden keine weiteren Schäden festgestellt.");
    if (fresh.length > 0) pdf.paragraph("Diese Schäden waren bei der Übergabe bereits am Fahrzeug vorhanden. Sie wurden vor Fahrtantritt gemeinsam dokumentiert und gelten als Vorschäden.", { size: 8.5, color: COLORS.ink2 });
  } else {
    damageTable(pdf, "Vor Mietbeginn dokumentierte Schäden", "VOR MIETBEGINN DOKUMENTIERT", COLORS.ink2, existing, "Vor Mietbeginn waren keine Schäden dokumentiert.");
    damageTable(pdf, "Bei der Übergabe dokumentierte Vorschäden", "BEI ÜBERGABE DOKUMENTIERTER VORSCHADEN", COLORS.ink2, pickupNew, "Bei der Übergabe wurden keine zusätzlichen Vorschäden dokumentiert.");
    damageTable(pdf, "Bei der Rückgabe neu festgestellte Schäden", "BEI RÜCKGABE FESTGESTELLT", COLORS.warn, fresh, "Bei der Rückgabe wurden keine neuen Schäden festgestellt.");
    if (fresh.length > 0) pdf.paragraph("Diese Schäden waren bei der Übergabe nicht dokumentiert und wurden bei der Rückgabe festgestellt. Das Protokoll hält den Zustand fest; über Verantwortung und Kosten wird gesondert entschieden.", { size: 8.5, color: COLORS.ink2 });
  }

  checklist(pdf, data.checklist);
  charges(pdf, data);
  photos(pdf, data, assets);
  drawSignatures(pdf, data.signatures, assets.signatures);
  return pdf.finish();
}
