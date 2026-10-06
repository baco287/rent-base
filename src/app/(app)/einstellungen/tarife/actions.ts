"use server";

// Befehl 29: Tarifverwaltung – nur der Inhaber (requireRole("OWNER"); Supportmodus ist dort immer read-only). Der Editor schickt den
// Inhalt als JSON mit Eurobeträgen als Text; hier wird exakt in Cent umgerechnet und erst die Logik (lib/tariff-admin) prüft fachlich.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { DomainError } from "@/lib/integrity";
import { toCents } from "@/lib/money";
import { createRatePlan, duplicateRatePlan, reviseRatePlan, setGroupDefaultRatePlan, setRatePlanActive, setVehicleRateOverride, updateRatePlanMeta, type TariffContent } from "@/lib/tariff-admin";
import { db } from "@/lib/db";

export type TariffFormState = { error?: string; ok?: string } | undefined;

const money = (v: string, label: string): number => {
  const t = (v ?? "").trim();
  if (!t) throw new DomainError(`${label}: bitte einen Betrag angeben.`);
  let c: number;
  try {
    c = toCents(t);
  } catch {
    throw new DomainError(`${label}: kein gültiger Betrag.`);
  }
  if (c < 0) throw new DomainError(`${label}: bitte einen Betrag ab 0,00 € angeben.`);
  return c;
};
const int = (v: string, label: string): number => {
  const t = (v ?? "").replace(/\./g, "").trim();
  if (!/^\d{1,6}$/.test(t)) throw new DomainError(`${label}: bitte eine ganze Zahl ab 0 angeben.`);
  return Number(t);
};

const kmSchema = z.object({ policy: z.enum(["FREE_KILOMETERS", "UNLIMITED"]), kmIncludedPerDay: z.string().max(10).default(""), extraKmRate: z.string().max(12).default("") });
const contentSchema = z.object({
  km: kmSchema,
  deposit: z.string().max(14),
  groups: z.array(z.object({
    groupId: z.string().min(1).max(64),
    tiers: z.array(z.object({ days: z.string().max(5), price: z.string().max(14), label: z.string().max(40).default("") })).max(40),
    deposit: z.string().max(14).default(""),
    km: kmSchema.nullable().default(null),
  })).max(200),
  defaults: z.array(z.string().min(1).max(64)).max(200).default([]),
});

function kmOf(k: z.infer<typeof kmSchema>, label: string): TariffContent["km"] {
  if (k.policy === "UNLIMITED") return { policy: "UNLIMITED", kmIncludedPerDay: null, extraKmRateCents: null };
  return { policy: "FREE_KILOMETERS", kmIncludedPerDay: int(k.kmIncludedPerDay, `${label}: Freikilometer je Tag`), extraKmRateCents: money(k.extraKmRate, `${label}: Mehrkilometerpreis`) };
}

function parseContent(fd: FormData): { content: TariffContent; defaults: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get("content") ?? ""));
  } catch {
    throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  }
  const p = contentSchema.safeParse(raw);
  if (!p.success) throw new DomainError("Die Eingaben sind unvollständig. Bitte die Seite neu laden.");
  const c = p.data;
  return {
    content: {
      km: kmOf(c.km, "Kilometer"),
      depositCents: money(c.deposit, "Kaution"),
      groups: c.groups.map((g) => ({
        groupId: g.groupId,
        tiers: g.tiers.filter((t) => t.days.trim() || t.price.trim()).map((t) => ({ days: int(t.days, "Dauer einer Preisstufe"), cents: money(t.price, "Preis einer Preisstufe"), label: t.label.trim() || null })),
        depositCents: g.deposit.trim() ? money(g.deposit, "Kaution der Fahrzeuggruppe") : null,
        km: g.km ? kmOf(g.km, "Kilometer der Fahrzeuggruppe") : null,
      })),
    },
    defaults: c.defaults,
  };
}

function metaOf(fd: FormData) {
  const n = String(fd.get("sortOrder") ?? "").trim();
  return { name: String(fd.get("name") ?? ""), code: String(fd.get("code") ?? "") || null, description: String(fd.get("description") ?? "") || null, sortOrder: /^-?\d{1,4}$/.test(n) ? Number(n) : 0 };
}

/** Standardtarif der Gruppen an die Auswahl angleichen (gesetzt, wo angehakt; aufgehoben, wo dieser Tarif Standard war und nicht mehr angehakt ist). */
async function applyDefaults(tenantId: string, actor: { id: string; name: string }, ratePlanId: string, defaults: string[]) {
  const groups = await db.vehicleGroup.findMany({ where: { tenantId }, select: { id: true, defaultRatePlanId: true } });
  for (const g of groups) {
    if (defaults.includes(g.id) && g.defaultRatePlanId !== ratePlanId) await setGroupDefaultRatePlan(tenantId, actor, g.id, ratePlanId);
    else if (!defaults.includes(g.id) && g.defaultRatePlanId === ratePlanId) await setGroupDefaultRatePlan(tenantId, actor, g.id, null);
  }
}

function revalidateTariffs(id?: string) {
  revalidatePath("/einstellungen/tarife");
  if (id) revalidatePath(`/einstellungen/tarife/${id}`);
  revalidatePath("/fahrzeuge/gruppen");
}

export async function createRatePlanAction(_prev: TariffFormState, formData: FormData): Promise<TariffFormState> {
  const { tenant, user } = await requireRole("OWNER");
  const actor = { id: user.id, name: user.name };
  let id: string;
  try {
    const { content, defaults } = parseContent(formData);
    const r = await createRatePlan(tenant.id, actor, { meta: metaOf(formData), content, active: formData.get("active") === "1", createKey: String(formData.get("createKey") ?? "") });
    id = r.id;
    if (r.created && formData.get("active") === "1") await applyDefaults(tenant.id, actor, id, defaults);
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  revalidateTariffs(id);
  redirect(`/einstellungen/tarife/${id}?gespeichert=1`);
}

export async function saveRatePlanAction(id: string, _prev: TariffFormState, formData: FormData): Promise<TariffFormState> {
  const { tenant, user } = await requireRole("OWNER");
  const actor = { id: user.id, name: user.name };
  let msg: string;
  try {
    const { content, defaults } = parseContent(formData);
    const meta = await updateRatePlanMeta(tenant.id, actor, id, metaOf(formData));
    const rev = await reviseRatePlan(tenant.id, actor, id, { content, expectedRevisionId: String(formData.get("expectedRevisionId") ?? ""), note: String(formData.get("note") ?? "") });
    const plan = await db.ratePlan.findFirst({ where: { id, tenantId: tenant.id }, select: { active: true } });
    if (plan?.active) await applyDefaults(tenant.id, actor, id, defaults);
    msg = rev.created ? `Gespeichert als Revision ${rev.revision}. Bestehende Buchungen und Verträge behalten ihren bisherigen Stand.` : meta.changed ? "Stammdaten gespeichert (Preise unverändert, keine neue Revision)." : "Keine Änderung.";
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  revalidateTariffs(id);
  return { ok: msg };
}

export async function setRatePlanActiveAction(id: string, active: boolean): Promise<void> {
  const { tenant, user } = await requireRole("OWNER");
  try {
    await setRatePlanActive(tenant.id, { id: user.id, name: user.name }, id, active);
  } catch (e) {
    if (e instanceof DomainError) redirect(`/einstellungen/tarife/${id}?fehler=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidateTariffs(id);
  redirect(`/einstellungen/tarife/${id}?gespeichert=1`);
}

export async function duplicateRatePlanAction(id: string, _prev: TariffFormState, formData: FormData): Promise<TariffFormState> {
  const { tenant, user } = await requireRole("OWNER");
  let newId: string;
  try {
    newId = (await duplicateRatePlan(tenant.id, { id: user.id, name: user.name }, id, { name: String(formData.get("name") ?? ""), createKey: String(formData.get("createKey") ?? "") })).id;
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  revalidateTariffs(newId);
  redirect(`/einstellungen/tarife/${newId}?kopie=1`);
}

/** Fahrzeugpreis je Tarif: nur abweichende Stufen (leer = wie Gruppe, „nicht angeboten“ möglich), optional Kaution/km. */
export async function setVehicleRateOverrideAction(vehicleId: string, ratePlanId: string, _prev: TariffFormState, formData: FormData): Promise<TariffFormState> {
  const { tenant, user } = await requireRole("OWNER");
  try {
    const tiers: { days: number; cents: number | null }[] = [];
    for (const [k, v] of formData.entries()) {
      const m = /^tier_(\d{1,4})$/.exec(k);
      if (!m) continue;
      const val = String(v).trim();
      if (formData.get(`off_${m[1]}`) === "1") tiers.push({ days: Number(m[1]), cents: null });
      else if (val) tiers.push({ days: Number(m[1]), cents: money(val, `Fahrzeugpreis ${m[1]} Tage`) });
    }
    const dep = String(formData.get("deposit") ?? "").trim();
    const kmMode = String(formData.get("kmMode") ?? "");
    const km = kmMode === "UNLIMITED" ? { policy: "UNLIMITED" as const, kmIncludedPerDay: null, extraKmRateCents: null } : kmMode === "FREE_KILOMETERS" ? { policy: "FREE_KILOMETERS" as const, kmIncludedPerDay: int(String(formData.get("kmIncludedPerDay") ?? ""), "Freikilometer je Tag"), extraKmRateCents: money(String(formData.get("extraKmRate") ?? ""), "Mehrkilometerpreis") } : null;
    const r = await setVehicleRateOverride(tenant.id, { id: user.id, name: user.name }, { vehicleId, ratePlanId, tiers, depositCents: dep ? money(dep, "Fahrzeugkaution") : null, km, note: String(formData.get("note") ?? "") || null });
    revalidatePath(`/fahrzeuge/${vehicleId}`);
    return { ok: r.changed ? "Fahrzeugpreis gespeichert. Gilt für neue Buchungen; bestehende behalten ihren Stand." : "Keine Änderung." };
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
}
