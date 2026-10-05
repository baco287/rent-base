// Befehl 29 Phase C: Unfallersatz-Wizard. Prüfung der Eingaben je Schritt (dieselbe Logik im Browser und verbindlich auf
// dem Server), Preisvorschau (bekanntes Ende mit Gesamtbetrag, offenes Ende ohne erfundenen Gesamtbetrag), Weg vom
// Formular bis zur Anlage (parseAccidentWizard → createAccidentCase) mit bestehendem und neuem Kunden, Tarif in Cent,
// verständliche Konfliktmeldungen, Mandantentrennung für Kunde, Fahrzeug und Adressbuch, Doppelklick und Freischaltung.
// Rollen und direkte Aufrufe der Server-Aktion prüfen tests/roles.test.ts (statisch) und tests/smoke-pages.mts (HTTP).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { createAccidentCase } from "../src/lib/accident-replacement";
import { accidentPricePreview, lineCents } from "../src/lib/accident-pricing";
import { moneyField, parseAccidentWizard, quotaField, stepOfCreateMessage, stepOfField, validateWizardStep, wizardEmailValid, type WizardData } from "../src/lib/accident-wizard";
import { isValidEmail } from "../src/lib/mail";
import { DomainError } from "../src/lib/integrity";
import { toDateTimeInput } from "../src/lib/format";
import { parseLocalDateTime, toDateInputValue } from "../src/lib/time";
import { createWorld, purgeTenants, type World } from "./helpers";

const tenants: string[] = [];
after(async () => { await purgeTenants(tenants); await db.$disconnect(); });

const HOUR = 3600_000, DAY = 24 * HOUR;
let seq = 0;
const nonce = () => `wz-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
/** Technische Details, die nie in einer Meldung an den Benutzer stehen dürfen. */
const TECHNICAL = /prisma|sql|constraint|unique|P20\d\d|stack|undefined|null|NaN|Error|cm[a-z0-9]{20,}/i;

type WWorld = World & { v2: string };

/** Mandant mit freigeschaltetem Unfallersatz und einem zweiten, freien Fahrzeug (v2). v1 trägt die Standardbuchung (morgen, 6 Tage). */
async function world(label: string, opts: { feature?: boolean } = {}): Promise<WWorld> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true } });
  if (opts.feature !== false) await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-WZ ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, make: "VW", model: "Golf", groupId: w.groupId, fuel: "BENZIN", mileage: 30_000, dailyRate: 59, deposit: 0, requiredLicenseClass: "B" } });
  return { ...w, v2: v2.id };
}

/** Mietbeginn in einer Stunde, auf volle Minuten (wie im Formular). */
const soon = () => new Date(Math.ceil((Date.now() + HOUR) / 60_000) * 60_000);

/** Vollständig ausgefülltes Formular, wie es der Wizard abschickt (nur Zeichenketten). */
function form(w: WWorld, over: WizardData = {}): WizardData {
  const start = soon();
  return {
    customerMode: "existing", customerId: w.customerId,
    damagedPlate: "hb-ab 123", damagedMake: "Opel", damagedModel: "Astra", damagedDrivable: "0", damageKind: "REPAIR",
    accidentDate: toDateInputValue(new Date(Date.now() - 2 * DAY)), accidentPlace: "Bremen, Am Wall",
    insurerName: "HUK-COBURG", insurerClaimNumber: "", liabilityStatus: "REPORTED",
    vehicleId: w.v2, startAt: toDateTimeInput(start), endMode: "open", plannedEndAt: "",
    dailyRate: "79", deposit: "", kmIncludedPerDay: "200", extraKmRate: "0,25",
    t_LIABILITY_REDUCTION_on: "1", t_LIABILITY_REDUCTION_amount: "15", t_LIABILITY_REDUCTION_mode: "day",
    t_DELIVERY_on: "1", t_DELIVERY_amount: "40", t_DELIVERY_mode: "once",
    // nicht angehakt: Betrag eingetragen, darf aber nicht gespeichert werden
    t_PICKUP_amount: "35", t_PICKUP_mode: "once",
    ...over,
  };
}

/** Formular prüfen und anlegen – genau der Weg der Server-Aktion (ohne Sitzung/Rolle, die prüft die Aktion davor). */
async function submit(w: WWorld, d: WizardData, key = nonce()) {
  const parsed = parseAccidentWizard(d);
  if (!parsed.ok) throw new Error(`Formular ungültig: ${parsed.errors.map((e) => e.message).join(" | ")}`);
  return createAccidentCase(w.tenantId, w.actor, { ...parsed.input, nonce: key });
}

async function domainMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof DomainError, `fachliche Meldung erwartet, erhalten: ${e instanceof Error ? e.name : typeof e}`);
    return e.message;
  }
  assert.fail("Anlage hätte abgelehnt werden müssen");
}

// ---------------------------------------------------------------------------
// Prüfung der Eingaben (rein)
// ---------------------------------------------------------------------------

test("Wizard: Pflichtangaben je Schritt mit verständlichen deutschen Meldungen, ohne technische Details", () => {
  const empty: WizardData = {};
  const msgs = (step: number) => validateWizardStep(step, empty).map((e) => e.message);
  assert.deepEqual(msgs(1), ["Bitte einen Kunden auswählen oder „Neuer Kunde“ wählen."]);
  assert.ok(msgs(2).includes("Bitte das Kennzeichen des beschädigten Fahrzeugs angeben.") && msgs(2).includes("Bitte das Unfalldatum angeben."));
  assert.ok(msgs(3).includes("Bitte die gegnerische Versicherung angeben."));
  assert.ok(msgs(4).includes("Bitte ein Ersatzfahrzeug aus der Flotte wählen.") && msgs(4).includes("Bitte den Mietbeginn mit Datum und Uhrzeit angeben."));
  assert.ok(msgs(5).includes("Tagessatz: bitte einen Betrag eingeben."));
  const all = validateWizardStep(6, empty);
  assert.ok(all.length >= 10, "Schritt 6 prüft alle Schritte");
  for (const e of all) assert.ok(!TECHNICAL.test(e.message), `technisches Detail in „${e.message}“`);
  // Fehler vom Server springen zum richtigen Schritt
  assert.deepEqual(["customerId", "c_lastName", "damagedPlate", "accidentDate", "insurerName", "liabilityQuotaPercent", "workshopName", "lawyerFirm", "vehicleId", "plannedEndAt", "dailyRate", "t_OTHER_label"].map(stepOfField), [1, 1, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5]);
  // Werkstatt/Anwalt optional – wer etwas einträgt, nennt den Namen
  assert.ok(validateWizardStep(3, { insurerName: "HUK", workshopPhone: "0421 1" }).some((e) => e.field === "workshopName"));
  assert.ok(validateWizardStep(3, { insurerName: "HUK", lawyerEmail: "kanzlei@example.test" }).some((e) => e.field === "lawyerFirm"));
  assert.deepEqual(validateWizardStep(3, { insurerName: "HUK" }), [], "Werkstatt und Anwalt dürfen ganz fehlen");
  assert.ok(validateWizardStep(3, { insurerName: "HUK", insurerEmail: "keine-mail" }).some((e) => e.message === "Versicherung: Die E-Mail-Adresse ist ungültig."));
  // dieselbe E-Mail-Regel wie der Server (mail.ts): was der Wizard durchlässt, lehnt die Anlage nicht nachträglich ab
  for (const m of ["info@werkstatt.de", "a.b@c-d.de", "info@werkstatt.de.", "info@firma.de,", "max..muster@firma.de", "<service@huk.de>", "x@y.z1", "ohne-at.de", " info@firma.de "]) assert.equal(wizardEmailValid(m), isValidEmail(m), m);
});

test("Meldungen der Anlage führen zum richtigen Schritt – auch wenn sie Namen enthalten", () => {
  const cases: [string, number][] = [
    ["Doppelbelegung: HB-UE 1 ist von 05.10.2026, 10:00 bis zur Rückgabe (offenes Mietende) an Kundendienst Werkstatt-Versicherung GmbH vergeben (Nr. 2026-0001).", 4],
    ["Mietende offen ist mit HB-UE 1 nicht möglich: Das Fahrzeug ist ab 06.10.2026, 09:00 für Buchung 2026-0002 vorgesehen. Bitte ein geplantes Mietende vor diesem Zeitpunkt wählen oder ein anderes Fahrzeug.", 4],
    ["Ersatzfahrzeug nicht gefunden.", 4],
    ["Das Fahrzeug steht auf „Werkstatt“ und kann in diesem Zustand nicht vermietet werden.", 4],
    ["Das Fahrzeug steht auf „Gesperrt“ und kann in diesem Zustand nicht vermietet werden.", 4],
    ["Kunde nicht gefunden.", 1],
    ["Erika Muster ist gesperrt: offene Forderungen", 1],
    ["Das Unfalldatum darf nicht in der Zukunft liegen.", 2],
    ["Die gewählte Werkstatt wurde im Adressbuch nicht gefunden.", 3],
    ["Bitte die Haftungsquote des Gegners als ganze Zahl von 0 bis 100 angeben.", 3],
    ["Werkstatt: Die E-Mail-Adresse ist ungültig.", 3],
    ["Versicherung: Die E-Mail-Adresse ist ungültig.", 3],
    ["Rechtsanwalt: Die E-Mail-Adresse ist ungültig.", 3],
    ["Bitte den Tagessatz (größer 0 €) angeben.", 5],
    ["Tarifposition 2: Bitte einen Betrag ab 0,00 € angeben.", 5],
    ["Unfallersatz ist für diesen Mandanten nicht freigeschaltet.", 6],
  ];
  for (const [m, step] of cases) assert.equal(stepOfCreateMessage(m), step, m);
});

test("Haftungsquote: unter 0, über 100, Kommazahl und Text abgelehnt; 0 und 100 angenommen; nur beim Status „Haftungsquote“ relevant", () => {
  for (const bad of ["-1", "101", "150", "12,5", "12.5", "abc", ""]) assert.ok(quotaField(bad).error, `${bad} muss abgelehnt werden`);
  for (const [ok, v] of [["0", 0], ["100", 100], ["75", 75], ["50 %", 50]] as const) assert.deepEqual(quotaField(ok), { value: v, error: null });
  const base = { insurerName: "HUK" };
  assert.ok(validateWizardStep(3, { ...base, liabilityStatus: "QUOTA", liabilityQuotaPercent: "101" }).some((e) => e.message === "Die Haftungsquote liegt zwischen 0 und 100 %."));
  assert.ok(validateWizardStep(3, { ...base, liabilityStatus: "QUOTA", liabilityQuotaPercent: "-5" }).some((e) => e.field === "liabilityQuotaPercent"));
  assert.ok(validateWizardStep(3, { ...base, liabilityStatus: "QUOTA", liabilityQuotaPercent: "" }).some((e) => e.field === "liabilityQuotaPercent"), "beim Status Haftungsquote ist die Quote Pflicht");
  assert.deepEqual(validateWizardStep(3, { ...base, liabilityStatus: "REPORTED", liabilityQuotaPercent: "150" }), [], "ohne Status Haftungsquote wird die Quote ignoriert");
  assert.ok(validateWizardStep(3, { ...base, liabilityStatus: "ERFUNDEN" }).some((e) => e.field === "liabilityStatus"));
});

test("Zeitraum: offenes Ende ohne Datum, bekanntes Ende nach Mietbeginn, Unfalldatum nicht in der Zukunft", () => {
  const d = { vehicleId: "x", startAt: "2026-11-02T10:00" };
  assert.deepEqual(validateWizardStep(4, { ...d, endMode: "open", plannedEndAt: "2026-11-01T10:00" }), [], "bei „Mietende offen“ zählt kein Enddatum");
  assert.ok(validateWizardStep(4, { ...d }).some((e) => e.field === "endMode"), "Mietende-Modus ist Pflicht");
  assert.ok(validateWizardStep(4, { ...d, endMode: "known" }).some((e) => e.field === "plannedEndAt"));
  assert.ok(validateWizardStep(4, { ...d, endMode: "known", plannedEndAt: "2026-11-02T10:00" }).some((e) => e.message === "Das geplante Mietende muss nach dem Mietbeginn liegen."));
  assert.deepEqual(validateWizardStep(4, { ...d, endMode: "known", plannedEndAt: "2026-11-05T10:00" }), []);
  const now = parseLocalDateTime("2026-10-04T12:00")!;
  const step2 = { damagedPlate: "HB-A 1", damagedMake: "VW", damagedModel: "Polo", damagedDrivable: "1", damageKind: "UNKNOWN" };
  assert.ok(validateWizardStep(2, { ...step2, accidentDate: "2026-10-05" }, now).some((e) => e.message === "Das Unfalldatum liegt in der Zukunft."));
  assert.deepEqual(validateWizardStep(2, { ...step2, accidentDate: "2026-10-04" }, now), [], "Unfall heute ist zulässig");
  assert.ok(validateWizardStep(2, { ...step2, accidentDate: "2026-02-30" }, now).some((e) => e.field === "accidentDate"));
});

test("Tarif: Beträge als ganze Cent ohne Fließkomma, nur angehakte Positionen, Pflichtbetrag je Position, kein Tagessatz 0", () => {
  const base: WizardData = { dailyRate: "79,90", deposit: "300", kmIncludedPerDay: "1.000", extraKmRate: "0,1" };
  const parsedOf = (d: WizardData) => {
    const p = parseAccidentWizard({
      customerMode: "existing", customerId: "k", damagedPlate: "HB-A 1", damagedMake: "VW", damagedModel: "Polo", damagedDrivable: "1", damageKind: "UNKNOWN", accidentDate: "2026-01-01",
      insurerName: "HUK", vehicleId: "v", startAt: "2026-11-02T10:00", endMode: "open", ...d,
    });
    return p;
  };
  const ok = parsedOf({ ...base, t_ADDITIONAL_DRIVER_on: "1", t_ADDITIONAL_DRIVER_amount: "0,30", t_WINTER_TIRES_amount: "9", t_OTHER_on: "1", t_OTHER_label: "Anhängerkupplung", t_OTHER_amount: "12,5", t_OTHER_mode: "day" });
  assert.ok(ok.ok);
  assert.equal(ok.input.dailyRateCents, 7_990);
  assert.equal(ok.input.depositCents, 30_000);
  assert.equal(ok.input.kmIncludedPerDay, 1_000);
  assert.equal(ok.input.extraKmRateCents, 10, "0,1 € = 10 Cent, nicht 0,1 * 100 als Fließkomma");
  assert.deepEqual(ok.input.tariff, [
    { kind: "ADDITIONAL_DRIVER", label: "Zusatzfahrer", perDay: true, unitPriceCents: 30, quantityHundredths: 100 },
    { kind: "OTHER", label: "Anhängerkupplung", perDay: true, unitPriceCents: 1_250, quantityHundredths: 100 },
  ], "Winterbereifung ist nicht angehakt und wird nicht gespeichert");
  for (const v of Object.values(ok.input.tariff)) assert.ok(Number.isInteger(v.unitPriceCents));
  const errs = (d: WizardData) => { const p = parsedOf({ ...base, ...d }); return p.ok ? [] : p.errors.map((e) => e.field); };
  assert.deepEqual(errs({ dailyRate: "0" }), ["dailyRate"], "Tagessatz 0 wird abgelehnt");
  assert.deepEqual(errs({ dailyRate: "-10" }), ["dailyRate"]);
  assert.deepEqual(errs({ dailyRate: "zehn" }), ["dailyRate"]);
  assert.deepEqual(errs({ t_DELIVERY_on: "1", t_DELIVERY_amount: "" }), ["t_DELIVERY_amount"], "angehakte Position ohne Betrag");
  assert.deepEqual(errs({ t_OTHER_on: "1", t_OTHER_amount: "5" }), ["t_OTHER_label"], "sonstige Position braucht eine Bezeichnung");
  assert.deepEqual(errs({ kmIncludedPerDay: "-5" }), ["kmIncludedPerDay"]);
  // deutscher Tausenderpunkt: „1.500“ sind 1.500 €, nicht 1,50 €
  assert.deepEqual(["1.500", "1.500,50", "12.345.678", "12,50", "12.50", "79 €", "€ 1.500", "1.500 €", "0.250", "0,25", "1 500"].map((v) => moneyField(v, "Betrag").cents), [150_000, 150_050, null, 1_250, 1_250, 7_900, 150_000, 150_000, 25, 25, 150_000], "Tausenderpunkt nur ohne führende Null; € vorn oder hinten gleich; 12.345.678 € ist unplausibel hoch");
  const p = parsedOf({ dailyRate: "79", t_DELIVERY_amount: "40" });
  assert.ok(p.ok && (p.input.tariff ?? []).length === 0 && p.input.depositCents === 0, "ohne Haken keine Position, leere Kaution = 0");
});

// ---------------------------------------------------------------------------
// Preisvorschau (rein)
// ---------------------------------------------------------------------------

test("Preisvorschau bekanntes Ende: Miettage × Tagessatz + Tagespositionen + Einmalpositionen = Gesamtbetrag (in Cent, Wandzeit)", () => {
  const items = [
    { label: "Haftungsreduzierung", perDay: true, unitPriceCents: 1_500, quantityHundredths: 100 },
    { label: "Zustellung", perDay: false, unitPriceCents: 4_000, quantityHundredths: 100 },
    { label: "Abholung", perDay: false, unitPriceCents: 3_500, quantityHundredths: 100 },
  ];
  const p = accidentPricePreview({ startAt: parseLocalDateTime("2026-11-02T10:00")!, endAt: parseLocalDateTime("2026-11-05T10:00")!, dailyRateCents: 7_900, items });
  assert.equal(p.kind, "KNOWN_END");
  if (p.kind !== "KNOWN_END") return;
  assert.equal(p.days, 3);
  assert.deepEqual(p.lines.map((l) => l.cents), [23_700, 4_500, 4_000, 3_500]);
  assert.equal(p.perDayCents, 9_400);
  assert.equal(p.oneOffCents, 7_500);
  assert.equal(p.totalCents, 3 * 7_900 + 3 * 1_500 + 4_000 + 3_500);
  assert.equal(p.totalCents, 35_700);
  // Zeitumstellung (25.10.2026): zwei Kalendertage bleiben zwei Miettage, obwohl 49 Stunden vergehen
  const dst = accidentPricePreview({ startAt: parseLocalDateTime("2026-10-24T10:00")!, endAt: parseLocalDateTime("2026-10-26T10:00")!, dailyRateCents: 5_500, items: [] });
  assert.ok(dst.kind === "KNOWN_END" && dst.days === 2 && dst.totalCents === 11_000);
  // keine Rabatte, keine Wochen-/Monatsstufen: 30 Tage sind 30 × Tagessatz
  const month = accidentPricePreview({ startAt: parseLocalDateTime("2026-11-01T09:00")!, endAt: parseLocalDateTime("2026-12-01T09:00")!, dailyRateCents: 5_500, items: [] });
  assert.ok(month.kind === "KNOWN_END" && month.totalCents === month.days * 5_500);
  assert.equal(lineCents(150, 999), 1_499, "Menge 1,5 × 9,99 € kaufmännisch gerundet");
});

test("Preisvorschau offenes Ende: kein Gesamtbetrag, laufende Kosten je Miettag und Einmalpositionen; Zwischenstand nur ab Mietbeginn", () => {
  const items = [
    { label: "Haftungsreduzierung", perDay: true, unitPriceCents: 1_500, quantityHundredths: 100 },
    { label: "Zustellung", perDay: false, unitPriceCents: 4_000, quantityHundredths: 100 },
  ];
  const now = parseLocalDateTime("2026-10-04T12:00")!;
  const future = accidentPricePreview({ startAt: parseLocalDateTime("2026-10-05T09:00")!, endAt: null, dailyRateCents: 7_900, items, now });
  assert.equal(future.kind, "OPEN_END");
  assert.ok(!("totalCents" in future), "kein erfundener Gesamtbetrag");
  if (future.kind !== "OPEN_END") return;
  assert.equal(future.perDayCents, 9_400);
  assert.deepEqual(future.perDayLines.map((l) => [l.label, l.cents]), [["Tagessatz", 7_900], ["Haftungsreduzierung", 1_500]]);
  assert.deepEqual(future.oneOffLines.map((l) => [l.label, l.cents]), [["Zustellung", 4_000]]);
  assert.equal(future.elapsed, null, "vor Mietbeginn kein Zwischenstand");
  const running = accidentPricePreview({ startAt: parseLocalDateTime("2026-10-01T09:00")!, endAt: null, dailyRateCents: 7_900, items, now });
  assert.ok(running.kind === "OPEN_END" && running.elapsed !== null);
  if (running.kind !== "OPEN_END" || !running.elapsed) return;
  assert.equal(running.elapsed.days, 4, "01.10. 09:00 bis 04.10. 12:00 = 4 angefangene Miettage");
  assert.equal(running.elapsed.cents, 4 * 9_400 + 4_000, "Zwischenstand = bisherige Miettage × Tageskosten + Einmalpositionen");
});

// ---------------------------------------------------------------------------
// Vom Formular bis zur Anlage (Datenbank)
// ---------------------------------------------------------------------------

test("Wizard → Anlage mit bestehendem Kunden und bekanntem Ende: Tarif in Cent, nur benutzte Positionen, Schadennummer darf fehlen", async () => {
  const w = await world("wz-known");
  const start = soon();
  const end = new Date(start.getTime() + 3 * DAY);
  const res = await submit(w, form(w, { endMode: "known", plannedEndAt: toDateTimeInput(end), deposit: "250", t_OTHER_on: "1", t_OTHER_label: "Kindersitz", t_OTHER_amount: "4,90", t_OTHER_mode: "day" }));
  assert.equal(res.created, true);
  const b = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
  assert.equal(b.rentalType, "ACCIDENT_REPLACEMENT");
  assert.equal(b.customerId, w.customerId, "bestehender Kunde, kein neuer Datensatz");
  assert.equal(await db.customer.count({ where: { tenantId: w.tenantId } }), 1);
  assert.equal(b.vehicleId, w.v2);
  assert.equal(b.startAt.getTime(), start.getTime());
  assert.equal(b.endAt?.getTime(), end.getTime(), "geplantes Mietende wie eingegeben");
  assert.equal(Number(b.dailyRate), 79);
  assert.equal(Number(b.deposit), 250);
  assert.equal(b.kmIncludedPerDay, 200);
  assert.equal(Number(b.extraKmRate), 0.25);
  const items = await db.accidentReplacementTariffItem.findMany({ where: { caseId: res.case.id }, orderBy: { sortOrder: "asc" } });
  assert.deepEqual(items.map((i) => [i.kind, i.label, i.perDay, i.unitPriceCents, i.quantityHundredths]), [
    ["LIABILITY_REDUCTION", "Haftungsreduzierung", true, 1_500, 100],
    ["DELIVERY", "Zustellung", false, 4_000, 100],
    ["OTHER", "Kindersitz", true, 490, 100],
  ], "Abholung war nicht angehakt und fehlt");
  assert.equal(res.case.insurerName, "HUK-COBURG");
  assert.equal(res.case.insurerClaimNumber, null, "Schadennummer darf bei der Anlage fehlen");
  assert.equal(res.case.damagedPlate, "HB-AB 123");
  assert.equal(res.case.damagedDrivable, false);
  assert.equal(res.case.liabilityStatus, "REPORTED");
  assert.equal(res.case.liabilityQuotaPercent, null);
  assert.equal(res.case.workshopName, null, "Werkstatt optional");
  assert.equal(res.case.lawyerFirm, null, "Anwalt optional");
  const contract = await db.rentalContract.findFirstOrThrow({ where: { bookingId: b.id } });
  assert.equal(contract.status, "DRAFT", "Übergabe vorbereitet: Vertragsentwurf liegt bereit");
  assert.equal(Number(contract.deposit), 250, "Vertragskaution wie im Wizard");
  assert.equal(contract.discountPercent, 0, "kein Kundenrabatt beim Unfallersatz, auch nicht im Vertrag (Kunde hat 10 %)");
});

test("Wizard → Anlage mit neuem Kunden und offenem Mietende: Kunde über die bestehende Kundenlogik, kein Enddatum erfunden", async () => {
  const w = await world("wz-new");
  await db.vehicle.update({ where: { id: w.v2 }, data: { deposit: 300 } });
  const res = await submit(w, form(w, {
    deposit: "0",
    customerMode: "new", customerId: "", c_type: "PRIVATE", c_firstName: "Anna-Katharina", c_lastName: "Schmidt-Rottluff von der Lippe", c_email: "Anna@Example.test", c_phone: "0421 555", c_street: "Weg 2", c_zip: "28195", c_city: "Bremen",
    liabilityStatus: "QUOTA", liabilityQuotaPercent: "75", insurerClaimNumber: "SN-2026-1",
  }));
  const b = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId }, include: { customer: true } });
  assert.equal(b.endAt, null, "Mietende offen: kein Datum");
  assert.notEqual(b.customerId, w.customerId);
  assert.equal(b.customer.tenantId, w.tenantId);
  assert.equal(b.customer.lastName, "Schmidt-Rottluff von der Lippe");
  assert.equal(b.customer.email, "anna@example.test", "dieselbe Normalisierung wie im Kundenformular");
  assert.match(b.customer.number ?? "", /^K-\d+$/);
  assert.equal(res.case.liabilityStatus, "QUOTA");
  assert.equal(res.case.liabilityQuotaPercent, 75);
  assert.equal(res.case.insurerClaimNumber, "SN-2026-1");
  // Kaution 0 heißt beim Unfallersatz „keine Kaution“ – weder Buchung noch Vertrag greifen auf die Fahrzeugvorgabe (300 €) zurück
  assert.equal(Number(b.deposit), 0);
  assert.equal(Number((await db.rentalContract.findFirstOrThrow({ where: { bookingId: b.id } })).deposit), 0);
  // Pflichtangaben des neuen Kunden: verständliche Meldung, Schritt 1
  const bad = parseAccidentWizard(form(w, { customerMode: "new", c_type: "PRIVATE", c_firstName: "Anna", c_lastName: "" }));
  assert.ok(!bad.ok && bad.step === 1 && bad.errors[0].message === "Neuer Kunde: Bitte den Nachnamen eingeben.");
});

test("Fahrzeugkonflikt und offene Miete vor einer zukünftigen Buchung: verständlich abgelehnt, nichts angelegt", async () => {
  const w = await world("wz-conflict");
  const std = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId }, include: { vehicle: true } });
  const before = { bookings: await db.booking.count({ where: { tenantId: w.tenantId } }), customers: await db.customer.count({ where: { tenantId: w.tenantId } }) };
  // Doppelbelegung: bekanntes Ende überschneidet die Standardbuchung auf v1
  const overlap = await domainMessage(submit(w, form(w, { vehicleId: w.vehicleId, startAt: toDateTimeInput(new Date(std.startAt.getTime() + DAY)), endMode: "known", plannedEndAt: toDateTimeInput(new Date(std.startAt.getTime() + 2 * DAY)) })));
  assert.match(overlap, /Doppelbelegung/);
  assert.ok(overlap.includes(std.vehicle.plate) && overlap.includes(std.number), "nennt Fahrzeug und belegende Buchung");
  assert.ok(!TECHNICAL.test(overlap), overlap);
  // offenes Ende jetzt, obwohl das Fahrzeug ab morgen für die Standardbuchung vorgesehen ist
  const open = await domainMessage(submit(w, form(w, { vehicleId: w.vehicleId, endMode: "open" })));
  assert.match(open, /^Mietende offen ist mit .+ nicht möglich: Das Fahrzeug ist ab .+ für Buchung .+ vorgesehen\. Bitte ein geplantes Mietende vor diesem Zeitpunkt wählen oder ein anderes Fahrzeug\.$/);
  assert.ok(!TECHNICAL.test(open), open);
  // ein neuer Kunde entsteht bei Ablehnung nicht
  await domainMessage(submit(w, form(w, { vehicleId: w.vehicleId, endMode: "open", customerMode: "new", c_type: "PRIVATE", c_firstName: "Neu", c_lastName: "Kunde" })));
  assert.deepEqual({ bookings: await db.booking.count({ where: { tenantId: w.tenantId } }), customers: await db.customer.count({ where: { tenantId: w.tenantId } }) }, before);
  assert.equal(await db.accidentReplacementCase.count({ where: { tenantId: w.tenantId } }), 0);
  // mit geplantem Ende vor der Standardbuchung klappt es
  const ok = await submit(w, form(w, { vehicleId: w.vehicleId, endMode: "known", plannedEndAt: toDateTimeInput(new Date(std.startAt.getTime() - HOUR)) }));
  assert.equal(ok.created, true);
});

test("Mandantentrennung: Adressbuch, Fahrzeug und Kunde eines anderen Mandanten sind nicht nutzbar; eigener Eintrag füllt den Fall-Snapshot", async () => {
  const a = await world("wz-tenant-a");
  const b = await world("wz-tenant-b");
  const foreignInsurer = await db.businessPartner.create({ data: { tenantId: b.tenantId, kind: "INSURER", name: "Fremde Versicherung AG", nameKey: "fremde versicherung ag", city: "Köln" } });
  const foreignWorkshop = await db.businessPartner.create({ data: { tenantId: b.tenantId, kind: "WORKSHOP", name: "Fremde Werkstatt", nameKey: "fremde werkstatt" } });
  const ownWorkshop = await db.businessPartner.create({ data: { tenantId: a.tenantId, kind: "WORKSHOP", name: "Eigene Werkstatt", nameKey: "eigene werkstatt" } });
  const notFound = (m: string) => /im Adressbuch nicht gefunden/.test(m) && !TECHNICAL.test(m);
  assert.ok(notFound(await domainMessage(submit(a, form(a, { insurerPartnerId: foreignInsurer.id })))), "Versicherung aus Mandant B");
  assert.ok(notFound(await domainMessage(submit(a, form(a, { workshopPartnerId: foreignWorkshop.id, workshopName: "Fremde Werkstatt" })))), "Werkstatt aus Mandant B");
  assert.ok(notFound(await domainMessage(submit(a, form(a, { insurerPartnerId: ownWorkshop.id })))), "eigene Werkstatt ist keine Versicherung");
  const vehicleMsg = await domainMessage(submit(a, form(a, { vehicleId: b.v2 })));
  assert.equal(vehicleMsg, "Ersatzfahrzeug nicht gefunden.", "Fahrzeug von Mandant B: wie nicht vorhanden");
  const customerMsg = await domainMessage(submit(a, form(a, { customerId: b.customerId })));
  assert.equal(customerMsg, "Kunde nicht gefunden.", "Kunde von Mandant B: wie nicht vorhanden");
  for (const t of [a, b]) assert.equal(await db.accidentReplacementCase.count({ where: { tenantId: t.tenantId } }), 0, "nichts angelegt");
  assert.equal(await db.booking.count({ where: { vehicleId: b.v2, rentalType: "ACCIDENT_REPLACEMENT" } }), 0, "Fahrzeug von B von niemandem belegt");
  // eigener Adressbucheintrag: gespeichert wird, was der Wizard abschickt (er übernimmt die Angaben beim Auswählen);
  // ein bewusst geleertes Feld wird nicht aus dem Adressbuch wieder aufgefüllt; der Fall behält seinen eigenen Stand
  const own = await db.businessPartner.create({ data: { tenantId: a.tenantId, kind: "INSURER", name: "Allianz Versicherungs-AG", nameKey: "allianz versicherungs-ag", contactName: "Herr Beispiel", phone: "089 1", email: "alt@allianz.example", city: "München" } });
  const res = await submit(a, form(a, { insurerPartnerId: own.id, insurerName: "Allianz Versicherungs-AG", insurerContactName: "Herr Beispiel", insurerPhone: "089 1", insurerEmail: "", insurerCity: "München" }));
  assert.equal(res.case.insurerContactName, "Herr Beispiel");
  assert.equal(res.case.insurerCity, "München");
  assert.equal(res.case.insurerEmail, null, "geleerte E-Mail bleibt leer");
  await db.businessPartner.update({ where: { id: own.id }, data: { name: "Allianz (umbenannt)", nameKey: "allianz (umbenannt)", city: "Berlin" } });
  const kept = await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: res.case.id } });
  assert.deepEqual([kept.insurerName, kept.insurerCity], ["Allianz Versicherungs-AG", "München"], "Snapshot im Fall bleibt unverändert");
});

test("Doppelklick: zwei gleichzeitige Absendungen desselben Formulars ergeben genau einen Fall und eine Buchung", async () => {
  const w = await world("wz-double");
  const d = form(w);
  const key = nonce();
  const [r1, r2] = await Promise.all([submit(w, d, key), submit(w, d, key)]);
  assert.equal(r1.case.id, r2.case.id);
  assert.equal(r1.bookingId, r2.bookingId);
  assert.equal([r1.created, r2.created].filter(Boolean).length, 1, "genau eine Absendung legt an");
  const r3 = await submit(w, d, key);
  assert.equal(r3.created, false, "erneutes Absenden (z. B. Zurück im Browser) legt nichts Neues an");
  assert.equal(await db.accidentReplacementCase.count({ where: { tenantId: w.tenantId } }), 1);
  assert.equal(await db.booking.count({ where: { tenantId: w.tenantId, rentalType: "ACCIDENT_REPLACEMENT" } }), 1);
  assert.equal(await db.rentalContract.count({ where: { tenantId: w.tenantId, bookingId: r1.bookingId } }), 1);
});

test("Ohne Freischaltung keine Anlage – auch nicht über einen direkten Aufruf der Fachlogik", async () => {
  const w = await world("wz-feature", { feature: false });
  const msg = await domainMessage(submit(w, form(w)));
  assert.ok(!TECHNICAL.test(msg), msg);
  assert.equal(await db.accidentReplacementCase.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await db.booking.count({ where: { tenantId: w.tenantId, rentalType: "ACCIDENT_REPLACEMENT" } }), 0);
  // ausdrücklich gesperrt (Control Center) wirkt genauso
  await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: false } });
  await domainMessage(submit(w, form(w)));
  await db.tenantFeatureFlag.update({ where: { tenantId_key: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT" } }, data: { enabled: true } });
  assert.equal((await submit(w, form(w))).created, true, "nach Freischaltung möglich");
});
