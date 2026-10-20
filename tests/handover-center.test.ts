// Befehl 29.7: Übergabe- und Rückgabezentrale – Testpunkte 2–23 und 25–28 aus dem Plan (Punkt 1 und die Menü-Markierung
// stehen zusätzlich in app-shell.test.ts, Punkt 24 in handover-center-ops.test.ts). Grenz- und Zeittests laufen mit festem
// „jetzt“ und festen UTC-Zeitpunkten (keine Wanduhr, keine 24-h-Pauschalen), je Testwelt ein eigener Mandant mit eigenen
// Fahrzeugen. Prozesswelten (Vertrag, Übergabe, Nachtrag, Storno, Unfallersatz) laufen mit der Wanduhr über die echte Serverlogik.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { db } from "../src/lib/db";
import { proxy } from "../src/proxy";
import { AGREED_EXTENSION_SELECT, agreedEndOf, isOverdue } from "../src/lib/bookings";
import { SOON_DAYS } from "../src/lib/dashboard";
import { navBadges } from "../src/lib/nav-badges";
import {
  CASE_LOCKED_CHIP, agreedHints, centerBounds, centerFilters, centerHref, handoverCenter, parseDayParam, parsePageParam, pickupRowAction,
  pickupRowStatus, resolveDayRange, resolveFilter, returnRowAction, returnRowStatus,
  type ActionInput, type CenterFilter, type CenterKind, type CenterOptions, type CenterViewer, type HandoverCenter,
} from "../src/lib/handover-center";
import { parseLocalDateTime, toDateInputValue, zonedDayRange, zonedDayStart, zonedDayStartPlus } from "../src/lib/time";
import { changeBookingStatus } from "../src/lib/booking-status";
import { agreeAmendment, createAmendmentDraft, getAmendmentContentHash, saveAmendmentSignature, signAmendment, updateAmendmentDraft } from "../src/lib/amendments";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { startHandover } from "../src/lib/handovers";
import { closeCase, createAccidentCase, type CreateAccidentCaseInput } from "../src/lib/accident-replacement";
import { getStorage } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";
import { pickedUpWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-zentrale-"));
  getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Dienstag, 20.10.2026, 10:00 Berliner Zeit (Sommerzeit, UTC+2) */
const NOW = new Date("2026-10-20T08:00:00Z");
/** Berliner Ortszeit „JJJJ-MM-TTTHH:MM“ als Zeitpunkt */
const B = (s: string) => parseLocalDateTime(s)!;
const OWNER: CenterViewer = { role: "OWNER", support: false };
const DISPO: CenterViewer = { role: "DISPO", support: false };
const YARD: CenterViewer = { role: "YARD", support: false };
const SUPPORT: CenterViewer = { role: "YARD", support: true };
const src = (p: string) => readFile(path.join(process.cwd(), p), "utf8");

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();

const center = (tenantId: string, kind: CenterKind, filter: CenterFilter, extra: Partial<CenterOptions> = {}) =>
  handoverCenter(tenantId, { kind, filter, now: NOW, pageSize: 100, viewer: OWNER, ...extra });
const ids = (c: HandoverCenter) => c.rows.map((r) => r.booking.id);
const rowOf = (c: HandoverCenter, bookingId: string) => c.rows.find((r) => r.booking.id === bookingId);

async function world(label: string): Promise<World> {
  await ready;
  const w = await createWorld(label, { startInDays: 60 });
  tenants.push(w.tenantId);
  return w;
}
async function vehicle(w: World, over: Record<string, unknown> = {}) {
  return db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UZ ${uid()}`, make: "VW", model: "Polo", groupId: w.groupId, dailyRate: 49, deposit: 0, requiredLicenseClass: "B", ...over } as never });
}
type MkInput = { number?: string; status?: string; rentalType?: string; startAt: Date; endAt: Date | null; vehicleId?: string; customerId?: string; actualReturnAt?: Date | null };
/** Testbuchung mit festen Zeitpunkten und eigenem Fahrzeug (Muster dashboard.test.ts). */
async function mk(w: World, d: MkInput) {
  const vehicleId = d.vehicleId ?? (await vehicle(w)).id;
  const status = d.status ?? "RESERVED";
  return db.booking.create({
    data: {
      tenantId: w.tenantId, customerId: d.customerId ?? w.customerId, vehicleId, number: d.number ?? `UZ-${uid()}`, status, rentalType: d.rentalType ?? "STANDARD",
      startAt: d.startAt, endAt: d.endAt, actualPickupAt: status === "ACTIVE" || status === "RETURNED" ? d.startAt : null,
      actualReturnAt: d.actualReturnAt !== undefined ? d.actualReturnAt : status === "RETURNED" ? d.endAt : null, dailyRate: 49, deposit: 0,
    },
  });
}
type BookingRow = Awaited<ReturnType<typeof mk>>;
/** Unterschriebener Vertrag als Testdaten (ohne Vertragslogik). */
async function rawContract(w: World, b: BookingRow) {
  return db.rentalContract.create({ data: { tenantId: w.tenantId, bookingId: b.id, number: `MV-UZ-${uid()}`, status: "SIGNED", customerId: b.customerId, vehicleId: b.vehicleId, customerSnapshot: {}, vehicleSnapshot: {}, priceSnapshot: {}, startAt: b.startAt, endAt: b.endAt, signedAt: new Date() } });
}
/** Vereinbarte, noch nicht unterschriebene Änderung (AGREED) an einem unterschriebenen Vertrag – nur Testdaten. */
async function agreed(w: World, b: BookingRow, change: { newEndAt?: Date; newStartAt?: Date }) {
  const c = await rawContract(w, b);
  return db.contractAmendment.create({ data: { tenantId: w.tenantId, contractId: c.id, bookingId: b.id, idempotencyKey: `uz-${uid()}`, status: "AGREED", agreedAt: new Date(), agreedChannel: "PHONE", newEndAt: change.newEndAt ?? null, newStartAt: change.newStartAt ?? null } });
}
async function keyDrop(w: World, bookingId: string, status: "AUTHORIZED" | "CUSTOMER_CONFIRMED", dropOff: Date | null = null) {
  return db.keyDropReturn.create({ data: { tenantId: w.tenantId, bookingId, status, agreedById: w.userId, agreedByName: "Test Mitarbeiter", location: "Hof", expectedReturnAt: NOW, settingsSnapshot: {}, recipientName: "Erika Muster", customerDropOffAt: dropOff } });
}
type RawHandoverOver = {
  number?: string; finalizedAt?: Date; startedAt?: Date; correctsId?: string;
  returnMode?: "IN_PERSON" | "KEY_DROP"; customerDropOffAt?: Date | null; returnTimeOverrideAt?: Date | null; returnTimeOverrideReason?: string | null; keyDropExceptionReason?: string | null;
};
async function rawHandover(w: World, b: { id: string; vehicleId: string }, type: "PICKUP" | "RETURN", status: "DRAFT" | "FINALIZED", over: RawHandoverOver = {}) {
  return db.handover.create({
    data: {
      tenantId: w.tenantId, bookingId: b.id, vehicleId: b.vehicleId, type, status, number: over.number ?? `${type === "PICKUP" ? "UP" : "RP"}-UZ-${uid()}`, employeeName: "Hof Test", driveType: "DIESEL",
      startedAt: over.startedAt ?? new Date(), finalizedAt: status === "FINALIZED" ? (over.finalizedAt ?? new Date()) : null, correctsId: over.correctsId ?? null,
      returnMode: over.returnMode ?? null, customerDropOffAt: over.customerDropOffAt ?? null, returnTimeOverrideAt: over.returnTimeOverrideAt ?? null,
      returnTimeOverrideReason: over.returnTimeOverrideReason ?? null, keyDropExceptionReason: over.keyDropExceptionReason ?? null,
    },
  });
}
/** Laufende Miete mit unterschriebenem Vertrag und abgeschlossener Übergabe (Testdaten) – Rückgabeaktionen über toRow. */
async function runningWithPickup(w: World, endAt: Date) {
  const b = await mk(w, { status: "ACTIVE", startAt: B("2026-10-10T10:00"), endAt });
  await rawContract(w, b);
  await rawHandover(w, b, "PICKUP", "FINALIZED", { finalizedAt: B("2026-10-10T10:05") });
  return b;
}

// ---------------------------------------------------------------------------
// Testwelt Übergaben (festes „jetzt“ = 20.10.2026 10:00 Berlin)
// ---------------------------------------------------------------------------
type PickupGrid = { w: World; other: World; id: Record<string, string>; foreign: string; outNumber: string };
let pickupGrid: Promise<PickupGrid> | null = null;
function pickups(): Promise<PickupGrid> {
  pickupGrid ??= (async () => {
    const w = await world("uz-pick");
    const other = await world("uz-pick-fremd");
    const id: Record<string, string> = {};
    const P = async (key: string, startAt: Date, over: Partial<MkInput> = {}) => { const b = await mk(w, { startAt, endAt: new Date(startAt.getTime() + 2 * DAY), ...over }); id[key] = b.id; return b; };
    await P("t0000", B("2026-10-20T00:00"));
    const t0800 = await P("t0800", B("2026-10-20T08:00"));
    await P("t2359", B("2026-10-20T23:59"), { vehicleId: (await vehicle(w, { status: "WORKSHOP" })).id });
    await P("n0000", B("2026-10-21T00:00"));
    await P("n0001", B("2026-10-21T00:01"));
    await P("y2359", B("2026-10-19T23:59"));
    await P("y1200", B("2026-10-19T12:00"));
    await P("d40", B("2026-09-10T10:00"));
    await P("w2330", B("2026-10-27T23:30"));
    await P("w2800", B("2026-10-28T00:00"));
    const run = uid();
    await P("sameB", B("2026-10-21T10:00"), { number: `UZ-SAME-B-${run}` });
    await P("sameA", B("2026-10-21T10:00"), { number: `UZ-SAME-A-${run}` });
    await P("cancelled", B("2026-10-20T12:00"), { status: "CANCELLED" });
    // G2: neuer Beginn vereinbart (Unterschrift ausstehend), der alte Termin ist verstrichen
    const ns = await P("newstart", B("2026-10-18T10:00"));
    await agreed(w, ns, { newStartAt: B("2026-10-22T10:00") });
    // das Fahrzeug der 08:00-Abholung ist laut einer anderen Buchung noch unterwegs
    const out = await mk(w, { status: "ACTIVE", startAt: B("2026-10-15T10:00"), endAt: B("2026-10-25T10:00"), vehicleId: t0800.vehicleId });
    // fremder Mandant mit Abholung heute
    const f = await mk(other, { startAt: B("2026-10-20T12:00"), endAt: B("2026-10-22T12:00") });
    return { w, other, id, foreign: f.id, outNumber: out.number };
  })();
  return pickupGrid;
}

// ---------------------------------------------------------------------------
// Testwelt Rückgaben (festes „jetzt“ = 20.10.2026 10:00 Berlin)
// ---------------------------------------------------------------------------
type ReturnGrid = { w: World; other: World; id: Record<string, string>; foreign: string[] };
let returnGrid: Promise<ReturnGrid> | null = null;
function returns(): Promise<ReturnGrid> {
  returnGrid ??= (async () => {
    const w = await world("uz-ret");
    const other = await world("uz-ret-fremd");
    const id: Record<string, string> = {};
    const R = async (key: string, endAt: Date | null, over: Partial<MkInput> = {}) => { const b = await mk(w, { status: "ACTIVE", startAt: B("2026-10-10T10:00"), endAt, ...over }); id[key] = b.id; return b; };
    const ACC = { rentalType: "ACCIDENT_REPLACEMENT" };
    await R("r0800", B("2026-10-20T08:00"));
    await R("r2359", B("2026-10-20T23:59"));
    await R("rNext", B("2026-10-21T00:00"));
    await R("rNext1", B("2026-10-21T00:01"));
    await R("rY", B("2026-10-18T10:00"));
    await keyDrop(w, (await R("rKd", B("2026-10-22T12:00"))).id, "CUSTOMER_CONFIRMED", B("2026-10-20T07:30"));
    await keyDrop(w, (await R("rKdOver", B("2026-10-15T10:00"))).id, "CUSTOMER_CONFIRMED", B("2026-10-16T09:00"));
    await keyDrop(w, (await R("rAuth", B("2026-10-22T12:00"))).id, "AUTHORIZED");
    await R("rOpen", null, ACC);
    await keyDrop(w, (await R("rOpenKd", null, ACC)).id, "CUSTOMER_CONFIRMED", B("2026-10-20T06:45"));
    await R("rAccPast", B("2026-10-19T10:00"), ACC);
    const accDraft = await R("rAccPastDraft", B("2026-10-19T10:00"), ACC);
    await rawHandover(w, accDraft, "RETURN", "DRAFT");
    await R("rAccToday", B("2026-10-20T15:00"), ACC);
    await R("rAccLater", B("2026-10-22T10:00"), ACC);
    await agreed(w, await R("rExt", B("2026-10-19T10:00")), { newEndAt: B("2026-10-20T18:00") });
    await agreed(w, await R("rExtPast", B("2026-10-17T10:00")), { newEndAt: B("2026-10-19T10:00") });
    await agreed(w, await R("rShort", B("2026-10-20T20:00")), { newEndAt: B("2026-10-19T12:00") });
    await agreed(w, await R("rStartOnly", B("2026-10-23T10:00")), { newStartAt: B("2026-10-11T10:00") });
    await R("rAlt", B("2026-10-22T09:00"));
    await R("rCancelled", B("2026-10-20T12:00"), { status: "CANCELLED" });
    await R("rReturned", B("2026-10-20T09:00"), { status: "RETURNED" });
    // fremder Mandant: Rückgabe heute und eine überfällige
    const f1 = await mk(other, { status: "ACTIVE", startAt: B("2026-10-10T10:00"), endAt: B("2026-10-20T12:00") });
    const f2 = await mk(other, { status: "ACTIVE", startAt: B("2026-10-10T10:00"), endAt: B("2026-10-19T12:00") });
    return { w, other, id, foreign: [f1.id, f2.id] };
  })();
  return returnGrid;
}

// ===========================================================================
// 3 Menü-Zähler
// ===========================================================================

test("3 Menü-Zähler: /uebergaben = Kennzahl „Heute geplant“, /rueckgaben = |heute ∪ überfällig| der Seite; Unfallersatz, offenes Ende, Storno und fremder Mandant zählen nicht", async () => {
  const p = await pickups();
  const r = await returns();
  const pb = await navBadges(p.w.tenantId, [], NOW);
  const pc = await center(p.w.tenantId, "PICKUP", "heute");
  assert.equal(pb["/uebergaben"]?.count, pc.kpis.today);
  assert.equal(pb["/uebergaben"]?.count, 3);
  assert.equal(pb["/uebergaben"]?.tone, "warn");
  assert.equal(pb["/uebergaben"]?.title, "3 Übergaben heute");

  const rb = await navBadges(r.w.tenantId, [], NOW);
  const today = await center(r.w.tenantId, "RETURN", "heute");
  const over = await center(r.w.tenantId, "RETURN", "ueberfaellig");
  const union = new Set([...ids(today), ...ids(over)]);
  assert.equal(rb["/rueckgaben"]?.count, union.size, JSON.stringify(rb["/rueckgaben"]));
  assert.equal(rb["/rueckgaben"]?.tone, "bad", "Standardmiete überfällig");
  assert.match(rb["/rueckgaben"]!.title, new RegExp(`^${union.size} Rückgaben heute/überfällig · ${over.total} überfällig$`));
  for (const k of ["rOpen", "rAccPast", "rAccPastDraft", "rCancelled", "rReturned", "rNext"]) assert.ok(!union.has(r.id[k]), `${k} nicht im Zähler`);
  for (const k of ["rKd", "rOpenKd", "rKdOver"]) assert.ok(union.has(r.id[k]), `${k}: gemeldete Schlüsselbox-Rückgabe zählt`);
  for (const f of r.foreign) assert.ok(!union.has(f));
  // fremder Mandant: nur eigene Zahlen
  const fb = await navBadges(r.other.tenantId, [], NOW);
  assert.equal(fb["/rueckgaben"]?.count, 2);

  // nur Unfallersatz mit überschrittenem Planende: kein Zähler, kein Rot; Planende heute: Zähler als Hinweis
  const acc = await world("uz-nav-ue");
  await mk(acc, { status: "ACTIVE", rentalType: "ACCIDENT_REPLACEMENT", startAt: B("2026-10-10T10:00"), endAt: B("2026-10-19T10:00") });
  await mk(acc, { status: "ACTIVE", rentalType: "ACCIDENT_REPLACEMENT", startAt: B("2026-10-10T10:00"), endAt: null });
  assert.equal((await navBadges(acc.tenantId, [], NOW))["/rueckgaben"], undefined);
  await mk(acc, { status: "ACTIVE", rentalType: "ACCIDENT_REPLACEMENT", startAt: B("2026-10-10T10:00"), endAt: B("2026-10-20T15:00") });
  const accBadge = (await navBadges(acc.tenantId, [], NOW))["/rueckgaben"];
  assert.equal(accBadge?.count, 1);
  assert.equal(accBadge?.tone, "warn");

  // Quelltext: der /heute-Block bleibt bei 3 count-Abfragen, die neue Zählung steht in einem eigenen safe()-Eintrag
  const nb = await src("src/lib/nav-badges.ts");
  const todayBlock = /const \[pickups, returnsToday, overdue\] = await Promise\.all\(\[([\s\S]*?)\]\);/.exec(nb)?.[1] ?? "";
  assert.equal(todayBlock.match(/db\.booking\.count\(/g)?.length, 3);
  assert.match(nb, /hidden\.has\("\/rueckgaben"\) \? null : safe\(async \(\) => \{\s*const \[due, overdue\] = await Promise\.all\(\[\s*db\.booking\.count\(\{ where: returnsTodayOrOverdueWhere\(tenantId, now\) \}\),\s*db\.booking\.count\(\{ where: returnsOverdueWhere\(tenantId, now\) \}\),/);
  assert.match(nb, /badges\["\/uebergaben"\] = \{ count: today\.pickups/);
  assert.match(nb, /export async function navBadges\(tenantId: string, hiddenPaths: readonly string\[\] = \[\], now = new Date\(\)\)/);
});

// ===========================================================================
// 4–6 Übergaben: heute, überfällig, anstehend
// ===========================================================================

test("4 Übergaben heute: 00:00 und 23:59 drin, 21.10. 00:00 nicht; 08:00 bleibt heute mit „Abholzeit verstrichen“", async () => {
  const g = await pickups();
  const c = await center(g.w.tenantId, "PICKUP", "heute");
  assert.deepEqual(ids(c), [g.id.t0000, g.id.t0800, g.id.t2359], "aufsteigend nach Abholzeit");
  assert.equal(c.kpis.today, 3);
  assert.equal(c.total, 3);
  for (const k of ["n0000", "n0001", "y2359", "cancelled"]) assert.ok(!ids(c).includes(g.id[k]), k);
  const r0800 = rowOf(c, g.id.t0800)!;
  assert.equal(r0800.status.label, "Heute 08:00 · Abholzeit verstrichen");
  assert.equal(r0800.status.tone, "amber");
  assert.equal(rowOf(c, g.id.t2359)!.status.label, "Heute 23:59");
  // reine Hinweise aus Runde 3 bzw. dem Fahrzeugstatus
  assert.ok(r0800.hints.some((h) => h.text === `Fahrzeug noch unterwegs (Buchung ${g.outNumber})`), JSON.stringify(r0800.hints));
  assert.ok(rowOf(c, g.id.t2359)!.hints.some((h) => /steht auf „Werkstatt“/.test(h.text)));
  assert.ok(r0800.hints.some((h) => h.text === "Mietvertrag fehlt"));
});

test("5 Übergaben überfällig: 19.10. 23:59 drin, 20.10. 00:00 nicht, 40 Tage zurück drin, älteste zuerst (Auftrag 8), Ton Hinweis", async () => {
  const g = await pickups();
  const c = await center(g.w.tenantId, "PICKUP", "ueberfaellig");
  assert.deepEqual(new Set(ids(c)), new Set([g.id.y2359, g.id.y1200, g.id.newstart, g.id.d40]));
  // auf den Auftrag ausgerichtet (Abschnitt 8 „Überfällig: älteste überfällige Vorgänge zuerst“): startAt aufsteigend
  assert.deepEqual(ids(c), [g.id.d40, g.id.newstart, g.id.y1200, g.id.y2359], "älteste überfällige zuerst");
  assert.equal(c.kpis.overdue, 4);
  const today = await center(g.w.tenantId, "PICKUP", "heute");
  assert.equal(ids(today).filter((x) => ids(c).includes(x)).length, 0, "kein Überlapp mit heute");
  assert.equal(rowOf(c, g.id.y2359)!.status.label, "Abholtermin verstrichen · seit 1 Tag");
  assert.equal(rowOf(c, g.id.y2359)!.status.tone, "amber");
  assert.equal(rowOf(c, g.id.d40)!.status.label, "Abholtermin verstrichen · seit 40 Tagen");
  assert.deepEqual(ids(await center(g.w.tenantId, "PICKUP", "ueberfaellig")), ids(c), "stabil");
});

test("6 Übergaben anstehend: ab morgen, von/bis (einschließlich) in Berliner Tagen, Kappung, ungültige Werte, Kennzahl „Nächste 7 Tage“", async () => {
  const g = await pickups();
  const c = await center(g.w.tenantId, "PICKUP", "anstehend");
  for (const k of ["n0000", "n0001", "sameA", "sameB", "w2330", "w2800"]) assert.ok(ids(c).includes(g.id[k]), k);
  for (const k of ["t0000", "t0800", "t2359", "y2359", "d40", "newstart", "cancelled"]) assert.ok(!ids(c).includes(g.id[k]), k);
  assert.equal(c.notes.length, 0);
  // genau der 21.10. (bis einschließlich)
  const d = await center(g.w.tenantId, "PICKUP", "anstehend", { von: "2026-10-21", bis: "2026-10-21" });
  assert.deepEqual(ids(d), [g.id.n0000, g.id.n0001, g.id.sameA, g.id.sameB]);
  assert.equal(d.dated, true);
  assert.deepEqual([d.von, d.bis], ["2026-10-21", "2026-10-21"]);
  // „von“ vor morgen wird gekappt, mit Hinweis
  const e = await center(g.w.tenantId, "PICKUP", "anstehend", { von: "2026-10-01", bis: "2026-10-21" });
  assert.deepEqual(ids(e), ids(d));
  assert.ok(e.notes.includes("Anstehend beginnt frühestens morgen"));
  // ungültig: Hinweis, Filter ignoriert, kein Fehler
  for (const [von, bis] of [["abc", ""], ["2026-10-25", "2026-10-21"], ["", "9999-12-31"], ["1999-01-01", ""], ["2026-02-30", ""]]) {
    const x = await center(g.w.tenantId, "PICKUP", "anstehend", { von, bis });
    assert.ok(x.notes.includes("Datum nicht erkannt – Filter ignoriert"), `${von}/${bis}`);
    assert.equal(x.dated, false);
    assert.deepEqual([x.von, x.bis], ["", ""]);
    assert.equal(x.total, c.total);
  }
  // Kennzahl „Nächste 7 Tage“ = Liste „Anstehend“ mit bis = heute + SOON_DAYS (E5b: [morgen, morgen + 7 Tage))
  assert.equal(c.kpis.soonBis, toDateInputValue(zonedDayStartPlus(NOW, SOON_DAYS)));
  assert.equal(c.kpis.soonBis, "2026-10-27");
  const s = await center(g.w.tenantId, "PICKUP", "anstehend", { bis: c.kpis.soonBis });
  assert.equal(s.total, c.kpis.soon);
  assert.ok(ids(s).includes(g.id.w2330) && !ids(s).includes(g.id.w2800));
  assert.equal(ids(s).filter((x) => x !== g.w.bookingId).length, 5, "vier am 21.10. und der 27.10. 23:30");
});

test("6b Rückgaben anstehend: Standardliste (Menge und Reihenfolge), von/bis (einschließlich) in Berliner Tagen, Kappung, ungültige Werte, Kennzahl „Nächste 7 Tage“", async () => {
  const r = await returns();
  const c = await center(r.w.tenantId, "RETURN", "anstehend");
  // ab morgen, operatives Ende, ohne gemeldete Schlüsselbox; Unfallersatz mit geplantem Ende als Disposition enthalten
  const expected = ["rNext", "rNext1", "rAlt", "rAccLater", "rAuth", "rStartOnly"].map((k) => r.id[k]);
  assert.deepEqual(new Set(ids(c)), new Set(expected));
  assert.deepEqual(ids(c), expected, "nächste Termine zuerst (endAt aufsteigend)");
  for (const k of ["r0800", "r2359", "rExt", "rShort", "rKd", "rKdOver", "rOpen", "rOpenKd", "rAccPast", "rAccToday", "rY", "rExtPast", "rCancelled", "rReturned"]) assert.ok(!ids(c).includes(r.id[k]), k);
  assert.equal(c.notes.length, 0);
  // genau ein Berliner Tag (bis einschließlich): 22.10. = [21.10. 22:00Z, 22.10. 22:00Z)
  const d22 = await center(r.w.tenantId, "RETURN", "anstehend", { von: "2026-10-22", bis: "2026-10-22" });
  assert.deepEqual(ids(d22), ["rAlt", "rAccLater", "rAuth"].map((k) => r.id[k]));
  assert.equal(d22.dated, true);
  const d21 = await center(r.w.tenantId, "RETURN", "anstehend", { von: "2026-10-21", bis: "2026-10-21" });
  assert.deepEqual(ids(d21), [r.id.rNext, r.id.rNext1], "21.10. 00:00 und 00:01 gehören zum 21.10.");
  assert.deepEqual(ids(await center(r.w.tenantId, "RETURN", "anstehend", { von: "2026-10-23" })), [r.id.rStartOnly], "nur „von“");
  assert.deepEqual(ids(await center(r.w.tenantId, "RETURN", "anstehend", { bis: "2026-10-21" })), [r.id.rNext, r.id.rNext1], "nur „bis“, ab morgen");
  // „von“ vor morgen wird gekappt, mit Hinweis
  const e = await center(r.w.tenantId, "RETURN", "anstehend", { von: "2026-10-01", bis: "2026-10-21" });
  assert.deepEqual(ids(e), ids(d21));
  assert.ok(e.notes.includes("Anstehend beginnt frühestens morgen"));
  // ungültig: Hinweis, Filter ignoriert
  for (const [von, bis] of [["abc", ""], ["2026-10-25", "2026-10-21"], ["", "9999-12-31"]]) {
    const x = await center(r.w.tenantId, "RETURN", "anstehend", { von, bis });
    assert.ok(x.notes.includes("Datum nicht erkannt – Filter ignoriert"), `${von}/${bis}`);
    assert.equal(x.total, c.total);
  }
  // Kennzahl „Nächste 7 Tage“ = Liste „Anstehend“ mit bis = soonBis (E5b)
  assert.equal(c.kpis.soonBis, "2026-10-27");
  const s = await center(r.w.tenantId, "RETURN", "anstehend", { bis: c.kpis.soonBis });
  assert.equal(s.total, c.kpis.soon);
  assert.deepEqual(new Set(ids(s)), new Set(expected), "alle anstehenden Rückgaben liegen vor dem 28.10.");
  assert.equal(c.kpis.soon, expected.length);
});

// ===========================================================================
// 7–8 In Bearbeitung und Abgeschlossen (Übergabe, Wanduhr)
// ===========================================================================

const TAX = { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" };
/** Unterschriebener Vertrag, Buchung reserviert (wie cancellation-and-rental-changes.test.ts). */
async function signedWorld(label: string): Promise<World & { contractId: string }> {
  await ready;
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: TAX });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return { ...w, contractId: c.id };
}

test("7 In Bearbeitung (Übergabe): Entwurf mit UP-Nummer, Schritt, Mitarbeiter und Beginn; Korrekturprotokoll zählt nicht; zweiter Start ändert nichts", async () => {
  const s = await signedWorld("uz-entwurf");
  const h1 = await startHandover(s.tenantId, s.bookingId, "PICKUP", s.actor);
  const c = await handoverCenter(s.tenantId, { kind: "PICKUP", filter: "in_bearbeitung", viewer: YARD });
  assert.deepEqual(c.rows.map((r) => r.key), [h1.id]);
  assert.equal(c.kpis.inProgress, 1);
  const row = c.rows[0];
  assert.equal(row.booking.id, s.bookingId);
  const esc = h1.number.replace(/[-]/g, "\\-");
  assert.ok(row.hints.some((h) => new RegExp(`^${esc} · Schritt \\d+ · begonnen \\d{2}\\.\\d{2}\\.\\d{4}, \\d{2}:\\d{2} von Test Mitarbeiter$`).test(h.text)), JSON.stringify(row.hints));
  assert.ok(row.chips.some((x) => x.label === "Entwurf"));
  assert.deepEqual(row.action, { label: "Übergabe fortsetzen", href: `/buchungen/${s.bookingId}/uebergabe` });
  // Prüfbefund T5 (c): Fahrerprüfung aus Runde 3 (Vertragsfahrer des unterschriebenen Vertrags, noch keine Bestätigung)
  assert.ok(row.hints.some((h) => /^Fahrerprüfung 0 von [1-9]\d* bestätigt$/.test(h.text)), JSON.stringify(row.hints));
  assert.ok(!row.hints.some((h) => h.text === "Mietvertrag fehlt" || h.text === "Vertrag in Arbeit"));
  // zweiter Start: derselbe Entwurf, keine zweite Zeile
  const h2 = await startHandover(s.tenantId, s.bookingId, "PICKUP", s.actor);
  assert.equal(h2.id, h1.id);
  // Korrekturprotokoll (correctsId gesetzt) zählt nicht
  await rawHandover(s, { id: s.bookingId, vehicleId: s.vehicleId }, "PICKUP", "DRAFT", { correctsId: h1.id });
  const c2 = await handoverCenter(s.tenantId, { kind: "PICKUP", filter: "in_bearbeitung", viewer: YARD });
  assert.equal(c2.total, 1);
  assert.equal(c2.kpis.inProgress, 1);
  // Suche nach der UP-Nummer
  const q = await handoverCenter(s.tenantId, { kind: "PICKUP", filter: "in_bearbeitung", q: h1.number, viewer: YARD });
  assert.deepEqual(q.rows.map((r) => r.key), [h1.id]);
});

test("8 Abgeschlossen (Übergabe): finalizedAt absteigend, tatsächliches Datum = actualPickupAt, Datumsfilter auf finalizedAt, Suche nach Protokollnummer", async () => {
  await ready;
  const p = await pickedUpWorld("uz-done");
  tenants.push(p.tenantId);
  const b = await db.booking.findUniqueOrThrow({ where: { id: p.bookingId } });
  const ho = await db.handover.findUniqueOrThrow({ where: { id: p.pickupId } });
  assert.equal(b.actualPickupAt!.getTime(), ho.finalizedAt!.getTime());
  const older = await mk(p, { status: "ACTIVE", startAt: new Date(ho.finalizedAt!.getTime() - 3 * DAY), endAt: new Date(ho.finalizedAt!.getTime() + 3 * DAY) });
  const oh = await rawHandover(p, older, "PICKUP", "FINALIZED", { finalizedAt: new Date(ho.finalizedAt!.getTime() - 2 * DAY) });
  const c = await handoverCenter(p.tenantId, { kind: "PICKUP", filter: "abgeschlossen", viewer: OWNER });
  assert.deepEqual(c.rows.map((r) => r.key), [p.pickupId, oh.id]);
  const row = c.rows[0];
  assert.equal(row.status.label, "Übergeben");
  assert.deepEqual(row.actual, [{ label: "Übergeben", at: b.actualPickupAt }]);
  assert.deepEqual(row.action, { label: "Übergabeprotokoll anzeigen", href: `/buchungen/${p.bookingId}/uebergabe` });
  // Datumsfilter auf den Abschlusstag (Berlin)
  const day = toDateInputValue(ho.finalizedAt!);
  const before = toDateInputValue(zonedDayStartPlus(ho.finalizedAt!, -1));
  const d1 = await handoverCenter(p.tenantId, { kind: "PICKUP", filter: "abgeschlossen", von: day, bis: day, viewer: OWNER });
  assert.deepEqual(d1.rows.map((r) => r.key), [p.pickupId]);
  const d2 = await handoverCenter(p.tenantId, { kind: "PICKUP", filter: "abgeschlossen", von: before, bis: before, viewer: OWNER });
  assert.ok(!d2.rows.some((r) => r.key === p.pickupId));
  // Suche nach der Protokollnummer
  const q = await handoverCenter(p.tenantId, { kind: "PICKUP", filter: "abgeschlossen", q: ho.number, viewer: OWNER });
  assert.deepEqual(q.rows.map((r) => r.key), [p.pickupId]);
});

// ===========================================================================
// 9–13 Rückgaben
// ===========================================================================

test("9 Rückgaben heute: ganzer Berliner Tag (08:00 auch überfällig, „Überfällig seit 08:00“), 23:59 drin, morgen nicht, Schlüsselbox gemeldet = Kontrolle ausstehend", async () => {
  const r = await returns();
  const c = await center(r.w.tenantId, "RETURN", "heute");
  const over = await center(r.w.tenantId, "RETURN", "ueberfaellig");
  const ahead = await center(r.w.tenantId, "RETURN", "anstehend");
  assert.deepEqual(new Set(ids(c)), new Set(["r0800", "r2359", "rKd", "rKdOver", "rOpenKd", "rAccToday", "rExt", "rShort"].map((k) => r.id[k])));
  assert.ok(ids(over).includes(r.id.r0800), "08:00 ist heute und überfällig");
  assert.equal(rowOf(c, r.id.r0800)!.status.label, "Überfällig seit 08:00");
  assert.equal(rowOf(c, r.id.r2359)!.status.label, "Heute 23:59");
  assert.ok(!ids(c).includes(r.id.rNext) && !ids(c).includes(r.id.rNext1));
  const kd = rowOf(c, r.id.rKd)!;
  assert.equal(kd.status.label, "Kontrolle ausstehend");
  assert.equal(kd.status.detail, "Abgabe laut Kunde 07:30");
  assert.ok(!ids(ahead).includes(r.id.rKd), "gemeldet: nicht anstehend");
  assert.ok(!ids(over).includes(r.id.rKdOver), "gemeldet: nicht überfällig");
  assert.equal(c.kpis.keyDropPending, 3);
  assert.equal(c.kpis.today, c.total);
  assert.equal(c.kpis.inProgress, 1);
});

test("10 Rückgaben überfällig: Filter = { Standard ∧ isOverdue(agreedEndOf) ∧ ¬Schlüsselbox gemeldet }, Zeilenstatus „Überfällig…“ genau für diese Menge", async () => {
  const r = await returns();
  const all = await db.booking.findMany({ where: { tenantId: r.w.tenantId }, select: { id: true, status: true, endAt: true, rentalType: true, contractAmendments: AGREED_EXTENSION_SELECT, keyDropReturns: { select: { status: true } } } });
  const expected = new Set(all.filter((b) => b.rentalType !== "ACCIDENT_REPLACEMENT" && isOverdue({ status: b.status, endAt: b.endAt, agreedEndAt: agreedEndOf(b) }, NOW) && !b.keyDropReturns.some((k) => k.status === "CUSTOMER_CONFIRMED")).map((b) => b.id));
  const over = await center(r.w.tenantId, "RETURN", "ueberfaellig");
  assert.deepEqual(new Set(ids(over)), expected);
  assert.deepEqual(expected, new Set([r.id.r0800, r.id.rY, r.id.rExtPast]));
  assert.equal(over.kpis.overdue, expected.size);
  assert.deepEqual(ids(over), [r.id.rExtPast, r.id.rY, r.id.r0800], "nach endAt aufsteigend (am längsten überfällig zuerst)");
  assert.equal(rowOf(over, r.id.rY)!.status.label, "Überfällig seit 2 Tagen");
  assert.equal(rowOf(over, r.id.rExtPast)!.status.label, "Überfällig seit 1 Tag");
  // Zeilenstatus über alle offenen Listen: „Überfällig…“ genau für die erwartete Menge
  const lists = await Promise.all((["heute", "ueberfaellig", "anstehend", "offenes_ende", "in_bearbeitung"] as CenterFilter[]).map((f) => center(r.w.tenantId, "RETURN", f)));
  const rows = new Map(lists.flatMap((l) => l.rows).map((x) => [x.booking.id, x]));
  for (const [bookingId, row] of rows) assert.equal(row.status.label.startsWith("Überfällig"), expected.has(bookingId), `${bookingId}: ${row.status.label}`);
});

test("11 Nachträge (Testdaten): Verlängerung verhindert „überfällig“, Verkürzung wirkt nicht, nur neuer Beginn bleibt „überfällig“; Hinweise je Art", async () => {
  const r = await returns();
  const g = await pickups();
  const today = await center(r.w.tenantId, "RETURN", "heute");
  const over = await center(r.w.tenantId, "RETURN", "ueberfaellig");
  const ext = rowOf(today, r.id.rExt)!;
  assert.ok(ext && !ids(over).includes(r.id.rExt));
  assert.equal(ext.planned.at!.getTime(), B("2026-10-20T18:00").getTime());
  assert.equal(ext.planned.before!.getTime(), B("2026-10-19T10:00").getTime());
  assert.ok(ext.hints.some((h) => h.text === "Verlängerung vereinbart bis 20.10.2026, 18:00 – vor Abschluss der Rückgabe unterschreiben lassen"), JSON.stringify(ext.hints));
  const short = rowOf(today, r.id.rShort)!;
  assert.ok(short && !ids(over).includes(r.id.rShort), "Einordnung nach dem alten Ende");
  assert.ok(short.hints.some((h) => h.text === "Verkürzung vereinbart (bis 19.10.2026, 12:00) – operativ noch nicht wirksam – vor Abschluss der Rückgabe unterschreiben lassen"), JSON.stringify(short.hints));
  const startOnly = rowOf(await center(r.w.tenantId, "RETURN", "anstehend"), r.id.rStartOnly)!;
  assert.ok(startOnly.hints.some((h) => h.text === "Neuer Mietbeginn vereinbart (11.10.2026, 10:00) – vor Abschluss der Rückgabe unterschreiben lassen"));
  // Übergabe: neuer Beginn vereinbart, alter Termin verstrichen → bleibt „überfällig“ (G2), Status nennt die Vereinbarung
  const po = await center(g.w.tenantId, "PICKUP", "ueberfaellig");
  const ns = rowOf(po, g.id.newstart)!;
  assert.equal(ns.status.label, "Neuer Beginn vereinbart (22.10.2026, 10:00) – Unterschrift ausstehend");
  assert.ok(ns.hints.some((h) => h.text === "Neuer Mietbeginn vereinbart (22.10.2026, 10:00) – bei der Übergabe unterschreiben lassen"));
});

test("11 Nachträge (Prozess): agreeAmendment verlängert über „jetzt“ hinaus – nicht überfällig, am vereinbarten Tag heute; nach signAmendment richtig eingeordnet", async () => {
  await ready;
  const p = await pickedUpWorld("uz-nachtrag");
  tenants.push(p.tenantId);
  const b0 = await db.booking.findUniqueOrThrow({ where: { id: p.bookingId } });
  const a = (await createAmendmentDraft(p.tenantId, p.actor, { bookingId: p.bookingId, nonce: `uz-nt-${uid()}` })).amendment;
  const newEnd = new Date(b0.endAt!.getTime() + DAY);
  await updateAmendmentDraft(p.tenantId, p.actor, a.id, { newEndAt: newEnd });
  await agreeAmendment(p.tenantId, p.actor, a.id, { channel: "PHONE" });
  // „jetzt“ = Beginn des vereinbarten Rückgabetags in Berlin
  const dayStart = zonedDayStart(newEnd);
  const nowX = dayStart.getTime() === newEnd.getTime() ? newEnd : dayStart;
  if (b0.endAt! < nowX) assert.equal(isOverdue({ status: "ACTIVE", endAt: b0.endAt }, nowX), true, "ohne Vereinbarung wäre die Miete überfällig");
  const at = (filter: CenterFilter) => handoverCenter(p.tenantId, { kind: "RETURN", filter, now: nowX, viewer: OWNER });
  const today = await at("heute");
  assert.ok(ids(today).includes(p.bookingId));
  assert.ok(!ids(await at("ueberfaellig")).includes(p.bookingId));
  const row = rowOf(today, p.bookingId)!;
  assert.ok(row.hints.some((h) => /^Verlängerung vereinbart bis .+ – vor Abschluss der Rückgabe unterschreiben lassen$/.test(h.text)), JSON.stringify(row.hints));
  assert.equal(row.planned.at!.getTime(), newEnd.getTime());
  assert.equal(row.planned.before!.getTime(), b0.endAt!.getTime());
  assert.deepEqual(row.action, { label: "Rückgabe starten", href: `/buchungen/${p.bookingId}/rueckgabe` });
  // Unterschrift: endAt ist das neue Ende, kein Nachtragshinweis mehr
  await saveAmendmentSignature(p.tenantId, p.actor, a.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(5), seenHash: await getAmendmentContentHash(p.tenantId, a.id) });
  await signAmendment(p.tenantId, p.actor, a.id);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: p.bookingId } })).endAt!.getTime(), newEnd.getTime());
  const signed = await at("heute");
  const row2 = rowOf(signed, p.bookingId)!;
  assert.ok(row2 && !ids(await at("ueberfaellig")).includes(p.bookingId));
  assert.ok(!row2.hints.some((h) => /vereinbart/.test(h.text)));
  assert.equal(row2.planned.before, null);
});

test("12 Offenes Mietende: nie heute/überfällig/anstehend, nie im Zähler; in „Offenes Mietende“ ohne Datum; mit gemeldeter Schlüsselbox heute als „Kontrolle ausstehend“", async () => {
  const r = await returns();
  const [today, over, ahead, open] = await Promise.all((["heute", "ueberfaellig", "anstehend", "offenes_ende"] as CenterFilter[]).map((f) => center(r.w.tenantId, "RETURN", f)));
  for (const c of [today, over, ahead]) assert.ok(!ids(c).includes(r.id.rOpen));
  const row = rowOf(open, r.id.rOpen)!;
  assert.equal(row.status.label, "Mietende offen");
  assert.equal(row.planned.at, null);
  assert.equal(row.planned.text, "Mietende offen");
  assert.ok(row.chips.some((x) => x.label === "Unfallersatz"));
  // offenes Ende + Schlüsselbox gemeldet
  assert.ok(ids(today).includes(r.id.rOpenKd) && !ids(over).includes(r.id.rOpenKd));
  assert.equal(rowOf(today, r.id.rOpenKd)!.status.label, "Kontrolle ausstehend");
  const badge = (await navBadges(r.w.tenantId, [], NOW))["/rueckgaben"]!;
  assert.equal(badge.count, new Set([...ids(today), ...ids(over)]).size);
  assert.equal(open.kpis.openEnd, 6);
});

test("13 Unfallersatz mit geplantem Ende: nie überfällig (E2a), in „Offenes Mietende“ überschritten/Rückgabe offen; heute bzw. anstehend als Disposition", async () => {
  const r = await returns();
  const [today, over, ahead, open] = await Promise.all((["heute", "ueberfaellig", "anstehend", "offenes_ende"] as CenterFilter[]).map((f) => center(r.w.tenantId, "RETURN", f)));
  for (const k of ["rAccPast", "rAccPastDraft", "rAccToday", "rAccLater", "rOpen", "rOpenKd"]) assert.ok(!ids(over).includes(r.id[k]), k);
  assert.equal(over.kpis.overdue, 3, "Kennzahl ohne Unfallersatz");
  const past = rowOf(open, r.id.rAccPast)!;
  assert.equal(past.status.label, "Geplantes Mietende überschritten");
  assert.equal(past.status.tone, "bad");
  assert.equal(open.kpis.openEndExceeded, 2);
  assert.equal(rowOf(open, r.id.rAccPastDraft)!.status.label, "Rückgabe offen");
  const t = rowOf(today, r.id.rAccToday)!;
  assert.equal(t.status.label, "geplant 20.10.2026 15:00 (Disposition)");
  assert.equal(t.planned.text, "geplant (Disposition)");
  assert.equal(rowOf(ahead, r.id.rAccLater)!.status.label, "geplant 22.10.2026 10:00 (Disposition)");
  assert.deepEqual(new Set(ids(open)), new Set(["rOpen", "rOpenKd", "rAccPast", "rAccPastDraft", "rAccToday", "rAccLater"].map((k) => r.id[k])));
});

// ===========================================================================
// 14 Storno
// ===========================================================================

test("14 Storno mit Übergabeentwurf: danach in keinem Filter, keiner Kennzahl, keinem Zähler; der Entwurf ist gelöscht", async () => {
  const s = await signedWorld("uz-storno");
  await startHandover(s.tenantId, s.bookingId, "PICKUP", s.actor);
  const before = await handoverCenter(s.tenantId, { kind: "PICKUP", filter: "in_bearbeitung", viewer: OWNER });
  assert.equal(before.total, 1);
  await changeBookingStatus(s.tenantId, s.bookingId, "CANCELLED", { actor: s.actor, reason: "Kunde hat abgesagt" });
  assert.equal(await db.handover.count({ where: { tenantId: s.tenantId, bookingId: s.bookingId } }), 0, "Entwurf gelöscht");
  for (const kind of ["PICKUP", "RETURN"] as CenterKind[]) {
    for (const f of centerFilters(kind)) {
      const c = await handoverCenter(s.tenantId, { kind, filter: f, viewer: OWNER });
      assert.ok(!ids(c).includes(s.bookingId), `${kind}/${f}`);
      assert.deepEqual([c.kpis.today, c.kpis.overdue, c.kpis.soon, c.kpis.inProgress], [0, 0, 0, 0], `${kind}/${f}`);
    }
  }
  const badges = await navBadges(s.tenantId, []);
  assert.equal(badges["/uebergaben"], undefined);
  assert.equal(badges["/rueckgaben"], undefined);
});

// ===========================================================================
// 15–18 Aktionen, gesperrter Fall, Supportmodus (rein und mit Datenbank)
// ===========================================================================

const H = (type: string, status: string) => ({ type, status });
const act = (over: Partial<ActionInput>): ActionInput => ({ bookingId: "b1", status: "RESERVED", contractStatus: "SIGNED", handovers: [], caseClosed: false, keyDrop: null, ...over });

test("15 Aktionen Übergabe: START, CONTINUE, VIEW; Vertrag fehlt = nur Buchung; Vertrag in Arbeit nur Inhaber/Disposition; nie mit „schritt“", () => {
  const PICK = "/buchungen/b1/uebergabe";
  for (const v of [OWNER, DISPO, YARD]) {
    assert.deepEqual(pickupRowAction(act({}), v), { label: "Übergabe starten", href: PICK });
    assert.deepEqual(pickupRowAction(act({ handovers: [H("PICKUP", "DRAFT")] }), v), { label: "Übergabe fortsetzen", href: PICK });
    assert.deepEqual(pickupRowAction(act({ status: "ACTIVE", handovers: [H("PICKUP", "FINALIZED")] }), v), { label: "Übergabeprotokoll anzeigen", href: PICK });
    assert.equal(pickupRowAction(act({ contractStatus: null }), v), null, "Mietvertrag fehlt: Vertrag entsteht per Server Action auf der Buchungsseite");
  }
  assert.deepEqual(pickupRowAction(act({ contractStatus: "DRAFT" }), DISPO), { label: "Mietvertrag fortsetzen", href: "/buchungen/b1/vertrag" });
  assert.deepEqual(pickupRowAction(act({ contractStatus: "DRAFT" }), OWNER), { label: "Mietvertrag fortsetzen", href: "/buchungen/b1/vertrag" });
  assert.equal(pickupRowAction(act({ contractStatus: "DRAFT" }), YARD), null, "Hof: kein Vertragslink");
  for (const a of [act({}), act({ handovers: [H("PICKUP", "DRAFT")] }), act({ status: "ACTIVE", handovers: [H("PICKUP", "FINALIZED")] })]) {
    assert.ok(!pickupRowAction(a, YARD)!.href.includes("schritt"));
  }
});

test("16 Aktionen Rückgabe: START, CONTINUE, VIEW, Altfall, Schlüsselbox vereinbart/gemeldet; jede vereinbarte Änderung ergibt einen Hinweis", async () => {
  const RET = "/buchungen/b1/rueckgabe";
  const running = act({ status: "ACTIVE", handovers: [H("PICKUP", "FINALIZED")] });
  for (const v of [OWNER, DISPO, YARD]) {
    assert.deepEqual(returnRowAction(running, v), { label: "Rückgabe starten", href: RET });
    assert.deepEqual(returnRowAction({ ...running, handovers: [H("PICKUP", "FINALIZED"), H("RETURN", "DRAFT")] }, v), { label: "Rückgabe fortsetzen", href: RET });
    assert.deepEqual(returnRowAction({ ...running, status: "RETURNED", handovers: [H("PICKUP", "FINALIZED"), H("RETURN", "FINALIZED")] }, v), { label: "Rückgabeprotokoll anzeigen", href: RET });
    assert.equal(returnRowAction(act({ status: "ACTIVE", contractStatus: null }), v), null, "Altfall ohne Protokoll: nur Buchung öffnen");
    assert.deepEqual(returnRowAction({ ...running, keyDrop: { status: "CUSTOMER_CONFIRMED" } }, v), { label: "Schlüsselbox-Rückgabe prüfen", href: RET });
    assert.deepEqual(returnRowAction({ ...running, keyDrop: { status: "CUSTOMER_CONFIRMED" }, handovers: [H("PICKUP", "FINALIZED"), H("RETURN", "DRAFT")] }, v), { label: "Rückgabe fortsetzen", href: RET });
  }
  assert.equal(returnRowAction({ ...running, keyDrop: { status: "AUTHORIZED" } }, YARD), null, "Hof: keine Kontrolle ohne Kundenmeldung");
  assert.deepEqual(returnRowAction({ ...running, keyDrop: { status: "AUTHORIZED" } }, DISPO), { label: "Schlüsselbox-Rückgabe öffnen", href: RET });
  assert.deepEqual(returnRowAction({ ...running, keyDrop: { status: "AUTHORIZED" } }, OWNER), { label: "Schlüsselbox-Rückgabe öffnen", href: RET });
  // Hinweise je Art (rein)
  const end = new Date("2026-10-22T10:00:00Z");
  assert.equal(agreedHints("RETURN", end, [{ newEndAt: new Date("2026-10-23T10:00:00Z"), newStartAt: null }]).length, 1);
  assert.match(agreedHints("RETURN", end, [{ newEndAt: new Date("2026-10-23T10:00:00Z"), newStartAt: null }])[0].text, /^Verlängerung vereinbart bis .+ – vor Abschluss der Rückgabe unterschreiben lassen$/);
  assert.match(agreedHints("RETURN", end, [{ newEndAt: new Date("2026-10-21T10:00:00Z"), newStartAt: null }])[0].text, /^Verkürzung vereinbart \(bis .+\) – operativ noch nicht wirksam – vor Abschluss/);
  assert.match(agreedHints("PICKUP", end, [{ newEndAt: null, newStartAt: new Date("2026-10-21T10:00:00Z") }])[0].text, /^Neuer Mietbeginn vereinbart \(.+\) – bei der Übergabe unterschreiben lassen$/);
  // Datenbank: Altfall und vereinbarte Schlüsselbox
  const r = await returns();
  const ahead = await center(r.w.tenantId, "RETURN", "anstehend", { viewer: DISPO });
  const alt = rowOf(ahead, r.id.rAlt)!;
  assert.ok(alt.hints.some((h) => h.text === "Altfall ohne Übergabeprotokoll"));
  assert.equal(alt.action, null);
  assert.deepEqual(alt.open, { label: "Buchung öffnen", href: `/buchungen/${r.id.rAlt}` });
  assert.ok(rowOf(ahead, r.id.rAuth)!.hints.some((h) => h.text === "Schlüsselbox vereinbart – Kundenmeldung ausstehend (Kontrolle vorher nur mit dokumentiertem Grund)"));
  // Prüfbefund R2: der Hof erfährt, warum er keine Aktion hat (wie rueckgabe/page.tsx); im Supportmodus nur der Grundtext
  const yardAhead = await center(r.w.tenantId, "RETURN", "anstehend", { viewer: YARD });
  const yardAuth = rowOf(yardAhead, r.id.rAuth)!;
  assert.ok(yardAuth.hints.some((h) => h.text === "Schlüsselbox vereinbart – Kundenmeldung ausstehend – Kontrolle vor der Kundenmeldung nur durch Inhaber oder Disposition (mit Begründung)"), JSON.stringify(yardAuth.hints));
  assert.equal(yardAuth.action, null);
  const supportAhead = await center(r.w.tenantId, "RETURN", "anstehend", { viewer: SUPPORT });
  assert.ok(rowOf(supportAhead, r.id.rAuth)!.hints.some((h) => h.text === "Schlüsselbox vereinbart – Kundenmeldung ausstehend"));
});

test("16b Schlüsselbox über die Datenbank: gemeldet = „prüfen“ für alle Rollen, vereinbart = Hof ohne Aktion; abgeschlossene Kontrolle mit/ohne Kundenmeldung (SL-3); Suche nach RP-Nummer", async () => {
  const w = await world("uz-kd");
  // laufende Mieten mit Vertrag und abgeschlossener Übergabe (Prüfbefund T5 b): Aktionen kommen über toRow, nicht nur rein
  const conf = await runningWithPickup(w, B("2026-10-22T12:00"));
  await keyDrop(w, conf.id, "CUSTOMER_CONFIRMED", B("2026-10-20T07:00"));
  const auth = await runningWithPickup(w, B("2026-10-22T12:00"));
  await keyDrop(w, auth.id, "AUTHORIZED");
  for (const viewer of [OWNER, DISPO, YARD]) {
    const today = await center(w.tenantId, "RETURN", "heute", { viewer });
    assert.deepEqual(rowOf(today, conf.id)!.action, { label: "Schlüsselbox-Rückgabe prüfen", href: `/buchungen/${conf.id}/rueckgabe` }, viewer.role);
    const a = rowOf(await center(w.tenantId, "RETURN", "anstehend", { viewer }), auth.id)!;
    if (viewer.role === "YARD") assert.equal(a.action, null);
    else assert.deepEqual(a.action, { label: "Schlüsselbox-Rückgabe öffnen", href: `/buchungen/${auth.id}/rueckgabe` }, viewer.role);
    assert.ok(!a.hints.some((h) => h.text === "Altfall ohne Übergabeprotokoll"));
  }
  assert.deepEqual(rowOf(await center(w.tenantId, "RETURN", "heute", { viewer: SUPPORT }), conf.id)!.action, null);

  // abgeschlossene Schlüsselbox-Kontrollen (Testdaten): mit Kundenmeldung, per Ausnahme ohne Meldung, mit Korrektur des Mietendes
  // feste Protokollnummern ohne Ziffern: die Suche darf nicht zufällig über Telefonziffern des Testkunden treffen
  const done = async (d: { number: string; dropOff: Date | null; override: Date | null; finalizedAt: Date; actualReturnAt: Date }) => {
    const b = await mk(w, { status: "RETURNED", startAt: B("2026-10-10T10:00"), endAt: B("2026-10-18T10:00"), actualReturnAt: d.actualReturnAt });
    await rawHandover(w, b, "PICKUP", "FINALIZED", { finalizedAt: B("2026-10-10T10:05") });
    const h = await rawHandover(w, b, "RETURN", "FINALIZED", {
      number: d.number, finalizedAt: d.finalizedAt, returnMode: "KEY_DROP", customerDropOffAt: d.dropOff,
      returnTimeOverrideAt: d.override, returnTimeOverrideReason: d.override ? "Kunde hat die Abgabezeit telefonisch korrigiert" : null,
      keyDropExceptionReason: d.dropOff ? null : "Kunde hat den Schlüssel persönlich abgegeben",
    });
    return h;
  };
  const withCustomer = await done({ number: "RP-KD-KUNDE", dropOff: B("2026-10-18T09:30"), override: null, finalizedAt: B("2026-10-18T11:00"), actualReturnAt: B("2026-10-18T09:30") });
  const exception = await done({ number: "RP-KD-AUSNAHME", dropOff: null, override: null, finalizedAt: B("2026-10-18T12:00"), actualReturnAt: B("2026-10-18T12:00") });
  const corrected = await done({ number: "RP-KD-KORREKTUR", dropOff: null, override: B("2026-10-18T08:00"), finalizedAt: B("2026-10-18T13:00"), actualReturnAt: B("2026-10-18T08:00") });
  const closed = await center(w.tenantId, "RETURN", "abgeschlossen");
  const byKey = (id: string) => closed.rows.find((x) => x.key === id)!;
  assert.deepEqual(byKey(withCustomer.id).actual, [{ label: "Abgabe laut Kunde", at: B("2026-10-18T09:30") }, { label: "Kontrolle am", at: B("2026-10-18T11:00") }]);
  assert.ok(!byKey(withCustomer.id).hints.some((h) => /Ausnahme/.test(h.text)));
  assert.deepEqual(byKey(exception.id).actual, [{ label: "Kontrolle am", at: B("2026-10-18T12:00") }], "ohne Kundenmeldung keine „Abgabe laut Kunde“");
  assert.ok(byKey(exception.id).hints.some((h) => h.text === "Kontrolle ohne Kundenmeldung (Ausnahme)"));
  assert.deepEqual(byKey(corrected.id).actual, [{ label: "Mietende (korrigiert)", at: B("2026-10-18T08:00") }, { label: "Kontrolle am", at: B("2026-10-18T13:00") }]);
  assert.ok(!byKey(corrected.id).hints.some((h) => /Ausnahme/.test(h.text)));
  assert.deepEqual(closed.rows.map((x) => x.key).slice(0, 3), [corrected.id, exception.id, withCustomer.id], "nach Kontrolle (finalizedAt) absteigend");
  // Prüfbefund T5 (a): Suche nach der RP-Nummer
  const q = await center(w.tenantId, "RETURN", "abgeschlossen", { q: exception.number });
  assert.deepEqual(q.rows.map((x) => x.key), [exception.id]);
});

test("16c Schlüsselbox per Ausnahme begonnen (SL-1): kein „Kundenmeldung ausstehend“ mehr, sondern Ausnahmehinweis; „Rückgabe fortsetzen“; Suche nach RP-Nummer", async () => {
  await ready;
  const p = await pickedUpWorld("uz-kd-ausnahme");
  tenants.push(p.tenantId);
  await keyDrop(p, p.bookingId, "AUTHORIZED");
  const before = await handoverCenter(p.tenantId, { kind: "RETURN", filter: "anstehend", viewer: OWNER });
  const b0 = rowOf(before, p.bookingId)!;
  assert.deepEqual(b0.action, { label: "Schlüsselbox-Rückgabe öffnen", href: `/buchungen/${p.bookingId}/rueckgabe` });
  assert.ok(b0.hints.some((h) => h.text.startsWith("Schlüsselbox vereinbart – Kundenmeldung ausstehend")));
  // Kontrolle ohne Kundenmeldung mit Pflichtgrund (wie das Ausnahmeformular der Rückgabeseite)
  const r = await startHandover(p.tenantId, p.bookingId, "RETURN", p.actor, { keyDropException: "Kunde hat den Schlüssel persönlich am Schalter abgegeben" });
  assert.equal(r.returnMode, "KEY_DROP");
  assert.equal(r.customerDropOffAt, null);
  const c = await handoverCenter(p.tenantId, { kind: "RETURN", filter: "in_bearbeitung", viewer: OWNER });
  const row = c.rows.find((x) => x.key === r.id)!;
  assert.ok(row, JSON.stringify(c.rows.map((x) => x.key)));
  assert.ok(!row.hints.some((h) => h.text.startsWith("Schlüsselbox vereinbart")), JSON.stringify(row.hints));
  assert.ok(row.hints.some((h) => h.text === "Kontrolle ohne Kundenmeldung begonnen (Ausnahme)"));
  assert.ok(row.chips.some((x) => x.label === "Entwurf"));
  assert.deepEqual(row.action, { label: "Rückgabe fortsetzen", href: `/buchungen/${p.bookingId}/rueckgabe` });
  const yard = (await handoverCenter(p.tenantId, { kind: "RETURN", filter: "in_bearbeitung", viewer: YARD })).rows.find((x) => x.key === r.id)!;
  assert.deepEqual(yard.action, { label: "Rückgabe fortsetzen", href: `/buchungen/${p.bookingId}/rueckgabe` }, "fortsetzen darf auch der Hof");
  // Prüfbefund T5 (a): Suche nach der RP-Nummer des Entwurfs
  const q = await handoverCenter(p.tenantId, { kind: "RETURN", filter: "in_bearbeitung", q: r.number, viewer: OWNER });
  assert.deepEqual(q.rows.map((x) => x.key), [r.id]);
});

const HOUR_MS = HOUR;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
function caseInput(w: World, vehicleId: string): CreateAccidentCaseInput {
  return {
    nonce: `uz-ue-${uid()}`, customerId: w.customerId, vehicleId, startAt: plus(new Date(), HOUR_MS), plannedEndAt: null, dailyRateCents: 7_900, depositCents: 0, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "HB-XY 1", make: "Opel", model: "Astra", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: plus(new Date(), -2 * DAY), place: "Bremen" },
    insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-UZ-0001", contactName: null, phone: null, email: null, street: "Merkweg 1", zip: "28195", city: "Bremen" },
    liability: { status: "CONFIRMED" },
    tariff: [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1_500 }],
  };
}

test("17 Geschlossener Unfallersatzfall: kein Start, kein Fortsetzen, kein Vertrag; Chip „gesperrt“; die Zeile bleibt gelistet (G14)", async () => {
  const w = await world("uz-ue-zu");
  await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  const v = await vehicle(w, { model: "Golf", fuel: "BENZIN" });
  const created = await createAccidentCase(w.tenantId, w.actor, caseInput(w, v.id));
  await closeCase(w.tenantId, created.case.id, w.actor, { reason: "Kunde hat abgesagt", acknowledgeWarnings: true });
  const b = await db.booking.findUniqueOrThrow({ where: { id: created.bookingId } });
  for (const viewer of [OWNER, DISPO, YARD]) {
    const c = await handoverCenter(w.tenantId, { kind: "PICKUP", filter: "heute", now: b.startAt, viewer });
    const row = rowOf(c, b.id);
    assert.ok(row, "bleibt gelistet");
    assert.equal(row!.action, null);
    assert.ok(row!.chips.some((x) => x.label === CASE_LOCKED_CHIP));
    assert.ok(row!.chips.some((x) => x.label === "Unfallersatz"));
  }
  // rein: auch START/CONTINUE und Vertragslink gesperrt, die Protokollansicht bleibt
  assert.equal(pickupRowAction(act({ caseClosed: true }), OWNER), null);
  assert.equal(pickupRowAction(act({ caseClosed: true, handovers: [H("PICKUP", "DRAFT")] }), YARD), null);
  assert.equal(pickupRowAction(act({ caseClosed: true, contractStatus: "DRAFT" }), DISPO), null);
  assert.equal(returnRowAction(act({ caseClosed: true, status: "ACTIVE", handovers: [H("PICKUP", "FINALIZED")] }), OWNER), null);
  assert.equal(pickupRowAction(act({ caseClosed: true, status: "ACTIVE", handovers: [H("PICKUP", "FINALIZED")] }), OWNER)?.label, "Übergabeprotokoll anzeigen");
});

test("18 Übergabe starten über die Datenbank (OWNER/DISPO/YARD) und Supportmodus: nur „Buchung öffnen“ – keine Assistenten- und Protokolllinks", async () => {
  const states = [act({}), act({ handovers: [H("PICKUP", "DRAFT")] }), act({ status: "ACTIVE", handovers: [H("PICKUP", "FINALIZED")] }), act({ contractStatus: "DRAFT" })];
  for (const s of states) assert.equal(pickupRowAction(s, SUPPORT), null);
  const running = act({ status: "ACTIVE", handovers: [H("PICKUP", "FINALIZED")] });
  for (const s of [running, { ...running, keyDrop: { status: "CUSTOMER_CONFIRMED" } }, { ...running, status: "RETURNED", handovers: [H("PICKUP", "FINALIZED"), H("RETURN", "FINALIZED")] }]) assert.equal(returnRowAction(s, SUPPORT), null);
  // Prüfbefund T2: Datenbankteil mit echten Aktionen – erst Gegenprobe als Inhaber, dann derselbe Abruf im Supportmodus
  const s = await signedWorld("uz-support");
  // Zeile einer offenen Übergabe in „Heute“ oder „Anstehend“ (Start „jetzt + 24 h“ fällt am 25-Stunden-Tag kurz nach Mitternacht noch auf heute)
  const openRow = async (bookingId: string, viewer: CenterViewer) => {
    for (const filter of ["heute", "anstehend"] as CenterFilter[]) {
      const row = rowOf(await handoverCenter(s.tenantId, { kind: "PICKUP", filter, viewer }), bookingId);
      if (row) return row;
    }
    return undefined;
  };
  // Abgleich 15.09: unterschriebener Vertrag, noch kein Entwurf → „Übergabe starten“ (Link auf die Startkarte, kein POST)
  for (const viewer of [OWNER, DISPO, YARD]) {
    assert.deepEqual((await openRow(s.bookingId, viewer))?.action, { label: "Übergabe starten", href: `/buchungen/${s.bookingId}/uebergabe` }, viewer.role);
  }
  assert.equal((await openRow(s.bookingId, SUPPORT))?.action, null, "Supportmodus: kein Start");
  await startHandover(s.tenantId, s.bookingId, "PICKUP", s.actor);
  assert.deepEqual((await openRow(s.bookingId, YARD))?.action, { label: "Übergabe fortsetzen", href: `/buchungen/${s.bookingId}/uebergabe` }, "nach dem Start: fortsetzen");
  const v2 = await vehicle(s);
  const draftContract = await db.booking.create({ data: { tenantId: s.tenantId, number: `UZ-VERTRAG-${uid()}`, vehicleId: v2.id, customerId: s.customerId, startAt: new Date(Date.now() + 2 * DAY), endAt: new Date(Date.now() + 4 * DAY), dailyRate: 49, deposit: 0 } });
  await ensureContractDraft(s.tenantId, draftContract.id, s.actor);
  const linkRe = /\/buchungen\/[^"]+\/(uebergabe|rueckgabe|vertrag)/;
  const ownerDraft = await handoverCenter(s.tenantId, { kind: "PICKUP", filter: "in_bearbeitung", viewer: OWNER });
  assert.deepEqual(ownerDraft.rows.map((r) => r.action?.href), [`/buchungen/${s.bookingId}/uebergabe`]);
  const ownerAhead = await handoverCenter(s.tenantId, { kind: "PICKUP", filter: "anstehend", viewer: OWNER });
  assert.equal(rowOf(ownerAhead, draftContract.id)?.action?.href, `/buchungen/${draftContract.id}/vertrag`);
  assert.equal((await openRow(s.bookingId, OWNER))?.action?.href, `/buchungen/${s.bookingId}/uebergabe`);
  assert.ok(linkRe.test(JSON.stringify(ownerAhead.rows)), "Gegenprobe: als Inhaber gibt es Assistenten- und Vertragslinks");
  for (const filter of ["in_bearbeitung", "anstehend"] as CenterFilter[]) {
    const c = await handoverCenter(s.tenantId, { kind: "PICKUP", filter, viewer: SUPPORT });
    assert.ok(c.rows.length > 0 && c.rows.every((r) => r.action === null && r.open.href === `/buchungen/${r.booking.id}`), filter);
    assert.ok(!linkRe.test(JSON.stringify(c.rows)), filter);
  }
});

test("19 Rollen und Seiten: requireSession ja; requireRole, requireFeature, Server Actions und Client-Komponenten nein", async () => {
  for (const p of ["src/app/(app)/uebergaben/page.tsx", "src/app/(app)/rueckgaben/page.tsx"]) {
    const s = await src(p);
    assert.match(s, /const \{ tenant, user, supportSession \} = await requireSession\(\);/, p);
    assert.match(s, /viewer: \{ role: user\.role, support: !!supportSession \}/, p);
    assert.ok(!/requireRole|requireFeature|["']use server["']|["']use client["']|\bactions\b/.test(s), p);
    assert.match(s, /searchParams: Promise<Record<string, string \| string\[\] \| undefined>>/, `${p}: kein PageProps (R2)`);
  }
  assert.ok(!existsSync(path.join(process.cwd(), "src/app/(app)/uebergaben/actions.ts")) && !existsSync(path.join(process.cwd(), "src/app/(app)/rueckgaben/actions.ts")));
  const view = await src("src/components/handover-center-view.tsx");
  assert.ok(!/["']use server["']|["']use client["']|Action\(|formAction/.test(view));
  assert.match(await src("src/app/(app)/uebergaben/page.tsx"), /title="Übergaben"[\s\S]*Anstehende, laufende und abgeschlossene Fahrzeugübergaben\./);
  assert.match(await src("src/app/(app)/rueckgaben/page.tsx"), /title="Rückgaben"[\s\S]*Geplante, laufende und abgeschlossene Fahrzeugrückgaben\./);
  // Hof: Übergabe fortsetzen ja, Vertrag nein (rein; Seiten im Rauchtest)
  assert.equal(pickupRowAction(act({ handovers: [H("PICKUP", "DRAFT")] }), YARD)?.label, "Übergabe fortsetzen");
  assert.equal(returnRowAction(act({ status: "ACTIVE", handovers: [H("PICKUP", "FINALIZED"), H("RETURN", "DRAFT")] }), YARD)?.label, "Rückgabe fortsetzen");
});

// ===========================================================================
// 20–23 Mandantentrennung, Suche, Sortierung, Seiten
// ===========================================================================

test("20 Mandantentrennung: fremde Buchungen fehlen in Liste, Kennzahlen, Suche und Zählern", async () => {
  const g = await pickups();
  const r = await returns();
  for (const f of centerFilters("PICKUP")) assert.ok(!ids(await center(g.w.tenantId, "PICKUP", f)).includes(g.foreign), f);
  for (const f of centerFilters("RETURN")) for (const x of r.foreign) assert.ok(!ids(await center(r.w.tenantId, "RETURN", f)).includes(x), f);
  const foreignPlate = (await db.booking.findUniqueOrThrow({ where: { id: g.foreign }, include: { vehicle: true } })).vehicle.plate;
  assert.equal((await center(g.w.tenantId, "PICKUP", "heute", { q: foreignPlate })).total, 0);
  const own = await center(g.other.tenantId, "PICKUP", "heute");
  assert.deepEqual(ids(own), [g.foreign]);
  assert.equal(own.kpis.today, 1);
  assert.equal((await navBadges(g.other.tenantId, [], NOW))["/uebergaben"]?.count, 1);
  // Quelltext (Prüfbefunde T6, Q1): verschachtelte Relationsfilter (some/none/every/is) beginnen mit tenantId: T, ebenso die
  // where-Bedingungen der nachgeladenen Relationen (handovers, contractAmendments, keyDropReturns)
  const lib = await src("src/lib/handover-center.ts");
  assert.ok(!/(some|none|every|is): \{ (?!tenantId: T\b)/.test(lib), "verschachtelte Filter mit tenantId");
  assert.ok(/(some|none): \{ tenantId: T/.test(lib));
  assert.ok(!/where: \{ (correctsId|status):/.test(lib), "Relationsauswahl mit tenantId");
  assert.match(lib, /handovers: \{ where: \{ tenantId: T, correctsId: null \}/);
  assert.match(lib, /contractAmendments: \{ where: \{ tenantId: T, status: "AGREED" \}/);
  assert.match(lib, /keyDropReturns: \{ where: \{ tenantId: T, status:/);
});

test("21 Suche: Kennzeichen, Name, Buchungsnummer, Fahrzeug, UP-Nummer – UND mit dem Filter, % entfernt, leer = kein Filter, Kennzahlen unverändert", async () => {
  const w = await world("uz-suche");
  const golf = await vehicle(w, { plate: "HB-RT 200", model: "Golf" });
  const hans = await db.customer.create({ data: { tenantId: w.tenantId, number: "K-00002", firstName: "Hans", lastName: "Beispiel", phone: "0170 999888" } });
  const a = await mk(w, { number: "SU-1001", vehicleId: golf.id, startAt: B("2026-10-20T12:00"), endAt: B("2026-10-22T12:00") });
  const b = await mk(w, { number: "SU-1002", customerId: hans.id, startAt: B("2026-10-20T13:00"), endAt: B("2026-10-22T13:00") });
  const draft = await rawHandover(w, a, "PICKUP", "DRAFT", { number: "UP-SU-0001" });
  const q = (filter: CenterFilter, text: string) => center(w.tenantId, "PICKUP", filter, { q: text });
  assert.deepEqual(ids(await q("heute", "hbrt200")), [a.id]);
  assert.deepEqual(ids(await q("heute", "HB RT 200")), [a.id]);
  assert.deepEqual(ids(await q("heute", "Erika Muster")), [a.id]);
  assert.deepEqual(ids(await q("heute", "Beispiel")), [b.id]);
  assert.deepEqual(ids(await q("heute", "SU-1002")), [b.id]);
  assert.deepEqual(ids(await q("heute", "Golf")), [a.id]);
  assert.deepEqual(ids(await q("heute", "0170 999")), [b.id], "Telefon (Ziffern)");
  assert.deepEqual((await q("in_bearbeitung", "UP-SU-0001")).rows.map((r) => r.key), [draft.id]);
  assert.deepEqual((await q("in_bearbeitung", "hbrt200")).rows.map((r) => r.key), [draft.id]);
  assert.equal((await q("in_bearbeitung", "Beispiel")).total, 0);
  assert.equal((await q("ueberfaellig", "hbrt200")).total, 0, "UND mit dem Filter");
  const pct = await q("heute", "%");
  assert.equal(pct.q, "");
  assert.equal(pct.total, 2);
  assert.equal((await q("heute", "  ")).total, 2);
  assert.deepEqual((await q("heute", "hbrt200")).kpis, (await q("heute", "")).kpis, "Kennzahlen unabhängig von der Suche");
  assert.equal((await q("heute", "x".repeat(200))).q.length, 80);
  // Prüfbefund Q2: Steuerzeichen (z. B. ?q=%00) führen nicht zu einem Datenbankfehler, sondern gelten als leere Suche
  const nul = await q("heute", "\u0000");
  const none = await q("heute", "");
  assert.deepEqual([nul.q, nul.total], ["", none.total]);
  assert.deepEqual(nul.kpis, none.kpis);
  assert.equal((await q("in_bearbeitung", "\u0000\u001f")).total, (await q("in_bearbeitung", "")).total);
  assert.deepEqual(ids(await q("heute", "\u0000Golf\u0007")), [a.id], "Steuerzeichen am Rand werden entfernt");
});

test("22 Sortierung: stabil bei gleichen Zeiten (number, id), überfällige Übergaben und Rückgaben älteste zuerst, offenes Mietende: überschritten → geplant → offen", async () => {
  const g = await pickups();
  const r = await returns();
  const a1 = await center(g.w.tenantId, "PICKUP", "anstehend");
  const a2 = await center(g.w.tenantId, "PICKUP", "anstehend");
  assert.deepEqual(ids(a1), ids(a2));
  const same = ids(a1).filter((x) => x === g.id.sameA || x === g.id.sameB);
  assert.deepEqual(same, [g.id.sameA, g.id.sameB], "gleiche Abholzeit: nach Buchungsnummer");
  // Auftrag Abschnitt 8: überfällig = älteste zuerst, bei Übergaben und Rückgaben
  const po = await center(g.w.tenantId, "PICKUP", "ueberfaellig");
  const poStarts = po.rows.map((x) => x.planned.at!.getTime());
  assert.deepEqual(poStarts, [...poStarts].sort((a, b) => a - b), "Übergaben überfällig: Abholtermin aufsteigend");
  assert.equal(ids(po)[0], g.id.d40);
  const open = ids(await center(r.w.tenantId, "RETURN", "offenes_ende"));
  const pos = (k: string) => open.indexOf(r.id[k]);
  assert.ok(pos("rAccPast") < pos("rAccToday") && pos("rAccPastDraft") < pos("rAccToday") && pos("rAccToday") < pos("rAccLater") && pos("rAccLater") < pos("rOpen") && pos("rAccLater") < pos("rOpenKd"), JSON.stringify(open));
  assert.deepEqual(open, ids(await center(r.w.tenantId, "RETURN", "offenes_ende")));
});

test("23 Paginierung: 13 Einträge, Seitengröße 10 – Seite 2 hat 3, zu große/ungültige Seiten werden geklammert, alle Seiten zusammen ohne Doppelte", async () => {
  const w = await world("uz-seiten");
  for (let i = 0; i < 13; i++) await mk(w, { startAt: new Date(B("2026-10-20T11:00").getTime() + i * 60_000), endAt: B("2026-10-23T11:00"), number: `PG-${String(i).padStart(2, "0")}` });
  const page = (p: unknown) => handoverCenter(w.tenantId, { kind: "PICKUP", filter: "heute", now: NOW, pageSize: 10, page: p, viewer: OWNER });
  const p1 = await page("1");
  assert.deepEqual([p1.total, p1.pages, p1.page, p1.rows.length], [13, 2, 1, 10]);
  const p2 = await page("2");
  assert.deepEqual([p2.page, p2.rows.length], [2, 3]);
  assert.equal((await page("9")).page, 2);
  assert.equal((await page("abc")).page, 1);
  const big = await page("9".repeat(30));
  assert.deepEqual([big.page, big.rows.length], [2, 3]);
  assert.equal((await page("-4")).page, 1);
  const all = [...ids(p1), ...ids(p2)];
  assert.equal(new Set(all).size, 13);
  assert.equal(parsePageParam("9".repeat(30)), 10_000);
  assert.equal(parsePageParam("abc"), 1);
  assert.equal(parsePageParam("0"), 1);
  assert.equal(parsePageParam(undefined), 1);
  // Seitengröße geklammert 10–100
  assert.equal((await handoverCenter(w.tenantId, { kind: "PICKUP", filter: "heute", now: NOW, pageSize: 1, viewer: OWNER })).pageSize, 10);
  assert.equal((await handoverCenter(w.tenantId, { kind: "PICKUP", filter: "heute", now: NOW, pageSize: 1000, viewer: OWNER })).pageSize, 100);
});

// ===========================================================================
// 25–26 Berliner Tagesgrenzen, Sommer- und Winterzeit
// ===========================================================================

test("25 Berliner Tagesgrenzen: 2026-10-19T22:30Z ist der 20.10.; Abholung 21:59Z ist überfällig; 23:59 heute gegen 00:01 morgen", async () => {
  const g = await pickups();
  const late = new Date("2026-10-19T22:30:00Z");
  assert.equal(zonedDayRange(late).start.toISOString(), "2026-10-19T22:00:00.000Z");
  assert.equal(B("2026-10-19T23:59").toISOString(), "2026-10-19T21:59:00.000Z");
  const o = await handoverCenter(g.w.tenantId, { kind: "PICKUP", filter: "ueberfaellig", now: late, pageSize: 100, viewer: OWNER });
  assert.ok(ids(o).includes(g.id.y2359));
  const h = await handoverCenter(g.w.tenantId, { kind: "PICKUP", filter: "heute", now: late, pageSize: 100, viewer: OWNER });
  assert.ok(ids(h).includes(g.id.t0000) && ids(h).includes(g.id.t2359) && !ids(h).includes(g.id.n0001) && !ids(h).includes(g.id.y2359));
  // rein: Status an der Grenze
  const b = centerBounds(NOW);
  assert.equal(pickupRowStatus({ startAt: B("2026-10-20T23:59"), handovers: [] }, b).label, "Heute 23:59");
  assert.match(pickupRowStatus({ startAt: B("2026-10-21T00:01"), handovers: [] }, b).label, /^Anstehend · 21\.10\.2026 00:01$/);
  const ret = (over: Partial<Parameters<typeof returnRowStatus>[0]>) => returnRowStatus({ status: "ACTIVE", rentalType: "STANDARD", endAt: null, agreedEndAt: null, handovers: [], keyDrop: null, ...over }, b);
  assert.equal(ret({ endAt: B("2026-10-20T08:00") }).label, "Überfällig seit 08:00", "nie „seit 0 Tagen“");
  assert.equal(ret({ endAt: B("2026-10-19T23:59") }).label, "Überfällig seit 1 Tag");
  assert.equal(ret({ endAt: B("2026-10-20T23:59") }).label, "Heute 23:59");
  assert.equal(ret({ endAt: B("2026-10-21T00:01") }).label, "Anstehend · 21.10.2026 00:01");
  assert.equal(ret({ endAt: B("2026-10-19T23:59"), agreedEndAt: B("2026-10-20T12:00") }).label, "Heute 12:00", "vereinbarte Verlängerung zählt");
  assert.equal(ret({ endAt: B("2026-10-19T23:59"), rentalType: "ACCIDENT_REPLACEMENT" }).label, "Geplantes Mietende überschritten");
  assert.equal(ret({ endAt: B("2026-10-19T23:59"), keyDrop: { status: "CUSTOMER_CONFIRMED", customerDropOffAt: B("2026-10-19T20:00") } }).detail, "Abgabe laut Kunde 19.10.2026, 20:00");
});

test("26 Sommer-/Winterzeit: 25.10.2026 hat 25 h, 28.03.2027 hat 23 h; 7-Tage-Fenster und „bis“ ohne 24-h-Pauschale", async () => {
  const d25 = zonedDayRange(new Date("2026-10-25T10:00:00Z"));
  assert.deepEqual([d25.start.toISOString(), d25.end.toISOString()], ["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"]);
  assert.equal(d25.end.getTime() - d25.start.getTime(), 25 * HOUR);
  const d28 = zonedDayRange(new Date("2027-03-28T10:00:00Z"));
  assert.deepEqual([d28.start.toISOString(), d28.end.toISOString()], ["2027-03-27T23:00:00.000Z", "2027-03-28T22:00:00.000Z"]);
  assert.equal(d28.end.getTime() - d28.start.getTime(), 23 * HOUR);
  assert.equal(resolveDayRange("", "2026-10-25").toExclusive!.toISOString(), "2026-10-25T23:00:00.000Z");
  assert.equal(parseDayParam("2027-03-28")!.toISOString(), "2027-03-27T23:00:00.000Z");
  // 7-Tage-Fenster ab 20.10. 10:00: endet am 28.10. 00:00 Berlin (Winterzeit) = 27.10. 23:00Z – nicht 27.10. 22:00Z (7 × 24 h)
  const b = centerBounds(NOW);
  assert.equal(b.end.toISOString(), "2026-10-20T22:00:00.000Z");
  assert.equal(b.soonEnd.toISOString(), "2026-10-27T23:00:00.000Z");
  assert.notEqual(b.soonEnd.getTime(), b.end.getTime() + 7 * DAY);
  const g = await pickups();
  assert.equal(B("2026-10-27T23:30").toISOString(), "2026-10-27T22:30:00.000Z");
  const soon = await center(g.w.tenantId, "PICKUP", "anstehend", { bis: "2026-10-27" });
  assert.ok(ids(soon).includes(g.id.w2330), "27.10. 23:30 Berlin liegt im Fenster");
  // Rückgaben an beiden Umstellungstagen (eigener Mandant)
  const w = await world("uz-dst");
  const mkR = (endAt: Date) => mk(w, { status: "ACTIVE", startAt: new Date("2026-10-01T10:00:00Z"), endAt });
  const r1 = await mkR(new Date("2026-10-25T22:30:00Z"));
  const r2 = await mkR(new Date("2026-10-25T23:00:00Z"));
  const r3 = await mkR(new Date("2027-03-28T21:30:00Z"));
  const r4 = await mkR(new Date("2027-03-28T22:00:00Z"));
  const at = (now: Date, filter: CenterFilter) => handoverCenter(w.tenantId, { kind: "RETURN", filter, now, pageSize: 100, viewer: OWNER });
  const n25 = new Date("2026-10-25T10:00:00Z");
  assert.ok(ids(await at(n25, "heute")).includes(r1.id));
  assert.ok(!ids(await at(n25, "heute")).includes(r2.id));
  assert.ok(ids(await at(n25, "anstehend")).includes(r2.id));
  const n28 = new Date("2027-03-28T10:00:00Z");
  assert.ok(ids(await at(n28, "heute")).includes(r3.id));
  assert.ok(!ids(await at(n28, "heute")).includes(r4.id));
  assert.ok(ids(await at(n28, "anstehend")).includes(r4.id));
});

// ===========================================================================
// 27 Deep Links, Adresse, Proxy
// ===========================================================================

test("27 Deep Links: Proxy schützt /rueckgaben und /uebergaben, /rueckgabe/<token> bleibt öffentlich; ungültiger Filter = heute; Adresse ohne Standardwerte", async () => {
  const r1 = proxy(new NextRequest("http://localhost/rueckgaben"));
  assert.equal(r1.status, 307);
  assert.ok((r1.headers.get("location") ?? "").endsWith("/login?weiter=%2Frueckgaben"), r1.headers.get("location") ?? "");
  const r2 = proxy(new NextRequest("http://localhost/uebergaben?filter=heute"));
  assert.equal(r2.status, 307);
  assert.ok((r2.headers.get("location") ?? "").endsWith("/login?weiter=%2Fuebergaben"));
  const pub = proxy(new NextRequest("http://localhost/rueckgabe/x"));
  assert.equal(pub.headers.get("location"), null);
  assert.equal(pub.status, 200);
  // Filter
  assert.equal(resolveFilter("PICKUP", "quatsch"), "heute");
  assert.equal(resolveFilter("PICKUP", "offenes_ende"), "heute", "Offenes Mietende gibt es nur bei Rückgaben");
  assert.equal(resolveFilter("RETURN", "offenes_ende"), "offenes_ende");
  assert.equal(resolveFilter("RETURN", ["heute"]), "heute");
  const g = await pickups();
  assert.equal((await center(g.w.tenantId, "PICKUP", "<script>" as CenterFilter)).filter, "heute");
  // Adresse
  const st = { filter: "anstehend" as CenterFilter, q: "golf", von: "2026-10-21", bis: "2026-10-25" };
  assert.equal(centerHref("PICKUP", { filter: "heute", q: "", von: "", bis: "" }), "/uebergaben");
  assert.equal(centerHref("RETURN", { filter: "heute", q: "", von: "", bis: "" }, { seite: 1 }), "/rueckgaben");
  assert.equal(centerHref("PICKUP", st, { seite: 2 }), "/uebergaben?filter=anstehend&q=golf&von=2026-10-21&bis=2026-10-25&seite=2");
  assert.equal(centerHref("PICKUP", st, { filter: "heute" }), "/uebergaben?q=golf", "Datum gilt nur für seinen Filter, Seite zurück");
  assert.equal(centerHref("RETURN", st, { q: "" }), "/rueckgaben?filter=anstehend&von=2026-10-21&bis=2026-10-25");
  assert.equal(centerHref("RETURN", st, { filter: "abgeschlossen" }), "/rueckgaben?filter=abgeschlossen&q=golf");
  assert.equal(centerHref("RETURN", st, { von: "", bis: "" }), "/rueckgaben?filter=anstehend&q=golf");
  assert.equal(centerHref("PICKUP", st, { filter: "anstehend", q: "", von: "", bis: "2026-10-27" }), "/uebergaben?filter=anstehend&bis=2026-10-27");
});

// ===========================================================================
// 28 Mobile Darstellung und keine Logikänderung
// ===========================================================================

test("28 Mobil und keine Logikänderung: Karten bis xl, Tabelle ab xl, Aktionen einspaltig unter sm; handover-center.ts nur lesend", async () => {
  const view = await src("src/components/handover-center-view.tsx");
  assert.match(view, /<ul className="xl:hidden divide-y divide-line-soft">/);
  assert.match(view, /<div className="hidden xl:block overflow-x-auto">/);
  assert.match(view, /<table className="w-full text-\[13\.5px\] table-fixed">/);
  assert.match(view, /<caption className="sr-only">/);
  assert.match(view, /grid grid-cols-1 sm:grid-cols-2 gap-2/);
  assert.match(view, /!whitespace-normal/);
  assert.match(view, /<nav aria-label="Filter" className="flex flex-wrap gap-2">/);
  assert.match(view, /aria-current=\{f === c\.filter \? "page" : undefined\}/);
  assert.match(view, /<Form action=\{c\.path\} role="search"/);
  assert.match(view, /maxLength=\{80\}/);
  assert.match(view, /min=\{DAY_PARAM_MIN\} max=\{DAY_PARAM_MAX\}/);
  assert.match(view, /<nav aria-label="Seiten"/);
  assert.match(view, /Alle Prüfungen \(Vertrag, Fahrer, Verfügbarkeit, Unterschriften\) laufen im Assistenten; aus dieser Liste wird nichts ausgelöst\./);
  // Prüfbefunde aus der Oberflächenprüfung
  assert.match(view, /const formKey = `\$\{c\.filter\}\|\$\{c\.q\}\|\$\{c\.von\}\|\$\{c\.bis\}`;/, "UI-1: Formulare am Adresszustand");
  assert.match(view, /<Form action=\{c\.path\} role="search" key=\{`suche\|\$\{formKey\}`\}/);
  assert.match(view, /<Form action=\{c\.path\} key=\{`zeitraum\|\$\{formKey\}`\}/);
  assert.ok(!/<ul role="status"/.test(view), "UI-2: Rolle status nicht auf der Liste");
  assert.match(view, /<div role="status" className="text-xs text-ink-2 bg-amber-soft/);
  assert.equal(view.match(/\[overflow-wrap:anywhere\]/g)?.length, 2, "UI-3: Suchbegriff im Kartentitel und im Leerzustand bricht um");
  assert.match(view, /grey: "text-ink-2" \};/, "UI-5: Hinweistexte mit ausreichendem Kontrast");
  assert.match(view, /w-\[176px\]">Aktionen/, "UI-4: Platz für die Hinweisspalte");
  assert.match(view, /"Suche und Zeitraum zurücksetzen" : c\.q \? "Suche löschen" : "Zeitraum zurücksetzen"/, "UI-6");
  assert.ok(!view.includes('"Filter zurücksetzen"'));
  const lib = await src("src/lib/handover-center.ts");
  const imports = [...lib.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  for (const bad of ["@/lib/handovers", "@/lib/returns", "@/lib/contracts", "@/lib/amendments", "@/lib/key-drop", "@/lib/invoices"]) assert.ok(!imports.includes(bad), bad);
  assert.ok(!/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$transaction|\$executeRaw/.test(lib), "keine schreibenden Aufrufe");
  assert.match(lib, /import \{ SOON_DAYS \} from "@\/lib\/dashboard";/);
  assert.ok(!/86_?400_?000/.test(lib), "keine 24-h-Rechnung");
});
