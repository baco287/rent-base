// Befehl 29.6: Mietvertragsassistent im Kartenlayout – reine Darstellung. Diese Tests sichern ab, dass sich dabei nichts
// Fachliches ändert: gemeinsame Bausteine rendern ohne neue Props byteweise wie vorher (Fixture vor dem Umbau), Schritt 1 sendet
// dieselben Kundenfelder, Schritt 6 zeigt jede Zeile des Vertragsdokuments genau einmal, die Übersicht rechnet nicht selbst,
// Konditionen-Komponenten und Layout-Regeln, Rollen und Mandantentrennung im Quelltext.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../src/lib/db";
import type { Issue } from "../src/lib/contract-checks";
import { buildContractDocument, type ContractDocument } from "../src/lib/contract-view";
import { ensureContractDraft, getContractState, saveConditions } from "../src/lib/contracts";
import { bookingTariffFor } from "../src/lib/tariffs";
import { createRatePlan } from "../src/lib/tariff-admin";
import { createAccidentCase } from "../src/lib/accident-replacement";
import { Field } from "../src/components/ui";
import { ContractTermsText } from "../src/components/terms-view";
import { parseTerms } from "../src/lib/terms-markdown";
import { CustomerFields, emptyCustomer } from "../src/app/(app)/kunden/customer-fields";
import { CONTRACT_CUSTOMER_CARDS, CONTRACT_CUSTOMER_SECTIONS } from "../src/app/(app)/kunden/customer-sections";
import { ContractDocumentView, DriverFields, PriceBreakdown, emptyDriver } from "../src/app/(app)/buchungen/[id]/vertrag/contract-parts";
import { DriverFeeFields, FinalizeForm, KmPolicyField, StepForm } from "../src/app/(app)/buchungen/[id]/vertrag/wizard-ui";
import { E5_MERGE_LABELS, buildOverviewData, buildReadiness, driverCheckState, editTargets, fieldIssues, groupDocumentRows, outsideRows, tariffLabel } from "../src/app/(app)/buchungen/[id]/vertrag/summary-map";
import { markupCases, sampleDocs } from "./fixtures/vertrag-296-cases";
import { createWorld, purgeTenants, type World } from "./helpers";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const DIR = "src/app/(app)/buchungen/[id]/vertrag";
const src = (p: string) => readFileSync(p, "utf8");
const r = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const names = (html: string) => [...html.matchAll(/ name="([^"]+)"/g)].map((m) => m[1]!);
const noop = async () => undefined;
const issue = (code: string, area: Issue["area"], message = code, severity: Issue["severity"] = "error"): Issue => ({ code, area, message, severity });

// ------------------------------------------------------------------ Markup-Stabilität der gemeinsamen Bausteine

test("1: gemeinsame Bausteine ohne neue Props rendern byteweise wie vor dem Umbau (Kunden, Buchung, Übergabe, Rückgabe, Nachtrag)", () => {
  const fixture = JSON.parse(src("tests/fixtures/vertrag-296-markup.json")) as Record<string, string>;
  assert.deepEqual(Object.keys(markupCases).sort(), Object.keys(fixture).sort(), "Fixture und Fälle passen zusammen");
  for (const [name, render] of Object.entries(markupCases)) assert.equal(render(), fixture[name], `Markup unverändert: ${name}`);
});

test("2: PriceBreakdown „document“ entspricht zeilengenau der Preis-Karte des Vertragsdokuments (Standard, Abweichung mit Notiz, Unfallersatz)", () => {
  for (const [name, doc] of Object.entries(sampleDocs)) {
    const view = r(h(ContractDocumentView, { doc, showSignatures: false }));
    const start = view.indexOf('<div class="px-4 py-3 text-sm flex flex-col">', view.indexOf(">Preis</h2>"));
    const end = view.indexOf("</section>", start);
    assert.ok(start > 0 && end > start, name);
    assert.equal(r(h(PriceBreakdown, { price: doc.price, variant: "document", className: "px-4 py-3 text-sm flex flex-col" })), view.slice(start, end), `gleich: ${name}`);
  }
  // „conditions“: kurzes Label, keine Zeile „Berechneter Mietpreis“, Summe ohne „(brutto)“, Kaution-Zeile
  const c = r(h(PriceBreakdown, { price: sampleDocs.agreed!.price, variant: "conditions" }));
  assert.match(c, />Abweichend vereinbart</);
  assert.ok(!c.includes("Sonderpreis Stammkunde") && !c.includes("Berechneter Mietpreis") && !c.includes("(brutto)") && c.includes(">Gesamtmietpreis<") && c.includes(">Kaution<"));
});

test("3: Field (Zeichen, Hinweis) und Bedingungstext (headingOffset) – neue Props wirken nur, wenn gesetzt", () => {
  const f = r(h(Field, { label: "Vorname", htmlFor: "firstName", mark: "save", issue: { describedBy: "hinweis-x", error: true, messages: [{ id: "hinweis-x", text: "Vorname fehlt.", error: true }] }, children: h("input", { id: "firstName" }) }));
  assert.match(f, /<span aria-hidden="true"[^>]*>\*<\/span><span class="sr-only">\(Pflichtfeld\)<\/span>/);
  assert.match(f, /<p id="hinweis-x" class="[^"]*text-bad[^"]*">/);
  const c = r(h(Field, { label: "Ort", htmlFor: "city", mark: "close", children: h("input", { id: "city" }) }));
  assert.match(c, />°<\/span><span class="sr-only">\(für den Abschluss nötig\)<\/span>/);
  const md = "# Titel\n\n## Abschnitt\n\n### Unterabschnitt\n\nText";
  const shifted = r(h(ContractTermsText, { blocks: parseTerms(md), text: md, compact: true, headingOffset: 1 }));
  assert.ok(shifted.includes("<h4") && shifted.includes("<h5") && shifted.includes("<h6") && !shifted.includes("<h3"));
});

// ------------------------------------------------------------------ Schritt 1/2/5: gleiche Feldnamen

test("4: Schritt 1 – die Abschnitts-Karten senden zusammen genau die Felder von CustomerFields compact (keins fehlt, keins doppelt)", () => {
  assert.deepEqual(CONTRACT_CUSTOMER_CARDS.map((c) => c.section), [...CONTRACT_CUSTOMER_SECTIONS]);
  assert.equal(new Set(CONTRACT_CUSTOMER_CARDS.map((c) => c.id)).size, CONTRACT_CUSTOMER_CARDS.length, "Karten-IDs eindeutig");
  for (const values of [emptyCustomer, { ...emptyCustomer, type: "COMPANY", companyName: "Hansa GmbH" }]) {
    const all = names(r(h(CustomerFields, { values, compact: true }))).sort();
    const parts = CONTRACT_CUSTOMER_SECTIONS.flatMap((s) => names(r(h(CustomerFields, { values, compact: true, sections: [s], headings: false })))).sort();
    assert.deepEqual(parts, all, `gleiche Namen (${values.type})`);
    assert.equal(new Set(parts).size, parts.length, "jeder Name genau einmal");
    assert.ok(!all.includes("legacyNumber") && !all.includes("discountPercent") && !all.includes("blocked") && !all.includes("notes"), "Verwaltungsfelder wie bisher nicht im Vertrag");
  }
  assert.ok(!/^"use client"/.test(src("src/app/(app)/kunden/customer-sections.ts")), "neutrales Modul (in der Server-Seite als Wert nutzbar)");
  assert.ok(!/export const \w*(SECTIONS|CARDS)/.test(src("src/app/(app)/kunden/customer-fields.tsx")), "keine Abschnitts-Konstanten aus dem Client-Modul");
  const page = src(`${DIR}/page.tsx`);
  assert.match(page, /CONTRACT_CUSTOMER_CARDS\.map\(/);
  assert.ok(!/sections=\{\[/.test(page), "keine fest verdrahteten Abschnitte in page.tsx");
});

test("5: Fahrerfelder – Person und Führerschein ergeben zusammen die Standardfelder, customerId genau einmal", () => {
  for (const prefix of ["d_", "a_"]) {
    const all = names(r(h(DriverFields, { values: emptyDriver, prefix }))).sort();
    const parts = [...names(r(h(DriverFields, { values: emptyDriver, prefix, section: "person" }))), ...names(r(h(DriverFields, { values: emptyDriver, prefix, section: "license" })))].sort();
    assert.deepEqual(parts, all, prefix);
    assert.equal(parts.filter((n) => n === `${prefix}customerId`).length, 1, `${prefix}customerId genau einmal`);
  }
  const withIssue = r(h(DriverFields, { values: emptyDriver, prefix: "d_", section: "license", issues: { d_licenseValidUntil: { describedBy: "hinweis-1", error: true, messages: [{ id: "hinweis-1", text: "abgelaufen", error: true }] } } }));
  assert.match(withIssue, /<input id="d_licenseValidUntil"[^>]*aria-invalid="true" aria-describedby="hinweis-1"[^>]*name="d_licenseValidUntil"/);
  assert.ok(!/aria-invalid/.test(withIssue.replace(/id="d_licenseValidUntil"[^>]*>/, "")), "aria-invalid nur am betroffenen Feld");
});

// ------------------------------------------------------------------ Zuordnungen (reine Funktionen)

test("6: Feldhinweise – Prüfcodes landen am richtigen Feld bzw. Kartenkopf, Banner-Codes nirgends", () => {
  const c = fieldIssues([issue("CUSTOMER_CONTACT", "CUSTOMER", "Telefonnummer oder E-Mail des Mieters fehlt."), issue("CUSTOMER_ID", "CUSTOMER"), issue("CUSTOMER_BLOCKED", "CUSTOMER")], "CUSTOMER");
  assert.equal(c.fields.phone!.messages.length, 1, "Meldung einmal am ersten Feld");
  assert.equal(c.fields.email!.messages.length, 0);
  assert.equal(c.fields.email!.describedBy, c.fields.phone!.describedBy, "beide Felder verknüpft");
  assert.ok(c.fields.idNumber && !Object.values(c.fields).some((f) => f.messages.some((m) => m.text === "CUSTOMER_BLOCKED")), "Sperre nur im Kopf");
  const d = fieldIssues([issue("DRIVER_ADDRESS", "DRIVER"), issue("LICENSE_EXPIRED", "DRIVER"), issue("DRIVER_MISSING", "DRIVER")], "DRIVER");
  assert.deepEqual(["d_street", "d_zip", "d_city"].map((f) => !!d.fields[f]), [true, true, true]);
  assert.equal(d.fields.d_street!.messages.length + d.fields.d_zip!.messages.length + d.fields.d_city!.messages.length, 1);
  assert.ok(d.fields.d_licenseValidUntil!.error && d.cards["fahrer-anders"]!.length === 1);
  assert.deepEqual(fieldIssues([issue("LICENSE_EXPIRED", "DRIVER")], "DRIVER", { enabled: false }), { fields: {}, cards: {} }, "gespeicherter Modus RENTER bzw. ?vonKunde: keine Feldhinweise");
  const k = fieldIssues([issue("NEGATIVE_VALUE", "CONDITIONS", "Kaution darf nicht negativ sein."), issue("NEGATIVE_VALUE", "CONDITIONS", "Selbstbeteiligung darf nicht negativ sein."), issue("NEGATIVE_VALUE", "CONDITIONS", "Mehrkilometerpreis darf nicht negativ sein."), issue("NUMBER_MISSING", "CONDITIONS"), issue("TERMS_REQUIRED", "CONDITIONS"), issue("PRICE_MISMATCH", "PRICE"), issue("ABROAD_MISMATCH", "CONDITIONS"), issue("FUEL_NOTE", "CONDITIONS")], "CONDITIONS");
  assert.equal(k.cards["k4-d"]!.length, 2);
  assert.equal(k.cards["k4-e"]!.length, 1);
  assert.equal(k.cards["k4-c"]!.length, 1);
  assert.equal(k.cards["k4-f"]!.length, 1);
  assert.ok(k.fields.fuelPolicyNote);
  const placed = [...Object.values(k.cards).flat(), ...Object.values(k.fields).flatMap((f) => f.messages)].map((x) => ("code" in x ? x.code : x.text));
  assert.ok(!placed.includes("NUMBER_MISSING") && !placed.includes("TERMS_REQUIRED"), "nur im Banner");
});

test("7: Fahrerstatus in Schritt 2 – nur aus dem gespeicherten Stand", () => {
  assert.equal(driverCheckState({ savedMode: "RENTER", prefill: false, issues: [] }), "valid");
  assert.equal(driverCheckState({ savedMode: "RENTER", prefill: false, issues: [issue("DRIVER_NAME", "DRIVER", "x", "warning")] }), "valid");
  assert.equal(driverCheckState({ savedMode: "RENTER", prefill: false, issues: [issue("LICENSE_EXPIRED", "DRIVER")] }), "check");
  assert.equal(driverCheckState({ savedMode: "OTHER", prefill: false, issues: [] }), "pending");
  assert.equal(driverCheckState({ savedMode: "RENTER", prefill: true, issues: [] }), "pending");
});

test("8: „Bearbeiten“-Ziele – dorthin, wo ein Wert der Karte änderbar ist", () => {
  const base = { bookingId: "b1", tariffLocked: false, deductibleLocked: false, abroadLocked: false, accident: false, caseHref: null };
  const std = editTargets(base);
  assert.equal(std.renter!.href, "/buchungen/b1/vertrag?schritt=1");
  assert.equal(std.vehicle!.href, "/buchungen/b1");
  assert.ok(std.price!.href.includes("schritt=4") && std.deposit!.href.includes("schritt=4") && std.abroad!.href.includes("schritt=4"));
  assert.equal(std.other, null);
  assert.equal(std.terms, null);
  const tariff = editTargets({ ...base, tariffLocked: true });
  assert.equal(tariff.price!.text, "In der Buchung ändern");
  assert.ok(tariff.deposit!.href.includes("schritt=4"), "Selbstbeteiligung noch im Vertrag änderbar");
  assert.ok(tariff.km!.href.includes("schritt=4"), "Tank, Tiere, Rauchen bleiben in Schritt 4");
  assert.equal(editTargets({ ...base, tariffLocked: true, deductibleLocked: true }).deposit!.href, "/buchungen/b1");
  assert.equal(editTargets({ ...base, abroadLocked: true }).abroad!.href, "/buchungen/b1");
  const ue = editTargets({ ...base, accident: true, caseHref: "/unfallersatz/c1" });
  assert.equal(ue.price!.href, "/unfallersatz/c1");
  assert.ok(ue.period!.href.includes("schritt=4"), "Orte auch beim Unfallersatz im Vertrag");
  assert.equal(editTargets({ ...base, accident: true, caseHref: null }).price, null, "ohne Fallakten-Link kein Link");
});

// ------------------------------------------------------------------ keine zweite Preisberechnung

test("9: Übersicht rechnet nicht selbst – Beträge und Texte unverändert aus dem Vertragsdokument", () => {
  for (const f of ["summary-map.ts", "summary-panel.tsx", "wizard-layout.tsx", "wizard-shell.tsx"]) {
    const s = src(`${DIR}/${f}`);
    assert.ok(!/calculateRentalPrice|quoteTariff|contractPrice|basisFromSnapshot|booking-price|@\/lib\/pricing|@\/lib\/tariffs|@\/lib\/money/.test(s), `${f}: keine Preis-/Tariffunktionen`);
    assert.ok(!/^"use server"/m.test(s), `${f}: keine Server-Aktion`);
  }
  assert.ok(!/\*\s*100|\/\s*100\b/.test(src(`${DIR}/summary-map.ts`)), "keine Betragsrechnung");
  const doc: ContractDocument = { ...sampleDocs.standard!, sections: [...sampleDocs.standard!.sections] };
  const o = buildOverviewData(doc, { startAt: new Date("2026-10-17T07:00:00Z"), endAt: new Date("2026-10-24T07:00:00Z") }, { tariff: "PLUS · Rev. 2" });
  assert.equal(o.price.total, doc.price.total);
  assert.deepEqual(o.outside, outsideRows(doc));
  assert.deepEqual(o.outside.map((x) => x.label), ["Kaution", "Selbstbeteiligung"]);
  assert.ok(!o.price.lines.some((l) => /Kaution|Selbstbeteiligung/.test(l.text)), "Kaution/Selbstbeteiligung nicht im Mietpreis");
  const ue = buildOverviewData(sampleDocs.accident!, { startAt: new Date(), endAt: null }, { tariff: "Tarif der Fallakte" });
  assert.ok(ue.period.to === "offen – bis zur Rückgabe" && ue.price.perDay === "94,00 € je Miettag" && !/\b0 Tage\b/.test(JSON.stringify(ue)));
  assert.equal(tariffLabel({ ratePlanId: "x", snapshot: null, accident: false }), "Miettarif laut Buchung (Stufen nicht verfügbar)");
  assert.equal(tariffLabel({ ratePlanId: null, snapshot: null, accident: false }), "ohne Miettarif (Altbuchung)");
  assert.equal(tariffLabel({ ratePlanId: "x", snapshot: { ratePlanName: "PLUS", revision: 2 }, accident: false }), "PLUS · Rev. 2");
  const ready = buildReadiness([issue("CUSTOMER_ID", "CUSTOMER"), issue("CUSTOMER_PHONE", "CUSTOMER", "x", "warning")], { selected: true, acknowledged: false }, false);
  assert.deepEqual(ready.map((x) => x.text), ["1 Punkt offen", "vollständig", "vollständig", "vollständig", "folgt in Schritt 7", "fehlt"], "nur Fehler zählen");
  assert.equal(buildReadiness([], { selected: true, acknowledged: false }, false, 7)[4]!.text, "fehlt", "in Schritt 7 selbst: Kenntnisnahme fehlt");
});

// ------------------------------------------------------------------ Konditionen-Komponenten und Layout-Regeln

test("10: Konditionen – rulesPresent genau einmal in page.tsx, Kilometerregel bei Tarif nur verborgen, Unfallersatz ohne Preisregel-Feld", () => {
  const page = src(`${DIR}/page.tsx`);
  assert.equal((page.match(/name="rulesPresent"/g) ?? []).length, 1);
  assert.ok(!src(`${DIR}/wizard-ui.tsx`).includes('name="rulesPresent"'));
  const locked = r(h(KmPolicyField, { value: "FREE_KILOMETERS", note: "", kmLocked: true, source: "Buchung" }));
  assert.equal(names(locked).filter((n) => n === "kmPolicy").length, 1, "genau ein kmPolicy (verborgen)");
  assert.match(locked, /<input type="hidden" name="kmPolicy" value="FREE_KILOMETERS"/);
  assert.match(locked, /<select id="kmPolicy" disabled=""/);
  const open = r(h(KmPolicyField, { value: "INDIVIDUAL", note: "x", source: "Standard" }));
  assert.deepEqual(names(open), ["kmPolicy", "kmPolicyNote"]);
  assert.ok(!names(r(h(DriverFeeFields, { driverFeeNote: "Hinweis", allowed: true, feeType: "PER_DAY", fee: "15,00", sources: {} }))).includes("additionalDriverFeeType"));
  assert.deepEqual(names(r(h(DriverFeeFields, { allowed: true, feeType: "PER_DAY", fee: "15,00", sources: {} }))), ["additionalDriverFeeType", "additionalDriverFeeCents"]);
  assert.match(page, /readOnly=\{deductibleLocked\}/);
  assert.match(page, /<input id="deductible" name="deductible" inputMode="decimal" defaultValue=\{dec\(contract\.deductible\)\} required readOnly=\{deductibleLocked\} className=/, "Feld Selbstbeteiligung unverändert");
});

test("11: Layout – Formulare display: contents, Leiste sticky (nie fixed), Abschlussgrund auf allen Breiten, Container nur um Raster", () => {
  const step = r(h(StepForm, { action: noop, step: 2, variant: "page", info: "Hinweis", children: h("input", { name: "x" }) }));
  assert.match(step, /^<form class="contents"/);
  assert.match(step, /data-action-bar="" class="sticky bottom-0 /);
  assert.ok(!/\bfixed\b/.test(step), "nie fixed");
  assert.match(step, /value="back" formNoValidate=""[^>]*name="nav"/);
  assert.match(step, /value="next"[^>]*name="nav"/);
  assert.ok(!r(h(StepForm, { action: noop, step: 1, variant: "page", children: h("span", null) })).includes('value="back"'), "Schritt 1 ohne Zurück");
  const fin = r(h(FinalizeForm, { action: noop, disabled: true, reason: "Es fehlt noch die Unterschrift des Mieters.", variant: "bar", left: h("a", { href: "?schritt=6" }, "Zurück") }));
  assert.match(fin, /^<form class="contents"/);
  const reason = /<span id="abschluss-grund" aria-live="polite" class="([^"]*)">Es fehlt noch die Unterschrift des Mieters\.<\/span>/.exec(fin);
  assert.ok(reason && !reason[1]!.includes("hidden"), "Grund sichtbar, auch mobil");
  assert.match(fin, /aria-describedby="abschluss-grund"[^>]*>Mietvertrag verbindlich abschließen</, "Knopftext zusammenhängend, mit Grund verknüpft");
  const page = src(`${DIR}/page.tsx`);
  assert.ok(page.includes('<div className="flex min-w-0 flex-col gap-4">'), "Hauptspalte ohne @container");
  for (const f of ["page.tsx", "wizard-ui.tsx", "wizard-layout.tsx", "contract-parts.tsx"]) assert.ok(!/["\s]col-span-2/.test(src(`${DIR}/${f}`)), `${f}: keine Spannweite ohne Präfix`);
  assert.ok(src(`${DIR}/wizard-layout.tsx`).includes('<div className="@container/cards min-w-0">'));
});

test("12: Rollen und Mandanten – Seite unverändert abgesichert, keine zusätzlichen Abfragen", () => {
  const page = src(`${DIR}/page.tsx`);
  assert.match(page, /await requireRole\("DISPO", "YARD"\)/);
  assert.match(page, /if \(!canEdit && booking\.contract\?\.status !== "SIGNED" && booking\.contract\?\.status !== "CANCELLED"\) redirect\(/);
  const calls = page.match(/db\.\w+\.\w+\(\{[^]*?\}\)/g) ?? [];
  assert.equal((page.match(/\bdb\.\w+\.\w+\(/g) ?? []).length, 5, "genau die bisherigen fünf Abfragen");
  for (const c of calls) assert.ok(/tenantId: tenant\.id/.test(c), `mandantengebunden: ${c.slice(0, 60)}`);
  for (const f of ["contract-icons.tsx", "wizard-layout.tsx", "wizard-shell.tsx", "summary-map.ts", "summary-panel.tsx"]) assert.ok(!/"use server"/.test(src(`${DIR}/${f}`)), f);
  for (const bound of ["saveConditionsStepAction", "saveSignatureAction", "finalizeContractAction", "saveCustomerStepAction", "saveDriverStepAction", "addDriverAction"]) assert.match(page, new RegExp(`${bound}\\.bind\\(null, booking\\.id\\)`), bound);
});

// ------------------------------------------------------------------ Schritt 6: jede Zeile genau einmal (echte Vertragsdokumente)

const DAY = 86_400_000;
const T4 = [{ days: 1, cents: 6000 }, { days: 5, cents: 27000 }, { days: 7, cents: 36000 }, { days: 30, cents: 140000 }];
async function docOf(w: World): Promise<ContractDocument> {
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const state = await getContractState(w.tenantId, c.id);
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } });
  return buildContractDocument(state.contract, tenant, state.signatures);
}
async function world(label: string, opts: Parameters<typeof createWorld>[1] = {}) {
  const w = await createWorld(label, opts);
  tenants.push(w.tenantId);
  return w;
}
function assertEachRowOnce(doc: ContractDocument, label: string) {
  const g = groupDocumentRows(doc);
  const placed = Object.values(g.cards).flatMap((c) => c.groups.flatMap((x) => x.rows));
  const all = [...doc.sections.flatMap((s) => s.rows), ...(doc.rules?.rows ?? [])];
  assert.equal(placed.length + g.merged.length, all.length, `${label}: Anzahl`);
  for (const row of all) assert.equal(placed.filter((p) => p === row).length + g.merged.filter((m) => m.row === row).length, 1, `${label}: genau einmal – ${row.label}`);
  for (const m of g.merged) assert.ok((E5_MERGE_LABELS as readonly string[]).includes(m.row.label), `${label}: nur ausdrücklich erlaubte Zusammenführung (${m.row.label})`);
  return g;
}

test("13: Schritt 6 – jede Zeile aus Konditionen und Geschäftsregeln genau einmal (Standard, Tarif, Unfallersatz, Auslandsfahrt, Elektro und Verbrenner mit Mindeststand)", async () => {
  // Standard (Altbestand: Selbstbeteiligung steht in Konditionen UND Regeln mit gleichem Wert → E5)
  const std = await world("w296-std");
  const gStd = assertEachRowOnce(await docOf(std), "Standard");
  assert.ok(gStd.merged.some((m) => m.row.label === "Selbstbeteiligung") && gStd.merged.some((m) => m.row.label === "Tankregelung"));

  // Tarifbuchung (29.5: vereinbarte Selbstbeteiligung nur in den Konditionen)
  const tw = await world("w296-tarif");
  const owner = { id: tw.userId, name: "Inhaberin" };
  const plan = await createRatePlan(tw.tenantId, owner, { meta: { name: "PLUS", code: null, description: null, sortOrder: 0 }, content: { km: { policy: "FREE_KILOMETERS", kmIncludedPerDay: 200, extraKmRateCents: 25 }, depositCents: 20000, deductibleCents: 75000, groups: [{ groupId: tw.groupId, tiers: T4, depositCents: null, km: null }] }, active: true, createKey: randomUUID() });
  const b = await db.booking.findUniqueOrThrow({ where: { id: tw.bookingId } });
  await db.$transaction(async (tx) => {
    const res = await bookingTariffFor(tx, tw.tenantId, owner, { vehicleId: b.vehicleId, ratePlanId: plan.id, startAt: b.startAt, endAt: b.endAt!, discountPercent: 0, choices: { price: { mode: "TARIFF" }, km: { mode: "TARIFF" }, deposit: { mode: "TARIFF" } }, previous: null });
    await tx.booking.update({ where: { id: tw.bookingId }, data: res.data });
  });
  const tDoc = await docOf(tw);
  const gT = assertEachRowOnce(tDoc, "Tarif");
  assert.ok(gT.cards.price.groups[0]!.rows.some((x) => x.label === "Miettarif"));
  assert.ok(gT.cards.deposit.groups.flatMap((x) => x.rows).some((x) => x.label === "Vereinbarte Selbstbeteiligung im Schadenfall"));

  // Auslandsfahrt laut Buchung
  const aw = await world("w296-ausland");
  await db.tenant.update({ where: { id: aw.tenantId }, data: { businessRules: { abroadAllowed: true, abroadCountries: ["AT", "CH"] } } });
  await db.booking.update({ where: { id: aw.bookingId }, data: { abroadAllowed: true, abroadCountries: ["AT"], abroadSurchargeCents: 4900 } });
  const gA = assertEachRowOnce(await docOf(aw), "Auslandsfahrt");
  assert.equal(gA.cards.abroad.groups[0]!.rows[0]!.label, "Auslandsfahrten");

  // Elektro und Verbrenner mit Mindeststand: Lade- bzw. Tankregel weicht von der Konditionszeile ab → beide Zeilen
  for (const [label, fuel, rules] of [["Elektro", "ELEKTRO", { batteryMinimumPercent: 80 }], ["Verbrenner", "DIESEL", { fuelMinimumEighths: 6 }]] as const) {
    const ew = await world(`w296-${label}`);
    await db.vehicle.update({ where: { id: ew.vehicleId }, data: { fuel } });
    const c = await ensureContractDraft(ew.tenantId, ew.bookingId, ew.actor);
    await saveConditions(ew.tenantId, c.id, { startAt: c.startAt, endAt: c.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "MINIMUM_LEVEL", rules: { kmPolicy: "FREE_KILOMETERS", ...rules, abroadAllowed: false, abroadCountries: [], smokingAllowed: false, petsPolicy: "BY_APPROVAL", additionalDriverFeeType: "FREE", additionalDriverFeeCents: 0 } } as never, ew.actor);
    const g = assertEachRowOnce(await docOf(ew), label);
    const km = g.cards.km.groups.flatMap((x) => x.rows.map((y) => y.label));
    assert.ok(km.includes("Tankregelung") && km.some((l) => l === (fuel === "ELEKTRO" ? "Laderegel" : "Tankregelung")) && km.length >= 4, `${label}: Konditions- und Regelzeile`);
    assert.equal(g.cards.km.groups.length, 2, `${label}: Untergruppen „Konditionen“ und „Geschäftsregeln dieses Vertrags“`);
  }

  // Unfallersatz (offenes Ende, keine Kaution)
  const uw = await world("w296-ue");
  await db.tenantFeatureFlag.create({ data: { tenantId: uw.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  const v2 = await db.vehicle.create({ data: { tenantId: uw.tenantId, plate: `HB-UE ${randomUUID().slice(0, 4).toUpperCase()}`, make: "VW", model: "Golf", groupId: uw.groupId, fuel: "BENZIN", mileage: 30_000, dailyRate: 59, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 0, tankCapacityLiters: 50, requiredLicenseClass: "B" } });
  const ue = await createAccidentCase(uw.tenantId, uw.actor, {
    nonce: `t296-${randomUUID().slice(0, 12)}`, customerId: uw.customerId, vehicleId: v2.id, startAt: new Date(Date.now() + 3_600_000), plannedEndAt: new Date(Date.now() + 9 * DAY), dailyRateCents: 7_900, depositCents: 0, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "hb-ab 123", make: "Opel", model: "Astra", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: new Date(Date.now() - 2 * DAY), place: "Bremen", opponentPlate: "OL-X 99", opponentName: "Gegner GmbH", policeFileNumber: "AZ 1" },
    insurer: { name: "HUK-COBURG", claimNumber: null, contactName: null, phone: null, email: null, street: null, zip: null, city: null },
    liability: { status: "REPORTED" },
    tariff: [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1500 }],
  } as never);
  const uDoc = await docOf({ ...uw, bookingId: ue.bookingId });
  const gU = assertEachRowOnce(uDoc, "Unfallersatz");
  const ueText = JSON.stringify({ g: gU, o: buildOverviewData(uDoc, { startAt: new Date(), endAt: null }, { tariff: "Tarif der Fallakte" }) });
  assert.ok(!ueText.includes("Geplante Rückgabe") && !/\b0 Tage\b/.test(ueText), "kein Ersatzdatum, keine 0 Tage");
  assert.ok(outsideRows(uDoc).some((x) => x.value === "keine Kaution vereinbart"));
});
