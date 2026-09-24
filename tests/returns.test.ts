// Integrationstest Phase 6: Rückgabe mit Vorher-/Nachher-Vergleich, Zusatzkosten, Return-PDF und E-Mail.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { addNewDamage, answerChecklist, finalizeHandover, getHandoverContentHash, getHandoverState, registerPhoto, removeNewDamage, saveHandoverSignature, startHandover, updateHandoverDraft, updateNewDamage, verifyHandover } from "../src/lib/handovers";
import { addManualCharge, buildComparison, confirmProposal, getReturnComparison, removeCharge } from "../src/lib/returns";
import { DEFAULT_RETURN_CHECKLIST, itemsForDrive } from "../src/lib/checklists";
import { ensureReturnDocument, loadSketchSvg, readDocumentFile } from "../src/lib/documents";
import { loadHandoverDocumentData } from "../src/lib/document-data";
import { runReturnFollowUp } from "../src/lib/followup";
import { renderHandoverPdf } from "../src/lib/pdf/handover-pdf";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { sendHandoverDocuments } from "../src/lib/rental-mail";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { DomainError, isImmutableError, sha256 } from "../src/lib/integrity";
import { buildStorageKey, getStorage, type StorageDriver } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { photoJpeg, signaturePng } from "./pdf-fixtures";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-return-"));
  storage = getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

class FakeTransport implements MailTransport {
  readonly name = "fake";
  sent: MailMessage[] = [];
  fail: unknown = null;
  async send(m: MailMessage) { if (this.fail) throw this.fail; this.sent.push(m); return { messageId: `<fake-${this.sent.length}@test>` }; }
}

const pngDataUrl = async () => `data:image/png;base64,${Buffer.from(await signaturePng(600, 200)).toString("base64")}`;

async function photo(w: World, handoverId: string, category: string, handoverDamageId?: string, real = false) {
  const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  if (real) {
    const jpeg = await photoJpeg(category);
    await storage.put(storageKey, jpeg, "image/jpeg");
    return registerPhoto(w.tenantId, w.actor, { handoverId, handoverDamageId, storageKey, category, contentType: "image/jpeg", sizeBytes: jpeg.length, checksum: sha256(jpeg) });
  }
  return registerPhoto(w.tenantId, w.actor, { handoverId, handoverDamageId, storageKey, category, contentType: "image/jpeg", sizeBytes: 250_000, checksum: sha256(storageKey) });
}
async function sign(w: World, handoverId: string, real = false) {
  return saveHandoverSignature(w.tenantId, w.actor, handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: real ? await pngDataUrl() : fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, handoverId), ipAddress: null, userAgent: "test" });
}
async function answerAll(w: World, handoverId: string, overrides: Record<string, { result: string; note?: string }> = {}) {
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId } });
  await answerChecklist(w.tenantId, handoverId, items.map((i) => {
    const o = overrides[i.itemKey];
    if (o) return { itemId: i.id, result: o.result, note: o.note ?? null };
    return { itemId: i.id, result: i.answerType === "TEXT" ? (i.itemKey === "keys" || i.itemKey === "keys_returned" ? "2" : "") : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" };
  }));
}

/** Miete unterwegs: Vertrag abgeschlossen (0,25 €/km, 200 km/Tag, Voll/Voll, ggf. Literpreis), Übergabe mit Altschaden und Vorschaden finalisiert. */
async function activeWorld(label: string, opts: { fuelPrice?: number | null; fuelPolicy?: string; vehicle?: Record<string, unknown>; real?: boolean } = {}) {
  await ready;
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { mileage: 45_000, ...(opts.vehicle ?? {}) } });
  const old = await db.damage.create({ data: { tenantId: w.tenantId, vehicleId: w.vehicleId, view: "LEFT", posX: 0.3, posY: 0.5, kind: "SCRATCH", severity: "MINOR", description: "Kratzer Fahrertür, vor der Miete", status: "OPEN" } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: (opts.fuelPolicy ?? "FULL_TO_FULL") as "FULL_TO_FULL", fuelPolicyNote: opts.fuelPolicy === "OTHER" ? "Halb voll zurück" : null, fuelPricePerLiter: opts.fuelPrice === undefined ? 1.8 : opts.fuelPrice, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: opts.real ? await pngDataUrl() : fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 45_210, fuelLevelEighths: 7, batteryPercent: 82 });
  const fresh = await addNewDamage(w.tenantId, p.id, { view: "FRONT", posX: 0.5, posY: 0.4, kind: "CHIP", severity: "MINOR", description: "Steinschlag Haube, bei Übergabe" });
  await photo(w, p.id, "DAMAGE", fresh.id, opts.real);
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, p.id, cat, undefined, opts.real);
  await answerAll(w, p.id);
  await sign(w, p.id, opts.real);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  return { w, contractId: c.id, pickupId: p.id, oldDamageId: old.id };
}

test("Rückgabe startet nur bei Unterwegs mit Vertrag und finalisierter Übergabe, ein Entwurf je Buchung, Mandantentrennung", async () => {
  await ready;
  const plain = await createWorld("ret-noctr");
  tenants.push(plain.tenantId);
  const c = await ensureContractDraft(plain.tenantId, plain.bookingId, plain.actor);
  await db.booking.update({ where: { id: plain.bookingId }, data: { status: "ACTIVE" } });
  await assert.rejects(() => startHandover(plain.tenantId, plain.bookingId, "RETURN", plain.actor), /keinen abgeschlossenen Mietvertrag/);
  await db.booking.update({ where: { id: plain.bookingId }, data: { status: "RESERVED" } });
  await saveContractSignature(plain.tenantId, plain.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(plain.tenantId, c.id) });
  await finalizeContract(plain.tenantId, c.id);
  await db.booking.update({ where: { id: plain.bookingId }, data: { status: "ACTIVE" } });
  await assert.rejects(() => startHandover(plain.tenantId, plain.bookingId, "RETURN", plain.actor), /kein abgeschlossenes Übergabeprotokoll/, "ohne Übergabe keine Rückgabe");

  const a = await activeWorld("ret-start");
  const other = await createWorld("ret-other");
  tenants.push(other.tenantId);
  await assert.rejects(() => startHandover(other.tenantId, a.w.bookingId, "RETURN", other.actor), /Buchung nicht gefunden/);
  const r1 = await startHandover(a.w.tenantId, a.w.bookingId, "RETURN", a.w.actor);
  const r2 = await startHandover(a.w.tenantId, a.w.bookingId, "RETURN", a.w.actor);
  assert.equal(r1.id, r2.id, "nur ein Entwurf je Buchung");
  assert.match(r1.number, /^RP-/);
  assert.equal(await db.handoverChecklistItem.count({ where: { handoverId: r1.id } }), itemsForDrive(DEFAULT_RETURN_CHECKLIST, "DIESEL").length, "eigene Rückgabe-Checkliste (ohne Ladezubehör beim Diesel)");

  const copied = await db.handoverDamage.findMany({ where: { handoverId: r1.id }, orderBy: { sortOrder: "asc" } });
  assert.deepEqual(copied.map((d) => [d.description, d.marker]), [["Kratzer Fahrertür, vor der Miete", "EXISTING"], ["Steinschlag Haube, bei Übergabe", "PICKUP_NEW"]], "Übergabeschäden korrekt übernommen und eingestuft");
  assert.equal((copied[1].photoRefs as unknown[]).length, 1);
  await assert.rejects(() => getReturnComparison(other.tenantId, r1.id), /Protokoll nicht gefunden/);
  await assert.rejects(() => updateHandoverDraft(other.tenantId, r1.id, { mileage: 1 }), /Protokoll nicht gefunden/);
});

test("Vergleich: Kilometer, Mehrkilometer aus dem Vertrags-Snapshot, negative Differenz blockiert, Tank und Batterie, Verspätung ohne Gebühr", async () => {
  const a = await activeWorld("ret-cmp", { vehicle: { fuel: "PLUGIN_HYBRID", extraKmRate: 0.99, kmIncludedPerDay: 50 } });
  const r = await startHandover(a.w.tenantId, a.w.bookingId, "RETURN", a.w.actor);
  await updateHandoverDraft(a.w.tenantId, r.id, { mileage: 45_892, fuelLevelEighths: 4, batteryPercent: 34 });
  const cmp = await getReturnComparison(a.w.tenantId, r.id);
  assert.deepEqual(cmp.mileage, { pickup: 45_210, return: 45_892, driven: 682 });
  assert.deepEqual([cmp.contract.kmIncludedPerDay, cmp.contract.extraKmRate, cmp.contract.includedKm, cmp.time.rentalDays], [200, 0.25, 1200, 6], "Vertragswerte, nicht die inzwischen geänderten Fahrzeugpreise");
  assert.equal(cmp.proposals.find((p) => p.key === "EXTRA_MILEAGE"), undefined, "682 km unter 1.200 Freikilometern: kein Vorschlag");
  assert.deepEqual(cmp.fuel, { pickup: 7, return: 4, diff: -3 });
  assert.deepEqual(cmp.battery, { pickup: 82, return: 34, diff: -48 }, "Plug-in: beide Werte");
  const fuel = cmp.proposals.find((p) => p.key === "FUEL");
  assert.ok(fuel, "Voll/Voll mit Literpreis im Vertrag und Tankgröße: Kraftstoffvorschlag");
  assert.equal(fuel.draft.amount, 50.63); // 3/8 × 75 l = 28,13 l × 1,80 €
  assert.equal((fuel.draft.calculation as { priceOrigin: string }).priceOrigin, "Vertrag");
  assert.ok(cmp.hints.some((h) => h.code === "CHARGING_NO_BASIS"), "Ladung ohne Preisgrundlage nur als Hinweis");
  assert.equal(cmp.charges.length, 0, "Vorschläge sind keine Positionen");

  // 2.000 km gefahren: Mehrkilometer-Vorschlag zum Vertragspreis
  await updateHandoverDraft(a.w.tenantId, r.id, { mileage: 47_210 });
  const km = (await getReturnComparison(a.w.tenantId, r.id)).proposals.find((p) => p.key === "EXTRA_MILEAGE");
  assert.ok(km);
  assert.deepEqual([km.draft.quantity, km.draft.unitPrice, km.draft.amount], [800, 0.25, 200]);

  // Rückgabestand unter Übergabestand: Fehler, nie still akzeptiert
  await updateHandoverDraft(a.w.tenantId, r.id, { mileage: 45_000 });
  const state = await getHandoverState(a.w.tenantId, r.id);
  assert.ok(state.issues.some((i) => i.code === "MILEAGE_BELOW_PICKUP" && i.severity === "error"));
  assert.equal((await getReturnComparison(a.w.tenantId, r.id)).proposals.length, 1, "bei negativer Differenz kein Kilometervorschlag");

  // Verspätung: Hinweis, keine Gebühr
  const contract = await db.rentalContract.findUniqueOrThrow({ where: { id: a.contractId } });
  const handover = await db.handover.findUniqueOrThrow({ where: { id: r.id }, include: { extraCharges: true } });
  const pickup = await db.handover.findUniqueOrThrow({ where: { id: a.pickupId } });
  const booking = await db.booking.findUniqueOrThrow({ where: { id: a.w.bookingId } });
  const late = buildComparison({ handover, booking, contract, pickup, now: new Date(contract.endAt.getTime() + (2 * 60 + 47) * 60_000) });
  assert.equal(late.time.lateMinutes, 167);
  assert.ok(late.hints.some((h) => h.code === "LATE_RETURN" && h.text.includes("2 Std. 47 Min.")));
  assert.ok(!late.proposals.some((p) => (p.draft.type as string) === "LATE_RETURN"), "keine erfundene Verspätungsgebühr");
  const onTime = buildComparison({ handover, booking, contract, pickup, now: new Date(contract.endAt.getTime() - 60_000) });
  assert.equal(onTime.time.lateMinutes, 0);
});

test("Kraftstoff ohne Grundlage: nur Hinweis; Literpreis bei Rückgabe angegeben: Vorschlag mit dokumentierter Herkunft; inklusive: nichts", async () => {
  const none = await activeWorld("ret-fuel-none", { fuelPrice: null });
  const r = await startHandover(none.w.tenantId, none.w.bookingId, "RETURN", none.w.actor);
  await updateHandoverDraft(none.w.tenantId, r.id, { mileage: 45_300, fuelLevelEighths: 4 });
  let cmp = await getReturnComparison(none.w.tenantId, r.id);
  assert.equal(cmp.proposals.find((p) => p.key === "FUEL"), undefined);
  assert.ok(cmp.hints.some((h) => h.code === "FUEL_NO_BASIS"));
  await updateHandoverDraft(none.w.tenantId, r.id, { fuelPricePerLiter: 1.9 });
  cmp = await getReturnComparison(none.w.tenantId, r.id);
  const fuel = cmp.proposals.find((p) => p.key === "FUEL");
  assert.ok(fuel);
  assert.equal(fuel.draft.amount, 53.45); // 28,13 l × 1,90 €
  assert.equal((fuel.draft.calculation as { priceOrigin: string }).priceOrigin, "Rückgabe");
  assert.match(fuel.draft.formula, /3\/8 × 75 l = 28,13 l × 1,90 € = 53,45 €/);

  const incl = await activeWorld("ret-fuel-incl", { fuelPolicy: "INCLUDED" });
  const r2 = await startHandover(incl.w.tenantId, incl.w.bookingId, "RETURN", incl.w.actor);
  await updateHandoverDraft(incl.w.tenantId, r2.id, { mileage: 45_300, fuelLevelEighths: 2 });
  const c2 = await getReturnComparison(incl.w.tenantId, r2.id);
  assert.equal(c2.proposals.find((p) => p.key === "FUEL"), undefined);
  assert.ok(c2.hints.some((h) => h.code === "FUEL_INCLUDED"));
});

test("Zusatzkosten: Vorschlag erst nach Bestätigung, manuelle Position, Schaden ohne automatischen Preis, Signatur wird entwertet", async () => {
  const a = await activeWorld("ret-charges");
  const r = await startHandover(a.w.tenantId, a.w.bookingId, "RETURN", a.w.actor);
  await updateHandoverDraft(a.w.tenantId, r.id, { mileage: 47_210, fuelLevelEighths: 4 });
  const dmg = await addNewDamage(a.w.tenantId, r.id, { view: "REAR", posX: 0.8, posY: 0.6, kind: "DENT", severity: "MODERATE", description: "Delle Heckklappe, bei Rückgabe" });
  await assert.rejects(() => addNewDamage(a.w.tenantId, r.id, { view: "REAR", posX: 120, posY: 40, kind: "DENT", severity: "MINOR", description: "Pixelwerte" }), /normalisiert/);
  await photo(a.w, r.id, "DAMAGE", dmg.id);
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(a.w, r.id, cat);
  await answerAll(a.w, r.id, { keys_returned: { result: "1" }, unusually_dirty: { result: "YES", note: "Stark verschmutzter Innenraum" } });

  const before = await getReturnComparison(a.w.tenantId, r.id);
  assert.equal(before.charges.length, 0, "nichts ist automatisch eine Forderung, auch der Schaden nicht");
  const issues = (await getHandoverState(a.w.tenantId, r.id)).issues;
  assert.ok(issues.some((i) => i.code === "ACCESSORY_MISSING" && i.severity === "warning" && i.message.includes("2 Schlüssel")), "fehlender Schlüssel ist auffällig, aber kein Geldbetrag");
  assert.ok(issues.some((i) => i.code === "CHECKLIST_ATTENTION"));

  await sign(a.w, r.id);
  assert.equal(await db.signature.count({ where: { handoverId: r.id } }), 1);
  const km = await confirmProposal(a.w.tenantId, r.id, a.w.actor.id, "EXTRA_MILEAGE");
  assert.deepEqual([Number(km.amount), km.source, km.type], [200, "PROPOSAL", "EXTRA_MILEAGE"]);
  assert.equal(await db.signature.count({ where: { handoverId: r.id } }), 0, "Zusatzkosten ändern den Inhalt: Unterschrift verworfen");
  await assert.rejects(() => confirmProposal(a.w.tenantId, r.id, a.w.actor.id, "EXTRA_MILEAGE"), /bereits bestätigt/);
  await confirmProposal(a.w.tenantId, r.id, a.w.actor.id, "FUEL");

  const missing = await addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "MISSING_ACCESSORY", description: "Zweitschlüssel fehlt", quantity: 1, unit: "Stk", unitPrice: 150, internalNote: "laut Mieter verloren" });
  assert.deepEqual([Number(missing.amount), missing.source, missing.internalNote], [150, "MANUAL", "laut Mieter verloren"]);
  await assert.rejects(() => addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "CLEANING", description: "Reinigung", quantity: 0, unit: "pauschal", unitPrice: 30 }), /Menge/);
  await assert.rejects(() => addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "CLEANING", description: "Reinigung", quantity: 1, unit: "pauschal", unitPrice: -1 }), /negativ/);
  await assert.rejects(() => addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "CLEANING", description: "Reinigung", quantity: 1, unit: "pauschal", unitPrice: 30, handoverDamageId: dmg.id }), /Typ „Schaden“/);
  const damageCharge = await addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "DAMAGE", description: "Ausbeulen Heckklappe, Kostenvoranschlag", quantity: 1, unit: "pauschal", unitPrice: 240, handoverDamageId: dmg.id });
  assert.equal(damageCharge.handoverDamageId, dmg.id);
  assert.equal(damageCharge.damageId, null, "vor dem Abschluss gibt es noch keine Schadenakte");
  const cleaning = await addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "CLEANING", description: "Innenreinigung", quantity: 1, unit: "pauschal", unitPrice: 30 });
  await removeCharge(a.w.tenantId, r.id, cleaning.id);

  const cmp = await getReturnComparison(a.w.tenantId, r.id);
  assert.deepEqual(cmp.charges.map((c) => [c.type, c.amount]), [["EXTRA_MILEAGE", 200], ["FUEL", 50.63], ["MISSING_ACCESSORY", 150], ["DAMAGE", 240]]);
  assert.equal(cmp.chargesTotal, 640.63);
  assert.ok(cmp.proposals.every((p) => p.confirmed));

  // Position zu gelöschtem Schaden blockiert den Abschluss statt still zu verwaisen
  const other = await addNewDamage(a.w.tenantId, r.id, { view: "TOP", posX: 0.5, posY: 0.5, kind: "SCRATCH", severity: "MINOR", description: "Kratzer Dach" });
  await photo(a.w, r.id, "DAMAGE", other.id);
  const tmp = await addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "DAMAGE", description: "Dach", quantity: 1, unit: "pauschal", unitPrice: 10, handoverDamageId: other.id });
  await removeNewDamage(a.w.tenantId, other.id);
  assert.ok((await getHandoverState(a.w.tenantId, r.id)).issues.some((i) => i.code === "CHARGE_DAMAGE_MISSING"));
  await removeCharge(a.w.tenantId, r.id, tmp.id);

  // Unterschrift an den Hash: Änderung an Kilometer, Schaden, Foto, Checkliste oder Kosten entwertet sie
  for (const change of [
    () => updateHandoverDraft(a.w.tenantId, r.id, { mileage: 47_211 }),
    () => updateNewDamage(a.w.tenantId, dmg.id, { description: "Delle Heckklappe, größer" }),
    () => photo(a.w, r.id, "OTHER"),
    () => answerAll(a.w, r.id, { keys_returned: { result: "2" } }),
    () => addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "CLEANING", description: "Innenreinigung", quantity: 1, unit: "pauschal", unitPrice: 30 }),
  ]) {
    await sign(a.w, r.id);
    await change();
    assert.equal(await db.signature.count({ where: { handoverId: r.id } }), 0);
  }
  await assert.rejects(() => finalizeHandover(a.w.tenantId, r.id, a.w.actor), /Unterschrift des Mieters fehlt/);
});

test("Abschluss: Transaktion, Fahrzeug, Buchung, Schadenakte mit Bezug zur Miete, keine Haftungsfeststellung, danach unveränderlich", async () => {
  const a = await activeWorld("ret-final", { vehicle: { status: "AVAILABLE" } });
  const r = await startHandover(a.w.tenantId, a.w.bookingId, "RETURN", a.w.actor);
  await updateHandoverDraft(a.w.tenantId, r.id, { mileage: 47_210, fuelLevelEighths: 4 });
  const dmg = await addNewDamage(a.w.tenantId, r.id, { view: "REAR", posX: 0.8, posY: 0.6, kind: "DENT", severity: "MODERATE", description: "Delle Heckklappe, bei Rückgabe" });
  await photo(a.w, r.id, "DAMAGE", dmg.id);
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(a.w, r.id, cat);
  await answerAll(a.w, r.id);
  await confirmProposal(a.w.tenantId, r.id, a.w.actor.id, "EXTRA_MILEAGE");
  const dc = await addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "DAMAGE", description: "Kostenvoranschlag Heckklappe", quantity: 1, unit: "pauschal", unitPrice: 240, handoverDamageId: dmg.id });
  await sign(a.w, r.id);

  const vehicleBefore = await db.vehicle.findUniqueOrThrow({ where: { id: a.w.vehicleId } });
  assert.equal(vehicleBefore.mileage, 45_210, "Fahrzeugstand bleibt bis zum Abschluss der Übergabestand");
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: a.w.bookingId } })).status, "ACTIVE");

  // Transaktionsfehler rollt alles zurück: die Buchung wird vorübergehend blockiert, so dass der Statuswechsel scheitert
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION rb_test_block() RETURNS trigger AS 'BEGIN IF NEW."status" = ''RETURNED'' THEN RAISE EXCEPTION ''TESTBLOCK''; END IF; RETURN NEW; END' LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER rb_test_block BEFORE UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION rb_test_block()`);
  try {
    await assert.rejects(() => finalizeHandover(a.w.tenantId, r.id, a.w.actor), /TESTBLOCK/);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS rb_test_block ON "Booking"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS rb_test_block()`);
  }
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: r.id } })).status, "DRAFT", "kein halber Abschluss");
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: a.w.vehicleId } })).mileage, 45_210);
  assert.equal(await db.damage.count({ where: { tenantId: a.w.tenantId, discoveredInHandoverId: r.id } }), 0, "keine halb erzeugte Schadenhistorie");
  assert.equal(await db.vehicleEvent.count({ where: { tenantId: a.w.tenantId, handoverId: r.id } }), 0);

  const done = await finalizeHandover(a.w.tenantId, r.id, a.w.actor);
  assert.equal(done.status, "FINALIZED");
  assert.ok(done.contentHash && done.finalizedAt);
  const booking = await db.booking.findUniqueOrThrow({ where: { id: a.w.bookingId } });
  assert.equal(booking.status, "RETURNED");
  assert.ok(booking.actualReturnAt);
  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: a.w.vehicleId } });
  assert.deepEqual([vehicle.mileage, vehicle.status], [47_210, "AVAILABLE"], "Kilometerstand übernommen, Fahrzeug bleibt in der bestehenden Verfügbarkeitslogik");

  const damage = await db.damage.findFirstOrThrow({ where: { tenantId: a.w.tenantId, discoveredInHandoverId: r.id } });
  assert.deepEqual([damage.bookingId, damage.status, damage.settlementReview, damage.description], [a.w.bookingId, "OPEN", true, "Delle Heckklappe, bei Rückgabe"], "mit Miete verknüpft, offen, Abrechnung zu prüfen");
  assert.equal(await db.damage.count({ where: { tenantId: a.w.tenantId, bookingId: a.w.bookingId } }), 1, "Vorschäden bleiben ohne Mieterbezug");
  assert.equal((await db.extraCharge.findUniqueOrThrow({ where: { id: dc.id } })).damageId, damage.id, "Kostenposition zeigt jetzt auf die Schadenakte");
  assert.equal(await db.photo.count({ where: { damageId: damage.id } }), 1);
  const events = await db.vehicleEvent.findMany({ where: { tenantId: a.w.tenantId, vehicleId: a.w.vehicleId }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(events.map((e) => [e.type, e.mileage]), [["DAMAGE_DISCOVERED", 45_210], ["PICKUP", 45_210], ["MILEAGE", 45_210], ["DAMAGE_DISCOVERED", 47_210], ["RETURN", 47_210], ["MILEAGE", 47_210]], "Historie: Übergabe, Rückgabe, Schäden je mit Kilometerstand");
  assert.match(events[3].description ?? "", /^Bei Rückgabe festgestellt:/);
  assert.ok(!events.some((e) => /verursacht/i.test(e.description ?? "")), "keine Schuldzuweisung in der Historie");

  // unveränderlich
  assert.equal((await verifyHandover(a.w.tenantId, r.id)).intact, true);
  await assert.rejects(() => updateHandoverDraft(a.w.tenantId, r.id, { mileage: 1 }), (e) => isImmutableError(e));
  await assert.rejects(() => addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "CLEANING", description: "spät", quantity: 1, unit: "pauschal", unitPrice: 1 }), (e) => isImmutableError(e) || e instanceof DomainError);
  await assert.rejects(() => db.extraCharge.update({ where: { id: dc.id }, data: { amount: 1 } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.handover.update({ where: { id: r.id }, data: { mileage: 1 } }), (e) => isImmutableError(e));
  await assert.rejects(() => startHandover(a.w.tenantId, a.w.bookingId, "RETURN", a.w.actor), /bereits abgeschlossen/);

  // Vergleich nach dem Abschluss rechnet mit der versiegelten Rückgabezeit, nicht mit "jetzt"
  const sealed = await loadHandoverDocumentData(a.w.tenantId, r.id);
  assert.equal(sealed.doc.type, "RETURN");
  assert.ok(sealed.doc.comparison);
  assert.equal(sealed.doc.comparison.rows[0].diff, "2.000 km gefahren");
  assert.equal(sealed.doc.comparison.charges.length, 2);
  assert.equal(sealed.doc.comparison.charges[1].damageIndex, 3);
  assert.deepEqual(sealed.doc.damages.map((d) => d.symbol), ["circle", "diamond", "triangle"]);
});

test("Rückgabe-PDF aus dem Snapshot mit neutraler Schadenformulierung, E-Mail mit Rückgabeprotokoll, kein Doppelversand, SMTP-Ausfall harmlos", async () => {
  const a = await activeWorld("ret-pdf", { real: true });
  const r = await startHandover(a.w.tenantId, a.w.bookingId, "RETURN", a.w.actor);
  await updateHandoverDraft(a.w.tenantId, r.id, { mileage: 47_210, fuelLevelEighths: 4, notes: "Fahrzeug außen verschmutzt" });
  const dmg = await addNewDamage(a.w.tenantId, r.id, { view: "REAR", posX: 1, posY: 1, kind: "DENT", severity: "MODERATE", description: "Delle Heckklappe, bei Rückgabe" });
  await photo(a.w, r.id, "DAMAGE", dmg.id, true);
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(a.w, r.id, cat, undefined, true);
  await answerAll(a.w, r.id, { unusually_dirty: { result: "YES", note: "Sand im Laderaum" } });
  await confirmProposal(a.w.tenantId, r.id, a.w.actor.id, "EXTRA_MILEAGE");
  await addManualCharge(a.w.tenantId, r.id, a.w.actor.id, { type: "CLEANING", description: "Innenreinigung", quantity: 1, unit: "pauschal", unitPrice: 30 });
  await sign(a.w, r.id, true);
  await finalizeHandover(a.w.tenantId, r.id, a.w.actor);

  // Live-Daten ändern sich später: Schadenakte, Fahrzeug, Kunde
  await db.customer.update({ where: { id: a.w.customerId }, data: { lastName: "Anders", email: "neu@example.test" } });
  await db.vehicle.update({ where: { id: a.w.vehicleId }, data: { plate: "XX-NEU 9" } });
  await db.damage.updateMany({ where: { discoveredInHandoverId: r.id }, data: { description: "NACHTRÄGLICH", status: "REPAIRED" } });

  const data = await loadHandoverDocumentData(a.w.tenantId, r.id);
  const { trace, bytes } = await renderHandoverPdf(data.doc, { sketchSvg: await loadSketchSvg(data.sketch), photos: new Map(), signatures: data.signatureImages });
  const all = trace.texts.join("\n");
  assert.deepEqual(trace.boxes.filter((b) => b.overflow), []);
  assert.ok(all.includes("Fahrzeug-Rückgabeprotokoll") && all.includes("Delle Heckklappe, bei Rückgabe") && !all.includes("NACHTRÄGLICH") && !all.includes("XX-NEU"));
  assert.ok(all.includes("Erika Muster") && !all.includes("Anders"));
  assert.equal(trace.texts.filter((t) => t === "BEI RÜCKGABE FESTGESTELLT").length, 1);
  assert.equal(trace.texts.filter((t) => t === "BEI ÜBERGABE DOKUMENTIERTER VORSCHADEN").length, 1);
  assert.equal(trace.texts.filter((t) => t === "VOR MIETBEGINN DOKUMENTIERT").length, 1);
  assert.ok(!/verursacht|schuld/i.test(all), "neutrale Formulierung");
  assert.ok(all.includes("Kilometerstand") && all.includes("2.000 km gefahren") && all.includes("−3/8"), "Vergleich im PDF");
  assert.ok(all.includes("Mehrkilometer") && all.includes("Innenreinigung") && all.includes("Kaution laut Vertrag"), "Zusatzkosten und Kaution getrennt");
  assert.ok(all.includes("Dreieck: bei dieser Rückgabe neu festgestellt"), "Legende mit drittem Symbol");
  assert.deepEqual([...trace.markers].sort((x, y) => x.index - y.index).map((m) => m.symbol), ["circle", "diamond", "triangle"]);
  assert.equal(trace.images.filter((i) => i.kind === "signature").length, 1);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");

  const transport = new FakeTransport();
  transport.fail = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
  const failed = await runReturnFollowUp(a.w.tenantId, { id: r.id }, a.w.actor.id, { storage, transport });
  assert.deepEqual([failed.returnDocument.ok, failed.email.status], [true, "FAILED"]);
  const doc = await db.document.findFirstOrThrow({ where: { tenantId: a.w.tenantId, type: "RETURN_PROTOCOL" } });
  assert.match(doc.fileName, /^Rueckgabe_MV-\d{4}-\d+_HB-T-[A-Za-z0-9-]+\.pdf$/);
  assert.equal(sha256((await readDocumentFile(a.w.tenantId, doc.id, storage))!.body), doc.checksum);
  assert.deepEqual([(await db.booking.findUniqueOrThrow({ where: { id: a.w.bookingId } })).status, (await db.vehicle.findUniqueOrThrow({ where: { id: a.w.vehicleId } })).mileage, await db.damage.count({ where: { discoveredInHandoverId: r.id } })], ["RETURNED", 47_210, 1], "SMTP-Ausfall verändert die Rückgabe nicht");

  transport.fail = null;
  const again = await Promise.all([1, 2, 3].map(() => ensureReturnDocument(a.w.tenantId, r.id, a.w.actor.id, { storage })));
  assert.ok(again.every((x) => !x.created && x.document.id === doc.id), "kein doppeltes PDF");
  const sent = await sendHandoverDocuments(a.w.tenantId, r.id, { trigger: "MANUAL", actorId: a.w.actor.id, nonce: "nonce-return-0001", transport, storage });
  assert.equal(sent.status, "SENT");
  const dup = await Promise.all([1, 2].map(() => sendHandoverDocuments(a.w.tenantId, r.id, { trigger: "MANUAL", actorId: a.w.actor.id, nonce: "nonce-return-0001", transport, storage })));
  assert.ok(dup.every((d) => d.status === "DUPLICATE"));
  assert.equal(transport.sent.length, 1);
  const mail = transport.sent[0];
  assert.equal(mail.to, "erika@example.test", "Empfänger aus der Vertragskopie, nicht die geänderte Adresse");
  assert.match(mail.subject, /^Ihre Rückgabeunterlagen – MV-/);
  assert.deepEqual(mail.attachments.map((x) => x.filename), [doc.fileName], "nur das Rückgabeprotokoll");
  assert.equal(sha256(mail.attachments[0].content), doc.checksum);
  assert.ok(!/verursacht|anerkann|geschuldet/i.test(mail.text), "keine Aussage zu Haftung oder Schuld");
  const logs = await db.emailLog.findMany({ where: { tenantId: a.w.tenantId, handoverId: r.id }, orderBy: { attemptNo: "asc" } });
  assert.deepEqual(logs.map((l) => [l.template, l.status, l.trigger]), [["RETURN_DOCUMENTS", "FAILED", "AUTO"], ["RETURN_DOCUMENTS", "SENT", "MANUAL"]]);

  const other = await createWorld("ret-foreign");
  tenants.push(other.tenantId);
  assert.equal(await readDocumentFile(other.tenantId, doc.id, storage), null);
  await assert.rejects(() => ensureReturnDocument(other.tenantId, r.id, null, { storage }), /Protokoll nicht gefunden/);
});
