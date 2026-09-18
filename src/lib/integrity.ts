// Versiegelung und Unveränderlichkeit.
// - canonicalJson/contentHash: stabiler Hash über einen Inhalt, unabhängig von der Schlüsselreihenfolge.
// - ImmutableError + assert-Funktionen: serverseitige Sperre für finalisierte Datensätze.
// Zusätzlich schützen Datenbank-Trigger (Migration vertrag_protokolle_fundament) dieselben Regeln,
// falls jemand an diesen Funktionen vorbei schreibt.

import { createHash } from "node:crypto";

/** Fehler, wenn ein finalisierter Datensatz geändert werden soll. */
export class ImmutableError extends Error {
  readonly code = "RB_IMMUTABLE";
  constructor(message: string) {
    super(message);
    this.name = "ImmutableError";
  }
}

/** Fachlicher Fehler mit verständlicher Meldung für den Benutzer. */
export class DomainError extends Error {
  readonly code = "RB_DOMAIN";
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/** Erkennt auch die Meldung der Datenbank-Trigger. */
export function isImmutableError(e: unknown): boolean {
  if (e instanceof ImmutableError) return true;
  return e instanceof Error && e.message.includes("RB_IMMUTABLE");
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    // Prisma.Decimal und ähnliche Typen: über toString() stabil abbilden
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null && typeof (value as { toString?: unknown }).toString === "function") {
      return String(value);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) out[key] = normalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** JSON mit sortierten Schlüsseln, Datumswerte als ISO-Text. Gleicher Inhalt ergibt immer denselben Text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hash über einen Inhalt. Wird beim Finalisieren gespeichert und von Unterschriften referenziert. */
export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function assertHandoverDraft(h: { status: string; number: string }) {
  if (h.status !== "DRAFT") throw new ImmutableError(`Das Protokoll ${h.number} ist finalisiert und kann nicht mehr geändert werden. Korrekturen nur über ein Nachtragsprotokoll.`);
}

export function assertContractDraft(c: { status: string; number: string }) {
  if (c.status !== "DRAFT") throw new ImmutableError(`Der Vertrag ${c.number} ist unterschrieben und kann nicht mehr geändert werden.`);
}
