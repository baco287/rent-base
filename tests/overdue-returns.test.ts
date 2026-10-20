// Befehl 29.7 – Korrektur vor dem Deployment: eine einheitliche Kennzahl „Rückgabe überfällig“ für /heute (Dashboard und
// Menü-Zähler „Heute“), die Rückgabezentrale (Filter, Kennzahl) und den Menü-Zähler „Rückgaben“. Vereinbarte, noch nicht
// unterschriebene Verlängerung zählt (Verkürzung wirkt operativ nicht), vom Kunden gemeldete Schlüsselbox-Rückgaben und
// Unfallersatz (auch mit offenem Mietende) sind nie überfällig. Andere Kennzahlen (Rückgaben heute, Schlüsselbox prüfen,
// geplantes Mietende überschritten) bleiben eigene Kennzahlen mit eigenen Zeitfenstern. Festes „jetzt“, keine Wanduhr.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { agreedEndOf, isOverdue, isReturnOverdue } from "../src/lib/bookings";
import { loadDashboard } from "../src/lib/dashboard";
import { DASHBOARD_CASE_STEPS } from "../src/lib/accident-replacement";
import { navBadges } from "../src/lib/nav-badges";
import { handoverCenter, returnsOverdueWhere, type CenterViewer } from "../src/lib/handover-center";
import { parseLocalDateTime } from "../src/lib/time";
import { createWorld, purgeTenants, type World } from "./helpers";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

/** Dienstag, 20.10.2026, 10:00 Berliner Zeit */
const NOW = new Date("2026-10-20T08:00:00Z");
const B = (s: string) => parseLocalDateTime(s)!;
const OWNER: CenterViewer = { role: "OWNER", support: false };
let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();

async function world(label: string): Promise<World> {
  const w = await createWorld(label, { startInDays: 60 });
  tenants.push(w.tenantId);
  return w;
}
/** Laufende (bzw. stornierte/zurückgegebene) Testmiete mit eigenem Fahrzeug und festen Zeitpunkten – nur Testdaten. */
async function rental(w: World, endAt: Date | null, over: { status?: string; rentalType?: string } = {}) {
  const v = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UE ${uid()}`, make: "VW", model: "Polo", groupId: w.groupId, dailyRate: 49, deposit: 0, requiredLicenseClass: "B" } as never });
  const status = over.status ?? "ACTIVE";
  const startAt = B("2026-10-10T10:00");
  return db.booking.create({
    data: {
      tenantId: w.tenantId, customerId: w.customerId, vehicleId: v.id, number: `UE-${uid()}`, status, rentalType: over.rentalType ?? "STANDARD",
      startAt, endAt, actualPickupAt: startAt, actualReturnAt: status === "RETURNED" ? endAt : null, dailyRate: 49, deposit: 0,
    },
  });
}
type Rental = Awaited<ReturnType<typeof rental>>;
/** Vereinbarte, noch nicht unterschriebene Änderung des Mietendes (AGREED) an einem unterschriebenen Vertrag – nur Testdaten. */
async function agreedEnd(w: World, b: Rental, newEndAt: Date) {
  const c = await db.rentalContract.create({ data: { tenantId: w.tenantId, bookingId: b.id, number: `MV-UE-${uid()}`, status: "SIGNED", customerId: b.customerId, vehicleId: b.vehicleId, customerSnapshot: {}, vehicleSnapshot: {}, priceSnapshot: {}, startAt: b.startAt, endAt: b.endAt, signedAt: new Date() } });
  await db.contractAmendment.create({ data: { tenantId: w.tenantId, contractId: c.id, bookingId: b.id, idempotencyKey: `ue-${uid()}`, status: "AGREED", agreedAt: new Date(), agreedChannel: "PHONE", newEndAt } });
}
async function keyDrop(w: World, b: Rental, status: "AUTHORIZED" | "CUSTOMER_CONFIRMED") {
  await db.keyDropReturn.create({ data: { tenantId: w.tenantId, bookingId: b.id, status, agreedById: w.userId, agreedByName: "Test Mitarbeiter", location: "Hof", expectedReturnAt: NOW, settingsSnapshot: {}, recipientName: "Erika Muster", customerDropOffAt: status === "CUSTOMER_CONFIRMED" ? B("2026-10-16T09:00") : null } });
}

type Grid = { a: World; b: World; c: World; d: World; id: Record<string, string> };
let grid: Promise<Grid> | null = null;
function setup(): Promise<Grid> {
  grid ??= (async () => {
    const id: Record<string, string> = {};
    // Mandant A: alle Fälle
    const a = await world("ue-a");
    const R = async (key: string, endAt: Date | null, over: { status?: string; rentalType?: string } = {}) => { const r = await rental(a, endAt, over); id[key] = r.id; return r; };
    const ACC = { rentalType: "ACCIDENT_REPLACEMENT" };
    await R("sOver", B("2026-10-18T10:00"));
    await R("sToday08", B("2026-10-20T08:00"));
    await R("sLater", B("2026-10-20T18:00"));
    await agreedEnd(a, await R("sExt", B("2026-10-19T10:00")), B("2026-10-20T18:00"));
    await agreedEnd(a, await R("sExtPast", B("2026-10-17T10:00")), B("2026-10-19T10:00"));
    await agreedEnd(a, await R("sShort", B("2026-10-20T20:00")), B("2026-10-19T12:00"));
    await keyDrop(a, await R("kdOver", B("2026-10-15T10:00")), "CUSTOMER_CONFIRMED");
    await keyDrop(a, await R("kdAuth", B("2026-10-16T10:00")), "AUTHORIZED");
    // vereinbarte Verlängerung über heute hinaus: weder heute noch überfällig, im 7-Tage-Horizont „bald“ zum vereinbarten Ende
    await agreedEnd(a, await R("sExtLong", B("2026-10-19T10:00")), B("2026-10-22T10:00"));
    await R("accPast", B("2026-10-19T10:00"), ACC);
    await R("accToday", B("2026-10-20T15:00"), ACC);
    await R("accOpen", null, ACC);
    await R("cancelled", B("2026-10-18T10:00"), { status: "CANCELLED" });
    await R("returned", B("2026-10-18T10:00"), { status: "RETURNED" });
    // Mandant B: fremd, eine überfällige Rückgabe
    const b = await world("ue-b");
    id.bOver = (await rental(b, B("2026-10-18T10:00"))).id;
    // Mandant C: nur Unfallersatz mit überschrittenem Planende und gemeldete Schlüsselbox-Rückgabe
    const c = await world("ue-c");
    id.cAcc = (await rental(c, B("2026-10-19T10:00"), ACC)).id;
    const cKd = await rental(c, B("2026-10-18T10:00"));
    await keyDrop(c, cKd, "CUSTOMER_CONFIRMED");
    id.cKd = cKd.id;
    // Unfallersatz mit überschrittenem Planende und gemeldeter Schlüsselbox: Kontrolle ausstehend (Schlüsselbox hat Vorrang)
    const cAccKd = await rental(c, B("2026-10-19T10:00"), ACC);
    await keyDrop(c, cAccKd, "CUSTOMER_CONFIRMED");
    id.cAccKd = cAccKd.id;
    // Mandant D: nur eine vereinbarte Verlängerung (Ende gestern, vereinbart bis heute 18:00)
    const d = await world("ue-d");
    const dExt = await rental(d, B("2026-10-19T10:00"));
    await agreedEnd(d, dExt, B("2026-10-20T18:00"));
    id.dExt = dExt.id;
    return { a, b, c, d, id };
  })();
  return grid;
}

const sorted = (xs: string[]) => [...xs].sort();
/** Menge „Rückgabe überfällig“ im Speicher – isReturnOverdue über alle Buchungen des Mandanten. */
async function overdueInMemory(tenantId: string, now: Date) {
  const rows = await db.booking.findMany({ where: { tenantId }, select: { id: true, status: true, endAt: true, rentalType: true, contractAmendments: { where: { tenantId, status: "AGREED" }, select: { newEndAt: true } }, keyDropReturns: { where: { tenantId, status: "CUSTOMER_CONFIRMED" }, select: { id: true } } } });
  return sorted(rows.filter((b) => isReturnOverdue({ status: b.status, endAt: b.endAt, agreedEndAt: agreedEndOf(b), rentalType: b.rentalType, keyDropReported: b.keyDropReturns.length > 0 }, now)).map((b) => b.id));
}
/** Dieselbe Menge in Prisma (Rückgabezentrale, Menü-Zähler). */
async function overdueInDb(tenantId: string, now: Date) {
  return sorted((await db.booking.findMany({ where: returnsOverdueWhere(tenantId, now), select: { id: true } })).map((b) => b.id));
}
const ids = (g: Grid, keys: string[]) => sorted(keys.map((k) => g.id[k]!));
const overdueNumberIn = (title: string | undefined) => Number(/(\d+) Rückgaben? überfällig/.exec(title ?? "")?.[1] ?? 0);
const rueckgabenOverdueIn = (title: string | undefined) => Number(/· (\d+) überfällig/.exec(title ?? "")?.[1] ?? 0);

// Erwartete Mengen „Rückgabe überfällig“ in Mandant A zu festen Zeitpunkten
const EXPECTED: [string, Date, string[]][] = [
  ["19.10. 09:59", B("2026-10-19T09:59"), ["sOver", "kdAuth"]],
  ["20.10. 10:00 (jetzt)", NOW, ["sOver", "sToday08", "sExtPast", "kdAuth"]],
  ["20.10. 18:00 (Grenze, noch nicht)", B("2026-10-20T18:00"), ["sOver", "sToday08", "sExtPast", "kdAuth"]],
  ["20.10. 18:00 + 1 ms", new Date(B("2026-10-20T18:00").getTime() + 1), ["sOver", "sToday08", "sExtPast", "kdAuth", "sLater", "sExt"]],
  ["21.10. 00:00", B("2026-10-21T00:00"), ["sOver", "sToday08", "sExtPast", "kdAuth", "sLater", "sExt", "sShort"]],
];

test("1 Zentrale Definition: isReturnOverdue (Speicher) und returnsOverdueWhere (Prisma) liefern zu jedem Zeitpunkt dieselbe Menge", async () => {
  const g = await setup();
  for (const [label, at, keys] of EXPECTED) {
    const mem = await overdueInMemory(g.a.tenantId, at);
    assert.deepEqual(mem, ids(g, keys), `${label}: Speicher`);
    assert.deepEqual(await overdueInDb(g.a.tenantId, at), mem, `${label}: Prisma = Speicher`);
  }
  // nie überfällig: Unfallersatz (überschritten, heute, offen), gemeldete Schlüsselbox, Storno, zurückgegeben
  const late = await overdueInMemory(g.a.tenantId, B("2026-12-31T10:00"));
  for (const k of ["accPast", "accToday", "accOpen", "kdOver", "cancelled", "returned"]) assert.ok(!late.includes(g.id[k]!), `${k} nie überfällig`);
  assert.ok(late.includes(g.id.sExtLong!), "Verlängerung bis 22.10.: danach überfällig");
  // Mandantentrennung der Prisma-Fassung: jeder Mandant nur seine eigene Menge
  assert.deepEqual(await overdueInDb(g.b.tenantId, NOW), [g.id.bOver], "fremder Mandant: eigene Menge");
  assert.ok(!(await overdueInDb(g.a.tenantId, B("2026-12-31T10:00"))).includes(g.id.bOver!), "Mandant A enthält keine fremde Buchung");
  // die operative Belegung (isOverdue) bleibt unverändert: Unfallersatz und gemeldete Schlüsselbox belegen das Fahrzeug weiter bis „jetzt“
  assert.equal(isOverdue({ status: "ACTIVE", endAt: B("2026-10-19T10:00") }, NOW), true, "Belegung: Unfallersatz-Planende überschritten bleibt belegt bis jetzt");
  assert.equal(isReturnOverdue({ status: "ACTIVE", endAt: B("2026-10-19T10:00"), rentalType: "ACCIDENT_REPLACEMENT", keyDropReported: false }, NOW), false);
  assert.equal(isReturnOverdue({ status: "ACTIVE", endAt: B("2026-10-19T10:00"), rentalType: "STANDARD", keyDropReported: true }, NOW), false);
  assert.equal(isReturnOverdue({ status: "ACTIVE", endAt: B("2026-10-19T10:00"), agreedEndAt: B("2026-10-20T18:00"), rentalType: "STANDARD", keyDropReported: false }, NOW), false);
  assert.equal(isReturnOverdue({ status: "ACTIVE", endAt: B("2026-10-20T20:00"), agreedEndAt: B("2026-10-19T12:00"), rentalType: "STANDARD", keyDropReported: false }, NOW), false, "Verkürzung wirkt operativ nicht");
  assert.equal(isReturnOverdue({ status: "ACTIVE", endAt: null, rentalType: "STANDARD", keyDropReported: false }, NOW), false, "offenes Ende nie");
});

test("2 Dashboard /heute: „Rückgabe überfällig“ genau die zentrale Menge; Verlängerung nach operativem Ende; Unfallersatz als Disposition, nicht überfällig", async () => {
  const g = await setup();
  const dash = await loadDashboard(g.a.tenantId, { now: NOW });
  const expected = await overdueInDb(g.a.tenantId, NOW);
  assert.equal(dash.counts.overdueReturns, expected.length);
  const overdueTasks = dash.tasks.filter((t) => t.key.startsWith("return-overdue-"));
  assert.deepEqual(sorted(overdueTasks.map((t) => t.key.replace("return-overdue-", ""))), expected, "Aufgaben „Rückgabe überfällig“ = zentrale Menge");
  assert.ok(overdueTasks.every((t) => t.group === "OVERDUE" && t.title.startsWith("Rückgabe überfällig · ")));
  // vereinbarte, abgelaufene Verlängerung: überfällig seit dem vereinbarten Ende, mit Hinweis
  const extPast = dash.tasks.find((t) => t.key === `return-overdue-${g.id.sExtPast}`)!;
  assert.equal(extPast.at?.getTime(), B("2026-10-19T10:00").getTime());
  assert.match(extPast.detail, /sollte 19\.10\.2026 um 10:00 zurück sein · 1 Tag/);
  assert.match(extPast.detail, /Verlängerung bis 19\.10\.2026,? 10:00 vereinbart – Unterschrift ausstehend/);
  // vereinbarte künftige Verlängerung: Rückgabe heute um 18:00 (statt überfällig seit gestern), mit Hinweis
  const ext = dash.tasks.find((t) => t.key === `return-${g.id.sExt}`)!;
  assert.deepEqual([ext.group, ext.at?.getTime(), ext.title.startsWith("Rückgabe 18:00 · ")], ["TODAY", B("2026-10-20T18:00").getTime(), true]);
  assert.match(ext.detail, /Verlängerung bis 20\.10\.2026,? 18:00 vereinbart – Unterschrift ausstehend/);
  // Verkürzung wirkt operativ nicht: Rückgabe heute 20:00
  assert.equal(dash.tasks.find((t) => t.key === `return-${g.id.sShort}`)?.at?.getTime(), B("2026-10-20T20:00").getTime());
  // Unfallersatz mit überschrittenem Planende: Dispositionsaufgabe in „Heute“, nie „Rückgabe überfällig“
  const acc = dash.tasks.find((t) => t.key === `return-planned-exceeded-${g.id.accPast}`)!;
  assert.deepEqual([acc.group, acc.status, acc.area], ["TODAY", "Disposition", "RENTAL"]);
  assert.match(acc.title, /^Geplantes Mietende überschritten · /);
  assert.match(acc.detail, /Unfallersatz · .* geplant 19\.10\.2026,? 10:00 \(Disposition\)/);
  for (const k of ["accPast", "accToday", "accOpen", "kdOver", "sExt", "sShort", "cancelled", "returned"]) {
    assert.ok(!dash.tasks.some((t) => t.key === `return-overdue-${g.id[k]}` || (t.href === `/buchungen/${g.id[k]}` && t.title.startsWith("Rückgabe überfällig"))), `${k}: keine Aufgabe „Rückgabe überfällig“`);
  }
  // gemeldete Schlüsselbox bleibt „Kontrolle ausstehend“
  assert.equal(dash.tasks.find((t) => t.key === `keydrop-${g.id.kdOver}`)?.status, "Kontrolle ausstehend");
  // eigene Kennzahl „Rückgaben heute“ (ganzer Kalendertag nach operativem Ende, ohne gemeldete Schlüsselbox): 08:00, 15:00 (Unfallersatz), 18:00, 18:00 (verlängert), 20:00
  assert.equal(dash.counts.returnsToday, 5);
  const retEvents = dash.events.filter((e) => e.kind === "RETURN");
  assert.deepEqual(sorted(retEvents.map((e) => e.bookingId)), ids(g, ["sToday08", "accToday", "sLater", "sExt", "sShort"]));
  // Hof-Sicht: dieselbe Kennzahl, Dispositionsaufgabe sichtbar
  const yard = await loadDashboard(g.a.tenantId, { now: NOW, hideAccidentBilling: true });
  assert.equal(yard.counts.overdueReturns, expected.length);
  assert.ok(yard.tasks.some((t) => t.key === `return-planned-exceeded-${g.id.accPast}`));
  // nur Unfallersatz und gemeldete Schlüsselbox: keine überfällige Rückgabe, aber beide Aufgaben vorhanden
  const c = await loadDashboard(g.c.tenantId, { now: NOW });
  assert.equal(c.counts.overdueReturns, 0);
  assert.ok(!c.tasks.some((t) => t.group === "OVERDUE" && t.area === "RENTAL"));
  assert.ok(c.tasks.some((t) => t.key === `return-planned-exceeded-${g.id.cAcc}`) && c.tasks.some((t) => t.key === `keydrop-${g.id.cKd}`));
  // Unfallersatz mit gemeldeter Schlüsselbox: nur „Kontrolle ausstehend“, keine Dispositionsaufgabe (wie openEndExceeded der Zentrale)
  assert.ok(c.tasks.some((t) => t.key === `keydrop-${g.id.cAccKd}`) && !c.tasks.some((t) => t.key === `return-planned-exceeded-${g.id.cAccKd}`));
  const cOpen = await handoverCenter(g.c.tenantId, { kind: "RETURN", filter: "offenes_ende", now: NOW, pageSize: 100, viewer: OWNER });
  assert.equal(cOpen.kpis.openEndExceeded, c.tasks.filter((t) => t.key.startsWith("return-planned-exceeded-")).length);
  // die Fall-Hinweise des Unfallersatz-Moduls lassen „Planende überschritten“ (OVERDUE) bewusst aus – sonst stünde der Fall doppelt auf /heute
  assert.equal(DASHBOARD_CASE_STEPS.has("OVERDUE"), false);
});

test("2b Dashboard: Unfallersatz-Planende heute schon verstrichen = Disposition (Rückgabe heute zählt, nicht überfällig); „bald“ nach vereinbartem Ende", async () => {
  const g = await setup();
  const at = new Date(B("2026-10-20T18:00").getTime() + 1);
  const dash = await loadDashboard(g.a.tenantId, { now: at });
  const exceeded = dash.tasks.filter((t) => t.key.startsWith("return-planned-exceeded-"));
  assert.deepEqual(sorted(exceeded.map((t) => t.key.replace("return-planned-exceeded-", ""))), ids(g, ["accPast", "accToday"]));
  const open = await handoverCenter(g.a.tenantId, { kind: "RETURN", filter: "offenes_ende", now: at, pageSize: 100, viewer: OWNER });
  assert.equal(exceeded.length, open.kpis.openEndExceeded, "dieselbe Menge wie „davon … geplantes Mietende überschritten“ der Zentrale");
  assert.ok(!dash.tasks.some((t) => t.key === `return-${g.id.accToday}` || t.key === `return-overdue-${g.id.accToday}`));
  assert.equal(dash.events.find((e) => e.kind === "RETURN" && e.bookingId === g.id.accToday)?.at.getTime(), B("2026-10-20T15:00").getTime());
  assert.equal(dash.counts.returnsToday, 5, "Rückgaben heute bleibt der ganze Kalendertag");
  // 7-Tage-Horizont: Verlängerung bis 22.10. erscheint als „Rückgabe bald“ zum vereinbarten Ende; „Überfällig“ unabhängig vom Horizont
  const d7 = await loadDashboard(g.a.tenantId, { now: NOW, horizon: "7" });
  const long = d7.tasks.find((t) => t.key === `return-${g.id.sExtLong}`)!;
  assert.deepEqual([long.group, long.at?.getTime(), long.status], ["SOON", B("2026-10-22T10:00").getTime(), "Rückgabe bald"]);
  assert.match(long.detail, /Verlängerung bis 22\.10\.2026,? 10:00 vereinbart – Unterschrift ausstehend/);
  const today = await loadDashboard(g.a.tenantId, { now: NOW });
  const overdueKeys = (d: typeof today) => sorted(d.tasks.filter((t) => t.group === "OVERDUE" && t.area === "RENTAL").map((t) => t.key));
  assert.deepEqual(overdueKeys(d7), overdueKeys(today));
  assert.ok(!today.tasks.some((t) => t.key === `return-${g.id.sExtLong}`), "ohne Horizont nicht unter „Heute“");
});

test("3 Rückgabezentrale: Filter „Überfällig“ und Kennzahl = zentrale Menge; Unfallersatz unter „Offenes Mietende“", async () => {
  const g = await setup();
  for (const [label, at] of EXPECTED) {
    const c = await handoverCenter(g.a.tenantId, { kind: "RETURN", filter: "ueberfaellig", now: at, pageSize: 100, viewer: OWNER });
    const expected = await overdueInMemory(g.a.tenantId, at);
    assert.deepEqual(sorted(c.rows.map((r) => r.booking.id)), expected, `${label}: Liste`);
    assert.equal(c.kpis.overdue, expected.length, `${label}: Kennzahl`);
    assert.ok(c.rows.every((r) => r.status.label.startsWith("Überfällig")), `${label}: Zeilenstatus`);
  }
  const open = await handoverCenter(g.a.tenantId, { kind: "RETURN", filter: "offenes_ende", now: NOW, pageSize: 100, viewer: OWNER });
  assert.equal(open.rows.find((r) => r.booking.id === g.id.accPast)?.status.label, "Geplantes Mietende überschritten");
});

test("4 Menü-Zähler: „Heute“ und „Rückgaben“ zeigen dieselbe Überfällig-Zahl wie Dashboard und Rückgabezentrale; Unfallersatz, Schlüsselbox und Verlängerung färben nicht rot", async () => {
  const g = await setup();
  for (const [label, at] of EXPECTED) {
    const [badges, dash, center] = await Promise.all([
      navBadges(g.a.tenantId, [], at),
      loadDashboard(g.a.tenantId, { now: at }),
      handoverCenter(g.a.tenantId, { kind: "RETURN", filter: "ueberfaellig", now: at, pageSize: 100, viewer: OWNER }),
    ]);
    const n = (await overdueInDb(g.a.tenantId, at)).length;
    assert.deepEqual([overdueNumberIn(badges["/heute"]?.title), rueckgabenOverdueIn(badges["/rueckgaben"]?.title), dash.counts.overdueReturns, center.kpis.overdue], [n, n, n, n], `${label}: eine Zahl überall`);
    if (n > 0) assert.deepEqual([badges["/heute"]?.tone, badges["/rueckgaben"]?.tone], ["bad", "bad"], `${label}: rot`);
  }
  // jetzt: 0 Abholungen, 4 Rückgaben heute ab jetzt (18:00, 18:00 verlängert, 20:00 verkürzt wirkungslos, 15:00 Unfallersatz), 4 überfällig
  const now = await navBadges(g.a.tenantId, [], NOW);
  assert.deepEqual([now["/heute"]?.count, now["/heute"]?.title], [8, "0 Abholungen heute · 4 Rückgaben heute · 4 Rückgaben überfällig"]);
  // nur Unfallersatz (Planende überschritten) und gemeldete Schlüsselbox: kein /heute-Zähler, „Rückgaben“ nur heute (Kontrolle ausstehend), nicht rot
  const c = await navBadges(g.c.tenantId, [], NOW);
  assert.equal(c["/heute"], undefined, "Unfallersatz-Planende und gemeldete Schlüsselbox zählen nicht als überfällig");
  assert.deepEqual([c["/rueckgaben"]?.count, c["/rueckgaben"]?.tone, c["/rueckgaben"]?.title], [2, "warn", "2 Rückgaben heute/überfällig"], "nur die beiden gemeldeten Schlüsselbox-Rückgaben (Kontrolle ausstehend)");
  // nur vereinbarte Verlängerung bis heute 18:00: Rückgabe heute, nicht überfällig
  const d = await navBadges(g.d.tenantId, [], NOW);
  assert.deepEqual([d["/heute"]?.count, d["/heute"]?.tone, d["/heute"]?.title], [1, "warn", "0 Abholungen heute · 1 Rückgabe heute"]);
  assert.equal((await loadDashboard(g.d.tenantId, { now: NOW })).counts.overdueReturns, 0);
  // fremder Mandant: eigene Zahl, beeinflusst A nicht
  const b = await navBadges(g.b.tenantId, [], NOW);
  assert.deepEqual([b["/heute"]?.title, b["/heute"]?.tone], ["0 Abholungen heute · 0 Rückgaben heute · 1 Rückgabe überfällig", "bad"]);
});
