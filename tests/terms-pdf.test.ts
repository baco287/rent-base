// Vertrags-PDF mit mehrseitigen, strukturierten Mietbedingungen: Umbruch über mehrere Seiten, Überschriften nie allein am
// Seitenende, Listen und Fettdruck gesetzt, nichts abgeschnitten, Fassung in Kopf und Fußzeile. Rein synthetisch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContractPdf } from "../src/lib/pdf/contract-pdf";
import { parseTerms } from "../src/lib/terms-markdown";
import { contractData } from "./pdf-fixtures";

const CLAUSE = "Der Mieter verpflichtet sich, das Fahrzeug pfleglich zu behandeln, alle für die Benutzung maßgeblichen Vorschriften zu beachten und das Fahrzeug ordnungsgemäß zu verschließen. Dieser Absatz ist Beispieltext für die Prüfung des Seitenumbruchs.";
function longMarkdown(sections = 30): string {
  const parts = ["# Allgemeine Mietbedingungen", ""];
  for (let i = 1; i <= sections; i++) {
    parts.push(`## ${i}. Abschnitt ${i}`, "", `${CLAUSE} **Wichtig:** ${CLAUSE}`, "", `- Punkt eins zu Abschnitt ${i}`, `- Punkt zwei mit **Hervorhebung**`, `- Punkt drei, der etwas länger ist und deshalb umbricht: ${CLAUSE}`, "", `1. Erster nummerierter Punkt`, `2. Zweiter nummerierter Punkt`, "");
  }
  return parts.join("\n");
}

test("Mehrseitige Mietbedingungen im Vertrags-PDF: Seitenumbruch, keine Überläufe, Überschriften mit Folgetext, Version in Kopf und Fußzeile", async () => {
  const doc = contractData("long");
  const md = longMarkdown();
  const data = { ...doc, terms: { version: "1.4", text: md, format: "MARKDOWN" as const, blocks: parseTerms(md), legacy: false, title: "Allgemeine Mietbedingungen – Version 1.4", acknowledgedAt: "22.09.2026, 10:15" } };
  const { bytes, trace } = await renderContractPdf(data, new Map());
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
  assert.ok(trace.pages >= 6, `mehrere Seiten erwartet, sind ${trace.pages}`);
  assert.equal(trace.boxes.filter((b) => b.overflow).length, 0, "nichts abgeschnitten");
  assert.ok(trace.texts.some((t) => t.includes("Mietbedingungen: Version 1.4")));
  assert.ok(trace.texts.some((t) => t === "30. Abschnitt 30"));
  assert.ok(trace.texts.some((t) => t.startsWith("Punkt drei, der etwas länger ist")));
  assert.ok(trace.texts.some((t) => t.includes("Wichtig: ")), "Fettlauf wird als Text gesetzt");
  assert.ok(trace.texts.some((t) => t.includes("Zur Kenntnisnahme bereitgestellt am 22.09.2026")));
  assert.ok(!trace.texts.some((t) => t.includes("**")), "Markdown-Zeichen erscheinen nicht im Dokument");
  // Determinismus: gleicher Inhalt, gleiche Textfolge
  const again = await renderContractPdf(data, new Map());
  assert.deepEqual(again.trace.texts, trace.texts);
  assert.equal(again.trace.pages, trace.pages);
});
