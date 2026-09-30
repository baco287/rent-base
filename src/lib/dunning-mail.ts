// Befehl 23: Versand eines Mahnschreibens – nur nach bewusster Bestätigung, über den bestehenden Business-Mail-Weg
// (sendBusinessMail), immer mit dem archivierten PDF des Schreibens an die beim Erstellen eingefrorene Adresse. Ein erneuter
// Versand erzeugt nur einen neuen Protokolleintrag: keine neue Stufe, keine neue Gebühr, keine neue Nummer, dasselbe PDF.

import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { dunningLevelLabel } from "@/lib/constants";
import { loadDunningDocumentData } from "@/lib/dunning-document";
import { ensureDunningDocument, readDocumentFile } from "@/lib/documents";
import { claimEmail, markEmailFailed, markEmailSent, type EmailLogRow } from "@/lib/email-log";
import { DomainError } from "@/lib/integrity";
import { deliveryMetaOf, isValidEmail, safeMailError, type MailTransport } from "@/lib/mail";
import type { StorageDriver } from "@/lib/storage";
import { sendBusinessMail } from "@/lib/tenant-mail";

export const DUNNING_MAIL_TEMPLATE = "DUNNING_NOTICE";

export function composeDunningMail(f: { level: number; number: string; invoiceNumber: string; total: string; deadline: string; recipientName: string; landlordName: string; landlordContact: string }) {
  const label = dunningLevelLabel(f.level);
  const subject = `${label} ${f.number} zu Rechnung ${f.invoiceNumber}`;
  const body = f.level === 1
    ? [`nach unseren Unterlagen ist zu unserer Rechnung ${f.invoiceNumber} noch ein Betrag von ${f.total} offen. Sicher ist die Zahlung nur übersehen worden.`, `Wir bitten Sie freundlich um Überweisung bis zum ${f.deadline}. Einzelheiten finden Sie in der angehängten Zahlungserinnerung.`]
    : f.level === 2
    ? [`die Forderung aus unserer Rechnung ${f.invoiceNumber} ist nach unseren Unterlagen weiterhin offen.`, `Bitte begleichen Sie die Gesamtforderung von ${f.total} bis spätestens ${f.deadline}. Einzelheiten finden Sie in der angehängten Mahnung.`]
    : [`die Forderung aus unserer Rechnung ${f.invoiceNumber} ist trotz vorheriger Schreiben nach unseren Unterlagen weiterhin offen.`, `Bitte begleichen Sie die Gesamtforderung von ${f.total} bis spätestens ${f.deadline}. Nach Ablauf dieser Frist kann eine weitere Bearbeitung erforderlich werden. Einzelheiten finden Sie in der angehängten Mahnung.`];
  const note = "Falls Sie inzwischen gezahlt haben, betrachten Sie diese Nachricht bitte als gegenstandslos.";
  const lines = [`Guten Tag ${f.recipientName},`, "", ...body.flatMap((b) => [b, ""]), note, "", "Im Anhang:", `- ${label} ${f.number}`, "", "Freundliche Grüße", f.landlordName, ...(f.landlordContact ? [f.landlordContact] : [])];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a2230"><p>Guten Tag ${esc(f.recipientName)},</p>${body.map((b) => `<p>${esc(b)}</p>`).join("")}<p>${esc(note)}</p><p>Im Anhang:</p><ul><li>${esc(`${label} ${f.number}`)}</li></ul><p>Freundliche Grüße<br>${esc(f.landlordName)}${f.landlordContact ? `<br><span style="color:#4a5568">${esc(f.landlordContact)}</span>` : ""}</p></div>`;
  return { subject, text: lines.join("\n"), html };
}

export type DunningSendOptions = { nonce: string; transport?: MailTransport; storage?: StorageDriver };
export type DunningSendResult = { status: "SENT" | "FAILED" | "DUPLICATE"; log: EmailLogRow; resend: boolean };

/** Versendet das archivierte PDF des Mahnschreibens. Derselbe nonce sendet nie zweimal (Doppelklick, zwei Tabs). */
export async function sendDunningNotice(tenantId: string, actor: Actor | null, noticeId: string, opts: DunningSendOptions): Promise<DunningSendResult> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(opts.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const n = await db.dunningNotice.findFirst({ where: { id: noticeId, tenantId } });
  if (!n) throw new DomainError("Mahnschreiben nicht gefunden.");
  const recipient = n.recipientEmail;
  if (!isValidEmail(recipient)) throw new DomainError("Zum Empfänger ist keine gültige E-Mail-Adresse hinterlegt. Bitte das PDF per Post übermitteln und die Übermittlung vermerken.");
  const { document: doc } = await ensureDunningDocument(tenantId, n.id, actor?.id ?? null, { storage: opts.storage });
  const data = await loadDunningDocumentData(tenantId, n.id);
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, phone: true, email: true } });
  const mail = composeDunningMail({ level: n.level, number: n.number, invoiceNumber: data.doc.invoice.number, total: data.doc.total, deadline: data.doc.deadline, recipientName: n.recipientName, landlordName: tenant.name, landlordContact: [tenant.phone, tenant.email].filter(Boolean).join(" · ") });
  const resend = (await db.emailLog.count({ where: { tenantId, dunningNoticeId: n.id, status: "SENT" } })) > 0;
  const { log, created } = await claimEmail({ tenantId, bookingId: n.bookingId, invoiceId: n.invoiceId, dunningNoticeId: n.id, recipient, subject: mail.subject, template: DUNNING_MAIL_TEMPLATE, attachments: [{ documentId: doc.id, fileName: doc.fileName, checksum: doc.checksum, version: doc.version, type: doc.type }], trigger: "MANUAL", createdById: actor?.id ?? null, idempotencyKey: `${DUNNING_MAIL_TEMPLATE}:${n.id}:${doc.id}v${doc.version}:manual:${opts.nonce}` });
  if (!created) return { status: "DUPLICATE", log, resend };
  const finish = async (status: "SENT" | "FAILED") => ({ status, resend, log: (await db.emailLog.findFirst({ where: { id: log.id, tenantId } })) ?? log });
  try {
    const file = await readDocumentFile(tenantId, doc.id, opts.storage);
    if (!file) throw new DomainError("Das Mahnschreiben wurde im Archiv nicht gefunden");
    const result = await sendBusinessMail(tenantId, { to: recipient.trim(), subject: mail.subject, text: mail.text, html: mail.html, fromName: tenant.name, replyTo: tenant.email, attachments: [{ filename: doc.fileName, content: file.body, contentType: doc.contentType }] }, { transport: opts.transport, storage: opts.storage });
    await markEmailSent(tenantId, log.id, result.messageId, result.meta);
    // ohne Empfängeradresse im Audit (kein Klartext-PII); Bezug über emailLogId
    await db.$transaction((tx) => recordAudit(tx, tenantId, actor, { action: resend ? "DUNNING_RESENT" : "DUNNING_SENT", bookingId: n.bookingId, invoiceId: n.invoiceId, amountCents: n.totalCents, details: { noticeId: n.id, number: n.number, level: n.level, emailLogId: log.id, documentId: doc.id } }));
    return finish("SENT");
  } catch (e) {
    const message = e instanceof Error && e.constructor.name === "DocumentIntegrityError" ? "Das Mahnschreiben konnte nicht unverändert aus dem Archiv gelesen werden" : safeMailError(e);
    await markEmailFailed(tenantId, log.id, message, deliveryMetaOf(e));
    return finish("FAILED");
  }
}
