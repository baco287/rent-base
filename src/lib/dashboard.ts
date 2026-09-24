// Operatives Dashboard (Phase 19): „Was braucht heute Aufmerksamkeit?“ – ausschließlich aus vorhandenen Zuständen
// abgeleitet, nichts wird gespeichert, nichts automatisch ausgelöst. Alle Geldbeträge kommen aus den zentralen
// Summierungen (financialsFor, balanceOf/computeDepositFinancials, openPayoutClaims), Fälligkeiten aus dueStatus
// (Wartung) und deadlineInfo (Behörden). Kalendertage gelten in der Anwendungszeitzone Europe/Berlin, Intervalle
// sind halboffen [start, end). Gruppen: Überfällig · Heute · Bald · Hinweis – deterministisch, ohne Doppelzählung.

import { db } from "@/lib/db";
import { AUTHORITY_CASE_STATUS, DAMAGE_CASE_STATUS, DOCUMENT_TYPES, type AuthorityCaseStatus, type DamageCaseStatus, type DocumentType } from "@/lib/constants";
import { AUTHORITY_OPEN_STATUS } from "@/lib/authority";
import { deadlineInfo } from "@/lib/authority-matching";
import { financialsFor } from "@/lib/counter-documents";
import { openDepositRows } from "@/lib/deposits";
import { pickupDriverCheckStatus } from "@/lib/driver-verification";
import { customerName, fmtDate, fmtDateTime, fmtTime } from "@/lib/format";
import { maintenanceCounts } from "@/lib/maintenance";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { openPayoutClaims } from "@/lib/payouts";
import { zonedDayRange, zonedDayStartPlus, zonedDaysBetween } from "@/lib/time";

/** Zentrale Bedeutung von „bald“: innerhalb der nächsten 7 Kalendertage (Mieten, Rechnungen, Führerscheine). Behörden- und Wartungsfristen bringen ihre eigene Vorwarnung mit (deadlineInfo, dueStatus). */
export const SOON_DAYS = 7;
/** Reservierungen, deren Abholtermin verstrichen ist, bleiben so viele Tage als Hinweis sichtbar. */
const STALE_PICKUP_DAYS = 30;

export type Horizon = "heute" | "7" | "30";
export const HORIZONS: { key: Horizon; label: string; days: number }[] = [
  { key: "heute", label: "Heute", days: 0 },
  { key: "7", label: "7 Tage", days: 7 },
  { key: "30", label: "30 Tage", days: 30 },
];

export type TaskGroup = "OVERDUE" | "TODAY" | "SOON" | "NOTE";
export const TASK_GROUPS: { key: TaskGroup; label: string; tone: "bad" | "amber" | "info" | "grey" }[] = [
  { key: "OVERDUE", label: "Überfällig", tone: "bad" },
  { key: "TODAY", label: "Heute", tone: "amber" },
  { key: "SOON", label: "Bald", tone: "info" },
  { key: "NOTE", label: "Hinweise", tone: "grey" },
];
export type TaskArea = "RENTAL" | "INVOICE" | "DEPOSIT" | "DAMAGE" | "MAINTENANCE" | "AUTHORITY" | "EMAIL" | "DOCUMENT" | "LICENSE" | "DRIVER_CHECK";
export const TASK_AREAS: Record<TaskArea, string> = { RENTAL: "Miete", INVOICE: "Rechnung", DEPOSIT: "Kaution", DAMAGE: "Schaden", MAINTENANCE: "Wartung", AUTHORITY: "Behörde", EMAIL: "E-Mail", DOCUMENT: "Dokument", LICENSE: "Führerschein", DRIVER_CHECK: "Fahrerprüfung" };

export type DashboardTask = {
  key: string;
  group: TaskGroup;
  area: TaskArea;
  title: string;
  detail: string;
  href: string;
  /** maßgeblicher Zeitpunkt (Sortierung innerhalb der Gruppe) */
  at: Date | null;
  plate: string | null;
  /** Statuswort, damit der Zustand nicht nur über Farbe erkennbar ist */
  status: string;
};

export type DashboardCounts = {
  pickupsToday: number; returnsToday: number; overdueReturns: number; activeRentals: number; pickupsNotRecorded: number;
  openInvoices: number; openInvoiceCents: Cents; overdueInvoices: number; overdueInvoiceCents: Cents; refundsOpen: number; refundsOpenCents: Cents;
  depositsExpected: number; depositsHeld: number; depositPayoutsOpen: number; depositPayoutsOpenCents: Cents;
  damagesOpen: number; damagesUnderReview: number; damagesInRepair: number; damagesLiabilityUnclear: number;
  maintenanceOverdue: number; maintenanceSoon: number; maintenanceAppointmentsToday: number; vehiclesInWorkshop: number;
  authorityReceived: number; authorityAssignment: number; authorityReview: number; authorityReady: number; authorityDueSoon: number; authorityOverdue: number;
  emailsFailed: number; documentsMissing: number; licenses: number;
};

export type DashboardEvent = { kind: "PICKUP" | "RETURN"; at: Date; bookingId: string; bookingNumber: string; customer: string; vehicle: string; plate: string; licenseMissing: boolean };

export type Dashboard = {
  now: Date;
  horizon: Horizon;
  range: { start: Date; end: Date; horizonEnd: Date };
  tasks: DashboardTask[];
  groups: Record<TaskGroup, DashboardTask[]>;
  counts: DashboardCounts;
  events: DashboardEvent[];
};

const cust = { select: { id: true, type: true, firstName: true, lastName: true, companyName: true, licenseNumber: true, licenseValidUntil: true } } as const;
const veh = { select: { id: true, plate: true, make: true, model: true } } as const;
const LIST_CAP = 40;

/** Alle Aufgaben des Mandanten für den Kalendertag von now (Europe/Berlin), optional mit Vorschau auf 7 oder 30 Tage. */
export async function loadDashboard(tenantId: string, opts: { horizon?: Horizon; now?: Date } = {}): Promise<Dashboard> {
  const now = opts.now ?? new Date();
  const horizon: Horizon = HORIZONS.some((h) => h.key === opts.horizon) ? opts.horizon! : "heute";
  const days = HORIZONS.find((h) => h.key === horizon)!.days;
  const { start, end } = zonedDayRange(now);
  const horizonEnd = days > 0 ? zonedDayStartPlus(now, days) : end;
  const soonEnd = zonedDayStartPlus(now, SOON_DAYS);
  const fetchEnd = new Date(Math.max(horizonEnd.getTime(), soonEnd.getTime()));
  const staleStart = zonedDayStartPlus(now, -STALE_PICKUP_DAYS);

  const [bookings, activeRentals, finalInvoices, depositRows, claims, damageCases, maint, authorityCases, failedMails, contractsNoDoc, handoversNoDoc, versionsNoDoc, payoutsNoDoc] = await Promise.all([
    db.booking.findMany({ where: { tenantId, OR: [{ status: "RESERVED", startAt: { gte: staleStart, lt: fetchEnd } }, { status: "ACTIVE", endAt: { lt: fetchEnd } }] }, select: { id: true, number: true, status: true, startAt: true, endAt: true, customer: cust, vehicle: veh }, orderBy: { startAt: "asc" } }),
    db.booking.count({ where: { tenantId, status: "ACTIVE" } }),
    db.invoice.findMany({ where: { tenantId, status: "FINALIZED", documentType: "INVOICE", currentVersionId: { not: null } }, select: { id: true, number: true, kind: true, bookingId: true, booking: { select: { number: true, customer: cust } }, currentVersion: { select: { grossTotal: true, paymentDueDate: true } } } }),
    openDepositRows(tenantId),
    openPayoutClaims(tenantId),
    db.damageCase.findMany({ where: { tenantId, status: { not: "CLOSED" } }, select: { id: true, caseNumber: true, status: true, liabilityStatus: true, description: true, createdAt: true, vehicle: veh }, orderBy: { createdAt: "asc" }, take: 200 }),
    maintenanceCounts(tenantId, now),
    db.authorityCase.findMany({ where: { tenantId, status: { in: AUTHORITY_OPEN_STATUS } }, select: { id: true, caseNumber: true, status: true, authorityName: true, responseDeadline: true, licensePlateSnapshot: true, createdAt: true }, orderBy: [{ responseDeadline: "asc" }, { createdAt: "asc" }], take: 200 }),
    db.emailLog.findMany({ where: { tenantId, status: "FAILED" }, select: { id: true, template: true, recipient: true, error: true, bookingId: true, payoutId: true, createdAt: true, lastAttemptAt: true, booking: { select: { number: true } } }, orderBy: { createdAt: "desc" }, take: LIST_CAP }),
    db.rentalContract.findMany({ where: { tenantId, status: "SIGNED", documents: { none: { type: "RENTAL_CONTRACT" } } }, select: { id: true, number: true, bookingId: true, signedAt: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: LIST_CAP }),
    db.handover.findMany({ where: { tenantId, status: "FINALIZED", correctsId: null, corrections: { none: {} }, documents: { none: {} } }, select: { id: true, number: true, type: true, bookingId: true, finalizedAt: true }, orderBy: { finalizedAt: "desc" }, take: LIST_CAP }),
    db.invoiceVersion.findMany({ where: { tenantId, status: "FINALIZED", documents: { none: {} }, invoice: { status: "FINALIZED" } }, select: { id: true, versionNo: true, invoice: { select: { id: true, number: true, documentType: true, bookingId: true, currentVersionId: true, finalizedAt: true } } }, orderBy: { finalizedAt: "desc" }, take: LIST_CAP * 2 }),
    db.payout.findMany({ where: { tenantId, status: "COMPLETED", documents: { none: { type: "PAYOUT_RECEIPT" } } }, select: { id: true, number: true, completedAt: true, executedAt: true }, orderBy: { completedAt: "desc" }, take: LIST_CAP }),
  ]);

  const tasks: DashboardTask[] = [];
  const events: DashboardEvent[] = [];
  const add = (t: Omit<DashboardTask, "plate" | "at"> & { plate?: string | null; at?: Date | null }) => tasks.push({ ...t, plate: t.plate ?? null, at: t.at ?? null });
  const vehicleText = (v: { make: string; model: string; plate: string }) => `${v.make} ${v.model}`;
  const inRange = (d: Date, a: Date, b: Date) => d.getTime() >= a.getTime() && d.getTime() < b.getTime();
  // Fahrerprüfung (Phase 19.5): nur für heutige Abholungen, eine Abfrage für alle Buchungen
  const todaysPickupIds = bookings.filter((b) => b.status === "RESERVED" && inRange(b.startAt, start, end)).map((b) => b.id);
  const driverChecks = await pickupDriverCheckStatus(tenantId, todaysPickupIds);
  const counts: DashboardCounts = {
    pickupsToday: 0, returnsToday: 0, overdueReturns: 0, activeRentals, pickupsNotRecorded: 0,
    openInvoices: 0, openInvoiceCents: 0, overdueInvoices: 0, overdueInvoiceCents: 0, refundsOpen: 0, refundsOpenCents: 0,
    depositsExpected: 0, depositsHeld: 0, depositPayoutsOpen: 0, depositPayoutsOpenCents: 0,
    damagesOpen: 0, damagesUnderReview: 0, damagesInRepair: 0, damagesLiabilityUnclear: 0,
    maintenanceOverdue: maint.overdue, maintenanceSoon: maint.soon, maintenanceAppointmentsToday: maint.appointmentsToday.length, vehiclesInWorkshop: maint.inWorkshop,
    authorityReceived: 0, authorityAssignment: 0, authorityReview: 0, authorityReady: 0, authorityDueSoon: 0, authorityOverdue: 0,
    emailsFailed: failedMails.length, documentsMissing: 0, licenses: 0,
  };

  // --- Mieten: Abholungen, Rückgaben, Überfälliges; Führerscheinhinweise nur aus vorhandenen Feldern ---
  for (const b of bookings) {
    const name = customerName(b.customer);
    const base = { area: "RENTAL" as const, href: `/buchungen/${b.id}`, plate: b.vehicle.plate };
    if (b.status === "RESERVED") {
      if (b.startAt < start) {
        counts.pickupsNotRecorded++;
        add({ ...base, key: `pickup-stale-${b.id}`, group: "NOTE", title: `Abholung nicht erfasst · ${name}`, detail: `Buchung ${b.number} · ${vehicleText(b.vehicle)} · geplant ${fmtDateTime(b.startAt)}`, at: b.startAt, status: "Reserviert, Termin verstrichen" });
      } else if (inRange(b.startAt, start, end)) {
        counts.pickupsToday++;
        events.push({ kind: "PICKUP", at: b.startAt, bookingId: b.id, bookingNumber: b.number, customer: name, vehicle: vehicleText(b.vehicle), plate: b.vehicle.plate, licenseMissing: !b.customer.licenseNumber });
        add({ ...base, key: `pickup-${b.id}`, group: "TODAY", title: `Abholung ${fmtTime(b.startAt)} · ${name}`, detail: `Buchung ${b.number} · ${vehicleText(b.vehicle)}${b.startAt < now ? " · Abholzeit bereits verstrichen" : ""}`, at: b.startAt, status: "Abholung heute" });
        // Fahrerprüfung: jeder vertragliche Fahrer muss bei der Übergabe identifiziert und seine Fahrerlaubnis geprüft sein
        const dc = driverChecks.get(b.id);
        if (dc && dc.required > 0) {
          const href = dc.handoverId ? `/buchungen/${b.id}/uebergabe?schritt=6` : `/buchungen/${b.id}/uebergabe`;
          if (dc.blocked > 0) add({ area: "DRIVER_CHECK", href, plate: b.vehicle.plate, key: `driver-blocked-${b.id}`, group: "TODAY", title: `Fahrerprüfung blockiert · ${name}`, detail: `Buchung ${b.number} · ${dc.blocked} Fahrer mit offenem Klärungsbedarf`, at: b.startAt, status: "Blockiert" });
          else if (dc.confirmed < dc.required) add({ area: "DRIVER_CHECK", href, plate: b.vehicle.plate, key: `driver-unverified-${b.id}`, group: "TODAY", title: `Fahrer noch nicht vollständig geprüft · ${name}`, detail: `Buchung ${b.number} · ${dc.confirmed} von ${dc.required} bestätigt`, at: b.startAt, status: "Vor Übergabe prüfen" });
          if (dc.manualReviewOpen > 0) add({ area: "DRIVER_CHECK", href, plate: b.vehicle.plate, key: `driver-manual-${b.id}`, group: "TODAY", title: `Manuelle Prüfung erforderlich · ${name}`, detail: `Buchung ${b.number} · ausländischer Führerschein ohne bestätigte Prüfung`, at: b.startAt, status: "Manuell prüfen" });
        }
      } else if (days > 0 && inRange(b.startAt, end, horizonEnd)) {
        add({ ...base, key: `pickup-${b.id}`, group: "SOON", title: `Abholung ${fmtDate(b.startAt)} ${fmtTime(b.startAt)} · ${name}`, detail: `Buchung ${b.number} · ${vehicleText(b.vehicle)}`, at: b.startAt, status: "Abholung bald" });
      }
      // Führerschein: fehlt oder läuft vor der Rückgabe ab – nur für Abholungen innerhalb der nächsten 7 Tage (bzw. des Horizonts)
      if (b.startAt >= start && b.startAt < fetchEnd) {
        if (!b.customer.licenseNumber) {
          counts.licenses++;
          add({ area: "LICENSE", href: `/kunden/${b.customer.id}`, plate: b.vehicle.plate, key: `license-missing-${b.id}`, group: "NOTE", title: `Führerschein fehlt · ${name}`, detail: `Abholung ${fmtDate(b.startAt)} · Buchung ${b.number}`, at: b.startAt, status: "Vor Abholung erfassen" });
        } else if (b.customer.licenseValidUntil && b.customer.licenseValidUntil < b.endAt) {
          counts.licenses++;
          add({ area: "LICENSE", href: `/kunden/${b.customer.id}`, plate: b.vehicle.plate, key: `license-expiring-${b.id}`, group: "NOTE", title: `Führerschein läuft vor Rückgabe ab · ${name}`, detail: `gültig bis ${fmtDate(b.customer.licenseValidUntil)} · Rückgabe ${fmtDate(b.endAt)} · Buchung ${b.number}`, at: b.startAt, status: "Prüfen" });
        }
      }
    } else if (b.status === "ACTIVE") {
      if (b.endAt < now) {
        counts.overdueReturns++;
        const daysLate = zonedDaysBetween(b.endAt, now);
        add({ ...base, key: `return-overdue-${b.id}`, group: "OVERDUE", title: `Rückgabe überfällig · ${name}`, detail: `Buchung ${b.number} · ${vehicleText(b.vehicle)} · sollte ${fmtDate(b.endAt)} um ${fmtTime(b.endAt)} zurück sein${daysLate > 0 ? ` · ${daysLate} ${daysLate === 1 ? "Tag" : "Tage"}` : ""}`, at: b.endAt, status: "Überfällig" });
        if (inRange(b.endAt, start, end)) { counts.returnsToday++; events.push({ kind: "RETURN", at: b.endAt, bookingId: b.id, bookingNumber: b.number, customer: name, vehicle: vehicleText(b.vehicle), plate: b.vehicle.plate, licenseMissing: false }); }
      } else if (inRange(b.endAt, start, end)) {
        counts.returnsToday++;
        events.push({ kind: "RETURN", at: b.endAt, bookingId: b.id, bookingNumber: b.number, customer: name, vehicle: vehicleText(b.vehicle), plate: b.vehicle.plate, licenseMissing: false });
        add({ ...base, key: `return-${b.id}`, group: "TODAY", title: `Rückgabe ${fmtTime(b.endAt)} · ${name}`, detail: `Buchung ${b.number} · ${vehicleText(b.vehicle)}`, at: b.endAt, status: "Rückgabe heute" });
      } else if (days > 0 && inRange(b.endAt, end, horizonEnd)) {
        add({ ...base, key: `return-${b.id}`, group: "SOON", title: `Rückgabe ${fmtDate(b.endAt)} ${fmtTime(b.endAt)} · ${name}`, detail: `Buchung ${b.number} · ${vehicleText(b.vehicle)}`, at: b.endAt, status: "Rückgabe bald" });
      }
      if (b.customer.licenseValidUntil && b.customer.licenseValidUntil < b.endAt && b.customer.licenseValidUntil >= start) {
        counts.licenses++;
        add({ area: "LICENSE", href: `/kunden/${b.customer.id}`, plate: b.vehicle.plate, key: `license-active-${b.id}`, group: "NOTE", title: `Führerschein läuft während der Miete ab · ${name}`, detail: `gültig bis ${fmtDate(b.customer.licenseValidUntil)} · Rückgabe ${fmtDate(b.endAt)} · Buchung ${b.number}`, at: b.customer.licenseValidUntil, status: "Prüfen" });
      }
    }
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  // --- Rechnungen: offen/überfällig nur bei offen > 0 (Guthaben oder gutgeschriebene Belege sind nie überfällig); Erstattungen aus derselben Summierung ---
  const fin = await financialsFor(tenantId, finalInvoices.map((i) => ({ id: i.id, grossTotal: i.currentVersion!.grossTotal })));
  for (const i of finalInvoices) {
    const f = fin.get(i.id)!;
    const name = customerName(i.booking.customer);
    const href = `/buchungen/${i.bookingId}/rechnung?nr=${i.id}`;
    const word = i.kind === "DAMAGE" ? "Schadenabrechnung" : "Rechnung";
    if (f.openCents > 0) {
      counts.openInvoices++; counts.openInvoiceCents += f.openCents;
      const due = i.currentVersion!.paymentDueDate;
      if (due && due < start) {
        counts.overdueInvoices++; counts.overdueInvoiceCents += f.openCents;
        add({ area: "INVOICE", href, key: `invoice-overdue-${i.id}`, group: "OVERDUE", title: `${word} ${i.number} überfällig · ${name}`, detail: `offen ${fmtCents(f.openCents)} · fällig ${fmtDate(due)} · Buchung ${i.booking.number}`, at: due, status: "Überfällig" });
      } else if (due && inRange(due, start, end)) {
        add({ area: "INVOICE", href, key: `invoice-due-${i.id}`, group: "TODAY", title: `${word} ${i.number} heute fällig · ${name}`, detail: `offen ${fmtCents(f.openCents)} · Buchung ${i.booking.number}`, at: due, status: "Heute fällig" });
      } else if (due && days > 0 && inRange(due, end, horizonEnd)) {
        add({ area: "INVOICE", href, key: `invoice-soon-${i.id}`, group: "SOON", title: `${word} ${i.number} fällig ${fmtDate(due)} · ${name}`, detail: `offen ${fmtCents(f.openCents)} · Buchung ${i.booking.number}`, at: due, status: "Bald fällig" });
      }
    }
    if (f.refundOpen) {
      counts.refundsOpen++; counts.refundsOpenCents += f.refundRemainingCents;
      add({ area: "INVOICE", href, key: `refund-${i.id}`, group: "NOTE", title: `Erstattung offen · ${name}`, detail: `${word} ${i.number} · noch auszuzahlen ${fmtCents(f.refundRemainingCents)} (Kundenguthaben)`, at: null, status: "Erstattung offen" });
    }
  }

  // --- Kautionen: Semantik aus Phase 15/18 (balanceOf, openPayoutClaims). Keine Verrechnung, keine Auslösung. ---
  for (const b of depositRows.expectedActive) {
    counts.depositsExpected++;
    add({ area: "DEPOSIT", href: `/buchungen/${b.id}#kaution`, key: `deposit-expected-${b.id}`, group: "NOTE", title: `Kaution noch nicht erhalten · ${customerName(b.customer)}`, detail: `Buchung ${b.number} unterwegs · vereinbart ${fmtCents(toCents(b.contract?.deposit ?? 0))}`, at: b.startAt, status: "Eingang offen" });
  }
  for (const d of depositRows.held) {
    counts.depositsHeld++;
    add({ area: "DEPOSIT", href: `/buchungen/${d.booking.id}#kaution`, key: `deposit-held-${d.id}`, group: "NOTE", title: `Kaution nach Rückgabe noch nicht entschieden · ${customerName(d.booking.customer)}`, detail: `Buchung ${d.booking.number} · ${fmtCents(d.balance.remainingCents)} weder freigegeben noch einbehalten`, at: d.booking.actualReturnAt ?? d.booking.endAt, status: "Entscheidung offen" });
  }
  for (const c of claims.deposits) {
    counts.depositPayoutsOpen++; counts.depositPayoutsOpenCents += c.remainingCents;
    add({ area: "DEPOSIT", href: c.href, key: `deposit-payout-${c.bookingId}`, group: "NOTE", title: `Kautionsauszahlung offen · ${c.customerName}`, detail: `Buchung ${c.bookingNumber} · freigegeben, noch nicht ausgezahlt ${fmtCents(c.remainingCents)}${c.draftCents > 0 ? ` · Entwurf ${fmtCents(c.draftCents)}` : ""}`, at: null, status: "Auszahlung offen" });
  }

  // --- Schäden: offene Akten; ungeklärte Haftung ist ein Prüfhinweis, nie eine Kundenzuweisung ---
  for (const d of damageCases) {
    counts.damagesOpen++;
    const unclear = d.liabilityStatus === "UNASSESSED" || d.liabilityStatus === "UNCLEAR";
    if (d.status === "UNDER_REVIEW") counts.damagesUnderReview++;
    if (d.status === "REPAIR_PLANNED" || d.status === "IN_REPAIR") counts.damagesInRepair++;
    if (unclear) counts.damagesLiabilityUnclear++;
    const label = DAMAGE_CASE_STATUS[d.status as DamageCaseStatus] ?? d.status;
    if (unclear) add({ area: "DAMAGE", href: `/schaeden/${d.id}`, plate: d.vehicle.plate, key: `damage-liability-${d.id}`, group: "NOTE", title: `Haftung ungeklärt · ${d.caseNumber}`, detail: `${d.description} · ${label} · seit ${fmtDate(d.createdAt)}`, at: d.createdAt, status: "Bewertung offen" });
    else if (d.status === "UNDER_REVIEW") add({ area: "DAMAGE", href: `/schaeden/${d.id}`, plate: d.vehicle.plate, key: `damage-review-${d.id}`, group: "NOTE", title: `Schadenakte in Prüfung · ${d.caseNumber}`, detail: `${d.description} · seit ${fmtDate(d.createdAt)}`, at: d.createdAt, status: label });
    else if (d.status === "REPAIR_PLANNED" || d.status === "IN_REPAIR") add({ area: "DAMAGE", href: `/schaeden/${d.id}`, plate: d.vehicle.plate, key: `damage-repair-${d.id}`, group: "NOTE", title: `${label} · ${d.caseNumber}`, detail: d.description, at: d.createdAt, status: label });
  }

  // --- Wartung: Fälligkeiten aus dueStatus (OVERDUE/DUE/SOON), Termine des Tages ---
  for (const d of maint.overdueList) {
    add({ area: "MAINTENANCE", href: `/fahrzeuge/${d.vehicle.id}?tab=faelligkeiten`, plate: d.vehicle.plate, key: `maint-due-${d.id}`, group: d.due.level === "OVERDUE" ? "OVERDUE" : "TODAY", title: `${d.title} · ${d.vehicle.plate}`, detail: `${d.vehicle.make} ${d.vehicle.model} · ${d.due.text}`, at: d.nextDueDate ?? null, status: d.due.label });
  }
  if (days > 0) for (const d of maint.soonList) {
    add({ area: "MAINTENANCE", href: `/fahrzeuge/${d.vehicle.id}?tab=faelligkeiten`, plate: d.vehicle.plate, key: `maint-soon-${d.id}`, group: "SOON", title: `${d.title} bald fällig · ${d.vehicle.plate}`, detail: `${d.vehicle.make} ${d.vehicle.model} · ${d.due.text}`, at: d.nextDueDate ?? null, status: d.due.label });
  }
  for (const r of maint.appointmentsToday) {
    add({ area: "MAINTENANCE", href: `/fahrzeuge/wartung/${r.id}`, plate: r.vehicle.plate, key: `maint-appt-${r.id}`, group: "TODAY", title: `Werkstatttermin ${fmtTime(r.scheduledAt!)} · ${r.title}`, detail: `${r.vehicle.plate} · ${r.vehicle.make} ${r.vehicle.model}${r.workshopName ? ` · ${r.workshopName}` : ""}`, at: r.scheduledAt, status: r.status === "IN_PROGRESS" ? "In Arbeit" : "Termin heute" });
  }
  if (days > 0) {
    const upcoming = await db.maintenanceRecord.findMany({ where: { tenantId, status: { in: ["SCHEDULED", "IN_PROGRESS"] }, scheduledAt: { gte: end, lt: horizonEnd } }, orderBy: { scheduledAt: "asc" }, take: LIST_CAP, select: { id: true, title: true, scheduledAt: true, workshopName: true, vehicle: veh } });
    for (const r of upcoming) add({ area: "MAINTENANCE", href: `/fahrzeuge/wartung/${r.id}`, plate: r.vehicle.plate, key: `maint-appt-${r.id}`, group: "SOON", title: `Werkstatttermin ${fmtDate(r.scheduledAt!)} · ${r.title}`, detail: `${r.vehicle.plate} · ${r.vehicle.make} ${r.vehicle.model}${r.workshopName ? ` · ${r.workshopName}` : ""}`, at: r.scheduledAt, status: "Termin bald" });
  }

  // --- Behörden: nur echte Fristen (responseDeadline) über deadlineInfo; Zustände als Hinweis ---
  for (const c of authorityCases) {
    const label = AUTHORITY_CASE_STATUS[c.status as AuthorityCaseStatus] ?? c.status;
    const dl = deadlineInfo(c.responseDeadline, now);
    const href = `/behoerden/${c.id}`;
    if (c.status === "RECEIVED") counts.authorityReceived++;
    if (c.status === "ASSIGNMENT_REQUIRED") counts.authorityAssignment++;
    if (c.status === "REVIEW_REQUIRED") counts.authorityReview++;
    if (c.status === "READY_TO_SEND") counts.authorityReady++;
    if (dl.level === "OVERDUE") { counts.authorityOverdue++; add({ area: "AUTHORITY", href, plate: c.licensePlateSnapshot, key: `authority-deadline-${c.id}`, group: "OVERDUE", title: `Antwortfrist verstrichen · ${c.caseNumber}`, detail: `${c.authorityName} · ${dl.text} · ${label}`, at: c.responseDeadline, status: "Überfällig" }); }
    else if (dl.level === "DUE") { counts.authorityDueSoon++; add({ area: "AUTHORITY", href, plate: c.licensePlateSnapshot, key: `authority-deadline-${c.id}`, group: "TODAY", title: `Antwortfrist heute · ${c.caseNumber}`, detail: `${c.authorityName} · ${label}`, at: c.responseDeadline, status: "Heute fällig" }); }
    else if (dl.level === "SOON") { counts.authorityDueSoon++; add({ area: "AUTHORITY", href, plate: c.licensePlateSnapshot, key: `authority-deadline-${c.id}`, group: "SOON", title: `Antwortfrist ${fmtDate(c.responseDeadline)} · ${c.caseNumber}`, detail: `${c.authorityName} · ${dl.text} · ${label}`, at: c.responseDeadline, status: "Bald fällig" }); }
    else if (c.status === "ASSIGNMENT_REQUIRED" || c.status === "REVIEW_REQUIRED" || c.status === "READY_TO_SEND" || c.status === "RECEIVED") {
      add({ area: "AUTHORITY", href, plate: c.licensePlateSnapshot, key: `authority-state-${c.id}`, group: "NOTE", title: `${label} · ${c.caseNumber}`, detail: `${c.authorityName}${c.responseDeadline ? ` · Frist ${fmtDate(c.responseDeadline)}` : " · keine Frist hinterlegt"}`, at: c.responseDeadline ?? c.createdAt, status: label });
    }
  }

  // --- E-Mail-Probleme: fehlgeschlagene Versuche; erneut senden geschieht bewusst manuell auf der Buchungs- bzw. Auszahlungsseite ---
  for (const m of failedMails) {
    const href = m.payoutId ? `/auszahlungen/${m.payoutId}` : m.bookingId ? `/buchungen/${m.bookingId}` : "/buchungen";
    add({ area: "EMAIL", href, key: `mail-${m.id}`, group: "NOTE", title: `E-Mail fehlgeschlagen · ${templateLabel(m.template)}`, detail: `${m.booking ? `Buchung ${m.booking.number} · ` : ""}an ${m.recipient}${m.error ? ` · ${m.error.slice(0, 120)}` : ""} · ${fmtDateTime(m.lastAttemptAt ?? m.createdAt)}`, at: m.lastAttemptAt ?? m.createdAt, status: "Fehlgeschlagen" });
  }

  // --- Fehlende Dokumente: nur wo die Architektur ein PDF vorsieht (abgeschlossene Verträge, Protokolle, Belege, Auszahlungen) ---
  for (const c of contractsNoDoc) { counts.documentsMissing++; add({ area: "DOCUMENT", href: `/buchungen/${c.bookingId}`, key: `doc-contract-${c.id}`, group: "NOTE", title: `Mietvertrag-PDF fehlt · ${c.number}`, detail: `abgeschlossen ${fmtDate(c.signedAt ?? c.createdAt)}`, at: c.signedAt ?? c.createdAt, status: "PDF noch nicht erzeugt" }); }
  for (const h of handoversNoDoc) { counts.documentsMissing++; add({ area: "DOCUMENT", href: `/buchungen/${h.bookingId}`, key: `doc-handover-${h.id}`, group: "NOTE", title: `${h.type === "PICKUP" ? "Übergabeprotokoll" : "Rückgabeprotokoll"}-PDF fehlt · ${h.number}`, detail: `finalisiert ${fmtDate(h.finalizedAt)}`, at: h.finalizedAt, status: "PDF noch nicht erzeugt" }); }
  for (const v of versionsNoDoc.filter((x) => x.invoice.currentVersionId === x.id)) { counts.documentsMissing++; const t = (v.invoice.documentType === "CREDIT_NOTE" ? "CREDIT_NOTE" : v.invoice.documentType === "CANCELLATION" ? "CANCELLATION" : "INVOICE") as DocumentType; add({ area: "DOCUMENT", href: `/buchungen/${v.invoice.bookingId}/rechnung?nr=${v.invoice.id}`, key: `doc-invoice-${v.id}`, group: "NOTE", title: `${DOCUMENT_TYPES[t]}-PDF fehlt · ${v.invoice.number ?? ""}`, detail: `Fassung ${v.versionNo} · abgeschlossen ${fmtDate(v.invoice.finalizedAt)}`, at: v.invoice.finalizedAt, status: "PDF noch nicht erzeugt" }); }
  for (const p of payoutsNoDoc) { counts.documentsMissing++; add({ area: "DOCUMENT", href: `/auszahlungen/${p.id}`, key: `doc-payout-${p.id}`, group: "NOTE", title: `Auszahlungsbeleg-PDF fehlt · ${p.number ?? ""}`, detail: `erfasst ${fmtDate(p.completedAt ?? p.executedAt)}`, at: p.completedAt ?? p.executedAt, status: "PDF noch nicht erzeugt" }); }

  // Sortierung: innerhalb der Gruppe nach Zeitpunkt (ältester/dringendster zuerst), ohne Zeitpunkt zuletzt, dann Bereich und Titel
  const areaOrder: TaskArea[] = ["RENTAL", "AUTHORITY", "INVOICE", "DEPOSIT", "MAINTENANCE", "DAMAGE", "LICENSE", "EMAIL", "DOCUMENT"];
  tasks.sort((a, b) => (a.at && b.at ? a.at.getTime() - b.at.getTime() : a.at ? -1 : b.at ? 1 : 0) || areaOrder.indexOf(a.area) - areaOrder.indexOf(b.area) || a.title.localeCompare(b.title, "de"));
  const groups: Record<TaskGroup, DashboardTask[]> = { OVERDUE: [], TODAY: [], SOON: [], NOTE: [] };
  for (const t of tasks) groups[t.group].push(t);
  return { now, horizon, range: { start, end, horizonEnd }, tasks, groups, counts, events };
}

const TEMPLATE_LABELS: Record<string, string> = { PICKUP_DOCUMENTS: "Unterlagen nach Übergabe", RETURN_DOCUMENTS: "Unterlagen nach Rückgabe", INVOICE: "Rechnung", INVOICE_CORRECTION: "Rechnungsberichtigung", CREDIT_NOTE: "Gutschrift", CANCELLATION: "Stornobeleg", PAYOUT_RECEIPT: "Auszahlungsbeleg" };
/** Lesbare Bezeichnung einer Versandvorlage (Fallback: technischer Name). */
export function templateLabel(template: string): string {
  return TEMPLATE_LABELS[template] ?? template;
}
