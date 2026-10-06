// Befehl 29 Phase H: Wiedervorlagen als tägliche Arbeitssteuerung in der Unfallersatz-Zentrale (dieselben CaseFollowUp-Daten wie
// die Fallakte, keine eigene Aufgabentabelle) und Phase-G-Politur der Aktionsspalte. Prüft Gruppen und Texte, Zuständigkeit,
// „Meine“, Erledigen über die Phase-D-Logik mit Verlauf/Audit, Rollen (Hof, Supportmodus), Mandantentrennung, Heute-Anbindung,
// Fallabschluss und eine feste Zahl an Abfragen bei 100 Fällen mit vielen Wiedervorlagen.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import {
  cancelFollowUp, closeCase, closeWarnings, completeFollowUp, createAccidentCase, createFollowUp, FOLLOW_UP_ASSIGNEE_ROLES, followUpTiming, type CreateAccidentCaseInput,
} from "../src/lib/accident-replacement";
import { accidentCenter, resolveTaskView, TASK_PREVIEW_LIMIT, type AccidentCenter } from "../src/lib/accident-center";
import { caseFileAccess, caseFileHeader, caseFileHistory, caseFileOverview } from "../src/lib/accident-case-file";
import { loadDashboard } from "../src/lib/dashboard";
import { finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { finalizeHandover, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { getStorage } from "../src/lib/storage";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { zonedDayStartPlus } from "../src/lib/time";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { answerAll, photo, sign } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-ue-h-"));
  getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const HOUR = 3600_000, DAY = 24 * HOUR;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
/** 09:00-ähnlicher Zeitpunkt am Kalendertag heute + d (Europe/Berlin) – unabhängig von der Uhrzeit des Testlaufs */
const dayAt = (d: number) => plus(zonedDayStartPlus(new Date(), d), 9 * HOUR);
let seq = 0;
const nonce = () => `ue-h-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const src = (p: string) => readFile(path.join(process.cwd(), p), "utf8");

async function world(label: string): Promise<World> {
  await ready;
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });
  await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  return w;
}
const user = async (w: World, name: string, role: "OWNER" | "DISPO" | "YARD", active = true) =>
  db.user.create({ data: { tenantId: w.tenantId, email: `${nonce()}@example.test`, name, passwordHash: "x", role, active } });
const vehicle = async (w: World, plate?: string) => (await db.vehicle.create({ data: { tenantId: w.tenantId, plate: plate ?? `HB-UH ${nonce().slice(-5).toUpperCase()}`, make: "VW", model: "Golf", groupId: w.groupId, fuel: "BENZIN", mileage: 1000, dailyRate: 59, kmIncludedPerDay: 100, extraKmRate: 0.2, tankCapacityLiters: 50, requiredLicenseClass: "B" } })).id;
function caseInput(w: World, vehicleId: string, over: Partial<CreateAccidentCaseInput> = {}): CreateAccidentCaseInput {
  return {
    nonce: nonce(), customerId: w.customerId, vehicleId, startAt: plus(new Date(), HOUR), plannedEndAt: null, dailyRateCents: 7_900, depositCents: 0, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "HB-XY 1", make: "Opel", model: "Astra", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: plus(new Date(), -2 * DAY), place: "Bremen" },
    insurer: { name: "HUK-COBURG", claimNumber: "SN-H-0001", contactName: null, phone: null, email: null, street: "Weg 2", zip: "96450", city: "Coburg" },
    liability: { status: "CONFIRMED" },
    tariff: [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1_500 }],
    ...over,
  };
}
async function signed(w: World, bookingId: string) {
  const c = await db.rentalContract.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId } });
  const bk = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: null, deposit: 0, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 500, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: null }, w.actor);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return c.id;
}
async function handover(w: World, bookingId: string, type: "PICKUP" | "RETURN", contractId?: string) {
  const bk = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { vehicleId: true } });
  const ww = { ...w, bookingId, vehicleId: bk.vehicleId };
  const h = await startHandover(w.tenantId, bookingId, type, w.actor);
  await updateHandoverDraft(w.tenantId, h.id, { mileage: type === "PICKUP" ? 1100 : 1200, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, h.id, cat);
  await answerAll(ww, h.id);
  await sign(ww, h.id);
  if (type === "PICKUP") await verifyAllDriversForPickup(w.tenantId, w.actor, h.id, contractId!);
  await finalizeHandover(w.tenantId, h.id, w.actor);
}
const tasksOf = (c: AccidentCenter) => c.tasks!.items;
const titles = (c: AccidentCenter) => tasksOf(c).map((t) => t.title);

// ---------------------------------------------------------------------------
// Gemeinsamer Bestand
//   K1 reserviert (Vertrag offen → keine Primäraktion): überfällig (Max), heute, morgen, +5 Tage, +10 Tage, erledigt, verworfen
//   K2 reserviert mit unterschriebenem Vertrag (Übergabe), langer Firmenname: heute (Max)
//   K3 läuft (Rückgabe); K4 zurückgegeben (Abrechnung); K5 geschlossen mit offen gebliebener überfälliger Wiedervorlage
//   fremder Mandant mit eigener Wiedervorlage
// ---------------------------------------------------------------------------
type Fixture = {
  w: World; other: World; max: { id: string; name: string }; owner: { id: string; name: string }; yard: { id: string; name: string };
  K1: string; K2: string; K3: string; K4: string; K5: string;
  f: { overdue: string; today: string; tomorrow: string; in5: string; in10: string; done: string; cancelled: string; k2today: string; k5overdue: string; foreign: string };
};
let fixture: Promise<Fixture> | null = null;
function setup(): Promise<Fixture> {
  fixture ??= (async () => {
    const w = await world("uh-main");
    const other = await world("uh-fremd");
    const max = await user(w, "Max Mustermann", "DISPO");
    const owner = await user(w, "Olga Inhaberin", "OWNER");
    const yard = await user(w, "Hof Hannes", "YARD");
    const longCustomer = await db.customer.create({ data: { tenantId: w.tenantId, number: "K-00077", type: "COMPANY", firstName: "Maxi", lastName: "Hohenstein", birthDate: new Date("1980-01-01"), idType: "PERSONALAUSWEIS", idNumber: "L01X00T49", idValidUntil: new Date("2031-01-01"), licenseNumber: "B072RRE2I57", licenseClass: "B", licenseIssuedAt: new Date("2001-01-01"), licenseValidUntil: new Date("2035-01-01"), companyName: "Maximiliane von Hohenstein-Wittgenstein Fahrzeugvermietung und Logistik GmbH & Co. KG", street: "Weg 1", zip: "28195", city: "Bremen", country: "DE", phone: "0421 555", email: "lang@example.test" } });

    const K1 = await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w), { startAt: plus(new Date(), 3 * DAY) }));
    const fu = (caseId: string, title: string, dueAt: Date, assigneeUserId?: string, note?: string) => createFollowUp(w.tenantId, caseId, w.actor, { title, dueAt, assigneeUserId: assigneeUserId ?? null, note: note ?? null });
    const overdue = await fu(K1.case.id, "Schadennummer bei HUK nachfragen", dayAt(-2), max.id, "Frau Merk, Durchwahl 12");
    const today = await fu(K1.case.id, "Werkstatt anrufen", dayAt(0));
    const tomorrow = await fu(K1.case.id, "Gutachten anfordern", dayAt(1));
    const in5 = await fu(K1.case.id, "Mietwagenbedarf mit Kunde klären", dayAt(5));
    const in10 = await fu(K1.case.id, "Reparaturende erfragen", dayAt(10), max.id);
    const done = await fu(K1.case.id, "ERLEDIGT-NICHT-ZEIGEN", dayAt(0));
    await completeFollowUp(w.tenantId, done.id, w.actor, "erledigt", { caseId: K1.case.id });
    const cancelled = await fu(K1.case.id, "VERWORFEN-NICHT-ZEIGEN", dayAt(0));
    await cancelFollowUp(w.tenantId, cancelled.id, w.actor, "entfällt", { caseId: K1.case.id });

    const K2 = await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w), { customerId: longCustomer.id, startAt: plus(new Date(), 2 * DAY) }));
    await signed(w, K2.bookingId);
    const k2today = await fu(K2.case.id, "Kunde wegen Übergabezeit anrufen – sehr lange Aufgabenbeschreibung, damit die Darstellung auch bei langen Texten sauber umbricht", dayAt(0), max.id);

    const K3 = await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w)));
    await handover(w, K3.bookingId, "PICKUP", await signed(w, K3.bookingId));
    const K4 = await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w)));
    await handover(w, K4.bookingId, "PICKUP", await signed(w, K4.bookingId));
    await handover(w, K4.bookingId, "RETURN");

    const K5 = await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w)));
    const k5overdue = await fu(K5.case.id, "GESCHLOSSEN-NICHT-ZEIGEN", dayAt(-1));
    await closeCase(w.tenantId, K5.case.id, w.actor, { reason: "abgesagt", acknowledgeWarnings: true });

    const O = await createAccidentCase(other.tenantId, other.actor, caseInput(other, await vehicle(other)));
    const foreign = await createFollowUp(other.tenantId, O.case.id, other.actor, { title: "FREMD-WIEDERVORLAGE", dueAt: dayAt(0) });

    return {
      w, other, max, owner, yard, K1: K1.case.id, K2: K2.case.id, K3: K3.case.id, K4: K4.case.id, K5: K5.case.id,
      f: { overdue: overdue.id, today: today.id, tomorrow: tomorrow.id, in5: in5.id, in10: in10.id, done: done.id, cancelled: cancelled.id, k2today: k2today.id, k5overdue: k5overdue.id, foreign: foreign.id },
    };
  })();
  return fixture;
}

// ---------------------------------------------------------------------------
// 1–5: Phase-G-Politur – Aktionsspalte
// ---------------------------------------------------------------------------

test("1–5: Aktionsspalte – feste Spalte „Aktionen“, Primäraktion oben, „Fall öffnen“ darunter, ohne Primäraktion nur „Fall öffnen“; Handy volle Breite; Hof nur operative Aktionen", async () => {
  const x = await setup();
  const page = await src("src/app/(app)/unfallersatz/page.tsx");
  // 1: sichtbarer Spaltenkopf mit fester Breite; Aktionen als Spalte, beide Knöpfe gleiche Klassen (Breite/Höhe)
  assert.match(page, /<th className="label-xs px-3 py-2 border-b border-line w-\[164px\]">Aktionen<\/th>/);
  assert.match(page, /<td className="px-3 py-2\.5"><RowActions r=\{r\} full=\{full\} layout="column" \/><\/td>/);
  assert.match(page, /const ACTION_BTN = "btn !py-1\.5 text-\[13px\] justify-center text-center w-full";/);
  assert.match(page, /\{r\.action && <Link href=\{r\.action\.href\} className=\{`\$\{ACTION_BTN\} btn-primary`\}>\{r\.action\.label\}<\/Link>\}\n\s*<Link href=\{`\/unfallersatz\/\$\{r\.id\}`\} className=\{ACTION_BTN\}>Fall öffnen<\/Link>/);
  // 4: Handy/Tablet – Aktionen unter der Karte, volle Breite (zwei gleich breite Spalten bzw. eine)
  assert.match(page, /<RowActions r=\{r\} full=\{full\} layout="bar" \/>/);
  assert.match(page, /`grid gap-2 \$\{r\.action \? "grid-cols-2" : "grid-cols-1"\}`/);
  assert.ok(!page.includes("sr-only\">Aktionen"), "Spaltenkopf nicht mehr nur für Screenreader");

  // 2/3: Primäraktion aus dem Zustand – Übergabe, Rückgabe, Abrechnung; ohne Vertrag keine (nur „Fall öffnen“)
  const fullView = await accidentCenter(x.w.tenantId, { access: "FULL", pageSize: 100 });
  const row = (id: string) => fullView.rows.find((r) => r.id === id)!;
  assert.equal(row(x.K1).action, null, "K1: Vertrag noch nicht unterschrieben – keine Primäraktion");
  assert.equal(row(x.K2).action?.label, "Übergabe");
  assert.equal(row(x.K3).action?.label, "Rückgabe");
  assert.equal(row(x.K4).action?.label, "Abrechnung");
  assert.equal(row(x.K4).action?.href, `/unfallersatz/${x.K4}?tab=abrechnung`);

  // 5: Hof – nur operative Aktionen (keine Abrechnung), kein „+ Wiedervorlage“
  const yard = await accidentCenter(x.w.tenantId, { access: "OPERATIONAL", pageSize: 100 });
  const yrow = (id: string) => yard.rows.find((r) => r.id === id)!;
  assert.equal(yrow(x.K2).action?.label, "Übergabe");
  assert.equal(yrow(x.K3).action?.label, "Rückgabe");
  assert.equal(yrow(x.K4).action, null, "Hof: keine Abrechnung");
  assert.ok(yard.rows.every((r) => !r.action || ["Übergabe", "Rückgabe"].includes(r.action.label)));
  assert.match(page, /const followUp = full && r\.status === "OPEN";/);
  assert.match(page, /\{followUp && <Link href=\{`\/unfallersatz\/\$\{r\.id\}\?wv=neu#wiedervorlagen`\}/);
});

// ---------------------------------------------------------------------------
// 6–14: Arbeitsliste – Gruppen, Texte, Fall, Kunde, Zuständigkeit
// ---------------------------------------------------------------------------

test("6–14: Arbeitsliste – überfällig, heute, demnächst (7 Tage) mit eindeutigem Text; spätere, erledigte, verworfene und geschlossene nicht; Fall, Kunde, Zuständiger, „Meine“", async () => {
  const x = await setup();
  const c = await accidentCenter(x.w.tenantId, { access: "FULL", userId: x.max.id });
  const t = c.tasks!;
  assert.equal(t.view, null);
  const byId = new Map(t.items.map((i) => [i.id, i]));
  // 6/7/8: Gruppen und Texte (nicht nur Farbe)
  assert.equal(byId.get(x.f.overdue)?.group, "OVERDUE");
  assert.equal(byId.get(x.f.overdue)?.dueText, "2 Tage überfällig");
  assert.equal(byId.get(x.f.today)?.group, "TODAY");
  assert.equal(byId.get(x.f.today)?.dueText, "Heute");
  assert.equal(byId.get(x.f.tomorrow)?.group, "SOON");
  assert.equal(byId.get(x.f.tomorrow)?.dueText, "Morgen");
  assert.equal(byId.get(x.f.in5)?.group, "SOON");
  assert.match(byId.get(x.f.in5)!.dueText, /^\d{2}\.\d{2}\.\d{4}$/);
  // 9: weiter entfernte nicht in der kompakten Vorschau, aber gezählt
  assert.ok(!byId.has(x.f.in10));
  assert.equal(t.later, 1);
  // 10/11: erledigte und verworfene nie; geschlossener Fall nicht (offene Wiedervorlage bleibt dort, ist aber nicht mehr bearbeitbar)
  for (const s of ["ERLEDIGT-NICHT-ZEIGEN", "VERWORFEN-NICHT-ZEIGEN", "GESCHLOSSEN-NICHT-ZEIGEN", "FREMD-WIEDERVORLAGE"]) assert.ok(!JSON.stringify(t).includes(s), s);
  // Reihenfolge: dringendste zuerst
  assert.deepEqual(t.items.slice(0, 1).map((i) => i.id), [x.f.overdue]);
  assert.ok(t.items.every((i, k) => k === 0 || t.items[k - 1].dueAt <= i.dueAt));
  // 12/13: Fallnummer und Kunde
  const k1 = await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: x.K1 }, select: { caseNumber: true } });
  const k2 = await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: x.K2 }, select: { caseNumber: true } });
  assert.equal(byId.get(x.f.overdue)?.caseNumber, k1.caseNumber);
  assert.equal(byId.get(x.f.overdue)?.caseId, x.K1);
  assert.equal(byId.get(x.f.overdue)?.customerName, "Erika Muster");
  assert.equal(byId.get(x.f.k2today)?.caseNumber, k2.caseNumber);
  assert.equal(byId.get(x.f.k2today)?.customerName, "Maximiliane von Hohenstein-Wittgenstein Fahrzeugvermietung und Logistik GmbH & Co. KG");
  assert.equal(byId.get(x.f.overdue)?.note, "Frau Merk, Durchwahl 12");
  // 14: Zuständigkeit; „Meine“ nur mit sicherer Zuordnung über die Benutzerkennung
  assert.equal(byId.get(x.f.overdue)?.assigneeName, "Max Mustermann");
  assert.equal(byId.get(x.f.overdue)?.mine, true);
  assert.equal(byId.get(x.f.today)?.assigneeName, null);
  assert.equal(byId.get(x.f.today)?.mine, false);
  assert.deepEqual(t.counts, { uebersicht: 5, faellig: 3, ueberfaellig: 1, heute: 2, demnaechst: 2, meine: 3 });
  // keine Versicherungs- oder Finanzdaten in der Aufgabenzeile
  const one = JSON.stringify(byId.get(x.f.overdue));
  for (const s of ["HUK-COBURG", "SN-H-0001", "Cents", "insurer"]) assert.ok(!one.includes(s), s);

  // eigene Filter der Arbeitsliste (Adresse aufgaben=…)
  const view = async (v: string, userId: string | null = x.max.id) => (await accidentCenter(x.w.tenantId, { access: "FULL", tasks: v, userId })).tasks!;
  assert.deepEqual((await view("ueberfaellig")).items.map((i) => i.id), [x.f.overdue]);
  assert.deepEqual(new Set((await view("heute")).items.map((i) => i.id)), new Set([x.f.today, x.f.k2today]));
  assert.deepEqual(new Set((await view("faellig")).items.map((i) => i.id)), new Set([x.f.overdue, x.f.today, x.f.k2today]));
  assert.deepEqual(new Set((await view("demnaechst")).items.map((i) => i.id)), new Set([x.f.tomorrow, x.f.in5]));
  const mine = await view("meine");
  assert.deepEqual(new Set(mine.items.map((i) => i.id)), new Set([x.f.overdue, x.f.k2today, x.f.in10]), "Meine: alle offenen eigenen, auch später fällige");
  assert.equal(mine.items.find((i) => i.id === x.f.in10)?.group, "LATER");
  assert.equal((await view("meine", x.owner.id)).items.length, 0, "Inhaberin ohne Zuweisung");
  assert.equal((await view("meine", null)).counts.meine, 0, "ohne Benutzer keine Zuordnung");
  // Fall-Filter und Suche bleiben unberührt; Arbeitsliste ist davon unabhängig
  const withFilter = await accidentCenter(x.w.tenantId, { access: "FULL", filter: "laufend", q: "keinTreffer", tasks: "faellig", userId: x.max.id });
  assert.equal(withFilter.filter, "laufend");
  assert.equal(withFilter.total, 0);
  assert.equal(withFilter.tasks!.items.length, 3);
  // URL-Zustand: unbekannte Werte → Übersicht
  assert.equal(resolveTaskView("heute"), "heute");
  assert.equal(resolveTaskView("alle"), "alle");
  assert.equal(resolveTaskView("<script>"), null);
  for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.equal(resolveTaskView(k), null, k);
  assert.equal(resolveTaskView(undefined), null);
});

test("Arbeitsliste: kompakte Vorschau begrenzt, „Weitere Wiedervorlagen anzeigen“ (aufgaben=alle) zeigt den Rest; Fälligkeitstexte nach Kalendertag", async () => {
  const w = await world("uh-viele");
  const k = await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w)));
  for (let i = 0; i < TASK_PREVIEW_LIMIT + 4; i++) await createFollowUp(w.tenantId, k.case.id, w.actor, { title: `Aufgabe ${i}`, dueAt: dayAt(i % 3 === 0 ? -1 : i % 3 === 1 ? 0 : 3) });
  const c = await accidentCenter(w.tenantId, { access: "FULL" });
  assert.equal(c.tasks!.items.length, TASK_PREVIEW_LIMIT);
  assert.equal(c.tasks!.more, 4);
  const all = (await accidentCenter(w.tenantId, { access: "FULL", tasks: "alle" })).tasks!;
  assert.equal(all.items.length, TASK_PREVIEW_LIMIT + 4);
  assert.equal(all.more, 0);
  // Texte: Kalendertage in der Anwendungszeitzone
  assert.equal(followUpTiming(dayAt(-1)).text, "1 Tag überfällig");
  assert.equal(followUpTiming(dayAt(-3)).text, "3 Tage überfällig");
  assert.equal(followUpTiming(dayAt(0)).text, "Heute");
  assert.equal(followUpTiming(dayAt(1)).text, "Morgen");
  assert.equal(followUpTiming(dayAt(7)).group, "SOON");
  assert.equal(followUpTiming(dayAt(8)).group, "LATER");
});

// ---------------------------------------------------------------------------
// 15–19: Erledigen (Phase-D-Logik), Verlauf/Audit, Verschieben, fallbezogene Anlage, geschlossener Fall
// ---------------------------------------------------------------------------

test("15–19: Erledigen über die Phase-D-Logik (Status, Kennzahl, Verlauf und Audit mit Benutzer und Zeitpunkt); Verschieben bewusst nicht angeboten; Anlage nur fallbezogen; geschlossener Fall sperrt", async () => {
  const w = await world("uh-erledigen");
  const dispo = await user(w, "Dora Dispo", "DISPO");
  const actor = { id: dispo.id, name: dispo.name };
  const k = await createAccidentCase(w.tenantId, w.actor, caseInput(w, await vehicle(w)));
  const f = await createFollowUp(w.tenantId, k.case.id, actor, { title: "Haftung bestätigen lassen", dueAt: dayAt(0), assigneeUserId: dispo.id });
  const before = await accidentCenter(w.tenantId, { access: "FULL" });
  assert.equal(before.kpis.followUpsDue, 1);
  assert.equal(before.tasks!.counts.heute, 1);

  // 15/16: Erledigen – dieselbe Funktion und derselbe Weg wie die Fallakte (completeFollowUpAction → completeFollowUp mit caseId)
  const t0 = new Date();
  await completeFollowUp(w.tenantId, f.id, actor, "Haftung am Telefon bestätigt", { caseId: k.case.id });
  const row = await db.caseFollowUp.findUniqueOrThrow({ where: { id: f.id } });
  assert.equal(row.status, "DONE");
  assert.equal(row.doneById, dispo.id);
  assert.ok(row.doneAt && row.doneAt >= plus(t0, -1000));
  const after = await accidentCenter(w.tenantId, { access: "FULL" });
  assert.equal(after.kpis.followUpsDue, 0, "Kennzahl aktualisiert");
  assert.equal(after.tasks!.items.length, 0, "aus der offenen Liste verschwunden");
  const hist = await caseFileHistory(w.tenantId, k.case.id, "FULL");
  const doneEv = hist.find((e) => e.label === "Wiedervorlage erledigt");
  assert.ok(doneEv && doneEv.userName === "Dora Dispo" && doneEv.to === "Haftung bestätigen lassen" && doneEv.note === "Haftung am Telefon bestätigt");
  assert.ok(hist.some((e) => e.label === "Wiedervorlage angelegt" && e.userName === "Dora Dispo"));
  const audit = await db.auditLog.findFirst({ where: { tenantId: w.tenantId, action: "ACCIDENT_FOLLOW_UP_DONE" }, orderBy: { createdAt: "desc" } });
  assert.ok(audit && audit.userId === dispo.id && audit.userName === "Dora Dispo" && (audit.details as Record<string, unknown>).followUpId === f.id);
  await assert.rejects(() => completeFollowUp(w.tenantId, f.id, actor, null, { caseId: k.case.id }), /bereits erledigt/);

  // Zentrale nutzt die bestehende Server-Aktion (kein zweiter Codepfad) und aktualisiert sich danach
  const page = await src("src/app/(app)/unfallersatz/page.tsx");
  assert.match(page, /<FollowUpDoneAction done=\{completeFollowUpAction\.bind\(null, x\.caseId, x\.id\)\} \/>/);
  assert.match(page, /import \{ completeFollowUpAction \} from "\.\/\[id\]\/actions";/);
  const actions = await src("src/app/(app)/unfallersatz/[id]/actions.ts");
  assert.match(actions, /function refresh\(c: \{ id: string; bookingId: string \}\) \{[\s\S]*?revalidatePath\("\/unfallersatz"\);\n\}/);
  const forms = await src("src/app/(app)/unfallersatz/[id]/case-forms.tsx");
  assert.match(forms, /export function FollowUpDoneAction\(\{ done \}: \{ done: Action \}\) \{\n  const \[open, setOpen\] = useState\(false\);\n  const a = useCaseAction\(done/);

  // 17: Verschieben – CaseFollowUp kennt keine fachliche Fälligkeitsänderung mit Verlaufseintrag → nicht angeboten
  assert.ok(!/Verschieben/.test(page) && !/Verschieben/.test(forms), "keine Verschieben-Aktion ohne saubere Fachlogik");

  // 18: neue Wiedervorlage nur zu einem konkreten Fall (Fallakte, aus der Zentrale per Link mit geöffnetem Formular)
  await assert.rejects(() => createFollowUp(w.tenantId, "kein-fall", actor, { title: "frei", dueAt: dayAt(1) }), /nicht gefunden/);
  const tabs = await src("src/app/(app)/unfallersatz/[id]/case-tabs.tsx");
  assert.match(tabs, /<Card id="wiedervorlagen" title="Wiedervorlagen"/);
  assert.match(tabs, /initialOpen=\{newFollowUp\}/);
  assert.match(await src("src/app/(app)/unfallersatz/[id]/page.tsx"), /newFollowUp=\{sp\.wv === "neu"\}/);

  // 19: geschlossener Fall – keine neue Wiedervorlage, offene nicht mehr bearbeitbar
  const g = await createFollowUp(w.tenantId, k.case.id, actor, { title: "bleibt offen", dueAt: dayAt(-1) });
  await closeCase(w.tenantId, k.case.id, actor, { reason: "erledigt", acknowledgeWarnings: true });
  await assert.rejects(() => createFollowUp(w.tenantId, k.case.id, actor, { title: "neu", dueAt: dayAt(1) }), /abgeschlossen/);
  await assert.rejects(() => completeFollowUp(w.tenantId, g.id, actor, null, { caseId: k.case.id }), /abgeschlossen/);
  const closedView = await accidentCenter(w.tenantId, { access: "FULL" });
  assert.equal(closedView.tasks!.items.length, 0, "Wiedervorlagen geschlossener Fälle nicht in der Arbeitsliste");
  assert.equal((await db.caseFollowUp.findUniqueOrThrow({ where: { id: g.id } })).status, "OPEN", "nicht automatisch erledigt");
});

// ---------------------------------------------------------------------------
// 20–23: Rollen – Hof, Supportmodus, Inhaber, Disposition
// ---------------------------------------------------------------------------

test("20–23: Hof und Supportmodus erhalten keine Wiedervorlagen (nicht geladen, nicht im Ergebnis, nicht in Heute); Inhaber und Disposition volle Funktion", async () => {
  const x = await setup();
  // 20/21: operative Sicht – Arbeitsliste gar nicht geladen
  const yard = await accidentCenter(x.w.tenantId, { access: "OPERATIONAL", tasks: "meine", userId: x.max.id });
  assert.equal(yard.tasks, null);
  const dump = JSON.stringify(yard);
  for (const s of ["Schadennummer bei HUK", "Werkstatt anrufen", "Gutachten anfordern", "Max Mustermann", "Frau Merk", "Wiedervorlage"]) assert.ok(!dump.includes(s), s);
  // Hof/Supportmodus auf Heute: keine Wiedervorlagen-Aufgaben (Supportmodus läuft als YARD → hideAccidentBilling)
  const heuteYard = await loadDashboard(x.w.tenantId, { hideAccidentBilling: true });
  const yardTasks = Object.values(heuteYard.groups).flat().filter((t) => t.key.startsWith("accident-followup-"));
  assert.equal(yardTasks.length, 0);
  assert.equal(heuteYard.accident?.followUps.length, 0);
  assert.equal(heuteYard.accident?.followUpsDue, null);
  // Seite: Supportmodus → operative Sicht; Arbeitsliste nur bei geladenen Daten (Vollsicht)
  const page = await src("src/app/(app)/unfallersatz/page.tsx");
  assert.match(page, /const access = supportSession \? "OPERATIONAL" : caseFileAccess\(user\.role\);/);
  assert.match(page, /\{c\.tasks && k\.open > 0 && <TaskBoard t=\{c\.tasks\} qs=\{qs\} \/>\}/);
  // Fallakte (Hof/Supportmodus): keine Wiedervorlagen, keine Zuständigen
  const h = (await caseFileHeader(x.w.tenantId, x.K1, "OPERATIONAL"))!;
  const o = await caseFileOverview(x.w.tenantId, h, "OPERATIONAL");
  assert.equal(o.followUps.length, 0);
  assert.equal(o.assignees.length, 0);
  // Aktionen: requireRole("DISPO") (Hof → Rechte, Supportmodus → gesperrt) in jeder Fallakten-Aktion
  const actions = await src("src/app/(app)/unfallersatz/[id]/actions.ts");
  assert.match(actions, /async function ctx\(caseId: string\) \{\n  const \{ tenant, user \} = await requireRole\("DISPO"\);/);
  // 22/23: Inhaber und Disposition – Vollsicht mit Arbeitsliste
  assert.equal(caseFileAccess("OWNER"), "FULL");
  assert.equal(caseFileAccess("DISPO"), "FULL");
  assert.equal(caseFileAccess("YARD"), "OPERATIONAL");
  const ownerView = await accidentCenter(x.w.tenantId, { access: caseFileAccess("OWNER"), userId: x.owner.id });
  const dispoView = await accidentCenter(x.w.tenantId, { access: caseFileAccess("DISPO"), userId: x.max.id });
  assert.ok(ownerView.tasks && ownerView.tasks.items.length === 5);
  assert.ok(dispoView.tasks && dispoView.tasks.counts.meine === 3);
});

// ---------------------------------------------------------------------------
// 24–26: Mandantentrennung und Zuständigkeit
// ---------------------------------------------------------------------------

test("24–26: fremder Mandant unsichtbar; fremde oder manipulierte Wiedervorlagen-/Fallkennungen nicht änderbar; nur Inhaber/Disposition des eigenen Mandanten als zuständig wählbar", async () => {
  const x = await setup();
  // 24: Arbeitslisten beider Mandanten getrennt
  const mine = await accidentCenter(x.w.tenantId, { access: "FULL", tasks: "alle" });
  const theirs = await accidentCenter(x.other.tenantId, { access: "FULL", tasks: "alle" });
  assert.ok(!titles(mine).includes("FREMD-WIEDERVORLAGE"));
  assert.deepEqual(titles(theirs), ["FREMD-WIEDERVORLAGE"]);
  const foreignCaseId = (await db.accidentReplacementCase.findFirstOrThrow({ where: { tenantId: x.other.tenantId } })).id;
  // 25: fremde Wiedervorlage im eigenen Mandanten, eigene über fremden Mandanten, eigene über einen anderen eigenen Fall
  await assert.rejects(() => completeFollowUp(x.w.tenantId, x.f.foreign, x.w.actor), /nicht gefunden/);
  await assert.rejects(() => completeFollowUp(x.other.tenantId, x.f.today, x.other.actor, null, { caseId: x.K1 }), /nicht gefunden/);
  await assert.rejects(() => completeFollowUp(x.w.tenantId, x.f.today, x.w.actor, null, { caseId: x.K2 }), /nicht gefunden/);
  await assert.rejects(() => cancelFollowUp(x.w.tenantId, x.f.foreign, x.w.actor, "manipuliert"), /nicht gefunden/);
  await assert.rejects(() => createFollowUp(x.w.tenantId, foreignCaseId, x.w.actor, { title: "fremder Fall", dueAt: dayAt(1) }), /nicht gefunden/);
  assert.equal((await db.caseFollowUp.findUniqueOrThrow({ where: { id: x.f.foreign } })).status, "OPEN");
  assert.equal((await db.caseFollowUp.findUniqueOrThrow({ where: { id: x.f.today } })).status, "OPEN");
  // Datenbank: Wiedervorlage kann nicht an einen fremden Fall gehängt werden
  await assert.rejects(() => db.caseFollowUp.create({ data: { tenantId: x.w.tenantId, caseId: foreignCaseId, title: "x", dueAt: new Date() } }), /RB_TENANT/);
  // 26: Zuständigkeit – fremder Benutzer, Hof, inaktiv: abgelehnt; Auswahl der Fallakte nur Inhaber/Disposition des Mandanten
  const foreignDispo = await user(x.other, "Fremde Disponentin", "DISPO");
  const inactive = await user(x.w, "Ina Inaktiv", "DISPO", false);
  for (const id of [foreignDispo.id, x.yard.id, inactive.id]) {
    await assert.rejects(() => createFollowUp(x.w.tenantId, x.K1, x.w.actor, { title: "Zuständigkeit", dueAt: dayAt(2), assigneeUserId: id }), /Zuständige wurde nicht gefunden/);
  }
  const ok = await createFollowUp(x.w.tenantId, x.K3, x.w.actor, { title: "Inhaberin zuständig", dueAt: dayAt(20), assigneeUserId: x.owner.id });
  assert.equal(ok.assigneeName, "Olga Inhaberin");
  assert.deepEqual([...FOLLOW_UP_ASSIGNEE_ROLES], ["OWNER", "DISPO"]);
  const h = (await caseFileHeader(x.w.tenantId, x.K1, "FULL"))!;
  const names = (await caseFileOverview(x.w.tenantId, h, "FULL")).assignees.map((a) => a.name);
  assert.ok(names.includes("Max Mustermann") && names.includes("Olga Inhaberin"));
  for (const n of ["Hof Hannes", "Ina Inaktiv", "Fremde Disponentin", "Test Mitarbeiter"]) assert.ok(!names.includes(n), n);
});

// ---------------------------------------------------------------------------
// 27–30: Kennzahl, Heute, Priorisierung, Fallabschluss
// ---------------------------------------------------------------------------

test("27–30: fällige Kennzahl = überfällig + heute der Arbeitsliste; Heute verlinkt in die Fallakte (#wiedervorlagen); Priorisierung unverändert; Abschlusswarnung bleibt, nichts wird automatisch erledigt", async () => {
  const x = await setup();
  const c = await accidentCenter(x.w.tenantId, { access: "FULL" });
  // 27: Kennzahl und Arbeitsliste aus denselben Daten
  assert.equal(c.kpis.followUpsDue, c.tasks!.counts.faellig);
  assert.equal(c.kpis.followUpsDue, 3);
  const page = await src("src/app/(app)/unfallersatz/page.tsx");
  assert.match(page, /<KpiTile href=\{`\$\{qs\(\{ aufgaben: "faellig" \}\)\}#wiedervorlagen`\} label="Fällige Wiedervorlagen"/);
  // 28: Heute – fällige Wiedervorlagen unter Aufmerksamkeit, Klick in die Fallakte zu den Wiedervorlagen; keine doppelte Logik
  const d = await loadDashboard(x.w.tenantId, { horizon: "7" });
  const fu = Object.values(d.groups).flat().filter((t) => t.key.startsWith("accident-followup-"));
  const overdueTask = fu.find((t) => t.key === `accident-followup-${x.f.overdue}`);
  assert.ok(overdueTask, "überfällige Wiedervorlage auf Heute");
  assert.equal(overdueTask!.href, `/unfallersatz/${x.K1}#wiedervorlagen`);
  assert.equal(overdueTask!.group, "OVERDUE");
  assert.ok(fu.every((t) => /^\/unfallersatz\/[^/?#]+#wiedervorlagen$/.test(t.href)));
  assert.ok(!fu.some((t) => t.title.includes("GESCHLOSSEN") || t.title.includes("ERLEDIGT") || t.title.includes("FREMD")));
  assert.equal(d.accident?.followUpsDue, c.kpis.followUpsDue, "Heute und Zentrale zählen gleich");
  // 29: Priorisierung – überfällige Wiedervorlage kritisch (Rang 1), heute fällige Rang 2
  const rowK1 = c.rows.find((r) => r.id === x.K1)!;
  const rowK2 = c.rows.find((r) => r.id === x.K2)!;
  assert.equal(rowK1.rank, 1);
  assert.equal(rowK1.lead?.code, "FOLLOW_UP_OVERDUE");
  assert.equal(rowK1.lead?.short, "Wiedervorlage überfällig");
  assert.equal(rowK2.rank, 2);
  assert.equal(rowK2.lead?.code, "FOLLOW_UP_TODAY");
  assert.equal(c.rows[0].id, x.K1);
  // 30: Abschluss – Warnung bei offenen Wiedervorlagen bleibt, ohne Bestätigung kein Abschluss, offene bleiben offen
  const w2 = await world("uh-abschluss");
  const k = await createAccidentCase(w2.tenantId, w2.actor, caseInput(w2, await vehicle(w2)));
  const f = await createFollowUp(w2.tenantId, k.case.id, w2.actor, { title: "noch offen", dueAt: dayAt(2) });
  const warn = await closeWarnings(w2.tenantId, k.case.id);
  assert.ok(warn.some((x2) => x2.code === "FOLLOW_UPS" && x2.text === "1 offene Wiedervorlage."));
  await assert.rejects(() => closeCase(w2.tenantId, k.case.id, w2.actor, { reason: "fertig" }), /offene Punkte/);
  await closeCase(w2.tenantId, k.case.id, w2.actor, { reason: "fertig", acknowledgeWarnings: true });
  assert.equal((await db.caseFollowUp.findUniqueOrThrow({ where: { id: f.id } })).status, "OPEN");
});

// ---------------------------------------------------------------------------
// Performance: 100 Fälle, mehrere Wiedervorlagen je Fall (offen/erledigt/verworfen, gemischte Fälligkeit)
// ---------------------------------------------------------------------------

test("Performance: feste Zahl an Datenbankoperationen – 100 Fälle mit je 4 Wiedervorlagen ändern sie nicht (kein Nachladen je Fall oder Wiedervorlage)", async () => {
  await setup();
  let ops = 0;
  const counted = db.$extends({ query: { $allModels: { async $allOperations({ args, query }) { ops++; return query(args); } } } }) as unknown as typeof db;
  const measure = async (tenantId: string, tasks?: string, userId?: string) => { ops = 0; const t = Date.now(); const c = await accidentCenter(tenantId, { access: "FULL", client: counted, tasks, userId }); return { ops, ms: Date.now() - t, c }; };
  const many = await world("uh-perf");
  const dispo = await user(many, "Perf Dispo", "DISPO");
  const small = await createAccidentCase(many.tenantId, many.actor, caseInput(many, await vehicle(many)));
  await createFollowUp(many.tenantId, small.case.id, many.actor, { title: "eine", dueAt: dayAt(0) });
  const base = await measure(many.tenantId);
  const vehicles = await Promise.all(Array.from({ length: 99 }, (_, i) => vehicle(many, `HB-PH ${String(i).padStart(3, "0")}`)));
  const caseIds: string[] = [small.case.id];
  for (let i = 0; i < 99; i++) caseIds.push((await createAccidentCase(many.tenantId, many.actor, caseInput(many, vehicles[i], { startAt: plus(new Date(), (i % 20 + 1) * HOUR) }))).case.id);
  // je Fall vier weitere: überfällig/heute/demnächst/später gemischt, dazu erledigt und verworfen (direkt eingefügt – nur Bestand)
  const rows = caseIds.flatMap((caseId, i) => [
    { tenantId: many.tenantId, caseId, title: `offen ${i} a`, dueAt: dayAt((i % 4) - 1), assigneeUserId: i % 2 ? dispo.id : null, assigneeName: i % 2 ? dispo.name : null },
    { tenantId: many.tenantId, caseId, title: `offen ${i} b`, dueAt: dayAt(i % 12), status: "OPEN" },
    { tenantId: many.tenantId, caseId, title: `erledigt ${i}`, dueAt: dayAt(-3), status: "DONE", doneAt: new Date() },
    { tenantId: many.tenantId, caseId, title: `verworfen ${i}`, dueAt: dayAt(-3), status: "CANCELLED", doneAt: new Date(), doneNote: "entfällt" },
  ]);
  await db.caseFollowUp.createMany({ data: rows });
  const overview = await measure(many.tenantId);
  const meine = await measure(many.tenantId, "meine", dispo.id);
  const alle = await measure(many.tenantId, "alle", dispo.id);
  console.log(`Arbeitsliste: 1 Fall ${base.ops} Operationen in ${base.ms} ms; 100 Fälle/${rows.length + 1} Wiedervorlagen: Übersicht ${overview.ops} Operationen in ${overview.ms} ms, „Meine“ ${meine.ops}, „alle“ ${alle.ops}`);
  assert.equal(overview.c.kpis.open, 100);
  const openCount = await db.caseFollowUp.count({ where: { tenantId: many.tenantId, status: "OPEN" } });
  assert.equal(openCount, 201);
  assert.ok(overview.ops <= base.ops, `100 Fälle: ${overview.ops} Operationen, 1 Fall: ${base.ops}`);
  assert.equal(meine.ops, overview.ops);
  assert.equal(alle.ops, overview.ops);
  assert.ok(overview.ops <= 12, `höchstens 12 Operationen (${overview.ops})`);
  assert.equal(overview.c.tasks!.items.length, TASK_PREVIEW_LIMIT);
  assert.ok(overview.c.tasks!.more > 0);
  assert.ok(alle.c.tasks!.items.every((t) => t.group !== "LATER" && !t.title.startsWith("erledigt") && !t.title.startsWith("verworfen")));
  assert.equal(meine.c.tasks!.counts.meine, 50);
});
