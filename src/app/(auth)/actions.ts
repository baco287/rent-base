"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { createSession, destroySession, hashPassword, verifyPassword } from "@/lib/auth";
import { consume, hashKeyPart, LOGIN_LIMIT_PER_ACCOUNT, LOGIN_LIMIT_PER_ADDRESS, reset } from "@/lib/rate-limit";
import { slugify } from "@/lib/slug";
import { acceptInvitation } from "@/lib/invitations";
import { completePasswordReset, requestPasswordReset } from "@/lib/password-reset";
import { requestBaseUrl } from "@/lib/request-url";
import { DomainError } from "@/lib/integrity";

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

  // Anmeldebremse ohne Redis (prozesslokal): je Konto und je Absenderadresse; Schlüssel gehasht, keine Klartextadresse im Speicher.
  const h = await headers();
  const address = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "unbekannt").split(",")[0].trim();
  const accountKey = `login:konto:${hashKeyPart(email)}`;
  const addressKey = `login:adresse:${hashKeyPart(address)}`;
  const byAccount = consume(accountKey, LOGIN_LIMIT_PER_ACCOUNT);
  const byAddress = consume(addressKey, LOGIN_LIMIT_PER_ADDRESS);
  if (!byAccount.allowed || !byAddress.allowed) return { error: "Zu viele Anmeldeversuche. Bitte in einigen Minuten erneut versuchen." };

  const user = await db.user.findUnique({ where: { email }, include: { tenant: { select: { status: true } } } });
  // Gleiche Antwort bei unbekannter Adresse und falschem Passwort, damit man Konten nicht erraten kann.
  const ok = user && user.active && (await verifyPassword(password, user.passwordHash));
  if (!ok) return { error: "E-Mail oder Passwort stimmen nicht." };

  reset(accountKey);
  await createSession(user.id);
  if (weiter && weiter.startsWith("/")) redirect(weiter);
  // Befehl 20, item 75: gesperrter Mandant landet klar auf der Sperrseite statt auf einem leeren Dashboard;
  // ein SUPER_ADMIN ohne eigenen Tenant-Kontext (kein weiter-Link) landet auf dem Plattformdashboard.
  if (user.tenant.status === "SUSPENDED") redirect("/gesperrt");
  redirect(user.platformRole === "SUPER_ADMIN" ? "/admin" : "/heute");
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
  setupKey: z.string().optional(),
});

/** Ersteinrichtung: legt den ersten Mandanten und den Inhaber an. Nur möglich, solange kein Mandant existiert. */
export async function setupAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const existing = await db.tenant.count();
  if (existing > 0) return { error: "Die Einrichtung wurde bereits abgeschlossen. Bitte anmelden." };

  const parsed = setupSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { tenantName, city, name, email, password, setupKey } = parsed.data;

  // Auf dem Server schützt SETUP_KEY die Ersteinrichtung: ohne den Schlüssel kann niemand Inhaber werden.
  const requiredKey = process.env.SETUP_KEY;
  if (requiredKey && setupKey !== requiredKey) return { error: "Der Einrichtungsschlüssel stimmt nicht." };

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

const acceptInvitationSchema = z.object({
  token: z.string().min(10),
  name: z.string().trim().min(2, "Bitte Ihren Namen eingeben."),
  password: z.string().min(10, "Das Passwort braucht mindestens 10 Zeichen."),
  passwordRepeat: z.string(),
});

/** Einladung annehmen: legt das Konto an und meldet sofort an (item 19). */
export async function acceptInvitationAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = acceptInvitationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { token, name, password, passwordRepeat } = parsed.data;
  if (password !== passwordRepeat) return { error: "Die Passwörter stimmen nicht überein." };
  let userId: string;
  try {
    ({ userId } = await acceptInvitation(token, { name, password }));
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  await createSession(userId);
  redirect("/heute");
}

const requestResetSchema = z.object({ email: z.string().trim().toLowerCase().email("Bitte eine gültige E-Mail-Adresse eingeben.") });

/** Passwort vergessen: immer dieselbe neutrale Antwort, unabhängig davon, ob die Adresse existiert (item 22). */
export type RequestResetState = AuthState | { ok: true };

export async function requestPasswordResetAction(_prev: RequestResetState, formData: FormData): Promise<RequestResetState> {
  const parsed = requestResetSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const h = await headers();
  const address = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "unbekannt").split(",")[0].trim();
  const addressKey = `reset:adresse:${hashKeyPart(address)}`;
  if (!consume(addressKey, LOGIN_LIMIT_PER_ADDRESS).allowed) return { ok: true }; // neutral, auch bei zu vielen Anfragen
  await requestPasswordReset(parsed.data.email, await requestBaseUrl());
  return { ok: true };
}

const completeResetSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(10, "Das Passwort braucht mindestens 10 Zeichen."),
  passwordRepeat: z.string(),
});

/** Setzt das neue Passwort und meldet an; bestehende Sitzungen wurden bereits beendet (item 21/23). */
export async function completePasswordResetAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = completeResetSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { token, password, passwordRepeat } = parsed.data;
  if (password !== passwordRepeat) return { error: "Die Passwörter stimmen nicht überein." };
  let userId: string;
  try {
    ({ userId } = await completePasswordReset(token, password));
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  await createSession(userId);
  redirect("/heute");
}
