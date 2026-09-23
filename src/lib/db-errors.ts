// Meldungen der Datenbank-Trigger (RB_DOMAIN, RB_IMMUTABLE) als fachliche Fehler weitergeben, statt sie als Technikfehler zu verlieren.
import { DomainError } from "@/lib/integrity";

export function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_(?:DOMAIN|IMMUTABLE): ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}
