"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { createSession, destroySession, hashPassword, verifyPassword } from "@/lib/auth";

export type AuthState = { error?: string } | undefined;

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail-Adresse eingeben."),
  password: z.string().min(1, "Bitte das Passwort eingeben."),
  weiter: z.string().optional(),
});

export async function loginAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { email, password, weiter } = parsed.data;

  const user = await db.user.findUnique({ where: { email } });
  // Gleiche Antwort bei unbekannter Adresse und falschem Passwort, damit man Konten nicht erraten kann.
  const ok = user && user.active && (await verifyPassword(password, user.passwordHash));
  if (!ok) return { error: "E-Mail oder Passwort stimmen nicht." };

  await createSession(user.id);
  redirect(weiter && weiter.startsWith("/") ? weiter : "/heute");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

const setupSchema = z.object({
  tenantName: z.string().trim().min(2, "Bitte den Firmennamen eingeben."),
  city: z.string().trim().optional(),
  name: z.string().trim().min(2, "Bitte deinen Namen eingeben."),
  email: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail-Adresse eingeben."),
  password: z.string().min(10, "Das Passwort braucht mindestens 10 Zeichen."),
});

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "vermietung";
}

/** Ersteinrichtung: legt den ersten Mandanten und den Inhaber an. Nur möglich, solange kein Mandant existiert. */
export async function setupAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const existing = await db.tenant.count();
  if (existing > 0) return { error: "Die Einrichtung wurde bereits abgeschlossen. Bitte anmelden." };

  const parsed = setupSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { tenantName, city, name, email, password } = parsed.data;

  const passwordHash = await hashPassword(password);
  const user = await db.user.create({
    data: {
      email,
      name,
      passwordHash,
      role: "OWNER",
      tenant: { create: { name: tenantName, slug: slugify(tenantName), city: city || null } },
    },
  });

  await createSession(user.id);
  redirect("/heute");
}
