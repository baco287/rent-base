// Rechnungsfassungen: Migration bestehender Rechnungen, „Rechnung bearbeiten“ (REVISION/CORRECTION), Snapshot-Verhalten,
// Zahlungen und Überzahlung, Versand je Fassung, Übergabemarkierung, Export-Sperre, DB-Integrität, Race Conditions, PDF.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { ensureInvoiceDocument, readDocumentFile } from "../src/lib/documents";
import { runInvoiceFollowUp } from "../src/lib/followup";
import { isImmutableError, sha256 } from "../src/lib/integrity";
import { discardInvoiceDraft, ensureInvoiceDraft, finalizeInvoice, getInvoiceState, invoiceEditMode, listVersions, markVersionDelivered, startInvoiceEdit, updateInvoiceDraft, verifyInvoice, verifyVersion, type ItemInput } from "../src/lib/invoices";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { cancelPayment, invoicePaymentSummary, recordInvoicePayment } from "../src/lib/payments";
import { renderInvoicePdf } from "../src/lib/pdf/invoice-pdf";
import { sendInvoiceDocument } from "../src/lib/rental-mail";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-invver-"));
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

const world = async (label: string, opts: Parameters<typeof returnedWorld>[1] = {}) => {
  await ready;
  const w = await returnedWorld(label, opts);
  tenants.push(w.tenantId);
  return w;
};
const draftOf = (invoiceId: string) => db.invoiceVersion.findFirstOrThrow({ where: { invoiceId, status: "DRAFT" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
const currentOf = async (invoiceId: string) => {
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  return db.invoiceVersion.findUniqueOrThrow({ where: { id: inv.currentVersionId! }, include: { items: { orderBy: { sortOrder: "asc" } } } });
};
const editable = (items: { id: string; description: string; quantity: unknown; unit: string; unitPrice: unknown; taxRate: unknown }[]): ItemInput[] => items.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: String(i.unitPrice), taxRate: String(i.taxRate) }));
/** Abgeschlossene Rechnung, deren aktuelle Fassung genau `gross` Euro brutto beträgt (eine Pauschalposition). */
async function invoicedWorld(label: string, gross = 1000) {
  const w = await world(label);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const d = await draftOf(inv.id);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: d.items[0].id, description: d.items[0].description, quantity: "1", unit: "pauschal", unitPrice: String(gross), taxRate: "19" }] });
  const v1 = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  return { w, invoiceId: inv.id, v1 };
}
/** Neue Fassung mit geändertem Bruttobetrag abschließen. */
async function refinalize(tenantId: string, invoiceId: string, actor: { id: string; name: string }, gross: number, opts: { reason?: string; confirmOverpayment?: boolean } = {}) {
  const d = await startInvoiceEdit(tenantId, invoiceId, actor);
  await updateInvoiceDraft(tenantId, invoiceId, actor, { items: [{ id: d.items[0].id, description: d.items[0].description, quantity: "1", unit: "pauschal", unitPrice: String(gross), taxRate: "19" }], reason: opts.reason });
  return finalizeInvoice(tenantId, invoiceId, actor, { confirmOverpayment: opts.confirmOverpayment });
}

test("Migration: Rechnung im Schema vor den Fassungen wird zu Fassung 1 – Positionen, Beträge, Prüfsumme, PDF, E-Mail-Historie, Zahlungen bleiben", async () => {
  const w = await world("ver-migrate");
  // Rechnung in der alten Form anlegen (Daten direkt auf Invoice/InvoiceItem, wie vor Phase 10)
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } });
  const contract = await db.rentalContract.findFirstOrThrow({ where: { bookingId: w.bookingId } });
  const snapshotC = { number: "K-00001", type: "PRIVATE", companyName: null, firstName: "Erika", lastName: "Muster", street: "Weg 1", zip: "28195", city: "Bremen", country: "DE", email: "erika@example.test" };
  const snapshotF = { name: tenant.name, legalForm: "GmbH", street: "Hafenstr. 1", zip: "28195", city: "Bremen", country: "DE", email: null, phone: null, vatId: null, taxNumber: "60/123/45678", bankName: null, iban: null, bic: null, invoiceFooter: null };
  const legacy = await db.invoice.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, customerId: w.customerId, contractId: contract.id, returnHandoverId: w.returnId, servicePeriodStart: at, servicePeriodEnd: new Date(), pricesIncludeTax: true, customerSnapshot: snapshotC, companySnapshot: snapshotF, netTotal: "403.36", taxTotal: "76.64", grossTotal: "480.00", paymentTermDays: 14, paymentDueDate: new Date(), issueDate: at, customerNote: "Danke", changeLog: [{ at: at.toISOString(), by: "Alt", summary: "Altbestand" }] } });
  await db.invoiceItem.createMany({ data: [
    { tenantId: w.tenantId, invoiceId: legacy.id, sortOrder: 0, description: "Fahrzeugmiete (Altbestand)", quantity: 1, unit: "pauschal", unitPrice: "450.00", netAmount: "378.15", taxRate: 19, taxAmount: "71.85", grossAmount: "450.00", source: "RENTAL" },
    { tenantId: w.tenantId, invoiceId: legacy.id, sortOrder: 1, description: "Reinigung", quantity: 1, unit: "pauschal", unitPrice: "30.00", netAmount: "25.21", taxRate: 19, taxAmount: "4.79", grossAmount: "30.00", source: "MANUAL" },
  ] });
  const hash = sha256("altbestand-pruefsumme");
  await db.invoice.update({ where: { id: legacy.id }, data: { status: "FINALIZED", number: "RE-2025-000077", finalizedAt: at, contentHash: hash } });
  const pdfBytes = Buffer.from("%PDF-1.4 altbestand");
  const key = `t/${w.tenantId}/documents/legacy-${legacy.id}.pdf`;
  await storage.put(key, pdfBytes, "application/pdf");
  const doc = await db.document.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, invoiceId: legacy.id, type: "INVOICE", storageKey: key, fileName: "Rechnung_RE-2025-000077.pdf", sizeBytes: pdfBytes.length, checksum: sha256(pdfBytes), sourceHash: hash } });
  const mail = await db.emailLog.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, invoiceId: legacy.id, recipient: "erika@example.test", subject: "Ihre Rechnung RE-2025-000077", template: "INVOICE", status: "SENT", sentAt: at, idempotencyKey: `legacy-${legacy.id}`, attachments: [{ documentId: doc.id, fileName: doc.fileName, checksum: doc.checksum }] } });
  const pay = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: legacy.id, amount: "100", method: "CASH", paidAt: at });
  const before = await invoicePaymentSummary(w.tenantId, legacy.id);
  assert.deepEqual([before.grossCents, before.paidCents, before.status], [48_000, 10_000, "PARTIAL"]);

  // Backfill-Block der Migration unverändert ausführen (idempotent; bereits migrierte Rechnungen bleiben unberührt)
  const sql = await readFile(path.join(process.cwd(), "prisma/migrations/20260924090000_rechnungsfassungen/migration.sql"), "utf8");
  const block = sql.split("-- BACKFILL START")[1].split("-- BACKFILL END")[0];
  const statements = block.split(/;\s*\n/).map((x) => x.replace(/^\s*--[^\n]*\n/gm, "").trim()).filter(Boolean);
  const versionsBefore = await db.invoiceVersion.count();
  await db.$transaction(async (tx) => { for (const st of statements) await tx.$executeRawUnsafe(st); }, { timeout: 60_000 });

  const v1 = await db.invoiceVersion.findUniqueOrThrow({ where: { id: `${legacy.id}_v1` }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  assert.deepEqual([v1.versionNo, v1.kind, v1.status, v1.contentHash, String(v1.grossTotal), String(v1.netTotal), v1.paymentTermDays, v1.customerNote], [1, "ORIGINAL", "FINALIZED", hash, "480", "403.36", 14, "Danke"]);
  assert.deepEqual(v1.items.map((i) => [i.description, String(i.grossAmount), i.source]), [["Fahrzeugmiete (Altbestand)", "450", "RENTAL"], ["Reinigung", "30", "MANUAL"]]);
  assert.deepEqual(v1.customerSnapshot, snapshotC);
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.deepEqual([inv.currentVersionId, inv.number, inv.status], [v1.id, "RE-2025-000077", "FINALIZED"]);
  assert.equal(await db.invoiceItem.count({ where: { invoiceId: legacy.id } }), 2, "Altbestand bleibt erhalten");
  assert.equal((await db.document.findUniqueOrThrow({ where: { id: doc.id } })).invoiceVersionId, v1.id);
  assert.equal((await db.emailLog.findUniqueOrThrow({ where: { id: mail.id } })).invoiceVersionId, v1.id);
  const file = await readDocumentFile(w.tenantId, doc.id, storage);
  assert.equal(Buffer.from(file!.body).toString(), "%PDF-1.4 altbestand", "bestehendes PDF unverändert abrufbar");
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: pay.payment.id } })).amountCents, 10_000);
  const after = await invoicePaymentSummary(w.tenantId, legacy.id);
  assert.deepEqual(after, before, "Zahlungsstatus identisch");
  assert.equal((await verifyVersion(w.tenantId, v1.id)).intact, false, "eine fremde Prüfsumme bleibt fremd (Hash aus dem Altbestand ist nur dann intakt, wenn er dort echt war)");
  // idempotent
  await db.$transaction(async (tx) => { for (const st of statements) await tx.$executeRawUnsafe(st); }, { timeout: 60_000 });
  assert.equal(await db.invoiceVersion.count(), versionsBefore + 1);
  // Migrierte Rechnung ist bearbeitbar wie jede andere
  const d2 = await startInvoiceEdit(w.tenantId, legacy.id, w.actor);
  assert.deepEqual([d2.versionNo, d2.kind, d2.items.length, String(d2.grossTotal)], [2, "CORRECTION", 2, "480"], "E-Mail SENT im Altbestand zählt als übermittelt");
  await discardInvoiceDraft(w.tenantId, legacy.id, w.actor);
});

test("Bearbeiten (nicht übermittelt): Entwurf aus Fassung 1, Snapshot statt Stammdaten, Fassung 2 = REVISION, Fassung 1 bleibt, Differenz, PDF je Fassung, Audit", async () => {
  const { w, invoiceId, v1 } = await invoicedWorld("ver-revision", 1000);
  const inv0 = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  assert.equal((await verifyVersion(w.tenantId, v1.id)).intact, true);
  const doc1 = await ensureInvoiceDocument(w.tenantId, v1.id, w.userId, { storage });
  assert.equal(doc1.document.fileName, `Rechnung_${inv0.number}_Fassung1.pdf`);
  // ein Download ist keine Übermittlung
  await readDocumentFile(w.tenantId, doc1.document.id, storage);
  assert.equal((await invoiceEditMode(w.tenantId, invoiceId)).mode, "A");

  // Stammdaten ändern sich nach Fassung 1: Kunde, Mandant, Buchung, Fahrzeug, Vertrag, Zusatzkosten(-quelle), Steuereinstellungen
  await db.customer.update({ where: { id: w.customerId }, data: { lastName: "Anders", street: "Neuer Weg 99", email: "anders@example.test" } });
  await db.tenant.update({ where: { id: w.tenantId }, data: { name: "Umfirmiert GmbH", iban: "DE99999999999999999999", defaultTaxRate: 7, pricesIncludeTax: false, paymentTermDays: 30 } });
  await db.booking.update({ where: { id: w.bookingId }, data: { deposit: 9999 } });
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { dailyRate: 999 } });

  const draft = await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  assert.deepEqual([draft.versionNo, draft.kind, draft.status, draft.supersedesVersionId, draft.pricesIncludeTax, draft.paymentTermDays, String(draft.grossTotal)], [2, "REVISION", "DRAFT", v1.id, true, 14, "1000"]);
  assert.deepEqual(draft.customerSnapshot, v1.customerSnapshot, "Empfänger aus Fassung 1, nicht aus dem geänderten Kunden");
  assert.deepEqual(draft.companySnapshot, v1.companySnapshot, "Rechnungssteller aus Fassung 1, nicht aus den geänderten Einstellungen");
  assert.deepEqual(draft.items.map((i) => [i.description, String(i.unitPrice), String(i.taxRate)]), v1.items.map((i) => [i.description, String(i.unitPrice), String(i.taxRate)]));
  assert.equal((await startInvoiceEdit(w.tenantId, invoiceId, w.actor)).id, draft.id, "zweiter Klick liefert denselben Entwurf");
  const state = await getInvoiceState(w.tenantId, invoiceId);
  assert.deepEqual([state.draft?.id, state.current?.id, state.mode?.mode, state.issues], [draft.id, v1.id, "A", []]);

  // bewusst korrigieren: Anschrift, Leistungszeitraum, Position, Zahlungsziel, Firmendaten
  const end = new Date(draft.servicePeriodEnd.getTime() + 3600_000);
  await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, {
    items: [...editable(draft.items).map((i) => ({ ...i, description: "Fahrzeugmiete korrigiert", unitPrice: "800" })), { description: "Kindersitz", quantity: "2", unit: "Tag", unitPrice: "5", taxRate: "19" }],
    customer: { street: "Weg 1a", email: "erika.neu@example.test" }, company: { iban: "DE02120300000000202051" }, servicePeriodEnd: end, paymentTermDays: 7, reason: "Hausnummer und Mietpreis korrigiert",
  });
  const v2 = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  assert.deepEqual([v2.versionNo, v2.kind, v2.status, String(v2.grossTotal), v2.paymentTermDays, !!v2.correctionDate, v2.issueDate?.getTime()], [2, "REVISION", "FINALIZED", "810", 7, true, v1.issueDate!.getTime()]);
  assert.ok(v2.contentHash && v2.contentHash !== v1.contentHash);
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  assert.deepEqual([inv.currentVersionId, inv.number, inv.status], [v2.id, inv0.number, "FINALIZED"], "Nummer bleibt, Zeiger wandert");
  const v1after = await db.invoiceVersion.findUniqueOrThrow({ where: { id: v1.id }, include: { items: true } });
  assert.deepEqual([v1after.status, v1after.contentHash, String(v1after.grossTotal), v1after.items.length], ["FINALIZED", v1.contentHash, "1000", 1], "Fassung 1 unverändert");
  assert.equal((await verifyVersion(w.tenantId, v1.id)).intact, true);
  assert.equal((await verifyInvoice(w.tenantId, invoiceId)).intact, true);
  const diff = v2.diffFromPrevious as { entries: { field: string; before: string | null; after: string | null }[]; grossBefore: string; grossAfter: string };
  const fields = diff.entries.map((e) => e.field);
  for (const f of ["customer.address", "customer.email", "company.bank", "servicePeriod", "paymentTermDays", "item.1", "item.2", "netTotal", "taxTotal", "grossTotal"]) assert.ok(fields.includes(f), `Differenz enthält ${f}`);
  assert.equal(diff.entries.find((e) => e.field === "customer.address")?.after, "Weg 1a, 28195 Bremen");
  const versions = await listVersions(w.tenantId, invoiceId);
  assert.deepEqual(versions.map((v) => [v.versionNo, v.status, v.delivered]), [[1, "FINALIZED", false], [2, "FINALIZED", false]]);

  // PDF je Fassung, alte Datei unverändert
  const doc2 = await ensureInvoiceDocument(w.tenantId, v2.id, w.userId, { storage });
  assert.deepEqual([doc2.created, doc2.document.fileName, doc2.document.invoiceVersionId], [true, `Rechnung_${inv0.number}_Fassung2.pdf`, v2.id]);
  assert.notEqual(doc2.document.storageKey, doc1.document.storageKey);
  assert.equal(sha256((await readDocumentFile(w.tenantId, doc1.document.id, storage))!.body), doc1.document.checksum, "PDF der Fassung 1 nie überschrieben");
  const d1 = await loadInvoiceDocumentData(w.tenantId, v1.id);
  const d2 = await loadInvoiceDocumentData(w.tenantId, v2.id);
  assert.deepEqual([d1.doc.version.isCurrent, d1.doc.customer.addressLines[0], d2.doc.version.isCurrent, d2.doc.customer.addressLines[0], d2.doc.version.supersedes?.versionNo, d2.doc.title], [false, "Weg 1", true, "Weg 1a", 1, "Rechnung"]);
  const pdf2 = await renderInvoicePdf(d2.doc);
  assert.ok(pdf2.trace.texts.some((t) => t.includes("Fassung 2") && t.includes("ersetzt Fassung 1")));
  assert.deepEqual(pdf2.trace.boxes.filter((b) => b.overflow), []);

  // Audit ohne Kundendaten
  const audit = await db.auditLog.findMany({ where: { tenantId: w.tenantId, invoiceId }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(audit.map((a) => a.action), ["INVOICE_VERSION_CREATED", "INVOICE_REVISED"]);
  assert.deepEqual((audit[1].details as { fromVersion: number; toVersion: number; grossBefore: number; grossAfter: number }), { ...(audit[1].details as object), fromVersion: 1, toVersion: 2, grossBefore: 100_000, grossAfter: 81_000 });
  assert.ok(!JSON.stringify(audit).includes("Muster") && !JSON.stringify(audit).includes("Weg 1"));

  // Entwurf der Fassung 3 verwerfen: nur der Entwurf verschwindet
  await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  assert.deepEqual(await discardInvoiceDraft(w.tenantId, invoiceId, w.actor), { invoiceDeleted: false, versionNo: 3 });
  assert.equal(await db.invoiceVersion.count({ where: { invoiceId } }), 2);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).currentVersionId, v2.id);
});

test("Bereits übermittelt: nach E-Mail-Versand oder Übergabemarkierung wird die nächste Fassung eine Berichtigung mit Pflichtgrund; E-Mail-Historie bleibt bei der alten Fassung; Korrekturmail nur mit neuem PDF", async () => {
  const { w, invoiceId, v1 } = await invoicedWorld("ver-correction", 1000);
  const transport = new FakeTransport();
  const f1 = await runInvoiceFollowUp(w.tenantId, v1.id, w.userId, { storage, transport });
  assert.deepEqual([f1.invoiceDocument.ok, f1.email.status], [true, "SENT"]);
  assert.match(transport.sent[0].subject, /^Ihre Rechnung RE-/);
  const mode = await invoiceEditMode(w.tenantId, invoiceId);
  assert.deepEqual([mode.mode, mode.nextKind, mode.delivered], ["B", "CORRECTION", true]);

  const draft = await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  assert.equal(draft.kind, "CORRECTION");
  await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, { items: editable(draft.items).map((i) => ({ ...i, unitPrice: "900" })) });
  const s = await getInvoiceState(w.tenantId, invoiceId);
  assert.ok(s.issues.some((i) => i.code === "REASON"));
  await assert.rejects(() => finalizeInvoice(w.tenantId, invoiceId, w.actor), /Grund der Berichtigung/);
  const v2 = await finalizeInvoice(w.tenantId, invoiceId, w.actor, { reason: "Mietpreis laut Vereinbarung reduziert" });
  assert.deepEqual([v2.kind, v2.reason, String(v2.grossTotal)], ["CORRECTION", "Mietpreis laut Vereinbarung reduziert", "900"]);
  await assert.rejects(() => db.invoiceVersion.update({ where: { id: v2.id }, data: { reason: null } }), (e) => isImmutableError(e));

  // Korrekturmail: eigene Vorlage, ausschließlich das PDF der Fassung 2; alte Mails bleiben bei Fassung 1
  const f2 = await runInvoiceFollowUp(w.tenantId, v2.id, w.userId, { storage, transport });
  assert.deepEqual([f2.invoiceDocument.ok, f2.email.status], [true, "SENT"]);
  const m2 = transport.sent[1];
  assert.match(m2.subject, /^Korrigierte Rechnung RE-/);
  assert.ok(m2.text.includes("berichtigte Rechnung") && m2.text.includes("Fassung 2") && m2.text.includes("ersetzt"));
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  assert.deepEqual(m2.attachments.map((a) => a.filename), [`Rechnung_${inv.number}_Fassung2.pdf`]);
  const logs = await db.emailLog.findMany({ where: { tenantId: w.tenantId, invoiceId }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(logs.map((l) => [l.template, l.invoiceVersionId, l.status]), [["INVOICE", v1.id, "SENT"], ["INVOICE_CORRECTION", v2.id, "SENT"]]);
  assert.equal((await runInvoiceFollowUp(w.tenantId, v2.id, w.userId, { storage, transport })).email.status, "DUPLICATE", "kein Doppelversand");
  assert.equal(transport.sent.length, 2);
  const pdf = await renderInvoicePdf((await loadInvoiceDocumentData(w.tenantId, v2.id)).doc);
  const text = pdf.trace.texts.join("\n");
  assert.ok(text.includes("Berichtigte Rechnung") && text.includes("Fassung 2") && text.includes("Berichtigt am") && text.includes("ersetzt Fassung 1") && text.includes("Grund der Berichtigung: Mietpreis laut Vereinbarung reduziert"));
  assert.deepEqual(pdf.trace.boxes.filter((b) => b.overflow), []);

  // manuelle Übergabe: gleiche Wirkung, einmalig, nie entfernbar
  const { w: w2, invoiceId: inv2, v1: v1b } = await invoicedWorld("ver-delivered", 500);
  assert.equal((await invoiceEditMode(w2.tenantId, inv2)).mode, "A");
  await assert.rejects(() => markVersionDelivered(w.tenantId, v1b.id, w.actor, null), /nicht gefunden/, "fremder Mandant");
  const marked = await markVersionDelivered(w2.tenantId, v1b.id, w2.actor, "ausgedruckt mitgegeben");
  assert.deepEqual([!!marked.deliveredAt, marked.deliveredByName, marked.deliveredNote], [true, "Test Mitarbeiter", "ausgedruckt mitgegeben"]);
  await assert.rejects(() => markVersionDelivered(w2.tenantId, v1b.id, w2.actor, null), /bereits als übergeben/);
  await assert.rejects(() => db.invoiceVersion.update({ where: { id: v1b.id }, data: { deliveredAt: null, deliveredById: null } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoiceVersion.update({ where: { id: v1b.id }, data: { deliveredNote: "geändert" } }), (e) => isImmutableError(e));
  assert.deepEqual((await invoiceEditMode(w2.tenantId, inv2)).mode, "B");
  assert.equal((await startInvoiceEdit(w2.tenantId, inv2, w2.actor)).kind, "CORRECTION");
  assert.equal(await db.auditLog.count({ where: { tenantId: w2.tenantId, action: "INVOICE_DELIVERED_MANUALLY" } }), 1);
});

test("Zahlungen bei neuer Fassung: 1000/0→800, 1000/500→800 (300 offen), →500 (bezahlt), →400 (überzahlt 100, Bestätigung Pflicht), 1000/1000→800 (überzahlt 200), überzahlt nimmt nichts an, Storno, Zahlungen unverändert", async () => {
  const a = await invoicedWorld("ver-pay-a", 1000);
  await refinalize(a.w.tenantId, a.invoiceId, a.w.actor, 800);
  assert.deepEqual(await invoicePaymentSummary(a.w.tenantId, a.invoiceId), { grossCents: 80_000, paidCents: 0, openCents: 80_000, overpaidCents: 0, status: "OPEN" });

  const b = await invoicedWorld("ver-pay-b", 1000);
  const p = await recordInvoicePayment(b.w.tenantId, b.w.actor, { invoiceId: b.invoiceId, amount: "500", method: "CASH", paidAt: at });
  assert.equal((await invoiceEditMode(b.w.tenantId, b.invoiceId)).mode, "C");
  await refinalize(b.w.tenantId, b.invoiceId, b.w.actor, 800);
  let s = await invoicePaymentSummary(b.w.tenantId, b.invoiceId);
  assert.deepEqual([s.grossCents, s.paidCents, s.openCents, s.status], [80_000, 50_000, 30_000, "PARTIAL"]);
  await refinalize(b.w.tenantId, b.invoiceId, b.w.actor, 500);
  s = await invoicePaymentSummary(b.w.tenantId, b.invoiceId);
  assert.deepEqual([s.openCents, s.overpaidCents, s.status], [0, 0, "PAID"]);
  // 400: Überzahlung nur mit ausdrücklicher Bestätigung
  await assert.rejects(() => refinalize(b.w.tenantId, b.invoiceId, b.w.actor, 400), /Überzahlung von 100,00.€[^]*ausdrücklich bestätigen/);
  assert.equal((await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId: b.invoiceId, status: "DRAFT" } })).versionNo, 4, "Entwurf bleibt bestehen");
  const st = await getInvoiceState(b.w.tenantId, b.invoiceId);
  assert.ok(st.issues.some((i) => i.code === "OVERPAID" && i.severity === "warning"));
  const v4 = await finalizeInvoice(b.w.tenantId, b.invoiceId, b.w.actor, { confirmOverpayment: true });
  assert.equal(String(v4.grossTotal), "400");
  s = await invoicePaymentSummary(b.w.tenantId, b.invoiceId);
  assert.deepEqual([s.grossCents, s.paidCents, s.openCents, s.overpaidCents, s.status], [40_000, 50_000, 0, 10_000, "OVERPAID"]);
  await assert.rejects(() => recordInvoicePayment(b.w.tenantId, b.w.actor, { invoiceId: b.invoiceId, amount: "1", method: "CASH", paidAt: at }), /überzahlt/);
  const audit = await db.auditLog.findFirst({ where: { tenantId: b.w.tenantId, action: "INVOICE_REVISED", invoiceId: b.invoiceId }, orderBy: { createdAt: "desc" } });
  assert.equal((audit?.details as { overpaidCents: number }).overpaidCents, 10_000);
  // Zahlung unverändert, kein Storno, kein negatives Payment, keine Kaution berührt
  assert.deepEqual([(await db.payment.findUniqueOrThrow({ where: { id: p.payment.id } })).status, await db.payment.count({ where: { tenantId: b.w.tenantId } })], ["CONFIRMED", 1]);
  assert.equal(await db.securityDeposit.count({ where: { tenantId: b.w.tenantId } }), 0);
  // Korrektur nach Payment-Storno: wieder offen, Zahlung bis zum offenen Betrag
  await cancelPayment(b.w.tenantId, b.w.actor, p.payment.id, "Falsche Rechnung");
  s = await invoicePaymentSummary(b.w.tenantId, b.invoiceId);
  assert.deepEqual([s.openCents, s.status], [40_000, "OPEN"]);
  await assert.rejects(() => recordInvoicePayment(b.w.tenantId, b.w.actor, { invoiceId: b.invoiceId, amount: "400,01", method: "CASH", paidAt: at }), /Überzahlung/);
  await recordInvoicePayment(b.w.tenantId, b.w.actor, { invoiceId: b.invoiceId, amount: "400", method: "CASH", paidAt: at });
  assert.equal((await invoicePaymentSummary(b.w.tenantId, b.invoiceId)).status, "PAID");

  const c = await invoicedWorld("ver-pay-c", 1000);
  await recordInvoicePayment(c.w.tenantId, c.w.actor, { invoiceId: c.invoiceId, amount: "1000", method: "BANK_TRANSFER", paidAt: at });
  await refinalize(c.w.tenantId, c.invoiceId, c.w.actor, 800, { confirmOverpayment: true });
  s = await invoicePaymentSummary(c.w.tenantId, c.invoiceId);
  assert.deepEqual([s.overpaidCents, s.status], [20_000, "OVERPAID"]);
});

test("Race Conditions und Integrität: parallele Bearbeitung/Abschlüsse, veralteter Entwurf, Versand während des Entwurfs, Export-Sperre, DB-Regeln", async () => {
  const { w, invoiceId, v1 } = await invoicedWorld("ver-race", 1000);
  // zweimal gleichzeitig „Rechnung bearbeiten“: ein Entwurf
  const both = await Promise.all([startInvoiceEdit(w.tenantId, invoiceId, w.actor), startInvoiceEdit(w.tenantId, invoiceId, { id: w.userId, name: "Kollege" })]);
  assert.equal(both[0].id, both[1].id);
  assert.equal(await db.invoiceVersion.count({ where: { invoiceId, status: "DRAFT" } }), 1);
  // beide gleichzeitig finalisieren: genau eine Fassung 2
  const res = await Promise.allSettled([finalizeInvoice(w.tenantId, invoiceId, w.actor), finalizeInvoice(w.tenantId, invoiceId, { id: w.userId, name: "Kollege" })]);
  assert.deepEqual(res.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(await db.invoiceVersion.count({ where: { invoiceId, status: "FINALIZED" } }), 2);
  assert.equal((await currentOf(invoiceId)).versionNo, 2);

  // Versand der Vorfassung, während ein Entwurf als Neufassung offen ist → beim Abschluss Berichtigung mit Pflichtgrund
  const transport = new FakeTransport();
  const d3 = await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  assert.equal(d3.kind, "REVISION");
  const v2 = await currentOf(invoiceId);
  await ensureInvoiceDocument(w.tenantId, v2.id, w.userId, { storage });
  const [sent, fin] = await Promise.allSettled([sendInvoiceDocument(w.tenantId, v2.id, { trigger: "AUTO", storage, transport }), finalizeInvoice(w.tenantId, invoiceId, w.actor)]);
  assert.equal(sent.status, "fulfilled");
  if (fin.status === "fulfilled") {
    assert.equal(fin.value.kind, "REVISION", "Abschluss vor dem Versand: Neufassung");
  } else {
    assert.match(String((fin as PromiseRejectedResult).reason.message), /Grund der Berichtigung/, "Abschluss nach dem Versand: Berichtigung braucht Grund");
    const d = await draftOf(invoiceId);
    assert.equal(d.kind, "REVISION", "Art wird erst beim Abschluss festgelegt");
    const v3 = await finalizeInvoice(w.tenantId, invoiceId, w.actor, { reason: "Nach Versand berichtigt" });
    assert.equal(v3.kind, "CORRECTION");
  }

  // finalisieren + Zahlung gleichzeitig: Saldo konsistent (Zahlung bezieht sich auf die dann aktuelle Fassung, nie über offen)
  const d4 = await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, { items: [{ id: d4.items[0].id, description: d4.items[0].description, quantity: "1", unit: "pauschal", unitPrice: "300", taxRate: "19" }], reason: "Reduziert" });
  const [payRes] = await Promise.allSettled([recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount: "1000", method: "CASH", paidAt: at }), finalizeInvoice(w.tenantId, invoiceId, w.actor, { confirmOverpayment: true })]);
  const sum = await invoicePaymentSummary(w.tenantId, invoiceId);
  if (payRes.status === "fulfilled") assert.deepEqual([sum.grossCents, sum.paidCents, sum.status], [30_000, 100_000, "OVERPAID"]);
  else assert.deepEqual([sum.grossCents, sum.paidCents], [30_000, 0]);
  assert.equal(sum.paidCents, (await db.payment.aggregate({ where: { invoiceId, status: "CONFIRMED" }, _sum: { amountCents: true } }))._sum.amountCents ?? 0);

  // finalisieren + übergeben markieren gleichzeitig: Markierung hängt an der markierten Fassung
  const cur = await currentOf(invoiceId);
  await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, { items: editable((await draftOf(invoiceId)).items), reason: "Text" });
  const [mk] = await Promise.allSettled([markVersionDelivered(w.tenantId, cur.id, w.actor, null), finalizeInvoice(w.tenantId, invoiceId, w.actor, { confirmOverpayment: true })]);
  assert.equal(mk.status, "fulfilled");
  assert.ok((await db.invoiceVersion.findUniqueOrThrow({ where: { id: cur.id } })).deliveredAt);

  // veralteter Entwurf: Entwurf basiert nicht mehr auf der aktuellen Fassung
  const stale = await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  const newest = await currentOf(invoiceId);
  await db.$executeRaw`SET rentbase.allow_purge = 'on'`;
  await db.invoiceVersion.update({ where: { id: stale.id }, data: { supersedesVersionId: v1.id } });
  await db.$executeRaw`RESET rentbase.allow_purge`;
  await assert.rejects(() => finalizeInvoice(w.tenantId, invoiceId, w.actor, { reason: "x", confirmOverpayment: true }), /nicht mehr auf der aktuellen Fassung/);
  await discardInvoiceDraft(w.tenantId, invoiceId, w.actor);
  assert.equal((await currentOf(invoiceId)).id, newest.id);

  // DB-Regeln
  const fin1 = await db.invoiceVersion.findUniqueOrThrow({ where: { id: v1.id }, include: { items: true } });
  await assert.rejects(() => db.invoiceVersion.update({ where: { id: v1.id }, data: { grossTotal: 1 } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoiceVersion.update({ where: { id: v1.id }, data: { customerSnapshot: {} } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoiceVersion.delete({ where: { id: v1.id } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoiceVersionItem.update({ where: { id: fin1.items[0].id }, data: { unitPrice: 1 } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoiceVersionItem.delete({ where: { id: fin1.items[0].id } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoiceVersion.create({ data: { tenantId: w.tenantId, invoiceId, versionNo: 1, kind: "REVISION", servicePeriodStart: at, servicePeriodEnd: at, pricesIncludeTax: true, customerSnapshot: {}, companySnapshot: {} } }), /P2002|lückenlos|Unique/);
  await assert.rejects(() => db.invoiceVersion.create({ data: { tenantId: w.tenantId, invoiceId, versionNo: 99, kind: "REVISION", servicePeriodStart: at, servicePeriodEnd: at, pricesIncludeTax: true, customerSnapshot: {}, companySnapshot: {} } }), /lückenlos/);
  await assert.rejects(() => db.invoice.update({ where: { id: invoiceId }, data: { currentVersionId: v1.id } }), /nur auf eine neuere Fassung/);
  await assert.rejects(() => db.invoice.update({ where: { id: invoiceId }, data: { currentVersionId: null } }), /behält immer eine aktuelle Fassung/);
  const other = await invoicedWorld("ver-other", 100);
  await assert.rejects(() => db.invoice.update({ where: { id: invoiceId }, data: { currentVersionId: other.v1.id } }), /abgeschlossene Fassung dieser Rechnung/);
  await assert.rejects(() => db.invoiceVersion.create({ data: { tenantId: other.w.tenantId, invoiceId, versionNo: 10, kind: "REVISION", servicePeriodStart: at, servicePeriodEnd: at, pricesIncludeTax: true, customerSnapshot: {}, companySnapshot: {} } }), /RB_TENANT/);
  await assert.rejects(() => db.document.create({ data: { tenantId: other.w.tenantId, bookingId: other.w.bookingId, invoiceVersionId: v1.id, type: "INVOICE", storageKey: `t/${other.w.tenantId}/x.pdf`, fileName: "x.pdf", sizeBytes: 1, checksum: "x" } }), /RB_TENANT/);
  await assert.rejects(() => db.emailLog.create({ data: { tenantId: other.w.tenantId, bookingId: other.w.bookingId, invoiceVersionId: v1.id, recipient: "x@example.test", subject: "x", template: "INVOICE", idempotencyKey: "fremd-1" } }), /RB_TENANT/);
  await assert.rejects(() => startInvoiceEdit(other.w.tenantId, invoiceId, other.w.actor), /nicht gefunden/);

  // Export-Sperre (D): Marke einmalig setzbar, danach keine Fassung mehr unter dieser Nummer (App und DB)
  await db.invoice.update({ where: { id: other.invoiceId }, data: { exportedAt: new Date(), exportBatchId: "TEST-1" } });
  assert.equal((await invoiceEditMode(other.w.tenantId, other.invoiceId)).mode, "D");
  await assert.rejects(() => startInvoiceEdit(other.w.tenantId, other.invoiceId, other.w.actor), /bereits buchhalterisch exportiert/);
  await assert.rejects(() => db.invoiceVersion.create({ data: { tenantId: other.w.tenantId, invoiceId: other.invoiceId, versionNo: 2, kind: "REVISION", servicePeriodStart: at, servicePeriodEnd: at, pricesIncludeTax: true, customerSnapshot: {}, companySnapshot: {} } }), /exportiert/);
  await assert.rejects(() => db.invoice.update({ where: { id: other.invoiceId }, data: { exportedAt: null } }), (e) => isImmutableError(e));
});

test("PDF-Fassungen: Fassung 10, Berichtigung mit langem Grund, 22 Positionen, lange Namen und Adressen, 0 % und 19 % – kein Textüberlauf", async () => {
  const { w, invoiceId } = await invoicedWorld("ver-pdf", 1000);
  const long = "Gesellschaft für außergewöhnlich lange Firmenbezeichnungen und internationale Nutzfahrzeugvermietung mit Sitz in der Hansestadt Bremen mbH & Co. KG";
  const longStreet = "Am äußerst langen Straßennamen der Überseestadt mit Hausnummer 1234 a-c, Hinterhaus, 3. Obergeschoss links";
  const reason = "Der Kunde hat nach Erhalt der Rechnung eine abweichende Vereinbarung aus dem Vertragsgespräch nachgewiesen (E-Mail vom Vortag der Anmietung). Der Mietpreis wurde entsprechend auf den vereinbarten Wochenpreis angepasst, die Reinigungspauschale entfällt, und die Anschrift wurde auf die Firmenadresse geändert. ".repeat(2);
  for (let n = 2; n <= 10; n++) {
    const d = await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
    const items: ItemInput[] = n === 10
      ? Array.from({ length: 22 }, (_, k) => ({ description: `Position ${k + 1}: ${k % 3 === 0 ? "Zusatzfahrer mit Führerscheinprüfung und Registrierung im Mietvertrag" : k % 3 === 1 ? "Mehrkilometer" : "Kindersitz Gruppe 1"}`, quantity: String(k + 1), unit: k % 2 ? "Tag" : "Stk", unitPrice: (k * 3.37 + 1).toFixed(2).replace(".", ","), taxRate: k % 4 === 0 ? "0" : "19" }))
      : editable(d.items).map((i) => ({ ...i, unitPrice: String(1000 - n * 10) }));
    await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, { items, reason: n === 10 ? reason : `Fassung ${n}`, taxNote: "Steuerfrei nach § 4 UStG (Beispieltext)", customer: n === 10 ? { type: "COMPANY", companyName: long, street: longStreet } : undefined, company: n === 10 ? { name: long, street: longStreet } : undefined });
    if (n === 5 || n === 10) await markVersionDelivered(w.tenantId, (await currentOf(invoiceId)).id, w.actor, null);
    await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  }
  const v10 = await currentOf(invoiceId);
  assert.deepEqual([v10.versionNo, v10.kind, v10.items.length], [10, "CORRECTION", 22]);
  const data = await loadInvoiceDocumentData(w.tenantId, v10.id);
  const pdf = await renderInvoicePdf(data.doc);
  assert.deepEqual(pdf.trace.boxes.filter((b) => b.overflow), [], "kein Text außerhalb des Satzspiegels");
  assert.ok(pdf.trace.pages >= 2, "mehrseitig");
  const text = pdf.trace.texts.join("\n");
  assert.ok(text.includes("Berichtigte Rechnung") && text.includes("Fassung 10") && text.includes("ersetzt Fassung 9") && text.includes(long) && text.includes("0,00 %") && text.includes("19,00 %") && text.includes("Steuerfrei nach § 4 UStG"));
  assert.ok(text.includes("Position 22"));
  for (const no of [1, 5, 6, 9]) {
    const v = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId, versionNo: no } });
    const p = await renderInvoicePdf((await loadInvoiceDocumentData(w.tenantId, v.id)).doc);
    assert.deepEqual(p.trace.boxes.filter((b) => b.overflow), [], `Fassung ${no} ohne Überlauf`);
    assert.equal((await verifyVersion(w.tenantId, v.id)).intact, true, `Fassung ${no} intakt`);
  }
  const kinds = (await listVersions(w.tenantId, invoiceId)).map((v) => v.kind);
  assert.deepEqual(kinds, ["ORIGINAL", "REVISION", "REVISION", "REVISION", "CORRECTION", "REVISION", "REVISION", "REVISION", "REVISION", "CORRECTION"]);
});
