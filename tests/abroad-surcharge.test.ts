// Auslandsfahrt bei der Buchungsanlage (Stufe 1): Genehmigung, Länder und EINMALIGER Aufpreis an der Buchung, zentrale
// Preisberechnung (Grundmiete + Aufpreis, einmal), Vertrag (eigene Position, eingefroren, Herkunft Buchung), Rechnung (eigene
// Position, Standardsteuersatz), Mietzahlung, Kaution unabhängig, Tarif unverändert, Altbestand unverändert, Storno, Rollen,
// Mandantentrennung. Läuft gegen die lokale Testdatenbank (wie alle Integrationstests).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { roleAllows } from "../src/lib/constants";
import { recordAudit } from "../src/lib/audit";
import { abroadRuleIssues, abroadSurchargeOf, bookingAbroadIssue, parseAbroadForm, parseSurchargeCents } from "../src/lib/abroad";
import { bookingQuote } from "../src/lib/booking-price";
import { contractRuleIssues, initialContractRules, resolveRules } from "../src/lib/business-rules";
import { adoptContractDefaults, ensureContractDraft, getContractContentHash, refreshContractDraft, saveConditions, verifyContract, type ContractPriceSnapshot } from "../src/lib/contracts";
import { changeBookingPeriod, previewBookingPeriodChange } from "../src/lib/booking-period";
import { insertRentalPayment, rentalPaymentSummary } from "../src/lib/rental-payments";
import { cancellationOverview, previewCancellation } from "../src/lib/cancellation";
import { ensureInvoiceDraft } from "../src/lib/invoices";
import { loadContractDocumentData } from "../src/lib/document-data";
import { renderContractPdf } from "../src/lib/pdf/contract-pdf";
import { rulesSection } from "../src/lib/contract-view";
import { readContractRules } from "../src/lib/business-rules";
import { bookingTariffFor, type TariffChoices } from "../src/lib/tariffs";
import { createRatePlan, type TariffContent } from "../src/lib/tariff-admin";
import { toCents } from "../src/lib/money";
import { createWorld, purgeTenants, type World } from "./helpers";
import { pickedUpWorld, returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const DAY = 86_400_000;
const RULES = { abroadAllowed: true, abroadCountries: ["AT", "CH", "FR"] };
const OWNER = (w: World) => ({ id: w.userId, name: "Inhaberin Test" });
const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
type Abroad = { allowed: boolean | null; countries?: string[]; cents?: number | null };
const abroadData = (a: Abroad) => (a.allowed === null ? { abroadAllowed: null, abroadCountries: [], abroadSurchargeCents: null } : a.allowed ? { abroadAllowed: true, abroadCountries: a.countries ?? ["AT"], abroadSurchargeCents: a.cents ?? 0 } : { abroadAllowed: false, abroadCountries: [], abroadSurchargeCents: null });

/** Welt mit Freigabeliste AT/CH/FR (Mandant), ohne Kundenrabatt; optional Auslandsfahrt an der Buchung. */
async function world(label: string, abroad?: Abroad, opts: { discount?: number } = {}): Promise<World> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: RULES } });
  await db.customer.update({ where: { id: w.customerId }, data: { discountPercent: opts.discount ?? 0 } });
  if (abroad) await db.booking.update({ where: { id: w.bookingId }, data: abroadData(abroad) });
  return w;
}
const booking = (w: World) => db.booking.findUniqueOrThrow({ where: { id: w.bookingId }, include: { customer: true } });
const quoteOf = async (w: World) => { const b = await booking(w); return bookingQuote(b, b.startAt, b.endAt!, b.customer.discountPercent); };
const priceOf = (c: { priceSnapshot: unknown }) => c.priceSnapshot as unknown as ContractPriceSnapshot;
const abroadExtras = (c: { priceSnapshot: unknown }) => (priceOf(c).extras ?? []).filter((e) => e.key === "ABROAD_SURCHARGE");
const T4 = [{ days: 1, cents: 10000 }, { days: 5, cents: 45000 }, { days: 7, cents: 60000 }, { days: 30, cents: 200000 }];
const TARIFF: TariffChoices = { price: { mode: "TARIFF" }, km: { mode: "TARIFF" }, deposit: { mode: "TARIFF" } };
async function tariffBooking(w: World, choices: TariffChoices = TARIFF, days = 6) {
  const content: TariffContent = { km: { policy: "FREE_KILOMETERS", kmIncludedPerDay: 200, extraKmRateCents: 25 }, depositCents: 30000, deductibleCents: null, groups: [{ groupId: w.groupId, tiers: T4, depositCents: null, km: null }] } as TariffContent;
  const planId = (await createRatePlan(w.tenantId, OWNER(w), { meta: { name: "PLUS", code: null, description: null, sortOrder: 0 }, content, active: true, createKey: randomUUID() })).id;
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const endAt = new Date(b.startAt.getTime() + days * DAY);
  await db.$transaction(async (tx) => {
    const r = await bookingTariffFor(tx, w.tenantId, OWNER(w), { vehicleId: b.vehicleId, ratePlanId: planId, startAt: b.startAt, endAt, discountPercent: 0, choices, previous: null });
    await tx.booking.update({ where: { id: w.bookingId }, data: { ...r.data, endAt } });
    for (const a of r.audits) await recordAudit(tx, w.tenantId, OWNER(w), { ...a, bookingId: w.bookingId });
  });
  return planId;
}
const pay = (w: World, amount: string, expectFull = false) => db.$transaction((tx) => insertRentalPayment(tx, w.tenantId, w.actor, w.bookingId, { amount, method: "CASH", paidAt: new Date(Date.now() - 60_000), reference: null, note: null, idempotencyKey: randomUUID() }, { expectFull }));

test("1: Auslandsfahrt nicht gestattet – kein Aufpreis, keine Position; ein Betrag ohne Freigabe wird abgelehnt (DB-Regel)", async () => {
  const w = await world("ab-off", { allowed: false });
  const q = await quoteOf(w);
  assert.deepEqual([q.abroadSurchargeCents, q.totalCents], [0, q.rentCents]);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(abroadExtras(c).length, 0);
  assert.equal(priceOf(c).finalTotal * 100, q.rentCents);
  const rules = readContractRules(c.conditions)!;
  assert.deepEqual([rules.values.abroadAllowed, rules.values.abroadCountries, rules.sources.abroadAllowed], [false, [], "BOOKING"], "neue Buchung: bewusst nicht gestattet (Herkunft Buchung), nicht die Vorbelegung „alle Länder“");
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { abroadSurchargeCents: 4900 } }), /rb_booking_abroad/);
});

test("2: gestattet mit 0 € – Länder im Vertrag, keine Position, keine 0-€-Zeile, Text „ohne Aufpreis“", async () => {
  const w = await world("ab-zero", { allowed: true, countries: ["AT"], cents: 0 });
  const q = await quoteOf(w);
  assert.equal(q.totalCents, q.rentCents);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(abroadExtras(c).length, 0);
  const rules = readContractRules(c.conditions)!;
  assert.deepEqual([rules.values.abroadAllowed, rules.values.abroadCountries, rules.sources.abroadCountries], [true, ["AT"], "BOOKING"]);
  // Vertragsansicht (Entwurf: Vorschau im Assistenten; das PDF gibt es erst nach Abschluss)
  const section = rulesSection(rules, { kmIncludedPerDay: 200, extraKmRate: 0.25, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, deductible: 1000 }, "DIESEL", 0, 6, { abroadSurchargeCents: null });
  assert.equal(nbsp(section!.rows.find((r) => r.label === "Auslandsfahrten")!.value as string), "Genehmigt für: Österreich · ohne Aufpreis");
});

test("3/4: gestattet mit 49 € und mehreren Ländern – genau EINE Position, einmalig (nicht je Land oder Tag)", async () => {
  const w = await world("ab-49", { allowed: true, countries: ["FR", "AT", "CH"], cents: 4900 });
  const q = await quoteOf(w);
  assert.deepEqual([q.abroadSurchargeCents, q.totalCents], [4900, q.rentCents + 4900]);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const ex = abroadExtras(c);
  assert.equal(ex.length, 1);
  assert.deepEqual([ex[0].quantity, ex[0].unitPrice, ex[0].amount, ex[0].label], [1, 49, 49, "Auslandsfahrt-Aufpreis (einmalig) – Österreich, Schweiz, Frankreich"]);
  assert.equal(Math.round(priceOf(c).finalTotal * 100), q.rentCents + 4900);
  assert.equal(Math.round(Number(c.totalAmount) * 100), q.rentCents + 4900);
  // mehrfaches Auffrischen: weiterhin genau eine Position
  for (let i = 0; i < 3; i++) await db.$transaction((tx) => refreshContractDraft(tx, w.tenantId, c.id));
  assert.equal(abroadExtras(await db.rentalContract.findUniqueOrThrow({ where: { id: c.id } })).length, 1);
});

test("5: ungültige Beträge und Länder werden abgelehnt (Formular, Logik, Datenbank)", async () => {
  for (const bad of ["-1", "-0,01", "abc", "1.234", "12,345", "100000,01", "", "1e3"]) assert.ok("error" in parseSurchargeCents(bad), bad);
  assert.deepEqual(["49", "49,00", "49.5", "1.234,50", "0", "0,00", " 49 € ", "100000"].map((s) => (parseSurchargeCents(s) as { cents: number }).cents), [4900, 4900, 4950, 123450, 0, 0, 4900, 10000000]);
  const fd = (entries: [string, string][]) => { const f = new FormData(); for (const [k, v] of entries) f.append(k, v); return f; };
  assert.deepEqual(parseAbroadForm(fd([])), { present: false });
  assert.deepEqual(parseAbroadForm(fd([["abroadSection", "1"]])), { present: true, allowed: false });
  assert.deepEqual(parseAbroadForm(fd([["abroadSection", "1"], ["abroadAllowed", "1"], ["abroadCountries", "CH"], ["abroadCountries", "AT"], ["abroadCountries", "AT"], ["abroadSurcharge", "49,00"]])), { present: true, allowed: true, countries: ["AT", "CH"], surchargeCents: 4900 });
  const on: [string, string][] = [["abroadSection", "1"], ["abroadAllowed", "1"]];
  for (const bad of [
    [["abroadCountries", "XX"], ["abroadSurcharge", "10"]],
    [["abroadCountries", "OTHER"], ["abroadSurcharge", "10"]],
    [["abroadSurcharge", "10"]],
    [["abroadCountries", "AT"], ["abroadSurcharge", "-5"]],
    [["abroadCountries", "AT"]],
  ] as [string, string][][]) assert.ok("error" in parseAbroadForm(fd([...on, ...bad])), JSON.stringify(bad));
  const w = await world("ab-db");
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { abroadAllowed: true, abroadCountries: ["AT"], abroadSurchargeCents: -1 } }), /rb_booking_abroad/);
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { abroadAllowed: true, abroadCountries: [], abroadSurchargeCents: 100 } }), /rb_booking_abroad/);
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { abroadAllowed: true, abroadCountries: ["AT"], abroadSurchargeCents: 10000001 } }), /rb_booking_abroad/);
});

test("6: Gesamtmiete = Grundmiete + Aufpreis in Vorschau, Mietzahlung und Vertrag; Kundenrabatt nur auf die Grundmiete", async () => {
  const w = await world("ab-total", { allowed: true, countries: ["AT", "CH"], cents: 4900 }, { discount: 10 });
  const q = await quoteOf(w);
  const b = await booking(w);
  const plain = bookingQuote({ ...b, abroadAllowed: false, abroadSurchargeCents: null }, b.startAt, b.endAt!, 10);
  const full = bookingQuote({ ...b, abroadAllowed: false, abroadSurchargeCents: null }, b.startAt, b.endAt!, 0);
  assert.ok(plain.totalCents < full.totalCents, "Rabatt wirkt");
  assert.equal(q.rentCents, plain.totalCents, "Rabatt wirkt nur auf die Grundmiete");
  assert.equal(q.totalCents, plain.totalCents + 4900, "Aufpreis ohne Rabatt");
  const s = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s.grossCents, s.source], [q.totalCents, "ESTIMATE"]);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(Math.round(Number(c.totalAmount) * 100), q.totalCents);
});

test("7: Sondermietpreis und Aufpreis getrennt: 300 € individuell + 49 € = 349 €; Zeitraumänderung „beibehalten“ behält beides", async () => {
  const w = await world("ab-agreed");
  await tariffBooking(w, { ...TARIFF, price: { mode: "INDIVIDUAL", cents: 30000, reason: "Stammkunde" } });
  await db.booking.update({ where: { id: w.bookingId }, data: abroadData({ allowed: true, countries: ["AT", "CH"], cents: 4900 }) });
  const q = await quoteOf(w);
  assert.deepEqual([q.agreedCents, q.rentCents, q.abroadSurchargeCents, q.totalCents], [30000, 30000, 4900, 34900]);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.deepEqual([priceOf(c).agreedTotal, priceOf(c).finalTotal, Number(c.totalAmount)], [300, 349, 349], "Sonderpreis überschreibt den Aufpreis nicht");
  const b = await booking(w);
  const preview = await previewBookingPeriodChange(w.tenantId, w.bookingId, b.startAt, new Date(b.endAt!.getTime() + DAY));
  assert.equal(preview.before.priceCents, 34900);
  assert.equal(preview.abroadSurchargeCents, 4900);
  assert.equal(preview.after!.priceCents, preview.after!.rentCents + 4900, "nachher: Grundmiete + unveränderter Aufpreis (keine Differenz „−49 €“)");
  await changeBookingPeriod(w.tenantId, w.actor, w.bookingId, { startAt: b.startAt, endAt: new Date(b.endAt!.getTime() + DAY), reason: "Kunde bleibt länger", priceDecision: { mode: "KEEP" } });
  assert.equal((await quoteOf(w)).totalCents, 34900, "Sonderpreis beibehalten, Aufpreis bleibt");
  const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId: w.bookingId, action: "BOOKING_PERIOD_CHANGED" } });
  assert.deepEqual([(audit.details as { priceBeforeCents: number }).priceBeforeCents, (audit.details as { priceAfterCents: number }).priceAfterCents], [34900, 34900]);
});

test("8: Mietzahlung „vollständig bezahlt“ prüft gegen den Gesamtbetrag inkl. Aufpreis; Überzahlung abgelehnt", async () => {
  const w = await world("ab-pay", { allowed: true, countries: ["AT"], cents: 4900 });
  const q = await quoteOf(w);
  await assert.rejects(() => pay(w, (q.rentCents / 100).toFixed(2).replace(".", ","), true), "nur die Grundmiete ist nicht vollständig");
  await pay(w, (q.totalCents / 100).toFixed(2).replace(".", ","), true);
  const s = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([s.paidCents, s.openCents, s.status], [q.totalCents, 0, "PAID"]);
  await assert.rejects(() => pay(w, "1,00"), "Überzahlung");
});

test("9: Kaution bleibt unabhängig vom Aufpreis (Buchung, Vertrag)", async () => {
  const a = await world("ab-dep-a", { allowed: true, countries: ["AT"], cents: 4900 });
  const b = await world("ab-dep-b", { allowed: false });
  const ca = await ensureContractDraft(a.tenantId, a.bookingId, a.actor);
  const cb = await ensureContractDraft(b.tenantId, b.bookingId, b.actor);
  assert.equal(Number(ca.deposit), Number((await booking(a)).deposit));
  assert.equal(Number(ca.deposit), Number(cb.deposit), "gleiche Kaution mit und ohne Aufpreis");
  assert.ok(!(priceOf(ca).extras ?? []).some((e) => /Kaution/.test(e.label)));
});

test("10: Vertrag mit Ländern und Aufpreis – eingefroren (Prüfsumme), Dokument und PDF zeigen beides, im Gesamtpreis enthalten", async () => {
  const w = await pickedUpWorld("ab-contract", {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.tenant.update({ where: { id: x.tenantId }, data: { businessRules: RULES } });
      await db.booking.update({ where: { id: x.bookingId }, data: abroadData({ allowed: true, countries: ["CH", "AT"], cents: 4900 }) });
    },
  });
  const c = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal(c.status, "SIGNED");
  assert.equal(abroadExtras(c).length, 1);
  assert.ok((await verifyContract(w.tenantId, w.contractId)).intact, "Prüfsumme intakt");
  const data = await loadContractDocumentData(w.tenantId, w.contractId);
  assert.equal(nbsp(data.doc.rules!.rows.find((r) => r.label === "Auslandsfahrten")!.value as string), "Genehmigt für: Österreich, Schweiz · Aufpreis einmalig 49,00 € (im Gesamtmietpreis enthalten)");
  assert.deepEqual(data.doc.price.extras.map((e) => [e.text, nbsp(e.amount)]), [["Auslandsfahrt-Aufpreis (einmalig) – Österreich, Schweiz", "49,00 €"]]);
  const pdf = await renderContractPdf(data.doc, data.signatureImages);
  assert.ok(pdf.trace.texts.some((t) => t.includes("Auslandsfahrt-Aufpreis (einmalig) – Österreich, Schweiz")));
  assert.ok(pdf.trace.texts.some((t) => nbsp(t).includes("Genehmigt für: Österreich, Schweiz")));
  assert.deepEqual(pdf.trace.boxes.filter((b) => b.overflow), [], "kein Text außerhalb des Satzspiegels");
});

test("11/12: Rechnung – Aufpreis als eigene Position (Mietvertragsbezug, Standardsteuersatz), Summe = Vertragspreis, keine Doppelposition", async () => {
  const w = await returnedWorld("ab-invoice", {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.tenant.update({ where: { id: x.tenantId }, data: { businessRules: RULES } });
      await db.booking.update({ where: { id: x.bookingId }, data: abroadData({ allowed: true, countries: ["AT", "CH"], cents: 4900 }) });
    },
  });
  const contract = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const again = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(again.id, inv.id, "eine Mietrechnung je Buchung");
  const version = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId: inv.id, status: "DRAFT" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  const items = version.items;
  const rental = items.filter((i) => i.source === "RENTAL");
  const abroad = rental.filter((i) => i.description.startsWith("Auslandsfahrt-Aufpreis"));
  assert.equal(abroad.length, 1, "genau eine Aufpreis-Position");
  assert.match(abroad[0].description, /^Auslandsfahrt-Aufpreis \(einmalig\) – Österreich, Schweiz, laut Mietvertrag MV-/);
  assert.deepEqual([toCents(abroad[0].grossAmount), Number(abroad[0].taxRate)], [4900, 19], "Standardsteuersatz des Mandanten wie die Fahrzeugmiete");
  assert.match(rental[0].description, /^Fahrzeugmiete /);
  assert.equal(rental.reduce((a, i) => a + toCents(i.grossAmount), 0), toCents(contract.totalAmount), "Fahrzeugmiete + Aufpreis = Vertragspreis");
});

test("13: Tarifrevision bleibt unverändert – der Aufpreis steht nie im Tarif oder im Tarif-Snapshot", async () => {
  const w = await world("ab-tariff");
  const planId = await tariffBooking(w);
  const before = JSON.stringify(await db.ratePlanRevision.findMany({ where: { ratePlanId: planId }, orderBy: { revision: "asc" } }));
  await db.booking.update({ where: { id: w.bookingId }, data: abroadData({ allowed: true, countries: ["AT"], cents: 4900 }) });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(JSON.stringify(await db.ratePlanRevision.findMany({ where: { ratePlanId: planId }, orderBy: { revision: "asc" } })), before);
  const b = await booking(w);
  assert.ok(!JSON.stringify(b.tariffSnapshot).includes("abroad") && !JSON.stringify(b.tariffSnapshot).includes("4900"));
  assert.equal(priceOf(c).tariff?.regularCents, b.regularPriceCents, "regulärer Tarifpreis ohne Aufpreis");
});

test("14: Altbestand unverändert – Buchung ohne Festlegung: Vertrag bestimmt wie bisher, Entwurf und Prüfsumme bleiben gleich; unterschrieben = gesperrt", async () => {
  const w = await world("ab-legacy");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const rules = readContractRules(c.conditions)!;
  assert.notEqual(rules.sources.abroadAllowed, "BOOKING");
  assert.deepEqual([rules.values.abroadAllowed, rules.values.abroadCountries], [true, ["AT", "CH", "FR"]], "Vorbelegung aus den Geschäftsregeln wie bisher");
  assert.equal(abroadExtras(c).length, 0);
  const h1 = await getContractContentHash(w.tenantId, c.id);
  await db.$transaction((tx) => refreshContractDraft(tx, w.tenantId, c.id));
  assert.equal(await getContractContentHash(w.tenantId, c.id), h1, "Entwurf unverändert");
  const signed = await pickedUpWorld("ab-legacy-signed", { beforeContract: async (x) => { tenants.push(x.tenantId); } });
  await assert.rejects(() => db.booking.update({ where: { id: signed.bookingId }, data: abroadData({ allowed: true, countries: ["AT"], cents: 100 }) }), /RB_IMMUTABLE/);
});

test("15: Storno und Erstattung – vereinbarter Preis enthält den Aufpreis, Vorauszahlung wird vollständig berücksichtigt", async () => {
  const w = await world("ab-storno", { allowed: true, countries: ["AT"], cents: 4900 });
  const q = await quoteOf(w);
  await pay(w, (q.totalCents / 100).toFixed(2).replace(".", ","));
  const ov = await cancellationOverview(w.tenantId, w.bookingId);
  assert.deepEqual([ov.finances.agreedCents, ov.finances.prepaidCents], [q.totalCents, q.totalCents]);
  const { plan } = await previewCancellation(w.tenantId, w.bookingId, { reason: "Kunde sagt ab", refund: { mode: "CREDIT" } });
  assert.deepEqual([plan.creditCents, plan.errors.length], [q.totalCents, 0], "gezahlter Aufpreis wird mit erstattet bzw. gutgeschrieben");
});

test("16: Änderung nach Vertragsabschluss: Buchung gesperrt (DB-Trigger), Nachträge kennen die Auslandsfahrt erst in Stufe 2", async () => {
  const w = await pickedUpWorld("ab-after", {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.tenant.update({ where: { id: x.tenantId }, data: { businessRules: RULES } });
      await db.booking.update({ where: { id: x.bookingId }, data: abroadData({ allowed: true, countries: ["AT"], cents: 4900 }) });
    },
  });
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { abroadSurchargeCents: 9900 } }), /RB_IMMUTABLE: Die Auslandsfahrt ist mit dem Mietvertrag festgeschrieben/);
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: abroadData({ allowed: false }) }), /RB_IMMUTABLE/);
  const s = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.equal(s.source, "CONTRACT");
  assert.equal(s.grossCents, toCents((await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } })).totalAmount), "nach der Unterschrift gilt der Vertragspreis (inkl. Aufpreis) – keine Doppelzählung");
  const actions = readFileSync("src/app/(app)/buchungen/actions.ts", "utf8");
  assert.match(actions, /isImmutableError\(e\) \? \{ error: lockedMessage\(e\) \}/, "verständliche Meldung statt Serverfehler");
  assert.match(actions, /if \(msg\.includes\("Auslandsfahrt ist mit dem Mietvertrag festgeschrieben"\)\) return ABROAD_LOCKED;/, "nur der Auslandsfahrt-Trigger ergibt die Auslandsfahrt-Meldung");
});

test("17: Rollen – Anlage und Bearbeitung nur Disposition/Inhaber, Vertragsschritt mit Rollenprüfung; Hof darf nicht", () => {
  assert.equal(roleAllows("YARD", ["DISPO"]), false);
  assert.equal(roleAllows("DISPO", ["DISPO"]), true);
  const actions = readFileSync("src/app/(app)/buchungen/actions.ts", "utf8");
  for (const fn of ["createBookingAction", "updateBookingAction"]) {
    const body = new RegExp(`export async function ${fn}[\\s\\S]{0,200}`).exec(actions)?.[0] ?? "";
    assert.match(body, /await requireRole\("DISPO"\)/, fn);
  }
  const wizard = readFileSync("src/app/(app)/buchungen/[id]/vertrag/actions.ts", "utf8");
  assert.match(/export async function saveConditionsStepAction[\s\S]{0,200}/.exec(wizard)?.[0] ?? "", /await context\(bookingId\)/);
});

test("18: Mandantentrennung – Länder nur aus der Freigabeliste des eigenen Mandanten, Fahrzeug mandantengeprüft", async () => {
  const a = resolveRules({ abroadAllowed: true, abroadCountries: ["AT"] }, null, null).values;
  const b = resolveRules({ abroadAllowed: true, abroadCountries: ["CH"] }, null, null).values;
  assert.match(bookingAbroadIssue({ allowed: true, countries: ["CH"] }, a, { rentalType: "STANDARD", plate: "HB-A 1" })!, /Schweiz ist für HB-A 1 nicht in der Freigabeliste/);
  assert.equal(bookingAbroadIssue({ allowed: true, countries: ["CH"] }, b, { rentalType: "STANDARD", plate: "HB-B 1" }), null);
  assert.match(bookingAbroadIssue({ allowed: true, countries: ["AT"] }, resolveRules({ abroadAllowed: false }, null, null).values, { rentalType: "STANDARD", plate: "HB-C 1" })!, /keine Auslandsfahrten vorgesehen/);
  const actions = readFileSync("src/app/(app)/buchungen/actions.ts", "utf8");
  assert.match(actions, /client\.vehicle\.findFirst\(\{ where: \{ id: vehicleId, tenantId: tenant\.id \}/);
  assert.match(actions, /resolveRules\(tenant\.businessRules, v\.group, v\)/, "Mandantenregeln aus der Sitzung, nie aus dem Browser");
  const options = readFileSync("src/app/(app)/buchungen/options.ts", "utf8");
  assert.match(options, /db\.vehicle\.findMany\(\{ where: \{ tenantId \}/);
});

test("19: mobile Darstellung – einspaltig, Länder umbrechend, Dezimaltastatur; Schritt 4 bei Buchungsführung nur Anzeige", () => {
  const s = readFileSync("src/app/(app)/buchungen/abroad-section.tsx", "utf8");
  assert.match(s, /className="md:col-span-2 rounded-lg border border-line p-4 flex flex-col gap-3"/);
  assert.match(s, /flex flex-wrap gap-x-4 gap-y-1\.5/);
  assert.match(s, /name="abroadSurcharge" inputMode="decimal"/);
  assert.match(s, /Einmaliger Aufpreis für die genehmigte Auslandsfahrt/);
  const ui = readFileSync("src/app/(app)/buchungen/[id]/vertrag/wizard-ui.tsx", "utf8");
  assert.match(ui, /abroadLocked \? \(/);
  const form = readFileSync("src/app/(app)/buchungen/booking-form.tsx", "utf8");
  assert.ok(!/Unfallersatz|accident/i.test(form), "Buchungsformular bleibt frei von Unfallersatz-Bezügen");
});

test("20: bestehende Auslandsregeln bleiben – Texte im Vertrag unverändert, aus der Buchung mit Hinweis, „Standardwerte übernehmen“ behält die Buchung", async () => {
  const resolved = resolveRules({ abroadAllowed: true, abroadCountries: ["AT", "CH"] }, null, null);
  const base = initialContractRules(resolved);
  const pl = { ...base, values: { ...base.values, abroadAllowed: true, abroadCountries: ["AT", "PL"] } };
  assert.deepEqual(contractRuleIssues(pl, resolved, { driveClass: "COMBUSTION", additionalDrivers: 0 }), ["Ausland: Polen ist nicht in der Freigabeliste des Vermieters."]);
  const fromBooking = { ...pl, sources: { ...pl.sources, abroadAllowed: "BOOKING" as const } };
  assert.deepEqual(contractRuleIssues(fromBooking, resolved, { driveClass: "COMBUSTION", additionalDrivers: 0 }), ["Ausland: Polen ist nicht in der Freigabeliste des Vermieters. Bitte in der Buchung ändern."]);
  assert.deepEqual(abroadRuleIssues({ abroadAllowed: true, abroadCountries: ["AT", "PL"] }, { abroadAllowed: true, abroadCountries: ["AT"] }, "CONTRACT", ["PL"]), [], "Bestandsschutz (Stufe 2): bereits genehmigte Länder");
  const w = await world("ab-adopt", { allowed: true, countries: ["CH"], cents: 2500 });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await adoptContractDefaults(w.tenantId, c.id, w.actor);
  const after = await db.rentalContract.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual(readContractRules(after.conditions)!.values.abroadCountries, ["CH"], "Werte der Buchung bleiben");
  assert.equal(abroadExtras(after).length, 1);
});

test("Z: Vertrag weicht nicht still ab – Schritt 4 lehnt abweichende Auslandsfahrt ab, gleichlautende Werte sind unschädlich", async () => {
  const w = await world("ab-z5", { allowed: true, countries: ["AT"], cents: 4900 });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const b = await booking(w);
  const input = { startAt: b.startAt, endAt: b.endAt, deposit: Number(b.deposit), kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL" as const, fuelPolicyNote: null, fuelPricePerLiter: null, agreedTotal: null, agreedTotalNote: null };
  await assert.rejects(() => saveConditions(w.tenantId, c.id, { ...input, rules: { abroadAllowed: false, abroadCountries: [] } }), /Auslandsfahrten werden in der Buchung festgelegt/);
  await assert.rejects(() => saveConditions(w.tenantId, c.id, { ...input, rules: { abroadAllowed: true, abroadCountries: ["AT", "CH"] } }), /in der Buchung festgelegt/);
  await saveConditions(w.tenantId, c.id, { ...input, rules: { abroadAllowed: true, abroadCountries: ["AT"] } });
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "CONTRACT_BUSINESS_RULE_OVERRIDDEN", details: { path: ["field"], equals: "abroadAllowed" } } }), 0, "kein falsches Audit");
  assert.equal(abroadSurchargeOf({ abroadAllowed: true, abroadSurchargeCents: 4900, rentalType: "ACCIDENT_REPLACEMENT" }), 0, "Unfallersatz nie mit Aufpreis");
});
