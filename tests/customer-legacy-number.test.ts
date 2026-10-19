// Fehler E3 (Befehl 29.6): Schritt 1 des Mietvertragsassistenten leerte beim Speichern die alte Kundennummer (legacyNumber),
// weil das kompakte Kundenformular sie nicht sendet und customerToData fehlende Angaben zu null macht. Seit dem Fix schreibt der
// Vertragsschritt nur die Felder, die das Formular sendet (contractStepCustomerData). Diese Tests simulieren genau die
// Formularübermittlung (gerendertes kompaktes Formular → customerSchema → Speichern wie in saveCustomerStepAction) und prüfen:
// vorhandene, leere und unveränderte Kundennummern, ausdrückliche Änderungen in der Kundenverwaltung, keine anderen Kundendaten,
// Mandantentrennung und Rollenprüfung (Quelltext der Aktion).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../src/lib/db";
import { contractStepCustomerData, customerSchema, customerToData } from "../src/lib/customer-schema";
import { customerToFormValues } from "../src/lib/customer-form-values";
import { CustomerFields, type CustomerFormValues } from "../src/app/(app)/kunden/customer-fields";
import { createWorld, purgeTenants, type World } from "./helpers";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** Was der Browser beim Absenden des gerenderten Formulars sendet: Eingabefelder mit value, Auswahlfelder mit der gewählten Option. */
function submitted(values: CustomerFormValues, compact: boolean): Record<string, string> {
  const html = renderToStaticMarkup(h(CustomerFields, { values, compact }));
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    const name = /\sname="([^"]+)"/.exec(tag)?.[1];
    const isBox = /\stype="checkbox"/.test(tag);
    if (!name || (isBox && !/\schecked=""/.test(tag))) continue;
    // ohne value-Attribut sendet der Browser für eine angehakte Checkbox „on“
    out[name] = decode(/\svalue="([^"]*)"/.exec(tag)?.[1] ?? (isBox ? "on" : ""));
  }
  for (const m of html.matchAll(/<select\b[^>]*\sname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    out[m[1]!] = decode(/<option value="([^"]*)" selected=""/.exec(m[2]!)?.[1] ?? /<option value="([^"]*)"/.exec(m[2]!)?.[1] ?? "");
  }
  for (const m of html.matchAll(/<textarea\b[^>]*\sname="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) out[m[1]!] = decode(m[2]!);
  return out;
}
const load = (w: World) => db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
/** Schritt 1 des Vertragsassistenten speichern – dieselben Schritte wie saveCustomerStepAction (Validierung, Daten, Mandant). */
async function saveContractStep(w: World, change: Partial<CustomerFormValues> = {}, tenantId = w.tenantId) {
  const form = submitted({ ...customerToFormValues(await load(w)), ...change }, true);
  return db.customer.updateMany({ where: { id: w.customerId, tenantId }, data: contractStepCustomerData(customerSchema.parse(form)) });
}
/** Kundenverwaltung (vollständiges Formular) speichern – wie updateCustomerAction. */
async function saveCustomerAdmin(w: World, change: Partial<CustomerFormValues>) {
  const form = submitted({ ...customerToFormValues(await load(w)), ...change }, false);
  return db.customer.updateMany({ where: { id: w.customerId, tenantId: w.tenantId }, data: customerToData(customerSchema.parse(form)) });
}
async function world(label: string, customer: Record<string, unknown> = {}) {
  const w = await createWorld(label, { customer });
  tenants.push(w.tenantId);
  return w;
}
const comparable = (c: Awaited<ReturnType<typeof load>>) => { const { updatedAt: _u, ...rest } = c; void _u; return rest; };

test("1: vorhandene alte Kundennummer bleibt beim Speichern von Schritt 1 erhalten; geänderte Felder werden gespeichert", async () => {
  const w = await world("legacy-1", { legacyNumber: "ALT-4711", notes: "Stammkunde", discountPercent: 10 });
  const r = await saveContractStep(w, { phone: "0421 999 000", street: "Neue Straße 1" });
  assert.equal(r.count, 1);
  const c = await load(w);
  assert.equal(c.legacyNumber, "ALT-4711", "alte Kundennummer unverändert");
  assert.equal(c.phone, "0421 999 000");
  assert.equal(c.street, "Neue Straße 1");
  assert.equal(c.notes, "Stammkunde", "Notizen unverändert");
  assert.equal(c.discountPercent, 10, "Rabatt unverändert");
  assert.equal(c.blocked, false);
});

test("2: leere alte Kundennummer bleibt leer (kein Wert wird erfunden)", async () => {
  const w = await world("legacy-2", { legacyNumber: null });
  await saveContractStep(w, { city: "Hamburg" });
  const c = await load(w);
  assert.equal(c.legacyNumber, null);
  assert.equal(c.city, "Hamburg");
});

test("3: unverändert gespeichert – zweimal Schritt 1 ohne Änderung ändert keinen einzigen Kundenwert", async () => {
  const w = await world("legacy-3", { legacyNumber: "K-ALT-0815", notes: "Rechnung per Post", blocked: true, blockReason: "Offene Forderung", discountPercent: 5, birthPlace: "Bremen", nationality: "deutsch", idIssuedBy: "Stadt Bremen", licenseIssuedBy: "Stadt Bremen" });
  const before = comparable(await load(w));
  await saveContractStep(w);
  await saveContractStep(w);
  assert.deepEqual(comparable(await load(w)), before);
});

test("4: ausdrückliche Änderungen der alten Kundennummer in der Kundenverwaltung funktionieren weiter (setzen, ändern, löschen)", async () => {
  const w = await world("legacy-4", { legacyNumber: null });
  await saveCustomerAdmin(w, { legacyNumber: "NEU-1" });
  assert.equal((await load(w)).legacyNumber, "NEU-1");
  await saveCustomerAdmin(w, { legacyNumber: "NEU-2" });
  assert.equal((await load(w)).legacyNumber, "NEU-2");
  await saveContractStep(w, { phone: "0421 1" });
  assert.equal((await load(w)).legacyNumber, "NEU-2", "danach im Vertrag gespeichert: bleibt");
  await saveCustomerAdmin(w, { legacyNumber: "" });
  assert.equal((await load(w)).legacyNumber, null, "ausdrücklich geleert");
  // gesperrter Kunde: Änderung der Kundennummer in der Kundenverwaltung lässt Sperre und Grund unverändert
  const g = await world("legacy-4-gesperrt", { legacyNumber: "ALT-G", blocked: true, blockReason: "Offene Forderung", notes: "Achtung" });
  await saveCustomerAdmin(g, { legacyNumber: "ALT-G2" });
  const cg = await load(g);
  assert.deepEqual([cg.legacyNumber, cg.blocked, cg.blockReason, cg.notes], ["ALT-G2", true, "Offene Forderung", "Achtung"]);
});

test("5: Schritt 1 schreibt nur Felder, die das kompakte Formular sendet (keine anderen Kundendaten)", async () => {
  for (const type of ["PRIVATE", "COMPANY"]) {
    const w = await world(`legacy-5-${type}`, { type, companyName: type === "COMPANY" ? "Hansa GmbH" : null, legacyNumber: "ALT-5" });
    const form = submitted(customerToFormValues(await load(w)), true);
    const written = Object.keys(contractStepCustomerData(customerSchema.parse(form)));
    // companyName wird bei Privatkunden wie bisher ausdrücklich auf null gesetzt (abhängig von der Kundenart, die das Formular sendet)
    const notSent = written.filter((k) => !(k in form) && !(k === "companyName" && type === "PRIVATE"));
    assert.deepEqual(notSent, [], `${type}: jedes geschriebene Feld kommt aus dem Formular`);
    for (const k of ["legacyNumber", "notes", "discountPercent", "blocked", "blockReason"]) assert.ok(!written.includes(k), `${type}: ${k} wird nicht geschrieben`);
    assert.ok(!("legacyNumber" in form), "das kompakte Formular enthält die alte Kundennummer nicht");
  }
});

test("6: Mandantentrennung und Rollen – fremder Mandant ändert nichts; die Aktion bleibt mandanten- und rollengebunden", async () => {
  const w = await world("legacy-6", { legacyNumber: "ALT-6" });
  const other = await world("legacy-6-fremd");
  const before = comparable(await load(w));
  const r = await saveContractStep(w, { phone: "0000" }, other.tenantId);
  assert.equal(r.count, 0, "fremder Mandant trifft den Kunden nicht");
  assert.deepEqual(comparable(await load(w)), before);
  const src = readFileSync("src/app/(app)/buchungen/[id]/vertrag/actions.ts", "utf8");
  const body = /export async function saveCustomerStepAction[\s\S]*?\n}\n/.exec(src)?.[0] ?? "";
  assert.match(body, /await context\(bookingId\)/, "Rollenprüfung über context()");
  assert.match(src, /async function context\(bookingId: string\) \{\n  const \{ tenant, user \} = await requireRole\("DISPO"\);/, "nur Inhaber und Disponent");
  assert.match(body, /db\.customer\.updateMany\(\{ where: \{ id: contract\.customerId, tenantId: tenant\.id \}, data: contractStepCustomerData\(parsed\.data\) \}\)/);
  assert.ok(!/customerToData/.test(body), "kein ungefiltertes customerToData im Vertragsschritt");
  // Kundenverwaltung unverändert: speichert alle Felder des vollständigen Formulars (ausdrückliche Änderungen)
  assert.match(readFileSync("src/app/(app)/kunden/actions.ts", "utf8"), /db\.customer\.updateMany\(\{ where: \{ id, tenantId: tenant\.id \}, data: customerToData\(parsed\.data\) \}\)/);
});
