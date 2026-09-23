"use server";

// Nummernkreise der Belege: nur der Inhaber. Geändert wird ausschließlich das Präfix; vergebene Nummern bleiben, wie sie sind.
// Ein neues Präfix beginnt seinen eigenen Zähler (je Kreis und Jahr); keine Nummer wird je wiederverwendet.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { NumberRangeError, numberRangesOf, validateNumberRanges, type NumberRangeKey } from "@/lib/number-ranges";

export type RangesState = { error?: string; ok?: string } | undefined;

export async function updateNumberRangesAction(_prev: RangesState, fd: FormData): Promise<RangesState> {
  const { tenant, user } = await requireRole("OWNER");
  const input = { invoice: String(fd.get("invoice") ?? ""), creditNote: String(fd.get("creditNote") ?? ""), cancellation: String(fd.get("cancellation") ?? "") };
  try {
    const next = validateNumberRanges(input);
    const before = numberRangesOf(tenant.numberRanges);
    const changed = (Object.keys(next) as NumberRangeKey[]).filter((k) => before[k].prefix !== next[k].prefix);
    if (changed.length === 0) return { ok: "Keine Änderung." };
    await db.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenant.id }, data: { numberRanges: next } });
      await recordAudit(tx, tenant.id, { id: user.id, name: user.name }, { action: "NUMBER_RANGES_UPDATED", details: Object.fromEntries(changed.map((k) => [k, `${before[k].prefix} → ${next[k].prefix}`])) });
    });
  } catch (e) {
    if (e instanceof NumberRangeError) return { error: e.message };
    if (String((e as Error).message).includes("rb_tenant_number_ranges")) return { error: "Die Datenbankprüfung hat die Präfixe abgelehnt (1–6 Großbuchstaben, alle verschieden)." };
    throw e;
  }
  revalidatePath("/einstellungen/nummernkreise");
  revalidatePath("/einstellungen");
  return { ok: "Nummernkreise gespeichert. Bereits vergebene Nummern bleiben unverändert; neue Belege erhalten das neue Präfix." };
}
