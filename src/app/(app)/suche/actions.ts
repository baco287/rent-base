"use server";

// Globale Suche als Server Action: Sitzung und Rolle serverseitig, Eingabe mit zod begrenzt, Mandantengrenze in der
// Suchbibliothek. Suchbegriffe werden nicht protokolliert. Eine kleine Lastbremse je Benutzer schützt die Datenbank.

import { requireRole } from "@/lib/auth";
import { consume, SEARCH_LIMIT_PER_USER } from "@/lib/rate-limit";
import { globalSearch, searchQuerySchema, type SearchResult } from "@/lib/search";

export async function globalSearchAction(rawQ: unknown): Promise<SearchResult | { error: string }> {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const parsed = searchQuerySchema.safeParse(typeof rawQ === "string" ? rawQ : "");
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const gate = consume(`search:${user.id}`, SEARCH_LIMIT_PER_USER);
  if (!gate.allowed) return { error: "Zu viele Suchanfragen. Bitte einen Moment warten." };
  try {
    return await globalSearch(tenant.id, user.role, parsed.data, { perType: 6 });
  } catch (e) {
    console.error("[suche] fehlgeschlagen", { fehler: e instanceof Error ? e.name : "unbekannt" });
    return { error: "Die Suche ist gerade nicht möglich. Bitte erneut versuchen." };
  }
}
