// Befehl 23.1: PDF und E-Mail einer Rechnung ohne Mietvertrag (freie Rechnung, deren Gegenbelege und Mahngebühren).
// Gleiche Aktionen und gleiches Archiv/Versandprotokoll wie der Dokumentenbereich der Buchung – nur ohne Vertrag/Protokolle.
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { Card, Chip } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { isValidEmail } from "@/lib/mail";
import { generateInvoicePdfAction, resendInvoiceAction } from "./actions";
import { DocActionButton, ResendForm } from "./document-forms";

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export async function InvoiceDocumentsCard({ tenantId, invoiceId, role }: { tenantId: string; invoiceId: string; role: string }) {
  const inv = await db.invoice.findFirst({ where: { id: invoiceId, tenantId, status: "FINALIZED" }, select: { id: true, number: true, documentType: true, currentVersion: { select: { id: true, versionNo: true, customerSnapshot: true } } } });
  if (!inv?.currentVersion) return null;
  const v = inv.currentVersion;
  const [doc, emails, dunningDocs] = await Promise.all([
    db.document.findFirst({ where: { tenantId, invoiceVersionId: v.id }, orderBy: { version: "desc" } }),
    db.emailLog.findMany({ where: { tenantId, invoiceVersionId: v.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    db.document.findMany({ where: { tenantId, type: "DUNNING_NOTICE", dunningNotice: { invoiceId } }, orderBy: { createdAt: "desc" } }),
  ]);
  const word = inv.documentType === "CREDIT_NOTE" ? "Gutschrift" : inv.documentType === "CANCELLATION" ? "Stornobeleg" : "Rechnung";
  const recipient = (v.customerSnapshot as { email?: string | null } | null)?.email?.trim() || null;
  const canSend = role !== "YARD";
  return (
    <Card title="Dokument und E-Mail" right={doc ? <Chip tone="good">✓ PDF erstellt</Chip> : <Chip tone="amber">PDF noch nicht erzeugt</Chip>}>
      <div className="p-4 flex flex-col gap-3 text-sm">
        {doc ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all">{doc.fileName}</span>
            <span className="text-xs text-ink-3">{fmtDateTime(doc.createdAt)} · {kb(doc.sizeBytes)}</span>
            <a href={`/api/documents/${doc.id}?download=1`} className="btn !py-2.5">PDF herunterladen</a>
          </div>
        ) : (
          <DocActionButton action={generateInvoicePdfAction.bind(null, null, inv.id)} label={`${word}-PDF erzeugen`} pendingLabel="PDF wird erzeugt…" primary />
        )}
        {canSend && (
          <ResendForm action={resendInvoiceAction.bind(null, null, inv.id)} recipient={recipient} nonce={randomUUID()} label={emails.some((e) => e.status === "SENT") ? `${word} erneut senden` : `${word} per E-Mail senden`} disabledReason={!doc ? "Versendet werden kann, sobald das PDF vorliegt." : !isValidEmail(recipient) ? "Zum Rechnungsempfänger ist keine gültige E-Mail-Adresse hinterlegt." : null} />
        )}
        {emails.length > 0 && (
          <div>
            <div className="label-xs mb-1">Versandhistorie</div>
            <ul className="divide-y divide-line-soft">
              {emails.map((e) => (
                <li key={e.id} className="py-1.5 flex flex-wrap gap-x-2">
                  <span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(e.lastAttemptAt ?? e.createdAt)}</span>
                  <span className="break-all">{e.recipient}</span>
                  <span className={e.status === "SENT" ? "text-good font-medium" : e.status === "FAILED" ? "text-bad font-medium" : "text-amber font-medium"}>{e.status === "SENT" ? "Erfolgreich" : e.status === "FAILED" ? `Fehlgeschlagen – ${e.error ?? "Grund unbekannt"}` : "Nicht bestätigt"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {dunningDocs.length > 0 && (
          <div>
            <div className="label-xs mb-1">Mahnschreiben</div>
            <ul className="flex flex-col gap-1">
              {dunningDocs.map((d) => <li key={d.id}><a href={`/api/documents/${d.id}?download=1`} className="underline break-all">{d.fileName}</a> <span className="text-xs text-ink-3">{fmtDateTime(d.createdAt)}</span></li>)}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
