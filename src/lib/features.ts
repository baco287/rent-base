// Control Center: Feature-Freischaltungen je Mandant. Registry und Standardwerte stehen in FEATURES (lib/constants.ts);
// hier liegt nur die Auswertung und die protokollierte Änderung. Kein Eintrag = Standardwert, damit Bestandsmandanten
// sich exakt wie vor der Einführung verhalten. Durchsetzung an den Einstiegspunkten der Module:
//   Seiten/Server Actions  -> requireFeature(key)          (lib/auth.ts, request-gebunden)
//   API-Routen             -> featureForApi(session, key)  (lib/auth.ts)
//   Bibliotheken/Tests     -> assertFeature(tenantId, key)
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError } from "@/lib/integrity";
import { FEATURES, FEATURE_KEYS, type FeatureKey } from "@/lib/constants";

export type FeatureState = Record<FeatureKey, boolean>;
type Db = Prisma.TransactionClient | typeof db;

/** Standardzustand ohne jede Mandanteneinstellung. */
export function defaultFeatureState(): FeatureState {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, FEATURES[k].defaultEnabled])) as FeatureState;
}

/** Wirksamer Zustand aus gespeicherten Zeilen (unbekannte Schlüssel älterer Versionen werden ignoriert). */
export function featureStateFrom(rows: readonly { key: string; enabled: boolean }[]): FeatureState {
  const state = defaultFeatureState();
  for (const r of rows) if (r.key in state) state[r.key as FeatureKey] = r.enabled;
  return state;
}

/** Wirksamer Feature-Zustand eines Mandanten. */
export async function tenantFeatures(tenantId: string, client: Db = db): Promise<FeatureState> {
  const rows = await client.tenantFeatureFlag.findMany({ where: { tenantId }, select: { key: true, enabled: true } });
  return featureStateFrom(rows);
}

export async function isFeatureEnabled(tenantId: string, key: FeatureKey, client: Db = db): Promise<boolean> {
  const row = await client.tenantFeatureFlag.findUnique({ where: { tenantId_key: { tenantId, key } }, select: { enabled: true } });
  return row ? row.enabled : FEATURES[key].defaultEnabled;
}

export function featureDisabledMessage(key: FeatureKey): string {
  return `Die Funktion „${FEATURES[key].label}“ ist für diesen Mandanten nicht freigeschaltet.`;
}

/** Wirft, wenn das Feature für den Mandanten gesperrt ist (für Bibliotheken und Tests; Seiten nutzen requireFeature). */
export async function assertFeature(tenantId: string, key: FeatureKey, client: Db = db): Promise<void> {
  if (!(await isFeatureEnabled(tenantId, key, client))) throw new DomainError(featureDisabledMessage(key));
}

/** Sidebar-Pfade, die für diesen Zustand ausgeblendet werden. */
export function hiddenNavPaths(state: FeatureState): string[] {
  return FEATURE_KEYS.filter((k) => !state[k]).flatMap((k) => [...FEATURES[k].nav]);
}

/**
 * Feature für einen Mandanten freischalten oder sperren. Protokolliert vorher/nachher; ein unveränderter Zustand wird
 * nicht protokolliert. Nur aus requirePlatform("FEATURE_MANAGE")-geschützten Aufrufern verwenden.
 */
export async function setTenantFeature(actor: Actor, tenantId: string, key: FeatureKey, enabled: boolean, note?: string | null): Promise<{ changed: boolean }> {
  const trimmedNote = note?.trim() || null;
  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw new DomainError("Mandant nicht gefunden.");
    const before = await isFeatureEnabled(tenantId, key, tx);
    if (before === enabled) return { changed: false };
    await tx.tenantFeatureFlag.upsert({
      where: { tenantId_key: { tenantId, key } },
      create: { tenantId, key, enabled, note: trimmedNote, updatedById: actor.id, updatedByName: actor.name },
      update: { enabled, note: trimmedNote, updatedById: actor.id, updatedByName: actor.name },
    });
    await recordAudit(tx, tenantId, actor, { action: enabled ? "FEATURE_ENABLED" : "FEATURE_DISABLED", details: { feature: key, label: FEATURES[key].label, note: trimmedNote, before: { enabled: before }, after: { enabled } } });
    return { changed: true };
  });
}

export type FeatureMatrixRow = {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  state: FeatureState;
  overrides: Partial<Record<FeatureKey, { note: string | null; updatedAt: Date; updatedByName: string | null }>>;
};

/** Alle Mandanten mit wirksamem Feature-Zustand (für /admin/features). */
export async function featureMatrix(opts: { query?: string } = {}): Promise<{ rows: FeatureMatrixRow[]; counts: Record<FeatureKey, { enabled: number; disabled: number }> }> {
  const q = opts.query?.trim();
  const tenants = await db.tenant.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }] } : {},
    orderBy: { name: "asc" },
    select: { id: true, name: true, status: true, featureFlags: { select: { key: true, enabled: true, note: true, updatedAt: true, updatedByName: true } } },
  });
  const counts = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { enabled: 0, disabled: 0 }])) as Record<FeatureKey, { enabled: number; disabled: number }>;
  const rows = tenants.map((t) => {
    const state = featureStateFrom(t.featureFlags);
    for (const k of FEATURE_KEYS) counts[k][state[k] ? "enabled" : "disabled"]++;
    const overrides: FeatureMatrixRow["overrides"] = {};
    for (const f of t.featureFlags) if (f.key in state) overrides[f.key as FeatureKey] = { note: f.note, updatedAt: f.updatedAt, updatedByName: f.updatedByName };
    return { tenantId: t.id, tenantName: t.name, tenantStatus: t.status, state, overrides };
  });
  return { rows, counts };
}
