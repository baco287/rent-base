// Fälligkeitslogik der Wartungspläne: reine Berechnung, ohne Datenbank.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, daysUntil, dueStatus, proposeNextDue } from "../src/lib/maintenance-due";

const now = new Date("2026-09-23T10:00:00+02:00");
const day = (n: number) => new Date(now.getTime() + n * 86_400_000);
const base = { warningDaysBefore: 30, warningKilometersBefore: 1000 };

test("nur Datum: weit weg, bald, heute, überfällig", () => {
  assert.equal(dueStatus({ ...base, nextDueDate: day(120), nextDueMileage: null }, 50_000, now).level, "OK");
  const soon = dueStatus({ ...base, nextDueDate: day(20), nextDueMileage: null }, 50_000, now);
  assert.equal(soon.level, "SOON");
  assert.equal(soon.text, "in 20 Tagen");
  assert.equal(soon.daysLeft, 20);
  const today = dueStatus({ ...base, nextDueDate: day(0), nextDueMileage: null }, 50_000, now);
  assert.equal(today.level, "DUE");
  assert.equal(today.text, "heute fällig");
  const over = dueStatus({ ...base, nextDueDate: day(-14), nextDueMileage: null }, 50_000, now);
  assert.equal(over.level, "OVERDUE");
  assert.equal(over.text, "seit 14 Tagen überfällig");
  assert.equal(dueStatus({ ...base, nextDueDate: day(-1), nextDueMileage: null }, null, now).text, "seit 1 Tag überfällig");
});

test("nur Kilometer: Abstand zum aktuellen Fahrzeugstand, keine Prognose", () => {
  assert.equal(dueStatus({ ...base, nextDueDate: null, nextDueMileage: 100_000 }, 90_000, now).level, "OK");
  const far = dueStatus({ ...base, nextDueDate: null, nextDueMileage: 100_000 }, 98_500, now);
  assert.equal(far.level, "OK");
  assert.equal(far.text, "noch 1.500 km", "Abstand wird immer genannt");
  const soon = dueStatus({ ...base, nextDueDate: null, nextDueMileage: 100_000 }, 99_200, now);
  assert.equal(soon.level, "SOON");
  assert.equal(soon.text, "noch 800 km");
  assert.equal(dueStatus({ ...base, nextDueDate: null, nextDueMileage: 100_000 }, 100_000, now).level, "DUE");
  const over = dueStatus({ ...base, nextDueDate: null, nextDueMileage: 100_000 }, 100_600, now);
  assert.equal(over.level, "OVERDUE");
  assert.equal(over.text, "seit 600 km überfällig");
  assert.equal(over.kmLeft, -600);
  // Ohne Fahrzeugkilometerstand nur Information, keine Warnstufe
  const none = dueStatus({ ...base, nextDueDate: null, nextDueMileage: 100_000 }, null, now);
  assert.equal(none.level, "NONE");
  assert.match(none.text, /kein Fahrzeugkilometerstand/);
});

test("Datum und Kilometer: der dringendere Wert zählt, der Text nennt beide (dringender zuerst)", () => {
  const far = dueStatus({ ...base, nextDueDate: day(200), nextDueMileage: 100_000 }, 80_000, now);
  assert.equal(far.level, "OK");
  const kmSoon = dueStatus({ ...base, nextDueDate: day(200), nextDueMileage: 100_000 }, 99_200, now);
  assert.equal(kmSoon.level, "SOON");
  assert.equal(kmSoon.text, "noch 800 km / in 200 Tagen");
  const dateSoon = dueStatus({ ...base, nextDueDate: day(12), nextDueMileage: 100_000 }, 80_000, now);
  assert.equal(dateSoon.level, "SOON");
  assert.equal(dateSoon.text, "in 12 Tagen / noch 20.000 km");
  const kmOver = dueStatus({ ...base, nextDueDate: day(12), nextDueMileage: 100_000 }, 100_300, now);
  assert.equal(kmOver.level, "OVERDUE");
  assert.equal(kmOver.text, "seit 300 km überfällig / in 12 Tagen");
  const dateOver = dueStatus({ ...base, nextDueDate: day(-3), nextDueMileage: 100_000 }, 99_900, now);
  assert.equal(dateOver.level, "OVERDUE");
  assert.equal(dateOver.text, "seit 3 Tagen überfällig / noch 100 km");
});

test("Schwellen aus dem Plan, deaktivierter Plan warnt nicht, Sortierung überfällig zuerst", () => {
  assert.equal(dueStatus({ ...base, warningDaysBefore: 7, nextDueDate: day(20), nextDueMileage: null }, null, now).level, "OK");
  assert.equal(dueStatus({ ...base, warningKilometersBefore: 5000, nextDueDate: null, nextDueMileage: 100_000 }, 96_000, now).level, "SOON");
  const off = dueStatus({ ...base, nextDueDate: day(-30), nextDueMileage: null, isActive: false }, 0, now);
  assert.equal(off.level, "NONE");
  assert.equal(off.text, "Plan deaktiviert");
  assert.equal(dueStatus({ ...base, nextDueDate: null, nextDueMileage: null }, 10, now).level, "NONE");
  const rows = [
    dueStatus({ ...base, nextDueDate: day(60), nextDueMileage: null }, null, now),
    dueStatus({ ...base, nextDueDate: day(-5), nextDueMileage: null }, null, now),
    dueStatus({ ...base, nextDueDate: day(5), nextDueMileage: null }, null, now),
    dueStatus({ ...base, nextDueDate: day(0), nextDueMileage: null }, null, now),
    dueStatus({ ...base, nextDueDate: day(-40), nextDueMileage: null }, null, now),
  ].sort((a, b) => a.sortKey - b.sortKey);
  assert.deepEqual(rows.map((r) => r.daysLeft), [-40, -5, 0, 5, 60]);
});

test("Kalendertage sind zeitunabhängig; Monatsrechnung und Vorschlag der nächsten Fälligkeit", () => {
  assert.equal(daysUntil(new Date("2026-09-24T00:30:00+02:00"), new Date("2026-09-23T23:30:00+02:00")), 1);
  assert.equal(addMonths(new Date("2026-01-31T12:00:00"), 1).getDate(), 28);
  assert.equal(addMonths(new Date("2026-09-18T12:00:00"), 12).toISOString().slice(0, 10), "2027-09-18");
  const p = proposeNextDue({ intervalMonths: 12, intervalKilometers: 20_000 }, new Date("2026-09-18T12:00:00"), 82_143);
  assert.equal(p.nextDueDate?.toISOString().slice(0, 10), "2027-09-18");
  assert.equal(p.nextDueMileage, 102_143);
  assert.deepEqual(proposeNextDue({ intervalMonths: null, intervalKilometers: 15_000 }, new Date(), null), { nextDueDate: null, nextDueMileage: null });
});
