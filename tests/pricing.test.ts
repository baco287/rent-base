// Tests der zentralen Preislogik. Aufruf: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRentalPrice, describePrice, rentalDays, toNumber } from "../src/lib/pricing";

const at = (day: number, hour = 9) => new Date(2026, 8, day, hour, 0, 0);
const rates = { dailyRate: 89, workWeekRate: 420, weeklyRate: 540, monthlyRate: 1790 };

test("Miettage: angefangene 24 Stunden zählen voll", () => {
  assert.equal(rentalDays(at(1), at(2)), 1);
  assert.equal(rentalDays(at(1), at(2, 10)), 2);
  assert.equal(rentalDays(at(1), at(1, 12)), 1);
  assert.equal(rentalDays(at(2), at(1)), 0);
});

test("unter 5 Tagen gilt der Tagespreis", () => {
  const p = calculateRentalPrice({ start: at(1), end: at(5), rates });
  assert.equal(p.days, 4);
  assert.equal(p.total, 356);
  assert.equal(describePrice(p), "4 × Tag");
});

test("5 Tage nutzen die Woche (5 Tage)", () => {
  const p = calculateRentalPrice({ start: at(1), end: at(6), rates });
  assert.equal(p.total, 420);
  assert.deepEqual(p.lines.map((l) => [l.tier, l.quantity]), [["WORK_WEEK", 1]]);
});

test("6 Tage: Woche plus Tag ist günstiger als die Kalenderwoche", () => {
  const p = calculateRentalPrice({ start: at(1), end: at(7), rates });
  assert.equal(p.total, 509);
});

test("7 Tage nutzen die Kalenderwoche", () => {
  const p = calculateRentalPrice({ start: at(1), end: at(8), rates });
  assert.equal(p.total, 540);
});

test("10 Tage: Kalenderwoche plus 3 Tage", () => {
  const p = calculateRentalPrice({ start: at(1), end: at(11), rates });
  assert.equal(p.total, 540 + 3 * 89);
  assert.equal(describePrice(p), "1 × Kalenderwoche (7 Tage) + 3 × Tag");
});

test("ein Block darf mehr Tage abdecken: 27 Tage kosten nie mehr als der Monat", () => {
  const p = calculateRentalPrice({ start: at(1), end: at(28), rates });
  assert.ok(p.total <= 1790);
});

test("30 Tage nutzen den Monat", () => {
  const p = calculateRentalPrice({ start: new Date(2026, 8, 1, 9), end: new Date(2026, 9, 1, 9), rates });
  assert.equal(p.days, 30);
  assert.equal(p.total, 1790);
});

test("ohne hinterlegte Stufen bleibt es bei Tagen mal Tagespreis (bestehende Buchungen)", () => {
  const p = calculateRentalPrice({ start: at(1), end: at(11), rates: { dailyRate: 49 } });
  assert.equal(p.total, 490);
});

test("Rabatt wird auf Cent gerundet und ausgewiesen", () => {
  const p = calculateRentalPrice({ start: at(1), end: at(4), rates: { dailyRate: 39.99 }, discountPercent: 10 });
  assert.equal(p.subtotal, 119.97);
  assert.equal(p.discountAmount, 12);
  assert.equal(p.total, 107.97);
});

test("die Aufschlüsselung enthält alles, was im Vertrag eingefroren wird", () => {
  const p = calculateRentalPrice({ start: at(1), end: at(11), rates, discountPercent: 5 });
  assert.equal(p.version, 1);
  assert.equal(p.strategy, "CHEAPEST_COMBINATION");
  assert.deepEqual(p.rates, { dailyRate: 89, workWeekRate: 420, weeklyRate: 540, monthlyRate: 1790 });
  assert.equal(p.lines.reduce((s, l) => s + l.amount, 0), p.subtotal);
});

test("toNumber versteht deutsche Kommazahlen und leere Werte", () => {
  assert.equal(toNumber("89,50"), 89.5);
  assert.equal(toNumber(""), null);
  assert.equal(toNumber(null), null);
});
