"use server";

// RentBase Control Center: jede Aktion ruft zuerst requirePlatform(<Berechtigung>) auf – die Berechtigungsmatrix in
// lib/constants.ts entscheidet, welche interne Rolle was darf. Nie nur die Oberfläche. Kritische Aktionen (Sperren,
// Supportmodus, Feature/Tarif/Rolle ändern) protokollieren über die Bibliotheken in derselben Transaktion.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { cookies } from "next/headers";
import { requirePlatform } from "@/lib/platform-auth";
import { createTenantByPlatform, reactivateTenant, suspendTenant } from "@/lib/platform-tenants";
import { resendInvitation, revokeInvitation } from "@/lib/invitations";
import { startSupportSession, endSupportSession } from "@/lib/support-sessions";
import { platformActivateUser, platformDeactivateUser, setPlatformRole } from "@/lib/platform-users";
import { setTenantFeature } from "@/lib/features";
import { upsertSubscription } from "@/lib/subscriptions";
import { DomainError } from "@/lib/integrity";
import { requestBaseUrl } from "@/lib/request-url";
import { db } from "@/lib/db";
import { SUPPORT_COOKIE, SESSION_DAYS, PLANS, PLATFORM_ROLES, SUBSCRIPTION_STATUS, isFeatureKey, type PlanKey, type PlatformRole, type SubscriptionStatus } from "@/lib/constants";

export type AdminState = { error?: string; ok?: string } | undefined;

const actorOf = (user: { id: string; name: string }) => ({ id: user.id, name: user.name });
const refresh = () => revalidatePath("/admin", "layout");

async function run(fn: () => Promise<string>): Promise<AdminState> {
  try {
    const ok = await fn();
    refresh();
    return { ok };
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
}

const createTenantSchema = z.object({
  companyName: z.string().trim().min(2, "Bitte den Firmennamen angeben."),
  ownerFirstName: z.string().trim().min(1, "Bitte den Vornamen des Inhabers angeben."),
  ownerLastName: z.string().trim().min(1, "Bitte den Nachnamen des Inhabers angeben."),
  ownerEmail: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail-Adresse angeben."),
  note: z.string().trim().max(2000).optional(),
});

/** Neue Autovermietung anlegen (item 13/14): Mandant + Einladung an den ersten Inhaber. */
export async function createTenantAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform("TENANT_CREATE");
  const parsed = createTenantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  let tenantId: string;
  try {
    const tenant = await createTenantByPlatform(actorOf(user), { ...parsed.data, baseUrl: await requestBaseUrl() });
    tenantId = tenant.id;
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  refresh();
  redirect(`/admin/mandanten/${tenantId}`);
}

const suspendSchema = z.object({ tenantId: z.string(), reason: z.string().trim().min(5, "Bitte einen Grund angeben."), confirm: z.literal("SPERREN", { message: "Bitte zur Bestätigung SPERREN eintippen." }) });

/** Mandant sperren: Pflichtgrund + ausdrückliche Bestätigung; beendet alle Sitzungen des Mandanten; keine Daten werden gelöscht. */
export async function suspendTenantAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform("TENANT_SUSPEND");
  const parsed = suspendSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  return run(async () => {
    await suspendTenant(actorOf(user), parsed.data.tenantId, parsed.data.reason);
    return "Mandant gesperrt.";
  });
}

export async function reactivateTenantAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform("TENANT_SUSPEND");
  const tenantId = String(formData.get("tenantId") ?? "");
  return run(async () => {
    await reactivateTenant(actorOf(user), tenantId);
    return "Mandant freigegeben.";
  });
}

export async function resendOwnerInvitationAction(tenantId: string, invitationId: string) {
  const { user } = await requirePlatform("USER_MANAGE");
  await resendInvitation(tenantId, actorOf(user), invitationId, await requestBaseUrl());
  refresh();
}

export async function revokeOwnerInvitationAction(tenantId: string, invitationId: string) {
  const { user } = await requirePlatform("USER_MANAGE");
  await revokeInvitation(tenantId, actorOf(user), invitationId);
  refresh();
}

/** Einladung erneut senden (Benutzerverwaltung): neuer Token, alter wird ungültig. */
export async function resendInvitationPlatformAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform("USER_MANAGE");
  const tenantId = String(formData.get("tenantId") ?? "");
  const invitationId = String(formData.get("invitationId") ?? "");
  return run(async () => {
    await resendInvitation(tenantId, actorOf(user), invitationId, await requestBaseUrl());
    return "Einladung erneut gesendet.";
  });
}

const startSupportSchema = z.object({ tenantId: z.string(), reason: z.string().trim().min(5, "Bitte einen Grund angeben."), confirm: z.literal("on", { message: "Bitte bestätigen, dass der Zugriff protokolliert wird." }) });

/** Startet den Supportmodus („als Kunde öffnen“, read-only): eigener Cookie, unabhängig von der Anmeldesitzung. */
export async function startSupportSessionAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform("SUPPORT_SESSION");
  const parsed = startSupportSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  let sessionId: string;
  try {
    const session = await startSupportSession(actorOf(user), parsed.data.tenantId, parsed.data.reason);
    sessionId = session.id;
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  const cookieStore = await cookies();
  cookieStore.set(SUPPORT_COOKIE, sessionId, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 24 * 60 * 60 });
  redirect("/heute");
}

/** Beendet den Supportmodus und kehrt zur Mandantenseite zurück. */
export async function endSupportSessionAction() {
  const { user, supportSession } = await requirePlatform();
  if (supportSession) await endSupportSession(actorOf(user), supportSession.id);
  const cookieStore = await cookies();
  cookieStore.delete(SUPPORT_COOKIE);
  refresh();
  redirect(supportSession ? `/admin/mandanten/${supportSession.tenantId}` : "/admin/mandanten");
}

/** Benutzer sperren (deaktivieren, beendet Sitzungen) oder entsperren. Dieselben Schutzregeln wie für den Inhaber. */
export async function toggleUserActiveAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform("USER_MANAGE");
  const userId = String(formData.get("userId") ?? "");
  const activate = formData.get("active") === "1";
  if (!activate && formData.get("confirm") !== "on") return { error: "Bitte bestätigen, dass der Benutzer gesperrt und seine Sitzungen beendet werden." };
  return run(async () => {
    if (activate) await platformActivateUser(actorOf(user), userId);
    else await platformDeactivateUser(actorOf(user), userId);
    return activate ? "Benutzer entsperrt." : "Benutzer gesperrt.";
  });
}

const roleSchema = z.object({
  userId: z.string().optional(),
  email: z.string().trim().toLowerCase().optional(),
  role: z.string().refine((r): r is PlatformRole => r in PLATFORM_ROLES, "Unbekannte Plattformrolle."),
  confirm: z.literal("on", { message: "Bitte die Änderung der internen Rolle bestätigen." }),
});

/** Interne Plattformrolle vergeben oder entziehen (nur SUPER_ADMIN). */
export async function setPlatformRoleAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform("PLATFORM_ROLE_MANAGE");
  const parsed = roleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  return run(async () => {
    let userId = parsed.data.userId;
    if (!userId) {
      if (!parsed.data.email) throw new DomainError("Bitte die E-Mail-Adresse eines bestehenden Kontos angeben.");
      const target = await db.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } });
      if (!target) throw new DomainError("Zu dieser E-Mail-Adresse gibt es kein Konto. Interne Konten entstehen über eine normale Einladung in einen Mandanten (in der Regel den Betreiber-Mandanten).");
      userId = target.id;
    }
    const { changed } = await setPlatformRole(actorOf(user), userId, parsed.data.role as PlatformRole);
    return changed ? `Plattformrolle gesetzt: ${PLATFORM_ROLES[parsed.data.role as PlatformRole]}.` : "Plattformrolle war bereits gesetzt.";
  });
}

const featureSchema = z.object({ tenantId: z.string(), key: z.string().refine(isFeatureKey, "Unbekanntes Feature."), enabled: z.enum(["0", "1"]), note: z.string().trim().max(500).optional() });

/** Feature für einen Mandanten freischalten oder sperren (nur SUPER_ADMIN). */
export async function setFeatureAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform("FEATURE_MANAGE");
  const parsed = featureSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  return run(async () => {
    const { changed } = await setTenantFeature(actorOf(user), parsed.data.tenantId, parsed.data.key, parsed.data.enabled === "1", parsed.data.note);
    return changed ? (parsed.data.enabled === "1" ? "Feature freigeschaltet." : "Feature gesperrt.") : "Keine Änderung.";
  });
}

const optionalDate = z.string().trim().optional().transform((v) => (v ? new Date(`${v}T12:00:00`) : null));
const optionalInt = z.string().trim().optional().transform((v, ctx) => {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n)) { ctx.addIssue({ code: "custom", message: "Bitte eine ganze Zahl angeben." }); return z.NEVER; }
  return n;
});
const subscriptionSchema = z.object({
  tenantId: z.string(),
  plan: z.string().refine((p): p is PlanKey => p in PLANS, "Unbekannter Tarif."),
  status: z.string().refine((s): s is SubscriptionStatus => s in SUBSCRIPTION_STATUS, "Unbekannter Abo-Status."),
  startedAt: optionalDate,
  trialEndsAt: optionalDate,
  cancelledAt: optionalDate,
  endsAt: optionalDate,
  monthlyPriceEur: z.string().trim().optional().transform((v, ctx) => {
    if (!v) return null;
    const n = Number(v.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { ctx.addIssue({ code: "custom", message: "Monatspreis: bitte einen Betrag ab 0 angeben." }); return z.NEVER; }
    return Math.round(n * 100);
  }),
  maxUsers: optionalInt,
  maxVehicles: optionalInt,
  note: z.string().trim().max(2000).optional(),
});

/** Tarif/Abo eines Mandanten anlegen oder ändern (SUPER_ADMIN, BILLING_ADMIN). */
export async function saveSubscriptionAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform("BILLING_MANAGE");
  const parsed = subscriptionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  return run(async () => {
    await upsertSubscription(actorOf(user), d.tenantId, { plan: d.plan as PlanKey, status: d.status as SubscriptionStatus, startedAt: d.startedAt, trialEndsAt: d.trialEndsAt, cancelledAt: d.cancelledAt, endsAt: d.endsAt, monthlyPriceCents: d.monthlyPriceEur, maxUsers: d.maxUsers, maxVehicles: d.maxVehicles, note: d.note });
    return "Tarif/Abo gespeichert.";
  });
}
