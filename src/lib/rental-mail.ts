// Versand der Mietunterlagen nach der Übergabe: Mietvertrag und Übergabeprotokoll als Anhang.
// Verschickt werden exakt die archivierten Dateien (Document). Hier wird kein PDF neu erzeugt.

import { db } from "@/lib/db";
import type { ArchivedDocument } from "@/lib/documents";
import { readDocumentFile } from "@/lib/documents";
import { loadContractDocumentData } from "@/lib/document-data";
import { claimEmail, markEmailFailed, markEmailSent, type EmailLogRow } from "@/lib/email-log";
import { DomainError } from "@/lib/integrity";
import { getMailTransport, isValidEmail, safeMailError, type MailTransport } from "@/lib/mail";
import type { StorageDriver } from "@/lib/storage";

export const PICKUP_MAIL_TEMPLATE = "PICKUP_DOCUMENTS";

export type PickupMailFacts = { renterName: string; contractNumber: string; vehicleTitle: string; plate: string; startAt: string; landlordName: string; landlordContact: string };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Betreff und Text der E-Mail. Sachlich, ohne rechtliche Aussagen. */
export function composePickupMail(f: PickupMailFacts): { subject: string; text: string; html: string } {
  const subject = `Ihre Mietunterlagen – ${f.contractNumber}`;
  const lines = [
    `Guten Tag ${f.renterName},`,
    "",
    "anbei erhalten Sie Ihre Unterlagen zur Fahrzeugmiete.",
    "",
    `Fahrzeug: ${f.vehicleTitle}`,
    `Kennzeichen: ${f.plate}`,
    `Mietbeginn: ${f.startAt}`,
    `Vertragsnummer: ${f.contractNumber}`,
    "",
    "Im Anhang:",
    "- Mietvertrag",
    "- Übergabeprotokoll",
    "",
    "Bitte bewahren Sie die Unterlagen für die Dauer der Miete auf.",
    "",
    "Freundliche Grüße",
    f.landlordName,
    ...(f.landlordContact ? [f.landlordContact] : []),
  ];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a2230">
<p>Guten Tag ${esc(f.renterName)},</p>
<p>anbei erhalten Sie Ihre Unterlagen zur Fahrzeugmiete.</p>
<table style="border-collapse:collapse;font-size:15px" cellpadding="0" cellspacing="0">
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Fahrzeug</td><td>${esc(f.vehicleTitle)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Kennzeichen</td><td>${esc(f.plate)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Mietbeginn</td><td>${esc(f.startAt)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Vertragsnummer</td><td>${esc(f.contractNumber)}</td></tr>
</table>
<p>Im Anhang:</p>
<ul><li>Mietvertrag</li><li>Übergabeprotokoll</li></ul>
<p>Bitte bewahren Sie die Unterlagen für die Dauer der Miete auf.</p>
<p>Freundliche Grüße<br>${esc(f.landlordName)}${f.landlordContact ? `<br><span style="color:#4a5568">${esc(f.landlordContact)}</span>` : ""}</p>
</div>`;
  return { subject, text: lines.join("\n"), html };
}

export type PickupMailPlan = {
  bookingId: string;
  handoverId: string;
  recipient: string | null; // aus der Vertragskopie
  facts: PickupMailFacts;
  replyTo: string | null;
  documents: ArchivedDocument[]; // Mietvertrag, Übergabeprotokoll (jeweils neueste archivierte Fassung)
  missing: string[];
};

/** Stellt zusammen, was verschickt würde. Liest nur Vertragskopie und Archiv. */
export async function planPickupMail(tenantId: string, handoverId: string): Promise<PickupMailPlan> {
  const h = await db.handover.findFirst({ where: { id: handoverId, tenantId }, select: { id: true, bookingId: true, contractId: true, type: true, status: true } });
  if (!h) throw new DomainError("Protokoll nicht gefunden.");
  if (h.type !== "PICKUP" || h.status !== "FINALIZED") throw new DomainError("Unterlagen werden erst nach abgeschlossener Übergabe versendet.");
  if (!h.contractId) throw new DomainError("Zu dieser Übergabe gibt es keinen Mietvertrag.");
  const contract = await loadContractDocumentData(tenantId, h.contractId);
  const [contractDoc, pickupDoc] = await Promise.all([
    db.document.findFirst({ where: { tenantId, type: "RENTAL_CONTRACT", contractId: h.contractId }, orderBy: { version: "desc" } }),
    db.document.findFirst({ where: { tenantId, type: "PICKUP_PROTOCOL", handoverId: h.id }, orderBy: { version: "desc" } }),
  ]);
  const d = contract.doc;
  return {
    bookingId: h.bookingId,
    handoverId: h.id,
    recipient: d.renterEmail,
    facts: { renterName: d.renterName, contractNumber: d.number, vehicleTitle: d.vehicleTitle, plate: d.plate, startAt: d.startAt, landlordName: d.landlord.name, landlordContact: d.landlord.contact },
    replyTo: d.landlord.email,
    documents: [contractDoc, pickupDoc].filter((x): x is ArchivedDocument => x !== null),
    missing: [...(contractDoc ? [] : ["Mietvertrag"]), ...(pickupDoc ? [] : ["Übergabeprotokoll"])],
  };
}

export type SendOptions = {
  trigger: "AUTO" | "MANUAL";
  actorId?: string | null;
  /** Nur bei MANUAL: einmaliger Wert des Bestätigungsformulars. Derselbe Wert sendet nie zweimal. */
  nonce?: string;
  transport?: MailTransport;
  storage?: StorageDriver;
};

export type SendResult = { status: "SENT" | "FAILED" | "DUPLICATE"; log: EmailLogRow };

/**
 * Sendet die Unterlagen. Wirft nur, wenn es gar nichts zu senden gibt (Dokumente fehlen, Protokoll nicht final).
 * Jeder echte Versuch endet als SENT oder FAILED im EmailLog; ein Fehler hier berührt die Übergabe nie.
 */
export async function sendPickupDocuments(tenantId: string, handoverId: string, opts: SendOptions): Promise<SendResult> {
  const plan = await planPickupMail(tenantId, handoverId);
  if (plan.missing.length > 0) throw new DomainError(`Es fehlt noch: ${plan.missing.join(" und ")}. Bitte zuerst das PDF erzeugen.`);
  if (opts.trigger === "MANUAL" && !/^[A-Za-z0-9-]{8,64}$/.test(opts.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");

  const versions = plan.documents.map((doc) => `${doc.id}v${doc.version}`).join("+");
  const idempotencyKey = `${PICKUP_MAIL_TEMPLATE}:${handoverId}:${versions}${opts.trigger === "MANUAL" ? `:manual:${opts.nonce}` : ""}`;
  const mail = composePickupMail(plan.facts);
  const { log, created } = await claimEmail({
    tenantId,
    bookingId: plan.bookingId,
    handoverId,
    recipient: plan.recipient ?? "(keine Adresse)",
    subject: mail.subject,
    template: PICKUP_MAIL_TEMPLATE,
    attachments: plan.documents.map((doc) => ({ documentId: doc.id, fileName: doc.fileName, checksum: doc.checksum, version: doc.version, type: doc.type })),
    trigger: opts.trigger,
    createdById: opts.actorId ?? null,
    idempotencyKey,
  });
  if (!created) return { status: "DUPLICATE", log };

  const finish = async (status: "SENT" | "FAILED") => ({ status, log: (await db.emailLog.findFirst({ where: { id: log.id, tenantId } })) ?? log });
  try {
    if (!isValidEmail(plan.recipient)) throw new DomainError("Im Mietvertrag ist keine gültige E-Mail-Adresse des Mieters hinterlegt");
    const transport = opts.transport ?? getMailTransport();
    const attachments = [];
    for (const doc of plan.documents) {
      const file = await readDocumentFile(tenantId, doc.id, opts.storage); // prüft Mandant und Prüfsumme
      if (!file) throw new DomainError("Ein Anhang wurde im Archiv nicht gefunden");
      attachments.push({ filename: doc.fileName, content: file.body, contentType: doc.contentType });
    }
    const result = await transport.send({ to: plan.recipient.trim(), subject: mail.subject, text: mail.text, html: mail.html, fromName: plan.facts.landlordName, replyTo: plan.replyTo, attachments });
    await markEmailSent(tenantId, log.id, result.messageId);
    return finish("SENT");
  } catch (e) {
    const message = e instanceof Error && e.constructor.name === "DocumentIntegrityError" ? "Ein Anhang konnte nicht unverändert aus dem Archiv gelesen werden" : safeMailError(e);
    await markEmailFailed(tenantId, log.id, message);
    return finish("FAILED");
  }
}
