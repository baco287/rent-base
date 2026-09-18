// Passwort eines Benutzers neu setzen, direkt auf dem Server im App-Container.
// Aufruf:  node scripts/reset-password.mjs
// Zeigt alle Benutzer, fragt nach Nummer und neuem Passwort (Eingabe unsichtbar).
// Für den Fall "Passwort vergessen", solange es keinen E-Mail-Versand gibt.

import { createInterface } from "node:readline";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Eingabe nicht anzeigen
      const write = rl._writeToOutput;
      rl._writeToOutput = function (s) {
        if (s.includes(question)) write.call(rl, s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const users = await db.user.findMany({ include: { tenant: true }, orderBy: [{ tenant: { name: "asc" } }, { email: "asc" }] });
if (users.length === 0) {
  console.log("Keine Benutzer vorhanden.");
  process.exit(1);
}
console.log("Benutzer:");
users.forEach((u, i) => console.log(`  ${i + 1}) ${u.email}  ·  ${u.name}  ·  ${u.role}  ·  ${u.tenant.name}${u.active ? "" : "  (deaktiviert)"}`));

const idx = parseInt(await ask("Nummer des Benutzers: "), 10);
const user = users[idx - 1];
if (!user) {
  console.log("Ungültige Nummer.");
  process.exit(1);
}

const p1 = await ask(`Neues Passwort für ${user.email} (mindestens 10 Zeichen): `, { hidden: true });
if (p1.length < 10) {
  console.log("Zu kurz, mindestens 10 Zeichen.");
  process.exit(1);
}
const p2 = await ask("Passwort wiederholen: ", { hidden: true });
if (p1 !== p2) {
  console.log("Die Passwörter stimmen nicht überein.");
  process.exit(1);
}

const passwordHash = await bcrypt.hash(p1, 12);
await db.user.update({ where: { id: user.id }, data: { passwordHash, active: true } });
await db.session.deleteMany({ where: { userId: user.id } });
console.log(`Passwort für ${user.email} gesetzt. Alle alten Sitzungen wurden beendet.`);
await db.$disconnect();
