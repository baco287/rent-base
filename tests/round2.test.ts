// Befehl 20.8 (Runde 2): Regressionen für Unterschriften (einmal genügt, Navigation/Re-Render verwirft nichts),
// Zusatzfahrer (ohne Formular fortsetzen, vorhandene bleiben, bewusst hinzufügen), Mietbedingungen-Bestätigung aktualisiert
// die Blocker, Kaution zählt nie als Mietzahlung, Prüfsummen bleiben in Datenbank und Integritätsprüfung.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { acknowledgeTerms, addAdditionalDriver, ensureContractDraft, getContractState, removeAdditionalDriver, saveContractSignature, setWizardStep, verifyContract, finalizeContract } from "../src/lib/contracts";
import { createTermsDraft, publishTermsVersion } from "../src/lib/rental-terms";
import { recordDepositReceived } from "../src/lib/deposits";
import { rentalPaymentSummary } from "../src/lib/rental-payments";
import { getHandoverCompletionStatus } from "../src/lib/completion";
import { answerChecklist, getHandoverContentHash, getHandoverState, registerPhoto, saveHandoverSignature, setHandoverStep, startHandover, updateHandoverDraft, verifyHandover } from "../src/lib/handovers";
import { sha256 } from "../src/lib/integrity";
import { buildStorageKey } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const driver = { firstName: "Max", lastName: "Zusatz", birthDate: new Date("1990-01-01"), street: "Weg 2", zip: "28195", city: "Bremen", country: "DE", licenseNumber: "Z123", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2032-01-01"), licenseCountry: "DE", licenseIssuedBy: "Bremen" };

test("Vertrag: ohne Zusatzfahrer weiter zur Zusammenfassung; vorhandener Zusatzfahrer bleibt bei Navigation erhalten; bewusst hinzufügen und entfernen", async () => {
  const w = await createWorld("r2-drivers");
  tenants.push(w.tenantId);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  // Schritt 5 → 6 ohne Zusatzfahrer: kein Formular nötig, keine Blocker im Bereich ADDITIONAL_DRIVER
  await setWizardStep(w.tenantId, c.id, 6);
  let s = await getContractState(w.tenantId, c.id);
  assert.equal(s.contract.wizardStep, 6);
  assert.equal(s.issues.filter((i) => i.area === "ADDITIONAL_DRIVER").length, 0);
  assert.equal(s.contract.drivers.filter((d) => d.role === "ADDITIONAL_DRIVER").length, 0);
  // bewusst hinzufügen (bestehende Validierung), dann navigieren: der Fahrer verschwindet nicht
  await addAdditionalDriver(w.tenantId, c.id, driver);
  await setWizardStep(w.tenantId, c.id, 5);
  await setWizardStep(w.tenantId, c.id, 6);
  s = await getContractState(w.tenantId, c.id);
  const add = s.contract.drivers.filter((d) => d.role === "ADDITIONAL_DRIVER");
  assert.deepEqual(add.map((d) => `${d.firstName} ${d.lastName}`), ["Max Zusatz"]);
  await removeAdditionalDriver(w.tenantId, c.id, add[0].id);
  assert.equal((await getContractState(w.tenantId, c.id)).contract.drivers.filter((d) => d.role === "ADDITIONAL_DRIVER").length, 0);
});

test("Vertrag: Mietbedingungen-Bestätigung entfernt den Blocker; eine gültige Mieterunterschrift überlebt beliebig viele Seitenaufrufe und Schrittwechsel", async () => {
  const w = await createWorld("r2-sign");
  tenants.push(w.tenantId);
  const d = await createTermsDraft(w.tenantId, w.actor, { content: "§1 Testbedingungen für den Regressionstest der Kenntnisnahme.", label: "2026-10" });
  await publishTermsVersion(w.tenantId, d.id, w.actor, { confirmed: true });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  let s = await getContractState(w.tenantId, c.id);
  assert.ok(s.issues.some((i) => i.code === "TERMS_ACK_MISSING"), "vor der Bestätigung blockiert die Kenntnisnahme");
  await acknowledgeTerms(w.tenantId, c.id, w.actor, { confirmed: true });
  s = await getContractState(w.tenantId, c.id);
  assert.ok(!s.issues.some((i) => i.code === "TERMS_ACK_MISSING"), "nach der Bestätigung ist der Punkt sofort aus dem Serverstand verschwunden");

  // Unterschrift genau mit dem angezeigten Stand (wie die Seite: Hash aus getContractState)
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: s.hash, ipAddress: null, userAgent: "test" });
  for (const step of [6, 7, 5, 7]) {
    await setWizardStep(w.tenantId, c.id, step);
    const again = await getContractState(w.tenantId, c.id);
    assert.equal(again.hash, s.hash, `Schrittwechsel auf ${step} ändert den Vertragsstand nicht`);
    assert.ok(again.signatures.some((x) => x.role === "RENTER"), `Unterschrift bleibt nach Navigation auf Schritt ${step} erhalten`);
  }
  // Vermieterunterschrift ist optional und verwirft die Mieterunterschrift nicht
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "EMPLOYEE", signerName: "Test Mitarbeiter", imageDataUrl: fakeSignaturePng(2), seenHash: s.hash, ipAddress: null, userAgent: "test" });
  s = await getContractState(w.tenantId, c.id);
  assert.deepEqual(s.signatures.map((x) => x.role).sort(), ["EMPLOYEE", "RENTER"]);
  await finalizeContract(w.tenantId, c.id);
  const v = await verifyContract(w.tenantId, c.id);
  assert.equal(v.intact, true, "Integritätsprüfung nutzt die Prüfsumme weiterhin");
  assert.match(v.storedHash ?? "", /^[a-f0-9]{64}$/, "SHA-256 bleibt gespeichert");
});

async function photo(w: World, handoverId: string, category: string) {
  const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  return registerPhoto(w.tenantId, w.actor, { handoverId, storageKey, category, contentType: "image/jpeg", sizeBytes: 250_000, checksum: sha256(storageKey) });
}

test("Übergabe: eine Unterschrift genügt – Seitenaufrufe, Schrittwechsel und die optionale Vermieterunterschrift verwerfen sie nicht; Abschluss erkennt sie", async () => {
  const w = await returnedWorld("r2-handover", { stopAfterPickup: true });
  tenants.push(w.tenantId);
  // neue Miete im selben Mandanten bis zur unterschriftsreifen Übergabe
  const w2 = await returnedWorld("r2-handover-2", { within: w, stopAfterPickup: true });
  const p = await db.handover.findFirstOrThrow({ where: { bookingId: w2.bookingId, type: "PICKUP" } });
  // die fertige Übergabe von w2 ist bereits finalisiert – wir brauchen einen Entwurf: dritte Miete von Hand
  const contract = await db.rentalContract.findFirstOrThrow({ where: { bookingId: w2.bookingId } });
  assert.ok(p.finalizedAt && contract.status === "SIGNED");
  const vehicle = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-R2 1", make: "VW", model: "Crafter", groupId: w.groupId, fuel: "DIESEL", mileage: 45_000, dailyRate: 89, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 500, requiredLicenseClass: "B" } });
  const start = new Date(Date.now() + 86400_000);
  const booking = await db.booking.create({ data: { tenantId: w.tenantId, number: `T-r2-${Date.now().toString(36)}`, vehicleId: vehicle.id, customerId: w.customerId, startAt: start, endAt: new Date(start.getTime() + 2 * 86400_000), dailyRate: 89, deposit: 500 } });
  const w3: World = { ...w, vehicleId: vehicle.id, bookingId: booking.id };
  const { ensureContractDraft: ecd, finalizeContract: fc, getContractContentHash: gh, saveConditions, saveContractSignature: scs } = await import("../src/lib/contracts");
  const c = await ecd(w3.tenantId, w3.bookingId, w3.actor);
  await saveConditions(w3.tenantId, c.id, { startAt: booking.startAt, endAt: booking.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: null, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await scs(w3.tenantId, w3.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await gh(w3.tenantId, c.id), ipAddress: null, userAgent: "test" });
  await fc(w3.tenantId, c.id);
  const h = await startHandover(w3.tenantId, w3.bookingId, "PICKUP", w3.actor);
  await updateHandoverDraft(w3.tenantId, h.id, { mileage: 45_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w3, h.id, cat);
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w3.tenantId, handoverId: h.id } });
  await answerChecklist(w3.tenantId, h.id, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? (i.itemKey === "keys" ? "2" : "") : i.answerType === "YES_NO" ? "YES" : "OK" })));
  await verifyAllDriversForPickup(w3.tenantId, w3.actor, h.id, c.id);

  const seen = (await getHandoverState(w3.tenantId, h.id)).hash;
  await saveHandoverSignature(w3.tenantId, w3.actor, h.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: seen, ipAddress: null, userAgent: "test" });
  // Seitenaufrufe (getHandoverState ruft touch) und Schrittwechsel 7 → 6 → 7 → 8 ändern den Protokollstand nicht
  for (const step of [7, 6, 7, 8]) {
    await setHandoverStep(w3.tenantId, h.id, step);
    const st = await getHandoverState(w3.tenantId, h.id);
    assert.equal(st.hash, seen, `Schritt ${step}: Protokollstand unverändert`);
    assert.equal(st.signatures.filter((x) => x.role === "RENTER").length, 1, `Schritt ${step}: genau eine Mieterunterschrift`);
  }
  let done = await getHandoverCompletionStatus(w3.tenantId, h.id);
  assert.deepEqual([done.renterSigned, done.ready, done.blockers.length], [true, true, 0], "Abschluss erkennt die eine Unterschrift");
  // optionale Vermieterunterschrift: verwirft nichts
  await saveHandoverSignature(w3.tenantId, w3.actor, h.id, { role: "EMPLOYEE", signerName: "Test Mitarbeiter", imageDataUrl: fakeSignaturePng(2), seenHash: await getHandoverContentHash(w3.tenantId, h.id), ipAddress: null, userAgent: "test" });
  const st = await getHandoverState(w3.tenantId, h.id);
  assert.deepEqual(st.signatures.map((x) => x.role).sort(), ["EMPLOYEE", "RENTER"]);
  done = await getHandoverCompletionStatus(w3.tenantId, h.id);
  assert.equal(done.ready, true);
  // eine fachliche Änderung (neues Foto) verwirft die Unterschrift bewusst – das ist gewollt und bleibt so
  await photo(w3, h.id, "OTHER");
  assert.equal((await getHandoverState(w3.tenantId, h.id)).signatures.length, 0);
  assert.equal((await verifyHandover(w3.tenantId, p.id)).intact, true, "Integritätsprüfung des versiegelten Protokolls nutzt die Prüfsumme weiterhin");
});

test("Kaution zählt nie als Mietzahlung", async () => {
  const w = await returnedWorld("r2-deposit");
  tenants.push(w.tenantId);
  const before = await rentalPaymentSummary(w.tenantId, w.bookingId);
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: new Date(Date.now() - 60_000) });
  const after1 = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([after1.paidCents, after1.openCents, after1.status], [before.paidCents, before.openCents, before.status]);
});
