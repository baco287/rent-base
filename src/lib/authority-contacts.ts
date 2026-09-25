// Behörden-Adressbuch: lernt beim Anlegen/Ändern eines Vorgangs Name, Abteilung, Anschrift, E-Mail und Portal der
// Behörde, damit das nächste Schreiben derselben Behörde vorbelegt ist. Nur Behördendaten – keine Personendaten, keine
// Zugangsdaten. Leere Felder löschen nie einen bekannten Wert; eine bewusst neue Angabe ersetzt ihn.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { portalUrlInfo } from "@/lib/authority-matching";
import { DomainError } from "@/lib/integrity";
import { isValidEmail } from "@/lib/mail";

type Tx = Prisma.TransactionClient;
export type ContactRow = Prisma.AuthorityContactGetPayload<object>;
export type ContactData = { authorityName: string; authorityDepartment?: string | null; authorityAddress?: string | null; authorityEmail?: string | null; authorityPortalUrl?: string | null };

/** Vergleichsschlüssel: klein, ohne Satzzeichen, Gedankenstriche und Mehrfachleerzeichen. */
export function contactKey(name: string): string {
  // „BUSSGELDSTELLE“ und „Bußgeldstelle“ sind dieselbe Behörde
  return name.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Im Adressbuch vermerken (innerhalb der Vorgangs-Transaktion). */
export async function learnContact(tx: Tx, tenantId: string, d: ContactData): Promise<void> {
  const name = d.authorityName.trim();
  const nameKey = contactKey(name);
  if (nameKey.length < 2) return;
  const filled = {
    ...(d.authorityDepartment?.trim() ? { department: d.authorityDepartment.trim() } : {}),
    ...(d.authorityAddress?.trim() ? { address: d.authorityAddress.trim() } : {}),
    ...(d.authorityEmail?.trim() && isValidEmail(d.authorityEmail) ? { email: d.authorityEmail.trim() } : {}),
    ...(d.authorityPortalUrl?.trim() && portalUrlInfo(d.authorityPortalUrl.trim()).ok ? { portalUrl: d.authorityPortalUrl.trim() } : {}),
  };
  const now = new Date();
  await tx.authorityContact.upsert({
    where: { tenantId_nameKey: { tenantId, nameKey } },
    create: { tenantId, name, nameKey, ...filled, useCount: 1, lastUsedAt: now },
    // die zuerst gelernte Schreibweise bleibt (Umbenennen nur bewusst im Adressbuch)
    update: { ...filled, useCount: { increment: 1 }, lastUsedAt: now },
  });
}

export async function listContacts(tenantId: string) {
  return db.authorityContact.findMany({ where: { tenantId }, orderBy: [{ useCount: "desc" }, { name: "asc" }], take: 500 });
}

/** Nur die Felder, die das Formular zum Vorbelegen braucht. */
export async function contactOptions(tenantId: string) {
  const rows = await listContacts(tenantId);
  return rows.map((c) => ({ id: c.id, name: c.name, department: c.department ?? "", address: c.address ?? "", email: c.email ?? "", portalUrl: c.portalUrl ?? "" }));
}
export type ContactOption = Awaited<ReturnType<typeof contactOptions>>[number];

export type ContactInput = { name: string; department?: string | null; address?: string | null; email?: string | null; portalUrl?: string | null };

function validate(input: ContactInput) {
  const name = input.name.trim();
  if (name.length < 2) throw new DomainError("Bitte den Namen der Behörde angeben.");
  const email = input.email?.trim() || null;
  if (email && !isValidEmail(email)) throw new DomainError("Die E-Mail-Adresse ist ungültig.");
  const portalUrl = input.portalUrl?.trim() || null;
  if (portalUrl && !portalUrlInfo(portalUrl).ok) throw new DomainError("Die Portaladresse muss eine vollständige https-Adresse sein.");
  return { name, nameKey: contactKey(name), department: input.department?.trim() || null, address: input.address?.trim() || null, email, portalUrl };
}

export async function updateContact(tenantId: string, id: string, actor: Actor, input: ContactInput): Promise<ContactRow> {
  const data = validate(input);
  try {
    return await db.$transaction(async (tx) => {
      const c = await tx.authorityContact.findFirst({ where: { id, tenantId } });
      if (!c) throw new DomainError("Eintrag nicht gefunden.");
      const updated = await tx.authorityContact.update({ where: { id: c.id }, data });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_CONTACT_UPDATED", details: { contactId: c.id, name: data.name } });
      return updated;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new DomainError("Eine Behörde mit diesem Namen steht bereits im Adressbuch.");
    throw e;
  }
}

/** Löschen ist unkritisch: Vorgänge tragen ihre eigene Kopie der Behördendaten. */
export async function deleteContact(tenantId: string, id: string, actor: Actor) {
  return db.$transaction(async (tx) => {
    const c = await tx.authorityContact.findFirst({ where: { id, tenantId } });
    if (!c) throw new DomainError("Eintrag nicht gefunden.");
    await tx.authorityContact.delete({ where: { id: c.id } });
    await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_CONTACT_DELETED", details: { contactId: c.id, name: c.name } });
  });
}
