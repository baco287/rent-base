// Befehl 21 (Praxistest-Runde 4): Kautionsanzeige nur aus echten Bewegungen, Prozess-Aktionen (Übergabe/Rückgabe),
// Abholort und Standard-Kilometerregel, Fahrerprüfung in einem Vorgang (Klasse/Ablauf weiterhin serverseitig),
// Live-Regeln km/Tank/Batterie, kompakte Protokollskizze, Zubehörpreise, und vor allem: Rechnungsabschluss mit bewusst
// bestätigter Kautionsverrechnung als EIN atomarer Vorgang (140 € Rechnung, 45 € Mietzahlung, 500 € Kaution → 95 €).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { ACCESSORY_ITEMS, accessoryPrice } from "../src/lib/accessories";
import { pickupAction, returnAction } from "../src/lib/booking-status";
import { initialContractRules, resolveRules } from "../src/lib/business-rules";
import { ensureContractDraft, finalizeContract, getContractContentHash, getContractState, saveConditions, saveContractSignature, standardKmPolicy } from "../src/lib/contracts";
import { DEPOSIT_RECEIPT_LABELS, depositReceiptState, depositView, recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { driverVerificationBlockers, driverVerificationOverview, repeatVerification, verifyDriverInOneStep } from "../src/lib/driver-verification";
import { startHandover } from "../src/lib/handovers";
import { depositOffsetStart, finalizeInvoiceWithDepositOffset } from "../src/lib/invoice-settlement";
import { ensureInvoiceDraft, finalizeInvoice, getInvoiceState, updateInvoiceDraft, verifyInvoice } from "../src/lib/invoices";
import { invoicePaymentSummary } from "../src/lib/payments";
import { payoutSource } from "../src/lib/payouts";
import { recordRentalPayment, rentalPaymentSummary } from "../src/lib/rental-payments";
import { isBatteryInputValid, isFuelInputValid, isMileageInputValid } from "../src/lib/readings-live";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});
const at = new Date(Date.now() - 60_000);
const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

async function conditionsOf(w: World, contractId: string, extra: Record<string, unknown> = {}) {
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  return saveConditions(w.tenantId, contractId, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof", ...extra });
}
async function signAndFinalize(w: World, contractId: string) {
  await saveContractSignature(w.tenantId, w.actor, contractId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, contractId) });
  return finalizeContract(w.tenantId, contractId);
}

// ---------------------------------------------------------------------------
// A. Kaution auf der Buchung: nur reale Werte
// ---------------------------------------------------------------------------

test("Kautionsanzeige: „erhalten“ nur aus dokumentierten Bewegungen – nichts, teilweise, vollständig; vor dem Vertrag nur „vereinbart laut Buchung“", async () => {
  assert.deepEqual([depositReceiptState(50_000, 0), depositReceiptState(50_000, 20_000), depositReceiptState(50_000, 50_000), depositReceiptState(0, 0)], ["NOT_RECEIVED", "PARTIALLY_RECEIVED", "RECEIVED", "NONE_AGREED"]);
  assert.deepEqual([DEPOSIT_RECEIPT_LABELS.NOT_RECEIVED, DEPOSIT_RECEIPT_LABELS.PARTIALLY_RECEIVED, DEPOSIT_RECEIPT_LABELS.RECEIVED], ["Noch nicht erhalten", "Teilweise erhalten", "Erhalten"]);
  const w = await createWorld("r4-dep");
  tenants.push(w.tenantId);
  // Buchung mit 500 € Kaution, kein Vertrag, keine Bewegung: niemals „erhalten“
  let v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.bookingDepositCents, v.receivedCents, v.deposit, v.contractSigned], [50_000, 0, null, false]);
  assert.equal(depositReceiptState(v.bookingDepositCents, v.receivedCents), "NOT_RECEIVED");
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await conditionsOf(w, c.id);
  await signAndFinalize(w, c.id);
  // Vertrag unterschrieben, Kaution vereinbart – weiterhin nichts erhalten (kein Betrag aus dem Vertrag abgeleitet)
  v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.expectedCents, v.receivedCents, v.events.length], [50_000, 0, 0]);
  assert.equal(depositReceiptState(v.expectedCents, v.receivedCents), "NOT_RECEIVED");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "200", method: "CASH", occurredAt: at });
  v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.expectedCents, v.receivedCents, v.expectedCents - v.receivedCents, depositReceiptState(v.expectedCents, v.receivedCents)], [50_000, 20_000, 30_000, "PARTIALLY_RECEIVED"]);
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "300", method: "CARD", occurredAt: at });
  v = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([v.receivedCents, v.expectedCents - v.receivedCents, depositReceiptState(v.expectedCents, v.receivedCents)], [50_000, 0, "RECEIVED"]);
  // Kaution ist keine Mietzahlung
  assert.equal((await rentalPaymentSummary(w.tenantId, w.bookingId)).paidCents, 0);
  const overview = src("src/app/(app)/buchungen/[id]/finanzen/money-overview.tsx");
  assert.match(overview, /tile\("Vereinbart", agreedCents\)[\s\S]*tile\("Erhalten", dep\.receivedCents, "good"\)[\s\S]*tile\("Noch offen", depositOpen, "bad"\)/);
  assert.match(overview, /href="#kaution"/);
});

// ---------------------------------------------------------------------------
// B/D/H. Prozess-Aktionen
// ---------------------------------------------------------------------------

test("Prozess-Aktionen: Vertrag fehlt → deutliche Aktion; nach Vertragsabschluss Übergabe starten, Entwurf fortsetzen, nach Abschluss keine Startaktion; Rückgabe starten/fortsetzen nur bei laufender Miete", async () => {
  const signed = { status: "SIGNED" };
  assert.deepEqual(pickupAction({ status: "RESERVED" }, null, []).kind, "NONE");
  assert.deepEqual(pickupAction({ status: "RESERVED" }, { status: "DRAFT" }, []).kind, "NONE");
  assert.deepEqual(pickupAction({ status: "RESERVED" }, signed, []), { kind: "START", label: "Übergabe starten" });
  assert.deepEqual(pickupAction({ status: "RESERVED" }, signed, [{ type: "PICKUP", status: "DRAFT" }]), { kind: "CONTINUE", label: "Übergabe fortsetzen" });
  assert.deepEqual(pickupAction({ status: "ACTIVE" }, signed, [{ type: "PICKUP", status: "FINALIZED" }]).kind, "VIEW", "abgeschlossene Übergabe: kein „starten“");
  assert.deepEqual(returnAction({ status: "ACTIVE" }, signed, [{ type: "PICKUP", status: "FINALIZED" }]), { kind: "START", label: "Rückgabe starten" });
  assert.deepEqual(returnAction({ status: "ACTIVE" }, signed, [{ type: "PICKUP", status: "FINALIZED" }, { type: "RETURN", status: "DRAFT" }]), { kind: "CONTINUE", label: "Rückgabe fortsetzen" });
  assert.equal(returnAction({ status: "ACTIVE" }, signed, []).kind, "NONE", "ohne Übergabeprotokoll keine Rückgabe");
  assert.equal(returnAction({ status: "RESERVED" }, signed, []).kind, "NONE");
  assert.equal(returnAction({ status: "RETURNED" }, signed, [{ type: "PICKUP", status: "FINALIZED" }, { type: "RETURN", status: "FINALIZED" }]).kind, "VIEW");
  assert.equal(returnAction({ status: "CANCELLED" }, signed, []).kind, "NONE");
  // echte Daten: Übergabe zweimal gestartet → derselbe Entwurf, kein Duplikat
  const w = await createWorld("r4-cta");
  tenants.push(w.tenantId);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await conditionsOf(w, c.id);
  await signAndFinalize(w, c.id);
  const load = async () => { const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId }, include: { contract: { select: { status: true } }, handovers: { where: { correctsId: null }, select: { type: true, status: true } } } }); return pickupAction(b, b.contract, b.handovers); };
  assert.equal((await load()).kind, "START");
  const h1 = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  const h2 = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  assert.equal(h1.id, h2.id);
  assert.equal(await db.handover.count({ where: { tenantId: w.tenantId, bookingId: w.bookingId, type: "PICKUP" } }), 1);
  assert.equal((await load()).kind, "CONTINUE");
  // Oberfläche: deutliche Aktionen an den richtigen Stellen
  const bookingPage = src("src/app/(app)/buchungen/[id]/page.tsx");
  assert.match(bookingPage, /title: "Mietvertrag fehlt"[\s\S]*Mietvertrag erstellen/);
  assert.match(bookingPage, /aria-label="Nächster Schritt"/);
  const contractPage = src("src/app/(app)/buchungen/[id]/vertrag/page.tsx");
  assert.match(contractPage, /Jetzt auf dem Tablet mit der Übergabe weitermachen/);
  assert.match(contractPage, /next\.kind === "CONTINUE"[\s\S]*Übergabe fortsetzen[\s\S]*startPickupAction\.bind\(null, booking\.id\)/);
  const list = src("src/app/(app)/buchungen/page.tsx");
  assert.match(list, /returnAction\(b, b\.contract, b\.handovers\)/);
  assert.match(list, /href: `\/buchungen\/\$\{b\.id\}\/rueckgabe`/);
  const ret = src("src/app/(app)/buchungen/[id]/rueckgabe/page.tsx");
  assert.equal((ret.match(/Für die Fahrzeugrückgabe am besten auf dem Tablet weitermachen\./g) ?? []).length, 2, "Startseite und Schritt 1");
  assert.match(ret, /Rückgabe abgeschlossen\. Die Rechnung wird anschließend am PC geprüft und finalisiert\./);
});

// ---------------------------------------------------------------------------
// C. Vertrag Schritt 4: Abholort und Kilometerregel
// ---------------------------------------------------------------------------

test("Abholort: neuer Vertrag trägt die Anschrift des Vermieters – kein falscher Hinweis; ohne jede Angabe bleibt der Hinweis", async () => {
  const w = await createWorld("r4-pickup");
  tenants.push(w.tenantId);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(c.pickupLocation, "Hafenstr. 1, Bremen");
  let s = await getContractState(w.tenantId, c.id);
  assert.ok(!s.issues.some((i) => i.code === "PICKUP_LOCATION"), "Abholort vorhanden → kein Hinweis");
  // bestehender Entwurf ohne Abholort (Altbestand): wird beim Auffrischen ergänzt
  await db.rentalContract.update({ where: { id: c.id }, data: { pickupLocation: null } });
  s = await getContractState(w.tenantId, c.id);
  assert.equal(s.contract.pickupLocation, "Hafenstr. 1, Bremen");
  assert.ok(!s.issues.some((i) => i.code === "PICKUP_LOCATION"));
  // Vermieter ohne Anschrift und ohne Eingabe: der Hinweis erscheint weiterhin (echter Mangel)
  const n = await createWorld("r4-pickup-none");
  tenants.push(n.tenantId);
  await db.tenant.update({ where: { id: n.tenantId }, data: { street: null, city: null } });
  const cn = await ensureContractDraft(n.tenantId, n.bookingId, n.actor);
  assert.equal(cn.pickupLocation, null);
  assert.ok((await getContractState(n.tenantId, cn.id)).issues.some((i) => i.code === "PICKUP_LOCATION" && i.severity === "warning"));
});

test("Kilometerregel: geerbte „individuelle Regel“ blockiert den Standardfall nicht mehr; bewusst individuell gewählt braucht weiterhin die Beschreibung", async () => {
  // reine Regel
  const resolved = resolveRules({ kmPolicy: "INDIVIDUAL" }, null, null);
  const inherited = initialContractRules(resolved);
  assert.deepEqual([inherited.values.kmPolicy, inherited.sources.kmPolicy], ["INDIVIDUAL", "TENANT"]);
  const std = standardKmPolicy(inherited, { kmIncludedPerDay: 200, extraKmRate: 0.25 });
  assert.deepEqual([std.values.kmPolicy, std.sources.kmPolicy], ["FREE_KILOMETERS", "BOOKING"]);
  assert.equal(standardKmPolicy(inherited, { kmIncludedPerDay: null, extraKmRate: null }).sources.kmPolicy, "VEHICLE");
  const chosen = { ...inherited, sources: { ...inherited.sources, kmPolicy: "CONTRACT" as const } };
  assert.equal(standardKmPolicy(chosen, { kmIncludedPerDay: 200, extraKmRate: 0.25 }).values.kmPolicy, "INDIVIDUAL", "bewusste Wahl im Vertrag bleibt");
  const described = { ...inherited, values: { ...inherited.values, kmPolicyNote: "1.000 km pauschal" } };
  assert.equal(standardKmPolicy(described, { kmIncludedPerDay: 200, extraKmRate: 0.25 }).values.kmPolicy, "INDIVIDUAL");
  // Mandant mit Standard „individuell“ (wie im Praxistest): neuer Vertrag ist sofort abschließbar
  const w = await createWorld("r4-km");
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { kmPolicy: "INDIVIDUAL" } } });
  await db.booking.update({ where: { id: w.bookingId }, data: { kmIncludedPerDay: 150, extraKmRate: 0.3 } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  let s = await getContractState(w.tenantId, c.id);
  assert.deepEqual([s.rules.snapshot?.values.kmPolicy, s.rules.snapshot?.sources.kmPolicy, s.contract.kmIncludedPerDay], ["FREE_KILOMETERS", "BOOKING", 150]);
  assert.ok(!s.issues.some((i) => /Kilometerregel/.test(i.message)), "keine Freitext-Blockade im Standardfall");
  // bewusst „individuell“ ohne Beschreibung: Blockade bleibt, Abschluss scheitert
  await conditionsOf(w, c.id, { kmIncludedPerDay: 150, extraKmRate: 0.3, rules: { kmPolicy: "INDIVIDUAL", kmPolicyNote: null } });
  s = await getContractState(w.tenantId, c.id);
  assert.ok(s.issues.some((i) => i.severity === "error" && /individuelle Kilometerregel beschreiben/.test(i.message)));
  await assert.rejects(() => signAndFinalize(w, c.id), /Kilometerregel/);
  // mit Beschreibung abschließbar
  await conditionsOf(w, c.id, { kmIncludedPerDay: 150, extraKmRate: 0.3, rules: { kmPolicy: "INDIVIDUAL", kmPolicyNote: "1.000 km pauschal, danach 0,30 €" } });
  const done = await signAndFinalize(w, c.id);
  assert.equal(done.status, "SIGNED");
  // Bestandsvertrag eines anderen Mandanten bleibt unberührt (versiegelt)
  const other = await returnedWorld("r4-km-sealed", { stopAfterPickup: true });
  tenants.push(other.tenantId);
  const sealed = await db.rentalContract.findFirstOrThrow({ where: { tenantId: other.tenantId } });
  await db.tenant.update({ where: { id: other.tenantId }, data: { businessRules: { kmPolicy: "INDIVIDUAL" } } });
  await getContractState(other.tenantId, sealed.id);
  const again = await db.rentalContract.findUniqueOrThrow({ where: { id: sealed.id } });
  assert.deepEqual([again.contentHash, JSON.stringify(again.conditions)], [sealed.contentHash, JSON.stringify(sealed.conditions)]);
});

// ---------------------------------------------------------------------------
// E. Fahrerprüfung in einem Vorgang
// ---------------------------------------------------------------------------

const licence = { documentType: "PERSONALAUSWEIS", licenseNumber: "B072RRE2I55", licenseCountry: "DE", licenseIssuedAt: new Date("2005-06-01"), licenseValidUntil: new Date("2033-06-01"), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false };

async function openPickup(label: string, vehicle: Record<string, unknown> = {}) {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  if (Object.keys(vehicle).length) await db.vehicle.update({ where: { id: w.vehicleId }, data: vehicle });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await conditionsOf(w, c.id);
  await signAndFinalize(w, c.id);
  const h = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  const driver = await db.contractDriver.findFirstOrThrow({ where: { tenantId: w.tenantId, contractId: c.id, role: "PRIMARY_DRIVER" } });
  return { w, handoverId: h.id, driverId: driver.id, contractId: c.id };
}

test("Fahrerprüfung: ein Vorgang speichert Identität, Führerschein und Bestätigung – mit Audit; Klasse und Ablauf werden weiterhin serverseitig geprüft", async () => {
  const { w, handoverId, driverId } = await openPickup("r4-driver");
  assert.match((await driverVerificationBlockers(w.tenantId, handoverId))[0].message, /Identität und Führerschein sind noch nicht geprüft/);
  const res = await verifyDriverInOneStep(w.tenantId, w.actor, handoverId, driverId, licence);
  assert.equal(res.confirmed, true);
  const r = res.row;
  assert.deepEqual([r.status, r.checkKind, r.identityOriginalSeen, r.identityNameMatched, r.identityBirthDateMatched, r.licenseOriginalSeen, r.licenseDocumentValid, r.licenseNameMatched, r.licenseClassSatisfied, r.requiredLicenseClassSnapshot, r.verifiedById, r.identityCheckedById, r.licenseCheckedById], ["CONFIRMED", "FULL", true, true, true, true, true, true, true, "B", w.actor.id, w.actor.id, w.actor.id]);
  assert.ok(r.verifiedAt && r.contentHash);
  assert.deepEqual(await driverVerificationBlockers(w.tenantId, handoverId), []);
  const actions = (await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { startsWith: "DRIVER_" } }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
  assert.deepEqual(actions, ["DRIVER_VERIFICATION_STARTED", "DRIVER_IDENTITY_VERIFIED", "DRIVER_LICENSE_VERIFIED", "DRIVER_VERIFICATION_COMPLETED"], "derselbe Nachweis wie bei der schrittweisen Prüfung");
  // zweiter Klick: derselbe Vermerk, nichts doppelt
  assert.equal((await verifyDriverInOneStep(w.tenantId, w.actor, handoverId, driverId, licence)).row.id, r.id);
  assert.equal(await db.driverVerification.count({ where: { tenantId: w.tenantId, handoverId } }), 1);
  assert.equal(await db.driverDocumentCopy.count({ where: { tenantId: w.tenantId } }), 0, "Dokumentkopien bleiben freiwillig");

  // falsche Klasse: wird nicht bestätigt, Vermerk blockiert, Übergabe bleibt gesperrt
  const c1 = await openPickup("r4-driver-class", { requiredLicenseClass: "C1" });
  const bad = await verifyDriverInOneStep(c1.w.tenantId, c1.w.actor, c1.handoverId, c1.driverId, licence);
  assert.deepEqual([bad.confirmed, bad.row.status, bad.blockers.includes("LICENSE_CLASS_INSUFFICIENT")], [false, "BLOCKED", true]);
  assert.match((await driverVerificationBlockers(c1.w.tenantId, c1.handoverId))[0].message, /blockiert/);
  // abgelaufener Führerschein: wird nicht bestätigt; mit gültigen Daten danach schon
  const ex = await openPickup("r4-driver-expired");
  const expired = await verifyDriverInOneStep(ex.w.tenantId, ex.w.actor, ex.handoverId, ex.driverId, { ...licence, licenseValidUntil: new Date(Date.now() - 86_400_000), deviationConfirmed: true });
  assert.deepEqual([expired.confirmed, expired.blockers.includes("LICENSE_EXPIRED")], [false, true]);
  const ok = await verifyDriverInOneStep(ex.w.tenantId, ex.w.actor, ex.handoverId, ex.driverId, licence);
  assert.deepEqual([ok.confirmed, ok.row.status, ok.row.blockedReasons], [true, "CONFIRMED", []]);
  // fremder Mandant
  const other = await createWorld("r4-driver-other");
  tenants.push(other.tenantId);
  await assert.rejects(() => verifyDriverInOneStep(other.tenantId, other.actor, handoverId, driverId, licence), /nicht gefunden/);
  // Oberfläche: kein eigenes Häkchen „Original vorgelegt“, kein Pflichtschritt „Führerschein speichern“ im Normalablauf
  const forms = src("src/app/(app)/buchungen/[id]/uebergabe/driver-forms.tsx");
  assert.ok(!/type="checkbox" name="originalSeen"/.test(forms), "kein redundantes Ankreuzfeld");
  assert.match(forms, /Originale geprüft – Prüfung bestätigen/);
  const actionsSrc = src("src/app/(app)/buchungen/[id]/uebergabe/driver-actions.ts");
  assert.match(actionsSrc.slice(actionsSrc.indexOf("export async function verifyDriverAction")), /requireRole\("DISPO", "YARD"\)[\s\S]*verifyDriverInOneStep/);
});

test("Wiederholungsprüfung (20.9) bleibt: Referenz aus der Ein-Schritt-Prüfung, eigener Vermerk je Übergabe, alte Prüfung unverändert", async () => {
  const first = await openPickup("r4-repeat");
  const ref = (await verifyDriverInOneStep(first.w.tenantId, first.w.actor, first.handoverId, first.driverId, licence)).row;
  // zweite Miete desselben Kunden
  const w = first.w;
  const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-R4 ${Date.now().toString(36).slice(-4)}`, make: "VW", model: "Crafter", groupId: w.groupId, fuel: "DIESEL", mileage: 45_000, dailyRate: 89, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 500, tankCapacityLiters: 75, requiredLicenseClass: "B" } });
  const start = new Date(Date.now() + 2 * 86_400_000);
  const b2 = await db.booking.create({ data: { tenantId: w.tenantId, number: `T-r4-${Date.now().toString(36)}`, vehicleId: v2.id, customerId: w.customerId, startAt: start, endAt: new Date(start.getTime() + 3 * 86_400_000), dailyRate: 89, deposit: 500 } });
  const w2: World = { ...w, vehicleId: v2.id, bookingId: b2.id };
  const c2 = await ensureContractDraft(w2.tenantId, w2.bookingId, w2.actor);
  await conditionsOf(w2, c2.id);
  await signAndFinalize(w2, c2.id);
  const h2 = await startHandover(w2.tenantId, w2.bookingId, "PICKUP", w2.actor);
  const d2 = await db.contractDriver.findFirstOrThrow({ where: { tenantId: w.tenantId, contractId: c2.id, role: "PRIMARY_DRIVER" } });
  const ov = await driverVerificationOverview(w.tenantId, h2.id);
  assert.deepEqual([ov[0].repeat?.eligible, ov[0].repeat?.verificationId], [true, ref.id]);
  const row = await repeatVerification(w.tenantId, w.actor, h2.id, d2.id, { originalsPresented: true, identityChecked: true, licensePresented: true, dataUnchanged: true, classSufficient: true, documentsValid: true });
  assert.deepEqual([row.status, row.checkKind, row.basedOnVerificationId, row.verifiedById], ["CONFIRMED", "REPEAT", ref.id, w.actor.id]);
  const refAfter = await db.driverVerification.findUniqueOrThrow({ where: { id: ref.id } });
  assert.deepEqual({ ...refAfter, updatedAt: null }, { ...ref, updatedAt: null });
  assert.ok(await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "DRIVER_VERIFICATION_REPEATED" } }), "wer wann welches Original gesehen hat, bleibt nachvollziehbar");
});

// ---------------------------------------------------------------------------
// F/G/J. Live-Regeln, Protokollskizze, Zubehörpreise
// ---------------------------------------------------------------------------

test("Live-Hinweise km/Tank/Batterie: gültige Eingabe blendet sofort aus, leere/ungültige nicht; Skizze im Protokoll kompakt; Zubehör 20/20/20, Hutablage ohne Pauschale", () => {
  assert.deepEqual(["50100", "50.100", " 7 ", "0"].map(isMileageInputValid), [true, true, true, true]);
  assert.deepEqual(["", "  ", "abc", "50,5", "-3", undefined, null].map((v) => isMileageInputValid(v as string)), [false, false, false, false, false, false, false]);
  assert.deepEqual(["0", "4", "8"].map(isFuelInputValid), [true, true, true]);
  assert.deepEqual(["", "9", undefined].map((v) => isFuelInputValid(v as string)), [false, false, false]);
  assert.deepEqual(["0", "80", "100"].map(isBatteryInputValid), [true, true, true]);
  assert.deepEqual(["", "101", "8o", "-1"].map(isBatteryInputValid), [false, false, false, false]);
  const live = src("src/app/(app)/buchungen/[id]/uebergabe/readings-issues.tsx");
  assert.match(live, /document\.addEventListener\("input", evaluate\)[\s\S]*document\.addEventListener\("change", evaluate\)/, "reagiert auf jede Eingabe, ohne Speichern");
  assert.match(src("src/app/(app)/buchungen/[id]/uebergabe/page.tsx"), /<ReadingsIssueList issues=\{issues\.filter\(\(i\) => i\.area === "READINGS"\)\} watch=\{\["mileage"/);
  // Protokollskizze
  assert.match(src("src/app/(app)/buchungen/[id]/uebergabe/handover-parts.tsx"), /<DamageMap sketch=\{doc\.sketch\} damages=\{doc\.damages\} handoverId=\{handoverId\} editable=\{false\} type=\{doc\.type\} compact \/>/);
  const map = src("src/app/(app)/buchungen/[id]/uebergabe/damage-map.tsx");
  assert.match(map, /compact \? "max-w-\[640px\]" : ""/);
  assert.match(map, /viewBox=\{`\$\{bx\} \$\{by\} \$\{bw\} \$\{bh\}`\}/, "Markierungen bleiben im Koordinatensystem der Skizze");
  // Zubehör
  const price = (key: string) => accessoryPrice(ACCESSORY_ITEMS.find((a) => a.key === key)!, null, null);
  assert.deepEqual([price("warning_triangle"), price("safety_vest"), price("first_aid")], [{ cents: 2_000, origin: "STANDARD" }, { cents: 2_000, origin: "STANDARD" }, { cents: 2_000, origin: "STANDARD" }]);
  assert.deepEqual(price("parcel_shelf"), { cents: null, origin: "NONE" }, "Hutablage: kein globaler Festpreis");
  assert.equal(ACCESSORY_ITEMS.find((a) => a.key === "parcel_shelf")!.fixedPriceCents, null);
});

// ---------------------------------------------------------------------------
// L–N. Rechnungsabschluss mit bewusst bestätigter Kautionsverrechnung
// ---------------------------------------------------------------------------

/** Zurückgegebene Miete: Rechnungsentwurf über `gross` €, vorab `prepaid` € Mietzahlung, `deposit` € Kaution erhalten. */
async function draftWorld(label: string, opts: { gross?: string; prepaid?: string | null; deposit?: string | null } = {}) {
  const w = await returnedWorld(label);
  tenants.push(w.tenantId);
  if (opts.prepaid !== null) await recordRentalPayment(w.tenantId, w.actor, w.bookingId, { amount: opts.prepaid ?? "45", method: "CASH", paidAt: at });
  if (opts.deposit !== null) await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: opts.deposit ?? "500", method: "CASH", occurredAt: at });
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const st = await getInvoiceState(w.tenantId, inv.id);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: st.draft!.items[0].id, description: st.draft!.items[0].description, quantity: "1", unit: "pauschal", unitPrice: opts.gross ?? "140", taxRate: "19" }] });
  const draft = (await getInvoiceState(w.tenantId, inv.id)).draft!;
  return { w, invoiceId: inv.id, draft };
}
const offsets = (tenantId: string) => Promise.all([db.payment.count({ where: { tenantId, type: "DEPOSIT_OFFSET" } }), db.securityDepositEvent.count({ where: { tenantId, type: "OFFSET" } })]);

test("Vorschlag: Rechnung 140 €, Mietzahlung 45 €, Kaution 500 € → 95 €; ohne Bestätigung entsteht keine Kautionsbewegung", async () => {
  const { w, invoiceId } = await draftWorld("r4-off-none");
  const dep = await depositView(w.tenantId, w.bookingId);
  const start = depositOffsetStart({ bookingStatus: "RETURNED", grossCents: 14_000, paidCents: 4_500, receivedCents: dep.receivedCents, remainingCents: dep.remainingCents });
  assert.deepEqual(start, { grossCents: 14_000, paidCents: 4_500, openCents: 9_500, receivedCents: 50_000, usedCents: 0, availableCents: 50_000, suggestedCents: 9_500 });
  // nie mehr als offen, nie mehr als verfügbar; nichts anzubieten ohne Forderung, ohne Kaution oder vor der Rückgabe
  assert.equal(depositOffsetStart({ bookingStatus: "RETURNED", grossCents: 70_000, paidCents: 0, receivedCents: 50_000, remainingCents: 50_000 })?.suggestedCents, 50_000);
  assert.equal(depositOffsetStart({ bookingStatus: "RETURNED", grossCents: 14_000, paidCents: 14_000, receivedCents: 50_000, remainingCents: 50_000 }), null);
  assert.equal(depositOffsetStart({ bookingStatus: "RETURNED", grossCents: 14_000, paidCents: 0, receivedCents: 0, remainingCents: 0 }), null);
  assert.equal(depositOffsetStart({ bookingStatus: "RETURNED", grossCents: 14_000, paidCents: 0, receivedCents: 50_000, remainingCents: 0 }), null);
  assert.equal(depositOffsetStart({ bookingStatus: "ACTIVE", grossCents: 14_000, paidCents: 0, receivedCents: 50_000, remainingCents: 50_000 }), null);
  // die Auswahl/Anzeige allein bucht nichts
  assert.deepEqual(await offsets(w.tenantId), [0, 0]);
  // Abschluss OHNE Auswahl: Rechnung finalisiert, 95 € offen, Kaution unberührt
  const v = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  assert.equal(v.status, "FINALIZED");
  const s = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s.grossCents, s.paidCents, s.offsetCents, s.openCents, s.status], [14_000, 4_500, 0, 9_500, "PARTIAL"]);
  assert.deepEqual(await offsets(w.tenantId), [0, 0]);
  const after = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([after.receivedCents, after.offsetCents, after.remainingCents], [50_000, 0, 50_000]);
});

test("Mit Bestätigung: Abschluss + 95 € Verrechnung in einem Vorgang → Rechnung 140, Mietzahlung 45, Verrechnung 95, offen 0, Kaution verbleibend 405 (nicht ausgezahlt); Rechnung unverändert", async () => {
  const { w, invoiceId, draft } = await draftWorld("r4-off-ok");
  const before = { gross: String(draft.grossTotal), net: String(draft.netTotal), tax: String(draft.taxTotal), items: draft.items.map((i) => [i.description, String(i.grossAmount), String(i.netAmount), String(i.taxAmount)]) };
  const res = await finalizeInvoiceWithDepositOffset(w.tenantId, invoiceId, w.actor, {}, { amount: "95", occurredAt: at, idempotencyKey: "r4-off-ok-key-1" });
  assert.deepEqual([res.created, res.version.status, res.version.versionNo, res.offset.payment.type, res.offset.payment.method, res.offset.payment.amountCents, res.offset.payment.invoiceId, res.offset.event?.type, res.offset.event?.amountCents], [true, "FINALIZED", 1, "DEPOSIT_OFFSET", "DEPOSIT_OFFSET", 9_500, invoiceId, "OFFSET", 9_500]);
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  assert.deepEqual([inv.status, /^RE-/.test(inv.number ?? "")], ["FINALIZED", true]);
  // Ausgleichsebene
  const s = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s.grossCents, s.paidCents, s.offsetCents, s.openCents, s.overpaidCents, s.status], [14_000, 14_000, 9_500, 0, 0, "PAID"]);
  const pays = await db.payment.findMany({ where: { tenantId: w.tenantId, invoiceId, status: "CONFIRMED" }, orderBy: { amountCents: "asc" } });
  assert.deepEqual(pays.map((p) => [p.type, p.method, p.amountCents]), [["RENTAL_PAYMENT", "CASH", 4_500], ["DEPOSIT_OFFSET", "DEPOSIT_OFFSET", 9_500]]);
  // Rechnung selbst: Positionen, Netto, Steuer, Brutto unverändert; keine Kautionsposition; Versiegelung intakt
  const sealed = await db.invoiceVersion.findUniqueOrThrow({ where: { id: res.version.id }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  assert.deepEqual({ gross: String(sealed.grossTotal), net: String(sealed.netTotal), tax: String(sealed.taxTotal), items: sealed.items.map((i) => [i.description, String(i.grossAmount), String(i.netAmount), String(i.taxAmount)]) }, before);
  assert.equal(String(sealed.grossTotal), "140");
  assert.ok(!sealed.items.some((i) => /Kaution/i.test(i.description)));
  assert.equal((await verifyInvoice(w.tenantId, invoiceId)).intact, true);
  // Kaution: erhalten 500, verrechnet 95, verbleibend 405 – weder freigegeben noch ausgezahlt
  const d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([d.receivedCents, d.offsetCents, d.remainingCents, d.releasedCents, d.retainedCents, d.completedPayoutCents, d.payoutRemainingCents], [50_000, 9_500, 40_500, 0, 0, 0, 0]);
  assert.equal(await db.payout.count({ where: { tenantId: w.tenantId } }), 0, "keine erfundene Auszahlung");
  assert.deepEqual(d.events.map((e) => [e.type, e.amountCents, e.status]).sort(), [["OFFSET", 9_500, "CONFIRMED"], ["RECEIVED", 50_000, "CONFIRMED"]]);
  // Kaution ist kein Mietumsatz und kein Geldeingang: Bar-/Bankzahlungen bleiben 45 €
  const cash = await db.payment.aggregate({ where: { tenantId: w.tenantId, status: "CONFIRMED", method: { in: ["CASH", "CARD", "BANK_TRANSFER", "OTHER"] } }, _sum: { amountCents: true } });
  assert.equal(cash._sum.amountCents, 4_500);
  // Audit: Verrechnung mit Rechnung, Buchung, Betrag, Benutzer
  const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, action: "DEPOSIT_OFFSET_APPLIED" } });
  assert.deepEqual([audit.invoiceId, audit.bookingId, audit.amountCents, audit.userId, (audit.details as { openAfter: number }).openAfter], [invoiceId, w.bookingId, 9_500, w.actor.id, 0]);
  // erst eine eigene, bewusste Freigabe macht die 405 € auszahlbar
  assert.equal((await payoutSource(db, w.tenantId, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId })).remainingCents, 0);
  const rel = await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "405", method: "BANK_TRANSFER", occurredAt: at });
  assert.deepEqual([rel.kind, rel.events[0].amountCents], ["RELEASE", 40_500]);
  assert.equal((await payoutSource(db, w.tenantId, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId })).remainingCents, 40_500);
  assert.equal((await depositView(w.tenantId, w.bookingId)).completedPayoutCents, 0, "Freigabe ist noch keine Auszahlung");
});

test("Grenzen und Atomarität: nie mehr als offen, nie mehr als verfügbar; scheitert ein Teil, bleibt die Rechnung Entwurf und die Kaution unberührt", async () => {
  // mehr als die offene Forderung
  const a = await draftWorld("r4-off-over");
  await assert.rejects(() => finalizeInvoiceWithDepositOffset(a.w.tenantId, a.invoiceId, a.w.actor, {}, { amount: "95,01", occurredAt: at, idempotencyKey: "r4-off-over-1" }), /Überverrechnung: Offen sind 95,00/);
  const unchanged = async (x: { w: World; invoiceId: string }) => {
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: x.invoiceId } });
    const d = await depositView(x.w.tenantId, x.w.bookingId);
    const linked = await db.payment.count({ where: { tenantId: x.w.tenantId, invoiceId: x.invoiceId } });
    return [inv.status, inv.number, inv.currentVersionId, await db.invoiceVersion.count({ where: { invoiceId: x.invoiceId, status: "FINALIZED" } }), linked, d.offsetCents, d.remainingCents, ...(await offsets(x.w.tenantId))];
  };
  assert.deepEqual(await unchanged(a), ["DRAFT", null, null, 0, 0, 0, 50_000, 0, 0]);
  // mehr als die verfügbare Kaution (nur 50 € erhalten)
  const b = await draftWorld("r4-off-avail", { deposit: "50" });
  await assert.rejects(() => finalizeInvoiceWithDepositOffset(b.w.tenantId, b.invoiceId, b.w.actor, {}, { amount: "60", occurredAt: at, idempotencyKey: "r4-off-avail-1" }), /Verfügbar sind nur 50,00/);
  assert.deepEqual(await unchanged(b), ["DRAFT", null, null, 0, 0, 0, 5_000, 0, 0]);
  // keine Kaution erhalten
  const c = await draftWorld("r4-off-nodep", { deposit: null });
  await assert.rejects(() => finalizeInvoiceWithDepositOffset(c.w.tenantId, c.invoiceId, c.w.actor, {}, { amount: "95", occurredAt: at, idempotencyKey: "r4-off-nodep-1" }), /noch keine Kaution/);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: c.invoiceId } })).status, "DRAFT");
  // ungültiger Betrag / fehlender Schlüssel
  await assert.rejects(() => finalizeInvoiceWithDepositOffset(a.w.tenantId, a.invoiceId, a.w.actor, {}, { amount: "0", occurredAt: at, idempotencyKey: "r4-off-zero-1" }), /größer als 0,00/);
  await assert.rejects(() => finalizeInvoiceWithDepositOffset(a.w.tenantId, a.invoiceId, a.w.actor, {}, { amount: "95", occurredAt: at, idempotencyKey: "" }), /veraltet/);
  // der Abschluss selbst scheitert (Pflichtangaben des Vermieters fehlen): keine halbe Verrechnung
  await db.tenant.update({ where: { id: a.w.tenantId }, data: { taxNumber: null, vatId: null } });
  await assert.rejects(() => finalizeInvoiceWithDepositOffset(a.w.tenantId, a.invoiceId, a.w.actor, {}, { amount: "95", occurredAt: at, idempotencyKey: "r4-off-fail-1" }), /Firmendaten|Steuernummer|USt/);
  assert.deepEqual(await unchanged(a), ["DRAFT", null, null, 0, 0, 0, 50_000, 0, 0]);
  // danach (Angaben wieder vollständig) klappt derselbe Vorgang – mit Teilbetrag
  await db.tenant.update({ where: { id: a.w.tenantId }, data: { taxNumber: "60/123/45678" } });
  const ok = await finalizeInvoiceWithDepositOffset(a.w.tenantId, a.invoiceId, a.w.actor, {}, { amount: "50", occurredAt: at, idempotencyKey: "r4-off-part-1" });
  assert.equal(ok.offset.payment.amountCents, 5_000);
  const s = await invoicePaymentSummary(a.w.tenantId, a.invoiceId);
  assert.deepEqual([s.paidCents, s.offsetCents, s.openCents, s.status], [9_500, 5_000, 4_500, "PARTIAL"]);
  assert.equal((await depositView(a.w.tenantId, a.w.bookingId)).remainingCents, 45_000);
  // fremder Mandant
  const other = await createWorld("r4-off-other");
  tenants.push(other.tenantId);
  await assert.rejects(() => finalizeInvoiceWithDepositOffset(other.tenantId, b.invoiceId, other.actor, {}, { amount: "10", occurredAt: at, idempotencyKey: "r4-off-other-1" }), /nicht gefunden/);
  assert.deepEqual(await unchanged(b), ["DRAFT", null, null, 0, 0, 0, 5_000, 0, 0]);
});

test("Doppelklick und Reload: derselbe Schlüssel bucht genau einmal – eine Rechnung, eine Verrechnung, eine Kautionsbewegung", async () => {
  const { w, invoiceId } = await draftWorld("r4-off-double");
  const input = { amount: "95", occurredAt: at, idempotencyKey: "r4-off-double-key-1" };
  const results = await Promise.allSettled([finalizeInvoiceWithDepositOffset(w.tenantId, invoiceId, w.actor, {}, input), finalizeInvoiceWithDepositOffset(w.tenantId, invoiceId, w.actor, {}, input)]);
  const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof finalizeInvoiceWithDepositOffset>>>[];
  assert.ok(ok.length >= 1);
  assert.equal(ok.filter((r) => r.value.created).length, 1, "genau ein Aufruf bucht");
  for (const r of results) if (r.status === "rejected") assert.match(String(r.reason?.message), /keinen offenen Entwurf|bereits|veraltet/);
  // Reload mit demselben Schlüssel: liefert den gebuchten Vorgang, bucht nichts
  const again = await finalizeInvoiceWithDepositOffset(w.tenantId, invoiceId, w.actor, {}, input);
  assert.deepEqual([again.created, again.offset.payment.id, again.version.id], [false, ok.find((r) => r.value.created)!.value.offset.payment.id, ok.find((r) => r.value.created)!.value.version.id]);
  assert.deepEqual(await offsets(w.tenantId), [1, 1]);
  assert.equal(await db.invoiceVersion.count({ where: { invoiceId, status: "FINALIZED" } }), 1);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, status: "FINALIZED", kind: "RENTAL" } }), 1);
  const d = await depositView(w.tenantId, w.bookingId);
  assert.deepEqual([d.offsetCents, d.remainingCents], [9_500, 40_500]);
  // ein anderer Schlüssel nach dem Abschluss: kein Entwurf mehr → nichts wird erneut gebucht
  await assert.rejects(() => finalizeInvoiceWithDepositOffset(w.tenantId, invoiceId, w.actor, {}, { ...input, idempotencyKey: "r4-off-double-key-2" }), /keinen offenen Entwurf/);
  assert.deepEqual(await offsets(w.tenantId), [1, 1]);
});

test("Rollen und Ablauf in der Oberfläche: Abschluss nur Inhaber/Disposition; Verrechnung nur nach ausdrücklicher Auswahl; nie vorausgewählt", () => {
  const actions = src("src/app/(app)/buchungen/[id]/rechnung/actions.ts");
  assert.match(actions, /async function context[\s\S]*requireRole\("DISPO"\)/);
  const fin = actions.slice(actions.indexOf("export async function finalizeInvoiceAction"));
  assert.match(fin, /formData\.get\("depositOffset"\) === "1"/);
  assert.match(fin, /depositOffsetConfirmed"\) !== "1"/);
  assert.match(fin, /finalizeInvoiceWithDepositOffset\(/);
  assert.match(fin, /version = await finalizeInvoice\(tenant\.id, invoice\.id, actor, opts\)/, "ohne Auswahl der bisherige Abschluss – ohne Verrechnung");
  const editor = src("src/app/(app)/buchungen/[id]/rechnung/invoice-editor.tsx");
  assert.match(editor, /const \[offsetChosen, setOffsetChosen\] = useState\(false\)/, "nie vorausgewählt");
  assert.match(editor, /aus Kaution verrechnen/);
  assert.match(editor, /an Kunden verbleibend/);
  const settlement = src("src/lib/invoice-settlement.ts");
  assert.match(settlement, /db\.\$transaction\(async \(tx\) => \{[\s\S]*lockOrCreateDeposit\(tx[\s\S]*finalizeInvoiceIn\(tx[\s\S]*applyDepositOffsetIn\(tx/, "eine Transaktion, Sperren in fester Reihenfolge");
});
