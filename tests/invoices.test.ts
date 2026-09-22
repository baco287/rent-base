// Integrationstest Rechnungsmodul: Entwurf nur nach Rückgabe, Vorbefüllung ausschließlich aus versiegelten Quellen,
// Bearbeitung mit Protokoll, Prüfliste, transaktionaler Abschluss mit eindeutiger Nummer, Unveränderlichkeit,
// Snapshot-Stabilität, PDF, Archiv und E-Mail, Mandantentrennung.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { ensureInvoiceDocument, readDocumentFile } from "../src/lib/documents";
import { runInvoiceFollowUp } from "../src/lib/followup";
import { isImmutableError } from "../src/lib/integrity";
import { discardInvoiceDraft, ensureInvoiceDraft, finalizeInvoice, getInvoiceState, invoiceSettingsMissing, updateInvoiceDraft, verifyInvoice } from "../src/lib/invoices";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { toCents } from "../src/lib/money";
import { nextInvoiceNumber, withNumberRetry } from "../src/lib/numbering";
import { renderInvoicePdf } from "../src/lib/pdf/invoice-pdf";
import { sendInvoiceDocument } from "../src/lib/rental-mail";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { createWorld, purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-invoice-"));
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
  fail: unknown = null;
  async send(m: MailMessage) { if (this.fail) throw this.fail; this.sent.push(m); return { messageId: `<fake-${this.sent.length}@test>` }; }
}

const world = async (label: string, opts: Parameters<typeof returnedWorld>[1] = {}) => {
  await ready;
  const w = await returnedWorld(label, opts);
  tenants.push(w.tenantId);
  return w;
};
const items = (invoiceId: string) => db.invoiceItem.findMany({ where: { invoiceId }, orderBy: { sortOrder: "asc" } });
const editable = (rows: Awaited<ReturnType<typeof items>>) => rows.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: String(i.unitPrice), taxRate: String(i.taxRate) }));

test("Entwurf: nur nach abgeschlossener Rückgabe, Vorbefüllung aus Vertragspreis und bestätigten Zusatzkosten, keine Vorschläge, kein Schaden ohne Position, Einstellungen Pflicht", async () => {
  await ready;
  // Buchung ohne Rückgabe: keine Rechnung
  const plain = await createWorld("inv-early");
  tenants.push(plain.tenantId);
  await db.tenant.update({ where: { id: plain.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/1" } });
  await assert.rejects(() => ensureInvoiceDraft(plain.tenantId, plain.bookingId, plain.actor), /erst nach abgeschlossener Rückgabe/);
  await db.booking.update({ where: { id: plain.bookingId }, data: { status: "RETURNED" } });
  await assert.rejects(() => ensureInvoiceDraft(plain.tenantId, plain.bookingId, plain.actor), /keinen abgeschlossenen Mietvertrag/, "Status allein reicht nicht, der Vertrag muss versiegelt sein");

  // Einstellungen unvollständig: keine Vermutung über Steuersatz oder Brutto/Netto
  const bare = await world("inv-settings", { tenant: { defaultTaxRate: null, pricesIncludeTax: null, taxNumber: null, vatId: null } });
  const tenantRow = await db.tenant.findUniqueOrThrow({ where: { id: bare.tenantId } });
  assert.deepEqual(invoiceSettingsMissing(tenantRow), ["Steuersatz für Rechnungspositionen", "Angabe, ob Miet- und Zusatzkostenpreise Brutto- oder Nettobeträge sind", "Steuernummer oder Umsatzsteuer-Identifikationsnummer"]);
  await assert.rejects(() => ensureInvoiceDraft(bare.tenantId, bare.bookingId, bare.actor), /Steuersatz für Rechnungspositionen/);
  assert.equal(await db.invoice.count({ where: { tenantId: bare.tenantId } }), 0);

  // Regelfall
  const w = await world("inv-draft");
  const charges = await db.extraCharge.findMany({ where: { tenantId: w.tenantId, handoverId: w.returnId } });
  assert.deepEqual(charges.map((c) => c.type).sort(), ["CLEANING", "EXTRA_MILEAGE"], "Kraftstoff blieb ein unbestätigter Vorschlag, der Schaden hat keine Position");
  const contract = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const booking = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  assert.equal(inv.status, "DRAFT");
  assert.equal(inv.number, null, "Nummer erst beim Abschluss");
  assert.deepEqual([inv.contractId, inv.returnHandoverId, inv.customerId, inv.pricesIncludeTax, inv.paymentTermDays], [w.contractId, w.returnId, w.customerId, true, 14]);
  assert.deepEqual([inv.servicePeriodStart.getTime(), inv.servicePeriodEnd.getTime()], [booking.actualPickupAt!.getTime(), booking.actualReturnAt!.getTime()], "Leistungszeitraum = tatsächliche Übergabe bis tatsächliche Rückgabe");
  const rows = await items(inv.id);
  assert.deepEqual(rows.map((r) => r.source), ["RENTAL", "EXTRA_CHARGE", "EXTRA_CHARGE"]);
  assert.equal(toCents(rows[0].grossAmount), toCents(contract.totalAmount), "Miete zum finalen Vertragspreis (brutto)");
  assert.match(rows[0].description, /Fahrzeugmiete VW Crafter .* laut Mietvertrag MV-/);
  const mileage = charges.find((c) => c.type === "EXTRA_MILEAGE")!;
  const cleaning = charges.find((c) => c.type === "CLEANING")!;
  const byCharge = new Map(rows.map((r) => [r.extraChargeId, r]));
  assert.equal(toCents(byCharge.get(mileage.id)!.grossAmount), toCents(mileage.amount), "Mehrkilometer exakt wie bestätigt");
  assert.deepEqual([String(byCharge.get(mileage.id)!.quantity), byCharge.get(mileage.id)!.unit, String(byCharge.get(mileage.id)!.unitPrice)], ["800", "km", "0.25"]);
  assert.equal(toCents(byCharge.get(cleaning.id)!.grossAmount), 3000);
  assert.ok(rows.every((r) => String(r.taxRate) === "19"), "Steuersatz aus der Konfiguration, nicht hart codiert");
  assert.ok(rows.every((r) => toCents(r.grossAmount) === toCents(r.netAmount) + toCents(r.taxAmount)));
  const sum = rows.reduce((s, r) => s + toCents(r.grossAmount), 0);
  assert.equal(toCents(inv.grossTotal), sum);
  assert.equal(toCents(inv.grossTotal), toCents(contract.totalAmount) + toCents(mileage.amount) + 3000);
  assert.ok(!rows.some((r) => /Kraftstoff|Schaden|Delle/.test(r.description)), "kein unbestätigter Vorschlag, kein Schaden ohne bestätigte Position");
  const snap = inv.customerSnapshot as { firstName: string; lastName: string; street: string; email: string };
  assert.deepEqual([snap.firstName, snap.lastName, snap.street, snap.email], ["Erika", "Muster", "Weg 1", "erika@example.test"]);
  assert.equal((inv.companySnapshot as { legalForm: string }).legalForm, "GmbH");
  assert.equal((await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor)).id, inv.id, "ein Entwurf je Buchung");

  // Schaden nur mit ausdrücklicher DAMAGE-Position
  const d = await world("inv-damage", { damageCharge: true });
  const dinv = await ensureInvoiceDraft(d.tenantId, d.bookingId, d.actor);
  const drows = await items(dinv.id);
  assert.equal(drows.length, 4);
  assert.equal(drows.find((r) => r.extraChargeId === d.charges.damageId)?.description, "Schaden: Kostenvoranschlag Heckklappe");

  // Nettomodus: Steuer kommt hinzu
  const n = await world("inv-net", { tenant: { pricesIncludeTax: false } });
  const ninv = await ensureInvoiceDraft(n.tenantId, n.bookingId, n.actor);
  const ncontract = await db.rentalContract.findUniqueOrThrow({ where: { id: n.contractId } });
  const nrows = await items(ninv.id);
  assert.equal(toCents(nrows[0].netAmount), toCents(ncontract.totalAmount));
  assert.equal(toCents(nrows[0].grossAmount), toCents(ncontract.totalAmount) + toCents(nrows[0].taxAmount));
  assert.equal(toCents(ninv.netTotal), nrows.reduce((s, r) => s + toCents(r.netAmount), 0));

  // Mandantentrennung
  await assert.rejects(() => ensureInvoiceDraft(d.tenantId, w.bookingId, d.actor), /Buchung nicht gefunden/);
  await assert.rejects(() => updateInvoiceDraft(d.tenantId, inv.id, d.actor, { items: editable(rows) }), /Rechnung nicht gefunden/);
  await assert.rejects(() => finalizeInvoice(d.tenantId, inv.id, d.actor), /Rechnung nicht gefunden/);
  await assert.rejects(() => loadInvoiceDocumentData(d.tenantId, inv.id, { allowDraft: true }), /Rechnung nicht gefunden/);
});

test("Bearbeitung: Positionen ändern, ergänzen, entfernen mit Protokoll; nur konfigurierte Steuersätze; 0 % nur mit Hinweis; keine negativen Beträge; Prüfliste", async () => {
  const w = await world("inv-edit");
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  let rows = await items(inv.id);
  const cleaning = rows.find((r) => r.description.startsWith("Reinigung"))!;

  // Prüfliste im Ausgangszustand: alles in Ordnung
  const s0 = await getInvoiceState(w.tenantId, inv.id);
  assert.deepEqual(s0.issues, []);
  assert.deepEqual(s0.allowedRates, [19, 0]);

  // Menge der Mehrkilometer kulant reduzieren, Reinigung entfernen, manuelle Position ergänzen
  const mileage = rows.find((r) => r.unit === "km")!;
  const edited = editable(rows).filter((r) => r.id !== cleaning.id).map((r) => (r.id === mileage.id ? { ...r, quantity: "500" } : r));
  edited.push({ id: "", description: "Kindersitz", quantity: "6", unit: "Tag", unitPrice: "5,00", taxRate: "19" });
  const updated = await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: edited, customerNote: "Vielen Dank für Ihre Miete.", paymentTermDays: 10 });
  rows = await items(inv.id);
  assert.deepEqual(rows.map((r) => r.source), ["RENTAL", "EXTRA_CHARGE", "MANUAL"], "Herkunft bleibt erhalten, neue Position ist manuell");
  assert.equal(rows[1].extraChargeId, mileage.extraChargeId, "Bezug zur bestätigten Zusatzkostenposition bleibt");
  assert.equal(toCents(rows[1].grossAmount), 12_500);
  assert.equal(toCents(rows[2].grossAmount), 3000);
  assert.equal(toCents(updated.grossTotal), rows.reduce((s, r) => s + toCents(r.grossAmount), 0));
  assert.equal(updated.paymentTermDays, 10);
  const log = updated.changeLog as { by: string; summary: string }[];
  assert.equal(log.length, 2);
  assert.equal(log[1].by, "Test Mitarbeiter");
  assert.match(log[1].summary, /Position entfernt: Reinigung: Innenreinigung \(30,00/);
  assert.match(log[1].summary, /Position geändert: .*Mehrkilometer.* zu .*125,00/);
  assert.match(log[1].summary, /Position hinzugefügt: Kindersitz \(30,00/);
  assert.match(log[1].summary, /Rechnungstext geändert; Zahlungsziel: 10/);
  assert.equal(toCents((await db.extraCharge.findUniqueOrThrow({ where: { id: mileage.extraChargeId! } })).amount), 20_000, "Quelle (Rückgabe) bleibt unberührt");

  // Steuersatz außerhalb der Konfiguration
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: editable(rows).map((r, i) => (i === 2 ? { ...r, taxRate: "7" } : r)) }), /Steuersatz 7,00 % ist nicht konfiguriert/);
  // 0 % erlaubt, aber Abschluss braucht den Hinweistext
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: editable(rows).map((r, i) => (i === 2 ? { ...r, taxRate: "0" } : r)), taxNote: "" });
  const s1 = await getInvoiceState(w.tenantId, inv.id);
  assert.deepEqual(s1.issues.map((i) => i.code), ["TAX_NOTE"]);
  await assert.rejects(() => finalizeInvoice(w.tenantId, inv.id, w.actor), /Steuerhinweis/);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: editable(await items(inv.id)), taxNote: "Steuerfrei nach § 4 UStG (Beispieltext des Inhabers)" });
  assert.deepEqual((await getInvoiceState(w.tenantId, inv.id)).issues, []);
  rows = await items(inv.id);
  assert.equal(toCents(rows[2].taxAmount), 0);

  // negative oder leere Werte
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: editable(rows).map((r, i) => (i === 2 ? { ...r, unitPrice: "-5" } : r)) }), /nicht negativ/);
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: editable(rows).map((r, i) => (i === 2 ? { ...r, quantity: "0" } : r)) }), /größer als 0/);
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [] }), /mindestens eine Position/);
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: editable(rows).map((r, i) => (i === 2 ? { ...r, unit: "Wochen" } : r)) }), /Unbekannte Einheit/);
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: editable(rows), paymentTermDays: 400 }), /zwischen 0 und 365/);
  assert.equal((await items(inv.id)).length, 3, "fehlgeschlagene Speicherung lässt den Entwurf unverändert");

  // Prüfliste: unvollständige Empfängeradresse blockiert (der Vertrag verlangt sie, hier wird die Kopie im Entwurf bewusst beschädigt)
  const noAddr = await world("inv-noaddr");
  const ninv = await ensureInvoiceDraft(noAddr.tenantId, noAddr.bookingId, noAddr.actor);
  await db.invoice.update({ where: { id: ninv.id }, data: { customerSnapshot: { ...(ninv.customerSnapshot as object), street: null } } });
  assert.deepEqual((await getInvoiceState(noAddr.tenantId, ninv.id)).issues.map((i) => i.code), ["CUSTOMER_ADDRESS"]);
  await assert.rejects(() => finalizeInvoice(noAddr.tenantId, ninv.id, noAddr.actor), /Anschrift des Rechnungsempfängers/);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: ninv.id } })).status, "DRAFT");
  // Firmendaten unvollständig blockiert ebenfalls den Abschluss (nicht nur die Anlage)
  await db.tenant.update({ where: { id: noAddr.tenantId }, data: { taxNumber: null } });
  assert.ok((await getInvoiceState(noAddr.tenantId, ninv.id)).issues.some((i) => i.code === "COMPANY"));

  // Entwurf verwerfen ist möglich, danach kann neu begonnen werden
  await discardInvoiceDraft(w.tenantId, inv.id);
  assert.equal(await db.invoice.count({ where: { id: inv.id } }), 0);
  const again = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  assert.notEqual(again.id, inv.id);
  assert.equal((await items(again.id)).length, 3, "neu aus den Quellen befüllt");
});

test("Abschluss: Transaktion, fortlaufende eindeutige Nummer, Firmendaten eingefroren, danach unveränderlich (App und DB), Snapshots stabil, eine Rechnung je Buchung", async () => {
  const w = await world("inv-final", { damageCharge: true });
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);

  // Firmendaten ändern sich noch vor dem Abschluss: der Abschluss friert den dann aktuellen Stand ein
  await db.tenant.update({ where: { id: w.tenantId }, data: { iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Testbank", invoiceFooter: "Geschäftsführer: Max Muster · HRB 12345" } });

  // Zwei gleichzeitige Abschlüsse desselben Entwurfs: genau einer gewinnt
  const results = await Promise.allSettled([finalizeInvoice(w.tenantId, inv.id, w.actor), finalizeInvoice(w.tenantId, inv.id, w.actor)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason.message), /bereits abgeschlossen/);

  const done = await db.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { items: true } });
  assert.equal(done.status, "FINALIZED");
  assert.equal(done.number, `RE-${new Date().getFullYear()}-000001`);
  assert.ok(done.issueDate && done.finalizedAt && done.contentHash);
  assert.equal(Math.round((done.paymentDueDate!.getTime() - done.issueDate!.getTime()) / 86400_000), 14);
  const company = done.companySnapshot as { iban: string; bankName: string; invoiceFooter: string };
  assert.deepEqual([company.iban, company.bankName], ["DE02120300000000202051", "Testbank"]);
  assert.equal((await verifyInvoice(w.tenantId, inv.id)).intact, true);
  assert.match(String((done.changeLog as { summary: string }[]).at(-1)?.summary), /Abgeschlossen als RE-/);

  // unveränderlich: Anwendung und Datenbank
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: editable(done.items) }), /abgeschlossen und kann nicht mehr geändert werden/);
  await assert.rejects(() => discardInvoiceDraft(w.tenantId, inv.id), /abgeschlossen/);
  await assert.rejects(() => finalizeInvoice(w.tenantId, inv.id, w.actor), /bereits abgeschlossen/);
  await assert.rejects(() => db.invoice.update({ where: { id: inv.id }, data: { grossTotal: 1 } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoice.update({ where: { id: inv.id }, data: { customerNote: "x" } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoice.delete({ where: { id: inv.id } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoiceItem.update({ where: { id: done.items[0].id }, data: { description: "x" } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoiceItem.delete({ where: { id: done.items[0].id } }), (e) => isImmutableError(e));
  await assert.rejects(() => db.invoiceItem.create({ data: { tenantId: w.tenantId, invoiceId: inv.id, sortOrder: 9, description: "nachträglich", quantity: 1, unit: "pauschal", unitPrice: 1, netAmount: 1, taxRate: 0, taxAmount: 0, grossAmount: 1, source: "MANUAL" } }), (e) => isImmutableError(e));
  assert.equal((await verifyInvoice(w.tenantId, inv.id)).intact, true);

  // Snapshots bleiben stabil, wenn sich Kunde und Mandant später ändern
  await db.customer.update({ where: { id: w.customerId }, data: { lastName: "Neu", street: "Anderswo 9", email: "neu@example.test" } });
  await db.tenant.update({ where: { id: w.tenantId }, data: { name: "Umfirmiert GmbH", iban: "DE00000000000000000000", defaultTaxRate: 7 } });
  const data = await loadInvoiceDocumentData(w.tenantId, inv.id);
  assert.equal(data.doc.customer.name, "Erika Muster");
  assert.deepEqual(data.doc.customer.addressLines, ["Weg 1", "28195 Bremen"]);
  assert.equal(data.renterEmail, "erika@example.test");
  assert.match(data.doc.company.fullName, /^Test inv-final.* GmbH$/);
  assert.ok(data.doc.company.bankLines.includes("IBAN: DE02120300000000202051"));
  assert.ok(data.doc.items.every((i) => i.taxRate === "19,00 %"));
  assert.equal(data.doc.items.length, 4);
  assert.equal(data.sourceHash, done.contentHash);

  // eine abgeschlossene Rechnung je Buchung; der Entwurfsaufruf liefert die bestehende
  assert.equal((await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor)).id, inv.id);
  await assert.rejects(
    () => db.invoice.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, number: "RE-9999-000001", status: "FINALIZED", servicePeriodStart: new Date(), servicePeriodEnd: new Date(), pricesIncludeTax: true, customerSnapshot: {}, companySnapshot: {}, netTotal: 0, taxTotal: 0, grossTotal: 0 } }),
    (e: { code?: string }) => e.code === "P2002",
    "Datenbank verhindert eine zweite abgeschlossene Rechnung je Buchung",
  );

  // Nummernvergabe unter Last: gleichzeitige Vergabe liefert lückenlos eindeutige Nummern, nie doppelt
  const year = new Date().getFullYear();
  const made = await Promise.all(
    Array.from({ length: 6 }, () =>
      withNumberRetry(() =>
        db.$transaction(async (tx) => {
          const number = await nextInvoiceNumber(tx, w.tenantId);
          return tx.invoice.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, number, status: "DRAFT", servicePeriodStart: new Date(), servicePeriodEnd: new Date(), pricesIncludeTax: true, customerSnapshot: {}, companySnapshot: {}, netTotal: 0, taxTotal: 0, grossTotal: 0 } });
        }),
      ),
    ),
  );
  assert.deepEqual(made.map((m) => m.number).sort(), Array.from({ length: 6 }, (_, i) => `RE-${year}-${String(i + 2).padStart(6, "0")}`));
  await db.invoice.deleteMany({ where: { id: { in: made.map((m) => m.id) } } });
  await assert.rejects(() => db.invoice.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, number: done.number!, status: "DRAFT", servicePeriodStart: new Date(), servicePeriodEnd: new Date(), pricesIncludeTax: true, customerSnapshot: {}, companySnapshot: {}, netTotal: 0, taxTotal: 0, grossTotal: 0 } }), (e: { code?: string }) => e.code === "P2002", "Nummer wird nie wiederverwendet");
});

test("PDF aus dem Snapshot, Archiv mit Prüfsumme, E-Mail genau einmal, erneut senden mit nonce, Ausfall harmlos, Entwurf ohne PDF", async () => {
  const w = await world("inv-pdf");
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: editable(await items(inv.id)), notes: "INTERN: Kunde hat sich beschwert", customerNote: "Bitte überweisen Sie innerhalb der Frist." });
  await assert.rejects(() => ensureInvoiceDocument(w.tenantId, inv.id, w.userId, { storage }), /erst, wenn die Rechnung abgeschlossen ist/);
  await assert.rejects(() => sendInvoiceDocument(w.tenantId, inv.id, { trigger: "AUTO", storage, transport: new FakeTransport() }), /Abschluss/);

  const draft = await loadInvoiceDocumentData(w.tenantId, inv.id, { allowDraft: true });
  const preview = await renderInvoicePdf(draft.doc);
  assert.ok(preview.trace.texts.includes("Rechnung Entwurf") || preview.trace.texts.some((t) => t.includes("Entwurf")));
  assert.deepEqual(preview.trace.boxes.filter((b) => b.overflow), []);

  await finalizeInvoice(w.tenantId, inv.id, w.actor);
  const data = await loadInvoiceDocumentData(w.tenantId, inv.id);
  const pdf = await renderInvoicePdf(data.doc);
  assert.deepEqual(pdf.trace.boxes.filter((b) => b.overflow), [], "kein Text außerhalb des Satzspiegels");
  assert.equal(pdf.trace.pages, 1);
  const text = pdf.trace.texts.join("\n");
  for (const must of [data.doc.number, "Rechnungsdatum", "Leistungszeitraum", "Kundennummer", "K-00001", "Erika Muster", "Weg 1", "28195 Bremen", "Steuernummer 60/123/45678", "Nettobetrag", "19,00 %", "Rechnungsbetrag", data.doc.totals.gross, "Zahlbar bis", "Bitte überweisen Sie innerhalb der Frist.", "Fahrzeugmiete VW Crafter"]) {
    assert.ok(text.includes(must), `PDF enthält „${must}“`);
  }
  assert.ok(!text.includes("INTERN"), "interne Notiz nie im PDF");
  assert.ok(!text.includes("Kraftstoff"), "unbestätigter Vorschlag nie im PDF");
  assert.ok(pdf.bytes.subarray(0, 5).toString() === "%PDF-");

  // Archiv
  const res = await ensureInvoiceDocument(w.tenantId, inv.id, w.userId, { storage });
  assert.equal(res.created, true);
  assert.deepEqual([res.document.type, res.document.fileName, res.document.version, res.document.invoiceId], ["INVOICE", `Rechnung_${data.doc.number}.pdf`, 1, inv.id]);
  const again = await ensureInvoiceDocument(w.tenantId, inv.id, w.userId, { storage });
  assert.deepEqual([again.created, again.document.id], [false, res.document.id], "kein zweites Dokument");
  const file = await readDocumentFile(w.tenantId, res.document.id, storage);
  assert.ok(file && file.body.length > 1000);
  assert.equal(await readDocumentFile("fremd", res.document.id, storage), null, "anderer Mandant sieht das Dokument nicht");

  // E-Mail: automatisch genau einmal, Anhang = archiviertes PDF
  const transport = new FakeTransport();
  const first = await sendInvoiceDocument(w.tenantId, inv.id, { trigger: "AUTO", storage, transport });
  assert.equal(first.status, "SENT");
  const dup = await sendInvoiceDocument(w.tenantId, inv.id, { trigger: "AUTO", storage, transport });
  assert.equal(dup.status, "DUPLICATE");
  assert.equal(transport.sent.length, 1);
  const m = transport.sent[0];
  assert.equal(m.to, "erika@example.test");
  assert.match(m.subject, new RegExp(`Rechnung ${data.doc.number}`));
  assert.ok(m.text.includes(data.doc.totals.gross) && !m.text.includes("INTERN"));
  assert.deepEqual(m.attachments.map((a) => a.filename), [`Rechnung_${data.doc.number}.pdf`]);
  assert.equal(m.attachments[0].content.length, file!.body.length);
  const logs = await db.emailLog.findMany({ where: { tenantId: w.tenantId, invoiceId: inv.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(logs.map((l) => [l.template, l.status, l.trigger, l.attemptNo]), [["INVOICE", "SENT", "AUTO", 1]]);

  // manuell erneut senden: nonce einmalig; Ausfall wird protokolliert und wirft nicht
  const nonce = "11111111-2222-3333-4444-555555555555";
  assert.equal((await sendInvoiceDocument(w.tenantId, inv.id, { trigger: "MANUAL", nonce, storage, transport })).status, "SENT");
  assert.equal((await sendInvoiceDocument(w.tenantId, inv.id, { trigger: "MANUAL", nonce, storage, transport })).status, "DUPLICATE");
  assert.equal(transport.sent.length, 2);
  transport.fail = new Error("SMTP down");
  const failed = await sendInvoiceDocument(w.tenantId, inv.id, { trigger: "MANUAL", nonce: "99999999-2222-3333-4444-555555555555", storage, transport });
  assert.equal(failed.status, "FAILED");
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "FINALIZED");

  // Nachbearbeitung als Ganzes: wirft nie, auch bei Speicherfehler
  const w2 = await world("inv-followup");
  const inv2 = await ensureInvoiceDraft(w2.tenantId, w2.bookingId, w2.actor);
  await finalizeInvoice(w2.tenantId, inv2.id, w2.actor);
  const broken = { ...storage, put: async () => { throw new Error("S3 down"); } } as StorageDriver;
  const f1 = await runInvoiceFollowUp(w2.tenantId, inv2.id, w2.userId, { storage: broken, transport: new FakeTransport() });
  assert.deepEqual([f1.invoiceDocument.ok, f1.email.status], [false, "SKIPPED"]);
  assert.equal(await db.document.count({ where: { invoiceId: inv2.id } }), 0);
  const t2 = new FakeTransport();
  const f2 = await runInvoiceFollowUp(w2.tenantId, inv2.id, w2.userId, { storage, transport: t2 });
  assert.deepEqual([f2.invoiceDocument.ok, f2.email.status, t2.sent.length], [true, "SENT", 1]);
  assert.deepEqual((await runInvoiceFollowUp(w2.tenantId, inv2.id, w2.userId, { storage, transport: t2 })).email.status, "DUPLICATE");
});
