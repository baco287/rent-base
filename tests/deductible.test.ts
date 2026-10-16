// Befehl 29.5: Selbstbeteiligung an Miettarife gekoppelt – Tarifwert in unveränderlichen Revisionen, Übernahme in die Buchung,
// individuelle Abweichung mit Pflichtgrund, Einfrieren im Vertrag (Snapshot + Prüfsumme), Vertragsdokument/PDF, Schadenakte nur zur
// Information, Altbestand unverändert, Rollen und Mandantentrennung. Läuft gegen die lokale Testdatenbank (wie alle Integrationstests).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { roleAllows } from "../src/lib/constants";
import { recordAudit } from "../src/lib/audit";
import { bookingTariffFor, keepBookingTariff, MAX_DEDUCTIBLE_CENTS, readTariffSnapshot, vehicleTariffs, type TariffChoices } from "../src/lib/tariffs";
import { checkContent, createRatePlan, listRatePlans, reviseRatePlan, setRatePlanActive, type TariffContent } from "../src/lib/tariff-admin";
import { ensureContractDraft, refreshContractDraft, saveConditions } from "../src/lib/contracts";
import { changeBookingPeriod } from "../src/lib/booking-period";
import { loadContractDocumentData } from "../src/lib/document-data";
import { renderContractPdf } from "../src/lib/pdf/contract-pdf";
import { caseView, openDamageCase, setCaseCosts } from "../src/lib/damage-cases";
import { tariffChoicesFromForm } from "../src/app/(app)/buchungen/tariff-form-data";
import { createWorld, purgeTenants, type World } from "./helpers";
import { pickedUpWorld, returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const DAY = 86_400_000;
const OWNER = (w: World) => ({ id: w.userId, name: "Inhaberin Test" });
const T = (...cents: [number, number, number, number]) => [{ days: 1, cents: cents[0] }, { days: 5, cents: cents[1] }, { days: 7, cents: cents[2] }, { days: 30, cents: cents[3] }];
const FREE = { policy: "FREE_KILOMETERS" as const, kmIncludedPerDay: 200, extraKmRateCents: 25 };
const TARIFF: TariffChoices = { price: { mode: "TARIFF" }, km: { mode: "TARIFF" }, deposit: { mode: "TARIFF" } };
const SB = (cents: number, reason: string): TariffChoices => ({ ...TARIFF, deductible: { mode: "INDIVIDUAL", cents, reason } });
/** Tarifinhalt: Preisstufen wie BASIC/PLUS, Kaution und Selbstbeteiligung frei wählbar (null = keine Tarifvorgabe). */
const content = (groupId: string, deductibleCents: number | null, depositCents = 20000, tiers = T(5900, 25900, 32900, 99900)): TariffContent => ({ km: FREE, depositCents, deductibleCents, groups: [{ groupId, tiers, depositCents: null, km: null }] });

async function world(label: string): Promise<World> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.customer.update({ where: { id: w.customerId }, data: { discountPercent: 0 } });
  return w;
}
async function plan(w: World, name: string, c: TariffContent) {
  return (await createRatePlan(w.tenantId, OWNER(w), { meta: { name, code: null, description: null, sortOrder: 0 }, content: c, active: true, createKey: randomUUID() })).id;
}
const currentRev = async (planId: string) => (await db.ratePlan.findUniqueOrThrow({ where: { id: planId } })).currentRevisionId!;
/** Buchung der Welt auf einen Tarif setzen (wie die Buchungsaktionen: Snapshot, Buchungsfelder, Audit). */
async function tariffBooking(w: World, ratePlanId: string, choices: TariffChoices = TARIFF, days = 7) {
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const endAt = new Date(b.startAt.getTime() + days * DAY);
  return db.$transaction(async (tx) => {
    const r = await bookingTariffFor(tx, w.tenantId, OWNER(w), { vehicleId: b.vehicleId, ratePlanId, startAt: b.startAt, endAt, discountPercent: 0, choices, previous: readTariffSnapshot(b.tariffSnapshot) });
    await tx.booking.update({ where: { id: w.bookingId }, data: { ...r.data, endAt } });
    for (const a of r.audits) await recordAudit(tx, w.tenantId, OWNER(w), { ...a, bookingId: w.bookingId });
    return r;
  });
}
/** Eingefrorenen Tarif behalten, nur Abweichungen ändern (Speichern der Buchung mit „Tarif dieser Buchung“). */
async function keepTariff(w: World, choices: TariffChoices) {
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const r = keepBookingTariff(readTariffSnapshot(b.tariffSnapshot)!, { startAt: b.startAt, endAt: b.endAt!, discountPercent: 0, choices, actor: OWNER(w) });
  await db.$transaction(async (tx) => {
    await tx.booking.update({ where: { id: w.bookingId }, data: r.data });
    for (const a of r.audits) await recordAudit(tx, w.tenantId, OWNER(w), { ...a, bookingId: w.bookingId });
  });
  return r;
}
/** Laufende Miete auf einem Tarif (Vertrag unterschrieben, Übergabe erfolgt). */
async function tariffRental(label: string, deductibleCents: number | null, choices: TariffChoices = TARIFF) {
  let planId = "";
  const w = await pickedUpWorld(label, {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.customer.update({ where: { id: x.customerId }, data: { discountPercent: 0 } });
      planId = await plan(x, "PLUS", content(x.groupId, deductibleCents));
      await tariffBooking(x, planId, choices, 6);
    },
  });
  return { w, planId };
}
const contractRow = (id: string) => db.rentalContract.findUniqueOrThrow({ where: { id } });
type FrozenTariff = { ratePlanId: string; revisionId: string; revision: number; deductible?: { cents: number; source: string; ruleSource?: string }; agreed: { deductible?: { cents: number; reason: string } | null } };
const frozenTariff = (c: { priceSnapshot: unknown }) => (c.priceSnapshot as { tariff: FrozenTariff }).tariff;
const contractRules = (c: { conditions: unknown }) => c.conditions as { values: { deductibleCents: number | null }; sources: { deductibleCents: string } };

// ---------------------------------------------------------------------------
// Tarifverwaltung und Revisionen
// ---------------------------------------------------------------------------

test("1/2/3 Tarife mit 1.500 €, 750 € und 0 € Selbstbeteiligung je Mandant; leer = keine Tarifvorgabe; Kaution getrennt", async () => {
  const w = await world("sb-create");
  await plan(w, "BASIC", content(w.groupId, 150000, 30000));
  await plan(w, "PLUS", content(w.groupId, 75000, 20000));
  await plan(w, "PREMIUM 0", content(w.groupId, 0, 10000));
  await plan(w, "OHNE VORGABE", content(w.groupId, null));
  const revs = await db.ratePlanRevision.findMany({ where: { tenantId: w.tenantId }, include: { ratePlan: { select: { name: true } } } });
  assert.deepEqual(Object.fromEntries(revs.map((r) => [r.ratePlan.name, r.deductibleCents])), { BASIC: 150000, PLUS: 75000, "PREMIUM 0": 0, "OHNE VORGABE": null });
  const list = await listRatePlans(w.tenantId);
  const by = (n: string) => list.find((p) => p.name === n)!;
  assert.equal(by("PLUS").deductibleCents, 75000);
  assert.equal(by("PREMIUM 0").deductibleCents, 0, "0 € ist ein eigener Wert, nicht „leer“");
  assert.equal(by("OHNE VORGABE").deductibleCents, null);
  assert.equal(by("BASIC").depositCents, 30000, "Kaution bleibt eigener Wert");
  const created = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: "RATE_PLAN_CREATED" } });
  assert.ok(created.some((a) => /Selbstbeteiligung: 1\.500,00/.test(JSON.stringify(a.details))), "Audit enthält die Selbstbeteiligung");
  assert.ok(created.some((a) => /Selbstbeteiligung: keine Tarifvorgabe/.test(JSON.stringify(a.details))));
  // keine globalen Tarife: ein anderer Mandant sieht nichts davon
  const other = await world("sb-create-b");
  assert.equal((await listRatePlans(other.tenantId)).length, 0);
});

test("4 negative, gebrochene und unplausible Beträge werden abgelehnt – in Engine, Formular und Datenbank", async () => {
  const w = await world("sb-invalid");
  for (const bad of [-1, -150000, 10.5, MAX_DEDUCTIBLE_CENTS + 1]) {
    assert.throws(() => checkContent(content(w.groupId, bad)), /Selbstbeteiligung des Tarifs/, String(bad));
    await assert.rejects(() => plan(w, `X ${bad}`, content(w.groupId, bad)), /Selbstbeteiligung des Tarifs/);
  }
  assert.equal(await db.ratePlan.count({ where: { tenantId: w.tenantId } }), 0, "nichts angelegt");
  const ok = await plan(w, "OK", content(w.groupId, 0));
  await assert.rejects(() => db.ratePlanRevision.create({ data: { tenantId: w.tenantId, ratePlanId: ok, revision: 99, kmPolicy: "UNLIMITED", depositCents: 0, deductibleCents: -5 } }), /rb_rateplan_revision_deductible/);
  // Buchung: nur Tarifbuchungen, nie negativ, Grund nur mit Wert und mindestens 3 Zeichen
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { deductibleCents: 100 } }), /rb_booking_deductible/, "Buchung ohne Tarif");
  await tariffBooking(w, ok);
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { deductibleCents: -1 } }), /rb_booking_deductible/);
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { deductibleOverrideReason: "x" } }), /rb_booking_deductible/);
  await assert.rejects(() => tariffBooking(w, ok, SB(-100, "Grund genug")), /Vereinbarte Selbstbeteiligung/);
  await assert.rejects(() => tariffBooking(w, ok, SB(MAX_DEDUCTIBLE_CENTS + 1, "Grund genug")), /Vereinbarte Selbstbeteiligung/);
  // manipulierte Formularwerte: exakt in Cent, keine negativen oder unlesbaren Beträge, Feld fehlt = keine Angabe
  const fd = (v: Record<string, string>) => { const f = new FormData(); for (const [k, x] of Object.entries(v)) f.set(k, x); return f; };
  for (const amount of ["-5", "", "abc", "1,2,3"]) assert.ok("error" in tariffChoicesFromForm(fd({ deductibleMode: "INDIVIDUAL", deductibleOverride: amount, deductibleReason: "Grund" })), amount);
  const parsed = tariffChoicesFromForm(fd({ deductibleMode: "INDIVIDUAL", deductibleOverride: "1.234,56", deductibleReason: "Firmenkunde" }));
  assert.deepEqual("error" in parsed ? null : parsed.deductible, { mode: "INDIVIDUAL", cents: 123456, reason: "Firmenkunde" });
  const none = tariffChoicesFromForm(fd({}));
  assert.ok(!("error" in none) && none.deductible === undefined, "ohne Feld keine Angabe (bestehende Vereinbarung bleibt)");
});

test("5/6 Änderung der Selbstbeteiligung erzeugt eine neue Revision; die alte bleibt unverändert; gleicher Inhalt keine Revision", async () => {
  const w = await world("sb-revision");
  const p = await plan(w, "BASIC", content(w.groupId, 150000));
  const r1 = await currentRev(p);
  assert.deepEqual(await reviseRatePlan(w.tenantId, OWNER(w), p, { content: content(w.groupId, 100000), expectedRevisionId: r1 }), { revision: 2, created: true });
  const r2 = await currentRev(p);
  assert.deepEqual(await reviseRatePlan(w.tenantId, OWNER(w), p, { content: content(w.groupId, 100000), expectedRevisionId: r2 }), { revision: 2, created: false }, "gleicher Inhalt: keine Revision");
  assert.equal((await db.ratePlanRevision.findUniqueOrThrow({ where: { id: r1 } })).deductibleCents, 150000, "Revision 1 unverändert");
  assert.equal((await db.ratePlanRevision.findUniqueOrThrow({ where: { id: r2 } })).deductibleCents, 100000);
  // leer setzen ist ebenfalls eine Inhaltsänderung (neue Revision), kein Überschreiben
  assert.deepEqual(await reviseRatePlan(w.tenantId, OWNER(w), p, { content: content(w.groupId, null), expectedRevisionId: r2 }), { revision: 3, created: true });
  await assert.rejects(() => db.ratePlanRevision.update({ where: { id: r1 }, data: { deductibleCents: 1 } }), /RB_IMMUTABLE/);
  // veralteter Editor überschreibt nichts
  await assert.rejects(() => reviseRatePlan(w.tenantId, OWNER(w), p, { content: content(w.groupId, 5), expectedRevisionId: r1 }), /inzwischen geändert/);
  const revised = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: "RATE_PLAN_REVISED" }, orderBy: { createdAt: "asc" } });
  const d0 = revised[0].details as { before: { content: string }; after: { content: string } };
  assert.match(d0.before.content, /Selbstbeteiligung: 1\.500,00/, "Audit vorher");
  assert.match(d0.after.content, /Selbstbeteiligung: 1\.000,00/, "Audit nachher");
});

// ---------------------------------------------------------------------------
// Buchung: Übernahme und Abweichung
// ---------------------------------------------------------------------------

test("7/8 Buchung übernimmt die Selbstbeteiligung des Tarifs; Tarifwechsel übernimmt den Wert des neuen Tarifs; Angebote zeigen sie je Tarif", async () => {
  const w = await world("sb-booking");
  const basic = await plan(w, "BASIC", content(w.groupId, 150000, 30000));
  const plus = await plan(w, "PLUS", content(w.groupId, 75000, 20000));
  const offers = (await vehicleTariffs(w.tenantId, w.vehicleId)).bases;
  assert.deepEqual(offers.map((b) => [b.ratePlanName, b.deductible?.cents, b.deductible?.source]).sort(), [["BASIC", 150000, "TARIFF"], ["PLUS", 75000, "TARIFF"]]);
  await tariffBooking(w, basic);
  let b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.deductibleCents, 150000);
  assert.equal(b.deductibleOverrideReason, null);
  assert.equal(Number(b.deposit), 300, "Kaution aus dem Tarif, unabhängig");
  assert.deepEqual(readTariffSnapshot(b.tariffSnapshot)?.deductible, { cents: 150000, source: "TARIFF" });
  await tariffBooking(w, plus);
  b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.deductibleCents, 75000, "Tarifwechsel: Wert des neuen Tarifs");
  assert.equal(Number(b.deposit), 200);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "BOOKING_DEDUCTIBLE_OVERRIDDEN" } }), 0, "keine Abweichung, kein Abweichungs-Audit");
});

test("8 Tarif ohne Vorgabe: Selbstbeteiligung aus den Geschäftsregeln (Mandant, Gruppe) – bei der Buchung eingefroren", async () => {
  const w = await world("sb-rules");
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { deductibleCents: 100000 } } });
  const open = await plan(w, "OHNE VORGABE", content(w.groupId, null));
  await tariffBooking(w, open);
  let b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.deductibleCents, 100000);
  assert.deepEqual(readTariffSnapshot(b.tariffSnapshot)?.deductible, { cents: 100000, source: "RULES", ruleSource: "TENANT" });
  await db.vehicleGroup.update({ where: { id: w.groupId }, data: { businessRules: { deductibleCents: 120000 } } });
  await tariffBooking(w, open);
  b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.deepEqual(readTariffSnapshot(b.tariffSnapshot)?.deductible, { cents: 120000, source: "RULES", ruleSource: "GROUP" });
  // eingefroren: eine spätere Regeländerung ändert weder Buchung noch den daraus entstehenden Vertragsentwurf
  await db.vehicleGroup.update({ where: { id: w.groupId }, data: { businessRules: { deductibleCents: 50000 } } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(Number(c.deductible), 1200);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).deductibleCents, 120000);
});

test("9/10/11 individuelle Selbstbeteiligung nur bewusst mit Pflichtgrund; 0 € zulässig; Tarif bleibt unverändert; Audit; ohne Angabe bleibt sie bestehen", async () => {
  const w = await world("sb-override");
  const basic = await plan(w, "BASIC", content(w.groupId, 150000));
  await assert.rejects(() => tariffBooking(w, basic, SB(50000, "")), /Grund für die abweichende Selbstbeteiligung/);
  await assert.rejects(() => tariffBooking(w, basic, SB(50000, "ab")), /mindestens 3 Zeichen/);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).ratePlanId, null, "abgelehnt: nichts gespeichert");
  await tariffBooking(w, basic, SB(50000, "Individuelle Vereinbarung mit Firmenkunde."));
  let b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.deductibleCents, 50000);
  assert.equal(b.deductibleOverrideReason, "Individuelle Vereinbarung mit Firmenkunde.");
  const snap = readTariffSnapshot(b.tariffSnapshot)!;
  assert.equal(snap.deductible?.cents, 150000, "Tarifwert bleibt im Snapshot");
  assert.equal(snap.agreed.deductible?.cents, 50000);
  assert.equal(snap.agreed.deductible?.byName, "Inhaberin Test");
  assert.equal((b.overrideInfo as { deductible: { byName: string } }).deductible.byName, "Inhaberin Test");
  assert.equal((await db.ratePlanRevision.findUniqueOrThrow({ where: { id: await currentRev(basic) } })).deductibleCents, 150000, "keine stillschweigende Tarifänderung");
  const audits = () => db.auditLog.findMany({ where: { tenantId: w.tenantId, action: "BOOKING_DEDUCTIBLE_OVERRIDDEN" }, orderBy: { createdAt: "asc" } });
  const a1 = await audits();
  assert.equal(a1.length, 1);
  assert.equal(a1[0].bookingId, w.bookingId);
  assert.deepEqual([(a1[0].details as { tariffCents: number }).tariffCents, (a1[0].details as { agreedCents: number }).agreedCents, (a1[0].details as { reason: string }).reason], [150000, 50000, "Individuelle Vereinbarung mit Firmenkunde."]);
  // gleiche Vereinbarung erneut speichern (Doppelklick): kein neues Audit, Zeitpunkt bleibt
  await keepTariff(w, SB(50000, "Individuelle Vereinbarung mit Firmenkunde."));
  assert.equal((await audits()).length, 1);
  // Formular ohne Selbstbeteiligungsfeld (z. B. Notiz geändert): Vereinbarung bleibt bestehen
  await keepTariff(w, TARIFF);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).deductibleCents, 50000);
  // 0 € individuell
  await keepTariff(w, SB(0, "Premiumkunde ohne Selbstbeteiligung"));
  b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.deductibleCents, 0);
  assert.equal((await audits()).length, 2);
  // bewusst zurück auf den Tarif
  await keepTariff(w, { ...TARIFF, deductible: { mode: "TARIFF" } });
  b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.deductibleCents, 150000);
  assert.equal(b.deductibleOverrideReason, null);
  assert.match(JSON.stringify((await audits())[2].details), /wie Tarif/);
});

// ---------------------------------------------------------------------------
// Vertrag: Einfrieren, Prüfsumme, Dokument
// ---------------------------------------------------------------------------

test("12 Vertrag friert die vereinbarte Selbstbeteiligung samt Herkunft ein (Tarif, Revision, Tarifwert, Abweichung, Grund)", async () => {
  const { w, planId } = await tariffRental("sb-contract", 75000, SB(50000, "Firmenkunde Rahmenvertrag"));
  const c = await contractRow(w.contractId);
  assert.equal(c.status, "SIGNED");
  assert.equal(Number(c.deductible), 500);
  const t = frozenTariff(c);
  assert.equal(t.ratePlanId, planId);
  assert.equal(t.revisionId, await currentRev(planId));
  assert.equal(t.revision, 1);
  assert.deepEqual(t.deductible, { cents: 75000, source: "TARIFF" });
  assert.equal(t.agreed.deductible?.cents, 50000);
  assert.equal(t.agreed.deductible?.reason, "Firmenkunde Rahmenvertrag");
  assert.deepEqual([contractRules(c).values.deductibleCents, contractRules(c).sources.deductibleCents], [50000, "BOOKING"]);
  assert.ok(c.contentHash, "Prüfsumme über den unterschriebenen Inhalt (inkl. Selbstbeteiligung und Tarif-Snapshot)");
  await assert.rejects(() => db.rentalContract.update({ where: { id: c.id }, data: { deductible: 1 } }), /RB_IMMUTABLE/);
  // ohne Abweichung: Tarifwert, Herkunft Miettarif
  const plain = await tariffRental("sb-contract-plain", 75000);
  const c2 = await contractRow(plain.w.contractId);
  assert.equal(Number(c2.deductible), 750);
  assert.deepEqual([contractRules(c2).values.deductibleCents, contractRules(c2).sources.deductibleCents], [75000, "TARIFF"]);
});

test("Vertragsschritt: die Selbstbeteiligung einer Tarifbuchung ist dort gesperrt (Änderung nur in der Buchung mit Grund)", async () => {
  const w = await world("sb-conditions");
  const p = await plan(w, "PLUS", content(w.groupId, 75000));
  await tariffBooking(w, p, TARIFF, 6);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(Number(c.deductible), 750);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const input = { startAt: bk.startAt, endAt: bk.endAt, deposit: Number(bk.deposit), kmIncludedPerDay: bk.kmIncludedPerDay ?? 0, extraKmRate: Number(bk.extraKmRate ?? 0), deductible: 500, fuelPolicy: "FULL_TO_FULL" as const, fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" };
  await assert.rejects(() => saveConditions(w.tenantId, c.id, input), /Selbstbeteiligung dieser Tarifbuchung wird in der Buchung festgelegt/);
  await saveConditions(w.tenantId, c.id, { ...input, deductible: 750 });
  const after = await contractRow(c.id);
  assert.equal(Number(after.deductible), 750);
  assert.deepEqual([contractRules(after).values.deductibleCents, contractRules(after).sources.deductibleCents], [75000, "TARIFF"]);
});

test("13 spätere Tarifänderung und Deaktivierung verändern weder unterschriebenen Vertrag noch Buchung; ein Entwurf behält den Buchungswert", async () => {
  const { w, planId } = await tariffRental("sb-later", 75000);
  const c0 = await contractRow(w.contractId);
  await reviseRatePlan(w.tenantId, OWNER(w), planId, { content: content(w.groupId, 20000), expectedRevisionId: await currentRev(planId) });
  await setRatePlanActive(w.tenantId, OWNER(w), planId, false);
  const c1 = await contractRow(w.contractId);
  assert.equal(String(c1.deductible), String(c0.deductible));
  assert.deepEqual(c1.priceSnapshot, c0.priceSnapshot);
  assert.equal(c1.contentHash, c0.contentHash);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).deductibleCents, 75000);
  // Entwurf: Tarif wird nach der Buchung geändert – der Entwurf folgt der Buchung, nicht dem Live-Tarif
  const d = await world("sb-later-draft");
  const p = await plan(d, "PLUS", content(d.groupId, 75000));
  await tariffBooking(d, p);
  const draft = await ensureContractDraft(d.tenantId, d.bookingId, d.actor);
  await reviseRatePlan(d.tenantId, OWNER(d), p, { content: content(d.groupId, 20000), expectedRevisionId: await currentRev(p) });
  await db.$transaction((tx) => refreshContractDraft(tx, d.tenantId, draft.id));
  assert.equal(Number((await contractRow(draft.id)).deductible), 750);
});

test("14 Vertragsdokument und PDF: „Vereinbarte Selbstbeteiligung im Schadenfall“ und „Vereinbarte Kaution“ getrennt – kein Grund, keine Zahlungsformulierung", async () => {
  const { w } = await tariffRental("sb-pdf", 75000, SB(50000, "Interner Grund SB-XYZ"));
  const data = await loadContractDocumentData(w.tenantId, w.contractId);
  const rows = data.doc.sections.flatMap((s) => s.rows).map((r) => ({ ...r, value: String(r.value ?? "").replace(/ /g, " ") }));
  assert.equal(rows.find((r) => r.label === "Vereinbarte Selbstbeteiligung im Schadenfall")?.value, "500,00 €");
  assert.equal(rows.find((r) => r.label === "Vereinbarte Kaution")?.value, "200,00 €");
  assert.ok(!(data.doc.rules?.rows ?? []).some((r) => /Selbstbeteiligung/.test(r.label)), "nicht doppelt im Abschnitt Geschäftsregeln");
  const text = JSON.stringify(data.doc);
  assert.ok(!text.includes("Interner Grund SB-XYZ"), "interner Grund nicht im Kundendokument");
  assert.ok(!/Zahlungspflicht|zu zahlen|wird fällig|automatisch berechnet/i.test(rows.filter((r) => /Selbstbeteiligung/.test(r.label)).map((r) => r.value).join(" ")));
  const pdf = await renderContractPdf(data.doc, data.signatureImages);
  assert.ok(pdf.trace.texts.some((t) => t.includes("Vereinbarte Selbstbeteiligung im Schadenfall")), "PDF enthält die Zeile");
  assert.ok(pdf.trace.texts.some((t) => t.includes("500,00")), "PDF enthält den vereinbarten Betrag");
  assert.ok(!pdf.trace.texts.some((t) => t.includes("Interner Grund SB-XYZ")));
  assert.deepEqual(pdf.trace.boxes.filter((b) => b.overflow), [], "kein Text außerhalb des Satzspiegels");
});

// ---------------------------------------------------------------------------
// Unabhängigkeit von Kaution und Preis, Schadenakte
// ---------------------------------------------------------------------------

test("15/16 Kaution und Mietpreis bleiben unabhängig von der Selbstbeteiligung (keine Zahlung, kein Preisbestandteil)", async () => {
  const w = await world("sb-independent");
  const none = await plan(w, "OHNE SB", content(w.groupId, 0));
  const high = await plan(w, "MIT SB", content(w.groupId, 150000));
  const offers = (await vehicleTariffs(w.tenantId, w.vehicleId)).bases;
  const tiersOf = (id: string) => JSON.stringify(offers.find((b) => b.ratePlanId === id)!.tiers);
  assert.equal(tiersOf(none), tiersOf(high));
  const r1 = await tariffBooking(w, none);
  const r2 = await tariffBooking(w, high, SB(10000, "Sondervereinbarung"));
  assert.equal(r1.quote.regularCents, r2.quote.regularCents, "regulärer Preis gleich");
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.agreedPriceCents, null, "kein individueller Preis entstanden");
  assert.equal(Number(b.deposit), 200, "Kaution laut Tarif, keine automatische Anpassung");
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId } }), 0);
  const rental = await tariffRental("sb-independent-rental", 150000);
  const c = await contractRow(rental.w.contractId);
  const snapB = await db.booking.findUniqueOrThrow({ where: { id: rental.w.bookingId } });
  assert.equal(Math.round(Number(c.totalAmount) * 100), snapB.regularPriceCents, "Vertragspreis = Tarifpreis, ohne Selbstbeteiligung");
  assert.equal(Number(c.deposit), 200);
  assert.ok(!JSON.stringify((c.priceSnapshot as { lines?: unknown }).lines ?? []).includes("Selbstbeteiligung"));
});

test("17/18/19 Schadenakte zeigt die vereinbarte Selbstbeteiligung – keine Forderung, keine Kautionsverrechnung, keine Rechnung, kein Abschluss", async () => {
  let planId = "";
  const w = await returnedWorld("sb-damage", {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.customer.update({ where: { id: x.customerId }, data: { discountPercent: 0 } });
      planId = await plan(x, "PLUS", content(x.groupId, 75000));
      await tariffBooking(x, planId, SB(60000, "Stammkunde"), 6);
    },
  });
  const damage = await db.damage.findFirstOrThrow({ where: { tenantId: w.tenantId, discoveredInHandoverId: w.returnId } });
  const counts = async () => ({
    invoices: await db.invoice.count({ where: { tenantId: w.tenantId } }),
    payments: await db.payment.count({ where: { tenantId: w.tenantId } }),
    depositEvents: await db.securityDepositEvent.count({ where: { tenantId: w.tenantId } }),
    charges: await db.extraCharge.count({ where: { tenantId: w.tenantId } }),
  });
  const before = await counts();
  const { damageCase } = await openDamageCase(w.tenantId, damage.id, w.actor);
  await setCaseCosts(w.tenantId, damageCase.id, w.actor, { estimated: "2200" });
  const view = await caseView(w.tenantId, damageCase.id);
  assert.equal(view.deductibleInfo?.cents, 60000);
  assert.match(view.deductibleInfo!.origin, /individuell vereinbart \(Tarif PLUS, Revision 1; Tarifwert 750,00/);
  assert.equal(view.deductibleInfo?.reason, "Stammkunde");
  assert.deepEqual(await counts(), before, "keine Rechnung, Zahlung, Kautionsbewegung oder Zusatzkosten");
  assert.equal(view.customerChargeCents, null, "keine Schadenforderung");
  assert.equal(view.invoice, null);
  assert.notEqual(view.liabilityStatus, "CUSTOMER_RESPONSIBILITY_CONFIRMED", "Haftung nicht anerkannt");
  assert.notEqual(view.status, "CLOSED", "nicht abgeschlossen");
  // maßgeblich bleibt der Vertragswert – auch nach einer Tarifänderung
  await reviseRatePlan(w.tenantId, OWNER(w), planId, { content: content(w.groupId, 10000), expectedRevisionId: await currentRev(planId) });
  assert.equal((await caseView(w.tenantId, damageCase.id)).deductibleInfo?.cents, 60000);
});

// ---------------------------------------------------------------------------
// Altbestand, Rollen, Mandanten, bestehende Abläufe
// ---------------------------------------------------------------------------

test("20 historische Verträge und Buchungen vor 29.5 bleiben unverändert; Migration ist rein additiv", async () => {
  // Altvertrag ohne Tarif: Wert aus dem Vertragsschritt wie bisher, Darstellung unverändert
  const legacy = await pickedUpWorld("sb-legacy");
  tenants.push(legacy.tenantId);
  const lc = await contractRow(legacy.contractId);
  assert.equal(Number(lc.deductible), 1000);
  const doc = (await loadContractDocumentData(legacy.tenantId, legacy.contractId)).doc;
  assert.ok(doc.sections.flatMap((s) => s.rows).some((r) => r.label === "Selbstbeteiligung" && String(r.value).replace(/ /g, " ") === "1.000,00 €"), "bisherige Beschriftung");
  assert.ok(!doc.sections.flatMap((s) => s.rows).some((r) => /^Vereinbarte (Kaution|Selbstbeteiligung)/.test(r.label)), "keine neue Beschriftung bei Altverträgen");
  assert.ok((doc.rules?.rows ?? []).some((r) => r.label === "Selbstbeteiligung"), "Abschnitt Geschäftsregeln unverändert");
  // Tarifbuchung von vor 29.5 (Snapshot ohne Selbstbeteiligung): der Vertrag bestimmt sie wie bisher und bleibt dort änderbar
  const w = await world("sb-pre295");
  const p = await plan(w, "PLUS", content(w.groupId, 75000));
  await tariffBooking(w, p, TARIFF, 6);
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const old = readTariffSnapshot(b.tariffSnapshot)! as Record<string, unknown> & { agreed: Record<string, unknown> };
  delete old.deductible;
  delete old.agreed.deductible;
  await db.booking.update({ where: { id: w.bookingId }, data: { tariffSnapshot: old as object, deductibleCents: null, deductibleOverrideReason: null } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(Number(c.deductible), 0, "Geschäftsregel (keine hinterlegt) wie bisher");
  await saveConditions(w.tenantId, c.id, { startAt: b.startAt, endAt: b.endAt, deposit: Number(b.deposit), kmIncludedPerDay: b.kmIncludedPerDay ?? 0, extraKmRate: Number(b.extraKmRate ?? 0), deductible: 800, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  const c2 = await contractRow(c.id);
  assert.equal(Number(c2.deductible), 800);
  assert.equal(contractRules(c2).sources.deductibleCents, "CONTRACT");
  // „Tarif dieser Buchung“ behalten ändert eine Altbuchung nicht (kein erfundener Wert)
  await keepTariff(w, TARIFF);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).deductibleCents, null);
  // Migration: nur neue Spalten und Prüfregeln – keine Übernahme, kein Ändern oder Löschen
  const sql = readFileSync("prisma/migrations/20261023090000_selbstbeteiligung_tarife/migration.sql", "utf8").replace(/--.*$/gm, "");
  assert.ok(!/\b(UPDATE|DELETE|DROP|TRUNCATE|INSERT)\b/i.test(sql), "keine Datenänderung");
  assert.match(sql, /ADD COLUMN "deductibleCents" INTEGER;/);
  assert.ok(!/NOT NULL\s*;|DEFAULT/i.test(sql.replace(/IS NOT NULL/g, "")), "keine Pflichtspalte, kein Standardwert");
});

test("21/22/23 Rollen: Abweichung nur OWNER/DISPO, Tarif nur OWNER, Hof nur lesend, Supportmodus read-only", () => {
  const booking = readFileSync("src/app/(app)/buchungen/actions.ts", "utf8");
  for (const fn of ["createBookingAction", "updateBookingAction"]) {
    const body = booking.slice(booking.indexOf(`export async function ${fn}`));
    assert.ok(body.indexOf('requireRole("DISPO")') >= 0 && body.indexOf('requireRole("DISPO")') < body.indexOf("tariffChoicesFromForm"), `${fn}: Rolle vor dem Auslesen der Abweichungen`);
  }
  const tariffs = readFileSync("src/app/(app)/einstellungen/tarife/actions.ts", "utf8");
  for (const fn of ["createRatePlanAction", "saveRatePlanAction"]) assert.match(tariffs.slice(tariffs.indexOf(`export async function ${fn}`)).slice(0, 300), /requireRole\("OWNER"\)/, fn);
  assert.equal(roleAllows("OWNER", ["DISPO"]), true);
  assert.equal(roleAllows("DISPO", ["DISPO"]), true);
  assert.equal(roleAllows("YARD", ["DISPO"]), false, "Hof ändert keine Buchung");
  assert.equal(roleAllows("DISPO", ["OWNER"]), false, "Disposition ändert keinen Tarif");
  assert.match(readFileSync("src/lib/auth.ts", "utf8"), /export async function requireRole[\s\S]{0,200}if \(session\.supportSession\) redirect/, "Supportmodus schreibt nie");
  assert.match(readFileSync("src/app/(app)/einstellungen/tarife/[id]/page.tsx", "utf8"), /canEdit = user\.role === "OWNER" && !supportSession/);
  // Anzeige für alle Rollen: Schadenakte und Vertragsschritt lesen nur, der Vertragsschritt sperrt das Feld
  assert.match(readFileSync("src/app/(app)/schaeden/[id]/page.tsx", "utf8"), /deductibleInfo/);
  assert.match(readFileSync("src/app/(app)/buchungen/[id]/vertrag/page.tsx", "utf8"), /readOnly=\{deductibleLocked\}/);
});

test("24 Mandantentrennung: ein Tarif eines anderen Mandanten ist weder buchbar noch änderbar (Server und Datenbank)", async () => {
  const a = await world("sb-iso-a");
  const b = await world("sb-iso-b");
  const pb = await plan(b, "B-PLUS", content(b.groupId, 75000));
  const rb = await currentRev(pb);
  await assert.rejects(() => tariffBooking(a, pb), /Miettarif nicht gefunden/);
  await assert.rejects(() => reviseRatePlan(a.tenantId, OWNER(a), pb, { content: content(b.groupId, 0), expectedRevisionId: rb }), /Miettarif nicht gefunden/);
  assert.ok(!(await vehicleTariffs(a.tenantId, a.vehicleId)).bases.some((x) => x.ratePlanId === pb));
  const snap = readTariffSnapshot((await db.booking.findUniqueOrThrow({ where: { id: a.bookingId } })).tariffSnapshot);
  assert.equal(snap, null);
  // Datenbank: auch ein direkter Schreibversuch mit fremdem Tarif samt Selbstbeteiligung wird abgewiesen
  await assert.rejects(() => db.booking.update({ where: { id: a.bookingId }, data: { ratePlanId: pb, ratePlanRevisionId: rb, tariffSnapshot: { v: 1 }, deductibleCents: 75000 } }), /RB_TENANT/);
  assert.equal((await db.ratePlanRevision.findUniqueOrThrow({ where: { id: rb } })).deductibleCents, 75000, "fremder Tarif unverändert");
});

test("25 bestehende Abläufe: Zeitraumänderung und Speichern ohne Feld behalten die vereinbarte Selbstbeteiligung", async () => {
  const w = await world("sb-flows");
  const p = await plan(w, "PLUS", content(w.groupId, 75000));
  await tariffBooking(w, p, SB(50000, "Firmenkunde"), 6);
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await changeBookingPeriod(w.tenantId, OWNER(w), w.bookingId, { startAt: b.startAt, endAt: new Date(b.endAt!.getTime() + DAY), reason: "Kunde braucht einen Tag länger" });
  const after = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(after.deductibleCents, 50000);
  assert.equal(after.deductibleOverrideReason, "Firmenkunde");
  assert.equal(readTariffSnapshot(after.tariffSnapshot)?.agreed.deductible?.cents, 50000);
  assert.equal(readTariffSnapshot(after.tariffSnapshot)?.deductible?.cents, 75000);
  // Vertrag aus dieser Buchung übernimmt den vereinbarten Wert
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(Number(c.deductible), 500);
});
