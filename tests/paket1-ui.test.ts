// Paket 1: Oberflächen-Änderungen ohne Datenlogik – Tankgröße nur beim Anlegen ausgeblendet, Dokumentfotos deutlich und vor der
// Bestätigung, telefonische Zustimmung als zweiter Weg im Nachtrag (Server-Aktion mit Rollenprüfung), Rückgabe-Bemerkung optional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const src = (p: string) => readFile(path.join(process.cwd(), p), "utf8");

test("Tankgröße: beim Anlegen ausgeblendet, unter „Bearbeiten“ unverändert; Server unverändert (bestehende Werte bleiben)", async () => {
  const form = await src("src/app/(app)/fahrzeuge/vehicle-form.tsx");
  assert.match(form, /withTankCapacity = true,/);
  assert.match(form, /\{withTankCapacity && fuel !== "ELEKTRO" && \(/);
  assert.match(await src("src/app/(app)/fahrzeuge/neu/page.tsx"), /withTankCapacity=\{false\}/);
  assert.ok(!(await src("src/app/(app)/fahrzeuge/[id]/page.tsx")).includes("withTankCapacity"), "Bearbeiten zeigt das Feld weiter");
  assert.match(await src("src/app/(app)/fahrzeuge/actions.ts"), /tankCapacityLiters/, "Server-Validierung unverändert");
});

test("Dokumentfotos: deutlich (Kamera, „Dokumente fotografieren“, optional) und vor „Prüfung bestätigen“; Upload-Technik unverändert", async () => {
  const panel = await src("src/app/(app)/buchungen/[id]/uebergabe/driver-verification-panel.tsx");
  const photos = panel.indexOf("Dokumente fotografieren");
  const check = panel.indexOf("<DriverCheckForm action={verifyDriverAction");
  assert.ok(photos > 0 && check > 0 && photos < check, "Fotobereich steht vor dem Bestätigen (danach ist keine Kopie mehr möglich)");
  assert.match(panel, /<ShellIcon name="camera"/);
  assert.match(panel, /<Chip>optional<\/Chip>/);
  assert.match(panel, /keine Voraussetzung für die Prüfung der Originale/);
  const forms = await src("src/app/(app)/buchungen/[id]/uebergabe/driver-forms.tsx");
  assert.match(forms, /capture="environment"/, "Kamera am Handy wie bisher");
  assert.match(forms, /fetch\(`\/api\/handovers\/\$\{handoverId\}\/driver-documents`/, "bestehende Upload-Route");
  assert.match(forms, /fotografieren \(\{side === "FRONT" \? "Vorderseite" : "Rückseite"\}\)/);
  assert.match(await src("src/components/shell-icons.tsx"), /\n {2}camera: </);
});

test("Telefonische Zustimmung: eigene Server-Aktion mit Rollenprüfung, Bestätigung im Formular Pflicht, „Als vereinbart speichern“ nicht mehr angeboten", async () => {
  const actions = await src("src/app/(app)/buchungen/[id]/nachtrag/actions.ts");
  const fn = /export async function confirmAmendmentByPhoneAction[\s\S]*?\n}/.exec(actions)?.[0] ?? "";
  assert.match(fn, /await context\(\)/, "nur Inhaber/Disposition, nicht im Supportmodus");
  assert.match(fn, /phoneConsent: \{ confirmed: formData\.get\("confirmed"\) === "1"/);
  assert.match(fn, /ensureAmendmentDocument/, "PDF wie beim Unterschreiben");
  const form = await src("src/app/(app)/buchungen/[id]/nachtrag/phone-consent-form.tsx");
  assert.match(form, /disabled=\{!confirmed \|\| pending\}/, "Knopf erst nach Bestätigung aktiv");
  assert.match(form, /name="seenHash"/);
  const page = await src("src/app/(app)/buchungen/[id]/nachtrag/[aid]/page.tsx");
  assert.ok(!page.includes("Als vereinbart speichern") && !page.includes("agreeAmendmentAction"), "Vereinbaren ohne Unterschrift wird nicht mehr angeboten");
  assert.match(page, /Wie hat der Mieter der Änderung zugestimmt\?/);
  assert.match(page, /Telefonische Zustimmung des Mieters am/);
});

test("Rückgabe: Bemerkung bei Bestandspunkten optional – nur RETURN, Übergabe unverändert", async () => {
  const h = await src("src/lib/handovers.ts");
  assert.match(h, /const noteOptional = \(x: \{ itemKey: string; result: string \| null \}\) => h\.type === "RETURN" && x\.result === "NO" && RETURN_NOTE_OPTIONAL_ON_NO\.has\(x\.itemKey\);/);
  assert.match(await src("src/app/(app)/buchungen/[id]/rueckgabe/page.tsx"), /RETURN_NOTE_OPTIONAL_ON_NO\.has\(c\.itemKey\) \? "Bemerkung \(optional\)"/);
  assert.ok(!(await src("src/app/(app)/buchungen/[id]/uebergabe/page.tsx")).includes("RETURN_NOTE_OPTIONAL_ON_NO"));
});
