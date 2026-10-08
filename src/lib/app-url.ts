// Basis-Adresse für Links in E-Mails: Einladung, Passwort-Reset, Rückgabelink.
//
// Kommt ausschließlich aus der Serverkonfiguration (APP_URL), nie aus Host- oder X-Forwarded-Host-Headern
// der Anfrage. Sonst könnte jemand mit einem manipulierten Header eine fremde Domain in einen Reset-Link
// schleusen und mit dem Token das Konto übernehmen.
//
// Regeln: In Produktion ist APP_URL Pflicht und muss eine reine https-Adresse sein (nur Protokoll und Domain,
// optional Port). Lokal ohne APP_URL gilt http://localhost:3000.

import { DomainError } from "@/lib/integrity";

export const DEV_APP_URL = "http://localhost:3000";

/** Konfigurationsfehler bei APP_URL. Als DomainError zeigen die Aktionen die Meldung statt einer Fehlerseite an. */
export class AppUrlError extends DomainError {
  constructor(detail: string) {
    super(`Links in E-Mails können gerade nicht erzeugt werden: ${detail} Bitte den RentBase-Support informieren.`);
    this.name = "AppUrlError";
  }
}

/** Prüft APP_URL und liefert den Ursprung ohne abschließenden Schrägstrich, z. B. "https://app.rent-base.de". */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const production = env.NODE_ENV === "production";
  const raw = env.APP_URL?.trim();
  if (!raw) {
    if (production) throw new AppUrlError("Die Server-Adresse (APP_URL) ist nicht gesetzt.");
    return DEV_APP_URL;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppUrlError("Die Server-Adresse (APP_URL) ist keine gültige Adresse.");
  }
  const allowedProtocol = url.protocol === "https:" || (!production && url.protocol === "http:");
  if (!allowedProtocol) throw new AppUrlError(production ? "Die Server-Adresse (APP_URL) muss mit https:// beginnen." : "Die Server-Adresse (APP_URL) muss mit http:// oder https:// beginnen.");
  if (url.username || url.password) throw new AppUrlError("Die Server-Adresse (APP_URL) darf keine Zugangsdaten enthalten.");
  if (url.pathname !== "/" || url.search || url.hash) throw new AppUrlError("Die Server-Adresse (APP_URL) darf nur aus Protokoll und Domain bestehen, ohne Pfad, Parameter oder Anker.");
  return url.origin;
}

/** Für Systemseite und Serverstart: ob APP_URL brauchbar ist, mit Grund. Gibt nie den Wert selbst preis. */
export function appUrlStatus(env: NodeJS.ProcessEnv = process.env): { ok: boolean; message: string } {
  try {
    const origin = appBaseUrl(env);
    if (!env.APP_URL?.trim()) return { ok: true, message: `nicht gesetzt, lokal gilt ${origin}` };
    return { ok: true, message: "gültig" };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
