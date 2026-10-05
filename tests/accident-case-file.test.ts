// Befehl 29 Phase D: Unfallersatz-Fallakte. Kopf und Kennzahlen aus realen Daten, Hauptstatus abgeleitet, nächste Schritte
// (fehlende Schadennummer, offene Haftung, fällige Wiedervorlagen, keine Sackgasse zum Vertragsassistenten), Mietwert mit Tarif bei
// offenem Ende, Mietdauer mit Konfliktprüfung, Event und Audit, Partner-Kopie ohne ungewollte Adressbuchänderung, Wiedervorlagen,
// Abschluss mit Warnungen, geschlossene Akte gesperrt, Abrechnung mit Teilzahlung und dokumentierter Kürzung, operative Sicht für
// den Hof ohne kaufmännische Daten, Mandantentrennung. Rollen und direkte Aufrufe per HTTP: tests/smoke-pages.mts.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import {
  cancelFollowUp, closeCase, closeWarnings, completeFollowUp, createAccidentCase, createFollowUp, followUpDue, previewPlannedEnd, updateAccident, updateDamagedVehicle, updateInsurer, updatePlannedEnd, updateWorkshop,
  type CreateAccidentCaseInput,
} from "../src/lib/accident-replacement";
import {
  caseFileAccess, caseFileBilling, caseFileDamage, caseFileDocuments, caseFileHeader, caseFileHistory, caseFileOverview, caseFileRental, caseFileTabs, caseMainStatus, rentalDuration, resolveCaseFileTab,
} from "../src/lib/accident-case-file";
import { rentValue } from "../src/lib/accident-pricing";
import { finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { finalizeHandover, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { recordInvoiceAdjustment } from "../src/lib/invoice-adjustments";
import { createAccidentInvoiceDraft, finalizeInvoice } from "../src/lib/invoices";
import { recordInvoicePayment } from "../src/lib/payments";
import { createCancellationDraft, finalizeCounterDocument } from "../src/lib/counter-documents";
import { vehicleStatusProblem } from "../src/lib/bookings";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { DomainError } from "../src/lib/integrity";
import { parseLocalDateTime } from "../src/lib/time";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { answerAll, photo, sign } from "./rental-flow";

const tenants: string[] = [];
after(async () => { await purgeTenants(tenants); await db.$disconnect(); });

const HOUR = 3600_000, DAY = 24 * HOUR;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
let seq = 0;
const nonce = () => `cf-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type AWorld = World & { v2: string };

async function world(label: string): Promise<AWorld> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });
  await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-CF ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, make: "VW", model: "Golf", groupId: w.groupId, fuel: "BENZIN", mileage: 30_000, dailyRate: 59, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 0, tankCapacityLiters: 50, requiredLicenseClass: "B" } });
  return { ...w, v2: v2.id };
}

function caseInput(w: AWorld, over: Partial<CreateAccidentCaseInput> = {}): CreateAccidentCaseInput {
  return {
    nonce: nonce(), customerId: w.customerId, vehicleId: w.v2, startAt: plus(new Date(), HOUR), plannedEndAt: null, dailyRateCents: 7_900, depositCents: 0, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "hb-ab 123", make: "Opel", model: "Astra", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: plus(new Date(), -2 * DAY), place: "Bremen", opponentPlate: "OL-X 99", opponentName: "Gegner GmbH", policeFileNumber: "AZ 4711" },
    insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: null, contactName: "Frau Merk", phone: "0421 999", email: null, street: "Merkweg 1", zip: "28195", city: "Bremen" },
    liability: { status: "REPORTED" },
    tariff: [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1_500 }, { kind: "DELIVERY", perDay: false, unitPriceCents: 4_000 }],
    ...over,
  };
}

/** Vertrag (offenes Ende) unterschreiben und Fahrzeug übergeben – über die bestehenden Prozesse (Fachlogik, nicht der Assistent). */
async function signAndPickup(w: AWorld, bookingId: string) {
  const ww = { ...w, bookingId, vehicleId: w.v2 };
  const contract = await db.rentalContract.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId } });
  const bk = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  await saveConditions(w.tenantId, contract.id, { startAt: bk.startAt, endAt: null, deposit: 0, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 500, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, contract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, contract.id) });
  await finalizeContract(w.tenantId, contract.id);
  const p = await startHandover(w.tenantId, bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 30_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, p.id, cat);
  await answerAll(ww, p.id);
  await sign(ww, p.id);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, contract.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
}

async function doReturn(w: AWorld, bookingId: string) {
  const ww = { ...w, bookingId, vehicleId: w.v2 };
  const r = await startHandover(w.tenantId, bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 30_400, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, r.id, cat);
  await answerAll(ww, r.id);
  await sign(ww, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
}

/** Alle Texte einer operativen Sicht – darin darf nichts Kaufmännisches stehen. */
const dump = (...parts: unknown[]) => JSON.stringify(parts);

// ---------------------------------------------------------------------------
// Ableitungen (rein)
// ---------------------------------------------------------------------------

test("Hauptstatus aus realen Zuständen; Tabs je Rolle; Fälligkeit nach Kalendertag; Mietwert und Mietdauer ab tatsächlicher Übergabe", () => {
  const fin = (o: Partial<{ active: number; billedUntil: Date | null; drafts: number; openCents: number; paidCents: number }>) => ({ active: 0, billedUntil: null, drafts: 0, openCents: 0, paidCents: 0, ...o, economicOpenCents: o.openCents ?? 0 }) as never;
  const st = (caseStatus: string, bookingStatus: string, f: unknown = null, extra: Partial<{ contractSigned: boolean; overdue: boolean; returnedAt: Date | null }> = {}) => caseMainStatus({ caseStatus, bookingStatus, contractSigned: false, overdue: false, fin: f as never, ...extra }).label;
  assert.equal(st("CLOSED", "ACTIVE"), "Abgeschlossen");
  assert.equal(st("OPEN", "RESERVED"), "Übergabe ausstehend");
  assert.equal(st("OPEN", "RESERVED", null, { contractSigned: true }), "Bereit zur Übergabe");
  assert.equal(st("OPEN", "ACTIVE"), "Miete läuft");
  assert.equal(st("OPEN", "ACTIVE", null, { overdue: true }), "Geplantes Mietende überschritten");
  assert.equal(st("OPEN", "ACTIVE", null, { overdue: true, returnStarted: true } as never), "Rückgabe offen");
  assert.equal(st("OPEN", "RETURNED"), "Miete beendet", "ohne Finanzsicht (Hof) nur „Miete beendet“");
  assert.equal(st("OPEN", "RETURNED", fin({})), "Abzurechnen");
  assert.equal(st("OPEN", "RETURNED", fin({ drafts: 1 })), "Rechnung im Entwurf");
  assert.equal(st("OPEN", "RETURNED", fin({ active: 1, openCents: 5_000, paidCents: 0 })), "Rechnung offen");
  assert.equal(st("OPEN", "RETURNED", fin({ active: 1, openCents: 5_000, paidCents: 8_400 })), "Teilbezahlt");
  assert.equal(st("OPEN", "RETURNED", fin({ active: 1, openCents: 0, paidCents: 13_400 })), "Bezahlt");
  assert.equal(st("OPEN", "RETURNED", fin({ active: 1, drafts: 1, openCents: 0, paidCents: 13_400 })), "Rechnung im Entwurf", "offener Entwurf geht „Bezahlt“ vor");
  const ret = new Date("2026-10-04T10:00:00Z");
  assert.equal(st("OPEN", "RETURNED", fin({ active: 1, billedUntil: new Date("2026-10-02T10:00:00Z"), openCents: 0, paidCents: 10_000 }), { returnedAt: ret }), "Schlussrechnung fehlt", "nur Zwischenrechnung abgerechnet");
  assert.equal(st("OPEN", "RETURNED", fin({ active: 1, billedUntil: ret, openCents: 0, paidCents: 10_000 }), { returnedAt: ret }), "Bezahlt");
  assert.equal(st("OPEN", "RETURNED", fin({ active: 0, openCents: 0, paidCents: 0 })), "Abzurechnen", "stornierte Rechnung zählt nicht");
  assert.equal(st("OPEN", "CANCELLED"), "Storniert");

  assert.equal(caseFileAccess("OWNER"), "FULL");
  assert.equal(caseFileAccess("DISPO"), "FULL");
  assert.equal(caseFileAccess("YARD"), "OPERATIONAL");
  assert.deepEqual(caseFileTabs("OPERATIONAL"), ["uebersicht", "miete", "dokumente", "verlauf"]);
  assert.equal(resolveCaseFileTab("abrechnung", "OPERATIONAL"), "uebersicht", "verbotener Tab fällt auf die Übersicht zurück");
  assert.equal(resolveCaseFileTab("schadenfall", "OPERATIONAL"), "uebersicht");
  assert.equal(resolveCaseFileTab("abrechnung", "FULL"), "abrechnung");
  assert.equal(resolveCaseFileTab("<script>", "FULL"), "uebersicht");

  const now = parseLocalDateTime("2026-10-04T12:00")!;
  assert.equal(followUpDue(parseLocalDateTime("2026-10-03T09:00")!, now), "OVERDUE");
  assert.equal(followUpDue(parseLocalDateTime("2026-10-04T23:30")!, now), "TODAY");
  assert.equal(followUpDue(parseLocalDateTime("2026-10-05T00:10")!, now), "LATER");

  const items = [{ perDay: true, unitPriceCents: 1_500, quantityHundredths: 100 }, { perDay: false, unitPriceCents: 4_000, quantityHundredths: 100 }];
  assert.equal(rentValue({ from: null, until: now, dailyRateCents: 7_900, items }), null, "vor der Übergabe kein Mietwert");
  const v = rentValue({ from: parseLocalDateTime("2026-10-01T09:00")!, until: now, dailyRateCents: 7_900, items })!;
  assert.deepEqual(v, { days: 4, perDayCents: 9_400, oneOffCents: 4_000, cents: 4 * 9_400 + 4_000 });
  assert.equal(rentalDuration({ actualPickupAt: null, actualReturnAt: null, status: "RESERVED" }, now), null);
  assert.deepEqual(rentalDuration({ actualPickupAt: parseLocalDateTime("2026-10-01T09:00")!, actualReturnAt: null, status: "ACTIVE" }, now), { days: 4, running: true });
});

// ---------------------------------------------------------------------------
// Fallakte mit echten Daten
// ---------------------------------------------------------------------------

test("Kopf und Übersicht: Kerninformationen, offenes Mietende als „offen“, nächste Schritte für Schadennummer und Haftung, keine Sackgasse zum Vertragsassistenten", async () => {
  const w = await world("cf-head");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  const h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.ok(h);
  assert.equal(h.caseNumber, res.case.caseNumber);
  assert.equal(h.customer.name, "Erika Muster");
  assert.equal(h.vehicle.id, w.v2);
  assert.equal(h.booking.endAt, null);
  assert.equal(h.openEnd, true, "offenes Mietende");
  assert.equal(h.insurer?.name, "MERKVERSICHERUNG-AG");
  assert.equal(h.insurer?.claimNumber, null);
  assert.equal(h.insurer?.liabilityLabel, "Schaden gemeldet");
  assert.equal(h.mainStatus.label, "Übergabe ausstehend");
  const o = await caseFileOverview(w.tenantId, h, "FULL");
  const codes = o.steps.map((s) => s.code);
  assert.ok(codes.includes("CLAIM_NUMBER_MISSING"), "fehlende Schadennummer erzeugt einen Schritt");
  assert.ok(codes.includes("LIABILITY_OPEN"), "ungeklärte Haftung erzeugt einen Schritt");
  const contract = o.steps.find((s) => s.code === "CONTRACT")!;
  // Phase E: der Unfallersatz-Vertrag wird im Vertragsassistenten abgeschlossen – der Schritt führt dorthin (keine Sackgasse)
  assert.equal(contract?.href, `/buchungen/${res.bookingId}/vertrag`);
  assert.ok(!/freigeschaltet/.test(contract.text));
  assert.equal(o.duration, null);
  assert.equal(o.rentValue, null, "vor der Übergabe kein erfundener Mietwert");
  // Schadennummer ergänzt, Haftung bestätigt → beide Schritte verschwinden
  await updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-1", contactName: "Frau Merk", phone: "0421 999", street: "Merkweg 1", zip: "28195", city: "Bremen" }, liability: { status: "CONFIRMED" } });
  const o2 = await caseFileOverview(w.tenantId, (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!, "FULL");
  assert.ok(!o2.steps.some((s) => s.code === "CLAIM_NUMBER_MISSING" || s.code === "LIABILITY_OPEN"));
});

test("Laufende Miete mit offenem Ende: Mietwert nach Tarif (Tagessatz + Tagespositionen + Einmalpositionen) bis jetzt, Schritt „Mietende offen“", async () => {
  const w = await world("cf-open");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  await signAndPickup(w, res.bookingId);
  // Übergabe vor drei Tagen (wie eine laufende Miete)
  // (2 Std. Abstand zur Tagesgrenze: auch über eine Zeitumstellung hinweg bleiben es 3 Miettage)
  await db.booking.update({ where: { id: res.bookingId }, data: { actualPickupAt: new Date(Date.now() - 3 * DAY + 2 * HOUR) } });
  const h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h.mainStatus.label, "Miete läuft");
  const o = await caseFileOverview(w.tenantId, h, "FULL");
  assert.deepEqual(o.duration, { days: 3, running: true });
  assert.equal(o.rentValue?.cents, 3 * (7_900 + 1_500) + 4_000, "3 Miettage × 94 € + Zustellung 40 €");
  assert.ok(o.steps.some((s) => s.code === "OPEN_END"));
  const r = await caseFileRental(w.tenantId, h, "FULL");
  assert.equal(r.tariff?.soFar?.cents, 3 * 9_400 + 4_000);
  assert.equal(r.tariff?.planned, null, "offenes Ende: kein Planwert");
  assert.equal(r.pickup.kind, "VIEW");
  assert.equal(r.ret.kind, "START", "Rückgabe startbar");
});

test("Mietdauer aktualisieren: setzen, Konflikt mit Folgebuchung abgewiesen, offenes Ende vor Folgebuchung abgewiesen, Event und Audit, keine neue Buchung", async () => {
  const w = await world("cf-end");
  const start = plus(new Date(), HOUR);
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: start, plannedEndAt: plus(start, 3 * DAY) }));
  // Folgebuchung auf demselben Fahrzeug ab Tag 6
  const follow = await db.booking.create({ data: { tenantId: w.tenantId, number: `F-${seq++}-${Date.now()}`, vehicleId: w.v2, customerId: w.customerId, startAt: plus(start, 6 * DAY), endAt: plus(start, 8 * DAY), dailyRate: 59, deposit: 0 } });
  const bookingsBefore = await db.booking.count({ where: { tenantId: w.tenantId } });
  const r1 = await updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(start, 5 * DAY), reason: "Reparatur dauert länger" });
  assert.equal(r1.after?.getTime(), plus(start, 5 * DAY).getTime());
  await assert.rejects(() => updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(start, 7 * DAY), reason: "noch länger" }), (e: unknown) => e instanceof DomainError && e.message.includes(follow.number));
  await assert.rejects(() => updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: null, reason: "Ende unbekannt" }), (e: unknown) => e instanceof DomainError && /vorgesehen/.test(e.message));
  assert.equal(await db.booking.count({ where: { tenantId: w.tenantId } }), bookingsBefore, "keine neue Buchung");
  assert.equal(await db.contractAmendment.count({ where: { tenantId: w.tenantId } }), 0, "kein Nachtrag");
  // Vorschau prüft den Fahrzeugstatus wie das Speichern (sonst „frei“ in der Vorschau, Fehler beim Speichern)
  await db.vehicle.update({ where: { id: w.v2 }, data: { status: "WORKSHOP" } });
  const pv = await previewPlannedEnd(w.tenantId, res.case.id, plus(start, 4 * DAY));
  assert.equal(pv.conflict, vehicleStatusProblem("WORKSHOP"));
  await db.vehicle.update({ where: { id: w.v2 }, data: { status: "AVAILABLE" } });
  const ev = await db.accidentReplacementCaseEvent.findMany({ where: { caseId: res.case.id, type: "PLANNED_END_CHANGED" } });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].reason, "Reparatur dauert länger");
  const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, action: "ACCIDENT_CASE_PLANNED_END_CHANGED" } });
  assert.equal((audit.details as { reason: string }).reason, "Reparatur dauert länger");
  const hist = await caseFileHistory(w.tenantId, res.case.id, "FULL");
  assert.ok(hist.some((e) => e.label === "Geplantes Mietende geändert" && e.reason === "Reparatur dauert länger"));
});

test("Schadenfall bearbeiten: Kopie im Fall ändert das Adressbuch nicht – nur auf ausdrücklichen Wunsch; unveränderte Angaben ohne Verlaufseintrag", async () => {
  const w = await world("cf-partner");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  const partner = await db.businessPartner.findFirstOrThrow({ where: { tenantId: w.tenantId, kind: "INSURER" } });
  const before = { phone: partner.phone, contactName: partner.contactName, useCount: partner.useCount };
  const ins = { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-77", contactName: "Herr Neu", phone: "0170 1111", street: "Merkweg 1", zip: "28195", city: "Bremen" };
  await updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: ins });
  const c1 = await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: res.case.id } });
  assert.deepEqual([c1.insurerContactName, c1.insurerPhone, c1.insurerClaimNumber], ["Herr Neu", "0170 1111", "SN-77"], "Fall-Kopie geändert");
  const p1 = await db.businessPartner.findUniqueOrThrow({ where: { id: partner.id } });
  assert.deepEqual({ phone: p1.phone, contactName: p1.contactName, useCount: p1.useCount }, before, "Adressbuch unverändert");
  // Werkstatt neu im Fall: kein Adressbucheintrag ohne Wunsch
  await updateWorkshop(w.tenantId, res.case.id, w.actor, { name: "Autohaus Test", phone: "0421 1" });
  assert.equal(await db.businessPartner.count({ where: { tenantId: w.tenantId, kind: "WORKSHOP" } }), 0);
  // bewusst ins Adressbuch übernehmen
  await updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: ins, addressBook: true });
  const p2 = await db.businessPartner.findUniqueOrThrow({ where: { id: partner.id } });
  assert.deepEqual([p2.contactName, p2.phone], ["Herr Neu", "0170 1111"], "nur auf Wunsch aktualisiert");
  await updateWorkshop(w.tenantId, res.case.id, w.actor, { name: "Autohaus Test", phone: "0421 1" }, { addressBook: true });
  assert.equal(await db.businessPartner.count({ where: { tenantId: w.tenantId, kind: "WORKSHOP" } }), 1);
  assert.equal(await db.businessPartner.count({ where: { tenantId: w.tenantId, kind: "LAWYER" } }), 0, "nur die gewählte Art wird gelernt");
  // unverändert speichern: kein weiterer Verlaufseintrag
  const evBefore = await db.accidentReplacementCaseEvent.count({ where: { caseId: res.case.id } });
  const c2 = await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: res.case.id } });
  await updateDamagedVehicle(w.tenantId, res.case.id, w.actor, { plate: c2.damagedPlate, make: c2.damagedMake, model: c2.damagedModel, drivable: c2.damagedDrivable, firstRegistration: c2.damagedFirstRegistration, vehicleClass: c2.damagedVehicleClass, location: c2.damagedLocation, damageKind: c2.damageKind });
  await updateAccident(w.tenantId, res.case.id, w.actor, { accidentAt: c2.accidentAt, place: c2.accidentPlace, opponentPlate: c2.opponentPlate, opponentName: c2.opponentName, policeFileNumber: c2.policeFileNumber, note: c2.accidentNote });
  await updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: ins });
  assert.equal(await db.accidentReplacementCaseEvent.count({ where: { caseId: res.case.id } }), evBefore, "keine Leer-Einträge");
  // nur „ins Adressbuch übernehmen“ ohne Änderung am Fall: Adressbuch aktualisiert, aber kein Eintrag „Versicherung geändert“
  await db.businessPartner.update({ where: { id: partner.id }, data: { phone: "alt" } });
  await updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: ins, addressBook: true });
  assert.equal((await db.businessPartner.findUniqueOrThrow({ where: { id: partner.id } })).phone, "0170 1111");
  assert.equal(await db.accidentReplacementCaseEvent.count({ where: { caseId: res.case.id } }), evBefore, "kein Schein-Eintrag bei reiner Adressbuch-Übernahme");
  // Bearbeitungsansicht liefert die Kopie und das Adressbuch zur Auswahl
  const dmg = await caseFileDamage(w.tenantId, res.case.id);
  assert.equal(dmg.case.insurerClaimNumber, "SN-77");
  assert.ok(dmg.partners.insurers.some((p) => p.name === "MERKVERSICHERUNG-AG"));
});

test("Wiedervorlagen: anlegen, überfällig/heute erkannt, erledigen, verwerfen nur mit Grund, nur zum eigenen Fall", async () => {
  const w = await world("cf-follow");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  const other = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: w.vehicleId, startAt: plus(new Date(), 30 * DAY), plannedEndAt: plus(new Date(), 32 * DAY) }));
  const f1 = await createFollowUp(w.tenantId, res.case.id, w.actor, { title: "Schadennummer nachfragen", dueAt: new Date(), assigneeUserId: w.userId, note: "bei Frau Merk" });
  const f2 = await createFollowUp(w.tenantId, res.case.id, w.actor, { title: "Gutachten anfordern", dueAt: plus(new Date(), 5 * DAY) });
  // überfällig (Datenbank erlaubt die Fälligkeit in der Vergangenheit – die Aktion verhindert sie nur bei der Anlage)
  await db.caseFollowUp.update({ where: { id: f2.id }, data: { dueAt: plus(new Date(), -2 * DAY) } });
  const h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  const o = await caseFileOverview(w.tenantId, h, "FULL");
  const due = Object.fromEntries(o.followUps.map((f) => [f.title, f.due]));
  assert.equal(due["Schadennummer nachfragen"], "TODAY");
  assert.equal(due["Gutachten anfordern"], "OVERDUE");
  assert.ok(o.steps.some((s) => s.code === "FOLLOW_UP_OVERDUE"));
  assert.ok(o.steps.some((s) => s.code === "FOLLOW_UP_TODAY"));
  assert.equal(o.followUps.find((f) => f.id === f1.id)?.assigneeName, "Test Mitarbeiter");
  // fremder Fall: dieselbe Wiedervorlage über einen anderen Fall nicht erledigbar
  await assert.rejects(() => completeFollowUp(w.tenantId, f1.id, w.actor, null, { caseId: other.case.id }), /nicht gefunden/);
  await completeFollowUp(w.tenantId, f1.id, w.actor, "Schadennummer SN-1 erhalten", { caseId: res.case.id });
  await assert.rejects(() => cancelFollowUp(w.tenantId, f2.id, w.actor, "", { caseId: res.case.id }), /Grund/);
  await cancelFollowUp(w.tenantId, f2.id, w.actor, "Gutachten liegt schon vor", { caseId: res.case.id });
  const o2 = await caseFileOverview(w.tenantId, (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!, "FULL");
  assert.equal(o2.followUps.filter((f) => f.status === "OPEN").length, 0);
  assert.ok(!o2.steps.some((s) => s.code.startsWith("FOLLOW_UP")));
  const hist = (await caseFileHistory(w.tenantId, res.case.id, "FULL")).map((e) => e.label);
  for (const l of ["Wiedervorlage angelegt", "Wiedervorlage erledigt", "Wiedervorlage verworfen"]) assert.ok(hist.includes(l), l);
});

test("Fall abschließen: Warnungen aus realen Daten, Abschluss trotz Warnungen nur bewusst und protokolliert; geschlossene Akte nicht bearbeitbar", async () => {
  const w = await world("cf-close");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  const f = await createFollowUp(w.tenantId, res.case.id, w.actor, { title: "Rückruf", dueAt: plus(new Date(), DAY) });
  const h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  const o = await caseFileOverview(w.tenantId, h, "FULL");
  const codes = o.closeWarnings.map((x) => x.code);
  for (const c of ["RENTAL_RUNNING", "NO_RETURN", "FOLLOW_UPS", "LIABILITY_OPEN"]) assert.ok(codes.includes(c), `Warnung ${c}`);
  await assert.rejects(() => closeCase(w.tenantId, res.case.id, w.actor, { reason: "fertig" }), /bewusst bestätigen/);
  await closeCase(w.tenantId, res.case.id, w.actor, { reason: "Kunde hat zurückgezogen", acknowledgeWarnings: true });
  const closedEvent = await db.accidentReplacementCaseEvent.findFirstOrThrow({ where: { caseId: res.case.id, type: "CLOSED" } });
  assert.equal(closedEvent.reason, "Kunde hat zurückgezogen");
  assert.match(closedEvent.note ?? "", /Trotz offener Punkte/);
  assert.ok(!/[A-Z]{4,}_[A-Z]/.test(closedEvent.note ?? ""), "keine technischen Codes in der Notiz");
  assert.ok((await caseFileHistory(w.tenantId, res.case.id, "FULL")).some((e) => e.label === "Fall abgeschlossen" && /Die Buchung ist noch reserviert/.test(e.note ?? "")), "offene Punkte im Verlauf als Klartext");
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "ACCIDENT_CASE_CLOSED" } }), 1);
  const hc = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(hc.status, "CLOSED");
  assert.equal(hc.mainStatus.label, "Abgeschlossen");
  assert.equal(hc.closeReason, "Kunde hat zurückgezogen");
  const rc = await caseFileRental(w.tenantId, hc, "FULL");
  assert.equal(rc.canChangeEnd, false, "keine Mietdauer-Aktion bei geschlossener Akte");
  assert.equal((await caseFileOverview(w.tenantId, hc, "FULL")).closeWarnings.length, 0);
  // jede Bearbeitung scheitert serverseitig mit verständlicher Meldung
  const closedMsg = /abgeschlossen/;
  await assert.rejects(() => updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: { name: "X Versicherung" } }), closedMsg);
  await assert.rejects(() => updateDamagedVehicle(w.tenantId, res.case.id, w.actor, { plate: "HB-X 1", make: "VW", model: "Polo", drivable: true, damageKind: "REPAIR" }), closedMsg);
  await assert.rejects(() => updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(new Date(), 4 * DAY), reason: "Test" }), closedMsg);
  await assert.rejects(() => createFollowUp(w.tenantId, res.case.id, w.actor, { title: "neu", dueAt: plus(new Date(), DAY) }), closedMsg);
  await assert.rejects(() => completeFollowUp(w.tenantId, f.id, w.actor, null, { caseId: res.case.id }), closedMsg, "offene Wiedervorlage einer geschlossenen Akte nicht mehr erledigbar");
  await assert.rejects(() => cancelFollowUp(w.tenantId, f.id, w.actor, "egal", { caseId: res.case.id }), closedMsg);
});

test("Abrechnung: Rechnung an die Versicherung mit Teilzahlung – offener Betrag korrekt, dokumentierte Kürzung mindert ihn nicht; Status „Teilbezahlt“", async () => {
  const w = await world("cf-bill");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  await signAndPickup(w, res.bookingId);
  await doReturn(w, res.bookingId);
  await updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-9", street: "Merkweg 1", zip: "28195", city: "Bremen" }, liability: { status: "CONFIRMED" } });
  let h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h.mainStatus.label, "Abzurechnen");
  assert.equal((await caseFileBilling(w.tenantId, h)).invoices.length, 0, "noch keine Rechnung");
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "INSURER", nonce: nonce() });
  h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h.mainStatus.label, "Rechnung im Entwurf");
  const draftBill = await caseFileBilling(w.tenantId, h);
  assert.equal(draftBill.drafts.length, 1);
  assert.equal(draftBill.drafts[0].roleLabel, "Versicherung");
  await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: invoice.id, amount: "84,00", method: "BANK_TRANSFER", paidAt: new Date(), reference: "MERK 1" });
  await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: invoice.id, reasonKind: "TARIFF", amountCents: 3_000, decidedAt: new Date(), note: "Tagessatz gekürzt" });
  h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  const bill = await caseFileBilling(w.tenantId, h);
  assert.equal(bill.invoices.length, 1);
  const i = bill.invoices[0];
  assert.equal(i.roleLabel, "Versicherung");
  assert.ok(i.number && i.number.length > 0);
  assert.equal(i.grossCents, 13_400, "1 Tag × 79 + Haftungsreduzierung 15 + Zustellung 40");
  assert.equal(i.paidCents, 8_400);
  assert.equal(i.openCents, 5_000, "Kürzung mindert die offene Forderung nicht");
  assert.equal(i.reducedCents, 3_000);
  assert.equal(i.payments.length, 1);
  assert.equal(i.adjustments.length, 1);
  assert.equal(i.paymentStatusLabel, "Teilbezahlt");
  assert.equal(h.mainStatus.label, "Teilbezahlt");
  const o = await caseFileOverview(w.tenantId, h, "FULL");
  assert.ok(o.steps.some((s) => s.code === "PARTIALLY_PAID"));
  const hist = (await caseFileHistory(w.tenantId, res.case.id, "FULL")).map((e) => `${e.label}|${e.to ?? ""}`);
  assert.ok(hist.includes("Rechnung erstellt|Versicherung"), "Empfängerrolle in Klartext");
  assert.ok(hist.includes("Kürzung dokumentiert|Tarifhöhe"));
  assert.ok(hist.some((e) => e.startsWith("Fahrzeug übergeben")) && hist.some((e) => e.startsWith("Fahrzeug zurückgegeben")));
});

test("Hof (YARD) und Supportmodus: operative Sicht ohne Versicherung, Schadennummer, Haftung, Tarif, Beträge, Wiedervorlagen oder Fall-Dokumente; Mandantentrennung", async () => {
  const w = await world("cf-yard");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { tariff: [{ kind: "OTHER", label: "GEHEIMPOSITION", perDay: true, unitPriceCents: 4_321 }] }));
  await updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-GEHEIM-123", contactName: "Frau Merk" }, liability: { status: "QUOTA", quotaPercent: 70 } });
  await createFollowUp(w.tenantId, res.case.id, w.actor, { title: "GEHEIMWIEDERVORLAGE", dueAt: plus(new Date(), DAY) });
  await updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(new Date(), 4 * DAY), reason: "GEHEIMGRUND Versicherung" });
  await db.accidentReplacementCaseDocument.create({ data: { tenantId: w.tenantId, caseId: res.case.id, type: "INSURER_LETTER", fileName: "GEHEIMBRIEF.pdf", storageKey: `t/${nonce()}`, contentType: "application/pdf", sizeBytes: 10, checksum: "x" } });
  const h = (await caseFileHeader(w.tenantId, res.case.id, "OPERATIONAL"))!;
  assert.equal(h.insurer, null);
  assert.equal(h.fin, null);
  assert.equal(h.closeReason, null);
  const o = await caseFileOverview(w.tenantId, h, "OPERATIONAL");
  const r = await caseFileRental(w.tenantId, h, "OPERATIONAL");
  const d = await caseFileDocuments(w.tenantId, h, "OPERATIONAL");
  const hist = await caseFileHistory(w.tenantId, res.case.id, "OPERATIONAL");
  assert.equal(r.tariff, null);
  assert.equal(r.canChangeEnd, false);
  assert.equal(o.rentValue, null);
  assert.deepEqual(o.followUps, []);
  assert.deepEqual(d.caseDocuments, []);
  assert.ok(o.steps.every((s) => ["CONTRACT", "PICKUP", "OPEN_END", "OVERDUE", "RETURN_DUE", "RETURN_DRAFT", "CLOSED", "CANCELLED"].includes(s.code)));
  assert.ok(hist.length >= 2 && hist.every((e) => ["Fall angelegt", "Geplantes Mietende geändert", "Fahrzeug übergeben", "Fahrzeug zurückgegeben", "Fall abgeschlossen", "Fall wieder geöffnet"].includes(e.label)));
  const all = dump(h, o, r, d, hist);
  for (const secret of ["MERKVERSICHERUNG", "SN-GEHEIM", "Frau Merk", "GEHEIMPOSITION", "4321", "GEHEIMWIEDERVORLAGE", "GEHEIMGRUND", "GEHEIMBRIEF", "Haftungsquote", "Gegner GmbH", "AZ 4711", "7900"]) {
    assert.ok(!all.includes(secret), `operative Sicht enthält „${secret}“`);
  }
  // Vollsicht hat alles
  const full = dump(await caseFileHeader(w.tenantId, res.case.id, "FULL"), await caseFileHistory(w.tenantId, res.case.id, "FULL"));
  assert.ok(full.includes("SN-GEHEIM-123") && full.includes("GEHEIMGRUND"));
  // Mandantentrennung: Mandant B findet den Fall nicht
  const b = await world("cf-yard-b");
  assert.equal(await caseFileHeader(b.tenantId, res.case.id, "FULL"), null);
  assert.equal(await caseFileHeader(b.tenantId, res.case.id, "OPERATIONAL"), null);
  await assert.rejects(() => caseFileDamage(b.tenantId, res.case.id));
  await assert.rejects(() => updatePlannedEnd(b.tenantId, res.case.id, b.actor, { plannedEndAt: null, reason: "fremd" }), /nicht gefunden/);
  await assert.rejects(() => createFollowUp(b.tenantId, res.case.id, b.actor, { title: "fremd", dueAt: plus(new Date(), DAY) }), /nicht gefunden/);
});

test("Stornierte Rechnung zählt nicht als Abrechnung; nur Zwischenrechnung vor der Rückgabe → „Schlussrechnung fehlt“", async () => {
  const w = await world("cf-storno");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  await signAndPickup(w, res.bookingId);
  await db.booking.update({ where: { id: res.bookingId }, data: { actualPickupAt: new Date(Date.now() - 3 * DAY) } });
  await updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-5", street: "Merkweg 1", zip: "28195", city: "Bremen" }, liability: { status: "CONFIRMED" } });
  // Zwischenrechnung bis vor einer Stunde, danach Rückgabe
  const { invoice: interim } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "INSURER", periodEnd: new Date(Date.now() - HOUR), nonce: nonce() });
  await finalizeInvoice(w.tenantId, interim.id, w.actor);
  await doReturn(w, res.bookingId);
  let h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h.mainStatus.label, "Schlussrechnung fehlt");
  let o = await caseFileOverview(w.tenantId, h, "FULL");
  assert.ok(o.steps.some((s) => s.code === "FINAL_INVOICE_MISSING"));
  assert.ok((await closeWarnings(w.tenantId, res.case.id)).some((x) => x.code === "FINAL_INVOICE_MISSING"));
  // Zwischenrechnung stornieren: keine wirksame Rechnung mehr – nicht „Bezahlt“, sondern „Abzurechnen“
  const st = await createCancellationDraft(w.tenantId, interim.id, w.actor);
  await finalizeCounterDocument(w.tenantId, st.id, w.actor, { confirmed: true, reason: "falscher Leistungszeitraum" });
  h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h.fin?.active, 0);
  assert.equal(h.mainStatus.label, "Abzurechnen", "stornierte Rechnung gilt nicht als abgerechnet oder bezahlt");
  o = await caseFileOverview(w.tenantId, h, "FULL");
  assert.ok(o.steps.some((s) => s.code === "INVOICE_MISSING" && /storniert/.test(s.text)));
  assert.ok(!o.steps.some((s) => s.code === "INVOICE_OPEN" || s.code === "PARTIALLY_PAID"));
  assert.ok((await closeWarnings(w.tenantId, res.case.id)).some((x) => x.code === "NO_INVOICE"));
  const bill = await caseFileBilling(w.tenantId, h);
  assert.equal(bill.invoices.length, 1, "stornierte Rechnung bleibt in der Abrechnung sichtbar");
  assert.equal(bill.invoices[0].neutralized, true);
  assert.equal(bill.invoices[0].chain, "CANCELLED");
});
