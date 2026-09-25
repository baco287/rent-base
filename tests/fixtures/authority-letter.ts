// Beispiel eines Anhörungsbogens (frei erfunden) für die Tests der Dokumenterkennung: als Text und als echtes PDF mit
// Textebene, erzeugt mit pdfkit (wie ein elektronisch erstelltes Behördenschreiben).
import PDFDocument from "pdfkit";

export const LETTER_LINES = [
  "Freie Hansestadt Bremen",
  "Stadtamt – Bußgeldstelle",
  "Stresemannstraße 48",
  "28207 Bremen",
  "",
  "JetRent GmbH",
  "Hafenstraße 12",
  "28217 Bremen",
  "",
  "Bremen, 02.09.2026",
  "",
  "Anhörung im Bußgeldverfahren – Zeugenfragebogen",
  "Aktenzeichen: 502.117.884-26    Bitte stets angeben",
  "",
  "Sehr geehrte Damen und Herren,",
  "mit dem Fahrzeug mit dem amtlichen Kennzeichen HB-JR 204 wurde folgende Ordnungswidrigkeit begangen:",
  "Tatzeit: 28.08.2026, 14:32 Uhr",
  "Tatort: Bremen, Hochstraße B75 Richtung Delmenhorst",
  "Sie überschritten die zulässige Höchstgeschwindigkeit innerhalb geschlossener Ortschaften um 21 km/h.",
  "Verwarnungsgeld: 70,00 EUR",
  "",
  "Bitte senden Sie den Fragebogen innerhalb einer Woche zurück, spätestens bis zum 16.09.2026.",
  "Sie können auch online antworten: https://anhoerung.bremen.de/owi",
  "Rückfragen: bussgeldstelle@stadtamt.bremen.de",
];
export const LETTER_TEXT = LETTER_LINES.join("\n");

export async function letterPdf(lines = LETTER_LINES): Promise<Uint8Array> {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  doc.fontSize(10);
  for (const l of lines) doc.text(l || " ");
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}
