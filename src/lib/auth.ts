import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { SESSION_COOKIE, SESSION_DAYS, type Role } from "@/lib/constants";

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

/** Legt eine Sitzung an und setzt das Cookie. */
export async function createSession(userId: string) {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.session.create({ data: { id, userId, expiresAt } });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const cookieStore = await cookies();
  const id = cookieStore.get(SESSION_COOKIE)?.value;
  if (id) {
    await db.session.deleteMany({ where: { id } });
  }
  cookieStore.delete(SESSION_COOKIE);
}

/**
 * Liest die aktuelle Sitzung. Pro Request nur einmal aus der Datenbank (React cache).
 * Gibt null zurück, wenn nicht angemeldet oder die Sitzung abgelaufen ist.
 */
export const getSession = cache(async () => {
  const cookieStore = await cookies();
  const id = cookieStore.get(SESSION_COOKIE)?.value;
  if (!id) return null;

  const session = await db.session.findUnique({
    where: { id },
    include: { user: { include: { tenant: true } } },
  });
  if (!session) return null;
  if (session.expiresAt < new Date() || !session.user.active) {
    await db.session.delete({ where: { id } }).catch(() => {});
    return null;
  }
  const { tenant, ...user } = session.user;
  return { user, tenant };
});

/** Für geschützte Seiten: leitet zum Login um, wenn keine Sitzung besteht. */
export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** Zusätzlich Rollenprüfung. Inhaber darf alles. */
export async function requireRole(...roles: Role[]) {
  const session = await requireSession();
  const role = session.user.role as Role;
  if (role !== "OWNER" && !roles.includes(role)) redirect("/heute?fehler=rechte");
  return session;
}
