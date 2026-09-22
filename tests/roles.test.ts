// Rollenmatrix: dieselbe Funktion, die requireRole in jeder Server Action und geschützten Seite als Erstes aufruft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { roleAllows } from "../src/lib/constants";

const ROLES = ["OWNER", "DISPO", "YARD"] as const;
const matrix: [string, readonly string[], Record<(typeof ROLES)[number], boolean>][] = [
  ["Buchung erstellen/ändern/stornieren", ["DISPO"], { OWNER: true, DISPO: true, YARD: false }],
  ["Mietvertrag erstellen/bearbeiten/finalisieren, Konditionen", ["DISPO"], { OWNER: true, DISPO: true, YARD: false }],
  ["Fahrzeuge und Gruppen pflegen", ["DISPO"], { OWNER: true, DISPO: true, YARD: false }],
  ["Übergabe, Rückgabe, Schäden, Fotos, Checkliste, Unterschrift, Zusatzkosten", ["DISPO", "YARD"], { OWNER: true, DISPO: true, YARD: true }],
  ["Kunden anlegen und ergänzen", ["DISPO", "YARD"], { OWNER: true, DISPO: true, YARD: true }],
  ["Dokumente erzeugen, ansehen, E-Mail erneut senden", ["DISPO", "YARD"], { OWNER: true, DISPO: true, YARD: true }],
  ["Einstellungen, Benutzer, Löschen", ["OWNER"], { OWNER: true, DISPO: false, YARD: false }],
];

test("Rollenmatrix: Inhaber alles, Disponent disponiert, Hofmitarbeiter führt Übergabe und Rückgabe durch", () => {
  for (const [what, allowed, expected] of matrix) for (const role of ROLES) assert.equal(roleAllows(role, allowed), expected[role], `${role}: ${what}`);
  assert.equal(roleAllows("GAST", ["DISPO", "YARD"]), false);
  assert.equal(roleAllows("", ["DISPO"]), false);
});

/** Jede Server Action und jede geschützte Seite muss die Rollenprüfung enthalten, nicht nur die Oberfläche. */
test("Jede Server-Action-Datei und jede Prozessseite prüft die Rolle serverseitig", () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/actions\.ts$/.test(f) || /\/(vertrag|uebergabe|rueckgabe|neu)\/page\.tsx$/.test(p.split(path.sep).join("/"))) files.push(p); } };
  walk(path.join(process.cwd(), "src", "app", "(app)"));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(/requireRole\(/.test(src), `${path.relative(process.cwd(), f)} ohne requireRole`);
    const exportedActions = (src.match(/export async function \w+/g) ?? []).length;
    if (/^"use server";/.test(src)) assert.ok((src.match(/requireRole\(/g) ?? []).length >= 1 && exportedActions > 0, `${path.relative(process.cwd(), f)}: Aktionen ohne Rollenprüfung`);
  }
  // Vertragsaktionen: nur DISPO (und damit OWNER)
  const contractActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/vertrag/actions.ts"), "utf8");
  assert.ok(!/requireRole\("DISPO", "YARD"\)/.test(contractActions), "Vertragsaktionen dürfen YARD nicht zulassen");
  const bookingActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/actions.ts"), "utf8");
  assert.ok(!/"YARD"/.test(bookingActions), "Buchungsaktionen dürfen YARD nicht zulassen");
});
