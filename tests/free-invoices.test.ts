// Befehl 23.1: Freie Rechnungen (kind GENERAL) mit optionalem Buchungsbezug und individuellem Zahlungsziel. Kein eigenes
// Rechnungssystem: dieselben Fassungen, Prüfungen, Nummern, Zahlungen, Gegenbelege, Forderungen, Mahnungen, PDFs und Mails.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { roleAllows } from "../src/lib/constants";
import { createCancellationDraft, createCreditNoteDraft, finalizeCounterDocument, invoiceFinancials, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { applyDepositOffset } from "../src/lib/deposit-offset";
import { offsetReturnOptions } from "../src/lib/deposit-offset-return";
import { recordDepositReceived } from "../src/lib/deposits";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { ensureInvoiceDocument } from "../src/lib/documents";
import { createDunningNotice, listReceivables, markDunningDelivered, previewDunning, receivableOf } from "../src/lib/dunning";
import { finalizeInvoiceWithDepositOffset } from "../src/lib/invoice-settlement";
import { invoiceHref } from "../src/lib/invoice-links";
import { createGeneralInvoiceDraft, finalizeInvoice, getInvoiceState, updateInvoiceDraft } from "../src/lib/invoices";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { lineAmounts } from "../src/lib/money";
import { recordInvoicePayment } from "../src/lib/payments";
import { createPayout } from "../src/lib/payouts";
import { renderInvoicePdf } from "../src/lib/pdf/invoice-pdf";
import { sendInvoiceDocument } from "../src/lib/rental-mail";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { zonedPlusDays } from "../src/lib/time";
import { createWorld, purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-free-"));
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
/** Jetzt + n Berliner Kalendertage zur selben Uhrzeit (nicht n × 24 h, sonst kippt der Tag nachts über eine Zeitumstellung). */
const T = (days: number) => zonedPlusDays(new Date(), days);
const year = new Date().getFullYear();
let seq = 0;
const nonce = (p = "fr") => `${p}-${Date.now().toString(36)}-${++seq}-free`;
const dbRejects = (re: RegExp) => (e: unknown) => re.test(String((e as Error).message));
type W = Awaited<ReturnType<typeof returnedWorld>>;

async function world(label: string, term = 7) {
  await ready;
  const w = await returnedWorld(label, { customer: { email: "frei@example.test" } });
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { paymentTermDays: term } });
  return w;
}
/** Freie Rechnung über `gross` € (19 %) als Entwurf und optional abgeschlossen. */
async function free(w: W, opts: { gross?: string; bookingId?: string | null; term?: number | null; finalize?: boolean; items?: { description: string; quantity: string; unit: string; unitPrice: string; taxRate: string }[] } = {}) {
  const { invoice } = await createGeneralInvoiceDraft(w.tenantId, w.actor, { customerId: w.customerId, bookingId: opts.bookingId ?? null, nonce: nonce() });
  await updateInvoiceDraft(w.tenantId, invoice.id, w.actor, { items: opts.items ?? [{ description: "Sonderreinigung Innenraum", quantity: "1", unit: "pauschal", unitPrice: opts.gross ?? "100", taxRate: "19" }], ...(opts.term !== undefined ? { paymentTermDays: opts.term } : {}) });
  if (opts.finalize === false) return { invoiceId: invoice.id, number: null as string | null };
  await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  const number = (await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).number;
  return { invoiceId: invoice.id, number };
}
const pay = (w: W, invoiceId: string, amount: string) => recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount, method: "BANK_TRANSFER", paidAt: at });

test("1/3/4/5/6/8/9: freie Rechnung ohne Buchung – keine Dummy-Buchung, mehrere Positionen, Rundung wie immer, Standard-Zahlungsziel, versiegelte Fälligkeit, RE-Nummer", async () => {
  const w = await world("fr-basic", 7);
  const bookingsBefore = await db.booking.count({ where: { tenantId: w.tenantId } });
  const customer = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  const { invoice, created } = await createGeneralInvoiceDraft(w.tenantId, w.actor, { customerId: w.customerId, nonce: nonce() });
  assert.deepEqual([created, invoice.kind, invoice.documentType, invoice.status, invoice.bookingId, invoice.customerId, invoice.number], [true, "GENERAL", "INVOICE", "DRAFT", null, w.customerId, null]);
  const items = [
    { description: "Sonderreinigung", quantity: "1", unit: "pauschal", unitPrice: "59,50", taxRate: "19" },
    { description: "Ersatz Ladekabel", quantity: "2", unit: "Stk", unitPrice: "12,99", taxRate: "19" },
    { description: "Auslagen Parkgebühr", quantity: "1", unit: "pauschal", unitPrice: "4,20", taxRate: "0" },
  ];
  await updateInvoiceDraft(w.tenantId, invoice.id, w.actor, { items, taxNote: "Durchlaufender Posten" });
  const st = await getInvoiceState(w.tenantId, invoice.id);
  const mode = st.draft!.pricesIncludeTax ? "GROSS" : "NET";
  for (const it of st.draft!.items) {
    const exp = lineAmounts(mode, Math.round(Number(it.quantity) * 100), Math.round(Number(it.unitPrice) * 100), Math.round(Number(it.taxRate) * 100));
    assert.deepEqual([Math.round(Number(it.netAmount) * 100), Math.round(Number(it.taxAmount) * 100), Math.round(Number(it.grossAmount) * 100)], [exp.net, exp.tax, exp.gross], `Position ${it.description}: dieselbe Berechnung wie alle Rechnungen`);
  }
  assert.equal(st.draft!.paymentTermDays, 7, "Standard-Zahlungsziel aus den Einstellungen");
  const v = await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  assert.match(inv.number!, new RegExp(`^RE-${year}-\\d{6}$`));
  assert.deepEqual([inv.status, inv.bookingId, v.status, v.paymentTermDays], ["FINALIZED", null, "FINALIZED", 7]);
  assert.equal(v.paymentDueDate!.getTime(), zonedPlusDays(v.finalizedAt!, 7).getTime(), "Fälligkeit = Abschluss + Zahlungsziel in Berliner Kalendertagen, versiegelt");
  const snap = v.customerSnapshot as { lastName: string; street: string | null; number: string | null };
  assert.deepEqual([snap.lastName, snap.street, snap.number], [customer.lastName, customer.street, customer.number], "Rechnungsempfänger aus dem Kundenstamm, versiegelt");
  await db.customer.update({ where: { id: w.customerId }, data: { street: "Neue Straße 99" } });
  assert.equal(((await db.invoiceVersion.findUniqueOrThrow({ where: { id: v.id } })).customerSnapshot as { street: string }).street, customer.street, "spätere Kundenänderung ändert die Rechnung nicht");
  assert.equal(await db.booking.count({ where: { tenantId: w.tenantId } }), bookingsBefore, "keine Dummy-Buchung");
  await assert.rejects(() => updateInvoiceDraft(w.tenantId, invoice.id, w.actor, { items, paymentTermDays: 30 }), /Entwurf|abgeschlossen/i, "nach dem Abschluss kein normales Ändern des Zahlungsziels");
  assert.equal(invoiceHref(inv), `/rechnungen/${inv.id}`);
});

test("7/8/10: individuelles Zahlungsziel nur für diese Rechnung, sofort fällig (überfällig ab Folgetag), ohne Zahlungsziel keine Mahnung; erscheint in der Rechnungsübersicht", async () => {
  const w = await world("fr-term", 7);
  const a = await free(w, { term: 3 });
  const b = await free(w);
  const c = await free(w, { term: 0 });
  const d = await free(w, { term: null });
  const due = async (id: string) => (await db.invoice.findUniqueOrThrow({ where: { id }, include: { currentVersion: true } })).currentVersion!;
  const [va, vb, vc, vd] = [await due(a.invoiceId), await due(b.invoiceId), await due(c.invoiceId), await due(d.invoiceId)];
  assert.deepEqual([va.paymentTermDays, vb.paymentTermDays, vc.paymentTermDays, vd.paymentTermDays, vd.paymentDueDate], [3, 7, 0, null, null]);
  assert.equal((await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } })).paymentTermDays, 7, "Geschäftsregel bleibt unverändert");
  assert.equal((await receivableOf(w.tenantId, c.invoiceId))!.status, "NOT_DUE", "sofort fällig: am Fälligkeitstag noch nicht überfällig");
  assert.equal((await receivableOf(w.tenantId, c.invoiceId, { now: T(1) }))!.status, "OVERDUE", "ab dem Folgetag überfällig");
  assert.equal((await receivableOf(w.tenantId, d.invoiceId, { now: T(60) }))!.status, "NO_DUE_DATE");
  // Rechnungsübersicht (gleiche Abfrage wie /rechnungen): freie Rechnungen erscheinen mit Fälligkeit
  const listed = await db.invoice.findMany({ where: { tenantId: w.tenantId, status: "FINALIZED", documentType: "INVOICE", kind: "GENERAL" }, select: { id: true, currentVersion: { select: { paymentDueDate: true } } } });
  assert.equal(listed.length, 4);
  assert.ok(listed.find((r) => r.id === a.invoiceId)!.currentVersion!.paymentDueDate, "Spalte Fällig hat ein Datum");
});

test("2/3: mit optionalem Buchungsbezug – nur Zuordnung: keine Mietpositionen, Buchung und Kaution unverändert; Buchung muss zum Kunden gehören (Code und DB)", async () => {
  const w = await world("fr-booking");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const snapshot = async () => { const b = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } }); const d = await db.securityDeposit.findFirstOrThrow({ where: { bookingId: w.bookingId }, include: { events: true } }); return [b.status, b.updatedAt.getTime(), d.status, d.events.length]; };
  const before = await snapshot();
  const r = await free(w, { bookingId: w.bookingId, gross: "80" });
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: r.invoiceId }, include: { currentVersion: { include: { items: true } } } });
  assert.deepEqual([inv.bookingId, inv.kind, inv.contractId, inv.currentVersion!.items.length, inv.currentVersion!.items[0].source], [w.bookingId, "GENERAL", null, 1, "MANUAL"]);
  assert.deepEqual(await snapshot(), before, "Buchung und Kaution unverändert");
  assert.equal(invoiceHref(inv), `/rechnungen/${inv.id}`, "freie Rechnung immer unter /rechnungen");
  // Buchung eines anderen Kunden desselben Mandanten
  const other = await db.customer.create({ data: { tenantId: w.tenantId, firstName: "Max", lastName: "Andere", street: "Weg 1", zip: "28195", city: "Bremen" } });
  await assert.rejects(() => createGeneralInvoiceDraft(w.tenantId, w.actor, { customerId: other.id, bookingId: w.bookingId, nonce: nonce() }), /gehört nicht zu diesem Kunden/);
  await assert.rejects(() => db.invoice.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, customerId: other.id, kind: "GENERAL" } }), dbRejects(/RB_DOMAIN: Die Buchung gehört nicht/));
});

test("11/12/13/14/15/16/17: Forderung, Teilzahlung, Vollzahlung, Gutschrift, Mahnwesen (Zahlungserinnerung, keine übersprungene Stufe, Gebühr ohne Buchung)", async () => {
  const w = await world("fr-claim", 7);
  await db.tenant.update({ where: { id: w.tenantId }, data: { dunningFeesEnabled: true, dunningFirstFeeCents: 500 } });
  const r = await free(w, { gross: "100" });
  const st = await getInvoiceState(w.tenantId, r.invoiceId);
  const itemId = st.current!.items[0].id;
  const open = async (now?: Date) => (await receivableOf(w.tenantId, r.invoiceId, { now }))!;
  assert.equal((await open()).principalOpenCents, 10_000, "100 € offen");
  assert.ok((await listReceivables(w.tenantId, { filter: "offen" })).rows.some((x) => x.invoiceId === r.invoiceId), "in Forderungen ohne Sonderlogik");
  const p30 = await pay(w, r.invoiceId, "30");
  assert.deepEqual([p30.payment.bookingId, p30.payment.type], [null, "INVOICE_PAYMENT"], "Zahlung ohne Buchung, bestehende Zahlungsart");
  assert.equal((await invoiceFinancials(w.tenantId, r.invoiceId)).openCents, 7_000, "Teilzahlung");
  const cn = await createCreditNoteDraft(w.tenantId, r.invoiceId, w.actor);
  assert.equal(cn.bookingId, null);
  await updateCounterDocumentDraft(w.tenantId, cn.id, w.actor, { items: [{ sourceItemId: itemId, mode: "AMOUNT", grossAmount: "20" }], reason: "Kulanz" });
  await finalizeCounterDocument(w.tenantId, cn.id, w.actor, { confirmed: true });
  assert.equal((await invoiceFinancials(w.tenantId, r.invoiceId)).openCents, 5_000, "Gutschrift 20 € mindert die Forderung");
  // Mahnwesen
  assert.equal((await open(T(8))).status, "OVERDUE");
  await assert.rejects(async () => { const p = await previewDunning(w.tenantId, r.invoiceId, { level: 2, now: T(8) }); return createDunningNotice(w.tenantId, w.actor, { invoiceId: r.invoiceId, level: 2, expectedTotalCents: p.totalCents, idempotencyKey: nonce("skip") }, { now: T(8) }); }, /nacheinander/);
  const p1 = await previewDunning(w.tenantId, r.invoiceId, { now: T(8) });
  const z = await createDunningNotice(w.tenantId, w.actor, { invoiceId: r.invoiceId, level: 1, expectedTotalCents: p1.totalCents, idempotencyKey: nonce("z") }, { now: T(8) });
  assert.deepEqual([z.notice.bookingId, z.notice.totalCents, z.notice.recipientEmail], [null, 5_000, "frei@example.test"]);
  await markDunningDelivered(w.tenantId, w.actor, z.notice.id, "Post");
  const p2 = await previewDunning(w.tenantId, r.invoiceId, { now: T(16) });
  const m1 = await createDunningNotice(w.tenantId, w.actor, { invoiceId: r.invoiceId, level: 2, expectedTotalCents: p2.totalCents, idempotencyKey: nonce("m1") }, { now: T(16) });
  const fee = await db.invoice.findUniqueOrThrow({ where: { id: m1.notice.feeInvoiceId! } });
  assert.deepEqual([fee.kind, fee.status, fee.bookingId, fee.customerId], ["DUNNING_FEE", "FINALIZED", null, w.customerId], "Mahngebühr auch ohne Buchung als eigene Rechnung");
  await pay(w, r.invoiceId, "50");
  await pay(w, fee.id, "5");
  assert.equal((await open(T(17))).status, "SETTLED", "Vollzahlung (inkl. Gebühr) erledigt die Forderung");
});

test("15b/Storno/Erstattung: Stornobeleg erledigt; Guthaben ohne Buchung wird über die bestehende Erstattung ausgezahlt", async () => {
  const w = await world("fr-storno");
  const a = await free(w, { gross: "100" });
  const c = await createCancellationDraft(w.tenantId, a.invoiceId, w.actor);
  await updateCounterDocumentDraft(w.tenantId, c.id, w.actor, { reason: "Leistung entfallen" });
  await finalizeCounterDocument(w.tenantId, c.id, w.actor, { confirmed: true });
  assert.deepEqual([(await invoiceFinancials(w.tenantId, a.invoiceId)).openCents, (await receivableOf(w.tenantId, a.invoiceId))!.status], [0, "SETTLED"]);
  const b = await free(w, { gross: "100" });
  await pay(w, b.invoiceId, "100");
  const item = (await getInvoiceState(w.tenantId, b.invoiceId)).current!.items[0].id;
  const cn = await createCreditNoteDraft(w.tenantId, b.invoiceId, w.actor);
  await updateCounterDocumentDraft(w.tenantId, cn.id, w.actor, { items: [{ sourceItemId: item, mode: "AMOUNT", grossAmount: "30" }], reason: "Teilerlass" });
  await finalizeCounterDocument(w.tenantId, cn.id, w.actor, { confirmed: true });
  const f = await invoiceFinancials(w.tenantId, b.invoiceId);
  assert.deepEqual([f.openCents, f.customerCreditCents], [0, 3_000], "Guthaben statt Forderung");
  const { payout } = await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId: b.invoiceId }, { amount: "30", method: "BANK_TRANSFER", iban: "DE02120300000000202051", executedAt: at, reference: "Erstattung" }, { complete: true, confirmed: true });
  assert.deepEqual([payout.status, payout.bookingId, payout.amountCents], ["COMPLETED", null, 3_000]);
});

test("25/16-Kaution: freie Rechnung ohne Buchung bietet keine Kautionsverrechnung (Code und DB)", async () => {
  const w = await world("fr-deposit");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const r = await free(w, { gross: "100" });
  const o = await offsetReturnOptions(w.tenantId, r.invoiceId);
  assert.equal(o.deposit.depositId, null, "keine Kaution ohne Buchungsbezug – auch nicht über denselben Kunden");
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId: r.invoiceId, amount: "50", occurredAt: at, idempotencyKey: nonce("off") }), /Buchung|nicht/);
  await assert.rejects(() => db.payment.create({ data: { tenantId: w.tenantId, bookingId: null, invoiceId: r.invoiceId, type: "DEPOSIT_OFFSET", method: "DEPOSIT_OFFSET", amountCents: 100, paidAt: at } }), dbRejects(/RB_DOMAIN: Ohne Buchungsbezug/));
  const d = await createGeneralInvoiceDraft(w.tenantId, w.actor, { customerId: w.customerId, nonce: nonce() });
  await updateInvoiceDraft(w.tenantId, d.invoice.id, w.actor, { items: [{ description: "Testposition", quantity: "1", unit: "pauschal", unitPrice: "10", taxRate: "19" }] });
  await assert.rejects(() => finalizeInvoiceWithDepositOffset(w.tenantId, d.invoice.id, w.actor, {}, { amount: "10", occurredAt: at, idempotencyKey: nonce("fo") }), /keinen Buchungsbezug/);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d.invoice.id } })).status, "DRAFT", "nichts abgeschlossen");
});

test("18/19: PDF neutral (keine Fahrzeugmiete, kein Vertrag), Archiv ohne Buchung, Mail über den bestehenden Versand", async () => {
  await ready;
  const w = await world("fr-pdf");
  const r = await free(w, { gross: "100" });
  const v = (await db.invoice.findUniqueOrThrow({ where: { id: r.invoiceId } })).currentVersionId!;
  const data = await loadInvoiceDocumentData(w.tenantId, v);
  const txt = (await renderInvoicePdf(data.doc)).trace.texts.join(" | ");
  assert.ok(txt.includes(`Rechnung ${r.number}`) && !/Fahrzeugmiete|Mietvertrag|Übergabe|Rückgabe|Kilometer/.test(txt), "neutrale Rechnung");
  const doc = await ensureInvoiceDocument(w.tenantId, v, w.actor.id, { storage });
  assert.deepEqual([doc.created, doc.document.bookingId, doc.document.invoiceVersionId], [true, null, v]);
  const t = new FakeTransport();
  const sent = await sendInvoiceDocument(w.tenantId, v, { trigger: "MANUAL", actorId: w.actor.id, nonce: "free-mail-nonce-1", transport: t, storage });
  assert.deepEqual([sent.status, sent.log.template, sent.log.bookingId, t.sent[0].to, t.sent[0].subject], ["SENT", "INVOICE", null, "frei@example.test", `Ihre Rechnung ${r.number}`]);
  assert.ok(!/Fahrzeug|Kennzeichen|Vertragsnummer/.test(t.sent[0].text), "Mailtext ohne Fahrzeugangaben");
  assert.equal((await sendInvoiceDocument(w.tenantId, v, { trigger: "MANUAL", actorId: w.actor.id, nonce: "free-mail-nonce-1", transport: t, storage })).status, "DUPLICATE");
});

test("23/24: Doppelklick legt einen Entwurf an; zwei Tabs finalisieren nur einmal (eine Nummer)", async () => {
  const w = await world("fr-race");
  const n = nonce("same");
  const [x, y] = await Promise.all([createGeneralInvoiceDraft(w.tenantId, w.actor, { customerId: w.customerId, nonce: n }), createGeneralInvoiceDraft(w.tenantId, w.actor, { customerId: w.customerId, nonce: n })]);
  assert.equal(x.invoice.id, y.invoice.id);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, kind: "GENERAL" } }), 1);
  await updateInvoiceDraft(w.tenantId, x.invoice.id, w.actor, { items: [{ description: "Zubehör", quantity: "1", unit: "Stk", unitPrice: "25", taxRate: "19" }] });
  const res = await Promise.allSettled([finalizeInvoice(w.tenantId, x.invoice.id, w.actor), finalizeInvoice(w.tenantId, x.invoice.id, w.actor)]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1, "zwei Tabs: nur ein Abschluss");
  const finals = await db.invoiceVersion.count({ where: { invoiceId: x.invoice.id, status: "FINALIZED" } });
  assert.equal(finals, 1);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, number: { not: null }, kind: "GENERAL" } }), 1, "eine Nummer");
});

test("20/21/22: Rollen, Supportmodus, Mandantentrennung (Code und DB)", async () => {
  const a = await world("fr-iso-a");
  const b = await createWorld("fr-iso-b");
  tenants.push(b.tenantId);
  await assert.rejects(() => createGeneralInvoiceDraft(a.tenantId, a.actor, { customerId: b.customerId, nonce: nonce() }), /Kunde nicht gefunden/);
  await assert.rejects(() => createGeneralInvoiceDraft(a.tenantId, a.actor, { customerId: a.customerId, bookingId: b.bookingId, nonce: nonce() }), /Buchung nicht gefunden/);
  await assert.rejects(() => db.invoice.create({ data: { tenantId: a.tenantId, customerId: b.customerId, kind: "GENERAL" } }), dbRejects(/RB_TENANT/));
  await assert.rejects(() => db.invoice.create({ data: { tenantId: a.tenantId, kind: "RENTAL", customerId: a.customerId } }), dbRejects(/rb_invoice_booking_or_customer|check/i), "ohne Buchung nur freie Rechnungen");
  const r = await free(a, { gross: "10" });
  await assert.rejects(() => recordInvoicePayment(b.tenantId, b.actor, { invoiceId: r.invoiceId, amount: "1", method: "CASH", paidAt: at }), /nicht gefunden/);
  assert.equal(await receivableOf(b.tenantId, r.invoiceId), null);
  assert.equal(roleAllows("YARD", ["DISPO"]), false);
  assert.equal(roleAllows("SUPER_ADMIN", ["DISPO"]), false);
  const actions = readFileSync(path.join(process.cwd(), "src/app/(app)/rechnungen/actions.ts"), "utf8");
  assert.match(actions, /export async function createFreeInvoiceAction[\s\S]*?requireRole\("DISPO"\)/);
  assert.match(actions, /export async function customerBookingsAction[\s\S]*?requireRole\("DISPO"\)/);
  const neu = readFileSync(path.join(process.cwd(), "src/app/(app)/rechnungen/neu/page.tsx"), "utf8");
  assert.match(neu, /requireRole\("DISPO"\)/, "Neue Rechnung nur Disposition/Inhaber (Supportmodus blockiert requireRole)");
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/rechnungen/[id]/page.tsx"), "utf8");
  assert.match(page, /requireRole\("DISPO", "YARD"\)/);
  assert.match(page, /const canEdit = user\.role !== "YARD"/);
  const list = readFileSync(path.join(process.cwd(), "src/app/(app)/rechnungen/page.tsx"), "utf8");
  assert.match(list, /user\.role !== "YARD" && <Link href="\/rechnungen\/neu"/, "Knopf „+ Neue Rechnung“ nicht für Hof/Support");
});

test("26/27/28/29: bestehende Mietrechnung, Mahngebühr und Kautionsverrechnung unverändert an der Buchung; Rechnungen ohne Zahlungsziel bleiben ohne Fälligkeit", async () => {
  const w = await world("fr-regress");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const { ensureInvoiceDraft } = await import("../src/lib/invoices");
  const rent = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const stt = await getInvoiceState(w.tenantId, rent.id);
  await updateInvoiceDraft(w.tenantId, rent.id, w.actor, { items: [{ id: stt.draft!.items[0].id, description: stt.draft!.items[0].description, quantity: "1", unit: "pauschal", unitPrice: "140", taxRate: "19" }], paymentTermDays: null });
  const res = await finalizeInvoiceWithDepositOffset(w.tenantId, rent.id, w.actor, {}, { amount: "140", occurredAt: at, idempotencyKey: nonce("rent") });
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: rent.id }, include: { currentVersion: true } });
  assert.deepEqual([inv.kind, inv.bookingId, inv.currentVersion!.paymentDueDate, res.offset.payment.bookingId], ["RENTAL", w.bookingId, null, w.bookingId], "Mietrechnung an der Buchung, Verrechnung an der Kaution der Buchung");
  assert.equal(invoiceHref(inv), `/buchungen/${w.bookingId}/rechnung?nr=${inv.id}`, "bisherige Adresse unter der Buchung");
  assert.equal((await receivableOf(w.tenantId, rent.id, { now: T(30) }))!.status, "SETTLED");
});
