// Gutschriften, Stornobelege und Kundenguthaben (Phase 17): Gegenbelege mit eigener Nummer und positiven Beträgen,
// Original unverändert, nie mehr gutschreiben als offen (Gesamt, je Position, je Steuersatz; Code und DB-Trigger),
// Storno = genau der Rest, Belegkette und zentrale Finanzsummierung (Forderung, Zahlungen, Guthaben, nie negativ offen),
// Steuerspiegelung, Nummernkreise je Mandant, Unveränderlichkeit, keine Nebenwirkungen, Race Conditions, PDF und E-Mail.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { cancellationLines, computeFinancials, createCancellationDraft, createCreditNoteDraft, discardCounterDocumentDraft, documentChain, finalizeCounterDocument, financialsFor, getCounterDocumentState, invoiceFinancials, residualsOf, updateCounterDocumentDraft, verifyCounterDocument } from "../src/lib/counter-documents";
import { chargeCustomer, openDamageCase, setLiability } from "../src/lib/damage-cases";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { ensureInvoiceDocument, readDocumentFile } from "../src/lib/documents";
import { runInvoiceFollowUp } from "../src/lib/followup";
import { DomainError, isImmutableError } from "../src/lib/integrity";
import { discardInvoiceDraft, ensureInvoiceDraft, finalizeInvoice, invoiceEditMode, startInvoiceEdit, updateInvoiceDraft, verifyInvoice, verifyVersion } from "../src/lib/invoices";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { toCents } from "../src/lib/money";
import { DEFAULT_NUMBER_RANGES, numberRangesOf, validateNumberRanges } from "../src/lib/number-ranges";
import { invoicePaymentSummary, paymentSummaries, recordInvoicePayment } from "../src/lib/payments";
import { renderInvoicePdf } from "../src/lib/pdf/invoice-pdf";
import { sendInvoiceDocument } from "../src/lib/rental-mail";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-credit-"));
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
const isDomain = (e: unknown) => e instanceof DomainError;
const dbRejects = (re: RegExp) => (e: unknown) => re.test(String((e as Error).message));

const world = async (label: string, opts: Parameters<typeof returnedWorld>[1] = {}) => {
  await ready;
  const w = await returnedWorld(label, opts);
  tenants.push(w.tenantId);
  return w;
};
const draftOf = (invoiceId: string) => db.invoiceVersion.findFirstOrThrow({ where: { invoiceId, status: "DRAFT" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
/** Abgeschlossene Mietrechnung 1.000 € brutto: 600 € zu 19 % und 400 € zu 0 % (mit Steuerhinweis). */
async function invoicedWorld(label: string, items: { price: string; rate: string }[] = [{ price: "600", rate: "19" }, { price: "400", rate: "0" }]) {
  const w = await world(label);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const d = await draftOf(inv.id);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: items.map((it, i) => ({ id: i === 0 ? d.items[0].id : undefined, description: i === 0 ? d.items[0].description : `Position ${i + 1}`, quantity: "1", unit: "pauschal", unitPrice: it.price, taxRate: it.rate })), taxNote: "Steuerfreie Position laut Vereinbarung (Test)." });
  const v1 = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  const original = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  return { w, invoiceId: inv.id, v1, number: original.number!, original };
}
/** Schnappschuss des Originals samt Positionen, Zahlungen, Dokumenten (für „nichts verändert“). */
async function snapshot(tenantId: string, invoiceId: string) {
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const versions = await db.invoiceVersion.findMany({ where: { invoiceId }, orderBy: { versionNo: "asc" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  const payments = await db.payment.findMany({ where: { tenantId, invoiceId }, orderBy: { createdAt: "asc" } });
  const docs = await db.document.findMany({ where: { tenantId, invoiceId }, orderBy: { createdAt: "asc" } });
  const { updatedAt: _u, changeLog: _c, ...rest } = inv;
  void _u; void _c;
  return JSON.stringify({ rest, versions, payments, docs });
}
const creditOf = async (tenantId: string, invoiceId: string, actor: { id: string; name: string }, items: Parameters<typeof updateCounterDocumentDraft>[3]["items"], reason = "Testgutschrift") => {
  const c = await createCreditNoteDraft(tenantId, invoiceId, actor);
  await updateCounterDocumentDraft(tenantId, c.id, actor, { items, reason });
  const v = await finalizeCounterDocument(tenantId, c.id, actor, { confirmed: true });
  return { counter: await db.invoice.findUniqueOrThrow({ where: { id: c.id } }), version: v };
};

test("Rechenmodell: Forderung = Rechnung − Gutschriften − Storno, offen nie negativ, Guthaben = Erstattung erforderlich, Kettenstatus", () => {
  const a = computeFinancials("a", 100_000, 0, 0, 0);
  assert.deepEqual([a.effectiveCents, a.openCents, a.customerCreditCents, a.chain, a.paymentStatus, a.refundRequired], [100_000, 100_000, 0, "NONE", "OPEN", false]);
  const b = computeFinancials("b", 100_000, 20_000, 0, 0);
  assert.deepEqual([b.effectiveCents, b.openCents, b.chain], [80_000, 80_000, "PARTIALLY_CREDITED"]);
  const c = computeFinancials("c", 100_000, 20_000, 0, 100_000);
  assert.deepEqual([c.effectiveCents, c.openCents, c.customerCreditCents, c.paymentStatus, c.refundRequired], [80_000, 0, 20_000, "PAID", true], "1.000 bezahlt, 200 gutgeschrieben → offen 0, Guthaben 200");
  const d = computeFinancials("d", 100_000, 70_000, 0, 50_000);
  assert.deepEqual([d.effectiveCents, d.openCents, d.customerCreditCents, d.paymentStatus], [30_000, 0, 20_000, "PAID"], "500 bezahlt, 700 gutgeschrieben → offen 0, Guthaben 200");
  const e = computeFinancials("e", 100_000, 20_000, 80_000, 100_000);
  assert.deepEqual([e.effectiveCents, e.customerCreditCents, e.chain, e.fullyNeutralized], [0, 100_000, "CANCELLED", true], "Storno nach Gutschrift: Gesamtwirkung 0, alles Guthaben");
  const f = computeFinancials("f", 100_000, 100_000, 0, 30_000);
  assert.deepEqual([f.chain, f.customerCreditCents, f.openCents], ["CREDITED", 30_000, 0]);
  const g = computeFinancials("g", 100_000, 20_000, 0, 50_000);
  assert.deepEqual([g.openCents, g.paymentStatus], [30_000, "PARTIAL"]);
});

test("Nummernkreise: Standard RE/GS/ST, Präfix-Prüfung (Form, verschieden), gespeicherte Konfiguration mit Rückfall", () => {
  assert.deepEqual(numberRangesOf(null), DEFAULT_NUMBER_RANGES);
  assert.deepEqual(numberRangesOf({ creditNote: { prefix: "GU" }, unknown: 1, cancellation: { prefix: "st" } }).creditNote.prefix, "GU");
  assert.equal(numberRangesOf({ cancellation: { prefix: "st" } }).cancellation.prefix, "ST", "ungültiges Präfix → Standard");
  assert.throws(() => validateNumberRanges({ invoice: "RE", creditNote: "RE", cancellation: "ST", payout: "AZ" }), /unterscheiden/);
  assert.throws(() => validateNumberRanges({ invoice: "RE-1", creditNote: "GS", cancellation: "ST", payout: "AZ" }), /1 bis 6 Großbuchstaben/);
  assert.deepEqual(validateNumberRanges({ invoice: "re", creditNote: " gs ", cancellation: "STORNO", payout: "az" }), { invoice: { prefix: "RE" }, creditNote: { prefix: "GS" }, cancellation: { prefix: "STORNO" }, payout: { prefix: "AZ" } });
});

test("Teilgutschrift und Restgutschrift: eigene Nummern GS-…, positive Beträge, Original unverändert, Kette, Restbeträge je Position, keine dritte Gutschrift (Code und DB)", async () => {
  const { w, invoiceId, v1, number } = await invoicedWorld("credit-basic");
  const before = await snapshot(w.tenantId, invoiceId);
  const item19 = v1.items[0], item0 = v1.items[1];

  // Entwurf: Vorschlag = alle offenen Positionen (Rest), noch ohne Nummer, Original unverändert
  const draft = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  assert.deepEqual([draft.documentType, draft.status, draft.number, draft.originalInvoiceId, draft.originalVersionId, draft.kind, draft.bookingId], ["CREDIT_NOTE", "DRAFT", null, invoiceId, v1.id, "RENTAL", w.bookingId]);
  const snap = draft.originalSnapshot as { number: string; versionNo: number; grossTotal: string; customerName: string };
  assert.deepEqual([snap.number, snap.versionNo, snap.grossTotal, snap.customerName], [number, 1, "1000.00", "Erika Muster"]);
  const dv = await draftOf(draft.id);
  assert.equal(toCents(dv.grossTotal), 100_000, "Vorschlag: gesamter Rest");
  assert.deepEqual(dv.items.map((i) => [i.sourceInvoiceVersionItemId, toCents(i.grossAmount), Number(i.taxRate)]), [[item19.id, 60_000, 19], [item0.id, 40_000, 0]]);
  // Zustand für die Oberfläche: Grund fehlt noch, sonst alles frei
  const st0 = await getCounterDocumentState(w.tenantId, draft.id);
  assert.ok(st0.issues.some((i) => i.code === "REASON") && !st0.issues.some((i) => i.code !== "REASON"), JSON.stringify(st0.issues));
  assert.equal((await invoiceEditMode(w.tenantId, invoiceId)).editable, false, "mit offenem Gegenbeleg-Entwurf keine Berichtigung");
  await assert.rejects(() => startInvoiceEdit(w.tenantId, invoiceId, w.actor), /Entwurf einer Gutschrift/);
  await assert.rejects(() => createCreditNoteDraft(w.tenantId, invoiceId, w.actor), /bereits ein Entwurf/, "nur ein offener Gegenbeleg-Entwurf je Rechnung");

  // Teilgutschrift: 200 € Teilbetrag auf die 19-%-Position → Netto/Steuer anteilig, plus 100 € der 0-%-Position nach Menge geht nicht (Menge 1 = Rest) → Betrag
  await updateCounterDocumentDraft(w.tenantId, draft.id, w.actor, { items: [{ sourceItemId: item19.id, mode: "AMOUNT", grossAmount: "200" }], reason: "Reinigungspauschale teilweise erlassen" });
  const dv2 = await draftOf(draft.id);
  assert.deepEqual(dv2.items.map((i) => [toCents(i.netAmount), toCents(i.taxAmount), toCents(i.grossAmount), i.unit, String(i.quantity)]), [[16_807, 3_193, 20_000, "pauschal", "1"]], "200 brutto → 168,07 netto + 31,93 USt (19 %)");
  await assert.rejects(() => finalizeCounterDocument(w.tenantId, draft.id, w.actor, { confirmed: false }), /ausdrücklich bestätigen/);
  await assert.rejects(() => finalizeCounterDocument(w.tenantId, draft.id, w.actor, { confirmed: true, reason: "" }), /Grund der Gutschrift/);
  const gv = await finalizeCounterDocument(w.tenantId, draft.id, w.actor, { confirmed: true });
  const g1 = await db.invoice.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(g1.number, `GS-${year}-000001`);
  assert.deepEqual([g1.status, gv.status, gv.versionNo, gv.kind, toCents(gv.grossTotal), gv.paymentDueDate, gv.reason, !!gv.contentHash, g1.currentVersionId], ["FINALIZED", "FINALIZED", 1, "ORIGINAL", 20_000, null, "Reinigungspauschale teilweise erlassen", true, gv.id]);
  assert.ok(gv.items.every((i) => toCents(i.grossAmount) > 0 && toCents(i.netAmount) >= 0 && toCents(i.taxAmount) >= 0), "keine negativen Beträge");
  assert.equal((await verifyCounterDocument(w.tenantId, g1.id)).intact, true);
  assert.equal((await verifyVersion(w.tenantId, gv.id)).intact, true, "Prüfsumme auch über die allgemeine Prüfung");
  assert.equal(await snapshot(w.tenantId, invoiceId), before, "Originalrechnung, Fassung, Positionen, Zahlungen, Dokumente unverändert");
  assert.equal((await verifyInvoice(w.tenantId, invoiceId)).intact, true);

  // Kette und Summierung
  const f1 = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f1.invoiceCents, f1.creditedCents, f1.effectiveCents, f1.openCents, f1.chain, f1.fullyNeutralized], [100_000, 20_000, 80_000, 80_000, "PARTIALLY_CREDITED", false]);
  const chain = await documentChain(w.tenantId, g1.id);
  assert.deepEqual([chain.original.number, chain.counters.map((c) => [c.documentType, c.number, c.grossCents]), chain.financials.effectiveCents], [number, [["CREDIT_NOTE", `GS-${year}-000001`, 20_000]], 80_000]);
  assert.equal(chain.counters[0].href, `/buchungen/${w.bookingId}/rechnung?nr=${g1.id}`);
  const res = await residualsOf(db, w.tenantId, { id: invoiceId, currentVersionId: v1.id });
  assert.deepEqual(res.items.map((i) => [i.credited.gross, i.remaining.gross, i.remaining.net, i.remaining.tax]), [[20_000, 40_000, 33_613, 6_387], [0, 40_000, 40_000, 0]]);

  // Über den Rest hinaus: je Position, insgesamt, je Steuersatz – im Code
  const d2 = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  await assert.rejects(() => updateCounterDocumentDraft(w.tenantId, d2.id, w.actor, { items: [{ sourceItemId: item19.id, mode: "AMOUNT", grossAmount: "400,01" }] }), /übersteigen den gutschreibbaren Rest/);
  await assert.rejects(() => updateCounterDocumentDraft(w.tenantId, d2.id, w.actor, { items: [{ sourceItemId: item19.id, mode: "QUANTITY", quantity: "2" }] }), /gutschreibbar sind noch/);
  await assert.rejects(() => updateCounterDocumentDraft(w.tenantId, d2.id, w.actor, { items: [{ manual: true, description: "Kulanz", quantity: "1", unit: "pauschal", unitPrice: "900", taxRate: "19", reason: "Kulanz" }] }), /übersteigt den noch nicht gutgeschriebenen Betrag/);
  await assert.rejects(() => updateCounterDocumentDraft(w.tenantId, d2.id, w.actor, { items: [{ manual: true, description: "Kulanz", quantity: "1", unit: "pauschal", unitPrice: "10", taxRate: "7", reason: "Kulanz" }] }), /kommt in der Rechnung nicht vor/, "nur Steuersätze der Rechnung");
  await assert.rejects(() => updateCounterDocumentDraft(w.tenantId, d2.id, w.actor, { items: [{ manual: true, description: "Kulanz", quantity: "1", unit: "pauschal", unitPrice: "10", taxRate: "19", reason: "" }] }), /Grund der manuellen Gutschrift/);
  // manuelle Kulanz 450 € zu 19 % ist je Steuersatz zu viel (Rest 19 %: 400 €)
  await updateCounterDocumentDraft(w.tenantId, d2.id, w.actor, { items: [{ manual: true, description: "Kulanz", quantity: "1", unit: "pauschal", unitPrice: "450", taxRate: "19", reason: "Kulanz wegen Wartezeit" }], reason: "Kulanz" });
  await assert.rejects(() => finalizeCounterDocument(w.tenantId, d2.id, w.actor, { confirmed: true }), /Zum Steuersatz 19,00.*sind noch 400,00/);
  // „Restbetrag vollständig gutschreiben“: exakt der Rest je Position, Kette danach CREDITED
  await assert.rejects(() => updateCounterDocumentDraft(w.tenantId, d2.id, w.actor, { items: [{ sourceItemId: item19.id, mode: "REMAINING" }, { sourceItemId: item0.id, mode: "REMAINING" }, { manual: true, description: "Kulanz", quantity: "1", unit: "pauschal", unitPrice: "0,01", taxRate: "19", reason: "Cent-Test" }] }), /800,01.*übersteigt den noch nicht gutgeschriebenen Betrag/, "auch 1 Cent zu viel wird abgelehnt");
  await updateCounterDocumentDraft(w.tenantId, d2.id, w.actor, { items: [{ sourceItemId: item19.id, mode: "REMAINING" }, { sourceItemId: item0.id, mode: "REMAINING" }] });
  const dv3 = await draftOf(d2.id);
  assert.deepEqual(dv3.items.map((i) => [i.description.endsWith("(Restbetrag)"), toCents(i.netAmount), toCents(i.taxAmount), toCents(i.grossAmount)]), [[true, 33_613, 6_387, 40_000], [false, 40_000, 0, 40_000]]);
  const gv2 = await finalizeCounterDocument(w.tenantId, d2.id, w.actor, { confirmed: true, reason: "Rest erlassen" });
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d2.id } })).number, `GS-${year}-000002`);
  assert.equal(toCents(gv2.grossTotal), 80_000);
  const f2 = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f2.creditedCents, f2.effectiveCents, f2.chain, f2.fullyNeutralized, f2.openCents], [100_000, 0, "CREDITED", true, 0]);
  await assert.rejects(() => createCreditNoteDraft(w.tenantId, invoiceId, w.actor), /vollständig gutgeschrieben/);
  await assert.rejects(() => createCancellationDraft(w.tenantId, invoiceId, w.actor), /vollständig gutgeschrieben/);
  assert.equal(await snapshot(w.tenantId, invoiceId), before, "Original weiterhin unverändert");

  // Audit: Anlage und Abschluss mit Bezug, Betrag, Nummer; ohne personenbezogene Daten
  const audit = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["CREDIT_NOTE_DRAFT_CREATED", "CREDIT_NOTE_FINALIZED"] } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(audit.map((a) => a.action), ["CREDIT_NOTE_DRAFT_CREATED", "CREDIT_NOTE_FINALIZED", "CREDIT_NOTE_DRAFT_CREATED", "CREDIT_NOTE_FINALIZED"]);
  const fin = audit[1].details as Record<string, unknown>;
  assert.deepEqual([fin.number, fin.originalInvoiceId, fin.originalNumber, fin.reason, audit[1].amountCents, audit[1].userId, audit[1].invoiceId], [`GS-${year}-000001`, invoiceId, number, "Reinigungspauschale teilweise erlassen", 20_000, w.actor.id, g1.id]);
  assert.ok(!JSON.stringify(audit.map((a) => a.details)).includes("Muster") && !JSON.stringify(audit.map((a) => a.details)).includes("@"), "keine Kundendaten im Audit");
});

test("Storno: Entwurf verwerfen verbraucht keine Nummer; Storno nach Teilgutschrift = genau der Rest (800), Gesamtwirkung 0, danach kein Beleg mehr; Rechnung und PDF bleiben", async () => {
  const { w, invoiceId, v1, number } = await invoicedWorld("credit-storno");
  const pdf = await ensureInvoiceDocument(w.tenantId, v1.id, w.actor.id, { storage });
  const before = await snapshot(w.tenantId, invoiceId);
  // Storno-Entwurf ohne frühere Belege spiegelt die Positionen; verwerfen → kein Beleg, keine Nummer
  const s0 = await createCancellationDraft(w.tenantId, invoiceId, w.actor);
  const s0v = await draftOf(s0.id);
  assert.deepEqual(s0v.items.map((i) => [i.sourceInvoiceVersionItemId, toCents(i.grossAmount), i.unit]), [[v1.items[0].id, 60_000, "pauschal"], [v1.items[1].id, 40_000, "pauschal"]]);
  await assert.rejects(() => updateCounterDocumentDraft(w.tenantId, s0.id, w.actor, { items: [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: "1" }] }), /Stornobeleg neutralisiert immer den vollständigen Rest/);
  const discarded = await discardCounterDocumentDraft(w.tenantId, s0.id, w.actor);
  assert.deepEqual([discarded.originalInvoiceId, discarded.type, await db.invoice.count({ where: { id: s0.id } })], [invoiceId, "CANCELLATION", 0]);
  assert.equal((await db.auditLog.count({ where: { tenantId: w.tenantId, action: "CANCELLATION_DRAFT_DISCARDED" } })), 1);

  const { counter: g } = await creditOf(w.tenantId, invoiceId, w.actor, [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: "200" }]);
  assert.equal(g.number, `GS-${year}-000001`);
  const s = await createCancellationDraft(w.tenantId, invoiceId, w.actor);
  const sv = await draftOf(s.id);
  assert.equal(toCents(sv.grossTotal), 80_000, "Storno = Rechnung 1.000 − Gutschrift 200");
  assert.deepEqual(sv.items.map((i) => [Number(i.taxRate), toCents(i.netAmount), toCents(i.taxAmount), toCents(i.grossAmount), i.sourceInvoiceVersionItemId]), [[19, 33_613, 6_387, 40_000, null], [0, 40_000, 0, 40_000, null]], "Rest je Steuersatz, exakt");
  assert.ok(sv.items[0].description.includes(`Storno Rechnung ${number}`) && sv.items[0].description.includes("19,00 %"));
  const st = await getCounterDocumentState(w.tenantId, s.id);
  assert.deepEqual([st.financials.effectiveCents, st.effectiveAfter, st.paidCents, st.customerCreditAfter], [80_000, 0, 0, 0]);
  await assert.rejects(() => finalizeCounterDocument(w.tenantId, s.id, w.actor, { confirmed: true }), /Grund des Stornos/);
  const stv = await finalizeCounterDocument(w.tenantId, s.id, w.actor, { confirmed: true, reason: "Rechnung an falschen Empfänger" });
  const sInv = await db.invoice.findUniqueOrThrow({ where: { id: s.id } });
  assert.deepEqual([sInv.number, sInv.status, sInv.documentType, toCents(stv.grossTotal)], [`ST-${year}-000001`, "FINALIZED", "CANCELLATION", 80_000]);
  const f = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f.invoiceCents, f.creditedCents, f.cancelledCents, f.effectiveCents, f.chain, f.fullyNeutralized], [100_000, 20_000, 80_000, 0, "CANCELLED", true]);
  await assert.rejects(() => createCreditNoteDraft(w.tenantId, invoiceId, w.actor), /bereits storniert/);
  await assert.rejects(() => createCancellationDraft(w.tenantId, invoiceId, w.actor), /bereits storniert/);
  assert.equal(await snapshot(w.tenantId, invoiceId), before, "Original unverändert");
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  assert.deepEqual([inv.status, inv.number, inv.currentVersionId], ["FINALIZED", number, v1.id], "Rechnung bleibt FINALIZED mit ihrer Nummer; Storno ist abgeleitet");
  const file = await readDocumentFile(w.tenantId, pdf.document.id, storage);
  assert.ok(file && file.body.length === pdf.document.sizeBytes, "PDF der Rechnung weiterhin abrufbar");
  const chain = await documentChain(w.tenantId, invoiceId);
  assert.deepEqual(chain.counters.map((c) => c.number), [`GS-${year}-000001`, `ST-${year}-000001`]);
  // Storno-Entwurf, der durch eine zwischenzeitliche Gutschrift veraltet: wird beim Abschluss abgewiesen
  const w2 = await invoicedWorld("credit-storno-stale");
  const s2 = await createCancellationDraft(w2.w.tenantId, w2.invoiceId, w2.w.actor);
  await db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_purge = 'on'`); await tx.invoice.update({ where: { id: s2.id }, data: { status: "DRAFT" } }); });
  // parallel: Gutschrift wird angelegt und abgeschlossen, obwohl ein Storno-Entwurf offen ist? Nein – ein Entwurf je Rechnung. Also: Storno verwerfen, Gutschrift, neuer Storno.
  await discardCounterDocumentDraft(w2.w.tenantId, s2.id, w2.w.actor);
  await creditOf(w2.w.tenantId, w2.invoiceId, w2.w.actor, [{ sourceItemId: w2.v1.items[1].id, mode: "REMAINING" }]);
  const s3 = await createCancellationDraft(w2.w.tenantId, w2.invoiceId, w2.w.actor);
  assert.equal(toCents((await draftOf(s3.id)).grossTotal), 60_000);
  const s3v = await finalizeCounterDocument(w2.w.tenantId, s3.id, w2.w.actor, { confirmed: true, reason: "Storno" });
  assert.equal(toCents(s3v.grossTotal), 60_000);
  assert.equal((await invoiceFinancials(w2.w.tenantId, w2.invoiceId)).effectiveCents, 0);
});

test("Zahlungen: Gutschrift ändert keine Zahlung; bezahlt 1.000 + Gutschrift 200 → offen 0, Guthaben 200, bezahlt, nicht überfällig; Zahlung nur bis zur wirksamen Forderung; keine Zahlung auf Gegenbelege", async () => {
  const { w, invoiceId, v1 } = await invoicedWorld("credit-payments");
  const pay = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "1000", method: "BANK_TRANSFER", paidAt: at });
  assert.equal((await invoicePaymentSummary(w.tenantId, invoiceId)).status, "PAID");
  const { counter } = await creditOf(w.tenantId, invoiceId, w.actor, [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: "200" }]);
  const s = await invoicePaymentSummary(w.tenantId, invoiceId);
  assert.deepEqual([s.invoiceCents, s.creditedCents, s.grossCents, s.paidCents, s.openCents, s.overpaidCents, s.status, s.chain], [100_000, 20_000, 80_000, 100_000, 0, 20_000, "OVERPAID", "PARTIALLY_CREDITED"]);
  const f = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f.openCents, f.customerCreditCents, f.paymentStatus, f.refundRequired], [0, 20_000, "PAID", true], "offen 0 und Guthaben 200 – kein negativer offener Betrag");
  // Regression Überfälligkeit: Fälligkeit liegt in der Vergangenheit, offen ist 0 → nicht überfällig
  const overdueRule = (fin: typeof f, due: Date | null) => fin.openCents > 0 && !!due && due < new Date();
  assert.equal(overdueRule(f, new Date(Date.now() - 86_400_000)), false);
  assert.equal(overdueRule(computeFinancials("x", 100_000, 20_000, 0, 30_000), new Date(Date.now() - 86_400_000)), true, "wer noch schuldet, bleibt überfällig");
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: pay.payment.id } }), pay.payment, "Zahlung unverändert");
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId } }), 1, "keine Erstattungs- oder Verrechnungsbuchung");
  await assert.rejects(() => recordInvoicePayment(w.tenantId, w.actor, { invoiceId: counter.id, amount: "1", method: "CASH", paidAt: at }), /nur zu Rechnungen erfasst/);
  await assert.rejects(() => db.payment.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, invoiceId: counter.id, type: "INVOICE_PAYMENT", method: "CASH", amountCents: 100, paidAt: at } }), dbRejects(/RB_DOMAIN: Zahlungen werden nur zu Rechnungen/));
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId } }), 1);
  // Liste: Summen aus der zentralen Berechnung
  const sums = await paymentSummaries(w.tenantId, [{ id: invoiceId, grossTotal: v1.grossTotal }]);
  assert.equal(sums.get(invoiceId)!.grossCents, 80_000);
  const m = await financialsFor(w.tenantId, [{ id: invoiceId, grossTotal: v1.grossTotal }, { id: counter.id, grossTotal: 20_000 }]);
  assert.equal(m.get(counter.id)!.chain, "NONE", "Gegenbeleg selbst ist keine Forderung mit Kette");

  // unbezahlt: Gutschrift 200 → offen 800; Zahlung 900 abgelehnt, 800 möglich → bezahlt
  const w2 = await invoicedWorld("credit-payments-2");
  await creditOf(w2.w.tenantId, w2.invoiceId, w2.w.actor, [{ sourceItemId: w2.v1.items[0].id, mode: "AMOUNT", grossAmount: "200" }]);
  assert.deepEqual([(await invoicePaymentSummary(w2.w.tenantId, w2.invoiceId)).openCents, (await invoicePaymentSummary(w2.w.tenantId, w2.invoiceId)).status], [80_000, "OPEN"]);
  await assert.rejects(() => recordInvoicePayment(w2.w.tenantId, w2.w.actor, { invoiceId: w2.invoiceId, amount: "900", method: "CASH", paidAt: at }), /Offen sind 800,00/);
  await recordInvoicePayment(w2.w.tenantId, w2.w.actor, { invoiceId: w2.invoiceId, amount: "800", method: "CASH", paidAt: at });
  const f2 = await invoiceFinancials(w2.w.tenantId, w2.invoiceId);
  assert.deepEqual([f2.paymentStatus, f2.openCents, f2.customerCreditCents], ["PAID", 0, 0]);
  // teilbezahlt 500, Gutschrift 700 → Forderung 300, offen 0, Guthaben 200
  const w3 = await invoicedWorld("credit-payments-3");
  await recordInvoicePayment(w3.w.tenantId, w3.w.actor, { invoiceId: w3.invoiceId, amount: "500", method: "CASH", paidAt: at });
  const c3 = await createCreditNoteDraft(w3.w.tenantId, w3.invoiceId, w3.w.actor);
  await updateCounterDocumentDraft(w3.w.tenantId, c3.id, w3.w.actor, { items: [{ sourceItemId: w3.v1.items[0].id, mode: "AMOUNT", grossAmount: "300" }, { sourceItemId: w3.v1.items[1].id, mode: "REMAINING" }], reason: "Teilerlass" });
  const st3 = await getCounterDocumentState(w3.w.tenantId, c3.id);
  assert.deepEqual([st3.paidCents, st3.effectiveAfter, st3.customerCreditAfter], [50_000, 30_000, 20_000], "Vorschau vor dem Abschluss zeigt den Erstattungsbedarf");
  await finalizeCounterDocument(w3.w.tenantId, c3.id, w3.w.actor, { confirmed: true });
  const f3 = await invoiceFinancials(w3.w.tenantId, w3.invoiceId);
  assert.deepEqual([f3.effectiveCents, f3.openCents, f3.customerCreditCents, f3.paymentStatus], [30_000, 0, 20_000, "PAID"]);
  const fa = (await db.auditLog.findFirst({ where: { tenantId: w3.w.tenantId, action: "CREDIT_NOTE_FINALIZED" } }))!.details as Record<string, number>;
  assert.deepEqual([fa.paidCents, fa.effectiveAfter, fa.customerCreditCents], [50_000, 30_000, 20_000]);
});

test("Steuer: Gutschrift spiegelt die Sätze der Rechnung; Schadenabrechnung nicht steuerbar → Gutschrift ohne Steuer; steuerpflichtig → 19 %; PDF, Dokument, E-Mail, Idempotenz", async () => {
  const w = await world("credit-tax");
  const d = await db.damage.findFirstOrThrow({ where: { tenantId: w.tenantId, discoveredInHandoverId: w.returnId } });
  const { damageCase } = await openDamageCase(w.tenantId, d.id, w.actor);
  await setLiability(w.tenantId, damageCase.id, w.actor, "CUSTOMER_RESPONSIBILITY_CONFIRMED", "Mieter hat die Beschädigung eingeräumt");
  const { invoiceId } = await chargeCustomer(w.tenantId, damageCase.id, w.actor, { amount: "1.000,00", basis: "Instandsetzung Heckklappe laut Werkstattrechnung", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" });
  const v1 = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  const caseBefore = JSON.stringify(await db.damageCase.findUniqueOrThrow({ where: { id: damageCase.id } }));
  const draft = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  assert.deepEqual([draft.kind, draft.damageCaseId, draft.taxTreatment], ["DAMAGE", damageCase.id, "NON_TAXABLE_DAMAGE_COMPENSATION"]);
  await assert.rejects(() => updateCounterDocumentDraft(w.tenantId, draft.id, w.actor, { items: [{ manual: true, description: "Kulanz", quantity: "1", unit: "pauschal", unitPrice: "10", taxRate: "19", reason: "Kulanz" }] }).then(() => finalizeCounterDocument(w.tenantId, draft.id, w.actor, { confirmed: true, reason: "x" })), (e: unknown) => isDomain(e), "bei echtem Schadensersatz kein Steuersatz (Satz wird auf 0 gezwungen; 19 kommt nicht vor)");
  await updateCounterDocumentDraft(w.tenantId, draft.id, w.actor, { items: [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: "250" }, { manual: true, description: "Kulanz Selbstbeteiligung", quantity: "1", unit: "pauschal", unitPrice: "50", taxRate: "0", reason: "Kulanz nach Rücksprache" }], reason: "Teil der Reparaturkosten erlassen" });
  const dv = await draftOf(draft.id);
  assert.deepEqual([dv.taxTreatment, dv.items.map((i) => [Number(i.taxRate), toCents(i.taxAmount), toCents(i.grossAmount), i.reference])], ["NON_TAXABLE_DAMAGE_COMPENSATION", [[0, 0, 25_000, null], [0, 0, 5_000, "Kulanz nach Rücksprache"]]]);
  const gv = await finalizeCounterDocument(w.tenantId, draft.id, w.actor, { confirmed: true });
  const { doc } = await loadInvoiceDocumentData(w.tenantId, gv.id);
  assert.deepEqual([doc.documentType, doc.title, doc.nonTaxable, doc.original?.number, doc.reason, doc.paymentDueDate], ["CREDIT_NOTE", "Gutschrift", true, (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).number, "Teil der Reparaturkosten erlassen", null]);
  const pdf = await renderInvoicePdf(doc);
  const text = pdf.trace.texts.join("\n").replace(/\s+/g, " ");
  assert.deepEqual(pdf.trace.boxes.filter((b) => b.overflow), []);
  assert.ok(text.includes("Gutschrift") && text.includes(`Zu Rechnung`) && text.includes(doc.original!.number) && text.includes("Gutschriftbetrag") && text.includes("Grund: Teil der Reparaturkosten erlassen") && text.includes("Guthaben zu Ihren Gunsten ergeben"), text);
  assert.ok(!text.includes("Zahlbar bis") && !/erstattet\b/.test(text) && !text.includes("USt. auf") && !/0,00\s?%/.test(text) && !text.includes("IBAN"), "keine Zahlungsaufforderung, keine Erstattungsbehauptung, kein Steuerausweis, keine Bankdaten");
  const archived = await ensureInvoiceDocument(w.tenantId, gv.id, w.actor.id, { storage });
  assert.deepEqual([archived.document.type, archived.document.fileName, archived.document.invoiceId], ["CREDIT_NOTE", `Gutschrift_${doc.number}.pdf`, draft.id]);
  assert.equal((await ensureInvoiceDocument(w.tenantId, gv.id, w.actor.id, { storage })).created, false, "keine Neuerzeugung");
  const transport = new FakeTransport();
  const sent = await sendInvoiceDocument(w.tenantId, gv.id, { trigger: "MANUAL", nonce: "nonce-credit-1", transport, storage, actorId: w.actor.id });
  assert.equal(sent.status, "SENT");
  assert.deepEqual([sent.log.template, sent.log.invoiceId, sent.log.invoiceVersionId, transport.sent[0].subject, transport.sent[0].attachments?.[0]?.filename], ["CREDIT_NOTE", draft.id, gv.id, `Gutschrift ${doc.number} zu Rechnung ${doc.original!.number}`, `Gutschrift_${doc.number}.pdf`]);
  assert.ok(/Gutschriftbetrag: 300,00/.test(transport.sent[0].text) && transport.sent[0].text.includes("Eine Erstattung ist mit dieser E-Mail nicht verbunden") && !/erstattet\b/.test(transport.sent[0].text));
  const dup = await sendInvoiceDocument(w.tenantId, gv.id, { trigger: "MANUAL", nonce: "nonce-credit-1", transport, storage, actorId: w.actor.id });
  assert.deepEqual([dup.status, transport.sent.length], ["DUPLICATE", 1], "gleiche Bestätigung sendet nicht zweimal");
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "CREDIT_NOTE_SENT" } }), 1);
  assert.equal(JSON.stringify(await db.damageCase.findUniqueOrThrow({ where: { id: damageCase.id } })), caseBefore, "Schadenakte unverändert (Haftung, Belastung, Status)");
  // Automatische Nachbearbeitung wie bei Rechnungen: PDF + Versand nach dem Abschluss (Storno)
  const s = await createCancellationDraft(w.tenantId, invoiceId, w.actor);
  const sv = await finalizeCounterDocument(w.tenantId, s.id, w.actor, { confirmed: true, reason: "Rest storniert" });
  const follow = await runInvoiceFollowUp(w.tenantId, sv.id, w.actor.id, { storage, transport });
  assert.deepEqual([follow.invoiceDocument.ok, follow.email.status, transport.sent[1].subject.startsWith("Stornobeleg ST-")], [true, "SENT", true]);
  const sdoc = await db.document.findFirstOrThrow({ where: { tenantId: w.tenantId, invoiceVersionId: sv.id } });
  assert.deepEqual([sdoc.type, sdoc.fileName.startsWith("Stornobeleg_ST-")], ["CANCELLATION", true]);
  const stext = (await renderInvoicePdf((await loadInvoiceDocumentData(w.tenantId, sv.id)).doc)).trace.texts.join("\n").replace(/\s+/g, " ");
  assert.ok(stext.includes("Stornobeleg") && stext.includes("Stornobetrag") && stext.includes("700,00"), stext);

  // Steuerpflichtiges Entgelt: 19 % gespiegelt; Zahlung + Gutschrift → Guthaben
  const w2 = await world("credit-tax-supply");
  const d2 = await db.damage.findFirstOrThrow({ where: { tenantId: w2.tenantId, discoveredInHandoverId: w2.returnId } });
  const c2 = await openDamageCase(w2.tenantId, d2.id, w2.actor);
  await setLiability(w2.tenantId, c2.damageCase.id, w2.actor, "CUSTOMER_RESPONSIBILITY_CONFIRMED", "eingeräumt");
  const inv2 = (await chargeCustomer(w2.tenantId, c2.damageCase.id, w2.actor, { amount: "1.190,00", basis: "Reparatur laut Werkstattrechnung", taxTreatment: "TAXABLE_SUPPLY" })).invoiceId;
  const v2 = await finalizeInvoice(w2.tenantId, inv2, w2.actor);
  const { version: g2 } = await creditOf(w2.tenantId, inv2, w2.actor, [{ sourceItemId: v2.items[0].id, mode: "AMOUNT", grossAmount: "119" }]);
  assert.deepEqual([g2.taxTreatment, g2.items.map((i) => [Number(i.taxRate), toCents(i.netAmount), toCents(i.taxAmount), toCents(i.grossAmount)])], ["TAXABLE_SUPPLY", [[19, 10_000, 1_900, 11_900]]]);
});

test("Nummernkreise je Mandant: eigene Präfixe, unabhängige Zähler, Jahr, keine Wiederverwendung; Datenbank lehnt doppelte Präfixe ab", async () => {
  const a = await invoicedWorld("credit-numbers-a");
  await db.tenant.update({ where: { id: a.w.tenantId }, data: { numberRanges: { creditNote: { prefix: "GU" }, cancellation: { prefix: "STO" } } } });
  await assert.rejects(() => db.tenant.update({ where: { id: a.w.tenantId }, data: { numberRanges: { creditNote: { prefix: "RE" } } } }), dbRejects(/rb_tenant_number_ranges/), "Gutschrift-Präfix RE kollidiert mit Rechnungen");
  await assert.rejects(() => db.tenant.update({ where: { id: a.w.tenantId }, data: { numberRanges: { creditNote: { prefix: "g1" } } } }), dbRejects(/rb_tenant_number_ranges/));
  const { counter: ga } = await creditOf(a.w.tenantId, a.invoiceId, a.w.actor, [{ sourceItemId: a.v1.items[1].id, mode: "AMOUNT", grossAmount: "100" }]);
  assert.equal(ga.number, `GU-${year}-000001`);
  const b = await invoicedWorld("credit-numbers-b");
  const { counter: gb } = await creditOf(b.w.tenantId, b.invoiceId, b.w.actor, [{ sourceItemId: b.v1.items[1].id, mode: "AMOUNT", grossAmount: "100" }]);
  assert.equal(gb.number, `GS-${year}-000001`, "anderer Mandant zählt für sich");
  // verworfener Entwurf danach: die nächste Nummer folgt der höchsten vergebenen, nichts wird wiederverwendet
  const dx = await createCreditNoteDraft(b.w.tenantId, b.invoiceId, b.w.actor);
  await discardCounterDocumentDraft(b.w.tenantId, dx.id, b.w.actor);
  const { counter: gb2 } = await creditOf(b.w.tenantId, b.invoiceId, b.w.actor, [{ sourceItemId: b.v1.items[1].id, mode: "AMOUNT", grossAmount: "100" }]);
  assert.equal(gb2.number, `GS-${year}-000002`);
  assert.equal(b.number.startsWith(`RE-${year}-`), true, "Rechnungsnummern unverändert im Kreis RE");
  // Nummer nach dem Abschluss fest (DB)
  await assert.rejects(() => db.invoice.update({ where: { id: gb2.id }, data: { number: `GS-${year}-000009` } }), dbRejects(/RB_IMMUTABLE/));
  // Gegenbeleg-Nummern folgen dem Format PREFIX-JJJJ-NNNNNN (CHECK)
  await assert.rejects(() => db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_purge = 'on'`); await tx.invoice.update({ where: { id: gb2.id }, data: { number: "GS-1" } }); }), dbRejects(/rb_invoice_counter_number/));
});

test("Unveränderlichkeit und Integrität (DB): fester Bezug, keine zweite Fassung, keine Berichtigung des Originals nach Gegenbeleg, kein Gegenbeleg auf Gegenbeleg, kein Selbstbezug, Mandantentrennung, Position nur aus Bezugsfassung", async () => {
  const { w, invoiceId, v1 } = await invoicedWorld("credit-immutable");
  const { counter: g, version: gv } = await creditOf(w.tenantId, invoiceId, w.actor, [{ sourceItemId: v1.items[1].id, mode: "AMOUNT", grossAmount: "100" }]);
  await assert.rejects(() => db.invoice.update({ where: { id: g.id }, data: { originalInvoiceId: null } }), dbRejects(/RB_IMMUTABLE|rb_invoice_counter_refs/));
  await assert.rejects(() => db.invoice.update({ where: { id: g.id }, data: { originalSnapshot: { number: "X" } } }), dbRejects(/RB_IMMUTABLE/));
  await assert.rejects(() => db.invoice.delete({ where: { id: g.id } }), dbRejects(/RB_IMMUTABLE/));
  await assert.rejects(() => db.invoiceVersion.update({ where: { id: gv.id }, data: { grossTotal: "1.00" } }), dbRejects(/RB_IMMUTABLE/));
  await assert.rejects(() => db.invoiceVersionItem.update({ where: { id: gv.items[0].id }, data: { grossAmount: "1.00" } }), dbRejects(/RB_IMMUTABLE/));
  await assert.rejects(() => db.invoiceVersion.create({ data: { tenantId: w.tenantId, invoiceId: g.id, versionNo: 2, kind: "REVISION", servicePeriodStart: at, servicePeriodEnd: at, pricesIncludeTax: true, customerSnapshot: {}, companySnapshot: {} } }), dbRejects(/genau eine Fassung/));
  // Original: keine Fassung 2 mehr (Code und DB)
  const mode = await invoiceEditMode(w.tenantId, invoiceId);
  assert.deepEqual([mode.editable, mode.counterFinalized], [false, 1]);
  await assert.rejects(() => startInvoiceEdit(w.tenantId, invoiceId, w.actor), /nicht mehr berichtigt/);
  await assert.rejects(() => db.invoiceVersion.create({ data: { tenantId: w.tenantId, invoiceId, versionNo: 2, kind: "REVISION", servicePeriodStart: at, servicePeriodEnd: at, pricesIncludeTax: true, customerSnapshot: {}, companySnapshot: {} } }), dbRejects(/nicht mehr berichtigt/));
  // Gegenbeleg auf Gegenbeleg, Selbstbezug, fremder Mandant
  await assert.rejects(() => createCreditNoteDraft(w.tenantId, g.id, w.actor), /nie auf eine Gutschrift/);
  const base = { tenantId: w.tenantId, bookingId: w.bookingId, kind: "RENTAL", documentType: "CREDIT_NOTE", originalSnapshot: {} };
  await assert.rejects(() => db.invoice.create({ data: { ...base, originalInvoiceId: g.id, originalVersionId: gv.id } }), dbRejects(/nie auf eine Gutschrift/));
  await assert.rejects(() => db.invoice.create({ data: { ...base, id: "self-ref-test", originalInvoiceId: "self-ref-test", originalVersionId: v1.id } }), dbRejects(/rb_invoice_no_self_reference|RB_DOMAIN/));
  await assert.rejects(() => db.invoice.create({ data: { ...base, documentType: "INVOICE", originalInvoiceId: invoiceId, originalVersionId: v1.id } }), dbRejects(/rb_invoice_counter_refs/));
  const other = await invoicedWorld("credit-immutable-other");
  await assert.rejects(() => createCreditNoteDraft(other.w.tenantId, invoiceId, other.w.actor), /nicht gefunden/);
  await assert.rejects(() => db.invoice.create({ data: { ...base, tenantId: other.w.tenantId, bookingId: other.w.bookingId, originalInvoiceId: invoiceId, originalVersionId: v1.id } }), dbRejects(/RB_TENANT/));
  // Entwurf: Bezug auf eine Position einer anderen Rechnung wird abgelehnt (Code und DB)
  const d = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  await assert.rejects(() => updateCounterDocumentDraft(w.tenantId, d.id, w.actor, { items: [{ sourceItemId: other.v1.items[0].id, mode: "REMAINING" }] }), /gehört nicht zur Bezugsfassung/);
  const dv = await draftOf(d.id);
  await assert.rejects(() => db.invoiceVersionItem.update({ where: { id: dv.items[0].id }, data: { sourceInvoiceVersionItemId: other.v1.items[0].id } }), dbRejects(/RB_TENANT|RB_DOMAIN/));
  await assert.rejects(() => db.invoiceVersionItem.update({ where: { id: v1.items[0].id }, data: { sourceInvoiceVersionItemId: v1.items[1].id } }), dbRejects(/RB_IMMUTABLE/), "Positionen der Rechnung bleiben gesperrt");
  // Über den Rest hinaus direkt in der DB: Entwurf mit 950 € und Abschluss → Trigger
  await updateCounterDocumentDraft(w.tenantId, d.id, w.actor, { items: [{ sourceItemId: v1.items[0].id, mode: "REMAINING" }, { sourceItemId: v1.items[1].id, mode: "AMOUNT", grossAmount: "300" }], reason: "Test über den Rest" });
  const dv2 = await draftOf(d.id);
  await db.invoiceVersionItem.update({ where: { id: dv2.items[1].id }, data: { grossAmount: "310.00", netAmount: "310.00" } });
  await db.invoiceVersion.update({ where: { id: dv2.id }, data: { grossTotal: "910.00", netTotal: "814.20" } });
  await assert.rejects(() => finalizeCounterDocument(w.tenantId, d.id, w.actor, { confirmed: true }), /übersteigt/);
  await assert.rejects(() => db.$transaction(async (tx) => {
    await tx.invoiceVersion.update({ where: { id: dv2.id }, data: { status: "FINALIZED", finalizedAt: new Date(), contentHash: "manipuliert", issueDate: new Date() } });
    await tx.invoice.update({ where: { id: d.id }, data: { status: "FINALIZED", number: `GS-${year}-000777`, currentVersionId: dv2.id } });
  }), dbRejects(/RB_DOMAIN: .*(übersteigt|über ihren Betrag hinaus)/), "Datenbank blockiert die Überschreitung");
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d.id } })).status, "DRAFT");
  // Exportmarke des Originals: Gutschrift weiterhin möglich, eigene Exportmarke leer, Original bleibt gesperrt
  await db.invoice.update({ where: { id: invoiceId }, data: { exportedAt: new Date(), exportBatchId: "TEST" } });
  await discardCounterDocumentDraft(w.tenantId, d.id, w.actor);
  const { counter: g2 } = await creditOf(w.tenantId, invoiceId, w.actor, [{ sourceItemId: v1.items[1].id, mode: "AMOUNT", grossAmount: "50" }]);
  assert.deepEqual([g2.exportedAt, (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).exportBatchId], [null, "TEST"]);
  assert.ok(isImmutableError(await db.invoice.update({ where: { id: invoiceId }, data: { exportedAt: null } }).catch((e) => e)));
});

test("Race Conditions: zwei Teilgutschriften parallel (beide, Nummern eindeutig), zwei volle parallel (eine), Gutschrift+Storno, zwei Stornos, Doppelklick-Abschluss idempotent, Gutschrift+Zahlung konsistent", async () => {
  const make = async (label: string) => {
    const x = await invoicedWorld(label);
    const d1 = await createCreditNoteDraft(x.w.tenantId, x.invoiceId, x.w.actor);
    await updateCounterDocumentDraft(x.w.tenantId, d1.id, x.w.actor, { items: [{ sourceItemId: x.v1.items[0].id, mode: "REMAINING" }], reason: "Anteil A" });
    // Ein zweiter Entwurf entsteht hier direkt in der Datenbank (im Code gilt: ein offener Gegenbeleg-Entwurf je Rechnung), damit
    // zwei Abschlüsse wirklich gleichzeitig gegen Sperre und Trigger laufen.
    return { ...x, d1 };
  };
  // zwei Teilgutschriften (600 + 400) parallel → beide, unterschiedliche Nummern, Summe exakt 1.000
  const a = await make("race-partial");
  const d2 = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_purge = 'on'`);
    const c = await tx.invoice.findUniqueOrThrow({ where: { id: a.d1.id } });
    const inv = await tx.invoice.create({ data: { tenantId: c.tenantId, bookingId: c.bookingId, customerId: c.customerId, contractId: c.contractId, kind: c.kind, documentType: "CREDIT_NOTE", originalInvoiceId: c.originalInvoiceId, originalVersionId: c.originalVersionId, originalSnapshot: c.originalSnapshot!, status: "DRAFT" } });
    const dv = await tx.invoiceVersion.findFirstOrThrow({ where: { invoiceId: a.d1.id } });
    const v = await tx.invoiceVersion.create({ data: { tenantId: c.tenantId, invoiceId: inv.id, versionNo: 1, kind: "ORIGINAL", servicePeriodStart: dv.servicePeriodStart, servicePeriodEnd: dv.servicePeriodEnd, pricesIncludeTax: dv.pricesIncludeTax, customerSnapshot: dv.customerSnapshot!, companySnapshot: dv.companySnapshot!, taxNote: dv.taxNote, reason: "Anteil B", netTotal: "400.00", taxTotal: "0.00", grossTotal: "400.00" } });
    await tx.invoiceVersionItem.create({ data: { tenantId: c.tenantId, versionId: v.id, sortOrder: 0, description: "Position 2", quantity: "1.00", unit: "pauschal", unitPrice: "400.00", netAmount: "400.00", taxRate: "0.00", taxAmount: "0.00", grossAmount: "400.00", source: "MANUAL", sourceInvoiceVersionItemId: a.v1.items[1].id } });
    return inv;
  });
  const r = await Promise.allSettled([finalizeCounterDocument(a.w.tenantId, a.d1.id, a.w.actor, { confirmed: true }), finalizeCounterDocument(a.w.tenantId, d2.id, a.w.actor, { confirmed: true })]);
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "fulfilled"], JSON.stringify(r.map((x) => (x.status === "rejected" ? String(x.reason) : "ok"))));
  const nums = (await db.invoice.findMany({ where: { id: { in: [a.d1.id, d2.id] } }, select: { number: true } })).map((x) => x.number).sort();
  assert.deepEqual(nums, [`GS-${year}-000001`, `GS-${year}-000002`]);
  assert.deepEqual([(await invoiceFinancials(a.w.tenantId, a.invoiceId)).creditedCents, (await invoiceFinancials(a.w.tenantId, a.invoiceId)).chain], [100_000, "CREDITED"]);

  // zwei volle Gutschriften parallel → genau eine
  const b = await invoicedWorld("race-full");
  const mk = async (x: typeof b, gross: string, type: "CREDIT_NOTE" | "CANCELLATION") => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_purge = 'on'`);
    const cur = await tx.invoiceVersion.findUniqueOrThrow({ where: { id: x.v1.id } });
    const inv = await tx.invoice.create({ data: { tenantId: x.w.tenantId, bookingId: x.w.bookingId, customerId: x.original.customerId, contractId: x.original.contractId, kind: "RENTAL", documentType: type, originalInvoiceId: x.invoiceId, originalVersionId: x.v1.id, originalSnapshot: { number: x.number, versionNo: 1, grossTotal: "1000.00", customerName: "Erika Muster", invoiceId: x.invoiceId, versionId: x.v1.id, issueDate: null, servicePeriodStart: cur.servicePeriodStart.toISOString(), servicePeriodEnd: cur.servicePeriodEnd.toISOString(), kind: "RENTAL", taxTreatment: null }, status: "DRAFT" } });
    const v = await tx.invoiceVersion.create({ data: { tenantId: x.w.tenantId, invoiceId: inv.id, versionNo: 1, kind: "ORIGINAL", servicePeriodStart: cur.servicePeriodStart, servicePeriodEnd: cur.servicePeriodEnd, pricesIncludeTax: cur.pricesIncludeTax, customerSnapshot: cur.customerSnapshot!, companySnapshot: cur.companySnapshot!, taxNote: cur.taxNote, reason: "parallel", netTotal: gross === "1000.00" ? "904.20" : gross, taxTotal: gross === "1000.00" ? "95.80" : "0.00", grossTotal: gross } });
    if (gross === "1000.00") {
      await tx.invoiceVersionItem.createMany({ data: [
        { tenantId: x.w.tenantId, versionId: v.id, sortOrder: 0, description: "P1", quantity: "1.00", unit: "pauschal", unitPrice: "600.00", netAmount: "504.20", taxRate: "19.00", taxAmount: "95.80", grossAmount: "600.00", source: "MANUAL", sourceInvoiceVersionItemId: x.v1.items[0].id },
        { tenantId: x.w.tenantId, versionId: v.id, sortOrder: 1, description: "P2", quantity: "1.00", unit: "pauschal", unitPrice: "400.00", netAmount: "400.00", taxRate: "0.00", taxAmount: "0.00", grossAmount: "400.00", source: "MANUAL", sourceInvoiceVersionItemId: x.v1.items[1].id },
      ] });
    } else {
      await tx.invoiceVersionItem.create({ data: { tenantId: x.w.tenantId, versionId: v.id, sortOrder: 0, description: "P2", quantity: "1.00", unit: "pauschal", unitPrice: gross, netAmount: gross, taxRate: "0.00", taxAmount: "0.00", grossAmount: gross, source: "MANUAL", sourceInvoiceVersionItemId: x.v1.items[1].id } });
    }
    return inv;
  });
  const [f1, f2] = await Promise.all([mk(b, "1000.00", "CREDIT_NOTE"), mk(b, "1000.00", "CREDIT_NOTE")]);
  const rb = await Promise.allSettled([finalizeCounterDocument(b.w.tenantId, f1.id, b.w.actor, { confirmed: true }), finalizeCounterDocument(b.w.tenantId, f2.id, b.w.actor, { confirmed: true })]);
  assert.deepEqual(rb.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.ok(rb.some((x) => x.status === "rejected" && isDomain(x.reason)));
  assert.equal((await invoiceFinancials(b.w.tenantId, b.invoiceId)).creditedCents, 100_000);

  // Gutschrift (400) + Storno parallel → genau einer; zwei Stornos parallel → genau einer
  const c = await invoicedWorld("race-credit-storno");
  const [c1, s1] = await Promise.all([mk(c, "400.00", "CREDIT_NOTE"), mk(c, "1000.00", "CANCELLATION")]);
  const rc = await Promise.allSettled([finalizeCounterDocument(c.w.tenantId, c1.id, c.w.actor, { confirmed: true }), finalizeCounterDocument(c.w.tenantId, s1.id, c.w.actor, { confirmed: true })]);
  assert.deepEqual(rc.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  const fc = await invoiceFinancials(c.w.tenantId, c.invoiceId);
  assert.ok((fc.chain === "CANCELLED" && fc.cancelledCents === 100_000 && fc.creditedCents === 0) || (fc.chain === "PARTIALLY_CREDITED" && fc.creditedCents === 40_000), JSON.stringify(fc));
  const d = await invoicedWorld("race-two-stornos");
  const [s2, s3] = await Promise.all([mk(d, "1000.00", "CANCELLATION"), mk(d, "1000.00", "CANCELLATION")]);
  const rd = await Promise.allSettled([finalizeCounterDocument(d.w.tenantId, s2.id, d.w.actor, { confirmed: true }), finalizeCounterDocument(d.w.tenantId, s3.id, d.w.actor, { confirmed: true })]);
  assert.deepEqual(rd.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(await db.invoice.count({ where: { originalInvoiceId: d.invoiceId, documentType: "CANCELLATION", status: "FINALIZED" } }), 1);

  // Doppelklick auf „finalisieren“: derselbe Entwurf zweimal parallel → ein Beleg, eine Nummer
  const e = await invoicedWorld("race-doubleclick");
  const de = await createCreditNoteDraft(e.w.tenantId, e.invoiceId, e.w.actor);
  await updateCounterDocumentDraft(e.w.tenantId, de.id, e.w.actor, { reason: "Doppelklick" });
  const re = await Promise.allSettled([finalizeCounterDocument(e.w.tenantId, de.id, e.w.actor, { confirmed: true }), finalizeCounterDocument(e.w.tenantId, de.id, e.w.actor, { confirmed: true })]);
  assert.deepEqual(re.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(await db.invoice.count({ where: { tenantId: e.w.tenantId, documentType: "CREDIT_NOTE" } }), 1);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: de.id } })).number, `GS-${year}-000001`);

  // Gutschrift 800 + Zahlung 500 parallel: serialisiert; Ergebnis in jedem Fall konsistent
  const g = await invoicedWorld("race-credit-payment");
  const dg = await createCreditNoteDraft(g.w.tenantId, g.invoiceId, g.w.actor);
  await updateCounterDocumentDraft(g.w.tenantId, dg.id, g.w.actor, { items: [{ sourceItemId: g.v1.items[0].id, mode: "REMAINING" }, { sourceItemId: g.v1.items[1].id, mode: "AMOUNT", grossAmount: "200" }], reason: "parallel zur Zahlung" });
  const rg = await Promise.allSettled([finalizeCounterDocument(g.w.tenantId, dg.id, g.w.actor, { confirmed: true }), recordInvoicePayment(g.w.tenantId, g.w.actor, { invoiceId: g.invoiceId, amount: "500", method: "CASH", paidAt: at })]);
  assert.equal(rg[0].status, "fulfilled", String((rg[0] as PromiseRejectedResult).reason));
  const fg = await invoiceFinancials(g.w.tenantId, g.invoiceId);
  assert.equal(fg.effectiveCents, 20_000);
  if (rg[1].status === "fulfilled") assert.deepEqual([fg.paidCents, fg.openCents, fg.customerCreditCents], [50_000, 0, 30_000], "Zahlung vor der Gutschrift: Guthaben 300");
  else { assert.ok(isDomain(rg[1].reason)); assert.deepEqual([fg.paidCents, fg.openCents], [0, 20_000], "Gutschrift zuerst: Zahlung über 500 abgelehnt"); }
});

test("Keine Nebenwirkungen: Kaution, Schadenakte, Buchung, Vertrag, Rückgabe, Zusatzkosten und Zahlungen unverändert; Original nach Storno lesbar; Entwurf der Rechnung nicht betroffen", async () => {
  const { w, invoiceId, v1 } = await invoicedWorld("credit-side-effects");
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "300", method: "CASH", paidAt: at });
  const state = async () => JSON.stringify({
    deposits: await db.securityDeposit.findMany({ where: { tenantId: w.tenantId } }),
    depositEvents: await db.securityDepositEvent.findMany({ where: { tenantId: w.tenantId } }),
    booking: await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } }),
    contract: await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } }),
    returns: await db.handover.findMany({ where: { tenantId: w.tenantId } }),
    charges: await db.extraCharge.findMany({ where: { tenantId: w.tenantId } }),
    payments: await db.payment.findMany({ where: { tenantId: w.tenantId } }),
    cases: await db.damageCase.findMany({ where: { tenantId: w.tenantId } }),
    invoiceVersions: await db.invoiceVersion.findMany({ where: { invoiceId }, include: { items: true } }),
  });
  const before = await state();
  await creditOf(w.tenantId, invoiceId, w.actor, [{ sourceItemId: v1.items[1].id, mode: "AMOUNT", grossAmount: "150" }]);
  const s = await createCancellationDraft(w.tenantId, invoiceId, w.actor);
  await finalizeCounterDocument(w.tenantId, s.id, w.actor, { confirmed: true, reason: "Storno" });
  assert.equal(await state(), before);
  const f = await invoiceFinancials(w.tenantId, invoiceId);
  assert.deepEqual([f.effectiveCents, f.paidCents, f.customerCreditCents, f.openCents], [0, 30_000, 30_000, 0], "nach Storno: Zahlung 300 bleibt, Guthaben 300, offen 0");
  const { doc } = await loadInvoiceDocumentData(w.tenantId, v1.id);
  assert.deepEqual([doc.title, doc.documentType, doc.number.startsWith("RE-")], ["Rechnung", "INVOICE", true], "Original weiterhin als Rechnung lesbar");
  // Rechnung ohne Gegenbelege: Bearbeiten/Verwerfen wie bisher, Entwurf-Verwerfen der Mietrechnung weiter möglich
  const w2 = await world("credit-side-effects-2");
  const inv2 = await ensureInvoiceDraft(w2.tenantId, w2.bookingId, w2.actor);
  assert.equal((await discardInvoiceDraft(w2.tenantId, inv2.id, w2.actor)).invoiceDeleted, true);
  // Gegenbeleg-Entwurf verwerfen über die allgemeine Funktion: löscht nur den Gegenbeleg, nie die Schadenakte-Belastung
  const w3 = await invoicedWorld("credit-side-effects-3");
  const c3 = await createCreditNoteDraft(w3.w.tenantId, w3.invoiceId, w3.w.actor);
  assert.equal((await discardInvoiceDraft(w3.w.tenantId, c3.id, w3.w.actor)).invoiceDeleted, true);
  assert.equal(await db.invoice.count({ where: { id: w3.invoiceId } }), 1);
  void cancellationLines;
});

test("Bezugsfassung: Berichtigung vor der Gutschrift → Gutschrift bezieht sich auf die aktuelle Fassung; veralteter Entwurf wird beim Abschluss abgewiesen", async () => {
  const { w, invoiceId, v1 } = await invoicedWorld("credit-version");
  const d = await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  await assert.rejects(() => createCreditNoteDraft(w.tenantId, invoiceId, w.actor), /noch ein Entwurf der Fassung 2 offen/);
  await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, { items: d.items.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: i.sortOrder === 0 ? "500" : String(i.unitPrice), taxRate: String(i.taxRate) })) });
  const v2 = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  assert.equal(toCents(v2.grossTotal), 90_000);
  const c = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  assert.equal(c.originalVersionId, v2.id, "Bezug auf Fassung 2");
  assert.equal(toCents((await draftOf(c.id)).grossTotal), 90_000);
  const st = await getCounterDocumentState(w.tenantId, c.id);
  assert.deepEqual([st.original.stale, st.original.currentVersionNo, st.original.snapshot.versionNo], [false, 2, 2]);
  // veralteter Bezug simuliert: Bezugsfassung zeigt auf Fassung 1
  await db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_purge = 'on'`); await tx.invoice.update({ where: { id: c.id }, data: { originalVersionId: v1.id } }); });
  assert.equal((await getCounterDocumentState(w.tenantId, c.id)).original.stale, true);
  await assert.rejects(() => finalizeCounterDocument(w.tenantId, c.id, w.actor, { confirmed: true, reason: "veraltet" }), /neuere Fassung/);
  await db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_purge = 'on'`); await tx.invoice.update({ where: { id: c.id }, data: { originalVersionId: v2.id } }); });
  const gv = await finalizeCounterDocument(w.tenantId, c.id, w.actor, { confirmed: true, reason: "voll" });
  assert.equal(toCents(gv.grossTotal), 90_000);
  assert.equal((await invoiceFinancials(w.tenantId, invoiceId)).chain, "CREDITED");
});
