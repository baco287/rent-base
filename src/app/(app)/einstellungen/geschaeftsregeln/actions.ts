"use server";

// Geschäftsregeln des Mandanten: nur der Inhaber. Jede Sektion speichert nur ihre eigenen Schlüssel (Merge); abgeschlossene
// Verträge bleiben unverändert, offene Entwürfe erhalten einen Hinweis und übernehmen neue Werte nur auf Wunsch.
// Keine Regel erzeugt Rechnungen, Zusatzkosten, Kautionsbewegungen oder Forderungen.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
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
  revalidatePath("/buchungen", "layout");
  return { ok: "Geschäftsregeln gespeichert. Abgeschlossene Verträge bleiben unverändert; offene Entwürfe erhalten einen Hinweis." };
}

export async function updatePrivacyReferenceAction(_prev: RulesState, fd: FormData): Promise<RulesState> {
  const { tenant } = await requireRole("OWNER");
  const value = String(fd.get("privacyNoticeReference") ?? "").trim().slice(0, 500) || null;
  await db.tenant.update({ where: { id: tenant.id }, data: { privacyNoticeReference: value } });
  revalidatePath("/einstellungen/geschaeftsregeln");
  return { ok: "Datenschutzverweis gespeichert." };
}
