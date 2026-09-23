// Steuersemantik der Schadenabrechnung: echter Schadensersatz ist „nicht steuerbar“ (kein Steuersatz, kein USt-Ausweis),
// steuerpflichtiges Entgelt folgt der normalen Umsatzsteuerlogik. Die Behandlung ist Teil jeder versiegelten Fassung;
// spätere Einstellungsänderungen des Mandanten ändern nichts. Normale 0-%-Positionen der Mietrechnung bleiben wie bisher.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { chargeCustomer, openDamageCase, setLiability } from "../src/lib/damage-cases";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { ensureInvoiceDraft, finalizeInvoice, getInvoiceState, startInvoiceEdit, updateInvoiceDraft, verifyInvoice } from "../src/lib/invoices";
import { toCents } from "../src/lib/money";
import { renderInvoicePdf } from "../src/lib/pdf/invoice-pdf";
import { purgeTenants } from "./helpers";
import { returnedWorld, type ReturnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => { await purgeTenants(tenants); await db.$disconnect(); });

async function world(label: string) {
  const w = await returnedWorld(label);
  tenants.push(w.tenantId);
  return w;
}

async function chargedInvoice(w: ReturnedWorld, amount: string, taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" | "TAXABLE_SUPPLY") {
  const d = await db.damage.findFirstOrThrow({ where: { tenantId: w.tenantId, discoveredInHandoverId: w.returnId } });
  const { damageCase } = await openDamageCase(w.tenantId, d.id, w.actor);
  await setLiability(w.tenantId, damageCase.id, w.actor, "CUSTOMER_RESPONSIBILITY_CONFIRMED", "Mieter hat die Beschädigung bei Rückgabe eingeräumt");
  const { invoiceId } = await chargeCustomer(w.tenantId, damageCase.id, w.actor, { amount, basis: "Instandsetzung Heckklappe laut Werkstattrechnung 4711", taxTreatment });
  return invoiceId;
}

const pdfText = async (tenantId: string, versionId: string) => {
  const { doc } = await loadInvoiceDocumentData(tenantId, versionId);
  const pdf = await renderInvoicePdf(doc);
  assert.deepEqual(pdf.trace.boxes.filter((b) => b.overflow), [], "kein Text außerhalb des Satzspiegels");
  return { doc, text: pdf.trace.texts.join("\n") };
};

test("Echter Schadensersatz 1.000 €: nicht steuerbar, kein Umsatzsteuerausweis, Gesamtforderung 1.000 €, Hinweis auf dem Dokument", async () => {
  const w = await world("tax-nontaxable");
  const invoiceId = await chargedInvoice(w, "1.000,00", "NON_TAXABLE_DAMAGE_COMPENSATION");
  const st = await getInvoiceState(w.tenantId, invoiceId);
  assert.equal(st.draft?.taxTreatment, "NON_TAXABLE_DAMAGE_COMPENSATION", "Behandlung liegt in der Fassung, nicht nur an der Rechnung");
  assert.equal(st.issues.filter((i) => i.severity === "error").length, 0, JSON.stringify(st.issues));
  const v1 = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  assert.equal(toCents(v1.grossTotal), 100_000);
  assert.equal(toCents(v1.netTotal), 100_000);
  assert.equal(toCents(v1.taxTotal), 0);
  assert.equal(v1.taxTreatment, "NON_TAXABLE_DAMAGE_COMPENSATION");
  const { doc, text } = await pdfText(w.tenantId, v1.id);
  assert.equal(doc.nonTaxable, true);
  assert.equal(doc.taxTreatmentLabel, "Echter Schadensersatz – nicht steuerbar");
  assert.deepEqual(doc.taxSummary, [], "keine Steuerzeile");
  assert.equal(doc.items[0].taxRate, "–", "Position trägt keinen Steuersatz");
  assert.equal(doc.hasZeroRate, false, "wird nicht als 0-%-Sachverhalt geführt");
  assert.match(doc.taxTreatmentNote ?? "", /nicht steuerbar/);
  assert.match(doc.taxTreatmentNote ?? "", /Abschn\. 1\.3 UStAE/);
  assert.ok(text.includes("Gesamtforderung") && text.includes("1.000,00"), "Gesamtforderung auf dem PDF");
  assert.ok(text.includes("Echter Schadensersatz – nicht steuerbar"), "Hinweis zur gewählten Behandlung auf dem PDF");
  assert.ok(!/0,00\s?%/.test(text) && !text.includes("MwSt") && !text.includes("USt. auf") && !text.includes("Nettobetrag"), "kein irreführender 0-%-Steuerausweis");
  assert.equal((await verifyInvoice(w.tenantId, invoiceId)).intact, true);
});

test("Steuerpflichtiges Entgelt 1.190 € brutto: Netto 1.000 €, Umsatzsteuer 190 €, Brutto 1.190 € mit normaler Steuerdarstellung", async () => {
  const w = await world("tax-taxable");
  const invoiceId = await chargedInvoice(w, "1.190,00", "TAXABLE_SUPPLY");
  const v1 = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  assert.equal(toCents(v1.netTotal), 100_000);
  assert.equal(toCents(v1.taxTotal), 19_000);
  assert.equal(toCents(v1.grossTotal), 119_000);
  assert.equal(v1.taxTreatment, "TAXABLE_SUPPLY");
  const { doc, text } = await pdfText(w.tenantId, v1.id);
  assert.equal(doc.nonTaxable, false);
  assert.equal(doc.taxSummary.length, 1);
  assert.equal(doc.taxSummary[0].rate, "19,00 %");
  assert.equal(doc.items[0].taxRate, "19,00 %");
  assert.ok(text.includes("zzgl. 19,00 % USt.") && text.includes("Nettobetrag") && text.includes("Rechnungsbetrag"), "normale Steuerdarstellung");
  assert.ok(text.includes("Steuerliche Behandlung: Steuerpflichtiges Entgelt"), "Einordnung auf dem PDF genannt");
  assert.equal(doc.taxTreatmentNote, null, "kein Schadensersatz-Hinweis bei steuerpflichtigem Entgelt");
});

test("Normale Mietrechnung mit 0-%-Position: bisheriges Verhalten (Steuerhinweis Pflicht, 0,00 % ausgewiesen, keine Behandlung)", async () => {
  const w = await world("tax-rental-zero");
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const st = await getInvoiceState(w.tenantId, inv.id);
  const items = st.draft!.items.map((i) => ({ id: i.id, description: i.description, quantity: String(Number(i.quantity)), unit: i.unit as "pauschal", unitPrice: String(Number(i.unitPrice)), taxRate: "0" }));
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items, taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" }), /nur bei Schadenabrechnungen/);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items, taxNote: "" });
  assert.ok((await getInvoiceState(w.tenantId, inv.id)).issues.some((i) => i.code === "TAX_NOTE"), "0 % ohne Hinweis bleibt blockiert");
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items, taxNote: "Steuerfreie Leistung gemäß § 4 UStG (Beispiel)" });
  const v1 = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  assert.equal(v1.taxTreatment, null, "Mietrechnung führt keine Schadensersatz-Behandlung");
  assert.equal(toCents(v1.taxTotal), 0);
  const { doc, text } = await pdfText(w.tenantId, v1.id);
  assert.equal(doc.nonTaxable, false);
  assert.equal(doc.hasZeroRate, true);
  assert.ok(doc.taxSummary.some((t) => t.rate === "0,00 %"), "0 % wird als Steuerzeile ausgewiesen");
  assert.ok(text.includes("0,00 % USt. auf") && text.includes("§ 4 UStG"), "0-%-Zeile und Steuerhinweis wie bisher");
});

test("Mandanten-Steuereinstellungen nach dem Abschluss geändert: Schadenabrechnung und Dokument unverändert", async () => {
  const w = await world("tax-settings");
  const invoiceId = await chargedInvoice(w, "1.000,00", "NON_TAXABLE_DAMAGE_COMPENSATION");
  const v1 = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  const before = JSON.stringify((await loadInvoiceDocumentData(w.tenantId, v1.id)).doc);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 7, pricesIncludeTax: false, taxNote: "Geänderter Hinweis" } });
  const row = await db.invoiceVersion.findUniqueOrThrow({ where: { id: v1.id } });
  assert.equal(row.taxTreatment, "NON_TAXABLE_DAMAGE_COMPENSATION");
  assert.equal(toCents(row.grossTotal), 100_000);
  assert.equal(toCents(row.taxTotal), 0);
  assert.equal(JSON.stringify((await loadInvoiceDocumentData(w.tenantId, v1.id)).doc), before, "Dokumentdaten identisch");
  assert.equal((await verifyInvoice(w.tenantId, invoiceId)).intact, true, "Prüfsumme unverändert gültig");
  // Die Behandlung ist unveränderlicher Bestandteil der abgeschlossenen Fassung
  await assert.rejects(() => db.invoiceVersion.update({ where: { id: v1.id }, data: { taxTreatment: "TAXABLE_SUPPLY" } }), /RB_IMMUTABLE/);
});

test("Fassung 2 übernimmt die Behandlung aus Fassung 1; bewusste Änderung auf steuerpflichtiges Entgelt rechnet neu und erscheint in der Differenz", async () => {
  const w = await world("tax-versions");
  const invoiceId = await chargedInvoice(w, "1.000,00", "NON_TAXABLE_DAMAGE_COMPENSATION");
  await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  const d2 = await startInvoiceEdit(w.tenantId, invoiceId, w.actor);
  assert.equal(d2.taxTreatment, "NON_TAXABLE_DAMAGE_COMPENSATION", "Fassung 2 startet mit der Behandlung der Fassung 1");
  const item = (rate: string, price: string) => [{ id: d2.items[0].id, description: d2.items[0].description, quantity: "1", unit: "pauschal" as const, unitPrice: price, taxRate: rate }];
  // Speichern ohne Angabe: Behandlung bleibt; ein eingegebener Steuersatz wird bei echtem Schadensersatz nicht übernommen
  const saved = await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, { items: item("19", "1000") });
  assert.equal(saved.taxTreatment, "NON_TAXABLE_DAMAGE_COMPENSATION");
  assert.equal(toCents(saved.taxTotal), 0);
  assert.equal(toCents(saved.grossTotal), 100_000);
  // Bewusste Änderung: steuerpflichtiges Entgelt mit 19 % (Bruttopreise laut Mandant)
  const changed = await updateInvoiceDraft(w.tenantId, invoiceId, w.actor, { items: item("19", "1190"), taxTreatment: "TAXABLE_SUPPLY" });
  assert.equal(changed.taxTreatment, "TAXABLE_SUPPLY");
  assert.equal(toCents(changed.netTotal), 100_000);
  assert.equal(toCents(changed.taxTotal), 19_000);
  assert.equal(toCents(changed.grossTotal), 119_000);
  const v2 = await finalizeInvoice(w.tenantId, invoiceId, w.actor);
  assert.equal(v2.versionNo, 2);
  const diff = v2.diffFromPrevious as { entries: { field: string; before: string | null; after: string | null }[] };
  const entry = diff.entries.find((e) => e.field === "taxTreatment");
  assert.ok(entry, "Differenz nennt die geänderte steuerliche Behandlung");
  assert.equal(entry!.before, "Echter Schadensersatz – nicht steuerbar");
  assert.equal(entry!.after, "Steuerpflichtiges Entgelt – mit Umsatzsteuer");
  const v1 = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId, versionNo: 1 } });
  assert.equal(v1.taxTreatment, "NON_TAXABLE_DAMAGE_COMPENSATION", "Fassung 1 bleibt wie versiegelt");
  const { doc } = await pdfText(w.tenantId, v2.id);
  assert.equal(doc.nonTaxable, false);
  assert.equal(doc.taxSummary[0].rate, "19,00 %");
  const log = (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).changeLog as { summary: string }[];
  assert.ok(log.some((l) => l.summary.includes("Steuerliche Behandlung: Steuerpflichtiges Entgelt")), "Änderung protokolliert");
});
