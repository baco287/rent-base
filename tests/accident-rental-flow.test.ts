// Befehl 29 Phase E: Unfallersatz-Vertrag mit offenem Mietende, Übergabe, laufende Miete, Rückgabe – über die bestehenden
// Prozesse (Vertragslogik, Übergabe-/Rückgabeprotokoll), keine zweite Engine. Geprüft werden u. a.: Vertrag ohne Ende und ohne
// erfundenen Gesamtpreis, eingefrorener Tarif, kein Kundenrabatt, Kaution 0, Unterschrift, Übergabe nur nach Unterschrift,
// Fahrzeug bleibt belegt, keine Überfälligkeit wegen NULL, tatsächliche Mietdauer als Grundlage für Miettage, Tagespositionen und
// Freikilometer, keine Nachträge/Verspätungsgebühren, geschlossener Fall sperrt Vertrag/Übergabe/Rückgabe/Storno/Nachtrag,
// Wiederöffnen, Dokumente in der Fallakte, Standardmiete unverändert, Mandantentrennung, Tagesgrenzen (inkl. Zeitumstellung).
// HTTP und Rollen: tests/smoke-pages.mts.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { closeCase, createAccidentCase, reopenCase, setTariff, updateInsurer, updatePlannedEnd, type CreateAccidentCaseInput } from "../src/lib/accident-replacement";
import { accidentTariffsFor, caseFileDocuments, caseFileHeader, caseFileOverview, caseFileRental, caseTariff, contractStep } from "../src/lib/accident-case-file";
import { accidentRentState, contractTariffItems, rentValue, type RentState } from "../src/lib/accident-pricing";
import { ACCIDENT_CASE_CLOSED_MESSAGE } from "../src/lib/accident-replacement-events";
import { createAmendmentDraft, discardAmendment, signAmendment, updateAmendmentDraft } from "../src/lib/amendments";
import { confirmVerification, recordDriverDocumentCopy, startOrGetVerification } from "../src/lib/driver-verification";
import { findConflicts, isOverdue } from "../src/lib/bookings";
import { changeBookingStatus } from "../src/lib/booking-status";
import { cancelBooking, cancellationOverview } from "../src/lib/cancellation";
import { buildContractDocument } from "../src/lib/contract-view";
import { adoptContractDefaults, ensureContractDraft, finalizeContract, getContractContentHash, getContractState, saveConditions, saveContractSignature, verifyContract } from "../src/lib/contracts";
import { mileagePeriod } from "../src/lib/extra-charges";
import { runContractFollowUp, runPickupFollowUp, runReturnFollowUp } from "../src/lib/followup";
import { discardEmptyReturnDraft, finalizeHandover, getHandoverState, registerPhoto, saveHandoverSignature, getHandoverContentHash, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { authorizeKeyDrop, cancelKeyDrop, sendKeyDropLink } from "../src/lib/key-drop";
import { confirmProposal, dismissProposal, getReturnComparison, removeCharge } from "../src/lib/returns";
import { createAccidentInvoiceDraft } from "../src/lib/invoices";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { DomainError, sha256 } from "../src/lib/integrity";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { rentalDays } from "../src/lib/pricing";
import { buildStorageKey, getStorage, type StorageDriver } from "../src/lib/storage";
import { parseLocalDateTime } from "../src/lib/time";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { answerAll, photo, pickedUpWorld, returnedWorld, sign } from "./rental-flow";
import { photoJpeg, signaturePng } from "./pdf-fixtures";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-ue-e-"));
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
  async send(m: MailMessage) { this.sent.push(m); return { messageId: `<fake-${this.sent.length}@test>` }; }
}

const HOUR = 3600_000, DAY = 24 * HOUR;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
let seq = 0;
const nonce = () => `ue-e-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
/** Intl setzt ein geschütztes Leerzeichen vor „€“ – für Vergleiche normalisieren. */
const sp = (s: string) => s.replace(/\u00a0/g, " ");
/** Mietwert eines Stands (null vor der Übergabe). */
const valueOf = (s: RentState) => (s.phase === "NONE" ? null : s.value);
const CLOSED = /Der Unfallersatzfall ist abgeschlossen und kann nicht mehr bearbeitet werden\./;

type AWorld = World & { v2: string };

async function world(label: string): Promise<AWorld> {
  await ready;
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH", keyDropEnabled: true } });
  await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  // Fahrzeug mit Kautionsvorgabe 500 € – der Unfallersatz-Fall legt 0 € fest, und das muss so bleiben
  const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UE ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, make: "VW", model: "Golf", groupId: w.groupId, fuel: "BENZIN", mileage: 30_000, dailyRate: 59, kmIncludedPerDay: 100, extraKmRate: 0.4, deposit: 500, tankCapacityLiters: 50, requiredLicenseClass: "B" } });
  return { ...w, v2: v2.id };
}

function caseInput(w: AWorld, over: Partial<CreateAccidentCaseInput> = {}): CreateAccidentCaseInput {
  return {
    nonce: nonce(), customerId: w.customerId, vehicleId: w.v2, startAt: plus(new Date(), HOUR), plannedEndAt: null, dailyRateCents: 7_900, depositCents: 0, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "hb-ab 123", make: "Opel", model: "Astra", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: plus(new Date(), -2 * DAY), place: "Bremen" },
    insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-77", contactName: null, phone: null, email: null, street: "Merkweg 1", zip: "28195", city: "Bremen" },
    liability: { status: "CONFIRMED" },
    tariff: [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1_500 }, { kind: "DELIVERY", perDay: false, unitPriceCents: 4_000 }, { kind: "PICKUP", perDay: false, unitPriceCents: 2_000, quantityHundredths: 200 }],
    ...over,
  };
}

const contractOf = (w: AWorld, bookingId: string) => db.rentalContract.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId }, include: { drivers: true } });
const docOf = async (w: AWorld, bookingId: string) => {
  const c = await contractOf(w, bookingId);
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } });
  return buildContractDocument(c, tenant, []);
};

/** Konditionen wie Schritt 4 beim Unfallersatz: Beginn aus der Buchung, Ende offen, kein abweichender Gesamtpreis. */
async function conditions(w: AWorld, bookingId: string, over: Partial<Parameters<typeof saveConditions>[2]> = {}) {
  const c = await contractOf(w, bookingId);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  return saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: null, deposit: 0, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 500, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof", ...over }, w.actor);
}
async function signContract(w: AWorld, bookingId: string) {
  const c = await contractOf(w, bookingId);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  return finalizeContract(w.tenantId, c.id);
}
/** Übergabe über das bestehende Protokoll (Kilometer, Tank, Pflichtfotos, Checkliste, Fahrerprüfung, Unterschrift). */
async function pickup(w: AWorld, bookingId: string, mileage = 30_100) {
  const ww = { ...w, bookingId, vehicleId: w.v2 };
  const c = await contractOf(w, bookingId);
  const p = await startHandover(w.tenantId, bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, p.id, cat);
  await answerAll(ww, p.id);
  await sign(ww, p.id);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  return finalizeHandover(w.tenantId, p.id, w.actor);
}
async function startReturn(w: AWorld, bookingId: string, mileage = 30_400) {
  const ww = { ...w, bookingId, vehicleId: w.v2 };
  const r = await startHandover(w.tenantId, bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, r.id, cat);
  await answerAll(ww, r.id);
  return r;
}
async function finishReturn(w: AWorld, bookingId: string, returnId: string) {
  await sign({ ...w, bookingId, vehicleId: w.v2 }, returnId);
  return finalizeHandover(w.tenantId, returnId, w.actor);
}
/** Übergabezeitpunkt zurückdatieren (simuliert eine Miete, die schon läuft) – nur Testdaten, keine Fachfunktion. */
const backdatePickup = (bookingId: string, at: Date) => db.booking.update({ where: { id: bookingId }, data: { actualPickupAt: at } });

/** Fall anlegen, Konditionen, Unterschrift – bereit zur Übergabe. */
async function signedCase(w: AWorld, over: Partial<CreateAccidentCaseInput> = {}) {
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, over));
  assert.equal(res.contractError, null);
  await conditions(w, res.bookingId);
  await signContract(w, res.bookingId);
  return res;
}

// ---------------------------------------------------------------------------
// Tagesgrenzen und reine Ableitungen
// ---------------------------------------------------------------------------

test("Tagesgrenzen: gleicher Tag, genau 24 h, 24 h + 1 min, mehrere Tage, Zeitumstellung – Mietwert und Freikilometer zählen gleich", () => {
  const t = (s: string) => parseLocalDateTime(s)!;
  assert.equal(rentalDays(t("2026-10-05T08:00"), t("2026-10-05T20:00")), 1, "Rückgabe am selben Tag = 1 Miettag");
  assert.equal(rentalDays(t("2026-10-05T10:00"), t("2026-10-06T10:00")), 1, "genau 24 Stunden = 1 Miettag");
  assert.equal(rentalDays(t("2026-10-05T10:00"), t("2026-10-06T10:01")), 2, "24 Stunden + 1 Minute = 2 Miettage");
  assert.equal(rentalDays(t("2026-10-05T10:00"), t("2026-10-08T09:00")), 3);
  assert.equal(rentalDays(t("2026-10-05T10:00"), t("2026-10-08T10:00")), 3);
  assert.equal(rentalDays(t("2026-10-05T10:00"), t("2026-10-08T10:01")), 4);
  // Zeitumstellung Herbst (25.10.2026, 03:00 → 02:00): 25 echte Stunden sind auf der Wanduhr 24 Stunden
  assert.equal(rentalDays(t("2026-10-24T10:00"), t("2026-10-25T10:00")), 1, "Herbst: 25 h echte Zeit = 1 Miettag (Wanduhr)");
  assert.equal(rentalDays(t("2026-10-24T10:00"), t("2026-10-25T10:01")), 2);
  assert.equal(rentalDays(t("2026-10-24T10:00"), t("2026-10-26T10:00")), 2);
  // Zeitumstellung Frühjahr (28.03.2027): 23 echte Stunden sind 24 Stunden Wanduhr
  assert.equal(rentalDays(t("2027-03-27T10:00"), t("2027-03-28T10:00")), 1, "Frühjahr: 23 h echte Zeit = 1 Miettag");
  assert.equal(rentalDays(t("2027-03-27T10:00"), t("2027-03-28T10:01")), 2);

  // Mietwert (Fallakte, Buchung, Rechnung) und Freikilometer (Rückgabe) nutzen dieselben Miettage ab der Übergabe
  const items = [{ perDay: true, unitPriceCents: 1_500, quantityHundredths: 100 }, { perDay: false, unitPriceCents: 4_000, quantityHundredths: 100 }];
  for (const [from, until, days] of [["2026-10-05T08:00", "2026-10-05T20:00", 1], ["2026-10-05T10:00", "2026-10-06T10:00", 1], ["2026-10-05T10:00", "2026-10-06T10:01", 2], ["2026-10-24T10:00", "2026-10-25T10:00", 1], ["2026-10-05T10:00", "2026-10-12T09:59", 7]] as const) {
    const v = rentValue({ from: t(from), until: t(until), dailyRateCents: 7_900, items })!;
    assert.equal(v.days, days, `${from} → ${until}`);
    assert.equal(v.cents, days * 9_400 + 4_000);
    const km = mileagePeriod({ startAt: t("2026-10-05T07:00"), endAt: null }, t(from), t(until));
    assert.equal(rentalDays(km.start, km.end), days, "Freikilometer-Tage = Miettage ab Übergabe (nicht ab geplantem Beginn)");
  }
  // Standardmiete: Freikilometer weiter nach Vertragszeitraum
  const std = mileagePeriod({ startAt: t("2026-10-05T10:00"), endAt: t("2026-10-08T10:00") }, t("2026-10-05T11:30"), t("2026-10-09T18:00"));
  assert.deepEqual(std, { start: t("2026-10-05T10:00"), end: t("2026-10-08T10:00") });

  // Mietwert-Stand: vor Übergabe keiner, laufend bis jetzt, nach Rückgabe Endwert
  const tariff = { dailyRateCents: 7_900, items };
  assert.deepEqual(accidentRentState({ status: "RESERVED", actualPickupAt: null, actualReturnAt: null }, tariff), { phase: "NONE" });
  const running = accidentRentState({ status: "ACTIVE", actualPickupAt: t("2026-10-05T10:00"), actualReturnAt: null }, tariff, t("2026-10-07T09:00"));
  assert.equal(running.phase, "RUNNING");
  assert.equal(valueOf(running)?.days, 2);
  const final = accidentRentState({ status: "RETURNED", actualPickupAt: t("2026-10-05T10:00"), actualReturnAt: t("2026-10-08T10:30") }, tariff, t("2026-11-01T00:00"));
  assert.equal(final.phase, "FINAL");
  assert.equal(valueOf(final)?.cents, 4 * 9_400 + 4_000, "Endwert hängt nicht vom Abfragezeitpunkt ab");
  assert.deepEqual(accidentRentState({ status: "CANCELLED", actualPickupAt: null, actualReturnAt: null }, tariff), { phase: "NONE" });
});

// ---------------------------------------------------------------------------
// Vertrag
// ---------------------------------------------------------------------------

test("1/3/4/5/6: Unfallersatz-Vertrag mit offenem Ende – kein Ersatzdatum, kein falscher Gesamtpreis, kein Rabatt, Kaution 0 bleibt 0, Tarif im Vertrag", async () => {
  const w = await world("ue-e-vertrag");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { plannedEndAt: plus(new Date(), 5 * DAY) }));
  assert.equal(Number((await contractOf(w, res.bookingId)).deposit), 0, "Vertragsentwurf übernimmt Kaution 0 aus dem Fall (nicht die Fahrzeugvorgabe 500 €)");
  await conditions(w, res.bookingId);
  const c = await contractOf(w, res.bookingId);
  // 1/3: offenes Ende, auch wenn die Disposition ein geplantes Ende kennt
  assert.equal(c.endAt, null, "Vertragsende offen");
  assert.ok((await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } })).endAt, "geplantes Ende bleibt Dispositionswert der Buchung");
  // 4: kein Gesamtpreis, kein abweichender Gesamtpreis
  assert.equal(Number(c.totalAmount), 0);
  assert.equal(c.agreedTotal, null);
  // 5: kein Kundenrabatt (Kunde hat 10 %)
  assert.equal(c.discountPercent, 0);
  assert.equal((c.priceSnapshot as { discountPercent: number }).discountPercent, 0);
  // 6: Kaution 0 bleibt 0 (Fahrzeugvorgabe 500 €), auch nach „Standardwerte übernehmen“
  assert.equal(Number(c.deposit), 0);
  await adoptContractDefaults(w.tenantId, c.id, w.actor);
  assert.equal(Number((await contractOf(w, res.bookingId)).deposit), 0, "Standardwerte überschreiben die Unfallersatz-Kaution nicht");
  assert.equal(Number((await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } })).deposit), 0);
  // Tarif eingefroren im Preis-Schnappschuss
  assert.deepEqual(contractTariffItems(c.priceSnapshot)?.map((i) => [i.kind, i.perDay, i.unitPriceCents, i.quantityHundredths]), [["LIABILITY_REDUCTION", true, 1_500, 100], ["DELIVERY", false, 4_000, 100], ["PICKUP", false, 2_000, 200]]);
  // Darstellung: Mietbeginn, Mietende offen, Mietpreis je Miettag, einmalige Positionen – nie „0 Tage“ oder „0,00 €“
  const doc = await docOf(w, res.bookingId);
  const period = doc.sections.find((s) => s.key === "period")!;
  assert.ok(period.rows.some((r) => r.label === "Mietbeginn" && /\d{2}\.\d{2}\.\d{4}/.test(r.value)));
  assert.ok(period.rows.some((r) => r.label === "Mietende" && /offen/.test(r.value)));
  assert.ok(!period.rows.some((r) => r.label === "Geplante Rückgabe"), "kein Ersatz-Enddatum im Vertrag");
  assert.equal(doc.price.openEnd, true);
  assert.deepEqual(doc.price.lines.map((l) => ({ text: l.text, amount: sp(l.amount) })), [{ text: "Mietpreis je Miettag (Tagessatz)", amount: "79,00 €" }, { text: "Haftungsreduzierung je Miettag", amount: "15,00 €" }]);
  assert.equal(doc.price.subtotalLabel, "Summe je Miettag");
  assert.equal(sp(doc.price.subtotal), "94,00 €");
  assert.deepEqual(doc.price.extras.map((e) => sp(e.amount)), ["40,00 €", "40,00 €"]);
  assert.match(doc.price.extras[1].text, /2 × 20,00/);
  assert.equal(doc.price.total, "nach tatsächlicher Mietdauer");
  assert.match(sp(doc.price.totalNote ?? ""), /tatsächliche Miettage × 94,00 € \+ 80,00 € einmalig/);
  assert.equal(doc.price.deposit, "keine");
  assert.equal(doc.price.discount, null);
  const text = sp(JSON.stringify(doc));
  assert.ok(!/\b0 Tage\b/.test(text) && !text.includes("Mietdauer 0"), "nie „0 Tage“");
  assert.ok(!text.includes('"0,00 €"'), `nie „0,00 €“ als Preis: ${(text.match(/"[^"]{0,40}":"0,00 €"/g) ?? []).join(", ")}`);
  assert.ok(doc.sections.find((s) => s.key === "conditions")!.rows.some((r) => r.label === "Kaution" && r.value === "keine Kaution vereinbart"));
  assert.ok(doc.rules!.rows.some((r) => r.label === "Verspätete Rückgabe" && /entfällt/.test(r.value)));
  // Abschlussprüfung: ohne Unterschrift nur die Unterschrift offen – Ende/Preis sind in Ordnung
  const st = await getContractState(w.tenantId, c.id);
  assert.ok(!st.issues.some((i) => i.severity === "error" && (i.area === "PERIOD" || i.area === "PRICE")), JSON.stringify(st.issues));
  // Abweichender Gesamtpreis ist beim Unfallersatz ausgeschlossen (serverseitig)
  await assert.rejects(() => conditions(w, res.bookingId, { agreedTotal: 100, agreedTotalNote: "Sonderpreis" }), /keinen abweichend vereinbarten Gesamtpreis/);
  // Mietbeginn wird nicht im Vertrag verschoben
  await assert.rejects(() => conditions(w, res.bookingId, { startAt: plus(new Date(), 3 * DAY) }), /Fallakte/);
});

test("6b: Unfallersatz-Kaution gleich der Fahrzeugvorgabe folgt keiner späteren Vorgabe; keine „neueren Standardwerte“ wegen der Kaution", async () => {
  const w = await world("ue-e-deposit");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { depositCents: 50_000 }));
  await conditions(w, res.bookingId, { deposit: 500 });
  const c = await contractOf(w, res.bookingId);
  assert.equal(Number(c.deposit), 500);
  await db.vehicle.update({ where: { id: w.v2 }, data: { deposit: 700 } });
  assert.equal((await getContractState(w.tenantId, c.id)).rules.newerDefaults, false, "geänderte Kautionsvorgabe ist beim Unfallersatz kein neuerer Standardwert");
  await adoptContractDefaults(w.tenantId, c.id, w.actor);
  assert.equal(Number((await contractOf(w, res.bookingId)).deposit), 500, "Vertragskaution bleibt beim Wert des Falls");
  assert.equal(Number((await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } })).deposit), 500);
});

test("2/25: Standardvertrag unverändert – Ende Pflicht, Rabatt, Kautionsvorgabe, Darstellung und Abschluss wie bisher", async () => {
  const w = await world("ue-e-std");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const base = { startAt: bk.startAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 500, fuelPolicy: "FULL_TO_FULL" as const, fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" };
  await assert.rejects(() => saveConditions(w.tenantId, c.id, { ...base, endAt: null }, w.actor), /Rückgabe mit Datum und Uhrzeit/);
  await saveConditions(w.tenantId, c.id, { ...base, endAt: bk.endAt }, w.actor);
  const after = await db.rentalContract.findUniqueOrThrow({ where: { id: c.id }, include: { drivers: true } });
  const snap = after.priceSnapshot as Record<string, unknown>;
  assert.ok(!("accidentTariff" in snap) && !("openEnd" in snap), "Standard-Schnappschuss ohne Unfallersatz-Schlüssel (Prüfsummen unverändert)");
  assert.equal(after.discountPercent, 10, "Kundenrabatt gilt wie bisher");
  assert.ok(Number(after.totalAmount) > 0);
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } });
  const doc = buildContractDocument(after, tenant, []);
  assert.ok(doc.sections.find((s) => s.key === "period")!.rows.some((r) => r.label === "Geplante Rückgabe"));
  assert.equal(doc.price.subtotalLabel, "Zwischensumme");
  assert.equal(doc.price.totalNote, null);
  assert.equal(doc.price.durationText, "Mietdauer 6 Tage");
  assert.ok(doc.price.discount, "Rabattzeile wie bisher");
  assert.equal(sp(doc.price.deposit), "500,00 €");
  // Abschluss wie bisher
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  const signed = await finalizeContract(w.tenantId, c.id);
  assert.equal(signed.status, "SIGNED");
  assert.equal(signed.endAt?.getTime(), bk.endAt!.getTime());
});

test("7/8/9: Unterschrift friert den Unfallersatz-Vertrag ein – geplantes Ende, Versicherung, Tarifänderung ändern ihn nicht; kein Nachtrag", async () => {
  const w = await world("ue-e-freeze");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  await conditions(w, res.bookingId);
  const draft = await contractOf(w, res.bookingId);
  // Mieter unterschreibt den Entwurf; danach ändert die Disposition das geplante Ende – Inhalt und Unterschrift bleiben gültig
  await saveContractSignature(w.tenantId, w.actor, draft.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, draft.id) });
  const hash0 = await getContractContentHash(w.tenantId, draft.id);
  const snap0 = (await contractOf(w, res.bookingId)).priceSnapshot;
  await updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(new Date(), 6 * DAY), reason: "Werkstatttermin" });
  await getContractState(w.tenantId, draft.id); // frischt den Entwurf auf
  assert.equal(await getContractContentHash(w.tenantId, draft.id), hash0, "geplantes Ende ist kein Vertragsinhalt");
  assert.deepEqual((await contractOf(w, res.bookingId)).priceSnapshot, snap0);
  assert.equal((await contractOf(w, res.bookingId)).endAt, null);
  assert.equal(await db.signature.count({ where: { contractId: draft.id } }), 1, "Unterschrift bleibt gültig");
  await updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: null, reason: "Ersatzteil verzögert" });
  assert.equal(await getContractContentHash(w.tenantId, draft.id), hash0);
  // Tarifänderung im Entwurf: sofort im Vertrag, vorhandene Unterschriften verfallen
  await setTariff(w.tenantId, res.case.id, w.actor, [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1_800 }]);
  assert.deepEqual(contractTariffItems((await contractOf(w, res.bookingId)).priceSnapshot)?.map((i) => i.unitPriceCents), [1_800]);
  assert.equal(await db.signature.count({ where: { contractId: draft.id } }), 0, "Unterschrift zum alten Tarif verfällt");
  // 9: Unterschrift und Abschluss über die bestehende Logik
  const signed = await signContract(w, res.bookingId);
  assert.equal(signed.status, "SIGNED");
  assert.equal(signed.endAt, null);
  const before = await contractOf(w, res.bookingId);
  // 7: Änderungen danach berühren den Vertrag nicht
  await updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(new Date(), 6 * DAY), reason: "Werkstatt meldet Reparaturende" });
  await updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: null, reason: "Ersatzteil verzögert" });
  await updateInsurer(w.tenantId, res.case.id, w.actor, { insurer: { name: "ANDERE-VERSICHERUNG", claimNumber: "X-1" } });
  await assert.rejects(() => setTariff(w.tenantId, res.case.id, w.actor, []), /im unterschriebenen Mietvertrag festgeschrieben/);
  const now = await contractOf(w, res.bookingId);
  assert.deepEqual(now.priceSnapshot, before.priceSnapshot);
  assert.equal(now.contentHash, before.contentHash);
  assert.equal(now.endAt, null);
  assert.equal((await verifyContract(w.tenantId, now.id)).intact, true, "Prüfsumme passt weiterhin");
  // 8: kein Nachtrag durch das geplante Ende
  assert.equal(await db.contractAmendment.count({ where: { tenantId: w.tenantId } }), 0);
  // Fallakte: Tarif aus dem Vertrag (eingefroren)
  const t = await caseTariff(w.tenantId, res.case.id, res.bookingId);
  assert.equal(t.frozen, true);
  assert.deepEqual(t.items.map((i) => i.unitPriceCents), [1_800]);
});

// ---------------------------------------------------------------------------
// Übergabe, laufende Miete, Rückgabe
// ---------------------------------------------------------------------------

test("10/11/12/13: Übergabe nur nach Unterschrift; danach Miete läuft, Fahrzeug bleibt belegt, keine Überfälligkeit wegen offenem Ende", async () => {
  const w = await world("ue-e-pickup");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  // 11: ohne unterschriebenen Vertrag keine Übergabe
  await assert.rejects(() => startHandover(w.tenantId, res.bookingId, "PICKUP", w.actor), /erst starten, wenn der Mietvertrag abgeschlossen ist/);
  let h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(contractStep(h.status, h.booking).kind, "OPEN", "Vertrag öffnen statt Sackgasse");
  await conditions(w, res.bookingId);
  await signContract(w, res.bookingId);
  h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h.mainStatus.label, "Bereit zur Übergabe");
  assert.equal(contractStep(h.status, h.booking).kind, "VIEW");
  // Vor der Übergabe kein Ist-Wert
  let r = await caseFileRental(w.tenantId, h, "FULL");
  assert.equal(r.tariff?.rent.phase, "NONE");
  // 10: Übergabe über das bestehende Protokoll
  await pickup(w, res.bookingId);
  const b = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
  assert.equal(b.status, "ACTIVE");
  assert.ok(b.actualPickupAt);
  assert.equal(await db.handover.count({ where: { bookingId: res.bookingId, type: "PICKUP", status: "FINALIZED" } }), 1, "ein Übergabeprotokoll, keine zweite Tabelle");
  await assert.rejects(() => startHandover(w.tenantId, res.bookingId, "PICKUP", w.actor), /bereits abgeschlossen/, "keine zweite Übergabe");
  h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h.mainStatus.label, "Miete läuft");
  assert.equal(h.openEnd, true);
  // 13: nicht überfällig wegen fehlendem Ende
  assert.equal(h.overdue, false);
  assert.equal(isOverdue({ status: b.status, endAt: b.endAt }), false);
  // 12: Fahrzeug bleibt belegt – auch Wochen später
  const conflicts = await findConflicts(db, w.tenantId, w.v2, plus(new Date(), 30 * DAY), plus(new Date(), 31 * DAY));
  assert.ok(conflicts.some((x) => x.id === res.bookingId), "offene Miete belegt das Fahrzeug unbefristet");
  await assert.rejects(() => createAccidentCase(w.tenantId, w.actor, caseInput(w, { startAt: plus(new Date(), 20 * DAY) })), DomainError);
  // laufende Miete: Mietwert bis jetzt aus der zentralen Logik
  await backdatePickup(res.bookingId, plus(new Date(), -(2 * DAY + 3 * HOUR)));
  h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  r = await caseFileRental(w.tenantId, h, "FULL");
  assert.equal(r.tariff?.rent.phase, "RUNNING");
  assert.equal(r.tariff?.rent.phase === "RUNNING" && r.tariff.rent.value.cents, 3 * 9_400 + 8_000);
  const o = await caseFileOverview(w.tenantId, h, "FULL");
  assert.equal(o.rentValue?.cents, 3 * 9_400 + 8_000, "Übersicht und Miete zeigen denselben Wert");
  assert.ok(o.steps.some((s) => s.code === "OPEN_END"));
});

test("14/15/16/17/18/19/24: Rückgabe ohne Vertragsende – tatsächliche Dauer, Tagespositionen, Freikilometer, kein Nachtrag, Fall bleibt offen", async () => {
  const w = await world("ue-e-return");
  // geplantes Ende in der Vergangenheit wird erreicht → Hinweis erlaubt, aber keine Verspätungsgebühr und kein Nachtrag
  const res = await signedCase(w, { plannedEndAt: plus(new Date(), 2 * DAY) });
  await pickup(w, res.bookingId);
  // Nach der Unterschrift gilt nur der Tarif aus dem Vertrag: Fallpositionen und Buchungs-Tagessatz absichtlich verändern (Testdaten)
  await db.accidentReplacementTariffItem.updateMany({ where: { caseId: res.case.id }, data: { unitPriceCents: 9_999 } });
  await db.booking.update({ where: { id: res.bookingId }, data: { dailyRate: 99 } });
  const frozen = await caseTariff(w.tenantId, res.case.id, res.bookingId);
  assert.equal(frozen.dailyRateCents, 7_900);
  assert.deepEqual(frozen.items.map((i) => i.unitPriceCents), [1_500, 4_000, 2_000]);
  assert.deepEqual((await accidentTariffsFor(w.tenantId, [res.bookingId])).get(res.bookingId)?.items.map((i) => i.unitPriceCents), [1_500, 4_000, 2_000]);
  const pickedAt = plus(new Date(), -(3 * DAY + 2 * HOUR)); // 3 Tage 2 Std. → 4 Miettage
  await backdatePickup(res.bookingId, pickedAt);
  await db.booking.update({ where: { id: res.bookingId }, data: { endAt: plus(new Date(), -DAY) } }); // geplantes Ende überschritten (Testdaten)
  const r = await startReturn(w, res.bookingId, 31_100); // 1.000 km gefahren
  const cmp = await getReturnComparison(w.tenantId, r.id);
  // 15/17: Miettage und Freikilometer ab der tatsächlichen Übergabe bis jetzt
  assert.equal(cmp.time.rentalDays, 4);
  assert.equal(cmp.time.plannedEnd, null, "Vertrag kennt kein Ende");
  assert.equal(cmp.time.lateMinutes, 0);
  assert.equal(cmp.contract.includedKm, 4 * 200);
  const km = cmp.proposals.find((p) => p.key === "EXTRA_MILEAGE")!;
  assert.equal(km.draft.quantity, 200, "1.000 km gefahren − 800 Freikilometer");
  assert.equal(km.draft.amount, 50);
  // 18: keine Verspätung trotz überschrittenem geplantem Ende
  assert.ok(!cmp.proposals.some((p) => p.key === "LATE_RETURN"));
  assert.ok(!cmp.hints.some((x) => x.code === "LATE_RETURN"));
  const state = await getHandoverState(w.tenantId, r.id);
  assert.ok(!state.issues.some((i) => i.code === "LATE_RETURN"));
  await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
  // Bestätigter Betrag veraltet, wenn bis zum Abschluss ein neuer Miettag begonnen hat
  await backdatePickup(res.bookingId, plus(pickedAt, -DAY));
  await sign({ ...w, bookingId: res.bookingId, vehicleId: w.v2 }, r.id);
  await assert.rejects(() => finalizeHandover(w.tenantId, r.id, w.actor), /Mehrkilometer: Der bestätigte Betrag passt nicht mehr/);
  const charge = await db.extraCharge.findFirstOrThrow({ where: { handoverId: r.id, type: "EXTRA_MILEAGE" } });
  await removeCharge(w.tenantId, r.id, charge.id);
  const cmp2 = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp2.time.rentalDays, 5);
  assert.equal(cmp2.proposals.some((p) => p.key === "EXTRA_MILEAGE"), false, "5 × 200 km frei – keine Mehrkilometer mehr");
  // 14: Rückgabe abschließen
  await finishReturn(w, res.bookingId, r.id);
  const b = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
  assert.equal(b.status, "RETURNED");
  assert.ok(b.actualReturnAt);
  const days = rentalDays(b.actualPickupAt!, b.actualReturnAt!);
  assert.equal(days, 5);
  assert.equal(await db.handover.count({ where: { bookingId: res.bookingId, type: "RETURN", status: "FINALIZED" } }), 1);
  await assert.rejects(() => startHandover(w.tenantId, res.bookingId, "RETURN", w.actor), /bereits abgeschlossen/, "keine zweite Rückgabe");
  // 18: kein Nachtrag, keine Verspätungsposition
  assert.equal(await db.contractAmendment.count({ where: { bookingId: res.bookingId } }), 0);
  assert.equal(await db.extraCharge.count({ where: { bookingId: res.bookingId, type: "LATE_RETURN" } }), 0);
  // 19: Fall bleibt offen, „Vertrag unterschrieben“, „Fahrzeug zurück“ und „Fall abgeschlossen“ sind getrennt
  const h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h.status, "OPEN");
  assert.equal(h.mainStatus.label, "Abzurechnen");
  assert.equal(h.booking.contract?.status, "SIGNED");
  // 16/24: Endwert aus der zentralen Logik = Tage × (Tagessatz + Tagespositionen) + Einmalpositionen; Rechnung zählt dieselben Tage
  const rental = await caseFileRental(w.tenantId, h, "FULL");
  assert.equal(rental.tariff?.rent.phase, "FINAL");
  const expected = rentValue({ from: b.actualPickupAt!, until: b.actualReturnAt!, dailyRateCents: 7_900, items: [{ perDay: true, unitPriceCents: 1_500, quantityHundredths: 100 }, { perDay: false, unitPriceCents: 4_000, quantityHundredths: 100 }, { perDay: false, unitPriceCents: 2_000, quantityHundredths: 200 }] })!;
  assert.equal(expected.cents, 5 * 9_400 + 8_000);
  assert.deepEqual(rental.tariff?.rent.phase === "FINAL" && rental.tariff.rent.value, expected);
  assert.equal(rental.duration?.days, 5);
  // die spätere Rechnung (Phase F) rechnet mit denselben Tagen und Positionen
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: res.case.id, recipientRole: "INSURER", nonce: nonce() });
  const iv = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId: invoice.id }, include: { items: true } });
  const rentalItem = iv.items.find((i) => i.source === "RENTAL")!;
  assert.equal(Number(rentalItem.quantity), 5, "Rechnung: Miettage = tatsächliche Dauer");
  const lr = iv.items.find((i) => /Haftungsreduzierung/.test(i.description))!;
  assert.equal(Number(lr.quantity), 5, "Tagesposition × tatsächliche Miettage");
  assert.equal(Number(rentalItem.unitPrice), 79, "Tagessatz laut Vertrag, nicht der nachträglich geänderte Buchungswert");
  assert.equal(Number(lr.unitPrice), 15, "Tagesposition laut Vertrag, nicht der nachträglich geänderte Fallwert");
  const rentCents = iv.items.filter((i) => i.source !== "EXTRA_CHARGE").reduce((s, i) => s + Math.round(Number(i.quantity) * Number(i.unitPrice) * 100), 0);
  assert.equal(rentCents, expected.cents, "Rechnung (ohne Zusatzkosten) = Endwert der Fallakte");
});

test("Bekanntes geplantes Ende: Vertrag trotzdem offen, Rückgabe vor dem Plan rechnet nach tatsächlicher Dauer", async () => {
  const w = await world("ue-e-plan");
  const res = await signedCase(w, { plannedEndAt: plus(new Date(), 10 * DAY) });
  assert.equal((await contractOf(w, res.bookingId)).endAt, null);
  await pickup(w, res.bookingId);
  await backdatePickup(res.bookingId, plus(new Date(), -(DAY + HOUR)));
  let h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  let r = await caseFileRental(w.tenantId, h, "FULL");
  assert.ok(r.tariff?.planned, "Planwert bis zum geplanten Ende wird als Planwert gezeigt");
  assert.equal(r.tariff?.rent.phase === "RUNNING" && r.tariff.rent.value.days, 2);
  const ret = await startReturn(w, res.bookingId, 30_300);
  await finishReturn(w, res.bookingId, ret.id);
  h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  r = await caseFileRental(w.tenantId, h, "FULL");
  assert.equal(r.tariff?.rent.phase === "FINAL" && r.tariff.rent.value.days, 2, "abgerechnet wird die tatsächliche Dauer, nicht das geplante Ende");
  assert.equal(r.tariff?.planned, null, "nach der Rückgabe kein Planwert mehr");
});

// ---------------------------------------------------------------------------
// Geschlossener Fall
// ---------------------------------------------------------------------------

test("20/22: Geschlossener Fall sperrt Vertrag und Übergabe serverseitig; Wiederöffnen gibt beides wieder frei", async () => {
  const w = await world("ue-e-closed-pickup");
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  const c = await contractOf(w, res.bookingId);
  // Entwurf mit Konditionen und Mieterunterschrift, dann Fall geschlossen
  await conditions(w, res.bookingId);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await closeCase(w.tenantId, res.case.id, w.actor, { reason: "Kunde hat abgesagt", acknowledgeWarnings: true });
  // die Vertragsansicht frischt den Entwurf eines geschlossenen Falls nicht auf (Kundendaten geändert → Entwurf und Unterschrift bleiben)
  const frozenDraft = await contractOf(w, res.bookingId);
  assert.equal(frozenDraft.status, "DRAFT");
  await db.customer.update({ where: { id: w.customerId }, data: { phone: "0421 000 999" } });
  await getContractState(w.tenantId, c.id);
  const afterView = await contractOf(w, res.bookingId);
  assert.deepEqual(afterView.customerSnapshot, frozenDraft.customerSnapshot, "Entwurf eines geschlossenen Falls bleibt eingefroren");
  assert.equal(await db.signature.count({ where: { tenantId: w.tenantId, contractId: c.id, role: "RENTER" } }), 1, "Unterschrift bleibt erhalten");
  // Vertrag: jede Änderung und der Abschluss gesperrt
  await assert.rejects(() => conditions(w, res.bookingId), CLOSED);
  await assert.rejects(() => saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: "0".repeat(64) }), CLOSED);
  await assert.rejects(() => finalizeContract(w.tenantId, c.id), CLOSED);
  const st = await getContractState(w.tenantId, c.id);
  assert.ok(st.issues.some((i) => i.code === "CASE_CLOSED" && i.message === ACCIDENT_CASE_CLOSED_MESSAGE), "der Assistent zeigt den Grund");
  // Wiederöffnen → Vertrag abschließbar
  await reopenCase(w.tenantId, res.case.id, w.actor, "Kunde kommt doch");
  await conditions(w, res.bookingId);
  await signContract(w, res.bookingId);
  // Übergabe: begonnen, dann Fall geschlossen → Fortsetzen, Ändern und Abschließen gesperrt
  const p = await startHandover(w.tenantId, res.bookingId, "PICKUP", w.actor);
  const driver = await db.contractDriver.findFirstOrThrow({ where: { contractId: c.id, role: "PRIMARY_DRIVER" } });
  const ver = await startOrGetVerification(w.tenantId, w.actor, p.id, driver.id);
  await closeCase(w.tenantId, res.case.id, w.actor, { reason: "versehentlich", acknowledgeWarnings: true });
  // Fahrerprüfung und Dokumentkopien gehören zur Übergabe – ebenfalls gesperrt
  await assert.rejects(() => startOrGetVerification(w.tenantId, w.actor, p.id, driver.id), CLOSED);
  await assert.rejects(() => confirmVerification(w.tenantId, w.actor, ver.id), CLOSED);
  const licenseImage = await photoJpeg("Führerschein", 400, 300);
  await assert.rejects(() => recordDriverDocumentCopy(w.tenantId, w.actor, { bookingId: res.bookingId, handoverId: p.id, verificationId: ver.id, contractDriverId: driver.id, documentKind: "LICENSE", side: "FRONT", bytes: licenseImage }), CLOSED);
  assert.equal(await db.driverDocumentCopy.count({ where: { tenantId: w.tenantId } }), 0, "keine Kopie gespeichert");
  await assert.rejects(() => startHandover(w.tenantId, res.bookingId, "PICKUP", w.actor), CLOSED);
  await assert.rejects(() => updateHandoverDraft(w.tenantId, p.id, { mileage: 30_100 }), CLOSED);
  await assert.rejects(() => finalizeHandover(w.tenantId, p.id, w.actor), CLOSED);
  await assert.rejects(() => updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(new Date(), 4 * DAY), reason: "Test" }), CLOSED);
  // Storno ebenfalls gesperrt (Vorschau zeigt den Grund)
  assert.ok((await cancellationOverview(w.tenantId, res.bookingId)).blockers.includes(ACCIDENT_CASE_CLOSED_MESSAGE));
  await assert.rejects(() => cancelBooking(w.tenantId, w.actor, res.bookingId, { reason: "Test-Storno" }), CLOSED);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } })).status, "RESERVED", "nichts verändert");
  // 22: Wiederöffnen → Übergabe möglich
  await reopenCase(w.tenantId, res.case.id, w.actor, "Fehler korrigiert");
  // der begonnene Entwurf wird fortgesetzt (startHandover liefert ihn zurück)
  await pickup(w, res.bookingId);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } })).status, "ACTIVE");
});

test("21/22: Geschlossener Fall sperrt Rückgabe, Schlüsselbox, Statuswechsel und Nachtrag; nach Wiederöffnen geht die Rückgabe", async () => {
  const w = await world("ue-e-closed-return");
  const res = await signedCase(w);
  await pickup(w, res.bookingId);
  // vor dem Schließen: Nachtrag-Entwurf angelegt und Rückgabe begonnen
  const { amendment } = await createAmendmentDraft(w.tenantId, w.actor, { bookingId: res.bookingId, nonce: nonce() });
  const r = await startReturn(w, res.bookingId);
  const cmpBefore = await getReturnComparison(w.tenantId, r.id);
  assert.ok(cmpBefore.proposals.some((x) => x.key === "EXTRA_MILEAGE"), "Mehrkilometer-Vorschlag vorhanden (300 km gefahren, 200 km frei)");
  await closeCase(w.tenantId, res.case.id, w.actor, { reason: "Fehlbedienung", acknowledgeWarnings: true });
  // Nachtrag, Protokoll-Unterschrift, „Nicht berechnen“ und Verwerfen sind gesperrt
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, amendment.id, { agreementText: "nach Abschluss" }), CLOSED);
  await assert.rejects(() => signAmendment(w.tenantId, w.actor, amendment.id), CLOSED);
  await assert.rejects(() => sign({ ...w, bookingId: res.bookingId, vehicleId: w.v2 }, r.id), CLOSED);
  await assert.rejects(() => dismissProposal(w.tenantId, r.id, w.actor, "EXTRA_MILEAGE"), CLOSED);
  await assert.rejects(() => discardEmptyReturnDraft(w.tenantId, res.bookingId, r.id, w.actor), CLOSED);
  // Phase F (Auflage aus Freigabe E): Nachtrag verwerfen bzw. Vorab-Vereinbarung zurückziehen (gleicher Serverpfad mit Grund) gesperrt
  await assert.rejects(() => discardAmendment(w.tenantId, w.actor, amendment.id), CLOSED);
  await assert.rejects(() => discardAmendment(w.tenantId, w.actor, amendment.id, "Kunde hat es sich anders überlegt"), CLOSED);
  assert.equal((await db.contractAmendment.findUniqueOrThrow({ where: { id: amendment.id } })).status, "DRAFT", "Nachtrag unverändert");

  await assert.rejects(() => startHandover(w.tenantId, res.bookingId, "RETURN", w.actor), CLOSED);
  await assert.rejects(() => updateHandoverDraft(w.tenantId, r.id, { mileage: 30_500 }), CLOSED);
  await assert.rejects(() => finalizeHandover(w.tenantId, r.id, w.actor), CLOSED);
  await assert.rejects(() => authorizeKeyDrop(w.tenantId, w.actor, res.bookingId, { location: "Schlüsselbox Hof", expectedReturnAt: plus(new Date(), DAY), agreedWithCustomer: true }), CLOSED);
  await assert.rejects(() => changeBookingStatus(w.tenantId, res.bookingId, "RETURNED", { actor: w.actor }), CLOSED);
  await assert.rejects(() => createAmendmentDraft(w.tenantId, w.actor, { bookingId: res.bookingId, nonce: nonce() }), CLOSED);
  const state = await getHandoverState(w.tenantId, r.id);
  assert.ok(state.issues.some((i) => i.code === "CASE_CLOSED"), "das Rückgabeprotokoll zeigt den Grund");
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } })).status, "ACTIVE", "nichts verändert");
  // Wiederöffnen → Rückgabe abschließbar
  await reopenCase(w.tenantId, res.case.id, w.actor, "Rückgabe nachholen");
  assert.equal((await discardAmendment(w.tenantId, w.actor, amendment.id)).status, "DISCARDED", "nach dem Wiederöffnen wieder verwerfbar");
  await finishReturn(w, res.bookingId, r.id);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } })).status, "RETURNED");
  assert.equal((await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: res.case.id } })).status, "OPEN");
});

test("21b: Geschlossener Fall sperrt die Schlüsselbox (Link senden, Aufheben); Wiederöffnen gibt sie frei", async () => {
  const w = await world("ue-e-closed-keydrop");
  const res = await signedCase(w);
  await pickup(w, res.bookingId);
  const kd = await authorizeKeyDrop(w.tenantId, w.actor, res.bookingId, { location: "Schlüsselbox Hof", expectedReturnAt: plus(new Date(), DAY), agreedWithCustomer: true });
  await closeCase(w.tenantId, res.case.id, w.actor, { reason: "Fehlbedienung", acknowledgeWarnings: true });
  const transport = new FakeTransport();
  const mailsBefore = await db.emailLog.count({ where: { tenantId: w.tenantId } });
  await assert.rejects(() => sendKeyDropLink(w.tenantId, w.actor, kd.id, { nonce: nonce(), baseUrl: "https://app.example.test", transport }), CLOSED);
  assert.equal(transport.sent.length, 0, "keine Rückgabe-Mail");
  assert.equal(await db.keyDropAccess.count({ where: { keyDropId: kd.id } }), 0, "kein Kundenlink");
  assert.equal(await db.emailLog.count({ where: { tenantId: w.tenantId } }), mailsBefore, "kein Versandeintrag");
  await assert.rejects(() => cancelKeyDrop(w.tenantId, w.actor, kd.id, "nach Abschluss"), CLOSED);
  assert.equal((await db.keyDropReturn.findUniqueOrThrow({ where: { id: kd.id } })).status, "AUTHORIZED");
  await reopenCase(w.tenantId, res.case.id, w.actor, "Kunde bringt das Fahrzeug persönlich");
  await cancelKeyDrop(w.tenantId, w.actor, kd.id, "doch persönlich");
  assert.equal((await db.keyDropReturn.findUniqueOrThrow({ where: { id: kd.id } })).status, "CANCELLED");
});

// ---------------------------------------------------------------------------
// Dokumente, Standardprozesse, Mandantentrennung
// ---------------------------------------------------------------------------

test("23: Mietvertrag, Übergabe- und Rückgabeprotokoll erscheinen in der Fallakte (operativ und voll)", async () => {
  const w = await world("ue-e-docs");
  // Vertrag mit echtem Unterschriftsbild, damit das PDF entsteht
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  await conditions(w, res.bookingId);
  const c0 = await contractOf(w, res.bookingId);
  await saveContractSignature(w.tenantId, w.actor, c0.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: `data:image/png;base64,${Buffer.from(await signaturePng(600, 200)).toString("base64")}`, seenHash: await getContractContentHash(w.tenantId, c0.id) });
  await finalizeContract(w.tenantId, c0.id);
  const transport = new FakeTransport();
  const ww = { ...w, bookingId: res.bookingId, vehicleId: w.v2 };
  const realPhoto = async (handoverId: string, category: string) => {
    const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: res.bookingId, contentType: "image/jpeg" });
    const jpeg = await photoJpeg(category, 400, 300);
    await storage.put(storageKey, jpeg, "image/jpeg");
    return registerPhoto(w.tenantId, w.actor, { handoverId, storageKey, category, contentType: "image/jpeg", sizeBytes: jpeg.length, checksum: sha256(jpeg) });
  };
  const realSign = async (handoverId: string) => saveHandoverSignature(w.tenantId, w.actor, handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: `data:image/png;base64,${Buffer.from(await signaturePng(600, 200)).toString("base64")}`, seenHash: await getHandoverContentHash(w.tenantId, handoverId), ipAddress: null, userAgent: "test" });
  const c = await contractOf(w, res.bookingId);
  const cf = await runContractFollowUp(w.tenantId, c.id, w.actor.id, { storage, transport });
  assert.equal(cf.ok, true, cf.error);
  const p = await startHandover(w.tenantId, res.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 30_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await realPhoto(p.id, cat);
  await answerAll(ww, p.id);
  await realSign(p.id);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  const fp = await finalizeHandover(w.tenantId, p.id, w.actor);
  await runPickupFollowUp(w.tenantId, { id: fp.id, contractId: c.id }, w.actor.id, { storage, transport });
  const r = await startHandover(w.tenantId, res.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 30_250, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await realPhoto(r.id, cat);
  await answerAll(ww, r.id);
  await realSign(r.id);
  const fr = await finalizeHandover(w.tenantId, r.id, w.actor);
  await runReturnFollowUp(w.tenantId, { id: fr.id }, w.actor.id, { storage, transport });
  const h = (await caseFileHeader(w.tenantId, res.case.id, "OPERATIONAL"))!;
  for (const access of ["OPERATIONAL", "FULL"] as const) {
    const d = await caseFileDocuments(w.tenantId, h, access);
    const types = new Set(d.documents.map((x) => x.type));
    for (const t of ["RENTAL_CONTRACT", "PICKUP_PROTOCOL", "RETURN_PROTOCOL"]) assert.ok(types.has(t), `${access}: ${t} in der Fallakte (${[...types].join(",")})`);
  }
  // Verlauf: Übergabe und Rückgabe stehen in der Fallakte
  const events = await db.accidentReplacementCaseEvent.findMany({ where: { caseId: res.case.id }, select: { type: true } });
  assert.ok(events.some((e) => e.type === "VEHICLE_PICKED_UP") && events.some((e) => e.type === "VEHICLE_RETURNED"));
});

test("26/27: Standard-Übergabe und -Rückgabe unverändert (Vertragszeitraum für Freikilometer, keine Fallakte, keine Sperre)", async () => {
  await ready;
  const picked = await pickedUpWorld("ue-e-std-pickup");
  tenants.push(picked.tenantId);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: picked.bookingId } })).status, "ACTIVE");
  const returned = await returnedWorld("ue-e-std-return");
  tenants.push(returned.tenantId);
  const b = await db.booking.findUniqueOrThrow({ where: { id: returned.bookingId }, include: { contract: true } });
  assert.equal(b.status, "RETURNED");
  const cmp = await getReturnComparison(returned.tenantId, returned.returnId);
  assert.equal(cmp.time.rentalDays, rentalDays(b.contract!.startAt, b.contract!.endAt!), "Standard: Freikilometer nach Vertragszeitraum wie bisher");
  assert.equal(cmp.contract.includedKm, 200 * 6);
  assert.ok(cmp.proposals.find((p) => p.key === "EXTRA_MILEAGE")?.confirmed, "bestätigter Mehrkilometer-Vorschlag wie bisher");
  assert.equal(await db.accidentReplacementCase.count({ where: { tenantId: returned.tenantId } }), 0);
});

test("28: Mandantentrennung – fremde Buchungen, Fälle und Tarife sind nicht erreichbar", async () => {
  const a = await world("ue-e-tenant-a");
  const bWorld = await world("ue-e-tenant-b");
  const res = await signedCase(a);
  // fremder Mandant: Buchung, Vertrag, Fall nicht gefunden – nichts verändert
  await assert.rejects(() => startHandover(bWorld.tenantId, res.bookingId, "PICKUP", bWorld.actor), /Buchung nicht gefunden/);
  const c = await contractOf(a, res.bookingId);
  await assert.rejects(() => finalizeContract(bWorld.tenantId, c.id), { message: "Vertrag nicht gefunden." });
  // Entwurf von Mandant A: Mandant B kann weder Konditionen noch Unterschrift setzen
  const resDraft = await createAccidentCase(a.tenantId, a.actor, caseInput(a, { vehicleId: (await db.vehicle.create({ data: { tenantId: a.tenantId, plate: "HB-UE 999", make: "VW", model: "Polo", groupId: a.groupId, dailyRate: 50, requiredLicenseClass: "B" } })).id }));
  const draftA = await contractOf(a, resDraft.bookingId);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: resDraft.bookingId } });
  await assert.rejects(() => saveConditions(bWorld.tenantId, draftA.id, { startAt: bk.startAt, endAt: null, deposit: 0, kmIncludedPerDay: 1, extraKmRate: 0, deductible: 0, fuelPolicy: "FULL_TO_FULL" }, bWorld.actor), { message: "Vertrag nicht gefunden." });
  await assert.rejects(() => saveContractSignature(bWorld.tenantId, bWorld.actor, draftA.id, { role: "RENTER", signerName: "fremd", imageDataUrl: fakeSignaturePng(), seenHash: "0".repeat(64) }), { message: "Vertrag nicht gefunden." });
  assert.equal((await contractOf(a, resDraft.bookingId)).kmIncludedPerDay, draftA.kmIncludedPerDay, "Konditionen von Mandant A unverändert");
  assert.equal(await db.signature.count({ where: { contractId: draftA.id } }), 0);
  await assert.rejects(() => closeCase(bWorld.tenantId, res.case.id, bWorld.actor, { reason: "fremd", acknowledgeWarnings: true }), /nicht gefunden/);
  await assert.rejects(() => updatePlannedEnd(bWorld.tenantId, res.case.id, bWorld.actor, { plannedEndAt: null, reason: "fremd" }), /nicht gefunden/);
  assert.equal(await caseFileHeader(bWorld.tenantId, res.case.id, "FULL"), null);
  assert.equal((await accidentTariffsFor(bWorld.tenantId, [res.bookingId])).size, 0);
  await assert.rejects(() => caseTariff(bWorld.tenantId, res.case.id, res.bookingId));
  assert.equal((await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: res.case.id } })).status, "OPEN");
  // eigener Mandant: Liste bekommt den Tarif
  assert.equal((await accidentTariffsFor(a.tenantId, [res.bookingId])).get(res.bookingId)?.frozen, true);
});

// ---------------------------------------------------------------------------
// Ende-zu-Ende (Fachlogik): Kunde neu, Fall mit offenem Ende, Vertrag, Übergabe, Mietdauer ändern, Rückgabe, Fall bleibt offen
// ---------------------------------------------------------------------------

test("Ende-zu-Ende: neuer Kunde → Fall offenes Ende → Vertrag → Unterschrift → Übergabe → Mietdauer ändern → Rückgabe → Fall offen", async () => {
  const w = await world("ue-e-e2e");
  // 1. Modul freigeschaltet (world); 2. Kunde neu anlegen (über die bestehende Kundenlogik)
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, {
    customerId: null,
    newCustomer: { type: "PRIVATE", firstName: "Jonas", lastName: "Unfall", country: "DE", blocked: false, discountPercent: 15, street: "Hafenweg 3", zip: "28195", city: "Bremen", phone: "0421 777", email: "jonas@example.test", birthDate: new Date("1990-05-05"), idType: "PERSONALAUSWEIS", idNumber: "T22000129", idValidUntil: new Date("2032-01-01"), licenseNumber: "J010000SD51", licenseClass: "B", licenseIssuedAt: new Date("2010-06-01"), licenseValidUntil: new Date("2034-06-01") },
  }));
  // 3. Fall mit offenem Ende; 4. Vertrag ist vorbereitet
  const h0 = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h0.openEnd, true);
  assert.equal(contractStep(h0.status, h0.booking).kind, "OPEN");
  // 5./6. Konditionen mit offenem Ende, Unterschrift, Abschluss
  await conditions(w, res.bookingId);
  const signed = await signContract(w, res.bookingId);
  assert.equal(signed.discountPercent, 0, "kein Kundenrabatt (Kunde hätte 15 %)");
  const hashAtSign = signed.contentHash;
  // 7. Übergabe
  await pickup(w, res.bookingId);
  // 8. Fallakte: Miete läuft, offen
  let h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  assert.equal(h.mainStatus.label, "Miete läuft");
  assert.equal(h.openEnd, true);
  // 9./10. geplantes Ende setzen → Vertrag unverändert
  await updatePlannedEnd(w.tenantId, res.case.id, w.actor, { plannedEndAt: plus(new Date(), 3 * DAY), reason: "Werkstatttermin bestätigt" });
  const c = await contractOf(w, res.bookingId);
  assert.equal(c.contentHash, hashAtSign);
  assert.equal(c.endAt, null);
  assert.equal(await db.contractAmendment.count({ where: { bookingId: res.bookingId } }), 0);
  // 11. Rückgabe (Miete lief 2 Tage + 2 Std.; Tagesgrenzen selbst prüft der Test oben mit festen Daten)
  await backdatePickup(res.bookingId, plus(new Date(), -(2 * DAY + 2 * HOUR)));
  const r = await startReturn(w, res.bookingId, 30_350);
  await finishReturn(w, res.bookingId, r.id);
  // 12./13. tatsächliche Dauer und Endwert
  h = (await caseFileHeader(w.tenantId, res.case.id, "FULL"))!;
  const rental = await caseFileRental(w.tenantId, h, "FULL");
  assert.equal(rental.duration?.days, 3, "2 Tage + 2 Std. = 3 Miettage");
  assert.equal(rental.tariff?.rent.phase === "FINAL" && rental.tariff.rent.value.cents, 3 * 9_400 + 8_000);
  // 15. Fall bleibt offen für die Abrechnung (Phase F)
  assert.equal(h.status, "OPEN");
  assert.equal(h.mainStatus.label, "Abzurechnen");
});
