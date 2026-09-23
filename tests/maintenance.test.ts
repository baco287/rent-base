// Flotten- und Wartungsmanagement (Phase 13): Pläne und Fälligkeiten, Vorgänge mit Nummer, Termin, Kosten, Dokumente,
// Abschluss mit nächster Fälligkeit, Kilometerregel, Fahrzeug sperren/freigeben über den zentralen Status, Verknüpfung
// mit Schadenakte ohne automatische Kosten-/Forderungsübernahme, Dokumentreferenz ohne Dateikopie, Mandantentrennung,
// Wettläufe und unveränderter Kernprozess.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { assertVehicleBookable } from "../src/lib/bookings";
import { openDamageCase } from "../src/lib/damage-cases";
import { DomainError, sha256 } from "../src/lib/integrity";
import { adoptCostsIntoDamageCase, archiveVehicleDocument, blockVehicleForMaintenance, cancelMaintenance, changeMaintenanceStatus, completeMaintenance, createMaintenance, createPlan, documentMileage, fleetDues, linkDamageCase, linkDamageDocument, listMaintenance, maintenanceCounts, maintenanceView, registerVehicleDocument, releaseVehicleAfterMaintenance, setMaintenanceCosts, setPlanActive, updateMaintenance, updatePlan, vehicleMaintenanceOverview } from "../src/lib/maintenance";
import { buildStorageKey } from "../src/lib/storage";
import { createWorld, purgeTenants, type World } from "./helpers";
import { returnedWorld } from "./rental-flow";

const tenants: string[] = [];
after(async () => { await purgeTenants(tenants); await db.$disconnect(); });

async function world(label: string): Promise<World> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  return w;
}
const day = (n: number) => new Date(Date.now() + n * 86_400_000);

async function snapshotCore(tenantId: string) {
  const [contracts, handovers, damages, cases, invoices] = await Promise.all([
    db.rentalContract.findMany({ where: { tenantId }, select: { id: true, contentHash: true, status: true } }),
    db.handover.findMany({ where: { tenantId }, select: { id: true, contentHash: true, status: true } }),
    db.damage.findMany({ where: { tenantId }, select: { id: true, status: true, description: true } }),
    db.damageCase.findMany({ where: { tenantId }, select: { id: true, liabilityStatus: true, customerChargeCents: true, actualCostCents: true, status: true } }),
    db.invoice.findMany({ where: { tenantId }, select: { id: true, status: true } }),
  ]);
  return JSON.stringify({ contracts, handovers, damages, cases, invoices });
}

// ---------------------------------------------------------------------------
// Pläne und Fälligkeiten
// ---------------------------------------------------------------------------

test("Wartungsplan: Datum-, Kilometer- und kombinierte Fälligkeit, HU-Plan synchronisiert das HU-Datum, deaktivierter Plan warnt nicht", async () => {
  const w = await world("maint-plan");
  await assert.rejects(() => createPlan(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "INSPECTION" }), /mindestens ein nächstes Fälligkeitsdatum/);
  const byDate = await createPlan(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "OIL_SERVICE", intervalMonths: "12", nextDueDate: day(20) });
  const byKm = await createPlan(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "INSPECTION", intervalKilometers: "20000", nextDueMileage: "50800" });
  const both = await createPlan(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "BRAKES", nextDueDate: day(400), nextDueMileage: "120000" });
  const hu = await createPlan(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "HU_AU", nextDueDate: day(-3), warningDaysBefore: 60 });
  assert.equal(byDate.title, "Ölservice");
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).huDate?.toDateString(), hu.nextDueDate?.toDateString(), "HU-Plan setzt das HU-Datum am Fahrzeug");
  const o = await vehicleMaintenanceOverview(w.tenantId, w.vehicleId);
  const lvl = (id: string) => o.plans.find((p) => p.id === id)!.due;
  assert.equal(lvl(byDate.id).level, "SOON");
  assert.equal(lvl(byDate.id).text, "in 20 Tagen");
  assert.equal(lvl(byKm.id).level, "SOON", "50.000 km Fahrzeug, fällig bei 50.800 → noch 800 km");
  assert.equal(lvl(byKm.id).text, "noch 800 km");
  assert.equal(lvl(both.id).level, "OK");
  assert.equal(lvl(hu.id).level, "OVERDUE");
  assert.equal(o.plans[0].id, hu.id, "überfällig zuerst sortiert");
  assert.equal(o.hu.due?.level, "OVERDUE");
  // Flottenweite Fälligkeiten und Kennzahlen
  const dues = await fleetDues(w.tenantId);
  assert.equal(dues.length, 4);
  const counts = await maintenanceCounts(w.tenantId);
  assert.equal(counts.overdue, 1);
  assert.equal(counts.soon, 2);
  // Deaktivierter Plan erzeugt keine Warnung; HU-Datum am Fahrzeug wird geleert
  await setPlanActive(w.tenantId, hu.id, w.actor, false);
  assert.equal((await maintenanceCounts(w.tenantId)).overdue, 0);
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).huDate, null);
  await updatePlan(w.tenantId, hu.id, w.actor, { type: "HU_AU", nextDueDate: day(300), isActive: true });
  assert.equal((await maintenanceCounts(w.tenantId)).overdue, 0);
  assert.ok((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).huDate);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: { in: ["MAINTENANCE_PLAN_CREATED", "MAINTENANCE_PLAN_UPDATED"] } } }), 6);
});

// ---------------------------------------------------------------------------
// Vorgang: Anlage, Termin, Kosten, Dokumente, Abschluss, Kilometer
// ---------------------------------------------------------------------------

test("Wartungsvorgang: Nummer WA-JJJJ-NNNNNN, Termin mit Überschneidungswarnung, Kosten ohne Rechnung, Beleg, Abschluss mit nächster Fälligkeit, Kilometer nie zurück", async () => {
  const w = await world("maint-record");
  const before = await snapshotCore(w.tenantId);
  const plan = await createPlan(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "INSPECTION", intervalMonths: "12", intervalKilometers: "20000", nextDueDate: day(10), nextDueMileage: "52000" });
  const booking = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  // Termin liegt in der Buchung (Tag 1 bis 7) → nur Warnung, keine Blockade
  const res = await createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "INSPECTION", title: "Inspektion 50.000 km", planId: plan.id, workshopName: "Autohaus Muster GmbH", scheduledAt: new Date(booking.startAt.getTime() + 86_400_000), scheduledEndAt: new Date(booking.startAt.getTime() + 86_400_000 * 1.3), estimatedCostCents: "700,00" });
  const r = res.record;
  assert.match(r.maintenanceNumber, /^WA-\d{4}-\d{6}$/);
  assert.equal(r.status, "SCHEDULED");
  assert.equal(r.estimatedCostCents, 70_000);
  assert.deepEqual(res.overlaps.map((b) => b.number), [booking.number], "Überschneidung mit Buchung gemeldet");
  assert.equal(res.blocked, false);
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).status, "AVAILABLE", "Termin sperrt nicht");
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "RESERVED", "Buchung unverändert");
  await assert.rejects(() => createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "REPAIR", title: "Reparatur", scheduledAt: day(2), scheduledEndAt: day(1) }), /Terminende/);
  await assert.rejects(() => createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "REPAIR", title: "Reparatur", estimatedCostCents: "-5" }), /negativ/);
  // Kosten und Kilometer
  await setMaintenanceCosts(w.tenantId, r.id, w.actor, { actual: "684,32" });
  const lower = await documentMileage(w.tenantId, r.id, w.actor, "49900");
  assert.equal(lower.record.mileageAtService, 49_900);
  assert.ok(lower.warnings.some((x) => /nicht reduziert/.test(x)));
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).mileage, 50_000, "niedrigerer Servicestand reduziert den Fahrzeugstand nicht");
  assert.equal(await db.vehicleEvent.count({ where: { tenantId: w.tenantId, type: "MILEAGE" } }), 0);
  // Beleg
  const key = buildStorageKey({ tenantId: w.tenantId, area: "documents", contentType: "application/pdf" });
  const doc = await registerVehicleDocument(w.tenantId, w.actor, { vehicleId: w.vehicleId, maintenanceId: r.id, type: "WORKSHOP_INVOICE", fileName: "Werkstattrechnung.pdf", storageKey: key, contentType: "application/pdf", sizeBytes: 1200, checksum: sha256(key) });
  await assert.rejects(() => db.vehicleDocument.delete({ where: { id: doc.id } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.vehicleDocument.update({ where: { id: doc.id }, data: { storageKey: "t/x/other" } }), /RB_IMMUTABLE/);
  // Status: In Arbeit, dann Abschluss mit höherem Kilometerstand und Vorschlag aus dem Plan
  await changeMaintenanceStatus(w.tenantId, r.id, w.actor, "IN_PROGRESS");
  const view = await maintenanceView(w.tenantId, r.id);
  assert.equal(view.proposal?.nextDueMileage, 49_900 + 20_000);
  const done = await completeMaintenance(w.tenantId, r.id, w.actor, { completedAt: new Date(), mileage: "50250", actualCost: "684,32", workDone: "Inspektion nach Herstellervorgabe", setNextDue: true, nextDueDate: day(365), nextDueMileage: "70250" });
  assert.equal(done.record.status, "COMPLETED");
  assert.equal(done.record.actualCostCents, 68_432);
  assert.equal(done.record.mileageAtService, 50_250);
  assert.equal(done.plan?.nextDueMileage, 70_250);
  assert.equal(done.plan?.lastMaintenanceId, r.id);
  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } });
  assert.equal(vehicle.mileage, 50_250, "höherer Servicestand schreibt das Fahrzeug fort");
  assert.equal(vehicle.status, "AVAILABLE");
  const events = await db.vehicleEvent.findMany({ where: { tenantId: w.tenantId }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(events.map((e) => e.type), ["MILEAGE", "MAINTENANCE_COMPLETED"]);
  // Abgeschlossen: Kosten/Status fest, Notiz erlaubt
  await assert.rejects(() => setMaintenanceCosts(w.tenantId, r.id, w.actor, { actual: "1" }), /erledigt/);
  await assert.rejects(() => db.maintenanceRecord.update({ where: { id: r.id }, data: { actualCostCents: 1 } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.maintenanceRecord.delete({ where: { id: r.id } }), /RB_IMMUTABLE/);
  await updateMaintenance(w.tenantId, r.id, w.actor, { internalNote: "Rechnung geprüft" });
  await assert.rejects(() => archiveVehicleDocument(w.tenantId, doc.id, w.actor, "falsch hochgeladen", { allowCompleted: false }), /nur der Inhaber/);
  const archived = await archiveVehicleDocument(w.tenantId, doc.id, w.actor, "Doppelt hochgeladen", { allowCompleted: true });
  assert.ok(archived.archivedAt);
  // Kostenhistorie und Fahrzeugakte
  const o = await vehicleMaintenanceOverview(w.tenantId, w.vehicleId);
  assert.equal(o.costs[0].total, 68_432);
  assert.equal(o.costs[0].byType[0].type, "INSPECTION");
  assert.equal(o.documents.filter((d) => !d.archivedAt).length, 0);
  assert.equal(o.documents.length, 1);
  assert.equal(o.plans[0].due.level, "OK");
  assert.equal(o.plans[0].lastMaintenance?.maintenanceNumber, r.maintenanceNumber);
  // Keine Rechnung, Zahlung, Kaution, keine Änderung am Kernprozess
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await db.payment.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await snapshotCore(w.tenantId), before);
  const audits = (await db.auditLog.findMany({ where: { tenantId: w.tenantId } })).map((a) => a.action);
  for (const a of ["MAINTENANCE_CREATED", "MAINTENANCE_SCHEDULED", "MAINTENANCE_STARTED", "MAINTENANCE_COST_CHANGED", "MAINTENANCE_DOCUMENT_ADDED", "MAINTENANCE_COMPLETED", "VEHICLE_DOCUMENT_ARCHIVED"]) assert.ok(audits.includes(a), a);
  assert.equal((await listMaintenance(w.tenantId, { filter: "erledigt" })).total, 1);
  assert.equal((await listMaintenance(w.tenantId, { filter: "alle", q: "Muster" })).total, 1);
  assert.equal((await listMaintenance(w.tenantId, { filter: "alle", q: "gibt-es-nicht" })).total, 0);
});

test("Abschluss ohne nächste Fälligkeit hinterlässt einen Hinweis; Abbruch nur mit Grund; Statusübergänge zentral", async () => {
  const w = await world("maint-status");
  const plan = await createPlan(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "OIL_SERVICE", intervalMonths: "12", nextDueDate: day(5) });
  const { record: r } = await createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "OIL_SERVICE", title: "Ölservice", planId: plan.id });
  assert.equal(r.status, "PLANNED");
  await assert.rejects(() => changeMaintenanceStatus(w.tenantId, r.id, w.actor, "SCHEDULED"), /Werkstatttermin/);
  await assert.rejects(() => changeMaintenanceStatus(w.tenantId, r.id, w.actor, "COMPLETED"), /Ungültiger Zielstatus/);
  const done = await completeMaintenance(w.tenantId, r.id, w.actor, { completedAt: new Date(), setNextDue: false });
  assert.ok(done.warnings.some((x) => /nächste Fälligkeit/.test(x)));
  assert.equal((await db.maintenancePlan.findUniqueOrThrow({ where: { id: plan.id } })).nextDueDate?.getTime(), plan.nextDueDate?.getTime(), "Plan unverändert, wenn keine Fälligkeit gesetzt wird");
  const { record: r2 } = await createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "REPAIR", title: "Klappergeräusch" });
  await assert.rejects(() => cancelMaintenance(w.tenantId, r2.id, w.actor, ""), /Grund/);
  const cancelled = await cancelMaintenance(w.tenantId, r2.id, w.actor, "Doppelt angelegt");
  assert.equal(cancelled.status, "CANCELLED");
  await assert.rejects(() => completeMaintenance(w.tenantId, r2.id, w.actor, { completedAt: new Date() }), /abgebrochen/);
  await assert.rejects(() => db.maintenanceRecord.create({ data: { tenantId: w.tenantId, vehicleId: w.vehicleId, maintenanceNumber: "WA-2026-999999", type: "REPAIR", title: "x", status: "COMPLETED" } }), /rb_maintenance_completed|check constraint/i);
});

// ---------------------------------------------------------------------------
// Fahrzeug sperren / freigeben
// ---------------------------------------------------------------------------

test("Fahrzeug für Wartung sperren: Status Werkstatt, nicht buchbar, Buchungen bleiben (Warnung); Abschluss gibt nicht frei; Freigabe ausdrücklich", async () => {
  const w = await world("maint-block");
  const res = await createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "BRAKES", title: "Bremsen vorne", blockVehicle: true });
  assert.equal(res.blocked, true);
  assert.equal(res.futureBookings.length, 1, "künftige Buchung wird gemeldet");
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).status, "WORKSHOP");
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "RESERVED", "nichts storniert");
  const s0 = day(30);
  await assert.rejects(() => db.$transaction((tx) => assertVehicleBookable(tx, w.tenantId, w.vehicleId, s0, day(31))), DomainError);
  await assert.rejects(() => blockVehicleForMaintenance(w.tenantId, res.record.id, w.actor), /bereits/);
  await completeMaintenance(w.tenantId, res.record.id, w.actor, { completedAt: new Date(), actualCost: "520" });
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).status, "WORKSHOP", "Erledigt gibt nicht automatisch frei");
  await releaseVehicleAfterMaintenance(w.tenantId, res.record.id, w.actor, "Werkstatt fertig");
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).status, "AVAILABLE");
  await assert.rejects(() => releaseVehicleAfterMaintenance(w.tenantId, res.record.id, w.actor), /nicht für die Werkstatt gesperrt/);
  const audits = (await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["VEHICLE_BLOCKED_FOR_MAINTENANCE", "VEHICLE_RELEASED_AFTER_MAINTENANCE"] } } })).map((a) => a.action).sort();
  assert.deepEqual(audits, ["VEHICLE_BLOCKED_FOR_MAINTENANCE", "VEHICLE_RELEASED_AFTER_MAINTENANCE"]);
  // Wegen Schaden gesperrt (BLOCKED) → Wartungssperre wird abgelehnt statt still überschrieben
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { status: "BLOCKED" } });
  const { record: r2 } = await createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "REPAIR", title: "Reparatur" });
  await assert.rejects(() => blockVehicleForMaintenance(w.tenantId, r2.id, w.actor), /wegen eines Schadens/);
});

test("Wettläufe: gleichzeitige Anlage, gleichzeitiger Abschluss, Sperren/Freigeben, Abschluss + Kosten, Kilometer aus Rückgabe und Wartung", async () => {
  const w = await world("maint-race");
  const created = await Promise.all(Array.from({ length: 5 }, (_, i) => createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "OTHER", title: `Parallel ${i}` })));
  const numbers = created.map((c) => c.record.maintenanceNumber);
  assert.equal(new Set(numbers).size, 5, "fünf verschiedene Nummern");
  const r = created[0].record;
  const results = await Promise.allSettled([1, 2, 3].map(() => completeMaintenance(w.tenantId, r.id, w.actor, { completedAt: new Date(), mileage: "50100" })));
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1, "genau ein Abschluss");
  assert.equal(await db.vehicleEvent.count({ where: { tenantId: w.tenantId, type: "MAINTENANCE_COMPLETED" } }), 1);
  const r2 = created[1].record;
  const mixed = await Promise.allSettled([completeMaintenance(w.tenantId, r2.id, w.actor, { completedAt: new Date() }), setMaintenanceCosts(w.tenantId, r2.id, w.actor, { actual: "10" })]);
  const row = await db.maintenanceRecord.findUniqueOrThrow({ where: { id: r2.id } });
  assert.equal(row.status, "COMPLETED");
  assert.ok(mixed.some((x) => x.status === "fulfilled"));
  const r3 = created[2].record;
  const blocks = await Promise.allSettled([1, 2, 3].map(() => blockVehicleForMaintenance(w.tenantId, r3.id, w.actor)));
  assert.equal(blocks.filter((x) => x.status === "fulfilled").length, 1);
  const releases = await Promise.allSettled([1, 2, 3].map(() => releaseVehicleAfterMaintenance(w.tenantId, r3.id, w.actor)));
  assert.equal(releases.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).status, "AVAILABLE");
  // Kilometer: Wartung dokumentiert 50.300, danach gleichzeitig niedriger Wartungswert – Fahrzeug bleibt beim Maximum
  const r4 = created[3].record;
  await Promise.all([documentMileage(w.tenantId, r4.id, w.actor, "50300"), documentMileage(w.tenantId, created[4].record.id, w.actor, "50200")]);
  assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })).mileage, 50_300);
});

// ---------------------------------------------------------------------------
// Schadenakte: Verknüpfung, Dokumentreferenz ohne Kopie, keine automatische Kosten- oder Kundenbelastung
// ---------------------------------------------------------------------------

test("Schadenreparatur: Verknüpfung nur gleiches Fahrzeug, Schadendokument ohne zweite Datei referenzierbar, Kosten nur auf ausdrückliche Übernahme, keine Forderung", async () => {
  const w = await returnedWorld("maint-damage");
  tenants.push(w.tenantId);
  const damage = await db.damage.findFirstOrThrow({ where: { tenantId: w.tenantId, discoveredInHandoverId: w.returnId } });
  const { damageCase: c } = await openDamageCase(w.tenantId, damage.id, w.actor);
  const before = await snapshotCore(w.tenantId);
  const dkey = buildStorageKey({ tenantId: w.tenantId, area: "documents", bookingId: w.bookingId, contentType: "application/pdf" });
  const caseDoc = await db.damageCaseDocument.create({ data: { tenantId: w.tenantId, caseId: c.id, type: "REPAIR_INVOICE", fileName: "Werkstattrechnung-4711.pdf", storageKey: dkey, contentType: "application/pdf", sizeBytes: 900, checksum: sha256(dkey) } });
  // Fremdes Fahrzeug: Verknüpfung abgelehnt (App und DB)
  const other = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-XX 999", make: "VW", model: "Golf", groupId: w.groupId, dailyRate: 49, deposit: 300 } });
  await assert.rejects(() => createMaintenance(w.tenantId, w.actor, { vehicleId: other.id, type: "DAMAGE_REPAIR", title: "Reparatur", damageCaseId: c.id }), /nicht zu diesem Fahrzeug/);
  const { record: r } = await createMaintenance(w.tenantId, w.actor, { vehicleId: w.vehicleId, type: "DAMAGE_REPAIR", title: "Heckklappe instand setzen", damageCaseId: c.id, workshopName: "Autohaus Muster" });
  assert.equal(r.damageCaseId, c.id);
  // Dokument der Schadenakte verknüpfen: dieselbe Datei, kein zweiter Upload; doppelt ist wirkungslos
  const l1 = await linkDamageDocument(w.tenantId, r.id, w.actor, caseDoc.id);
  const l2 = await linkDamageDocument(w.tenantId, r.id, w.actor, caseDoc.id);
  assert.equal(l1.created, true);
  assert.equal(l2.created, false);
  assert.equal(l1.link.id, l2.link.id);
  const parallel = await Promise.allSettled([1, 2, 3].map(() => linkDamageDocument(w.tenantId, r.id, w.actor, caseDoc.id)));
  assert.ok(parallel.every((p) => p.status === "fulfilled"));
  assert.equal(await db.maintenanceDocumentLink.count({ where: { maintenanceId: r.id } }), 1);
  assert.equal(await db.vehicleDocument.count({ where: { tenantId: w.tenantId } }), 0, "keine Dateikopie");
  const view = await maintenanceView(w.tenantId, r.id);
  assert.equal(view.documentLinks[0].damageCaseDocument.storageKey, dkey);
  const o = await vehicleMaintenanceOverview(w.tenantId, w.vehicleId);
  assert.ok(o.damageDocuments.some((d) => d.id === caseDoc.id), "Werkstattrechnung in der Fahrzeugakte sichtbar");
  // Kosten am Vorgang ändern die Akte nicht
  await setMaintenanceCosts(w.tenantId, r.id, w.actor, { actual: "1.500,00" });
  let dc = await db.damageCase.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(dc.actualCostCents, null, "keine automatische Kostenübernahme");
  assert.equal(dc.liabilityStatus, "UNASSESSED");
  assert.equal(dc.customerChargeCents, null);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0, "keine Rechnung");
  // Ausdrückliche Übernahme
  const adopted = await adoptCostsIntoDamageCase(w.tenantId, r.id, w.actor);
  assert.equal(adopted.after, 150_000);
  dc = await db.damageCase.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(dc.actualCostCents, 150_000);
  assert.equal(dc.liabilityStatus, "UNASSESSED", "Haftung unverändert");
  assert.equal(dc.customerChargeCents, null, "keine Kundenbelastung");
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "MAINTENANCE_COSTS_ADOPTED" } }), 1);
  // Kernprozess (Vertrag, Protokolle, Rechnungen, Haftung, Belastung) unverändert bis auf die bewusste Kostenübernahme
  const after = JSON.parse(await snapshotCore(w.tenantId));
  const beforeObj = JSON.parse(before);
  assert.deepEqual({ ...after, cases: null }, { ...beforeObj, cases: null });
  // Verknüpfung lösen und neu setzen
  await linkDamageCase(w.tenantId, r.id, w.actor, null);
  assert.equal((await db.maintenanceRecord.findUniqueOrThrow({ where: { id: r.id } })).damageCaseId, null);
  await linkDamageCase(w.tenantId, r.id, w.actor, c.id);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "MAINTENANCE_DAMAGE_LINKED" } }), 3);
});

// ---------------------------------------------------------------------------
// Mandantentrennung
// ---------------------------------------------------------------------------

test("Mandantentrennung: fremde Pläne, Vorgänge, Dokumente und Schadenakten sind unsichtbar und unverknüpfbar", async () => {
  const a = await world("maint-tenant-a");
  const b = await world("maint-tenant-b");
  const plan = await createPlan(a.tenantId, a.actor, { vehicleId: a.vehicleId, type: "INSPECTION", nextDueDate: day(10) });
  const { record: r } = await createMaintenance(a.tenantId, a.actor, { vehicleId: a.vehicleId, type: "INSPECTION", title: "Inspektion A", planId: plan.id });
  await assert.rejects(() => createPlan(b.tenantId, b.actor, { vehicleId: a.vehicleId, type: "INSPECTION", nextDueDate: day(10) }), /Fahrzeug nicht gefunden/);
  await assert.rejects(() => createMaintenance(b.tenantId, b.actor, { vehicleId: b.vehicleId, type: "INSPECTION", title: "Inspektion B", planId: plan.id }), /Wartungsplan gehört nicht/);
  await assert.rejects(() => maintenanceView(b.tenantId, r.id), /nicht gefunden/);
  await assert.rejects(() => setMaintenanceCosts(b.tenantId, r.id, b.actor, { actual: "1" }), /nicht gefunden/);
  await assert.rejects(() => completeMaintenance(b.tenantId, r.id, b.actor, { completedAt: new Date() }), /nicht gefunden/);
  await assert.rejects(() => blockVehicleForMaintenance(b.tenantId, r.id, b.actor), /nicht gefunden/);
  await assert.rejects(() => updatePlan(b.tenantId, plan.id, b.actor, { type: "INSPECTION", nextDueDate: day(1) }), /nicht gefunden/);
  await assert.rejects(() => registerVehicleDocument(b.tenantId, b.actor, { vehicleId: a.vehicleId, type: "OTHER", fileName: "x.pdf", storageKey: `t/${b.tenantId}/documents/x.pdf`, contentType: "application/pdf", sizeBytes: 1, checksum: "c" }), /Fahrzeug nicht gefunden/);
  assert.equal((await listMaintenance(b.tenantId, { filter: "alle" })).total, 0);
  assert.equal((await fleetDues(b.tenantId)).length, 0);
  // DB-Regeln unabhängig von der App
  await assert.rejects(() => db.maintenanceRecord.create({ data: { tenantId: b.tenantId, vehicleId: a.vehicleId, maintenanceNumber: "WA-2026-999998", type: "REPAIR", title: "x" } }), /RB_TENANT/);
  await assert.rejects(() => db.maintenancePlan.create({ data: { tenantId: b.tenantId, vehicleId: a.vehicleId, type: "REPAIR", title: "x", nextDueDate: day(1) } }), /RB_TENANT/);
  await assert.rejects(() => db.vehicleDocument.create({ data: { tenantId: b.tenantId, vehicleId: a.vehicleId, type: "OTHER", fileName: "x", storageKey: `t/${b.tenantId}/documents/y.pdf`, contentType: "application/pdf", sizeBytes: 1, checksum: "c" } }), /RB_TENANT/);
  await assert.rejects(() => db.maintenanceEvent.create({ data: { tenantId: b.tenantId, maintenanceId: r.id, type: "NOTE_ADDED" } }), /RB_TENANT/);
});
