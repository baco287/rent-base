// Operativer Feinschliff: Antriebsklassen (Verbrenner / Elektro / Plug-in-Hybrid) steuern Energiefelder, Ladezubehör und
// Checklistenpunkte zentral; „Vor Abschluss prüfen“ liefert Blocker und Hinweise aus denselben Regeln wie der Abschluss.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { DEFAULT_CHECKLIST, DEFAULT_RETURN_CHECKLIST, itemsForDrive } from "../src/lib/checklists";
import { getHandoverCompletionStatus } from "../src/lib/completion";
import { REQUIRED_PHOTO_CATEGORIES, driveClassOf } from "../src/lib/constants";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { recordDepositReceived } from "../src/lib/deposits";
import { buildHandoverDocument } from "../src/lib/handover-view";
import { addNewDamage, answerChecklist, finalizeHandover, getHandoverContentHash, getHandoverState, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { sha256 } from "../src/lib/integrity";
import { confirmProposal, getReturnComparison } from "../src/lib/returns";
import { buildStorageKey } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const codes = (s: Awaited<ReturnType<typeof getHandoverCompletionStatus>>) => ({ b: s.blockers.map((x) => x.code), w: s.warnings.map((x) => x.code) });
async function photo(w: World, handoverId: string, category: string, handoverDamageId?: string) {
  const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  return registerPhoto(w.tenantId, w.actor, { handoverId, handoverDamageId, storageKey, category, contentType: "image/jpeg", sizeBytes: 250_000, checksum: sha256(storageKey) });
}
const sign = async (w: World, handoverId: string) => saveHandoverSignature(w.tenantId, w.actor, handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, handoverId), ipAddress: null, userAgent: "test" });
async function answerAll(w: World, handoverId: string) {
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId } });
  await answerChecklist(w.tenantId, handoverId, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2" : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
}
/** Vertrag abgeschlossen (Kaution 500, Voll/Voll, 200 km/Tag), Fahrzeug mit gewünschtem Antrieb. */
async function ready(label: string, fuel: string) {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { fuel, mileage: 45_000 } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return { w, contractId: c.id };
}
const keysOf = (w: World, handoverId: string) => db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId }, select: { itemKey: true }, orderBy: { sortOrder: "asc" } }).then((r) => r.map((x) => x.itemKey));

test("Antriebsklassen und Checklisten-Applicability: Ladezubehör nur bei Elektro und Plug-in-Hybrid", () => {
  assert.deepEqual(["DIESEL", "BENZIN", "HYBRID", "ELEKTRO", "PLUGIN_HYBRID"].map(driveClassOf), ["COMBUSTION", "COMBUSTION", "COMBUSTION", "ELECTRIC", "PHEV"]);
  for (const list of [DEFAULT_CHECKLIST, DEFAULT_RETURN_CHECKLIST]) {
    assert.ok(list.some((i) => i.key === "charging_cable" && i.appliesTo?.length === 2));
    assert.ok(!itemsForDrive(list, "DIESEL").some((i) => i.key === "charging_cable"));
    assert.ok(!itemsForDrive(list, "BENZIN").some((i) => i.key === "charging_cable"));
    assert.ok(itemsForDrive(list, "ELEKTRO").some((i) => i.key === "charging_cable"));
    assert.ok(itemsForDrive(list, "PLUGIN_HYBRID").some((i) => i.key === "charging_cable"));
    assert.equal(itemsForDrive(list, "DIESEL").length, list.length - 1, "nur der Ladezubehör-Punkt entfällt");
  }
  // Punkte ohne appliesTo gelten für alle
  assert.equal(itemsForDrive([{ key: "x", label: "x", answerType: "YES_NO", required: true }], "DIESEL").length, 1);
});

test("Übergabe und Rückgabe je Antrieb: Benziner, Diesel, Elektro, Plug-in-Hybrid – Tank, Batterie, Ladekabel, Checkliste, Protokoll", async () => {
  for (const fuel of ["BENZIN", "DIESEL", "ELEKTRO", "PLUGIN_HYBRID"] as const) {
    const { w, contractId } = await ready(`drive-${fuel.toLowerCase()}`, fuel);
    const electric = fuel === "ELEKTRO", phev = fuel === "PLUGIN_HYBRID";
    const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
    const pKeys = await keysOf(w, p.id);
    assert.equal(pKeys.includes("charging_cable"), electric || phev, `${fuel}: Ladezubehör in der Übergabe-Checkliste`);
    let s = await getHandoverCompletionStatus(w.tenantId, p.id);
    let c = codes(s);
    assert.equal(c.b.includes("FUEL_MISSING"), !electric, `${fuel}: Tank fehlt ist Blocker nur mit Tank`);
    assert.equal(c.b.includes("BATTERY_MISSING"), electric || phev, `${fuel}: Batterie fehlt ist Blocker nur mit Batterie`);
    assert.ok(c.b.includes("MILEAGE_MISSING") && c.b.includes("PHOTOS_MISSING") && c.b.includes("CHECKLIST_OPEN") && c.b.includes("SIGNATURE_MISSING"));
    assert.ok(c.w.includes("DEPOSIT_NOT_RECEIVED"), "Kaution nicht dokumentiert ist nur Hinweis");
    assert.ok(s.blockers.every((b) => b.step >= 2 && b.step <= 7 && b.stepLabel), "jeder Blocker zeigt auf einen Schritt");
    assert.deepEqual(s.blockers.filter((b) => b.code === "PHOTOS_MISSING").map((b) => b.step), [4]);
    assert.deepEqual(s.blockers.filter((b) => b.code === "SIGNATURE_MISSING").map((b) => b.step), [7]);

    await updateHandoverDraft(w.tenantId, p.id, { mileage: 45_100, ...(electric ? {} : { fuelLevelEighths: 7 }), ...(electric || phev ? { batteryPercent: 80 } : {}) });
    for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, p.id, cat);
    await answerAll(w, p.id);
    await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, contractId);
    c = codes(await getHandoverCompletionStatus(w.tenantId, p.id));
    assert.deepEqual(c.b, ["SIGNATURE_MISSING"], `${fuel}: nur die Unterschrift fehlt noch`);
    await sign(w, p.id);
    s = await getHandoverCompletionStatus(w.tenantId, p.id);
    assert.deepEqual([s.ready, s.blockers, s.renterSigned, s.warnings.map((x) => x.code)], [true, [], true, ["DEPOSIT_NOT_RECEIVED"]]);
    // Kaution dokumentiert → Hinweis verschwindet, Abschluss war auch vorher möglich
    await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: new Date(Date.now() - 1000) });
    assert.deepEqual(codes(await getHandoverCompletionStatus(w.tenantId, p.id)).w, []);
    await finalizeHandover(w.tenantId, p.id, w.actor);
    const pickupKeysAfter = await keysOf(w, p.id);

    // Protokoll-Ansicht: nur passende Energiezeilen
    const st = await getHandoverState(w.tenantId, p.id);
    const doc = buildHandoverDocument(st.handover, st.sketch, [], [...REQUIRED_PHOTO_CATEGORIES], null, null);
    const labels = doc.readings.map((r) => r.label);
    assert.equal(labels.includes("Tankstand"), !electric, `${fuel}: Tankstand im Protokoll`);
    assert.equal(labels.includes("Batteriestand"), electric || phev, `${fuel}: Batteriestand im Protokoll`);
    assert.equal(doc.checklist.some((i) => /Ladekabel/.test(i.label)), electric || phev, `${fuel}: Ladezubehör im Protokoll`);

    // Rückgabe
    const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
    const rKeys = await keysOf(w, r.id);
    assert.equal(rKeys.includes("charging_cable"), electric || phev, `${fuel}: Ladezubehör in der Rückgabe-Checkliste`);
    c = codes(await getHandoverCompletionStatus(w.tenantId, r.id));
    assert.equal(c.b.includes("FUEL_MISSING"), !electric);
    assert.equal(c.b.includes("BATTERY_MISSING"), electric || phev);
    assert.ok(!c.w.includes("DEPOSIT_NOT_RECEIVED"), "Kautionshinweis gehört zur Übergabe");
    await updateHandoverDraft(w.tenantId, r.id, { mileage: 46_500, ...(electric ? {} : { fuelLevelEighths: 4 }), ...(electric || phev ? { batteryPercent: 30 } : {}) });
    const cmp = await getReturnComparison(w.tenantId, r.id);
    assert.equal(cmp.fuel !== null, !electric, `${fuel}: Kraftstoffvergleich nur mit Tank`);
    assert.equal(cmp.battery !== null, electric || phev, `${fuel}: Ladezustandsvergleich nur mit Batterie`);
    assert.equal(cmp.proposals.some((p) => p.key === "FUEL"), !electric, `${fuel}: Kraftstoffvorschlag nur mit Tank`);
    // offene Vorschläge sind Hinweise (nie Blocker) und führen zum Zusatzkosten-Schritt
    const dmg = await addNewDamage(w.tenantId, r.id, { view: "REAR", posX: 0.5, posY: 0.5, kind: "DENT", severity: "MINOR", description: "Delle" });
    s = await getHandoverCompletionStatus(w.tenantId, r.id);
    assert.ok(s.warnings.some((x) => x.code === "PROPOSAL_OPEN_EXTRA_MILEAGE" && x.step === 7));
    assert.ok(s.blockers.some((x) => x.code === "DAMAGE_PHOTO_MISSING" && x.step === 4), "Schaden ohne Foto blockiert und zeigt auf den Zustandsschritt");
    await photo(w, r.id, "DAMAGE", dmg.id);
    for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, r.id, cat);
    await answerAll(w, r.id);
    await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
    await sign(w, r.id);
    s = await getHandoverCompletionStatus(w.tenantId, r.id);
    assert.deepEqual(s.blockers, []);
    assert.equal(s.warnings.some((x) => x.code === "PROPOSAL_OPEN_EXTRA_MILEAGE"), false);
    assert.equal(s.warnings.some((x) => x.code === "PROPOSAL_OPEN_FUEL"), !electric, "Kraftstoffvorschlag bewusst offen gelassen: Hinweis, kein Blocker");
    await finalizeHandover(w.tenantId, r.id, w.actor);
    // historische Snapshots unverändert: die Checkliste der abgeschlossenen Übergabe ist identisch mit dem Stand vor der Rückgabe
    assert.deepEqual(await keysOf(w, p.id), pickupKeysAfter);
    assert.equal((await db.handover.findUniqueOrThrow({ where: { id: p.id } })).driveType, fuel);
  }
});

test("Abschlussprüfung: Karte und Abschluss nutzen dieselben Regeln; veränderter Stand wird beim Abschluss erneut geprüft", async () => {
  const { w, contractId } = await ready("completion-rules", "DIESEL");
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 45_100, fuelLevelEighths: 7 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, p.id, cat);
  await answerAll(w, p.id);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, contractId);
  await sign(w, p.id);
  assert.equal((await getHandoverCompletionStatus(w.tenantId, p.id)).ready, true);
  // nach der Anzeige ändert jemand den Kilometerstand: Unterschrift veraltet → Karte und Abschluss sagen dasselbe
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 45_150 });
  const s = await getHandoverCompletionStatus(w.tenantId, p.id);
  assert.deepEqual([s.ready, s.blockers.map((b) => [b.code, b.step])], [false, [["SIGNATURE_MISSING", 7]]], "Unterschrift wird bei Änderung verworfen");
  await assert.rejects(() => finalizeHandover(w.tenantId, p.id, w.actor), /Unterschrift des Mieters fehlt/);
  await sign(w, p.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  assert.deepEqual(await getHandoverCompletionStatus(w.tenantId, p.id).then((x) => [x.blockers, x.warnings]), [[], []], "abgeschlossen: nichts mehr offen");
});
