"use server";

// Geschäftsregeln des Mandanten: nur der Inhaber. Jede Sektion speichert nur ihre eigenen Schlüssel (Merge); abgeschlossene
// Verträge bleiben unverändert, offene Entwürfe erhalten einen Hinweis und übernehmen neue Werte nur auf Wunsch.
// Keine Regel erzeugt Rechnungen, Zusatzkosten, Kautionsbewegungen oder Forderungen.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireFeature, requireRole } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { DEFAULT_BUSINESS_RULES, RuleError, RULE_KEYS, ruleConsistencyIssues, sanitizeRules, type BusinessRules, type RuleKey } from "@/lib/business-rules";
import { RULE_SECTIONS, rulesFromForm } from "@/lib/business-rules-form";

export type RulesState = { error?: string; ok?: string } | undefined;

const sectionWords: Record<string, string[]> = { zusatzfahrer: ["zusatzfahrer"], ausland: ["ausland"], tanken: ["tank-/laderegel"], rueckgabe: ["verspätete"], behoerden: ["bearbeitungsentgelt"] };

export async function updateBusinessRulesAction(section: string, _prev: RulesState, fd: FormData): Promise<RulesState> {
  const { tenant, user } = await requireRole("OWNER");
  const keys = RULE_SECTIONS[section];
  if (!keys) return { error: "Unbekannter Bereich." };
  try {
    const part = rulesFromForm(fd, keys);
    const current = sanitizeRules(tenant.businessRules, RULE_KEYS);
    const merged: BusinessRules = { ...DEFAULT_BUSINESS_RULES, ...current, ...part };
    const words = sectionWords[section] ?? [];
    const problems = ruleConsistencyIssues(merged).filter((m) => words.some((w) => m.toLowerCase().includes(w)));
    if (problems.length) return { error: problems[0] };
    const stored = { ...current, ...part };
    const changed = (keys as RuleKey[]).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(part[k]));
    await db.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenant.id }, data: { businessRules: stored } });
      if (changed.length) await recordAudit(tx, tenant.id, { id: user.id, name: user.name }, { action: "BUSINESS_RULES_UPDATED", details: { scope: "TENANT", section, changed: changed.join(","), ...Object.fromEntries(changed.map((k) => [k, JSON.stringify(part[k] ?? null)])) } });
    });
  } catch (e) {
    if (e instanceof RuleError) return { error: e.message };
    if (String((e as Error).message).includes("rules_valid")) return { error: "Die Werte wurden von der Datenbankprüfung abgelehnt (negativer Betrag oder ungültiger Wert)." };
    throw e;
  }
  revalidatePath("/einstellungen/geschaeftsregeln");
  revalidatePath("/einstellungen/vertraege");
  revalidatePath("/buchungen", "layout");
  return { ok: "Geschäftsregeln gespeichert. Abgeschlossene Verträge bleiben unverändert; offene Entwürfe erhalten einen Hinweis." };
}

export async function updatePrivacyReferenceAction(_prev: RulesState, fd: FormData): Promise<RulesState> {
  const { tenant } = await requireRole("OWNER");
  const value = String(fd.get("privacyNoticeReference") ?? "").trim().slice(0, 500) || null;
  await db.tenant.update({ where: { id: tenant.id }, data: { privacyNoticeReference: value } });
  revalidatePath("/einstellungen/geschaeftsregeln");
  revalidatePath("/einstellungen/vertraege");
  return { ok: "Datenschutzverweis gespeichert." };
}

/** Befehl 20.6: kontaktlose Rückgabe / Schlüsselbox erlauben und konfigurieren (Mandanten-Funktion, kein Vertragsbestandteil). Nur Inhaber. */
export async function updateKeyDropSettingsAction(_prev: RulesState, fd: FormData): Promise<RulesState> {
  const { tenant, user } = await requireRole("OWNER");
  await requireFeature("KEY_DROP");
  const { saveKeyDropSettings } = await import("@/lib/key-drop");
  await saveKeyDropSettings(tenant.id, { id: user.id, name: user.name }, {
    enabled: fd.get("enabled") === "on",
    label: String(fd.get("label") ?? ""),
    defaultInstructions: String(fd.get("defaultInstructions") ?? ""),
    parkingNote: String(fd.get("parkingNote") ?? ""),
    keyNote: String(fd.get("keyNote") ?? ""),
    requestedPhotos: fd.getAll("requestedPhotos").map(String) as never,
  });
  revalidatePath("/einstellungen/geschaeftsregeln");
  revalidatePath("/einstellungen/vertraege");
  return { ok: "Einstellungen zur kontaktlosen Rückgabe gespeichert." };
}

/**
 * Befehl 23: Mahnwesen (Standard-Zahlungsziel, Fristen, Mahngebühren). Nur der Inhaber; wirkt nur auf künftige Rechnungen
 * und Mahnschreiben. Serverseitig geprüft (lib/dunning.ts validateDunningSettings), Beträge in Cent, keine Verzugszinsen.
 */
export async function updateDunningSettingsAction(_prev: RulesState, fd: FormData): Promise<RulesState> {
  const { tenant, user } = await requireRole("OWNER");
  const { updateDunningSettings } = await import("@/lib/dunning");
  const { parseAmount } = await import("@/lib/deposits");
  const { DomainError } = await import("@/lib/integrity");
  const int = (k: string) => { const v = String(fd.get(k) ?? "").trim(); return v === "" ? NaN : Number(v); };
  try {
    const term = String(fd.get("paymentTermDays") ?? "").trim();
    await updateDunningSettings(tenant.id, { id: user.id, name: user.name }, {
      paymentTermDays: term === "" ? null : Number(term),
      reminderDays: int("reminderDays"), firstDays: int("firstDays"), secondDays: int("secondDays"),
      feesEnabled: fd.get("feesEnabled") === "on",
      firstFeeCents: parseAmount(String(fd.get("firstFee") ?? "") || "0", "Die Gebühr der 1. Mahnung"),
      secondFeeCents: parseAmount(String(fd.get("secondFee") ?? "") || "0", "Die Gebühr der 2. Mahnung"),
    });
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  for (const p of ["/einstellungen/rechnungen", "/einstellungen/geschaeftsregeln", "/forderungen"]) revalidatePath(p);
  return { ok: "Mahnwesen gespeichert. Die Werte gelten für künftige Rechnungen und Mahnschreiben; bestehende bleiben unverändert." };
}
