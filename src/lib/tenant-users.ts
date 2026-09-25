// Befehl 20: Benutzerverwaltung innerhalb eines Mandanten (Einladen, Rolle ändern, Deaktivieren/Aktivieren).
// Ersetzt die frühere Direktanlage mit einem vom Inhaber vergebenen Passwort (item 15) durch dieselbe
// Einladungsmechanik wie bei der Mandantenanlage (lib/invitations.ts) – kein Parallelsystem.
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError } from "@/lib/integrity";
import type { Role } from "@/lib/constants";

/** Wirft, wenn der Benutzer der einzige aktive OWNER des Mandanten ist (item 28). Serverseitig vor dem DB-Trigger. */
export async function assertNotLastActiveOwner(tenantId: string, userId: string, what: string) {
  const target = await db.user.findFirst({ where: { id: userId, tenantId } });
  if (!target) throw new DomainError("Benutzer nicht gefunden.");
  if (target.role !== "OWNER" || !target.active) return;
  const otherActiveOwners = await db.user.count({ where: { tenantId, role: "OWNER", active: true, id: { not: userId } } });
  if (otherActiveOwners === 0) throw new DomainError(`Der letzte aktive Inhaber kann nicht ${what}. Bitte zuerst einen weiteren Inhaber hinzufügen.`);
}

export async function deactivateUser(actor: Actor, tenantId: string, userId: string): Promise<void> {
  if (userId === actor.id) throw new DomainError("Das eigene Konto kann nicht deaktiviert werden.");
  await assertNotLastActiveOwner(tenantId, userId, "deaktiviert werden");
  await db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new DomainError("Benutzer nicht gefunden.");
    await tx.user.update({ where: { id: userId }, data: { active: false } });
    await tx.session.deleteMany({ where: { userId } });
    await recordAudit(tx, tenantId, actor, { action: "USER_DEACTIVATED", details: { email: user.email } });
  });
}

export async function activateUser(actor: Actor, tenantId: string, userId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new DomainError("Benutzer nicht gefunden.");
    await tx.user.update({ where: { id: userId }, data: { active: true } });
    await recordAudit(tx, tenantId, actor, { action: "USER_ACTIVATED", details: { email: user.email } });
  });
}

/** Rollenänderung (item 30). Historische Aktionen (Audit, Prüfvermerke, Verträge) bleiben unverändert – sie zeigen die damalige Rolle als Snapshot, nicht die aktuelle. */
export async function changeUserRole(actor: Actor, tenantId: string, userId: string, newRole: Role): Promise<void> {
  if (userId === actor.id) throw new DomainError("Die eigene Rolle kann nicht selbst geändert werden.");
  await assertNotLastActiveOwner(tenantId, userId, "herabgestuft werden");
  await db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new DomainError("Benutzer nicht gefunden.");
    if (user.role === newRole) return;
    await tx.user.update({ where: { id: userId }, data: { role: newRole } });
    await recordAudit(tx, tenantId, actor, { action: "USER_ROLE_CHANGED", details: { email: user.email, from: user.role, to: newRole } });
  });
}
