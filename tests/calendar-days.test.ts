// Kalendertage in Europe/Berlin über die Zeitumstellungen: Fälligkeit und Fristen sind „n Kalendertage später zur selben
// Uhrzeit“, nicht n × 24 Stunden. Reine Logik mit festen Zeitpunkten – unabhängig davon, wann der Test läuft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveReceivable } from "../src/lib/dunning";
import { parseLocalDateTime, toDateTimeInputValue, zonedDaysBetween, zonedParts, zonedPlusDays } from "../src/lib/time";

const H = 3_600_000;
const berlin = (d: Date) => toDateTimeInputValue(d);
const local = (s: string) => parseLocalDateTime(s)!;

test("Ende der Sommerzeit (25.10.2026): Abschluss 20.10. 00:30 + 14 Tage → 03.11. 00:30, nicht 02.11. 23:30", () => {
  const from = new Date("2026-10-20T00:30:00+02:00");
  const due = zonedPlusDays(from, 14);
  assert.equal(berlin(due), "2026-11-03T00:30");
  assert.equal(due.getTime() - from.getTime(), 14 * 24 * H + H, "eine Stunde mehr als 14 × 24 h");
  assert.equal(zonedDaysBetween(from, due), 14);
  assert.equal(berlin(new Date(from.getTime() + 14 * 24 * H)), "2026-11-02T23:30", "so rechnete die bisherige Fälligkeit");
});

test("Beginn der Sommerzeit (28.03.2027): Abschluss 20.03. 23:30 + 14 Tage → 03.04. 23:30, nicht 04.04. 00:30", () => {
  const from = new Date("2027-03-20T23:30:00+01:00");
  const due = zonedPlusDays(from, 14);
  assert.equal(berlin(due), "2027-04-03T23:30");
  assert.equal(due.getTime() - from.getTime(), 14 * 24 * H - H, "eine Stunde weniger als 14 × 24 h");
  assert.equal(zonedDaysBetween(from, due), 14);
  assert.equal(berlin(new Date(from.getTime() + 14 * 24 * H)), "2027-04-04T00:30", "so rechnete die bisherige Fälligkeit");
});

test("jede Uhrzeit vor beiden Umstellungen: Zieltag immer genau n Kalendertage später, Uhrzeit gleich (Lücke: nächste gültige)", () => {
  for (const [start, days] of [["2026-10-18", 14], ["2026-10-24", 1], ["2027-03-21", 14], ["2027-03-27", 1]] as const) {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30, 59]) {
        const from = local(`${start}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
        const to = zonedPlusDays(from, days);
        assert.equal(zonedDaysBetween(from, to), days, `${berlin(from)} + ${days} Tage → ${berlin(to)}`);
        const z = zonedParts(to);
        // 28.03.2027 02:00–02:59 gibt es nicht: dann 03:xx; der 25.10.2026 02:xx kommt doppelt vor, die Uhrzeit bleibt
        const inGap = berlin(to).startsWith("2027-03-28") && h === 2;
        assert.deepEqual([z.hour, z.minute], [inGap ? 3 : h, m], `${berlin(from)} + ${days} Tage → ${berlin(to)}`);
      }
    }
  }
});

test("Millisekunden und Tage ohne Umstellung bleiben exakt (n × 24 h)", () => {
  const from = new Date("2026-07-01T10:15:30.250+02:00");
  assert.equal(zonedPlusDays(from, 14).getTime() - from.getTime(), 14 * 24 * H);
  assert.equal(zonedPlusDays(from, 0).getTime(), from.getTime());
});

test("Überfällig nach Kalendertag über die Umstellung: am Fälligkeitstag nicht überfällig, ab dem Folgetag 00:00 überfällig", () => {
  const base = { principalOpenCents: 10_000, feesOpenCents: 0, notices: [] };
  // Herbst: Abschluss kurz nach Mitternacht – mit 14 × 24 h wäre die Rechnung am 03.11. schon überfällig gewesen
  const autumn = { ...base, dueDate: zonedPlusDays(new Date("2026-10-20T00:30:00+02:00"), 14) };
  assert.equal(deriveReceivable(autumn, local("2026-11-03T23:59")).status, "NOT_DUE");
  const a = deriveReceivable(autumn, local("2026-11-04T00:00"));
  assert.deepEqual([a.status, a.daysOverdue], ["OVERDUE", 1]);
  // Frühjahr: Abschluss kurz vor Mitternacht – mit 14 × 24 h wäre die Rechnung erst einen Tag später fällig gewesen
  const spring = { ...base, dueDate: zonedPlusDays(new Date("2027-03-20T23:30:00+01:00"), 14) };
  assert.equal(deriveReceivable(spring, local("2027-04-03T23:59")).status, "NOT_DUE");
  const s = deriveReceivable(spring, local("2027-04-04T00:00"));
  assert.deepEqual([s.status, s.daysOverdue], ["OVERDUE", 1]);
});
