// Befehl 21: Eingabeprüfung für die Live-Hinweise „Kilometerstand fehlt“ / „Batteriestand fehlt“ in Übergabe und Rückgabe.
// Reine Funktionen (ohne DOM), damit die Regeln testbar sind. Nur Anzeige: ob ein Wert wirklich gilt, entscheidet allein
// der Server (collectIssues in handovers.ts) beim Speichern und beim Abschluss.

/** Kilometerstand: ganze Zahl ab 0, Tausenderpunkte erlaubt („50.100“). Leer oder Text gilt als fehlend. */
export function isMileageInputValid(value: string | null | undefined): boolean {
  return /^\d+$/.test((value ?? "").replace(/\./g, "").trim());
}

/** Batteriestand: ganze Zahl von 0 bis 100. */
export function isBatteryInputValid(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return /^\d{1,3}$/.test(v) && Number(v) <= 100;
}

/** Tankstand: einer der Werte 0 bis 8 (Achtel) ist ausgewählt. */
export function isFuelInputValid(value: string | null | undefined): boolean {
  return /^[0-8]$/.test((value ?? "").trim());
}
