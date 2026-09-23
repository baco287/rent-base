// Dokumentdaten für PDF-Tests und die Vorschau (tests/pdf-preview.mts). Rein synthetisch, keine Datenbank.
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ContractDocumentData, DocSection } from "../src/lib/contract-view";
import type { DocDamage, HandoverDocumentData } from "../src/lib/handover-view";

const landlord = { name: "JetRent Autovermietung", address: "Hafenstraße 12, 28195 Bremen", contact: "0421 555 01 23 · info@jetrent.example", email: "info@jetrent.example" };

const driver = (key: string, title: string, name: string): DocSection => ({
  key,
  title,
  rows: [
    { label: "Name", value: name },
    { label: "Geburtsdatum", value: "12.03.1985" },
    { label: "Adresse", value: "Weg 1, 28195 Bremen" },
    { label: "Führerscheinnummer", value: "B072RRE2I55" },
    { label: "Klasse", value: "B, BE" },
    { label: "Ausgestellt am", value: "01.06.2005" },
    { label: "Gültig bis", value: "01.06.2033" },
    { label: "Ausstellungsland", value: "Deutschland" },
  ],
});

export const LONG_NAME = "Maximiliane-Alexandra Şükriye von Hohenzollern-Sigmaringen zu Königsberg-Łukaszewicz";
export const LONG_ADDRESS = "Friedrich-Ebert-Straße am Alten Güterbahnhof 1234a, Hinterhaus, 3. Obergeschoss links, Appartement 17b";

const TERMS_PARAGRAPH = "Der Mieter verpflichtet sich, das Fahrzeug pfleglich zu behandeln, alle für die Benutzung maßgeblichen Vorschriften und technischen Regeln zu beachten und das Fahrzeug ordnungsgemäß zu verschließen. Dies ist ein Beispieltext für die Prüfung des Seitenumbruchs und keine rechtlich geprüfte Formulierung.";

export function longTerms(sections = 28): string {
  return Array.from({ length: sections }, (_, i) => `§ ${i + 1} Beispielabschnitt ${i + 1}\n\n${TERMS_PARAGRAPH} ${TERMS_PARAGRAPH}\n\n${TERMS_PARAGRAPH}`).join("\n\n");
}

export function contractData(variant: "short" | "long"): ContractDocumentData {
  const long = variant === "long";
  const renterName = long ? LONG_NAME : "Al Li";
  return {
    title: "Mietvertrag",
    number: "MV-2026-0042",
    status: "SIGNED",
    landlord,
    renterEmail: "kunde@example.test",
    renterName,
    vehicleTitle: "VW Crafter",
    plate: "HB-RT 200",
    startAt: "21.09.2026, 10:00",
    createdAt: "20.09.2026, 13:10",
    signedAt: "20.09.2026, 13:34",
    contentHash: "500e21351fb162c7076a1a6bdb46af436f3620d0dee3cedb88d9ddbe7a58ff1b",
    sections: [
      { key: "renter", title: "Mieter", rows: [
        { label: "Kundennummer", value: "K-00042" }, { label: "Kundenart", value: "Privatkunde" }, { label: "Name", value: renterName }, { label: "Geburtsdatum", value: "12.03.1985" },
        { label: "Straße und Hausnummer", value: long ? LONG_ADDRESS : "Weg 1" }, { label: "PLZ und Ort", value: "28195 Bremen" }, { label: "Land", value: "Deutschland" }, { label: "Telefon", value: "0421 12345" },
        { label: "E-Mail", value: long ? "maximiliane-alexandra.von-hohenzollern-sigmaringen@sehr-lange-beispieldomain.example" : "al@example.test" }, { label: "Ausweis", value: "Personalausweis L01X00T47" }, { label: "Ausweis gültig bis", value: "01.01.2031" },
      ] },
      driver("driver", "Fahrer (Mieter fährt selbst)", renterName),
      { key: "vehicle", title: "Fahrzeug", rows: [
        { label: "Kennzeichen", value: "HB-RT 200" }, { label: "Fahrzeug", value: "VW Crafter" }, { label: "Fahrzeuggruppe", value: "Transporter 3,5 t" }, { label: "Antrieb", value: "Diesel" },
        { label: "Fahrgestellnummer", value: "WV1ZZZSYZK9012345" }, { label: "Kilometerstand bei Vertragserstellung", value: "50.000 km" },
      ] },
      { key: "period", title: "Mietzeitraum", rows: [
        { label: "Mietbeginn", value: "21.09.2026, 10:00" }, { label: "Geplante Rückgabe", value: "27.09.2026, 10:00" }, { label: "Mietdauer", value: "6 Tage" }, { label: "Abholort", value: "Hafenstraße 12, Bremen" }, { label: "Rückgabeort", value: "Hafenstraße 12, Bremen" },
      ] },
      { key: "conditions", title: "Konditionen", rows: [
        { label: "Kaution", value: "500,00 €" }, { label: "Freikilometer", value: "200 km je Tag, gesamt 1.200 km" }, { label: "Mehrkilometer", value: "0,25 € je km" }, { label: "Selbstbeteiligung", value: "1.000,00 €" },
        { label: "Tankregelung", value: long ? "Andere Regelung: Das Fahrzeug wird mit halb vollem Tank übergeben und ist mit mindestens demselben Füllstand zurückzugeben, fehlender Kraftstoff wird berechnet." : "Voll übernommen, voll zurück" },
      ] },
    ],
    additionalDrivers: long ? [driver("a1", "Zusatzfahrer 1", "Jan Kowalski"), driver("a2", "Zusatzfahrer 2", LONG_NAME), driver("a3", "Zusatzfahrer 3", "Ünal İpek")] : [],
    price: {
      days: 6,
      lines: [{ text: "1 × Woche (5 Tage) zu 420,00 €", amount: "420,00 €" }, { text: "1 × Tag zu 89,00 €", amount: "89,00 €" }],
      subtotal: "509,00 €",
      discount: long ? { text: "Rabatt 10 %", amount: "−50,90 €" } : null,
      calculated: "458,10 €",
      agreed: long ? { text: "Abweichend vereinbart: Stammkundenpreis laut Absprache mit der Geschäftsführung", amount: "450,00 €" } : null,
      total: long ? "450,00 €" : "509,00 €",
      extras: long ? [{ text: "1 × Zusatzfahrer (pauschal) zu 15,00 €", amount: "15,00 €" }] : [],
      deposit: "500,00 €",
    },
    rules: long ? { key: "rules", title: "Geschäftsregeln dieses Vertrags", rows: [{ label: "Kilometerregel", value: "200 km je Tag (gesamt 1.200 km), Mehrkilometer 0,25 € je km" }, { label: "Tankregelung", value: "Voll/Voll" }, { label: "Auslandsfahrten", value: "Genehmigt für: Österreich, Niederlande" }, { label: "Rauchen im Fahrzeug", value: "Nicht gestattet" }, { label: "Tiere im Fahrzeug", value: "Nur nach Absprache" }] } : null,
    individualAgreements: long ? "Kindersitz wird kostenlos gestellt. Rückgabe am Sonntag nach Absprache bis 20 Uhr." : null,
    terms: { version: "2026-09", text: long ? longTerms() : "§ 1 Beispiel\n\nDas Fahrzeug ist pfleglich zu behandeln.", format: "PLAIN", blocks: null, legacy: true, title: "Mietbedingungen (Fassung 2026-09)", acknowledgedAt: null },
    signatures: [
      { id: "sig-renter", role: "RENTER", roleLabel: "Mieter", signerName: renterName, signedAt: "20.09.2026, 13:33", imageUrl: "" },
      ...(long ? [{ id: "sig-employee", role: "EMPLOYEE", roleLabel: "Vermieter", signerName: "Sezer Karakuş", signedAt: "20.09.2026, 13:34", imageUrl: "" }] : []),
    ],
  };
}

const VIEWS = [
  { key: "FRONT", label: "Vorne", box: [40, 280, 320, 270] }, { key: "REAR", label: "Hinten", box: [380, 280, 320, 270] }, { key: "LEFT", label: "Links (Fahrerseite)", box: [10, 20, 490, 230] },
  { key: "RIGHT", label: "Rechts (Beifahrerseite)", box: [510, 20, 490, 230] }, { key: "TOP", label: "Dach", box: [720, 280, 260, 270] }, { key: "INTERIOR", label: "Innenraum", box: [40, 575, 560, 250] },
] as { key: string; label: string; box: [number, number, number, number] }[];

function damage(i: number, marker: "EXISTING" | "NEW", view: string, posX: number, posY: number, photos: number): DocDamage {
  const v = VIEWS.find((x) => x.key === view)!;
  return {
    id: `d${i}`, index: i, marker, symbol: marker === "NEW" ? "diamond" : "circle", markerLabel: marker === "NEW" ? "Neu entdeckt (Vorschaden)" : "Bereits dokumentiert", view, viewLabel: v.label, posX, posY,
    kind: "SCRATCH", kindLabel: i % 3 === 0 ? "Delle" : "Kratzer", severity: "MINOR", severityLabel: i % 4 === 0 ? "Mittel" : "Leicht", size: i % 2 === 0 ? "ca. 6 cm" : null,
    description: i % 5 === 0 ? "Langer Kratzer quer über die gesamte Schiebetür bis in den hinteren Radlauf, Lack bis auf die Grundierung beschädigt, bereits leicht angerostet" : `Schaden ${i} an ${v.label}`,
    photos: Array.from({ length: photos }, (_, p) => ({ id: `dp-${i}-${p}`, url: "" })),
  };
}

export function handoverData(variant: "empty" | "full"): HandoverDocumentData {
  const full = variant === "full";
  const corners: [number, number][] = [[0, 0], [1, 1], [0.5, 0.5], [1, 0], [0, 1]];
  const damages = full
    ? Array.from({ length: 14 }, (_, i) => {
        const [x, y] = corners[i % corners.length];
        return damage(i + 1, i < 8 ? "EXISTING" : "NEW", VIEWS[i % VIEWS.length].key, x, y, i === 9 ? 3 : i === 11 ? 2 : 0);
      })
    : [];
  const categories = [["FRONT", "Vorne"], ["REAR", "Hinten"], ["LEFT", "Links"], ["RIGHT", "Rechts"], ["INTERIOR", "Innenraum"], ["ODOMETER", "Kilometerstand"], ["FUEL", "Tank / Batterie"], ["OTHER", "Weitere"], ["OTHER", "Weitere"]];
  return {
    context: { landlord, contractNumber: "MV-2026-0042", bookingNumber: "2026-0107", renterName: full ? LONG_NAME : "Al Li", renterNumber: "K-00042", vehicleTitle: "VW Crafter", plate: "HB-RT 200", vehicleGroup: "Transporter 3,5 t" },
    comparison: null,
    title: "Übergabeprotokoll", number: "UP-2026-0042", type: "PICKUP", status: "FINALIZED", startedAt: "21.09.2026, 09:48", finalizedAt: "21.09.2026, 10:07", employeeName: "Sezer Karakuş",
    contentHash: "7978de30115c62c7076a1a6bdb46af436f3620d0dee3cedb88d9ddbe7a58aa01",
    readings: [{ label: "Kilometerstand", value: "50.123 km", missing: false }, { label: "Antrieb", value: full ? "Plug-in-Hybrid" : "Diesel", missing: false }, { label: "Tankstand", value: "6/8", missing: false }, ...(full ? [{ label: "Batteriestand", value: "80 %", missing: false }] : [])],
    notes: full ? "Fahrzeug wurde außen gewaschen übergeben. Der Mieter wurde auf die Durchfahrtshöhe von 2,60 m hingewiesen und hat die Einweisung in die Ladungssicherung erhalten." : null,
    sketch: { assetPath: "/sketches/generic-transporter-v2.svg", version: 2, name: "Allgemeiner Transporter", views: VIEWS },
    damages,
    checklist: full
      ? Array.from({ length: 26 }, (_, i) => ({
          label: i % 6 === 0 ? `Prüfpunkt ${i + 1}: Sehr ausführlich beschriebener Punkt zur Kontrolle von Bordwerkzeug, Wagenheber, Reserverad, Abschleppöse und Zurrgurten im Laderaum` : `Prüfpunkt ${i + 1}`,
          result: i === 2 ? "2" : i % 9 === 4 ? "Nicht in Ordnung" : i % 7 === 6 ? "Nicht zutreffend" : i % 2 ? "Ja" : "In Ordnung",
          ok: i === 2 ? null : i % 9 === 4 ? false : i % 7 === 6 ? null : true,
          note: i % 9 === 4 ? "Auffälligkeit wurde dem Mieter gezeigt und hier vermerkt, Reparatur ist nach der Miete eingeplant." : null,
          missing: false,
        }))
      : [{ label: "Fahrzeugschein und Bordmappe vorhanden", result: "Ja", ok: true, note: null, missing: false }, { label: "Anzahl übergebener Schlüssel", result: "2", ok: null, note: null, missing: false }],
    photos: full ? categories.map(([category, categoryLabel], i) => ({ id: `p${i}`, url: "", category, categoryLabel })) : [],
    missingPhotoCategories: [],
    signatures: [
      { id: "sig-renter", role: "RENTER", roleLabel: "Mieter", signerName: full ? LONG_NAME : "Al Li", signedAt: "21.09.2026, 10:06", imageUrl: "" },
      ...(full ? [{ id: "sig-employee", role: "EMPLOYEE", roleLabel: "Vermieter", signerName: "Sezer Karakuş", signedAt: "21.09.2026, 10:07", imageUrl: "" }] : []),
    ],
  };
}

/** Unterschrift als PNG mit transparentem Hintergrund, bewusst breit (4:1), um Verzerrungen zu erkennen. */
export async function signaturePng(width = 800, height = 200): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="M20 ${height * 0.7} C ${width * 0.2} ${height * 0.1}, ${width * 0.3} ${height * 0.95}, ${width * 0.45} ${height * 0.5} S ${width * 0.7} ${height * 0.2}, ${width - 20} ${height * 0.6}" fill="none" stroke="#1a2230" stroke-width="5" stroke-linecap="round"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Testfoto in Kameragröße, damit die Verkleinerung wirklich etwas zu tun hat. */
export async function photoJpeg(label: string, width = 2000, height = 1500): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16325c"/><stop offset="1" stop-color="#7a8494"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="80" y="${height / 2}" font-size="140" fill="#fff" font-family="sans-serif">${label}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

export const sketchSvg = () => readFile(path.join(process.cwd(), "public", "sketches", "generic-transporter-v2.svg"), "utf8");
