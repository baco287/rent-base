// Mehrkilometer-Kulanz: individuelle Mehrkilometer-Abrechnung bei der Rückgabe. „Regulär berechnen“ (A, jede Rolle),
// „Individuellen Betrag festlegen“ (B) und „Aus Kulanz erlassen“ (C) mit Pflichtbegründung (nur Inhaber/Disposition). Geprüft
// gegen die echte Serverlogik: Beträge streng und serverseitig neu gerechnet, eine Position je Rückgabe, Pflichtentscheidung vor
// dem Abschluss (D4), Veraltet-Prüfung für alle Mietarten (D5), Unterschrift (D6), Rechnung (D10), Hash, Mandant, Rollen, Zeitachse.
// Welt: pickedUpWorld – Vertragszeitraum fest morgen 10:00 bis +6 Kalendertage 10:00 (Europe/Berlin, also immer 6 Miettage, auch
// über eine Zeitumstellung), 200 km frei je Tag, 0,25 €/km, Übergabe 45.210 km, Brutto-Mandant.
// Nicht hier geprüft: die mobile Darstellung nur per Quelltext (Fall 15), echte Gleichzeitigkeit nur mit connection_limit > 1 (Fall 8);
// YARD und Supportmodus über requireRole (Quelltext hier, echter Aufruf der Server Action im Smoke).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { recordAudit } from "../src/lib/audit";
import { getHandoverCompletionStatus } from "../src/lib/completion";
import { roleAllows } from "../src/lib/constants";
import { bookingTimeline, customerTimeline } from "../src/lib/customer-file";
import { recordDepositReceived, securityDepositFinancials } from "../src/lib/deposits";
import { flatCharge, saveExtraCharge } from "../src/lib/extra-charges";
import { finalizeHandover, getHandoverContentHash, getHandoverState, hashedExtraCharge, startHandover, updateHandoverDraft, verifyHandover } from "../src/lib/handovers";
import { isImmutableError } from "../src/lib/integrity";
import { ensureInvoiceDraft, finalizeInvoice, getInvoiceState, updateInvoiceDraft } from "../src/lib/invoices";
import { fmtCents, parseEuroInput, toCents } from "../src/lib/money";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { addManualCharge, confirmProposal, decideMileageProposal, dismissProposal, getReturnComparison, removeCharge, revokeMileageDecision, type MileageDecisionInput } from "../src/lib/returns";
import { createRatePlan } from "../src/lib/tariff-admin";
import { bookingTariffFor, readTariffSnapshot } from "../src/lib/tariffs";
import { berlinDay, createWorld, purgeTenants } from "./helpers";
import { answerAll, photo, pickedUpWorld, returnedWorld, sign, type PickedUpWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const REASON = "Stammkunde, Umweg wegen Vollsperrung nachgewiesen";
/** 46.850 km: 1.640 km gefahren, 1.200 km frei (6 Miettage × 200 km) → 440 Mehrkilometer × 0,25 € = 110,00 € */
const STD_KM = 46_850;
/**
 * Fester Vertragszeitraum: Kalendertage in Europe/Berlin statt „jetzt + n × 24 h“ – rentalDays zählt Wanduhr, sonst wären es bei einem
 * Lauf über die Frühjahrs-Zeitumstellung 7 Miettage (1.400 km frei, 60 €) und alle fest eingetragenen Werte (110 €, 11_000) falsch.
 */
const PERIOD = { startAt: berlinDay(1, 10), endAt: berlinDay(7, 10) };

async function world(label: string, opts: Parameters<typeof pickedUpWorld>[1] = {}) {
  const w = await pickedUpWorld(label, { ...opts, conditions: { ...PERIOD, ...(opts.conditions ?? {}) } });
  tenants.push(w.tenantId);
  return w;
}

/**
 * Tarifbuchung (Muster tests/tariffs.test.ts tariffRental/tariffBooking) im festen Zeitraum: Tarif „PLUS“ mit 200 km frei je Tag,
 * 0,25 €/km und 500 € Kaution – dieselben Werte wie die übrigen Fälle, aber mit echtem Buchungs- und Tarifschnappschuss.
 */
async function tariffWorld(label: string) {
  return world(label, {
    beforeContract: async (x) => {
      await db.customer.update({ where: { id: x.customerId }, data: { discountPercent: 0 } });
      const tiers = [{ days: 1, cents: 5_900 }, { days: 5, cents: 25_900 }, { days: 7, cents: 32_900 }, { days: 30, cents: 99_900 }];
      const plan = await createRatePlan(x.tenantId, x.actor, { meta: { name: "PLUS", code: null, description: null, sortOrder: 0 }, content: { km: { policy: "FREE_KILOMETERS", kmIncludedPerDay: 200, extraKmRateCents: 25 }, depositCents: 50_000, groups: [{ groupId: x.groupId, tiers, depositCents: null, km: null }] }, active: true, createKey: randomUUID() });
      const b = await db.booking.findUniqueOrThrow({ where: { id: x.bookingId } });
      await db.$transaction(async (tx) => {
        const r = await bookingTariffFor(tx, x.tenantId, x.actor, { vehicleId: b.vehicleId, ratePlanId: plan.id, startAt: PERIOD.startAt, endAt: PERIOD.endAt, discountPercent: 0, choices: { price: { mode: "TARIFF" }, km: { mode: "TARIFF" }, deposit: { mode: "TARIFF" } }, previous: readTariffSnapshot(b.tariffSnapshot) });
        await tx.booking.update({ where: { id: x.bookingId }, data: { ...r.data, startAt: PERIOD.startAt, endAt: PERIOD.endAt } });
        for (const a of r.audits) await recordAudit(tx, x.tenantId, x.actor, { ...a, bookingId: x.bookingId });
      });
    },
  });
}

/** Rückgabeentwurf: Kilometerstand, Tank wie bei der Übergabe (7/8), alle Pflichtfotos, Checkliste beantwortet. */
async function returnDraft(w: PickedUpWorld, km: number) {
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: km, fuelLevelEighths: 7 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, r.id, cat);
  await answerAll(w, r.id);
  return r;
}

const decide = (w: PickedUpWorld, returnId: string, input: Partial<MileageDecisionInput> & Pick<MileageDecisionInput, "mode">) =>
  decideMileageProposal(w.tenantId, returnId, w.actor, { reason: REASON, seenRegularCents: 11_000, ...input });
const codes = async (w: PickedUpWorld, returnId: string) => (await getHandoverState(w.tenantId, returnId)).issues.map((i) => i.code);
const kmCharges = (w: PickedUpWorld, returnId: string) => db.extraCharge.findMany({ where: { tenantId: w.tenantId, handoverId: returnId, type: "EXTRA_MILEAGE" }, orderBy: { createdAt: "asc" } });
const audits = (w: PickedUpWorld, action: string) => db.auditLog.findMany({ where: { tenantId: w.tenantId, action }, orderBy: { createdAt: "asc" } });
const renterSignatures = (returnId: string) => db.signature.count({ where: { handoverId: returnId, role: "RENTER" } });
type Calc = Record<string, unknown> & { decision: Record<string, unknown> };

/** Rechnungsentwurf mit Positionen (offener Entwurf). */
const draftOf = (invoiceId: string) => db.invoiceVersion.findFirstOrThrow({ where: { invoiceId, status: "DRAFT" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
const editable = (rows: Awaited<ReturnType<typeof draftOf>>["items"]) => rows.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: String(i.unitPrice), taxRate: String(i.taxRate) }));
/**
 * Kulanz am PC: die Zeile einer Zusatzkostenposition im Rechnungsentwurf als Pauschale auf einen Betrag setzen. Positionen werden beim
 * Speichern neu angelegt – deshalb über den Bezug zur Zusatzkostenposition (Herkunft und Bezug bleiben erhalten).
 */
async function setChargeLine(w: PickedUpWorld, invoiceId: string, extraChargeId: string, cents: number) {
  const cur = await draftOf(invoiceId);
  await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, { items: editable(cur.items).map((it, i) => (cur.items[i].extraChargeId === extraChargeId ? { ...it, quantity: "1", unit: "pauschal", unitPrice: (cents / 100).toFixed(2) } : it)) });
}

// ---------------------------------------------------------------------------
// A, B, C
// ---------------------------------------------------------------------------

test("1 Regulär berechnen: 440 km × 0,25 € = 110 € als Position aus dem Vorschlag, ohne Entscheidung; danach kein Mehrkilometer-Punkt offen", async () => {
  const w = await world("mk-a");
  const r = await returnDraft(w, STD_KM);
  let cmp = await getReturnComparison(w.tenantId, r.id);
  const m = cmp.mileageBilling!;
  assert.equal(m.state, "OPEN");
  assert.deepEqual([m.drivenKm, m.rentalDays, m.kmIncludedPerDay, m.includedKm, m.extraKm, m.extraKmRate, m.regularAmount], [1_640, 6, 200, 1_200, 440, 0.25, 110]);
  const c = await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
  assert.deepEqual([Number(c.quantity), c.unit, Number(c.unitPrice), Number(c.amount), c.source], [440, "km", 0.25, 110, "PROPOSAL"]);
  assert.equal((c.calculation as Record<string, unknown>).decision, undefined, "Regulär berechnen trägt keine Entscheidung");
  cmp = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp.mileageBilling?.state, "REGULAR");
  assert.equal(cmp.mileageBilling?.chargedAmount, 110);
  assert.equal(cmp.charges[0].decision, null);
  assert.ok(!(await getHandoverState(w.tenantId, r.id)).issues.some((i) => i.area === "CHARGES" && i.severity === "error"));
  const st = await getHandoverCompletionStatus(w.tenantId, r.id);
  assert.ok(!st.warnings.some((x) => x.code === "PROPOSAL_OPEN_EXTRA_MILEAGE"));
  assert.ok(!st.blockers.some((x) => x.code.startsWith("EXTRA_MILEAGE_")));
  // Hash: andere Schlüssel der Rechengrundlage (calculation) gehören nicht zum Protokollinhalt – nur eine Entscheidung (Fall 13)
  const h1 = await getHandoverContentHash(w.tenantId, r.id);
  await db.extraCharge.update({ where: { id: c.id }, data: { calculation: { ...(c.calculation as Record<string, unknown>), regularFormula: "x", extraKm: 1 } as Prisma.InputJsonValue } });
  assert.equal(await getHandoverContentHash(w.tenantId, r.id), h1, "geänderte Rechengrundlage ohne Entscheidung ändert den Hash nicht");
});

test("2 Individueller Betrag 50 € statt 110 €: eine Pauschalposition mit Erläuterung, Rechengrundlage und Entscheidung, Audit", async () => {
  const w = await world("mk-b");
  const r = await returnDraft(w, STD_KM);
  const before = Date.now();
  await decide(w, r.id, { mode: "CUSTOM", amount: "50,00" });
  const rows = await kmCharges(w, r.id);
  assert.equal(rows.length, 1, "genau eine Mehrkilometer-Position");
  const c = rows[0];
  assert.deepEqual([Number(c.amount), Number(c.quantity), c.unit, Number(c.unitPrice), c.source], [50, 1, "pauschal", 50, "PROPOSAL"]);
  const calc = c.calculation as Calc;
  assert.deepEqual([calc.extraKm, calc.drivenKm, calc.includedKm, calc.regularFormula], [440, 1_640, 1_200, "440 km × 0,25 € = 110,00 €"], "bisherige Rechengrundlage bleibt");
  const { decidedAt, ...decision } = calc.decision;
  // Steuermodus dreiwertig eingefroren (Brutto-Mandant): Kennzeichnung bleibt auch nach einer späteren Umstellung richtig
  assert.deepEqual(decision, { kind: "CUSTOM", regularCents: 11_000, agreedCents: 5_000, deviationCents: 6_000, extraKm: 440, reason: REASON, decidedById: w.actor.id, decidedByName: w.actor.name, netPrices: false, pricesIncludeTax: true });
  assert.ok(Date.parse(String(decidedAt)) >= before - 1_000, "Zeitpunkt aus dem Server");
  assert.equal(c.description, "440 km über Freikilometer (regulär 110,00 €), Kulanznachlass 60,00 €");
  assert.equal(c.formula, "Regulär 440 km × 0,25 € = 110,00 € · Kulanznachlass 60,00 € · berechnet 50,00 €");
  const audit = await audits(w, "RETURN_MILEAGE_DECIDED");
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].amountCents, audit[0].bookingId, audit[0].userId], [5_000, w.bookingId, w.actor.id]);
  assert.deepEqual(audit[0].details, { handoverId: r.id, handoverNumber: r.number, decision: "CUSTOM", regularCents: 11_000, agreedCents: 5_000, deviationCents: 6_000, extraKm: 440, reason: REASON });
  const cmp = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp.chargesTotal, 50);
  assert.equal(cmp.mileageBilling?.state, "CUSTOM");
  assert.deepEqual([cmp.mileageBilling?.decision?.agreedAmount, cmp.mileageBilling?.decision?.deviation, cmp.mileageBilling?.decision?.reason, cmp.mileageBilling?.decision?.decidedByName], [50, 60, REASON, w.actor.name]);
  assert.deepEqual([cmp.mileageBilling?.decision?.netPrices, cmp.mileageBilling?.decision?.pricesIncludeTax], [false, true], "Steuermodus der Entscheidung für die Anzeige");
  // ältere Entscheidung ohne gespeicherten Steuermodus: wird toleriert (Feld fehlt, nur netPrices)
  const olderDecision = Object.fromEntries(Object.entries(calc.decision).filter(([k]) => k !== "pricesIncludeTax"));
  await db.extraCharge.update({ where: { id: c.id }, data: { calculation: { ...calc, decision: olderDecision } as Prisma.InputJsonValue } });
  const older = (await getReturnComparison(w.tenantId, r.id)).mileageBilling?.decision;
  assert.ok(older && older.netPrices === false && !("pricesIncludeTax" in older), "älterer Stand ohne Feld: keine erfundene Angabe");
  await db.extraCharge.update({ where: { id: c.id }, data: { calculation: calc as Prisma.InputJsonValue } });
  assert.deepEqual(cmp.charges[0].decision, { kind: "CUSTOM", regularAmount: 110, agreedAmount: 50 });
  assert.ok(!(await codes(w, r.id)).some((x) => x.startsWith("EXTRA_MILEAGE_")), "entschieden: kein Mehrkilometer-Punkt offen");
});

test("3 Aus Kulanz erlassen: Position 0 € (1 pauschal), Erläuterung, Summe 0, Audit", async () => {
  const w = await world("mk-c");
  const r = await returnDraft(w, STD_KM);
  await decide(w, r.id, { mode: "WAIVED", amount: "30" });
  const [c] = await kmCharges(w, r.id);
  assert.deepEqual([Number(c.amount), Number(c.unitPrice), Number(c.quantity), c.unit], [0, 0, 1, "pauschal"], "bei Erlass zählt ein Betrag aus dem Formular nicht");
  assert.equal(c.description, "440 km über Freikilometer (regulär 110,00 €), aus Kulanz erlassen");
  assert.equal(c.formula, "Regulär 440 km × 0,25 € = 110,00 € · erlassen 110,00 € · berechnet 0,00 €");
  assert.deepEqual([(c.calculation as Calc).decision.kind, (c.calculation as Calc).decision.agreedCents, (c.calculation as Calc).decision.deviationCents], ["WAIVED", 0, 11_000]);
  const cmp = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp.chargesTotal, 0);
  assert.equal(cmp.mileageBilling?.state, "WAIVED");
  const audit = await audits(w, "RETURN_MILEAGE_DECIDED");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].amountCents, 0);
  assert.equal((audit[0].details as { decision: string }).decision, "WAIVED");
  assert.ok(!(await codes(w, r.id)).some((x) => x.startsWith("EXTRA_MILEAGE_")));
});

// ---------------------------------------------------------------------------
// Validierung
// ---------------------------------------------------------------------------

test("4 Begründung ist Pflicht (10 bis 500 Zeichen) bei individuellem Betrag und Erlass – sonst keine Position, kein Audit", async () => {
  const w = await world("mk-reason");
  const r = await returnDraft(w, STD_KM);
  for (const mode of ["CUSTOM", "WAIVED"] as const) {
    for (const reason of ["", "zu kurz", "    kurz      "]) await assert.rejects(() => decide(w, r.id, { mode, amount: "50", reason }), /mindestens 10 Zeichen/, `${mode}: „${reason}“`);
    await assert.rejects(() => decide(w, r.id, { mode, amount: "50", reason: "x".repeat(501) }), /höchstens 500/);
  }
  assert.equal((await kmCharges(w, r.id)).length, 0);
  assert.equal((await audits(w, "RETURN_MILEAGE_DECIDED")).length, 0);
});

test("5 Beträge: streng geparst, 0 < individuell < regulär, ganze Cent; Tausenderpunkte richtig gelesen", async () => {
  // reine Eingabeprüfung (auch für die Vorschau im Browser)
  assert.equal(parseEuroInput("1.000"), 100_000);
  assert.equal(parseEuroInput("1.234,5"), 123_450);
  assert.equal(parseEuroInput("1.000,00"), 100_000);
  assert.equal(parseEuroInput("49.99"), 4_999);
  assert.equal(parseEuroInput("49,99"), 4_999);
  assert.equal(parseEuroInput(" 50 € "), 5_000);
  for (const bad of ["49,999", "-5", "abc", "", "1,2,3", "1.00.0", "12.345.6", "1.5.0", "4 9,9 9x"]) assert.equal(parseEuroInput(bad), null, bad);

  const w = await world("mk-amount");
  const r = await returnDraft(w, STD_KM);
  const cases: [string, RegExp][] = [["110,01", /Regulär berechnen/], ["110,00", /Regulär berechnen/], ["110", /Regulär berechnen/], ["-5", /gültigen Betrag/], ["0", /Aus Kulanz erlassen/], ["0,00", /Aus Kulanz erlassen/], ["abc", /gültigen Betrag/], ["49,999", /gültigen Betrag/], ["", /gültigen Betrag/]];
  for (const [amount, re] of cases) await assert.rejects(() => decide(w, r.id, { mode: "CUSTOM", amount }), re, amount);
  assert.equal((await kmCharges(w, r.id)).length, 0);

  // 52.000 km: 6.790 gefahren − 1.200 frei = 5.590 Mehrkilometer = 1.397,50 €
  const v = await world("mk-amount-big");
  const rv = await returnDraft(v, 52_000);
  assert.equal((await getReturnComparison(v.tenantId, rv.id)).mileageBilling?.regularAmount, 1_397.5);
  await decide(v, rv.id, { mode: "CUSTOM", amount: "1.000", seenRegularCents: 139_750 });
  let [c] = await kmCharges(v, rv.id);
  assert.equal(toCents(c.amount), 100_000, "„1.000“ ist tausend Euro, nicht ein Euro");
  assert.equal(c.description, "5.590 km über Freikilometer (regulär 1.397,50 €), Kulanznachlass 397,50 €");
  await revokeMileageDecision(v.tenantId, rv.id, v.actor);
  await decide(v, rv.id, { mode: "CUSTOM", amount: "1.234,5", seenRegularCents: 139_750 });
  [c] = await kmCharges(v, rv.id);
  assert.equal(toCents(c.amount), 123_450);
  assert.equal((c.calculation as Calc).decision.deviationCents, 16_300);
});

test("6 Keine Mehrkilometer (46.000 km): nichts zu entscheiden, Abschluss ohne Mehrkilometer-Blocker", async () => {
  const w = await world("mk-none");
  const r = await returnDraft(w, 46_000);
  const cmp = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp.mileageBilling?.state, "NONE");
  assert.deepEqual([cmp.mileageBilling?.drivenKm, cmp.mileageBilling?.extraKm, cmp.mileageBilling?.regularAmount], [790, 0, 0]);
  await assert.rejects(() => decide(w, r.id, { mode: "WAIVED" }), /keine Mehrkilometer/);
  await assert.rejects(() => confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE"), /keinen Vorschlag/);
  assert.ok(!(await codes(w, r.id)).some((x) => x.startsWith("EXTRA_MILEAGE_")));
  await sign(w, r.id);
  assert.equal((await finalizeHandover(w.tenantId, r.id, w.actor)).status, "FINALIZED");
});

test("7 Unbegrenzte Kilometer: keine Entscheidung möglich, keine Position; individuelle Regel rechnet mit den Vertragswerten und zeigt den Regeltext", async () => {
  const w = await world("mk-unlimited", { conditions: { rules: { kmPolicy: "UNLIMITED" } } });
  const r = await returnDraft(w, 49_000);
  await assert.rejects(() => decide(w, r.id, { mode: "WAIVED" }), /keine Mehrkilometer/);
  const cmp = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp.mileageBilling?.state, "UNLIMITED");
  assert.equal(cmp.mileageBilling?.includedKm, null);
  assert.ok(cmp.hints.some((h) => h.code === "KM_UNLIMITED"));
  assert.equal((await kmCharges(w, r.id)).length, 0);
  assert.ok(!(await codes(w, r.id)).some((x) => x.startsWith("EXTRA_MILEAGE_")));
  // Altbestand: manuelle Mehrkilometer-Position, obwohl laut Vertrag keine Forderung anfällt – Fehler (D9), sonst landete sie in der Rechnung
  const legacy = await db.$transaction((tx) => saveExtraCharge(tx, w.tenantId, w.actor.id, { bookingId: w.bookingId, handoverId: r.id }, flatCharge("EXTRA_MILEAGE", "Mehrkilometer pauschal", 1, "pauschal", 20)));
  const legacyIssue = (await getHandoverState(w.tenantId, r.id)).issues.find((i) => i.code === "EXTRA_MILEAGE_LEGACY_MANUAL");
  assert.ok(legacyIssue && legacyIssue.severity === "error");
  assert.match(legacyIssue.message, /keine Mehrkilometer-Forderung an/);
  assert.equal((await getReturnComparison(w.tenantId, r.id)).mileageBilling?.state, "LEGACY_MANUAL");
  await sign(w, r.id);
  await assert.rejects(() => finalizeHandover(w.tenantId, r.id, w.actor), /keine Mehrkilometer-Forderung an/);
  await removeCharge(w.tenantId, r.id, legacy.id);
  assert.ok(!(await codes(w, r.id)).some((x) => x.startsWith("EXTRA_MILEAGE_")), "entfernt: nichts mehr offen");

  // Befehl 27 unverändert: INDIVIDUAL rechnet mit Freikilometern und Preis des Vertrags; der Regeltext ist sichtbar (D11)
  const v = await world("mk-individual", { conditions: { rules: { kmPolicy: "INDIVIDUAL", kmPolicyNote: "Baustellenfahrten nach Absprache" } } });
  const rv = await returnDraft(v, STD_KM);
  const ci = await getReturnComparison(v.tenantId, rv.id);
  assert.equal(ci.contract.kmPolicy, "INDIVIDUAL");
  assert.equal(ci.contract.kmPolicyNote, "Baustellenfahrten nach Absprache");
  assert.deepEqual([ci.mileageBilling?.state, ci.mileageBilling?.policyNote, ci.mileageBilling?.regularAmount], ["OPEN", "Baustellenfahrten nach Absprache", 110]);
});

test("8 Mehrfachaufruf (lokal serialisiert): drei Entscheidungen ergeben genau eine Position und ein Audit; die Sperre FOR UPDATE per Quelltext", async () => {
  // Lokal laufen die Tests mit connection_limit=1 (PGlite): die drei Transaktionen warten nacheinander auf die Verbindung, jede spätere
  // sieht die committete Position. Das belegt den Mehrfachaufruf („bereits entschieden“), nicht die Zeilensperre – die prüft der
  // Quelltext unten; echte Gleichzeitigkeit nur in einem eigenen Lauf gegen Postgres mit connection_limit > 1.
  const ret = readFileSync(path.join(process.cwd(), "src/lib/returns.ts"), "utf8");
  assert.match(ret, /async function lockReturnForMileage\([^)]*\) \{\s*await tx\.\$queryRaw`SELECT "id" FROM "Handover" WHERE "id" = \$\{handoverId\} AND "tenantId" = \$\{tenantId\} FOR UPDATE`/, "Sperre als erste Anweisung");
  for (const fn of ["decideMileageProposal", "revokeMileageDecision"]) {
    const start = ret.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, fn);
    const rest = ret.slice(start);
    const end = rest.search(/\r?\n\}\r?\n/);
    assert.ok(end > 0, `${fn}: Funktionsende gefunden`);
    const body = rest.slice(0, end);
    assert.match(body, /return db\.\$transaction\(async \(tx\) => \{\s*const \{[^}]*\} = await lockReturnForMileage\(tx, tenantId, handoverId\);/, `${fn}: zuerst sperren, dann lesen`);
  }
  const w = await world("mk-race");
  const r = await returnDraft(w, STD_KM);
  const results = await Promise.allSettled([1, 2, 3].map(() => decide(w, r.id, { mode: "CUSTOM", amount: "50" })));
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  for (const x of results) if (x.status === "rejected") assert.match(String((x.reason as Error).message), /bereits entschieden/);
  assert.equal((await kmCharges(w, r.id)).length, 1);
  assert.equal((await audits(w, "RETURN_MILEAGE_DECIDED")).length, 1);
  await assert.rejects(() => confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE"), /bereits bestätigt/);
  await assert.rejects(() => decide(w, r.id, { mode: "WAIVED" }), /bereits entschieden/);
});

test("9 Keine Umwege: keine manuelle Mehrkilometer-Position, kein „Nicht berechnen“, Entscheidung nur über Rücknahme entfernbar; Altbestand wird blockiert", async () => {
  const w = await world("mk-bypass");
  const r = await returnDraft(w, STD_KM);
  await assert.rejects(() => addManualCharge(w.tenantId, r.id, w.actor.id, { type: "EXTRA_MILEAGE", description: "Mehrkilometer pauschal", quantity: 1, unit: "pauschal", unitPrice: 10 }), /Mehrkilometer-Abrechnung/);
  await assert.rejects(() => dismissProposal(w.tenantId, r.id, w.actor, "EXTRA_MILEAGE"), /nicht über „Nicht berechnen“/);
  assert.deepEqual(await dismissProposal(w.tenantId, r.id, w.actor, "EXTRA_MILEAGE", true), [], "Zurücknehmen eines alten „Nicht berechnen“ bleibt erlaubt");
  // B: nicht über „entfernen“, nur über die Rücknahme (mit Audit) – danach wieder offen
  const b = await decide(w, r.id, { mode: "CUSTOM", amount: "80" });
  await assert.rejects(() => removeCharge(w.tenantId, r.id, b.id), /Entscheidung zurücknehmen/);
  await revokeMileageDecision(w.tenantId, r.id, w.actor);
  assert.equal((await kmCharges(w, r.id)).length, 0);
  assert.equal((await getReturnComparison(w.tenantId, r.id)).mileageBilling?.state, "OPEN");
  let revoked = await audits(w, "RETURN_MILEAGE_DECISION_REVOKED");
  assert.equal(revoked.length, 1);
  assert.deepEqual(revoked[0].details, { handoverId: r.id, handoverNumber: r.number, kind: "CUSTOM", regularCents: 11_000, agreedCents: 8_000 });
  // A: Rücknahme ebenfalls möglich (Audit REGULAR); eine reguläre Position darf außerdem jede Rolle entfernen
  await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
  await revokeMileageDecision(w.tenantId, r.id, w.actor);
  revoked = await audits(w, "RETURN_MILEAGE_DECISION_REVOKED");
  assert.equal(revoked.length, 2);
  assert.deepEqual([(revoked[1].details as { kind: string }).kind, (revoked[1].details as { regularCents: number }).regularCents, (revoked[1].details as { agreedCents: number }).agreedCents], ["REGULAR", 11_000, 11_000]);
  await assert.rejects(() => revokeMileageDecision(w.tenantId, r.id, w.actor), /keine Entscheidung/);
  // Zeitachse der Buchung und der Kundenakte (intern): Entscheidung mit Grund, Rücknahmen nach ihrer Art – eine zurückgenommene
  // reguläre Berechnung erscheint nicht als Kulanz
  const timeline = await bookingTimeline(w.tenantId, w.bookingId);
  const decidedEntry = timeline.find((x) => x.key.startsWith("rmd-"));
  assert.equal(decidedEntry?.title, `Mehrkilometer individuell ${fmtCents(8_000)} statt ${fmtCents(11_000)} (Kulanznachlass ${fmtCents(3_000)})`);
  assert.equal(decidedEntry?.kind, "Rückgabe");
  assert.equal(decidedEntry?.href, `/buchungen/${w.bookingId}/rueckgabe`);
  assert.ok(decidedEntry?.detail?.includes(r.number) && decidedEntry?.detail?.includes(`Grund: ${REASON}`), "Protokollnummer und Grund (intern)");
  assert.deepEqual(timeline.filter((x) => x.key.startsWith("rmr-")).map((x) => x.title).sort(), [
    `Mehrkilometer-Entscheidung zurückgenommen (individuell ${fmtCents(8_000)} statt ${fmtCents(11_000)})`,
    `Mehrkilometer-Entscheidung zurückgenommen (regulär berechnet ${fmtCents(11_000)})`,
  ].sort());
  assert.ok(timeline.filter((x) => x.key.startsWith("rmr-")).every((x) => !x.detail?.includes("Grund")));
  assert.equal((await customerTimeline(w.tenantId, w.customerId)).filter((x) => x.key.startsWith("rmd-") || x.key.startsWith("rmr-")).length, 3, "auch in der Kundenakte");
  const a = await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
  await removeCharge(w.tenantId, r.id, a.id);
  assert.ok((await codes(w, r.id)).includes("EXTRA_MILEAGE_OPEN"), "entfernte reguläre Position: wieder offen und blockierend");

  // Altbestand: manuell gespeicherte Mehrkilometer-Position (wie vor der Mehrkilometer-Abrechnung)
  const v = await world("mk-legacy-manual");
  const rv = await returnDraft(v, STD_KM);
  const draft = (await getReturnComparison(v.tenantId, rv.id)).proposals.find((p) => p.key === "EXTRA_MILEAGE")!.draft;
  const manual = await db.$transaction((tx) => saveExtraCharge(tx, v.tenantId, v.actor.id, { bookingId: v.bookingId, handoverId: rv.id }, draft));
  assert.equal(manual.source, "MANUAL");
  await assert.rejects(() => decide(v, rv.id, { mode: "WAIVED" }), /manuelle Mehrkilometer-Position/);
  await assert.rejects(() => confirmProposal(v.tenantId, rv.id, v.actor.id, "EXTRA_MILEAGE"), /manuelle Mehrkilometer-Position/);
  assert.ok((await codes(v, rv.id)).includes("EXTRA_MILEAGE_LEGACY_MANUAL"));
  assert.equal((await getReturnComparison(v.tenantId, rv.id)).mileageBilling?.state, "LEGACY_MANUAL");
  // Duplikat (Position aus der Abrechnung plus manuelle): Fehler
  await removeCharge(v.tenantId, rv.id, manual.id);
  await confirmProposal(v.tenantId, rv.id, v.actor.id, "EXTRA_MILEAGE");
  await db.$transaction((tx) => saveExtraCharge(tx, v.tenantId, v.actor.id, { bookingId: v.bookingId, handoverId: rv.id }, draft));
  assert.ok((await codes(v, rv.id)).includes("EXTRA_MILEAGE_DUPLICATE"));

  // Altbestand: früher ohne Begründung „Nicht berechnet“ – zählt nicht mehr, die Entscheidung räumt die Liste auf
  const u = await world("mk-legacy-dismissed");
  const ru = await returnDraft(u, STD_KM);
  await db.handover.update({ where: { id: ru.id }, data: { dismissedProposals: ["EXTRA_MILEAGE"] } });
  assert.equal((await getReturnComparison(u.tenantId, ru.id)).mileageBilling?.state, "DISMISSED_LEGACY");
  assert.ok((await codes(u, ru.id)).includes("EXTRA_MILEAGE_OPEN"), "„Nicht berechnet“ ohne Begründung blockiert trotzdem");
  await decide(u, ru.id, { mode: "WAIVED" });
  assert.deepEqual((await db.handover.findUniqueOrThrow({ where: { id: ru.id } })).dismissedProposals, []);
  assert.ok(!(await codes(u, ru.id)).some((x) => x.startsWith("EXTRA_MILEAGE_")));
});

// ---------------------------------------------------------------------------
// Pflichtentscheidung, Veraltet, Unterschrift
// ---------------------------------------------------------------------------

test("10 Pflichtentscheidung (D4) und Veraltet-Prüfung (D5): offener Vorschlag blockiert; A und B werden nach einer Kilometeränderung neu entschieden", async () => {
  const w = await world("mk-required");
  const r = await returnDraft(w, STD_KM);
  const st = await getHandoverCompletionStatus(w.tenantId, r.id);
  const open = st.blockers.find((x) => x.code === "EXTRA_MILEAGE_OPEN");
  assert.ok(open && open.step === 7, "Blocker in Schritt 7");
  assert.match(open.message, /440 km, regulär 110,00/);
  assert.match(open.message, /vor der Unterschrift/);
  assert.ok(!st.warnings.some((x) => x.code === "PROPOSAL_OPEN_EXTRA_MILEAGE"), "kein zweiter Hinweis zum selben Vorschlag");
  await sign(w, r.id);
  await assert.rejects(() => finalizeHandover(w.tenantId, r.id, w.actor), /sind noch nicht entschieden/);

  // A bei 46.850, danach 46.580 km: die reguläre Position passt nicht mehr (auch bei Standardmiete)
  await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 46_580 });
  assert.ok((await codes(w, r.id)).includes("EXTRA_MILEAGE_STALE"));
  await sign(w, r.id);
  await assert.rejects(() => finalizeHandover(w.tenantId, r.id, w.actor), /Mehrkilometer: Der bestätigte Betrag passt nicht mehr/);
  const [stale] = await kmCharges(w, r.id);
  await removeCharge(w.tenantId, r.id, stale.id);
  const fresh = await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
  assert.equal(Number(fresh.amount), 42.5, "1.370 − 1.200 = 170 km × 0,25 €");
  await sign(w, r.id);
  assert.equal((await finalizeHandover(w.tenantId, r.id, w.actor)).status, "FINALIZED");

  // B, danach 46.900 km: Entscheidung veraltet – Inhaber/Disposition muss neu entscheiden
  const v = await world("mk-decision-stale");
  const rv = await returnDraft(v, STD_KM);
  const b = await decide(v, rv.id, { mode: "CUSTOM", amount: "50" });
  await updateHandoverDraft(v.tenantId, rv.id, { mileage: 46_900 }); // 1.690 − 1.200 = 490 km = 122,50 €
  const c2 = await codes(v, rv.id);
  assert.ok(c2.includes("EXTRA_MILEAGE_DECISION_STALE"));
  assert.ok(!c2.includes("EXTRA_MILEAGE_STALE"));
  assert.ok((await getHandoverCompletionStatus(v.tenantId, rv.id)).blockers.some((x) => x.code === "EXTRA_MILEAGE_DECISION_STALE" && x.step === 7));
  await sign(v, rv.id);
  await assert.rejects(() => finalizeHandover(v.tenantId, rv.id, v.actor), /Inhaber oder Disposition muss neu entscheiden/);
  await assert.rejects(() => removeCharge(v.tenantId, rv.id, b.id), /Entscheidung zurücknehmen/);
  await revokeMileageDecision(v.tenantId, rv.id, v.actor, { confirmSignatureLoss: true });
  // die Seite zeigte noch den alten regulären Betrag
  await assert.rejects(() => decide(v, rv.id, { mode: "CUSTOM", amount: "50", seenRegularCents: 10_000 }), /hat sich geändert/);
  await assert.rejects(() => decide(v, rv.id, { mode: "CUSTOM", amount: "50", seenRegularCents: 11_000 }), /hat sich geändert/);
  await decide(v, rv.id, { mode: "CUSTOM", amount: "50", seenRegularCents: 12_250 });
  assert.ok(!(await codes(v, rv.id)).some((x) => x.startsWith("EXTRA_MILEAGE_")));
  await sign(v, rv.id);
  assert.equal((await finalizeHandover(v.tenantId, rv.id, v.actor)).status, "FINALIZED");
});

test("11 Unterschrift (D6): nach der Mieter-Unterschrift nur mit ausdrücklicher Bestätigung entscheiden oder zurücknehmen", async () => {
  const w = await world("mk-signature");
  const r = await returnDraft(w, STD_KM);
  await sign(w, r.id);
  assert.equal(await renterSignatures(r.id), 1);
  await assert.rejects(() => decide(w, r.id, { mode: "WAIVED" }), /bereits unterschrieben/);
  assert.equal(await renterSignatures(r.id), 1, "Unterschrift bleibt");
  assert.equal((await kmCharges(w, r.id)).length, 0, "keine Position");
  await decide(w, r.id, { mode: "WAIVED", confirmSignatureLoss: true });
  assert.equal((await kmCharges(w, r.id)).length, 1);
  assert.equal(await renterSignatures(r.id), 0, "Unterschrift verworfen – der Mieter unterschreibt erneut");

  await sign(w, r.id);
  await assert.rejects(() => revokeMileageDecision(w.tenantId, r.id, w.actor), /bereits unterschrieben/);
  assert.equal(await renterSignatures(r.id), 1);
  assert.equal((await kmCharges(w, r.id)).length, 1);
  await revokeMileageDecision(w.tenantId, r.id, w.actor, { confirmSignatureLoss: true });
  assert.equal((await kmCharges(w, r.id)).length, 0);
  assert.equal(await renterSignatures(r.id), 0);
});

test("12 Echte Werte bleiben unverändert: Kilometerstand in Fahrzeug und Historie, Vertrag, Tarif- und Buchungsschnappschuss, erhaltene Kaution; die Entscheidung steht versiegelt im Protokoll", async () => {
  // Tarifbuchung mit echtem Kautionseingang – sonst vergliche der Test leere Werte (kein Tarif: null = null, keine Kaution: [] = [])
  const w = await tariffWorld("mk-real");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: new Date() });
  const pick = (b: Prisma.BookingGetPayload<object>) => ({ ratePlanId: b.ratePlanId, ratePlanRevisionId: b.ratePlanRevisionId, tariffSnapshot: b.tariffSnapshot, regularPriceCents: b.regularPriceCents, kmIncludedPerDay: b.kmIncludedPerDay, extraKmRate: b.extraKmRate == null ? null : String(b.extraKmRate), deductibleCents: b.deductibleCents, agreedPriceCents: b.agreedPriceCents, deposit: String(b.deposit) });
  const contractBefore = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const bookingBefore = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.ok(bookingBefore.ratePlanId && bookingBefore.ratePlanRevisionId && bookingBefore.tariffSnapshot && bookingBefore.kmIncludedPerDay === 200 && Number(bookingBefore.extraKmRate) === 0.25, "Vorbedingung: Tarifbuchung mit Schnappschuss (200 km/Tag, 0,25 €/km)");
  const depositsBefore = await db.securityDeposit.findMany({ where: { tenantId: w.tenantId, bookingId: w.bookingId }, include: { events: true } });
  assert.equal(depositsBefore.length, 1, "Vorbedingung: Kautionszeile vorhanden");
  assert.equal(depositsBefore[0].events.length, 1, "Vorbedingung: ein Kautionseingang");
  const depositFinBefore = await securityDepositFinancials(w.tenantId, w.bookingId);
  assert.equal(depositFinBefore.receivedCents, 50_000);
  const r = await returnDraft(w, STD_KM);
  assert.equal((await getReturnComparison(w.tenantId, r.id)).mileageBilling?.regularAmount, 110, "Tarif mit denselben Werten wie die übrigen Fälle");
  await decide(w, r.id, { mode: "CUSTOM", amount: "50" });
  await sign(w, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  // versiegelt: Entscheidung mit Grund, Mitarbeiter und Zeitpunkt aus dem abgeschlossenen Protokoll (Lesepfad wie die Seite)
  const sealed = (await getReturnComparison(w.tenantId, r.id)).mileageBilling!;
  assert.deepEqual([sealed.state, sealed.chargedAmount, sealed.decision?.agreedAmount, sealed.decision?.deviation, sealed.decision?.reason, sealed.decision?.decidedByName], ["CUSTOM", 50, 50, 60, REASON, w.actor.name]);
  assert.ok(sealed.decision?.decidedAt);
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).mileage, STD_KM, "tatsächlicher Kilometerstand im Fahrzeug");
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: r.id } })).mileage, STD_KM);
  const events = await db.vehicleEvent.findMany({ where: { tenantId: w.tenantId, handoverId: r.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(events.map((e) => `${e.type} ${e.mileage}`).sort(), [`MILEAGE ${STD_KM}`, `RETURN ${STD_KM}`]);
  const bookingAfter = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(bookingAfter.status, "RETURNED");
  assert.ok(bookingAfter.actualReturnAt);
  assert.deepEqual(pick(bookingAfter), pick(bookingBefore), "Buchungs- und Tarifschnappschuss unverändert");
  const contractAfter = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal(contractAfter.contentHash, contractBefore.contentHash);
  assert.deepEqual(contractAfter.conditions, contractBefore.conditions);
  assert.deepEqual([contractAfter.kmIncludedPerDay, String(contractAfter.extraKmRate)], [contractBefore.kmIncludedPerDay, String(contractBefore.extraKmRate)]);
  assert.deepEqual(await db.securityDeposit.findMany({ where: { tenantId: w.tenantId, bookingId: w.bookingId }, include: { events: true } }), depositsBefore, "Kaution unverändert");
  assert.deepEqual(await securityDepositFinancials(w.tenantId, w.bookingId), depositFinBefore, "Kautionsstand unverändert (erhalten, nichts verrechnet, nichts freigegeben)");
});

test("13 Versiegelt und Hash: nach dem Abschluss keine Änderung; die Entscheidung (auch der Grund) ist Teil des Protokoll-Hashs", async () => {
  const w = await world("mk-sealed");
  const r = await returnDraft(w, STD_KM);
  const decided = await decide(w, r.id, { mode: "CUSTOM", amount: "50" });
  // Bindung des Grundes: im Entwurf nur calculation.decision.reason ändern → anderer Hash; zurückgesetzt → derselbe Hash
  const h1 = await getHandoverContentHash(w.tenantId, r.id);
  const calc = decided.calculation as Calc;
  await db.extraCharge.update({ where: { id: decided.id }, data: { calculation: { ...calc, decision: { ...calc.decision, reason: "nachträglich anderer Grund" } } as Prisma.InputJsonValue } });
  assert.notEqual(await getHandoverContentHash(w.tenantId, r.id), h1);
  await db.extraCharge.update({ where: { id: decided.id }, data: { calculation: calc as Prisma.InputJsonValue } });
  assert.equal(await getHandoverContentHash(w.tenantId, r.id), h1);
  // ein anderer Schlüssel der Rechengrundlage neben der Entscheidung ändert den Hash nicht
  await db.extraCharge.update({ where: { id: decided.id }, data: { calculation: { ...calc, regularFormula: "x" } as Prisma.InputJsonValue } });
  assert.equal(await getHandoverContentHash(w.tenantId, r.id), h1);
  await db.extraCharge.update({ where: { id: decided.id }, data: { calculation: calc as Prisma.InputJsonValue } });
  await sign(w, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  assert.equal((await verifyHandover(w.tenantId, r.id)).intact, true);
  // abgelehnt wegen des versiegelten Protokolls (Unveränderlichkeit) – nicht aus einem anderen Grund („bereits entschieden“,
  // Unterschrift, Entscheidungssperre): deshalb Rücknahme mit bestätigtem Unterschriftsverlust
  await assert.rejects(() => decide(w, r.id, { mode: "WAIVED" }), (e) => isImmutableError(e));
  await assert.rejects(() => revokeMileageDecision(w.tenantId, r.id, w.actor, { confirmSignatureLoss: true }), (e) => isImmutableError(e));
  await assert.rejects(() => removeCharge(w.tenantId, r.id, decided.id), (e) => isImmutableError(e));
  await assert.rejects(() => db.extraCharge.update({ where: { id: decided.id }, data: { amount: 1 } }), (e) => isImmutableError(e));
  assert.equal((await kmCharges(w, r.id)).length, 1);

  // Altform (reguläre Position ohne Entscheidung, wie bisher): Protokoll bleibt intakt
  const old = await returnedWorld("mk-sealed-legacy");
  tenants.push(old.tenantId);
  assert.equal((await verifyHandover(old.tenantId, old.returnId)).intact, true);
  const oldRow = await db.extraCharge.findUniqueOrThrow({ where: { id: old.charges.mileageId } });
  assert.equal((oldRow.calculation as Record<string, unknown>).decision, undefined);
  // nicht zirkulär: die Hash-Abbildung einer Position ohne Entscheidung hat exakt den Schlüsselsatz vor der Mehrkilometer-Abrechnung
  // (d31deb0) – damit bleiben alle bereits versiegelten Protokolle bitgleich; mit Entscheidung kommt nur „decision“ hinzu
  const LEGACY_KEYS = ["type", "description", "formula", "amount", "source", "handoverDamageId"];
  assert.deepEqual(Object.keys(hashedExtraCharge(oldRow)), LEGACY_KEYS);
  assert.deepEqual(hashedExtraCharge(oldRow), { type: oldRow.type, description: oldRow.description, formula: oldRow.formula, amount: String(oldRow.amount), source: oldRow.source, handoverDamageId: oldRow.handoverDamageId });
  const sealedRow = await db.extraCharge.findUniqueOrThrow({ where: { id: decided.id } });
  assert.deepEqual(Object.keys(hashedExtraCharge(sealedRow)), [...LEGACY_KEYS, "decision"]);
  assert.deepEqual(hashedExtraCharge(sealedRow).decision, (sealedRow.calculation as Calc).decision, "Rohdaten der Entscheidung");
});

// ---------------------------------------------------------------------------
// Rechnung (D10)
// ---------------------------------------------------------------------------

test("14 Rechnung: Pauschalzeile mit Erläuterung (brutto und netto), Erlass 0,00 €; der Entwurf darf nicht mehr verlangen als entschieden", async () => {
  // Brutto, individueller Betrag
  const w = await world("mk-inv-b");
  const r = await returnDraft(w, STD_KM);
  await decide(w, r.id, { mode: "CUSTOM", amount: "50" });
  await sign(w, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const v = await draftOf(inv.id);
  const line = v.items.find((i) => i.source === "EXTRA_CHARGE")!;
  assert.equal(line.description, "Mehrkilometer: 440 km über Freikilometer (regulär 110,00 €), Kulanznachlass 60,00 €");
  assert.deepEqual([Number(line.quantity), line.unit, toCents(line.unitPrice), toCents(line.grossAmount)], [1, "pauschal", 5_000, 5_000]);
  assert.ok(!v.items.some((i) => toCents(i.grossAmount) === 11_000), "keine Zeile über den regulären Betrag");
  const rentGross = v.items.filter((i) => i.source !== "EXTRA_CHARGE").reduce((s, i) => s + toCents(i.grossAmount), 0);
  assert.equal(toCents(v.grossTotal), rentGross + 5_000);
  assert.ok(!(await getInvoiceState(w.tenantId, inv.id)).issues.some((i) => i.code === "EXTRA_MILEAGE_DECISION"));
  // Kulanz im Rechnungsentwurf: mehr als entschieden → Fehler; weniger → nur Hinweis
  const setLine = (cents: number) => setChargeLine(w, inv.id, line.extraChargeId!, cents);
  await setLine(11_000);
  let issues = (await getInvoiceState(w.tenantId, inv.id)).issues;
  assert.ok(issues.some((i) => i.code === "EXTRA_MILEAGE_DECISION" && i.severity === "error"));
  await assert.rejects(() => finalizeInvoice(w.tenantId, inv.id, w.actor), /darf nicht mehr verlangen/);
  await setLine(4_000);
  issues = (await getInvoiceState(w.tenantId, inv.id)).issues;
  assert.ok(issues.some((i) => i.code === "EXTRA_MILEAGE_DECISION" && i.severity === "warning"));
  assert.ok(!issues.some((i) => i.severity === "error"));
  assert.equal((await finalizeInvoice(w.tenantId, inv.id, w.actor)).status, "FINALIZED");

  // Erlass: Zeile 0,00 €, Rechnung abschließbar, nichts von den 110 € offen
  const c = await world("mk-inv-c");
  const rc = await returnDraft(c, STD_KM);
  await decide(c, rc.id, { mode: "WAIVED" });
  await sign(c, rc.id);
  await finalizeHandover(c.tenantId, rc.id, c.actor);
  // versiegelt: Erlass mit Grund, Mitarbeiter und Zeitpunkt aus dem abgeschlossenen Protokoll
  const sealedC = (await getReturnComparison(c.tenantId, rc.id)).mileageBilling!;
  assert.deepEqual([sealedC.state, sealedC.chargedAmount, sealedC.decision?.agreedAmount, sealedC.decision?.deviation, sealedC.decision?.reason, sealedC.decision?.decidedByName], ["WAIVED", 0, 0, 110, REASON, c.actor.name]);
  assert.ok(sealedC.decision?.decidedAt);
  const cinv = await ensureInvoiceDraft(c.tenantId, c.bookingId, c.actor);
  const cv = await draftOf(cinv.id);
  const cline = cv.items.find((i) => i.source === "EXTRA_CHARGE")!;
  assert.equal(cline.description, "Mehrkilometer: 440 km über Freikilometer (regulär 110,00 €), aus Kulanz erlassen");
  assert.equal(toCents(cline.grossAmount), 0);
  assert.equal(toCents(cv.grossTotal), cv.items.filter((i) => i.source !== "EXTRA_CHARGE").reduce((s, i) => s + toCents(i.grossAmount), 0), "Gesamtbetrag ohne die 110 €");
  // erlassen heißt: keine offene Forderung – auch nicht über den Rechnungsentwurf
  await setChargeLine(c, cinv.id, cline.extraChargeId!, 11_000);
  assert.ok((await getInvoiceState(c.tenantId, cinv.id)).issues.some((i) => i.code === "EXTRA_MILEAGE_DECISION" && i.severity === "error"));
  await assert.rejects(() => finalizeInvoice(c.tenantId, cinv.id, c.actor), /aus Kulanz erlassen[\s\S]*darf nicht mehr verlangen/);
  await setChargeLine(c, cinv.id, cline.extraChargeId!, 0);
  assert.ok(!(await getInvoiceState(c.tenantId, cinv.id)).issues.some((i) => i.code === "EXTRA_MILEAGE_DECISION"));
  assert.equal((await finalizeInvoice(c.tenantId, cinv.id, c.actor)).status, "FINALIZED");

  // Netto-Mandant: „netto“ hinter den Beträgen, 50 € netto + 19 % = 59,50 € brutto; verglichen wird netto (kein Fehlalarm 59,50 > 50)
  const n = await world("mk-inv-net", { tenant: { pricesIncludeTax: false } });
  const rn = await returnDraft(n, STD_KM);
  await decide(n, rn.id, { mode: "CUSTOM", amount: "50" });
  const [nc] = await kmCharges(n, rn.id);
  assert.equal(nc.description, "440 km über Freikilometer (regulär 110,00 € netto), Kulanznachlass 60,00 € netto");
  assert.deepEqual([(nc.calculation as Calc).decision.netPrices, (nc.calculation as Calc).decision.pricesIncludeTax], [true, false]);
  await sign(n, rn.id);
  await finalizeHandover(n.tenantId, rn.id, n.actor);
  const ninv = await ensureInvoiceDraft(n.tenantId, n.bookingId, n.actor);
  const nline = (await draftOf(ninv.id)).items.find((i) => i.source === "EXTRA_CHARGE")!;
  assert.match(nline.description, /netto/);
  assert.deepEqual([toCents(nline.netAmount), toCents(nline.grossAmount)], [5_000, 5_950]);
  assert.ok(!(await getInvoiceState(n.tenantId, ninv.id)).issues.some((i) => i.code === "EXTRA_MILEAGE_DECISION"), "netto 50 = vereinbart 50");
  assert.equal((await finalizeInvoice(n.tenantId, ninv.id, n.actor)).status, "FINALIZED");
});

test("14b Rechnung bei „Regulär berechnen“: die Zeile darf nicht über dem regulären Betrag liegen; senken bleibt ohne Hinweis möglich", async () => {
  const w = await world("mk-inv-a");
  const r = await returnDraft(w, STD_KM);
  await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
  await sign(w, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const line = (await draftOf(inv.id)).items.find((i) => i.source === "EXTRA_CHARGE")!;
  assert.equal(toCents(line.grossAmount), 11_000);
  await setChargeLine(w, inv.id, line.extraChargeId!, 12_000);
  const issue = (await getInvoiceState(w.tenantId, inv.id)).issues.find((i) => i.code === "EXTRA_MILEAGE_DECISION");
  assert.equal(issue?.severity, "error");
  assert.match(issue?.message ?? "", /regulär mit 110,00\s€ berechnet – die Rechnung darf nicht mehr verlangen/);
  await assert.rejects(() => finalizeInvoice(w.tenantId, inv.id, w.actor), /darf nicht mehr verlangen/);
  // Kulanz am PC wie bisher (invoices.test): senken ohne Hinweis, da es keine Entscheidung gibt
  await setChargeLine(w, inv.id, line.extraChargeId!, 8_000);
  assert.ok(!(await getInvoiceState(w.tenantId, inv.id)).issues.some((i) => i.code === "EXTRA_MILEAGE_DECISION"));
  assert.equal((await finalizeInvoice(w.tenantId, inv.id, w.actor)).status, "FINALIZED");
});

test("16 Preis je Mehrkilometer 0 €: keine Forderung, kein Blocker und kein Hinweis, nichts zu entscheiden – Abschluss möglich", async () => {
  const w = await world("mk-zero", { conditions: { extraKmRate: 0 } });
  const r = await returnDraft(w, STD_KM);
  const m = (await getReturnComparison(w.tenantId, r.id)).mileageBilling!;
  assert.deepEqual([m.state, m.extraKm, m.extraKmRate, m.regularAmount], ["ZERO_RATE", 440, 0, 0]);
  assert.ok(!(await codes(w, r.id)).some((x) => x.startsWith("EXTRA_MILEAGE_")), "kein Mehrkilometer-Blocker");
  await assert.rejects(() => decide(w, r.id, { mode: "WAIVED", seenRegularCents: 0 }), /ist 0,00\s€ – es gibt nichts festzulegen/);
  assert.equal((await kmCharges(w, r.id)).length, 0);
  const st = await getHandoverCompletionStatus(w.tenantId, r.id);
  assert.ok(!st.warnings.some((x) => x.code === "PROPOSAL_OPEN_EXTRA_MILEAGE"), "kein Hinweis, der sich nur über eine 0,00-€-Position erledigen ließe");
  assert.ok(!st.blockers.some((x) => x.code.startsWith("EXTRA_MILEAGE_")));
  await sign(w, r.id);
  assert.equal((await finalizeHandover(w.tenantId, r.id, w.actor)).status, "FINALIZED");
  assert.equal((await getReturnComparison(w.tenantId, r.id)).mileageBilling?.state, "ZERO_RATE");
});

// ---------------------------------------------------------------------------
// Mandant und Rollen
// ---------------------------------------------------------------------------

test("15 Mandant und Rollen: fremder Mandant findet das Protokoll nicht; individuell/erlassen nur Inhaber und Disposition (Server Action)", async () => {
  const w = await world("mk-tenant");
  const r = await returnDraft(w, STD_KM);
  const other = await createWorld("mk-tenant-other");
  tenants.push(other.tenantId);
  await assert.rejects(() => decideMileageProposal(other.tenantId, r.id, other.actor, { mode: "WAIVED", reason: REASON, seenRegularCents: 11_000 }), /Protokoll nicht gefunden/);
  await assert.rejects(() => revokeMileageDecision(other.tenantId, r.id, other.actor), /Protokoll nicht gefunden/);
  assert.equal((await kmCharges(w, r.id)).length, 0);

  // Rollenmatrix: dieselbe Funktion wie requireRole
  assert.deepEqual([roleAllows("OWNER", ["DISPO"]), roleAllows("DISPO", ["DISPO"]), roleAllows("YARD", ["DISPO"])], [true, true, false]);
  // Quelltextprüfung wie round3.test: die neuen Aktionen prüfen selbst nur DISPO (OWNER implizit), „Regulär berechnen“ bleibt bei context()
  const src = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rueckgabe/actions.ts"), "utf8");
  const body = (fn: string) => new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`).exec(src)?.[0] ?? "";
  for (const fn of ["decideMileageAction", "revokeMileageDecisionAction"]) {
    const b = body(fn);
    assert.ok(b.length > 0, `${fn} vorhanden`);
    assert.match(b, /requireRole\("DISPO"\)/, fn);
    assert.ok(!/YARD/.test(b), `${fn}: kein Hofmitarbeiter`);
    assert.ok(!/context\(/.test(b), `${fn}: nicht über context()`);
    assert.match(b, /tenantId: tenant\.id/, `${fn}: mandantengebunden`);
  }
  assert.match(body("confirmProposalAction"), /await context\(bookingId\)/);
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rueckgabe/page.tsx"), "utf8");
  assert.match(page, /canDecideMileage=\{user\.role !== "YARD"\}/);
  // Schritt 7: veraltet/doppelt/manuell nur in der Karte, nicht zusätzlich in der Fehlerliste (keine doppelten role="alert")
  assert.match(page, /<HandoverIssueList issues=\{issues\} areas=\{\["CHARGES"\]\} codes=\{\(c\) => !inMileageCard\(c\)\} \/>/);

  // Mobile Darstellung – nur per Quelltext geprüft (kein Browser im Test): Optionen untereinander, große Tippflächen, Knöpfe über die
  // volle Breite, Dezimaltastatur, alles während des Speicherns gesperrt, Fehler als role="alert"; Werte schrumpfen und brechen auch
  // lange Wörter, Begründung/Entscheidung mobil über die volle Breite und erst ab sm rechtsbündig (kein waagrechtes Scrollen)
  const parts = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rueckgabe/return-parts.tsx"), "utf8");
  // Nur die neuen Bausteine prüfen: role="alert" und inputMode="decimal" stehen auch im älteren Zusatzkosten-Editor bzw. -Formular
  // derselben Datei und würden sonst auch ohne die Karte treffen
  const between = (from: string, to: string) => {
    const a = parts.indexOf(from), b = parts.indexOf(to);
    assert.ok(a >= 0 && b > a, `Ausschnitt ${from} … ${to}`);
    return parts.slice(a, b);
  };
  const facts = between("function MileageFacts", "function MileageBillingCard");
  const card = between("function MileageBillingCard", "export function MileageBillingSealed");
  for (const re of [/grid grid-cols-1 sm:grid-cols-3/, /flex min-h-\[52px\]/, /btn btn-primary w-full sm:w-auto/, /btn w-full sm:w-auto/, /inputMode="decimal"/, /!min-h-\[52px\]/, /<fieldset[^>]*disabled=\{busy\}/, /role="alert"/]) assert.match(card, re, `Mehrkilometer-Karte: ${re}`);
  for (const re of [/grid grid-cols-\[auto_minmax\(0,1fr\)\]/, /const value = "min-w-0 font-mono tnum text-right"/, /ml-1 whitespace-nowrap text-xs/,/col-span-2 sm:col-span-1 min-w-0 \[overflow-wrap:anywhere\] sm:text-right/, /<dd className=\{wideValue\}>\{d\.reason \|\| "–"\}<\/dd>/]) assert.match(facts, re, `Zahlenblock der Karte: ${re}`);
  assert.ok(!/break-words/.test(facts), "kein break-words (senkt die min-content-Breite nicht)");
  // Begründung: der Zähler steht außerhalb des <label> (sonst Teil des zugänglichen Namens der Textarea)
  assert.match(card, /<label htmlFor=\{`\$\{ids\}-reason`\} className="label-xs">Begründung der Abweichung \(Pflicht, intern\)<\/label>\s*<textarea id=\{`\$\{ids\}-reason`\}/);
  // Beschriftung „Wird gespeichert…/zurückgenommen…“ nur für die eigene Aktion der Karte (gesperrt wird über das gemeinsame busy)
  assert.match(card, /pending === "decide" \? "Wird gespeichert…"/);
  assert.match(card, /pending === "revoke" \? "Wird zurückgenommen…"/);
  // veralteter Stand nach einer Ablehnung: die Aktionen erneuern die Anzeige auch im Fehlerfall
  for (const fn of ["decideMileageAction", "revokeMileageDecisionAction"]) assert.match(body(fn), /catch \(e\) \{ revalidatePath\(base\(bookingId\)\); return asResult\(e\); \}/, fn);
});
