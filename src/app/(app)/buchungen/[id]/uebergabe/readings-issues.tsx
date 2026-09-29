"use client";

// Befehl 20.7: „Kilometerstand fehlt“ / „Tankstand fehlt“ / „Batteriestand fehlt“ verschwinden sofort, sobald im Formular ein
// gültiger Wert steht – ohne Server. Nur Anzeige: die serverseitige Prüfung (collectIssues) entscheidet weiterhin allein
// beim Speichern und beim Abschluss; nach dem Speichern kommt ohnehin der Serverstand.
import { useEffect, useState } from "react";
import type { HandoverIssue } from "@/lib/handovers";
import { isBatteryInputValid, isFuelInputValid, isMileageInputValid } from "@/lib/readings-live";

export type ReadingWatch = { code: string; check: () => boolean };

// Die Regeln selbst stehen als reine Funktionen in lib/readings-live.ts (testbar); hier nur das Auslesen der Felder.
export const WATCH_MILEAGE: ReadingWatch = { code: "MILEAGE_MISSING", check: () => isMileageInputValid((document.getElementById("mileage") as HTMLInputElement | null)?.value) };
export const WATCH_FUEL: ReadingWatch = { code: "FUEL_MISSING", check: () => isFuelInputValid((document.querySelector('input[name="fuelLevelEighths"]:checked') as HTMLInputElement | null)?.value) };
export const WATCH_BATTERY: ReadingWatch = { code: "BATTERY_MISSING", check: () => isBatteryInputValid((document.getElementById("batteryPercent") as HTMLInputElement | null)?.value) };

export function ReadingsIssueList({ issues, watch, okText }: { issues: HandoverIssue[]; watch: ("mileage" | "fuel" | "battery")[]; okText?: string }) {
  const [satisfied, setSatisfied] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const watches = watch.map((w) => (w === "mileage" ? WATCH_MILEAGE : w === "fuel" ? WATCH_FUEL : WATCH_BATTERY));
    const evaluate = () => setSatisfied(new Set(watches.filter((w) => { try { return w.check(); } catch { return false; } }).map((w) => w.code)));
    evaluate();
    document.addEventListener("input", evaluate);
    document.addEventListener("change", evaluate);
    return () => { document.removeEventListener("input", evaluate); document.removeEventListener("change", evaluate); };
  }, [watch]);
  const list = issues.filter((i) => !satisfied.has(i.code));
  const errors = list.filter((i) => i.severity === "error");
  const warnings = list.filter((i) => i.severity === "warning");
  if (list.length === 0) return okText ? <p className="rounded-md bg-good-soft text-good px-3 py-2 text-sm font-medium">{okText}</p> : null;
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {errors.length > 0 && (
        <div role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">
          <div className="font-semibold mb-1">{errors.length === 1 ? "1 Punkt ist noch offen" : `${errors.length} Punkte sind noch offen`}</div>
          <ul className="list-disc pl-5 flex flex-col gap-0.5">{errors.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">
          <div className="font-semibold mb-1">Hinweise</div>
          <ul className="list-disc pl-5 flex flex-col gap-0.5">{warnings.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
