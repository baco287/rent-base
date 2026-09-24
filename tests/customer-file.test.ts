// Phase 19: Kundenakte 360°. Aggregation aus vorhandenen Modulen, Finanzstand identisch mit den zentralen Funktionen,
// Fahrerrollen getrennt von Buchungen, Haftung nie aus „unklar“ abgeleitet, Dokumente/Mails mit Bezug, keine Fremdmandanten.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { createAuthorityCase, setDriver } from "../src/lib/authority";
import { addAdditionalDriver, ensureContractDraft } from "../src/lib/contracts";
import { createCancellationDraft, createCreditNoteDraft, financialsFor, finalizeCounterDocument, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { customerBookings, customerDamageCases, customerDeposits, customerDocuments, customerDriverRoles, customerEmails, customerFinance, customerHeader, customerOverview, customerTimeline } from "../src/lib/customer-file";
import { openDamageCase, setLiability } from "../src/lib/damage-cases";
import { reportDamage } from "../src/lib/damages";
import { recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { ensureContractDocument } from "../src/lib/documents";
import { enqueueEmail, markEmailFailed } from "../src/lib/email-log";
import { ensureInvoiceDraft, finalizeInvoice, updateInvoiceDraft } from "../src/lib/invoices";
import { cancelPayment, recordInvoicePayment } from "../src/lib/payments";
import { cancelPayout, createPayout } from "../src/lib/payouts";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { toDateInputValue, zonedParts } from "../src/lib/time";
import { createWorld, purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-kundenakte-"));
  storage = getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const at = new Date(Date.now() - 60_000);
const draftOf = (invoiceId: string) => db.invoiceVersion.findFirstOrThrow({ where: { invoiceId, status: "DRAFT" }, include: { items: { orderBy: { sortOrder: "asc" } } } });

/** Abgeschlossene Miete mit Rechnung 1.000 € brutto (19 %). */
async function invoicedWorld(label: string) {
  await ready;
  const w = await returnedWorld(label);
  tenants.push(w.tenantId);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const d = await draftOf(inv.id);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: d.items[0].id, description: d.items[0].description, quantity: "1", unit: "pauschal", unitPrice: "1000", taxRate: "19" }] });
  const v1 = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  return { w, invoiceId: inv.id, v1 };
}

test("Kunde ohne Historie: Kopf, Nullwerte, offene Punkte nur aus Stammdaten, keine erfundenen Ereignisse", async () => {
  await ready;
  const w = await createWorld("akte-leer");
  tenants.push(w.tenantId);
  const fresh = await db.customer.create({ data: { tenantId: w.tenantId, number: "K-00002", firstName: "Max", lastName: "Neu", street: "Weg 2", zip: "28195", city: "Bremen" } });
  const head = await customerHeader(w.tenantId, fresh.id);
  assert.ok(head);
  assert.equal(head.name, "Max Neu");
  assert.equal(head.lastActivityWhat, "Stammdaten geändert");
  const o = await customerOverview(w.tenantId, fresh.id, fresh);
  assert.equal(o.bookingsTotal, 0);
  assert.equal(o.activeRentals, 0);
  assert.equal(o.lastRental, null);
  assert.equal(o.nextBooking, null);
  assert.equal(o.openReceivablesCents, 0);
  assert.equal(o.refundOpenCents, 0);
  assert.equal(o.depositPayoutOpenCents, 0);
  assert.deepEqual(o.tasks.map((t) => t.key), ["license"]);
  const fin = await customerFinance(w.tenantId, fresh.id);
  assert.equal(fin.documents.length + fin.payments.length + fin.payouts.length, 0);
  assert.deepEqual(fin.sums.effectiveInvoiceCents, 0);
  const tl = await customerTimeline(w.tenantId, fresh.id);
  assert.deepEqual(tl.map((e) => e.kind), ["Kunde"]);
  assert.equal((await customerBookings(w.tenantId, fresh.id)).total, 0);
  assert.equal((await customerDeposits(w.tenantId, fresh.id)).length, 0);
  assert.equal((await customerDocuments(w.tenantId, fresh.id, "OWNER")).length, 0);
  assert.equal((await customerEmails(w.tenantId, fresh.id)).length, 0);
});

test("Eine Buchung, nächste Buchung, aktive und überfällige Miete: Kennzahlen und offene Punkte aus vorhandenen Zuständen", async () => {
  await ready;
  const w = await createWorld("akte-buchung", { startInDays: 3 });
  tenants.push(w.tenantId);
  const c = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  let o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.bookingsTotal, 1);
  assert.equal(o.nextBooking?.id, w.bookingId);
  assert.equal(o.lastRental, null);
  // aktive, überfällige Miete
  const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-AK 2", make: "VW", model: "Golf", groupId: w.groupId, dailyRate: 49, deposit: 300 } });
  const overdue = await db.booking.create({ data: { tenantId: w.tenantId, number: "AKT-1", vehicleId: v2.id, customerId: c.id, startAt: new Date(Date.now() - 3 * 86400_000), endAt: new Date(Date.now() - 3600_000), dailyRate: 49, deposit: 300, status: "ACTIVE", actualPickupAt: new Date(Date.now() - 3 * 86400_000) } });
  o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.bookingsTotal, 2);
  assert.equal(o.activeRentals, 1);
  assert.equal(o.lastRental?.id, overdue.id);
  assert.ok(o.tasks.some((t) => t.key === `overdue-${overdue.id}` && t.tone === "bad"));
  const list = await customerBookings(w.tenantId, c.id, 1, 1);
  assert.equal(list.total, 2);
  assert.equal(list.pages, 2);
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].id, w.bookingId, "neueste zuerst (Startdatum)");
  const page2 = await customerBookings(w.tenantId, c.id, 2, 1);
  assert.equal(page2.rows[0].id, overdue.id);
});

test("Fahrerrollen: als Zusatzfahrer in fremdem Vertrag zählt nicht als eigene Buchung", async () => {
  await ready;
  const w = await createWorld("akte-fahrer");
  tenants.push(w.tenantId);
  const driver = await db.customer.create({ data: { tenantId: w.tenantId, number: "K-00002", firstName: "Zusatz", lastName: "Fahrer", street: "Weg 3", zip: "28195", city: "Bremen", birthDate: new Date("1990-01-01"), licenseNumber: "Z1", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01") } });
  const contract = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await addAdditionalDriver(w.tenantId, contract.id, { customerId: driver.id, firstName: "Zusatz", lastName: "Fahrer", birthDate: new Date("1990-01-01"), street: "Weg 3", zip: "28195", city: "Bremen", country: "DE", licenseNumber: "Z1", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: null, licenseCountry: "DE" });
  const o = await customerOverview(w.tenantId, driver.id, driver);
  assert.equal(o.bookingsTotal, 0, "keine Buchung als Mieter");
  assert.equal(o.driverOnlyContracts, 1);
  const roles = await customerDriverRoles(w.tenantId, driver.id);
  assert.equal(roles.length, 1);
  assert.equal(roles[0].role, "ADDITIONAL_DRIVER");
  assert.equal(roles[0].contract.id, contract.id);
  // der Mieter selbst hat keine „Fahrer“-Rolle in seinem eigenen Vertrag
  const own = await customerDriverRoles(w.tenantId, w.customerId);
  assert.equal(own.length, 0);
});

test("Finanzen: Rechnung offen/bezahlt, Gutschrift, Storno, Erstattung offen/erledigt – identisch mit financialsFor; Stornos sichtbar, nie summiert", async () => {
  const { w, invoiceId, v1 } = await invoicedWorld("akte-finanzen");
  const c = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  // offen
  let o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.openReceivablesCents, 100_000);
  assert.equal(o.openInvoices, 1);
  assert.ok(o.tasks.some((t) => t.key === `inv-${invoiceId}`));
  // Fehlbuchung 50 storniert (bleibt sichtbar), dann Zahlung 1.000 → bezahlt, nichts offen
  const wrong = (await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "50", method: "CASH", paidAt: at })).payment;
  await cancelPayment(w.tenantId, w.actor, wrong.id, "Fehlbuchung im Test");
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "1000", method: "BANK_TRANSFER", paidAt: at });
  o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.openReceivablesCents, 0);
  assert.equal(o.refundOpenCents, 0);
  let f = await customerFinance(w.tenantId, c.id);
  assert.equal(f.payments.length, 2);
  assert.equal(f.payments.filter((p) => p.status === "CANCELLED").length, 1);
  assert.equal(f.sums.paidCents, 100_000, "stornierte Zahlung nicht summiert");
  assert.equal(f.sums.creditCents, 0);
  // Gutschrift 100 → wirksam 900, Guthaben 100 (Erstattung offen)
  const cn = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  await updateCounterDocumentDraft(w.tenantId, cn.id, w.actor, { items: [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: "100" }], reason: "Kulanz" });
  await finalizeCounterDocument(w.tenantId, cn.id, w.actor, { confirmed: true });
  o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.refundOpenCents, 10_000);
  assert.ok(o.tasks.some((t) => t.key === `ref-${invoiceId}`));
  f = await customerFinance(w.tenantId, c.id);
  const central = (await financialsFor(w.tenantId, [{ id: invoiceId, grossTotal: v1.grossTotal }])).get(invoiceId)!;
  assert.equal(f.sums.effectiveInvoiceCents, central.effectiveCents);
  assert.equal(f.sums.effectiveInvoiceCents, 90_000);
  assert.equal(f.sums.creditedCents, 10_000);
  assert.equal(f.sums.creditCents, 10_000);
  assert.equal(f.sums.refundOpenCents, central.refundRemainingCents);
  assert.equal(f.sums.refundOpenCents, 10_000);
  assert.equal(f.documents.length, 2, "Rechnung und Gutschrift je eine Zeile");
  const cnRow = f.documents.find((d) => d.id === cn.id)!;
  assert.equal(cnRow.financials, null, "Gegenbeleg trägt keinen eigenen Forderungsstand");
  assert.equal(cnRow.original?.id, invoiceId);
  // Erstattung 100 erfasst → Erstattung offen 0; eine stornierte Auszahlung bleibt sichtbar
  const pay = (await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId }, { amount: "100", method: "CASH", executedAt: at }, { complete: true, confirmed: true })).payout;
  await cancelPayout(w.tenantId, w.actor, pay.id, "Fehlbuchung im Test");
  await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId }, { amount: "100", method: "CASH", executedAt: at }, { complete: true, confirmed: true });
  f = await customerFinance(w.tenantId, c.id);
  assert.equal(f.payouts.length, 2);
  assert.equal(f.sums.payoutsCompletedCents, 10_000, "stornierte Auszahlung nicht summiert");
  assert.equal(f.sums.refundOpenCents, 0);
  assert.equal(f.sums.refundedCents, 10_000);
  o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.refundOpenCents, 0);
  assert.ok(!o.tasks.some((t) => t.key.startsWith("ref-")));
  // Zweite Miete mit Storno-Beleg: wirksam 0, nie offen, nie überfällig
  const w2 = await returnedWorld("akte-storno", { within: w });
  const inv2 = await ensureInvoiceDraft(w.tenantId, w2.bookingId, w.actor);
  await finalizeInvoice(w.tenantId, inv2.id, w.actor);
  const st = await createCancellationDraft(w.tenantId, inv2.id, w.actor);
  await finalizeCounterDocument(w.tenantId, st.id, w.actor, { confirmed: true, reason: "Storno im Test" });
  f = await customerFinance(w.tenantId, c.id);
  const inv2Row = f.documents.find((d) => d.id === inv2.id)!;
  assert.equal(inv2Row.financials?.chain, "CANCELLED");
  assert.equal(inv2Row.financials?.openCents, 0);
  o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.openReceivablesCents, 0);
  // Historie enthält nur gespeicherte Zeitpunkte
  const tl = await customerTimeline(w.tenantId, c.id);
  const kinds = new Set(tl.map((e) => e.kind));
  for (const k of ["Kunde", "Buchung", "Vertrag", "Übergabe", "Rückgabe", "Rechnung", "Gutschrift", "Stornobeleg", "Zahlung", "Auszahlung"]) assert.ok(kinds.has(k), `Historie: ${k}`);
  assert.ok(tl.every((e) => e.at instanceof Date && !Number.isNaN(e.at.getTime())));
  assert.ok(tl.some((e) => e.title.includes("storniert")), "Storno einer Zahlung/Auszahlung als eigenes Ereignis (gespeicherter Zeitpunkt)");
});

test("Kautionen: offen, erhalten, freigegeben, ausgezahlt – Stand aus computeDepositFinancials; Kaution ist kein Umsatz", async () => {
  const { w } = await invoicedWorld("akte-kaution");
  const c = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  let rows = await customerDeposits(w.tenantId, c.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receivedCents, 50_000);
  assert.equal(rows[0].remainingCents, 50_000);
  let o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.depositsHeld, 1, "nach Rückgabe noch nicht entschieden");
  assert.ok(o.tasks.some((t) => t.key.startsWith("dephold-")));
  await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: "400", reason: "Reinigung", occurredAt: at });
  o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.depositsHeld, 0);
  assert.equal(o.depositPayoutOpenCents, 40_000);
  await createPayout(w.tenantId, w.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId }, { amount: "400", method: "CASH", executedAt: at }, { complete: true, confirmed: true });
  rows = await customerDeposits(w.tenantId, c.id);
  assert.equal(rows[0].completedPayoutCents, 40_000);
  assert.equal(rows[0].payoutRemainingCents, 0);
  assert.equal(rows[0].retainedCents, 10_000);
  o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.depositPayoutOpenCents, 0);
  const f = await customerFinance(w.tenantId, c.id);
  assert.equal(f.sums.effectiveInvoiceCents, 100_000, "Kaution taucht nicht im Rechnungsvolumen auf");
  assert.equal(f.sums.payoutsCompletedCents, 40_000, "Kautionsauszahlung ist Geldabfluss, kein Umsatz");
});

test("Schäden: nur Akten zu Buchungen der Person; UNASSESSED/UNCLEAR ist keine Kundenverantwortung; hofinterne Schäden fehlen", async () => {
  const { w } = await invoicedWorld("akte-schaden");
  const c = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  const d1 = await reportDamage(w.tenantId, w.actor, { vehicleId: w.vehicleId, view: "LEFT", posX: 0.4, posY: 0.5, kind: "SCRATCH", description: "Kratzer nach Rückgabe", bookingId: w.bookingId });
  const { damageCase } = await openDamageCase(w.tenantId, d1.id, w.actor);
  const hof = await reportDamage(w.tenantId, w.actor, { vehicleId: w.vehicleId, view: "FRONT", posX: 0.2, posY: 0.4, kind: "CHIP", description: "Steinschlag ohne Miete" });
  await openDamageCase(w.tenantId, hof.id, w.actor);
  const rows = await customerDamageCases(w.tenantId, c.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, damageCase.id);
  assert.equal(rows[0].liabilityStatus, "UNASSESSED");
  const o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.openDamageCases, 1);
  const task = o.tasks.find((t) => t.key === "damage")!;
  assert.ok(task && task.tone === "grey" && /keine automatische Zuordnung/.test(task.detail));
  await setLiability(w.tenantId, damageCase.id, w.actor, "UNCLEAR", "Prüfung");
  assert.equal((await customerDamageCases(w.tenantId, c.id))[0].customerChargeCents, null);
});

test("Behördenvorgänge nur mit echter Fahrerbestimmung; Dokumente und Mails nur mit Bezug; Hofmitarbeiter ohne Behördendokumente; keine Fremdmandanten", async () => {
  const { w } = await invoicedWorld("akte-behoerde");
  const c = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  const bk = await db.booking.update({ where: { id: w.bookingId }, data: { actualPickupAt: new Date(Date.now() - 4 * 86400_000), actualReturnAt: new Date(Date.now() - 3600_000) } });
  const offense = new Date(bk.actualPickupAt!.getTime() + 2 * 3600_000);
  const p = zonedParts(offense);
  const plate = (await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).plate;
  const bh = await createAuthorityCase(w.tenantId, w.actor, { type: "SPEEDING", authorityName: "Stadtamt Bremen", authorityReference: "AZ 1/1", licensePlate: plate, offenseDate: toDateInputValue(offense), offenseTime: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`, responseDeadline: new Date(Date.now() + 2 * 86400_000) });
  assert.equal(bh.bookingId, w.bookingId, "Vermietung automatisch zugeordnet");
  let o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.openAuthorityCases, 0, "ohne Fahrerbestimmung kein Vorgang in der Kundenakte – nicht aus Kennzeichen/Zeitraum abgeleitet");
  const driverId = (await db.contractDriver.findFirstOrThrow({ where: { tenantId: w.tenantId, contractId: bh.contractId!, role: "PRIMARY_DRIVER" } })).id;
  await setDriver(w.tenantId, bh.id, w.actor, { mode: "CONTRACT", contractDriverId: driverId, confirmed: true });
  o = await customerOverview(w.tenantId, c.id, c);
  assert.equal(o.openAuthorityCases, 1);
  assert.ok(o.tasks.some((t) => t.key === `auth-${bh.id}`));
  // Dokumente: Vertrags-PDF mit Bezug; Behördendokument nur für Disposition/Inhaber sichtbar
  await ensureContractDocument(w.tenantId, w.contractId, w.actor.id, { storage });
  await db.authorityCaseDocument.create({ data: { tenantId: w.tenantId, caseId: bh.id, type: "INCOMING_NOTICE", fileName: "Anhoerung.pdf", storageKey: `tenants/${w.tenantId}/authority/${bh.id}/x.pdf`, contentType: "application/pdf", sizeBytes: 10, checksum: "abc" } });
  const docsOwner = await customerDocuments(w.tenantId, c.id, "OWNER");
  assert.ok(docsOwner.some((d) => d.kind === "BOOKING" && d.type === "RENTAL_CONTRACT" && d.href.startsWith("/api/documents/")));
  assert.ok(docsOwner.some((d) => d.kind === "AUTHORITY" && d.href.startsWith("/api/authority-documents/")));
  const docsYard = await customerDocuments(w.tenantId, c.id, "YARD");
  assert.ok(!docsYard.some((d) => d.kind === "AUTHORITY"), "Hofmitarbeiter sehen keine Behördendokumente in der Kundenakte");
  assert.ok(docsOwner.every((d) => !/^https?:/.test(d.href)), "keine öffentlichen Adressen");
  // Kommunikation: Versandprotokoll, fehlgeschlagene Sendung sichtbar mit Fehler
  const mail = await enqueueEmail({ tenantId: w.tenantId, bookingId: w.bookingId, recipient: "erika@example.test", subject: "Ihre Unterlagen", template: "PICKUP_DOCUMENTS", idempotencyKey: `test-${w.bookingId}` });
  await markEmailFailed(w.tenantId, mail.id, "SMTP nicht erreichbar");
  const mails = await customerEmails(w.tenantId, c.id);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].status, "FAILED");
  assert.equal(mails[0].error, "SMTP nicht erreichbar");
  // letzte Aktivität = jüngster Zeitstempel
  const head = await customerHeader(w.tenantId, c.id);
  assert.ok(head?.lastActivityAt && head.lastActivityAt.getTime() >= mail.createdAt.getTime() - 1000);
  // Fremdmandant sieht nichts
  const other = await createWorld("akte-fremd");
  tenants.push(other.tenantId);
  assert.equal(await customerHeader(other.tenantId, c.id), null);
  assert.equal((await customerFinance(other.tenantId, c.id)).documents.length, 0);
  assert.equal((await customerDocuments(other.tenantId, c.id, "OWNER")).length, 0);
  assert.equal((await customerEmails(other.tenantId, c.id)).length, 0);
  assert.equal((await customerDeposits(other.tenantId, c.id)).length, 0);
  assert.equal((await customerBookings(other.tenantId, c.id)).total, 0);
  assert.equal((await customerTimeline(other.tenantId, c.id)).length, 0);
});
