// Phase 19: Operatives Dashboard. Kalendertage in Europe/Berlin (Mitternacht, Zeitumstellung), halboffene Intervalle,
// Gruppen Überfällig/Heute/Bald/Hinweis ohne Doppelzählung, keine Falschmeldungen (Guthaben nie überfällig, stornierte
// Zahlungen nicht gezählt, Haftung „unklar“ nur Hinweis), fehlgeschlagene Mails, fehlende PDFs, Führerscheine, Mandantengrenze.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { createCreditNoteDraft, finalizeCounterDocument, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { loadDashboard, SOON_DAYS } from "../src/lib/dashboard";
import { openDamageCase } from "../src/lib/damage-cases";
import { reportDamage } from "../src/lib/damages";
import { ensureContractDocument } from "../src/lib/documents";
import { enqueueEmail, markEmailFailed } from "../src/lib/email-log";
import { ensureInvoiceDraft, finalizeInvoice, updateInvoiceDraft } from "../src/lib/invoices";
import { cancelPayment, recordInvoicePayment } from "../src/lib/payments";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { parseLocalDateTime, zonedDayRange, zonedDayStart, zonedDayStartPlus, zonedDaysBetween, zonedParts } from "../src/lib/time";
import { createWorld, purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-dashboard-"));
  storage = getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const draftOf = (invoiceId: string) => db.invoiceVersion.findFirstOrThrow({ where: { invoiceId, status: "DRAFT" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
const keys = (d: Awaited<ReturnType<typeof loadDashboard>>) => d.tasks.map((t) => t.key);

test("Zeit: Tagesgrenzen in Europe/Berlin, halboffen, Zeitumstellung (23- und 25-Stunden-Tage), Kalendertage zählen", () => {
  // Sommerzeitbeginn 2026-03-29: Tag hat 23 Stunden; Winterzeitbeginn 2026-10-25: 25 Stunden
  const dstStart = zonedDayRange(parseLocalDateTime("2026-03-29T12:00")!);
  assert.equal(dstStart.end.getTime() - dstStart.start.getTime(), 23 * 3600_000);
  assert.equal(dstStart.start.toISOString(), "2026-03-28T23:00:00.000Z");
  const dstEnd = zonedDayRange(parseLocalDateTime("2026-10-25T12:00")!);
  assert.equal(dstEnd.end.getTime() - dstEnd.start.getTime(), 25 * 3600_000);
  // Mitternacht Berlin ist nicht Mitternacht UTC: 23:30 Berlin gehört noch zu heute, 00:30 zu morgen
  const now = parseLocalDateTime("2026-07-15T14:00")!;
  const { start, end } = zonedDayRange(now);
  assert.equal(start.toISOString(), "2026-07-14T22:00:00.000Z");
  assert.equal(end.toISOString(), "2026-07-15T22:00:00.000Z");
  const late = parseLocalDateTime("2026-07-15T23:30")!;
  const early = parseLocalDateTime("2026-07-16T00:30")!;
  assert.ok(late >= start && late < end);
  assert.ok(!(early < end));
  assert.equal(zonedDayStart(end).getTime(), end.getTime(), "Tagesbeginn ist idempotent");
  assert.equal(zonedDayStartPlus(now, 7).toISOString(), "2026-07-21T22:00:00.000Z");
  assert.equal(zonedDayStartPlus(parseLocalDateTime("2026-03-28T12:00")!, 1).toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(zonedDaysBetween(late, early), 1);
  assert.equal(zonedDaysBetween(early, late), -1);
  assert.equal(SOON_DAYS, 7);
});

test("Mieten: Abholung/Rückgabe heute, überfällig, bald, nicht erfasste Abholung, Führerscheine – ohne Doppelzählung", async () => {
  await ready;
  const w = await createWorld("dash-mieten", { startInDays: 20 });
  tenants.push(w.tenantId);
  const now = new Date();
  const { start, end } = zonedDayRange(now);
  const z = zonedParts(now);
  const vehicle = async (plate: string) => db.vehicle.create({ data: { tenantId: w.tenantId, plate, make: "VW", model: "Golf", groupId: w.groupId, dailyRate: 49, deposit: 300 } });
  const customer = await db.customer.findUniqueOrThrow({ where: { id: w.customerId } });
  const mk = (data: Record<string, unknown>) => db.booking.create({ data: { tenantId: w.tenantId, customerId: customer.id, dailyRate: 49, deposit: 300, ...data } as never });
  // Abholung heute 23:59 Berlin (noch heute), Rückgabe morgen 00:01 (nicht heute)
  const lateToday = parseLocalDateTime(`${z.year}-${String(z.month).padStart(2, "0")}-${String(z.day).padStart(2, "0")}T23:59`)!;
  const earlyTomorrow = new Date(end.getTime() + 60_000);
  const pickupToday = await mk({ number: "D-PICK", vehicleId: (await vehicle("HB-D 1")).id, startAt: lateToday, endAt: new Date(lateToday.getTime() + 2 * 86400_000) });
  const pickupTomorrow = await mk({ number: "D-TOMO", vehicleId: (await vehicle("HB-D 2")).id, startAt: earlyTomorrow, endAt: new Date(earlyTomorrow.getTime() + 2 * 86400_000) });
  const overdue = await mk({ number: "D-OVER", vehicleId: (await vehicle("HB-D 3")).id, status: "ACTIVE", startAt: new Date(now.getTime() - 3 * 86400_000), endAt: new Date(now.getTime() - 3600_000), actualPickupAt: new Date(now.getTime() - 3 * 86400_000) });
  const returnLater = await mk({ number: "D-RET", vehicleId: (await vehicle("HB-D 4")).id, status: "ACTIVE", startAt: new Date(now.getTime() - 86400_000), endAt: new Date(end.getTime() - 1000), actualPickupAt: new Date(now.getTime() - 86400_000) });
  const stale = await mk({ number: "D-STALE", vehicleId: (await vehicle("HB-D 5")).id, startAt: new Date(start.getTime() - 2 * 86400_000), endAt: new Date(start.getTime() - 86400_000) });
  const soon = await mk({ number: "D-SOON", vehicleId: (await vehicle("HB-D 6")).id, startAt: new Date(end.getTime() + 3 * 86400_000), endAt: new Date(end.getTime() + 5 * 86400_000) });

  const d = await loadDashboard(w.tenantId, { horizon: "heute", now });
  assert.equal(d.range.start.getTime(), start.getTime());
  assert.equal(d.counts.pickupsToday, 1);
  assert.equal(d.counts.overdueReturns, 1);
  assert.equal(d.counts.activeRentals, 2);
  assert.equal(d.counts.pickupsNotRecorded, 1);
  const k = keys(d);
  assert.ok(k.includes(`pickup-${pickupToday.id}`) && d.tasks.find((t) => t.key === `pickup-${pickupToday.id}`)!.group === "TODAY");
  assert.ok(!k.includes(`pickup-${pickupTomorrow.id}`), "morgen 00:01 gehört nicht zu heute");
  assert.equal(d.tasks.find((t) => t.key === `return-overdue-${overdue.id}`)?.group, "OVERDUE");
  assert.ok(!k.includes(`return-${overdue.id}`), "überfällige Rückgabe nicht zusätzlich unter Heute");
  const ret = d.tasks.find((t) => t.key === `return-${returnLater.id}`);
  assert.equal(ret?.group, "TODAY");
  assert.equal(d.counts.returnsToday, 1 + (overdue.endAt >= start ? 1 : 0), "Rückgaben heute: geplante plus heute überfällig gewordene");
  assert.equal(d.tasks.find((t) => t.key === `pickup-stale-${stale.id}`)?.group, "NOTE");
  assert.ok(!k.includes(`pickup-${soon.id}`), "Horizont „heute“ zeigt kein „bald“");
  assert.equal(d.groups.SOON.length, 0);
  assert.equal(d.events.filter((e) => e.kind === "PICKUP").length, 1);
  // Horizont 7 Tage: „bald“ erscheint, Heute bleibt gleich
  const d7 = await loadDashboard(w.tenantId, { horizon: "7", now });
  assert.equal(d7.tasks.find((t) => t.key === `pickup-${soon.id}`)?.group, "SOON");
  assert.equal(d7.tasks.find((t) => t.key === `pickup-${pickupTomorrow.id}`)?.group, "SOON");
  assert.equal(d7.counts.pickupsToday, d.counts.pickupsToday);
  assert.equal(d7.groups.OVERDUE.length, d.groups.OVERDUE.length);
  // Führerschein: vorhanden und gültig → kein Hinweis; fehlt → Hinweis; läuft vor Rückgabe ab → Hinweis
  assert.equal(d.counts.licenses, 0);
  await db.customer.update({ where: { id: customer.id }, data: { licenseValidUntil: new Date(lateToday.getTime() + 86400_000) } });
  const dl = await loadDashboard(w.tenantId, { horizon: "heute", now });
  assert.ok(keys(dl).includes(`license-expiring-${pickupToday.id}`));
  await db.customer.update({ where: { id: customer.id }, data: { licenseNumber: null, licenseValidUntil: null } });
  const dm = await loadDashboard(w.tenantId, { horizon: "heute", now });
  assert.ok(keys(dm).includes(`license-missing-${pickupToday.id}`));
  assert.ok(dm.events.find((e) => e.bookingId === pickupToday.id)?.licenseMissing);
  // Sortierung innerhalb der Gruppe: nach Zeitpunkt, deterministisch (zwei Läufe bei gleichem Datenstand)
  const again = await loadDashboard(w.tenantId, { horizon: "7", now });
  const again2 = await loadDashboard(w.tenantId, { horizon: "7", now });
  assert.deepEqual(keys(again), keys(again2));
  for (const g of ["OVERDUE", "TODAY", "SOON", "NOTE"] as const) {
    const ats = again.groups[g].filter((t) => t.at).map((t) => t.at!.getTime());
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b), `${g} nach Zeit sortiert`);
  }
});

test("Rechnungen: offen/überfällig nur bei offen > 0; Guthaben und Gutschrift nie überfällig; stornierte Zahlungen nicht gezählt; Erstattung als Hinweis", async () => {
  await ready;
  const w = await returnedWorld("dash-rechnung");
  tenants.push(w.tenantId);
  const at = new Date(Date.now() - 60_000);
  // Abgeschlossene Fassungen sind unveränderlich (Datenbankregel) – Fälligkeiten entstehen über das Zahlungsziel beim Abschluss,
  // „überfällig“ über einen späteren Betrachtungszeitpunkt (now) des Dashboards.
  const mkInvoice = async (bookingId: string, gross: string, paymentTermDays: number) => {
    const inv = await ensureInvoiceDraft(w.tenantId, bookingId, w.actor);
    const d = await draftOf(inv.id);
    await updateInvoiceDraft(w.tenantId, inv.id, w.actor, { items: [{ id: d.items[0].id, description: d.items[0].description, quantity: "1", unit: "pauschal", unitPrice: gross, taxRate: "19" }], paymentTermDays });
    const v = await finalizeInvoice(w.tenantId, inv.id, w.actor);
    return { id: inv.id, v };
  };
  const a = await mkInvoice(w.bookingId, "1000", 0); // heute fällig
  const todayD = await loadDashboard(w.tenantId, { now: new Date() });
  assert.equal(todayD.tasks.find((t) => t.key === `invoice-due-${a.id}`)?.group, "TODAY");
  assert.equal(todayD.counts.overdueInvoices, 0);
  // Betrachtung morgen: gestern fällig → überfällig
  const tomorrow = new Date(zonedDayStartPlus(new Date(), 1).getTime() + 12 * 3600_000);
  const now = tomorrow;
  let d = await loadDashboard(w.tenantId, { now });
  assert.equal(d.counts.openInvoices, 1);
  assert.equal(d.counts.overdueInvoices, 1);
  assert.equal(d.counts.overdueInvoiceCents, 100_000);
  assert.equal(d.tasks.find((t) => t.key === `invoice-overdue-${a.id}`)?.group, "OVERDUE");
  // stornierte Zahlung ändert nichts; bezahlt plus Gutschrift → offen 0, nie überfällig, Guthaben als Erstattungshinweis
  const wrong = (await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: a.id, amount: "1000", method: "CASH", paidAt: at })).payment;
  await cancelPayment(w.tenantId, w.actor, wrong.id, "Test");
  d = await loadDashboard(w.tenantId, { now });
  assert.equal(d.counts.overdueInvoices, 1, "stornierte Zahlung zählt nicht");
  await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: a.id, amount: "1000", method: "BANK_TRANSFER", paidAt: at });
  const cnA = await createCreditNoteDraft(w.tenantId, a.id, w.actor);
  await updateCounterDocumentDraft(w.tenantId, cnA.id, w.actor, { items: [{ sourceItemId: a.v.items[0].id, mode: "AMOUNT", grossAmount: "200" }], reason: "Kulanz" });
  await finalizeCounterDocument(w.tenantId, cnA.id, w.actor, { confirmed: true });
  d = await loadDashboard(w.tenantId, { now });
  assert.equal(d.counts.openInvoices, 0);
  assert.equal(d.counts.overdueInvoices, 0, "Guthaben ist nie überfällig");
  assert.equal(d.counts.refundsOpen, 1);
  assert.equal(d.counts.refundsOpenCents, 20_000);
  assert.equal(d.tasks.find((t) => t.key === `refund-${a.id}`)?.group, "NOTE");
  // zweite Rechnung, vollständig gutgeschrieben, Fälligkeit (aus Sicht von morgen) gestern → nichts offen, nichts überfällig
  const w2 = await returnedWorld("dash-gs", { within: w });
  const b = await mkInvoice(w2.bookingId, "500", 0);
  const cn = await createCreditNoteDraft(w.tenantId, b.id, w.actor);
  await updateCounterDocumentDraft(w.tenantId, cn.id, w.actor, { items: [{ sourceItemId: b.v.items[0].id, mode: "REMAINING" }], reason: "Storno per Gutschrift" });
  await finalizeCounterDocument(w.tenantId, cn.id, w.actor, { confirmed: true });
  d = await loadDashboard(w.tenantId, { now });
  assert.equal(d.counts.openInvoices, 0);
  assert.equal(d.counts.overdueInvoices, 0);
  assert.ok(!keys(d).includes(`invoice-overdue-${b.id}`));
  // Zahlungsziel 5 Tage: aus Sicht von morgen in 4 Tagen fällig → nicht unter „heute“, aber unter „bald“ (7 und 30 Tage)
  const w3 = await returnedWorld("dash-heute", { within: w });
  const c = await mkInvoice(w3.bookingId, "300", 5);
  d = await loadDashboard(w.tenantId, { now });
  assert.ok(!keys(d).some((k) => k.endsWith(c.id)), "in 4 Tagen fällig: nicht unter „heute“");
  const d7 = await loadDashboard(w.tenantId, { horizon: "7", now });
  assert.equal(d7.tasks.find((t) => t.key === `invoice-soon-${c.id}`)?.group, "SOON");
  const d30 = await loadDashboard(w.tenantId, { horizon: "30", now });
  assert.equal(d30.tasks.find((t) => t.key === `invoice-soon-${c.id}`)?.group, "SOON");
  // Zahlungsziel 30 Tage: weder heute noch in 7 Tagen, aber in 30 Tagen
  const w4 = await returnedWorld("dash-spaet", { within: w });
  const e = await mkInvoice(w4.bookingId, "200", 20);
  assert.ok(!keys(await loadDashboard(w.tenantId, { horizon: "7", now })).some((k) => k.endsWith(e.id)));
  assert.equal((await loadDashboard(w.tenantId, { horizon: "30", now })).tasks.find((t) => t.key === `invoice-soon-${e.id}`)?.group, "SOON");
});

test("Schäden, Kautionen, E-Mail-Probleme, fehlende PDFs: Hinweise ohne Automatik; Mandantengrenze", async () => {
  await ready;
  const w = await returnedWorld("dash-hinweise");
  tenants.push(w.tenantId);
  const now = new Date();
  // Schadenakte ohne Bewertung → Hinweis „Haftung ungeklärt“, keine Kundenzuweisung
  const dmg = await reportDamage(w.tenantId, w.actor, { vehicleId: w.vehicleId, view: "LEFT", posX: 0.4, posY: 0.5, kind: "SCRATCH", description: "Kratzer", bookingId: w.bookingId });
  const { damageCase } = await openDamageCase(w.tenantId, dmg.id, w.actor);
  // fehlgeschlagene Mail
  const mail = await enqueueEmail({ tenantId: w.tenantId, bookingId: w.bookingId, recipient: "erika@example.test", subject: "Unterlagen", template: "PICKUP_DOCUMENTS", idempotencyKey: `dash-${w.bookingId}` });
  await markEmailFailed(w.tenantId, mail.id, "Verbindung abgelehnt");
  let d = await loadDashboard(w.tenantId, { now });
  assert.equal(d.counts.damagesOpen, 1);
  assert.equal(d.counts.damagesLiabilityUnclear, 1);
  const liab = d.tasks.find((t) => t.key === `damage-liability-${damageCase.id}`)!;
  assert.equal(liab.group, "NOTE");
  assert.ok(!/Kunde|Mieter/.test(liab.title), "kein Kundenbezug im Hinweis");
  assert.equal(d.counts.emailsFailed, 1);
  const mailTask = d.tasks.find((t) => t.key === `mail-${mail.id}`)!;
  assert.equal(mailTask.group, "NOTE");
  assert.ok(mailTask.detail.includes("Verbindung abgelehnt") && mailTask.href === `/buchungen/${w.bookingId}`);
  // fehlende PDFs: Vertrag (SIGNED), zwei Protokolle, keine Rechnung → drei Hinweise; nach Erzeugung des Vertrags-PDF einer weniger
  assert.equal(d.counts.documentsMissing, 3);
  assert.ok(keys(d).includes(`doc-contract-${w.contractId}`) && keys(d).includes(`doc-handover-${w.pickupId}`) && keys(d).includes(`doc-handover-${w.returnId}`));
  await ensureContractDocument(w.tenantId, w.contractId, w.actor.id, { storage });
  d = await loadDashboard(w.tenantId, { now });
  assert.equal(d.counts.documentsMissing, 2);
  assert.ok(!keys(d).includes(`doc-contract-${w.contractId}`));
  // Kaution: Vertrag über 500, Buchung zurückgegeben, nichts erhalten → weder „unterwegs ohne Eingang“ (nicht aktiv) noch „nicht entschieden“ (nichts erhalten)
  assert.equal(d.counts.depositsExpected, 0);
  assert.equal(d.counts.depositsHeld, 0);
  // Fremder Mandant sieht nichts davon
  const other = await createWorld("dash-fremd");
  tenants.push(other.tenantId);
  const od = await loadDashboard(other.tenantId, { now });
  assert.equal(od.counts.damagesOpen, 0);
  assert.equal(od.counts.emailsFailed, 0);
  assert.equal(od.counts.documentsMissing, 0);
  assert.ok(!od.tasks.some((t) => t.key.endsWith(damageCase.id) || t.key.endsWith(mail.id)));
});
