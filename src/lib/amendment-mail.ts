// Befehl 25: Versand eines Nachtrags – nur nach bewusster Bestätigung, über den bestehenden Business-Mail-Weg
// (sendBusinessMail), immer mit dem archivierten PDF an die im Snapshot eingefrorene Mieteradresse. Kein automatischer
// Versand bei Unterschrift. Ein erneuter Versand erzeugt nur einen neuen Protokolleintrag: dieselbe Nummer, dasselbe PDF.

import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { loadAmendmentDocumentData } from "@/lib/amendment-document";
import { ensureAmendmentDocument, readDocumentFile } from "@/lib/documents";
import { claimEmail, markEmailFailed, markEmailSent, type EmailLogRow } from "@/lib/email-log";
import { DomainError } from "@/lib/integrity";
import { deliveryMetaOf, isValidEmail, safeMailError, type MailTransport } from "@/lib/mail";
import type { StorageDriver } from "@/lib/storage";
import { sendBusinessMail } from "@/lib/tenant-mail";

export const AMENDMENT_MAIL_TEMPLATE = "CONTRACT_AMENDMENT";

export function composeAmendmentMail(f: { number: string; contractNumber: string; bookingNumber: string; changes: string[]; recipientName: string; landlordName: string; landlordContact: string }) {
  const subject = `Nachtrag ${f.number} zum Mietvertrag ${f.contractNumber}`;
  const body = [
    `anbei erhalten Sie den unterschriebenen Nachtrag ${f.number} zu Ihrem Mietvertrag ${f.contractNumber} (Buchung ${f.bookingNumber}).`,
    `Geänderte Vereinbarungen: ${f.changes.join(", ")}.`,
    "Alle übrigen Vereinbarungen des Mietvertrags bleiben unverändert bestehen.",
  ];
  const lines = [`Guten Tag ${f.recipientName},`, "", ...body.flatMap((b) => [b, ""]), "Im Anhang:", `- Nachtrag ${f.number} zum Mietvertrag`, "", "Freundliche Grüße", f.landlordName, ...(f.landlordContact ? [f.landlordContact] : [])];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a2230"><p>Guten Tag ${esc(f.recipientName)},</p>${body.map((b) => `<p>${esc(b)}</p>`).join("")}<p>Im Anhang:</p><ul><li>${esc(`Nachtrag ${f.number} zum Mietvertrag`)}</li></ul><p>Freundliche Grüße<br>${esc(f.landlordName)}${f.landlordContact ? `<br><span style="color:#4a5568">${esc(f.landlordContact)}</span>` : ""}</p></div>`;
  return { subject, text: lines.join("\n"), html };
}

export type AmendmentSendOptions = { nonce: string; transport?: MailTransport; storage?: StorageDriver };
export type AmendmentSendResult = { status: "SENT" | "FAILED" | "DUPLICATE"; log: EmailLogRow; resend: boolean };

/** Versendet das archivierte PDF des Nachtrags. Derselbe nonce sendet nie zweimal (Doppelklick, zwei Tabs). */
export async function sendAmendment(tenantId: string, actor: Actor | null, amendmentId: string, opts: AmendmentSendOptions): Promise<AmendmentSendResult> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(opts.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const a = await db.contractAmendment.findFirst({ where: { id: amendmentId, tenantId } });
  if (!a) throw new DomainError("Nachtrag nicht gefunden.");
  if (a.status !== "SIGNED" || !a.number) throw new DomainError("Versendet wird nur ein unterschriebener, wirksamer Nachtrag.");
  const data = await loadAmendmentDocumentData(tenantId, a.id);
  const recipient = data.recipientEmail;
  if (!isValidEmail(recipient)) throw new DomainError("Zum Mieter ist im Vertrag keine gültige E-Mail-Adresse hinterlegt. Bitte das PDF anders übermitteln.");
  const { document: doc } = await ensureAmendmentDocument(tenantId, a.id, actor?.id ?? null, { storage: opts.storage });
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, phone: true, email: true } });
  const mail = composeAmendmentMail({ number: a.number, contractNumber: data.doc.contract.number, bookingNumber: data.doc.bookingNumber, changes: data.doc.changes.map((c) => c.label), recipientName: data.doc.customer.name, landlordName: tenant.name, landlordContact: [tenant.phone, tenant.email].filter(Boolean).join(" · ") });
  const resend = (await db.emailLog.count({ where: { tenantId, amendmentId: a.id, status: "SENT" } })) > 0;
  const { log, created } = await claimEmail({ tenantId, bookingId: a.bookingId, amendmentId: a.id, recipient: recipient!, subject: mail.subject, template: AMENDMENT_MAIL_TEMPLATE, attachments: [{ documentId: doc.id, fileName: doc.fileName, checksum: doc.checksum, version: doc.version, type: doc.type }], trigger: "MANUAL", createdById: actor?.id ?? null, idempotencyKey: `${AMENDMENT_MAIL_TEMPLATE}:${a.id}:${doc.id}v${doc.version}:manual:${opts.nonce}` });
  if (!created) return { status: "DUPLICATE", log, resend };
  const finish = async (status: "SENT" | "FAILED") => ({ status, resend, log: (await db.emailLog.findFirst({ where: { id: log.id, tenantId } })) ?? log });
  try {
    const file = await readDocumentFile(tenantId, doc.id, opts.storage);
    if (!file) throw new DomainError("Der Nachtrag wurde im Archiv nicht gefunden");
    const result = await sendBusinessMail(tenantId, { to: recipient!.trim(), subject: mail.subject, text: mail.text, html: mail.html, fromName: tenant.name, replyTo: tenant.email, attachments: [{ filename: doc.fileName, content: file.body, contentType: doc.contentType }] }, { transport: opts.transport, storage: opts.storage });
    await markEmailSent(tenantId, log.id, result.messageId, result.meta);
    // ohne Empfängeradresse im Audit (kein Klartext-PII); Bezug über emailLogId
    await db.$transaction((tx) => recordAudit(tx, tenantId, actor, { action: "AMENDMENT_SENT", bookingId: a.bookingId, details: { amendmentId: a.id, number: a.number, resend, emailLogId: log.id, documentId: doc.id } }));
    return finish("SENT");
  } catch (e) {
    const message = e instanceof Error && e.constructor.name === "DocumentIntegrityError" ? "Der Nachtrag konnte nicht unverändert aus dem Archiv gelesen werden" : safeMailError(e);
    await markEmailFailed(tenantId, log.id, message, deliveryMetaOf(e));
    return finish("FAILED");
  }
}
