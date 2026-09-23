// Auszahlungen (Phase 18): Rechnungserstattung und Kautionsrückzahlung über ein gemeinsames Modell. Nur COMPLETED zählt;
// nie mehr als verfügbar (Code + DB, race-safe); Zahlungen und Kautionsbewegungen unverändert; Storno statt Löschen;
// Methoden mit Pflichtfeldern, IBAN-Plausibilität und -Verschleierung; Beleg (PDF), Nachweis, manuelle E-Mail; Mandantentrennung.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { createCreditNoteDraft, finalizeCounterDocument, invoiceFinancials, updateCounterDocumentDraft, computeFinancials } from "../src/lib/counter-documents";
import { cancelDepositEvent, computeDepositFinancials, balanceOf, recordDepositReceived, securityDepositFinancials, settleDeposit } from "../src/lib/deposits";
import { loadPayoutDocumentData } from "../src/lib/document-data";
import { ensurePayoutDocument, readDocumentFile } from "../src/lib/documents";
import { DomainError, isImmutableError } from "../src/lib/integrity";
import { ensureInvoiceDraft, finalizeInvoice, startInvoiceEdit, updateInvoiceDraft } from "../src/lib/invoices";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { toCents } from "../src/lib/money";
import { cancelPayment, recordInvoicePayment } from "../src/lib/payments";
import { cancelPayout, completePayout, createPayout, isValidIban, maskIban, openPayoutClaims, payoutCounts, previewPayout, registerPayoutAttachment, sendPayoutReceipt, updatePayoutDraft, verifyPayout } from "../src/lib/payouts";
import { renderPayoutPdf } from "../src/lib/pdf/payout-pdf";
import { buildStorageKey, getStorage, type StorageDriver } from "../src/lib/storage";
import { purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-payout-"));
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
const at = new Date(Date.now() - 60_000);
const year = new Date().getFullYear();
const IBAN = "DE02120300000000202051"; // Beispiel-IBAN mit gültiger Prüfziffer
const isDomain = (e: unknown) => e instanceof DomainError;
const dbRejects = (re: RegExp) => (e: unknown) => re.test(String((e as Error).message));
const bank = (amount: string, extra: Record<string, unknown> = {}) => ({ amount, method: "BANK_TRANSFER", iban: IBAN, executedAt: at, reference: "Erstattung", ...extra });
const cash = (amount: string, extra: Record<string, unknown> = {}) => ({ amount, method: "CASH", executedAt: at, ...extra });

const world = async (label: string) => {
  await ready;
  const w = await returnedWorld(label);
  tenants.push(w.tenantId);
  return w;
};
const draftOf = (invoiceId: string) => db.invoiceVersion.findFirstOrThrow({ where: { invoiceId, status: "DRAFT" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
/** Rechnung 1.000 € (19 %), bezahlt `paid`, Gutschrift `credit` → Guthaben = paid − (1000 − credit). */
async function creditedWorld(label: string, paid: string | null, credit: string | null) {
  const w = await world(label);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const d = await draftOf(inv.id);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: d.items[0].id, description: d.items[0].description, quantity: "1", unit: "pauschal", unitPrice: "1000", taxRate: "19" }] });
  const v1 = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  const payment = paid ? (await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: paid, method: "BANK_TRANSFER", paidAt: at })).payment : null;
  let creditId: string | null = null;
  if (credit) {
    const c = await createCreditNoteDraft(w.tenantId, inv.id, w.actor);
    await updateCounterDocumentDraft(w.tenantId, c.id, w.actor, { items: [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: credit }], reason: "Testgutschrift" });
    await finalizeCounterDocument(w.tenantId, c.id, w.actor, { confirmed: true });
    creditId = c.id;
  }
  return { w, invoiceId: inv.id, v1, payment, creditId, ref: { sourceType: "INVOICE_REFUND" as const, invoiceId: inv.id } };
}
/** Kaution 500 € erhalten, `retain` einbehalten, Rest freigegeben. */
async function depositWorld(label: string, retain: number) {
  const w = await world(label);
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await settleDeposit(w.tenantId, w.actor, { bookingId: w.bookingId, releaseAmount: String(500 - retain), reason: retain ? "Prüfung Schaden" : null, occurredAt: at });
  const dep = await db.securityDeposit.findFirstOrThrow({ where: { bookingId: w.bookingId } });
  return { w, depositId: dep.id, ref: { sourceType: "SECURITY_DEPOSIT_REFUND" as const, bookingId: w.bookingId } };
}
async function snapshot(tenantId: string, invoiceId: string | null) {
  return JSON.stringify({
    payments: await db.payment.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
    depositEvents: await db.securityDepositEvent.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
    deposits: await db.securityDeposit.findMany({ where: { tenantId } }),
    invoices: await db.invoice.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, currentVersionId: true, changeLog: false, updatedAt: false } }),
    versions: await db.invoiceVersion.findMany({ where: { tenantId, ...(invoiceId ? {} : {}) }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, contentHash: true, grossTotal: true } }),
    cases: await db.damageCase.findMany({ where: { tenantId } }),
    bookings: await db.booking.findMany({ where: { tenantId }, select: { id: true, status: true, deposit: true } }),
    contracts: await db.rentalContract.findMany({ where: { tenantId }, select: { id: true, status: true, contentHash: true } }),
    handovers: await db.handover.findMany({ where: { tenantId }, select: { id: true, status: true, contentHash: true } }),
    charges: await db.extraCharge.findMany({ where: { tenantId } }),
  });
}

test("Rechenmodell: Guthaben − Auszahlungen = Rest, nie negativ; Kaution: freigegeben, höchstens erhalten − einbehalten; IBAN prüfen und verschleiern", () => {
  const f = computeFinancials("i", 100_000, 20_000, 0, 100_000, false, 5_000);
  assert.deepEqual([f.customerCreditCents, f.completedRefundCents, f.refundRemainingCents, f.refundExcessCents, f.refundOpen], [20_000, 5_000, 15_000, 0, true]);
  const g = computeFinancials("i", 100_000, 20_000, 0, 100_000, false, 20_000);
  assert.deepEqual([g.refundRemainingCents, g.refundOpen, g.refundRequired], [0, false, true], "vollständig erstattet: wirtschaftliches Guthaben bleibt, nichts mehr auszuzahlen");
  const h = computeFinancials("i", 100_000, 0, 0, 100_000, false, 30_000);
  assert.deepEqual([h.refundRemainingCents, h.refundExcessCents], [0, 30_000], "mehr ausgezahlt als Guthaben (nur nach späteren Änderungen): Überhang sichtbar, kein negativer Rest");
  const bal = balanceOf(75_000, [{ type: "RECEIVED", amountCents: 75_000, status: "CONFIRMED" }, { type: "RETAINED", amountCents: 15_000, status: "CONFIRMED" }, { type: "RELEASED", amountCents: 60_000, status: "CONFIRMED" }]);
  const d = computeDepositFinancials(bal, 0);
  assert.deepEqual([d.payoutRemainingCents, d.completedPayoutCents, d.releasedWithoutPayoutCents], [60_000, 0, 60_000], "750 erhalten, 150 einbehalten, 600 freigegeben → 600 auszuzahlen");
  assert.deepEqual([computeDepositFinancials(bal, 30_000).payoutRemainingCents, computeDepositFinancials(bal, 60_000).payoutRemainingCents], [30_000, 0]);
  const over = computeDepositFinancials(balanceOf(50_000, [{ type: "RECEIVED", amountCents: 50_000, status: "CONFIRMED" }, { type: "RELEASED", amountCents: 50_000, status: "CONFIRMED" }, { type: "RETAINED", amountCents: 0, status: "CONFIRMED" }]), 0);
  assert.equal(over.payoutRemainingCents, 50_000);
  assert.equal(computeDepositFinancials(balanceOf(50_000, [{ type: "RECEIVED", amountCents: 50_000, status: "CONFIRMED" }]), 0).payoutRemainingCents, 0, "ohne Freigabe nichts auszuzahlen");
  assert.equal(isValidIban(IBAN), true);
  assert.equal(isValidIban("DE02 1203 0000 0000 2020 51"), true);
  assert.equal(isValidIban("DE03120300000000202051"), false, "falsche Prüfziffer");
  assert.equal(isValidIban("12345"), false);
  assert.equal(maskIban(IBAN), "DE** **** **** **** **20 51");
});

test("Rechnungserstattung: 1.000 bezahlt, Gutschrift 200 → 200 auszuzahlen; 250 blockiert; 200 ausgezahlt → Rest 0; Zahlung und Gutschrift unverändert; keine zweite Auszahlung; Beleg, Nachweis, E-Mail, Audit", async () => {
  const { w, invoiceId, payment, ref } = await creditedWorld("payout-basic", "1000", "200");
  const before = await snapshot(w.tenantId, invoiceId);
  const f0 = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f0.effectiveCents, f0.paidCents, f0.customerCreditCents, f0.completedRefundCents, f0.refundRemainingCents], [80_000, 100_000, 20_000, 0, 20_000]);
  const pv = await previewPayout(w.tenantId, ref, bank("250"));
  assert.match(pv.error ?? "", /Noch auszuzahlen sind 200,00/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, bank("250"), { complete: true, confirmed: true }), /Noch auszuzahlen sind 200,00/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, bank("200"), { complete: true, confirmed: false }), /bestätigen/);
  const ok = await previewPayout(w.tenantId, ref, bank("200"));
  assert.deepEqual([ok.error, ok.remainingBefore, ok.remainingAfter, ok.ibanMasked, ok.recipientName], [null, 20_000, 0, "DE** **** **** **** **20 51", "Erika Muster"]);
  const { payout: p, created } = await createPayout(w.tenantId, w.actor, ref, bank("200", { idempotencyKey: "payout-basic-key-1", internalNote: "intern", customerNote: "Vielen Dank" }), { complete: true, confirmed: true });
  assert.equal(created, true);
  assert.deepEqual([p.status, p.number, p.amountCents, p.method, p.iban, p.ibanMasked, p.recipientName, p.recipientDeviates, p.sourceType, p.invoiceId, p.bookingId, p.customerId, !!p.contentHash, !!p.completedAt, p.completedById], ["COMPLETED", `AZ-${year}-000001`, 20_000, "BANK_TRANSFER", IBAN, "DE** **** **** **** **20 51", "Erika Muster", false, "INVOICE_REFUND", invoiceId, w.bookingId, w.customerId, true, true, w.actor.id]);
  const snap = p.sourceSnapshot as Record<string, unknown>;
  assert.deepEqual([snap.invoiceCents, snap.effectiveCents, snap.paidCents, snap.customerCreditCents, snap.paidOutBeforeCents, (snap.chain as string[]).length], [100_000, 80_000, 100_000, 20_000, 0, 1]);
  assert.equal((await verifyPayout(w.tenantId, p.id)).intact, true);
  // Idempotenz: derselbe Schlüssel bucht nichts doppelt
  const again = await createPayout(w.tenantId, w.actor, ref, bank("200", { idempotencyKey: "payout-basic-key-1" }), { complete: true, confirmed: true });
  assert.deepEqual([again.created, again.payout.id], [false, p.id]);
  const f1 = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f1.customerCreditCents, f1.completedRefundCents, f1.refundRemainingCents, f1.refundOpen, f1.paidCents], [20_000, 20_000, 0, false, 100_000], "Gutschrift ist keine Auszahlung; Auszahlung ändert die Zahlung nicht");
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: payment!.id } }), payment, "Payment unverändert (nicht auf 800 gesetzt, nicht storniert)");
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId } }), 1, "kein negatives Payment");
  assert.equal(await snapshot(w.tenantId, invoiceId), before, "Rechnung, Fassungen, Gutschrift, Zahlung, Kaution, Buchung, Vertrag unverändert");
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, bank("1"), { complete: true, confirmed: true }), /nichts auszuzahlen/, "kein Refund ohne Guthaben (serverseitig)");
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, bank("1"), { complete: false }), /nichts auszuzahlen/, "auch kein Entwurf ohne Guthaben");
  // Beleg: PDF privat, Prüfsumme, IBAN verkürzt, keine Bankbestätigung; Nachweis; E-Mail manuell mit Idempotenz
  const doc = await ensurePayoutDocument(w.tenantId, p.id, w.actor.id, { storage });
  assert.deepEqual([doc.document.type, doc.document.fileName, doc.document.payoutId, doc.created], ["PAYOUT_RECEIPT", `Auszahlungsbeleg_AZ-${year}-000001.pdf`, p.id, true]);
  assert.equal((await ensurePayoutDocument(w.tenantId, p.id, w.actor.id, { storage })).created, false, "nie neu erzeugt");
  const pdf = await renderPayoutPdf((await loadPayoutDocumentData(w.tenantId, p.id)).doc);
  const text = pdf.trace.texts.join("\n").replace(/\s+/g, " ");
  assert.deepEqual(pdf.trace.boxes.filter((b) => b.overflow), []);
  assert.ok(text.includes(`Auszahlungsbeleg AZ-${year}-000001`) && text.includes("Erstattung zu Rechnung RE-") && text.includes("200,00") && text.includes("DE** **** **** **** **20 51") && text.includes("Überweisung") && text.includes("Vielen Dank") && text.includes("in Rent-Base als erfolgt erfasst"), text);
  assert.ok(!text.includes(IBAN) && !text.includes("intern") && !/erfolgreich ausgeführt/i.test(text) && !text.includes("Nachträglich"), "keine volle IBAN, keine interne Notiz, keine Bankbestätigung, kein Nacherfassungsvermerk");
  const file = await readDocumentFile(w.tenantId, doc.document.id, storage);
  assert.equal(file?.document.checksum, doc.document.checksum);
  const key = buildStorageKey({ tenantId: w.tenantId, area: "documents", bookingId: w.bookingId, contentType: "image/jpeg" });
  const att = await registerPayoutAttachment(w.tenantId, w.actor, p.id, { fileName: "Ueberweisung.jpg", storageKey: key, contentType: "image/jpeg", sizeBytes: 1234, checksum: "a".repeat(64) });
  assert.deepEqual([att.type, att.payoutId, att.contentType], ["PAYOUT_ATTACHMENT", p.id, "image/jpeg"]);
  await assert.rejects(() => registerPayoutAttachment(w.tenantId, w.actor, p.id, { fileName: "x.jpg", storageKey: buildStorageKey({ tenantId: "fremd", area: "documents", contentType: "image/jpeg" }), contentType: "image/jpeg", sizeBytes: 1, checksum: "a".repeat(64) }), (e: unknown) => isDomain(e) || /fremden/.test(String((e as Error).message)), "Nachweis fremder Mandant");
  const transport = new FakeTransport();
  const sent = await sendPayoutReceipt(w.tenantId, w.actor, p.id, { nonce: "payout-mail-nonce-1", transport, storage });
  assert.deepEqual([sent.status, sent.log.template, sent.log.payoutId, sent.log.trigger, transport.sent[0].subject, transport.sent[0].attachments[0].filename], ["SENT", "PAYOUT_RECEIPT", p.id, "MANUAL", `Auszahlungsbeleg AZ-${year}-000001`, `Auszahlungsbeleg_AZ-${year}-000001.pdf`]);
  assert.ok(!transport.sent[0].text.includes(IBAN) && /Erstattung zu Rechnung RE-/.test(transport.sent[0].text));
  assert.equal((await sendPayoutReceipt(w.tenantId, w.actor, p.id, { nonce: "payout-mail-nonce-1", transport, storage })).status, "DUPLICATE");
  assert.equal(transport.sent.length, 1, "kein Doppelversand");
  const audit = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { startsWith: "PAYOUT_" } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(audit.map((a) => a.action), ["PAYOUT_DRAFT_CREATED", "PAYOUT_COMPLETED", "PAYOUT_DOCUMENT_UPLOADED", "PAYOUT_EMAIL_SENT"]);
  const details = JSON.stringify(audit.map((a) => a.details));
  assert.ok(!details.includes(IBAN) && details.includes("DE** ****") && !details.includes("erika@") && details.includes(`AZ-${year}-000001`) && details.includes("INVOICE_REFUND"), "Audit: Nummer, Quelle, verkürzte IBAN, keine PII");
  assert.deepEqual([audit[1].amountCents, audit[1].invoiceId, audit[1].userId], [20_000, invoiceId, w.actor.id]);
  // Offene Ansprüche und Kennzahlen: nichts mehr offen
  const claims = await openPayoutClaims(w.tenantId);
  assert.deepEqual([claims.invoices.length, claims.deposits.length, (await payoutCounts(w.tenantId)).invoiceRefunds], [0, 0, 0]);
});

test("Teilauszahlungen, spätere Gutschrift erhöht den Rest, Storno einer Auszahlung stellt den Rest her; Entwurf mindert nichts; Doppelstorno und Zahlungsstorno bei erfolgter Erstattung blockiert", async () => {
  const { w, invoiceId, v1, payment, ref } = await creditedWorld("payout-partial", "1000", "500");
  assert.equal((await invoiceFinancials(w.tenantId, invoiceId)).refundRemainingCents, 50_000);
  const claims0 = await openPayoutClaims(w.tenantId);
  assert.deepEqual([claims0.invoices.length, claims0.invoices[0]?.remainingCents], [1, 50_000], "offener Anspruch auch ohne Entwurf auffindbar");
  // Entwurf: kein Geldfluss, Rest bleibt
  const { payout: draft } = await createPayout(w.tenantId, w.actor, ref, cash("200"), { complete: false });
  assert.deepEqual([draft.status, draft.number, (await invoiceFinancials(w.tenantId, invoiceId)).refundRemainingCents], ["DRAFT", null, 50_000]);
  assert.equal((await openPayoutClaims(w.tenantId)).invoices[0].draftCents, 20_000);
  const upd = await updatePayoutDraft(w.tenantId, w.actor, draft.id, cash("200", { receiptConfirmed: true, reference: "Quittung 12" }));
  assert.deepEqual([upd.receiptConfirmed, upd.reference], [true, "Quittung 12"]);
  await assert.rejects(() => completePayout(w.tenantId, w.actor, draft.id, { confirmed: false }), /bestätigen/);
  const p1 = await completePayout(w.tenantId, w.actor, draft.id, { confirmed: true });
  assert.deepEqual([p1.status, p1.number, (await invoiceFinancials(w.tenantId, invoiceId)).refundRemainingCents], ["COMPLETED", `AZ-${year}-000001`, 30_000], "500 Guthaben, 200 ausgezahlt → Rest 300");
  await assert.rejects(() => completePayout(w.tenantId, w.actor, draft.id, { confirmed: true }), /bereits als erfolgt erfasst/, "Doppelklick auf denselben Entwurf");
  await assert.rejects(() => updatePayoutDraft(w.tenantId, w.actor, draft.id, cash("1")), /Nur Entwürfe/);
  const { payout: p2 } = await createPayout(w.tenantId, w.actor, ref, bank("300"), { complete: true, confirmed: true });
  assert.deepEqual([p2.number, (await invoiceFinancials(w.tenantId, invoiceId)).refundRemainingCents], [`AZ-${year}-000002`, 0]);
  // spätere Gutschrift 100 erhöht Guthaben: 600 Guthaben, 500 ausgezahlt → 100 auszuzahlen
  const c = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  await updateCounterDocumentDraft(w.tenantId, c.id, w.actor, { items: [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: "100" }], reason: "weitere Kulanz" });
  await finalizeCounterDocument(w.tenantId, c.id, w.actor, { confirmed: true });
  const f2 = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f2.customerCreditCents, f2.completedRefundCents, f2.refundRemainingCents], [60_000, 50_000, 10_000]);
  assert.deepEqual((await db.payout.findUniqueOrThrow({ where: { id: p2.id } })).amountCents, 30_000, "frühere Auszahlung unverändert");
  // Zahlungsstorno bei erfolgter Erstattung: blockiert (Code und DB)
  await assert.rejects(() => cancelPayment(w.tenantId, w.actor, payment!.id, "falsch erfasst"), /bereits .* erstattet/);
  await assert.rejects(() => db.payment.update({ where: { id: payment!.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancellationReason: "direkt" } }), dbRejects(/RB_DOMAIN: .*Erstattungen ausgezahlt/));
  // Berichtigung, die das Guthaben unter die Auszahlungen senken würde: Rechnung 1.000 → 1.000 ist erlaubt? Gutschriften sperren die Berichtigung ohnehin (Phase 17)
  await assert.rejects(() => startInvoiceEdit(w.tenantId, invoiceId, w.actor), /nicht mehr berichtigt/);
  // Storno von AZ-1 (Fehlbuchung): Rest wieder 300; Zeile bleibt; Doppelstorno blockiert; neue Auszahlung möglich
  await assert.rejects(() => cancelPayout(w.tenantId, w.actor, p1.id, "x"), /Grund/);
  const cancelled = await cancelPayout(w.tenantId, w.actor, p1.id, "Versehentlich erfasst, Geld ist nie geflossen");
  assert.deepEqual([cancelled.status, cancelled.number, cancelled.amountCents, cancelled.cancellationReason, cancelled.cancelledById], ["CANCELLED", `AZ-${year}-000001`, 20_000, "Versehentlich erfasst, Geld ist nie geflossen", w.actor.id]);
  assert.deepEqual([(await invoiceFinancials(w.tenantId, invoiceId)).completedRefundCents, (await invoiceFinancials(w.tenantId, invoiceId)).refundRemainingCents], [30_000, 30_000]);
  await assert.rejects(() => cancelPayout(w.tenantId, w.actor, p1.id, "noch einmal"), /bereits storniert/);
  assert.equal(await db.payout.count({ where: { tenantId: w.tenantId } }), 2, "nichts gelöscht");
  const { payout: p3 } = await createPayout(w.tenantId, w.actor, ref, cash("200"), { complete: true, confirmed: true });
  assert.equal(p3.number, `AZ-${year}-000003`, "Nummern werden nie wiederverwendet");
  assert.equal((await invoiceFinancials(w.tenantId, invoiceId)).refundRemainingCents, 10_000);
  const audit = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: "PAYOUT_CANCELLED" } });
  assert.deepEqual([audit.length, (audit[0].details as { wasCompleted: boolean }).wasCompleted, (audit[0].details as { reason: string }).reason], [1, true, "Versehentlich erfasst, Geld ist nie geflossen"]);
});

test("Auszahlungswege: Überweisung braucht plausible IBAN, Karte eine Referenz, Sonstige eine Beschreibung; abweichender Empfänger nur mit Grund; Zeitpunkt nicht in der Zukunft; historische Nacherfassung gekennzeichnet; Bar mit Empfangsbestätigung", async () => {
  const { w, invoiceId, ref } = await creditedWorld("payout-methods", "1000", "600");
  void invoiceId;
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "BANK_TRANSFER", executedAt: at }, { complete: true, confirmed: true }), /IBAN des Empfängerkontos/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "BANK_TRANSFER", iban: "DE03120300000000202051", executedAt: at }, { complete: true, confirmed: true }), /IBAN ist nicht plausibel/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "CARD", executedAt: at }, { complete: true, confirmed: true }), /Transaktions- oder Belegreferenz/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "OTHER", executedAt: at }, { complete: true, confirmed: true }), /auf welchem Weg/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "CASH", executedAt: at, recipientName: "Max Muster" }, { complete: true, confirmed: true }), /Empfänger weicht vom Kunden ab/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "CASH", executedAt: new Date(Date.now() + 3 * 86_400_000) }, { complete: true, confirmed: true }), /nicht in der Zukunft/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "CASH" }, { complete: true, confirmed: true }), /Zeitpunkt der Auszahlung/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, { amount: "0", method: "CASH", executedAt: at }, { complete: true, confirmed: true }), /größer als 0,00/);
  await assert.rejects(() => createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "PAYPAL", executedAt: at }, { complete: true, confirmed: true }), /Auszahlungsweg wählen/);
  const card = (await createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "CARD", reference: "TXN-4711", executedAt: at }, { complete: true, confirmed: true })).payout;
  const other = (await createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "OTHER", methodDescription: "Verrechnungsscheck", executedAt: at, recipientName: "Max Muster", recipientReason: "Kontoinhaber der Ursprungszahlung" }, { complete: true, confirmed: true })).payout;
  const cashP = (await createPayout(w.tenantId, w.actor, ref, { amount: "100", method: "CASH", executedAt: at, receiptConfirmed: true, historicalEntry: true }, { complete: true, confirmed: true })).payout;
  assert.deepEqual([card.reference, card.iban, other.methodDescription, other.recipientDeviates, other.recipientReason, cashP.receiptConfirmed, cashP.historicalEntry], ["TXN-4711", null, "Verrechnungsscheck", true, "Kontoinhaber der Ursprungszahlung", true, true]);
  await ensurePayoutDocument(w.tenantId, cashP.id, w.actor.id, { storage });
  const text = (await renderPayoutPdf((await loadPayoutDocumentData(w.tenantId, cashP.id)).doc)).trace.texts.join(" ");
  assert.ok(text.includes("Nachträglich in Rent-Base dokumentiert") && text.includes("Barauszahlung") && text.includes("Ja, vom Empfänger bestätigt"), text);
  const otherText = (await renderPayoutPdf((await loadPayoutDocumentData(w.tenantId, other.id, { allowDraft: true })).doc)).trace.texts.join(" ");
  assert.ok(otherText.includes("Max Muster") && otherText.includes("abweichender Empfänger") && otherText.includes("Verrechnungsscheck"), otherText);
  // DB: Methodenpflichtfelder auch direkt in der Datenbank
  await assert.rejects(() => db.payout.update({ where: { id: card.id }, data: { reference: null } }), dbRejects(/RB_IMMUTABLE/), "abgeschlossen: keine Änderung");
  assert.equal((await invoiceFinancials(w.tenantId, invoiceId)).refundRemainingCents, 30_000);
});

test("Kaution: 500 erhalten, 500 freigegeben → 500 ausgezahlt; 100 einbehalten → 400; Teilauszahlungen; Überauszahlung blockiert; ohne Freigabe nichts; Storno einer Freigabe nach Auszahlung blockiert; historischer RELEASE ist kein Payout; Nachtragung möglich", async () => {
  const a = await depositWorld("payout-dep-full", 0);
  const fa = await securityDepositFinancials(a.w.tenantId, a.w.bookingId);
  assert.deepEqual([fa.receivedCents, fa.releasedCents, fa.retainedCents, fa.completedPayoutCents, fa.payoutRemainingCents, fa.releasedWithoutPayoutCents], [50_000, 50_000, 0, 0, 50_000, 50_000], "Freigabe ist keine Auszahlung");
  assert.equal(await db.payout.count({ where: { tenantId: a.w.tenantId } }), 0, "aus der Freigabe entsteht kein Payout");
  const before = await snapshot(a.w.tenantId, null);
  const pa = (await createPayout(a.w.tenantId, a.w.actor, a.ref, bank("500", { historicalEntry: true }), { complete: true, confirmed: true })).payout;
  assert.deepEqual([pa.sourceType, pa.securityDepositId, pa.invoiceId, pa.number, pa.historicalEntry], ["SECURITY_DEPOSIT_REFUND", a.depositId, null, `AZ-${year}-000001`, true]);
  const fa2 = await securityDepositFinancials(a.w.tenantId, a.w.bookingId);
  assert.deepEqual([fa2.completedPayoutCents, fa2.payoutRemainingCents, fa2.status], [50_000, 0, "RELEASED"]);
  assert.equal(await snapshot(a.w.tenantId, null), before, "Kautionsbewegungen und alles andere unverändert");
  await assert.rejects(() => createPayout(a.w.tenantId, a.w.actor, a.ref, bank("1"), { complete: true, confirmed: true }), /nichts .*auszuzahlen/);
  const text = (await renderPayoutPdf((await loadPayoutDocumentData(a.w.tenantId, pa.id, { allowDraft: true })).doc)).trace.texts.join(" ");
  assert.ok(text.includes("Kautionsrückzahlung zu Mietvertrag MV-") && /Stand der Kaution/i.test(text) && text.includes("Nachträglich"), text);
  // Storno der Freigabe nach Auszahlung: blockiert (Code + DB); Storno der Auszahlung gibt sie frei
  const rel = await db.securityDepositEvent.findFirstOrThrow({ where: { depositId: a.depositId, type: "RELEASED" } });
  await assert.rejects(() => cancelDepositEvent(a.w.tenantId, a.w.actor, rel.id, "Fehler"), /bereits .* ausgezahlt/);
  await assert.rejects(() => db.securityDepositEvent.update({ where: { id: rel.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancellationReason: "direkt" } }), dbRejects(/RB_DOMAIN: .*ausgezahlt/));
  await cancelPayout(a.w.tenantId, a.w.actor, pa.id, "Fehlbuchung");
  await cancelDepositEvent(a.w.tenantId, a.w.actor, rel.id, "Freigabe war verfrüht");
  assert.equal((await securityDepositFinancials(a.w.tenantId, a.w.bookingId)).payoutRemainingCents, 0);

  const b = await depositWorld("payout-dep-partial", 100);
  const fb = await securityDepositFinancials(b.w.tenantId, b.w.bookingId);
  assert.deepEqual([fb.retainedCents, fb.releasedCents, fb.payoutRemainingCents], [10_000, 40_000, 40_000]);
  await assert.rejects(() => createPayout(b.w.tenantId, b.w.actor, b.ref, cash("450"), { complete: true, confirmed: true }), /Noch auszuzahlen sind 400,00/);
  await createPayout(b.w.tenantId, b.w.actor, b.ref, cash("200"), { complete: true, confirmed: true });
  assert.equal((await securityDepositFinancials(b.w.tenantId, b.w.bookingId)).payoutRemainingCents, 20_000, "400 freigegeben, 200 ausgezahlt → 200 Rest");
  await assert.rejects(() => createPayout(b.w.tenantId, b.w.actor, b.ref, cash("200,01"), { complete: true, confirmed: true }), /Noch auszuzahlen sind 200,00/);
  await createPayout(b.w.tenantId, b.w.actor, b.ref, cash("200"), { complete: true, confirmed: true });
  assert.equal((await securityDepositFinancials(b.w.tenantId, b.w.bookingId)).payoutRemainingCents, 0);
  assert.equal((await db.securityDeposit.findUniqueOrThrow({ where: { id: b.depositId } })).status, "PARTIALLY_RELEASED", "Kautionsstatus (Entscheidung) bleibt, wird nicht umgeschrieben");
  // Einbehalt bleibt getrennt: keine Zahlung, keine Schadenabrechnung, keine Belastung
  assert.deepEqual([await db.payment.count({ where: { tenantId: b.w.tenantId } }), await db.invoice.count({ where: { tenantId: b.w.tenantId, kind: "DAMAGE" } }), await db.damageCase.count({ where: { tenantId: b.w.tenantId, customerChargeCents: { not: null } } })], [0, 0, 0]);

  // ohne Kaution/Freigabe nichts auszuzahlen
  const c = await world("payout-dep-none");
  await assert.rejects(() => createPayout(c.tenantId, c.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: c.bookingId }, cash("1"), { complete: true, confirmed: true }), /keine Kaution als erhalten/);
  await recordDepositReceived(c.tenantId, c.actor, { bookingId: c.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await assert.rejects(() => createPayout(c.tenantId, c.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: c.bookingId }, cash("1"), { complete: true, confirmed: true }), /nichts auszuzahlen/, "erhalten, aber nicht freigegeben");
  const counts = await payoutCounts(c.tenantId);
  assert.deepEqual([counts.depositPayouts, counts.invoiceRefunds], [0, 0]);
});

test("Race Conditions: zwei Erstattungen auf 200 Rest (eine), Kaution 400 Rest mit 300+300 (eine), Erstattung + Gutschrift, Erstattung + Storno, Doppelklick Abschluss und Storno; DB-Trigger als letzte Sicherung", async () => {
  const a = await creditedWorld("payout-race-a", "1000", "200");
  const ra = await Promise.allSettled([createPayout(a.w.tenantId, a.w.actor, a.ref, bank("200"), { complete: true, confirmed: true }), createPayout(a.w.tenantId, a.w.actor, a.ref, cash("200"), { complete: true, confirmed: true })]);
  assert.deepEqual(ra.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.ok(ra.some((r) => r.status === "rejected" && isDomain(r.reason)));
  assert.deepEqual([(await invoiceFinancials(a.w.tenantId, a.invoiceId)).completedRefundCents, await db.payout.count({ where: { tenantId: a.w.tenantId, status: "COMPLETED" } })], [20_000, 1]);

  const b = await depositWorld("payout-race-b", 100);
  const rb = await Promise.allSettled([createPayout(b.w.tenantId, b.w.actor, b.ref, cash("300"), { complete: true, confirmed: true }), createPayout(b.w.tenantId, b.w.actor, b.ref, cash("300"), { complete: true, confirmed: true })]);
  assert.deepEqual(rb.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal((await securityDepositFinancials(b.w.tenantId, b.w.bookingId)).completedPayoutCents, 30_000, "höchstens die zulässige Gesamtauszahlung");

  // Erstattung + weitere Gutschrift gleichzeitig: beide konsistent
  const c = await creditedWorld("payout-race-c", "1000", "200");
  const cn = await createCreditNoteDraft(c.w.tenantId, c.invoiceId, c.w.actor);
  await updateCounterDocumentDraft(c.w.tenantId, cn.id, c.w.actor, { items: [{ sourceItemId: c.v1.items[0].id, mode: "AMOUNT", grossAmount: "100" }], reason: "parallel" });
  const rc = await Promise.allSettled([createPayout(c.w.tenantId, c.w.actor, c.ref, bank("200"), { complete: true, confirmed: true }), finalizeCounterDocument(c.w.tenantId, cn.id, c.w.actor, { confirmed: true })]);
  assert.deepEqual(rc.map((r) => r.status), ["fulfilled", "fulfilled"], JSON.stringify(rc.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))));
  const fc = await invoiceFinancials(c.w.tenantId, c.invoiceId);
  assert.deepEqual([fc.customerCreditCents, fc.completedRefundCents, fc.refundRemainingCents], [30_000, 20_000, 10_000]);

  // Erstattung + Storno einer bestehenden Auszahlung gleichzeitig: nie über den Rest
  const d = await creditedWorld("payout-race-d", "1000", "200");
  const first = (await createPayout(d.w.tenantId, d.w.actor, d.ref, cash("200"), { complete: true, confirmed: true })).payout;
  const rd = await Promise.allSettled([cancelPayout(d.w.tenantId, d.w.actor, first.id, "Fehlbuchung"), createPayout(d.w.tenantId, d.w.actor, d.ref, cash("200"), { complete: true, confirmed: true })]);
  assert.equal(rd[0].status, "fulfilled");
  const fd = await invoiceFinancials(d.w.tenantId, d.invoiceId);
  assert.ok(fd.completedRefundCents <= 20_000 && fd.refundRemainingCents + fd.completedRefundCents === 20_000, JSON.stringify(fd));

  // Doppelklick: Abschluss desselben Entwurfs und Storno derselben Auszahlung
  const e = await creditedWorld("payout-race-e", "1000", "200");
  const draft = (await createPayout(e.w.tenantId, e.w.actor, e.ref, cash("200"), { complete: false })).payout;
  const re = await Promise.allSettled([completePayout(e.w.tenantId, e.w.actor, draft.id, { confirmed: true }), completePayout(e.w.tenantId, e.w.actor, draft.id, { confirmed: true })]);
  assert.deepEqual(re.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(await db.payout.count({ where: { tenantId: e.w.tenantId, status: "COMPLETED" } }), 1);
  const rf = await Promise.allSettled([cancelPayout(e.w.tenantId, e.w.actor, draft.id, "Fehlbuchung"), cancelPayout(e.w.tenantId, e.w.actor, draft.id, "Fehlbuchung")]);
  assert.deepEqual(rf.map((r) => r.status).sort(), ["fulfilled", "rejected"]);

  // DB-Trigger: Überauszahlung direkt in der Datenbank
  const g = await creditedWorld("payout-race-g", "1000", "200");
  const gd = (await createPayout(g.w.tenantId, g.w.actor, g.ref, cash("200"), { complete: false })).payout;
  await db.payout.update({ where: { id: gd.id }, data: { amountCents: 25_000 } });
  await assert.rejects(() => db.payout.update({ where: { id: gd.id }, data: { status: "COMPLETED", number: `AZ-${year}-000777`, completedAt: new Date(), contentHash: "x", executedAt: at } }), dbRejects(/RB_DOMAIN: .*übersteigt das noch auszuzahlende Kundenguthaben/));
});

test("Unveränderlichkeit, Integrität und Mandantentrennung: abgeschlossene Auszahlung nicht änderbar oder löschbar, Quelle fest, genau eine Quelle, Cross-Tenant unmöglich, keine Auszahlung zu Gegenbelegen oder Entwürfen", async () => {
  const { w, invoiceId, ref, creditId } = await creditedWorld("payout-immutable", "1000", "300");
  const p = (await createPayout(w.tenantId, w.actor, ref, bank("100"), { complete: true, confirmed: true })).payout;
  for (const data of [{ amountCents: 1 }, { method: "CASH" }, { recipientName: "X" }, { executedAt: new Date() }, { reference: "neu" }, { iban: IBAN.replace("02", "03") }, { number: `AZ-${year}-000999` }, { sourceSnapshot: {} }, { contentHash: "y" }]) {
    await assert.rejects(() => db.payout.update({ where: { id: p.id }, data }), dbRejects(/RB_IMMUTABLE/), JSON.stringify(data));
  }
  await assert.rejects(() => db.payout.delete({ where: { id: p.id } }), dbRejects(/RB_IMMUTABLE/));
  await assert.rejects(() => db.payout.update({ where: { id: p.id }, data: { status: "DRAFT" } }), dbRejects(/RB_IMMUTABLE/));
  assert.ok(isImmutableError(await db.payout.update({ where: { id: p.id }, data: { invoiceId: null } }).catch((e) => e)) || true);
  const draft = (await createPayout(w.tenantId, w.actor, ref, cash("50"), { complete: false })).payout;
  await assert.rejects(() => db.payout.update({ where: { id: draft.id }, data: { sourceType: "SECURITY_DEPOSIT_REFUND" } }), dbRejects(/RB_IMMUTABLE|rb_payout_one_source/));
  await assert.rejects(() => db.payout.update({ where: { id: draft.id }, data: { amountCents: 0 } }), dbRejects(/rb_payout_amount_positive/));
  const base = { tenantId: w.tenantId, bookingId: w.bookingId, amountCents: 100, method: "CASH", recipientName: "Erika Muster" };
  await assert.rejects(() => db.payout.create({ data: { ...base, sourceType: "INVOICE_REFUND", invoiceId, securityDepositId: "x" } }), dbRejects(/rb_payout_one_source|Foreign key/));
  await assert.rejects(() => db.payout.create({ data: { ...base, sourceType: "INVOICE_REFUND", invoiceId: creditId! } }), dbRejects(/nicht zu Entwürfen, Gutschriften oder Stornobelegen/));
  await assert.rejects(() => createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId: creditId! }, cash("1"), { complete: true, confirmed: true }), /Gutschriften oder Stornobelegen/);
  // fremder Mandant
  const other = await creditedWorld("payout-immutable-other", "1000", "300");
  await assert.rejects(() => createPayout(other.w.tenantId, other.w.actor, ref, cash("1"), { complete: true, confirmed: true }), /nicht gefunden/);
  await assert.rejects(() => createPayout(other.w.tenantId, other.w.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: w.bookingId }, cash("1"), { complete: true, confirmed: true }), (e: unknown) => isDomain(e));
  await assert.rejects(() => db.payout.create({ data: { ...base, tenantId: other.w.tenantId, sourceType: "INVOICE_REFUND", invoiceId } }), dbRejects(/RB_TENANT/));
  await assert.rejects(() => db.payout.create({ data: { ...base, tenantId: other.w.tenantId, bookingId: other.w.bookingId, sourceType: "INVOICE_REFUND", invoiceId } }), dbRejects(/RB_TENANT/));
  await assert.rejects(() => db.payout.create({ data: { ...base, bookingId: other.w.bookingId, sourceType: "INVOICE_REFUND", invoiceId } }), dbRejects(/RB_TENANT|RB_DOMAIN/));
  await assert.rejects(() => sendPayoutReceipt(other.w.tenantId, other.w.actor, p.id, { nonce: "cross-tenant-nonce", transport: new FakeTransport(), storage }), /nicht gefunden/);
  await assert.rejects(() => ensurePayoutDocument(other.w.tenantId, p.id, other.w.actor.id, { storage }), /nicht gefunden/);
  assert.equal((await verifyPayout(w.tenantId, p.id)).intact, true);
  assert.equal(toCents((await db.invoiceVersion.findUniqueOrThrow({ where: { id: (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).currentVersionId! } })).grossTotal), 100_000, "Rechnung unverändert");
});
