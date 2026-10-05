"use server";

// Befehl 29 Phase C: Anlage eines Unfallersatzfalls aus dem Wizard. Rollen: OWNER und DISPO legen Fälle an; YARD nicht
// (keine Buchungen, keine kaufmännischen Angaben). Jede Aktion prüft Rolle UND Freischaltung serverseitig – ein direkter
// Aufruf umgeht nichts. Alle Eingaben werden hier verbindlich geprüft (parseAccidentWizard); Mandanten-, Kunden-, Fahrzeug-
// und Adressbuch-Zugehörigkeit sowie die Verfügbarkeit prüft createAccidentCase in einer Transaktion unter Fahrzeugsperre.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireFeature, requireRole } from "@/lib/auth";
import { createAccidentCase } from "@/lib/accident-replacement";
import { parseAccidentWizard, stepOfCreateMessage, type WizardData, type WizardError } from "@/lib/accident-wizard";
import { db } from "@/lib/db";
import { occupyingWhere, vehicleStatusProblem } from "@/lib/bookings";
import { fmtDateTime } from "@/lib/format";
import { DomainError } from "@/lib/integrity";
import { parseLocalDateTime } from "@/lib/time";

export type AccidentWizardState = { error?: string; step?: number; errors?: WizardError[] } | undefined;

function formDataToWizard(formData: FormData): WizardData {
  const out: WizardData = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

export async function createAccidentCaseAction(_prev: AccidentWizardState, formData: FormData): Promise<AccidentWizardState> {
  const { tenant, user } = await requireRole("DISPO");
  await requireFeature("ACCIDENT_REPLACEMENT");
  const data = formDataToWizard(formData);
  const nonce = (data.nonce ?? "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return { error: "Die Seite ist veraltet. Bitte neu laden.", step: 6 };
  const parsed = parseAccidentWizard(data);
  if (!parsed.ok) return { error: parsed.errors[0].message, step: parsed.step, errors: parsed.errors };
  let created: { bookingId: string; caseId: string };
  try {
    const res = await createAccidentCase(tenant.id, { id: user.id, name: user.name }, { ...parsed.input, nonce });
    created = { bookingId: res.bookingId, caseId: res.case.id };
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message, step: stepOfCreateMessage(e.message) };
    // keine technischen Details an den Benutzer; im Serverlog nur die Fehlerart, keine Eingaben
    console.error("[unfallersatz] Anlage fehlgeschlagen", { fehler: e instanceof Error ? e.name : "unbekannt" });
    return { error: "Der Unfallersatzfall konnte nicht angelegt werden. Bitte erneut versuchen.", step: 6 };
  }
  revalidatePath("/buchungen");
  revalidatePath(`/buchungen/${created.bookingId}`);
  revalidatePath("/dispo");
  revalidatePath("/heute");
  // Phase D: weiter in die Fallakte (operative Hauptansicht); die Buchung bleibt von dort aus erreichbar
  redirect(`/unfallersatz/${created.caseId}?angelegt=1`);
}

export type VehicleAvailability = { free: boolean; text: string };
export type AvailabilityResult = { error?: string; vehicles?: Record<string, VehicleAvailability> };

/**
 * Verfügbarkeit aller Flottenfahrzeuge für den gewählten Zeitraum (nur lesend, ohne Sperre – verbindlich prüft die Anlage).
 * Dieselbe Belegungsregel wie überall (occupyingWhere): ein offenes Mietende belegt ab Mietbeginn unbegrenzt.
 */
export async function accidentAvailabilityAction(input: { startAt: string; endMode: string; plannedEndAt: string }): Promise<AvailabilityResult> {
  const { tenant } = await requireRole("DISPO");
  await requireFeature("ACCIDENT_REPLACEMENT");
  const startAt = parseLocalDateTime(input.startAt);
  if (!startAt) return { error: "Bitte den Mietbeginn mit Datum und Uhrzeit angeben." };
  const open = input.endMode === "open";
  const endAt = open ? null : parseLocalDateTime(input.plannedEndAt);
  if (!open && !endAt) return { error: "Bitte das geplante Mietende angeben oder „Mietende offen“ wählen." };
  if (endAt && !(endAt > startAt)) return { error: "Das geplante Mietende muss nach dem Mietbeginn liegen." };
  const [vehicles, busy] = await Promise.all([
    db.vehicle.findMany({ where: { tenantId: tenant.id, status: { not: "INACTIVE" } }, select: { id: true, status: true } }),
    db.booking.findMany({ where: { tenantId: tenant.id, ...occupyingWhere(startAt, endAt) }, select: { vehicleId: true, number: true, startAt: true, endAt: true }, orderBy: { startAt: "asc" } }),
  ]);
  const out: Record<string, VehicleAvailability> = {};
  for (const v of vehicles) {
    const problem = vehicleStatusProblem(v.status);
    const c = busy.find((b) => b.vehicleId === v.id);
    if (problem) out[v.id] = { free: false, text: problem };
    else if (c) {
      const later = c.startAt > startAt;
      out[v.id] = {
        free: false,
        text: later && open
          ? `Mietende offen nicht möglich: Das Fahrzeug ist ab ${fmtDateTime(c.startAt)} für Buchung ${c.number} vorgesehen. Bitte ein geplantes Mietende davor wählen oder ein anderes Fahrzeug.`
          : later ? `Ab ${fmtDateTime(c.startAt)} für Buchung ${c.number} vorgesehen.` : `Belegt durch Buchung ${c.number}${c.endAt ? ` bis ${fmtDateTime(c.endAt)}` : " (Mietende offen)"}.`,
      };
    } else out[v.id] = { free: true, text: open ? "Frei ab Mietbeginn, auch ohne Mietende" : "Im Zeitraum frei" };
  }
  return { vehicles: out };
}
