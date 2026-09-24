// Phase 19: Globale Suche. Exakte Nummern aller Belegarten, Teiltreffer, Groß/Klein, Umlaute, Kennzeichen ohne
// Leerzeichen, Telefon normalisiert, deterministische Rangfolge, strikte Mandantengrenze, Rollen (FIN), Eingabegrenzen,
// Lastbremse.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { createAuthorityCase } from "../src/lib/authority";
import { createCreditNoteDraft, finalizeCounterDocument, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { toCents } from "../src/lib/money";
import { openDamageCase } from "../src/lib/damage-cases";
import { reportDamage } from "../src/lib/damages";
import { ensureInvoiceDraft, finalizeInvoice } from "../src/lib/invoices";
import { createMaintenance } from "../src/lib/maintenance";
import { recordInvoicePayment } from "../src/lib/payments";
import { createPayout } from "../src/lib/payouts";
import { clearAllRateLimits, consume, LOGIN_LIMIT_PER_ACCOUNT, reset } from "../src/lib/rate-limit";
import { bookingSearchWhere, customerSearchWhere, globalSearch, searchQuerySchema, type SearchType } from "../src/lib/search";
import { toDateInputValue, zonedParts } from "../src/lib/time";
import { createWorld, purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

/** Ein Mandant mit allen Vorgangsarten plus ein zweiter Mandant mit ähnlichen Daten. */
async function buildFixture() {
    const w = await returnedWorld("suche");
    tenants.push(w.tenantId);
    const at = new Date(Date.now() - 60_000);
    await db.customer.update({ where: { id: w.customerId }, data: { phone: "+49 (0)421 / 12 34 56", email: "Erika.Muster@Example.test" } });
    const mueller = await db.customer.create({ data: { tenantId: w.tenantId, number: "K-00002", type: "COMPANY", companyName: "Müller & Söhne GmbH", firstName: "Jörg", lastName: "Müller", street: "Weg 9", zip: "28195", city: "Bremen", phone: "0171 9998877" } });
    const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } });
    await db.vehicle.update({ where: { id: vehicle.id }, data: { vin: "WVWZZZ1KZAW123456" } });
    const booking = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
    const contract = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
    const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
    const v1 = await finalizeInvoice(w.tenantId, inv.id, w.actor);
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    // vollständig bezahlt, dann Gutschrift 10 → Kundenguthaben 10 → Auszahlung 10
    await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: inv.id, amount: String(toCents(v1.grossTotal) / 100), method: "BANK_TRANSFER", paidAt: at });
    const cn = await createCreditNoteDraft(w.tenantId, inv.id, w.actor);
    await updateCounterDocumentDraft(w.tenantId, cn.id, w.actor, { items: [{ sourceItemId: v1.items[0].id, mode: "AMOUNT", grossAmount: "10" }], reason: "Kulanz" });
    await finalizeCounterDocument(w.tenantId, cn.id, w.actor, { confirmed: true });
    const payout = (await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId: inv.id }, { amount: "10", method: "CASH", executedAt: at, reference: "Kulanz Sommer" }, { complete: true, confirmed: true })).payout;
    const damage = await reportDamage(w.tenantId, w.actor, { vehicleId: w.vehicleId, view: "LEFT", posX: 0.4, posY: 0.5, kind: "SCRATCH", description: "Kratzer Schiebetür", bookingId: w.bookingId });
    const { damageCase } = await openDamageCase(w.tenantId, damage.id, w.actor);
    const maint = (await createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "INSPECTION", title: "Inspektion 60.000 km", workshopName: "Autohaus Weser" })).record;
    const bk = await db.booking.update({ where: { id: w.bookingId }, data: { actualPickupAt: new Date(Date.now() - 4 * 86400_000), actualReturnAt: new Date(Date.now() - 3600_000) } });
    const offense = new Date(bk.actualPickupAt!.getTime() + 3600_000);
    const p = zonedParts(offense);
    const authority = await createAuthorityCase(w.tenantId, w.actor, { type: "PARKING", authorityName: "Ordnungsamt Bremen", authorityReference: "OA-7788/26", licensePlate: vehicle.plate.toLowerCase().replace(/\s+/g, ""), offenseDate: toDateInputValue(offense), offenseTime: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` });
    // zweiter Mandant mit gleichem Namen, gleicher Kundennummer und ähnlichem Kennzeichen
    const other = await createWorld("suche-fremd");
    tenants.push(other.tenantId);
    return { w, mueller, vehicle, booking, contract, invoice, payout, damageCase, maint, authority, other };
}
type Fixture = Awaited<ReturnType<typeof buildFixture>>;
let cached: Promise<Fixture> | null = null;
function fixture(): Promise<Fixture> {
  if (!cached) cached = buildFixture();
  return cached;
}

const first = (r: Awaited<ReturnType<typeof globalSearch>>, type: SearchType) => r.groups.find((g) => g.type === type)?.hits[0];
const ids = (r: Awaited<ReturnType<typeof globalSearch>>, type: SearchType) => r.groups.find((g) => g.type === type)?.hits.map((h) => h.id) ?? [];

test("Exakte Nummern: Kunde, Buchung, Vertrag, RE, AZ, SCH, WA, BH – Treffer mit höchstem Rang, Gruppe zuerst", async () => {
  const f = await fixture();
  const t = f.w.tenantId;
  const cases: [string, SearchType, string][] = [
    ["K-00001", "customer", f.w.customerId],
    [f.booking.number, "booking", f.booking.id],
    [f.contract.number, "contract", f.contract.id],
    [f.invoice.number!, "invoice", f.invoice.id],
    [f.payout.number!, "payout", f.payout.id],
    [f.damageCase.caseNumber, "damage", f.damageCase.id],
    [f.maint.maintenanceNumber, "maintenance", f.maint.id],
    [f.authority.caseNumber, "authority", f.authority.id],
  ];
  for (const [q, type, id] of cases) {
    const r = await globalSearch(t, "OWNER", q);
    const hit = first(r, type);
    assert.ok(hit, `${q}: Gruppe ${type} fehlt`);
    assert.equal(hit.id, id, `${q}: erster Treffer`);
    assert.ok(hit.score >= 90, `${q}: Rang ${hit.score}`);
    assert.equal(r.groups[0].type, type, `${q}: Gruppe ${type} zuerst`);
    assert.ok(hit.href.startsWith("/"), "interne Adresse");
  }
  // Nummern auch in Kleinschreibung
  const lower = await globalSearch(t, "OWNER", f.invoice.number!.toLowerCase());
  assert.equal(first(lower, "invoice")?.id, f.invoice.id);
});

test("Kennzeichen: exakt, ohne Leerzeichen, klein geschrieben – Fahrzeug, Buchung, Vertrag, Schadenakte, Wartung, Behördenvorgang", async () => {
  const f = await fixture();
  const compact = f.vehicle.plate.replace(/[\s-]/g, "").toLowerCase();
  const r = await globalSearch(f.w.tenantId, "OWNER", compact);
  assert.equal(first(r, "vehicle")?.id, f.vehicle.id);
  assert.ok(first(r, "vehicle")!.score >= 90, "normalisiertes Kennzeichen zählt als exakter Schlüssel");
  assert.ok(ids(r, "booking").includes(f.booking.id));
  assert.ok(ids(r, "contract").includes(f.contract.id));
  assert.ok(ids(r, "damage").includes(f.damageCase.id));
  assert.ok(ids(r, "maintenance").includes(f.maint.id));
  assert.ok(ids(r, "authority").includes(f.authority.id));
  const exact = await globalSearch(f.w.tenantId, "OWNER", f.vehicle.plate);
  assert.equal(first(exact, "vehicle")?.score, 90);
});

test("Teiltreffer: Name klein, Firma mit Umlaut, E-Mail, Telefon in anderer Schreibweise, Marke/Modell, Werkstatt, Aktenzeichen; zweiteilige Namen", async () => {
  const f = await fixture();
  const t = f.w.tenantId;
  assert.equal(first(await globalSearch(t, "OWNER", "muster"), "customer")?.id, f.w.customerId);
  assert.equal(first(await globalSearch(t, "OWNER", "MÜLLER"), "customer")?.id, f.mueller.id);
  assert.equal(first(await globalSearch(t, "OWNER", "söhne"), "customer")?.id, f.mueller.id);
  assert.equal(first(await globalSearch(t, "OWNER", "erika.muster@example"), "customer")?.id, f.w.customerId);
  assert.equal(first(await globalSearch(t, "OWNER", "0421123456"), "customer")?.id, f.w.customerId, "Telefon nur Ziffern");
  assert.equal(first(await globalSearch(t, "OWNER", "421 / 12 34"), "customer")?.id, f.w.customerId, "Telefon mit Trennzeichen");
  assert.equal(first(await globalSearch(t, "OWNER", "crafter"), "vehicle")?.id, f.vehicle.id);
  assert.equal(first(await globalSearch(t, "OWNER", "weser"), "maintenance")?.id, f.maint.id);
  assert.equal(first(await globalSearch(t, "OWNER", "OA-7788"), "authority")?.id, f.authority.id);
  assert.equal(first(await globalSearch(t, "OWNER", "kulanz"), "payout")?.id, f.payout.id);
  // Kundenliste: „Erika Muster“ und „Muster Erika“
  for (const q of ["Erika Muster", "muster erika"]) {
    const rows = await db.customer.findMany({ where: await customerSearchWhere(t, q), select: { id: true } });
    assert.ok(rows.some((r) => r.id === f.w.customerId), q);
  }
  // Buchungsliste: Kennzeichen kompakt und Kundenname
  const compact = f.vehicle.plate.replace(/[\s-]/g, "");
  for (const q of [compact, "Muster", f.contract.number]) {
    const rows = await db.booking.findMany({ where: await bookingSearchWhere(t, q), select: { id: true } });
    assert.ok(rows.some((r) => r.id === f.booking.id), `Buchungsliste: ${q}`);
  }
  // Sonderzeichen sind harmlos (kein Roh-SQL)
  const weird = await globalSearch(t, "OWNER", "%_' OR 1=1 --");
  assert.equal(weird.total, 0);
  const pct = await globalSearch(t, "OWNER", "%%");
  assert.equal(pct.total, 0, "Prozentzeichen ist kein Platzhalter");
});

test("Rangfolge deterministisch: exakte Nummer vor Teiltreffer, Gruppen nach bestem Treffer, gleiche Eingabe gleiche Reihenfolge", async () => {
  const f = await fixture();
  const t = f.w.tenantId;
  // „Muster“ trifft Kunde (Name exakt: 80) und Buchung/Vertrag/Rechnung (Kundenname: 80/60) – Kunde bleibt zuerst
  const a = await globalSearch(t, "OWNER", "Muster");
  const b = await globalSearch(t, "OWNER", "Muster");
  assert.deepEqual(a.groups.map((g) => [g.type, g.hits.map((h) => h.id)]), b.groups.map((g) => [g.type, g.hits.map((h) => h.id)]));
  assert.equal(a.groups[0].type, "customer");
  assert.equal(a.groups[0].hits[0].score, 80);
  // Kunde „Muster“ (Nachname exakt) vor „Müller“ (kein Treffer) – und Nummer schlägt Name
  const byNumber = await globalSearch(t, "OWNER", "K-00002");
  assert.equal(first(byNumber, "customer")?.id, f.mueller.id);
  assert.equal(first(byNumber, "customer")?.score, 90);
  // perType begrenzt und meldet „mehr“
  const limited = await globalSearch(t, "OWNER", "Muster", { perType: 1 });
  for (const g of limited.groups) assert.ok(g.hits.length <= 1);
});

test("Mandantengrenze und Rollen: keine Fremdtreffer, FIN nur für Inhaber/Disposition, Eingabegrenzen, Lastbremse", async () => {
  const f = await fixture();
  // Fremder Mandant: gleicher Name, gleiche Kundennummer, gleiches Kennzeichenmuster – nichts aus Mandant A
  const foreign = await globalSearch(f.other.tenantId, "OWNER", "Muster");
  for (const g of foreign.groups) for (const h of g.hits) assert.notEqual(h.id, f.w.customerId);
  const foreignNo = await globalSearch(f.other.tenantId, "OWNER", f.invoice.number!);
  assert.equal(foreignNo.total, 0);
  const foreignPlate = await globalSearch(f.other.tenantId, "OWNER", f.vehicle.plate);
  assert.ok(!ids(foreignPlate, "vehicle").includes(f.vehicle.id));
  const foreignK = await globalSearch(f.other.tenantId, "OWNER", "K-00001");
  assert.equal(first(foreignK, "customer")?.id, f.other.customerId);
  // FIN: Inhaber findet, Hofmitarbeiter nicht (weder als Treffer noch im Kontext)
  const vinOwner = await globalSearch(f.w.tenantId, "OWNER", "WVWZZZ1KZAW");
  assert.equal(first(vinOwner, "vehicle")?.id, f.vehicle.id);
  assert.ok(first(vinOwner, "vehicle")!.context.includes("FIN"));
  const vinYard = await globalSearch(f.w.tenantId, "YARD", "WVWZZZ1KZAW");
  assert.equal(vinYard.total, 0);
  const plateYard = await globalSearch(f.w.tenantId, "YARD", f.vehicle.plate);
  assert.ok(!plateYard.groups.some((g) => g.hits.some((h) => h.context.includes("WVWZZZ"))), "keine FIN im Kontext für Hofmitarbeiter");
  // Keine IBAN im Suchergebnis
  const anyText = JSON.stringify(await globalSearch(f.w.tenantId, "OWNER", "Muster"));
  assert.ok(!/DE\d{20}/.test(anyText));
  // Eingabegrenzen
  assert.equal(searchQuerySchema.safeParse("a").success, false);
  assert.equal(searchQuerySchema.safeParse("  a ").success, false);
  assert.equal(searchQuerySchema.safeParse("x".repeat(81)).success, false);
  assert.equal(searchQuerySchema.safeParse(" ab ").success, true);
  await assert.rejects(() => globalSearch(f.w.tenantId, "OWNER", "a"));
  // Lastbremse: prozesslokal, Fenster, Zurücksetzen
  clearAllRateLimits();
  const rule = { limit: 3, windowMs: 1000 };
  const t0 = 1_000_000;
  assert.equal(consume("k", rule, t0).allowed, true);
  assert.equal(consume("k", rule, t0 + 1).allowed, true);
  assert.equal(consume("k", rule, t0 + 2).allowed, true);
  const blocked = consume("k", rule, t0 + 3);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000);
  assert.equal(consume("k", rule, t0 + 1001).allowed, true, "Fenster abgelaufen");
  reset("k");
  assert.equal(consume("k", rule, t0 + 1002).remaining, rule.limit - 1);
  assert.ok(LOGIN_LIMIT_PER_ACCOUNT.limit >= 5 && LOGIN_LIMIT_PER_ACCOUNT.windowMs >= 5 * 60_000);
  clearAllRateLimits();
});
