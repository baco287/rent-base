// Befehl 29: Unfallersatz V1 (Backend). Offenes Mietende (endAt null) und Fahrzeugkonflikte, Anlage mit Fallnummer und
// Idempotenz, Mietdauer aktualisieren, Vertrag mit offenem Ende, Übergabe/Rückgabe über die bestehenden Prozesse,
// Unfallersatz-Rechnung an Versicherung bzw. Mieter, Teilzahlungen, dokumentierte Kürzungen ohne Forderungsminderung,
// Mahnempfänger ohne Rückfall auf den Mieter, Wiedervorlagen, Abschlusswarnungen, Datenbankregeln und Mandantentrennung.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import {
  accidentCaseCounts, accidentCaseView, archiveAccidentDocument, cancelFollowUp, caseFinancials, closeCase, closeWarnings, completeFollowUp, createAccidentCase, createFollowUp,
  listAccidentCases, previewPlannedEnd, registerAccidentDocument, reopenCase, setLiability, setTariff, updateInsurer, updatePlannedEnd, type CreateAccidentCaseInput,
} from "../src/lib/accident-replacement";
import { changeBookingPeriod } from "../src/lib/booking-period";
import { assertVehicleBookable, findConflicts, isOverdue, occupiedUntil } from "../src/lib/bookings";
import { contractEndOf, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { createAmendmentDraft, updateAmendmentDraft } from "../src/lib/amendments";
import { FEATURES } from "../src/lib/constants";
import { invoiceFinancials } from "../src/lib/counter-documents";
import { loadDashboard } from "../src/lib/dashboard";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { previewDunning } from "../src/lib/dunning";
import { finalizeHandover, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { adjustmentSummary, cancelInvoiceAdjustment, recordInvoiceAdjustment } from "../src/lib/invoice-adjustments";
import { createAccidentInvoiceDraft, createAccidentRemainderDraft, ensureInvoiceDraft, finalizeInvoice } from "../src/lib/invoices";
import { DomainError, sha256 } from "../src/lib/integrity";
import { toCents } from "../src/lib/money";
import { invoicePaymentSummary, recordInvoicePayment } from "../src/lib/payments";
import { expectedRentalCents } from "../src/lib/rental-payments";
import { buildStorageKey } from "../src/lib/storage";
import { planInvoiceMail } from "../src/lib/rental-mail";
import { applyDepositOffset, depositOffsetOptions } from "../src/lib/deposit-offset";
import { recordDepositReceived } from "../src/lib/deposits";
import { recordRentalPayment } from "../src/lib/rental-payments";
import { futureBookingsOf, openDamageCase } from "../src/lib/damage-cases";
import { buildContractDocument } from "../src/lib/contract-view";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { answerAll, photo, sign } from "./rental-flow";

const tenants: string[] = [];
after(async () => { await purgeTenants(tenants); await db.$disconnect(); });

const HOUR = 3600_000, DAY = 24 * HOUR;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
let seq = 0;
const nonce = () => `ue-test-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type AWorld = World & { v2: string };

/** Mandant mit Rechnungsdaten und einem zweiten Fahrzeug (v2) ohne Buchungen; v1 trägt die Standardbuchung aus createWorld (morgen, 6 Tage). */
async function world(label: string): Promise<AWorld> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });
  // Unfallersatz ist standardmäßig gesperrt; für diese Tests freigeschaltet (wie im Control Center)
  await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UE ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, make: "VW", model: "Golf", groupId: w.groupId, fuel: "BENZIN", mileage: 30_000, dailyRate: 59, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 0, tankCapacityLiters: 50, requiredLicenseClass: "B" } });
  return { ...w, v2: v2.id };
}

function caseInput(w: AWorld, over: Partial<CreateAccidentCaseInput> = {}): CreateAccidentCaseInput {
  return {
    nonce: nonce(), customerId: w.customerId, vehicleId: w.v2, startAt: plus(new Date(), HOUR), plannedEndAt: null, dailyRateCents: 7_900, depositCents: 0, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "hb-ab 123", make: "Opel", model: "Astra", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: plus(new Date(), -2 * DAY), place: "Bremen, Am Wall", opponentPlate: "OL-X 99", opponentName: "Gegner GmbH", policeFileNumber: "AZ 4711" },
    insurer: { name: "HUK-COBURG", claimNumber: null, contactName: "Frau Sachbearbeiterin", phone: "09561 960", email: null, street: "Bahnhofsplatz 1", zip: "96450", city: "Coburg" },
    liability: { status: "REPORTED" },
    tariff: [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1500 }, { kind: "DELIVERY", perDay: false, unitPriceCents: 4000 }],
    ...over,
  };
}

/** Vertrag (offenes Ende) unterschreiben und Fahrzeug übergeben – über die bestehenden Prozesse. */
async function signAndPickup(w: AWorld, bookingId: string, deposit = 0) {
  const ww = { ...w, bookingId, vehicleId: w.v2 };
  const contract = await db.rentalContract.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId } });
  const bk = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  await saveConditions(w.tenantId, contract.id, { startAt: bk.startAt, endAt: null, deposit, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 500, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, contract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, contract.id) });
  await finalizeContract(w.tenantId, contract.id);
  // Mietbeginn auf „jetzt“ ziehen, damit die Übergabe heute stattfindet (wie in den bestehenden Flows)
  const p = await startHandover(w.tenantId, bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 30_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, p.id, cat);
  await answerAll(ww, p.id);
  await sign(ww, p.id);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, contract.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  return { contractId: contract.id, pickupId: p.id };
}

async function doReturn(w: AWorld, bookingId: string) {
  const ww = { ...w, bookingId, vehicleId: w.v2 };
  const r = await startHandover(w.tenantId, bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 30_400, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, r.id, cat);
  await answerAll(ww, r.id);
  await sign(ww, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  return r.id;
}

async function returnedCase(label: string, over: Partial<CreateAccidentCaseInput> = {}) {
  const w = await world(label);
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, over));
  await signAndPickup(w, res.bookingId);
  const returnId = await doReturn(w, res.bookingId);
  return { w, caseId: res.case.id, bookingId: res.bookingId, returnId };
}

// ---------------------------------------------------------------------------
// Anlage, Fallnummer, Idempotenz, offenes Mietende
// ---------------------------------------------------------------------------

test("Fall anlegen: Buchung Unfallersatz mit offenem Ende, Fallnummer UE-JJJJ-NNNNNN, Vertragsentwurf ohne Ende, Tarif, Verlauf, Audit, Adressbuch", async () => {
  const w = await world("ue-create");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  assert.equal(res.created, true);
  assert.equal(res.contractError, null);
  assert.match(res.case.caseNumber, new RegExp(`^UE-${new Date().getFullYear()}-000001$`));
  const b = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
  assert.equal(b.rentalType, "ACCIDENT_REPLACEMENT");
  assert.equal(b.endAt, null, "offenes Mietende ist null, kein erfundenes Datum");
  assert.equal(Number(b.dailyRate), 79);
  const c = await db.rentalContract.findFirstOrThrow({ where: { bookingId: b.id } });
  assert.equal(c.endAt, null, "Vertrag läuft bis zur Rückgabe");
  assert.equal(Number(c.totalAmount), 0);
  assert.equal((c.priceSnapshot as { openEnd?: boolean }).openEnd, true);
  assert.equal(res.case.damagedPlate, "HB-AB 123");
  assert.equal(res.case.insurerClaimNumber, null, "Schadennummer darf bei Anlage fehlen");
  assert.equal(await db.accidentReplacementTariffItem.count({ where: { caseId: res.case.id } }), 2);
  assert.equal(await db.accidentReplacementCaseEvent.count({ where: { caseId: res.case.id, type: "CREATED" } }), 1);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "ACCIDENT_CASE_CREATED", bookingId: b.id } }), 1);
  const partner = await db.businessPartner.findFirstOrThrow({ where: { tenantId: w.tenantId, kind: "INSURER" } });
  assert.equal(partner.name, "HUK-COBURG");
  // Idempotenz: derselbe Formularschlüssel liefert denselben Fall
  const again = await createAccidentCase(w.tenantId, w.actor, { ...caseInput(w), nonce: res.case.idempotencyKey });
  assert.equal(again.created, false);
  assert.equal(again.case.id, res.case.id);
  assert.equal(await db.booking.count({ where: { tenantId: w.tenantId, rentalType: "ACCIDENT_REPLACEMENT" } }), 1);
});

test("Neuer Kunde über die bestehende Kundenlogik; gesperrter Kunde wird abgelehnt; Pflichtangaben werden geprüft", async () => {
  const w = await world("ue-customer");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { customerId: null, newCustomer: { type: "PRIVATE", firstName: "Max", lastName: "Müller", country: "DE", blocked: false, discountPercent: 0, street: "Weg 2", zip: "28195", city: "Bremen" } }));
  const b = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId }, include: { customer: true } });
  assert.equal(b.customer.lastName, "Müller");
  assert.match(b.customer.number ?? "", /^K-\d{5}$/);
  await db.customer.update({ where: { id: w.customerId }, data: { blocked: true, blockReason: "Test" } });
  const v3 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-UE 3333", make: "VW", model: "Polo", groupId: w.groupId, dailyRate: 49 } });
  await assert.rejects(() => createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: v3.id })), /gesperrt/);
  await db.customer.update({ where: { id: w.customerId }, data: { blocked: false, blockReason: null } });
  await assert.rejects(() => createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: v3.id, damaged: { plate: " ", make: "Opel", model: "Astra", drivable: true, damageKind: "REPAIR" } })), /Kennzeichen/);
  await assert.rejects(() => createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: v3.id, dailyRateCents: 0 })), /Tagessatz/);
});

test("Fallnummern kollidieren nicht: fünf gleichzeitige Anlagen auf fünf Fahrzeugen ergeben fünf fortlaufende Nummern", async () => {
  const w = await world("ue-numbers");
  const vehicles = await Promise.all([0, 1, 2, 3, 4].map((i) => db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UN ${i}${Date.now().toString().slice(-3)}`, make: "VW", model: "Polo", groupId: w.groupId, dailyRate: 49 } })));
  const results = await Promise.all(vehicles.map((v) => createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: v.id }))));
  const numbers = results.map((r) => r.case.caseNumber).sort();
  assert.equal(new Set(numbers).size, 5);
  const year = new Date().getFullYear();
  assert.deepEqual(numbers, [1, 2, 3, 4, 5].map((n) => `UE-${year}-${String(n).padStart(6, "0")}`));
  assert.equal(new Set(results.map((r) => r.bookingId)).size, 5);
});

// ---------------------------------------------------------------------------
// Fahrzeugkonflikte bei offenem Ende
// ---------------------------------------------------------------------------

test("Offenes Ende belegt das Fahrzeug ab Mietbeginn unbegrenzt: spätere Buchungen werden abgelehnt, frühere und angrenzende nicht", async () => {
  const w = await world("ue-conflict");
  const start = plus(new Date(), 2 * DAY);
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: start }));
  const check = (s: Date, e: Date | null) => db.$transaction((tx) => assertVehicleBookable(tx, w.tenantId, w.v2, s, e));
  // 30 Tage später: belegt
  assert.equal((await check(plus(start, 30 * DAY), plus(start, 31 * DAY))).conflicts.length, 1);
  // 365 Tage später: belegt (kein künstliches Ende)
  assert.equal((await check(plus(start, 365 * DAY), plus(start, 366 * DAY))).conflicts.length, 1);
  // vorher und genau angrenzend (Ende = Beginn): frei (halboffene Zeiträume)
  assert.equal((await check(plus(start, -3 * DAY), plus(start, -1 * DAY))).conflicts.length, 0);
  assert.equal((await check(plus(start, -2 * DAY), start)).conflicts.length, 0);
  // über den Beginn hinweg: belegt
  assert.equal((await check(plus(start, -1 * DAY), plus(start, HOUR))).conflicts.length, 1);
  // eine weitere Anlage mit offenem Ende auf demselben Fahrzeug – auch vorher beginnend – ist belegt
  // offenes Ende vor der (offenen) Belegung: Grund und Ausweg statt bloßer „Doppelbelegung“
  await assert.rejects(() => createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: plus(start, -1 * DAY) })), /Mietende offen ist mit .+ nicht möglich: Das Fahrzeug ist ab .+ für Buchung .+ vorgesehen\. Bitte ein geplantes Mietende vor diesem Zeitpunkt wählen oder ein anderes Fahrzeug\.$/);
  await assert.rejects(() => createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: plus(start, 10 * DAY), plannedEndAt: plus(start, 12 * DAY) })), /Doppelbelegung.*offenes Mietende/);
  // Abfrage ohne Ende (Suchzeitraum offen) trifft eine spätere Standardbuchung
  const conflicts = await findConflicts(db, w.tenantId, w.vehicleId, plus(new Date(), -DAY), null);
  assert.equal(conflicts.length, 1, "offener Suchzeitraum trifft die Standardbuchung auf v1");
  assert.equal(conflicts[0].id, w.bookingId);
  // Belegungshilfen: offenes Ende ist nie überfällig und belegt „bis offen“
  const b = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
  assert.equal(isOverdue({ status: "ACTIVE", endAt: b.endAt }, plus(start, 400 * DAY)), false);
  assert.equal(occupiedUntil({ status: "ACTIVE", endAt: b.endAt }, plus(start, 400 * DAY)), null);
});

test("Offenes Ende vor einer bestehenden Standardbuchung wird abgelehnt; mit geplantem Ende davor ist die Anlage möglich", async () => {
  const w = await world("ue-before-std");
  const std = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  // v1 ist ab morgen für 6 Tage gebucht
  await assert.rejects(() => createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: w.vehicleId, startAt: plus(new Date(), HOUR), plannedEndAt: null })), new RegExp(`Mietende offen ist mit .+ nicht möglich: Das Fahrzeug ist ab .+ für Buchung ${std.number} vorgesehen`));
  const ok = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: w.vehicleId, startAt: plus(new Date(), HOUR), plannedEndAt: plus(std.startAt, -HOUR) }));
  assert.equal(ok.created, true);
});

test("Parallel: zwei gleichzeitige Anlagen mit offenem Ende auf demselben Fahrzeug – genau eine gewinnt (Fahrzeugsperre)", async () => {
  const w = await world("ue-race");
  const start = plus(new Date(), DAY);
  const results = await Promise.allSettled([0, 1, 2].map(() => createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: start }))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results.filter((r) => r.status === "rejected")) assert.match(String((r as PromiseRejectedResult).reason?.message), /Doppelbelegung/);
  assert.equal(await db.booking.count({ where: { tenantId: w.tenantId, vehicleId: w.v2, status: { in: ["RESERVED", "ACTIVE"] } } }), 1);
});

// ---------------------------------------------------------------------------
// Mietdauer aktualisieren
// ---------------------------------------------------------------------------

test("Mietdauer aktualisieren: Ende setzen, verlängern, wieder öffnen – Konflikte erkannt, Pflichtgrund, Verlauf und Audit, keine neue Buchung", async () => {
  const w = await world("ue-extend");
  const start = plus(new Date(), DAY);
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: start, plannedEndAt: plus(start, 5 * DAY) }));
  // Folgebuchung (Standard) ab Tag 10 auf demselben Fahrzeug
  const follow = await db.booking.create({ data: { tenantId: w.tenantId, number: `T-F-${Date.now()}`, vehicleId: w.v2, customerId: w.customerId, startAt: plus(start, 10 * DAY), endAt: plus(start, 12 * DAY), dailyRate: 59 } });
  await assert.rejects(() => updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(start, 8 * DAY), reason: "" }), /Grund/);
  const r1 = await updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(start, 8 * DAY), reason: "Reparatur dauert länger" });
  assert.equal(r1.after!.getTime(), plus(start, 8 * DAY).getTime());
  // Verlängerung in die Folgebuchung: abgelehnt, Ende bleibt
  await assert.rejects(() => updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(start, 11 * DAY), reason: "Teile fehlen" }), new RegExp(`Buchung ${follow.number}`));
  // offen machen ist bei Folgebuchung ebenfalls ein Konflikt
  await assert.rejects(() => updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: null, reason: "Ende unbekannt" }), new RegExp(`Buchung ${follow.number}`));
  const preview = await previewPlannedEnd(w.tenantId, res.case.id, plus(start, 11 * DAY));
  assert.match(preview.conflict ?? "", new RegExp(follow.number));
  assert.ok(preview.estimateAfterCents > preview.estimateBeforeCents);
  // nach Storno der Folgebuchung: offen möglich
  await db.booking.update({ where: { id: follow.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancellationReason: "Test" } });
  await updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: null, reason: "Ende unbekannt" });
  const b = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
  assert.equal(b.endAt, null);
  assert.equal(await db.booking.count({ where: { tenantId: w.tenantId, rentalType: "ACCIDENT_REPLACEMENT" } }), 1, "keine neue Buchung");
  assert.equal(await db.accidentReplacementCaseEvent.count({ where: { caseId: res.case.id, type: "PLANNED_END_CHANGED" } }), 2);
  const audits = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: "ACCIDENT_CASE_PLANNED_END_CHANGED" }, orderBy: { createdAt: "asc" } });
  assert.equal(audits.length, 2);
  assert.equal((audits[1].details as { endAfter: string | null }).endAfter, null);
  // Nachtrag und „Zeitraum ändern“ der Standardmiete greifen beim Unfallersatz nicht
  await assert.rejects(() => changeBookingPeriod(w.tenantId, w.actor, res.bookingId, { startAt: start, endAt: plus(start, 3 * DAY), reason: "Test" }), /Fallakte/);
});

// ---------------------------------------------------------------------------
// Übergabe, Rückgabe, Abrechnung, Zahlungen, Kürzungen
// ---------------------------------------------------------------------------

test("Übergabe und Rückgabe über die bestehenden Prozesse; tatsächliche Mietdauer steht fest; Verlauf in der Fallakte", async () => {
  const { w, caseId, bookingId, returnId } = await returnedCase("ue-flow");
  const b = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  assert.equal(b.status, "RETURNED");
  assert.ok(b.actualPickupAt && b.actualReturnAt);
  assert.equal(b.endAt, null, "das geplante Ende bleibt offen; maßgeblich ist actualReturnAt");
  const ret = await db.handover.findUniqueOrThrow({ where: { id: returnId } });
  assert.equal(ret.status, "FINALIZED");
  const types = (await db.accidentReplacementCaseEvent.findMany({ where: { caseId }, select: { type: true } })).map((e) => e.type);
  assert.ok(types.includes("VEHICLE_PICKED_UP") && types.includes("VEHICLE_RETURNED"));
  // Unfallersatz rechnet nicht über die Mietrechnung ab
  await assert.rejects(() => ensureInvoiceDraft(w.tenantId, bookingId, w.actor), /Fallakte/);
  const view = await accidentCaseView(w.tenantId, caseId);
  assert.equal(view.state.rental, "RETURNED");
  assert.ok(view.nextSteps.some((s) => s.code === "INVOICE_MISSING"));
});

test("Rechnung an die Versicherung: Mieter ≠ Empfänger, Positionen aus Tagen und Tarif, PDF-Daten mit Schadennummer, Teilzahlungen, Kürzung ändert nichts an Rechnung und Forderung", async () => {
  const { w, caseId, bookingId } = await returnedCase("ue-invoice");
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId, recipientRole: "INSURER", nonce: "kurz" }), /veraltet/);
  await updateInsurer(w.tenantId, caseId, w.actor, { insurer: { name: "HUK-COBURG", claimNumber: "SN-2026-77", street: "Bahnhofsplatz 1", zip: "96450", city: "Coburg" }, liability: { status: "CONFIRMED" } });
  const n = nonce();
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId, recipientRole: "INSURER", nonce: n });
  const again = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId, recipientRole: "INSURER", nonce: n });
  assert.equal(again.created, false);
  const v = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId: invoice.id }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  const snap = v.customerSnapshot as { companyName: string; recipientRole: string; claimNumber: string; insuredName: string };
  assert.equal(snap.companyName, "HUK-COBURG");
  assert.equal(snap.recipientRole, "INSURER");
  assert.equal(snap.claimNumber, "SN-2026-77");
  assert.equal(snap.insuredName, "Erika Muster", "Geschädigter bleibt nachvollziehbar");
  const booking = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  assert.equal(invoice.customerId, booking.customerId, "Bezug bleibt der Mieter; Empfänger steht in der Kopie");
  // Positionen: 1 Tag × 79 Grundmiete, Haftungsreduzierung 1 × 15, Zustellung 40 → 134,00 brutto
  assert.equal(v.items.length, 3);
  assert.equal(toCents(v.grossTotal), 13_400);
  const fin0 = await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  assert.equal(fin0.status, "FINALIZED");
  const docData = await loadInvoiceDocumentData(w.tenantId, fin0.id);
  assert.equal(docData.doc.customer.roleLabel, "Versicherung");
  assert.equal(docData.doc.customer.claimNumber, "SN-2026-77");
  assert.equal(docData.doc.customer.insuredName, "Erika Muster");
  // Teilzahlungen: 50 + 34 → offen 50, Status PARTIAL
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: invoice.id, amount: "50,00", method: "BANK_TRANSFER", paidAt: new Date(), reference: "HUK 1" });
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: invoice.id, amount: "34,00", method: "BANK_TRANSFER", paidAt: new Date(), reference: "HUK 2" });
  const s1 = await invoicePaymentSummary(w.tenantId, invoice.id);
  assert.equal(s1.paidCents, 8_400);
  assert.equal(s1.openCents, 5_000);
  assert.equal(s1.status, "PARTIAL");
  // Kürzung 50 € dokumentieren: Rechnungsbetrag, Zahlungen und offene Forderung bleiben unverändert
  const versionBefore = await db.invoiceVersion.findUniqueOrThrow({ where: { id: fin0.id } });
  const adj = await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "TARIFF", amountCents: 5_000, decidedAt: new Date(), note: "Tagessatz über Schwacke-Mittelwert" });
  const f2 = await invoiceFinancials(w.tenantId, invoice.id);
  assert.equal(f2.invoiceCents, 13_400);
  assert.equal(f2.paidCents, 8_400);
  assert.equal(f2.openCents, 5_000, "dokumentierte Kürzung setzt die Forderung nicht auf null");
  const versionAfter = await db.invoiceVersion.findUniqueOrThrow({ where: { id: fin0.id } });
  assert.equal(String(versionAfter.grossTotal), String(versionBefore.grossTotal));
  assert.equal(versionAfter.contentHash, versionBefore.contentHash);
  const sum = await adjustmentSummary(w.tenantId, invoice.id);
  assert.equal(sum.reducedCents, 5_000);
  // Summe der Kürzungen ≤ Rechnungsbetrag
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "OTHER", amountCents: 9_000, decidedAt: new Date() }), /übersteigen/);
  // Storno mit Grund; Zeile bleibt
  await assert.rejects(() => cancelInvoiceAdjustment(w.tenantId, w.actor, adj.id, ""), /Grund/);
  await cancelInvoiceAdjustment(w.tenantId, w.actor, adj.id, "Versicherung hat nachgezahlt");
  assert.equal((await adjustmentSummary(w.tenantId, invoice.id)).reducedCents, 0);
  assert.equal(await db.invoiceAdjustment.count({ where: { invoiceId: invoice.id } }), 1);
  // Fallakte: Finanzen aus der zentralen Saldenquelle
  const cf = await caseFinancials(w.tenantId, bookingId);
  assert.equal(cf.grossCents, 13_400);
  assert.equal(cf.paidCents, 8_400);
  assert.equal(cf.openCents, 5_000);
  const types = (await db.accidentReplacementCaseEvent.findMany({ where: { caseId }, select: { type: true } })).map((e) => e.type);
  assert.ok(types.includes("INVOICE_CREATED") && types.includes("ADJUSTMENT_RECORDED") && types.includes("ADJUSTMENT_CANCELLED"));
});

test("Mahnwesen: Versicherungsrechnung ohne E-Mail fällt nie auf die Mieteradresse zurück; Mieterrechnung nutzt ihre eigene Kopie", async () => {
  const { w, caseId } = await returnedCase("ue-dunning");
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId, recipientRole: "INSURER", nonce: nonce() });
  await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  const plan = await previewDunning(w.tenantId, invoice.id, { now: plus(new Date(), 60 * DAY) });
  assert.equal(plan.recipientName, "HUK-COBURG");
  assert.equal(plan.recipientEmail, null, "kein Rückgriff auf erika@example.test");
  // Mieterrechnung (Phase F: Restforderung nach dokumentierter Kürzung): Empfänger ist der Mieter
  await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "TARIFF", amountCents: 3_000, decidedAt: new Date() });
  const { invoice: rentInv } = await createAccidentRemainderDraft(w.tenantId, w.actor, { caseId, invoiceId: invoice.id, amountCents: 3_000, nonce: nonce() });
  await finalizeInvoice(w.tenantId, rentInv.id, w.actor);
  const plan2 = await previewDunning(w.tenantId, rentInv.id, { now: plus(new Date(), 60 * DAY) });
  assert.equal(plan2.recipientEmail, "erika@example.test");
  // mehrere Unfallersatz-Rechnungen je Buchung sind möglich (anders als die eine Mietrechnung)
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, kind: "ACCIDENT_REPLACEMENT", status: "FINALIZED" } }), 2);
});

test("Zwischenrechnung vor der Rückgabe nur mit Stichtag ≤ jetzt; nie ein Leistungszeitraum in der Zukunft", async () => {
  const w = await world("ue-interim");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: plus(new Date(), -HOUR) }));
  await signAndPickup(w, res.bookingId);
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "INSURER", nonce: nonce() }), /Stichtag/);
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "INSURER", periodEnd: plus(new Date(), DAY), nonce: nonce() }), /Zukunft/);
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "INSURER", periodEnd: new Date(), nonce: nonce() });
  assert.equal(invoice.returnHandoverId, null);
  // bisheriger Mietwert bei offenem Ende: Schätzung aus Tagessatz bis jetzt, nie aus einem erfundenen Ende
  const b = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId }, include: { customer: true, contract: { select: { status: true, totalAmount: true, amendments: { where: { status: "SIGNED" }, select: { id: true, number: true, sequenceNo: true, priceDeltaCents: true, newDepositCents: true, newEndAt: true } } } } } });
  const est = expectedRentalCents(b);
  assert.equal(est.source, "ESTIMATE");
  assert.equal(est.cents, 7_900);
  // Nachträge mit neuem Ende sind beim Unfallersatz gesperrt
  const { amendment } = await createAmendmentDraft(w.tenantId, w.actor, { bookingId: res.bookingId, nonce: nonce() });
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, amendment.id, { newEndAt: plus(new Date(), 5 * DAY) }), /Fallakte/);
  // Dashboard: laufende Miete mit offenem Ende ist nie „Rückgabe überfällig“
  const dash = await loadDashboard(w.tenantId, { now: plus(new Date(), 30 * DAY) });
  assert.ok(!dash.tasks.some((t) => t.key === `return-overdue-${res.bookingId}`));
});

// ---------------------------------------------------------------------------
// Haftung, Wiedervorlagen, Dokumente, Abschluss
// ---------------------------------------------------------------------------

test("Haftungsquote nur 0–100 und nur beim Status Haftungsquote; Datenbank prüft dasselbe", async () => {
  const w = await world("ue-quota");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  await assert.rejects(() => setLiability(w.tenantId, res.case.id, w.actor, { status: "QUOTA", quotaPercent: 101 }), /0 bis 100/);
  await assert.rejects(() => setLiability(w.tenantId, res.case.id, w.actor, { status: "QUOTA", quotaPercent: -1 }), /0 bis 100/);
  await assert.rejects(() => setLiability(w.tenantId, res.case.id, w.actor, { status: "QUOTA" }), /0 bis 100/);
  await assert.rejects(() => setLiability(w.tenantId, res.case.id, w.actor, { status: "CONFIRMED", quotaPercent: 50 }), /nur beim Status/);
  const ok = await setLiability(w.tenantId, res.case.id, w.actor, { status: "QUOTA", quotaPercent: 75, note: "Schreiben HUK vom 01.10." });
  assert.equal(ok.liabilityQuotaPercent, 75);
  await assert.rejects(() => db.accidentReplacementCase.update({ where: { id: res.case.id }, data: { liabilityQuotaPercent: 150 } }), /rb_accident_case_quota/);
  await assert.rejects(() => db.accidentReplacementCase.update({ where: { id: res.case.id }, data: { liabilityStatus: "CONFIRMED" } }), /rb_accident_case_quota/);
  const ev = await db.accidentReplacementCaseEvent.findFirstOrThrow({ where: { caseId: res.case.id, type: "LIABILITY_CHANGED" } });
  assert.equal(ev.toValue, "Haftungsquote 75 %");
});

test("Wiedervorlagen: anlegen, erledigen, verwerfen; erledigte bleiben unverändert und werden nie gelöscht", async () => {
  const w = await world("ue-followup");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  // Phase H: zuständig sind nur Inhaber und Disposition (wie die Auswahl der Fallakte) – Testbenutzer als Disposition
  await db.user.update({ where: { id: w.userId }, data: { role: "DISPO" } });
  const f1 = await createFollowUp(w.tenantId, res.case.id, w.actor, { title: "HUK wegen Haftungsbestätigung kontaktieren", dueAt: plus(new Date(), 2 * DAY), assigneeUserId: w.userId });
  assert.equal(f1.assigneeName, "Test Mitarbeiter");
  const f2 = await createFollowUp(w.tenantId, res.case.id, w.actor, { title: "Werkstatt anrufen", dueAt: plus(new Date(), DAY) });
  await completeFollowUp(w.tenantId, f1.id, w.actor, "Haftung telefonisch bestätigt");
  await assert.rejects(() => completeFollowUp(w.tenantId, f1.id, w.actor), /bereits/);
  await assert.rejects(() => cancelFollowUp(w.tenantId, f2.id, w.actor, ""), /Grund/);
  await cancelFollowUp(w.tenantId, f2.id, w.actor, "erledigt sich");
  await assert.rejects(() => db.caseFollowUp.update({ where: { id: f1.id }, data: { title: "geändert" } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.caseFollowUp.delete({ where: { id: f2.id } }), /RB_IMMUTABLE/);
  const types = (await db.accidentReplacementCaseEvent.findMany({ where: { caseId: res.case.id }, select: { type: true } })).map((e) => e.type);
  assert.ok(types.includes("FOLLOW_UP_CREATED") && types.includes("FOLLOW_UP_DONE") && types.includes("FOLLOW_UP_CANCELLED"));
});

test("Dokumente: Upload-Registrierung, Archivierung mit Grund statt Löschen, Datei und Zuordnung unveränderlich", async () => {
  const w = await world("ue-docs");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  const key = buildStorageKey({ tenantId: w.tenantId, area: "documents", bookingId: res.bookingId, contentType: "application/pdf" });
  await assert.rejects(() => registerAccidentDocument(w.tenantId, res.case.id, w.actor, { type: "XYZ", fileName: "a.pdf", storageKey: key, contentType: "application/pdf", sizeBytes: 100, checksum: sha256(key) }), /Dokumenttyp/);
  const doc = await registerAccidentDocument(w.tenantId, res.case.id, w.actor, { type: "ASSIGNMENT", fileName: "Abtretung.pdf", storageKey: key, contentType: "application/pdf", sizeBytes: 12_345, checksum: sha256(key) });
  await assert.rejects(() => db.accidentReplacementCaseDocument.update({ where: { id: doc.id }, data: { storageKey: `${key}-x` } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.accidentReplacementCaseDocument.delete({ where: { id: doc.id } }), /RB_IMMUTABLE/);
  await assert.rejects(() => archiveAccidentDocument(w.tenantId, doc.id, w.actor, "x"), /Grund/);
  await archiveAccidentDocument(w.tenantId, doc.id, w.actor, "falsche Datei hochgeladen");
  await assert.rejects(() => archiveAccidentDocument(w.tenantId, doc.id, w.actor, "nochmal"), /bereits archiviert/);
  await assert.rejects(() => db.accidentReplacementCaseDocument.update({ where: { id: doc.id }, data: { archivedAt: null, archiveReason: null } }), /RB_IMMUTABLE/);
});

test("Abschluss: Warnungen bei laufender Miete, fehlender Rückgabe/Rechnung und offenen Wiedervorlagen; nur mit Bestätigung; dokumentiert; geschlossene Akte gesperrt; Wiederöffnen mit Grund", async () => {
  const w = await world("ue-close");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  await createFollowUp(w.tenantId, res.case.id, w.actor, { title: "Gutachten anfordern", dueAt: plus(new Date(), DAY) });
  const warnings = await closeWarnings(w.tenantId, res.case.id);
  const codes = warnings.map((x) => x.code);
  for (const c of ["RENTAL_RUNNING", "NO_RETURN", "FOLLOW_UPS", "LIABILITY_OPEN"]) assert.ok(codes.includes(c), `Warnung ${c}`);
  await assert.rejects(() => closeCase(w.tenantId, res.case.id, w.actor, { reason: "fertig" }), /bewusst bestätigen/);
  await assert.rejects(() => closeCase(w.tenantId, res.case.id, w.actor, { reason: "", acknowledgeWarnings: true }), /Grund/);
  const closed = await closeCase(w.tenantId, res.case.id, w.actor, { reason: "Kunde hat storniert, Fall erledigt", acknowledgeWarnings: true });
  assert.equal(closed.status, "CLOSED");
  assert.deepEqual((closed.closeWarnings as { code: string }[]).map((x) => x.code).sort(), [...codes].sort());
  await assert.rejects(() => setTariff(w.tenantId, res.case.id, w.actor, []), /abgeschlossen/);
  await assert.rejects(() => updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(new Date(), 5 * DAY), reason: "Test" }), /abgeschlossen/);
  await assert.rejects(() => db.accidentReplacementTariffItem.create({ data: { tenantId: w.tenantId, caseId: res.case.id, kind: "OTHER", label: "x", unitPriceCents: 1 } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.accidentReplacementCase.delete({ where: { id: res.case.id } }), /RB_IMMUTABLE/);
  const reopened = await reopenCase(w.tenantId, res.case.id, w.actor, "Versicherung meldet sich erneut");
  assert.equal(reopened.status, "OPEN");
  assert.equal(reopened.closeWarnings, null);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: { in: ["ACCIDENT_CASE_CLOSED", "ACCIDENT_CASE_REOPENED"] } } }), 2);
});

test("Liste und Kennzahlen aus abgeleiteten Zuständen; Filter und Suche", async () => {
  const { w, caseId } = await returnedCase("ue-list");
  const running = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: w.vehicleId, startAt: plus(new Date(), HOUR), plannedEndAt: plus(new Date(), 10 * HOUR), insurer: { name: "Allianz" } }));
  const all = await listAccidentCases(w.tenantId);
  assert.equal(all.length, 2);
  assert.deepEqual((await listAccidentCases(w.tenantId, { filter: "abzurechnen" })).map((r) => r.id), [caseId]);
  assert.deepEqual((await listAccidentCases(w.tenantId, { filter: "laufend" })).map((r) => r.id), [running.case.id]);
  assert.deepEqual((await listAccidentCases(w.tenantId, { q: "allianz" })).map((r) => r.id), [running.case.id]);
  const counts = await accidentCaseCounts(w.tenantId);
  assert.equal(counts.running, 1);
  assert.equal(counts.toInvoice, 1);
  assert.equal(counts.liabilityOpen, 2);
});

// ---------------------------------------------------------------------------
// Datenbankregeln, Mandantentrennung, Standardmiete unverändert
// ---------------------------------------------------------------------------

test("Standardmiete: Ende bleibt Pflicht (DB-CHECK), Mietart ist fest, Vertrag ohne Ende nur beim Unfallersatz", async () => {
  const w = await world("ue-std");
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { endAt: null } }), /rb_booking_open_end/);
  await assert.rejects(() => db.booking.create({ data: { tenantId: w.tenantId, number: `T-X-${Date.now()}`, vehicleId: w.v2, customerId: w.customerId, startAt: new Date(), endAt: null } }), /rb_booking_open_end/);
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { rentalType: "ACCIDENT_REPLACEMENT" } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.booking.update({ where: { id: w.bookingId }, data: { rentalType: "SONSTIGES" } }), /rb_booking_rental_type|RB_IMMUTABLE/);
  const std = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(std.rentalType, "STANDARD");
  assert.equal(contractEndOf(std)?.getTime(), std.endAt!.getTime());
  const { ensureContractDraft } = await import("../src/lib/contracts");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.ok(c.endAt, "Standardvertrag hat ein Ende");
  await assert.rejects(() => db.rentalContract.update({ where: { id: c.id }, data: { endAt: null } }), /offenes Mietende gibt es nur bei einer Unfallersatzmiete/);
  // eine Fallakte gehört nur zu einer Unfallersatz-Buchung
  await assert.rejects(() => db.accidentReplacementCase.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, caseNumber: "UE-1999-000001", idempotencyKey: nonce(), damagedPlate: "X", damagedMake: "X", damagedModel: "X", damagedDrivable: true } }), /Unfallersatz-Buchung/);
});

test("Mandantentrennung: Mandant B sieht und ändert keine Fälle, Dokumente, Rechnungen oder Kürzungen von Mandant A – serverseitig und in der Datenbank", async () => {
  const { w: a, caseId, bookingId } = await returnedCase("ue-tenant-a");
  const b = await world("ue-tenant-b");
  const { invoice } = await createAccidentInvoiceDraft(a.tenantId, a.actor, { caseId, recipientRole: "INSURER", nonce: nonce() });
  await finalizeInvoice(a.tenantId, invoice.id, a.actor);
  await assert.rejects(() => accidentCaseView(b.tenantId, caseId), /nicht gefunden/);
  await assert.rejects(() => updatePlannedEnd(b.tenantId, caseId, b.actor, { plannedEndAt: null, reason: "fremd" }), /nicht gefunden/);
  await assert.rejects(() => setLiability(b.tenantId, caseId, b.actor, { status: "CONFIRMED" }), /nicht gefunden/);
  await assert.rejects(() => createFollowUp(b.tenantId, caseId, b.actor, { title: "x", dueAt: new Date() }), /nicht gefunden/);
  await assert.rejects(() => closeCase(b.tenantId, caseId, b.actor, { reason: "fremd", acknowledgeWarnings: true }), /nicht gefunden/);
  await assert.rejects(() => createAccidentInvoiceDraft(b.tenantId, b.actor, { caseId, recipientRole: "INSURER", nonce: nonce() }), /nicht gefunden/);
  await assert.rejects(() => recordInvoiceAdjustment(b.tenantId, b.actor, { invoiceId: invoice.id, reasonKind: "TARIFF", amountCents: 100, decidedAt: new Date() }), /nicht gefunden/);
  const key = buildStorageKey({ tenantId: b.tenantId, area: "documents", contentType: "application/pdf" });
  await assert.rejects(() => registerAccidentDocument(b.tenantId, caseId, b.actor, { type: "OTHER", fileName: "x.pdf", storageKey: key, contentType: "application/pdf", sizeBytes: 1, checksum: sha256(key) }), /nicht gefunden/);
  // Mandant B darf das Fahrzeug von A nicht über einen eigenen Fall belegen
  await assert.rejects(() => createAccidentCase(b.tenantId, b.actor, caseInput(b, { vehicleId: a.v2 })), /nicht gefunden/);
  // Datenbankebene: fremde Bezüge werden abgelehnt
  await assert.rejects(() => db.accidentReplacementCaseEvent.create({ data: { tenantId: b.tenantId, caseId, type: "NOTE_ADDED", note: "fremd" } }), /RB_TENANT/);
  await assert.rejects(() => db.accidentReplacementCaseDocument.create({ data: { tenantId: b.tenantId, caseId, type: "OTHER", fileName: "x.pdf", storageKey: `${key}-db`, contentType: "application/pdf", sizeBytes: 1, checksum: "x" } }), /RB_TENANT/);
  await assert.rejects(() => db.caseFollowUp.create({ data: { tenantId: b.tenantId, caseId, title: "x", dueAt: new Date() } }), /RB_TENANT/);
  await assert.rejects(() => db.accidentReplacementTariffItem.create({ data: { tenantId: b.tenantId, caseId, kind: "OTHER", label: "x", unitPriceCents: 1 } }), /RB_TENANT/);
  await assert.rejects(() => db.invoiceAdjustment.create({ data: { tenantId: b.tenantId, invoiceId: invoice.id, reasonKind: "TARIFF", amountCents: 100, decidedAt: new Date() } }), /RB_TENANT/);
  await assert.rejects(() => db.accidentReplacementCase.create({ data: { tenantId: b.tenantId, bookingId, caseNumber: "UE-1999-000002", idempotencyKey: nonce(), damagedPlate: "X", damagedMake: "X", damagedModel: "X", damagedDrivable: true } }), /RB_TENANT/);
  // Listen und Kennzahlen bleiben getrennt
  assert.equal((await listAccidentCases(b.tenantId)).length, 0);
  assert.equal((await accidentCaseCounts(b.tenantId)).running, 0);
});

test("Kürzungen: nur zu abgeschlossenen Rechnungen, nie geändert, nie gelöscht; Verlauf nur anfügen", async () => {
  const { w, caseId } = await returnedCase("ue-adj-rules");
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId, recipientRole: "INSURER", nonce: nonce() });
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "TARIFF", amountCents: 100, decidedAt: new Date() }), /abgeschlossenen Rechnungen/);
  await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "UNBEKANNT", amountCents: 100, decidedAt: new Date() }), /Kürzungsgrund/);
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "TARIFF", amountCents: 0, decidedAt: new Date() }), /größer als 0/);
  const adj = await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "DURATION", amountCents: 1_000, decidedAt: new Date() });
  await assert.rejects(() => db.invoiceAdjustment.update({ where: { id: adj.id }, data: { amountCents: 500 } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.invoiceAdjustment.delete({ where: { id: adj.id } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.invoiceAdjustment.update({ where: { id: adj.id }, data: { status: "CANCELLED" } }), /rb_invoice_adjustment_cancel_fields/);
  const ev = await db.accidentReplacementCaseEvent.findFirstOrThrow({ where: { caseId } });
  await assert.rejects(() => db.accidentReplacementCaseEvent.update({ where: { id: ev.id }, data: { note: "x" } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.accidentReplacementCaseEvent.delete({ where: { id: ev.id } }), /RB_IMMUTABLE/);
  assert.ok(DomainError);
});

test("Feature-Freischaltung: Unfallersatz ist ein eigenes, standardmäßig gesperrtes Modul mit Navigation /unfallersatz", () => {
  assert.equal(FEATURES.ACCIDENT_REPLACEMENT.defaultEnabled, false);
  assert.deepEqual([...FEATURES.ACCIDENT_REPLACEMENT.nav], ["/unfallersatz"]);
});

// ---------------------------------------------------------------------------
// Befunde der unabhängigen Prüfung (Phase B): Absicherungen
// ---------------------------------------------------------------------------

test("Rechnungsmail an die Versicherung: ohne eigene E-Mail kein Versand an den Mieter; Anrede an den Empfänger", async () => {
  const { w, caseId } = await returnedCase("ue-mail");
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId, recipientRole: "INSURER", nonce: nonce() });
  const v = await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  const plan = await planInvoiceMail(w.tenantId, v.id);
  assert.equal(plan.recipient, null, "kein Rückgriff auf die Vertragsadresse des Mieters");
  assert.equal(plan.facts.renterName, "HUK-COBURG");
  await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "TARIFF", amountCents: 2_000, decidedAt: new Date() });
  const { invoice: rentInv } = await createAccidentRemainderDraft(w.tenantId, w.actor, { caseId, invoiceId: invoice.id, amountCents: 2_000, nonce: nonce() });
  const rv = await finalizeInvoice(w.tenantId, rentInv.id, w.actor);
  assert.equal((await planInvoiceMail(w.tenantId, rv.id)).recipient, "erika@example.test");
});

test("Kaution des Mieters wird nie gegen eine Versicherungsrechnung verrechnet; Mietvorauszahlung beim Unfallersatz gesperrt", async () => {
  const w = await world("ue-deposit");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { depositCents: 30_000 }));
  await assert.rejects(() => recordRentalPayment(w.tenantId, w.actor, res.bookingId, { amount: "50", method: "CASH", paidAt: new Date() }), /Unfallersatz-Rechnung/);
  await signAndPickup(w, res.bookingId, 300);
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: res.bookingId, amount: "300", method: "CASH", occurredAt: new Date() });
  await doReturn(w, res.bookingId);
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "INSURER", nonce: nonce() });
  await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  const opts = await depositOffsetOptions(w.tenantId, res.bookingId);
  assert.equal(opts.invoices.length, 0, "Versicherungsrechnung wird nicht zur Verrechnung angeboten");
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: res.bookingId, invoiceId: invoice.id, amount: "100", occurredAt: new Date(), idempotencyKey: nonce() }), /Versicherung/);
  // eine Mieterrechnung (Restforderung nach dokumentierter Kürzung) kann mit der Kaution verrechnet werden
  await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "TARIFF", amountCents: 5_000, decidedAt: new Date() });
  const { invoice: rentInv } = await createAccidentRemainderDraft(w.tenantId, w.actor, { caseId: res.case.id, invoiceId: invoice.id, amountCents: 5_000, nonce: nonce() });
  await finalizeInvoice(w.tenantId, rentInv.id, w.actor);
  assert.deepEqual((await depositOffsetOptions(w.tenantId, res.bookingId)).invoices.map((i) => i.id), [rentInv.id]);
});

test("Zwischen- und Schlussrechnung: keine doppelte Berechnung von Miettagen, Einmalpositionen und Zusatzkosten", async () => {
  const w = await world("ue-interim-final");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: plus(new Date(), -HOUR) }));
  await signAndPickup(w, res.bookingId);
  const interim = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "INSURER", periodEnd: new Date(), nonce: nonce() });
  await finalizeInvoice(w.tenantId, interim.invoice.id, w.actor);
  const iv = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId: interim.invoice.id }, include: { items: true } });
  assert.equal(iv.items.filter((i) => i.source === "RENTAL").reduce((a, i) => a + Number(i.quantity), 0), 1);
  assert.ok(iv.items.some((i) => i.description.startsWith("Zustellung")), "Einmalposition in der ersten Rechnung");
  await doReturn(w, res.bookingId);
  // Rückgabe am selben Tag: alle Miettage sind bereits berechnet, Einmalpositionen ebenfalls → nichts mehr offen für die Versicherung
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "INSURER", nonce: nonce() }), /bereits/);
  // Phase F: auch für einen anderen Empfänger (Mieter) keine zweite Abrechnung derselben Leistung – die Kette gilt je Fall
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "RENTER", nonce: nonce() }), /bereits vollständig abgerechnet/);
});

test("Nachtrag beim Unfallersatz: andere Änderungen ohne Zeitraum speicherbar, Preisänderungen nur über den Tarif", async () => {
  const w = await world("ue-amend");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: plus(new Date(), -HOUR) }));
  await signAndPickup(w, res.bookingId);
  const { amendment } = await createAmendmentDraft(w.tenantId, w.actor, { bookingId: res.bookingId, nonce: nonce() });
  const saved = await updateAmendmentDraft(w.tenantId, w.actor, amendment.id, { newStartAt: null, newEndAt: null, newReturnLocation: "Werkstatt Müller", agreementText: "Fahrzeug wird an der Werkstatt abgegeben" });
  assert.equal(saved.newReturnLocation, "Werkstatt Müller");
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, amendment.id, { newStartAt: null, newEndAt: null, priceDeltaCents: 15_000, priceReason: "Aufschlag" }), /Tarif der Fallakte/);
});

test("Offenes Mietende: Schadenakte-Sperre nennt die laufende Unfallersatzmiete; Vertragsdokument ohne 0-Tage-Gesamtpreis; Rückgabe ohne Verspätungswarnung", async () => {
  const w = await world("ue-open-misc");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: plus(new Date(), DAY) }));
  const hints = await futureBookingsOf(w.tenantId, w.v2);
  assert.deepEqual(hints.map((h) => h.id), [res.bookingId]);
  const contract = await db.rentalContract.findFirstOrThrow({ where: { bookingId: res.bookingId }, include: { drivers: true } });
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } });
  const doc = buildContractDocument(contract as unknown as Parameters<typeof buildContractDocument>[0], tenant as unknown as Parameters<typeof buildContractDocument>[1], []);
  assert.equal(doc.price.openEnd, true);
  assert.match(doc.price.durationText, /offen/);
  // Phase E: Gesamtmietpreis „nach tatsächlicher Mietdauer“, die Formel steht in der Erläuterung (Tage × Summe je Miettag)
  assert.match(doc.price.total, /tatsächlicher Mietdauer/);
  assert.match(doc.price.totalNote ?? "", /tatsächliche Miettage ×/);
  assert.match(doc.price.lines[0].amount, /79,00/);
  assert.ok(openDamageCase);
});
