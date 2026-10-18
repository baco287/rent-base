// Befehl 29.6: erzeugt das Vergleichs-Markup der gemeinsam genutzten Bausteine (Stand vor dem Umbau, d31deb0).
// Aufruf: npx tsx tests/fixtures/vertrag-296-markup.mts > tests/fixtures/vertrag-296-markup.json
// Der Test contract-wizard-296.test.ts rendert dieselben Aufrufe und vergleicht – ohne neue Props muss das Markup gleich bleiben.
import { markupCases } from "./vertrag-296-cases";

const out: Record<string, string> = {};
for (const [name, render] of Object.entries(markupCases)) out[name] = render();
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
