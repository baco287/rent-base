// Behörden- und Bußgeldmanagement (Phase 14): Anlage mit Nummer, Zuordnung Kennzeichen/Tatzeit (tatsächlich vor geplant,
// tagesgenau bei unbekannter Uhrzeit, mehrere Kandidaten ohne Auswahl), Fahrerkandidaten nur aus dem versiegelten Vertrag,
// bewusste Fahrerbestimmung mit Bestätigung, Antwortfassungen (Entwurf → Freigabe unveränderlich + PDF → Übermittlung
// idempotent → Nachweis), E-Mail-Fehler hält den Vorgang offen, Fristen und Kennzahlen, Mandantentrennung, Wettläufe,
// keine Rechnung/Zahlung/Kaution, unveränderter Kernprozess.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { addAdditionalDriver, ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { approveResponse, archiveAuthorityDocument, assignBooking, assignVehicle, authorityCaseView, authorityCounts, buildResponsePdfData, cancelAuthorityCase, casesForBooking, casesForCustomer, casesForVehicle, closeAuthorityCase, createAuthorityCase, listAuthorityCases, prepareResponse, registerAuthorityDocument, rematchCase, reopenAuthorityCase, setDriver, submitResponse, updateAuthorityCase, type CaseInput } from "../src/lib/authority";
import { renderAuthorityResponsePdf } from "../src/lib/pdf/authority-pdf";
import { sha256 } from "../src/lib/integrity";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { buildStorageKey, getStorage, type StorageDriver } from "../src/lib/storage";
import { toDateInputValue, zonedParts } from "../src/lib/time";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-auth-"));
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
  async send(m: MailMessage) {
    if (this.fail) throw this.fail;
    this.sent.push(m);
    return { messageId: `<fake-${this.sent.length}@test>` };
  }
}

const DAY = 86_400_000;
const at = (offsetDays: number, hour = 10) => { const d = new Date(Date.now() + offsetDays * DAY); d.setHours(hour, 15, 0, 0); return d; };
const dateTime = (d: Date) => { const p = zonedParts(d); return { offenseDate: toDateInputValue(d), offenseTime: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` }; };
const input = (plate: string, when: Date | { date: Date; timeUnknown: true }, over: Partial<CaseInput> = {}): CaseInput => ({
  type: "SPEEDING", authorityName: "Stadtamt Bremen, Bußgeldstelle", authorityReference: `AZ-${Math.random().toString(36).slice(2, 8)}`, authorityAddress: "Stresemannstr. 48\n28207 Bremen", licensePlate: plate,
  ...("timeUnknown" in when ? { offenseDate: toDateInputValue(when.date), offenseTime: null } : dateTime(when)), offenseLocation: "A27, km 12", ...over,
});

/** Zurückgegebene Miete mit tatsächlicher Übergabe vor 5 Tagen und Rückgabe vor 1 Tag (Tatzeit-Tests). */
async function rentedWorld(label: string) {
  await ready;
  const w = await returnedWorld(label);
  tenants.push(w.tenantId);
  await db.booking.update({ where: { id: w.bookingId }, data: { actualPickupAt: at(-5, 9), actualReturnAt: at(-1, 16) } });
  return w;
}

/** Versiegelter Vertrag mit Haupt- und Zusatzfahrer, tatsächliche Zeiten direkt gesetzt (keine Rückgabe nötig). */
async function twoDriverWorld(label: string): Promise<World & { contractId: string }> {
  await ready;
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { legalForm: "GmbH", email: "post@jetrent.test", phone: "0421 999" } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await addAdditionalDriver(w.tenantId, c.id, { firstName: "Max", lastName: "Beifahrer", birthDate: new Date("1990-07-01"), street: "Nebenweg 2", zip: "28199", city: "Bremen", licenseNumber: "Z999", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2035-01-01") });
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  await db.booking.update({ where: { id: w.bookingId }, data: { status: "ACTIVE", actualPickupAt: at(-3, 8), actualReturnAt: null } });
  return { ...w, contractId: c.id };
}

async function plate(vehicleId: string) { return (await db.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).plate; }

async function snapshotCore(tenantId: string) {
  const [contracts, handovers, invoices, payments, deposits, charges, drivers] = await Promise.all([
    db.rentalContract.findMany({ where: { tenantId }, select: { id: true, contentHash: true, status: true } }),
    db.handover.findMany({ where: { tenantId }, select: { id: true, contentHash: true, status: true } }),
    db.invoice.count({ where: { tenantId } }), db.payment.count({ where: { tenantId } }), db.securityDepositEvent.count({ where: { tenantId } }), db.extraCharge.count({ where: { tenantId } }),
    db.contractDriver.findMany({ where: { tenantId }, select: { id: true, firstName: true, lastName: true } }),
  ]);
  return JSON.stringify({ contracts, handovers, invoices, payments, deposits, charges, drivers });
}

// ---------------------------------------------------------------------------
// Anlage, Nummer, automatische Zuordnung
// ---------------------------------------------------------------------------

test("Anlage: Nummer BH-JJJJ-NNNNNN, Kennzeichen-Snapshot, tatsächliche Mietdauer trifft, Vertrag und Kandidaten, aber kein Fahrer; Kernprozess unverändert", async () => {
  const w = await rentedWorld("auth-create");
  const before = await snapshotCore(w.tenantId);
  const p = await plate(w.vehicleId);
  const c = await createAuthorityCase(w.tenantId, w.actor, input(p.toLowerCase().replace("-", " "), at(-3, 14), { responseDeadline: at(7), noticeAmount: "48,50", authorityEmail: "bussgeld@example.test" }));
  assert.match(c.caseNumber, /^BH-\d{4}-000001$/);
  assert.equal(c.licensePlateSnapshot, p.toLowerCase().replace("-", " "), "Original bleibt erhalten");
  assert.equal(c.vehicleMatch, "EXACT_MATCH");
  assert.equal(c.vehicleId, w.vehicleId);
  assert.equal(c.rentalMatch, "ACTUAL_PERIOD");
  assert.equal(c.rentalMatchDayOnly, false);
  assert.equal(c.bookingId, w.bookingId);
  assert.equal(c.contractId, w.contractId);
  assert.equal(c.assignmentStatus, "ASSIGNED");
  assert.equal(c.status, "REVIEW_REQUIRED");
  assert.equal(c.driverDeterminationStatus, "UNDETERMINED", "nie automatisch ein Fahrer");
  assert.equal(c.driverSnapshot, null);
  assert.equal(c.noticeAmountCents, 4850);
  assert.equal(c.offenseTimeKnown, true);
  const v = await authorityCaseView(w.tenantId, c.id);
  assert.equal(v.driverCandidates.length, 1);
  assert.equal(v.driverCandidates[0].role, "PRIMARY_DRIVER");
  assert.equal(v.driverCandidates[0].lastName, "Muster");
  assert.equal(v.rentalCandidates.length, 1);
  assert.equal(v.deadline.level, "OK");
  assert.match(v.offenseText, /Uhr$/);
  assert.equal(v.events.map((e) => e.type).sort().join(","), "CREATED,RENTAL_MATCHED,STATUS_CHANGED,VEHICLE_MATCHED");
  const audits = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { startsWith: "AUTHORITY_" } } });
  assert.deepEqual(audits.map((a) => a.action).sort(), ["AUTHORITY_CASE_ASSIGNED_TO_BOOKING", "AUTHORITY_CASE_ASSIGNED_TO_VEHICLE", "AUTHORITY_CASE_CREATED"]);
  for (const a of audits) assert.ok(!JSON.stringify(a.details).includes("Muster"), "keine Personendaten im Audit");
  const second = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-2, 9)));
  assert.match(second.caseNumber, /-000002$/);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await snapshotCore(w.tenantId), before, "Vertrag, Protokolle, Rechnungen, Zahlungen, Kaution, Fahrer unverändert");
  assert.equal((await casesForVehicle(w.tenantId, w.vehicleId)).length, 2);
  assert.equal((await casesForBooking(w.tenantId, w.bookingId)).length, 2);
  assert.equal((await casesForCustomer(w.tenantId, w.customerId)).length, 0, "Kundenakte zeigt nur bewusst bestimmte Fahrer");
});

test("Wettlauf: parallele Anlage vergibt eindeutige Nummern", async () => {
  const w = await rentedWorld("auth-race");
  const p = await plate(w.vehicleId);
  const rows = await Promise.all([1, 2, 3, 4, 5].map((i) => createAuthorityCase(w.tenantId, w.actor, input(p, at(-3, 8 + i)))));
  assert.equal(new Set(rows.map((r) => r.caseNumber)).size, 5);
  assert.deepEqual(rows.map((r) => r.caseNumber).sort(), [1, 2, 3, 4, 5].map((i) => `${rows[0].caseNumber.slice(0, 8)}00000${i}`));
});

test("Zuordnung: vor Übergabe, exakt Rückgabe und danach = keine Vermietung; Uhrzeit unbekannt = tagesgenau; fremdes Kennzeichen = kein Fahrzeug; Daten ändern löst neue Zuordnung aus", async () => {
  const w = await rentedWorld("auth-match");
  const p = await plate(w.vehicleId);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const before = await createAuthorityCase(w.tenantId, w.actor, input(p, new Date(bk.actualPickupAt!.getTime() - 60_000)));
  assert.equal(before.rentalMatch, "NONE");
  assert.equal(before.bookingId, null);
  assert.equal(before.assignmentStatus, "NO_MATCH");
  assert.equal(before.status, "REVIEW_REQUIRED");
  const exactReturn = await createAuthorityCase(w.tenantId, w.actor, input(p, bk.actualReturnAt!));
  assert.equal(exactReturn.rentalMatch, "NONE", "[start, end): Rückgabezeitpunkt gehört nicht mehr zur Miete");
  const exactPickup = await createAuthorityCase(w.tenantId, w.actor, input(p, bk.actualPickupAt!));
  assert.equal(exactPickup.rentalMatch, "ACTUAL_PERIOD");
  const unknown = await createAuthorityCase(w.tenantId, w.actor, input(p, { date: at(-3), timeUnknown: true }));
  assert.equal(unknown.offenseTimeKnown, false);
  assert.equal(zonedParts(unknown.offenseAt).hour, 12, "technischer Anker 12:00, nie 00:00");
  assert.equal(unknown.rentalMatch, "ACTUAL_PERIOD");
  assert.equal(unknown.rentalMatchDayOnly, true);
  assert.match((await authorityCaseView(w.tenantId, unknown.id)).offenseText, /Uhrzeit nicht angegeben/);
  const foreign = await createAuthorityCase(w.tenantId, w.actor, input("HH-XX 9999", at(-3)));
  assert.equal(foreign.vehicleMatch, "NO_MATCH");
  assert.equal(foreign.vehicleId, null);
  assert.equal(foreign.rentalMatch, "UNMATCHED");
  assert.equal(foreign.assignmentStatus, "NO_MATCH");
  // Kennzeichen korrigiert → Fahrzeug und Vermietung gefunden
  const fixed = await updateAuthorityCase(w.tenantId, foreign.id, w.actor, input(p, at(-3)));
  assert.equal(fixed.vehicleMatch, "EXACT_MATCH");
  assert.equal(fixed.bookingId, w.bookingId);
  // Tatzeit in die Zukunft / ungültig
  await assert.rejects(() => createAuthorityCase(w.tenantId, w.actor, input(p, at(3))), /Zukunft/);
  await assert.rejects(() => createAuthorityCase(w.tenantId, w.actor, { ...input(p, at(-3)), offenseDate: "2026-13-40" }), /gültiges Tatdatum/);
  await assert.rejects(() => createAuthorityCase(w.tenantId, w.actor, input(p, at(-3), { authorityPortalUrl: "http://portal.example.de" })), /https/);
  await assert.rejects(() => createAuthorityCase(w.tenantId, w.actor, input(p, at(-3), { noticeAmount: "-5" })), /negativ/);
});

test("Zuordnung: nur geplante Buchungszeit ist ein schwächerer Hinweis ohne Vertrag; mehrere Fahrzeuge und mehrere Vermietungen werden nie automatisch gewählt; manuelle Zuordnung", async () => {
  await ready;
  const w = await createWorld("auth-planned", { startInDays: -2 });
  tenants.push(w.tenantId);
  const p = await plate(w.vehicleId);
  const planned = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-1, 11)));
  assert.equal(planned.rentalMatch, "PLANNED_PERIOD");
  assert.equal(planned.bookingId, w.bookingId);
  assert.equal(planned.contractId, null, "ohne versiegelten Vertrag keine Fahrerkandidaten");
  assert.equal((await authorityCaseView(w.tenantId, planned.id)).driverCandidates.length, 0);
  // zweites Fahrzeug mit gleichem Schlüssel → mehrdeutig
  const twin = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: p.replace("-", "").replace(" ", "-"), make: "VW", model: "Caddy", groupId: w.groupId, fuel: "DIESEL", mileage: 1000, dailyRate: 50, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 100 } });
  const amb = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-1, 12)));
  assert.equal(amb.vehicleMatch, "AMBIGUOUS");
  assert.equal(amb.vehicleId, null);
  assert.equal(amb.status, "ASSIGNMENT_REQUIRED");
  const view = await authorityCaseView(w.tenantId, amb.id);
  assert.deepEqual(view.plateHits.map((v) => v.id).sort(), [twin.id, w.vehicleId].sort());
  const manual = await assignVehicle(w.tenantId, amb.id, w.actor, w.vehicleId);
  assert.equal(manual.vehicleMatch, "MANUALLY_ASSIGNED");
  assert.equal(manual.rentalMatch, "PLANNED_PERIOD");
  assert.equal(manual.bookingId, w.bookingId);
  assert.equal((await rematchCase(w.tenantId, amb.id, w.actor)).vehicleMatch, "AMBIGUOUS", "erneute automatische Prüfung setzt die manuelle Wahl zurück");
  // zwei überlappende Vermietungen (tatsächliche Zeiten) → mehrdeutig, beide sichtbar, manuelle Auswahl
  const b1 = await db.booking.update({ where: { id: w.bookingId }, data: { status: "RETURNED", actualPickupAt: at(-4, 8), actualReturnAt: at(-1, 8) } });
  const b2 = await db.booking.create({ data: { tenantId: w.tenantId, number: "T-zweite", vehicleId: w.vehicleId, customerId: w.customerId, startAt: at(-3), endAt: at(0), status: "RETURNED", actualPickupAt: at(-3, 7), actualReturnAt: at(-1, 20), dailyRate: 89, deposit: 500 } });
  const multi = await createAuthorityCase(w.tenantId, w.actor, input(p.replace("-", ""), at(-2, 12)));
  assert.equal(multi.vehicleMatch, "AMBIGUOUS");
  await assignVehicle(w.tenantId, multi.id, w.actor, w.vehicleId);
  const mv = await authorityCaseView(w.tenantId, multi.id);
  assert.equal(mv.rentalMatch, "AMBIGUOUS");
  assert.equal(mv.bookingId, null);
  assert.equal(mv.status, "ASSIGNMENT_REQUIRED");
  assert.deepEqual(mv.rentalCandidates.map((k) => k.bookingId).sort(), [b1.id, b2.id].sort());
  const chosen = await assignBooking(w.tenantId, multi.id, w.actor, b2.id);
  assert.equal(chosen.rentalMatch, "MANUALLY_ASSIGNED");
  assert.equal(chosen.bookingId, b2.id);
  assert.equal(chosen.status, "REVIEW_REQUIRED");
  await assert.rejects(() => assignBooking(w.tenantId, multi.id, w.actor, "nicht-da"), /nicht gefunden/);
  // Buchung eines anderen Fahrzeugs
  const other = await db.booking.create({ data: { tenantId: w.tenantId, number: "T-anderes", vehicleId: twin.id, customerId: w.customerId, startAt: at(-3), endAt: at(0), dailyRate: 50, deposit: 100 } });
  await assert.rejects(() => assignBooking(w.tenantId, multi.id, w.actor, other.id), /nicht zum zugeordneten Fahrzeug/);
});

// ---------------------------------------------------------------------------
// Fahrerbestimmung
// ---------------------------------------------------------------------------

test("Fahrer: Kandidaten nur aus dem Vertrag (Haupt- und Zusatzfahrer), Auswahl nur mit Bestätigung, minimaler Snapshot, andere Person, nicht feststellbar immer möglich, Audit ohne Personendaten", async () => {
  const w = await twoDriverWorld("auth-driver");
  const p = await plate(w.vehicleId);
  const c = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-1, 12)));
  assert.equal(c.rentalMatch, "ACTUAL_PERIOD", "laufende Miete ohne Rückgabe");
  const v = await authorityCaseView(w.tenantId, c.id);
  assert.equal(v.driverCandidates.length, 2);
  assert.deepEqual(v.driverCandidates.map((d) => d.role), ["PRIMARY_DRIVER", "ADDITIONAL_DRIVER"]);
  const [primary, additional] = v.driverCandidates;
  await assert.rejects(() => setDriver(w.tenantId, c.id, w.actor, { mode: "CONTRACT", contractDriverId: primary.contractDriverId, confirmed: false }), /ausdrücklich/);
  await assert.rejects(() => setDriver(w.tenantId, c.id, w.actor, { mode: "CONTRACT", contractDriverId: "fremd", confirmed: true }), /nicht zum zugeordneten Mietvertrag/);
  const sel = await setDriver(w.tenantId, c.id, w.actor, { mode: "CONTRACT", contractDriverId: additional.contractDriverId, confirmed: true, note: "Mieter hat den Zusatzfahrer schriftlich benannt" });
  assert.equal(sel.driverDeterminationStatus, "CONTRACT_DRIVER_SELECTED");
  assert.equal(sel.driverContractDriverId, additional.contractDriverId);
  assert.equal(sel.driverCustomerId, null, "Zusatzfahrer ohne Kundenakte");
  const snap = sel.driverSnapshot as Record<string, unknown>;
  assert.equal(snap.lastName, "Beifahrer");
  assert.equal(snap.role, "ADDITIONAL_DRIVER");
  assert.deepEqual(Object.keys(snap).sort(), ["birthDate", "city", "country", "firstName", "lastName", "role", "source", "street", "zip"], "kein Führerschein, Telefon, E-Mail, Geburtsort");
  const main = await setDriver(w.tenantId, c.id, w.actor, { mode: "CONTRACT", contractDriverId: primary.contractDriverId, confirmed: true });
  assert.equal(main.driverCustomerId, w.customerId);
  assert.equal((await casesForCustomer(w.tenantId, w.customerId)).length, 1, "jetzt in der Kundenakte sichtbar");
  const other = await setDriver(w.tenantId, c.id, w.actor, { mode: "OTHER", person: { firstName: "Paula", lastName: "Dritte", city: "Oldenburg" }, confirmed: true });
  assert.equal(other.driverDeterminationStatus, "OTHER_DRIVER_ENTERED");
  assert.equal(other.driverCustomerId, null);
  assert.equal((await casesForCustomer(w.tenantId, w.customerId)).length, 0);
  await assert.rejects(() => setDriver(w.tenantId, c.id, w.actor, { mode: "OTHER", person: { firstName: "", lastName: "X" }, confirmed: true }), /Vor- und Nachname/);
  const none = await setDriver(w.tenantId, c.id, w.actor, { mode: "NOT_IDENTIFIABLE", note: "zwei Fahrer, keine Angabe des Mieters" });
  assert.equal(none.driverDeterminationStatus, "NOT_IDENTIFIABLE");
  assert.equal(none.driverSnapshot, null);
  assert.equal(none.driverContractDriverId, null);
  const audits = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["AUTHORITY_DRIVER_SELECTED", "AUTHORITY_DRIVER_CHANGED"] } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(audits.map((a) => a.action), ["AUTHORITY_DRIVER_SELECTED", "AUTHORITY_DRIVER_CHANGED", "AUTHORITY_DRIVER_CHANGED", "AUTHORITY_DRIVER_CHANGED"]);
  for (const a of audits) assert.ok(!/Beifahrer|Muster|Dritte/.test(JSON.stringify(a.details)), "Audit ohne Namen");
  // Umhängen der Vermietung setzt die Fahrerbestimmung zurück
  await setDriver(w.tenantId, c.id, w.actor, { mode: "CONTRACT", contractDriverId: primary.contractDriverId, confirmed: true });
  const reset = await assignBooking(w.tenantId, c.id, w.actor, null);
  assert.equal(reset.driverDeterminationStatus, "UNDETERMINED");
  assert.equal(reset.driverSnapshot, null);
  assert.equal(reset.contractId, null);
});

// ---------------------------------------------------------------------------
// Antwortfassungen: Entwurf, Freigabe, Unveränderlichkeit, PDF, Übermittlung
// ---------------------------------------------------------------------------

test("Antwort: „Fahrer benannt“ nur nach Fahrerbestimmung, Datensparsamkeit, Vorschau, Freigabe erzeugt Prüfsumme und PDF, danach unveränderlich; neue Fassung ersetzt; PDF bleibt nach Kundenänderung identisch", async () => {
  const w = await twoDriverWorld("auth-response");
  const p = await plate(w.vehicleId);
  const c = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-1, 12), { authorityEmail: "bussgeld@example.test", authorityDepartment: "Zentrale Bußgeldstelle" }));
  await assert.rejects(() => prepareResponse(w.tenantId, c.id, w.actor, { responseType: "DRIVER_IDENTIFIED", submissionMethod: "POST" }), /bewusste Fahrerbestimmung/);
  await assert.rejects(() => prepareResponse(w.tenantId, c.id, w.actor, { responseType: "DRIVER_NOT_IDENTIFIABLE", submissionMethod: "VERIFIED_API" }), /keine verifizierte Schnittstelle/);
  await assert.rejects(() => prepareResponse(w.tenantId, c.id, w.actor, { responseType: "CUSTOM_RESPONSE", submissionMethod: "POST" }), /braucht einen Text/);
  const v = await authorityCaseView(w.tenantId, c.id);
  const primary = v.driverCandidates[0];
  await setDriver(w.tenantId, c.id, w.actor, { mode: "CONTRACT", contractDriverId: primary.contractDriverId, confirmed: true });
  const r1 = await prepareResponse(w.tenantId, c.id, w.actor, { responseType: "DRIVER_IDENTIFIED", submissionMethod: "POST", includeBirthDate: false, includeAddress: true });
  assert.equal(r1.version, 1);
  assert.equal(r1.status, "DRAFT");
  assert.equal(r1.contentHash, null);
  const persons = (r1.personSnapshot as { persons: { role: string; fields: { label: string }[] }[] }).persons;
  assert.equal(persons.length, 1);
  assert.deepEqual(persons[0].fields.map((f) => f.label), ["Vorname", "Nachname", "Anschrift"], "ohne Geburtsdatum, nie Führerschein/Telefon/E-Mail");
  assert.equal((r1.recipientSnapshot as { email: string | null }).email, null, "Postversand: keine E-Mail im Snapshot");
  assert.equal((await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } })).status, "RESPONSE_PREPARED");
  const preview = buildResponsePdfData(await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } }), r1);
  assert.equal(preview.recipient.addressLines.length, 2);
  assert.equal(preview.rental?.bookingNumber, (await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).number);
  assert.match(preview.rental!.basisText, /Tatsächliche/);
  assert.match(preview.rental!.windowText, /laufend/);
  // Entwurf ersetzen: gleiche Fassungsnummer, jetzt mit Geburtsdatum
  const r1b = await prepareResponse(w.tenantId, c.id, w.actor, { responseType: "DRIVER_IDENTIFIED", submissionMethod: "POST", includeBirthDate: true, includeAddress: true });
  assert.equal(r1b.version, 1);
  assert.equal(await db.authorityResponse.count({ where: { caseId: c.id } }), 1);
  // Freigabe
  const before = await snapshotCore(w.tenantId);
  const approved = await approveResponse(w.tenantId, r1b.id, w.actor, { storage });
  assert.equal(approved.status, "APPROVED");
  assert.ok(approved.contentHash && approved.approvedAt && approved.approvedById === w.actor.id);
  assert.ok(approved.pdfDocumentId);
  const pdfDoc = await db.authorityCaseDocument.findUniqueOrThrow({ where: { id: approved.pdfDocumentId! } });
  assert.equal(pdfDoc.type, "RESPONSE_PDF");
  const stored = await storage.get(pdfDoc.storageKey);
  assert.ok(stored && sha256(stored.body) === pdfDoc.checksum, "PDF unverändert im privaten Speicher");
  assert.equal(Buffer.from(stored!.body.subarray(0, 5)).toString(), "%PDF-");
  assert.equal((await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } })).status, "READY_TO_SEND");
  // Doppelklick auf Freigabe: keine zweite PDF, gleiche Fassung
  const again = await approveResponse(w.tenantId, r1b.id, w.actor, { storage });
  assert.equal(again.pdfDocumentId, approved.pdfDocumentId);
  assert.equal(await db.authorityCaseDocument.count({ where: { caseId: c.id, type: "RESPONSE_PDF" } }), 1);
  // Unveränderlich: Inhalt, Person, Typ nicht mehr änderbar, kein Löschen
  await assert.rejects(() => db.authorityResponse.update({ where: { id: r1b.id }, data: { freeText: "nachträglich" } }), /unveränderlich/);
  await assert.rejects(() => db.authorityResponse.update({ where: { id: r1b.id }, data: { personSnapshot: { persons: [] } } }), /unveränderlich/);
  await assert.rejects(() => db.authorityResponse.update({ where: { id: r1b.id }, data: { responseType: "CUSTOM_RESPONSE" } }), /unveränderlich/);
  await assert.rejects(() => db.authorityResponse.delete({ where: { id: r1b.id } }), /nicht gelöscht/);
  await assert.rejects(() => db.authorityCaseDocument.update({ where: { id: pdfDoc.id }, data: { checksum: "x" } }), /fest/);
  await assert.rejects(() => archiveAuthorityDocument(w.tenantId, pdfDoc.id, w.actor, "weg damit"), /nicht archiviert/);
  // Korrektur = neue Fassung; alte wird ersetzt
  const r2 = await prepareResponse(w.tenantId, c.id, w.actor, { responseType: "DRIVER_IDENTIFIED", submissionMethod: "POST", includeBirthDate: true, includeAddress: false, freeText: "Korrigierte Fassung" });
  assert.equal(r2.version, 2);
  assert.equal((await db.authorityResponse.findUniqueOrThrow({ where: { id: r1b.id } })).status, "SUPERSEDED");
  assert.equal((await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } })).status, "RESPONSE_PREPARED");
  const a2 = await approveResponse(w.tenantId, r2.id, w.actor, { storage });
  const traceBefore = (await renderAuthorityResponsePdf(buildResponsePdfData(await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } }), a2))).trace.texts;
  assert.ok(traceBefore.some((t) => t.includes("Muster")));
  assert.ok(!traceBefore.some((t) => /Weg 1/.test(t)), "Anschrift bewusst nicht aufgenommen");
  assert.ok(!traceBefore.some((t) => /B072RRE2I55|erika@example|0421 12345/.test(t)), "keine Führerschein-, E-Mail-, Telefonangaben");
  assert.equal(buildResponsePdfData(await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } }), a2).contentHash, a2.contentHash, "Prüfsumme wird als Fußnote auf das PDF übernommen");
  // Kunde ändert Namen → Fassung und PDF unverändert
  await db.customer.update({ where: { id: w.customerId }, data: { lastName: "Neuername" } });
  const traceAfter = (await renderAuthorityResponsePdf(buildResponsePdfData(await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } }), await db.authorityResponse.findUniqueOrThrow({ where: { id: r2.id } })))).trace.texts;
  assert.deepEqual(traceAfter, traceBefore);
  assert.ok(!traceAfter.some((t) => t.includes("Neuername")));
  const pdf2 = await db.authorityCaseDocument.findUniqueOrThrow({ where: { id: a2.pdfDocumentId! } });
  assert.equal(sha256((await storage.get(pdf2.storageKey))!.body), pdf2.checksum);
  assert.equal(await snapshotCore(w.tenantId), before, "Freigaben ändern nichts am Kernprozess");
  // Mehrere mögliche Fahrer: alle Kandidaten, kein Favorit
  const multi = await prepareResponse(w.tenantId, c.id, w.actor, { responseType: "MULTIPLE_POSSIBLE_DRIVERS", submissionMethod: "POST", includeBirthDate: true });
  assert.equal(multi.version, 3);
  const mp = (multi.personSnapshot as { persons: { role: string }[] }).persons;
  assert.deepEqual(mp.map((x) => x.role), ["Vertraglicher Hauptfahrer", "Zusätzlicher Vertragsfahrer"]);
  assert.equal((await db.authorityResponse.findUniqueOrThrow({ where: { id: r2.id } })).status, "SUPERSEDED");
});

test("Übermittlung Post/Portal: nur freigegebene Fassung, Datum Pflicht, Nachweis mit Dokument, idempotent auch parallel, übermittelte Fassung fest, Nachweisdokument nicht archivierbar", async () => {
  const w = await rentedWorld("auth-post");
  const p = await plate(w.vehicleId);
  const c = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-3, 12), { authorityPortalUrl: "https://portal.bussgeld.example.de/anhoerung" }));
  await setDriver(w.tenantId, c.id, w.actor, { mode: "NOT_IDENTIFIABLE" });
  const draft = await prepareResponse(w.tenantId, c.id, w.actor, { responseType: "DRIVER_NOT_IDENTIFIABLE", submissionMethod: "MANUAL_PORTAL" });
  assert.equal(draft.personSnapshot, null);
  await assert.rejects(() => submitResponse(w.tenantId, draft.id, w.actor, { submittedAt: new Date() }), /freigegebene/);
  await approveResponse(w.tenantId, draft.id, w.actor, { storage });
  await assert.rejects(() => submitResponse(w.tenantId, draft.id, w.actor, {}), /Übermittlungsdatum/);
  await assert.rejects(() => submitResponse(w.tenantId, draft.id, w.actor, { submittedAt: at(2) }), /Zukunft/);
  // Nachweisdokument (Portal-Screenshot als PDF) vorab registriert
  const key = buildStorageKey({ tenantId: w.tenantId, area: "documents", contentType: "application/pdf" });
  const receiptDoc = await registerAuthorityDocument(w.tenantId, c.id, w.actor, { type: "SUBMISSION_RECEIPT", fileName: "portal-bestaetigung.pdf", storageKey: key, contentType: "application/pdf", sizeBytes: 10, checksum: sha256("x") });
  const when = at(0, 9);
  const [a, b] = await Promise.all([
    submitResponse(w.tenantId, draft.id, w.actor, { submittedAt: when, reference: "PORTAL-4711", receiptDocumentId: receiptDoc.id }),
    submitResponse(w.tenantId, draft.id, w.actor, { submittedAt: when, reference: "PORTAL-4711", receiptDocumentId: receiptDoc.id }),
  ]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["ALREADY_SUBMITTED", "SUBMITTED"]);
  assert.equal(await db.authoritySubmissionReceipt.count({ where: { caseId: c.id } }), 1, "genau ein Nachweis");
  const r = await db.authorityResponse.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(r.status, "SUBMITTED");
  assert.equal(r.submissionReference, "PORTAL-4711");
  assert.equal(r.submittedAt?.getTime(), when.getTime());
  const receipt = await db.authoritySubmissionReceipt.findFirstOrThrow({ where: { caseId: c.id } });
  assert.equal(receipt.method, "MANUAL_PORTAL");
  assert.equal(receipt.documentId, receiptDoc.id);
  assert.equal((await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } })).status, "SUBMITTED");
  assert.equal((await submitResponse(w.tenantId, draft.id, w.actor, { submittedAt: when })).outcome, "ALREADY_SUBMITTED");
  await assert.rejects(() => db.authorityResponse.update({ where: { id: draft.id }, data: { submissionReference: "anders" } }), /übermittelte Antwortfassung/);
  await assert.rejects(() => db.authoritySubmissionReceipt.update({ where: { id: receipt.id }, data: { reference: "x" } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.authoritySubmissionReceipt.delete({ where: { id: receipt.id } }), /RB_IMMUTABLE/);
  await assert.rejects(() => archiveAuthorityDocument(w.tenantId, receiptDoc.id, w.actor, "Versehen"), /Übermittlungsnachweis bleibt/);
  // keine weitere Fassung, nur Abschluss; Storno nach Übermittlung nicht möglich
  await assert.rejects(() => cancelAuthorityCase(w.tenantId, c.id, w.actor, "doch nicht"), /übermittelter Antwort/);
  const audit = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["AUTHORITY_RESPONSE_SUBMITTED", "AUTHORITY_SUBMISSION_RECEIPT_ADDED"] } } });
  assert.equal(audit.length, 2);
  const view = await authorityCaseView(w.tenantId, c.id);
  assert.equal(view.portal.host, "portal.bussgeld.example.de");
  assert.equal(view.currentResponse?.id, draft.id);
});

test("Übermittlung E-Mail: nur an die erfasste Behördenadresse, PDF-Anhang mit Prüfsumme, Fehler hält den Vorgang offen (FAILED, erneuter Versuch), Erfolg ist idempotent", async () => {
  const w = await rentedWorld("auth-mail");
  const p = await plate(w.vehicleId);
  await assert.rejects(() => createAuthorityCase(w.tenantId, w.actor, input(p, at(-3, 12), { authorityEmail: "keine-adresse" })), /E-Mail-Adresse der Behörde ist ungültig/);
  const noMail = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-3, 12)));
  await assert.rejects(() => prepareResponse(w.tenantId, noMail.id, w.actor, { responseType: "DRIVER_NOT_IDENTIFIABLE", submissionMethod: "EMAIL" }), /E-Mail-Adresse der Behörde aus dem Schreiben/);
  const c = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-3, 12), { authorityEmail: "bussgeld@example.test" }));
  await setDriver(w.tenantId, c.id, w.actor, { mode: "NOT_IDENTIFIABLE" });
  const draft = await prepareResponse(w.tenantId, c.id, w.actor, { responseType: "DRIVER_NOT_IDENTIFIABLE", submissionMethod: "EMAIL" });
  assert.equal((draft.recipientSnapshot as { email: string }).email, "bussgeld@example.test");
  const approved = await approveResponse(w.tenantId, draft.id, w.actor, { storage });
  const transport = new FakeTransport();
  transport.fail = new Error("SMTP 451 try later");
  const failed = await submitResponse(w.tenantId, approved.id, w.actor, { transport, storage });
  assert.equal(failed.outcome, "FAILED");
  assert.equal(failed.response.status, "FAILED");
  assert.equal(failed.response.failureReason, "Versand fehlgeschlagen", "kein roher Transportfehler in der Akte");
  assert.equal((await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } })).status, "READY_TO_SEND", "nie fälschlich übermittelt");
  assert.equal(await db.authoritySubmissionReceipt.count({ where: { caseId: c.id } }), 0);
  assert.equal((await db.emailLog.findFirstOrThrow({ where: { tenantId: w.tenantId, template: "AUTHORITY_RESPONSE" } })).status, "FAILED");
  // gleicher Versuch ohne neuen Nonce: kein zweiter Versand
  transport.fail = null;
  const dup = await submitResponse(w.tenantId, approved.id, w.actor, { transport, storage });
  assert.equal(dup.outcome, "FAILED");
  assert.equal(transport.sent.length, 0);
  // erneuter Versuch mit Nonce
  const ok = await submitResponse(w.tenantId, approved.id, w.actor, { transport, storage, nonce: "retry-1" });
  assert.equal(ok.outcome, "SUBMITTED");
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].to, "bussgeld@example.test");
  assert.equal(transport.sent[0].attachments.length, 1);
  const pdfDoc = await db.authorityCaseDocument.findUniqueOrThrow({ where: { id: approved.pdfDocumentId! } });
  assert.equal(sha256(transport.sent[0].attachments[0].content), pdfDoc.checksum, "genau die freigegebene PDF");
  assert.ok(!/erika@example|Muster/.test(JSON.stringify({ to: transport.sent[0].to, subject: transport.sent[0].subject, text: transport.sent[0].text })), "keine Kundendaten in Adresse, Betreff oder Text");
  assert.equal((await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } })).status, "SUBMITTED");
  const logs = await db.emailLog.findMany({ where: { tenantId: w.tenantId, template: "AUTHORITY_RESPONSE" }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(logs.map((l) => l.status), ["FAILED", "SENT"]);
  assert.equal(logs[1].recipient, "bussgeld@example.test");
  const again = await submitResponse(w.tenantId, approved.id, w.actor, { transport, storage, nonce: "retry-2" });
  assert.equal(again.outcome, "ALREADY_SUBMITTED");
  assert.equal(transport.sent.length, 1, "kein Doppelversand");
  assert.equal((await db.authorityResponse.findUniqueOrThrow({ where: { id: approved.id } })).emailLogId, logs[1].id);
});

// ---------------------------------------------------------------------------
// Fristen, Kennzahlen, Liste, Dokumente, Abschluss
// ---------------------------------------------------------------------------

test("Fristen und Liste: Kennzahlen, Abschnitte, Suche über Nummer, Kennzeichenvariante, Buchung, Kunde; Dokumente append-only; Abschluss/Wiederöffnen/Storno mit Grund", async () => {
  const w = await rentedWorld("auth-list");
  const p = await plate(w.vehicleId);
  const overdue = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-3, 12), { responseDeadline: at(-2), type: "PARKING" }));
  const today = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-3, 13), { responseDeadline: at(0) }));
  const soon = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-3, 14), { responseDeadline: at(2) }));
  const later = await createAuthorityCase(w.tenantId, w.actor, input(p, at(-3, 15), { responseDeadline: at(20) }));
  const none = await createAuthorityCase(w.tenantId, w.actor, input("HH-ZZ 1", at(-3, 16)));
  const counts = await authorityCounts(w.tenantId);
  assert.equal(counts.received, 0, "nach der automatischen Zuordnung ist nichts mehr „Neu“");
  assert.equal(counts.overdue, 1);
  assert.equal(counts.dueSoon, 2, "heute und in 2 Tagen");
  assert.deepEqual(counts.dueToday.map((x) => x.id), [overdue.id, today.id]);
  assert.equal(counts.dueToday[0].deadline.text, "seit 2 Tagen überfällig");
  assert.equal(counts.dueToday[1].deadline.text, "heute fällig");
  const ov = await listAuthorityCases(w.tenantId, { filter: "ueberfaellig" });
  assert.deepEqual(ov.items.map((x) => x.id), [overdue.id]);
  assert.equal((await listAuthorityCases(w.tenantId, { deadline: "bald" })).total, 2);
  assert.equal((await listAuthorityCases(w.tenantId, { deadline: "ohne" })).total, 1);
  assert.equal((await listAuthorityCases(w.tenantId, { filter: "pruefung" })).total, 5);
  assert.equal((await listAuthorityCases(w.tenantId, { type: "PARKING" })).total, 1);
  assert.equal((await listAuthorityCases(w.tenantId, { assigned: "nein" })).total, 1);
  const all = await listAuthorityCases(w.tenantId, {});
  assert.deepEqual(all.items.slice(0, 4).map((x) => x.id), [overdue.id, today.id, soon.id, later.id], "nach Frist sortiert, ohne Frist zuletzt");
  assert.equal(all.items[4].id, none.id);
  assert.equal((await listAuthorityCases(w.tenantId, { q: overdue.caseNumber })).total, 1);
  assert.equal((await listAuthorityCases(w.tenantId, { q: p.replace("-", "").replace(" ", "").toLowerCase() })).total, 4, "Kennzeichen in anderer Schreibweise");
  assert.equal((await listAuthorityCases(w.tenantId, { q: "Muster" })).total, 4, "Kunde der zugeordneten Buchung");
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal((await listAuthorityCases(w.tenantId, { q: bk.number })).total, 4);
  assert.equal((await listAuthorityCases(w.tenantId, { q: overdue.authorityReference })).total, 1);
  assert.equal((await listAuthorityCases(w.tenantId, { pageSize: 10, page: 2 })).items.length, 0);
  assert.equal((await listAuthorityCases(w.tenantId, { pageSize: 10 })).pages, 1);
  // Dokumente: anlegen, archivieren mit Grund, nie löschen, Archivierung nicht zurücknehmbar
  const key = buildStorageKey({ tenantId: w.tenantId, area: "documents", contentType: "application/pdf" });
  const doc = await registerAuthorityDocument(w.tenantId, later.id, w.actor, { type: "INCOMING_NOTICE", fileName: "bescheid.pdf", storageKey: key, contentType: "application/pdf", sizeBytes: 5, checksum: sha256("y") });
  await assert.rejects(() => registerAuthorityDocument(w.tenantId, later.id, w.actor, { type: "RESPONSE_PDF", fileName: "x.pdf", storageKey: key + "2", contentType: "application/pdf", sizeBytes: 5, checksum: sha256("z") }), /Unbekannter Dokumenttyp/);
  await assert.rejects(() => db.authorityCaseDocument.delete({ where: { id: doc.id } }), /nicht gelöscht/);
  await assert.rejects(() => archiveAuthorityDocument(w.tenantId, doc.id, w.actor, "x"), /Grund/);
  const archived = await archiveAuthorityDocument(w.tenantId, doc.id, w.actor, "Falscher Vorgang");
  assert.ok(archived.archivedAt);
  await assert.rejects(() => archiveAuthorityDocument(w.tenantId, doc.id, w.actor, "nochmal"), /bereits archiviert/);
  await assert.rejects(() => db.authorityCaseDocument.update({ where: { id: doc.id }, data: { archivedAt: null } }), /nicht zurückgenommen/);
  assert.equal((await authorityCaseView(w.tenantId, later.id)).archivedDocuments.length, 1);
  // Abschluss mit Grund; danach keine Änderungen; Wiederöffnen; Storno; Wettlauf beim Abschluss
  await assert.rejects(() => closeAuthorityCase(w.tenantId, later.id, w.actor, ""), /Abschlussgrund/);
  const results = await Promise.allSettled([closeAuthorityCase(w.tenantId, later.id, w.actor, "Telefonisch geklärt"), closeAuthorityCase(w.tenantId, later.id, w.actor, "Telefonisch geklärt")]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const closed = await db.authorityCase.findUniqueOrThrow({ where: { id: later.id } });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.closeReason, "Telefonisch geklärt");
  await assert.rejects(() => setDriver(w.tenantId, later.id, w.actor, { mode: "NOT_IDENTIFIABLE" }), /abgeschlossen/);
  await assert.rejects(() => prepareResponse(w.tenantId, later.id, w.actor, { responseType: "CUSTOM_RESPONSE", submissionMethod: "POST", freeText: "x" }), /abgeschlossen/);
  assert.equal((await listAuthorityCases(w.tenantId, { filter: "abgeschlossen" })).total, 1);
  assert.equal((await authorityCounts(w.tenantId)).overdue, 1, "abgeschlossene Vorgänge zählen nicht als überfällig");
  await closeAuthorityCase(w.tenantId, overdue.id, w.actor, "Bezahlt");
  assert.equal((await authorityCounts(w.tenantId)).overdue, 0);
  const reopened = await reopenAuthorityCase(w.tenantId, later.id, w.actor, "Behörde fragt nach");
  assert.equal(reopened.status, "REVIEW_REQUIRED");
  assert.equal(reopened.closedAt, null);
  await cancelAuthorityCase(w.tenantId, none.id, w.actor, "Doppelt erfasst");
  assert.equal((await db.authorityCase.findUniqueOrThrow({ where: { id: none.id } })).status, "CANCELLED");
  await assert.rejects(() => db.authorityCase.delete({ where: { id: none.id } }), /nicht gelöscht/);
  await assert.rejects(() => db.authorityCase.update({ where: { id: none.id }, data: { caseNumber: "BH-2026-999999" } }), /fest/);
  const events = await db.authorityCaseEvent.findMany({ where: { caseId: later.id }, select: { type: true } });
  for (const t of ["DOCUMENT_ADDED", "DOCUMENT_ARCHIVED", "CLOSED", "REOPENED"]) assert.ok(events.some((e) => e.type === t), t);
  assert.deepEqual((await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["AUTHORITY_CASE_CLOSED", "AUTHORITY_CASE_REOPENED", "AUTHORITY_CASE_CANCELLED"] } } })).map((a) => a.action).sort(), ["AUTHORITY_CASE_CANCELLED", "AUTHORITY_CASE_CLOSED", "AUTHORITY_CASE_CLOSED", "AUTHORITY_CASE_REOPENED"]);
});

// ---------------------------------------------------------------------------
// Mandantentrennung
// ---------------------------------------------------------------------------

test("Mandantentrennung: fremde Vorgänge, Fahrzeuge, Buchungen, Fahrer, Fassungen und Dokumente sind unsichtbar oder werden abgelehnt – auch auf Datenbankebene", async () => {
  const a = await twoDriverWorld("auth-tenant-a");
  const b = await twoDriverWorld("auth-tenant-b");
  const pa = await plate(a.vehicleId);
  const ca = await createAuthorityCase(a.tenantId, a.actor, input(pa, at(-1, 12)));
  const cb = await createAuthorityCase(b.tenantId, b.actor, input(pa, at(-1, 12)));
  assert.equal(cb.vehicleMatch, "NO_MATCH", "Kennzeichen des anderen Mandanten wird nicht gefunden");
  await assert.rejects(() => authorityCaseView(b.tenantId, ca.id), /nicht gefunden/);
  await assert.rejects(() => updateAuthorityCase(b.tenantId, ca.id, b.actor, input(pa, at(-1, 12))), /nicht gefunden/);
  await assert.rejects(() => assignVehicle(b.tenantId, cb.id, b.actor, a.vehicleId), /Fahrzeug nicht gefunden/);
  await assert.rejects(() => assignBooking(b.tenantId, cb.id, b.actor, a.bookingId), /Buchung nicht gefunden/);
  const va = await authorityCaseView(a.tenantId, ca.id);
  await assert.rejects(() => setDriver(b.tenantId, cb.id, b.actor, { mode: "CONTRACT", contractDriverId: va.driverCandidates[0].contractDriverId, confirmed: true }), /nicht zum zugeordneten Mietvertrag/);
  await assert.rejects(() => setDriver(b.tenantId, ca.id, b.actor, { mode: "NOT_IDENTIFIABLE" }), /nicht gefunden/);
  await setDriver(a.tenantId, ca.id, a.actor, { mode: "NOT_IDENTIFIABLE" });
  const ra = await prepareResponse(a.tenantId, ca.id, a.actor, { responseType: "DRIVER_NOT_IDENTIFIABLE", submissionMethod: "POST" });
  await assert.rejects(() => approveResponse(b.tenantId, ra.id, b.actor, { storage }), /nicht gefunden/);
  await approveResponse(a.tenantId, ra.id, a.actor, { storage });
  await assert.rejects(() => submitResponse(b.tenantId, ra.id, b.actor, { submittedAt: new Date() }), /nicht gefunden/);
  const doc = await db.authorityCaseDocument.findFirstOrThrow({ where: { caseId: ca.id } });
  await assert.rejects(() => archiveAuthorityDocument(b.tenantId, doc.id, b.actor, "fremd"), /nicht gefunden/);
  await assert.rejects(() => closeAuthorityCase(b.tenantId, ca.id, b.actor, "fremd"), /nicht gefunden/);
  assert.equal((await listAuthorityCases(b.tenantId, {})).total, 1);
  assert.equal((await casesForVehicle(b.tenantId, a.vehicleId)).length, 0);
  // Datenbank: Fremdverknüpfungen scheitern am Trigger
  await assert.rejects(() => db.authorityCase.update({ where: { id: cb.id }, data: { vehicleId: a.vehicleId } }), /RB_TENANT/);
  await assert.rejects(() => db.authorityCase.update({ where: { id: cb.id }, data: { bookingId: a.bookingId } }), /RB_TENANT/);
  await assert.rejects(() => db.authorityCaseDocument.create({ data: { tenantId: b.tenantId, caseId: ca.id, type: "OTHER", fileName: "x", storageKey: buildStorageKey({ tenantId: b.tenantId, area: "documents", contentType: "application/pdf" }), contentType: "application/pdf", sizeBytes: 1, checksum: "c", createdById: b.userId, createdByName: "x" } }), /RB_TENANT/);
  await assert.rejects(() => db.authorityResponse.create({ data: { tenantId: b.tenantId, caseId: ca.id, version: 9, responseType: "CUSTOM_RESPONSE", submissionMethod: "POST", recipientSnapshot: {}, authorityReference: "x", senderSnapshot: {}, vehicleSnapshot: {}, offenseSnapshot: {}, createdById: b.userId, createdByName: "x" } }), /RB_TENANT/);
});
