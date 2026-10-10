// Befehl 23: Mahnwesen und Forderungsmanagement. Offene Forderung ausschließlich aus der zentralen Summierung; Stufen
// nacheinander, nichts automatisch; Mahngebühr als eigene Gebührenrechnung; Mahnschreiben unveränderlich (Snapshot).
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { DUNNING_LEVELS, depositStatusLabel, roleAllows } from "../src/lib/constants";
import { createCancellationDraft, createCreditNoteDraft, finalizeCounterDocument, invoiceFinancials, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { applyDepositOffset, cancelDepositOffset } from "../src/lib/deposit-offset";
import { returnOffsetToDeposit } from "../src/lib/deposit-offset-return";
import { recordDepositReceived } from "../src/lib/deposits";
import { ensureDunningDocument } from "../src/lib/documents";
import { buildDunningDocument, loadDunningDocumentData } from "../src/lib/dunning-document";
import { sendDunningNotice } from "../src/lib/dunning-mail";
import { createDunningNotice, deriveReceivable, listReceivables, markDunningDelivered, previewDunning, receivableOf, receivablesSummary, updateDunningSettings, validateDunningSettings, type DunningSnapshot } from "../src/lib/dunning";
import { DomainError } from "../src/lib/integrity";
import { ensureInvoiceDraft, finalizeInvoice, getInvoiceState, updateInvoiceDraft } from "../src/lib/invoices";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { cancelPayment, recordInvoicePayment } from "../src/lib/payments";
import { createPayout } from "../src/lib/payouts";
import { renderDunningPdf } from "../src/lib/pdf/dunning-pdf";
import { renderInvoicePdf } from "../src/lib/pdf/invoice-pdf";
import { loadInvoiceDocumentData } from "../src/lib/document-data";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { parseLocalDateTime, toDateInputValue, zonedDayStartPlus, zonedDaysBetween, zonedParts, zonedPlusDays } from "../src/lib/time";
import { purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-dunning-"));
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
let keySeq = 0;
const key = (p = "k") => `${p}-${Date.now().toString(36)}-${++keySeq}-dunning`;
const dbRejects = (re: RegExp) => (e: unknown) => re.test(String((e as Error).message));

type W = Awaited<ReturnType<typeof returnedWorld>>;
/** Abgeschlossene Mietrechnung über `gross` € (19 %), Zahlungsziel `term` Tage (Standard 14). */
async function billed(label: string, opts: { gross?: string; term?: number | null; fees?: boolean; firstFee?: number; secondFee?: number; email?: string | null } = {}) {
  await ready;
  const w = await returnedWorld(label, opts.email === undefined ? {} : { customer: { email: opts.email } });
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { paymentTermDays: opts.term === undefined ? 14 : opts.term, dunningFeesEnabled: !!opts.fees, dunningFirstFeeCents: opts.firstFee ?? 500, dunningSecondFeeCents: opts.secondFee ?? 1000 } });
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const st = await getInvoiceState(w.tenantId, inv.id);
  await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: st.draft!.items[0].id, description: st.draft!.items[0].description, quantity: "1", unit: "pauschal", unitPrice: opts.gross ?? "500", taxRate: "19" }], ...(opts.term === null ? { paymentTermDays: null } : {}) });
  const v1 = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  const number = (await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).number!;
  return { w, invoiceId: inv.id, itemId: v1.items[0].id, number };
}
const pay = (w: W, invoiceId: string, amount: string) => recordInvoicePayment(w.tenantId, w.actor, { invoiceId, amount, method: "CASH", paidAt: at });
async function credit(w: W, invoiceId: string, itemId: string, amount: string) {
  const cn = await createCreditNoteDraft(w.tenantId, invoiceId, w.actor);
  await updateCounterDocumentDraft(w.tenantId, cn.id, w.actor, { items: [{ sourceItemId: itemId, mode: "AMOUNT", grossAmount: amount }], reason: "Kulanz" });
  await finalizeCounterDocument(w.tenantId, cn.id, w.actor, { confirmed: true });
}
/** Vorschau → Erstellen mit dem Vorschaubetrag (wie das Formular). */
async function issue(w: W, invoiceId: string, level: 1 | 2 | 3, now: Date, k = key()) {
  const p = await previewDunning(w.tenantId, invoiceId, { level, now });
  return createDunningNotice(w.tenantId, w.actor, { invoiceId, level, expectedTotalCents: p.totalCents, idempotencyKey: k }, { now });
}
const deliver = (w: W, id: string) => markDunningDelivered(w.tenantId, w.actor, id, "per Post");

test("Salden (1–5): Forderung = zentrale Summierung – Zahlung, Kautionsverrechnung und Gutschrift mindern; Restzahlung → erledigt", async () => {
  const { w, invoiceId, itemId } = await billed("dn-bal");
  const open = async () => { const r = (await receivableOf(w.tenantId, invoiceId, { now: T(15) }))!; const f = await invoiceFinancials(w.tenantId, invoiceId); assert.equal(r.principalOpenCents, f.openCents, "dieselbe Quelle wie die Rechnung"); return r; };
  assert.equal((await open()).principalOpenCents, 50_000);
  await pay(w, invoiceId, "100");
  assert.equal((await open()).principalOpenCents, 40_000);
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "200", occurredAt: at, idempotencyKey: key("off") });
  assert.equal((await open()).principalOpenCents, 20_000);
  await credit(w, invoiceId, itemId, "50");
  const r4 = await open();
  assert.deepEqual([r4.principalOpenCents, r4.totalOpenCents, r4.status], [15_000, 15_000, "OVERDUE"]);
  assert.equal((await previewDunning(w.tenantId, invoiceId, { now: T(15) })).totalCents, 15_000, "Mahnbetrag = aktuelle Restforderung");
  await pay(w, invoiceId, "150");
  const r5 = await open();
  assert.deepEqual([r5.principalOpenCents, r5.status, r5.next.kind], [0, "SETTLED", "NONE"]);
});

test("Salden (6–10): Guthaben statt Forderung, Rückführung/Auszahlung erzeugen keine Forderung, Stornos erhöhen korrekt", async () => {
  const { w, invoiceId, itemId } = await billed("dn-credit", { gross: "140" });
  await pay(w, invoiceId, "45");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const off = await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "95", occurredAt: at, idempotencyKey: key("off") });
  await credit(w, invoiceId, itemId, "80");
  const r = (await receivableOf(w.tenantId, invoiceId, { now: T(15) }))!;
  assert.deepEqual([r.principalOpenCents, r.totalOpenCents, r.status, r.financials.customerCreditCents], [0, 0, "SETTLED", 8_000], "Forderung 0, Guthaben 80 € – nie negativ");
  const p = await previewDunning(w.tenantId, invoiceId, { now: T(15) });
  assert.equal(p.allowed, false);
  assert.match(p.reason!, /Kundenguthaben/);
  await returnOffsetToDeposit(w.tenantId, w.actor, { invoiceId, paymentId: off.payment.id, amount: "40", occurredAt: at, idempotencyKey: key("ret") });
  assert.equal((await receivableOf(w.tenantId, invoiceId, { now: T(15) }))!.principalOpenCents, 0, "Rückführung zur Kaution erzeugt keine Forderung");
  await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId }, { amount: "40", method: "CASH", executedAt: at, receiptConfirmed: true }, { complete: true, confirmed: true });
  assert.equal((await receivableOf(w.tenantId, invoiceId, { now: T(15) }))!.principalOpenCents, 0, "Guthabenauszahlung erzeugt keine Forderung");

  const b = await billed("dn-storno");
  const p1 = await pay(b.w, b.invoiceId, "100");
  assert.equal((await receivableOf(b.w.tenantId, b.invoiceId))!.principalOpenCents, 40_000);
  await cancelPayment(b.w.tenantId, b.w.actor, p1.payment.id, "falsch erfasst");
  assert.equal((await receivableOf(b.w.tenantId, b.invoiceId))!.principalOpenCents, 50_000, "Zahlungsstorno erhöht die Forderung");
  await recordDepositReceived(b.w.tenantId, b.w.actor, { bookingId: b.w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const o2 = await applyDepositOffset(b.w.tenantId, b.w.actor, { bookingId: b.w.bookingId, invoiceId: b.invoiceId, amount: "300", occurredAt: at, idempotencyKey: key("off2") });
  assert.equal((await receivableOf(b.w.tenantId, b.invoiceId))!.principalOpenCents, 20_000);
  await cancelDepositOffset(b.w.tenantId, b.w.actor, o2.payment.id, "falsch verrechnet");
  assert.equal((await receivableOf(b.w.tenantId, b.invoiceId))!.principalOpenCents, 50_000, "Storno der Kautionsverrechnung erhöht die Forderung");
});

/** Nächste Zeitumstellung in Berlin nach `from`: letzter Sonntag im März (Beginn der Sommerzeit) bzw. im Oktober (Ende). */
function nextSwitch(from: Date, month: 3 | 10): Date {
  for (let y = from.getUTCFullYear(); ; y++) {
    const last = new Date(Date.UTC(y, month, 0));
    const sunday = new Date(Date.UTC(y, month - 1, last.getUTCDate() - last.getUTCDay(), 12));
    if (sunday > from) return sunday;
  }
}

test("Zeitumstellung: Mahnfrist zählt Berliner Kalendertage – Herbst 00:30 und Frühjahr 23:30, unabhängig von der Uhrzeit des Testlaufs", async () => {
  for (const [label, month, wall] of [["Herbst", 10, "00:30"], ["Frühjahr", 3, "23:30"]] as const) {
    const { w, invoiceId } = await billed(`dn-dst-${month}`);
    const due = (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { currentVersion: true } })).currentVersion!.paymentDueDate!;
    // drei Tage vor der nächsten Umstellung (nach der Fälligkeit), zur kritischen Uhrzeit: die Frist von 7 Tagen überspannt die Umstellung
    const day = zonedPlusDays(nextSwitch(zonedPlusDays(due, 5), month), -3);
    const now = parseLocalDateTime(`${toDateInputValue(day)}T${wall}`)!;
    await updateDunningSettings(w.tenantId, w.actor, { paymentTermDays: 14, reminderDays: 7, firstDays: 7, secondDays: 7, feesEnabled: false, firstFeeCents: 0, secondFeeCents: 0 });
    const n = await issue(w, invoiceId, 1, now);
    const deadline = n.notice.deadlineAt;
    assert.equal(zonedDaysBetween(now, deadline), 7, `${label}: Fristtag genau 7 Kalendertage nach dem ${toDateInputValue(now)} ${wall}, ist ${toDateInputValue(deadline)}`);
    assert.deepEqual([zonedParts(deadline).hour, zonedParts(deadline).minute], [zonedParts(now).hour, zonedParts(now).minute], `${label}: gleiche Uhrzeit am Fristtag`);
    assert.notEqual(deadline.getTime() - now.getTime(), 7 * 86_400_000, `${label}: die Frist überspannt die Umstellung (sonst prüft der Test nichts)`);
    // Fristablauf nach Kalendertag: am Fristtag läuft die Frist noch, ab dem Folgetag ist die nächste Stufe möglich
    await deliver(w, n.notice.id);
    const lastMinute = parseLocalDateTime(`${toDateInputValue(deadline)}T23:59`)!;
    assert.equal((await receivableOf(w.tenantId, invoiceId, { now: lastMinute }))!.next.kind, "WAIT_DEADLINE", `${label}: am Fristtag 23:59 läuft die Frist`);
    const following = (await receivableOf(w.tenantId, invoiceId, { now: zonedDayStartPlus(deadline, 1) }))!.next;
    assert.deepEqual([following.kind, following.kind === "CREATE" ? following.level : null], ["CREATE", 2], `${label}: am Folgetag 00:00 ist die 1. Mahnung möglich`);
  }
});

test("Fälligkeit (11–15): nicht fällig / überfällig / bezahlt; Teilzahlung vor Fälligkeit; Regeländerung wirkt nicht rückwirkend; ohne Zahlungsziel keine Mahnstufe", async () => {
  const { w, invoiceId } = await billed("dn-due");
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { currentVersion: true } });
  const due = inv.currentVersion!.paymentDueDate!;
  assert.equal(due.getTime(), zonedPlusDays(inv.currentVersion!.finalizedAt!, 14).getTime(), "Fälligkeit beim Abschluss versiegelt: 14 Berliner Kalendertage nach dem Abschluss");
  const r0 = (await receivableOf(w.tenantId, invoiceId))!;
  assert.deepEqual([r0.status, r0.daysOverdue, r0.next.kind], ["NOT_DUE", 0, "WAIT_DUE"]);
  await pay(w, invoiceId, "100");
  assert.deepEqual([(await receivableOf(w.tenantId, invoiceId))!.principalOpenCents, (await receivableOf(w.tenantId, invoiceId))!.status], [40_000, "NOT_DUE"], "Teilzahlung vor Fälligkeit");
  const r1 = (await receivableOf(w.tenantId, invoiceId, { now: T(16) }))!;
  assert.deepEqual([r1.status, r1.daysOverdue, r1.next.kind], ["OVERDUE", 2, "CREATE"]);
  // Geschäftsregel ändern: bestehende Rechnung behält ihre Fälligkeit
  await updateDunningSettings(w.tenantId, w.actor, { paymentTermDays: 3, reminderDays: 10, firstDays: 10, secondDays: 10, feesEnabled: true, firstFeeCents: 300, secondFeeCents: 600 });
  const inv2 = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { currentVersion: true } });
  assert.equal(inv2.currentVersion!.paymentDueDate!.getTime(), due.getTime());
  const n = await issue(w, invoiceId, 1, T(16));
  await updateDunningSettings(w.tenantId, w.actor, { paymentTermDays: 30, reminderDays: 3, firstDays: 3, secondDays: 3, feesEnabled: false, firstFeeCents: 0, secondFeeCents: 0 });
  const n2 = await db.dunningNotice.findUniqueOrThrow({ where: { id: n.notice.id } });
  assert.deepEqual([n2.deadlineDays, n2.deadlineAt.getTime(), n2.contentHash], [10, n.notice.deadlineAt.getTime(), n.notice.contentHash], "Mahnschreiben unverändert nach Regeländerung");
  // bezahlt nach Fälligkeit → nicht mehr im aktiven Mahnwesen
  await pay(w, invoiceId, "400");
  const open = await listReceivables(w.tenantId, { filter: "offen", now: T(16) });
  assert.equal(open.rows.some((r) => r.invoiceId === invoiceId), false);
  assert.equal((await listReceivables(w.tenantId, { filter: "erledigt", now: T(16) })).rows.some((r) => r.invoiceId === invoiceId), true, "erledigt mit Historie");
  // ohne Zahlungsziel: keine Fälligkeit, keine Mahnstufe, nichts rückwirkend festgelegt
  const x = await billed("dn-nodue", { term: null });
  const rx = (await receivableOf(x.w.tenantId, x.invoiceId, { now: T(60) }))!;
  assert.deepEqual([rx.dueDate, rx.status, rx.next.kind], [null, "NO_DUE_DATE", "NO_DUE_DATE"]);
  await assert.rejects(() => issue(x.w, x.invoiceId, 1, T(60)), /kein Fälligkeitsdatum/);
  assert.throws(() => validateDunningSettings({ paymentTermDays: 7, reminderDays: 0, firstDays: 7, secondDays: 7, feesEnabled: false, firstFeeCents: 0, secondFeeCents: 0 }), /zwischen 1 und 60/);
  assert.throws(() => validateDunningSettings({ paymentTermDays: 7, reminderDays: 7, firstDays: 7, secondDays: 7, feesEnabled: true, firstFeeCents: 10_001, secondFeeCents: 0 }), /100,00/);
});

test("Mahnstufen (16–23): Zahlungserinnerung → 1. → 2. Mahnung → weitere Bearbeitung; nichts übersprungen, nichts doppelt; Zahlung erledigt, Historie bleibt", async () => {
  const { w, invoiceId } = await billed("dn-levels");
  await assert.rejects(() => issue(w, invoiceId, 1, T(1)), /noch nicht überfällig/);
  await assert.rejects(() => issue(w, invoiceId, 2, T(15)), /nacheinander.*Zahlungserinnerung/);
  const z = await issue(w, invoiceId, 1, T(15));
  assert.match(z.notice.number, new RegExp(`^MA-${year}-000001$`));
  assert.deepEqual([z.created, z.notice.level, z.notice.totalCents, z.notice.feeCents, z.notice.feeInvoiceId], [true, 1, 50_000, 0, null]);
  await assert.rejects(() => issue(w, invoiceId, 1, T(15)), /bereits erstellt/);
  assert.equal((await receivableOf(w.tenantId, invoiceId, { now: T(15) }))!.status, "REMINDER_OPEN");
  await assert.rejects(() => issue(w, invoiceId, 2, T(30)), /noch nicht übermittelt/);
  await deliver(w, z.notice.id);
  const rs = (await receivableOf(w.tenantId, invoiceId, { now: T(16) }))!;
  assert.deepEqual([rs.status, rs.next.kind], ["REMINDER_SENT", "WAIT_DEADLINE"]);
  await assert.rejects(() => issue(w, invoiceId, 2, T(16)), /Frist der Zahlungserinnerung läuft/);
  const m1 = await issue(w, invoiceId, 2, T(23));
  assert.deepEqual([m1.notice.level, m1.notice.number], [2, `MA-${year}-000002`]);
  await deliver(w, m1.notice.id);
  await assert.rejects(() => issue(w, invoiceId, 3, T(24)), /Frist der 1. Mahnung läuft/);
  const m2 = await issue(w, invoiceId, 3, T(31));
  await deliver(w, m2.notice.id);
  assert.equal((await receivableOf(w.tenantId, invoiceId, { now: T(32) }))!.status, "SECOND_SENT");
  const rf = (await receivableOf(w.tenantId, invoiceId, { now: T(39) }))!;
  assert.deepEqual([rf.status, rf.next.kind], ["FURTHER_ACTION", "FURTHER_ACTION"]);
  const pf = await previewDunning(w.tenantId, invoiceId, { now: T(39) });
  assert.equal(pf.allowed, false);
  // DB: keine doppelte Stufe, keine übersprungene Stufe
  const base = await db.dunningNotice.findUniqueOrThrow({ where: { id: z.notice.id } });
  const { id: _id, ...clone } = base;
  void _id;
  await assert.rejects(() => db.dunningNotice.create({ data: { ...clone, snapshot: {}, number: `MA-${year}-999999`, idempotencyKey: key("dup") } }), dbRejects(/Unique constraint|unique/i));
  // vollständige Zahlung → erledigt, Historie bleibt
  await pay(w, invoiceId, "500");
  const done = (await receivableOf(w.tenantId, invoiceId, { now: T(40) }))!;
  assert.deepEqual([done.status, done.notices.map((n) => n.level)], ["SETTLED", [1, 2, 3]]);
  // Gutschrift auf 0 → erledigt, Historie bleibt
  const g = await billed("dn-credit0");
  const gz = await issue(g.w, g.invoiceId, 1, T(15));
  await credit(g.w, g.invoiceId, g.itemId, "500");
  const gd = (await receivableOf(g.w.tenantId, g.invoiceId, { now: T(16) }))!;
  assert.deepEqual([gd.status, gd.notices.length, gd.notices[0].number], ["SETTLED", 1, gz.notice.number]);
  // übersprungene Stufe direkt in der Datenbank
  const s = await billed("dn-skip");
  await assert.rejects(() => db.dunningNotice.create({ data: { tenantId: s.w.tenantId, invoiceId: s.invoiceId, bookingId: s.w.bookingId, level: 2, number: `MA-${year}-000077`, issuedAt: T(20), deadlineDays: 7, deadlineAt: T(27), principalOpenCents: 50_000, totalCents: 50_000, recipientName: "x", snapshot: {}, contentHash: "x", idempotencyKey: key("skip") } }), dbRejects(/nicht übersprungen/));
});

test("Historische Beträge (24–26) und Storno nach Mahnung (34): alte Schreiben bleiben, neue Stufe mit aktuellem Saldo", async () => {
  const { w, invoiceId, itemId } = await billed("dn-hist", { gross: "300" });
  const z = await issue(w, invoiceId, 1, T(15));
  assert.equal(z.notice.totalCents, 30_000);
  await deliver(w, z.notice.id);
  await pay(w, invoiceId, "100");
  const zAfter = await db.dunningNotice.findUniqueOrThrow({ where: { id: z.notice.id } });
  assert.deepEqual([zAfter.totalCents, zAfter.principalOpenCents, zAfter.contentHash], [30_000, 30_000, z.notice.contentHash], "historische Zahlungserinnerung bleibt 300 €");
  assert.equal((await receivableOf(w.tenantId, invoiceId, { now: T(23) }))!.principalOpenCents, 20_000);
  const m1 = await issue(w, invoiceId, 2, T(23));
  assert.equal(m1.notice.principalOpenCents, 20_000, "nächste Mahnung basiert auf 200 €");
  await credit(w, invoiceId, itemId, "50");
  assert.equal((await receivableOf(w.tenantId, invoiceId, { now: T(24) }))!.principalOpenCents, 15_000);
  assert.equal((await db.dunningNotice.findUniqueOrThrow({ where: { id: m1.notice.id } })).totalCents, 20_000, "1. Mahnung bleibt 200 €");
  // Stornobeleg nach Mahnung: Forderung 0, erledigt, Schreiben bleiben
  const c = await createCancellationDraft(w.tenantId, invoiceId, w.actor);
  await updateCounterDocumentDraft(w.tenantId, c.id, w.actor, { reason: "Miete storniert" });
  await finalizeCounterDocument(w.tenantId, c.id, w.actor, { confirmed: true });
  const r = (await receivableOf(w.tenantId, invoiceId, { now: T(40) }))!;
  assert.deepEqual([r.principalOpenCents, r.status, r.notices.length], [0, "SETTLED", 2]);
  assert.equal(await db.dunningNotice.count({ where: { invoiceId } }), 2);
});

test("Mahngebühren (27–34): aus → keine; Erinnerung nie; 1./2. Mahnung als eigene Gebührenrechnung (Finanzdaten), kein Doppel, Regeländerung ohne Wirkung", async () => {
  // Gebühren ausgeschaltet
  const off = await billed("dn-fee-off");
  const zo = await issue(off.w, off.invoiceId, 1, T(15)); await deliver(off.w, zo.notice.id);
  const mo = await issue(off.w, off.invoiceId, 2, T(23));
  assert.deepEqual([mo.notice.feeCents, mo.notice.feeInvoiceId, await db.invoice.count({ where: { tenantId: off.w.tenantId, kind: "DUNNING_FEE" } })], [0, null, 0]);

  const { w, invoiceId } = await billed("dn-fee", { fees: true, firstFee: 500, secondFee: 1000 });
  const z = await issue(w, invoiceId, 1, T(15));
  assert.equal(z.notice.feeCents, 0, "Zahlungserinnerung ohne Gebühr");
  await deliver(w, z.notice.id);
  const p = await previewDunning(w.tenantId, invoiceId, { now: T(23) });
  assert.deepEqual([p.level, p.principalOpenCents, p.feeCents, p.totalCents], [2, 50_000, 500, 50_500]);
  const k = key("fee-m1");
  const [a, b] = await Promise.all([
    createDunningNotice(w.tenantId, w.actor, { invoiceId, level: 2, expectedTotalCents: 50_500, idempotencyKey: k }, { now: T(23) }),
    createDunningNotice(w.tenantId, w.actor, { invoiceId, level: 2, expectedTotalCents: 50_500, idempotencyKey: k }, { now: T(23) }),
  ]);
  assert.deepEqual([[a.created, b.created].filter(Boolean).length, a.notice.id === b.notice.id], [1, true], "Doppelklick: ein Schreiben");
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, kind: "DUNNING_FEE" } }), 1, "Doppelklick: eine Gebühr");
  const fee = await db.invoice.findUniqueOrThrow({ where: { id: a.notice.feeInvoiceId! }, include: { currentVersion: { include: { items: true } } } });
  assert.deepEqual([fee.kind, fee.status, fee.documentType, fee.bookingId, Number(fee.currentVersion!.grossTotal), Number(fee.currentVersion!.items[0].taxRate), /^RE-/.test(fee.number!)], ["DUNNING_FEE", "FINALIZED", "INVOICE", w.bookingId, 5, 0, true]);
  assert.ok(fee.currentVersion!.paymentDueDate, "Gebühr mit Fälligkeit (Frist der Mahnung)");
  assert.equal((await invoiceFinancials(w.tenantId, fee.id)).openCents, 500, "Gebühr existiert in den Finanzdaten");
  const feePdf = await renderInvoicePdf((await loadInvoiceDocumentData(w.tenantId, fee.currentVersionId!)).doc);
  const feeTxt = feePdf.trace.texts.join(" | ");
  assert.ok(feeTxt.includes("Mahngebühr zur Vermietung") && !feeTxt.includes("Fahrzeugmiete") && feeTxt.includes("Mahngebühr ohne Umsatzsteuer"), "Gebührenrechnung als PDF mit eigenem Untertitel und 0 %-Hinweis");
  const orig = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { currentVersion: true } });
  assert.equal(Number(orig.currentVersion!.grossTotal), 500, "Originalrechnung unverändert");
  const r = (await receivableOf(w.tenantId, invoiceId, { now: T(23) }))!;
  assert.deepEqual([r.principalOpenCents, r.feesOpenCents, r.totalOpenCents], [50_000, 500, 50_500]);
  // Regeländerung: historische Gebühr unverändert
  await db.tenant.update({ where: { id: w.tenantId }, data: { dunningFirstFeeCents: 900 } });
  assert.equal((await db.dunningNotice.findUniqueOrThrow({ where: { id: a.notice.id } })).feeCents, 500);
  // Kunde zahlt 500 € auf die Rechnung → Rest 5 € Gebühr (keine Tilgungsreihenfolge; Zahlung gehört zur Rechnung)
  await pay(w, invoiceId, "500");
  const r2 = (await receivableOf(w.tenantId, invoiceId, { now: T(24) }))!;
  assert.deepEqual([r2.principalOpenCents, r2.feesOpenCents, r2.totalOpenCents, r2.status], [0, 500, 500, "FIRST_OPEN"]);
  // erneuter Versand: keine neue Gebühr, keine neue Stufe
  const t = new FakeTransport();
  await sendDunningNotice(w.tenantId, w.actor, a.notice.id, { nonce: "fee-send-1-nonce", transport: t, storage });
  await sendDunningNotice(w.tenantId, w.actor, a.notice.id, { nonce: "fee-send-2-nonce", transport: t, storage });
  assert.deepEqual([await db.invoice.count({ where: { tenantId: w.tenantId, kind: "DUNNING_FEE" } }), await db.dunningNotice.count({ where: { invoiceId } })], [1, 2]);
  // 2. Mahnung: Gebühr laut Regel, offene frühere Gebühr ist Teil der Gesamtforderung
  const p3 = await previewDunning(w.tenantId, invoiceId, { now: T(31) });
  assert.deepEqual([p3.level, p3.principalOpenCents, p3.priorFeesOpenCents, p3.feeCents, p3.totalCents], [3, 0, 500, 1000, 1500]);
  const m2 = await issue(w, invoiceId, 3, T(31));
  const snap = m2.notice.snapshot as unknown as DunningSnapshot;
  assert.deepEqual([snap.priorFees.length, snap.priorFees[0].openCents, snap.fee.cents], [1, 500, 1000]);
  // Gebühren bezahlt → erledigt
  await pay(w, a.notice.feeInvoiceId!, "5");
  await pay(w, m2.notice.feeInvoiceId!, "10");
  assert.equal((await receivableOf(w.tenantId, invoiceId, { now: T(32) }))!.status, "SETTLED");
  // Gebührenrechnungen selbst werden nicht gemahnt und nicht als eigene Forderung gelistet
  assert.equal(await receivableOf(w.tenantId, a.notice.feeInvoiceId!), null);
  // DB: Gebühr ohne Gebührenrechnung / Gebühr auf der Zahlungserinnerung wird abgelehnt
  const s = await billed("dn-fee-db");
  await assert.rejects(() => db.dunningNotice.create({ data: { tenantId: s.w.tenantId, invoiceId: s.invoiceId, bookingId: s.w.bookingId, level: 1, number: `MA-${year}-000088`, issuedAt: T(20), deadlineDays: 7, deadlineAt: T(27), principalOpenCents: 50_000, feeCents: 500, totalCents: 50_500, recipientName: "x", snapshot: {}, contentHash: "x", idempotencyKey: key("feedb") } }), dbRejects(/rb_dunning_fee_ref|check/i));
});

test("Nebenläufigkeit (35–41): zwei Tabs gleiche Stufe → eine; veraltete Vorschau nach Zahlung, Verrechnung, Gutschrift, Storno → nichts erstellt; parallel ohne veralteten Betrag", async () => {
  const { w, invoiceId, itemId } = await billed("dn-race");
  const [x, y] = await Promise.allSettled([
    createDunningNotice(w.tenantId, w.actor, { invoiceId, level: 1, expectedTotalCents: 50_000, idempotencyKey: key("tab1") }, { now: T(15) }),
    createDunningNotice(w.tenantId, w.actor, { invoiceId, level: 1, expectedTotalCents: 50_000, idempotencyKey: key("tab2") }, { now: T(15) }),
  ]);
  assert.equal([x, y].filter((r) => r.status === "fulfilled").length, 1, "zwei Tabs: eine gewinnt");
  const loser = [x, y].find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(loser.reason instanceof DomainError && /bereits erstellt/.test(loser.reason.message));
  assert.equal(await db.dunningNotice.count({ where: { invoiceId } }), 1);
  const z = (await db.dunningNotice.findFirstOrThrow({ where: { invoiceId } }));
  await deliver(w, z.id);
  // veraltete Vorschau: Zahlung
  const pv = await previewDunning(w.tenantId, invoiceId, { now: T(23) });
  await pay(w, invoiceId, "100");
  await assert.rejects(() => createDunningNotice(w.tenantId, w.actor, { invoiceId, level: 2, expectedTotalCents: pv.totalCents, idempotencyKey: key("stale-pay") }, { now: T(23) }), /geändert.*400,00/);
  // veraltete Vorschau: Kautionsverrechnung
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  const pv2 = await previewDunning(w.tenantId, invoiceId, { now: T(23) });
  await applyDepositOffset(w.tenantId, w.actor, { bookingId: w.bookingId, invoiceId, amount: "100", occurredAt: at, idempotencyKey: key("off") });
  await assert.rejects(() => createDunningNotice(w.tenantId, w.actor, { invoiceId, level: 2, expectedTotalCents: pv2.totalCents, idempotencyKey: key("stale-off") }, { now: T(23) }), /geändert/);
  // veraltete Vorschau: Gutschrift
  const pv3 = await previewDunning(w.tenantId, invoiceId, { now: T(23) });
  await credit(w, invoiceId, itemId, "50");
  await assert.rejects(() => createDunningNotice(w.tenantId, w.actor, { invoiceId, level: 2, expectedTotalCents: pv3.totalCents, idempotencyKey: key("stale-cn") }, { now: T(23) }), /geändert/);
  assert.equal(await db.dunningNotice.count({ where: { invoiceId } }), 1, "keine Mahnung mit veraltetem Betrag");
  // parallel: Mahnung und Zahlung – entweder Mahnung über den Stand vor der Zahlung oder Abbruch, nie ein veralteter Betrag
  const pv4 = await previewDunning(w.tenantId, invoiceId, { now: T(23) });
  const [mRes] = await Promise.allSettled([
    createDunningNotice(w.tenantId, w.actor, { invoiceId, level: 2, expectedTotalCents: pv4.totalCents, idempotencyKey: key("par") }, { now: T(23) }),
    pay(w, invoiceId, "20"),
  ]);
  const f = await invoiceFinancials(w.tenantId, invoiceId);
  if (mRes.status === "fulfilled") assert.equal(mRes.value.notice.principalOpenCents, pv4.totalCents, "Mahnung über den Stand bei Erstellung");
  else assert.match(String((mRes.reason as Error).message), /geändert/);
  assert.equal(f.openCents, pv4.totalCents - 2_000);
  // Storno nach Vorschau
  const s = await billed("dn-race-st");
  const ps = await previewDunning(s.w.tenantId, s.invoiceId, { now: T(15) });
  const c = await createCancellationDraft(s.w.tenantId, s.invoiceId, s.w.actor);
  await updateCounterDocumentDraft(s.w.tenantId, c.id, s.w.actor, { reason: "Miete storniert" });
  await assert.rejects(() => createDunningNotice(s.w.tenantId, s.w.actor, { invoiceId: s.invoiceId, level: 1, expectedTotalCents: ps.totalCents, idempotencyKey: key("st-draft") }, { now: T(15) }), /Stornoentwurf offen/);
  await finalizeCounterDocument(s.w.tenantId, c.id, s.w.actor, { confirmed: true });
  await assert.rejects(() => createDunningNotice(s.w.tenantId, s.w.actor, { invoiceId: s.invoiceId, level: 1, expectedTotalCents: ps.totalCents, idempotencyKey: key("st") }, { now: T(15) }), /ausgeglichen/);
});

test("Dokument und Mail (50–57): PDF mit damaligem Betrag, Frist, Stufe, Gebühr nur wenn wirksam; Versand, Duplikat, erneuter Versand mit demselben Dokument", async () => {
  const { w, invoiceId, number } = await billed("dn-doc", { fees: true, firstFee: 250, email: "kunde@example.test" });
  const z = await issue(w, invoiceId, 1, T(15));
  const t = new FakeTransport();
  const s1 = await sendDunningNotice(w.tenantId, w.actor, z.notice.id, { nonce: "dn-doc-nonce-1", transport: t, storage });
  assert.deepEqual([s1.status, s1.resend, s1.log.template, s1.log.dunningNoticeId, s1.log.trigger, t.sent[0].to, t.sent[0].subject, t.sent[0].attachments?.[0].filename], ["SENT", false, "DUNNING_NOTICE", z.notice.id, "MANUAL", "kunde@example.test", `Zahlungserinnerung ${z.notice.number} zu Rechnung ${number}`, `Zahlungserinnerung_${z.notice.number}.pdf`]);
  assert.equal((await sendDunningNotice(w.tenantId, w.actor, z.notice.id, { nonce: "dn-doc-nonce-1", transport: t, storage })).status, "DUPLICATE");
  assert.equal(t.sent.length, 1, "kein Doppelversand");
  const r = (await receivableOf(w.tenantId, invoiceId, { now: T(16) }))!;
  assert.deepEqual([r.status, r.notices[0].sentTo, r.notices[0].sendCount], ["REMINDER_SENT", "kunde@example.test", 1], "E-Mail-Versand zählt als Übermittlung");
  const doc1 = await db.document.findFirstOrThrow({ where: { dunningNoticeId: z.notice.id } });
  // nach Zahlung: PDF und Snapshot unverändert, erneuter Versand nutzt dasselbe Dokument
  await pay(w, invoiceId, "123");
  const again = await ensureDunningDocument(w.tenantId, z.notice.id, null, { storage });
  assert.deepEqual([again.created, again.document.id, again.document.checksum], [false, doc1.id, doc1.checksum]);
  const s2 = await sendDunningNotice(w.tenantId, w.actor, z.notice.id, { nonce: "dn-doc-nonce-2", transport: t, storage });
  assert.deepEqual([s2.status, s2.resend, (s2.log.attachments as { documentId: string }[])[0].documentId, t.sent.length], ["SENT", true, doc1.id, 2]);
  assert.deepEqual([await db.dunningNotice.count({ where: { invoiceId } }), await db.document.count({ where: { dunningNoticeId: z.notice.id } })], [1, 1], "keine neue Stufe, kein neues Dokument");
  const audits = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["DUNNING_REMINDER_CREATED", "DUNNING_SENT", "DUNNING_RESENT"] } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(audits.map((a) => a.action), ["DUNNING_REMINDER_CREATED", "DUNNING_SENT", "DUNNING_RESENT"]);
  const d0 = audits[0].details as Record<string, unknown>;
  assert.deepEqual([audits[0].invoiceId, audits[0].bookingId, audits[0].amountCents, d0.level, d0.number, d0.feeCents, typeof d0.deadlineAt, audits[0].userId], [invoiceId, w.bookingId, 50_000, 1, z.notice.number, 0, "string", w.actor.id]);
  assert.ok(!JSON.stringify(audits.map((a) => a.details)).includes("kunde@example.test"), "keine E-Mail-Adresse im Audit");
  // PDF-Inhalt aus dem Snapshot
  const data = await loadDunningDocumentData(w.tenantId, z.notice.id);
  const pdf1 = await renderDunningPdf(data.doc);
  const txt1 = pdf1.trace.texts.join(" | ");
  assert.ok(txt1.includes("Zahlungserinnerung") && txt1.includes(z.notice.number) && /500,00\s€/.test(txt1) && txt1.includes(data.doc.deadline), "Stufe, Nummer, damaliger Betrag, Frist");
  assert.ok(!/Mahngebühr/.test(txt1) && !/Inkasso|Anwalt|Gericht|Zinsen/i.test(txt1), "keine Gebühr auf der Erinnerung, keine Drohung");
  await deliver(w, z.notice.id);
  const m1 = await issue(w, invoiceId, 2, T(23));
  const d2 = await loadDunningDocumentData(w.tenantId, m1.notice.id);
  const txt2 = (await renderDunningPdf(d2.doc)).trace.texts.join(" | ");
  assert.ok(txt2.includes("1. Mahnung") && /Mahngebühr/.test(txt2) && /2,50\s€/.test(txt2) && /379,50\s€/.test(txt2), "Gebühr nur wenn wirksam; Gesamt 377 + 2,50");
  assert.equal(buildDunningDocument(d2.snapshot, "h").rows.some((r) => /bereits gezahlt/.test(r.label)), true);
  // ohne E-Mail-Adresse: klare Meldung, Versand per Post vermerken
  const p = await billed("dn-nomail", { email: null });
  const pz = await issue(p.w, p.invoiceId, 1, T(15));
  await assert.rejects(() => sendDunningNotice(p.w.tenantId, p.w.actor, pz.notice.id, { nonce: "dn-nomail-nonce", transport: t, storage }), /keine gültige E-Mail-Adresse/);
  await markDunningDelivered(p.w.tenantId, p.w.actor, pz.notice.id, "Brief");
  assert.equal((await receivableOf(p.w.tenantId, p.invoiceId, { now: T(16) }))!.status, "REMINDER_SENT");
});

test("Unveränderlichkeit und Mandantentrennung (39, 42–44, 48): kein Ändern/Löschen, fremde IDs blockiert (Code und DB)", async () => {
  const a = await billed("dn-iso-a");
  const b = await billed("dn-iso-b");
  const z = await issue(a.w, a.invoiceId, 1, T(15));
  await assert.rejects(() => db.dunningNotice.update({ where: { id: z.notice.id }, data: { totalCents: 1 } }), dbRejects(/RB_IMMUTABLE/));
  await assert.rejects(() => db.dunningNotice.delete({ where: { id: z.notice.id } }), dbRejects(/RB_IMMUTABLE/));
  await markDunningDelivered(a.w.tenantId, a.w.actor, z.notice.id, "Post");
  await assert.rejects(() => db.dunningNotice.update({ where: { id: z.notice.id }, data: { deliveredNote: "anders" } }), dbRejects(/RB_IMMUTABLE/));
  // fremder Mandant: Rechnung, Mahnschreiben, Versand, Vermerk, Übersicht
  assert.equal(await receivableOf(b.w.tenantId, a.invoiceId), null);
  await assert.rejects(() => previewDunning(b.w.tenantId, a.invoiceId, { now: T(15) }), /nicht gefunden/);
  await assert.rejects(() => createDunningNotice(b.w.tenantId, b.w.actor, { invoiceId: a.invoiceId, level: 2, expectedTotalCents: 50_000, idempotencyKey: key("foreign") }, { now: T(30) }), /nicht gefunden/);
  await assert.rejects(() => markDunningDelivered(b.w.tenantId, b.w.actor, z.notice.id, null), /nicht gefunden/);
  await assert.rejects(() => sendDunningNotice(b.w.tenantId, b.w.actor, z.notice.id, { nonce: "foreign-nonce-1", storage }), /nicht gefunden/);
  await assert.rejects(() => ensureDunningDocument(b.w.tenantId, z.notice.id, null, { storage }), /nicht gefunden/);
  assert.equal((await listReceivables(b.w.tenantId, { filter: "offen", now: T(15) })).rows.some((r) => r.invoiceId === a.invoiceId), false);
  assert.equal((await listReceivables(b.w.tenantId, { filter: "erinnerung", q: a.number, now: T(15) })).total, 0);
  // DB: fremde Rechnung / Buchung / Kunde / Gebührenrechnung
  const row = (over: Record<string, unknown>) => ({ tenantId: b.w.tenantId, invoiceId: b.invoiceId, bookingId: b.w.bookingId, level: 1, number: `MA-${year}-00${Math.floor(Math.random() * 9000 + 1000)}`, issuedAt: T(20), deadlineDays: 7, deadlineAt: T(27), principalOpenCents: 50_000, totalCents: 50_000, recipientName: "x", snapshot: {}, contentHash: "x", idempotencyKey: key("db"), ...over });
  await assert.rejects(() => db.dunningNotice.create({ data: row({ invoiceId: a.invoiceId }) as never }), dbRejects(/RB_TENANT/));
  await assert.rejects(() => db.dunningNotice.create({ data: row({ bookingId: a.w.bookingId }) as never }), dbRejects(/RB_DOMAIN|RB_TENANT/));
  await assert.rejects(() => db.dunningNotice.create({ data: row({ customerId: a.w.customerId }) as never }), dbRejects(/RB_TENANT/));
  const aFee = await billed("dn-iso-fee", { fees: true });
  const fz = await issue(aFee.w, aFee.invoiceId, 1, T(15)); await deliver(aFee.w, fz.notice.id);
  const fm = await issue(aFee.w, aFee.invoiceId, 2, T(23));
  await assert.rejects(() => db.dunningNotice.create({ data: row({ level: 2, feeInvoiceId: fm.notice.feeInvoiceId, feeCents: 500, totalCents: 50_500 }) as never }), dbRejects(/RB_TENANT|nicht übersprungen/));
  // Suche nach eigener Rechnung, Buchung, Kunde, Kundennummer
  const cust = await db.customer.findUniqueOrThrow({ where: { id: a.w.customerId } });
  for (const q of [a.number, (await db.booking.findUniqueOrThrow({ where: { id: a.w.bookingId } })).number, cust.lastName, cust.number ?? ""].filter(Boolean)) {
    assert.equal((await listReceivables(a.w.tenantId, { filter: "erinnerung", q, now: T(16) })).rows.some((r) => r.invoiceId === a.invoiceId), true, `Suche ${q}`);
  }
});

test("Rollen, Supportmodus, Plattform (38, 45–49): Mahnaktionen nur Disposition/Inhaber, Hof und Support lesen, keine Plattform-Finanzrechte", () => {
  assert.equal(roleAllows("YARD", ["DISPO"]), false, "Hofmitarbeiter darf nicht erstellen/senden");
  assert.equal(roleAllows("DISPO", ["DISPO"]), true);
  assert.equal(roleAllows("OWNER", ["DISPO"]), true);
  assert.equal(roleAllows("SUPER_ADMIN", ["DISPO"]), false, "Plattformrolle ist keine Mandantenrolle");
  const actions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rechnung/dunning-actions.ts"), "utf8");
  const mutating = ["createDunningAction", "sendDunningAction", "markDunningDeliveredAction", "previewDunningAction"];
  for (const name of mutating) assert.match(actions, new RegExp(`export async function ${name}[\\s\\S]*?requireRole\\("DISPO"\\)`), `${name} verlangt Disposition (Support-Sitzungen blockiert requireRole)`);
  const settings = readFileSync(path.join(process.cwd(), "src/app/(app)/einstellungen/geschaeftsregeln/actions.ts"), "utf8");
  assert.match(settings, /export async function updateDunningSettingsAction[\s\S]*?requireRole\("OWNER"\)/);
  const auth = readFileSync(path.join(process.cwd(), "src/lib/auth.ts"), "utf8");
  assert.match(auth, /export async function requireRole[\s\S]*?supportSession\) redirect/, "Supportmodus bleibt lesend");
  const card = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rechnung/dunning-card.tsx"), "utf8");
  assert.match(card, /canManage = role !== "YARD"/);
  assert.deepEqual(Object.values(DUNNING_LEVELS), ["Zahlungserinnerung", "1. Mahnung", "2. Mahnung"]);
});

test("Übersicht und Kennzahlen (24–26 Dashboard): Filter, Sortierung, Summen ohne Doppelzählung", async () => {
  const x = await billed("dn-list-a", { gross: "200" });
  const y = await billed("dn-list-b", { gross: "100" });
  const yz = await issue(y.w, y.invoiceId, 1, T(15)); void yz;
  const sx = await receivablesSummary(x.w.tenantId, T(15));
  assert.deepEqual([sx.open, sx.overdue, sx.openCents, sx.overdueCents, sx.reminder, sx.actionable.length], [1, 1, 20_000, 20_000, 0, 1]);
  const sy = await receivablesSummary(y.w.tenantId, T(15));
  assert.deepEqual([sy.open, sy.reminder, sy.actionable[0].next.kind], [1, 1, "DELIVER"]);
  // Gutschrift und Kautionsverrechnung zählen nicht doppelt
  await recordDepositReceived(x.w.tenantId, x.w.actor, { bookingId: x.w.bookingId, amount: "500", method: "CASH", occurredAt: at });
  await applyDepositOffset(x.w.tenantId, x.w.actor, { bookingId: x.w.bookingId, invoiceId: x.invoiceId, amount: "50", occurredAt: at, idempotencyKey: key("off") });
  await credit(x.w, x.invoiceId, x.itemId, "30");
  const sx2 = await receivablesSummary(x.w.tenantId, T(15));
  assert.equal(sx2.openCents, 12_000);
  const l = await listReceivables(x.w.tenantId, { filter: "ueberfaellig", sort: "betrag", now: T(15) });
  assert.deepEqual([l.total, l.rows[0].totalOpenCents, l.sums.openCents, l.sums.overdueCents], [1, 12_000, 12_000, 12_000]);
  assert.equal((await listReceivables(x.w.tenantId, { filter: "offen", now: T(1) })).rows[0].status, "NOT_DUE");
});

test("Ableitung (rein): Tagesgrenzen, Versand offen, Frist, weitere Bearbeitung, nie negativ", () => {
  const now = new Date("2026-10-20T10:00:00Z");
  const d = (s: string) => new Date(s);
  assert.equal(deriveReceivable({ principalOpenCents: 100, feesOpenCents: 0, dueDate: d("2026-10-20T08:00:00Z"), notices: [] }, now).status, "NOT_DUE", "am Fälligkeitstag noch nicht überfällig");
  assert.deepEqual(deriveReceivable({ principalOpenCents: 100, feesOpenCents: 0, dueDate: d("2026-10-19T08:00:00Z"), notices: [] }, now).status, "OVERDUE");
  assert.equal(deriveReceivable({ principalOpenCents: 0, feesOpenCents: 0, dueDate: d("2026-10-01T08:00:00Z"), notices: [] }, now).status, "SETTLED");
  assert.equal(deriveReceivable({ principalOpenCents: 0, feesOpenCents: 500, dueDate: d("2026-10-01T08:00:00Z"), notices: [{ id: "a", level: 2, delivered: true, deadlineAt: d("2026-10-25T08:00:00Z") }] }, now).status, "FIRST_SENT", "offene Gebühr hält den Vorgang offen");
  assert.equal(deriveReceivable({ principalOpenCents: 10, feesOpenCents: 0, dueDate: d("2026-10-01T08:00:00Z"), notices: [{ id: "a", level: 1, delivered: false, deadlineAt: d("2026-10-10T08:00:00Z") }] }, now).status, "REMINDER_OPEN");
  const f = deriveReceivable({ principalOpenCents: 10, feesOpenCents: 0, dueDate: d("2026-10-01T08:00:00Z"), notices: [{ id: "a", level: 3, delivered: true, deadlineAt: d("2026-10-19T08:00:00Z") }] }, now);
  assert.deepEqual([f.status, f.next.kind], ["FURTHER_ACTION", "FURTHER_ACTION"]);
});

test("Befehl-22-Korrektur (44B): Kautionsstand ohne Freigabe heißt nicht „Teilweise freigegeben“", () => {
  assert.equal(depositStatusLabel("PARTIALLY_RELEASED", { releasedCents: 0, retainedCents: 0, offsetCents: 9_500 }), "Teilweise verrechnet");
  assert.equal(depositStatusLabel("PARTIALLY_RELEASED", { releasedCents: 0, retainedCents: 5_000, offsetCents: 0 }), "Teilweise einbehalten");
  assert.equal(depositStatusLabel("PARTIALLY_RELEASED", { releasedCents: 0, retainedCents: 5_000, offsetCents: 1_000 }), "Teilweise verrechnet und einbehalten");
  assert.equal(depositStatusLabel("PARTIALLY_RELEASED", { releasedCents: 10_000, retainedCents: 0, offsetCents: 0 }), "Teilweise freigegeben");
  assert.equal(depositStatusLabel("PARTIALLY_RELEASED", { releasedCents: 10_000, retainedCents: 0, offsetCents: 5_000 }), "Teilweise freigegeben");
  assert.equal(depositStatusLabel("RETAINED", { releasedCents: 0, retainedCents: 0, offsetCents: 50_000 }), "Mit Forderungen verrechnet");
  assert.equal(depositStatusLabel("RETAINED", { releasedCents: 0, retainedCents: 50_000, offsetCents: 0 }), "Einbehalten");
  assert.equal(depositStatusLabel("RELEASED", { releasedCents: 50_000, retainedCents: 0, offsetCents: 0 }), "Freigegeben");
  assert.equal(depositStatusLabel("RECEIVED"), "Erhalten");
  const card = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/finanzen/customer-credit-card.tsx"), "utf8");
  assert.match(card, /<ReasonForm variant="button"[^>]*label="Rückführung stornieren"/, "44A: ordentliches Touch-Ziel mit Dialog");
});
