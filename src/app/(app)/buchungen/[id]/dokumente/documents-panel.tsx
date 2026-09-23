// Bereich "Dokumente" und "E-Mail" einer Buchung. Wird auf der Buchungsseite und bei den finalisierten
// Protokollen gezeigt. Alle Zustände stammen aus Archiv (Document) und Versandprotokoll (EmailLog):
// "versendet" steht hier nur, wenn der Versand tatsächlich bestätigt wurde.
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { Card, Chip } from "@/components/ui";
import { DOCUMENT_TYPES, type DocumentType } from "@/lib/constants";
import { listBookingDocuments } from "@/lib/documents";
import { listBookingEmails } from "@/lib/email-log";
import { fmtDateTime } from "@/lib/format";
import { isValidEmail, mailStatus } from "@/lib/mail";
import { storageStatus } from "@/lib/storage";
import { generateContractPdfAction, generateHandoverPdfAction, generateInvoicePdfAction, regenerateHandoverPdfAction, resendDocumentsAction, resendInvoiceAction } from "./actions";
import { DocActionButton, ResendForm } from "./document-forms";

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** invoiceId: eine bestimmte Rechnung dieser Buchung (Schadenabrechnung); ohne Angabe die Mietrechnung. */
export async function DocumentsPanel({ tenantId, bookingId, role, invoiceId = null }: { tenantId: string; bookingId: string; role: string; invoiceId?: string | null }) {
  const [contract, handovers, invoice, documents, emails] = await Promise.all([
    db.rentalContract.findFirst({ where: { bookingId, tenantId }, select: { id: true, number: true, status: true, customerSnapshot: true } }),
    db.handover.findMany({ where: { bookingId, tenantId, status: "FINALIZED", correctsId: null }, orderBy: { finalizedAt: "desc" }, select: { id: true, number: true, type: true } }),
    db.invoice.findFirst({ where: { bookingId, tenantId, status: "FINALIZED", ...(invoiceId ? { id: invoiceId } : { kind: "RENTAL", documentType: "INVOICE" }) }, select: { id: true, number: true, kind: true, documentType: true, currentVersionId: true, currentVersion: { select: { id: true, versionNo: true, customerSnapshot: true } } } }),
    listBookingDocuments(tenantId, bookingId),
    listBookingEmails(tenantId, bookingId, 16),
  ]);
  if (!contract || contract.status !== "SIGNED") return null;

  const storage = storageStatus();
  const mail = mailStatus();
  const isOwner = role === "OWNER";
  const recipient = (contract.customerSnapshot as { email?: string | null } | null)?.email?.trim() || null;
  const invoiceRecipient = (invoice?.currentVersion?.customerSnapshot as { email?: string | null } | null)?.email?.trim() || null;
  const currentVersionId = invoice?.currentVersion?.id ?? null;
  // Gegenbelege (Gutschrift, Stornobeleg) haben ihren eigenen Dokumenttyp und immer einen eigenen Schlüssel
  const invoiceDocType: DocumentType = invoice?.documentType === "CREDIT_NOTE" ? "CREDIT_NOTE" : invoice?.documentType === "CANCELLATION" ? "CANCELLATION" : "INVOICE";
  const invoiceKey = invoice && (invoice.kind === "DAMAGE" || invoiceDocType !== "INVOICE") ? invoice.id : null;
  const invoiceWord = invoiceDocType === "CREDIT_NOTE" ? "Gutschrift" : invoiceDocType === "CANCELLATION" ? "Stornobeleg" : invoice?.kind === "DAMAGE" ? "Schadenabrechnung" : "Rechnung";
  const canSendInvoice = role !== "YARD";
  const pickup = handovers.find((h) => h.type === "PICKUP");
  const ret = handovers.find((h) => h.type === "RETURN");
  // Rechnung: nur das PDF der aktuellen Fassung zählt hier; ältere Fassungen sind auf der Rechnungsseite im Fassungsverlauf
  const latest = (type: DocumentType) => documents.find((d) => d.type === type && (type !== invoiceDocType || d.invoiceVersionId === currentVersionId));

  type DocAction = (prev: import("./actions").DocState, fd: FormData) => Promise<import("./actions").DocState>;
  const rows: { type: DocumentType; available: boolean; action: DocAction; regenerate?: DocAction; generateLabel: string; waitText: string }[] = [
    { type: "RENTAL_CONTRACT", available: true, action: generateContractPdfAction.bind(null, bookingId), generateLabel: "Mietvertrag-PDF erzeugen", waitText: "" },
    { type: "PICKUP_PROTOCOL", available: !!pickup, action: generateHandoverPdfAction.bind(null, bookingId, "PICKUP"), regenerate: regenerateHandoverPdfAction.bind(null, bookingId, "PICKUP"), generateLabel: "Übergabeprotokoll-PDF erzeugen", waitText: "nach der Übergabe" },
    { type: "RETURN_PROTOCOL", available: !!ret, action: generateHandoverPdfAction.bind(null, bookingId, "RETURN"), regenerate: regenerateHandoverPdfAction.bind(null, bookingId, "RETURN"), generateLabel: "Rückgabeprotokoll-PDF erzeugen", waitText: "nach der Rückgabe" },
    { type: invoiceDocType, available: !!currentVersionId, action: generateInvoicePdfAction.bind(null, bookingId, invoiceKey), generateLabel: `${invoiceWord}-PDF erzeugen`, waitText: "nach Abschluss der Rechnung" },
  ];

  const mailBlocks = [
    pickup ? { kind: "PICKUP" as const, title: "E-Mail nach der Übergabe", handover: pickup, ready: !!latest("RENTAL_CONTRACT") && !!latest("PICKUP_PROTOCOL"), readyText: "Versendet werden kann, sobald Mietvertrag und Übergabeprotokoll als PDF vorliegen." } : null,
    ret ? { kind: "RETURN" as const, title: "E-Mail nach der Rückgabe", handover: ret, ready: !!latest("RETURN_PROTOCOL"), readyText: "Versendet werden kann, sobald das Rückgabeprotokoll als PDF vorliegt." } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  const invoiceBlock = invoice && currentVersionId ? { title: `E-Mail mit ${invoiceWord} ${invoice.number}${(invoice.currentVersion?.versionNo ?? 1) > 1 ? ` (Fassung ${invoice.currentVersion!.versionNo})` : ""}`, ready: !!latest(invoiceDocType), readyText: "Versendet werden kann, sobald der Beleg als PDF vorliegt.", emails: emails.filter((e) => e.invoiceVersionId === currentVersionId) } : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      <Card title="Dokumente">
        {!storage.configured && (
          <p role="alert" className="mx-4 mt-3 rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">
            Der Dateispeicher ist noch nicht eingerichtet. PDFs können erst erzeugt und archiviert werden, wenn er in den Servereinstellungen hinterlegt ist.
            {isOwner && <span className="block mt-1 font-mono text-xs">Fehlt: {storage.missing.join(", ")}</span>}
          </p>
        )}
        <ul className="divide-y divide-line-soft">
          {rows.map((r) => {
            const doc = latest(r.type);
            const older = documents.filter((d) => d.type === r.type && d.id !== doc?.id && (r.type !== invoiceDocType || d.invoiceVersionId === currentVersionId));
            return (
              <li key={r.type} className="px-4 py-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="font-medium">{r.type === invoiceDocType && invoice && (invoice.kind === "DAMAGE" || invoiceDocType !== "INVOICE") ? `${invoiceWord} ${invoice.number}` : DOCUMENT_TYPES[r.type]}</span>
                  {doc ? <Chip tone="good">✓ erstellt</Chip> : r.available ? <Chip tone="amber">noch nicht erzeugt</Chip> : <Chip>{r.waitText}</Chip>}
                </div>
                {doc && (
                  <>
                    <div className="text-sm text-ink-2 break-all">{doc.fileName}</div>
                    <div className="text-xs text-ink-3">erstellt am {fmtDateTime(doc.createdAt)} · Version {doc.version} · {kb(doc.sizeBytes)}</div>
                    <div className="flex flex-wrap gap-2">
                      <a href={`/api/documents/${doc.id}`} target="_blank" rel="noopener noreferrer" className="btn">Anzeigen</a>
                      <a href={`/api/documents/${doc.id}?download=1`} className="btn">Herunterladen</a>
                    </div>
                    <div className="text-[11px] text-ink-3 font-mono break-all">SHA-256 {doc.checksum}</div>
                    {older.map((o) => (
                      <div key={o.id} className="text-xs text-ink-3">Frühere Version {o.version} vom {fmtDateTime(o.createdAt)}: <a className="underline" href={`/api/documents/${o.id}`} target="_blank" rel="noopener noreferrer">anzeigen</a></div>
                    ))}
                    {isOwner && r.regenerate && (
                      <details className="text-xs text-ink-3">
                        <summary className="cursor-pointer">PDF neu erzeugen (nur Inhaber)</summary>
                        <div className="mt-2 flex flex-col gap-2">
                          <p>Erzeugt aus demselben versiegelten Protokollinhalt eine neue PDF-Version, z. B. nach einer Verbesserung der PDF-Darstellung. Die bisherige Datei bleibt als frühere Version erhalten; es wird nichts versendet.</p>
                          <DocActionButton action={r.regenerate} label="Neue PDF-Version erzeugen" pendingLabel="PDF wird erzeugt…" />
                        </div>
                      </details>
                    )}
                  </>
                )}
                {!doc && r.available && <DocActionButton action={r.action} label={r.generateLabel} pendingLabel="PDF wird erzeugt…" primary />}
              </li>
            );
          })}
        </ul>
      </Card>

      {(mailBlocks.length > 0 || invoiceBlock) && (
        <div className="flex flex-col gap-4">
          {!mail.configured && (
            <p role="alert" className="rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">
              Der E-Mail-Versand ist noch nicht eingerichtet.
              {isOwner && <span className="block mt-1 font-mono text-xs">Fehlt: {mail.missing.join(", ")}</span>}
            </p>
          )}
          {mailBlocks.map((m) => {
            const own = emails.filter((e) => e.handoverId === m.handover.id);
            const last = own[0];
            return (
              <Card key={m.kind} title={m.title}>
                <div className="px-4 py-3 flex flex-col gap-3">
                  <MailStatus last={last} />
                  {!isValidEmail(recipient) && <p className="text-sm text-bad">Im Mietvertrag ist keine gültige E-Mail-Adresse hinterlegt. Die Unterlagen können heruntergeladen und persönlich übergeben werden.</p>}
                  <ResendForm
                    action={resendDocumentsAction.bind(null, bookingId, m.kind)}
                    recipient={recipient}
                    nonce={randomUUID()}
                    label={last?.status === "SENT" ? "Unterlagen erneut senden" : last ? "E-Mail erneut senden" : "Unterlagen jetzt senden"}
                    disabledReason={!m.ready ? m.readyText : null}
                  />
                  <MailHistory rows={own} />
                </div>
              </Card>
            );
          })}
          {invoiceBlock && (
            <Card title={invoiceBlock.title}>
              <div className="px-4 py-3 flex flex-col gap-3">
                <MailStatus last={invoiceBlock.emails[0]} />
                {!isValidEmail(invoiceRecipient) && <p className="text-sm text-bad">Im Beleg ist keine gültige E-Mail-Adresse hinterlegt. Der Beleg kann heruntergeladen und persönlich übergeben werden.</p>}
                {canSendInvoice ? (
                  <ResendForm
                    action={resendInvoiceAction.bind(null, bookingId, invoiceKey)}
                    recipient={invoiceRecipient}
                    nonce={randomUUID()}
                    label={invoiceBlock.emails[0]?.status === "SENT" ? `${invoiceWord} erneut senden` : invoiceBlock.emails[0] ? "E-Mail erneut senden" : `${invoiceWord} jetzt senden`}
                    disabledReason={!invoiceBlock.ready ? invoiceBlock.readyText : null}
                  />
                ) : (
                  <p className="text-sm text-ink-3">Der Versand erfolgt durch die Disposition.</p>
                )}
                <MailHistory rows={invoiceBlock.emails} />
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

type EmailRow = Awaited<ReturnType<typeof listBookingEmails>>[number];

function MailStatus({ last }: { last: EmailRow | undefined }) {
  if (!last) return <div><Chip tone="amber">Noch nicht versendet</Chip></div>;
  if (last.status === "SENT") return <div className="flex flex-col gap-1"><div><Chip tone="good">✓ Unterlagen versendet</Chip></div><div className="text-sm text-ink-2">{fmtDateTime(last.sentAt)} · <span className="break-all">{last.recipient}</span></div></div>;
  if (last.status === "FAILED") return <div className="flex flex-col gap-1"><div><Chip tone="bad">⚠ E-Mail-Versand fehlgeschlagen</Chip></div><div className="text-sm text-ink-2">{fmtDateTime(last.lastAttemptAt ?? last.createdAt)} · {last.error ?? "Grund unbekannt"}</div></div>;
  return <div className="flex flex-col gap-1"><div><Chip tone="amber">Versand nicht bestätigt</Chip></div><div className="text-sm text-ink-2">Der Versuch vom {fmtDateTime(last.createdAt)} wurde nicht abgeschlossen. Bei Bedarf erneut senden.</div></div>;
}

function MailHistory({ rows }: { rows: EmailRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="label-xs mb-1">Versandhistorie</div>
      <ul className="text-sm divide-y divide-line-soft">
        {rows.map((e) => (
          <li key={e.id} className="py-1.5 flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono tnum text-xs text-ink-3">{fmtDateTime(e.lastAttemptAt ?? e.createdAt)}</span>
            <span className="break-all">{e.recipient}</span>
            <span className={e.status === "SENT" ? "text-good font-medium" : e.status === "FAILED" ? "text-bad font-medium" : "text-amber font-medium"}>
              {e.status === "SENT" ? "Erfolgreich" : e.status === "FAILED" ? `Fehlgeschlagen – ${e.error ?? "Grund unbekannt"}` : "Nicht bestätigt"}
            </span>
            <span className="text-xs text-ink-3">Versuch {e.attemptNo}{e.trigger === "MANUAL" ? ", manuell" : ", automatisch"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
