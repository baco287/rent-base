// Geldlogik der Rechnungen: ganzzahlige Cent-Arithmetik, deterministische Rundung, brutto = netto + Steuer je Position.
import { test } from "node:test";
import assert from "node:assert/strict";
import { centsToDecimalString, fmtCents, lineAmounts, summarize, toBasisPoints, toCents, toHundredths } from "../src/lib/money";

test("Cent-Umwandlung: Komma, Punkt, Tausenderpunkte, Decimal-Strings, Rundung auf ganze Cent", () => {
  assert.equal(toCents("0,01"), 1);
  assert.equal(toCents("0.10"), 10);
  assert.equal(toCents("0,20"), 20);
  assert.equal(toCents("0,30"), 30);
  assert.equal(toCents("1.234,56"), 123_456);
  assert.equal(toCents("1234.56"), 123_456);
  assert.equal(toCents(89), 8900);
  assert.equal(toCents("480.00"), 48_000);
  assert.equal(toCents("0.005"), 1, "halbe Cent kaufmännisch aufwärts");
  assert.equal(toCents("1.005"), 101);
  assert.equal(toCents("999999999,99"), 99_999_999_999);
  assert.throws(() => toCents("abc"), /Kein gültiger Betrag/);
  assert.equal(centsToDecimalString(1), "0.01");
  assert.equal(centsToDecimalString(123_456), "1234.56");
  assert.equal(centsToDecimalString(-5), "-0.05");
  assert.equal(fmtCents(123_456).replace(/ /g, " "), "1.234,56 €");
  assert.equal(toHundredths("2,5"), 250);
  assert.equal(toBasisPoints("19"), 1900);
  assert.equal(toBasisPoints("7,00"), 700);
});

test("Gleitkomma-Fallen: 0,1 + 0,2 und Mehrfachsummen ergeben exakt ganze Cent", () => {
  assert.notEqual(0.1 + 0.2, 0.3, "Gleitkomma wäre falsch");
  assert.equal(toCents("0,10") + toCents("0,20"), toCents("0,30"));
  const sum = summarize([1, 2, 3].map(() => ({ taxRateBp: 1900, amounts: lineAmounts("NET", 100, 10, 1900) })));
  assert.deepEqual(sum.total, { net: 30, tax: 6, gross: 36 });
  // 0,01 € netto bei 19 %: Steuer rundet auf 0,00, brutto bleibt 0,01
  assert.deepEqual(lineAmounts("NET", 100, 1, 1900), { net: 1, tax: 0, gross: 1 });
  // 0,03 € netto bei 19 %: 0,0057 → 0,01
  assert.deepEqual(lineAmounts("NET", 100, 3, 1900), { net: 3, tax: 1, gross: 4 });
});

test("19 % netto und brutto: Steuer einmal je Position, Summe = Summe der gerundeten Positionen", () => {
  // Nettomodus: 6 Tage × 89,00 € = 534,00 netto, Steuer 101,46, brutto 635,46
  assert.deepEqual(lineAmounts("NET", 600, 8900, 1900), { net: 53_400, tax: 10_146, gross: 63_546 });
  // Bruttomodus: 480,00 brutto enthält 19 % → Steuer 76,64 (480/1,19 = 403,36 netto)
  assert.deepEqual(lineAmounts("GROSS", 100, 48_000, 1900), { net: 40_336, tax: 7664, gross: 48_000 });
  // 0,25 €/km × 200 km netto = 50,00; brutto 59,50
  assert.deepEqual(lineAmounts("NET", 20_000, 25, 1900), { net: 5000, tax: 950, gross: 5950 });
  // Bruttomodus: 0,25 €/km × 33 km = 8,25 brutto, Steuer 1,32 (8,25 × 19/119 = 1,3172)
  assert.deepEqual(lineAmounts("GROSS", 3300, 25, 1900), { net: 693, tax: 132, gross: 825 });
  // 0 %: keine Steuer, brutto = netto
  assert.deepEqual(lineAmounts("GROSS", 100, 3000, 0), { net: 3000, tax: 0, gross: 3000 });
  // 7 % netto
  assert.deepEqual(lineAmounts("NET", 100, 1000, 700), { net: 1000, tax: 70, gross: 1070 });
  // Menge mit Nachkommastellen: 2,5 h × 45,00 = 112,50
  assert.deepEqual(lineAmounts("NET", 250, 4500, 1900), { net: 11_250, tax: 2138, gross: 13_388 });
  for (const mode of ["NET", "GROSS"] as const) for (const [q, p, r] of [[100, 1, 1900], [333, 3333, 1900], [1, 1, 700], [999, 99_999, 1900]]) {
    const a = lineAmounts(mode, q, p, r);
    assert.equal(a.gross, a.net + a.tax, `brutto = netto + Steuer (${mode} ${q} ${p} ${r})`);
    assert.ok(Number.isInteger(a.net) && Number.isInteger(a.tax) && Number.isInteger(a.gross));
  }
});

test("Mehrere Positionen und Steuersätze: Zusammenfassung je Satz, Gesamt, große Beträge ohne Präzisionsverlust", () => {
  const lines = [
    { taxRateBp: 1900, amounts: lineAmounts("GROSS", 100, 63_546, 1900) },
    { taxRateBp: 1900, amounts: lineAmounts("GROSS", 3300, 25, 1900) },
    { taxRateBp: 0, amounts: lineAmounts("GROSS", 100, 3000, 0) },
    { taxRateBp: 700, amounts: lineAmounts("GROSS", 200, 1070, 700) },
  ];
  const s = summarize(lines);
  assert.deepEqual(s.byRate.map((r) => r.taxRateBp), [1900, 700, 0], "höchster Satz zuerst");
  assert.deepEqual(s.byRate[0], { taxRateBp: 1900, net: 53_400 + 693, tax: 10_146 + 132, gross: 63_546 + 825 });
  assert.deepEqual(s.byRate[1], { taxRateBp: 700, net: 2000, tax: 140, gross: 2140 });
  assert.deepEqual(s.byRate[2], { taxRateBp: 0, net: 3000, tax: 0, gross: 3000 });
  assert.equal(s.total.gross, 63_546 + 825 + 3000 + 2140);
  assert.equal(s.total.gross, s.total.net + s.total.tax);

  // große Beträge: 1.000.000,00 × 999,99 bleibt ganzzahlig und exakt
  const big = lineAmounts("NET", 100_000_000, 99_999, 1900);
  assert.equal(big.net, 99_999_000_000);
  assert.equal(big.tax, 18_999_810_000);
  assert.equal(big.gross, big.net + big.tax);
  assert.ok(Number.isSafeInteger(big.gross));
});

test("Ungültige Eingaben werden abgewiesen: Menge 0, negativer Preis, Steuersatz außerhalb 0–100", () => {
  assert.throws(() => lineAmounts("NET", 0, 100, 1900), /größer als 0/);
  assert.throws(() => lineAmounts("NET", 100, -1, 1900), /nicht negativ/);
  assert.throws(() => lineAmounts("NET", 100, 100, -1), /zwischen 0 und 100/);
  assert.throws(() => lineAmounts("NET", 100, 100, 10_001), /zwischen 0 und 100/);
});
