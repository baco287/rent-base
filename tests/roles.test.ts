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
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/actions\.ts$/.test(f) || /\/(vertrag|uebergabe|rueckgabe|rechnung|neu)\/page\.tsx$/.test(p.split(path.sep).join("/"))) files.push(p); } };
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
  // Rechnungen: anlegen, bearbeiten, abschließen und versenden nur DISPO (und OWNER); PDF erzeugen und laden auch YARD
  const invoiceActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rechnung/actions.ts"), "utf8");
  assert.ok(!/"YARD"/.test(invoiceActions), "Rechnungsaktionen dürfen YARD nicht zulassen");
  const docActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/dokumente/actions.ts"), "utf8");
  assert.match(docActions, /export async function resendInvoiceAction[\s\S]*?requireRole\("DISPO"\)/, "Rechnungsversand nur DISPO");
  // Zahlungen und Kaution: Zahlung erfassen/stornieren, Kaution freigeben/einbehalten/korrigieren nur DISPO (und OWNER);
  // Kaution als erhalten dokumentieren auch YARD (operativ bei der Übergabe)
  const money = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/finanzen/actions.ts"), "utf8");
  const bodyOf = (name: string) => new RegExp(`export async function ${name}[\\s\\S]*?\\n}`).exec(money)?.[0] ?? "";
  for (const fn of ["recordPaymentAction", "cancelPaymentAction", "settleDepositAction", "cancelDepositEventAction", "previewPaymentAction", "previewDepositSettleAction"]) {
    assert.match(bodyOf(fn), /requireRole\("DISPO"\)/, `${fn}: nur Inhaber und Disponent`);
  }
  assert.match(bodyOf("recordDepositReceivedAction"), /requireRole\("DISPO", "YARD"\)/, "Kaution erhalten: auch Hofmitarbeiter");
});
