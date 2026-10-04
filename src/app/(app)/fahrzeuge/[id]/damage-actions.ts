"use server";

// Befehl 27: Schaden ohne Übergabe-/Rückgabeprotokoll erfassen (Fahrzeugakte → Schäden → „+ Schaden erfassen“).
// Inhaber, Disposition und Hof (wie das Eröffnen einer Schadenakte); Supportmodus nur lesend (requireRole leitet um).
// Keine Haftung, keine Kundenbelastung, keine Rechnung – nur die bestehende Schadenlogik (lib/damages.ts reportDamage).

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { reportDamage } from "@/lib/damages";
import { DomainError } from "@/lib/integrity";
import { parseLocalDateTime } from "@/lib/time";

export type ReportDamageState = { error?: string; damageId?: string } | undefined;

const schema = z.object({
  view: z.string().min(1, "Bitte den Fahrzeugbereich wählen."),
  posX: z.coerce.number({ message: "Bitte die Stelle auf der Skizze antippen." }).min(0).max(1),
  posY: z.coerce.number({ message: "Bitte die Stelle auf der Skizze antippen." }).min(0).max(1),
  kind: z.string().min(1, "Bitte die Schadenart wählen."),
  severity: z.string().min(1),
  size: z.string().trim().max(60).optional(),
  description: z.string().trim().min(3, "Bitte den Schaden kurz beschreiben.").max(1000),
  note: z.string().trim().max(1000).optional(),
  discoveredAt: z.string().optional(),
});

export async function reportDamageAction(vehicleId: string, _prev: ReportDamageState, formData: FormData): Promise<ReportDamageState> {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  const discoveredAt = d.discoveredAt ? parseLocalDateTime(d.discoveredAt) : null;
  if (d.discoveredAt && !discoveredAt) return { error: "Bitte Datum und Uhrzeit der Feststellung angeben." };
  try {
    const damage = await reportDamage(tenant.id, { id: user.id, name: user.name }, { vehicleId, view: d.view, posX: d.posX, posY: d.posY, kind: d.kind, severity: d.severity, size: d.size || null, description: d.description, note: d.note || null, discoveredAt });
    revalidatePath(`/fahrzeuge/${vehicleId}`);
    return { damageId: damage.id };
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
}
