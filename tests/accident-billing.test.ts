// Befehl 29 Phase F: Unfallersatz-Abrechnung, Zahlungen, Kürzungen, Restforderung und Dokumente.
// Schlussrechnung nur nach der Rückgabe aus der tatsächlichen Mietdauer und dem eingefrorenen Vertragstarif; Zwischenrechnungen
// bis zu einem Stichtag; je Fall wird jede Leistung genau einmal fakturiert (auch über Empfänger hinweg); Empfänger-Kopie
// versiegelt; Zahlungen über die bestehende Logik; Kürzungen nur Dokumentation (offene Forderung bleibt); Restforderung an den
// Mieter nur bewusst, Doppelforderung sichtbar; Fallsperre für alle Finanzänderungen; Standardrechnung unverändert.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import {
  archiveAccidentDocument, caseFinancials, closeCase, closeWarnings, createAccidentCase, registerAccidentDocument, reopenCase, updateInsurer, updatePlannedEnd,
  type CreateAccidentCaseInput,
} from "../src/lib/accident-replacement";
import { billingFlags, caseFileBilling, caseFileDocuments, caseFileHeader, caseTariff } from "../src/lib/accident-case-file";
import { accidentRentState } from "../src/lib/accident-pricing";
import {
  createAccidentInvoiceDraft, createAccidentRemainderDraft, discardInvoiceDraft, ensureInvoiceDraft, finalizeInvoice, getInvoiceState, previewAccidentInvoice, startInvoiceEdit,
  updateInvoiceDraft, verifyInvoice,
} from "../src/lib/invoices";
import { createCancellationDraft, createCreditNoteDraft, discardCounterDocumentDraft, finalizeCounterDocument, invoiceFinancials } from "../src/lib/counter-documents";
import { createPayout } from "../src/lib/payouts";
import { authorizeKeyDrop } from "../src/lib/key-drop";
import { customerDocuments } from "../src/lib/customer-file";
import { ACCIDENT_BILLING_WHERE, ACCIDENT_CASE_CLOSED_MESSAGE, isAccidentBillingDocument } from "../src/lib/accident-replacement-events";
import { cancelPayment, invoicePaymentSummary, recordInvoicePayment } from "../src/lib/payments";
import { adjustmentSummary, cancelInvoiceAdjustment, recordInvoiceAdjustment } from "../src/lib/invoice-adjustments";
import { applyDepositOffset, depositOffsetOptions } from "../src/lib/deposit-offset";
import { recordDepositReceived } from "../src/lib/deposits";
import { createDunningNotice, listReceivables, previewDunning } from "../src/lib/dunning";
import { loadDashboard } from "../src/lib/dashboard";
import { globalSearch } from "../src/lib/search";
import { planInvoiceMail, sendInvoiceDocument } from "../src/lib/rental-mail";
import { ensureInvoiceDocument } from "../src/lib/documents";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { renderInvoicePdf } from "../src/lib/pdf/invoice-pdf";
import { finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { finalizeHandover, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { confirmProposal } from "../src/lib/returns";
import { rentalDays } from "../src/lib/pricing";
import { toCents } from "../src/lib/money";
import { buildStorageKey, getStorage, type StorageDriver } from "../src/lib/storage";
import { sha256 } from "../src/lib/integrity";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { answerAll, photo, returnedWorld, sign } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-ue-f-"));
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
const nonce = () => `ue-f-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const CLOSED = /Der Unfallersatzfall ist abgeschlossen und kann nicht mehr bearbeitet werden\./;
const sp = (s: string) => s.replace(/ /g, " ");

type AWorld = World & { v2: string };

async function world(label: string): Promise<AWorld> {
  await ready;
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });
  await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UF ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, make: "VW", model: "Golf", groupId: w.groupId, fuel: "BENZIN", mileage: 30_000, dailyRate: 59, kmIncludedPerDay: 100, extraKmRate: 0.4, deposit: 0, tankCapacityLiters: 50, requiredLicenseClass: "B" } });
  return { ...w, v2: v2.id };
}

/** Tagessatz 79 €, Haftungsreduzierung 15 €/Tag, Zustellung 40 € und Abholung 20 € einmalig (alles brutto). */
function caseInput(w: AWorld, over: Partial<CreateAccidentCaseInput> = {}): CreateAccidentCaseInput {
  return {
    nonce: nonce(), customerId: w.customerId, vehicleId: w.v2, startAt: plus(new Date(), HOUR), plannedEndAt: null, dailyRateCents: 7_900, depositCents: 0, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "hb-ab 123", make: "Opel", model: "Astra", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: plus(new Date(), -2 * DAY), place: "Bremen" },
    insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-2026-4711", contactName: null, phone: null, email: null, street: "Merkweg 1", zip: "28195", city: "Bremen" },
    liability: { status: "CONFIRMED" },
    tariff: [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1_500 }, { kind: "DELIVERY", perDay: false, unitPriceCents: 4_000 }, { kind: "PICKUP", perDay: false, unitPriceCents: 2_000 }],
    ...over,
  };
}
const PER_DAY = 7_900 + 1_500, ONE_OFF = 4_000 + 2_000;

const contractOf = (w: AWorld, bookingId: string) => db.rentalContract.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId } });

/** Fall anlegen, Konditionen (offenes Ende), Unterschrift, Übergabe; Übergabe auf „vor pickupAgo“ zurückdatiert. */
async function runningCase(w: AWorld, pickupAgo: number, over: Partial<CreateAccidentCaseInput> = {}, deposit = 0) {
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, over));
  const c = await contractOf(w, res.bookingId);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: null, deposit, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 500, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" }, w.actor);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  const ww = { ...w, bookingId: res.bookingId, vehicleId: w.v2 };
  const p = await startHandover(w.tenantId, res.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 30_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, p.id, cat);
  await answerAll(ww, p.id);
  await sign(ww, p.id);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  const pickupAt = new Date(Date.now() - pickupAgo);
  await db.booking.update({ where: { id: res.bookingId }, data: { actualPickupAt: pickupAt } });
  return { ...res, caseId: res.case.id, pickupAt };
}
/** Rückgabe über das bestehende Protokoll; mit Mehrkilometern wird der Vorschlag bewusst bestätigt (Zusatzkosten). */
async function returnCase(w: AWorld, bookingId: string, opts: { mileage?: number; confirmMileage?: boolean } = {}) {
  const ww = { ...w, bookingId, vehicleId: w.v2 };
  const r = await startHandover(w.tenantId, bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: opts.mileage ?? 30_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, r.id, cat);
  await answerAll(ww, r.id);
  if (opts.confirmMileage) await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
  await sign(ww, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  return db.booking.findUniqueOrThrow({ where: { id: bookingId } });
}
const versionOf = (invoiceId: string) => db.invoiceVersion.findFirstOrThrow({ where: { invoiceId }, orderBy: { versionNo: "desc" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
const daysIn = (items: { source: string; unit: string; quantity: unknown }[]) => items.filter((i) => i.source === "RENTAL" && i.unit === "Tag").reduce((s, i) => s + Number(i.quantity), 0);
async function invoice(w: AWorld, caseId: string, role: "INSURER" | "RENTER" | "OTHER", periodEnd?: Date, other?: Record<string, string>) {
  const { invoice: inv } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId, recipientRole: role, periodEnd: periodEnd ?? null, nonce: nonce(), other });
  return finalizeInvoice(w.tenantId, inv.id, w.actor).then((v) => ({ id: inv.id, version: v }));
}
async function insurerLetter(w: AWorld, caseId: string, bookingId: string, type = "INSURER_LETTER") {
  const bytes = new TextEncoder().encode(`%PDF-1.4\n% Schreiben ${nonce()}\n`);
  const key = buildStorageKey({ tenantId: w.tenantId, area: "documents", bookingId, contentType: "application/pdf" });
  await storage.put(key, bytes, "application/pdf");
  return registerAccidentDocument(w.tenantId, caseId, w.actor, { type, fileName: "Kürzungsschreiben.pdf", storageKey: key, contentType: "application/pdf", sizeBytes: bytes.length, checksum: sha256(bytes) });
}

// ---------------------------------------------------------------------------
// 1–5: Schlussrechnung aus der tatsächlichen Mietdauer und dem eingefrorenen Vertragstarif
// ---------------------------------------------------------------------------

test("1/2/3/4/5: Schlussrechnung erst nach der Rückgabe, tatsächliche Mietdauer (nicht geplantes Ende), Vertragstarif statt veränderter Stammdaten, Fallakte = Rechnung", async () => {
  const w = await world("uf-final");
  const r = await runningCase(w, 3 * DAY + 2 * HOUR);
  // 2: vor der Rückgabe keine Schlussrechnung – ohne Stichtag abgelehnt, auch in der Vorschau
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "INSURER", nonce: nonce() }), /Stichtag/);
  await assert.rejects(() => previewAccidentInvoice(w.tenantId, { caseId: r.caseId }), /Stichtag/);
  // geplantes Ende weit in der Zukunft; Stammdaten nach der Unterschrift verändert – beides darf die Rechnung nicht beeinflussen
  await updatePlannedEnd(w.tenantId, r.caseId, w.actor, { plannedEndAt: plus(new Date(), 20 * DAY), reason: "Werkstatt braucht länger" });
  await db.accidentReplacementTariffItem.updateMany({ where: { caseId: r.caseId }, data: { unitPriceCents: 99_900 } });
  await db.booking.update({ where: { id: r.bookingId }, data: { dailyRate: 1 } });
  await db.vehicle.update({ where: { id: w.v2 }, data: { dailyRate: 999 } });
  const b = await returnCase(w, r.bookingId);
  const days = rentalDays(r.pickupAt, b.actualReturnAt!);
  assert.equal(days, 4, "3 Tage 2 Stunden = 4 Miettage");
  // Vorschau = Entwurf
  const pv = await previewAccidentInvoice(w.tenantId, { caseId: r.caseId });
  assert.equal(pv.type, "FINAL");
  assert.equal(pv.days, 4);
  assert.equal(pv.grossCents, 4 * PER_DAY + ONE_OFF);
  const { invoice: inv } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "INSURER", nonce: nonce() });
  const draft = await versionOf(inv.id);
  assert.equal(toCents(draft.grossTotal), pv.grossCents, "Vorschau und Entwurf rechnen gleich");
  assert.equal(draft.servicePeriodStart.getTime(), r.pickupAt.getTime(), "Beginn = tatsächliche Übergabe");
  assert.equal(draft.servicePeriodEnd.getTime(), b.actualReturnAt!.getTime(), "Ende = tatsächliche Rückgabe, nicht das geplante Ende");
  assert.equal(daysIn(draft.items), 4);
  const snap = draft.customerSnapshot as { accidentBilling?: { type: string; days: number } };
  assert.equal(snap.accidentBilling?.type, "FINAL");
  // 4: Vertragstarif (79 € + 15 €/Tag) statt verändertem Fall-/Buchungstarif
  assert.ok(draft.items.some((i) => i.source === "RENTAL" && toCents(i.unitPrice) === 7_900));
  assert.ok(draft.items.some((i) => i.description.startsWith("Haftungsreduzierung") && toCents(i.unitPrice) === 1_500));
  // 5: Fallakte (finaler Mietwert, zentrale Formel) und Rechnung laufen nicht auseinander
  const tariff = await caseTariff(w.tenantId, r.caseId, r.bookingId);
  const rent = accidentRentState(b, tariff);
  assert.equal(rent.phase, "FINAL");
  assert.equal(rent.phase === "FINAL" ? rent.value.cents : -1, toCents(draft.grossTotal));
  // 1: Abschluss nach der Rückgabe
  const v = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  assert.equal(v.status, "FINALIZED");
  // keine zweite Schlussrechnung, auch nicht an einen anderen Empfänger
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "RENTER", nonce: nonce() }), /bereits vollständig abgerechnet/);
  const fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.finalBilled, true);
  assert.equal(fin.grossCents, 4 * PER_DAY + ONE_OFF);
  assert.ok(billingFlags(fin, b).some((f) => f.label === "Schlussgerechnet"));
});

// ---------------------------------------------------------------------------
// 22/23/24: Zwischen- und Schlussrechnung mit mehreren Mietdauern – nie doppelt, Summe = Gesamtleistung
// ---------------------------------------------------------------------------

for (const sc of [
  { name: "20 Tage, Zwischenrechnung nach genau 10 Tagen", pickupAgo: 19 * DAY + 3 * HOUR, interims: [10 * DAY], expectDays: [10, 10] },
  { name: "20 Tage, Zwischenrechnung nach 10 Tagen und 1 Stunde (angefangener Tag zählt)", pickupAgo: 19 * DAY + 3 * HOUR, interims: [10 * DAY + HOUR], expectDays: [11, 9] },
  { name: "14 Tage, zwei Zwischenrechnungen", pickupAgo: 13 * DAY + 5 * HOUR, interims: [5 * DAY, 9 * DAY + 30 * 60_000], expectDays: [5, 5, 4] },
  { name: "2 Tage, Zwischenrechnung nach 3 Stunden", pickupAgo: DAY + 6 * HOUR, interims: [3 * HOUR], expectDays: [1, 1] },
]) {
  test(`22/23/24: ${sc.name} – keine doppelten Miettage, Tages- und Einmalpositionen; Zusatzkosten nur einmal; Summe = Gesamtleistung`, async () => {
    const w = await world("uf-chain");
    const r = await runningCase(w, sc.pickupAgo);
    const ids: string[] = [];
    for (const off of sc.interims) {
      // 22: Stichtag in der Zukunft abgelehnt, Stichtag vor dem bereits Abgerechneten abgelehnt
      await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "INSURER", periodEnd: plus(new Date(), HOUR), nonce: nonce() }), /Zukunft/);
      ids.push((await invoice(w, r.caseId, "INSURER", plus(r.pickupAt, off))).id);
      await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "INSURER", periodEnd: plus(r.pickupAt, off - HOUR), nonce: nonce() }), /bereits abgerechnet/);
    }
    // Rückgabe mit Mehrkilometern (bestätigte Zusatzkosten)
    const b = await returnCase(w, r.bookingId, { mileage: 30_100 + 200 * 30, confirmMileage: true });
    const totalDays = rentalDays(r.pickupAt, b.actualReturnAt!);
    ids.push((await invoice(w, r.caseId, "INSURER")).id);
    const versions = await Promise.all(ids.map(versionOf));
    assert.deepEqual(versions.map((v) => daysIn(v.items)), sc.expectDays);
    assert.equal(versions.reduce((s, v) => s + daysIn(v.items), 0), totalDays, "Summe der Miettage = tatsächliche Miettage");
    // Leistungszeiträume schließen lückenlos aneinander an
    for (let i = 1; i < versions.length; i++) assert.equal(versions[i].servicePeriodStart.getTime(), versions[i - 1].servicePeriodEnd.getTime());
    // 24: Einmalpositionen genau einmal (in der ersten Rechnung); Tagespositionen je Rechnung mit deren Tagen
    const oneOffs = versions.flatMap((v) => v.items.filter((i) => i.description === "Zustellung" || i.description === "Abholung"));
    assert.equal(oneOffs.length, 2);
    assert.ok(versions[0].items.some((i) => i.description === "Zustellung"));
    const lr = versions.flatMap((v) => v.items.filter((i) => i.description.startsWith("Haftungsreduzierung"))).reduce((s, i) => s + Number(i.quantity), 0);
    assert.equal(lr, totalDays);
    // Zusatzkosten nur in der Schlussrechnung, genau einmal
    const charges = versions.flatMap((v) => v.items.filter((i) => i.source === "EXTRA_CHARGE"));
    assert.equal(charges.length, 1);
    assert.equal(versions[versions.length - 1].items.filter((i) => i.source === "EXTRA_CHARGE").length, 1);
    const charge = await db.extraCharge.findUniqueOrThrow({ where: { id: charges[0].extraChargeId! } });
    // Summe aller Rechnungen = finaler Mietwert der Fallakte + Zusatzkosten
    const rent = accidentRentState(b, await caseTariff(w.tenantId, r.caseId, r.bookingId));
    const total = versions.reduce((s, v) => s + toCents(v.grossTotal), 0);
    assert.equal(total, (rent.phase === "FINAL" ? rent.value.cents : 0) + toCents(charge.amount));
    assert.equal(total, totalDays * PER_DAY + ONE_OFF + toCents(charge.amount));
    const fin = await caseFinancials(w.tenantId, r.bookingId);
    assert.equal(fin.finalBilled, true);
    assert.equal(fin.gaps.length, 0);
    // die Rechnung erklärt die Abrechnung (Abrechnungsart, Miettage, frühere Rechnungen)
    const last = await loadInvoiceDocumentData(w.tenantId, versions[versions.length - 1].id);
    assert.equal(last.doc.title, "Schlussrechnung");
    assert.match(sp(last.doc.accident!.note), new RegExp(`${totalDays} Miettage, davon ${totalDays - sc.expectDays[sc.expectDays.length - 1]} Miettage? zuvor`));
  });
}

test("Zwischenrechnung deckt den Rückgabetag schon ab: keine Sackgasse – „vollständig abgerechnet“ statt „Schlussrechnung fehlt“", async () => {
  const w = await world("uf-covered");
  const r = await runningCase(w, 2 * DAY + 2 * HOUR);
  await invoice(w, r.caseId, "INSURER", new Date(Date.now() - HOUR));
  const b = await returnCase(w, r.bookingId);
  assert.equal(rentalDays(r.pickupAt, b.actualReturnAt!), 3);
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "INSURER", nonce: nonce() }), /bereits vollständig abgerechnet/);
  const h = (await caseFileHeader(w.tenantId, r.caseId, "FULL"))!;
  assert.notEqual(h.mainStatus.label, "Schlussrechnung fehlt");
  assert.ok(!(await closeWarnings(w.tenantId, r.caseId)).some((x) => x.code === "FINAL_INVOICE_MISSING"));
  const bill = await caseFileBilling(w.tenantId, h);
  assert.equal(bill.actions.canFinal, false);
  assert.ok(bill.flags.some((f) => f.label === "Vollständig abgerechnet"));
});

// ---------------------------------------------------------------------------
// 5–9: Rechnungsempfänger, versiegelte Kopie, PDF
// ---------------------------------------------------------------------------

test("5/6/7/8/9: Empfänger Versicherung, Mieter, anderer Empfänger; Kopie versiegelt – spätere Änderungen an Fall, Kunde und Adressbuch ändern nichts; Fall-/Schadennummer im PDF", async () => {
  const w = await world("uf-recipients");
  const r = await runningCase(w, 6 * DAY + HOUR);
  // 7: anderer Empfänger nur mit Rechnungsdaten
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "OTHER", periodEnd: plus(r.pickupAt, 2 * DAY), nonce: nonce(), other: { type: "COMPANY", companyName: "", street: "x", zip: "1", city: "y" } }), /Firmennamen/);
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "OTHER", periodEnd: plus(r.pickupAt, 2 * DAY), nonce: nonce(), other: { type: "COMPANY", companyName: "Leasing GmbH", street: "", zip: "", city: "" } }), /Anschrift/);
  const ins = await invoice(w, r.caseId, "INSURER", plus(r.pickupAt, 2 * DAY));
  const ren = await invoice(w, r.caseId, "RENTER", plus(r.pickupAt, 4 * DAY));
  const oth = await invoice(w, r.caseId, "OTHER", plus(r.pickupAt, 6 * DAY), { type: "COMPANY", companyName: "Leasing Nord GmbH", street: "Hafenweg 2", zip: "28217", city: "Bremen", email: "rechnung@leasing-nord.example" });
  const [vi, vr, vo] = await Promise.all([versionOf(ins.id), versionOf(ren.id), versionOf(oth.id)]);
  const si = vi.customerSnapshot as Record<string, unknown>, sr = vr.customerSnapshot as Record<string, unknown>, so = vo.customerSnapshot as Record<string, unknown>;
  assert.equal(si.recipientRole, "INSURER"); assert.equal(si.companyName, "MERKVERSICHERUNG-AG"); assert.equal(si.claimNumber, "SN-2026-4711"); assert.equal(si.insuredName, "Erika Muster"); assert.match(String(si.caseNumber), /^UE-/);
  assert.equal(sr.recipientRole, "RENTER"); assert.equal(sr.lastName, "Muster"); assert.equal(sr.email, "erika@example.test");
  assert.equal(so.recipientRole, "OTHER"); assert.equal(so.companyName, "Leasing Nord GmbH"); assert.equal(so.email, "rechnung@leasing-nord.example", "keine stille Mieteradresse"); assert.equal(so.insuredName, "Erika Muster");
  // 8: spätere Änderungen an Versicherung (Fall + Adressbuch) und Kunde ändern die abgeschlossene Rechnung nicht
  await updateInsurer(w.tenantId, r.caseId, w.actor, { insurer: { name: "ANDERE VERSICHERUNG", claimNumber: "NEU-1", street: "Neuweg 9", zip: "10115", city: "Berlin", email: "neu@example.test" }, addressBook: true });
  await db.customer.update({ where: { id: w.customerId }, data: { lastName: "Geändert", email: "neu@kunde.example" } });
  assert.deepEqual((await versionOf(ins.id)).customerSnapshot, vi.customerSnapshot);
  assert.deepEqual((await versionOf(ren.id)).customerSnapshot, vr.customerSnapshot);
  assert.equal((await verifyInvoice(w.tenantId, ins.id)).intact, true, "Prüfsumme der versiegelten Fassung stimmt weiterhin");
  // 9: PDF mit Fallnummer, Schadennummer, Geschädigtem, Empfänger, Leistungszeitraum, Miettagen
  const data = await loadInvoiceDocumentData(w.tenantId, ins.version.id);
  const { trace } = await renderInvoicePdf(data.doc);
  const text = sp(trace.texts.join(" | "));
  for (const t of ["SN-2026-4711", String(si.caseNumber), "Erika Muster", "MERKVERSICHERUNG-AG", "Versicherung", "Zwischenrechnung", "Miettage", "Leistungszeitraum"]) assert.ok(text.includes(t), `PDF enthält ${t}`);
  for (const forbidden of ["erstattungsfähig", "muss zahlen", "Schwacke"]) assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `keine Aussage „${forbidden}“`);
});

// ---------------------------------------------------------------------------
// 10–14: Zahlungen, offener Betrag, keine Kautionsverrechnung, kein Mieter-Rückgriff
// ---------------------------------------------------------------------------

test("10/11/12/13/14: Teil- und Mehrfachzahlungen, offener Betrag; Versicherungsrechnung ohne Kautionsangebot und ohne E-Mail-Rückgriff auf den Mieter", async () => {
  const w = await world("uf-pay");
  const r = await runningCase(w, DAY + HOUR, { depositCents: 30_000 }, 300);
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: r.bookingId, amount: "300", method: "CASH", occurredAt: new Date() });
  await returnCase(w, r.bookingId);
  const inv = await invoice(w, r.caseId, "INSURER");
  const gross = 2 * PER_DAY + ONE_OFF; // 248,00 €
  assert.equal(toCents(inv.version.grossTotal), gross);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "100,00", method: "BANK_TRANSFER", paidAt: new Date(), reference: "MERK 1" });
  const p2 = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "48,00", method: "BANK_TRANSFER", paidAt: new Date(), reference: "MERK 2" });
  let s = await invoicePaymentSummary(w.tenantId, inv.id);
  assert.equal(s.paidCents, 14_800); assert.equal(s.openCents, gross - 14_800); assert.equal(s.status, "PARTIAL");
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "999,00", method: "CASH", paidAt: new Date() }), /Überzahlung/);
  await cancelPayment(w.tenantId, w.actor, p2.payment.id, "doppelt erfasst");
  s = await invoicePaymentSummary(w.tenantId, inv.id);
  assert.equal(s.paidCents, 10_000);
  const fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.paidCents, 10_000); assert.equal(fin.openCents, gross - 10_000);
  // 13: keine Kautionsverrechnung mit der Versicherungsrechnung – weder als Angebot noch per Direktaufruf; Rechnungsseite bietet sie nicht an
  assert.equal((await depositOffsetOptions(w.tenantId, r.bookingId)).invoices.length, 0);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: r.bookingId, invoiceId: inv.id, amount: "10", occurredAt: new Date(), idempotencyKey: nonce() }), /Versicherung/);
  const page = await readFile(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rechnung/page.tsx"), "utf8");
  assert.match(page, /const offsetStart = renterInvoice \? depositOffsetStart\(/);
  assert.match(page, /\{renterInvoice && <DepositSettlementCard/);
  // 14: ohne E-Mail der Versicherung kein Versand an den Mieter (Rechnungsmail, erneuter Versand, Mahnung)
  const plan = await planInvoiceMail(w.tenantId, inv.version.id).catch(() => null);
  assert.equal(plan?.recipient ?? null, null);
  await ensureInvoiceDocument(w.tenantId, inv.version.id, w.actor.id, { storage });
  const transport = new FakeTransport();
  const sent = await sendInvoiceDocument(w.tenantId, inv.version.id, { trigger: "MANUAL", nonce: nonce(), actorId: w.actor.id, transport, storage });
  assert.equal(sent.status, "FAILED");
  assert.equal(transport.sent.length, 0, "nichts an den Mieter");
  assert.match(sent.log.error ?? "", /Rechnungsempfänger/);
  const dun = await previewDunning(w.tenantId, inv.id, { now: plus(new Date(), 60 * DAY) });
  assert.equal(dun.recipientEmail, null);
  assert.equal(dun.recipientName, "MERKVERSICHERUNG-AG");
});

// ---------------------------------------------------------------------------
// 15–21: Kürzungen
// ---------------------------------------------------------------------------

test("15/16/17/18/19/20/21: Kürzung dokumentieren, offener Betrag bleibt, Storno mit Grund bleibt sichtbar, Versichererschreiben verknüpfen – nur aus diesem Fall und Mandanten", async () => {
  const w = await world("uf-adjust");
  const r = await runningCase(w, DAY + HOUR);
  const other = await runningCase(w, DAY + HOUR, { vehicleId: (await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UF ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, make: "VW", model: "Polo", groupId: w.groupId, dailyRate: 40, deposit: 0, requiredLicenseClass: "B" } })).id });
  await returnCase(w, r.bookingId);
  const inv = await invoice(w, r.caseId, "INSURER");
  const gross = toCents(inv.version.grossTotal);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "100,00", method: "BANK_TRANSFER", paidAt: new Date() });
  const letter = await insurerLetter(w, r.caseId, r.bookingId);
  // 15/19: Kürzung mit Versichererschreiben dieses Falls
  const adj = await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: inv.id, reasonKind: "TARIFF", amountCents: 5_000, decidedAt: new Date(), note: "Tagessatz über Mittelwert", documentId: letter.id });
  assert.equal(adj.documentId, letter.id);
  // 16: Rechnungsbetrag, Steuer, Zahlungen und offene Forderung unverändert
  const f = await invoiceFinancials(w.tenantId, inv.id);
  assert.equal(f.invoiceCents, gross); assert.equal(f.paidCents, 10_000); assert.equal(f.openCents, gross - 10_000);
  const v2 = await versionOf(inv.id);
  assert.equal(v2.contentHash, inv.version.contentHash); assert.equal(String(v2.taxTotal), String(inv.version.taxTotal));
  const fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.openCents, gross - 10_000, "Kürzung nicht vom offenen Betrag abgezogen");
  assert.equal(fin.reducedCents, 5_000, "separat ausgewiesen");
  // 20: fremdes Dokument (anderer Fall, Abtretung statt Schreiben, archiviert) nicht verknüpfbar
  const foreignLetter = await insurerLetter(w, other.caseId, other.bookingId);
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: inv.id, reasonKind: "OTHER", amountCents: 100, decidedAt: new Date(), documentId: foreignLetter.id }), /nicht gefunden/);
  const assignment = await insurerLetter(w, r.caseId, r.bookingId, "ASSIGNMENT");
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: inv.id, reasonKind: "OTHER", amountCents: 100, decidedAt: new Date(), documentId: assignment.id }), /Schreiben der Versicherung/);
  const archived = await insurerLetter(w, r.caseId, r.bookingId);
  await archiveAccidentDocument(w.tenantId, archived.id, w.actor, "falsches Schreiben", { caseId: r.caseId });
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: inv.id, reasonKind: "OTHER", amountCents: 100, decidedAt: new Date(), documentId: archived.id }), /archiviert/);
  // Obergrenze: Summe der Kürzungen höchstens die wirksame Forderung
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: inv.id, reasonKind: "OTHER", amountCents: gross, decidedAt: new Date() }), /übersteigen/);
  // 21: fremder Mandant kann keine Kürzung erfassen oder stornieren und kein fremdes Dokument nutzen
  const b = await world("uf-adjust-b");
  await assert.rejects(() => recordInvoiceAdjustment(b.tenantId, b.actor, { invoiceId: inv.id, reasonKind: "TARIFF", amountCents: 100, decidedAt: new Date() }), /nicht gefunden/);
  await assert.rejects(() => cancelInvoiceAdjustment(b.tenantId, b.actor, adj.id, "fremder Mandant"), /nicht gefunden/);
  // 17/18: Storno mit Grund – nicht gelöscht, nachvollziehbar (Zeitpunkt, Benutzer, Grund, Audit, Verlauf)
  await assert.rejects(() => cancelInvoiceAdjustment(w.tenantId, w.actor, adj.id, ""), /Grund/);
  await cancelInvoiceAdjustment(w.tenantId, w.actor, adj.id, "Versicherung hat nachgezahlt");
  const row = await db.invoiceAdjustment.findUniqueOrThrow({ where: { id: adj.id } });
  assert.equal(row.status, "CANCELLED"); assert.equal(row.cancellationReason, "Versicherung hat nachgezahlt"); assert.ok(row.cancelledAt); assert.equal(row.cancelledByName, w.actor.name);
  assert.equal((await adjustmentSummary(w.tenantId, inv.id)).rows.length, 1);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "INVOICE_ADJUSTMENT_CANCELLED" } }), 1);
  assert.equal(await db.accidentReplacementCaseEvent.count({ where: { caseId: r.caseId, type: "ADJUSTMENT_CANCELLED" } }), 1);
  // Kürzungen nur zu Versicherungsrechnungen
  const r2 = await runningCase(w, DAY + HOUR, { vehicleId: (await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UF ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, make: "VW", model: "Up", groupId: w.groupId, dailyRate: 40, deposit: 0, requiredLicenseClass: "B" } })).id });
  await returnCase(w, r2.bookingId);
  const renterInv = await invoice(w, r2.caseId, "RENTER");
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: renterInv.id, reasonKind: "TARIFF", amountCents: 100, decidedAt: new Date() }), /Versicherung/);
});

// ---------------------------------------------------------------------------
// Restforderung an den Mieter, Doppelforderung, Abschlusswarnungen (Spec 18/19/22)
// ---------------------------------------------------------------------------

test("Restforderung an den Mieter nur bewusst und höchstens die dokumentierte Kürzung; Doppelforderung wird ausgewiesen, nie still; Abschlusswarnungen mit Finanzdaten", async () => {
  const w = await world("uf-remainder");
  const r = await runningCase(w, 4 * DAY + HOUR);
  await returnCase(w, r.bookingId);
  const inv = await invoice(w, r.caseId, "INSURER");
  const gross = toCents(inv.version.grossTotal); // 5 × 94 + 60 = 530,00 €
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "400,00", method: "BANK_TRANSFER", paidAt: new Date() });
  // ohne Kürzung keine Restforderung
  await assert.rejects(() => createAccidentRemainderDraft(w.tenantId, w.actor, { caseId: r.caseId, invoiceId: inv.id, amountCents: 1_000, nonce: nonce() }), /keine Kürzung/);
  await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: inv.id, reasonKind: "DURATION", amountCents: 13_000, decidedAt: new Date() });
  let fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.unresolvedReductionCents, 13_000, "Kürzung ohne Entscheidung");
  let codes = (await closeWarnings(w.tenantId, r.caseId)).map((x) => x.code);
  assert.ok(codes.includes("REDUCTION_OPEN") && codes.includes("OPEN_AMOUNT"));
  // Obergrenze und keine Rechnung an Dritte als Grundlage
  await assert.rejects(() => createAccidentRemainderDraft(w.tenantId, w.actor, { caseId: r.caseId, invoiceId: inv.id, amountCents: 13_001, nonce: nonce() }), /Höchstens/);
  const { invoice: rem } = await createAccidentRemainderDraft(w.tenantId, w.actor, { caseId: r.caseId, invoiceId: inv.id, amountCents: 13_000, nonce: nonce() });
  const st = await getInvoiceState(w.tenantId, rem.id);
  assert.ok(st.issues.some((i) => i.code === "REMAINDER_DOUBLE" && i.severity === "warning"), "deutliche Warnung im Entwurf");
  const rv = await versionOf(rem.id);
  assert.equal(toCents(rv.grossTotal), 13_000);
  assert.equal((rv.customerSnapshot as { recipientRole: string }).recipientRole, "RENTER");
  assert.equal((rv.customerSnapshot as { accidentBilling: { remainderOf: { invoiceId: string } } }).accidentBilling.remainderOf.invoiceId, inv.id);
  await finalizeInvoice(w.tenantId, rem.id, w.actor);
  // keine zweite Restforderung über denselben Betrag
  await assert.rejects(() => createAccidentRemainderDraft(w.tenantId, w.actor, { caseId: r.caseId, invoiceId: inv.id, amountCents: 100, nonce: nonce() }), /bereits vollständig als Restforderung/);
  // die Versicherungsrechnung bleibt unverändert offen; die Doppelforderung ist sichtbar
  assert.equal((await invoiceFinancials(w.tenantId, inv.id)).openCents, gross - 40_000);
  fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.doubleClaimCents, 13_000);
  assert.equal(fin.doubleClaimHint, "BOTH_OPEN");
  assert.equal(fin.openCents, gross - 40_000 + 13_000);
  assert.equal(fin.economicOpenCents, gross - 40_000);
  assert.equal(fin.unresolvedReductionCents, 0);
  codes = (await closeWarnings(w.tenantId, r.caseId)).map((x) => x.code);
  assert.ok(codes.includes("DOUBLE_CLAIM"));
  // Mieter zahlt die Restforderung: Versicherungsrechnung noch offen → Hinweis „per Gutschrift mindern“
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: rem.id, amount: "130,00", method: "CASH", paidAt: new Date() });
  fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.doubleClaimCents, 13_000);
  assert.equal(fin.doubleClaimHint, "RENTER_PAID");
  assert.equal(fin.economicOpenCents, 0, "wirtschaftlich nichts mehr offen");
  assert.ok((await closeWarnings(w.tenantId, r.caseId)).some((x) => x.code === "DOUBLE_CLAIM" && /Mieter hat die Restforderung bezahlt/.test(x.text)));
  // bewusste Gutschrift über den Restbetrag auf der Versicherungsrechnung: nichts mehr offen, keine Doppelforderung
  const cv = await versionOf(inv.id);
  const credit = await createCreditNoteDraft(w.tenantId, inv.id, w.actor, [{ sourceItemId: cv.items[0].id, mode: "AMOUNT", grossAmount: "130,00" }]);
  await finalizeCounterDocument(w.tenantId, credit.id, w.actor, { confirmed: true, reason: "Restbetrag vom Mieter getragen" });
  fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.openCents, 0);
  assert.equal(fin.doubleClaimCents, 0);
  assert.ok(!(await closeWarnings(w.tenantId, r.caseId)).some((x) => x.code === "OPEN_AMOUNT" || x.code.startsWith("DOUBLE")));
});

test("Review: Versicherung zahlt trotz Kürzung voll → Doppelforderung sichtbar; Restforderung nicht über Bezahltes hinaus; Fassung 2 umgeht die Obergrenze nicht; Kürzungsstorno und Storno der Versicherungsrechnung lassen keine stille Restforderung", async () => {
  const w = await world("uf-remainder-2");
  const r = await runningCase(w, 4 * DAY + HOUR);
  await returnCase(w, r.bookingId);
  const inv = await invoice(w, r.caseId, "INSURER");
  const gross = toCents(inv.version.grossTotal);
  const adj = await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: inv.id, reasonKind: "TARIFF", amountCents: 10_000, decidedAt: new Date() });
  const { invoice: rem } = await createAccidentRemainderDraft(w.tenantId, w.actor, { caseId: r.caseId, invoiceId: inv.id, amountCents: 10_000, nonce: nonce() });
  await finalizeInvoice(w.tenantId, rem.id, w.actor);
  // die Versicherung zahlt doch alles: nichts mehr offen, aber die Restforderung verlangt denselben Betrag noch einmal
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: (gross / 100).toFixed(2).replace(".", ","), method: "BANK_TRANSFER", paidAt: new Date() });
  let fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.doubleClaimCents, 10_000);
  assert.equal(fin.doubleClaimHint, "INSURER_PAID");
  assert.equal(fin.economicOpenCents, 0);
  assert.ok((await closeWarnings(w.tenantId, r.caseId)).some((x) => x.code === "DOUBLE_CLAIM" && /Restforderung stornieren/.test(x.text)));
  // Fassung 2 der Restforderung kann die Obergrenze nicht umgehen
  const draft2 = await startInvoiceEdit(w.tenantId, rem.id, w.actor);
  await updateInvoiceDraft(w.tenantId, rem.id, w.actor, { items: draft2.items.map((i) => ({ id: i.id, description: i.description, quantity: "1", unit: i.unit, unitPrice: "300,00", taxRate: String(i.taxRate) })) });
  assert.ok((await getInvoiceState(w.tenantId, rem.id)).issues.some((i) => i.code === "REMAINDER_AMOUNT" && i.severity === "error"));
  await assert.rejects(() => finalizeInvoice(w.tenantId, rem.id, w.actor), /Restforderung/);
  await discardInvoiceDraft(w.tenantId, rem.id, w.actor);
  // Kürzung storniert: die Restforderung hat keine Grundlage mehr – Hinweis statt Stille
  await cancelInvoiceAdjustment(w.tenantId, w.actor, adj.id, "Versicherung erkennt doch an");
  fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.remainderExcessCents, 10_000);
  assert.ok((await closeWarnings(w.tenantId, r.caseId)).some((x) => x.code === "REMAINDER_EXCESS"));
  // Storno der Versicherungsrechnung: Restforderung allein (Grundlage entfallen) und Guthaben aus der Zahlung werden gemeldet
  const st = await createCancellationDraft(w.tenantId, inv.id, w.actor);
  await finalizeCounterDocument(w.tenantId, st.id, w.actor, { confirmed: true, reason: "Rechnung an falsche Versicherung" });
  fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.orphanRemainderCents, 10_000);
  assert.equal(fin.refundOpenCents, gross);
  assert.equal(fin.paidCents, 0, "Zahlungen auf stornierte Rechnungen zählen nicht als bezahlt");
  const codes = (await closeWarnings(w.tenantId, r.caseId)).map((x) => x.code);
  assert.ok(codes.includes("REMAINDER_ORPHAN") && codes.includes("REFUND_OPEN"));
  // geschlossener Fall: auch die Auszahlung des Guthabens ist gesperrt
  await closeCase(w.tenantId, r.caseId, w.actor, { reason: "Test Auszahlung", acknowledgeWarnings: true });
  await assert.rejects(() => createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId: inv.id }, { amount: "10,00", method: "CASH", recipientName: "MERKVERSICHERUNG-AG" }, { complete: false }), CLOSED);
});

test("Review: Restforderung höchstens bis zu dem, was die Versicherung nicht gezahlt hat", async () => {
  const w = await world("uf-remainder-3");
  const r = await runningCase(w, DAY + HOUR);
  await returnCase(w, r.bookingId);
  const inv = await invoice(w, r.caseId, "INSURER");
  const gross = toCents(inv.version.grossTotal);
  await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: inv.id, reasonKind: "TARIFF", amountCents: 5_000, decidedAt: new Date() });
  // Versicherung zahlt alles bis auf 20 € – mehr als 20 € kann nicht beim Mieter verlangt werden
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: ((gross - 2_000) / 100).toFixed(2).replace(".", ","), method: "BANK_TRANSFER", paidAt: new Date() });
  await assert.rejects(() => createAccidentRemainderDraft(w.tenantId, w.actor, { caseId: r.caseId, invoiceId: inv.id, amountCents: 2_001, nonce: nonce() }), /Höchstens 20,00/);
  const h = (await caseFileHeader(w.tenantId, r.caseId, "FULL"))!;
  assert.equal((await caseFileBilling(w.tenantId, h)).invoices[0].remainderAvailableCents, 2_000);
});

test("Review: Kette ohne Lücke – Storno bzw. Vollgutschrift einer mittleren Rechnung abgelehnt, Teilgutschrift und Storno der letzten möglich; Schlüsselbox-Abgabe sperrt Zwischenrechnungen", async () => {
  const w = await world("uf-midchain");
  const r = await runningCase(w, 6 * DAY + HOUR);
  const first = await invoice(w, r.caseId, "INSURER", plus(r.pickupAt, 2 * DAY));
  const second = await invoice(w, r.caseId, "INSURER", plus(r.pickupAt, 4 * DAY));
  await assert.rejects(() => createCancellationDraft(w.tenantId, first.id, w.actor), /mitten in der Unfallersatz-Abrechnung/);
  const full = await createCreditNoteDraft(w.tenantId, first.id, w.actor);
  await assert.rejects(() => finalizeCounterDocument(w.tenantId, full.id, w.actor, { confirmed: true, reason: "voll" }), /mitten in der Unfallersatz-Abrechnung/);
  await discardCounterDocumentDraft(w.tenantId, full.id, w.actor);
  const fv = await versionOf(first.id);
  const part = await createCreditNoteDraft(w.tenantId, first.id, w.actor, [{ sourceItemId: fv.items[0].id, mode: "AMOUNT", grossAmount: "10,00" }]);
  await finalizeCounterDocument(w.tenantId, part.id, w.actor, { confirmed: true, reason: "Kulanz" });
  // von hinten nach vorn stornieren geht – danach ist die Leistung wieder vollständig offen (inkl. Einmalpositionen)
  const s2 = await createCancellationDraft(w.tenantId, second.id, w.actor);
  await finalizeCounterDocument(w.tenantId, s2.id, w.actor, { confirmed: true, reason: "neu abrechnen" });
  const s1 = await createCancellationDraft(w.tenantId, first.id, w.actor);
  await finalizeCounterDocument(w.tenantId, s1.id, w.actor, { confirmed: true, reason: "neu abrechnen" });
  const pv = await previewAccidentInvoice(w.tenantId, { caseId: r.caseId, periodEnd: plus(r.pickupAt, 4 * DAY) });
  assert.equal(pv.periodStart.getTime(), r.pickupAt.getTime());
  assert.equal(pv.days, 4);
  assert.ok(pv.items.some((i) => i.description === "Zustellung"));
  assert.equal((await caseFinancials(w.tenantId, r.bookingId)).gaps.length, 0);
  // Schlüsselbox-Abgabe gemeldet: keine Zwischenrechnung mehr (die tatsächliche Rückgabe läge vor dem Stichtag)
  await db.tenant.update({ where: { id: w.tenantId }, data: { keyDropEnabled: true } });
  const kd = await authorizeKeyDrop(w.tenantId, w.actor, r.bookingId, { location: "Schlüsselbox Hof", expectedReturnAt: plus(new Date(), DAY), agreedWithCustomer: true });
  await db.keyDropReturn.update({ where: { id: kd.id }, data: { status: "CUSTOMER_CONFIRMED", customerDropOffAt: new Date(Date.now() - 2 * HOUR), confirmedAt: new Date(), confirmationText: "Testbestätigung", confirmationHash: "a".repeat(64) } });
  await assert.rejects(() => previewAccidentInvoice(w.tenantId, { caseId: r.caseId, periodEnd: new Date() }), /Schlüsselbox/);
  const h = (await caseFileHeader(w.tenantId, r.caseId, "FULL"))!;
  const bill = await caseFileBilling(w.tenantId, h);
  assert.equal(bill.actions.canInterim, false);
  assert.match(bill.actions.interimBlockedReason ?? "", /Schlüsselbox/);
});

test("Review: Zwischenrechnung erst, wenn ein neuer Miettag begonnen hat – kein Formular ohne möglichen Erfolg", async () => {
  const w = await world("uf-nextday");
  const r = await runningCase(w, 5 * HOUR);
  await invoice(w, r.caseId, "INSURER", new Date(Date.now() - HOUR));
  const h = (await caseFileHeader(w.tenantId, r.caseId, "FULL"))!;
  const bill = await caseFileBilling(w.tenantId, h);
  assert.equal(bill.actions.canInterim, false);
  assert.match(bill.actions.interimBlockedReason ?? "", /nächste Zwischenrechnung ist ab/);
});

test("Review: Hof und Supportmodus bekommen keine Belege der Unfallersatz-Abrechnung (Dokument-Adresse, Kundenakte, PDF-Erzeugung, Mahnschreiben)", async () => {
  const route = await readFile(path.join(process.cwd(), "src/app/api/documents/[id]/route.ts"), "utf8");
  assert.match(route, /\(session\.user\.role === "YARD" \|\| session\.supportSession\) && \(await isAccidentBillingDocument\(db, session\.tenant\.id, file\.document\)\)/);
  const actions = await readFile(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/dokumente/actions.ts"), "utf8");
  assert.match(actions, /user\.role === "YARD" && \(await accidentInvoiceOf\(db, tenant\.id, invoice\.invoiceId\)\)/);
  const w = await world("uf-yard-docs");
  const r = await runningCase(w, DAY + HOUR);
  await returnCase(w, r.bookingId);
  const inv = await invoice(w, r.caseId, "INSURER");
  const doc = await ensureInvoiceDocument(w.tenantId, inv.version.id, w.actor.id, { storage });
  assert.equal(await isAccidentBillingDocument(db, w.tenantId, doc.document), true);
  const yardDocs = await customerDocuments(w.tenantId, w.customerId, "YARD");
  assert.ok(!yardDocs.some((d) => d.id === doc.document.id));
  assert.ok((await customerDocuments(w.tenantId, w.customerId, "DISPO")).some((d) => d.id === doc.document.id));
  // Standard-Mietrechnung bleibt für den Hof abrufbar
  const std = await returnedWorld("uf-yard-std");
  tenants.push(std.tenantId);
  const sinv = await ensureInvoiceDraft(std.tenantId, std.bookingId, std.actor);
  const sv = await finalizeInvoice(std.tenantId, sinv.id, std.actor);
  const sdoc = await ensureInvoiceDocument(std.tenantId, sv.id, std.actor.id, { storage });
  assert.equal(await isAccidentBillingDocument(db, std.tenantId, sdoc.document), false);
});

// ---------------------------------------------------------------------------
// 25–30: Storno, Gutschrift, fallweite Summen
// ---------------------------------------------------------------------------

test("25/26/27/28/29/30: Stornierte Rechnung zählt nicht (Leistung wieder offen), Gutschrift mindert die Forderung; Fakturiert/Bezahlt/Offen korrekt, Kürzungen separat", async () => {
  const w = await world("uf-sums");
  const r = await runningCase(w, 5 * DAY + HOUR);
  const interim = await invoice(w, r.caseId, "INSURER", plus(r.pickupAt, 2 * DAY));
  // 25: Storno der Zwischenrechnung → die Leistung ab der Übergabe ist wieder offen
  const st = await createCancellationDraft(w.tenantId, interim.id, w.actor);
  await finalizeCounterDocument(w.tenantId, st.id, w.actor, { confirmed: true, reason: "falscher Stichtag" });
  const again = await previewAccidentInvoice(w.tenantId, { caseId: r.caseId, periodEnd: plus(r.pickupAt, 2 * DAY) });
  assert.equal(again.periodStart.getTime(), r.pickupAt.getTime());
  assert.equal(again.days, 2);
  assert.ok(again.items.some((i) => i.description === "Zustellung"), "Einmalpositionen wieder offen");
  await returnCase(w, r.bookingId);
  const fin0 = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin0.active, 0, "stornierte Rechnung ist keine wirksame Abrechnung");
  const final = await invoice(w, r.caseId, "INSURER");
  const gross = toCents(final.version.grossTotal);
  assert.equal(gross, 6 * PER_DAY + ONE_OFF);
  // 26: Gutschrift 50 € mindert die Forderung (nicht die Leistung)
  const fv = await versionOf(final.id);
  const credit = await createCreditNoteDraft(w.tenantId, final.id, w.actor, [{ sourceItemId: fv.items[0].id, mode: "AMOUNT", grossAmount: "50,00" }]);
  await finalizeCounterDocument(w.tenantId, credit.id, w.actor, { confirmed: true, reason: "Kulanz" });
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: final.id, amount: "300,00", method: "BANK_TRANSFER", paidAt: new Date() });
  await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: final.id, reasonKind: "ANCILLARY", amountCents: 2_000, decidedAt: new Date() });
  const fin = await caseFinancials(w.tenantId, r.bookingId);
  assert.equal(fin.grossCents, gross - 5_000, "27: fakturiert = wirksame Rechnungen nach Gutschrift; Storno zählt nicht");
  assert.equal(fin.paidCents, 30_000, "28");
  assert.equal(fin.openCents, gross - 5_000 - 30_000, "29");
  assert.equal(fin.reducedCents, 2_000, "30: Kürzung separat, nicht vom Offenen abgezogen");
  assert.equal(fin.finalBilled, true);
  const h = (await caseFileHeader(w.tenantId, r.caseId, "FULL"))!;
  const bill = await caseFileBilling(w.tenantId, h);
  assert.equal(bill.invoices.length, 2);
  assert.equal(bill.invoices.find((i) => i.id === interim.id)?.neutralized, true);
  assert.ok(bill.flags.some((x) => x.label === "Teilbezahlt") && bill.flags.some((x) => x.label === "Kürzung dokumentiert"));
});

// ---------------------------------------------------------------------------
// 31–33: Dokumente
// ---------------------------------------------------------------------------

test("31/32/33: Dokument hochladen (geprüft), tenant- und fallsicher, archivieren mit Grund – archiviert bleibt sichtbar; ungültige Uploads abgelehnt", async () => {
  const w = await world("uf-docs");
  const r = await runningCase(w, DAY);
  const d = await insurerLetter(w, r.caseId, r.bookingId);
  const assignment = await insurerLetter(w, r.caseId, r.bookingId, "ASSIGNMENT");
  // ungültige Daten werden auch ohne Upload-Route abgelehnt
  const key = buildStorageKey({ tenantId: w.tenantId, area: "documents", bookingId: r.bookingId, contentType: "application/pdf" });
  await assert.rejects(() => registerAccidentDocument(w.tenantId, r.caseId, w.actor, { type: "OTHER", fileName: "x.html", storageKey: key, contentType: "text/html", sizeBytes: 10, checksum: sha256(key) }), /PDF oder ein Bild/);
  await assert.rejects(() => registerAccidentDocument(w.tenantId, r.caseId, w.actor, { type: "OTHER", fileName: "x.pdf", storageKey: key, contentType: "application/pdf", sizeBytes: 9 * 1024 * 1024, checksum: sha256(key) }), /zu groß/);
  const b = await world("uf-docs-b");
  const foreignKey = buildStorageKey({ tenantId: b.tenantId, area: "documents", contentType: "application/pdf" });
  await assert.rejects(() => registerAccidentDocument(w.tenantId, r.caseId, w.actor, { type: "OTHER", fileName: "x.pdf", storageKey: foreignKey, contentType: "application/pdf", sizeBytes: 10, checksum: sha256(foreignKey) }));
  // Dateiname bereinigt
  const bytes = new TextEncoder().encode("%PDF-1.4\n");
  const k2 = buildStorageKey({ tenantId: w.tenantId, area: "documents", bookingId: r.bookingId, contentType: "application/pdf" });
  const weird = await registerAccidentDocument(w.tenantId, r.caseId, w.actor, { type: "OTHER", fileName: "../../etc/pass:wd?.pdf", storageKey: k2, contentType: "application/pdf", sizeBytes: bytes.length, checksum: sha256(bytes) });
  assert.ok(!/[\\/:?]/.test(weird.fileName));
  // 32: tenant- und fallsicher – ein anderer Mandant findet das Dokument nicht; Archivieren nur mit passendem Fall
  assert.equal(await db.accidentReplacementCaseDocument.findFirst({ where: { id: d.id, tenantId: b.tenantId } }), null);
  await assert.rejects(() => archiveAccidentDocument(b.tenantId, d.id, b.actor, "fremd"), /nicht gefunden/);
  const other = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: (await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UF ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, make: "VW", model: "Up", groupId: w.groupId, dailyRate: 40, deposit: 0 } })).id }));
  await assert.rejects(() => archiveAccidentDocument(w.tenantId, d.id, w.actor, "falscher Fall", { caseId: other.case.id }), /nicht gefunden/);
  // 33: Archivieren mit Grund; archiviert bleibt sichtbar (eigene Liste), nichts wird gelöscht
  await assert.rejects(() => archiveAccidentDocument(w.tenantId, assignment.id, w.actor, "x", { caseId: r.caseId }), /Grund/);
  await archiveAccidentDocument(w.tenantId, assignment.id, w.actor, "durch neue Fassung ersetzt", { caseId: r.caseId });
  const h = (await caseFileHeader(w.tenantId, r.caseId, "FULL"))!;
  const docs = await caseFileDocuments(w.tenantId, h, "FULL");
  assert.deepEqual(docs.insurer.map((x) => x.id), [d.id]);
  assert.ok(docs.archived.some((x) => x.id === assignment.id && x.archiveReason === "durch neue Fassung ersetzt" && x.archivedByName === w.actor.name));
  assert.equal(await db.accidentReplacementCaseDocument.count({ where: { caseId: r.caseId } }), 3);
  // operative Sicht (Hof) lädt keine Fall-Dokumente
  const op = await caseFileDocuments(w.tenantId, (await caseFileHeader(w.tenantId, r.caseId, "OPERATIONAL"))!, "OPERATIONAL");
  assert.equal(op.insurer.length + op.accident.length + op.archived.length, 0);
});

// ---------------------------------------------------------------------------
// 34: geschlossener Fall blockiert alle Finanzänderungen serverseitig
// ---------------------------------------------------------------------------

test("34: Geschlossener Fall blockiert Rechnungsentwurf, Abschluss, Bearbeitung, Zahlung, Storno, Gutschrift, Kürzung, Restforderung, Mahnung, Verrechnung, Dokumente – Lesen und PDF bleiben; Wiederöffnen gibt frei", async () => {
  const w = await world("uf-closed");
  const r = await runningCase(w, 3 * DAY + HOUR, { depositCents: 10_000 }, 100);
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: r.bookingId, amount: "100", method: "CASH", occurredAt: new Date() });
  const ins = await invoice(w, r.caseId, "INSURER", plus(r.pickupAt, DAY));
  const pay = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: ins.id, amount: "10,00", method: "CASH", paidAt: new Date() });
  const adj = await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: ins.id, reasonKind: "TARIFF", amountCents: 1_000, decidedAt: new Date() });
  const letter = await insurerLetter(w, r.caseId, r.bookingId);
  await returnCase(w, r.bookingId);
  const { invoice: draft } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "INSURER", nonce: nonce() });
  await closeCase(w.tenantId, r.caseId, w.actor, { reason: "Test Sperre", acknowledgeWarnings: true });
  const dv = await versionOf(draft.id);
  await assert.rejects(() => createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId: r.caseId, recipientRole: "RENTER", nonce: nonce() }), CLOSED);
  await assert.rejects(() => finalizeInvoice(w.tenantId, draft.id, w.actor), CLOSED);
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, draft.id, w.actor, { items: dv.items.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: String(i.unitPrice), taxRate: String(i.taxRate) })) }), CLOSED);
  await assert.rejects(() => discardInvoiceDraft(w.tenantId, draft.id, w.actor), CLOSED);
  await assert.rejects(() => startInvoiceEdit(w.tenantId, ins.id, w.actor), CLOSED);
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: ins.id, amount: "5,00", method: "CASH", paidAt: new Date() }), CLOSED);
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, pay.payment.id, "Test"), CLOSED);
  await assert.rejects(() => recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: ins.id, reasonKind: "TARIFF", amountCents: 100, decidedAt: new Date() }), CLOSED);
  await assert.rejects(() => cancelInvoiceAdjustment(w.tenantId, w.actor, adj.id, "Test"), CLOSED);
  await assert.rejects(() => createAccidentRemainderDraft(w.tenantId, w.actor, { caseId: r.caseId, invoiceId: ins.id, amountCents: 500, nonce: nonce() }), CLOSED);
  await assert.rejects(() => createCreditNoteDraft(w.tenantId, ins.id, w.actor), CLOSED);
  await assert.rejects(() => createCancellationDraft(w.tenantId, ins.id, w.actor), CLOSED);
  const plan = await previewDunning(w.tenantId, ins.id, { now: plus(new Date(), 60 * DAY) });
  await assert.rejects(() => createDunningNotice(w.tenantId, w.actor, { invoiceId: ins.id, level: 1, expectedTotalCents: plan.totalCents, idempotencyKey: nonce() }, { now: plus(new Date(), 60 * DAY) }), CLOSED);
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: r.bookingId, invoiceId: ins.id, amount: "1", occurredAt: new Date(), idempotencyKey: nonce() }), CLOSED);
  await assert.rejects(() => insurerLetter(w, r.caseId, r.bookingId), CLOSED);
  await assert.rejects(() => archiveAccidentDocument(w.tenantId, letter.id, w.actor, "Test", { caseId: r.caseId }), CLOSED);
  // die Prüfliste nennt den Grund; Lesen, PDF und Finanzstand bleiben verfügbar
  assert.ok((await getInvoiceState(w.tenantId, draft.id)).issues.some((i) => i.code === "CASE_CLOSED" && i.message === ACCIDENT_CASE_CLOSED_MESSAGE));
  assert.ok((await ensureInvoiceDocument(w.tenantId, ins.version.id, w.actor.id, { storage })).document.id);
  assert.equal((await caseFinancials(w.tenantId, r.bookingId)).paidCents, 1_000);
  assert.equal(await db.payment.count({ where: { invoiceId: ins.id } }), 1, "nichts verändert");
  // Wiederöffnen gibt die Bearbeitung frei
  await reopenCase(w.tenantId, r.caseId, w.actor, "Versicherung zahlt nach");
  await finalizeInvoice(w.tenantId, draft.id, w.actor);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: ins.id, amount: "5,00", method: "CASH", paidAt: new Date() });
});

// ---------------------------------------------------------------------------
// 35: Rollen – jede Phase-F-Aktion serverseitig nur Inhaber/Disposition mit Freischaltung; Hof sieht keine Abrechnung
// ---------------------------------------------------------------------------

test("35: Phase-F-Aktionen und Dokument-Routen nur für Inhaber und Disposition mit Freischaltung; Unfallersatz-Rechnungsseite nicht für den Hof", async () => {
  const actions = await readFile(path.join(process.cwd(), "src/app/(app)/unfallersatz/[id]/actions.ts"), "utf8");
  assert.ok(!/"YARD"/.test(actions));
  for (const fn of ["previewAccidentInvoiceAction", "createAccidentInvoiceAction", "createAccidentRemainderAction", "recordAccidentAdjustmentAction", "cancelAccidentAdjustmentAction", "previewAccidentPaymentAction", "recordAccidentPaymentAction", "cancelAccidentPaymentAction", "archiveAccidentDocumentAction"]) {
    const body = new RegExp(`export async function ${fn}\\([\\s\\S]*?\\n}`).exec(actions)?.[0] ?? "";
    assert.match(body, /const x = await ctx\(caseId\);\n\s+if \(!x\) return/, `${fn}: Rolle, Freischaltung und Mandant zuerst`);
  }
  assert.match(actions, /async function ctx\(caseId: string\) \{\n\s+const \{ tenant, user \} = await requireRole\("DISPO"\);\n\s+await requireFeature\("ACCIDENT_REPLACEMENT"\);/);
  for (const f of ["src/app/api/accident-cases/[id]/documents/route.ts", "src/app/api/accident-documents/[id]/route.ts"]) {
    const src = await readFile(path.join(process.cwd(), f), "utf8");
    assert.match(src, /featureForApi\(session, "ACCIDENT_REPLACEMENT"/, `${f}: Freischaltung`);
    assert.match(src, /roleAllows\(session\.user\.role, \["DISPO"\]\)/, `${f}: Rolle`);
    assert.match(src, /where: \{ id, tenantId(: session\.tenant\.id)? \}/, `${f}: Mandant`);
  }
  assert.match(await readFile(path.join(process.cwd(), "src/app/api/accident-documents/[id]/route.ts"), "utf8"), /apiSession\("read", "ACCIDENT_DOCUMENT"\)/, "Supportmodus gesperrt");
  const page = await readFile(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rechnung/page.tsx"), "utf8");
  assert.match(page, /if \(accidentRef && !canEdit\) redirect\(/);
});

// ---------------------------------------------------------------------------
// 36/37/38: Standardrechnung, -zahlung und -mahnung unverändert
// ---------------------------------------------------------------------------

test("36/37/38: Standard-Mietrechnung, Zahlung, Kautionsangebot, Rechnungsmail und Mahnung unverändert (keine Empfängerrolle, kein Unfallersatz-Bezug)", async () => {
  await ready;
  const w = await returnedWorld("uf-standard");
  tenants.push(w.tenantId);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(inv.kind, "RENTAL");
  const v = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  const snap = v.customerSnapshot as Record<string, unknown>;
  assert.equal(snap.recipientRole, undefined); assert.equal(snap.accidentBilling, undefined);
  const data = await loadInvoiceDocumentData(w.tenantId, v.id);
  assert.equal(data.doc.title, "Rechnung"); assert.equal(data.doc.accident ?? null, null); assert.equal(data.recipientIsRenter, true);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "10,00", method: "CASH", paidAt: new Date() });
  assert.equal((await invoicePaymentSummary(w.tenantId, inv.id)).paidCents, 1_000);
  const plan = await planInvoiceMail(w.tenantId, v.id);
  assert.equal(plan.recipient, "erika@example.test");
  assert.equal(plan.invoice.accident, null);
  const dun = await previewDunning(w.tenantId, inv.id, { now: plus(new Date(), 60 * DAY) });
  assert.equal(dun.recipientEmail, "erika@example.test");
  const st = await getInvoiceState(w.tenantId, inv.id);
  assert.ok(!st.issues.some((i) => i.code === "CASE_CLOSED" || i.code.startsWith("PERIOD_CHAIN") || i.code.startsWith("REMAINDER")));
});

// ---------------------------------------------------------------------------
// Ende-zu-Ende-Finanztest (Spec 33)
// ---------------------------------------------------------------------------

test("Ende-zu-Ende: 14 Miettage, Haftungsreduzierung, Zustellung, Abholung → Schlussrechnung an die Versicherung → zwei Zahlungen → Rest offen → Kürzung über den Rest mit Versichererschreiben – offen bleibt der Rest", async () => {
  const w = await world("uf-e2e");
  const r = await runningCase(w, 13 * DAY + 5 * HOUR);
  const b = await returnCase(w, r.bookingId);
  assert.equal(rentalDays(r.pickupAt, b.actualReturnAt!), 14);
  const pv = await previewAccidentInvoice(w.tenantId, { caseId: r.caseId });
  const X = 14 * PER_DAY + ONE_OFF; // 14 × (79 + 15) + 40 + 20 = 1.376,00 €
  assert.equal(pv.grossCents, X);
  const inv = await invoice(w, r.caseId, "INSURER");
  assert.equal(toCents(inv.version.grossTotal), X);
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "1000,00", method: "BANK_TRANSFER", paidAt: new Date(), reference: "MERK Zahlung 1" });
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: "176,00", method: "BANK_TRANSFER", paidAt: new Date(), reference: "MERK Zahlung 2" });
  const Y = 117_600, Z = X - Y; // bezahlt 1.176,00 €, offen 200,00 €
  const letter = await insurerLetter(w, r.caseId, r.bookingId);
  await recordInvoiceAdjustment(w.tenantId, w.actor, { invoiceId: inv.id, reasonKind: "TARIFF", amountCents: Z, decidedAt: new Date(), note: "Kürzung laut Schreiben", documentId: letter.id });
  const h = (await caseFileHeader(w.tenantId, r.caseId, "FULL"))!;
  const bill = await caseFileBilling(w.tenantId, h);
  const i = bill.invoices[0];
  assert.equal(i.invoiceCents, X, "Rechnungsbetrag X");
  assert.equal(i.paidCents, Y, "Bezahlt Y");
  assert.equal(i.openCents, Z, "Offen Z – ausdrücklich nicht 0");
  assert.notEqual(i.openCents, 0);
  assert.equal(i.reducedCents, Z, "Dokumentierte Kürzung Z");
  assert.equal(bill.fin.economicOpenCents, Z);
  assert.equal(bill.fin.reducedCents, Z);
  assert.equal(i.adjustments[0].document?.id, letter.id, "Kürzung mit dem Versichererschreiben verbunden");
  assert.ok(bill.flags.some((x) => x.label === "Teilbezahlt") && bill.flags.some((x) => x.label === "Kürzung dokumentiert") && bill.flags.some((x) => x.label === "Schlussgerechnet"));
  assert.equal(h.mainStatus.label, "Teilbezahlt");
  const docs = await caseFileDocuments(w.tenantId, h, "FULL");
  assert.equal(docs.insurer[0].adjustments[0].amountCents, Z);
  const warn = (await closeWarnings(w.tenantId, r.caseId)).map((x) => x.code);
  assert.ok(warn.includes("OPEN_AMOUNT") && warn.includes("REDUCTION_OPEN"), "Abschluss warnt: Kürzung allein macht die Forderung nicht bezahlt");
  const pdf = await renderInvoicePdf((await loadInvoiceDocumentData(w.tenantId, inv.version.id)).doc);
  const text = sp(pdf.trace.texts.join(" | "));
  assert.ok(text.includes("Schlussrechnung") && text.includes("14") && text.includes("SN-2026-4711"));
});

test("Review: Hofmitarbeiter sehen Unfallersatz-Rechnungen auch in globalen Listen nicht (Forderungen, Heute, Rechnungsliste, Gegenbelege der Buchung)", async () => {
  const w = await world("uf-yard-list");
  const r = await runningCase(w, DAY + HOUR);
  await returnCase(w, r.bookingId);
  const inv = await invoice(w, r.caseId, "INSURER");
  // Forderungsübersicht: Disposition sieht die Forderung, Hof-Sicht nicht
  assert.ok((await listReceivables(w.tenantId, { filter: "offen" })).rows.some((x) => x.invoiceId === inv.id));
  assert.ok(!(await listReceivables(w.tenantId, { filter: "offen", hideAccidentBilling: true })).rows.some((x) => x.invoiceId === inv.id));
  // Heute: offene Rechnungen zählen nur für Inhaber/Disposition
  assert.equal((await loadDashboard(w.tenantId)).counts.openInvoices, 1);
  const dashFull = await loadDashboard(w.tenantId), dashYard = await loadDashboard(w.tenantId, { hideAccidentBilling: true });
  assert.equal(dashYard.counts.openInvoices, 0);
  // auch keine Hinweise „Rechnung-PDF fehlt“ zur Unfallersatz-Rechnung (Rechnungsnummer) in der Hof-Sicht
  assert.equal(dashYard.counts.documentsMissing, dashFull.counts.documentsMissing - 1);
  // globale Suche: Treffer nur für Inhaber/Disposition
  const number = (await db.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { number: true } })).number!;
  const hits = async (role: string) => (await globalSearch(w.tenantId, role, number)).groups.filter((g) => g.type === "invoice").flatMap((g) => g.hits).length;
  assert.equal(await hits("DISPO"), 1);
  assert.equal(await hits("YARD"), 0);
  // Gegenbeleg übernimmt die Art und fällt ebenfalls heraus
  const cn = await createCancellationDraft(w.tenantId, inv.id, w.actor);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, id: { in: [inv.id, cn.id] }, NOT: ACCIDENT_BILLING_WHERE } }), 0);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, id: { in: [inv.id, cn.id] }, ...ACCIDENT_BILLING_WHERE } }), 2);
  await discardCounterDocumentDraft(w.tenantId, cn.id, w.actor);
  // Seiten verwenden den Filter für die Hofrolle
  const src = async (p: string) => readFile(path.join(process.cwd(), p), "utf8");
  assert.match(await src("src/app/(app)/rechnungen/page.tsx"), /hideAccident \? \{ NOT: ACCIDENT_BILLING_WHERE \}/);
  assert.match(await src("src/app/(app)/forderungen/page.tsx"), /hideAccidentBilling: user\.role === "YARD"/);
  assert.match(await src("src/app/(app)/heute/page.tsx"), /hideAccidentBilling: user\.role === "YARD"/);
  assert.match(await src("src/app/(app)/buchungen/[id]/page.tsx"), /user\.role === "YARD" \? \{ NOT: ACCIDENT_BILLING_WHERE \}/);
});
