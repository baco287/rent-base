// Befehl 28: Stornobestätigung per E-Mail – nur nach bewusster Bestätigung (kein Automatismus), über den bestehenden
// Business-Mail-Weg (sendBusinessMail, EmailLog mit Idempotenz). Anhang: die archivierte Stornobestätigung und nur die beim
// Storno neu entstandenen Belege (Stornogebühr-Rechnung, Auszahlungsbelege der Erstattung/Kautionsrückzahlung). Alte Dokumente
// (Mietvertrag, frühere Rechnungen) werden nicht erneut ungefragt versendet.

import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { loadCancellationDocumentData } from "@/lib/cancellation-document";
import { ensureCancellationDocument, ensureInvoiceDocument, ensurePayoutDocument, readDocumentFile } from "@/lib/documents";
import { claimEmail, markEmailFailed, markEmailSent, type EmailLogRow } from "@/lib/email-log";
import { DomainError } from "@/lib/integrity";
import { deliveryMetaOf, isValidEmail, safeMailError, type MailTransport } from "@/lib/mail";
import type { StorageDriver } from "@/lib/storage";
import { sendBusinessMail } from "@/lib/tenant-mail";

export const CANCELLATION_MAIL_TEMPLATE = "BOOKING_CANCELLATION";

export function composeCancellationMail(f: { bookingNumber: string; recipientName: string; landlordName: string; landlordContact: string; attachments: string[] }) {
  const subject = `Stornobestätigung zur Buchung ${f.bookingNumber}`;
  const body = [
    `hiermit bestätigen wir die Stornierung Ihrer Buchung ${f.bookingNumber}.`,
    "Die finanzielle Zusammenfassung (Vorauszahlung, gegebenenfalls Stornogebühr, Erstattung oder Guthaben sowie Kaution) finden Sie in der beigefügten Stornobestätigung.",
  ];
  const lines = [`Guten Tag ${f.recipientName},`, "", ...body.flatMap((b) => [b, ""]), "Im Anhang:", ...f.attachments.map((a) => `- ${a}`), "", "Freundliche Grüße", f.landlordName, ...(f.landlordContact ? [f.landlordContact] : [])];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a2230"><p>Guten Tag ${esc(f.recipientName)},</p>${body.map((b) => `<p>${esc(b)}</p>`).join("")}<p>Im Anhang:</p><ul>${f.attachments.map((a) => `<li>${esc(a)}</li>`).join("")}</ul><p>Freundliche Grüße<br>${esc(f.landlordName)}${f.landlordContact ? `<br>${esc(f.landlordContact)}` : ""}</p></div>`;
  return { subject, text: lines.join("\n"), html };
}

export type CancellationSendResult = { status: "SENT" | "FAILED" | "DUPLICATE"; log: EmailLogRow };

/** Versendet die Stornobestätigung (archiviertes PDF) und die beim Storno neu entstandenen Belege. Derselbe nonce sendet nie zweimal. */
export async function sendCancellationConfirmation(tenantId: string, actor: Actor | null, bookingId: string, opts: { nonce: string; transport?: MailTransport; storage?: StorageDriver }): Promise<CancellationSendResult> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(opts.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const data = await loadCancellationDocumentData(tenantId, bookingId);
  const recipient = data.recipientEmail;
  if (!isValidEmail(recipient)) throw new DomainError("Zum Kunden ist keine gültige E-Mail-Adresse hinterlegt. Bitte die Stornobestätigung anders übermitteln.");
  const booking = await db.booking.findFirstOrThrow({ where: { id: bookingId, tenantId }, select: { cancellationKey: true } });
  const docs = [(await ensureCancellationDocument(tenantId, bookingId, actor?.id ?? null, { storage: opts.storage })).document];
  const labels = ["Stornobestätigung"];
  const fee = await db.invoice.findFirst({ where: { tenantId, bookingId, kind: "CANCELLATION_FEE", documentType: "INVOICE", status: "FINALIZED" }, select: { currentVersionId: true, number: true } });
  if (fee?.currentVersionId) { docs.push((await ensureInvoiceDocument(tenantId, fee.currentVersionId, actor?.id ?? null, { storage: opts.storage })).document); labels.push(`Rechnung ${fee.number ?? ""} (Stornogebühr)`); }
  const payouts = booking.cancellationKey ? await db.payout.findMany({ where: { tenantId, bookingId, status: "COMPLETED", idempotencyKey: { startsWith: booking.cancellationKey } }, orderBy: { createdAt: "asc" }, select: { id: true, number: true } }) : [];
  for (const p of payouts) { docs.push((await ensurePayoutDocument(tenantId, p.id, actor?.id ?? null, { storage: opts.storage })).document); labels.push(`Auszahlungsbeleg ${p.number ?? ""}`); }
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, phone: true, email: true } });
  const mail = composeCancellationMail({ bookingNumber: data.doc.bookingNumber, recipientName: data.doc.customer.name, landlordName: tenant.name, landlordContact: [tenant.phone, tenant.email].filter(Boolean).join(" · "), attachments: labels });
  const { log, created } = await claimEmail({
    tenantId, bookingId, recipient: recipient!, subject: mail.subject, template: CANCELLATION_MAIL_TEMPLATE,
    attachments: docs.map((d) => ({ documentId: d.id, fileName: d.fileName, checksum: d.checksum, version: d.version, type: d.type })),
    trigger: "MANUAL", createdById: actor?.id ?? null, idempotencyKey: `${CANCELLATION_MAIL_TEMPLATE}:${bookingId}:manual:${opts.nonce}`,
  });
  if (!created) return { status: "DUPLICATE", log };
  const finish = async (status: "SENT" | "FAILED") => ({ status, log: (await db.emailLog.findFirst({ where: { id: log.id, tenantId } })) ?? log });
  try {
    const files = [];
    for (const d of docs) {
      const file = await readDocumentFile(tenantId, d.id, opts.storage);
      if (!file) throw new DomainError(`Das Dokument ${d.fileName} wurde im Archiv nicht gefunden`);
      files.push({ filename: d.fileName, content: file.body, contentType: d.contentType });
    }
    const result = await sendBusinessMail(tenantId, { to: recipient!.trim(), subject: mail.subject, text: mail.text, html: mail.html, fromName: tenant.name, replyTo: tenant.email, attachments: files }, { transport: opts.transport, storage: opts.storage });
    await markEmailSent(tenantId, log.id, result.messageId, result.meta);
    await db.$transaction((tx) => recordAudit(tx, tenantId, actor, { action: "BOOKING_CANCELLATION_SENT", bookingId, details: { emailLogId: log.id, documents: docs.length } }));
    return finish("SENT");
  } catch (e) {
    const message = e instanceof Error && e.constructor.name === "DocumentIntegrityError" ? "Ein Dokument konnte nicht unverändert aus dem Archiv gelesen werden" : safeMailError(e);
    await markEmailFailed(tenantId, log.id, message, deliveryMetaOf(e));
    return finish("FAILED");
  }
}
