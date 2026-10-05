// Befehl 29: Adressbuch für Versicherungen, Werkstätten und Kanzleien (Muster AuthorityContact). Lernt beim Anlegen oder
// Ändern eines Unfallersatzfalls Name, Ansprechpartner, Telefon, E-Mail und Anschrift, damit der nächste Fall vorbelegt ist.
// Bewusst klein: kein CRM, keine Vorgangs-Historie, keine Personendaten von Mietern. Fälle tragen immer ihre eigene Kopie;
// leere Felder löschen nie einen bekannten Wert, eine bewusst neue Angabe ersetzt ihn.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import type { BusinessPartnerKind } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { isValidEmail } from "@/lib/mail";

type Tx = Prisma.TransactionClient;
export type PartnerRow = Prisma.BusinessPartnerGetPayload<object>;
export type PartnerData = { name: string; contactName?: string | null; phone?: string | null; email?: string | null; street?: string | null; zip?: string | null; city?: string | null };

/** Vergleichsschlüssel: klein, ohne Satzzeichen, Gedankenstriche und Mehrfachleerzeichen („HUK-COBURG“ = „HUK Coburg“). */
export function partnerKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const clean = (v: string | null | undefined, max = 200) => (v?.replace(/\s+/g, " ").trim().slice(0, max) || null);

/** Im Adressbuch vermerken (innerhalb der Fall-Transaktion). Ungültige E-Mails werden nicht gelernt. */
export async function learnPartner(tx: Tx, tenantId: string, kind: BusinessPartnerKind, d: PartnerData): Promise<void> {
  const name = clean(d.name) ?? "";
  const nameKey = partnerKey(name);
  if (nameKey.length < 2) return;
  const filled = {
    ...(clean(d.contactName) ? { contactName: clean(d.contactName) } : {}),
    ...(clean(d.phone, 60) ? { phone: clean(d.phone, 60) } : {}),
    ...(clean(d.email) && isValidEmail(clean(d.email)!) ? { email: clean(d.email) } : {}),
    ...(clean(d.street) ? { street: clean(d.street) } : {}),
    ...(clean(d.zip, 20) ? { zip: clean(d.zip, 20) } : {}),
    ...(clean(d.city) ? { city: clean(d.city) } : {}),
  };
  const now = new Date();
  await tx.businessPartner.upsert({
    where: { tenantId_kind_nameKey: { tenantId, kind, nameKey } },
    create: { tenantId, kind, name, nameKey, ...filled, useCount: 1, lastUsedAt: now },
    // die zuerst gelernte Schreibweise bleibt (Umbenennen nur bewusst im Adressbuch)
    update: { ...filled, useCount: { increment: 1 }, lastUsedAt: now },
  });
}

export async function listPartners(tenantId: string, kind?: BusinessPartnerKind) {
  return db.businessPartner.findMany({ where: { tenantId, ...(kind ? { kind } : {}) }, orderBy: [{ kind: "asc" }, { useCount: "desc" }, { name: "asc" }], take: 500 });
}

/** Nur die Felder, die ein Formular zum Vorbelegen braucht. */
export async function partnerOptions(tenantId: string, kind: BusinessPartnerKind) {
  const rows = await listPartners(tenantId, kind);
  return rows.map((p) => ({ id: p.id, name: p.name, contactName: p.contactName ?? "", phone: p.phone ?? "", email: p.email ?? "", street: p.street ?? "", zip: p.zip ?? "", city: p.city ?? "" }));
}
export type PartnerOption = Awaited<ReturnType<typeof partnerOptions>>[number];

function validate(input: PartnerData) {
  const name = clean(input.name) ?? "";
  if (name.length < 2) throw new DomainError("Bitte den Namen angeben.");
  const email = clean(input.email);
  if (email && !isValidEmail(email)) throw new DomainError("Die E-Mail-Adresse ist ungültig.");
  return { name, nameKey: partnerKey(name), contactName: clean(input.contactName), phone: clean(input.phone, 60), email, street: clean(input.street), zip: clean(input.zip, 20), city: clean(input.city) };
}

export async function updatePartner(tenantId: string, id: string, actor: Actor, input: PartnerData): Promise<PartnerRow> {
  const data = validate(input);
  try {
    return await db.$transaction(async (tx) => {
      const p = await tx.businessPartner.findFirst({ where: { id, tenantId } });
      if (!p) throw new DomainError("Eintrag nicht gefunden.");
      const updated = await tx.businessPartner.update({ where: { id: p.id }, data });
      await recordAudit(tx, tenantId, actor, { action: "BUSINESS_PARTNER_UPDATED", details: { partnerId: p.id, kind: p.kind, name: data.name } });
      return updated;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new DomainError("Ein Eintrag dieser Art mit diesem Namen steht bereits im Adressbuch.");
    throw e;
  }
}

/** Löschen ist unkritisch: Fälle tragen ihre eigene Kopie der Partnerdaten. */
export async function deletePartner(tenantId: string, id: string, actor: Actor) {
  return db.$transaction(async (tx) => {
    const p = await tx.businessPartner.findFirst({ where: { id, tenantId } });
    if (!p) throw new DomainError("Eintrag nicht gefunden.");
    await tx.businessPartner.delete({ where: { id: p.id } });
    await recordAudit(tx, tenantId, actor, { action: "BUSINESS_PARTNER_DELETED", details: { partnerId: p.id, kind: p.kind, name: p.name } });
  });
}
