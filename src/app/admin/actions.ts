"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlatform } from "@/lib/platform-auth";
import { createTenantByPlatform, reactivateTenant, suspendTenant } from "@/lib/platform-tenants";
import { resendInvitation, revokeInvitation } from "@/lib/invitations";
import { startSupportSession, endSupportSession } from "@/lib/support-sessions";
import { DomainError } from "@/lib/integrity";
import { requestBaseUrl } from "@/lib/request-url";
import { SUPPORT_COOKIE, SESSION_DAYS } from "@/lib/constants";
import { cookies } from "next/headers";

export type AdminState = { error?: string; ok?: string } | undefined;

const createTenantSchema = z.object({
  companyName: z.string().trim().min(2, "Bitte den Firmennamen angeben."),
  ownerFirstName: z.string().trim().min(1, "Bitte den Vornamen des Inhabers angeben."),
  ownerLastName: z.string().trim().min(1, "Bitte den Nachnamen des Inhabers angeben."),
  ownerEmail: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail-Adresse angeben."),
  note: z.string().trim().max(2000).optional(),
});

/** Neue Autovermietung anlegen (item 13/14): Mandant + Einladung an den ersten Inhaber. */
export async function createTenantAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform();
  const parsed = createTenantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  let tenantId: string;
  try {
    const tenant = await createTenantByPlatform({ id: user.id, name: user.name }, { ...parsed.data, baseUrl: await requestBaseUrl() });
    tenantId = tenant.id;
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  redirect(`/admin/mandanten/${tenantId}`);
}

const suspendSchema = z.object({ tenantId: z.string(), reason: z.string().trim().min(5, "Bitte einen Grund angeben.") });

export async function suspendTenantAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform();
  const parsed = suspendSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    await suspendTenant({ id: user.id, name: user.name }, parsed.data.tenantId, parsed.data.reason);
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/admin/mandanten/${parsed.data.tenantId}`);
  return { ok: "Mandant gesperrt." };
}

export async function reactivateTenantAction(tenantId: string) {
  const { user } = await requirePlatform();
  await reactivateTenant({ id: user.id, name: user.name }, tenantId);
  revalidatePath(`/admin/mandanten/${tenantId}`);
}

export async function resendOwnerInvitationAction(tenantId: string, invitationId: string) {
  const { user } = await requirePlatform();
  await resendInvitation(tenantId, { id: user.id, name: user.name }, invitationId, await requestBaseUrl());
  revalidatePath(`/admin/mandanten/${tenantId}`);
}

export async function revokeOwnerInvitationAction(tenantId: string, invitationId: string) {
  const { user } = await requirePlatform();
  await revokeInvitation(tenantId, { id: user.id, name: user.name }, invitationId);
  revalidatePath(`/admin/mandanten/${tenantId}`);
}

const startSupportSchema = z.object({ tenantId: z.string(), reason: z.string().trim().min(5, "Bitte einen Grund angeben.") });

/** Startet den Supportmodus (item 33/34): eigener Cookie, unabhängig von der Anmeldesitzung. */
export async function startSupportSessionAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const { user } = await requirePlatform();
  const parsed = startSupportSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  let sessionId: string;
  try {
    const session = await startSupportSession({ id: user.id, name: user.name }, parsed.data.tenantId, parsed.data.reason);
    sessionId = session.id;
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  const cookieStore = await cookies();
  cookieStore.set(SUPPORT_COOKIE, sessionId, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 24 * 60 * 60 });
  redirect("/heute");
}

/** Beendet den Supportmodus und kehrt zur Mandantenübersicht zurück (item 34). */
export async function endSupportSessionAction() {
  const { user, supportSession } = await requirePlatform();
  if (supportSession) await endSupportSession({ id: user.id, name: user.name }, supportSession.id);
  const cookieStore = await cookies();
  cookieStore.delete(SUPPORT_COOKIE);
  redirect(supportSession ? `/admin/mandanten/${supportSession.tenantId}` : "/admin/mandanten");
}
