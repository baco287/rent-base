"use server";

// Befehl 20.7: Kundensuche im Buchungsformular. Serverseitig, mandantengebunden, dieselbe Such- und Normalisierungslogik
// wie die globale Suche (customerSearchWhere: Nummer, Name, Firma, E-Mail, Telefon nur Ziffern). Es wird nie die ganze
// Kundenliste in den Browser geladen. Suchbegriffe werden nicht protokolliert; Lastbremse wie bei der globalen Suche.

import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { consume, SEARCH_LIMIT_PER_USER } from "@/lib/rate-limit";
import { customerSearchWhere, searchQuerySchema } from "@/lib/search";
import type { CustomerOption } from "./booking-form";
import { CUSTOMER_OPTION_SELECT, CUSTOMER_PICKER_LIMIT, customerOptionOf } from "./customer-option";

export async function searchCustomersAction(rawQ: unknown): Promise<{ hits: CustomerOption[]; more: boolean } | { error: string }> {
  const { tenant, user } = await requireRole("DISPO");
  const parsed = searchQuerySchema.safeParse(typeof rawQ === "string" ? rawQ : "");
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const gate = consume(`search:${user.id}`, SEARCH_LIMIT_PER_USER);
  if (!gate.allowed) return { error: "Zu viele Suchanfragen. Bitte einen Moment warten." };
  try {
    const where = await customerSearchWhere(tenant.id, parsed.data);
    const rows = await db.customer.findMany({ where, take: CUSTOMER_PICKER_LIMIT + 1, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], select: CUSTOMER_OPTION_SELECT });
    return { hits: rows.slice(0, CUSTOMER_PICKER_LIMIT).map(customerOptionOf), more: rows.length > CUSTOMER_PICKER_LIMIT };
  } catch (e) {
    console.error("[kundensuche] fehlgeschlagen", { fehler: e instanceof Error ? e.name : "unbekannt" });
    return { error: "Die Suche ist gerade nicht möglich. Bitte erneut versuchen." };
  }
}
