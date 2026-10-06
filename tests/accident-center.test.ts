// Befehl 29 Phase G: Unfallersatz-Zentrale – Navigation und Rechte, Kennzahlen, Filter/Suche/Seiten, operative Darstellung,
// gebündelter Finanzstand (Parität zur Fallakte) und feste Zahl an Abfragen unabhängig von der Fallzahl.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { caseFinancials, caseFinancialsMany, closeCase, createAccidentCase, createFollowUp, type CreateAccidentCaseInput } from "../src/lib/accident-replacement";
import { accidentCenter, centerFilters, centerRank, resolveCenterFilter, type AccidentCenter } from "../src/lib/accident-center";
import { caseFileAccess } from "../src/lib/accident-case-file";
import { hiddenNavPaths, tenantFeatures } from "../src/lib/features";
import { globalSearch } from "../src/lib/search";
import { createAccidentInvoiceDraft, finalizeInvoice } from "../src/lib/invoices";
import { recordInvoicePayment } from "../src/lib/payments";
import { recordInvoiceAdjustment } from "../src/lib/invoice-adjustments";
import { createCancellationDraft, finalizeCounterDocument } from "../src/lib/counter-documents";
import { recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { finalizeHandover, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { getStorage } from "../src/lib/storage";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { answerAll, photo, sign } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-ue-g-"));
  getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const HOUR = 3600_000, DAY = 24 * HOUR;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
let seq = 0;
const nonce = () => `ue-g-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const src = (p: string) => readFile(path.join(process.cwd(), p), "utf8");
const sp = (s: string) => s.replace(/ /g, " ");

async function world(label: string, enabled = true): Promise<World> {
  await ready;
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });
  if (enabled) await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  return w;
}
const vehicle = async (w: World, plate?: string) => (await db.vehicle.create({ data: { tenantId: w.tenantId, plate: plate ?? `HB-UG ${nonce().slice(-5).toUpperCase()}`, make: "VW", model: "Golf", groupId: w.groupId, fuel: "BENZIN", mileage: 1000, dailyRate: 59, kmIncludedPerDay: 100, extraKmRate: 0.2, tankCapacityLiters: 50, requiredLicenseClass: "B" } })).id;
function caseInput(w: World, vehicleId: string, over: Partial<CreateAccidentCaseInput> = {}): CreateAccidentCaseInput {
  return {
    nonce: nonce(), customerId: w.customerId, vehicleId, startAt: plus(new Date(), HOUR), plannedEndAt: null, dailyRateCents: 7_900, depositCents: 0, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "HB-XY 1", make: "Opel", model: "Astra", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: plus(new Date(), -2 * DAY), place: "Bremen" },
    insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-G-0001", contactName: null, phone: null, email: null, street: "Merkweg 1", zip: "28195", city: "Bremen" },
    liability: { status: "CONFIRMED" },
    tariff: [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1_500 }],
    ...over,
  };
}
async function signed(w: World, bookingId: string, deposit = 0) {
  const c = await db.rentalContract.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId } });
  const bk = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: null, deposit, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 500, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: null }, w.actor);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return c.id;
}
async function handover(w: World, bookingId: string, type: "PICKUP" | "RETURN", contractId?: string) {
  const bk = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { vehicleId: true } });
  const ww = { ...w, bookingId, vehicleId: bk.vehicleId };
  const h = await startHandover(w.tenantId, bookingId, type, w.actor);
  await updateHandoverDraft(w.tenantId, h.id, { mileage: type === "PICKUP" ? 1100 : 1200, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, h.id, cat);
  await answerAll(ww, h.id);
  await sign(ww, h.id);
  if (type === "PICKUP") await verifyAllDriversForPickup(w.tenantId, w.actor, h.id, contractId!);
  await finalizeHandover(w.tenantId, h.id, w.actor);
}
async function running(w: World, ago: number, over: Partial<CreateAccidentCaseInput> = {}, deposit = 0) {
  const r = await createAccidentCase(w.tenantId, w.actor, caseInput(w, over.vehicleId ?? await vehicle(w), over));
  const cid = await signed(w, r.bookingId, deposit);
  await handover(w, r.bookingId, "PICKUP", cid);
  await db.booking.update({ where: { id: r.bookingId }, data: { actualPickupAt: new Date(Date.now() - ago) } });
  return { ...r, caseId: r.case.id };
}
async function returned(w: World, ago: number, over: Partial<CreateAccidentCaseInput> = {}, deposit = 0) {
  const r = await running(w, ago, over, deposit);
  if (deposit > 0) await recordDepositReceived(w.tenantId, w.actor, { bookingId: r.bookingId, amount: deposit, method: "CASH", occurredAt: new Date(Date.now() - ago + HOUR) });
  await handover(w, r.bookingId, "RETURN");
  return r;
}
async function insurerInvoice(w: World, caseId: string) {
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId, recipientRole: "INSURER", nonce: nonce() });
  const v = await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  return { id: invoice.id, grossCents: Math.round(Number(v.grossTotal) * 100) };
}
const ids = (c: AccidentCenter) => c.rows.map((r) => r.caseNumber).sort();
const numberOf = async (caseId: string) => (await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: caseId }, select: { caseNumber: true } })).caseNumber;

// ---------------------------------------------------------------------------
// Gemeinsamer Bestand: reserviert, laufend, zurückgegeben (abzurechnen), Rechnung teilbezahlt mit Kürzung, storniert, geschlossen
// ---------------------------------------------------------------------------
type Fixture = { w: World; other: World; A: string; B: string; C: string; D: string; E: string; F: string; G: string; H: string; bPlate: string; dInvoice: { id: string; grossCents: number }; dPaidCents: number };
let fixture: Promise<Fixture> | null = null;
function setup(): Promise<Fixture> {
  fixture ??= (async () => {
    const w = await world("ug-main");
    const other = await world("ug-fremd");
    const karakus = await db.customer.create({ data: { tenantId: w.tenantId, number: "K-00002", firstName: "Sezer", lastName: "Karakus", street: "Weg 1", zip: "28195", city: "Bremen", country: "DE", phone: "0421 555", email: "sk@example.test", birthDate: new Date("1990-01-01"), idType: "PERSONALAUSWEIS", idNumber: "L01X00T48", idValidUntil: new Date("2031-01-01"), licenseNumber: "B072RRE2I56", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2035-01-01") } });
    // A: reserviert, Wiedervorlage überfällig
    const A = await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w), { startAt: plus(new Date(), 3 * DAY) }));
    await createFollowUp(w.tenantId, A.case.id, w.actor, { title: "Gutachter nachfassen", dueAt: plus(new Date(), -2 * DAY) });
    // B: läuft (offenes Ende), Wiedervorlage heute
    const bPlate = `HB-UG ${nonce().slice(-4).toUpperCase()}9`;
    const B = await running(w, 3 * DAY, { vehicleId: await vehicle(w, bPlate), damaged: { plate: "HB-DMG 42", make: "BMW", model: "320d", drivable: false, damageKind: "REPAIR" } });
    await createFollowUp(w.tenantId, B.caseId, w.actor, { title: "Versicherung anrufen", dueAt: new Date() });
    // C: zurückgegeben, noch nicht abgerechnet; andere Versicherung
    const C = await returned(w, 4 * DAY, { insurer: { name: "HUK-COBURG Versicherung", claimNumber: "HUK-555", contactName: null, phone: null, email: null, street: "Weg 2", zip: "96450", city: "Coburg" } });
    // D: Kunde Karakus, Rechnung an die Versicherung, Teilzahlung, Kürzung
    const D = await returned(w, 5 * DAY, { customerId: karakus.id });
    const dInvoice = await insurerInvoice(w, D.caseId);
    const dPaidCents = 20_000;
    await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: dInvoice.id, amount: "200,00", method: "BANK_TRANSFER", paidAt: new Date() });
    await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: dInvoice.id, reasonKind: "TARIFF", amountCents: 5_000, decidedAt: new Date(), note: "Tarifhöhe" });
    // E: Rechnung storniert → wieder abzurechnen; eigene Schadennummer
    const E = await returned(w, 3 * DAY, { insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "KS-777-STORNO", contactName: null, phone: null, email: null, street: "Merkweg 1", zip: "28195", city: "Bremen" } });
    const eInv = await insurerInvoice(w, E.caseId);
    const st = await createCancellationDraft(w.tenantId, eInv.id, w.actor);
    await finalizeCounterDocument(w.tenantId, st.id, w.actor, { confirmed: true, reason: "falscher Empfänger" });
    // F: geschlossen
    const F = await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w)));
    await closeCase(w.tenantId, F.case.id, w.actor, { reason: "Kunde hat abgesagt", acknowledgeWarnings: true });
    // G: läuft mit geplantem Ende in der Zukunft; H: läuft, geplantes Ende überschritten
    const G = await running(w, DAY, { plannedEndAt: plus(new Date(), 5 * DAY) });
    const H = await running(w, 6 * DAY, { plannedEndAt: plus(new Date(), 2 * DAY) });
    await db.booking.update({ where: { id: H.bookingId }, data: { endAt: plus(new Date(), -DAY) } });
    // fremder Mandant mit eigenem Fall (darf nie erscheinen)
    await createAccidentCase(other.tenantId, other.actor, caseInput(other as never, await vehicle(other), { insurer: { name: "FREMD-VERSICHERUNG", claimNumber: "FREMD-999", contactName: null, phone: null, email: null, street: "x", zip: "1", city: "y" } }));
    return { w, other, A: A.case.id, B: B.caseId, C: C.caseId, D: D.caseId, E: E.caseId, F: F.case.id, G: G.caseId, H: H.caseId, bPlate, dInvoice, dPaidCents };
  })();
  return fixture;
}

// ---------------------------------------------------------------------------
// 1–9: Navigation und Rechte
// ---------------------------------------------------------------------------

test("1–9: Menüpunkt nur mit Modul (serverseitig ausgeblendet), Direktaufruf gesperrt, Voll- und operative Sicht, fremder Mandant, Supportmodus", async () => {
  const f = await setup();
  const off = await world("ug-off", false);
  // 1/2: Sidebar-Eintrag existiert und wird ohne Modul über hiddenPaths entfernt (serverseitig gerendert)
  const sidebar = await src("src/components/sidebar.tsx");
  assert.match(sidebar, /\{ href: "\/buchungen", label: "Buchungen", icon: "doc" \},[\s\S]{0,200}\{ href: "\/unfallersatz", label: "Unfallersatz", icon: "shield" \},\s*\{ href: "\/rechnungen"/);
  assert.match(sidebar, /case "shield":/);
  assert.ok(hiddenNavPaths(await tenantFeatures(off.tenantId)).includes("/unfallersatz"));
  assert.ok(!hiddenNavPaths(await tenantFeatures(f.w.tenantId)).includes("/unfallersatz"));
  // 3: Direktaufruf ohne Modul – Seite und Modul-Layout verlangen requireFeature
  assert.match(await src("src/app/(app)/unfallersatz/page.tsx"), /await requireFeature\("ACCIDENT_REPLACEMENT"\)/);
  assert.match(await src("src/app/(app)/unfallersatz/layout.tsx"), /requireFeature\("ACCIDENT_REPLACEMENT"\)/);
  // 4/5: Inhaber und Disposition: Vollsicht
  assert.equal(caseFileAccess("OWNER"), "FULL");
  assert.equal(caseFileAccess("DISPO"), "FULL");
  const fullView = await accidentCenter(f.w.tenantId, { access: "FULL" });
  assert.ok(fullView.rows.every((r) => r.full !== null));
  assert.ok(fullView.kpis.toInvoice !== null && fullView.kpis.receivablesCents !== null && fullView.kpis.followUpsDue !== null);
  // 6/7: Hof: reduzierte Sicht, Finanz-/Versicherungsdaten serverseitig nicht geladen
  assert.equal(caseFileAccess("YARD"), "OPERATIONAL");
  const yard = await accidentCenter(f.w.tenantId, { access: "OPERATIONAL" });
  assert.ok(yard.rows.length > 0 && yard.rows.every((r) => r.full === null));
  assert.deepEqual([yard.kpis.toInvoice, yard.kpis.receivablesCents, yard.kpis.receivablesCases, yard.kpis.followUpsDue], [null, null, null, null]);
  assert.deepEqual(centerFilters("OPERATIONAL"), ["offen", "laufend", "uebergabe", "abgeschlossen"]);
  assert.equal(resolveCenterFilter("rechnung_offen", "OPERATIONAL"), "offen", "kaufmännischer Filter für den Hof nicht erreichbar");
  const yardJson = JSON.stringify(yard);
  for (const secret of ["MERKVERSICHERUNG", "HUK-COBURG", "SN-G-0001", "HUK-555", "HB-DMG 42", "grossCents", "economicOpenCents", "reducedCents", "Wiedervorlage", "Haftung", "Schadennummer"]) assert.ok(!yardJson.includes(secret), `Hof-Sicht enthält ${secret}`);
  assert.ok(yard.rows.every((r) => r.steps.every((s) => ["CONTRACT", "PICKUP", "OPEN_END", "OVERDUE", "RETURN_DUE", "RETURN_DRAFT", "CLOSED", "CANCELLED"].includes(s.code))));
  // Hof-Suche findet über Versicherung/Schadennummer/beschädigtes Kennzeichen nichts
  for (const q of ["MERKVERSICHERUNG", "SN-G-0001", "HB-DMG"]) assert.equal((await accidentCenter(f.w.tenantId, { access: "OPERATIONAL", q })).total, 0, `Hof-Suche ${q}`);
  // 8: fremder Mandant sieht keinen Fall dieses Mandanten
  const otherView = await accidentCenter(f.other.tenantId, { access: "FULL" });
  assert.equal(otherView.kpis.open, 1);
  assert.ok(!JSON.stringify(otherView).includes("MERKVERSICHERUNG"));
  // 9: Supportmodus läuft als operative Sicht (Seite wählt OPERATIONAL bei aktiver Supportsession; Rolle dort YARD)
  assert.match(await src("src/app/(app)/unfallersatz/page.tsx"), /const access = supportSession \? "OPERATIONAL" : caseFileAccess\(user\.role\);/);
  // Anlage-Knopf nur in der Vollsicht
  assert.match(await src("src/app/(app)/unfallersatz/page.tsx"), /\{full && <Link href="\/unfallersatz\/neu"[^>]*>\+ Unfallersatzfall<\/Link>\}/);
});

// ---------------------------------------------------------------------------
// 10–18 und 44: Kennzahlen
// ---------------------------------------------------------------------------

test("10–18/44: offene Fälle, laufende Mieten, reserviert, abzurechnen, offene Forderungen (Storno berücksichtigt, Kürzung mindert nicht), fällige Wiedervorlagen; Standardbuchungen zählen nicht", async () => {
  const f = await setup();
  const c = await accidentCenter(f.w.tenantId, { access: "FULL" });
  // offen: A, B, C, D, E, G, H (F geschlossen); die Standardbuchung der Welt zählt nicht
  assert.equal(c.kpis.open, 7);
  assert.ok(await db.booking.count({ where: { tenantId: f.w.tenantId, rentalType: "STANDARD" } }) >= 1);
  assert.equal(c.kpis.running, 3, "B, G, H");
  assert.equal(c.kpis.reserved, 1, "A");
  assert.equal(c.kpis.toInvoice, 2, "C nicht abgerechnet, E storniert");
  // offene Forderung: nur D (E storniert = 0); Kürzung 50 € mindert sie nicht
  assert.equal(c.kpis.receivablesCents, f.dInvoice.grossCents - f.dPaidCents);
  assert.equal(c.kpis.receivablesCases, 1);
  // Wiedervorlagen: A überfällig, B heute
  assert.equal(c.kpis.followUpsDue, 2);
  // Kennzahlen gelten unabhängig von Filter und Suche
  assert.deepEqual((await accidentCenter(f.w.tenantId, { access: "FULL", filter: "laufend", q: "Karakus" })).kpis, c.kpis);
});

// ---------------------------------------------------------------------------
// 19–33: Filter, Suche, Seiten
// ---------------------------------------------------------------------------

test("19–33: Schnellfilter, Suche (Fallnummer, Kunde, Kennzeichen, Versicherung, Schadennummer), kombiniert, Seiten mit Filter, keine fremden Treffer", async () => {
  const f = await setup();
  const n = { A: await numberOf(f.A), B: await numberOf(f.B), C: await numberOf(f.C), D: await numberOf(f.D), E: await numberOf(f.E), F: await numberOf(f.F), G: await numberOf(f.G), H: await numberOf(f.H) };
  const view = (filter: string, q?: string) => accidentCenter(f.w.tenantId, { access: "FULL", filter, q });
  assert.deepEqual(ids(await view("laufend")), [n.B, n.G, n.H].sort());
  assert.deepEqual(ids(await view("uebergabe")), [n.A]);
  assert.deepEqual(ids(await view("abzurechnen")), [n.C, n.E].sort());
  assert.deepEqual(ids(await view("rechnung_offen")), [n.D]);
  assert.deepEqual(ids(await view("kuerzung")), [n.D]);
  assert.deepEqual(ids(await view("wiedervorlage")), [n.A, n.B].sort());
  assert.deepEqual(ids(await view("abgeschlossen")), [n.F]);
  assert.equal((await view("abgeschlossen")).rows[0].status, "CLOSED");
  // Suche
  assert.deepEqual(ids(await view("offen", n.C)), [n.C], "Fallnummer");
  assert.deepEqual(ids(await view("offen", "Karakus")), [n.D], "Kunde");
  assert.deepEqual(ids(await view("offen", f.bPlate.replace(/\s/g, ""))), [n.B], "Ersatzfahrzeug-Kennzeichen (normalisiert)");
  assert.deepEqual(ids(await view("offen", "HB DMG 42")), [n.B], "beschädigtes Kennzeichen");
  assert.deepEqual(ids(await view("offen", "HUK-COBURG")), [n.C], "Versicherung");
  assert.deepEqual(ids(await view("offen", "KS-777")), [n.E], "Schadennummer");
  // kombiniert: Suche + Filter
  assert.deepEqual(ids(await view("abzurechnen", "HUK")), [n.C]);
  assert.equal((await view("rechnung_offen", "HUK")).total, 0);
  // Filterzähler berücksichtigen die Suche
  assert.equal((await view("offen", "HUK")).counts.abzurechnen, 1);
  // fremder Mandant: weder Fallnummer noch Versicherung/Schadennummer des anderen Mandanten
  const foreignNo = (await db.accidentReplacementCase.findFirstOrThrow({ where: { tenantId: f.other.tenantId } })).caseNumber;
  for (const q of ["FREMD-VERSICHERUNG", "FREMD-999"]) assert.equal((await view("offen", q)).total, 0, `fremde Suche ${q}`);
  const sameNumber = await view("alle" as never, foreignNo);
  assert.ok(sameNumber.rows.every((r) => r.id !== undefined && !JSON.stringify(r).includes("FREMD")));
  assert.equal((await accidentCenter(f.other.tenantId, { access: "FULL", q: n.D })).rows.filter((r) => r.caseNumber === n.D && r.customer.name.includes("Karakus")).length, 0);
  assert.equal((await accidentCenter(f.other.tenantId, { access: "FULL", q: "Karakus" })).total, 0);
  assert.equal((await accidentCenter(f.other.tenantId, { access: "FULL", q: "HUK-555" })).total, 0);
});

test("32: Seiten bleiben gefiltert (serverseitig, kein Nachladen aller Fälle im Browser)", async () => {
  const w = await world("ug-pages");
  for (let i = 0; i < 13; i++) await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w), { startAt: plus(new Date(), (i + 2) * DAY) }));
  const p1 = await accidentCenter(w.tenantId, { access: "FULL", filter: "uebergabe", pageSize: 10, page: 1 });
  const p2 = await accidentCenter(w.tenantId, { access: "FULL", filter: "uebergabe", pageSize: 10, page: 2 });
  assert.deepEqual([p1.total, p1.pages, p1.rows.length, p2.rows.length, p2.page], [13, 2, 10, 3, 2]);
  assert.equal(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size, 13);
  assert.equal(p2.filter, "uebergabe");
  // Seite über dem Ende → letzte Seite
  assert.equal((await accidentCenter(w.tenantId, { access: "FULL", filter: "uebergabe", pageSize: 10, page: 9 })).page, 2);
  // reservierte Fälle in naher Zukunft zuerst (Datumsreihenfolge innerhalb gleicher Priorität)
  assert.ok(p1.rows.every((r, i) => i === 0 || p1.rows[i - 1].booking.startAt <= r.booking.startAt));
  // URL-Zustand in der Seite: filter, q, seite (Phase H: zusätzlich aufgaben für die Wiedervorlagen-Arbeitsliste)
  const page = await src("src/app/(app)/unfallersatz/page.tsx");
  assert.match(page, /const merged: Record<string, string \| number \| null> = \{ filter: c\.filter === "offen" \? null : c\.filter, q: c\.q \|\| null, seite: null, aufgaben: c\.tasks\?\.view \?\? null, \.\.\.over \};/);
  assert.match(page, /accidentCenter\(tenant\.id, \{ access, filter: one\(sp\.filter\), q: one\(sp\.q\), page, tasks: one\(sp\.aufgaben\), userId: user\.id \}\)/);
});

// ---------------------------------------------------------------------------
// 34–43: operative Darstellung
// ---------------------------------------------------------------------------

test("34–43: offenes/geplantes/überschrittenes Ende, abzurechnen, Teilzahlung, Kürzung, Kaution, Priorisierung, abgeschlossen ruhig", async () => {
  const f = await setup();
  const c = await accidentCenter(f.w.tenantId, { access: "FULL" });
  const row = (id: string) => c.rows.find((r) => r.id === id)!;
  // 34: offenes Ende – seit Übergabe, Miettage nach zentraler Tageslogik, kein Enddatum
  const B = row(f.B);
  assert.deepEqual([B.period.kind, B.period.until, B.period.days], ["OPEN", null, 4]);
  // 35: geplantes Ende
  assert.equal(row(f.G).period.kind, "PLANNED");
  assert.equal(row(f.G).mainStatus.label, "Miete läuft");
  // 36: geplantes Ende überschritten – fachlich präzise, nicht „Rückgabe überfällig“
  const H = row(f.H);
  assert.equal(H.period.kind, "PLANNED_EXCEEDED");
  assert.equal(H.mainStatus.label, "Geplantes Mietende überschritten");
  assert.equal(H.lead?.short, "Rückgabe oder Mietdauer klären");
  assert.ok(!JSON.stringify(H).includes("Rückgabe überfällig"));
  // 37: zurückgegeben → abzurechnen
  const C = row(f.C);
  assert.equal(C.mainStatus.label, "Abzurechnen");
  assert.equal(C.lead?.short, "Schlussrechnung erstellen");
  assert.equal(C.action?.href, `/unfallersatz/${f.C}?tab=abrechnung`);
  // 38/39: Teilzahlung und Kürzung (Kürzung als weiterer Punkt, mindert den offenen Betrag nicht)
  const D = row(f.D);
  assert.equal(D.mainStatus.label, "Teilbezahlt");
  assert.equal(sp(D.lead!.short), `${sp(fmt(f.dInvoice.grossCents - f.dPaidCents))} offen (teilbezahlt)`);
  assert.ok(D.more >= 1 && D.steps.some((s) => s.code === "REDUCTION_OPEN" && s.short === "Kürzung prüfen"));
  assert.equal(D.full?.billing.reducedCents, 5_000);
  assert.equal(D.full?.billing.economicOpenCents, f.dInvoice.grossCents - f.dPaidCents);
  // 42: überfällige Wiedervorlage zuerst, dann kritisch, Wiedervorlage heute, abzurechnen, Rechnung offen, …
  assert.equal(c.rows[0].id, f.A, "A (überfällige Wiedervorlage) steht oben");
  assert.equal(row(f.A).lead?.short, "Wiedervorlage überfällig");
  const order = c.rows.map((r) => r.id);
  assert.ok(order.indexOf(f.H) < order.indexOf(f.B), "kritisch (Ende überschritten) vor Wiedervorlage heute");
  assert.ok(order.indexOf(f.B) < order.indexOf(f.C), "Wiedervorlage heute vor abzurechnen");
  assert.ok(order.indexOf(f.C) < order.indexOf(f.D), "abzurechnen vor Rechnung offen");
  assert.ok(order.indexOf(f.D) < order.indexOf(f.G), "Rechnung offen vor laufender Miete");
  assert.deepEqual([centerRank([], { status: "ACTIVE", startAt: new Date() }, new Date()), centerRank([], { status: "RESERVED", startAt: plus(new Date(), 5 * DAY) }, new Date())], [6, 7]);
  // 43: abgeschlossen ruhig – kein Schritt, keine Aktion, grauer Zustand
  const closed = await accidentCenter(f.w.tenantId, { access: "FULL", filter: "abgeschlossen" });
  const F = closed.rows.find((r) => r.id === f.F)!;
  assert.deepEqual([F.status, F.lead, F.action, F.mainStatus.label, F.mainStatus.tone, F.steps.length], ["CLOSED", null, null, "Abgeschlossen", "grey", 0]);
  assert.ok(!c.rows.some((r) => r.id === f.F), "abgeschlossene Fälle nicht zwischen aktiven");
});

test("40/41: Kaution prüfen bzw. Kautionsauszahlung offen als nächster Schritt (nur bei Handlungsbedarf, keine Kautionsspalte)", async () => {
  const w = await world("ug-kaution");
  const r = await returned(w, 2 * DAY, {}, 300);
  let row = (await accidentCenter(w.tenantId, { access: "FULL" })).rows.find((x) => x.id === r.caseId)!;
  assert.ok(row.steps.some((s) => s.code === "DEPOSIT_OPEN" && s.short === "Kaution prüfen"));
  await settleDeposit(w.tenantId, w.actor, { bookingId: r.bookingId, releaseAmount: 300, method: "CASH", occurredAt: new Date() });
  row = (await accidentCenter(w.tenantId, { access: "FULL" })).rows.find((x) => x.id === r.caseId)!;
  assert.ok(!row.steps.some((s) => s.code === "DEPOSIT_OPEN"));
  assert.ok(row.steps.some((s) => s.code === "DEPOSIT_PAYOUT_OPEN" && s.short === "Kautionsauszahlung offen"));
  // Hof: keine Kautionshinweise
  const yardRow = (await accidentCenter(w.tenantId, { access: "OPERATIONAL" })).rows.find((x) => x.id === r.caseId)!;
  assert.ok(!yardRow.steps.some((s) => s.code.startsWith("DEPOSIT")));
});

// ---------------------------------------------------------------------------
// Gebündelter Finanzstand: Parität zur Fallakte; feste Zahl an Abfragen (100 Fälle)
// ---------------------------------------------------------------------------

test("Parität: caseFinancialsMany liefert für jeden Fall exakt denselben Finanzstand wie caseFinancials", async () => {
  const f = await setup();
  const bookings = await db.booking.findMany({ where: { tenantId: f.w.tenantId, rentalType: "ACCIDENT_REPLACEMENT" }, select: { id: true, actualPickupAt: true, actualReturnAt: true } });
  const many = await caseFinancialsMany(f.w.tenantId, bookings);
  for (const b of bookings) assert.deepEqual(many.get(b.id), await caseFinancials(f.w.tenantId, b.id), `Buchung ${b.id}`);
});

test("Performance: feste Zahl an Datenbankoperationen – 100 zusätzliche Fälle mit Wiedervorlagen ändern sie nicht", async () => {
  const f = await setup();
  let ops = 0;
  const counted = db.$extends({ query: { $allModels: { async $allOperations({ args, query }) { ops++; return query(args); } } } }) as unknown as typeof db;
  const measure = async (tenantId: string) => { ops = 0; const t = Date.now(); const c = await accidentCenter(tenantId, { access: "FULL", client: counted }); return { ops, ms: Date.now() - t, open: c.kpis.open }; };
  const before = await measure(f.w.tenantId);
  // 100 weitere Fälle (eigene Fahrzeuge), jeder zehnte mit Wiedervorlage
  const many = await world("ug-perf");
  const base = await measure(many.tenantId);
  const vehicles = await Promise.all(Array.from({ length: 100 }, (_, i) => vehicle(many, `HB-PF ${String(i).padStart(3, "0")}`)));
  for (let i = 0; i < 100; i++) {
    const r = await createAccidentCase(many.tenantId, many.actor, caseInput(many, vehicles[i], { startAt: plus(new Date(), (i % 20 + 1) * HOUR) }));
    if (i % 10 === 0) await createFollowUp(many.tenantId, r.case.id, many.actor, { title: `WV ${i}`, dueAt: new Date() });
  }
  const after = await measure(many.tenantId);
  console.log(`Zentrale: Fallbestand (7 offene, Rechnungen/Zahlungen/Kürzung/Storno) ${before.ops} Operationen in ${before.ms} ms; leer ${base.ops}; 100 Fälle ${after.ops} Operationen in ${after.ms} ms`);
  assert.equal(after.open, 100);
  // feste Obergrenze unabhängig von der Fallzahl (kein „je Fall weitere Abfragen“)
  assert.ok(after.ops <= before.ops, `100 Fälle: ${after.ops} Operationen, Bestand mit 7 Fällen: ${before.ops}`);
  assert.ok(before.ops <= 12, `höchstens 12 Operationen (${before.ops})`);
});

const fmt = (cents: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(cents / 100);

test("30: globale Suche – Ergebnistyp „Unfallersatz“ nur mit Modul, Vollsicht über Schadennummer/Versicherung, Hof nicht, nur eigener Mandant", async () => {
  const f = await setup();
  const off = await world("ug-search-off", false);
  const nD = await numberOf(f.D);
  const group = async (tenantId: string, role: string, q: string) => (await globalSearch(tenantId, role, q, { types: ["accident"] })).groups.find((g) => g.type === "accident");
  const hit = await group(f.w.tenantId, "DISPO", nD);
  assert.equal(hit?.label, "Unfallersatz");
  assert.equal(hit?.hits[0].href, `/unfallersatz/${f.D}`);
  assert.match(hit!.hits[0].context, /Karakus/);
  assert.ok((await group(f.w.tenantId, "OWNER", "KS-777"))?.hits.some((h) => h.id === f.E), "Schadennummer (Vollsicht)");
  assert.ok((await group(f.w.tenantId, "DISPO", "HB DMG 42"))?.hits.some((h) => h.id === f.B), "beschädigtes Kennzeichen (Vollsicht)");
  assert.equal(await group(f.w.tenantId, "YARD", "KS-777"), undefined, "Hof: keine Treffer über die Schadennummer");
  const yardHit = await group(f.w.tenantId, "YARD", nD);
  assert.ok(yardHit && !/MERKVERSICHERUNG|Schaden-Nr|beschädigt/.test(JSON.stringify(yardHit)), "Hof: Treffer ohne Versicherungsdaten");
  assert.equal(await group(f.other.tenantId, "DISPO", "Karakus"), undefined, "fremder Mandant");
  assert.equal(await group(off.tenantId, "DISPO", "UE-2026"), undefined, "ohne Modul kein Ergebnistyp");
});
