// Integrationstest des Fundaments gegen die lokale Entwicklungsdatenbank (npm run db:dev).
// Prüft Snapshots, Sperren im Code, Sperren in der Datenbank, Mandantentrennung und Zusatzkosten.
// Legt eigene Testmandanten an und entfernt sie am Ende wieder. Aufruf: npm test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { addAdditionalDriver, ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature, verifyContract } from "../src/lib/contracts";
import { fakeSignaturePng, purgeTenants } from "./helpers";
import { addNewDamage, answerChecklistItem, saveHandoverSignature, finalizeHandover, getHandoverContentHash, registerPhoto, startHandover, updateHandoverDraft, verifyHandover } from "../src/lib/handovers";
import { setDamageStatus } from "../src/lib/damages";
import { publishChecklistVersion, DEFAULT_CHECKLIST } from "../src/lib/checklists";
import { publishSketchVersion } from "../src/lib/sketches";
import { extraMileageCharge, fuelCharge, saveExtraCharge } from "../src/lib/extra-charges";
import { registerDocument } from "../src/lib/documents";
import { enqueueEmail } from "../src/lib/email-log";
import { buildStorageKey } from "../src/lib/storage";
import { isImmutableError, sha256 } from "../src/lib/integrity";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";

const run = `t${Date.now()}`;
const ids = { tenantA: "", tenantB: "", user: "", vehicle: "", customer: "", booking: "", group: "" };
const actor = { id: "", name: "Test Hofmitarbeiter" };
let contractId = "";
let pickupId = "";
let returnId = "";
let oldDamageId = "";

async function rejectsImmutable(fn: () => Promise<unknown>, what: string) {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(isImmutableError(e), `${what}: erwartet RB_IMMUTABLE, bekam ${(e as Error).message}`);
    return true;
  });
}

async function photo(handoverId: string, category: string, handoverDamageId?: string) {
  const storageKey = buildStorageKey({ tenantId: ids.tenantA, area: "photos", bookingId: ids.booking, contentType: "image/jpeg" });
  return registerPhoto(ids.tenantA, actor, { handoverId, handoverDamageId, storageKey, category, contentType: "image/jpeg", sizeBytes: 250_000, checksum: sha256(storageKey) });
}

async function signAndFinalize(handoverId: string) {
  const hash = await getHandoverContentHash(ids.tenantA, handoverId);
  for (const role of ["RENTER", "EMPLOYEE"] as const) {
    await saveHandoverSignature(ids.tenantA, actor, handoverId, { role, signerName: role === "RENTER" ? "Erika Muster" : actor.name, imageDataUrl: fakeSignaturePng(), seenHash: hash });
  }
  return finalizeHandover(ids.tenantA, handoverId, actor);
}

before(async () => {
  const a = await db.tenant.create({ data: { name: `Test A ${run}`, slug: `test-a-${run}` } });
  const b = await db.tenant.create({ data: { name: `Test B ${run}`, slug: `test-b-${run}` } });
  ids.tenantA = a.id;
  ids.tenantB = b.id;
  const user = await db.user.create({ data: { tenantId: a.id, email: `hof-${run}@example.test`, name: actor.name, passwordHash: "x", role: "YARD" } });
  ids.user = actor.id = user.id;
  const group = await db.vehicleGroup.create({ data: { tenantId: a.id, name: "Transporter", bodyType: "TRANSPORTER", dailyRate: 89 } });
  ids.group = group.id;
  const vehicle = await db.vehicle.create({ data: { tenantId: a.id, plate: `HB-T ${run.slice(-4)}`, make: "VW", model: "Crafter", groupId: group.id, fuel: "DIESEL", mileage: 50_000, dailyRate: 89, workWeekRate: 420, weeklyRate: 540, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 500, tankCapacityLiters: 75 } });
  ids.vehicle = vehicle.id;
  const customer = await db.customer.create({ data: { tenantId: a.id, firstName: "Erika", lastName: "Muster", street: "Weg 1", zip: "28195", city: "Bremen", phone: "0421 1", birthDate: new Date("1985-03-12"), idNumber: "L01X00T47", idValidUntil: new Date("2031-01-01"), licenseNumber: "B123", licenseClass: "B", licenseIssuedAt: new Date("2005-06-01"), licenseValidUntil: new Date("2033-06-01"), discountPercent: 10 } });
  ids.customer = customer.id;
  const start = new Date(Date.now() - 3600_000);
  const end = new Date(start.getTime() + 6 * 24 * 3600_000);
  const booking = await db.booking.create({ data: { tenantId: a.id, number: `T-${run}`, vehicleId: vehicle.id, customerId: customer.id, startAt: start, endAt: end, dailyRate: 89, workWeekRate: 420, weeklyRate: 540, deposit: 500 } });
  ids.booking = booking.id;
  // Altschaden mit Foto in der Schadenakte
  const d = await db.damage.create({ data: { tenantId: a.id, vehicleId: vehicle.id, view: "LEFT", posX: 0.2, posY: 0.6, kind: "SCRATCH", description: "Kratzer Schiebetür", severity: "MINOR" } });
  oldDamageId = d.id;
  await db.photo.create({ data: { tenantId: a.id, damageId: d.id, storageKey: buildStorageKey({ tenantId: a.id, area: "photos", contentType: "image/jpeg" }), category: "DAMAGE", contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256("alt") } });
});

after(async () => {
  await purgeTenants([ids.tenantA, ids.tenantB]);
  await db.$disconnect();
});

test("Vertrag: Entwurf, Zusatzfahrer ohne Kundenkarte, Abschluss friert Kunde, Fahrzeug und Preise ein", async () => {
  const c = await ensureContractDraft(ids.tenantA, ids.booking, actor);
  contractId = c.id;
  assert.match(c.number, /^MV-\d{4}-\d{4}$/);
  // 6 Tage: Woche (420) + Tag (89) = 509, 10 % Rabatt
  assert.equal(Number(c.totalAmount), 458.1);

  const booking = await db.booking.findFirstOrThrow({ where: { id: ids.booking } });
  await saveConditions(ids.tenantA, c.id, { startAt: booking.startAt, endAt: booking.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPricePerLiter: 2.1 });
  const driver = await addAdditionalDriver(ids.tenantA, c.id, { firstName: "Max", lastName: "Zusatz", birthDate: new Date("1990-05-01"), street: "Hafen 3", zip: "28217", city: "Bremen", licenseNumber: "Z999", licenseClass: "B", licenseIssuedAt: new Date("2010-06-01"), licenseValidUntil: new Date("2033-06-01"), licenseCountry: "DE" });
  assert.equal(driver.customerId, null);
  await assert.rejects(() => addAdditionalDriver(ids.tenantB, c.id, { firstName: "X", lastName: "Y", birthDate: new Date("1990-01-01"), street: "s", zip: "1", city: "c", licenseNumber: "n", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01") }), /nicht gefunden/);

  await assert.rejects(() => finalizeContract(ids.tenantA, c.id), /Unterschrift des Mieters fehlt/);
  const hash = await getContractContentHash(ids.tenantA, c.id);
  await saveContractSignature(ids.tenantA, actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: hash });
  const signed = await finalizeContract(ids.tenantA, c.id);
  assert.equal(signed.status, "SIGNED");
  assert.equal(signed.contentHash, hash);

  // Stammdaten ändern sich später: der abgeschlossene Vertrag bleibt, wie er war
  await db.customer.update({ where: { id: ids.customer }, data: { lastName: "Neuname", street: "Andere Str. 9" } });
  await db.vehicle.update({ where: { id: ids.vehicle }, data: { dailyRate: 199, extraKmRate: 0.99 } });
  const again = await db.rentalContract.findFirstOrThrow({ where: { id: c.id, tenantId: ids.tenantA } });
  const cust = again.customerSnapshot as Record<string, unknown>;
  assert.equal(cust.lastName, "Muster");
  assert.equal(cust.street, "Weg 1");
  assert.equal(Number(again.extraKmRate), 0.25);
  assert.equal((again.priceSnapshot as { total: number }).total, 458.1);
  assert.equal((await verifyContract(ids.tenantA, c.id)).intact, true);

  await rejectsImmutable(() => addAdditionalDriver(ids.tenantA, c.id, { firstName: "A", lastName: "B", birthDate: new Date("1990-01-01"), street: "s", zip: "1", city: "c", licenseNumber: "n", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01") }), "Fahrer nach Unterschrift");
  // direkt an der Anwendungslogik vorbei
  await rejectsImmutable(() => db.rentalContract.update({ where: { id: c.id }, data: { totalAmount: 1 } }), "Vertrag direkt ändern");
  await rejectsImmutable(() => db.contractDriver.deleteMany({ where: { contractId: c.id } }), "Fahrer direkt löschen");
});

test("Übergabe kopiert Schäden, Checkliste und Skizze; andere Mandanten sehen nichts", async () => {
  await assert.rejects(() => startHandover(ids.tenantB, ids.booking, "PICKUP", actor), /Buchung nicht gefunden/);
  await assert.rejects(() => startHandover(ids.tenantA, ids.booking, "RETURN", actor), /nur für laufende Mieten/);

  const h = await startHandover(ids.tenantA, ids.booking, "PICKUP", actor);
  pickupId = h.id;
  assert.match(h.number, /^UP-\d{4}-\d{4}$/);
  assert.equal(h.driveType, "DIESEL");
  assert.equal(h.sketchId, "sys_sketch_transporter_v2"); // Fallback nach Karosserieart der Gruppe
  assert.equal(h.contractId, contractId);

  const again = await startHandover(ids.tenantA, ids.booking, "PICKUP", actor);
  assert.equal(again.id, h.id, "Entwurf wird fortgesetzt, nicht doppelt angelegt");

  const damages = await db.handoverDamage.findMany({ where: { tenantId: ids.tenantA, handoverId: h.id } });
  assert.equal(damages.length, 1);
  assert.equal(damages[0].marker, "EXISTING");
  assert.equal(damages[0].damageId, oldDamageId);
  assert.equal((damages[0].photoRefs as unknown[]).length, 1);

  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: ids.tenantA, handoverId: h.id } });
  assert.equal(items.length, DEFAULT_CHECKLIST.length);
});

test("Finalisieren verlangt Pflichtangaben und die Unterschrift über genau diesen Inhalt", async () => {
  await assert.rejects(() => finalizeHandover(ids.tenantA, pickupId, actor), /Kilometerstand fehlt/);
  await updateHandoverDraft(ids.tenantA, pickupId, { mileage: 50_010, fuelLevelEighths: 8 });
  await assert.rejects(() => finalizeHandover(ids.tenantA, pickupId, actor), /Pflichtfotos/);
  for (const item of await db.handoverChecklistItem.findMany({ where: { tenantId: ids.tenantA, handoverId: pickupId, required: true } })) {
    await answerChecklistItem(ids.tenantA, item.id, item.answerType === "TEXT" ? "2" : item.answerType === "YES_NO" ? "YES" : "OK");
  }
  await assert.rejects(() => finalizeHandover(ids.tenantA, pickupId, actor), /Pflichtfotos/);
  for (const c of REQUIRED_PHOTO_CATEGORIES) await photo(pickupId, c);

  await assert.rejects(() => addNewDamage(ids.tenantA, pickupId, { view: "REAR", posX: 640, posY: 0.4, kind: "DENT", description: "Pixelwert" }), /normalisiert/);
  const nd = await addNewDamage(ids.tenantA, pickupId, { view: "REAR", posX: 0.8, posY: 0.4, kind: "DENT", description: "Delle Hecktür", size: "ca. 4 cm", severity: "MODERATE" });
  await photo(pickupId, "DAMAGE", nd.id);

  // Unterschrift, danach Änderung: die Unterschrift passt nicht mehr
  const hash = await getHandoverContentHash(ids.tenantA, pickupId);
  await saveHandoverSignature(ids.tenantA, actor, pickupId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: hash });
  await updateHandoverDraft(ids.tenantA, pickupId, { notes: "nachträglich geändert" });
  // die Änderung hat die Unterschrift verworfen
  await assert.rejects(() => finalizeHandover(ids.tenantA, pickupId, actor), /Unterschrift des Mieters fehlt/);

  const done = await signAndFinalize(pickupId);
  assert.equal(done.status, "FINALIZED");
  assert.ok(done.contentHash);

  const booking = await db.booking.findFirstOrThrow({ where: { id: ids.booking, tenantId: ids.tenantA } });
  assert.equal(booking.status, "ACTIVE");
  assert.ok(booking.actualPickupAt);
  assert.equal((await db.vehicle.findFirstOrThrow({ where: { id: ids.vehicle } })).mileage, 50_010);
  // Neuer Schaden ist jetzt in der Schadenakte, bei der Übergabe gefunden und damit keinem Mieter zugeordnet
  const akte = await db.damage.findMany({ where: { tenantId: ids.tenantA, vehicleId: ids.vehicle }, orderBy: { createdAt: "asc" } });
  assert.equal(akte.length, 2);
  assert.equal(akte[1].discoveredInHandoverId, pickupId);
  assert.equal(akte[1].bookingId, null);
  const types = (await db.vehicleEvent.findMany({ where: { tenantId: ids.tenantA, vehicleId: ids.vehicle } })).map((e) => e.type).sort();
  assert.deepEqual(types, ["DAMAGE_DISCOVERED", "MILEAGE", "PICKUP"]);
});

test("finalisiertes Protokoll ist gesperrt, im Code und in der Datenbank", async () => {
  await rejectsImmutable(() => updateHandoverDraft(ids.tenantA, pickupId, { mileage: 1 }), "Messwerte ändern");
  await rejectsImmutable(() => addNewDamage(ids.tenantA, pickupId, { view: "LEFT", posX: 0.1, posY: 0.1, kind: "DENT", description: "später" }), "Schaden nachtragen");
  await rejectsImmutable(() => photo(pickupId, "OTHER"), "Foto nachtragen");
  // direkt an der Anwendungslogik vorbei
  await rejectsImmutable(() => db.handover.update({ where: { id: pickupId }, data: { mileage: 1 } }), "Protokoll direkt ändern");
  await rejectsImmutable(() => db.handover.delete({ where: { id: pickupId } }), "Protokoll direkt löschen");
  await rejectsImmutable(() => db.handoverDamage.updateMany({ where: { handoverId: pickupId }, data: { description: "manipuliert" } }), "Schaden-Kopie direkt ändern");
  await rejectsImmutable(() => db.handoverChecklistItem.updateMany({ where: { handoverId: pickupId }, data: { result: "NOT_OK" } }), "Checkliste direkt ändern");
  await rejectsImmutable(() => db.photo.deleteMany({ where: { handoverId: pickupId } }), "Foto direkt löschen");
  await rejectsImmutable(() => db.signature.updateMany({ where: { handoverId: pickupId }, data: { signerName: "Jemand anderes" } }), "Unterschrift direkt ändern");
  await rejectsImmutable(() => db.vehicleEvent.deleteMany({ where: { vehicleId: ids.vehicle } }), "Historie direkt löschen");
});

test("spätere Änderungen an Schadenakte, Skizze und Checkliste verändern das alte Protokoll nicht", async () => {
  const before = await db.handoverDamage.findMany({ where: { tenantId: ids.tenantA, handoverId: pickupId }, orderBy: { sortOrder: "asc" } });

  // Schadenakte lebt weiter: Text ändern, Altschaden reparieren
  await db.damage.update({ where: { id: oldDamageId }, data: { description: "Kratzer Schiebetür, poliert", posX: 0.9 } });
  await setDamageStatus(ids.tenantA, actor, oldDamageId, "REPAIRED", "Smart Repair");
  // Neue Skizze und neue Checkliste für die Gruppe
  await db.$transaction(async (tx) => {
    const sketch = await publishSketchVersion(tx, ids.tenantA, { code: "CRAFTER", name: "Crafter L3H2", bodyType: "TRANSPORTER", assetPath: "t/x/sketches/crafter.svg", assetContent: "<svg/>", views: [{ key: "LEFT", label: "Fahrerseite", box: [0, 0, 100, 100] }] });
    await tx.vehicleGroup.update({ where: { id: ids.group }, data: { sketchId: sketch.id } });
    await publishChecklistVersion(tx, ids.tenantA, { name: "Transporter", groupId: ids.group, items: [{ key: "straps", label: "Spanngurte vollständig", answerType: "YES_NO", required: true }] });
  });

  const afterChange = await db.handoverDamage.findMany({ where: { tenantId: ids.tenantA, handoverId: pickupId }, orderBy: { sortOrder: "asc" } });
  assert.deepEqual(afterChange.map((d) => [d.description, d.posX, d.marker]), before.map((d) => [d.description, d.posX, d.marker]));
  assert.equal(afterChange[0].description, "Kratzer Schiebetür");

  const pickup = await db.handover.findFirstOrThrow({ where: { id: pickupId, tenantId: ids.tenantA } });
  assert.equal(pickup.sketchId, "sys_sketch_transporter_v2");
  assert.equal(pickup.sketchVersion, 2);
  assert.equal(await db.handoverChecklistItem.count({ where: { handoverId: pickupId } }), DEFAULT_CHECKLIST.length);

  const check = await verifyHandover(ids.tenantA, pickupId);
  assert.equal(check.intact, true, "gespeicherter Hash passt weiterhin zum Inhalt");
  // Der reparierte Schaden bleibt in der Akte erhalten
  assert.ok((await db.damage.findFirstOrThrow({ where: { id: oldDamageId } })).repairedAt);
  await rejectsImmutable(() => db.damage.delete({ where: { id: oldDamageId } }), "Schaden aus der Akte löschen");
});

test("Rückgabe nutzt den Zustand von jetzt: neue Skizze, neue Checkliste, nur sichtbare Schäden", async () => {
  const h = await startHandover(ids.tenantA, ids.booking, "RETURN", actor);
  returnId = h.id;
  assert.match(h.number, /^RP-/);
  assert.notEqual(h.sketchId, "sys_sketch_transporter_v2");
  assert.equal(h.sketchVersion, 1);

  const damages = await db.handoverDamage.findMany({ where: { tenantId: ids.tenantA, handoverId: h.id } });
  assert.deepEqual(damages.map((d) => [d.description, d.marker]), [["Delle Hecktür", "EXISTING"]], "reparierter Altschaden fehlt, Schaden aus der Übergabe ist jetzt vorhanden");
  assert.equal((damages[0].photoRefs as unknown[]).length, 1, "Fotoverweis des Schadens wurde mitkopiert");

  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: ids.tenantA, handoverId: h.id } });
  assert.deepEqual(items.map((i) => i.itemKey), ["straps"]);
  assert.equal(items[0].templateVersion, 1);
});

test("Zusatzkosten speichern die Rechengrundlage mit den Preisen aus dem Vertrag", async () => {
  await updateHandoverDraft(ids.tenantA, returnId, { mileage: 50_000, fuelLevelEighths: 5 });
  for (const item of await db.handoverChecklistItem.findMany({ where: { tenantId: ids.tenantA, handoverId: returnId } })) await answerChecklistItem(ids.tenantA, item.id, "YES");
  for (const c of REQUIRED_PHOTO_CATEGORIES) await photo(returnId, c);
  const hash = await getHandoverContentHash(ids.tenantA, returnId);
  await saveHandoverSignature(ids.tenantA, actor, returnId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: hash });
  await assert.rejects(() => finalizeHandover(ids.tenantA, returnId, actor), /liegt unter dem der Übergabe/);

  await updateHandoverDraft(ids.tenantA, returnId, { mileage: 51_552 });
  const contract = await db.rentalContract.findFirstOrThrow({ where: { id: contractId, tenantId: ids.tenantA } });
  // 1.542 km gefahren, 6 Tage × 200 km frei = 1.200 km, 342 Mehrkilometer zum Vertragspreis 0,25 € (Fahrzeug steht inzwischen auf 0,99 €)
  const km = extraMileageCharge({ pickupMileage: 50_010, returnMileage: 51_552, start: contract.startAt, end: contract.endAt, kmIncludedPerDay: contract.kmIncludedPerDay, extraKmRate: Number(contract.extraKmRate) });
  assert.ok(km);
  assert.equal(km.quantity, 342);
  assert.equal(km.amount, 85.5);
  assert.equal(km.formula, "342 km × 0,25 € = 85,50 €");
  const fuel = fuelCharge({ pickupEighths: 8, returnEighths: 5, tankCapacityLiters: 75, pricePerLiter: Number(contract.fuelPricePerLiter) });
  assert.ok(fuel);
  assert.equal(fuel.amount, 59.07); // 3/8 × 75 l = 28,13 l × 2,10 €

  await db.$transaction(async (tx) => {
    await saveExtraCharge(tx, ids.tenantA, ids.user, { bookingId: ids.booking, handoverId: returnId }, km);
    await saveExtraCharge(tx, ids.tenantA, ids.user, { bookingId: ids.booking, handoverId: returnId }, fuel);
    await assert.rejects(() => saveExtraCharge(tx, ids.tenantB, null, { bookingId: ids.booking }, km), /Buchung nicht gefunden/);
  });

  const done = await signAndFinalize(returnId);
  assert.equal(done.status, "FINALIZED");
  const booking = await db.booking.findFirstOrThrow({ where: { id: ids.booking, tenantId: ids.tenantA } });
  assert.equal(booking.status, "RETURNED");
  assert.ok(booking.actualReturnAt);
  const stored = await db.extraCharge.findFirstOrThrow({ where: { tenantId: ids.tenantA, handoverId: returnId, type: "EXTRA_MILEAGE" } });
  assert.equal((stored.calculation as { extraKm: number }).extraKm, 342);
  await rejectsImmutable(() => db.extraCharge.updateMany({ where: { handoverId: returnId }, data: { amount: 1 } }), "Zusatzkosten eines finalisierten Protokolls ändern");
});

test("Dokumente sind unveränderlich archiviert, E-Mails werden nicht doppelt eingereiht", async () => {
  const doc = await db.$transaction((tx) =>
    registerDocument(tx, ids.tenantA, ids.user, { bookingId: ids.booking, handoverId: returnId, type: "RETURN_PROTOCOL", storageKey: buildStorageKey({ tenantId: ids.tenantA, area: "documents", bookingId: ids.booking, contentType: "application/pdf" }), fileName: "Rueckgabe.pdf", sizeBytes: 120_000, checksum: sha256("pdf") }),
  );
  assert.equal(doc.version, 1);
  await rejectsImmutable(() => db.document.update({ where: { id: doc.id }, data: { fileName: "anders.pdf" } }), "Dokument ändern");
  await rejectsImmutable(() => db.document.delete({ where: { id: doc.id } }), "Dokument löschen");
  await assert.rejects(
    () => db.$transaction((tx) => registerDocument(tx, ids.tenantB, null, { bookingId: ids.booking, type: "INVOICE", storageKey: buildStorageKey({ tenantId: ids.tenantB, area: "documents", contentType: "application/pdf" }), fileName: "x.pdf", sizeBytes: 1, checksum: sha256("x") })),
    /Buchung nicht gefunden/,
  );

  const key = `RETURN_PROTOCOL:${returnId}:v1`;
  const first = await enqueueEmail({ tenantId: ids.tenantA, bookingId: ids.booking, recipient: "Erika@Example.test", subject: "Ihr Rückgabeprotokoll", template: "RETURN_PROTOCOL", attachments: [{ documentId: doc.id, fileName: doc.fileName, checksum: doc.checksum }], idempotencyKey: key });
  const second = await enqueueEmail({ tenantId: ids.tenantA, bookingId: ids.booking, recipient: "erika@example.test", subject: "Ihr Rückgabeprotokoll", template: "RETURN_PROTOCOL", idempotencyKey: key });
  assert.equal(first.id, second.id);
  assert.equal(first.status, "PENDING");
  assert.equal(first.recipient, "erika@example.test");
});

test("Mandantentrennung: Mandant B sieht von alldem nichts", async () => {
  const where = { where: { tenantId: ids.tenantB } };
  const counts = await Promise.all([db.rentalContract.count(where), db.handover.count(where), db.damage.count(where), db.handoverDamage.count(where), db.photo.count(where), db.signature.count(where), db.document.count(where), db.extraCharge.count(where), db.emailLog.count(where), db.vehicleEvent.count(where)]);
  assert.deepEqual(counts, new Array(10).fill(0));
  await assert.rejects(() => updateHandoverDraft(ids.tenantB, pickupId, { notes: "x" }), /Protokoll nicht gefunden/);
  await assert.rejects(() => setDamageStatus(ids.tenantB, actor, oldDamageId, "OPEN"), /Schaden nicht gefunden/);
  await assert.rejects(() => getContractContentHash(ids.tenantB, contractId), /Vertrag nicht gefunden/);
});
