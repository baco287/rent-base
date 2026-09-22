import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { SESSION_COOKIE, SESSION_DAYS, roleAllows, type Role } from "@/lib/constants";

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
  if (!session) redirect("/login?abgelaufen=1");
  return session;
}

/**
 * Rollenmatrix (nur hier und in den Aufrufen von requireRole):
 *   OWNER  alles
 *   DISPO  Buchungen anlegen/ändern/stornieren, Fahrzeuge und Gruppen, Mietverträge erstellen/bearbeiten/abschließen,
 *          Übergabe und Rückgabe, Kunden, Dokumente, E-Mail erneut senden
 *   YARD   Kunden anlegen und ergänzen, Übergabe und Rückgabe (Kilometer, Tank, Schäden, Fotos, Checkliste,
 *          Unterschriften, Zusatzkosten), Verträge und Protokolle ansehen, Dokumente, E-Mail erneut senden.
 *          Keine Buchungen, keine Vertragsänderungen, kein Vertragsabschluss, keine Einstellungen.
 */
/** Zusätzlich Rollenprüfung. Inhaber darf alles. Jede Server Action und jede geschützte Seite ruft dies als Erstes auf. */
export async function requireRole(...roles: Role[]) {
  const session = await requireSession();
  if (!roleAllows(session.user.role, roles)) redirect("/heute?fehler=rechte");
  return session;
}
