// Mietbedingungen als Markdown-Teilmenge. Bewusst klein gehalten und selbst geparst: kein HTML, keine Skripte,
// keine Links, keine Bilder. Unterstützt: Überschriften (#, ##, ###), Absätze, Aufzählungen (-, *) und
// nummerierte Listen (1.), fett (**text**). Alles andere ist Text. Dieselbe Struktur speist Vorschau, Vertragsansicht
// und PDF; das Ergebnis ist deterministisch (gleicher Text → gleiche Blöcke).

export type TextRun = { text: string; bold: boolean };
export type TermsBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; runs: TextRun[] }
  | { type: "list"; ordered: boolean; items: TextRun[][] };

/** Zerlegt eine Zeile in Text- und Fettläufe. Unpaarige ** bleiben Text. */
export function parseRuns(line: string): TextRun[] {
  const runs: TextRun[] = [];
  let bold = false;
  let buf = "";
  let i = 0;
  const flush = () => { if (buf) { runs.push({ text: buf, bold }); buf = ""; } };
  while (i < line.length) {
    if (line.startsWith("**", i)) {
      // nur umschalten, wenn ein schließendes ** folgt (bei Öffnung) – sonst Text
      if (!bold && line.indexOf("**", i + 2) < 0) { buf += "**"; i += 2; continue; }
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    buf += line[i];
    i += 1;
  }
  flush();
  return runs.length ? runs : [{ text: "", bold: false }];
}

export const runsText = (runs: TextRun[]) => runs.map((r) => r.text).join("");

/** Markdown-Teilmenge → Blöcke. Leere Zeilen trennen Absätze; Listen enden an einer Leerzeile oder einem anderen Block. */
export function parseTerms(source: string): TermsBlock[] {
  const lines = (source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: TermsBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: "paragraph", runs: parseRuns(para.join(" ").replace(/\s+/g, " ").trim()) }); para = []; } };
  const flushList = () => { if (list) { blocks.push({ type: "list", ordered: list.ordered, items: list.items.map((t) => parseRuns(t)) }); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, " ").trimEnd();
    const trimmed = line.trim();
    if (!trimmed) { flushPara(); flushList(); continue; }
    const h = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (h) { flushPara(); flushList(); blocks.push({ type: "heading", level: h[1].length as 1 | 2 | 3, text: h[2].replace(/\*\*/g, "").trim() }); continue; }
    const ul = /^[-*•]\s+(.+)$/.exec(trimmed);
    const ol = /^\d{1,3}[.)]\s+(.+)$/.exec(trimmed);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol && !ul;
      const text = (ul ?? ol)![1].trim();
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(text);
      continue;
    }
    if (list) {
      // Fortsetzungszeile eines Listenpunkts (eingerückt) – sonst beginnt ein Absatz
      if (/^\s{2,}/.test(line)) { list.items[list.items.length - 1] += ` ${trimmed}`; continue; }
      flushList();
    }
    para.push(trimmed);
  }
  flushPara();
  flushList();
  return blocks;
}

/** Reiner Text der Blöcke (für Suche, Prüfsummen-Anzeige, Tests). */
export function termsPlainText(blocks: TermsBlock[]): string {
  return blocks.map((b) => (b.type === "heading" ? b.text : b.type === "paragraph" ? runsText(b.runs) : b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : "•"} ${runsText(it)}`).join("\n"))).join("\n\n");
}

/** Strukturvorlage für den ersten Entwurf: nur Überschriften, keine Klauseln. Der Text bleibt bewusst leer. */
export const TERMS_STRUCTURE_TEMPLATE = [
  "# Allgemeine Mietbedingungen",
  "",
  "Mustertext – vor Verwendung rechtlich prüfen. Diese Vorlage enthält nur die Gliederung; die Inhalte legt der Vermieter fest.",
  "",
  ...["Geltungsbereich", "Mietfahrzeug", "Mietdauer", "Fahrer", "Nutzung", "Auslandsfahrten", "Kilometer", "Kraftstoff und Ladung", "Übergabe", "Rückgabe", "Unfall und Panne", "Schäden", "Versicherung und Selbstbeteiligung", "Kaution", "Reinigung", "Schlüssel und Zubehör", "Behörden und Verkehrsverstöße", "Zahlung", "Datenschutz", "Individuelle Vereinbarungen"].flatMap((t, i) => [`## ${i + 1}. ${t}`, "", ""]),
].join("\n");

/** Grobe Plausibilität für den Editor: Länge, keine HTML-Tags. */
export function validateTermsSource(source: string): string | null {
  if (!source || source.trim().length < 20) return "Der Text der Mietbedingungen ist zu kurz.";
  if (source.length > 200_000) return "Der Text ist zu lang (maximal 200.000 Zeichen).";
  if (/<\s*\/?\s*[a-z][^>]*>/i.test(source)) return "HTML ist in den Mietbedingungen nicht erlaubt. Bitte nur Text, Überschriften (#), Listen (-) und fett (**) verwenden.";
  return null;
}
