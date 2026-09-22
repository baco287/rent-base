// Integrationstest des Übergabe-Assistenten (Phase 4) gegen die lokale Entwicklungsdatenbank.
// Aufruf: npm test
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveContractSignature } from "../src/lib/contracts";
import {
  addNewDamage,
  answerChecklist,
  answerChecklistItem,
  finalizeHandover,
  getHandoverContentHash,
  getHandoverState,
  registerPhoto,
  removeNewDamage,
  removePhoto,
  saveHandoverSignature,
  startHandover,
  updateHandoverDraft,
  updateNewDamage,
  verifyHandover,
} from "../src/lib/handovers";
import { buildHandoverDocument } from "../src/lib/handover-view";
import { bookingStage } from "../src/lib/booking-status";
import { publishChecklistVersion, DEFAULT_CHECKLIST } from "../src/lib/checklists";
import { DomainError, isImmutableError, sha256 } from "../src/lib/integrity";
import { assertKeyBelongsToTenant, buildStorageKey, getStorage, sniffImageType, storageStatus } from "../src/lib/storage";
import { REQUIRED_PHOTO_CATEGORIES, energyRequirements } from "../src/lib/constants";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

/** Mandant mit abgeschlossenem Mietvertrag: die Buchung ist bereit zur Übergabe. */
async function readyWorld(label: string, vehicle?: Record<string, unknown>): Promise<World> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  if (vehicle) await db.vehicle.update({ where: { id: w.vehicleId }, data: vehicle });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return w;
}

async function photo(w: World, handoverId: string, category: string, handoverDamageId?: string) {
  const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  return registerPhoto(w.tenantId, w.actor, { handoverId, handoverDamageId, storageKey, category, contentType: "image/jpeg", sizeBytes: 250_000, checksum: sha256(storageKey) });
}
async function sign(w: World, handoverId: string, role: "RENTER" | "EMPLOYEE" = "RENTER") {
  return saveHandoverSignature(w.tenantId, w.actor, handoverId, { role, signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, handoverId), ipAddress: "203.0.113.9", userAgent: "test" });
}
/** Füllt alles aus, was für den Abschluss nötig ist. */
async function complete(w: World, handoverId: string, mileage = 50_020) {
  await updateHandoverDraft(w.tenantId, handoverId, { mileage, fuelLevelEighths: 8 });
  for (const c of REQUIRED_PHOTO_CATEGORIES) await photo(w, handoverId, c);
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId } });
  await answerChecklist(w.tenantId, handoverId, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2 Schlüssel" : i.answerType === "YES_NO" ? "YES" : "OK" })));
}
const codes = async (w: World, handoverId: string) => (await getHandoverState(w.tenantId, handoverId)).issues.filter((i) => i.severity === "error").map((i) => i.code);
const signatureCount = (w: World, handoverId: string) => db.signature.count({ where: { tenantId: w.tenantId, handoverId } });
async function rejectsImmutable(fn: () => Promise<unknown>, what: string) {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(isImmutableError(e), `${what}: erwartet RB_IMMUTABLE, bekam ${(e as Error).message}`);
    return true;
  });
}

test("Übergabe startet nur mit abgeschlossenem Mietvertrag, und es gibt nur einen Entwurf je Buchung", async () => {
  const w = await createWorld("start");
  tenants.push(w.tenantId);
  await assert.rejects(() => startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor), /wenn der Mietvertrag abgeschlossen ist/);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await assert.rejects(() => startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor), /wenn der Mietvertrag abgeschlossen ist/);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);

  // fünf gleichzeitige Klicks auf "Übergabe starten"
  const started = await Promise.all([1, 2, 3, 4, 5].map(() => startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor)));
  assert.equal(new Set(started.map((h) => h.id)).size, 1);
  assert.equal(await db.handover.count({ where: { tenantId: w.tenantId, bookingId: w.bookingId, type: "PICKUP" } }), 1);
  assert.match(started[0].number, /^UP-\d{4}-0001$/);
  assert.equal(started[0].contractId, c.id);
  assert.equal(started[0].sketchId, "sys_sketch_transporter_v2");
});

test("Kilometerstand bleibt im Entwurf und geht erst beim Abschluss ins Fahrzeug", async () => {
  const w = await readyWorld("mileage");
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await assert.rejects(() => updateHandoverDraft(w.tenantId, h.id, { mileage: 12.5 }), /ganze Zahl/);
  await updateHandoverDraft(w.tenantId, h.id, { mileage: 49_000, fuelLevelEighths: 6 });
  assert.equal((await db.vehicle.findFirstOrThrow({ where: { id: w.vehicleId } })).mileage, 50_000, "Fahrzeug unverändert");
  assert.ok((await codes(w, h.id)).includes("MILEAGE_BELOW_VEHICLE"));

  await complete(w, h.id, 50_123);
  assert.equal((await db.vehicle.findFirstOrThrow({ where: { id: w.vehicleId } })).mileage, 50_000, "immer noch unverändert");
  await sign(w, h.id);
  await finalizeHandover(w.tenantId, h.id, w.actor);
  assert.equal((await db.vehicle.findFirstOrThrow({ where: { id: w.vehicleId } })).mileage, 50_123);
});

test("Tank bei Verbrennern, Batterie bei Elektro, beides bei Plug-in-Hybrid", async () => {
  assert.deepEqual(energyRequirements("DIESEL"), { fuel: true, battery: false, chargingGear: false });
  assert.deepEqual(energyRequirements("BENZIN"), { fuel: true, battery: false, chargingGear: false });
  assert.deepEqual(energyRequirements("HYBRID"), { fuel: true, battery: false, chargingGear: false });
  assert.deepEqual(energyRequirements("ELEKTRO"), { fuel: false, battery: true, chargingGear: true });
  assert.deepEqual(energyRequirements("PLUGIN_HYBRID"), { fuel: true, battery: true, chargingGear: true });

  const e = await readyWorld("electric", { fuel: "ELEKTRO" });
  const he = await startHandover(e.tenantId, e.bookingId, "PICKUP", e.actor);
  assert.equal(he.driveType, "ELEKTRO");
  let c = await codes(e, he.id);
  assert.ok(c.includes("BATTERY_MISSING") && !c.includes("FUEL_MISSING"));
  await assert.rejects(() => updateHandoverDraft(e.tenantId, he.id, { batteryPercent: 140 }), /0 und 100/);
  await updateHandoverDraft(e.tenantId, he.id, { batteryPercent: 82 });
  assert.ok(!(await codes(e, he.id)).includes("BATTERY_MISSING"));

  const p = await readyWorld("plugin", { fuel: "PLUGIN_HYBRID" });
  const hp = await startHandover(p.tenantId, p.bookingId, "PICKUP", p.actor);
  c = await codes(p, hp.id);
  assert.ok(c.includes("BATTERY_MISSING") && c.includes("FUEL_MISSING"));
  await updateHandoverDraft(p.tenantId, hp.id, { fuelLevelEighths: 7 });
  c = await codes(p, hp.id);
  assert.ok(c.includes("BATTERY_MISSING") && !c.includes("FUEL_MISSING"));
  await assert.rejects(() => updateHandoverDraft(p.tenantId, hp.id, { fuelLevelEighths: 9 }), /0 und 8/);

  // Die Antriebsart ist eine Kopie vom Start: ein späterer Umbau am Fahrzeugstamm ändert das Protokoll nicht
  await db.vehicle.update({ where: { id: p.vehicleId }, data: { fuel: "DIESEL" } });
  assert.equal((await getHandoverState(p.tenantId, hp.id)).handover.driveType, "PLUGIN_HYBRID");
});

test("Schäden: vorhandene aus dem Snapshot, neue markieren, bearbeiten, verschieben, löschen", async () => {
  const w = await readyWorld("damages");
  const old = await db.damage.create({ data: { tenantId: w.tenantId, vehicleId: w.vehicleId, view: "LEFT", posX: 0.2, posY: 0.6, kind: "SCRATCH", description: "Kratzer Schiebetür" } });
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);

  await assert.rejects(() => addNewDamage(w.tenantId, h.id, { view: "REAR", posX: 640, posY: 0.4, kind: "DENT", description: "Pixelwert" }), /normalisiert/);
  await assert.rejects(() => addNewDamage(w.tenantId, h.id, { view: "UNTEN", posX: 0.5, posY: 0.4, kind: "DENT", description: "falsche Ansicht" }), /Fahrzeugansicht/);
  await assert.rejects(() => addNewDamage(w.tenantId, h.id, { view: "REAR", posX: 0.5, posY: 0.4, kind: "DENT", description: "x" }), /beschreiben/);
  await assert.rejects(() => addNewDamage(w.tenantId, h.id, { view: "REAR", posX: 0.5, posY: 0.4, kind: "LACKTOD", description: "unbekannte Art" }), /Art des Schadens/);

  const nd = await addNewDamage(w.tenantId, h.id, { view: "REAR", posX: 0.8, posY: 0.4, kind: "DENT", description: "Delle Hecktür", size: "ca. 4 cm", severity: "MODERATE" });
  const interior = await addNewDamage(w.tenantId, h.id, { view: "INTERIOR", posX: 0.3, posY: 0.5, kind: "STAIN", description: "Fleck Fahrersitz" });
  assert.equal(interior.view, "INTERIOR");

  // bearbeiten und verschieben
  const moved = await updateNewDamage(w.tenantId, nd.id, { posX: 0.25, posY: 0.75, view: "FRONT", description: "Delle Stoßstange vorn", severity: "SEVERE" });
  assert.deepEqual([moved.view, moved.posX, moved.posY, moved.severity], ["FRONT", 0.25, 0.75, "SEVERE"]);
  await assert.rejects(() => updateNewDamage(w.tenantId, nd.id, { posX: 1.2, posY: 0.5 }), /normalisiert/);

  // vorhandene Schäden sind Teil des dokumentierten Zustands
  const existing = await db.handoverDamage.findFirstOrThrow({ where: { handoverId: h.id, marker: "EXISTING" } });
  assert.equal(existing.damageId, old.id);
  await assert.rejects(() => updateNewDamage(w.tenantId, existing.id, { description: "heimlich geändert" }), /können im Protokoll nicht verändert werden/);
  await assert.rejects(() => removeNewDamage(w.tenantId, existing.id), /können im Protokoll nicht verändert werden/);

  // löschen samt Foto
  const p = await photo(w, h.id, "DAMAGE", interior.id);
  const keys = await removeNewDamage(w.tenantId, interior.id);
  assert.deepEqual(keys, [p.storageKey]);
  assert.equal(await db.photo.count({ where: { id: p.id } }), 0);

  const state = await getHandoverState(w.tenantId, h.id);
  const doc = buildHandoverDocument(state.handover, state.sketch, state.signatures, REQUIRED_PHOTO_CATEGORIES);
  assert.deepEqual(doc.damages.map((d) => [d.index, d.marker, d.markerLabel]), [[1, "EXISTING", "Bereits dokumentiert"], [2, "NEW", "Neu entdeckt (Vorschaden)"]]);
  assert.deepEqual(doc.sketch?.views.map((v) => v.key), ["FRONT", "REAR", "LEFT", "RIGHT", "TOP", "INTERIOR"]);
  assert.ok((await codes(w, h.id)).includes("DAMAGE_PHOTO_MISSING"), "neuer Schaden braucht ein Foto");
});

test("bei der Übergabe entdeckter Schaden ist ein Vorschaden und wird keinem Mieter zugerechnet", async () => {
  const w = await readyWorld("pre-damage");
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await complete(w, h.id);
  const nd = await addNewDamage(w.tenantId, h.id, { view: "RIGHT", posX: 0.6, posY: 0.5, kind: "SCRATCH", description: "Kratzer Beifahrertür" });
  await photo(w, h.id, "DAMAGE", nd.id);
  await sign(w, h.id);
  await finalizeHandover(w.tenantId, h.id, w.actor);

  const damage = await db.damage.findFirstOrThrow({ where: { tenantId: w.tenantId, vehicleId: w.vehicleId } });
  assert.equal(damage.bookingId, null, "nicht der laufenden Miete zugeordnet");
  assert.equal(damage.discoveredInHandoverId, h.id);
  assert.equal(damage.status, "OPEN");
  assert.deepEqual([damage.posX, damage.posY, damage.view], [0.6, 0.5, "RIGHT"]);
  const snapshot = await db.handoverDamage.findFirstOrThrow({ where: { id: nd.id } });
  assert.equal(snapshot.damageId, damage.id);
  assert.equal((await db.photo.findFirstOrThrow({ where: { handoverDamageId: nd.id } })).damageId, damage.id);
  const event = await db.vehicleEvent.findFirstOrThrow({ where: { tenantId: w.tenantId, type: "DAMAGE_DISCOVERED" } });
  assert.match(event.description ?? "", /Vorschaden bei Übergabe/);

  // spätere Änderungen an der Akte lassen das Protokoll unberührt
  await db.damage.update({ where: { id: damage.id }, data: { description: "inzwischen lackiert", posX: 0.1 } });
  assert.equal((await db.handoverDamage.findFirstOrThrow({ where: { id: nd.id } })).description, "Kratzer Beifahrertür");
  assert.equal((await verifyHandover(w.tenantId, h.id)).intact, true);
});

test("Fotos: Pflichtansichten, privater Speicher mit Mandantenprüfung, Löschen nur im Entwurf", async () => {
  const w = await readyWorld("photos");
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  assert.deepEqual(REQUIRED_PHOTO_CATEGORIES, ["FRONT", "REAR", "LEFT", "RIGHT", "INTERIOR", "ODOMETER", "FUEL"]);
  assert.ok((await codes(w, h.id)).includes("PHOTOS_MISSING"));

  const other = await createWorld("photos-foreign");
  tenants.push(other.tenantId);
  const foreignKey = buildStorageKey({ tenantId: other.tenantId, area: "photos", contentType: "image/jpeg" });
  await assert.rejects(() => registerPhoto(w.tenantId, w.actor, { handoverId: h.id, storageKey: foreignKey, category: "FRONT", contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256("x") }), /fremden Speicherbereich/);
  const ownKey = () => buildStorageKey({ tenantId: w.tenantId, area: "photos", contentType: "image/jpeg" });
  await assert.rejects(() => registerPhoto(w.tenantId, w.actor, { handoverId: h.id, storageKey: ownKey(), category: "FRONT", contentType: "application/pdf", sizeBytes: 1000, checksum: sha256("x") }), /Dateityp/);
  await assert.rejects(() => registerPhoto(w.tenantId, w.actor, { handoverId: h.id, storageKey: ownKey(), category: "FRONT", contentType: "image/jpeg", sizeBytes: 50_000_000, checksum: sha256("x") }), /zu groß/);
  await assert.rejects(() => registerPhoto(w.tenantId, w.actor, { handoverId: h.id, storageKey: ownKey(), category: "SELFIE", contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256("x") }), /Fotokategorie/);

  for (const c of REQUIRED_PHOTO_CATEGORIES) await photo(w, h.id, c);
  assert.ok(!(await codes(w, h.id)).includes("PHOTOS_MISSING"));
  const first = await db.photo.findFirstOrThrow({ where: { handoverId: h.id, category: "FRONT" } });
  assert.ok(first.storageKey.startsWith(`t/${w.tenantId}/photos/`));
  assert.ok(!/^https?:/.test(first.storageKey), "gespeichert wird ein Schlüssel, keine Adresse");

  assert.equal(await removePhoto(w.tenantId, first.id), first.storageKey);
  assert.ok((await codes(w, h.id)).includes("PHOTOS_MISSING"));
  await assert.rejects(() => removePhoto(other.tenantId, first.id), /Foto nicht gefunden/);

  // Foto an einem Schaden: der Verweis steht in der Kopie des Schadens und verschwindet beim Löschen wieder
  const nd = await addNewDamage(w.tenantId, h.id, { view: "FRONT", posX: 0.5, posY: 0.5, kind: "CHIP", description: "Steinschlag Haube" });
  const dp = await photo(w, h.id, "FRONT", nd.id);
  assert.equal(dp.category, "DAMAGE", "Schadenfotos zählen nicht als Pflichtansicht");
  assert.equal(((await db.handoverDamage.findFirstOrThrow({ where: { id: nd.id } })).photoRefs as unknown[]).length, 1);
  await removePhoto(w.tenantId, dp.id);
  assert.equal(((await db.handoverDamage.findFirstOrThrow({ where: { id: nd.id } })).photoRefs as unknown[]).length, 0);
});

test("Speicherschicht: lokal nur außerhalb der Produktion, in Produktion ohne Konfiguration gesperrt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rb-storage-"));
  try {
    const dev = getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as NodeJS.ProcessEnv);
    assert.equal(dev.name, "local");
    const key = buildStorageKey({ tenantId: "tenantx", area: "photos", contentType: "image/jpeg" });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await dev.put(key, bytes, "image/jpeg");
    await assert.rejects(() => dev.put(key, bytes, "image/jpeg"), /existiert bereits/, "nie überschreiben");
    const back = await dev.get(key);
    assert.deepEqual([...back!.body], [...bytes]);
    assert.equal(back!.contentType, "image/jpeg");
    await dev.remove(key);
    assert.equal(await dev.get(key), null);

    assert.throws(() => getStorage({ NODE_ENV: "production" } as NodeJS.ProcessEnv), (e: unknown) => e instanceof DomainError && /noch nicht eingerichtet/.test((e as Error).message));
    assert.deepEqual(storageStatus({ NODE_ENV: "production" } as NodeJS.ProcessEnv), { configured: false, driver: "none", missing: ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"] });
    const prod = { NODE_ENV: "production", S3_ENDPOINT: "https://nbg1.your-objectstorage.com", S3_BUCKET: "b", S3_ACCESS_KEY: "k", S3_SECRET_KEY: "s" } as NodeJS.ProcessEnv;
    assert.equal(getStorage(prod).name, "s3");
    assert.equal(storageStatus(prod).driver, "s3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.throws(() => assertKeyBelongsToTenant("t/anderer/photos/x.jpg", "tenantx"), /fremden Speicherbereich/);
  assert.throws(() => assertKeyBelongsToTenant("t/tenantx/../anderer/x.jpg", "tenantx"), /fremden Speicherbereich/);
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffImageType(new TextEncoder().encode("<svg onload=alert(1)>")), null, "der Typ wird am Inhalt erkannt, nicht am Namen");
});

test("Checkliste: Standard ohne Vorlage, eigene Vorlage als Kopie, Bemerkung bei Beanstandung", async () => {
  const w = await readyWorld("checklist");
  await db.$transaction((tx) => publishChecklistVersion(tx, w.tenantId, { name: "Transporter", groupId: w.groupId, handoverType: "PICKUP", items: [{ key: "straps", label: "Spanngurte vollständig", answerType: "YES_NO", required: true }, { key: "floor", label: "Ladeboden", answerType: "OK_NOT_OK", required: true }] }));
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  const items = await db.handoverChecklistItem.findMany({ where: { handoverId: h.id }, orderBy: { sortOrder: "asc" } });
  assert.deepEqual(items.map((i) => [i.itemKey, i.templateVersion]), [["straps", 1], ["floor", 1]]);

  // Vorlage ändert sich später: das laufende Protokoll behält seine Fragen
  await db.$transaction((tx) => publishChecklistVersion(tx, w.tenantId, { name: "Transporter", groupId: w.groupId, handoverType: "PICKUP", items: [{ key: "neu", label: "Ganz andere Frage", answerType: "YES_NO", required: true }] }));
  assert.equal(await db.handoverChecklistItem.count({ where: { handoverId: h.id } }), 2);

  await assert.rejects(() => answerChecklist(w.tenantId, h.id, [{ itemId: items[0].id, result: "VIELLEICHT" }]), /Ungültige Antwort/);
  await answerChecklist(w.tenantId, h.id, [{ itemId: items[0].id, result: "YES" }, { itemId: items[1].id, result: "NOT_OK" }]);
  assert.ok((await codes(w, h.id)).includes("CHECKLIST_NOTE"), "Beanstandung braucht eine Bemerkung");
  await answerChecklistItem(w.tenantId, items[1].id, "NOT_OK", "Ladeboden verkratzt");
  const c = await codes(w, h.id);
  assert.ok(!c.includes("CHECKLIST_NOTE") && !c.includes("CHECKLIST_OPEN"));

  // ohne eigene Vorlage greift der Standard
  const plain = await readyWorld("checklist-default");
  const hp = await startHandover(plain.tenantId, plain.bookingId, "PICKUP", plain.actor);
  assert.equal(await db.handoverChecklistItem.count({ where: { handoverId: hp.id } }), DEFAULT_CHECKLIST.length - 1, "Standard ohne den Ladezubehör-Punkt (Diesel)");
  assert.ok((await codes(plain, hp.id)).includes("CHECKLIST_OPEN"));
});

test("Unterschrift gehört zum gesehenen Stand; jede inhaltliche Änderung verwirft sie", async () => {
  const w = await readyWorld("signature");
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await complete(w, h.id);

  const oldHash = await getHandoverContentHash(w.tenantId, h.id);
  await updateHandoverDraft(w.tenantId, h.id, { notes: "zwei Schlüssel" });
  await assert.rejects(() => saveHandoverSignature(w.tenantId, w.actor, h.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: oldHash }), /seit der Anzeige geändert/);
  const fresh = await getHandoverContentHash(w.tenantId, h.id);
  await assert.rejects(() => saveHandoverSignature(w.tenantId, w.actor, h.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: "data:image/png;base64,AAAA", seenHash: fresh }), /ungültig|leer/);

  const changes: [string, () => Promise<unknown>][] = [
    ["Kilometerstand", () => updateHandoverDraft(w.tenantId, h.id, { mileage: 50_021 })],
    ["Tankstand", () => updateHandoverDraft(w.tenantId, h.id, { fuelLevelEighths: 7 })],
    ["Checkliste", async () => answerChecklistItem(w.tenantId, (await db.handoverChecklistItem.findFirstOrThrow({ where: { handoverId: h.id, answerType: "OK_NOT_OK" } })).id, "NOT_OK", "Kratzer Felge")],
    ["neuer Schaden", () => addNewDamage(w.tenantId, h.id, { view: "LEFT", posX: 0.4, posY: 0.4, kind: "DENT", description: "Delle Tür" })],
    ["Schaden verschoben", async () => updateNewDamage(w.tenantId, (await db.handoverDamage.findFirstOrThrow({ where: { handoverId: h.id, marker: "NEW" } })).id, { posX: 0.45, posY: 0.4 })],
    ["Schadenfoto", async () => photo(w, h.id, "DAMAGE", (await db.handoverDamage.findFirstOrThrow({ where: { handoverId: h.id, marker: "NEW" } })).id)],
    ["weiteres Foto", () => photo(w, h.id, "OTHER")],
    ["Foto gelöscht", async () => removePhoto(w.tenantId, (await db.photo.findFirstOrThrow({ where: { handoverId: h.id, category: "OTHER" } })).id)],
  ];
  for (const [what, change] of changes) {
    await sign(w, h.id);
    await sign(w, h.id, "EMPLOYEE");
    assert.equal(await signatureCount(w, h.id), 2);
    await change();
    assert.equal(await signatureCount(w, h.id), 0, `${what}: Unterschriften verworfen`);
    await assert.rejects(() => finalizeHandover(w.tenantId, h.id, w.actor), `${what}: ohne neue Unterschrift kein Abschluss`);
  }

  // Reine Navigation im Assistenten ändert den Inhalt nicht
  await sign(w, h.id);
  await db.handover.update({ where: { id: h.id }, data: { wizardStep: 7 } });
  assert.equal((await getHandoverState(w.tenantId, h.id)).signatures.length, 1);
});

test("Abschluss: Buchung geht auf Unterwegs, Protokoll ist versiegelt, doppelter Abschluss scheitert", async () => {
  const w = await readyWorld("finalize");
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await assert.rejects(() => finalizeHandover(w.tenantId, h.id, w.actor), /Kilometerstand fehlt/);
  await complete(w, h.id);
  await assert.rejects(() => finalizeHandover(w.tenantId, h.id, w.actor), /Unterschrift des Mieters fehlt/);
  assert.equal((await db.booking.findFirstOrThrow({ where: { id: w.bookingId } })).status, "RESERVED");
  await sign(w, h.id);

  const results = await Promise.allSettled([finalizeHandover(w.tenantId, h.id, w.actor), finalizeHandover(w.tenantId, h.id, w.actor)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);

  const booking = await db.booking.findFirstOrThrow({ where: { id: w.bookingId }, include: { contract: true } });
  assert.equal(booking.status, "ACTIVE");
  assert.ok(booking.actualPickupAt);
  assert.equal(bookingStage(booking, booking.contract), "ACTIVE");
  const done = await db.handover.findFirstOrThrow({ where: { id: h.id } });
  assert.equal(done.status, "FINALIZED");
  assert.ok(done.finalizedAt && done.contentHash);
  assert.deepEqual((await db.vehicleEvent.findMany({ where: { tenantId: w.tenantId } })).map((e) => e.type).sort(), ["MILEAGE", "PICKUP"]);
  assert.equal((await db.vehicleEvent.findFirstOrThrow({ where: { tenantId: w.tenantId, type: "PICKUP" } })).mileage, 50_020);
  await assert.rejects(() => startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor), /bereits abgeschlossen/);

  // gesperrt, im Code und in der Datenbank
  await rejectsImmutable(() => updateHandoverDraft(w.tenantId, h.id, { mileage: 1 }), "Messwerte");
  await rejectsImmutable(() => addNewDamage(w.tenantId, h.id, { view: "LEFT", posX: 0.1, posY: 0.1, kind: "DENT", description: "nachträglich" }), "Schaden");
  await rejectsImmutable(async () => answerChecklistItem(w.tenantId, (await db.handoverChecklistItem.findFirstOrThrow({ where: { handoverId: h.id } })).id, "NOT_OK", "x"), "Checkliste");
  await rejectsImmutable(async () => removePhoto(w.tenantId, (await db.photo.findFirstOrThrow({ where: { handoverId: h.id } })).id), "Foto löschen");
  await rejectsImmutable(() => saveHandoverSignature(w.tenantId, w.actor, h.id, { role: "RENTER", signerName: "X Y", imageDataUrl: fakeSignaturePng(3), seenHash: "0".repeat(64) }), "erneut unterschreiben");
  await rejectsImmutable(() => db.handover.update({ where: { id: h.id }, data: { mileage: 1 } }), "Protokoll direkt");
  await rejectsImmutable(() => db.photo.deleteMany({ where: { handoverId: h.id } }), "Fotos direkt");
  await rejectsImmutable(() => db.signature.deleteMany({ where: { handoverId: h.id } }), "Unterschrift direkt");
  assert.equal((await verifyHandover(w.tenantId, h.id)).intact, true);
});

test("Mandantentrennung im Übergabeprozess", async () => {
  const a = await readyWorld("tenant-a");
  const b = await readyWorld("tenant-b");
  const h = await startHandover(a.tenantId, a.bookingId, "PICKUP", a.actor);
  const nd = await addNewDamage(a.tenantId, h.id, { view: "LEFT", posX: 0.4, posY: 0.4, kind: "DENT", description: "Delle Tür" });

  await assert.rejects(() => startHandover(b.tenantId, a.bookingId, "PICKUP", b.actor), /Buchung nicht gefunden/);
  await assert.rejects(() => getHandoverState(b.tenantId, h.id), /Protokoll nicht gefunden/);
  await assert.rejects(() => updateHandoverDraft(b.tenantId, h.id, { mileage: 1 }), /Protokoll nicht gefunden/);
  await assert.rejects(() => addNewDamage(b.tenantId, h.id, { view: "LEFT", posX: 0.1, posY: 0.1, kind: "DENT", description: "fremd" }), /Protokoll nicht gefunden/);
  await assert.rejects(() => updateNewDamage(b.tenantId, nd.id, { description: "fremd geändert" }), /Schaden nicht gefunden/);
  await assert.rejects(() => removeNewDamage(b.tenantId, nd.id), /Schaden nicht gefunden/);
  await assert.rejects(() => saveHandoverSignature(b.tenantId, b.actor, h.id, { role: "RENTER", signerName: "X Y", imageDataUrl: fakeSignaturePng(), seenHash: "0".repeat(64) }), /Protokoll nicht gefunden/);
  await assert.rejects(() => finalizeHandover(b.tenantId, h.id, b.actor), /Protokoll nicht gefunden/);
  assert.equal(await db.handover.count({ where: { tenantId: b.tenantId } }), 0);
});
