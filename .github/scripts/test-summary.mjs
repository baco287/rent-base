// Fasst den JUnit-Bericht des Node-Testrunners für die Job-Zusammenfassung von GitHub Actions zusammen:
// Anzahl der Tests und eine Tabelle der gescheiterten Tests mit Datei und erster Zeile der Fehlermeldung.
// Aufruf: node .github/scripts/test-summary.mjs test-results.xml >> "$GITHUB_STEP_SUMMARY"
// Mit --annotations stattdessen je gescheitertem Test eine Fehler-Annotation am Lauf (auch ohne Anmeldung sichtbar).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const annotations = args.includes("--annotations");
const file = args.find((a) => !a.startsWith("--")) ?? "test-results.xml";
if (!existsSync(file)) {
  if (!annotations) console.log(`## Tests\n\nKein Testbericht vorhanden (\`${file}\`). Die Tests liefen nicht bis zum Ende, Ursache im Log des vorherigen Schritts.`);
  process.exit(0);
}

const xml = readFileSync(file, "utf8");
const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decode(m[1]) : "";
};
const cell = (s) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

// Jeder Testfall: <testcase …/> oder <testcase …>…<failure …>…</testcase>.
// Attribute werden über ihre Anführungszeichen erkannt: Meldungen enthalten oft ">" (z. B. "() =>").
const ATTRS = '((?:\\s+[\\w:-]+="[^"]*")*)';
const TESTCASE = new RegExp(`<testcase${ATTRS}\\s*(\\/>|>([\\s\\S]*?)<\\/testcase>)`, "g");
const FAILURE = new RegExp(`<failure${ATTRS}\\s*\\/?>`);
const cases = [...xml.matchAll(TESTCASE)].map((m) => {
  const failure = m[3]?.match(FAILURE);
  const fullPath = attr(m[1], "file");
  return {
    name: attr(m[1], "name"),
    file: path.basename(fullPath.replace(/\\/g, "/")),
    relPath: path.relative(process.cwd(), fullPath).replace(/\\/g, "/"),
    failed: Boolean(failure),
    type: failure ? attr(failure[1], "type") : "",
    message: failure ? essence(attr(failure[1], "message")) : "",
  };
});

/** Die aussagekräftige Zeile einer Fehlermeldung: Datenbankfehler, sonst Ist/Soll eines Vergleichs, sonst die erste Zeile. */
function essence(message) {
  const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
  const patterns = [/Unique constraint/i, /deadlock detected/i, /could not serialize/i, /RB_[A-Z_]+/, /Transaction (already closed|API error)|expired transaction/i, /\bP20\d\d\b/, /timed out|test timed out/i];
  for (const p of patterns) {
    const hit = lines.find((l) => p.test(l));
    if (hit) return hit;
  }
  const actual = lines.find((l) => /^\+ (?!actual)/.test(l));
  const expected = lines.find((l) => /^- (?!expected)/.test(l));
  if (actual && expected) return `ist ${actual.slice(2)}, erwartet ${expected.slice(2)}`;
  return lines[0] ?? "";
}
const failed = cases.filter((c) => c.failed);

const lines = [`## Tests: ${cases.length - failed.length} von ${cases.length} bestanden, ${failed.length} fehlgeschlagen`, ""];
if (failed.length) {
  lines.push("| Datei | Test | Art | Meldung |", "|---|---|---|---|");
  for (const c of failed) lines.push(`| ${cell(c.file)} | ${cell(c.name).slice(0, 160)} | ${cell(c.type)} | ${cell(c.message).slice(0, 220)} |`);
}

if (annotations) {
  // Workflow-Befehle (::error …::), Sonderzeichen nach GitHub-Vorgabe kodiert
  const data = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (s) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  for (const c of failed) console.log(`::error file=${prop(c.relPath)},title=${prop(c.name.slice(0, 200))}::${data(`${c.type}: ${c.message}`.slice(0, 500))}`);
} else console.log(lines.join("\n"));
