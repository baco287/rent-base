// Schadenmanagement (Phase 12): Akte je Schaden, Statusworkflow, Haftung getrennt, Kosten ohne Forderung, Fahrzeug
// sperren/freigeben, Kundenbelastung → eigene Schadenabrechnung (kind DAMAGE) neben der Mietrechnung, Fassungen und Zahlungen,
// Kaution unberührt, Mandantentrennung, Wettläufe, unveränderte Protokolle und Verträge.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { addCaseNote, blockVehicleForCase, caseCounts, caseView, changeCaseStatus, chargeCustomer, closeCase, listCases, openDamageCase, registerCaseDocument, registerCasePhoto, releaseVehicleForCase, reopenCase, setCaseCosts, setLiability } from "../src/lib/damage-cases";
import { balanceOf } from "../src/lib/deposits";
import { DomainError, sha256 } from "../src/lib/integrity";
import { discardInvoiceDraft, ensureInvoiceDraft, finalizeInvoice, getInvoiceState, listVersions, startInvoiceEdit, updateInvoiceDraft, verifyInvoice } from "../src/lib/invoices";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { recordDepositReceived } from "../src/lib/deposits";
import { toCents } from "../src/lib/money";
import { invoicePaymentSummary, recordInvoicePayment } from "../src/lib/payments";
import { buildStorageKey } from "../src/lib/storage";
import { createWorld, purgeTenants } from "./helpers";
import { returnedWorld, type ReturnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => { await purgeTenants(tenants); await db.$disconnect(); });

async function world(label: string, opts: Parameters<typeof returnedWorld>[1] = {}) {
  const w = await returnedWorld(label, opts);
  if (!tenants.includes(w.tenantId)) tenants.push(w.tenantId);
  return w;
}

/** Der bei der Rückgabe neu festgestellte Schaden aus returnedWorld (Delle Heckklappe). */
async function returnDamage(w: ReturnedWorld) {
  return db.damage.findFirstOrThrow({ where: { tenantId: w.tenantId, discoveredInHandoverId: w.returnId } });
}

async function snapshotOf(w: ReturnedWorld) {
  const [contract, ret, pickup, damages, snapshots] = await Promise.all([
    db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId }, select: { contentHash: true, status: true, customerSnapshot: true } }),
    db.handover.findUniqueOrThrow({ where: { id: w.returnId }, select: { contentHash: true, status: true, finalizedAt: true } }),
    db.handover.findUniqueOrThrow({ where: { id: w.pickupId }, select: { contentHash: true, status: true } }),
    db.damage.findMany({ where: { tenantId: w.tenantId }, select: { id: true, description: true, view: true, posX: true, posY: true, discoveredAt: true } }),
    db.handoverDamage.findMany({ where: { tenantId: w.tenantId }, select: { id: true, marker: true, description: true, photoRefs: true } }),
  ]);
  return JSON.stringify({ contract, ret, pickup, damages, snapshots });
}

// ---------------------------------------------------------------------------
// Grundprozess
// ---------------------------------------------------------------------------

test("Schadenakte eröffnen: Nummer SCH-JJJJ-NNNNNN, Start OPEN/UNASSESSED, Bezug zu Rückgabe und Buchung, genau eine Akte je Schaden", async () => {
  const w = await world("case-open");
  const d = await returnDamage(w);
  const before = await snapshotOf(w);
  const { damageCase: c, created } = await openDamageCase(w.tenantId, d.id, w.actor);
  assert.equal(created, true);
  assert.match(c.caseNumber, /^SCH-\d{4}-\d{6}$/);
  assert.equal(c.status, "OPEN");
  assert.equal(c.priority, "NORMAL");
  assert.equal(c.liabilityStatus, "UNASSESSED");
  assert.equal(c.bookingId, w.bookingId);
  assert.equal(c.returnHandoverId, w.returnId);
  assert.equal(c.vehicleId, w.vehicleId);
  assert.equal(c.customerChargeCents, null);
  // zweites Eröffnen liefert dieselbe Akte
  const again = await openDamageCase(w.tenantId, d.id, w.actor);
  assert.equal(again.damageCase.id, c.id);
  assert.equal(again.created, false);
  assert.equal(await db.damageCase.count({ where: { tenantId: w.tenantId } }), 1);
  // Historie und Audit
  const events = await db.damageCaseEvent.findMany({ where: { caseId: c.id } });
  assert.deepEqual(events.map((e) => e.type), ["CREATED"]);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "DAMAGE_CASE_CREATED" } }), 1);
  // Vertrag, Protokolle, Schäden und Protokollkopien unverändert
  assert.equal(await snapshotOf(w), before);
  // Keine Rechnung, keine Zahlung, keine Kautionsbewegung entstanden
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId } }), 0);
  // Sicht: Vorher/Nachher
  const v = await caseView(w.tenantId, c.id);
  assert.equal(v.comparison.pickup, null, "bei Übergabe nicht dokumentiert");
  assert.equal(v.comparison.return?.marker, "NEW");
  assert.equal(v.deductibleCents, 100_000);
  assert.ok(v.deposit && v.deposit.expectedCents === 50_000);
});

test("Parallel: fünf gleichzeitige Eröffnungen desselben Schadens ergeben genau eine Akte", async () => {
  const w = await world("case-race");
  const d = await returnDamage(w);
  const results = await Promise.all(Array.from({ length: 5 }, () => openDamageCase(w.tenantId, d.id, w.actor)));
  const ids = new Set(results.map((r) => r.damageCase.id));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(await db.damageCase.count({ where: { tenantId: w.tenantId } }), 1);
});

test("Statusworkflow: nur zentrale Übergänge, Schließen mit Grund, Wiederöffnen mit Grund, geschlossene Akte nicht bearbeitbar", async () => {
  const w = await world("case-status");
  const d = await returnDamage(w);
  const { damageCase: c } = await openDamageCase(w.tenantId, d.id, w.actor);
  await assert.rejects(() => changeCaseStatus(w.tenantId, c.id, w.actor, "REPAIRED"), /kein Wechsel/);
  await assert.rejects(() => changeCaseStatus(w.tenantId, c.id, w.actor, "CLOSED"), /Ungültiger Zielstatus/);
  await changeCaseStatus(w.tenantId, c.id, w.actor, "UNDER_REVIEW");
  await changeCaseStatus(w.tenantId, c.id, w.actor, "REPAIR_PLANNED");
  await changeCaseStatus(w.tenantId, c.id, w.actor, "IN_REPAIR");
  const rep = await changeCaseStatus(w.tenantId, c.id, w.actor, "REPAIRED");
  assert.ok(rep.repairCompletedAt);
  // Fahrzeugschaden spiegelt den Reparaturstand, Protokollkopien bleiben
  const dmg = await db.damage.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(dmg.status, "REPAIRED");
  assert.ok(dmg.repairedAt);
  assert.equal((await db.handoverDamage.findFirst({ where: { damageId: d.id } }))?.marker, "NEW");
  await assert.rejects(() => closeCase(w.tenantId, c.id, w.actor, ""), /Abschlussgrund/);
  const closed = await closeCase(w.tenantId, c.id, w.actor, "Repariert, keine Weiterverfolgung");
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.closeReason, "Repariert, keine Weiterverfolgung");
  await assert.rejects(() => setCaseCosts(w.tenantId, c.id, w.actor, { estimated: "100" }), /geschlossen/);
  await assert.rejects(() => setLiability(w.tenantId, c.id, w.actor, "UNCLEAR"), /geschlossen/);
  await assert.rejects(() => changeCaseStatus(w.tenantId, c.id, w.actor, "UNDER_REVIEW"), /geschlossen/);
  const reopened = await reopenCase(w.tenantId, c.id, w.actor, "Nachforderung der Werkstatt");
  assert.equal(reopened.status, "REPAIRED");
  assert.equal(reopened.closedAt, null);
  const actions = (await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["DAMAGE_CASE_CLOSED", "DAMAGE_CASE_REOPENED", "DAMAGE_CASE_STATUS_CHANGED"] } } })).map((a) => a.action);
  assert.equal(actions.filter((a) => a === "DAMAGE_CASE_STATUS_CHANGED").length, 4);
  assert.ok(actions.includes("DAMAGE_CASE_CLOSED") && actions.includes("DAMAGE_CASE_REOPENED"));
  // Akten werden nie gelöscht
  await assert.rejects(() => db.damageCase.delete({ where: { id: c.id } }), /RB_IMMUTABLE/);
});

// ---------------------------------------------------------------------------
// Haftung und Kosten
// ---------------------------------------------------------------------------

test("Haftung: „Kunde verantwortlich“ nur mit Begründung, keine automatische Haftung, Kosten erzeugen keine Forderung", async () => {
  const w = await world("case-liability");
  const d = await returnDamage(w);
  const { damageCase: c } = await openDamageCase(w.tenantId, d.id, w.actor);
  await assert.rejects(() => setLiability(w.tenantId, c.id, w.actor, "CUSTOMER_RESPONSIBILITY_CONFIRMED"), /begründen/);
  await assert.rejects(() => setLiability(w.tenantId, c.id, w.actor, "CUSTOMER_RESPONSIBILITY_CONFIRMED", "  "), /begründen/);
  // DB-Regel unabhängig von der App
  await assert.rejects(() => db.damageCase.update({ where: { id: c.id }, data: { liabilityStatus: "CUSTOMER_RESPONSIBILITY_CONFIRMED", liabilityNote: null } }), /rb_damage_case_liability_note|check constraint/i);
  const u = await setLiability(w.tenantId, c.id, w.actor, "UNCLEAR", "Hergang unklar");
  assert.equal(u.liabilityStatus, "UNCLEAR");
  // Kosten: reine Information
  const cost = await setCaseCosts(w.tenantId, c.id, w.actor, { estimated: "1.250,00", actual: null });
  assert.equal(cost.estimatedCostCents, 125_000);
  await assert.rejects(() => setCaseCosts(w.tenantId, c.id, w.actor, { actual: "-5" }), /negativ/);
  await assert.rejects(() => setCaseCosts(w.tenantId, c.id, w.actor, { actual: "abc" }), /gültigen Betrag/);
  await setCaseCosts(w.tenantId, c.id, w.actor, { actual: "980,50" });
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0, "keine Rechnung durch Kosten");
  assert.equal(await db.extraCharge.count({ where: { tenantId: w.tenantId, damageId: d.id } }), 0, "keine Zusatzkostenposition durch Kosten");
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId } }), 0);
  // Ohne bestätigte Kundenverantwortung keine Belastung
  await assert.rejects(() => chargeCustomer(w.tenantId, c.id, w.actor, { amount: "500", basis: "Reparaturkosten Heckklappe", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" }), /Kunde verantwortlich/);
  const audits = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["DAMAGE_LIABILITY_CHANGED", "DAMAGE_COST_CHANGED"] } } });
  assert.equal(audits.filter((a) => a.action === "DAMAGE_LIABILITY_CHANGED").length, 1);
  assert.equal(audits.filter((a) => a.action === "DAMAGE_COST_CHANGED").length, 2);
});

test("Haftung parallel: gleichzeitige Änderungen enden konsistent und lückenlos in der Historie", async () => {
  const w = await world("case-liab-race");
  const d = await returnDamage(w);
  const { damageCase: c } = await openDamageCase(w.tenantId, d.id, w.actor);
  const values = ["UNCLEAR", "THIRD_PARTY", "NOT_CUSTOMER_RESPONSIBILITY", "INTERNAL"] as const;
  await Promise.all(values.map((v) => setLiability(w.tenantId, c.id, w.actor, v, `Prüfung ${v}`)));
  const row = await db.damageCase.findUniqueOrThrow({ where: { id: c.id } });
  assert.ok((values as readonly string[]).includes(row.liabilityStatus));
  const events = await db.damageCaseEvent.findMany({ where: { caseId: c.id, type: "LIABILITY_CHANGED" }, orderBy: { createdAt: "asc" } });
  assert.equal(events.length, 4);
  assert.equal(events[events.length - 1].toValue, row.liabilityStatus, "letzter Eintrag entspricht dem Stand");
});

// ---------------------------------------------------------------------------
// Fahrzeug sperren / freigeben
// ---------------------------------------------------------------------------

test("Fahrzeug sperren: zentraler Status BLOCKED, Buchungen bleiben, Warnung; Freigabe nur ausdrücklich, nie durch Abschluss", async () => {
  const w = await world("case-block");
  const d = await returnDamage(w);
  const { damageCase: c } = await openDamageCase(w.tenantId, d.id, w.actor);
  // künftige Buchung für dasselbe Fahrzeug
  const start = new Date(Date.now() + 3 * 86400_000);
  const future = await db.booking.create({ data: { tenantId: w.tenantId, number: `T-F-${Date.now().toString(36)}`, vehicleId: w.vehicleId, customerId: w.customerId, startAt: start, endAt: new Date(start.getTime() + 2 * 86400_000), dailyRate: 89, workWeekRate: 420, weeklyRate: 540, deposit: 500 } });
  const r = await blockVehicleForCase(w.tenantId, c.id, w.actor, "Achse prüfen");
  assert.equal(r.vehicleStatus, "BLOCKED");
  assert.equal(r.futureBookings, 1);
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).status, "BLOCKED");
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: future.id } })).status, "RESERVED", "nichts storniert");
  await assert.rejects(() => blockVehicleForCase(w.tenantId, c.id, w.actor), /bereits gesperrt/);
  // gesperrtes Fahrzeug ist nicht buchbar
  const { assertVehicleBookable } = await import("../src/lib/bookings");
  const s0 = new Date(Date.now() + 30 * 86400_000);
  await assert.rejects(() => db.$transaction((tx) => assertVehicleBookable(tx, w.tenantId, w.vehicleId, s0, new Date(s0.getTime() + 86400_000))), DomainError);
  // Reparatur fertig und Akte geschlossen: Fahrzeug bleibt gesperrt
  await changeCaseStatus(w.tenantId, c.id, w.actor, "REPAIR_PLANNED");
  await changeCaseStatus(w.tenantId, c.id, w.actor, "IN_REPAIR");
  await changeCaseStatus(w.tenantId, c.id, w.actor, "REPAIRED");
  await closeCase(w.tenantId, c.id, w.actor, "Repariert");
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).status, "BLOCKED", "kein automatisches Freigeben");
  // Freigabe auch an geschlossener Akte möglich (bewusste Entscheidung)
  const rel = await releaseVehicleForCase(w.tenantId, c.id, w.actor, "Werkstatt hat freigegeben");
  assert.equal(rel.vehicleStatus, "AVAILABLE");
  await assert.rejects(() => releaseVehicleForCase(w.tenantId, c.id, w.actor), /nicht gesperrt/);
  const audits = (await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["VEHICLE_BLOCKED_FOR_DAMAGE", "VEHICLE_RELEASED_AFTER_DAMAGE"] } } })).map((a) => a.action);
  assert.deepEqual(audits.sort(), ["VEHICLE_BLOCKED_FOR_DAMAGE", "VEHICLE_RELEASED_AFTER_DAMAGE"]);
});

test("Sperren und Freigeben parallel: das Fahrzeug endet in genau einem Zustand, jede Aktion höchstens einmal", async () => {
  const w = await world("case-block-race");
  const d = await returnDamage(w);
  const { damageCase: c } = await openDamageCase(w.tenantId, d.id, w.actor);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => blockVehicleForCase(w.tenantId, c.id, w.actor)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "genau eine Sperrung");
  const rel = await Promise.allSettled(Array.from({ length: 4 }, () => releaseVehicleForCase(w.tenantId, c.id, w.actor)));
  assert.equal(rel.filter((r) => r.status === "fulfilled").length, 1, "genau eine Freigabe");
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).status, "AVAILABLE");
  assert.equal(await db.damageCaseEvent.count({ where: { caseId: c.id, type: { in: ["VEHICLE_BLOCKED", "VEHICLE_RELEASED"] } } }), 2);
});

// ---------------------------------------------------------------------------
// Kundenbelastung und Schadenabrechnung
// ---------------------------------------------------------------------------

async function confirmedCase(w: ReturnedWorld) {
  const d = await returnDamage(w);
  const { damageCase: c } = await openDamageCase(w.tenantId, d.id, w.actor);
  await setLiability(w.tenantId, c.id, w.actor, "CUSTOMER_RESPONSIBILITY_CONFIRMED", "Im Rückgabeprotokoll neu, Mieter hat Verursachung bestätigt");
  return { d, c };
}

test("Schaden dem Kunden berechnen: Betrag und Grundlage Pflicht, steuerliche Behandlung gewählt, eigene Schadenabrechnung als Entwurf, Belastung einmalig", async () => {
  const w = await world("case-charge");
  const { c } = await confirmedCase(w);
  await assert.rejects(() => chargeCustomer(w.tenantId, c.id, w.actor, { amount: "0", basis: "Reparaturkosten laut Werkstattrechnung", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" }), /größer als 0/);
  await assert.rejects(() => chargeCustomer(w.tenantId, c.id, w.actor, { amount: "500", basis: "x", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" }), /Grundlage/);
  await assert.rejects(() => chargeCustomer(w.tenantId, c.id, w.actor, { amount: "500", basis: "Reparaturkosten laut Werkstattrechnung", taxTreatment: "" }), /steuerliche Behandlung/);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0);

  const r = await chargeCustomer(w.tenantId, c.id, w.actor, { amount: "980,50", basis: "Reparaturkosten laut Werkstattrechnung 4711", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" });
  assert.equal(r.created, true);
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: r.invoiceId }, include: { versions: { include: { items: true } } } });
  assert.equal(inv.kind, "DAMAGE");
  assert.equal(inv.status, "DRAFT");
  assert.equal(inv.damageCaseId, c.id);
  assert.equal(inv.bookingId, w.bookingId);
  assert.equal(inv.taxTreatment, "NON_TAXABLE_DAMAGE_COMPENSATION");
  assert.equal(inv.number, null, "Nummer erst beim Abschluss");
  assert.equal(inv.versions.length, 1);
  assert.equal(inv.versions[0].items.length, 1);
  assert.equal(toCents(inv.versions[0].grossTotal), 98_050);
  assert.equal(toCents(inv.versions[0].taxTotal), 0, "echter Schadensersatz ohne USt");
  assert.match(inv.versions[0].taxNote ?? "", /nicht steuerbar/);
  assert.equal(inv.versions[0].taxTreatment, "NON_TAXABLE_DAMAGE_COMPENSATION", "Behandlung in der Fassung versiegelt");
  assert.match(inv.versions[0].items[0].description, /Schadenakte SCH-/);
  const row = await db.damageCase.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(row.customerChargeCents, 98_050);
  assert.equal(row.customerChargeTaxTreatment, "NON_TAXABLE_DAMAGE_COMPENSATION");
  assert.equal(row.status, "UNDER_REVIEW");
  // Belastung ist einmalig und unveränderlich; Haftung danach festgeschrieben
  const again = await chargeCustomer(w.tenantId, c.id, w.actor, { amount: "1", basis: "noch einmal, versehentlich", taxTreatment: "TAXABLE_SUPPLY" });
  assert.equal(again.created, false);
  assert.equal(again.invoiceId, r.invoiceId);
  await assert.rejects(() => db.damageCase.update({ where: { id: c.id }, data: { customerChargeCents: 1 } }), /RB_IMMUTABLE/);
  await assert.rejects(() => setLiability(w.tenantId, c.id, w.actor, "UNCLEAR", "doch nicht"), /nicht mehr geändert/);
  // Kein Mietrechnungs-Draft entstanden, keine Zahlung, keine Kautionsbewegung
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, kind: "RENTAL" } }), 0);
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId } }), 0);
  const audits = (await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["DAMAGE_CUSTOMER_CHARGE_CREATED", "DAMAGE_INVOICE_CREATED"] } } })).map((a) => a.action).sort();
  assert.deepEqual(audits, ["DAMAGE_CUSTOMER_CHARGE_CREATED", "DAMAGE_INVOICE_CREATED"]);
});

test("Parallel: „Schaden dem Kunden berechnen“ mehrfach gleichzeitig ergibt genau eine Schadenabrechnung", async () => {
  const w = await world("case-charge-race");
  const { c } = await confirmedCase(w);
  const results = await Promise.all(Array.from({ length: 5 }, () => chargeCustomer(w.tenantId, c.id, w.actor, { amount: "300", basis: "Kostenvoranschlag Heckklappe", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" })));
  assert.equal(new Set(results.map((r) => r.invoiceId)).size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, damageCaseId: c.id } }), 1);
});

test("Schadenabrechnung neben Mietrechnung: beide finalisierbar, Nummern getrennt, Zahlungen je Rechnung, Kaution unverändert, PDF-Daten mit Aktennummer", async () => {
  const w = await world("case-two-invoices");
  // Mietrechnung
  const rental = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const rv = await finalizeInvoice(w.tenantId, rental.id, w.actor);
  assert.equal(rv.versionNo, 1);
  // Kaution erhalten (Dokumentation) – bleibt durch alles Folgende unberührt
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: new Date() });
  const depBefore = await db.securityDepositEvent.findMany({ where: { tenantId: w.tenantId } });
  // Schadenabrechnung
  const { c } = await confirmedCase(w);
  const { invoiceId } = await chargeCustomer(w.tenantId, c.id, w.actor, { amount: "1.190,00", basis: "Instandsetzung Heckklappe inkl. Lackierung, Werkstattrechnung 4712", taxTreatment: "TAXABLE_SUPPLY" });
  const st = await getInvoiceState(w.tenantId, invoiceId);
  assert.equal(st.issues.filter((i) => i.severity === "error").length, 0, JSON.stringify(st.issues));
  const dv = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  const dmgInv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const rentInv = await db.invoice.findUniqueOrThrow({ where: { id: rental.id } });
  assert.match(dmgInv.number ?? "", /^RE-\d{4}-\d{6}$/);
  assert.notEqual(dmgInv.number, rentInv.number);
  assert.equal(dmgInv.status, "FINALIZED");
  assert.equal(rentInv.status, "FINALIZED", "Mietrechnung unverändert finalisiert");
  assert.equal(toCents(dv.grossTotal), 119_000);
  assert.equal(toCents(dv.taxTotal), 19_000, "steuerpflichtiges Entgelt: 19 % im Bruttobetrag");
  // eine Mietrechnung je Buchung bleibt gewahrt, Schadenabrechnung ist keine zweite Mietrechnung
  assert.equal((await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor)).id, rental.id, "keine zweite Mietrechnung");
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, bookingId: w.bookingId, kind: "RENTAL" } }), 1);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, bookingId: w.bookingId } }), 2);
  // Zahlungen je Rechnung getrennt
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "500", method: "BANK_TRANSFER", paidAt: new Date() });
  const payDamage = await invoicePaymentSummary(w.tenantId, invoiceId);
  const payRental = await invoicePaymentSummary(w.tenantId, rental.id);
  assert.equal(payDamage.status, "PARTIAL");
  assert.equal(payDamage.openCents, 69_000);
  assert.equal(payRental.status, "OPEN");
  assert.equal(payRental.paidCents, 0);
  // Kaution unberührt, keine Verrechnung
  const depAfter = await db.securityDepositEvent.findMany({ where: { tenantId: w.tenantId } });
  assert.deepEqual(depAfter, depBefore);
  const dep = await db.securityDeposit.findUniqueOrThrow({ where: { bookingId: w.bookingId }, include: { events: true } });
  assert.equal(balanceOf(dep.expectedAmountCents, dep.events).remainingCents, 50_000);
  // Akte zeigt Rechnung, Fassung, Zahlungsstand
  const view = await caseView(w.tenantId, c.id);
  assert.equal(view.invoice?.number, dmgInv.number);
  assert.equal(view.invoice?.currentVersion?.versionNo, 1);
  assert.equal(view.payment?.status, "PARTIAL");
  // Dokumentdaten: Art, Titel, Aktennummer
  const { doc } = await loadInvoiceDocumentData(w.tenantId, dv.id);
  assert.equal(doc.kind, "DAMAGE");
  assert.equal(doc.title, "Schadenabrechnung");
  assert.equal(doc.reference.caseNumber, view.caseNumber);
  const { doc: rentalDoc } = await loadInvoiceDocumentData(w.tenantId, rv.id);
  assert.equal(rentalDoc.kind, "RENTAL");
  assert.equal(rentalDoc.title, "Rechnung");
  // Liste und Kennzahlen
  const list = await listCases(w.tenantId, { filter: "rechnung_offen" });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].payment?.status, "PARTIAL");
  assert.equal((await caseCounts(w.tenantId)).openInvoices, 1);
  // Integrität beider Rechnungen
  assert.equal((await verifyInvoice(w.tenantId, invoiceId)).intact, true);
  assert.equal((await verifyInvoice(w.tenantId, rental.id)).intact, true);
});

test("Schadenabrechnung: Fassungen (Neufassung) funktionieren wie bei der Mietrechnung; Entwurf verwerfen setzt die Belastung zurück", async () => {
  const w = await world("case-versions");
  const { c } = await confirmedCase(w);
  const { invoiceId } = await chargeCustomer(w.tenantId, c.id, w.actor, { amount: "400", basis: "Kostenvoranschlag Heckklappe", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" });
  // Entwurf verwerfen → Belastung frei, erneut möglich
  const res = await discardInvoiceDraft(w.tenantId, invoiceId, w.actor);
  assert.equal(res.invoiceDeleted, true);
  assert.equal((await db.damageCase.findUniqueOrThrow({ where: { id: c.id } })).customerChargeCents, null);
  const second = await chargeCustomer(w.tenantId, c.id, w.actor, { amount: "450", basis: "Kostenvoranschlag Heckklappe, korrigiert", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" });
  assert.equal(second.created, true);
  const v1 = await finalizeInvoice(w.tenantId, second.invoiceId, w.actor);
  assert.equal(toCents(v1.grossTotal), 45_000);
  // Neufassung: Betrag anpassen (nicht übermittelt → REVISION, keine Begründungspflicht)
  const d2 = await startInvoiceEdit(w.tenantId, second.invoiceId, w.actor);
  await updateInvoiceDraft(w.tenantId, second.invoiceId, w.actor, { items: [{ id: d2.items[0].id, description: d2.items[0].description, quantity: "1", unit: "pauschal", unitPrice: "420", taxRate: "0" }], taxNote: d2.taxNote ?? "" });
  const v2 = await finalizeInvoice(w.tenantId, second.invoiceId, w.actor);
  assert.equal(v2.versionNo, 2);
  assert.equal(v2.kind, "REVISION");
  assert.equal(toCents(v2.grossTotal), 42_000);
  const versions = await listVersions(w.tenantId, second.invoiceId);
  assert.equal(versions.length, 2);
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: second.invoiceId } });
  assert.equal(inv.currentVersionId, v2.id);
  // Belastung an der Akte bleibt der ursprünglich festgelegte Wert (Korrektur läuft über die Fassung)
  assert.equal((await db.damageCase.findUniqueOrThrow({ where: { id: c.id } })).customerChargeCents, 45_000);
  const view = await caseView(w.tenantId, c.id);
  assert.equal(view.invoice?.currentVersion?.versionNo, 2);
  assert.equal(view.payment?.grossCents, 42_000);
});

test("Doppelabrechnungsschutz: je Akte höchstens eine Schadenabrechnung (DB-Index), Rechnung ohne Akte darf nicht DAMAGE sein", async () => {
  const w = await world("case-double");
  const { c } = await confirmedCase(w);
  const { invoiceId } = await chargeCustomer(w.tenantId, c.id, w.actor, { amount: "100", basis: "Kleinreparatur Stoßfänger", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" });
  const first = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  await assert.rejects(
    () => db.invoice.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, customerId: first.customerId, contractId: first.contractId, kind: "DAMAGE", damageCaseId: c.id, damageId: c.damageId, taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION", sourceHash: "x", createdById: w.actor.id } }),
    /rb_invoice_one_per_damage_case|Unique constraint/,
  );
  await assert.rejects(
    () => db.invoice.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, customerId: first.customerId, contractId: first.contractId, kind: "DAMAGE", sourceHash: "y", createdById: w.actor.id } }),
    /rb_invoice_damage_refs|check constraint/i,
  );
});

// ---------------------------------------------------------------------------
// Fotos, Dokumente, Notizen, Liste
// ---------------------------------------------------------------------------

test("Fotos und Dokumente an der Akte: privat gespeichert, nur anfügend, Protokollfotos unberührt; Liste filtert und sucht", async () => {
  const w = await world("case-files");
  const d = await returnDamage(w);
  const protocolPhotos = await db.photo.findMany({ where: { tenantId: w.tenantId, handoverId: w.returnId } });
  const { damageCase: c } = await openDamageCase(w.tenantId, d.id, w.actor);
  const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  const photo = await registerCasePhoto(w.tenantId, c.id, w.actor, { storageKey: key, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key), caption: "Werkstattaufnahme" });
  assert.equal(photo.damageCaseId, c.id);
  assert.equal(photo.damageId, d.id);
  assert.ok(!photo.storageKey.startsWith("http"), "kein öffentlicher Link");
  const dkey = buildStorageKey({ tenantId: w.tenantId, area: "documents", bookingId: w.bookingId, contentType: "application/pdf" });
  const doc = await registerCaseDocument(w.tenantId, c.id, w.actor, { type: "ESTIMATE", fileName: "KV-4711.pdf", storageKey: dkey, contentType: "application/pdf", sizeBytes: 5000, checksum: sha256(dkey) });
  await assert.rejects(() => registerCaseDocument(w.tenantId, c.id, w.actor, { type: "WORD", fileName: "x.doc", storageKey: `${dkey}2`, contentType: "application/pdf", sizeBytes: 1, checksum: "a" }), /Dokumenttyp/);
  await assert.rejects(() => db.damageCaseDocument.update({ where: { id: doc.id }, data: { fileName: "anders.pdf" } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.damageCaseDocument.delete({ where: { id: doc.id } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.damageCaseEvent.deleteMany({ where: { caseId: c.id } }), /RB_IMMUTABLE/);
  await addCaseNote(w.tenantId, c.id, w.actor, "Werkstatt angerufen");
  assert.deepEqual(await db.photo.findMany({ where: { tenantId: w.tenantId, handoverId: w.returnId } }), protocolPhotos, "Protokollfotos unverändert");
  const view = await caseView(w.tenantId, c.id);
  assert.equal(view.photos.length, 1);
  assert.equal(view.documents.length, 1);
  assert.ok(view.events.some((e) => e.type === "NOTE_ADDED"));
  // Liste: Filter und Suche
  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } });
  assert.equal((await listCases(w.tenantId, { filter: "offen" })).total, 1);
  assert.equal((await listCases(w.tenantId, { filter: "geschlossen" })).total, 0);
  assert.equal((await listCases(w.tenantId, { filter: "haftung_ungeklaert" })).total, 1);
  assert.equal((await listCases(w.tenantId, { filter: "alle", q: vehicle.plate.slice(0, 5) })).total, 1);
  assert.equal((await listCases(w.tenantId, { filter: "alle", q: c.caseNumber })).total, 1);
  assert.equal((await listCases(w.tenantId, { filter: "alle", q: "gibt-es-nicht" })).total, 0);
  const counts = await caseCounts(w.tenantId);
  assert.equal(counts.open, 1);
  assert.equal(counts.liability, 1);
  assert.equal(counts.blocked, 0);
});

// ---------------------------------------------------------------------------
// Mandantentrennung
// ---------------------------------------------------------------------------

test("Mandantentrennung: fremde Akte ist unsichtbar und unbearbeitbar, fremder Schaden nicht eröffenbar, fremde Fotos nicht anfügbar", async () => {
  const a = await world("case-tenant-a");
  const b = await createWorld("case-tenant-b");
  tenants.push(b.tenantId);
  const d = await returnDamage(a);
  const { damageCase: c } = await openDamageCase(a.tenantId, d.id, a.actor);
  await assert.rejects(() => openDamageCase(b.tenantId, d.id, b.actor), /nicht gefunden/);
  await assert.rejects(() => caseView(b.tenantId, c.id), /nicht gefunden/);
  await assert.rejects(() => setLiability(b.tenantId, c.id, b.actor, "UNCLEAR"), /nicht gefunden/);
  await assert.rejects(() => setCaseCosts(b.tenantId, c.id, b.actor, { estimated: "1" }), /nicht gefunden/);
  await assert.rejects(() => blockVehicleForCase(b.tenantId, c.id, b.actor), /nicht gefunden/);
  await assert.rejects(() => closeCase(b.tenantId, c.id, b.actor, "fremd"), /nicht gefunden/);
  await assert.rejects(() => chargeCustomer(b.tenantId, c.id, b.actor, { amount: "1", basis: "fremder Zugriff", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" }), /nicht gefunden/);
  assert.equal((await listCases(b.tenantId, { filter: "alle" })).total, 0);
  // DB: Akte mit fremdem Fahrzeug / fremder Buchung ist unmöglich
  const foreignVehicle = await db.vehicle.findFirstOrThrow({ where: { tenantId: b.tenantId } });
  await assert.rejects(() => db.damageCase.create({ data: { tenantId: b.tenantId, damageId: d.id, vehicleId: foreignVehicle.id, caseNumber: "SCH-2026-999999", reportedAt: new Date(), description: "x" } }), /RB_TENANT|RB_DOMAIN|Unique constraint/);
  // DB: Foto eines fremden Mandanten an der Akte
  await assert.rejects(() => db.photo.create({ data: { tenantId: b.tenantId, damageCaseId: c.id, storageKey: `t/${b.tenantId}/photos/x.jpg`, category: "DAMAGE", contentType: "image/jpeg", sizeBytes: 1, checksum: "c" } }), /RB_TENANT/);
  assert.equal(await db.damageCase.count({ where: { tenantId: a.tenantId } }), 1);
});
