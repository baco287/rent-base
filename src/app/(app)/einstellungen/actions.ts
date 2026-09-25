"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ROLES, type Role } from "@/lib/constants";
import { createInvitation, resendInvitation, revokeInvitation } from "@/lib/invitations";
import { activateUser, changeUserRole, deactivateUser } from "@/lib/tenant-users";
import { requestBaseUrl } from "@/lib/request-url";
import { DomainError } from "@/lib/integrity";

export type FormState = { error?: string; ok?: string } | undefined;

const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const tenantSchema = z.object({
  name: z.string().trim().min(2, "Bitte den Firmennamen eingeben."),
  street: optStr,
  zip: optStr,
  city: optStr,
  phone: optStr,
  email: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().toLowerCase().email("Die E-Mail-Adresse ist ungültig.").optional()),
  // Befehl 20.5: optionale Website für Briefkopf/Branding; ohne Schema wird https:// ergänzt
  website: z.preprocess(
    (v) => (typeof v !== "string" || v.trim() === "" ? undefined : /^https?:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`),
    z.string().max(200, "Die Website-Adresse ist zu lang.").url("Die Website-Adresse ist ungültig.").refine((u) => /^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u), "Die Website-Adresse ist ungültig.").optional(),
  ),
});

export async function updateTenantAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("OWNER");
  const parsed = tenantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  await db.tenant.update({
    where: { id: tenant.id },
    data: { name: d.name, street: d.street ?? null, zip: d.zip ?? null, city: d.city ?? null, phone: d.phone ?? null, email: d.email ?? null, website: d.website ?? null },
  });
  revalidatePath("/", "layout");
  return { ok: "Firmendaten gespeichert." };
}

const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail-Adresse eingeben."),
  role: z.enum(Object.keys(ROLES) as [string, ...string[]]),
});

/** Lädt einen Mitarbeiter per E-Mail ein (Befehl 20, item 15/27): kein vom Inhaber vergebenes Passwort mehr. */
export async function inviteUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant, user: me } = await requireRole("OWNER");
  const parsed = inviteUserSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  try {
    await createInvitation(tenant.id, { id: me.id, name: me.name }, { email: d.email, role: d.role as Role, baseUrl: await requestBaseUrl() });
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  revalidatePath("/einstellungen");
  return { ok: `Einladung an ${d.email} gesendet.` };
}

export async function resendInvitationAction(invitationId: string) {
  const { tenant, user: me } = await requireRole("OWNER");
  await resendInvitation(tenant.id, { id: me.id, name: me.name }, invitationId, await requestBaseUrl());
  revalidatePath("/einstellungen");
}

export async function revokeInvitationAction(invitationId: string) {
  const { tenant, user: me } = await requireRole("OWNER");
  await revokeInvitation(tenant.id, { id: me.id, name: me.name }, invitationId);
  revalidatePath("/einstellungen");
}

export async function toggleUserActiveAction(userId: string) {
  const { tenant, user: me } = await requireRole("OWNER");
  if (userId === me.id) redirect("/einstellungen?fehler=selbst");
  const u = await db.user.findFirst({ where: { id: userId, tenantId: tenant.id } });
  if (!u) redirect("/einstellungen");
  try {
    if (u.active) await deactivateUser({ id: me.id, name: me.name }, tenant.id, userId);
    else await activateUser({ id: me.id, name: me.name }, tenant.id, userId);
  } catch (e) {
    if (e instanceof DomainError) redirect(`/einstellungen?fehler=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidatePath("/einstellungen");
  redirect("/einstellungen");
}

export async function changeUserRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant, user: me } = await requireRole("OWNER");
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!Object.keys(ROLES).includes(role)) return { error: "Ungültige Rolle." };
  try {
    await changeUserRole({ id: me.id, name: me.name }, tenant.id, userId, role as Role);
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  revalidatePath("/einstellungen");
  return { ok: "Rolle geändert." };
}

const optInt = z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.coerce.number().int().min(0).max(365).optional());
const optRate = z.preprocess((v) => (v === "" || v === undefined ? undefined : typeof v === "string" ? v.replace(",", ".") : v), z.coerce.number().min(0, "Der Steuersatz liegt zwischen 0 und 100.").max(100, "Der Steuersatz liegt zwischen 0 und 100.").optional());
const invoiceSettingsSchema = z.object({
  legalForm: optStr,
  country: z.string().trim().length(2, "Land als Zweibuchstaben-Kürzel, z. B. DE.").toUpperCase(),
  vatId: optStr,
  taxNumber: optStr,
  bankName: optStr,
  iban: z.preprocess((v) => (typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : v), z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/, "Die IBAN ist ungültig.").optional())),
  bic: z.preprocess((v) => (typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : v), z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, "Die BIC ist ungültig.").optional())),
  invoiceFooter: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().max(2000).optional()),
  paymentTermDays: optInt,
  defaultTaxRate: optRate,
  pricesIncludeTax: z.enum(["", "true", "false"]).optional(),
  taxNote: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().max(1000).optional()),
});

/** Rechnungsdaten und Steuerkonfiguration. Abgeschlossene Rechnungen behalten ihre eingefrorenen Firmendaten. */
export async function updateInvoiceSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { tenant } = await requireRole("OWNER");
  const parsed = invoiceSettingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  await db.tenant.update({
    where: { id: tenant.id },
    data: {
      legalForm: d.legalForm ?? null, country: d.country, vatId: d.vatId ?? null, taxNumber: d.taxNumber ?? null,
      bankName: d.bankName ?? null, iban: d.iban ?? null, bic: d.bic ?? null, invoiceFooter: d.invoiceFooter ?? null,
      paymentTermDays: d.paymentTermDays ?? null, defaultTaxRate: d.defaultTaxRate ?? null,
      pricesIncludeTax: d.pricesIncludeTax === "true" ? true : d.pricesIncludeTax === "false" ? false : null,
      taxNote: d.taxNote ?? null,
    },
  });
  revalidatePath("/einstellungen");
  return { ok: "Rechnungsdaten gespeichert. Sie gelten für alle Rechnungen, die ab jetzt abgeschlossen werden." };
}
