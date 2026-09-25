// Befehl 20, item 5/98: bestehenden Benutzer zum SUPER_ADMIN machen. Kein UI-Weg, keine Selbstregistrierung,
// keine Zugangsdaten in dieser Datei oder im Git-Verlauf – der Benutzer muss bereits existieren und sich
// bereits mit seinem eigenen Passwort anmelden können. Dieses Skript ändert nur die Plattformrolle.
// Aufruf:  node scripts/promote-super-admin.mjs
// Zeigt alle aktiven Benutzer, fragt nach Nummer und einer ausdrücklichen Bestätigung.
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
users.forEach((u, i) => console.log(`  ${i + 1}) ${u.email}  ·  ${u.name}  ·  ${u.role}  ·  ${u.tenant.name}${u.platformRole === "SUPER_ADMIN" ? "  (bereits SUPER_ADMIN)" : ""}`));

const idx = parseInt(await ask("Nummer des Benutzers, der SUPER_ADMIN werden soll: "), 10);
const user = users[idx - 1];
if (!user) { console.log("Ungültige Nummer."); process.exit(1); }
if (user.platformRole === "SUPER_ADMIN") { console.log(`${user.email} ist bereits SUPER_ADMIN.`); process.exit(0); }

const confirm = await ask(`${user.email} (${user.tenant.name}) wird SUPER_ADMIN der RentBase-Plattform. Tippen Sie "ja" zum Bestätigen: `);
if (confirm.trim().toLowerCase() !== "ja") { console.log("Abgebrochen."); process.exit(1); }

await db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_platform_role_change = 'on'`);
  await tx.user.update({ where: { id: user.id }, data: { platformRole: "SUPER_ADMIN" } });
  await tx.auditLog.create({ data: { tenantId: user.tenantId, action: "SUPER_ADMIN_GRANTED", details: { note: "per scripts/promote-super-admin.mjs gesetzt" }, userId: user.id, userName: user.name } });
});
console.log(`${user.email} ist jetzt SUPER_ADMIN. Nächste Anmeldung führt zur Plattformübersicht (/admin).`);
await db.$disconnect();
