// Verschlüsselung gespeicherter Geheimnisse (Befehl 20.5: SMTP-Passwörter der Vermieter).
//
// - AES-256-GCM (authentifiziert) aus node:crypto, keine eigene Kryptographie. Zufälliger 96-Bit-IV je Wert.
// - Der Schlüssel kommt ausschließlich aus der Umgebung (RENTBASE_SECRET_KEY, 32 Byte, base64 oder hex) und wird nie
//   gespeichert, geloggt oder ausgegeben. Ohne Schlüssel wird nichts verschlüsselt – es gibt keinen Klartext-Rückfall.
// - Zusätzlich gebundene Daten (AAD) = Zweck und Mandant: Ein kopierter Wert lässt sich weder bei einem anderen
//   Mandanten noch für einen anderen Zweck entschlüsseln.
// - Schlüsselwechsel vorbereitet: Jeder Wert trägt die Kennung seines Schlüssels. RENTBASE_SECRET_KEY_PREVIOUS
//   (optional) wird nur noch zum Entschlüsseln verwendet; neu gespeicherte Werte nutzen immer den aktuellen Schlüssel.
// - Falscher Schlüssel oder veränderter Wert: GCM-Prüfung schlägt fehl, es wird geworfen – nie still Unsinn geliefert.
//
// Format: "v1.<keyId>.<iv>.<tag>.<ciphertext>" (base64url).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class SecretKeyMissingError extends Error {
  constructor() {
    super("Auf dem Server ist kein Schlüssel für gespeicherte Zugangsdaten eingerichtet (RENTBASE_SECRET_KEY).");
  }
}
export class SecretDecryptError extends Error {
  constructor() {
    super("Gespeicherte Zugangsdaten konnten nicht entschlüsselt werden.");
  }
}

type Key = { id: string; bytes: Buffer };

function parseKey(raw: string | undefined): Key | null {
  const v = raw?.trim();
  if (!v) return null;
  const bytes = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (bytes.length !== 32) return null;
  // Kennung: nicht umkehrbar, verrät nichts über den Schlüssel
  return { id: createHash("sha256").update("rentbase-secret-key-id:").update(bytes).digest("hex").slice(0, 12), bytes };
}

/** Nur Zustand, nie Werte: ist ein gültiger Schlüssel konfiguriert? */
export function secretKeyStatus(env: NodeJS.ProcessEnv = process.env): { configured: boolean; invalid: boolean } {
  const configured = parseKey(env.RENTBASE_SECRET_KEY) !== null;
  return { configured, invalid: !configured && Boolean(env.RENTBASE_SECRET_KEY?.trim()) };
}

const aad = (purpose: string, tenantId: string) => Buffer.from(`rentbase:${purpose}:${tenantId}`, "utf8");

export function encryptSecret(plain: string, ctx: { purpose: string; tenantId: string }, env: NodeJS.ProcessEnv = process.env): string {
  const key = parseKey(env.RENTBASE_SECRET_KEY);
  if (!key) throw new SecretKeyMissingError();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, iv);
  cipher.setAAD(aad(ctx.purpose, ctx.tenantId));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", key.id, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(stored: string, ctx: { purpose: string; tenantId: string }, env: NodeJS.ProcessEnv = process.env): string {
  const parts = stored.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") throw new SecretDecryptError();
  const [, keyId, ivB, tagB, ctB] = parts;
  const keys = [parseKey(env.RENTBASE_SECRET_KEY), parseKey(env.RENTBASE_SECRET_KEY_PREVIOUS)].filter((k): k is Key => k !== null);
  if (keys.length === 0) throw new SecretKeyMissingError();
  const key = keys.find((k) => k.id === keyId);
  if (!key) throw new SecretDecryptError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(ivB, "base64url"));
    decipher.setAAD(aad(ctx.purpose, ctx.tenantId));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretDecryptError();
  }
}

/** Kennung des Schlüssels, mit dem ein gespeicherter Wert verschlüsselt wurde (für einen späteren Schlüsselwechsel). */
export function secretKeyIdOf(stored: string | null | undefined): string | null {
  const p = stored?.split(".");
  return p && p.length === 5 && p[0] === "v1" ? p[1] : null;
}
