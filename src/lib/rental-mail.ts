// Versand der Mietunterlagen nach der Übergabe: Mietvertrag und Übergabeprotokoll als Anhang.
// Verschickt werden exakt die archivierten Dateien (Document). Hier wird kein PDF neu erzeugt.

import { db } from "@/lib/db";
import type { ArchivedDocument } from "@/lib/documents";
import { readDocumentFile } from "@/lib/documents";
import { loadContractDocumentData, loadInvoiceDocumentData } from "@/lib/document-data";
import { claimEmail, markEmailFailed, markEmailSent, type EmailLogRow } from "@/lib/email-log";
import { DomainError } from "@/lib/integrity";
import { getMailTransport, isValidEmail, safeMailError, type MailTransport } from "@/lib/mail";
import type { StorageDriver } from "@/lib/storage";
import { APP_TIME_ZONE } from "@/lib/time";

export const PICKUP_MAIL_TEMPLATE = "PICKUP_DOCUMENTS";
export const RETURN_MAIL_TEMPLATE = "RETURN_DOCUMENTS";
export const INVOICE_MAIL_TEMPLATE = "INVOICE";
export const INVOICE_CORRECTION_MAIL_TEMPLATE = "INVOICE_CORRECTION";
export type MailKind = "PICKUP" | "RETURN" | "INVOICE";

export type PickupMailFacts = { renterName: string; contractNumber: string; vehicleTitle: string; plate: string; startAt: string; landlordName: string; landlordContact: string; returnedAt?: string | null };

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

/** Nach der Rückgabe: nur das Rückgabeprotokoll, neutral formuliert, keine Aussage zu Schäden oder Beträgen. */
export function composeReturnMail(f: PickupMailFacts): { subject: string; text: string; html: string } {
  const subject = `Ihre Rückgabeunterlagen – ${f.contractNumber}`;
  const lines = [
    `Guten Tag ${f.renterName},`,
    "",
    "vielen Dank für die Rückgabe des Fahrzeugs. Anbei erhalten Sie das Rückgabeprotokoll.",
    "",
    `Fahrzeug: ${f.vehicleTitle}`,
    `Kennzeichen: ${f.plate}`,
    ...(f.returnedAt ? [`Rückgabe: ${f.returnedAt}`] : []),
    `Vertragsnummer: ${f.contractNumber}`,
    "",
    "Im Anhang:",
    "- Rückgabeprotokoll",
    "",
    "Bei Fragen zum Protokoll melden Sie sich gern bei uns.",
    "",
    "Freundliche Grüße",
    f.landlordName,
    ...(f.landlordContact ? [f.landlordContact] : []),
  ];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a2230">
<p>Guten Tag ${esc(f.renterName)},</p>
<p>vielen Dank für die Rückgabe des Fahrzeugs. Anbei erhalten Sie das Rückgabeprotokoll.</p>
<table style="border-collapse:collapse;font-size:15px" cellpadding="0" cellspacing="0">
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Fahrzeug</td><td>${esc(f.vehicleTitle)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Kennzeichen</td><td>${esc(f.plate)}</td></tr>
${f.returnedAt ? `<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Rückgabe</td><td>${esc(f.returnedAt)}</td></tr>` : ""}
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Vertragsnummer</td><td>${esc(f.contractNumber)}</td></tr>
</table>
<p>Im Anhang:</p>
<ul><li>Rückgabeprotokoll</li></ul>
<p>Bei Fragen zum Protokoll melden Sie sich gern bei uns.</p>
<p>Freundliche Grüße<br>${esc(f.landlordName)}${f.landlordContact ? `<br><span style="color:#4a5568">${esc(f.landlordContact)}</span>` : ""}</p>
</div>`;
  return { subject, text: lines.join("\n"), html };
}

export type PickupMailPlan = {
  kind: MailKind;
  bookingId: string;
  handoverId: string | null;
  invoiceId?: string | null;
  invoiceVersionId?: string | null;
  recipient: string | null; // aus der Vertragskopie
  facts: PickupMailFacts;
  replyTo: string | null;
  documents: ArchivedDocument[]; // Mietvertrag, Übergabeprotokoll (jeweils neueste archivierte Fassung)
  missing: string[];
};

/** Stellt zusammen, was verschickt würde. Liest nur Vertragskopie und Archiv. Übergabe: Vertrag + Protokoll, Rückgabe: nur Rückgabeprotokoll. */
export async function planHandoverMail(tenantId: string, handoverId: string): Promise<PickupMailPlan> {
  const h = await db.handover.findFirst({ where: { id: handoverId, tenantId }, select: { id: true, bookingId: true, contractId: true, type: true, status: true, finalizedAt: true } });
  if (!h) throw new DomainError("Protokoll nicht gefunden.");
  const kind: MailKind = h.type === "RETURN" ? "RETURN" : "PICKUP";
  if (h.status !== "FINALIZED") throw new DomainError(kind === "PICKUP" ? "Unterlagen werden erst nach abgeschlossener Übergabe versendet." : "Unterlagen werden erst nach abgeschlossener Rückgabe versendet.");
  if (!h.contractId) throw new DomainError("Zu diesem Protokoll gibt es keinen Mietvertrag.");
  const contract = await loadContractDocumentData(tenantId, h.contractId);
  const d = contract.doc;
  const facts = { renterName: d.renterName, contractNumber: d.number, vehicleTitle: d.vehicleTitle, plate: d.plate, startAt: d.startAt, landlordName: d.landlord.name, landlordContact: d.landlord.contact, returnedAt: h.finalizedAt ? h.finalizedAt.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null };
  if (kind === "RETURN") {
    const returnDoc = await db.document.findFirst({ where: { tenantId, type: "RETURN_PROTOCOL", handoverId: h.id }, orderBy: { version: "desc" } });
    return { kind, bookingId: h.bookingId, handoverId: h.id, recipient: d.renterEmail, facts, replyTo: d.landlord.email, documents: returnDoc ? [returnDoc] : [], missing: returnDoc ? [] : ["Rückgabeprotokoll"] };
  }
  const [contractDoc, pickupDoc] = await Promise.all([
    db.document.findFirst({ where: { tenantId, type: "RENTAL_CONTRACT", contractId: h.contractId }, orderBy: { version: "desc" } }),
    db.document.findFirst({ where: { tenantId, type: "PICKUP_PROTOCOL", handoverId: h.id }, orderBy: { version: "desc" } }),
  ]);
  return {
    kind,
    bookingId: h.bookingId,
    handoverId: h.id,
    recipient: d.renterEmail,
    facts,
    replyTo: d.landlord.email,
    documents: [contractDoc, pickupDoc].filter((x): x is ArchivedDocument => x !== null),
    missing: [...(contractDoc ? [] : ["Mietvertrag"]), ...(pickupDoc ? [] : ["Übergabeprotokoll"])],
  };
}

export const planPickupMail = planHandoverMail;

/** Rechnung: neutraler Text, nur das Rechnungs-PDF. Keine Aussage zu Schäden oder Verantwortung. */
export type InvoiceMailFacts = PickupMailFacts & { invoiceNumber: string; grossTotal: string; dueDate: string | null; correction?: { versionNo: number; supersededVersionNo: number | null } | null };

/** Rechnungsmail; bei einer Berichtigung neutral formuliert: die neue Fassung ersetzt die zuvor übermittelte. */
export function composeInvoiceMail(f: InvoiceMailFacts): { subject: string; text: string; html: string } {
  const corr = f.correction ?? null;
  const subject = corr ? `Korrigierte Rechnung ${f.invoiceNumber}` : `Ihre Rechnung ${f.invoiceNumber}`;
  const intro = corr
    ? `anbei erhalten Sie die berichtigte Rechnung ${f.invoiceNumber} (Fassung ${corr.versionNo}) zu Ihrer Fahrzeugmiete. Sie ersetzt die Ihnen zuvor übermittelte Fassung${corr.supersededVersionNo ? ` ${corr.supersededVersionNo}` : ""} dieser Rechnung.`
    : `anbei erhalten Sie die Rechnung ${f.invoiceNumber} zu Ihrer Fahrzeugmiete.`;
  const lines = [
    `Guten Tag ${f.renterName},`,
    "",
    intro,
    "",
    `Fahrzeug: ${f.vehicleTitle}`,
    `Kennzeichen: ${f.plate}`,
    `Vertragsnummer: ${f.contractNumber}`,
    `Rechnungsbetrag: ${f.grossTotal}`,
    ...(f.dueDate ? [`Zahlbar bis: ${f.dueDate}`] : []),
    "",
    "Im Anhang:",
    corr ? "- Berichtigte Rechnung" : "- Rechnung",
    "",
    "Bei Fragen zur Rechnung melden Sie sich gern bei uns.",
    "",
    "Freundliche Grüße",
    f.landlordName,
    ...(f.landlordContact ? [f.landlordContact] : []),
  ];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a2230">
<p>Guten Tag ${esc(f.renterName)},</p>
<p>${esc(intro)}</p>
<table style="border-collapse:collapse;font-size:15px" cellpadding="0" cellspacing="0">
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Fahrzeug</td><td>${esc(f.vehicleTitle)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Kennzeichen</td><td>${esc(f.plate)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Vertragsnummer</td><td>${esc(f.contractNumber)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Rechnungsbetrag</td><td><b>${esc(f.grossTotal)}</b></td></tr>
${f.dueDate ? `<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Zahlbar bis</td><td>${esc(f.dueDate)}</td></tr>` : ""}
</table>
<p>Im Anhang:</p>
<ul><li>${corr ? "Berichtigte Rechnung" : "Rechnung"}</li></ul>
<p>Bei Fragen zur Rechnung melden Sie sich gern bei uns.</p>
<p>Freundliche Grüße<br>${esc(f.landlordName)}${f.landlordContact ? `<br><span style="color:#4a5568">${esc(f.landlordContact)}</span>` : ""}</p>
</div>`;
  return { subject, text: lines.join("\n"), html };
}

export type InvoiceMailPlan = PickupMailPlan & { invoice: { number: string; grossTotal: string; dueDate: string | null; correction: { versionNo: number; supersededVersionNo: number | null } | null } };

/** Stellt zusammen, was für eine Rechnungsfassung verschickt würde: ausschließlich das archivierte PDF dieser Fassung an die Adresse aus der Rechnungskopie. */
export async function planInvoiceMail(tenantId: string, versionId: string): Promise<InvoiceMailPlan> {
  const v = await db.invoiceVersion.findFirst({ where: { id: versionId, tenantId }, select: { id: true, status: true, kind: true, versionNo: true, invoiceId: true } });
  if (!v) throw new DomainError("Rechnungsfassung nicht gefunden.");
  const inv = await db.invoice.findFirst({ where: { id: v.invoiceId, tenantId }, select: { id: true, bookingId: true, contractId: true, status: true, number: true } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  if (v.status !== "FINALIZED" || inv.status !== "FINALIZED" || !inv.number) throw new DomainError("Eine Rechnung wird erst nach dem Abschluss versendet.");
  if (!inv.contractId) throw new DomainError("Zu dieser Rechnung gibt es keinen Mietvertrag.");
  const contract = await loadContractDocumentData(tenantId, inv.contractId);
  const d = contract.doc;
  const invoiceData = await loadInvoiceDocumentData(tenantId, v.id);
  const doc = await db.document.findFirst({ where: { tenantId, type: "INVOICE", invoiceVersionId: v.id }, orderBy: { version: "desc" } });
  return {
    kind: "INVOICE",
    bookingId: inv.bookingId,
    handoverId: null,
    invoiceId: inv.id,
    invoiceVersionId: v.id,
    recipient: invoiceData.renterEmail ?? d.renterEmail,
    facts: { renterName: d.renterName, contractNumber: d.number, vehicleTitle: d.vehicleTitle, plate: d.plate, startAt: d.startAt, landlordName: d.landlord.name, landlordContact: d.landlord.contact },
    replyTo: d.landlord.email,
    documents: doc ? [doc] : [],
    missing: doc ? [] : ["Rechnung"],
    invoice: { number: inv.number, grossTotal: invoiceData.doc.totals.gross, dueDate: invoiceData.doc.paymentDueDate, correction: v.kind === "CORRECTION" ? { versionNo: v.versionNo, supersededVersionNo: invoiceData.doc.version.supersedes?.versionNo ?? null } : null },
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
export async function sendHandoverDocuments(tenantId: string, handoverId: string, opts: SendOptions): Promise<SendResult> {
  return sendPlannedDocuments(tenantId, await planHandoverMail(tenantId, handoverId), opts);
}

/** Versendet das PDF genau dieser Rechnungsfassung. Jeder Versuch hängt an der Fassung (EmailLog.invoiceVersionId). */
export async function sendInvoiceDocument(tenantId: string, versionId: string, opts: SendOptions): Promise<SendResult> {
  return sendPlannedDocuments(tenantId, await planInvoiceMail(tenantId, versionId), opts);
}

async function sendPlannedDocuments(tenantId: string, plan: PickupMailPlan & { invoice?: InvoiceMailPlan["invoice"] }, opts: SendOptions): Promise<SendResult> {
  const template = plan.kind === "RETURN" ? RETURN_MAIL_TEMPLATE : plan.kind === "INVOICE" ? (plan.invoice?.correction ? INVOICE_CORRECTION_MAIL_TEMPLATE : INVOICE_MAIL_TEMPLATE) : PICKUP_MAIL_TEMPLATE;
  const subjectId = plan.invoiceVersionId ?? plan.invoiceId ?? plan.handoverId ?? plan.bookingId;
  if (plan.missing.length > 0) throw new DomainError(`Es fehlt noch: ${plan.missing.join(" und ")}. Bitte zuerst das PDF erzeugen.`);
  if (opts.trigger === "MANUAL" && !/^[A-Za-z0-9-]{8,64}$/.test(opts.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");

  const versions = plan.documents.map((doc) => `${doc.id}v${doc.version}`).join("+");
  const idempotencyKey = `${template}:${subjectId}:${versions}${opts.trigger === "MANUAL" ? `:manual:${opts.nonce}` : ""}`;
  const mail = plan.kind === "INVOICE" && plan.invoice ? composeInvoiceMail({ ...plan.facts, invoiceNumber: plan.invoice.number, grossTotal: plan.invoice.grossTotal, dueDate: plan.invoice.dueDate, correction: plan.invoice.correction }) : plan.kind === "RETURN" ? composeReturnMail(plan.facts) : composePickupMail(plan.facts);
  const { log, created } = await claimEmail({
    tenantId,
    bookingId: plan.bookingId,
    handoverId: plan.handoverId,
    invoiceId: plan.invoiceId ?? null,
    invoiceVersionId: plan.invoiceVersionId ?? null,
    recipient: plan.recipient ?? "(keine Adresse)",
    subject: mail.subject,
    template,
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

export const sendPickupDocuments = sendHandoverDocuments;
