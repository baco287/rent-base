// Vermieter-Oberfläche (Vorschlag 4): Ableitung „Nächster Schritt“ je Schadenakte (rein) und Zähler der Seitenleiste
// gegen die Datenbank – gleiche Zahlen wie die jeweilige Übersicht, gesperrte Module ohne Zähler, Mandanten getrennt.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { mostUrgentCase, nextCaseStep, type NextStepInput } from "../src/lib/damage-next-step";
import { navBadges } from "../src/lib/nav-badges";
import { caseCounts, openDamageCase, setLiability } from "../src/lib/damage-cases";
import { reportDamage } from "../src/lib/damages";
import { zonedDayRange } from "../src/lib/time";
import { createWorld, purgeTenants } from "./helpers";

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

const base = (over: Partial<NextStepInput> = {}): NextStepInput => ({
  id: "c1", caseNumber: "SCH-2026-000001", status: "OPEN", liabilityStatus: "UNASSESSED", reportedAt: new Date("2026-09-20T10:00:00Z"),
  estimatedCostCents: null, actualCostCents: null, customerChargeCents: null,
  vehicle: { plate: "HB BM 90", status: "AVAILABLE" }, damage: { description: "Brandloch" }, invoice: null, payment: null, ...over,
});

test("Nächster Schritt: Haftung zuerst, dann Belastung, Abrechnung, Zahlung, Freigabe, Abschluss; geschlossen = nichts", () => {
  assert.equal(nextCaseStep(base({ status: "CLOSED" })), null);
  assert.deepEqual(nextCaseStep(base()), { rank: 1, action: "Haftung bewerten", waitingFor: "die Haftungsentscheidung", href: "/schaeden/c1#haftung" });
  assert.equal(nextCaseStep(base({ liabilityStatus: "UNCLEAR", status: "REPAIRED" }))!.action, "Haftung bewerten", "Haftung schlägt jeden anderen Schritt");
  const customer = { liabilityStatus: "CUSTOMER_RESPONSIBILITY_CONFIRMED" };
  assert.equal(nextCaseStep(base(customer))!.action, "Kunde belasten");
  assert.equal(nextCaseStep(base({ ...customer, customerChargeCents: 14000, invoice: { status: "DRAFT" } }))!.action, "Abrechnung abschließen");
  assert.equal(nextCaseStep(base({ ...customer, customerChargeCents: 14000, invoice: { status: "FINALIZED" }, payment: { status: "OPEN" } }))!.action, "Zahlung prüfen");
  assert.equal(nextCaseStep(base({ ...customer, customerChargeCents: 14000, invoice: { status: "FINALIZED" }, payment: { status: "PARTIAL" } }))!.action, "Zahlung prüfen");
  const paid = { ...customer, customerChargeCents: 14000, invoice: { status: "FINALIZED" }, payment: { status: "PAID" } };
  assert.equal(nextCaseStep(base({ ...paid, status: "REPAIRED", vehicle: { plate: "X", status: "BLOCKED" } }))!.action, "Fahrzeug freigeben");
  assert.deepEqual(nextCaseStep(base({ ...paid, status: "REPAIRED" }))!.href, "/schaeden/c1#abschluss");
  assert.equal(nextCaseStep(base({ liabilityStatus: "INTERNAL", status: "UNDER_REVIEW" }))!.action, "Kosten erfassen");
  assert.equal(nextCaseStep(base({ liabilityStatus: "INTERNAL", status: "UNDER_REVIEW", estimatedCostCents: 5000 }))!.rank, 8, "nur noch prüfen, keine Entscheidung offen");
  assert.equal(nextCaseStep(base({ liabilityStatus: "THIRD_PARTY", status: "IN_REPAIR", estimatedCostCents: 5000 }))!.action, "Reparatur verfolgen");
});

test("Dringendste Akte: niedrigster Rang, bei Gleichstand die älteste; reine Weiterverfolgung zählt nicht", () => {
  const old = base({ id: "alt", caseNumber: "SCH-1", reportedAt: new Date("2026-09-01") });
  const young = base({ id: "neu", caseNumber: "SCH-2", reportedAt: new Date("2026-09-25") });
  const charge = base({ id: "bel", liabilityStatus: "CUSTOMER_RESPONSIBILITY_CONFIRMED", reportedAt: new Date("2026-08-01") });
  assert.equal(mostUrgentCase([young, charge, old])!.item.id, "alt");
  assert.equal(mostUrgentCase([charge])!.step.action, "Kunde belasten");
  assert.equal(mostUrgentCase([base({ liabilityStatus: "THIRD_PARTY", status: "IN_REPAIR", estimatedCostCents: 1 })]), null);
  assert.equal(mostUrgentCase([]), null);
});

test("Menü-Zähler: Heute, Schäden (= Filter „Offen“), gesperrte Module ohne Zähler, Mandanten getrennt", async () => {
  const w = await createWorld("nav-badges", { startInDays: 0 });
  const other = await createWorld("nav-badges-other");
  tenants.push(w.tenantId, other.tenantId);
  const now = new Date();
  const { start } = zonedDayRange(now);
  // Abholung heute (createWorld setzt den Start auf „jetzt + 0 Tage“) und eine überfällige Rückgabe
  await db.booking.update({ where: { id: w.bookingId }, data: { startAt: new Date(Math.max(start.getTime() + 60_000, now.getTime() + 60_000)) } });
  const late = await db.booking.create({ data: { tenantId: w.tenantId, number: `NB-${Date.now()}`, vehicleId: w.vehicleId, customerId: w.customerId, startAt: new Date(now.getTime() - 5 * 86_400_000), endAt: new Date(now.getTime() - 3_600_000), status: "ACTIVE", dailyRate: 89, deposit: 0 } });
  let badges = await navBadges(w.tenantId, [], now);
  assert.equal(badges["/heute"]?.count, 2, JSON.stringify(badges["/heute"]));
  assert.equal(badges["/heute"]?.tone, "bad", "überfällige Rückgabe = dringend");
  assert.match(badges["/heute"]!.title, /1 Rückgabe überfällig/);
  assert.equal(badges["/schaeden"], undefined, "ohne offene Akte kein Zähler");

  // Zwei Schadenakten, eine davon mit bestätigter Haftung
  const d1 = await reportDamage(w.tenantId, w.actor, { vehicleId: w.vehicleId, view: "FRONT", posX: 0.2, posY: 0.3, kind: "SCRATCH", description: "Kratzer vorne" });
  const d2 = await reportDamage(w.tenantId, w.actor, { vehicleId: w.vehicleId, view: "REAR", posX: 0.5, posY: 0.5, kind: "DENT", description: "Delle hinten" });
  await openDamageCase(w.tenantId, d1.id, w.actor);
  const { damageCase: c2 } = await openDamageCase(w.tenantId, d2.id, w.actor);
  await setLiability(w.tenantId, c2.id, w.actor, "INTERNAL", "eigener Betrieb");
  badges = await navBadges(w.tenantId, [], now);
  const counts = await caseCounts(w.tenantId);
  assert.equal(badges["/schaeden"]?.count, counts.open, "gleiche Zahl wie die Schadenübersicht");
  assert.equal(badges["/schaeden"]?.count, 2);
  assert.equal(badges["/schaeden"]?.tone, "bad", "eine Akte mit ungeklärter Haftung");
  assert.match(badges["/schaeden"]!.title, /1 mit ungeklärter Haftung/);

  // Gesperrtes Modul (Control Center): kein Zähler, keine Abfrage
  const gated = await navBadges(w.tenantId, ["/schaeden", "/behoerden", "/forderungen", "/fahrzeuge/wartung"], now);
  assert.equal(gated["/schaeden"], undefined);
  assert.ok(gated["/heute"], "Heute bleibt immer");

  // Anderer Mandant sieht nichts davon
  const foreign = await navBadges(other.tenantId, [], now);
  assert.equal(foreign["/schaeden"], undefined);
  assert.equal(foreign["/heute"], undefined);
  await db.booking.delete({ where: { id: late.id } }).catch(() => {});
});
