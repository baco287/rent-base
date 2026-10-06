// Befehl 29: Miettarife 2.0 – Tarifverwaltung, zentrale Engine, Buchungs-/Vertragssnapshot, Abweichungen, Legacy, Migration,
// Mandantentrennung, Rennen, Rollen. Läuft gegen die lokale Testdatenbank (wie alle Integrationstests).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { roleAllows, type Role } from "../src/lib/constants";
import { calculateRentalPrice, rateCardFrom, totalCentsOf } from "../src/lib/pricing";
import { resolveDeposit } from "../src/lib/business-rules";
import { bookingTariffFor, buildBookingTariff, keepBookingTariff, lockTariffBasis, quoteTariff, readTariffSnapshot, vehicleTariffs, type TariffChoices } from "../src/lib/tariffs";
import { createRatePlan, currentContent, duplicateRatePlan, listRatePlans, reviseRatePlan, setGroupDefaultRatePlan, setRatePlanActive, setVehicleRateOverride, updateRatePlanMeta, type TariffContent } from "../src/lib/tariff-admin";
import { bookingQuote } from "../src/lib/booking-price";
import { recordAudit } from "../src/lib/audit";
import { createWorld, purgeTenants, type World } from "./helpers";
import { pickedUpWorld, returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const DAY = 86_400_000;
const OWNER = (w: World) => ({ id: w.userId, name: "Inhaberin Test" });
const key = () => randomUUID();
const T = (...cents: [number, number, number, number]) => [{ days: 1, cents: cents[0] }, { days: 5, cents: cents[1] }, { days: 7, cents: cents[2] }, { days: 30, cents: cents[3] }];
const FREE = (km: number, rateCents: number) => ({ policy: "FREE_KILOMETERS" as const, kmIncludedPerDay: km, extraKmRateCents: rateCents });
const UNLIMITED = { policy: "UNLIMITED" as const, kmIncludedPerDay: null, extraKmRateCents: null };
const TARIFF: TariffChoices = { price: { mode: "TARIFF" }, km: { mode: "TARIFF" }, deposit: { mode: "TARIFF" } };
const content = (groupId: string, tiers = T(5900, 25900, 32900, 99900), km: TariffContent["km"] = FREE(250, 25), depositCents = 50000): TariffContent => ({ km, depositCents, groups: [{ groupId, tiers, depositCents: null, km: null }] });

async function world(label: string): Promise<World> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.customer.update({ where: { id: w.customerId }, data: { discountPercent: 0 } });
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });
  return w;
}
async function plan(w: World, name: string, c: TariffContent = content(w.groupId), active = true) {
  return (await createRatePlan(w.tenantId, OWNER(w), { meta: { name, code: null, description: null, sortOrder: 0 }, content: c, active, createKey: key() })).id;
}
/** Buchung der Welt auf einen Tarif umstellen (Zeitraum: Start + n Tage) */
async function tariffBooking(w: World, ratePlanId: string, days = 7, choices: TariffChoices = TARIFF, bookingId = w.bookingId) {
  const b = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  const endAt = new Date(b.startAt.getTime() + days * DAY);
  return db.$transaction(async (tx) => {
    const r = await bookingTariffFor(tx, w.tenantId, OWNER(w), { vehicleId: b.vehicleId, ratePlanId, startAt: b.startAt, endAt, discountPercent: 0, choices, previous: readTariffSnapshot(b.tariffSnapshot) });
    await tx.booking.update({ where: { id: bookingId }, data: { ...r.data, endAt } });
    // wie die Buchungsaktionen: Tarif und Abweichungen ins Audit (Verlauf der Buchung)
    for (const a of r.audits) await recordAudit(tx, w.tenantId, OWNER(w), { ...a, bookingId });
    return r;
  });
}
const at = (iso: string) => new Date(iso);

// ---------------------------------------------------------------------------
// Tarifverwaltung
// ---------------------------------------------------------------------------

test("1/2/3 Mandant legt eigene Tarife an – beliebig viele, Namen wie BASIC sind nicht systemweit reserviert", async () => {
  const a = await world("t29-own-a");
  const b = await world("t29-own-b");
  for (const n of ["BASIC", "PLUS", "UNLIMITED", "CITY 100", "LANGZEIT"]) await plan(a, n);
  await plan(b, "BASIC");
  const la = await listRatePlans(a.tenantId);
  assert.deepEqual(la.map((p) => p.name).sort(), ["BASIC", "CITY 100", "LANGZEIT", "PLUS", "UNLIMITED"]);
  assert.equal((await listRatePlans(b.tenantId)).length, 1, "Mandant B hat nur seinen eigenen BASIC");
  // gleicher Name im selben Mandanten (ohne Groß-/Kleinschreibung) wird abgelehnt
  await assert.rejects(() => plan(a, " basic "), /existiert bereits/);
  const rev = await db.ratePlanRevision.findMany({ where: { tenantId: a.tenantId } });
  assert.equal(rev.length, 5);
  assert.ok(rev.every((r) => r.revision === 1));
  assert.ok((await db.auditLog.count({ where: { tenantId: a.tenantId, action: "RATE_PLAN_CREATED" } })) === 5);
});

test("4/48 Mandantentrennung: Tarife, Revisionen, Gruppen und Fahrzeuge eines anderen Mandanten sind nicht nutzbar (Server und DB)", async () => {
  const a = await world("t29-iso-a");
  const b = await world("t29-iso-b");
  const pa = await plan(a, "PLUS");
  const pb = await plan(b, "PLUS");
  assert.ok((await listRatePlans(a.tenantId)).every((p) => p.id !== pb));
  await assert.rejects(() => db.$transaction((tx) => lockTariffBasis(tx, a.tenantId, a.vehicleId, pb)), /Miettarif nicht gefunden/);
  await assert.rejects(() => setVehicleRateOverride(a.tenantId, OWNER(a), { vehicleId: a.vehicleId, ratePlanId: pb, tiers: [{ days: 1, cents: 100 }], depositCents: null, km: null, note: null }), /Miettarif nicht gefunden/);
  await assert.rejects(() => setVehicleRateOverride(a.tenantId, OWNER(a), { vehicleId: b.vehicleId, ratePlanId: pa, tiers: [{ days: 1, cents: 100 }], depositCents: null, km: null, note: null }), /Fahrzeug nicht gefunden/);
  await assert.rejects(() => plan(a, "FREMD", content(b.groupId)), /Fahrzeuggruppe nicht gefunden/);
  await assert.rejects(() => setGroupDefaultRatePlan(a.tenantId, OWNER(a), a.groupId, pb), /Miettarif nicht gefunden/);
  // DB: direkte Verknüpfung über Mandantengrenzen wird abgelehnt
  const revA = (await db.ratePlan.findUniqueOrThrow({ where: { id: pa } })).currentRevisionId!;
  await assert.rejects(() => db.ratePlanGroupPrice.create({ data: { tenantId: a.tenantId, revisionId: revA, groupId: b.groupId, tiers: { create: [{ tenantId: a.tenantId, durationDays: 1, priceCents: 1 }] } } }), /RB_TENANT/);
  await assert.rejects(() => db.vehicleGroup.update({ where: { id: a.groupId }, data: { defaultRatePlanId: pb } }), /RB_TENANT/);
  const revB = (await db.ratePlan.findUniqueOrThrow({ where: { id: pb } })).currentRevisionId!;
  await assert.rejects(() => db.booking.update({ where: { id: a.bookingId }, data: { ratePlanId: pa, ratePlanRevisionId: revB, tariffSnapshot: { v: 1 } } }), /RB_TENANT/);
});

test("5/6 Fahrzeuggruppe mit mehreren Tarifen, Standardtarif vorausgewählt; nur ein aktiver Tarif = automatisch Standard", async () => {
  const w = await world("t29-default");
  const basic = await plan(w, "BASIC", content(w.groupId, T(4900, 21900, 27900, 89900), FREE(100, 35), 50000));
  const plus = await plan(w, "PLUS");
  const unl = await plan(w, "UNLIMITED", content(w.groupId, T(6900, 31900, 44900, 129900), UNLIMITED, 75000));
  let vt = await vehicleTariffs(w.tenantId, w.vehicleId);
  assert.deepEqual(vt.bases.map((b) => b.ratePlanName).sort(), ["BASIC", "PLUS", "UNLIMITED"]);
  assert.equal(vt.defaultRatePlanId, null, "mehrere Tarife ohne Standard → keine Vorauswahl");
  await setGroupDefaultRatePlan(w.tenantId, OWNER(w), w.groupId, plus);
  vt = await vehicleTariffs(w.tenantId, w.vehicleId);
  assert.equal(vt.defaultRatePlanId, plus);
  // Deaktivieren hebt den Standard auf (protokolliert), ein Standard muss aktiv und zugeordnet sein
  await setRatePlanActive(w.tenantId, OWNER(w), plus, false);
  assert.equal((await db.vehicleGroup.findUniqueOrThrow({ where: { id: w.groupId } })).defaultRatePlanId, null);
  await assert.rejects(() => setGroupDefaultRatePlan(w.tenantId, OWNER(w), w.groupId, plus), /deaktivierter Tarif/);
  await assert.rejects(() => db.vehicleGroup.update({ where: { id: w.groupId }, data: { defaultRatePlanId: plus } }), /RB_DOMAIN/);
  await setRatePlanActive(w.tenantId, OWNER(w), unl, false);
  vt = await vehicleTariffs(w.tenantId, w.vehicleId);
  assert.equal(vt.bases.length, 1);
  assert.equal(vt.defaultRatePlanId, basic, "nur ein aktiver Tarif → automatisch vorausgewählt");
});

// ---------------------------------------------------------------------------
// Preisengine
// ---------------------------------------------------------------------------

test("7–11 Preisstufen 1/5/7/30 Tage und günstigste Kombination (9 Tage = 7 Tage + 2 × Tag = 447 €)", async () => {
  const w = await world("t29-tiers");
  await plan(w, "PLUS");
  const [basis] = (await vehicleTariffs(w.tenantId, w.vehicleId)).bases;
  const s = at("2026-11-02T08:00:00Z");
  const price = (days: number, hours = 0) => quoteTariff(basis, s, new Date(s.getTime() + days * DAY + hours * 3_600_000)).regularCents;
  assert.equal(price(1), 5900);
  assert.equal(price(5), 25900);
  assert.equal(price(7), 32900);
  assert.equal(price(30), 99900);
  assert.equal(price(9), 44700);
  assert.equal(price(6), 25900 + 5900, "6 Tage: 5 Tage + Tag (318 €) statt 7 Tage (329 €)");
  assert.equal(price(1, 1), 2 * 5900, "angefangener Tag zählt voll");
  // unabhängige Vergleichsrechnung: für 1..60 Tage nie teurer als jede andere gültige Kombination
  const tiers = basis.tiers;
  for (let d = 1; d <= 60; d++) {
    const best: number[] = [0];
    for (let n = 1; n <= d; n++) best[n] = Math.min(...tiers.map((t) => t.cents + best[Math.max(0, n - t.days)]));
    assert.equal(price(d), best[d], `${d} Tage`);
  }
});

test("12/13 Zeitumstellung: Sa 10:00 – Mo 10:00 sind im Frühjahr (47 h) und Herbst (49 h) genau 2 Miettage", async () => {
  const w = await world("t29-dst");
  await plan(w, "PLUS");
  const [basis] = (await vehicleTariffs(w.tenantId, w.vehicleId)).bases;
  const spring = quoteTariff(basis, at("2026-03-28T09:00:00Z"), at("2026-03-30T08:00:00Z"));
  const autumn = quoteTariff(basis, at("2026-10-24T08:00:00Z"), at("2026-10-26T09:00:00Z"));
  assert.equal(spring.days, 2);
  assert.equal(autumn.days, 2);
  assert.equal(spring.regularCents, 11800);
  assert.equal(autumn.regularCents, 11800);
  assert.equal(quoteTariff(basis, at("2026-10-24T08:00:00Z"), at("2026-10-26T09:01:00Z")).days, 3, "eine Minute über Mo 10:00 beginnt einen neuen Tag");
});

test("14–18 Kilometerregel je Tarif (100/250 km je Tag, unbegrenzt) und Kaution aus dem Tarif", async () => {
  const w = await world("t29-km");
  await plan(w, "BASIC", content(w.groupId, T(4900, 21900, 27900, 89900), FREE(100, 35), 50000));
  await plan(w, "PLUS", content(w.groupId, T(5900, 25900, 32900, 99900), FREE(250, 25), 50000));
  await plan(w, "UNLIMITED", content(w.groupId, T(6900, 31900, 44900, 129900), UNLIMITED, 75000));
  const s = at("2026-11-02T08:00:00Z");
  const e = new Date(s.getTime() + 7 * DAY);
  const q = Object.fromEntries((await vehicleTariffs(w.tenantId, w.vehicleId)).bases.map((b) => [b.ratePlanName, quoteTariff(b, s, e)]));
  assert.equal(q.BASIC.includedKm, 700);
  assert.equal(q.PLUS.includedKm, 1750);
  assert.equal(q.UNLIMITED.includedKm, null);
  assert.equal(q.BASIC.basis.km.extraKmRateCents, 35);
  assert.equal(q.UNLIMITED.basis.km.extraKmRateCents, null);
  assert.equal(q.UNLIMITED.basis.depositCents, 75000);
  assert.equal(q.PLUS.basis.depositCents, 50000);
  // UNLIMITED mit Mehrkilometerpreis ist widersprüchlich – Server und DB lehnen ab
  // Server bereinigt: bei „unbegrenzt“ werden mitgesendete Kilometerwerte verworfen (kein Mehrkilometerpreis gespeichert)
  const clean = await plan(w, "UNBEGRENZT 2", content(w.groupId, T(1, 1, 1, 1), { policy: "UNLIMITED", kmIncludedPerDay: 100, extraKmRateCents: 25 } as never));
  const rev = await db.ratePlanRevision.findFirstOrThrow({ where: { ratePlanId: clean } });
  assert.equal(rev.extraKmRateCents, null);
  assert.equal(rev.kmIncludedPerDay, null);
  const anyPlan = (await db.ratePlan.findFirstOrThrow({ where: { tenantId: w.tenantId } })).id;
  await assert.rejects(() => db.ratePlanRevision.create({ data: { tenantId: w.tenantId, ratePlanId: anyPlan, revision: 9, kmPolicy: "UNLIMITED", kmIncludedPerDay: null, extraKmRateCents: 25, depositCents: 0 } }), /rb_rateplan_revision_km/);
});

test("19/20 Fahrzeugpreis: nur abweichende Stufe gespeichert, übrige aus der Gruppe; Fahrzeug ohne Abweichung nutzt die Gruppe", async () => {
  const w = await world("t29-veh");
  const p = await plan(w, "PLUS");
  const other = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-V ${Date.now().toString(36).slice(-4)}`, make: "Mercedes", model: "S-Klasse", groupId: w.groupId, fuel: "BENZIN", mileage: 10_000 } });
  const r = await setVehicleRateOverride(w.tenantId, OWNER(w), { vehicleId: other.id, ratePlanId: p, tiers: [{ days: 1, cents: 17900 }], depositCents: null, km: null, note: "S-Klasse" });
  assert.equal(r.changed, true);
  assert.equal((await setVehicleRateOverride(w.tenantId, OWNER(w), { vehicleId: other.id, ratePlanId: p, tiers: [{ days: 1, cents: 17900 }], depositCents: null, km: null, note: "S-Klasse" })).changed, false, "gleiche Abweichung: keine Änderung, kein Audit");
  assert.equal(await db.vehicleRateOverrideTier.count({ where: { tenantId: w.tenantId } }), 1, "nur die abweichende Stufe ist gespeichert");
  const s = at("2026-11-02T08:00:00Z");
  const [sk] = (await vehicleTariffs(w.tenantId, other.id)).bases;
  const [std] = (await vehicleTariffs(w.tenantId, w.vehicleId)).bases;
  assert.equal(quoteTariff(sk, s, new Date(s.getTime() + DAY)).regularCents, 17900);
  assert.equal(quoteTariff(sk, s, new Date(s.getTime() + 7 * DAY)).regularCents, 32900, "7 Tage weiterhin aus der Gruppe");
  assert.deepEqual(sk.vehicleTierDays, [1]);
  assert.equal(quoteTariff(std, s, new Date(s.getTime() + DAY)).regularCents, 5900);
  assert.deepEqual(std.vehicleTierDays, []);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "VEHICLE_RATE_OVERRIDE_SET" } }), 1);
  // Stufe für dieses Fahrzeug nicht anbieten (null)
  await setVehicleRateOverride(w.tenantId, OWNER(w), { vehicleId: other.id, ratePlanId: p, tiers: [{ days: 1, cents: 17900 }, { days: 5, cents: null }], depositCents: 90000, km: null, note: null });
  const [sk2] = (await vehicleTariffs(w.tenantId, other.id)).bases;
  assert.deepEqual(sk2.tiers.map((t) => t.days), [1, 7, 30]);
  assert.equal(sk2.depositCents, 90000);
  assert.equal(sk2.depositSource, "VEHICLE");
});

// ---------------------------------------------------------------------------
// Abweichungen je Buchung (Snapshot)
// ---------------------------------------------------------------------------

test("21–24 individueller Buchungspreis niedriger, höher und 0 € – Tarifpreis bleibt erhalten; Pflichtgrund", async () => {
  const w = await world("t29-price");
  const p = await plan(w, "PLUS");
  const [basis] = (await vehicleTariffs(w.tenantId, w.vehicleId)).bases;
  const s = at("2026-11-02T08:00:00Z");
  const e = new Date(s.getTime() + 7 * DAY);
  const actor = OWNER(w);
  for (const cents of [25000, 40000, 0]) {
    const r = buildBookingTariff({ basis, start: s, end: e, discountPercent: 0, choices: { ...TARIFF, price: { mode: "INDIVIDUAL", cents, reason: "Sondervereinbarung Test" } }, previous: null, actor });
    assert.equal(r.data.regularPriceCents, 32900);
    assert.equal(r.data.agreedPriceCents, cents);
    assert.equal(r.snapshot.agreed.price?.regularCents, 32900);
    assert.equal(r.snapshot.agreed.price?.byName, actor.name);
    const audit = r.audits.find((a) => a.action === "BOOKING_PRICE_OVERRIDDEN")!;
    assert.equal((audit.details as Record<string, unknown>).differenceCents, cents - 32900);
  }
  assert.throws(() => buildBookingTariff({ basis, start: s, end: e, discountPercent: 0, choices: { ...TARIFF, price: { mode: "INDIVIDUAL", cents: 0, reason: " " } }, previous: null, actor }), /Grund/);
  assert.throws(() => buildBookingTariff({ basis, start: s, end: e, discountPercent: 0, choices: { ...TARIFF, price: { mode: "INDIVIDUAL", cents: -1, reason: "negativ" } }, previous: null, actor }), /ab 0,00/);
  // DB: Sonderpreis ohne Grund ist unmöglich, 0 € ist zulässig
  await tariffBooking(w, p, 7, { ...TARIFF, price: { mode: "INDIVIDUAL", cents: 0, reason: "Privatvermietung" } });
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.agreedPriceCents, 0);
  assert.equal(b.regularPriceCents, 32900);
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { priceOverrideReason: null } }), /rb_booking_agreed_price/);
  assert.equal(bookingQuote(b, b.startAt, b.endAt!, 0).totalCents, 0);
  assert.equal(bookingQuote(b, b.startAt, b.endAt!, 0).regularCents, 32900);
});

test("25–27 individuelle Kilometer (200 km/Tag, unbegrenzt) und individuelle Kaution 0 € – mit Grund, Tarifwert bleibt im Snapshot", async () => {
  const w = await world("t29-km-dep");
  const p = await plan(w, "BASIC", content(w.groupId, T(4900, 21900, 27900, 89900), FREE(100, 35), 50000));
  await tariffBooking(w, p, 7, { price: { mode: "TARIFF" }, km: { mode: "INDIVIDUAL", policy: "FREE_KILOMETERS", kmIncludedPerDay: 200, extraKmRateCents: 35, reason: "Stammkunde Langstrecke" }, deposit: { mode: "INDIVIDUAL", cents: 0, reason: "Sondervereinbarung" } });
  let b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  let snap = readTariffSnapshot(b.tariffSnapshot)!;
  assert.equal(b.kmIncludedPerDay, 200);
  assert.equal(b.kmPolicy, "FREE_KILOMETERS");
  assert.equal(snap.km.kmIncludedPerDay, 100, "Tarifwert bleibt erhalten");
  assert.equal(snap.agreed.km?.reason, "Stammkunde Langstrecke");
  assert.equal(Number(b.deposit), 0);
  assert.equal(snap.deposit.cents, 50000);
  assert.equal(b.depositOverrideReason, "Sondervereinbarung");
  // unbegrenzt
  const r = keepBookingTariff(snap, { startAt: b.startAt, endAt: b.endAt!, discountPercent: 0, actor: OWNER(w), choices: { price: { mode: "TARIFF" }, km: { mode: "INDIVIDUAL", ...{ policy: "UNLIMITED", kmIncludedPerDay: null, extraKmRateCents: null }, reason: "Urlaubsfahrt vereinbart" }, deposit: { mode: "TARIFF" } } });
  await db.booking.update({ where: { id: w.bookingId }, data: r.data });
  b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  snap = readTariffSnapshot(b.tariffSnapshot)!;
  assert.equal(b.kmPolicy, "UNLIMITED");
  assert.equal(b.kmIncludedPerDay, 0);
  assert.equal(Number(b.deposit), 500, "Kaution zurück auf Tarif");
  assert.ok(r.audits.some((a) => a.action === "BOOKING_KM_OVERRIDDEN"));
  assert.ok(r.audits.some((a) => a.action === "BOOKING_DEPOSIT_OVERRIDDEN"));
  assert.ok(!r.audits.some((a) => a.action === "BOOKING_TARIFF_CHANGED"), "Tarif selbst unverändert");
});

// ---------------------------------------------------------------------------
// Revisionen, Idempotenz, Historie
// ---------------------------------------------------------------------------

test("30 Revisionen: Änderung erzeugt neue Revision (alte bleibt unverändert), gleicher Inhalt keine; veralteter Editor überschreibt nichts", async () => {
  const w = await world("t29-rev");
  const p = await plan(w, "PLUS");
  const r1 = (await db.ratePlan.findUniqueOrThrow({ where: { id: p } })).currentRevisionId!;
  // Buchung auf Revision 1
  await tariffBooking(w, p, 7);
  const same = await reviseRatePlan(w.tenantId, OWNER(w), p, { content: content(w.groupId), expectedRevisionId: r1 });
  assert.equal(same.created, false, "Doppelklick / unveränderter Inhalt: keine Revision");
  const up = await reviseRatePlan(w.tenantId, OWNER(w), p, { content: content(w.groupId, T(6900, 29900, 37900, 109900), FREE(200, 30), 75000), expectedRevisionId: r1 });
  assert.equal(up.revision, 2);
  await assert.rejects(() => reviseRatePlan(w.tenantId, OWNER(w), p, { content: content(w.groupId, T(1, 1, 1, 1)), expectedRevisionId: r1 }), /inzwischen geändert/);
  // alte Revision unverändert, unveränderlich
  assert.equal((await currentContent(db, w.tenantId, r1))!.groups[0].tiers[2].cents, 32900);
  await assert.rejects(() => db.ratePlanRevision.update({ where: { id: r1 }, data: { depositCents: 1 } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.ratePlanPriceTier.updateMany({ where: { tenantId: w.tenantId }, data: { priceCents: 1 } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.ratePlan.delete({ where: { id: p } }), /RB_IMMUTABLE/);
  // Buchung behält Revision 1 + Snapshot; eine neue Buchung bekommt Revision 2
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.ratePlanRevisionId, r1);
  assert.equal(bookingQuote(b, b.startAt, b.endAt!, 0).regularCents, 32900);
  const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-R ${Date.now().toString(36).slice(-4)}`, make: "VW", model: "Golf", groupId: w.groupId, fuel: "BENZIN", mileage: 1 } });
  const nb = await db.booking.create({ data: { tenantId: w.tenantId, number: `T29-${Date.now()}`, vehicleId: v2.id, customerId: w.customerId, startAt: b.startAt, endAt: b.endAt, dailyRate: 0, deposit: 0 } });
  await tariffBooking(w, p, 7, TARIFF, nb.id);
  const nb2 = await db.booking.findUniqueOrThrow({ where: { id: nb.id } });
  assert.equal(readTariffSnapshot(nb2.tariffSnapshot)!.revision, 2);
  assert.equal(nb2.regularPriceCents, 37900);
  assert.equal(Number(nb2.deposit), 750);
  // Stammdaten ändern erzeugt keine Revision; Name eindeutig
  assert.equal((await updateRatePlanMeta(w.tenantId, OWNER(w), p, { name: "PLUS", code: "P", description: "neu", sortOrder: 1 })).changed, true);
  assert.equal((await db.ratePlan.findUniqueOrThrow({ where: { id: p } })).currentRevisionId, (await db.ratePlanRevision.findFirstOrThrow({ where: { ratePlanId: p, revision: 2 } })).id);
});

test("33 Idempotenz: doppeltes Anlegen mit gleichem Schlüssel legt einen Tarif an; Duplizieren ist inaktiv und unabhängig", async () => {
  const w = await world("t29-idem");
  const k = key();
  const meta = { name: "STANDARD 300", code: null, description: null, sortOrder: 0 };
  const [x, y] = await Promise.all([createRatePlan(w.tenantId, OWNER(w), { meta, content: content(w.groupId), active: true, createKey: k }), createRatePlan(w.tenantId, OWNER(w), { meta, content: content(w.groupId), active: true, createKey: k })]);
  assert.equal(x.id, y.id);
  assert.equal(await db.ratePlan.count({ where: { tenantId: w.tenantId } }), 1);
  const d = await duplicateRatePlan(w.tenantId, OWNER(w), x.id, { name: "STANDARD 300 (Kopie)", createKey: key() });
  const copy = await db.ratePlan.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(copy.active, false);
  assert.notEqual(copy.currentRevisionId, (await db.ratePlan.findUniqueOrThrow({ where: { id: x.id } })).currentRevisionId);
});

// ---------------------------------------------------------------------------
// Rennen
// ---------------------------------------------------------------------------

test("43 Rennen: Tarifänderung während der Buchung – die Buchung bekommt genau eine konsistente Revision (nie gemischt) oder eine klare Ablehnung", async () => {
  for (let i = 0; i < 3; i++) {
    const w = await world(`t29-race-${i}`);
    const p = await plan(w, "PLUS");
    const r1 = (await db.ratePlan.findUniqueOrThrow({ where: { id: p } })).currentRevisionId!;
    const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
    const book = db.$transaction(async (tx) => {
      const r = await bookingTariffFor(tx, w.tenantId, OWNER(w), { vehicleId: w.vehicleId, ratePlanId: p, startAt: b.startAt, endAt: new Date(b.startAt.getTime() + 7 * DAY), discountPercent: 0, choices: TARIFF, previous: null, seenRevisionId: r1, seenRegularCents: 32900 });
      await tx.booking.update({ where: { id: w.bookingId }, data: { ...r.data, endAt: new Date(b.startAt.getTime() + 7 * DAY) } });
      return r;
    });
    const revise = reviseRatePlan(w.tenantId, OWNER(w), p, { content: content(w.groupId, T(9900, 39900, 49900, 149900)), expectedRevisionId: r1 });
    const [bk, rv] = await Promise.allSettled([book, revise]);
    assert.equal(rv.status, "fulfilled");
    const saved = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
    if (bk.status === "fulfilled") {
      // Buchung lief vor der Revision: Revision 1 mit ihren Stufen
      const snap = readTariffSnapshot(saved.tariffSnapshot)!;
      assert.equal(saved.ratePlanRevisionId, r1);
      assert.equal(snap.revisionId, r1);
      assert.deepEqual(snap.tiers.map((t) => t.cents), [5900, 25900, 32900, 99900]);
    } else {
      assert.match(String((bk.reason as Error).message), /gerade geändert|Tarifpreis hat sich geändert/);
      assert.equal(saved.ratePlanId, null, "abgelehnt: nichts gespeichert");
    }
  }
});

test("44 Rennen: zwei Standardtarife gleichzeitig – die Gruppe hat danach genau einen gültigen Standard", async () => {
  const w = await world("t29-race-default");
  const a = await plan(w, "A");
  const b = await plan(w, "B");
  await Promise.allSettled([setGroupDefaultRatePlan(w.tenantId, OWNER(w), w.groupId, a), setGroupDefaultRatePlan(w.tenantId, OWNER(w), w.groupId, b)]);
  const g = await db.vehicleGroup.findUniqueOrThrow({ where: { id: w.groupId } });
  assert.ok(g.defaultRatePlanId === a || g.defaultRatePlanId === b);
  // Deaktivieren und Standard setzen gleichzeitig: nie ein deaktivierter Standard
  const c = await plan(w, "C");
  await Promise.allSettled([setRatePlanActive(w.tenantId, OWNER(w), c, false), setGroupDefaultRatePlan(w.tenantId, OWNER(w), w.groupId, c)]);
  const g2 = await db.vehicleGroup.findUniqueOrThrow({ where: { id: w.groupId }, include: { defaultRatePlan: true } });
  assert.ok(!g2.defaultRatePlan || g2.defaultRatePlan.active, "Standard ist immer aktiv");
});

// ---------------------------------------------------------------------------
// Migration der Altpreise (SQL der Migration, beschränkt auf einen Testmandanten)
// ---------------------------------------------------------------------------

test("41 Migration: bisherige Gruppen-/Fahrzeugpreise, Kilometer und Kaution werden exakt als Tarif „Standard“ übernommen", async () => {
  const w = await world("t29-mig");
  // zweite Gruppe mit anderen Preisen/km/Kaution; Fahrzeuge: wie Gruppe, abweichender Tag + ohne 5-Tage-Stufe, abweichende Kaution/km
  await db.vehicleGroup.update({ where: { id: w.groupId }, data: { dailyRate: 89, workWeekRate: 420, weeklyRate: 540, monthlyRate: null, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 500 } });
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { dailyRate: 89, workWeekRate: 420, weeklyRate: 540, monthlyRate: null, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 500 } });
  const g2 = await db.vehicleGroup.create({ data: { tenantId: w.tenantId, name: "Kompakt", dailyRate: 45.5, workWeekRate: 190, weeklyRate: 290, monthlyRate: 1200, kmIncludedPerDay: 150, extraKmRate: 0.3, deposit: 0 } });
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { depositCents: 30000 } } });
  const mk = (plate: string, data: Record<string, unknown>) => db.vehicle.create({ data: { tenantId: w.tenantId, plate, make: "VW", model: "Polo", fuel: "BENZIN", mileage: 1, groupId: g2.id, ...data } as never });
  const same = await mk(`HB-M1 ${Date.now() % 10000}`, { dailyRate: 45.5, workWeekRate: 190, weeklyRate: 290, monthlyRate: 1200, kmIncludedPerDay: 150, extraKmRate: 0.3, deposit: 0 });
  const diff = await mk(`HB-M2 ${Date.now() % 10000}`, { dailyRate: 49.99, workWeekRate: null, weeklyRate: 290, monthlyRate: 1200, kmIncludedPerDay: 150, extraKmRate: 0.3, deposit: 0 });
  const dep = await mk(`HB-M3 ${Date.now() % 10000}`, { dailyRate: 45.5, workWeekRate: 190, weeklyRate: 290, monthlyRate: 1200, kmIncludedPerDay: 300, extraKmRate: 0.2, deposit: 800 });
  // SQL der Migration (nur der Übernahmeblock), auf diesen Mandanten beschränkt
  const sql = readFileSync("prisma/migrations/20261022090000_miettarife/migration.sql", "utf8");
  const block = sql.slice(sql.indexOf("DO $$"), sql.lastIndexOf("END $$;") + "END $$;".length).replace('ORDER BY t."id" LOOP', `AND t."id" = '${w.tenantId}' ORDER BY t."id" LOOP`);
  assert.ok(block.includes(w.tenantId));
  await db.$executeRawUnsafe(block);
  const plans = await listRatePlans(w.tenantId);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].name, "Standard");
  assert.equal(plans[0].active, true);
  assert.deepEqual(plans[0].defaultFor.sort(), ["Kompakt", "Transporter"]);
  // Vergleich alt (Fahrzeugpreise, Kautionskette, km) gegen neu (Tarifengine) – für 1..45 Tage exakt gleich
  const tenantRules = (await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } })).businessRules;
  const s = at("2026-11-02T08:00:00Z");
  for (const v of [await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId }, include: { group: true } }), ...(await db.vehicle.findMany({ where: { id: { in: [same.id, diff.id, dep.id] } }, include: { group: true } }))]) {
    const [basis] = (await vehicleTariffs(w.tenantId, v.id)).bases;
    assert.ok(basis, v.plate);
    for (let d = 1; d <= 45; d++) {
      const e = new Date(s.getTime() + d * DAY);
      assert.equal(quoteTariff(basis, s, e).regularCents, totalCentsOf(calculateRentalPrice({ start: s, end: e, rates: rateCardFrom(v) })), `${v.plate} ${d} Tage`);
    }
    assert.equal(basis.depositCents, resolveDeposit(tenantRules, v.group, v).cents, `${v.plate} Kaution`);
    assert.equal(basis.km.kmIncludedPerDay, v.kmIncludedPerDay, `${v.plate} km`);
    assert.equal(basis.km.extraKmRateCents, Math.round(Number(v.extraKmRate) * 100), `${v.plate} Mehrkilometer`);
  }
  assert.equal(await db.vehicleRateOverride.count({ where: { tenantId: w.tenantId } }), 2, "nur abweichende Fahrzeuge bekommen eine Abweichung");
});

// ---------------------------------------------------------------------------
// Rollen, Supportmodus, Plattform-Admin (serverseitig)
// ---------------------------------------------------------------------------

test("45/46/47 Rollen: Tarifverwaltung nur Inhaber, Abweichungen je Buchung Inhaber/Disposition, Hof nichts; Support/Plattform nur lesend", () => {
  const actions = readFileSync("src/app/(app)/einstellungen/tarife/actions.ts", "utf8");
  const fns = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  assert.ok(fns.length >= 5, fns.join(","));
  for (const fn of fns) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 600), /requireRole\("OWNER"\)/, `${fn} prüft OWNER`);
  }
  const bookingActions = readFileSync("src/app/(app)/buchungen/actions.ts", "utf8");
  for (const fn of ["createBookingAction", "updateBookingAction", "quoteTariffsAction"]) assert.match(bookingActions.slice(bookingActions.indexOf(`export async function ${fn}`)).slice(0, 400), /requireRole\("DISPO"\)/, fn);
  const r = (role: Role, need: Role) => roleAllows(role, [need]);
  assert.equal(r("OWNER", "OWNER"), true);
  assert.equal(r("DISPO", "OWNER"), false);
  assert.equal(r("DISPO", "DISPO"), true);
  assert.equal(r("YARD", "DISPO"), false);
  // requireRole: eine Supportsitzung ist immer read-only (Weiterleitung), unabhängig von der Rolle
  const auth = readFileSync("src/lib/auth.ts", "utf8");
  assert.match(auth, /export async function requireRole[\s\S]{0,200}if \(session\.supportSession\) redirect/);
  // Plattform-Admin-Bereich greift nicht schreibend auf Mandantentarife zu
  const admin = readFileSync("src/app/admin/layout.tsx", "utf8");
  assert.ok(!/tariff-admin/.test(admin));
});

// ---------------------------------------------------------------------------
// Abläufe: Vertrag, Zeitraum, Nachtrag, Rückgabe, Rechnung, Altbestand
// ---------------------------------------------------------------------------

/** Laufende Miete auf einem Tarif (Vertrag unterschrieben, Übergabe erfolgt). */
async function tariffRental(label: string, c: (w: World) => TariffContent = (w) => content(w.groupId), choices: TariffChoices = TARIFF, days = 7) {
  let planId = "";
  const w = await pickedUpWorld(label, {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.customer.update({ where: { id: x.customerId }, data: { discountPercent: 0 } });
      planId = await plan(x, "PLUS", c(x));
      await tariffBooking(x, planId, days, choices);
    },
  });
  return { w, planId };
}
const contractRow = (id: string) => db.rentalContract.findUniqueOrThrow({ where: { id } });

test("28/29/42 unterschriebener Vertrag: Tarifänderung und Deaktivierung verändern ihn nicht (Preis, Snapshot, Prüfsumme)", async () => {
  const { w, planId } = await tariffRental("t29-contract");
  const c0 = await contractRow(w.contractId);
  const snap = c0.priceSnapshot as { version: number; tariff?: { ratePlanName: string; revision: number; regularCents: number } };
  assert.equal(snap.version, 2);
  assert.equal(snap.tariff?.ratePlanName, "PLUS");
  assert.equal(snap.tariff?.regularCents, 32900);
  assert.equal(Number(c0.totalAmount), 329);
  assert.equal(Number(c0.deposit), 500);
  assert.equal(c0.kmIncludedPerDay, 250);
  const r1 = (await db.ratePlan.findUniqueOrThrow({ where: { id: planId } })).currentRevisionId!;
  await reviseRatePlan(w.tenantId, OWNER(w), planId, { content: content(w.groupId, T(6900, 29900, 37900, 109900), FREE(200, 30), 75000), expectedRevisionId: r1 });
  await setRatePlanActive(w.tenantId, OWNER(w), planId, false);
  const c1 = await contractRow(w.contractId);
  assert.deepEqual(c1.priceSnapshot, c0.priceSnapshot);
  assert.equal(String(c1.totalAmount), String(c0.totalAmount));
  assert.equal(c1.contentHash, c0.contentHash);
  assert.equal(String(c1.deposit), String(c0.deposit));
  assert.equal(c1.kmIncludedPerDay, 250);
  // 42: der Übernahmeblock der Migration fasst einen Mandanten mit Tarifen und Verträgen nicht an
  const sql = readFileSync("prisma/migrations/20261022090000_miettarife/migration.sql", "utf8");
  const block = sql.slice(sql.indexOf("DO $$"), sql.lastIndexOf("END $$;") + "END $$;".length).replace('ORDER BY t."id" LOOP', `AND t."id" = '${w.tenantId}' ORDER BY t."id" LOOP`);
  const before = await db.ratePlan.count({ where: { tenantId: w.tenantId } });
  await db.$executeRawUnsafe(block);
  assert.equal(await db.ratePlan.count({ where: { tenantId: w.tenantId } }), before, "Mandant hat bereits Tarife → keine Übernahme");
  const c2 = await contractRow(w.contractId);
  assert.deepEqual(c2.priceSnapshot, c0.priceSnapshot);
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.regularPriceCents, 32900);
});

test("Vertragsdokument zeigt Tarifname und vereinbarte Werte – keine IDs, keine internen Gründe", async () => {
  const { w } = await tariffRental("t29-view", (x) => content(x.groupId, T(6900, 31900, 44900, 129900), UNLIMITED, 75000), { ...TARIFF, price: { mode: "INDIVIDUAL", cents: 30000, reason: "interner Grund XYZ" } });
  const { loadContractDocumentData } = await import("../src/lib/document-data");
  const data = await loadContractDocumentData(w.tenantId, w.contractId);
  const text = JSON.stringify(data);
  assert.match(text, /PLUS/);
  assert.match(text, /unbegrenzt/i);
  assert.ok(!text.includes("interner Grund XYZ"), "Grund des Sonderpreises erscheint nicht im Kundendokument");
  const c = await contractRow(w.contractId);
  const snap = c.priceSnapshot as { tariff: { ratePlanId: string; revisionId: string } };
  assert.ok(!text.includes(snap.tariff.ratePlanId), "keine Tarif-ID");
  assert.ok(!text.includes(snap.tariff.revisionId), "keine Revisions-ID");
});

test("31/32 Zeitraum ändern: rechnet mit den eingefrorenen Tarifstufen; ein individueller Preis wird nie still überschrieben", async () => {
  const w = await world("t29-period");
  const p = await plan(w, "PLUS");
  await tariffBooking(w, p, 3);
  let b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.regularPriceCents, 3 * 5900);
  // Tarif inzwischen teurer – die Buchung rechnet weiter mit ihrem Snapshot
  await reviseRatePlan(w.tenantId, OWNER(w), p, { content: content(w.groupId, T(9900, 39900, 49900, 149900)), expectedRevisionId: b.ratePlanRevisionId! });
  const { changeBookingPeriod, previewBookingPeriodChange } = await import("../src/lib/booking-period");
  const to7 = new Date(b.startAt.getTime() + 7 * DAY);
  const pv = await previewBookingPeriodChange(w.tenantId, w.bookingId, b.startAt, to7);
  assert.equal(pv.after?.priceCents, 32900);
  await changeBookingPeriod(w.tenantId, OWNER(w), w.bookingId, { startAt: b.startAt, endAt: to7, reason: "Kunde verlängert vorab" });
  b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.regularPriceCents, 32900, "Preis aus Revision 1, nicht aus der neuen Revision");
  // individueller Preis → Entscheidung Pflicht
  const kept = keepBookingTariff(readTariffSnapshot(b.tariffSnapshot)!, { startAt: b.startAt, endAt: b.endAt!, discountPercent: 0, actor: OWNER(w), choices: { ...TARIFF, price: { mode: "INDIVIDUAL", cents: 15000, reason: "Sonderpreis Test" } } });
  await db.booking.update({ where: { id: w.bookingId }, data: kept.data });
  const to9 = new Date(b.startAt.getTime() + 9 * DAY);
  const pv2 = await previewBookingPeriodChange(w.tenantId, w.bookingId, b.startAt, to9);
  assert.equal(pv2.agreed?.cents, 15000);
  assert.equal(pv2.after?.priceCents, 44700);
  await assert.rejects(() => changeBookingPeriod(w.tenantId, OWNER(w), w.bookingId, { startAt: b.startAt, endAt: to9, reason: "länger" }), /individueller Preis/);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).endAt!.getTime(), to7.getTime(), "abgelehnt: nichts geändert");
  await changeBookingPeriod(w.tenantId, OWNER(w), w.bookingId, { startAt: b.startAt, endAt: to9, reason: "länger", priceDecision: { mode: "KEEP" } });
  b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.agreedPriceCents, 15000);
  assert.equal(b.regularPriceCents, 44700);
  await changeBookingPeriod(w.tenantId, OWNER(w), w.bookingId, { startAt: b.startAt, endAt: to7, reason: "doch kürzer", priceDecision: { mode: "TARIFF" } });
  b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.agreedPriceCents, null);
  assert.equal(b.regularPriceCents, 32900);
  const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, action: "BOOKING_PERIOD_CHANGED" }, orderBy: { createdAt: "desc" } });
  assert.equal((audit.details as Record<string, unknown>).priceDecision, "TARIFF");
  await changeBookingPeriod(w.tenantId, OWNER(w), w.bookingId, { startAt: b.startAt, endAt: to9, reason: "neuer Sonderpreis", priceDecision: { mode: "INDIVIDUAL", cents: 40000, reason: "Neu verhandelt" } });
  b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.agreedPriceCents, 40000);
  assert.equal(b.priceOverrideReason, "Neu verhandelt");
});

test("33/34/35 Verlängerung aus dem eingefrorenen Vertragstarif (nicht aus der aktuellen Revision); Verkürzung senkt den Preis nicht automatisch", async () => {
  const { w, planId } = await tariffRental("t29-ext");
  const r1 = (await db.ratePlan.findUniqueOrThrow({ where: { id: planId } })).currentRevisionId!;
  await reviseRatePlan(w.tenantId, OWNER(w), planId, { content: content(w.groupId, T(6900, 29900, 37900, 109900)), expectedRevisionId: r1 });
  const { createAmendmentDraft, updateAmendmentDraft, effectiveContractState } = await import("../src/lib/amendments");
  const c = await contractRow(w.contractId);
  const a = (await createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: key() })).amendment;
  const ext = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: new Date(c.endAt!.getTime() + 2 * DAY) });
  assert.equal(ext.priceProposalCents, 44700 - 32900, "9 Tage alt (447 €) − 7 Tage alt (329 €) = +118 €");
  const short = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: new Date(c.endAt!.getTime() - 2 * DAY) });
  assert.equal(short.priceProposalCents, 25900 - 32900, "Vorschlag −70 €");
  assert.equal(short.priceDeltaCents ?? null, null, "keine automatische Minderung");
  assert.equal((await effectiveContractState(w.tenantId, w.contractId)).totalCents, 32900);
});

test("36/37 Rückgabe: eingefrorene Kilometerregel des Vertrags (auch nach Tarifänderung); unbegrenzt ergibt 0 Mehrkilometer", async () => {
  const { startHandover, updateHandoverDraft } = await import("../src/lib/handovers");
  const { getReturnComparison } = await import("../src/lib/returns");
  const { w, planId } = await tariffRental("t29-km-return");
  const r1 = (await db.ratePlan.findUniqueOrThrow({ where: { id: planId } })).currentRevisionId!;
  await reviseRatePlan(w.tenantId, OWNER(w), planId, { content: content(w.groupId, T(5900, 25900, 32900, 99900), FREE(100, 50)), expectedRevisionId: r1 });
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 45_210 + 3_100, fuelLevelEighths: 7 });
  const cmp = await getReturnComparison(w.tenantId, r.id);
  const prop = cmp.proposals.find((x) => x.key === "EXTRA_MILEAGE");
  assert.ok(prop, JSON.stringify(cmp.proposals.map((x) => x.key)));
  assert.equal(Math.round(Number(prop!.draft.amount) * 100), (3_100 - 7 * 250) * 25, "250 km/Tag und 0,25 €/km aus dem Vertrag, nicht 100 km und 0,50 € aus Revision 2");

  const u = await tariffRental("t29-km-unl", (x) => content(x.groupId, T(6900, 31900, 44900, 129900), UNLIMITED, 75000));
  const c = await contractRow(u.w.contractId);
  assert.equal(Number(c.deposit), 750);
  const r2 = await startHandover(u.w.tenantId, u.w.bookingId, "RETURN", u.w.actor);
  await updateHandoverDraft(u.w.tenantId, r2.id, { mileage: 45_210 + 9_999, fuelLevelEighths: 7 });
  const cmp2 = await getReturnComparison(u.w.tenantId, r2.id);
  assert.equal(cmp2.contract.kmPolicy, "UNLIMITED");
  assert.equal(cmp2.proposals.some((x) => x.key === "EXTRA_MILEAGE"), false);
});

test("38/39 Rechnung nutzt den vereinbarten Preis (auch 0 €) – keine negative Position; regulärer Preis bleibt im Vertrag intern erhalten", async () => {
  const { ensureInvoiceDraft, finalizeInvoice } = await import("../src/lib/invoices");
  const w = await returnedWorld("t29-inv-zero", {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.customer.update({ where: { id: x.customerId }, data: { discountPercent: 0 } });
      const planId = await plan(x, "PLUS");
      await tariffBooking(x, planId, 7, { price: { mode: "INDIVIDUAL", cents: 0, reason: "Privatvermietung Test" }, km: { mode: "TARIFF" }, deposit: { mode: "INDIVIDUAL", cents: 0, reason: "Sondervereinbarung" } });
    },
  });
  const c = await contractRow(w.contractId);
  assert.equal(Number(c.totalAmount), 0);
  assert.equal(Number(c.deposit), 0);
  const snap = c.priceSnapshot as { agreedTotal: number; tariff: { regularCents: number; agreed: { price: { reason: string; regularCents: number } } } };
  assert.equal(snap.agreedTotal, 0);
  assert.equal(snap.tariff.regularCents, 32900, "intern: regulärer Tarifpreis bleibt bekannt");
  assert.equal(snap.tariff.agreed.price.reason, "Privatvermietung Test");
  // interne Historie: Tarifpreis und Abweichung bleiben im Verlauf der Buchung sichtbar
  const { bookingTimeline } = await import("../src/lib/customer-file");
  const tl = (await bookingTimeline(w.tenantId, w.bookingId)).map((e) => `${e.title} | ${e.detail ?? ""}`).join("\n");
  assert.match(tl, /Individueller Mietpreis 0,00\s€ statt 329,00\s€ \(−329,00\s€, −100,0 %\)/);
  assert.match(tl, /Grund: Privatvermietung Test/);
  assert.match(tl, /Miettarif PLUS \(Revision 1\)/);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const ver = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId: inv.id }, orderBy: { versionNo: "desc" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  const rental = ver.items.find((i) => i.source === "RENTAL");
  assert.ok(rental, JSON.stringify(ver.items.map((i) => i.source)));
  assert.equal(Math.round(Number(rental!.grossAmount) * 100), 0, "Mietposition 0 €");
  assert.ok(ver.items.every((i) => Number(i.grossAmount) >= 0), "keine negativen Positionen");
  await finalizeInvoice(w.tenantId, inv.id, w.actor);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "FINALIZED");
});

test("40 alte Buchung ohne Tarif bleibt voll lesbar und rechnet aus ihren Altfeldern (keine Neubewertung)", async () => {
  const w = await world("t29-legacy");
  const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(b.ratePlanId, null);
  const q = bookingQuote(b, b.startAt, b.endAt!, 0);
  assert.equal(q.source, "LEGACY");
  assert.equal(q.totalCents, totalCentsOf(calculateRentalPrice({ start: b.startAt, end: b.endAt!, rates: rateCardFrom(b) })));
  // auch wenn der Mandant inzwischen Tarife hat
  await plan(w, "PLUS");
  const { ensureContractDraft } = await import("../src/lib/contracts");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, OWNER(w));
  const snap = c.priceSnapshot as { version: number; tariff?: unknown };
  assert.equal(snap.version, 1);
  assert.equal(snap.tariff, undefined);
  assert.equal(Math.round(Number(c.totalAmount) * 100), q.totalCents);
});
