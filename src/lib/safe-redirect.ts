// Befehl 27: Weiterleitung nach dem Login nur auf interne Pfade. Abgelehnt werden u. a. protokoll-relative Ziele
// („//fremde-domain“), Schemata (http:, https:, javascript:), Backslashes (Browser lesen „/\“ wie „//“) und Steuerzeichen.
const BASE = "http://intern.invalid";

export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0 || v.length > 2000) return null;
  if (!v.startsWith("/") || v.startsWith("//")) return null;
  if (v.includes("\\")) return null;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  try {
    const u = new URL(v, BASE);
    if (u.origin !== BASE) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}
