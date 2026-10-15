// Buchungsentwurf („Zwischenspeichern“ in der Buchungsanlage): reine Logik mit einem nachgebildeten Browser-Speicher und
// Quelltext-Prüfungen, dass beim Zwischenspeichern nichts an den Server geht (keine Buchung, Zahlung, Kaution, Reservierung).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DRAFT_MAX_AGE_MS,
  DRAFT_MAX_COUNT,
  draftSnapshot,
  draftStorageKey,
  effectivePayIntent,
  isDraftId,
  localInputText,
  parseDrafts,
  patchPayment,
  pruneExpiredDrafts,
  readDrafts,
  removeDraft,
  removeDraftEverywhere,
  restoreTargets,
  sanitizeDraftData,
  saveDraft,
  type BookingDraftData,
  type DraftScope,
  type DraftStorage,
} from "../src/lib/booking-draft";

const src = (p: string) => readFile(path.join(process.cwd(), p), "utf8");

class MemoryStorage implements DraftStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const A: DraftScope = { tenantId: "tenant-a", userId: "user-1" };
const NOW = Date.UTC(2026, 9, 15, 12, 0);
let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function data(over: Partial<BookingDraftData> = {}): BookingDraftData {
  return sanitizeDraftData({
    vehicleId: "veh1",
    startAt: "2026-10-20T09:00",
    endAt: "2026-10-23T09:00",
    notes: "Abholung am Nebeneingang",
    customerMode: "existing",
    customerId: "cus1",
    tariff: { ratePlanId: "plan1", regularCents: 30000, price: { on: false, text: "", reason: "" }, km: { on: false, policy: "FREE_KILOMETERS", perDay: "", rate: "", reason: "" }, deposit: { on: false, text: "", reason: "" } },
    pay: { intent: "NONE", amount: "", fullCents: null, method: "CASH", paidAt: "2026-10-15T11:10", reference: "", note: "" },
    dep: { received: false, amount: null, method: "CASH", occurredAt: "2026-10-15T11:10", reference: "", note: "" },
    ...over,
  });
}

function saveNew(storage: DraftStorage, d: BookingDraftData, scope = A, now = NOW) {
  const r = saveDraft(storage, scope, { id: null, knownRev: 0, data: d, newId: ids, now });
  assert.ok(r.ok);
  return r.draft;
}

test("1–3: Mietzahlung vollständig, teilweise und offen – Entwurf speichern und unverändert wieder lesen", () => {
  const s = new MemoryStorage();
  const full = saveNew(s, data({ pay: { intent: "FULL", amount: "300,00", fullCents: 30000, method: "CASH", paidAt: "2026-10-15T11:10", reference: "", note: "" } }));
  const partial = saveNew(s, data({ pay: { intent: "PARTIAL", amount: "150,00", fullCents: null, method: "BANK_TRANSFER", paidAt: "2026-10-15T11:10", reference: "", note: "" } }));
  const open = saveNew(s, data());
  const back = readDrafts(s, A, NOW);
  assert.equal(back.length, 3);
  const byId = (id: string) => back.find((d) => d.id === id)!;
  assert.deepEqual([byId(full.id).pay.intent, byId(full.id).pay.amount, byId(full.id).pay.fullCents], ["FULL", "300,00", 30000]);
  assert.deepEqual([byId(partial.id).pay.intent, byId(partial.id).pay.amount, byId(partial.id).pay.method], ["PARTIAL", "150,00", "BANK_TRANSFER"]);
  assert.deepEqual([byId(open.id).pay.intent, byId(open.id).pay.amount], ["NONE", ""]);
});

test("Review: Datum nur bei erfasster Zahlung/Kaution, Kautionsbetrag nur bei „jetzt erhalten“ – sonst beim Fortsetzen „jetzt“ bzw. vereinbarte Kaution", () => {
  const d = data({ pay: { intent: "NONE", amount: "", fullCents: null, method: "CASH", paidAt: "2026-10-10T14:00", reference: "", note: "" }, dep: { received: false, amount: "500,00", method: "CASH", occurredAt: "2026-10-10T14:00", reference: "", note: "" } });
  assert.deepEqual([d.pay.paidAt, d.dep.occurredAt, d.dep.amount], ["", "", null]);
  const p = data({ pay: { intent: "PARTIAL", amount: "50,00", fullCents: null, method: "CASH", paidAt: "2026-10-10T14:00", reference: "", note: "" }, dep: { received: true, amount: "500,00", method: "CASH", occurredAt: "2026-10-10T14:05", reference: "", note: "" } });
  assert.deepEqual([p.pay.paidAt, p.dep.occurredAt, p.dep.amount], ["2026-10-10T14:00", "2026-10-10T14:05", "500,00"], "erfasste Angaben bleiben");
});

test("Review: Schutz für „Vollständig bezahlt“ bleibt bei Änderung von Zahlungsart/Datum/Referenz/Notiz, endet bei Status oder Betrag", () => {
  type P = { intent: "NONE" | "PARTIAL" | "FULL"; amount: string; method: string; reference: string; fullCheck?: number | null };
  const restored: P = { intent: "FULL", amount: "100,00", method: "CASH", reference: "", fullCheck: 10000 };
  const notReady = effectivePayIntent(restored.intent, restored.fullCheck, { ready: false, totalCents: 0 });
  let p = patchPayment(restored, notReady, { method: "CARD" });
  p = patchPayment(p, effectivePayIntent(p.intent, p.fullCheck, { ready: false, totalCents: 0 }), { reference: "Beleg 1" });
  assert.equal(p.fullCheck, 10000, "Prüfung bleibt");
  assert.deepEqual(effectivePayIntent(p.intent, p.fullCheck, { ready: true, totalCents: 14000 }), { intent: "PARTIAL", mismatch: true }, "später berechneter anderer Preis wird erkannt");
  const chosen = patchPayment(p, notReady, { intent: "FULL" });
  assert.equal(chosen.fullCheck, undefined, "bewusst gewählt");
  const shown = patchPayment(p, { intent: "PARTIAL", mismatch: true }, { method: "BANK_TRANSFER" });
  assert.deepEqual([shown.intent, shown.fullCheck, shown.amount], ["PARTIAL", undefined, "100,00"], "angezeigte Teilzahlung wird übernommen");
});

test("Review: abgelaufene Entwürfe werden im Browser tatsächlich entfernt (alle Schlüssel), gültige bleiben", () => {
  const s = new MemoryStorage();
  const B: DraftScope = { tenantId: "tenant-b", userId: "user-9" };
  saveNew(s, data(), A, NOW - DRAFT_MAX_AGE_MS - 1);
  const keep = saveNew(s, data({ notes: "frisch" }), A, NOW);
  saveNew(s, data(), B, NOW - DRAFT_MAX_AGE_MS - 10);
  s.setItem(`${draftStorageKey(B)}x`, "kaputt");
  pruneExpiredDrafts(s, NOW);
  assert.deepEqual(JSON.parse(s.getItem(draftStorageKey(A))!).map((d: { id: string }) => d.id), [keep.id]);
  assert.equal(s.getItem(draftStorageKey(B)), null);
  assert.equal(s.getItem(`${draftStorageKey(B)}x`), null);
});

test("4–5: Kaution erhalten bzw. nicht erhalten – getrennt von der Miete gespeichert", () => {
  const s = new MemoryStorage();
  const got = saveNew(s, data({ dep: { received: true, amount: "200,00", method: "CARD", occurredAt: "2026-10-15T11:12", reference: "K-1", note: "bar" } }));
  const not = saveNew(s, data());
  const back = readDrafts(s, A, NOW);
  const g = back.find((d) => d.id === got.id)!;
  const n = back.find((d) => d.id === not.id)!;
  assert.deepEqual(g.dep, { received: true, amount: "200,00", method: "CARD", occurredAt: "2026-10-15T11:12", reference: "K-1", note: "bar" });
  assert.equal(g.pay.intent, "NONE", "Kaution ist keine Mietzahlung");
  assert.equal(n.dep.received, false);
  assert.equal(n.dep.amount, null);
});

test("6: Zahlungsart, Datum und Referenz bleiben erhalten (Miete und Kaution)", () => {
  const s = new MemoryStorage();
  const d = saveNew(s, data({ pay: { intent: "PARTIAL", amount: "99,50", fullCents: null, method: "CARD", paidAt: "2026-10-14T16:45", reference: "Beleg 4711", note: "Anzahlung" }, dep: { received: true, amount: "150,00", method: "OTHER", occurredAt: "2026-10-14T16:50", reference: "Quittung 12", note: "" } }));
  const [back] = readDrafts(s, A, NOW);
  assert.equal(back.id, d.id);
  assert.deepEqual([back.pay.method, back.pay.paidAt, back.pay.reference, back.pay.note], ["CARD", "2026-10-14T16:45", "Beleg 4711", "Anzahlung"]);
  assert.deepEqual([back.dep.method, back.dep.occurredAt, back.dep.reference], ["OTHER", "2026-10-14T16:50", "Quittung 12"]);
});

test("7: Entwurf nach erneutem Öffnen wiederherstellbar – Fahrzeug, Zeitraum, Kunde und Tarifauswahl mit Abweichungen", () => {
  const s = new MemoryStorage();
  const d = saveNew(s, data({ tariff: { ratePlanId: "plan2", regularCents: 30000, price: { on: true, text: "280,00", reason: "Stammkunde" }, km: { on: true, policy: "UNLIMITED", perDay: "", rate: "", reason: "Urlaubsfahrt" }, deposit: { on: true, text: "150,00", reason: "Sondervereinbarung" } } }));
  // „Neu öffnen“: neuer Speicherzugriff auf denselben Text, wie nach dem Neuladen der Seite
  const reopened = new MemoryStorage();
  reopened.map = new Map(s.map);
  const back = readDrafts(reopened, A, NOW + 60_000).find((x) => x.id === d.id)!;
  assert.deepEqual(back.tariff, { ratePlanId: "plan2", regularCents: 30000, price: { on: true, text: "280,00", reason: "Stammkunde" }, km: { on: true, policy: "UNLIMITED", perDay: "", rate: "", reason: "Urlaubsfahrt" }, deposit: { on: true, text: "150,00", reason: "Sondervereinbarung" } });
  const t = restoreTargets(back, [{ id: "veh1", status: "AVAILABLE" }], "cus1", { startAt: "x", endAt: "y" }, "2026-10-15T14:00");
  assert.deepEqual([t.vehicleId, t.startAt, t.endAt, t.customerOk, t.notices.length], ["veh1", "2026-10-20T09:00", "2026-10-23T09:00", true, 0]);
});

test("7b: Wiederherstellung prüft erneut – fremdes/deaktiviertes Fahrzeug, unbekannter Kunde, Vergangenheit, Neukunde ohne Daten", () => {
  const d = data({ startAt: "2026-10-10T09:00" });
  const t = restoreTargets(d, [{ id: "veh1", status: "INACTIVE" }], null, { startAt: "2026-10-16T09:00", endAt: "2026-10-17T09:00" }, "2026-10-15T14:00");
  assert.equal(t.vehicleId, "", "deaktiviertes Fahrzeug wird nicht übernommen");
  assert.equal(t.customerOk, false, "Kunde nur, wenn der Server ihn für diesen Mandanten geladen hat");
  assert.ok(t.notices.some((n) => n.includes("Fahrzeug")));
  assert.ok(t.notices.some((n) => n.includes("Kunde")));
  assert.ok(t.notices.some((n) => n.includes("Vergangenheit")));
  const other = restoreTargets(d, [{ id: "veh2", status: "AVAILABLE" }], "cus-fremd", { startAt: "a", endAt: "b" }, "2026-10-01T00:00");
  assert.deepEqual([other.vehicleId, other.customerOk], ["", false], "Fahrzeug nicht in der Liste dieses Mandanten, anderer Kunde geladen");
  const fresh = restoreTargets(data({ customerMode: "new", customerId: "cus1" }), [], null, { startAt: "a", endAt: "b" }, "2026-10-01T00:00");
  assert.ok(fresh.notices.some((n) => n.includes("neuen Kunden")));
  const broken = restoreTargets(sanitizeDraftData({ startAt: "gestern", endAt: "2026-10-20T09:00" }), [], null, { startAt: "2026-10-16T09:00", endAt: "2026-10-17T09:00" }, "2026-10-01T00:00");
  assert.deepEqual([broken.startAt, broken.endAt], ["2026-10-16T09:00", "2026-10-17T09:00"], "ungültiger Zeitraum → Vorschlag der Seite");
});

test("8: Entwurf verwerfen – nur dieser Entwurf, andere bleiben; letzter Entwurf entfernt den Schlüssel", () => {
  const s = new MemoryStorage();
  const a = saveNew(s, data());
  const b = saveNew(s, data({ notes: "zweiter" }));
  assert.ok(removeDraft(s, A, a.id, NOW));
  assert.deepEqual(readDrafts(s, A, NOW).map((d) => d.id), [b.id]);
  assert.ok(removeDraft(s, A, b.id, NOW));
  assert.equal(s.getItem(draftStorageKey(A)), null);
});

test("9/10/12: Entwurf enthält nur Whitelist-Felder – keine Kennung (Nonce), keine Tarifvorschau-Stände, keine Neukundendaten", () => {
  const s = new MemoryStorage();
  const sneaky = { ...data(), payNonce: "abc-12345678", depNonce: "abc-12345678-dep", seenRevisionId: "rev1", seenRegularCents: "30000", c_idNumber: "L01X00T47", c_licenseNumber: "B072RRE2I55", c_birthDate: "1980-01-01", customerLabel: "Muster, Erika", idempotencyKey: "x" };
  saveNew(s, sneaky as unknown as BookingDraftData);
  const text = s.getItem(draftStorageKey(A))!;
  for (const forbidden of ["Nonce", "nonce", "seenRevision", "seenRegular", "idNumber", "license", "birth", "Muster", "idempotency", "L01X00T47"]) assert.ok(!text.includes(forbidden), `nicht gespeichert: ${forbidden}`);
  const newCustomer = saveNew(s, data({ customerMode: "new", customerId: "cus1" }));
  assert.equal(newCustomer.customerId, "", "bei Neukunde nicht einmal eine Kunden-ID");
});

test("11: Mandanten und Benutzer getrennt – eigener Schlüssel, fremde Einträge werden beim Lesen verworfen", () => {
  const s = new MemoryStorage();
  const B: DraftScope = { tenantId: "tenant-b", userId: "user-1" };
  const U2: DraftScope = { tenantId: "tenant-a", userId: "user-2" };
  saveNew(s, data(), A);
  assert.notEqual(draftStorageKey(A), draftStorageKey(B));
  assert.notEqual(draftStorageKey(A), draftStorageKey(U2));
  assert.equal(readDrafts(s, B, NOW).length, 0, "anderer Mandant sieht nichts");
  assert.equal(readDrafts(s, U2, NOW).length, 0, "anderer Benutzer sieht nichts");
  // manipulierte Kopie unter fremdem Schlüssel: die Einträge tragen Mandant/Benutzer A und werden für B nicht übernommen
  s.setItem(draftStorageKey(B), s.getItem(draftStorageKey(A))!);
  assert.equal(readDrafts(s, B, NOW).length, 0);
  assert.equal(readDrafts(s, A, NOW).length, 1);
});

test("Mehrere Fenster: kein Vermischen – geänderter oder entfernter Entwurf wird nicht überschrieben/wiederbelebt, sondern neu angelegt", () => {
  const s = new MemoryStorage();
  const first = saveNew(s, data({ notes: "Fenster 1" }));
  // Fenster 2 setzt denselben Entwurf fort und speichert (rev 2)
  const w2 = saveDraft(s, A, { id: first.id, knownRev: first.rev, data: data({ notes: "Fenster 2" }), newId: ids, now: NOW + 1000 });
  assert.ok(w2.ok && w2.forked === null && w2.draft.rev === 2);
  // Fenster 1 kennt noch rev 1 → eigener neuer Entwurf, Fenster 2 bleibt unverändert
  const w1 = saveDraft(s, A, { id: first.id, knownRev: 1, data: data({ notes: "Fenster 1 geändert" }), newId: ids, now: NOW + 2000 });
  assert.ok(w1.ok && w1.forked === "changed" && w1.draft.id !== first.id);
  const all = readDrafts(s, A, NOW + 3000);
  assert.equal(all.find((d) => d.id === first.id)!.notes, "Fenster 2");
  assert.equal(all.find((d) => d.id === w1.draft.id)!.notes, "Fenster 1 geändert");
  // entfernt (z. B. nach der Anlage) → nicht unter alter Kennung wiederbeleben
  removeDraftEverywhere(s, first.id);
  const again = saveDraft(s, A, { id: first.id, knownRev: 2, data: data(), newId: ids, now: NOW + 4000 });
  assert.ok(again.ok && again.forked === "missing" && again.draft.id !== first.id);
  assert.ok(!readDrafts(s, A, NOW + 5000).some((d) => d.id === first.id));
});

test("Alte Entwürfe: nach 7 Tagen verworfen, höchstens 5 je Benutzer, Zukunft/Unsinn wird ignoriert", () => {
  const s = new MemoryStorage();
  const old = saveNew(s, data(), A, NOW - DRAFT_MAX_AGE_MS - 1);
  assert.ok(!readDrafts(s, A, NOW).some((d) => d.id === old.id), "abgelaufen");
  for (let i = 0; i < DRAFT_MAX_COUNT + 2; i++) saveNew(s, data({ notes: `n${i}` }), A, NOW + i);
  const list = readDrafts(s, A, NOW + 100);
  assert.equal(list.length, DRAFT_MAX_COUNT);
  assert.equal(list[0].notes, `n${DRAFT_MAX_COUNT + 1}`, "neueste zuerst");
  assert.deepEqual(parseDrafts("kein json", A, NOW), []);
  assert.deepEqual(parseDrafts(JSON.stringify({ v: 1 }), A, NOW), []);
  assert.deepEqual(parseDrafts(JSON.stringify([{ v: 1, id: "abcdefgh-1", tenantId: A.tenantId, userId: A.userId, savedAt: NOW + 3_600_000, rev: 1 }]), A, NOW), [], "aus der Zukunft");
});

test("Wiederherstellen validiert feldweise: ungültige Werte werden leer statt übernommen", () => {
  const d = sanitizeDraftData({
    vehicleId: "../x", startAt: "morgen", customerId: "<script>", notes: "x".repeat(25000),
    tariff: { ratePlanId: "plan 1", price: { on: "ja", text: "12x", reason: "r".repeat(400) }, km: { policy: "IRGENDWAS" } },
    pay: { intent: "__proto__", amount: "1e9", method: "BITCOIN", paidAt: "2026-13-01", reference: "y".repeat(200) },
    dep: { received: "true", amount: 5, method: "toString" },
  });
  assert.deepEqual([d.vehicleId, d.startAt, d.customerId, d.notes.length], ["", "", "", 20000]);
  assert.deepEqual([d.tariff.ratePlanId, d.tariff.price.on, d.tariff.price.text, d.tariff.price.reason.length, d.tariff.km.policy], ["", false, "", 300, "FREE_KILOMETERS"]);
  assert.deepEqual([d.pay.intent, d.pay.amount, d.pay.method, d.pay.reference.length], ["NONE", "", "CASH", 120]);
  assert.deepEqual([d.dep.received, d.dep.amount, d.dep.method], [false, null, "CASH"]);
});

test("Vollständig bezahlt nie still mit anderem Betrag: geänderter oder unbekannter Mietpreis → Teilzahlung über den gespeicherten Betrag", () => {
  assert.deepEqual(effectivePayIntent("FULL", 30000, { ready: true, totalCents: 30000 }), { intent: "FULL", mismatch: false });
  assert.deepEqual(effectivePayIntent("FULL", 30000, { ready: true, totalCents: 32000 }), { intent: "PARTIAL", mismatch: true });
  assert.deepEqual(effectivePayIntent("FULL", null, { ready: true, totalCents: 32000 }), { intent: "PARTIAL", mismatch: true });
  assert.deepEqual(effectivePayIntent("FULL", 30000, { ready: false, totalCents: 0 }), { intent: "FULL", mismatch: false }, "erst nach der Berechnung prüfen");
  assert.deepEqual(effectivePayIntent("FULL", undefined, { ready: true, totalCents: 32000 }), { intent: "FULL", mismatch: false }, "selbst gewählt → keine Prüfung");
  assert.deepEqual(effectivePayIntent("PARTIAL", 30000, { ready: true, totalCents: 32000 }), { intent: "PARTIAL", mismatch: false });
});

test("Hilfsfunktionen: Kennung, Anzeige, Vergleichswert", () => {
  assert.ok(isDraftId("00000000-0000-4000-8000-000000000001"));
  for (const bad of ["", "kurz", "a/b-12345678", "x".repeat(65), null, 5]) assert.ok(!isDraftId(bad));
  assert.equal(localInputText("2026-10-16T09:00"), "16.10.2026, 09:00");
  assert.equal(localInputText(""), "–");
  assert.equal(draftSnapshot(data()), draftSnapshot({ ...data(), extra: 1 } as unknown as BookingDraftData));
  assert.notEqual(draftSnapshot(data()), draftSnapshot(data({ notes: "anders" })));
});

test("9/10: Zwischenspeichern bleibt im Browser – keine Server-Aktion, kein fetch, Knopf ist kein Absende-Knopf", async () => {
  const lib = await src("src/lib/booking-draft.ts");
  assert.deepEqual(lib.match(/^import .*$/gm), ['import { PAYMENT_METHODS, RENTAL_PAYMENT_INTENTS, type PaymentMethod, type RentalPaymentIntent } from "@/lib/constants";'], "reine Logik, keine DB/Server-Importe");
  for (const f of ["src/lib/booking-draft.ts", "src/app/(app)/buchungen/booking-draft-store.ts", "src/app/(app)/buchungen/new-booking-form.tsx", "src/app/(app)/buchungen/booking-draft-cleanup.tsx"]) {
    const s = await src(f);
    assert.ok(!/fetch\(|"use server"|@\/lib\/db|prisma/.test(s), `${f}: nichts an den Server`);
  }
  const form = await src("src/app/(app)/buchungen/booking-form.tsx");
  assert.match(form, /<button type="button" onClick=\{saveDraftNow\}[^>]*>Zwischenspeichern<\/button>/);
  const save = /function saveDraftNow\(\) \{[\s\S]*?\n  \}/.exec(form)?.[0] ?? "";
  assert.ok(save.length > 100 && !/Action|formAction|fetch|startTransition/.test(save), "nur lokaler Speicher");
  assert.match(form, /<input type="hidden" name="payNonce" value=\{config\.nonce\} \/>/, "Kennung der Seite, nie aus dem Entwurf");
  assert.match(form, /<input type="hidden" name="depNonce" value=\{`\$\{config\.nonce\}-dep`\} \/>/);
});

test("12/13: Anlage unverändert mit Verfügbarkeits-, Tarif- und Preisprüfung; Entwurf nur für den Redirect zum Aufräumen", async () => {
  const actions = await src("src/app/(app)/buchungen/actions.ts");
  const fn = /export async function createBookingAction[\s\S]*?\n}/.exec(actions)?.[0] ?? "";
  for (const must of ["assertVehicleBookable(tx", "bookingTariffFor(tx", "seenRevisionId: selection.seenRevisionId", "seenRegularCents: selection.seenRegularCents", "insertRentalPayment(tx", "insertDepositReceived(tx", "expectFull: pay.intent === \"FULL\""]) assert.ok(fn.includes(must), must);
  assert.match(fn, /redirect\(isDraftId\(draftId\) \? `\/buchungen\/\$\{id\}\?ausEntwurf=\$\{draftId\}` : `\/buchungen\/\$\{id\}`\);/);
  assert.equal((fn.match(/draftId/g) ?? []).length, 4, "Entwurf beeinflusst nur den Redirect");
  const picker = await src("src/app/(app)/buchungen/tariff-picker.tsx");
  assert.match(picker, /<input type="hidden" name="seenRevisionId" value=\{offer\?\.revisionId \?\? ""\} \/>/, "Tarifstand immer aus der aktuellen Vorschau");
  assert.match(picker, /<input type="hidden" name="seenRegularCents" value=\{offer \? String\(offer\.regularCents\) : ""\} \/>/);
  const page = await src("src/app/(app)/buchungen/[id]/page.tsx");
  assert.match(page, /\{isDraftId\(sp\.ausEntwurf\) && <BookingDraftCleanup draftId=\{sp\.ausEntwurf\} \/>\}/);
  const cleanup = await src("src/app/(app)/buchungen/booking-draft-cleanup.tsx");
  assert.match(cleanup, /removeDraftEverywhere\(browserDraftStorage\(\), draftId\)/);
});

test("Nur neue Buchung: Bearbeiten nutzt kein Zwischenspeichern; Neu-Seite übergibt Mandant und Benutzer", async () => {
  const edit = await src("src/app/(app)/buchungen/[id]/page.tsx");
  const editForm = /<BookingForm[\s\S]*?\/>/.exec(edit)?.[0] ?? "";
  assert.ok(editForm.length > 50 && !editForm.includes("draft="), "Bearbeiten ohne Entwurf");
  const neu = await src("src/app/(app)/buchungen/neu/page.tsx");
  assert.match(neu, /const \{ tenant, user \} = await requireRole\("DISPO"\);/);
  assert.match(neu, /scope=\{\{ tenantId: tenant\.id, userId: user\.id \}\}/);
  assert.match(neu, /\{accidentEnabled && <RentalTypeSwitch current="STANDARD"/);
});
