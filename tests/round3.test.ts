// Befehl 20.9 (End-to-End-Verbesserungen Runde 3): Zahlungsstorno ohne Löschen, Kaution bei Buchungsanlage (Doppelklick,
// getrennt vom Mietumsatz, fester Betrag), Übergabe-Validierung bleibt serverseitig, Wiederholungsprüfung bekannter Fahrer
// (Ablauf, Klasse, alte Prüfung unverändert), Zubehör-Kostenvorschläge (Standardpreise, Hutablage fahrzeugbezogen, Nicht
// berechnen, Übernehmen genau einmal, Doppelklick), Kautionsverrechnung 275/500, 700/500, 0/500, teilweise verbraucht,
// parallel, Fremdmandant, Rollen (Quelltext).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { ACCESSORY_ITEMS, accessoryPrice, missingAccessories } from "../src/lib/accessories";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { depositOffsetOptions, applyDepositOffset, previewDepositOffset } from "../src/lib/deposit-offset";
import { depositView, insertDepositReceived, recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { driverVerificationBlockers, driverVerificationOverview, repeatCheckReasons, repeatVerification } from "../src/lib/driver-verification";
import { answerChecklist, finalizeHandover, getHandoverContentHash, getHandoverState, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { getHandoverCompletionStatus } from "../src/lib/completion";
import { sha256 } from "../src/lib/integrity";
import { ensureInvoiceDraft, finalizeInvoice, getInvoiceState, updateInvoiceDraft } from "../src/lib/invoices";
import { cancelPayment, invoicePaymentSummary, recordInvoicePayment } from "../src/lib/payments";
import { payoutSource } from "../src/lib/payouts";
import { recordRentalPayment, rentalPaymentSummary } from "../src/lib/rental-payments";
import { confirmProposal, dismissProposal, getReturnComparison } from "../src/lib/returns";
import { buildStorageKey } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});
const at = new Date(Date.now() - 60_000);
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Helfer: Vertrag abschließen, Übergabe/Rückgabe mit steuerbaren Checklisten-Antworten
// ---------------------------------------------------------------------------

async function photo(w: World, handoverId: string, category: string) {
  const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  return registerPhoto(w.tenantId, w.actor, { handoverId, storageKey, category, contentType: "image/jpeg", sizeBytes: 250_000, checksum: sha256(storageKey) });
}
async function sign(w: World, handoverId: string) {
  return saveHandoverSignature(w.tenantId, w.actor, handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, handoverId), ipAddress: null, userAgent: "test" });
}
/** Alle Punkte beantworten; `overrides` je itemKey (z. B. { first_aid: "NO" }). */
async function answerAll(w: World, handoverId: string, overrides: Record<string, string> = {}) {
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId } });
  await answerChecklist(w.tenantId, handoverId, items.map((i) => ({ itemId: i.id, result: overrides[i.itemKey] ?? (i.answerType === "TEXT" ? (i.itemKey === "keys" || i.itemKey === "keys_returned" ? "2" : "") : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK"), note: overrides[i.itemKey] === "NO" ? "fehlt" : null })));
}
async function signedContract(w: World, deposit = 500) {
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return c;
}
async function pickup(w: World, contractId: string, checklist: Record<string, string> = {}, opts: { verify?: boolean } = {}) {
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 50_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, p.id, cat);
  await answerAll(w, p.id, checklist);
  if (opts.verify !== false) await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, contractId);
  await sign(w, p.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  return p;
}
/** Zweite Miete desselben Kunden im selben Mandanten (eigenes Fahrzeug), Vertrag abgeschlossen, Übergabe begonnen – Fahrer noch ungeprüft. */
async function secondRentalWithOpenPickup(w: World, label: string, vehicle: Record<string, unknown> = {}) {
  const run = `${label}-${Date.now().toString(36)}`;
  const v = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-R3 ${run.slice(-4)}`, make: "VW", model: "Crafter", groupId: w.groupId, fuel: "DIESEL", mileage: 45_000, dailyRate: 89, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 500, tankCapacityLiters: 75, requiredLicenseClass: "B", ...vehicle } });
  const start = new Date(Date.now() + 2 * DAY);
  const booking = await db.booking.create({ data: { tenantId: w.tenantId, number: `T-${run}`, vehicleId: v.id, customerId: w.customerId, startAt: start, endAt: new Date(start.getTime() + 3 * DAY), dailyRate: 89, deposit: 500 } });
  const w2: World = { ...w, vehicleId: v.id, bookingId: booking.id };
  const c = await signedContract(w2);
  const h = await startHandover(w2.tenantId, w2.bookingId, "PICKUP", w2.actor);
  const driver = await db.contractDriver.findFirstOrThrow({ where: { tenantId: w.tenantId, contractId: c.id, role: "PRIMARY_DRIVER" } });
  return { w2, contractId: c.id, handoverId: h.id, driverId: driver.id, bookingEnd: booking.endAt };
}
const withInvoiceSettings = (tenantId: string) => db.tenant.update({ where: { id: tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });

// ---------------------------------------------------------------------------
// 1. Zahlungsstorno
// ---------------------------------------------------------------------------

test("Zahlungsstorno: Zahlung bleibt physisch erhalten, wird gekennzeichnet, offener Betrag neu berechnet; Löschen verweigert", async () => {
  const w = await createWorld("r3-cancel");
  tenants.push(w.tenantId);
  const { payment } = await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: "370", method: "CASH", paidAt: at });
  const before = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.equal(before.paidCents, 37_000);
  const cancelled = await cancelPayment(w.tenantId, w.actor, payment.id, "Betrag falsch eingegeben");
  assert.deepEqual([cancelled.id, cancelled.status, cancelled.cancellationReason, cancelled.amountCents], [payment.id, "CANCELLED", "Betrag falsch eingegeben", 37_000]);
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId, bookingId: w.bookingId } }), 1, "keine Zeile gelöscht, keine Gegenzeile angelegt");
  const after = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([after.paidCents, after.openCents === before.grossCents], [0, true]);
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, payment.id, "nochmal"), /bereits storniert/);
  await assert.rejects(() => db.payment.delete({ where: { id: payment.id } }), /RB_IMMUTABLE|nicht gelöscht/);
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "PAYMENT_CANCELLED", paymentId: payment.id } }));
});

// ---------------------------------------------------------------------------
// 2. Kaution bei Buchungsanlage
// ---------------------------------------------------------------------------

test("Kaution bei Buchungsanlage: Eingang ohne Vertrag über die bestehende Erfassung, Doppelklick einmal, getrennt vom Mietumsatz, Betrag danach fest, Vertrag wird verknüpft", async () => {
  const w = await createWorld("r3-dep");
  tenants.push(w.tenantId);
  const actor = w.actor;
  // ohne fromBooking bleibt die alte Regel (Vertrag zuerst)
  await assert.rejects(() => recordDepositReceived(w.tenantId, actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at }), /abgeschlossenen Mietvertrag/);
  // Doppelklick: derselbe Schlüssel in zwei Transaktionen → genau ein Eingang
  const input = { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at, reference: "Beleg 1", idempotencyKey: "r3-dep-key-1" };
  const [a, b] = await Promise.all([
    db.$transaction((tx) => insertDepositReceived(tx, w.tenantId, actor, input, { fromBooking: true })).catch((e) => ({ error: String(e?.message) })),
    db.$transaction((tx) => insertDepositReceived(tx, w.tenantId, actor, input, { fromBooking: true })).catch((e) => ({ error: String(e?.message) })),
  ]);
  const ok = [a, b].filter((r) => "event" in r) as { event: { id: string }; created: boolean }[];
  assert.ok(ok.length >= 1, "mindestens ein Aufruf dokumentiert den Eingang");
  assert.equal(ok.filter((r) => r.created).length, 1, "genau einer legt an");
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId, type: "RECEIVED" } }), 1);
  // Stand: erhalten, vereinbart aus der Buchung, kein Vertrag
  const v = await depositView(w.tenantId, w.bookingId);
  // remaining = erhalten − freigegeben − einbehalten − verrechnet: noch nichts zugeordnet, also die vollen 500
  assert.deepEqual([v.contractSigned, v.expectedCents, v.receivedCents, v.remainingCents, v.status, v.deposit?.contractId ?? null], [false, 50_000, 50_000, 50_000, "RECEIVED", null]);
  // Kaution ist keine Mietzahlung und kein Mietumsatz
  const rent = await rentalPaymentSummary(w.tenantId, w.bookingId);
  assert.deepEqual([rent.paidCents, rent.openCents === rent.grossCents, rent.status], [0, true, "OPEN"]);
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId, bookingId: w.bookingId } }), 0);
  // mehr als vereinbart: abgelehnt; Buchung ohne Kaution: abgelehnt
  await assert.rejects(() => db.$transaction((tx) => insertDepositReceived(tx, w.tenantId, actor, { bookingId: w.bookingId, amount: "1", method: "CASH", occurredAt: at }, { fromBooking: true })), /Mehr als die vereinbarte Kaution/);
  const zero = await createWorld("r3-dep-zero");
  tenants.push(zero.tenantId);
  await db.booking.update({ where: { id: zero.bookingId }, data: { deposit: 0 } });
  await assert.rejects(() => db.$transaction((tx) => insertDepositReceived(tx, zero.tenantId, zero.actor, { bookingId: zero.bookingId, amount: "100", method: "CASH", occurredAt: at }, { fromBooking: true })), /keine Kaution vereinbart/);
  // Vertrag: abweichende Kaution kann nicht mehr vereinbart werden, gleiche schon; Abschluss verknüpft die Kautionszeile
  const c = await ensureContractDraft(w.tenantId, w.bookingId, actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const cond = { startAt: bk.startAt, endAt: bk.endAt, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL" as const, fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" };
  await assert.rejects(() => saveConditions(w.tenantId, c.id, { ...cond, deposit: 400 }), /bereits eine Kaution über 500,00/);
  await saveConditions(w.tenantId, c.id, { ...cond, deposit: 500 });
  await saveContractSignature(w.tenantId, actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  const v2 = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v2.contractSigned, v2.contractNumber !== null, v2.deposit?.contractId, v2.expectedCents, v2.receivedCents, v2.status], [true, true, c.id, 50_000, 50_000, "RECEIVED"]);
  const audit = await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "DEPOSIT_RECEIVED" } });
  assert.equal((audit?.details as { agreedFrom?: string })?.agreedFrom, "BOOKING");
});

// ---------------------------------------------------------------------------
// 3. Übergabe: Live-Warnungen sind nur Anzeige, die Serverprüfung bleibt
// ---------------------------------------------------------------------------

test("Übergabe Schritt 2: Live-Liste eingebaut; serverseitig blockieren fehlender Kilometer-, Tank- und Batteriestand weiterhin", async () => {
  const w = await createWorld("r3-live");
  tenants.push(w.tenantId);
  const c = await signedContract(w);
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  let s = await getHandoverState(w.tenantId, p.id);
  assert.deepEqual(s.issues.filter((i) => i.area === "READINGS").map((i) => i.code).sort(), ["FUEL_MISSING", "MILEAGE_MISSING"]);
  await assert.rejects(() => finalizeHandover(w.tenantId, p.id, w.actor), /Kilometerstand|noch nicht abgeschlossen|offene Punkte/);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 50_100 });
  s = await getHandoverState(w.tenantId, p.id);
  assert.deepEqual(s.issues.filter((i) => i.area === "READINGS").map((i) => i.code), ["FUEL_MISSING"]);
  await updateHandoverDraft(w.tenantId, p.id, { fuelLevelEighths: 8 });
  s = await getHandoverState(w.tenantId, p.id);
  assert.equal(s.issues.filter((i) => i.area === "READINGS" && i.severity === "error").length, 0);
  // Elektro: Batteriestand statt Tank
  const e = await createWorld("r3-live-ev");
  tenants.push(e.tenantId);
  await db.vehicle.update({ where: { id: e.vehicleId }, data: { fuel: "ELEKTRO" } });
  await signedContract(e);
  const pe = await startHandover(e.tenantId, e.bookingId, "PICKUP", e.actor);
  assert.deepEqual((await getHandoverState(e.tenantId, pe.id)).issues.filter((i) => i.area === "READINGS").map((i) => i.code).sort(), ["BATTERY_MISSING", "MILEAGE_MISSING"]);
  // Oberfläche nutzt die bestehende Live-Komponente der Rückgabe (keine dritte Validierungslogik)
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/uebergabe/page.tsx"), "utf8");
  assert.match(page, /<ReadingsIssueList issues=\{issues\.filter\(\(i\) => i\.area === "READINGS"\)\} watch=\{\["mileage"/);
  void c;
});

// ---------------------------------------------------------------------------
// 4. Wiederkehrende Fahrer
// ---------------------------------------------------------------------------

test("Wiederholungsprüfung: bekannter Fahrer wird per Sichtprüfung für DIESE Übergabe bestätigt – eigener Vermerk, Referenz, alte Prüfung unverändert; Blocker-Text angepasst", async () => {
  const w = await returnedWorld("r3-repeat", { stopAfterPickup: true });
  tenants.push(w.tenantId);
  const ref0 = await db.driverVerification.findFirstOrThrow({ where: { tenantId: w.tenantId, status: "CONFIRMED" } });
  const { w2, handoverId, driverId } = await secondRentalWithOpenPickup(w, "r3-repeat-2");
  const ov = await driverVerificationOverview(w2.tenantId, handoverId);
  assert.equal(ov.length, 1);
  assert.deepEqual([ov[0].status, ov[0].repeat?.eligible, ov[0].repeat?.verificationId, ov[0].repeat?.licenseClasses, ov[0].repeat?.reasons], ["NOT_STARTED", true, ref0.id, ["B"], []]);
  assert.match((await driverVerificationBlockers(w2.tenantId, handoverId))[0].message, /Dokumente für diese Übergabe noch nicht bestätigt/);
  // alle Punkte Pflicht
  await assert.rejects(() => repeatVerification(w2.tenantId, w2.actor, handoverId, driverId, { originalsPresented: true, identityChecked: true, licensePresented: true, dataUnchanged: false, classSufficient: true, documentsValid: true }), /alle Punkte bestätigen/);
  const all = { originalsPresented: true, identityChecked: true, licensePresented: true, dataUnchanged: true, classSufficient: true, documentsValid: true };
  const row = await repeatVerification(w2.tenantId, w2.actor, handoverId, driverId, all);
  assert.deepEqual([row.status, row.checkKind, row.basedOnVerificationId, row.handoverId, row.contractDriverId, row.verifiedById, row.licenseClassesSnapshot, row.requiredLicenseClassSnapshot, row.licenseClassSatisfied, row.identityOriginalSeen, row.licenseOriginalSeen], ["CONFIRMED", "REPEAT", ref0.id, handoverId, driverId, w2.actor.id, ["B"], "B", true, true, true]);
  assert.ok(row.verifiedAt && row.contentHash && /Wiederholungsprüfung/.test(row.notes ?? ""));
  assert.notEqual(row.id, ref0.id);
  // alte Prüfung unverändert
  const ref1 = await db.driverVerification.findUniqueOrThrow({ where: { id: ref0.id } });
  assert.deepEqual({ ...ref1, updatedAt: null }, { ...ref0, updatedAt: null });
  // Blocker weg, Übergabe abschließbar; zweiter Klick liefert denselben Vermerk
  assert.deepEqual(await driverVerificationBlockers(w2.tenantId, handoverId), []);
  assert.equal((await repeatVerification(w2.tenantId, w2.actor, handoverId, driverId, all)).id, row.id);
  assert.equal(await db.driverVerification.count({ where: { tenantId: w.tenantId, handoverId } }), 1);
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "DRIVER_VERIFICATION_REPEATED", bookingId: w2.bookingId } }));
  await updateHandoverDraft(w2.tenantId, handoverId, { mileage: 45_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w2, handoverId, cat);
  await answerAll(w2, handoverId);
  await sign(w2, handoverId);
  await finalizeHandover(w2.tenantId, handoverId, w2.actor);
  // Fremdmandant sieht keine Referenz und kann nichts bestätigen
  const other = await createWorld("r3-repeat-other");
  tenants.push(other.tenantId);
  await assert.rejects(() => repeatVerification(other.tenantId, other.actor, handoverId, driverId, all), /nicht gefunden/);
});

test("Schnellbestätigung verweigert: falsche Fahrerlaubnisklasse, abgelaufener/ablaufender Führerschein, geänderte Kundenstammdaten, unbekannter Fahrer", async () => {
  const w = await returnedWorld("r3-repeat-block", { stopAfterPickup: true });
  tenants.push(w.tenantId);
  const ref = await db.driverVerification.findFirstOrThrow({ where: { tenantId: w.tenantId, status: "CONFIRMED" } });
  // Fahrzeug braucht C1: Referenz hat nur B
  const c1 = await secondRentalWithOpenPickup(w, "r3-c1", { requiredLicenseClass: "C1" });
  const ov = await driverVerificationOverview(w.tenantId, c1.handoverId);
  assert.equal(ov[0].repeat?.eligible, false);
  assert.match(ov[0].repeat?.reasons.join(" ") ?? "", /Fahrerlaubnisklasse C1 fehlt/);
  const all = { originalsPresented: true, identityChecked: true, licensePresented: true, dataUnchanged: true, classSufficient: true, documentsValid: true };
  await assert.rejects(() => repeatVerification(w.tenantId, w.actor, c1.handoverId, c1.driverId, all), /Schnellbestätigung nicht möglich.*C1/);
  assert.equal(await db.driverVerification.count({ where: { tenantId: w.tenantId, handoverId: c1.handoverId } }), 0, "kein Vermerk entstanden");
  // reine Regeln: abgelaufen / läuft vor Rückgabe ab / Name weicht ab / Klasse fehlt
  const driver = await db.contractDriver.findFirstOrThrow({ where: { id: c1.driverId } });
  const customer = { licenseNumber: ref.licenseNumberSnapshot, licenseValidUntil: ref.licenseValidUntilSnapshot };
  assert.deepEqual(repeatCheckReasons(ref, driver, "B", c1.bookingEnd, customer), []);
  assert.match(repeatCheckReasons(ref, driver, "B", c1.bookingEnd, customer, new Date("2040-01-01")).join(" "), /abgelaufen/);
  assert.match(repeatCheckReasons(ref, driver, "B", new Date("2040-01-01"), customer).join(" "), /vor der geplanten Rückgabe/);
  assert.match(repeatCheckReasons(ref, { ...driver, lastName: "Anders" }, "B", c1.bookingEnd, customer).join(" "), /Name oder Geburtsdatum/);
  assert.match(repeatCheckReasons(ref, driver, null, c1.bookingEnd, customer).join(" "), /keine erforderliche Fahrerlaubnisklasse/);
  assert.match(repeatCheckReasons(ref, driver, "B", c1.bookingEnd, { ...customer, licenseNumber: "X" }).join(" "), /Kundenstammdaten/);
  // Kundenstammdaten inzwischen geändert → Schnellbestätigung nicht mehr möglich, vollständige Prüfung bleibt der Weg
  await db.customer.update({ where: { id: w.customerId }, data: { licenseNumber: "NEU123456" } });
  const c2 = await secondRentalWithOpenPickup(w, "r3-changed");
  const ov2 = await driverVerificationOverview(w.tenantId, c2.handoverId);
  assert.equal(ov2[0].repeat?.eligible, false);
  assert.match(ov2[0].repeat?.reasons.join(" ") ?? "", /Führerscheinnummer im Vertrag|Kundenstammdaten/);
  await assert.rejects(() => repeatVerification(w.tenantId, w.actor, c2.handoverId, c2.driverId, all), /Schnellbestätigung nicht möglich/);
  // unbekannter Fahrer (neuer Kunde ohne frühere Prüfung): keine Referenz, alter Blocker-Text
  const fresh = await createWorld("r3-repeat-fresh");
  tenants.push(fresh.tenantId);
  const c = await signedContract(fresh);
  const h = await startHandover(fresh.tenantId, fresh.bookingId, "PICKUP", fresh.actor);
  assert.equal((await driverVerificationOverview(fresh.tenantId, h.id))[0].repeat, null);
  assert.match((await driverVerificationBlockers(fresh.tenantId, h.id))[0].message, /Identität und Führerschein sind noch nicht geprüft/);
  void c;
});

// ---------------------------------------------------------------------------
// 5. Zubehör-Kostenvorschläge
// ---------------------------------------------------------------------------

test("Zubehör: Vorschlag nur bei „Übergabe JA, Rückgabe NEIN“; Standard 20 €; Hutablage ohne Preis nur Hinweis; Nicht berechnen / Übernehmen genau einmal; Rechnung übernimmt nur Übernommenes", async () => {
  const w = await createWorld("r3-acc");
  tenants.push(w.tenantId);
  await withInvoiceSettings(w.tenantId);
  const c = await signedContract(w);
  // Übergabe: Verbandkasten fehlte schon, Rest vorhanden
  await pickup(w, c.id, { first_aid: "NO" });
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 50_300, fuelLevelEighths: 8 });
  await answerAll(w, r.id, { warning_triangle: "NO", safety_vest: "NO", first_aid: "NO", parcel_shelf: "NO" });
  let cmp = await getReturnComparison(w.tenantId, r.id);
  const keys = cmp.proposals.map((p) => p.key).sort();
  assert.deepEqual(keys, ["ACCESSORY_safety_vest", "ACCESSORY_warning_triangle"], "Verbandkasten fehlte schon bei Übergabe → kein Vorschlag; Hutablage ohne Preis → kein Vorschlag");
  for (const p of cmp.proposals) assert.deepEqual([p.draft.type, p.draft.amount, p.draft.quantity, p.confirmed, p.dismissed], ["MISSING_ACCESSORY", 20, 1, false, false]);
  assert.ok(cmp.hints.some((h) => h.code === "ACCESSORY_NO_PRICE_parcel_shelf" && /kein Ersatzpreis hinterlegt/.test(h.text)), "Hutablage: erkannt, kein erfundener Preis");
  assert.equal(await db.extraCharge.count({ where: { tenantId: w.tenantId, handoverId: r.id } }), 0, "das bloße Nein erzeugt keine Position");
  // Nicht berechnen: Warnweste
  await dismissProposal(w.tenantId, r.id, w.actor, "ACCESSORY_safety_vest");
  cmp = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp.proposals.find((p) => p.key === "ACCESSORY_safety_vest")?.dismissed, true);
  const completion = await getHandoverCompletionStatus(w.tenantId, r.id);
  assert.ok(!completion.warnings.some((x) => x.code === "PROPOSAL_OPEN_ACCESSORY_safety_vest"), "verworfener Vorschlag ist kein offener Punkt mehr");
  assert.ok(completion.warnings.some((x) => x.code === "PROPOSAL_OPEN_ACCESSORY_warning_triangle"));
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "RETURN_PROPOSAL_DISMISSED" } }));
  // Übernehmen: Warndreieck – Doppelklick erzeugt genau eine Position
  const results = await Promise.allSettled([confirmProposal(w.tenantId, r.id, w.actor.id, "ACCESSORY_warning_triangle"), confirmProposal(w.tenantId, r.id, w.actor.id, "ACCESSORY_warning_triangle")]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(String((results.find((x) => x.status === "rejected") as PromiseRejectedResult).reason?.message), /bereits bestätigt/);
  const charges = await db.extraCharge.findMany({ where: { tenantId: w.tenantId, handoverId: r.id } });
  assert.equal(charges.length, 1);
  assert.deepEqual([charges[0].type, Number(charges[0].amount), charges[0].source, (charges[0].calculation as { accessoryKey: string }).accessoryKey], ["MISSING_ACCESSORY", 20, "PROPOSAL", "warning_triangle"]);
  cmp = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp.proposals.find((p) => p.key === "ACCESSORY_warning_triangle")?.confirmed, true);
  await assert.rejects(() => dismissProposal(w.tenantId, r.id, w.actor, "ACCESSORY_warning_triangle"), /bereits als Position übernommen/);
  // Rückgabe abschließen, Rechnung: nur die übernommene Position
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, r.id, cat);
  await sign(w, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const st = await getInvoiceState(w.tenantId, inv.id);
  const descs = st.draft!.items.map((i) => i.description);
  assert.ok(descs.some((d) => /Warndreieck/.test(d)));
  assert.ok(!descs.some((d) => /Warnweste|Verbandkasten|Hutablage/.test(d)));
});

test("Hutablage: fahrzeugbezogener Ersatzpreis aus den Geschäftsregeln (Fahrzeug A ≠ Fahrzeug B), im Vertrag eingefroren; ohne Preis kein Betrag", async () => {
  // reine Preisauflösung
  const shelf = ACCESSORY_ITEMS.find((a) => a.key === "parcel_shelf")!;
  assert.deepEqual(accessoryPrice(shelf, { parcelShelfReplacementCents: 15_000 }, { parcelShelfReplacementCents: 28_000 }), { cents: 15_000, origin: "CONTRACT" });
  assert.deepEqual(accessoryPrice(shelf, {}, { parcelShelfReplacementCents: 28_000 }), { cents: 28_000, origin: "VEHICLE" }, "älterer Vertrag ohne die Regel: aktuelle Fahrzeugregel");
  assert.deepEqual(accessoryPrice(shelf, { parcelShelfReplacementCents: null }, { parcelShelfReplacementCents: 28_000 }), { cents: null, origin: "NONE" }, "Vertrag kennt die Regel und hat keinen Preis → keiner");
  assert.deepEqual(accessoryPrice(ACCESSORY_ITEMS[0], null, null), { cents: 2_000, origin: "STANDARD" });
  assert.deepEqual(missingAccessories([{ itemKey: "parcel_shelf", result: "NA" }], [{ itemKey: "parcel_shelf", result: "NO" }], () => ({ cents: 1, origin: "STANDARD" })), [], "„Nicht zutreffend“ bei Übergabe ist kein Nachweis");
  assert.deepEqual(missingAccessories([{ itemKey: "parcel_shelf", result: "YES" }], [{ itemKey: "parcel_shelf", result: "NA" }], () => ({ cents: 1, origin: "STANDARD" })), []);
  // Fahrzeug A mit 150 €: Vorschlag 150 €
  const w = await createWorld("r3-shelf");
  tenants.push(w.tenantId);
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { businessRules: { parcelShelfReplacementCents: 15_000 } } });
  const c = await signedContract(w);
  await pickup(w, c.id);
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 50_200, fuelLevelEighths: 8 });
  await answerAll(w, r.id, { parcel_shelf: "NO" });
  const cmp = await getReturnComparison(w.tenantId, r.id);
  const p = cmp.proposals.find((x) => x.key === "ACCESSORY_parcel_shelf");
  assert.deepEqual([p?.draft.amount, p?.draft.type, (p?.draft.calculation as { priceOrigin?: string })?.priceOrigin], [150, "MISSING_ACCESSORY", "CONTRACT"]);
  // Gruppe 280 €, Fahrzeug B ohne eigenen Wert → 280 € (Fahrzeug → Gruppe → Mandant)
  const wb = await createWorld("r3-shelf-b");
  tenants.push(wb.tenantId);
  await db.vehicleGroup.update({ where: { id: wb.groupId }, data: { businessRules: { parcelShelfReplacementCents: 28_000 } } });
  const cb = await signedContract(wb);
  await pickup(wb, cb.id);
  const rb = await startHandover(wb.tenantId, wb.bookingId, "RETURN", wb.actor);
  await updateHandoverDraft(wb.tenantId, rb.id, { mileage: 50_200, fuelLevelEighths: 8 });
  await answerAll(wb, rb.id, { parcel_shelf: "NO" });
  assert.equal((await getReturnComparison(wb.tenantId, rb.id)).proposals.find((x) => x.key === "ACCESSORY_parcel_shelf")?.draft.amount, 280);
  // spätere Preisänderung am Fahrzeug ändert den laufenden Vertrag nicht
  await db.vehicle.update({ where: { id: wb.vehicleId }, data: { businessRules: { parcelShelfReplacementCents: 99_900 } } });
  assert.equal((await getReturnComparison(wb.tenantId, rb.id)).proposals.find((x) => x.key === "ACCESSORY_parcel_shelf")?.draft.amount, 280);
});

// ---------------------------------------------------------------------------
// 6. Kautionsverrechnung auf der Rechnungsseite (bestehender DEPOSIT_OFFSET-Vorgang)
// ---------------------------------------------------------------------------

async function invoiceWorld(label: string, gross: string, opts: { received?: string | null; paid?: string | null } = {}) {
  const w = await returnedWorld(label);
  tenants.push(w.tenantId);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const st = await getInvoiceState(w.tenantId, inv.id);
  const items = st.draft!.items;
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: items[0].id, description: items[0].description, quantity: "1", unit: "pauschal", unitPrice: gross, taxRate: "19" }] });
  await finalizeInvoice(w.tenantId, inv.id, w.actor);
  if (opts.received !== null) await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: opts.received ?? "500", method: "CASH", occurredAt: at });
  if (opts.paid) await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: opts.paid, method: "CASH", paidAt: at });
  return { w, invoiceId: inv.id };
}

test("A) Rechnung 320, bezahlt 45, offen 275, Kaution 500 → Vorschlag 275, danach offen 0, Kaution 225 zur Freigabe", async () => {
  const { w, invoiceId } = await invoiceWorld("r3-off-a", "320", { paid: "45" });
  const pv = await previewDepositOffset(w.tenantId, w.bookingId, invoiceId, null);
  assert.deepEqual([pv.openCents, pv.availableCents, pv.suggestedCents, pv.amountCents, pv.claimAfterCents, pv.depositAfterCents, pv.invoiceStatusAfter, pv.error], [27_500, 50_000, 27_500, 27_500, 0, 22_500, "PAID", null]);
  const r = await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: null, occurredAt: at, idempotencyKey: "r3-off-a-1" });
  assert.deepEqual([r.created, r.payment.amountCents, r.payment.type], [true, 27_500, "DEPOSIT_OFFSET"]);
  const s = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s.openCents, s.paidCents, s.offsetCents, s.status], [0, 32_000, 27_500, "PAID"]);
  const v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.offsetCents, v.remainingCents, v.releasedCents], [27_500, 22_500, 0]);
  // Verrechnung und Freigabe bleiben getrennt: erst jetzt bewusst 225 freigeben, dann auszahlbar 225
  const rel = await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "225", method: "CASH", occurredAt: at });
  assert.deepEqual([rel.kind, rel.events[0].amountCents], ["RELEASE", 22_500]);
  assert.equal((await payoutSource(db, w.tenantId, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId })).remainingCents, 22_500);
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId, invoiceId, method: { in: ["CASH", "CARD", "BANK_TRANSFER", "OTHER"] } } }), 1, "kein neuer Geldeingang durch die Verrechnung");
});

test("B) offen 700, Kaution 500 → höchstens 500 verrechenbar, Rechnung 200 offen, Kaution 0", async () => {
  const { w, invoiceId } = await invoiceWorld("r3-off-b", "700");
  const pv = await previewDepositOffset(w.tenantId, w.bookingId, invoiceId, null);
  assert.deepEqual([pv.suggestedCents, pv.claimAfterCents, pv.depositAfterCents, pv.invoiceStatusAfter], [50_000, 20_000, 0, "PARTIAL"]);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "500,01", occurredAt: at }), /Verfügbar sind nur 500,00/);
  await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: null, occurredAt: at });
  assert.deepEqual([(await invoicePaymentSummary(w.tenantId, invoiceId)).openCents, (await depositView(w.tenantId, w.bookingId)).remainingCents], [20_000, 0]);
  assert.match((await depositOffsetOptions(w.tenantId, w.bookingId)).blockedReason ?? "", /vollständig freigegeben, einbehalten oder verrechnet/);
});

test("C) offene Forderung 0, Kaution 500 → keine Verrechnung angeboten, 500 bleiben für Freigabe/Auszahlung", async () => {
  const { w, invoiceId } = await invoiceWorld("r3-off-c", "300", { paid: "300" });
  const o = await depositOffsetOptions(w.tenantId, w.bookingId);
  assert.deepEqual([o.blockedReason, o.availableCents, o.invoices.length], ["Zu dieser Buchung gibt es keine offene Forderung.", 50_000, 0]);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, occurredAt: at }), /vollständig bezahlt|nichts zu verrechnen/);
  const rel = await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "500", method: "CASH", occurredAt: at });
  assert.equal(rel.events[0].amountCents, 50_000);
});

test("D) teilweise verbrauchte Kaution: Einbehalt 100 und Verrechnung 150 → nur der Rest 250 verwendbar; parallel nie mehr als verfügbar; Fremdmandant abgelehnt", async () => {
  const { w, invoiceId } = await invoiceWorld("r3-off-d", "900");
  await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "400", reason: "Prüfung Kratzer", occurredAt: at }); // 400 frei, 100 einbehalten
  const released = await db.securityDepositEvent.findFirstOrThrow({ where: { tenantId: w.tenantId, type: "RELEASED" } });
  const { cancelDepositEvent } = await import("../src/lib/deposits");
  await cancelDepositEvent(w.tenantId, w.actor, released.id, "doch verrechnen"); // 400 wieder verfügbar, 100 bleibt einbehalten
  await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "150", occurredAt: at });
  const pv = await previewDepositOffset(w.tenantId, w.bookingId, invoiceId, null);
  assert.deepEqual([pv.retainedCents, pv.offsetCents, pv.availableCents, pv.suggestedCents], [10_000, 15_000, 25_000, 25_000]);
  // zwei parallele Verrechnungen über 200 + 200 bei 250 Rest: genau eine gewinnt
  const results = await Promise.allSettled([
    applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "200", occurredAt: at }),
    applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "200", occurredAt: at }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await depositView(w.tenantId, w.bookingId)).remainingCents, 5_000);
  // Fremdmandant
  const other = await createWorld("r3-off-other");
  tenants.push(other.tenantId);
  await assert.rejects(() => applyDepositOffset(other.tenantId, other.actor, { bookingId: w.bookingId, invoiceId, occurredAt: at }), /nicht gefunden/);
  await assert.rejects(() => previewDepositOffset(other.tenantId, w.bookingId, invoiceId, null), /nicht gefunden/);
});

// ---------------------------------------------------------------------------
// 7. Rollen (serverseitig in den Aktionen) – Quelltextprüfung wie in deposit-offset.test
// ---------------------------------------------------------------------------

test("Rollen: Storno und Verrechnung nur Inhaber/Disposition; Wiederholungsprüfung und Vorschläge auch Hofmitarbeiter; Kaution bei Buchung nur mit Buchungsrecht", () => {
  const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  const fin = src("src/app/(app)/buchungen/[id]/finanzen/actions.ts");
  for (const fn of ["cancelPaymentAction", "applyDepositOffsetAction", "settleDepositAction"]) assert.match(fin.slice(fin.indexOf(`export async function ${fn}`), fin.indexOf(`export async function ${fn}`) + 400), /requireRole\("DISPO"\)/, fn);
  const drv = src("src/app/(app)/buchungen/[id]/uebergabe/driver-actions.ts");
  assert.match(drv.slice(drv.indexOf("export async function repeatDriverVerificationAction")), /requireRole\("DISPO", "YARD"\)/);
  const ret = src("src/app/(app)/buchungen/[id]/rueckgabe/actions.ts");
  assert.match(ret, /async function context[\s\S]*requireRole\("DISPO", "YARD"\)/);
  assert.match(ret.slice(ret.indexOf("export async function dismissProposalAction")), /await context\(bookingId\)/);
  const bk = src("src/app/(app)/buchungen/actions.ts");
  assert.match(bk.slice(bk.indexOf("export async function createBookingAction"), bk.indexOf("export async function createBookingAction") + 300), /requireRole\("DISPO"\)/);
  assert.match(bk, /insertDepositReceived\(tx, tenant\.id/, "Kautionseingang läuft in derselben Transaktion wie die Buchung");
});
