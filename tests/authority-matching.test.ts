// Zuordnungslogik der Behördenvorgänge – reine Funktionen: Kennzeichenformate, Tatzeit vs. tatsächliche/geplante
// Mietdauer mit halboffenem Intervall, laufende Miete, mehrere Kandidaten, Tatzeit ohne Uhrzeit, Fristanzeige, Portaladresse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deadlineInfo, matchRentals, matchVehicles, offenseDayRange, plateKey, portalUrlInfo, type RentalCandidateInput } from "../src/lib/authority-matching";

const T = (iso: string) => new Date(iso);
const booking = (o: Partial<RentalCandidateInput> & { bookingId: string }): RentalCandidateInput => ({ bookingNumber: `B-${o.bookingId}`, status: "RETURNED", startAt: T("2026-09-10T08:00:00Z"), endAt: T("2026-09-14T08:00:00Z"), actualPickupAt: T("2026-09-10T08:30:00Z"), actualReturnAt: T("2026-09-14T07:45:00Z"), contractId: `c-${o.bookingId}`, contractStatus: "SIGNED", ...o });

test("Kennzeichen: Leer- und Bindestriche, Groß-/Kleinschreibung und Umlaute ergeben denselben Schlüssel; kein Fuzzy-Match", () => {
  assert.equal(plateKey("HB-AB 1234"), "HBAB1234");
  assert.equal(plateKey("hb ab 1234"), "HBAB1234");
  assert.equal(plateKey("HBAB1234"), "HBAB1234");
  assert.equal(plateKey("HB-ÄB 12"), "HBÄB12");
  assert.equal(plateKey("  "), "");
  const fleet = [{ id: "v1", plate: "HB-AB 1234" }, { id: "v2", plate: "HB-AB 1235" }, { id: "v3", plate: "HB AB 1234" }];
  assert.deepEqual(matchVehicles("HBAB1235", fleet), { status: "EXACT_MATCH", vehicleIds: ["v2"] });
  assert.deepEqual(matchVehicles("HB-AB 1234", fleet), { status: "AMBIGUOUS", vehicleIds: ["v1", "v3"] });
  assert.deepEqual(matchVehicles("HB-AB 1236", fleet), { status: "NO_MATCH", vehicleIds: [] });
  assert.deepEqual(matchVehicles("HB-AB 123", fleet), { status: "NO_MATCH", vehicleIds: [] }, "ähnlich reicht nicht");
  assert.equal(matchVehicles("", fleet).status, "NO_MATCH");
});

test("Vermietung: Tatzeit mitten in der Miete, vor Übergabe, exakt Übergabe, exakt Rückgabe, nach Rückgabe ([start, end))", () => {
  const b = [booking({ bookingId: "a" })];
  assert.equal(matchRentals(b, T("2026-09-12T12:00:00Z"), true).status, "ACTUAL_PERIOD");
  assert.equal(matchRentals(b, T("2026-09-12T12:00:00Z"), true).selected?.explanation, "Tatzeit liegt innerhalb der tatsächlichen Mietdauer");
  assert.equal(matchRentals(b, T("2026-09-10T08:29:59Z"), true).status, "NONE", "vor tatsächlicher Übergabe – auch wenn geplant schon begonnen");
  assert.equal(matchRentals(b, T("2026-09-10T08:30:00Z"), true).status, "ACTUAL_PERIOD", "exakt Übergabe zählt");
  assert.equal(matchRentals(b, T("2026-09-14T07:45:00Z"), true).status, "NONE", "exakt Rückgabe zählt nicht mehr");
  assert.equal(matchRentals(b, T("2026-09-14T07:44:59Z"), true).status, "ACTUAL_PERIOD");
  assert.equal(matchRentals(b, T("2026-09-14T07:50:00Z"), true).status, "NONE", "nach Rückgabe – auch wenn geplant noch lief");
});

test("Vermietung: laufende Miete ohne Rückgabe, nur geplante Zeit als schwächerer Hinweis, tatsächlich schlägt geplant, mehrere Kandidaten ohne Auswahl, Storno ignoriert", () => {
  const running = booking({ bookingId: "r", status: "ACTIVE", actualReturnAt: null });
  const late = matchRentals([running], T("2026-09-20T12:00:00Z"), true);
  assert.equal(late.status, "ACTUAL_PERIOD");
  assert.equal(late.selected?.windowEnd, null);
  assert.match(late.selected!.explanation, /laufenden Miete/);
  const planned = booking({ bookingId: "p", status: "RESERVED", actualPickupAt: null, actualReturnAt: null });
  const pl = matchRentals([planned], T("2026-09-12T12:00:00Z"), true);
  assert.equal(pl.status, "PLANNED_PERIOD");
  assert.equal(pl.selected?.basis, "PLANNED");
  assert.match(pl.selected!.explanation, /geplanter Buchungszeit/);
  const both = matchRentals([planned, booking({ bookingId: "a" })], T("2026-09-12T12:00:00Z"), true);
  assert.equal(both.status, "ACTUAL_PERIOD", "tatsächlich gewinnt gegen geplant");
  assert.equal(both.selected?.bookingId, "a");
  assert.equal(both.candidates.length, 2, "alle Kandidaten sichtbar");
  const amb = matchRentals([booking({ bookingId: "a" }), booking({ bookingId: "b" })], T("2026-09-12T12:00:00Z"), true);
  assert.equal(amb.status, "AMBIGUOUS");
  assert.equal(amb.selected, null, "keine automatische Auswahl");
  assert.equal(matchRentals([booking({ bookingId: "x", status: "CANCELLED" })], T("2026-09-12T12:00:00Z"), true).status, "NONE");
  assert.equal(matchRentals([booking({ bookingId: "old", status: "RETURNED", actualPickupAt: null, actualReturnAt: null })], T("2026-09-12T12:00:00Z"), true).status, "NONE", "Altbestand ohne tatsächliche Zeiten: keine Aussage");
  assert.equal(matchRentals([], T("2026-09-12T12:00:00Z"), true).status, "NONE");
});

test("Tatzeit unbekannt: Tattag (Europe/Berlin) statt Zeitpunkt, Ergebnis nur tagesgenau, Tagesgrenzen korrekt", () => {
  const anchor = T("2026-09-12T10:00:00Z"); // 12:00 Berlin
  const range = offenseDayRange(anchor);
  assert.equal(range.start.toISOString(), "2026-09-11T22:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-09-12T22:00:00.000Z");
  const winter = offenseDayRange(T("2026-01-15T11:00:00Z"));
  assert.equal(winter.start.toISOString(), "2026-01-14T23:00:00.000Z");
  // Miete endet am 12.09. um 09:45 Berlin – Tattag 12.09. überschneidet sich
  const ends12 = booking({ bookingId: "e", actualPickupAt: T("2026-09-10T08:30:00Z"), actualReturnAt: T("2026-09-12T07:45:00Z") });
  const r = matchRentals([ends12], anchor, false);
  assert.equal(r.status, "ACTUAL_PERIOD");
  assert.equal(r.dayOnly, true);
  assert.match(r.selected!.explanation, /Uhrzeit unbekannt/);
  // Miete, die erst am 13.09. beginnt, trifft den Tattag 12.09. nicht
  assert.equal(matchRentals([booking({ bookingId: "n", actualPickupAt: T("2026-09-12T22:00:00Z"), actualReturnAt: T("2026-09-15T08:00:00Z") })], anchor, false).status, "NONE");
  // Zwei Mieten am selben Tag (Rückgabe morgens, neue Übergabe nachmittags): mehrdeutig
  const later = booking({ bookingId: "l", actualPickupAt: T("2026-09-12T13:00:00Z"), actualReturnAt: T("2026-09-15T08:00:00Z") });
  const amb = matchRentals([ends12, later], anchor, false);
  assert.equal(amb.status, "AMBIGUOUS");
  assert.equal(amb.candidates.length, 2);
});

test("Fristanzeige: keine Frist, noch X Tage, heute fällig, überfällig – Kalendertage, nie erfunden", () => {
  const now = T("2026-09-23T10:00:00Z");
  assert.deepEqual(deadlineInfo(null, now), { daysLeft: null, level: "NONE", text: "keine Frist hinterlegt" });
  assert.deepEqual(deadlineInfo(T("2026-09-26T10:00:00Z"), now), { daysLeft: 3, level: "SOON", text: "noch 3 Tage" });
  assert.deepEqual(deadlineInfo(T("2026-09-24T10:00:00Z"), now), { daysLeft: 1, level: "SOON", text: "noch 1 Tag" });
  assert.deepEqual(deadlineInfo(T("2026-09-23T22:30:00Z"), now), { daysLeft: 1, level: "SOON", text: "noch 1 Tag" }, "22:30 UTC ist schon der 24. in Berlin");
  assert.deepEqual(deadlineInfo(T("2026-09-23T06:00:00Z"), now), { daysLeft: 0, level: "DUE", text: "heute fällig" });
  assert.deepEqual(deadlineInfo(T("2026-09-21T10:00:00Z"), now), { daysLeft: -2, level: "OVERDUE", text: "seit 2 Tagen überfällig" });
  assert.deepEqual(deadlineInfo(T("2026-09-22T10:00:00Z"), now), { daysLeft: -1, level: "OVERDUE", text: "seit 1 Tag überfällig" });
  assert.equal(deadlineInfo(T("2026-10-30T10:00:00Z"), now).level, "OK");
});

test("Portaladresse: nur vollständige https-Adressen mit Domain werden verlinkt", () => {
  assert.equal(portalUrlInfo("https://portal.bussgeld-bremen.de/anhoerung?id=1").ok, true);
  assert.equal(portalUrlInfo("https://portal.bussgeld-bremen.de/anhoerung?id=1").host, "portal.bussgeld-bremen.de");
  assert.equal(portalUrlInfo("http://portal.example.de").ok, false);
  assert.equal(portalUrlInfo("portal.example.de").ok, false);
  assert.equal(portalUrlInfo("https://localhost").ok, false);
  assert.equal(portalUrlInfo("javascript:alert(1)").ok, false);
  assert.equal(portalUrlInfo(null).ok, false);
});
