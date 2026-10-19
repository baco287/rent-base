// Auslandsfahrt per Nachtrag (Stufe 2): Genehmigung erteilen, Länder oder Aufpreis ändern, Genehmigung entziehen – als eigener,
// versiegelter Nachtrag. Der unterschriebene Vertrag und die Buchung bleiben unverändert; der wirksame Stand (Vertrag +
// unterschriebene Nachträge) liefert Genehmigung, Länder und Gesamt-Aufpreis; auf den Gesamtpreis wirkt nur der Unterschied.
// Rechnung: Erhöhung = eigene Position (Abrechnungsbezug Nachtrag), Senkung mindert nur Auslandspositionen. Läuft gegen die
// lokale Testdatenbank (wie alle Integrationstests).
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { abroadReasonIssue, abroadStateText, contractAbroadOf, parseAmendmentAbroadForm, type AmendmentAbroadChoice } from "../src/lib/abroad";
import {
  agreeAmendment, amendmentKindsLabel, applyAmendments, createAmendmentDraft, describeChanges, discardAmendment, effectiveStateForBooking, effectiveTotalCents, getAmendmentContentHash,
  getAmendmentState, pendingSettlements, saveAmendmentSignature, signAmendment, updateAmendmentDraft, type AmendmentSnapshot,
} from "../src/lib/amendments";
import { loadAmendmentDocumentData } from "../src/lib/amendment-document";
import { verifyContract } from "../src/lib/contracts";
import { finalizeHandover, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { contentHash } from "../src/lib/integrity";
import { createAmendmentSettlementDraft, ensureInvoiceDraft, finalizeInvoice, verifyInvoice } from "../src/lib/invoices";
import { fmtCents, toCents } from "../src/lib/money";
import { renderAmendmentPdf } from "../src/lib/pdf/amendment-pdf";
import { allocateRentalItems } from "../src/lib/rental-allocation";
import { rentalPaymentSummary } from "../src/lib/rental-payments";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";
import { answerAll, photo, pickedUpWorld, returnedWorld, sign, type PickedUpWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const RULES = { abroadAllowed: true, abroadCountries: ["AT", "CH", "FR"] };
const nbsp = (s: string) => s.replace(/[  ]/g, " ");
const nonce = (s: string) => `${s}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
type Abroad = { allowed: boolean; countries?: string[]; cents?: number };
const abroadData = (a: Abroad) => (a.allowed ? { abroadAllowed: true, abroadCountries: a.countries ?? ["AT"], abroadSurchargeCents: a.cents ?? 0 } : { abroadAllowed: false, abroadCountries: [], abroadSurchargeCents: null });
const choice = (allowed: boolean, countries: string[], surchargeCents: number, reason: string | null = null): AmendmentAbroadChoice => ({ allowed, countries, surchargeCents, reason });

/** Laufende Miete (übergeben) mit Freigabeliste AT/CH/FR; Auslandsfahrt laut Buchung bzw. Vertrag. */
async function abroadWorld(label: string, abroad: Abroad = { allowed: false }): Promise<PickedUpWorld> {
  return pickedUpWorld(label, {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.tenant.update({ where: { id: x.tenantId }, data: { businessRules: RULES } });
      await db.booking.update({ where: { id: x.bookingId }, data: abroadData(abroad) });
    },
  });
}
async function draft(w: World, label: string) {
  return (await createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: nonce(label) })).amendment;
}
async function signed(w: World, amendmentId: string) {
  await saveAmendmentSignature(w.tenantId, w.actor, amendmentId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(2), seenHash: await getAmendmentContentHash(w.tenantId, amendmentId) });
  return (await signAmendment(w.tenantId, w.actor, amendmentId)).amendment;
}
async function abroadAmendment(w: World, label: string, c: AmendmentAbroadChoice) {
  const a = await draft(w, label);
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: c });
  return signed(w, a.id);
}
/** Rückgabe ohne Zusatzkosten abschließen (gleicher Tank, Kilometer innerhalb der Freikilometer). */
async function finishReturn(w: World) {
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 45_500, fuelLevelEighths: 7 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, r.id, cat);
  await answerAll(w, r.id);
  await sign(w, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
}
async function draftItems(w: World) {
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const v = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId: inv.id, status: "DRAFT" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  return { inv, items: v.items };
}
const cents = (i: { grossAmount: unknown }) => toCents(i.grossAmount as string);
const contractTotal = async (w: PickedUpWorld) => toCents((await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } })).totalAmount);

// ---------------------------------------------------------------------------
// Ableitung ohne Datenbank
// ---------------------------------------------------------------------------

test("S2-1 Ableitung: Ausland-Nachtrag ersetzt den Stand vollständig, nur der Unterschied wirkt auf den Gesamtpreis", () => {
  const end = new Date("2026-10-10T10:00:00Z");
  const c = { id: "c", number: "MV-1", bookingId: "b", startAt: new Date("2026-10-04T10:00:00Z"), endAt: end, totalAmount: "583.00", kmIncludedPerDay: 200, extraKmRate: "0.25", deposit: "500.00", returnLocation: null, pickupLocation: "Hof", conditions: { rulesVersion: 1, values: { abroadAllowed: true, abroadCountries: ["CH", "AT"] } }, priceSnapshot: { extras: [{ key: "ABROAD_SURCHARGE", label: "Auslandsfahrt-Aufpreis", quantity: 1, unitPrice: 49, amount: 49 }] } } as unknown as Parameters<typeof applyAmendments>[0];
  const base = { id: "", status: "SIGNED", number: null, sequenceNo: null, newEndAt: null, priceDeltaCents: null, newKmIncludedPerDay: null, newExtraKmRate: null, newDepositCents: null, newReturnLocation: null, agreementText: null };
  const a1 = { ...base, id: "a1", number: "NT-2026-000001", sequenceNo: 1, newAbroadAllowed: true, newAbroadCountries: ["FR", "AT", "CH"], newAbroadSurchargeCents: 8000, abroadSurchargeDeltaCents: 3100 };
  const a2 = { ...base, id: "a2", number: "NT-2026-000002", sequenceNo: 2, priceDeltaCents: -1000 };
  const draftRow = { ...base, id: "a3", status: "DRAFT", newAbroadAllowed: false, newAbroadCountries: [], newAbroadSurchargeCents: 0, abroadSurchargeDeltaCents: -8000 };
  const before = applyAmendments(c, [] as unknown as Parameters<typeof applyAmendments>[1], []);
  assert.deepEqual(before.abroad, { allowed: true, countries: ["AT", "CH"], surchargeCents: 4900 }, "Stand laut Vertrag (Länder normalisiert)");
  assert.equal(before.abroadChangedBy, null);
  const st = applyAmendments(c, [] as unknown as Parameters<typeof applyAmendments>[1], [a2, draftRow, a1] as unknown as Parameters<typeof applyAmendments>[2]);
  assert.deepEqual(st.abroad, { allowed: true, countries: ["AT", "CH", "FR"], surchargeCents: 8000 });
  assert.equal(st.abroadChangedBy, "NT-2026-000001");
  assert.equal(st.totalCents, 58300 + 3100 - 1000, "Vertragsaufpreis nicht doppelt, nur der Unterschied; Entwurf wirkt nicht");
  assert.equal(st.changedBy.total, "NT-2026-000002");
  assert.deepEqual(Object.keys(st.changedBy).sort(), ["deposit", "endAt", "km", "returnLocation", "total"], "keine neue Art im bisherigen changedBy");
  assert.equal(effectiveTotalCents("583.00", [a2, a1]), 58300 + 3100 - 1000);
  assert.deepEqual(contractAbroadOf(undefined, undefined), { allowed: false, countries: [], surchargeCents: 0 }, "Altvertrag ohne Regeln: nicht gestattet");
  const ch = describeChanges({ ...draftRow, abroadReason: "Kunde fährt nur im Inland" } as unknown as Parameters<typeof describeChanges>[0], st, [] as unknown as Parameters<typeof describeChanges>[2]);
  assert.deepEqual(ch.map((x) => x.kind), ["ABROAD"]);
  assert.equal(ch[0].label, "Auslandsfahrten");
  assert.equal(nbsp(ch[0].before), nbsp(abroadStateText(st.abroad)));
  assert.equal(ch[0].after, "Nicht gestattet");
  assert.match(nbsp(ch[0].note!), /Auslandsfahrt-Aufpreis −80,00 € \(einmalig\) · Kunde fährt nur im Inland/);
  assert.equal(amendmentKindsLabel({ ...draftRow, addedDrivers: [], removedDrivers: [] } as unknown as Parameters<typeof amendmentKindsLabel>[0]), "Auslandsfahrt");
});

test("S2-2 Formular: Bereich aus = keine Änderung, Länder als Mehrfachwerte, strenger Betrag, Entzug = Aufpreis 0, Grund ≥ 3 Zeichen", () => {
  const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f; };
  assert.equal(parseAmendmentAbroadForm(fd({ abroadAllowed: "1", abroadCountries: "AT" })), null, "nicht angehakt");
  assert.deepEqual(parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "1", abroadCountries: ["CH", "AT", "AT"], abroadSurcharge: "1.234,50" })), { allowed: true, countries: ["AT", "CH"], surchargeCents: 123450, reason: null });
  assert.deepEqual(parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "0", abroadCountries: "AT", abroadSurcharge: "99", abroadReason: " Nur Inland " })), { allowed: false, countries: [], surchargeCents: 0, reason: "Nur Inland" }, "Entzug ignoriert Länder und Betrag");
  assert.deepEqual(parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "1", abroadCountries: "AT", abroadSurcharge: "0" })), { allowed: true, countries: ["AT"], surchargeCents: 0, reason: null }, "0,00 € zulässig");
  for (const bad of ["-1", "1,234", "abc", "100000,01", ""]) assert.ok("error" in (parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "1", abroadCountries: "AT", abroadSurcharge: bad })) as object), `Betrag ${bad}`);
  assert.match((parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "1", abroadCountries: "XX", abroadSurcharge: "1" })) as { error: string }).error, /Unbekanntes Land/);
  assert.match((parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "1", abroadCountries: "OTHER", abroadSurcharge: "1" })) as { error: string }).error, /Unbekanntes Land/);
  assert.match((parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "1", abroadSurcharge: "1" })) as { error: string }).error, /konkret genehmigten Länder/);
  assert.match((parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "0", abroadReason: "ab" })) as { error: string }).error, /mindestens 3 Zeichen/);
  // Zeichen wie die Datenbank-Prüfregel (Codepunkte): Emoji zählt als ein Zeichen
  assert.match((parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "0", abroadReason: "👍a" })) as { error: string }).error, /mindestens 3 Zeichen/);
  assert.deepEqual(parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "0", abroadReason: "🚗🚗🚗" })), { allowed: false, countries: [], surchargeCents: 0, reason: "🚗🚗🚗" });
  assert.equal(abroadReasonIssue("x".repeat(3)), null);
  assert.equal([...((parseAmendmentAbroadForm(fd({ abroadChange: "1", abroadAllowed: "0", abroadReason: "😀".repeat(301) })) as { reason: string }).reason)].length, 300, "Kürzung ohne halbes Zeichen");
});

test("S2-15 Verteilung (rein): Minderungen in Nachtragsreihenfolge, nur bestehende Positionen, Vermerk nur am tatsächlich mindernden Nachtrag; Bestand wie vor Stufe 2", () => {
  const am = (n: number, p: number | null, d: number | null = null) => ({ id: `a${n}`, number: `NT-${n}`, priceDeltaCents: p, abroadSurchargeDeltaCents: d });
  const ABR = { key: "ABROAD_SURCHARGE", amount: 49 };
  const view = (r: ReturnType<typeof allocateRentalItems>) => ({ rental: r.rentalCents, extras: r.extras.map((e) => [e.cents, e.reducedBy.join()]), inc: r.increases.map((x) => [x.a.number, x.cents, x.reducedBy.join()]), abroad: r.abroad.map((x) => [x.a.number, x.cents, x.reducedBy.join()]), total: r.totalCents });
  // wie vor Stufe 2: Minderung über die Miete hinaus mindert zuerst den Auslandsfahrt-Aufpreis laut Vertrag, die Verlängerung bleibt
  assert.deepEqual(view(allocateRentalItems(34900, [ABR], [am(1, 10000), am(2, -32000)])), { rental: 0, extras: [[2900, "NT-2"]], inc: [["NT-1", 10000, ""]], abroad: [], total: 12900 });
  // zwei Minderungen: die erste fängt die Miete auf, nur die zweite mindert die (nach ihr unterschriebene) Erhöhung
  assert.deepEqual(view(allocateRentalItems(30000, [], [am(1, -29000), am(2, 10000), am(3, -10500)])), { rental: 0, extras: [], inc: [["NT-2", 500, "NT-3"]], abroad: [], total: 500 });
  // Minderung vor einer späteren Erhöhung: die spätere bleibt voll
  assert.deepEqual(view(allocateRentalItems(30000, [], [am(1, 10000), am(2, -35000), am(3, 5000)])), { rental: 0, extras: [], inc: [["NT-1", 5000, "NT-2"], ["NT-3", 5000, ""]], abroad: [], total: 10000 });
  // Zusatzfahrer-Position und Altbestand (Positionen über dem Vertragspreis)
  assert.deepEqual(view(allocateRentalItems(30000, [{ key: "ADDITIONAL_DRIVER", amount: 50 }], [am(1, -27000)])), { rental: 0, extras: [[3000, "NT-1"]], inc: [], abroad: [], total: 3000 });
  assert.deepEqual(view(allocateRentalItems(3000, [{ key: "ADDITIONAL_DRIVER", amount: 50 }], [])), { rental: 0, extras: [[3000, ""]], inc: [], abroad: [], total: 3000 });
  // Auslandsfahrt: Senkung mindert nur Auslandspositionen, Entzug + neue Genehmigung
  assert.deepEqual(view(allocateRentalItems(34900, [ABR], [am(1, null, 3100), am(2, null, -6000)])), { rental: 30000, extras: [[2000, "NT-2"]], inc: [], abroad: [["NT-1", 0, "NT-2"]], total: 32000 });
  assert.deepEqual(view(allocateRentalItems(34900, [ABR], [am(1, null, -4900), am(2, null, 3000)])), { rental: 30000, extras: [[0, "NT-1"]], inc: [], abroad: [["NT-2", 3000, ""]], total: 33000 });
});

// ---------------------------------------------------------------------------
// Entwurf, Prüfungen, Wirksamwerden
// ---------------------------------------------------------------------------

test("S2-3 Genehmigung per Nachtrag: Unterschied serverseitig, versiegelt, Vertrag und Buchung unverändert, Preis/Zahlung/Protokoll", async () => {
  const w = await abroadWorld("s2-grant");
  const total0 = await contractTotal(w);
  const contract0 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const booking0 = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const a = await draft(w, "grant");
  const st0 = await getAmendmentState(w.tenantId, a.id);
  assert.deepEqual(st0.abroadOptions, { plate: (await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).plate, possible: true, countries: ["AT", "CH", "FR"], kept: [], accident: false });
  // Client-Daten bestimmen den Unterschied nicht: nur der neue Gesamtstand wird übergeben
  const row = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: choice(true, ["CH", "AT"], 3000) });
  assert.deepEqual([row.newAbroadAllowed, row.newAbroadCountries, row.newAbroadSurchargeCents, row.abroadSurchargeDeltaCents, row.abroadReason], [true, ["AT", "CH"], 3000, 3000, null]);
  const st = await getAmendmentState(w.tenantId, a.id);
  assert.deepEqual(st.changes.map((c) => c.kind), ["ABROAD"]);
  assert.equal(st.changes[0].before, "Nicht gestattet");
  assert.deepEqual(st.issues.filter((i) => i.severity === "error").map((i) => i.code), [], "keine Prüffehler");
  const n = await signed(w, a.id);
  assert.equal(n.status, "SIGNED");
  const snap = n.snapshot as unknown as AmendmentSnapshot;
  assert.deepEqual(snap.abroad, { before: { allowed: false, countries: [], surchargeCents: 0 }, after: { allowed: true, countries: ["AT", "CH"], surchargeCents: 3000 }, deltaCents: 3000, reason: null });
  assert.equal(snap.after.totalCents, total0 + 3000);
  assert.equal(snap.before.totalCents, total0);
  // wirksamer Stand
  const eff = (await effectiveStateForBooking(w.tenantId, w.bookingId))!;
  assert.deepEqual(eff.abroad, { allowed: true, countries: ["AT", "CH"], surchargeCents: 3000 });
  assert.equal(eff.abroadChangedBy, n.number);
  assert.equal(eff.totalCents, total0 + 3000);
  assert.equal(eff.changedBy.total, n.number);
  assert.equal((await rentalPaymentSummary(w.tenantId, w.bookingId)).grossCents, total0 + 3000, "Mietzahlung erwartet den neuen Gesamtpreis");
  // Vertrag und Buchung bleiben unverändert (der Vertrag wird nicht überschrieben)
  const contract1 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal(contract1.contentHash, contract0.contentHash);
  assert.equal(String(contract1.totalAmount), String(contract0.totalAmount));
  assert.ok((await verifyContract(w.tenantId, w.contractId)).intact, "Prüfsumme des Vertrags intakt");
  const booking1 = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.deepEqual([booking1.abroadAllowed, booking1.abroadCountries, booking1.abroadSurchargeCents], [booking0.abroadAllowed, booking0.abroadCountries, booking0.abroadSurchargeCents]);
  // Protokoll
  const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, action: "AMENDMENT_ABROAD_CHANGED" } });
  assert.equal(audit.amountCents, 3000);
  assert.equal((audit.details as { before?: string }).before, "Nicht gestattet");
  assert.equal((await db.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, action: "AMENDMENT_SIGNED" } })).amountCents, 3000);
  // unterschrieben = unveränderlich (Datenbank)
  await assert.rejects(() => db.contractAmendment.update({ where: { id: n.id }, data: { newAbroadSurchargeCents: 1 } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.contractAmendment.update({ where: { id: n.id }, data: { newAbroadCountries: ["AT"] } }), /RB_IMMUTABLE/);
});

test("S2-4 Validierung: nur Länder der Freigabeliste, ganze Cent 0–100.000 €, kein unveränderter Stand, getrennt von Preisänderung, kein negativer Gesamtpreis, Mandantentrennung", async () => {
  const w = await abroadWorld("s2-valid", { allowed: true, countries: ["AT"], cents: 4900 });
  const total0 = await contractTotal(w);
  const a = await draft(w, "v");
  const upd = (c: AmendmentAbroadChoice) => updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: c });
  await assert.rejects(() => upd(choice(true, ["PL"], 4900)), /Polen ist nicht in der Freigabeliste/);
  await assert.rejects(() => upd(choice(true, [], 4900)), /konkret genehmigten Länder/);
  await assert.rejects(() => upd(choice(true, ["AT"], -1)), /zwischen 0,00 € und 100.000,00 €/);
  await assert.rejects(() => upd(choice(true, ["AT"], 10_000_001)), /zwischen 0,00 € und 100.000,00 €/);
  await assert.rejects(() => upd(choice(true, ["AT"], 12.5)), /zwischen 0,00 € und 100.000,00 €/);
  await assert.rejects(() => upd(choice(true, ["AT"], 4900)), /entspricht bereits dem vereinbarten Stand/);
  await assert.rejects(() => upd(choice(false, [], 0, "ab")), /mindestens 3 Zeichen/);
  await assert.rejects(() => upd(choice(false, [], 0, "😀😀")), /mindestens 3 Zeichen/, "Meldung statt Datenbankfehler");
  await assert.rejects(() => upd(choice(false, [], 0, "<b>a</b>")), /mindestens 3 Zeichen/, "nach dem Entfernen von HTML geprüft");
  // nicht zusammen mit einer allgemeinen Preisänderung (beide Reihenfolgen)
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: 1000, priceReason: "Zuschlag" });
  await assert.rejects(() => upd(choice(true, ["AT"], 8000)), /eigenen Nachtrag/);
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: null, priceReason: null });
  await upd(choice(true, ["AT", "CH"], 8000));
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: 1000, priceReason: "Zuschlag" }), /eigenen Nachtrag/);
  // nur Länderänderung (Unterschied 0) darf neben einer Preisänderung stehen
  await upd(choice(true, ["AT", "CH"], 4900));
  const both = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: 1000, priceReason: "Zuschlag" });
  assert.deepEqual([both.priceDeltaCents, both.abroadSurchargeDeltaCents], [1000, 0]);
  // fremder Mandant
  const other = await createWorld("s2-valid-other");
  tenants.push(other.tenantId);
  await assert.rejects(() => updateAmendmentDraft(other.tenantId, other.actor, a.id, { abroad: choice(true, ["AT"], 0) }), /Nachtrag nicht gefunden/);
  await assert.rejects(() => getAmendmentState(other.tenantId, a.id), /Nachtrag nicht gefunden/);
  // Bereich abwählen entfernt die Auslandsänderung vollständig
  const cleared = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: null, priceDeltaCents: null, priceReason: null });
  assert.deepEqual([cleared.newAbroadAllowed, cleared.newAbroadCountries, cleared.newAbroadSurchargeCents, cleared.abroadSurchargeDeltaCents], [null, [], null, null]);
  // negativer Gesamtpreis: erst Preisnachtrag bis knapp über den Aufpreis, dann Entzug
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: -(total0 - 1000), priceReason: "Kulanz nach Panne" });
  await signed(w, a.id);
  const b = await draft(w, "v2");
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, b.id, { abroad: choice(false, [], 0, "Kunde bleibt im Inland") }), /Vertragsgesamtpreis würde negativ/);
  await discardAmendment(w.tenantId, w.actor, b.id);
});

test("S2-5 Bestandsschutz: bereits genehmigte Länder bleiben trotz verkleinerter Freigabeliste zulässig, neue Länder nur aus der aktuellen Liste", async () => {
  const w = await abroadWorld("s2-kept", { allowed: true, countries: ["AT", "CH"], cents: 4900 });
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { abroadAllowed: true, abroadCountries: ["AT"] } } });
  const a = await draft(w, "k");
  assert.deepEqual((await getAmendmentState(w.tenantId, a.id)).abroadOptions?.kept, ["AT", "CH"]);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: choice(true, ["AT", "CH", "FR"], 4900) }), /Frankreich ist nicht in der Freigabeliste/);
  const ok = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: choice(true, ["AT", "CH"], 8000) });
  assert.equal(ok.abroadSurchargeDeltaCents, 3100);
  // Freigabe insgesamt zurückgenommen: Bestand bleibt ändern- und unterschreibbar, Neues nicht
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { abroadAllowed: false, abroadCountries: [] } } });
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: choice(true, ["AT", "CH", "FR"], 8000) }), /nicht vorgesehen. Eine Freigabe per Nachtrag/);
  const n = await signed(w, a.id);
  assert.deepEqual((await effectiveStateForBooking(w.tenantId, w.bookingId))!.abroad, { allowed: true, countries: ["AT", "CH"], surchargeCents: 8000 });
  assert.equal((n.snapshot as unknown as AmendmentSnapshot).abroad?.deltaCents, 3100);
});

test("S2-6 Entzug und Senkung: Grund Pflicht, Aufpreis 0, Unterschied negativ; vorab vereinbaren nicht möglich; Freigabeliste und Stand beim Unterschreiben erneut geprüft", async () => {
  const w = await abroadWorld("s2-revoke", { allowed: true, countries: ["AT", "FR"], cents: 4900 });
  const total0 = await contractTotal(w);
  const a = await draft(w, "r");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: choice(false, [], 0) });
  assert.ok((await getAmendmentState(w.tenantId, a.id)).issues.some((i) => i.code === "ABROAD_REASON"));
  await assert.rejects(() => signed(w, a.id), /nicht mehr gestattet ist/);
  await assert.rejects(() => agreeAmendment(w.tenantId, w.actor, a.id, { channel: "PHONE" }), /nur eine Änderung des Mietzeitraums/);
  // auch zusammen mit einer Verlängerung: die Auslandsänderung wird nicht vorab vereinbart (sonst würde sie ohne Unterschrift „fest“)
  const end0 = (await effectiveStateForBooking(w.tenantId, w.bookingId))!.endAt!;
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: new Date(end0.getTime() + 86_400_000) });
  await assert.rejects(() => agreeAmendment(w.tenantId, w.actor, a.id, { channel: "PHONE" }), /Auslandsfahrten werden nicht vorab vereinbart/);
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: null });
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: choice(false, [], 0, "Kunde bleibt im Inland") });
  const n = await signed(w, a.id);
  assert.equal(n.abroadSurchargeDeltaCents, -4900);
  const eff = (await effectiveStateForBooking(w.tenantId, w.bookingId))!;
  assert.deepEqual(eff.abroad, { allowed: false, countries: [], surchargeCents: 0 });
  assert.equal(eff.totalCents, total0 - 4900);
  // Senkung ohne Grund
  const b = await draft(w, "r2");
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { abroad: choice(true, ["FR"], 2000) });
  await signed(w, b.id);
  const c = await draft(w, "r3");
  await updateAmendmentDraft(w.tenantId, w.actor, c.id, { abroad: choice(true, ["FR"], 1000) });
  assert.ok((await getAmendmentState(w.tenantId, c.id)).issues.some((i) => i.code === "ABROAD_REASON" && /Senkung/.test(i.message)));
  // Freigabeliste nach dem Speichern geändert: beim Unterschreiben erneut geprüft (FR hat Bestandsschutz, CH nicht)
  await updateAmendmentDraft(w.tenantId, w.actor, c.id, { abroad: choice(true, ["FR", "CH"], 3000) });
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { abroadAllowed: true, abroadCountries: ["AT"] } } });
  await assert.rejects(() => signed(w, c.id), /Schweiz ist nicht in der Freigabeliste/);
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: RULES } });
  // veralteter Unterschied (Absicherung): direkt verfälscht → Unterschrift abgelehnt
  await db.contractAmendment.update({ where: { id: c.id }, data: { abroadSurchargeDeltaCents: 999 } });
  assert.ok((await getAmendmentState(w.tenantId, c.id)).issues.some((i) => i.code === "ABROAD_STALE"));
  await assert.rejects(() => signed(w, c.id), /inzwischen geändert/);
  await discardAmendment(w.tenantId, w.actor, c.id);
});

test("S2-7 Telefonische Zustimmung (Paket 1) gilt auch für eine Auslandsänderung", async () => {
  const w = await abroadWorld("s2-phone");
  const a = await draft(w, "p");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { abroad: choice(true, ["CH"], 0) });
  const hash = await getAmendmentContentHash(w.tenantId, a.id);
  const res = await signAmendment(w.tenantId, w.actor, a.id, { phoneConsent: { confirmed: true, seenHash: hash, note: "Anruf 10:15" } });
  const snap = res.amendment.snapshot as unknown as AmendmentSnapshot;
  assert.equal(snap.consent?.method, "PHONE");
  assert.deepEqual(snap.abroad?.after, { allowed: true, countries: ["CH"], surchargeCents: 0 });
  assert.equal(res.amendment.abroadSurchargeDeltaCents, 0);
});

test("S2-8 Datenbank-Prüfregeln: vollständige Angaben, getrennte Beträge, kein „vorab vereinbart“, Grund 3–300 Zeichen", async () => {
  const w = await abroadWorld("s2-db");
  const ok = { tenantId: w.tenantId, contractId: w.contractId, bookingId: w.bookingId };
  const mk = (data: Record<string, unknown>) => db.contractAmendment.create({ data: { ...ok, idempotencyKey: nonce("db"), ...data } });
  const full = { newAbroadAllowed: true, newAbroadCountries: ["AT"], newAbroadSurchargeCents: 1000, abroadSurchargeDeltaCents: 1000 };
  await assert.rejects(() => mk({ ...full, priceDeltaCents: 500 }), /rb_amendment_abroad_separate/);
  await assert.rejects(() => mk({ newAbroadAllowed: true, newAbroadCountries: [], newAbroadSurchargeCents: 1000, abroadSurchargeDeltaCents: 1000 }), /rb_amendment_abroad/);
  await assert.rejects(() => mk({ newAbroadAllowed: false, newAbroadCountries: ["AT"], newAbroadSurchargeCents: 0, abroadSurchargeDeltaCents: 0 }), /rb_amendment_abroad/);
  await assert.rejects(() => mk({ newAbroadAllowed: false, newAbroadCountries: [], newAbroadSurchargeCents: 100, abroadSurchargeDeltaCents: 100 }), /rb_amendment_abroad/);
  await assert.rejects(() => mk({ ...full, newAbroadSurchargeCents: 10_000_001 }), /rb_amendment_abroad/);
  await assert.rejects(() => mk({ ...full, abroadSurchargeDeltaCents: null }), /rb_amendment_abroad/);
  await assert.rejects(() => mk({ ...full, abroadReason: "ab" }), /rb_amendment_abroad/);
  await assert.rejects(() => mk({ newAbroadCountries: ["AT"] }), /rb_amendment_abroad/, "Länder ohne Auslandsänderung");
  await assert.rejects(() => mk({ ...full, status: "AGREED", newEndAt: new Date(Date.now() + 9 * 86_400_000), agreedAt: new Date(), agreedChannel: "PHONE" }), /rb_amendment_abroad_not_agreed|rb_amendment_agreed/);
  const fine = await mk({ ...full, abroadReason: "Kunde fährt nach Wien" });
  assert.equal(fine.status, "DRAFT");
  await db.contractAmendment.delete({ where: { id: fine.id } });
});

// ---------------------------------------------------------------------------
// Rechnung und Nachberechnung
// ---------------------------------------------------------------------------

test("S2-9 Rechnung: Erhöhung als eigene Position (Nachtragsbezug, Standardsteuersatz), Vertragsposition unverändert, Summe = wirksamer Preis, nichts offen", async () => {
  const w = await abroadWorld("s2-inv-up", { allowed: true, countries: ["AT"], cents: 4900 });
  const n = await abroadAmendment(w, "up", choice(true, ["AT"], 8000));
  await finishReturn(w);
  const { inv, items } = await draftItems(w);
  const extra = items.filter((i) => i.source === "RENTAL" && i.description.startsWith("Auslandsfahrt-Aufpreis"));
  assert.equal(extra.length, 1);
  assert.equal(cents(extra[0]), 4900, "Vertragsposition bleibt 49 €");
  assert.doesNotMatch(extra[0].description, /gemindert/);
  const am = items.filter((i) => i.source === "AMENDMENT");
  assert.equal(am.length, 1, "genau eine Nachtragsposition");
  assert.equal(am[0].amendmentId, n.id);
  assert.equal(cents(am[0]), 3100);
  assert.equal(Number(am[0].taxRate), 19, "Standardsteuersatz wie die Vertragsposition");
  assert.equal(nbsp(am[0].description), `Auslandsfahrt (Österreich), Erhöhung des einmaligen Aufpreises auf gesamt 80,00 €, laut Nachtrag ${n.number} zum Mietvertrag ${(await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } })).number}`);
  const eff = (await effectiveStateForBooking(w.tenantId, w.bookingId))!;
  assert.equal(items.filter((i) => i.source !== "EXTRA_CHARGE").reduce((s, i) => s + cents(i), 0), eff.totalCents, "Summe = wirksamer Gesamtpreis");
  await finalizeInvoice(w.tenantId, inv.id, w.actor);
  assert.ok((await verifyInvoice(w.tenantId, inv.id)).intact);
  assert.deepEqual(await pendingSettlements(w.tenantId, w.bookingId), [], "nichts offen");
  await assert.rejects(() => createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: n.id, nonce: nonce("s") }), /bereits in einer abgeschlossenen Rechnung/);
});

test("S2-10 Rechnung: Senkung mindert nur Auslandspositionen (zuletzt vereinbarte zuerst), nie die Fahrzeugmiete; 0-€-Position bleibt mit Bezug", async () => {
  const w = await abroadWorld("s2-inv-down", { allowed: true, countries: ["AT"], cents: 4900 });
  const total0 = await contractTotal(w);
  const up = await abroadAmendment(w, "up", choice(true, ["AT"], 8000));
  const down = await abroadAmendment(w, "down", choice(true, ["AT"], 2000, "Kulanz wegen Umweg"));
  await finishReturn(w);
  const { inv, items } = await draftItems(w);
  const rental = items.find((i) => i.source === "RENTAL" && i.description.startsWith("Fahrzeugmiete"))!;
  assert.equal(cents(rental), total0 - 4900, "Fahrzeugmiete unverändert");
  assert.doesNotMatch(rental.description, /Preisminderung/);
  const extra = items.find((i) => i.description.startsWith("Auslandsfahrt-Aufpreis"))!;
  assert.equal(cents(extra), 2000);
  assert.match(extra.description, new RegExp(`gemindert laut Nachtrag ${down.number}`));
  const am = items.filter((i) => i.source === "AMENDMENT");
  assert.deepEqual(am.map((i) => [i.amendmentId, cents(i)]), [[up.id, 0]], "Erhöhung auf 0 € gemindert, Senkung keine eigene Position");
  assert.match(am[0].description, new RegExp(`gemindert laut Nachtrag ${down.number}`));
  assert.equal(items.filter((i) => i.source !== "EXTRA_CHARGE").reduce((s, i) => s + cents(i), 0), total0 - 4900 + 2000);
  await finalizeInvoice(w.tenantId, inv.id, w.actor);
  assert.deepEqual(await pendingSettlements(w.tenantId, w.bookingId), [], "0-€-Position zählt als abgerechnet; Senkung vor der Rechnung wirksam");
});

test("S2-11 Rechnung: Entzug und neue Genehmigung – Vertragsposition 0 €, neue Position voll; allgemeine Minderung kürzt auch Erhöhungen (keine Lücke)", async () => {
  const w = await abroadWorld("s2-inv-regrant", { allowed: true, countries: ["AT"], cents: 4900 });
  const total0 = await contractTotal(w);
  await abroadAmendment(w, "revoke", choice(false, [], 0, "Reise abgesagt"));
  const regrant = await abroadAmendment(w, "regrant", choice(true, ["CH"], 3000));
  await finishReturn(w);
  const { items } = await draftItems(w);
  assert.equal(cents(items.find((i) => i.description.startsWith("Auslandsfahrt-Aufpreis"))!), 0);
  const am = items.filter((i) => i.source === "AMENDMENT");
  assert.deepEqual(am.map((i) => [i.amendmentId, cents(i)]), [[regrant.id, 3000]]);
  assert.match(nbsp(am[0].description), /^Auslandsfahrt \(Schweiz\), einmaliger Aufpreis, laut Nachtrag/);
  assert.equal(items.filter((i) => i.source !== "EXTRA_CHARGE").reduce((s, i) => s + cents(i), 0), total0 - 4900 + 3000);

  // bisherige Lücke: Miete R, Erhöhung +50 €, Minderung −(R + 40 €) → wirksam 10 €; die Rechnung ergibt jetzt genau 10 €
  const v = await pickedUpWorld("s2-inv-gap");
  tenants.push(v.tenantId);
  const r0 = await contractTotal(v);
  const p1 = await draft(v, "p1");
  await updateAmendmentDraft(v.tenantId, v.actor, p1.id, { priceDeltaCents: 5000, priceReason: "Zusatzleistung" });
  const n1 = await signed(v, p1.id);
  const p2 = await draft(v, "p2");
  await updateAmendmentDraft(v.tenantId, v.actor, p2.id, { priceDeltaCents: -(r0 + 4000), priceReason: "Kulanz nach Panne" });
  const n2 = await signed(v, p2.id);
  await finishReturn(v);
  const g = await draftItems(v);
  const inc = g.items.find((i) => i.amendmentId === n1.id)!;
  assert.equal(cents(inc), 1000);
  assert.match(inc.description, new RegExp(`gemindert laut Nachtrag ${n2.number}\\)$`), "nennt den tatsächlich mindernden Nachtrag");
  assert.equal(g.items.filter((i) => i.source !== "EXTRA_CHARGE").reduce((s, i) => s + cents(i), 0), 1000, "Summe = wirksamer Preis (vorher 50 €)");
});

test("S2-12 Nachberechnung nach abgeschlossener Mietrechnung: Erhöhung → eigene Rechnung (einmalig), Senkung → Gutschrift-Weg", async () => {
  const w = await returnedWorld("s2-settle", {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.tenant.update({ where: { id: x.tenantId }, data: { businessRules: RULES } });
      await db.booking.update({ where: { id: x.bookingId }, data: abroadData({ allowed: true, countries: ["AT"], cents: 4900 }) });
    },
  });
  const contract = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  await finalizeInvoice(w.tenantId, inv.id, w.actor);
  // Nachträge nach der Rückgabe sind fachlich gesperrt – für die Absicherung direkt als wirksam angelegt
  const base = { tenantId: w.tenantId, contractId: w.contractId, bookingId: w.bookingId, status: "SIGNED", contentHash: contentHash({ x: 2 }), signedAt: new Date(), createdById: w.actor.id, createdByName: w.actor.name };
  const snapshot = { v: 1, contract: { startAt: contract.startAt.toISOString() }, before: { endAt: contract.endAt!.toISOString() }, abroad: { before: { allowed: true, countries: ["AT"], surchargeCents: 4900 } } };
  const up = await db.contractAmendment.create({ data: { ...base, number: "NT-2026-910001", sequenceNo: 1, snapshot, newAbroadAllowed: true, newAbroadCountries: ["AT", "CH"], newAbroadSurchargeCents: 7900, abroadSurchargeDeltaCents: 3000, idempotencyKey: nonce("up") } });
  const down = await db.contractAmendment.create({ data: { ...base, number: "NT-2026-910002", sequenceNo: 2, snapshot, newAbroadAllowed: true, newAbroadCountries: ["AT"], newAbroadSurchargeCents: 1000, abroadSurchargeDeltaCents: -6900, abroadReason: "Kulanz", idempotencyKey: nonce("down") } });
  const flat = await db.contractAmendment.create({ data: { ...base, number: "NT-2026-910003", sequenceNo: 3, snapshot, newAbroadAllowed: true, newAbroadCountries: ["AT", "FR"], newAbroadSurchargeCents: 1000, abroadSurchargeDeltaCents: 0, idempotencyKey: nonce("flat") } });
  assert.deepEqual((await pendingSettlements(w.tenantId, w.bookingId)).map((p) => [p.amendment.id, p.deltaCents]), [[up.id, 3000], [down.id, -6900]], "Länderänderung ohne Unterschied ist nichts abzurechnen");
  const s1 = await createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: up.id, nonce: nonce("s1") });
  const s2 = await createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: up.id, nonce: nonce("s2") });
  assert.equal(s1.created, true); assert.equal(s2.created, false); assert.equal(s1.invoice.id, s2.invoice.id, "einmalig je Nachtrag");
  const v = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId: s1.invoice.id }, include: { items: true } });
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].amendmentId, up.id);
  assert.equal(cents(v.items[0]), 3000);
  assert.match(nbsp(v.items[0].description), /^Auslandsfahrt \(Österreich, Schweiz\), Erhöhung des einmaligen Aufpreises auf gesamt 79,00 €, laut Nachtrag NT-2026-910001/);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(v.servicePeriodStart.getTime(), bk.actualPickupAt!.getTime(), "Leistungszeitraum = tatsächliche Mietdauer");
  assert.equal(v.servicePeriodEnd.getTime(), bk.actualReturnAt!.getTime());
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "FINALIZED", "abgeschlossene Mietrechnung unverändert");
  await assert.rejects(() => createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: down.id, nonce: nonce("neg") }), /Gutschrift/);
  await assert.rejects(() => createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: flat.id, nonce: nonce("flat") }), /keine Preiserhöhung/);
  const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, action: "AMENDMENT_SETTLEMENT_CREATED" } });
  assert.equal(audit.amountCents, 3000);
});

test("S2-14 Nachberechnung: eine durch spätere Minderung bereits ausgeglichene Erhöhung wird nie (voll) nachberechnet", async () => {
  const w = await returnedWorld("s2-settle-alloc", {
    beforeContract: async (x) => {
      tenants.push(x.tenantId);
      await db.tenant.update({ where: { id: x.tenantId }, data: { businessRules: RULES } });
      await db.booking.update({ where: { id: x.bookingId }, data: abroadData({ allowed: true, countries: ["AT"], cents: 4900 }) });
    },
  });
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  await finalizeInvoice(w.tenantId, inv.id, w.actor);
  const created = (await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).createdAt;
  // wie „0-€-Position aus dem Entwurf gelöscht“: Nachträge waren vor der Mietrechnung wirksam, ihre Position fehlt in der Rechnung
  const before = new Date(created.getTime() - 60_000);
  const base = { tenantId: w.tenantId, contractId: w.contractId, bookingId: w.bookingId, status: "SIGNED", contentHash: contentHash({ x: 3 }), signedAt: before, createdById: w.actor.id, createdByName: w.actor.name, snapshot: { v: 1, before: { endAt: new Date().toISOString() } } };
  const mk = (n: number, d: Record<string, unknown>) => db.contractAmendment.create({ data: { ...base, number: `NT-2026-92000${n}`, sequenceNo: n, idempotencyKey: nonce(`a${n}`), ...d } });
  const up = await mk(1, { newAbroadAllowed: true, newAbroadCountries: ["AT"], newAbroadSurchargeCents: 8000, abroadSurchargeDeltaCents: 3100 });
  const down = await mk(2, { newAbroadAllowed: true, newAbroadCountries: ["AT"], newAbroadSurchargeCents: 6000, abroadSurchargeDeltaCents: -2000, abroadReason: "Kulanz" });
  const up2 = await mk(3, { newAbroadAllowed: true, newAbroadCountries: ["AT", "CH"], newAbroadSurchargeCents: 6500, abroadSurchargeDeltaCents: 500 });
  await mk(4, { newAbroadAllowed: true, newAbroadCountries: ["AT"], newAbroadSurchargeCents: 6000, abroadSurchargeDeltaCents: -500, abroadReason: "Doch nur Österreich" });
  assert.deepEqual((await pendingSettlements(w.tenantId, w.bookingId)).map((p) => [p.amendment.number, p.deltaCents]), [["NT-2026-920001", 1100]], "nur der nicht ausgeglichene Rest; vollständig ausgeglichene Erhöhung nicht angeboten");
  const s = await createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: up.id, nonce: nonce("alloc") });
  const v = await db.invoiceVersion.findFirstOrThrow({ where: { invoiceId: s.invoice.id }, include: { items: true } });
  assert.equal(cents(v.items[0]), 1100);
  assert.match(v.items[0].description, new RegExp(`gemindert laut Nachtrag ${down.number}\\)$`));
  await assert.rejects(() => createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: up2.id, nonce: nonce("alloc2") }), /bereits vollständig ausgeglichen/);
  assert.deepEqual(await pendingSettlements(w.tenantId, w.bookingId), []);
});

// ---------------------------------------------------------------------------
// Dokument
// ---------------------------------------------------------------------------

test("S2-13 Nachtragsdokument und PDF zeigen alt/neu und den Stand nach dem Nachtrag; Nachträge ohne Ausland bleiben ohne Auslandsangaben", async () => {
  const w = await abroadWorld("s2-pdf", { allowed: true, countries: ["AT"], cents: 4900 });
  const n = await abroadAmendment(w, "pdf", choice(true, ["AT", "FR"], 6900));
  const data = await loadAmendmentDocumentData(w.tenantId, n.id);
  assert.deepEqual(data.doc.changes.map((c) => c.label), ["Auslandsfahrten"]);
  assert.match(nbsp(data.doc.changes[0].before), /Österreich/);
  assert.match(nbsp(data.doc.changes[0].note ?? ""), /\+20,00 € \(einmalig\)/);
  assert.equal(nbsp(data.doc.after.abroad ?? ""), nbsp(abroadStateText({ allowed: true, countries: ["AT", "FR"], surchargeCents: 6900 })));
  assert.equal(data.doc.after.total, fmtCents((await effectiveStateForBooking(w.tenantId, w.bookingId))!.totalCents));
  const pdf = await renderAmendmentPdf(data.doc, data.signatureImages, null);
  assert.ok(pdf.trace.texts.some((t) => t.includes("Auslandsfahrten")));
  assert.ok(pdf.trace.texts.some((t) => nbsp(t).includes("Frankreich")));
  assert.deepEqual(pdf.trace.boxes.filter((b) => b.overflow), [], "kein Text außerhalb des Satzspiegels");
  // ein Nachtrag ohne Auslandsänderung: kein Auslandsteil im versiegelten Inhalt
  const a = await draft(w, "plain");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { agreementText: "Dachbox inklusive" });
  const plain = await signed(w, a.id);
  assert.equal(JSON.stringify(plain.snapshot).includes("\"abroad\""), false);
  assert.equal((await loadAmendmentDocumentData(w.tenantId, plain.id)).doc.after.abroad, null);
});
