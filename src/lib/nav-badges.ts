// Vermieter-Oberfläche (Vorschlag 4): Zähler an den Menüpunkten der Seitenleiste. Jede Zahl nutzt dieselbe Ableitung wie
// die jeweilige Übersicht (Schäden: Filter „Offen“, Forderungen: „Überfällig“, Wartung/Behörden: deren Kennzahlen), damit
// Menü und Seite nie verschiedene Zahlen zeigen. Ein Fehler beim Zählen darf die Navigation nie verhindern – dann fehlt
// nur der Zähler. Gesperrte Module (Control Center) werden gar nicht erst gezählt.
import { db } from "@/lib/db";
import { zonedDayRange, zonedDayStartPlus } from "@/lib/time";
import { fleetDues } from "@/lib/maintenance";
import { receivablesSummary } from "@/lib/dunning";
import { AUTHORITY_OPEN_STATUS } from "@/lib/authority";

export type NavBadgeTone = "info" | "warn" | "bad";
export type NavBadge = { count: number; tone: NavBadgeTone; title: string };
export type NavBadges = Partial<Record<string, NavBadge>>;

const AUTHORITY_OPEN = AUTHORITY_OPEN_STATUS;

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function navBadges(tenantId: string, hiddenPaths: readonly string[] = [], now = new Date()): Promise<NavBadges> {
  const hidden = new Set(hiddenPaths);
  const { start, end } = zonedDayRange(now);
  const in4 = zonedDayStartPlus(now, 4);
  const badges: NavBadges = {};

  const [today, damages, maintenance, receivables, authorities] = await Promise.all([
    safe(async () => {
      const [pickups, returnsToday, overdue] = await Promise.all([
        db.booking.count({ where: { tenantId, status: "RESERVED", startAt: { gte: start, lt: end } } }),
        db.booking.count({ where: { tenantId, status: "ACTIVE", endAt: { gte: now, lt: end } } }),
        // kontaktlos gemeldete Rückgaben gelten nicht als überfällig (wie im Dashboard)
        db.booking.count({ where: { tenantId, status: "ACTIVE", endAt: { lt: now }, keyDropReturns: { none: { status: "CUSTOMER_CONFIRMED" } } } }),
      ]);
      return { pickups, returnsToday, overdue };
    }),
    hidden.has("/schaeden") ? null : safe(async () => {
      const [open, liability] = await Promise.all([
        db.damageCase.count({ where: { tenantId, status: { not: "CLOSED" } } }),
        db.damageCase.count({ where: { tenantId, status: { not: "CLOSED" }, liabilityStatus: { in: ["UNASSESSED", "UNCLEAR"] } } }),
      ]);
      return { open, liability };
    }),
    hidden.has("/fahrzeuge/wartung") ? null : safe(async () => {
      const dues = await fleetDues(tenantId, now);
      return { overdue: dues.filter((d) => d.due.level === "OVERDUE").length, due: dues.filter((d) => d.due.level === "DUE").length };
    }),
    hidden.has("/forderungen") ? null : safe(() => receivablesSummary(tenantId, now)),
    hidden.has("/behoerden") ? null : safe(async () => {
      const [overdue, dueSoon, incoming] = await Promise.all([
        db.authorityCase.count({ where: { tenantId, status: { in: AUTHORITY_OPEN }, responseDeadline: { lt: start } } }),
        db.authorityCase.count({ where: { tenantId, status: { in: AUTHORITY_OPEN }, responseDeadline: { gte: start, lt: in4 } } }),
        db.authorityCase.count({ where: { tenantId, status: { in: ["RECEIVED", "ASSIGNMENT_REQUIRED"] } } }),
      ]);
      return { overdue, dueSoon, incoming };
    }),
  ]);

  if (today) {
    const n = today.pickups + today.returnsToday + today.overdue;
    if (n > 0) badges["/heute"] = { count: n, tone: today.overdue > 0 ? "bad" : "warn", title: [plural(today.pickups, "Abholung", "Abholungen") + " heute", plural(today.returnsToday, "Rückgabe", "Rückgaben") + " heute", today.overdue ? plural(today.overdue, "Rückgabe überfällig", "Rückgaben überfällig") : null].filter(Boolean).join(" · ") };
  }
  if (damages && damages.open > 0) badges["/schaeden"] = { count: damages.open, tone: damages.liability > 0 ? "bad" : "warn", title: `${plural(damages.open, "offene Schadenakte", "offene Schadenakten")}${damages.liability ? ` · ${damages.liability} mit ungeklärter Haftung` : ""}` };
  if (maintenance && maintenance.overdue + maintenance.due > 0) badges["/fahrzeuge/wartung"] = { count: maintenance.overdue + maintenance.due, tone: maintenance.overdue > 0 ? "bad" : "warn", title: `${maintenance.overdue} überfällig · ${maintenance.due} fällig` };
  if (receivables && receivables.overdue > 0) badges["/forderungen"] = { count: receivables.overdue, tone: "bad", title: `${plural(receivables.overdue, "überfällige Forderung", "überfällige Forderungen")}` };
  if (authorities) {
    const n = authorities.overdue + authorities.dueSoon + authorities.incoming;
    if (n > 0) badges["/behoerden"] = { count: n, tone: authorities.overdue > 0 ? "bad" : "warn", title: [authorities.overdue ? `${authorities.overdue} Frist überschritten` : null, authorities.dueSoon ? `${authorities.dueSoon} Frist in 3 Tagen` : null, authorities.incoming ? `${authorities.incoming} neu/zuzuordnen` : null].filter(Boolean).join(" · ") };
  }
  return badges;
}
