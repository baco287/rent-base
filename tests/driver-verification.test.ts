// Phase 19.5: Fahreridentifikation und Führerscheinprüfung bei der Übergabe. Standardfall, Zusatzfahrer, Mieter ≠
// Fahrer, abgelaufen, Klasse, Mismatch, Personalausweiskopie mit/ohne Zustimmung, keine Kopie (Regression), Storage,
// Unveränderlichkeit, Mandantentrennung.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { addAdditionalDriver, ensureContractDraft, finalizeContract, getContractContentHash, saveContractSignature, setOtherDriver, type DriverInput } from "../src/lib/contracts";
import { DomainError, isImmutableError } from "../src/lib/integrity";
import {
  classSatisfiesRequirement,
  confirmVerification,
  deleteDriverDocumentCopy,
  driverVerificationBlockers,
  driverVerificationOverview,
  isEuEeaChCountry,
  pickupDriverCheckStatus,
  readDriverDocumentCopy,
  recordDriverDocumentCopy,
  recordIdentityCheck,
  recordLicenseCheck,
  requiredLicenseClassFor,
  startOrGetVerification,
  updateCustomerLicenseFromVerification,
} from "../src/lib/driver-verification";
import { answerChecklist, finalizeHandover, getHandoverContentHash, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { buildStorageKey } from "../src/lib/storage";
import { sha256 } from "../src/lib/integrity";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";
import { photoJpeg } from "./pdf-fixtures";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

// Magic Bytes genügen für den Foto-Upload der Übergabe (nur sniffImageType); die Dokumentkopie geht zusätzlich durch
// sharp (Stempel) und braucht deshalb ein echtes, dekodierbares Bild (siehe realJpeg()).
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const realJpeg = (label = "Test") => photoJpeg(label, 400, 300);

/** Mandant mit abgeschlossenem Mietvertrag (Fahrzeug erfordert Klasse B) und begonnener Übergabe (Entwurf). */
async function pickupWorld(label: string, opts: { otherDriver?: DriverInput; additionalDriver?: DriverInput } = {}): Promise<World & { handoverId: string; contractId: string; primaryDriverId: string; additionalDriverId?: string }> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { requiredLicenseClass: "B" } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  if (opts.otherDriver) await setOtherDriver(w.tenantId, c.id, opts.otherDriver);
  let additionalDriverId: string | undefined;
  if (opts.additionalDriver) additionalDriverId = (await addAdditionalDriver(w.tenantId, c.id, opts.additionalDriver)).id;
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  const handover = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, handover.id, { mileage: 50_020, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) {
    const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
    await registerPhoto(w.tenantId, w.actor, { handoverId: handover.id, storageKey, category: cat, contentType: "image/jpeg", sizeBytes: jpeg.length, checksum: sha256(storageKey) });
  }
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId: handover.id } });
  await answerChecklist(w.tenantId, handover.id, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2 Schlüssel" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  const drivers = await db.contractDriver.findMany({ where: { tenantId: w.tenantId, contractId: c.id } });
  const primary = drivers.find((d) => d.role === "PRIMARY_DRIVER")!;
  return { ...w, handoverId: handover.id, contractId: c.id, primaryDriverId: primary.id, additionalDriverId };
}

async function signAndFinalize(w: World & { handoverId: string }) {
  const hash = await getHandoverContentHash(w.tenantId, w.handoverId);
  await saveHandoverSignature(w.tenantId, w.actor, w.handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: hash });
  return finalizeHandover(w.tenantId, w.handoverId, w.actor);
}

/** Vollständige, gültige Prüfung eines Fahrers: deutscher Führerschein Klasse B, alles bestätigt. */
async function verifyOk(w: World & { handoverId: string }, contractDriverId: string, overrides: Partial<Parameters<typeof recordLicenseCheck>[3]> = {}) {
  const v = await startOrGetVerification(w.tenantId, w.actor, w.handoverId, contractDriverId);
  await recordIdentityCheck(w.tenantId, w.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: true });
  await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "B072RRE2I55", licenseCountry: "DE", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2033-06-01"), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false, ...overrides });
  return confirmVerification(w.tenantId, w.actor, v.id);
}

test("Fahrerlaubnisklassen und Länder: § 6 Abs. 3 FeV Einschlüsse, EU/EWR/Schweiz-Liste", () => {
  assert.equal(requiredLicenseClassFor({ requiredLicenseClass: null }, { requiredLicenseClass: null, bodyType: "PKW" }), "B");
  assert.equal(requiredLicenseClassFor({ requiredLicenseClass: null }, { requiredLicenseClass: null, bodyType: "TRANSPORTER" }), null);
  assert.equal(requiredLicenseClassFor({ requiredLicenseClass: "C1" }, { requiredLicenseClass: "B", bodyType: "PKW" }), "C1", "Fahrzeug schlägt Gruppe");
  assert.equal(requiredLicenseClassFor({ requiredLicenseClass: null }, { requiredLicenseClass: "BE", bodyType: "TRANSPORTER" }), "BE", "Gruppe schlägt Standard");
  assert.equal(classSatisfiesRequirement("B", ["B"]), true);
  assert.equal(classSatisfiesRequirement("AM", ["B"]), true, "B schließt AM ein (§ 6 Abs. 3)");
  assert.equal(classSatisfiesRequirement("B", ["C1"]), false, "C1 schließt B nicht automatisch ein");
  assert.equal(classSatisfiesRequirement("C1", ["C"]), true, "C schließt C1 ein");
  assert.equal(isEuEeaChCountry("DE"), true);
  assert.equal(isEuEeaChCountry("ch"), true, "Groß-/Kleinschreibung");
  assert.equal(isEuEeaChCountry("TR"), false);
  assert.equal(isEuEeaChCountry("US"), false);
});

test("Standardfall: deutscher Führerschein Klasse B, Identität und Führerschein geprüft, gültig → Übergabe möglich", async () => {
  const w = await pickupWorld("dv-standard");
  let overview = await driverVerificationOverview(w.tenantId, w.handoverId);
  assert.equal(overview.length, 1, "nur der Hauptfahrer (Mieter fährt selbst)");
  assert.equal(overview[0].status, "NOT_STARTED");
  assert.equal(overview[0].requiredLicenseClass, "B");
  let blockers = await driverVerificationBlockers(w.tenantId, w.handoverId);
  assert.equal(blockers.length, 1);
  await assert.rejects(() => signAndFinalize(w), (e) => e instanceof DomainError && /Identität und Führerschein/.test((e as Error).message));

  const confirmed = await verifyOk(w, w.primaryDriverId);
  assert.equal(confirmed.status, "CONFIRMED");
  assert.ok(confirmed.contentHash);
  overview = await driverVerificationOverview(w.tenantId, w.handoverId);
  assert.equal(overview[0].status, "CONFIRMED");
  blockers = await driverVerificationBlockers(w.tenantId, w.handoverId);
  assert.equal(blockers.length, 0);
  const done = await signAndFinalize(w);
  assert.equal(done.status, "FINALIZED");
});

test("Zusatzfahrer: nur ein Fahrer geprüft blockiert; beide bestätigt ermöglicht die Übergabe", async () => {
  const additionalDriver: DriverInput = { firstName: "Nina", lastName: "Zweit", birthDate: new Date("1988-03-03"), street: "Weg 3", zip: "28195", city: "Bremen", country: "DE", licenseNumber: "N1122334", licenseClass: "B", licenseIssuedAt: new Date("2008-01-01"), licenseValidUntil: new Date("2031-01-01") };
  const w = await pickupWorld("dv-zusatz", { additionalDriver });
  const overview0 = await driverVerificationOverview(w.tenantId, w.handoverId);
  assert.equal(overview0.length, 2, "Hauptfahrer (Mieter) + Zusatzfahrer");

  await verifyOk(w, w.primaryDriverId);
  let blockers = await driverVerificationBlockers(w.tenantId, w.handoverId);
  assert.equal(blockers.length, 1, "der Zusatzfahrer ist noch offen");
  await assert.rejects(() => signAndFinalize(w));

  await verifyOk(w, w.additionalDriverId!, { licenseNumber: "N1122334", licenseValidUntil: new Date("2031-01-01") });
  blockers = await driverVerificationBlockers(w.tenantId, w.handoverId);
  assert.equal(blockers.length, 0);
  const done = await signAndFinalize(w);
  assert.equal(done.status, "FINALIZED");
});

test("Mieter ≠ Fahrer: bei abweichendem Fahrer wird nur der tatsächliche Fahrer geprüft, nicht automatisch der Mieter", async () => {
  const otherDriver: DriverInput = { firstName: "Peter", lastName: "Fährt", birthDate: new Date("1990-01-01"), street: "Weg 5", zip: "28195", city: "Bremen", country: "DE", licenseNumber: "P5566778", licenseClass: "B", licenseIssuedAt: new Date("2009-01-01"), licenseValidUntil: new Date("2030-01-01") };
  const w = await pickupWorld("dv-mieter-ne-fahrer", { otherDriver });
  const overview = await driverVerificationOverview(w.tenantId, w.handoverId);
  assert.equal(overview.length, 1);
  assert.equal(overview[0].driver.firstName, "Peter", "nur der bestimmte Fahrer steht zur Prüfung, nicht die Mieterin");
  assert.equal(overview[0].driver.customerId, null, "kein automatischer Kundenbezug für den fremden Fahrer");
  await verifyOk(w, w.primaryDriverId, { licenseNumber: "P5566778", licenseValidUntil: new Date("2030-01-01") });
  const done = await signAndFinalize(w);
  assert.equal(done.status, "FINALIZED");
});

test("Abgelaufen: Führerschein am Übergabetag abgelaufen blockiert; Ablauf vor der geplanten Rückgabe blockiert ebenfalls", async () => {
  const w = await pickupWorld("dv-abgelaufen");
  const v = await startOrGetVerification(w.tenantId, w.actor, w.handoverId, w.primaryDriverId);
  await recordIdentityCheck(w.tenantId, w.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: true });
  const expired = await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "B072RRE2I55", licenseCountry: "DE", licenseIssuedAt: new Date("2005-01-01"), licenseValidUntil: new Date(Date.now() - 86_400_000), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false });
  assert.equal(expired.status, "BLOCKED");
  assert.ok(expired.blockedReasons.includes("LICENSE_EXPIRED"));
  await assert.rejects(() => confirmVerification(w.tenantId, w.actor, v.id), DomainError);

  const booking = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const beforeReturn = await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "B072RRE2I55", licenseCountry: "DE", licenseIssuedAt: new Date("2005-01-01"), licenseValidUntil: new Date(booking.endAt.getTime() - 86_400_000), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false });
  assert.ok(beforeReturn.blockedReasons.includes("LICENSE_EXPIRES_BEFORE_RETURN"));

  // gültig bis weicht bewusst vom Kundenstammdatensatz ab (realistischer Fall: Original zeigt ein neueres Datum) → braucht die bewusste Bestätigung
  const ok = await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "B072RRE2I55", licenseCountry: "DE", licenseIssuedAt: new Date("2005-01-01"), licenseValidUntil: new Date(booking.endAt.getTime() + 365 * 86_400_000), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false, deviationConfirmed: true });
  assert.equal(ok.blockedReasons.length, 0);
  await confirmVerification(w.tenantId, w.actor, v.id);
});

test("Fahrerlaubnisklasse: Fahrzeug benötigt B, Fahrer ohne B blockiert, mit B möglich", async () => {
  const w = await pickupWorld("dv-klasse");
  const v = await startOrGetVerification(w.tenantId, w.actor, w.handoverId, w.primaryDriverId);
  await recordIdentityCheck(w.tenantId, w.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: true });
  const noB = await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "B072RRE2I55", licenseCountry: "DE", licenseIssuedAt: new Date("2005-01-01"), licenseValidUntil: new Date("2033-01-01"), licenseClasses: ["AM"], internationalPermitPresented: false, translationPresented: false });
  assert.equal(noB.licenseClassSatisfied, false);
  assert.ok(noB.blockedReasons.includes("LICENSE_CLASS_INSUFFICIENT"));
  const withB = await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "B072RRE2I55", licenseCountry: "DE", licenseIssuedAt: new Date("2005-01-01"), licenseValidUntil: new Date("2033-06-01"), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false });
  assert.equal(withB.licenseClassSatisfied, true);
  assert.equal(withB.blockedReasons.length, 0);
});

test("Mismatch: Name oder Geburtsdatum stimmt nicht überein blockiert; Kundenstammdaten ändern sich nicht automatisch", async () => {
  const w = await pickupWorld("dv-mismatch");
  const customer = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  const before = { licenseNumber: customer.licenseNumber, licenseValidUntil: customer.licenseValidUntil?.getTime() };
  const v = await startOrGetVerification(w.tenantId, w.actor, w.handoverId, w.primaryDriverId);
  const badName = await recordIdentityCheck(w.tenantId, w.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: false, birthDateMatched: true });
  assert.equal(badName.status, "BLOCKED");
  assert.ok(badName.blockedReasons.includes("IDENTITY_NAME_MISMATCH"));
  const badBirth = await recordIdentityCheck(w.tenantId, w.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: false });
  assert.ok(badBirth.blockedReasons.includes("IDENTITY_BIRTHDATE_MISMATCH"));
  await recordIdentityCheck(w.tenantId, w.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: true });
  // Führerschein weicht von Kundendaten ab: blockiert, bis bewusst bestätigt; Kundendaten bleiben unverändert
  const dev = await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "ABWEICHEND999", licenseCountry: "DE", licenseIssuedAt: new Date("2005-01-01"), licenseValidUntil: new Date("2033-06-01"), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false });
  assert.equal(dev.deviatesFromCustomer, true);
  assert.ok(dev.blockedReasons.includes("LICENSE_DEVIATES_FROM_CUSTOMER"));
  const stillSame = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  assert.deepEqual({ licenseNumber: stillSame.licenseNumber, licenseValidUntil: stillSame.licenseValidUntil?.getTime() }, before, "keine automatische Änderung");
  const confirmedDev = await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "ABWEICHEND999", licenseCountry: "DE", licenseIssuedAt: new Date("2005-01-01"), licenseValidUntil: new Date("2033-06-01"), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false, deviationConfirmed: true });
  assert.equal(confirmedDev.blockedReasons.length, 0);
  const done = await confirmVerification(w.tenantId, w.actor, v.id);
  assert.equal(done.status, "CONFIRMED");
  // bewusste, separate Übernahme in die Stammdaten – nur dann ändern sie sich
  await updateCustomerLicenseFromVerification(w.tenantId, w.actor, v.id);
  const updated = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  assert.equal(updated.licenseNumber, "ABWEICHEND999");
});

test("Ausländischer Führerschein: außerhalb EU/EWR/Schweiz ohne Übersetzung/IFS blockiert bis zur bewussten manuellen Prüfung", async () => {
  const w = await pickupWorld("dv-ausland");
  const v = await startOrGetVerification(w.tenantId, w.actor, w.handoverId, w.primaryDriverId);
  await recordIdentityCheck(w.tenantId, w.actor, v.id, { documentType: "REISEPASS", originalSeen: true, nameMatched: true, birthDateMatched: true });
  const open = await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "TR-99887766", licenseCountry: "TR", licenseIssuedAt: new Date("2015-01-01"), licenseValidUntil: new Date("2033-01-01"), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false });
  assert.equal(open.manualReviewRequired, true);
  assert.ok(open.blockedReasons.includes("LICENSE_MANUAL_REVIEW_OPEN"));
  // ausländischer Führerschein weicht naturgemäß von den deutschen Kundenstammdaten ab → zusätzlich bewusst bestätigen
  const confirmedManual = await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "TR-99887766", licenseCountry: "TR", licenseIssuedAt: new Date("2015-01-01"), licenseValidUntil: new Date("2033-01-01"), licenseClasses: ["B"], internationalPermitPresented: true, translationPresented: false, manualReviewConfirmed: true, deviationConfirmed: true });
  assert.equal(confirmedManual.blockedReasons.length, 0);
  await confirmVerification(w.tenantId, w.actor, v.id);
  // EU-Land ohne IFS/Übersetzung braucht keine manuelle Prüfung (abweichende Daten hier bewusst bestätigt)
  const w2 = await pickupWorld("dv-eu");
  const v2 = await startOrGetVerification(w2.tenantId, w2.actor, w2.handoverId, w2.primaryDriverId);
  await recordIdentityCheck(w2.tenantId, w2.actor, v2.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: true });
  const eu = await recordLicenseCheck(w2.tenantId, w2.actor, v2.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: "AT-1234", licenseCountry: "AT", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2033-01-01"), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false, deviationConfirmed: true });
  assert.equal(eu.manualReviewRequired, false);
  assert.equal(eu.blockedReasons.length, 0);
});

test("Personalausweiskopie: ohne Zustimmung blockiert, mit Zustimmung möglich, dauerhaft als Kopie gekennzeichnet; Originalprüfung funktioniert auch ganz ohne Kopie", async () => {
  const w = await pickupWorld("dv-kopie");
  const v = await startOrGetVerification(w.tenantId, w.actor, w.handoverId, w.primaryDriverId);
  const photo1 = await realJpeg("Ausweis");
  await assert.rejects(
    () => recordDriverDocumentCopy(w.tenantId, w.actor, { bookingId: w.bookingId, handoverId: w.handoverId, verificationId: v.id, contractDriverId: w.primaryDriverId, documentKind: "IDENTITY", side: "FRONT", bytes: photo1, consent: { given: false } }),
    (e) => e instanceof DomainError && /Zustimmung/.test((e as Error).message),
  );
  assert.equal((await (await import("../src/lib/driver-verification")).listDriverDocumentCopies(w.tenantId, w.handoverId)).length, 0);
  const copy = await recordDriverDocumentCopy(w.tenantId, w.actor, { bookingId: w.bookingId, handoverId: w.handoverId, verificationId: v.id, contractDriverId: w.primaryDriverId, documentKind: "IDENTITY", side: "FRONT", bytes: photo1, consent: { given: true } });
  assert.equal(copy.markedAsCopy, true);
  assert.equal(copy.consentGiven, true);
  assert.ok(copy.consentAt);
  assert.equal(copy.consentRecordedById, w.actor.id);
  const read = await readDriverDocumentCopy(w.tenantId, copy.id);
  assert.ok(read);
  assert.equal(read!.contentType, "image/jpeg");
  assert.notDeepEqual(Buffer.from(read!.body), Buffer.from(photo1), "das Bild wurde gestempelt, nicht unverändert gespeichert");

  // Führerscheinkopie braucht keine Zustimmung, trägt aber denselben Zweckvermerk und dieselbe Kennzeichnung
  const photo2 = await realJpeg("Fuehrerschein");
  const licCopy = await recordDriverDocumentCopy(w.tenantId, w.actor, { bookingId: w.bookingId, handoverId: w.handoverId, verificationId: v.id, contractDriverId: w.primaryDriverId, documentKind: "LICENSE", side: "FRONT", bytes: photo2 });
  assert.equal(licCopy.consentRequired, false);
  assert.equal(licCopy.markedAsCopy, true);

  // Regressionstest: Prüfung vollständig ohne jede Kopie möglich
  const w2 = await pickupWorld("dv-ohne-kopie");
  await verifyOk(w2, w2.primaryDriverId);
  const done = await signAndFinalize(w2);
  assert.equal(done.status, "FINALIZED");
  assert.equal((await (await import("../src/lib/driver-verification")).listDriverDocumentCopies(w2.tenantId, w2.handoverId)).length, 0);
});

test("Storage: Mandantentrennung, falsche Zuordnung, Löschen entfernt die Datei aber nicht den Prüfvermerk", async () => {
  const w = await pickupWorld("dv-storage-a");
  const other = await createWorld("dv-storage-b");
  tenants.push(other.tenantId);
  const v = await startOrGetVerification(w.tenantId, w.actor, w.handoverId, w.primaryDriverId);
  const storagePhoto = await realJpeg("Storage");
  const copy = await recordDriverDocumentCopy(w.tenantId, w.actor, { bookingId: w.bookingId, handoverId: w.handoverId, verificationId: v.id, contractDriverId: w.primaryDriverId, documentKind: "LICENSE", side: "FRONT", bytes: storagePhoto });
  assert.equal(await readDriverDocumentCopy(other.tenantId, copy.id), null, "fremder Mandant findet die Kopie nicht");

  // falsche Booking-/Fahrer-Zuordnung wird abgelehnt
  const w2 = await pickupWorld("dv-storage-c");
  const v2 = await startOrGetVerification(w2.tenantId, w2.actor, w2.handoverId, w2.primaryDriverId);
  await assert.rejects(
    () => recordDriverDocumentCopy(w.tenantId, w.actor, { bookingId: w2.bookingId, handoverId: w2.handoverId, verificationId: v.id, contractDriverId: w.primaryDriverId, documentKind: "LICENSE", side: "FRONT", bytes: jpeg }),
    DomainError,
  );
  void v2;

  // manipulierter Inhaltstyp wird abgelehnt (kein echtes Bild)
  await assert.rejects(
    () => recordDriverDocumentCopy(w.tenantId, w.actor, { bookingId: w.bookingId, handoverId: w.handoverId, verificationId: v.id, contractDriverId: w.primaryDriverId, documentKind: "LICENSE", side: "FRONT", bytes: new TextEncoder().encode("<svg onload=alert(1)>") }),
    (e) => e instanceof DomainError && /Format/.test((e as Error).message),
  );

  // Löschen: Datei weg, Zeile bleibt als Nachweis, Prüfvermerk unberührt
  await deleteDriverDocumentCopy(w.tenantId, w.actor, copy.id, "Testlöschung");
  assert.equal(await readDriverDocumentCopy(w.tenantId, copy.id), null);
  const row = await db.driverDocumentCopy.findUniqueOrThrow({ where: { id: copy.id } });
  assert.equal(row.deletionStatus, "DELETED");
  assert.ok(row.deletedAt);
  const stillThere = await db.driverVerification.findUniqueOrThrow({ where: { id: v.id } });
  assert.equal(stillThere.id, v.id, "Prüfvermerk bleibt vollständig erhalten");
});

test("Unveränderlichkeit: bestätigter Prüfvermerk kann nicht mehr bearbeitet werden; Kundenänderung danach wirkt sich nicht auf den Snapshot aus", async () => {
  const w = await pickupWorld("dv-immutable");
  const confirmed = await verifyOk(w, w.primaryDriverId);
  await assert.rejects(
    () => recordIdentityCheck(w.tenantId, w.actor, confirmed.id, { documentType: "REISEPASS", originalSeen: true, nameMatched: true, birthDateMatched: true }),
    (e) => isImmutableError(e),
  );
  await assert.rejects(() => confirmVerification(w.tenantId, w.actor, confirmed.id), (e) => isImmutableError(e));
  await assert.rejects(
    () => db.driverVerification.update({ where: { id: confirmed.id }, data: { notes: "Manipuliert" } }),
    (e) => /RB_IMMUTABLE/.test((e as Error).message),
  );
  await db.customer.update({ where: { id: w.customerId }, data: { licenseValidUntil: new Date("2099-01-01") } });
  const stillFrozen = await db.driverVerification.findUniqueOrThrow({ where: { id: confirmed.id } });
  assert.equal(stillFrozen.licenseValidUntilSnapshot?.getTime(), new Date("2033-06-01").getTime(), "Kundenänderung ändert den historischen Snapshot nicht");
});

test("Mandantentrennung: fremder Mandant sieht keine Fahrerprüfungen, Dashboard-Status je Mandant getrennt", async () => {
  const w = await pickupWorld("dv-tenant-a");
  await verifyOk(w, w.primaryDriverId);
  const other = await createWorld("dv-tenant-b");
  tenants.push(other.tenantId);
  assert.equal((await driverVerificationOverview(other.tenantId, w.handoverId)).length, 0);
  assert.deepEqual(await driverVerificationBlockers(other.tenantId, w.handoverId), []);
  const status = await pickupDriverCheckStatus(w.tenantId, [w.bookingId]);
  assert.equal(status.get(w.bookingId)?.confirmed, 1);
  const statusOther = await pickupDriverCheckStatus(other.tenantId, [w.bookingId]);
  assert.equal(statusOther.size, 0, "fremder Mandant erhält keinen Stand zu dieser Buchung");
});

test("Dashboard-Stand: erforderlich/bestätigt/blockiert/manuelle Prüfung je Buchung, eine Abfrage für mehrere Buchungen", async () => {
  const w = await pickupWorld("dv-dash-a");
  const w2 = await pickupWorld("dv-dash-b");
  await verifyOk(w, w.primaryDriverId);
  const v2 = await startOrGetVerification(w2.tenantId, w2.actor, w2.handoverId, w2.primaryDriverId);
  await recordIdentityCheck(w2.tenantId, w2.actor, v2.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: false, birthDateMatched: true });
  const status = await pickupDriverCheckStatus(w.tenantId, [w.bookingId]);
  assert.equal(status.get(w.bookingId)?.required, 1);
  assert.equal(status.get(w.bookingId)?.confirmed, 1);
  assert.equal(status.get(w.bookingId)?.blocked, 0);
  const status2 = await pickupDriverCheckStatus(w2.tenantId, [w2.bookingId]);
  assert.equal(status2.get(w2.bookingId)?.blocked, 1);
  assert.equal(status2.get(w2.bookingId)?.confirmed, 0);
});
