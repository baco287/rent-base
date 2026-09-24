// Kleine, prozesslokale Last- und Missbrauchsbremse (Login, Suche). Ohne Redis: Der Zähler lebt im Speicher dieses
// Prozesses. Bei mehreren App-Instanzen gilt die Grenze je Instanz – für den heutigen Betrieb (ein Container) ausreichend;
// eine geteilte Bremse wäre eine Abhängigkeit (Redis o. ä.) und ist bewusst nicht eingebaut.
// Schlüssel enthalten keine Klartext-Personendaten: E-Mail-Adressen werden vor der Verwendung gehasht.

import { createHash } from "node:crypto";

type Bucket = { hits: number[] };
const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

export type RateLimitRule = { limit: number; windowMs: number };

export const LOGIN_LIMIT_PER_ACCOUNT: RateLimitRule = { limit: 8, windowMs: 15 * 60_000 };
export const LOGIN_LIMIT_PER_ADDRESS: RateLimitRule = { limit: 40, windowMs: 15 * 60_000 };
export const SEARCH_LIMIT_PER_USER: RateLimitRule = { limit: 90, windowMs: 60_000 };

export function hashKeyPart(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 24);
}

/** Prüft und zählt einen Versuch. Gibt zurück, ob er erlaubt ist, und wann das Fenster frei wird. */
export function consume(key: string, rule: RateLimitRule, now = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_KEYS) sweep(now);
    b = { hits: [] };
    buckets.set(key, b);
  }
  const since = now - rule.windowMs;
  b.hits = b.hits.filter((t) => t > since);
  if (b.hits.length >= rule.limit) {
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, b.hits[0] + rule.windowMs - now) };
  }
  b.hits.push(now);
  return { allowed: true, remaining: rule.limit - b.hits.length, retryAfterMs: 0 };
}

/** Nur prüfen, ohne zu zählen (z. B. nach erfolgreichem Login zurücksetzen). */
export function reset(key: string) {
  buckets.delete(key);
}

function sweep(now: number) {
  for (const [k, b] of buckets) {
    if (b.hits.length === 0 || b.hits[b.hits.length - 1] < now - 60 * 60_000) buckets.delete(k);
  }
  if (buckets.size >= MAX_KEYS) buckets.clear();
}

/** Für Tests: alle Zähler verwerfen. */
export function clearAllRateLimits() {
  buckets.clear();
}
