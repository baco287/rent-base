// Login-E-Mail eines bestehenden Benutzers kontrolliert ändern (administrativer Einzelfall, kein UI-Weg).
// Ändert ausschließlich User.email – User-ID, Passwort-Hash, Mandant, Rolle und Plattformrolle bleiben unverändert.
// Aus Sicherheitsgründen werden die Sitzungen genau dieses Benutzers beendet (neu anmelden mit neuer Adresse und
// bisherigem Passwort) und offene Passwort-Reset-Links, die noch an die alte Adresse gingen, laufen sofort ab.
// Keine Zugangsdaten in dieser Datei. Protokolliert als USER_EMAIL_CHANGED (alte/neue Adresse, keine Secrets).
// Aufruf:  node scripts/change-user-email.mjs
import { createInterface } from "node:readline";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

const users = await db.user.findMany({ where: { active: true }, include: { tenant: true }, orderBy: [{ tenant: { name: "asc" } }, { email: "asc" }] });
if (users.length === 0) {
  console.log("Keine aktiven Benutzer vorhanden.");
  process.exit(1);
}
console.log("Aktive Benutzer:");
users.forEach((u, i) => console.log(`  ${i + 1}) ${u.email}  ·  ${u.name}  ·  ${u.role}  ·  ${u.tenant.name}${u.platformRole === "SUPER_ADMIN" ? "  ·  SUPER_ADMIN" : ""}`));

const idx = parseInt(await ask("Nummer des Benutzers, dessen Login-E-Mail geändert werden soll: "), 10);
const user = users[idx - 1];
if (!user) { console.log("Ungültige Nummer."); process.exit(1); }

const newEmail = (await ask("Neue Login-E-Mail: ")).trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) { console.log("Ungültige E-Mail-Adresse."); process.exit(1); }
if (newEmail === user.email) { console.log("Die Adresse ist bereits gesetzt."); process.exit(0); }
const taken = await db.user.findFirst({ where: { email: { equals: newEmail, mode: "insensitive" } }, select: { id: true } });
const pending = await db.invitation.findFirst({ where: { email: { equals: newEmail, mode: "insensitive" }, status: "PENDING" }, select: { id: true } });
if (taken || pending) { console.log("Die neue Adresse wird bereits von einem Benutzer oder einer offenen Einladung verwendet. Nichts geändert."); process.exit(1); }

const confirm = await ask(`${user.email} → ${newEmail} (${user.name}, ${user.tenant.name}). Sitzungen dieses Benutzers werden beendet. Tippen Sie "ja" zum Bestätigen: `);
if (confirm.trim().toLowerCase() !== "ja") { console.log("Abgebrochen."); process.exit(1); }

const result = await db.$transaction(async (tx) => {
  // Nur ändern, wenn die alte Adresse noch unverändert ist (kein stilles Überschreiben einer parallelen Änderung).
  const updated = await tx.user.updateMany({ where: { id: user.id, email: user.email }, data: { email: newEmail } });
  if (updated.count !== 1) throw new Error("Benutzer wurde zwischenzeitlich geändert. Nichts geändert.");
  const sessions = await tx.session.deleteMany({ where: { userId: user.id } });
  const resetTokens = await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date() } });
  await tx.auditLog.create({ data: { tenantId: user.tenantId, action: "USER_EMAIL_CHANGED", details: { from: user.email, to: newEmail, sessionsEnded: sessions.count, resetLinksExpired: resetTokens.count, note: "per scripts/change-user-email.mjs geändert" }, userId: user.id, userName: user.name } });
  return { sessions: sessions.count, resetTokens: resetTokens.count };
});
console.log(`Login-E-Mail geändert: ${user.email} → ${newEmail}. Beendete Sitzungen: ${result.sessions}. Abgelaufene Reset-Links: ${result.resetTokens}. Anmeldung jetzt mit der neuen Adresse und dem bisherigen Passwort.`);
await db.$disconnect();
