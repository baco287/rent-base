// Integrationstest des Mietvertragsprozesses (Phase 3) gegen die lokale Entwicklungsdatenbank.
// Aufruf: npm test
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import {
  addAdditionalDriver,
  ensureContractDraft,
  finalizeContract,
  getContractContentHash,
  getContractState,
  removeAdditionalDriver,
  saveConditions,
  saveContractSignature,
  setOtherDriver,
  setRenterDrives,
  verifyContract,
  type DriverInput,
} from "../src/lib/contracts";
import { bookingStage, changeBookingStatus } from "../src/lib/booking-status";
import { buildContractDocument } from "../src/lib/contract-view";
import { startHandover } from "../src/lib/handovers";
import { isImmutableError } from "../src/lib/integrity";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";

const tenants: string[] = [];
async function world(label: string, opts?: Parameters<typeof createWorld>[1]): Promise<World> {
  const w = await createWorld(label, opts);
  tenants.push(w.tenantId);
  return w;
}
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const otherDriver: DriverInput = {
  firstName: "Max", lastName: "Fahrer", birthDate: new Date("1990-05-01"), street: "Hafen 3", zip: "28217", city: "Bremen", country: "DE",
  licenseNumber: "Z999AA11", licenseClass: "B", licenseIssuedAt: new Date("2010-06-01"), licenseValidUntil: new Date("2033-06-01"), licenseCountry: "DE",
};

async function sign(w: World, contractId: string, role: "RENTER" | "EMPLOYEE" = "RENTER") {
  const seenHash = await getContractContentHash(w.tenantId, contractId);
  return saveContractSignature(w.tenantId, w.actor, contractId, { role, signerName: role === "RENTER" ? "Erika Muster" : w.actor.name, imageDataUrl: fakeSignaturePng(), seenHash, ipAddress: "203.0.113.5", userAgent: "test" });
}
const errorCodes = async (w: World, contractId: string) => (await getContractState(w.tenantId, contractId)).issues.filter((i) => i.severity === "error").map((i) => i.code);

async function rejectsImmutable(fn: () => Promise<unknown>, what: string) {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(isImmutableError(e), `${what}: erwartet RB_IMMUTABLE, bekam ${(e as Error).message}`);
    return true;
  });
}

test("Vertrag entsteht aus der Buchung, genau einmal, mit Nummer vom Server", async () => {
  const w = await world("create");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.match(c.number, /^MV-\d{4}-0001$/);
  assert.equal(c.status, "DRAFT");
  assert.equal(c.bookingId, w.bookingId);

  // erneuter Aufruf und gleichzeitige Aufrufe: es bleibt bei einem Vertrag
  const again = await Promise.all([1, 2, 3].map(() => ensureContractDraft(w.tenantId, w.bookingId, w.actor)));
  assert.deepEqual(new Set(again.map((x) => x.id)), new Set([c.id]));
  assert.equal(await db.rentalContract.count({ where: { bookingId: w.bookingId } }), 1);

  const booking = await db.booking.findFirstOrThrow({ where: { id: w.bookingId } });
  assert.equal(bookingStage(booking, c), "CONTRACT_DRAFT");
});

test("Vertragsnummern sind je Mandant eindeutig, auch bei gleichzeitigen Anfragen", async () => {
  const w = await world("numbers");
  const start = new Date(Date.now() + 40 * 24 * 3600_000);
  const bookings = [];
  for (let i = 0; i < 5; i++) {
    const v = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-N ${i}${Date.now() % 10000}`, make: "VW", model: "Golf", groupId: w.groupId, dailyRate: 49 } });
    bookings.push(await db.booking.create({ data: { tenantId: w.tenantId, number: `N-${i}-${Date.now()}`, vehicleId: v.id, customerId: w.customerId, startAt: start, endAt: new Date(start.getTime() + 2 * 24 * 3600_000), dailyRate: 49 } }));
  }
  const contracts = await Promise.all(bookings.map((b) => ensureContractDraft(w.tenantId, b.id, w.actor)));
  const numbers = contracts.map((c) => c.number);
  assert.equal(new Set(numbers).size, 5, `doppelte Nummern: ${numbers.join(", ")}`);
  for (const n of numbers) assert.match(n, /^MV-\d{4}-\d{4}$/);
});

test("bestehender, vollständiger Kunde: keine Beanstandung, Mieter ist Fahrer", async () => {
  const w = await world("complete");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const state = await getContractState(w.tenantId, c.id);
  assert.deepEqual(state.issues.filter((i) => i.severity === "error"), []);
  const primary = state.contract.drivers.find((d) => d.role === "PRIMARY_DRIVER");
  assert.ok(primary, "Fahrer-Kopie aus dem Mieter");
  assert.equal(primary.customerId, w.customerId);
  assert.equal(primary.licenseNumber, "B072RRE2I55");
  assert.equal(state.contract.driverMode, "RENTER");
});

test("Kunde mit fehlenden Daten: klare Meldungen, kein Abschluss, nach Ergänzung in Ordnung", async () => {
  const w = await world("missing", { customer: { birthDate: null, street: null, idNumber: null, licenseNumber: null, licenseValidUntil: null } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const codes = await errorCodes(w, c.id);
  for (const expected of ["CUSTOMER_BIRTHDATE", "CUSTOMER_STREET", "CUSTOMER_ID", "LICENSE_NUMBER", "LICENSE_VALIDITY", "DRIVER_BIRTHDATE"]) assert.ok(codes.includes(expected), `${expected} fehlt in ${codes.join(", ")}`);
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /fehl/i);

  // Mitarbeiter ergänzt die Daten in Schritt 1
  await db.customer.update({ where: { id: w.customerId }, data: { birthDate: new Date("1985-03-12"), street: "Weg 1", idNumber: "L01X00T47", licenseNumber: "B072RRE2I55", licenseValidUntil: new Date("2033-06-01") } });
  assert.deepEqual(await errorCodes(w, c.id), []);
});

test("gesperrter Kunde: deutlicher Fehler, Abschluss unmöglich", async () => {
  const w = await world("blocked", { customer: { blocked: true, blockReason: "Schaden nicht bezahlt" } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.ok((await errorCodes(w, c.id)).includes("CUSTOMER_BLOCKED"));
  await sign(w, c.id);
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /gesperrt/);
  assert.equal((await db.rentalContract.findFirstOrThrow({ where: { id: c.id } })).status, "DRAFT");
});

test("abweichender Fahrer und zurück zu 'Mieter fährt selbst'", async () => {
  const w = await world("driver");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await setOtherDriver(w.tenantId, c.id, otherDriver);
  let state = await getContractState(w.tenantId, c.id);
  let primary = state.contract.drivers.filter((d) => d.role === "PRIMARY_DRIVER");
  assert.equal(primary.length, 1);
  assert.equal(primary[0].lastName, "Fahrer");
  assert.equal(primary[0].customerId, null);
  assert.equal(state.contract.driverMode, "OTHER");

  await setRenterDrives(w.tenantId, c.id);
  state = await getContractState(w.tenantId, c.id);
  primary = state.contract.drivers.filter((d) => d.role === "PRIMARY_DRIVER");
  assert.equal(primary.length, 1);
  assert.equal(primary[0].lastName, "Muster");
});

test("abgelaufener Führerschein wird serverseitig erkannt", async () => {
  const w = await world("license");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await setOtherDriver(w.tenantId, c.id, { ...otherDriver, licenseValidUntil: new Date("2020-01-01") });
  assert.ok((await errorCodes(w, c.id)).includes("LICENSE_EXPIRED"));
  await sign(w, c.id);
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /abgelaufen/);

  // auch beim Mieter selbst
  await setRenterDrives(w.tenantId, c.id);
  await db.customer.update({ where: { id: w.customerId }, data: { licenseValidUntil: new Date("2021-01-01") } });
  assert.ok((await errorCodes(w, c.id)).includes("LICENSE_EXPIRED"));
});

test("Zusatzfahrer: manuell und aus bestehendem Kunden, mit eigener Kopie", async () => {
  const w = await world("additional");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const second = await db.customer.create({ data: { tenantId: w.tenantId, firstName: "Jonas", lastName: "Zweit", street: "Ring 4", zip: "28203", city: "Bremen", birthDate: new Date("1992-02-02"), licenseNumber: "J111", licenseClass: "B", licenseIssuedAt: new Date("2011-01-01"), licenseValidUntil: new Date("2034-01-01") } });
  await addAdditionalDriver(w.tenantId, c.id, otherDriver);
  await addAdditionalDriver(w.tenantId, c.id, { ...otherDriver, customerId: second.id, firstName: "Jonas", lastName: "Zweit", licenseNumber: "J111" });
  const other = await world("additional-foreign");
  await assert.rejects(() => addAdditionalDriver(w.tenantId, c.id, { ...otherDriver, customerId: other.customerId }), /gehört nicht zu diesem Mandanten/);

  const state = await getContractState(w.tenantId, c.id);
  const add = state.contract.drivers.filter((d) => d.role === "ADDITIONAL_DRIVER");
  assert.equal(add.length, 2);
  assert.equal(add.find((d) => d.lastName === "Zweit")?.customerId, second.id);
  await removeAdditionalDriver(w.tenantId, c.id, add[0].id);
  assert.equal((await getContractState(w.tenantId, c.id)).contract.drivers.filter((d) => d.role === "ADDITIONAL_DRIVER").length, 1);
});

test("Konditionen: Tankregelungen, Orte, vereinbarter Preis, Zeitraum mit bestehender Konfliktprüfung", async () => {
  const w = await world("conditions");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const booking = await db.booking.findFirstOrThrow({ where: { id: w.bookingId } });
  const baseInput = { startAt: booking.startAt, endAt: booking.endAt, deposit: 750, kmIncludedPerDay: 250, extraKmRate: 0.3, deductible: 1000, fuelPolicy: "FULL_TO_FULL" as const, pickupLocation: "Hafenstr. 1, Bremen" };

  await assert.rejects(() => saveConditions(w.tenantId, c.id, { ...baseInput, fuelPolicy: "OTHER" }), /Tankregelung beschreiben/);
  await assert.rejects(() => saveConditions(w.tenantId, c.id, { ...baseInput, agreedTotal: 400 }), /begründen/);
  const saved = await saveConditions(w.tenantId, c.id, { ...baseInput, fuelPolicy: "OTHER", fuelPolicyNote: "Rückgabe mit mindestens halbem Tank", agreedTotal: 400, agreedTotalNote: "Sonderpreis", internalNote: "nur intern" });
  assert.equal(Number(saved.deposit), 750);
  assert.equal(Number(saved.totalAmount), 400);
  assert.equal((saved.priceSnapshot as { total: number; finalTotal: number }).total, 458.1, "Berechnung bleibt nachvollziehbar gespeichert");
  assert.equal((await db.booking.findFirstOrThrow({ where: { id: w.bookingId } })).deposit.toString(), "750");

  // anderer Zeitraum kollidiert mit einer zweiten Buchung desselben Fahrzeugs
  const later = new Date(booking.endAt.getTime() + 2 * 24 * 3600_000);
  await db.booking.create({ data: { tenantId: w.tenantId, number: `X-${Date.now()}`, vehicleId: w.vehicleId, customerId: w.customerId, startAt: later, endAt: new Date(later.getTime() + 3 * 24 * 3600_000), dailyRate: 89 } });
  await assert.rejects(() => saveConditions(w.tenantId, c.id, { ...baseInput, endAt: new Date(later.getTime() + 24 * 3600_000) }), /überschneidet sich/);
  const unchanged = await db.booking.findFirstOrThrow({ where: { id: w.bookingId } });
  assert.equal(unchanged.endAt.getTime(), booking.endAt.getTime());
});

test("Fahrzeug nicht mehr vermietbar oder inzwischen belegt: Abschluss wird verweigert", async () => {
  const w = await world("vehicle");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { status: "WORKSHOP" } });
  assert.ok((await errorCodes(w, c.id)).includes("VEHICLE_STATUS"));
  await sign(w, c.id);
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /nicht vermietbar/);

  await db.vehicle.update({ where: { id: w.vehicleId }, data: { status: "AVAILABLE" } });
  const booking = await db.booking.findFirstOrThrow({ where: { id: w.bookingId } });
  await db.booking.create({ data: { tenantId: w.tenantId, number: `K-${Date.now()}`, vehicleId: w.vehicleId, customerId: w.customerId, startAt: new Date(booking.startAt.getTime() + 3600_000), endAt: booking.endAt, dailyRate: 89 } });
  assert.ok((await errorCodes(w, c.id)).includes("VEHICLE_CONFLICT"));
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /bereits durch Buchung/);
});

test("Unterschrift gehört zum gesehenen Stand; jede vertragsrelevante Änderung verwirft sie", async () => {
  const w = await world("signature");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /Unterschrift des Mieters fehlt/);

  // veralteter Stand auf dem Bildschirm
  const oldHash = await getContractContentHash(w.tenantId, c.id);
  const booking = await db.booking.findFirstOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: booking.startAt, endAt: booking.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 800, fuelPolicy: "FULL_TO_FULL" });
  await assert.rejects(() => saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: oldHash }), /seit der Anzeige geändert/);
  const freshHash = await getContractContentHash(w.tenantId, c.id);
  await assert.rejects(() => saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: "data:image/png;base64,AAAA", seenHash: freshHash }), /ungültig|leer/);

  await sign(w, c.id);
  await sign(w, c.id, "EMPLOYEE");
  assert.equal((await getContractState(w.tenantId, c.id)).signatures.length, 2);

  // Änderung nach der Unterschrift: Konditionen
  await saveConditions(w.tenantId, c.id, { startAt: booking.startAt, endAt: booking.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1500, fuelPolicy: "FULL_TO_FULL" });
  assert.equal((await getContractState(w.tenantId, c.id)).signatures.length, 0, "beide Unterschriften verworfen");
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /Unterschrift des Mieters fehlt/);

  // Änderung nach der Unterschrift: Stammdaten des Kunden, außerhalb des Assistenten
  await sign(w, c.id);
  await db.customer.update({ where: { id: w.customerId }, data: { street: "Neue Straße 9" } });
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /Unterschrift des Mieters fehlt/);
  assert.equal((await getContractState(w.tenantId, c.id)).signatures.length, 0);

  // Die interne Notiz ist nicht Teil des unterschriebenen Inhalts
  await sign(w, c.id);
  await saveConditions(w.tenantId, c.id, { startAt: booking.startAt, endAt: booking.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1500, fuelPolicy: "FULL_TO_FULL", internalNote: "Kunde kommt später" });
  assert.equal((await getContractState(w.tenantId, c.id)).signatures.length, 1);
});

test("Abschluss versiegelt den Vertrag; spätere Änderungen an Preisen und Kunde wirken nicht mehr", async () => {
  const w = await world("finalize");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await addAdditionalDriver(w.tenantId, c.id, { ...otherDriver, customerId: null });
  await sign(w, c.id);
  const signed = await finalizeContract(w.tenantId, c.id);
  assert.equal(signed.status, "SIGNED");
  assert.ok(signed.signedAt);
  assert.ok(signed.contentHash);
  // 6 Tage: Woche (5 Tage) 420 + Tag 89 = 509, 10 % Rabatt = 458,10
  assert.equal(Number(signed.totalAmount), 458.1);

  const booking = await db.booking.findFirstOrThrow({ where: { id: w.bookingId } });
  assert.equal(booking.status, "RESERVED", "Buchungsstatus bleibt, der Stand ergibt sich aus dem Vertrag");
  assert.equal(bookingStage(booking, signed), "READY_FOR_PICKUP");

  // Stammdaten ändern sich danach
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { dailyRate: 199, workWeekRate: 900, extraKmRate: 0.99, plate: "HB-NEU 1" } });
  await db.booking.update({ where: { id: w.bookingId }, data: { dailyRate: 199 } });
  await db.customer.update({ where: { id: w.customerId }, data: { lastName: "Neuname", street: "Andere Str. 9", licenseNumber: "GEAENDERT" } });

  const state = await getContractState(w.tenantId, c.id);
  const snapCustomer = state.contract.customerSnapshot as { lastName: string; street: string };
  assert.equal(snapCustomer.lastName, "Muster");
  assert.equal(snapCustomer.street, "Weg 1");
  assert.equal((state.contract.vehicleSnapshot as { plate: string }).plate.startsWith("HB-T"), true);
  assert.equal(Number(state.contract.totalAmount), 458.1);
  assert.equal(Number(state.contract.extraKmRate), 0.25);
  assert.equal((state.contract.priceSnapshot as { rates: { dailyRate: number } }).rates.dailyRate, 89);
  const primary = state.contract.drivers.find((d) => d.role === "PRIMARY_DRIVER");
  assert.equal(primary?.lastName, "Muster", "Fahrer-Kopie folgt dem Kunden nicht mehr");
  assert.equal(primary?.licenseNumber, "B072RRE2I55");
  assert.equal((await verifyContract(w.tenantId, c.id)).intact, true);

  // Dieselben Daten speisen Anzeige und späteres PDF
  const tenant = await db.tenant.findFirstOrThrow({ where: { id: w.tenantId } });
  const doc = buildContractDocument(state.contract, tenant, state.signatures);
  assert.equal(doc.sections.find((s) => s.key === "renter")?.rows.find((r) => r.label === "Name")?.value, "Erika Muster");
  assert.equal(doc.additionalDrivers.length, 1);
  assert.deepEqual(doc.price.lines.map((l) => l.text.split(" zu ")[0]), ["1 × Woche (5 Tage)", "1 × Tag"]);
  assert.equal(doc.terms.version, "2026-09");
  assert.equal(doc.signatures.length, 1);
});

test("abgeschlossener Vertrag: nicht bearbeiten, nicht löschen, nicht doppelt abschließen", async () => {
  const w = await world("sealed");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await sign(w, c.id);

  // Doppelklick: zwei Abschlüsse gleichzeitig, genau einer gewinnt
  const results = await Promise.allSettled([finalizeContract(w.tenantId, c.id), finalizeContract(w.tenantId, c.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), /bereits abgeschlossen/);

  const booking = await db.booking.findFirstOrThrow({ where: { id: w.bookingId } });
  await rejectsImmutable(() => saveConditions(w.tenantId, c.id, { startAt: booking.startAt, endAt: booking.endAt, deposit: 1, kmIncludedPerDay: 1, extraKmRate: 1, deductible: 1, fuelPolicy: "INCLUDED" }), "Konditionen ändern");
  await rejectsImmutable(() => setOtherDriver(w.tenantId, c.id, otherDriver), "Fahrer ändern");
  await rejectsImmutable(() => addAdditionalDriver(w.tenantId, c.id, otherDriver), "Zusatzfahrer ergänzen");
  await rejectsImmutable(() => saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "X Y", imageDataUrl: fakeSignaturePng(2), seenHash: "0".repeat(64) }), "erneut unterschreiben");
  // direkt an der Anwendungslogik vorbei
  await rejectsImmutable(() => db.rentalContract.update({ where: { id: c.id }, data: { totalAmount: 1 } }), "Vertrag direkt ändern");
  await rejectsImmutable(() => db.rentalContract.delete({ where: { id: c.id } }), "Vertrag direkt löschen");
  await rejectsImmutable(() => db.contractDriver.updateMany({ where: { contractId: c.id }, data: { lastName: "Manipuliert" } }), "Fahrer direkt ändern");
  await rejectsImmutable(() => db.signature.deleteMany({ where: { contractId: c.id } }), "Unterschrift direkt löschen");
  assert.equal((await ensureContractDraft(w.tenantId, w.bookingId, w.actor)).id, c.id, "kein zweiter Vertrag nach Abschluss");
});

test("alter direkter Weg auf 'Unterwegs' ist gesperrt; Übergabe braucht den abgeschlossenen Vertrag", async () => {
  const w = await world("status");
  await assert.rejects(() => changeBookingStatus(w.tenantId, w.bookingId, "ACTIVE"), /nur über Mietvertrag und Übergabeprotokoll/);
  await assert.rejects(() => startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor), /wenn der Mietvertrag abgeschlossen ist/);

  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await assert.rejects(() => startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor), /wenn der Mietvertrag abgeschlossen ist/);
  await sign(w, c.id);
  await finalizeContract(w.tenantId, c.id);
  await assert.rejects(() => changeBookingStatus(w.tenantId, w.bookingId, "ACTIVE"), /nur über Mietvertrag und Übergabeprotokoll/);
  assert.equal((await db.booking.findFirstOrThrow({ where: { id: w.bookingId } })).status, "RESERVED");
  const handover = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  assert.equal(handover.contractId, c.id);

  // Storno: Entwurf wird verworfen, unterschriebener Vertrag storniert und bleibt erhalten
  const w2 = await world("cancel");
  const draft = await ensureContractDraft(w2.tenantId, w2.bookingId, w2.actor);
  await changeBookingStatus(w2.tenantId, w2.bookingId, "CANCELLED");
  assert.equal(await db.rentalContract.count({ where: { id: draft.id } }), 0);
  const w3 = await world("cancel-signed");
  const c3 = await ensureContractDraft(w3.tenantId, w3.bookingId, w3.actor);
  await sign(w3, c3.id);
  await finalizeContract(w3.tenantId, c3.id);
  await changeBookingStatus(w3.tenantId, w3.bookingId, "CANCELLED");
  const cancelled = await db.rentalContract.findFirstOrThrow({ where: { id: c3.id } });
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(Number(cancelled.totalAmount), 458.1, "Inhalt bleibt unverändert");
});

test("Mandantentrennung im Vertragsprozess", async () => {
  const a = await world("tenant-a");
  const b = await world("tenant-b");
  const c = await ensureContractDraft(a.tenantId, a.bookingId, a.actor);
  const booking = await db.booking.findFirstOrThrow({ where: { id: a.bookingId } });

  await assert.rejects(() => ensureContractDraft(b.tenantId, a.bookingId, b.actor), /Buchung nicht gefunden/);
  await assert.rejects(() => getContractState(b.tenantId, c.id), /Vertrag nicht gefunden/);
  await assert.rejects(() => setOtherDriver(b.tenantId, c.id, otherDriver), /Vertrag nicht gefunden/);
  await assert.rejects(() => saveConditions(b.tenantId, c.id, { startAt: booking.startAt, endAt: booking.endAt, deposit: 1, kmIncludedPerDay: 1, extraKmRate: 1, deductible: 1, fuelPolicy: "INCLUDED" }), /Vertrag nicht gefunden/);
  await assert.rejects(() => saveContractSignature(b.tenantId, b.actor, c.id, { role: "RENTER", signerName: "X Y", imageDataUrl: fakeSignaturePng(), seenHash: "0".repeat(64) }), /Vertrag nicht gefunden/);
  await assert.rejects(() => finalizeContract(b.tenantId, c.id), /Vertrag nicht gefunden/);
  await assert.rejects(() => changeBookingStatus(b.tenantId, a.bookingId, "CANCELLED"), /Buchung nicht gefunden/);
  assert.equal(await db.rentalContract.count({ where: { tenantId: b.tenantId } }), 0);
});
