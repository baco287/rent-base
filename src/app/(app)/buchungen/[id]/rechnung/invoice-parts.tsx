// Anzeige einer Rechnung aus InvoiceDocumentData. Server-Komponenten ohne Zustand; für Entwurf und Abschluss gleich,
// damit die Vorschau genau dem entspricht, was später versiegelt und als PDF erzeugt wird.
import { Card, Chip } from "@/components/ui";
import type { InvoiceDocumentData } from "@/lib/invoice-view";
import type { InvoiceIssue } from "@/lib/invoices";

export function InvoiceIssueList({ issues, okText }: { issues: InvoiceIssue[]; okText: string }) {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  if (issues.length === 0) return <p className="rounded-md bg-good-soft text-good px-3 py-2 text-sm font-medium">{okText}</p>;
  return (
    <div className="flex flex-col gap-2">
      {errors.length > 0 && (
        <div role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">
          <div className="font-semibold mb-1">Prüfung: {errors.length === 1 ? "1 Punkt verhindert den Abschluss" : `${errors.length} Punkte verhindern den Abschluss`}</div>
          <ul className="list-disc pl-5 flex flex-col gap-0.5">{errors.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">
          <div className="font-semibold mb-1">Hinweise</div>
          <ul className="list-disc pl-5 flex flex-col gap-0.5">{warnings.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/** Rechnungsempfänger, Leistungszeitraum und Rechnungssteller aus den Kopien der Rechnung. */
export function InvoiceHeadCards({ doc }: { doc: InvoiceDocumentData }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
      <Card title="Rechnungsempfänger">
        <div className="p-4 text-sm flex flex-col gap-0.5">
          <span className="font-medium">{doc.customer.name || <span className="text-bad">Kein Name</span>}</span>
          {doc.customer.addressLines.length > 0 ? doc.customer.addressLines.map((l) => <span key={l}>{l}</span>) : <span className="text-bad">Keine Anschrift</span>}
          {doc.customer.number && <span className="text-ink-3 text-xs mt-1">Kundennummer {doc.customer.number}</span>}
          {doc.customer.email && <span className="text-ink-3 text-xs break-all">{doc.customer.email}</span>}
          <span className="text-[11px] text-ink-3 mt-1">Kopie aus dem Mietvertrag. Spätere Änderungen am Kunden wirken sich nicht aus.</span>
        </div>
      </Card>
      <Card title="Leistung">
        <dl className="p-4 text-sm grid grid-cols-[110px_1fr] gap-y-1.5">
          <dt className="label-xs self-center">Zeitraum</dt><dd className="font-mono tnum text-xs">{doc.servicePeriod}</dd>
          <dt className="label-xs self-center">Mietvertrag</dt><dd>{doc.reference.contractNumber ?? "–"}</dd>
          <dt className="label-xs self-center">Buchung</dt><dd>{doc.reference.bookingNumber ?? "–"}</dd>
          <dt className="label-xs self-center">Rückgabe</dt><dd>{doc.reference.returnNumber ?? "–"}</dd>
          {doc.issueDate && <><dt className="label-xs self-center">Rechnungsdatum</dt><dd className="font-mono tnum">{doc.issueDate}</dd></>}
          {doc.paymentDueDate && <><dt className="label-xs self-center">Zahlbar bis</dt><dd className="font-mono tnum">{doc.paymentDueDate}</dd></>}
        </dl>
      </Card>
      <Card title="Rechnungssteller">
        <div className="p-4 text-sm flex flex-col gap-0.5">
          <span className="font-medium">{doc.company.fullName}</span>
          {doc.company.addressLines.map((l) => <span key={l}>{l}</span>)}
          {doc.company.taxLine ? <span className="text-ink-3 text-xs mt-1">{doc.company.taxLine}</span> : <span className="text-bad text-xs mt-1">Steuernummer oder USt-IdNr. fehlt</span>}
          {doc.company.bankLines.map((l) => <span key={l} className="text-ink-3 text-xs">{l}</span>)}
          {doc.status === "DRAFT" && <span className="text-[11px] text-ink-3 mt-1">Wird beim Abschluss aus den aktuellen Einstellungen übernommen und eingefroren.</span>}
        </div>
      </Card>
    </div>
  );
}

/** Abgeschlossene Rechnung: Positionen, Steuer, Summen und Texte, nur lesend. */
export function InvoiceDocumentView({ doc }: { doc: InvoiceDocumentData }) {
  const v = doc.version;
  // Gegenbelege: eigene Betragsbezeichnung und Bezug auf die Rechnung; keine Zahlungsaufforderung
  const counter = doc.documentType !== "INVOICE";
  const amountLabel = doc.documentType === "CREDIT_NOTE" ? "Gutschriftbetrag" : doc.documentType === "CANCELLATION" ? "Stornobetrag" : doc.nonTaxable ? "Gesamtforderung" : "Rechnungsbetrag";
  return (
    <div className="flex flex-col gap-4">
      {v.versionNo > 1 && (
        <div className={`rounded-md px-3.5 py-2.5 text-sm ${v.kind === "CORRECTION" ? "bg-amber-soft text-amber" : "bg-panel-2 text-ink-2"}`}>
          <span className="font-semibold">{v.kind === "CORRECTION" ? "Berichtigte Rechnung" : "Neufassung"} · Fassung {v.versionNo}</span>
          {v.correctionDate && <> · {v.kind === "CORRECTION" ? "Berichtigt am" : "vom"} {v.correctionDate}</>}
          {v.supersedes && <> · Diese Fassung ersetzt Fassung {v.supersedes.versionNo}{v.supersedes.finalizedAt ? ` vom ${v.supersedes.finalizedAt}` : ""}.</>}
          {v.reason && <div className="mt-1">Grund der Berichtigung: {v.reason}</div>}
        </div>
      )}
      <InvoiceHeadCards doc={doc} />
      <Card title="Positionen" right={doc.nonTaxable ? <Chip tone="info">nicht steuerbar</Chip> : <Chip>{doc.pricesIncludeTax ? "Einzelpreise brutto" : "Einzelpreise netto"}</Chip>}>
        <div className="overflow-x-auto">
          <table className={`w-full text-sm ${doc.nonTaxable ? "min-w-[520px]" : "min-w-[720px]"}`}>
            {doc.nonTaxable ? (
              <thead><tr className="text-left text-xs text-ink-3 border-b border-line-soft"><th className="px-4 py-2 font-medium w-10">Pos.</th><th className="px-2 py-2 font-medium">Beschreibung</th><th className="px-2 py-2 font-medium text-right">Menge</th><th className="px-2 py-2 font-medium text-right">Einzelbetrag</th><th className="px-4 py-2 font-medium text-right">Betrag</th></tr></thead>
            ) : (
              <thead><tr className="text-left text-xs text-ink-3 border-b border-line-soft"><th className="px-4 py-2 font-medium w-10">Pos.</th><th className="px-2 py-2 font-medium">Beschreibung</th><th className="px-2 py-2 font-medium text-right">Menge</th><th className="px-2 py-2 font-medium text-right">Einzelpreis</th><th className="px-2 py-2 font-medium text-right">USt.</th><th className="px-2 py-2 font-medium text-right">Netto</th><th className="px-2 py-2 font-medium text-right">Steuer</th><th className="px-4 py-2 font-medium text-right">Brutto</th></tr></thead>
            )}
            <tbody>
              {doc.items.map((i) => (
                <tr key={i.index} className="border-b border-line-soft align-top">
                  <td className="px-4 py-2 text-ink-3">{i.index}</td>
                  <td className="px-2 py-2 whitespace-pre-line">{i.description}</td>
                  <td className="px-2 py-2 text-right font-mono tnum">{i.quantity} {i.unit}</td>
                  <td className="px-2 py-2 text-right font-mono tnum">{i.unitPrice}</td>
                  {!doc.nonTaxable && <td className="px-2 py-2 text-right font-mono tnum">{i.taxRate}</td>}
                  {!doc.nonTaxable && <td className="px-2 py-2 text-right font-mono tnum">{i.net}</td>}
                  {!doc.nonTaxable && <td className="px-2 py-2 text-right font-mono tnum">{i.tax}</td>}
                  <td className="px-4 py-2 text-right font-mono tnum font-semibold">{i.gross}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Card title={counter ? "Texte auf dem Beleg" : "Texte auf der Rechnung"}>
          <div className="p-4 text-sm flex flex-col gap-2">
            {counter && doc.original && <p><span className="label-xs">Bezug</span><br />Zu Rechnung {doc.original.number}{doc.original.date ? ` vom ${doc.original.date}` : ""}{doc.original.versionNo > 1 ? ` (Fassung ${doc.original.versionNo})` : ""}</p>}
            {counter && doc.reason && <p><span className="label-xs">Grund</span><br />{doc.reason}</p>}
            {counter && <p className="text-ink-2">Aus diesem Beleg kann sich ein Guthaben zu Ihren Gunsten ergeben, soweit die Rechnung bereits bezahlt wurde. Eine Erstattung ist mit diesem Beleg nicht verbunden; sie wird gesondert abgestimmt.</p>}
            {!counter && (doc.paymentDueDate ? <p>Zahlbar bis {doc.paymentDueDate}{doc.paymentTermDays != null ? ` (${doc.paymentTermDays} Tage nach Rechnungsdatum)` : ""} ohne Abzug.</p> : <p className="text-ink-3">Kein Zahlungsziel hinterlegt.</p>)}
            {doc.taxTreatmentNote ? <p><span className="label-xs">Steuerliche Behandlung</span><br />{doc.taxTreatmentNote}</p> : doc.taxTreatmentLabel ? <p><span className="label-xs">Steuerliche Behandlung</span><br />{doc.taxTreatmentLabel}.</p> : null}
            {doc.hasZeroRate && doc.taxNote && <p><span className="label-xs">Steuerhinweis</span><br />{doc.taxNote}</p>}
            {doc.customerNote && <p className="whitespace-pre-line">{doc.customerNote}</p>}
            {doc.company.invoiceFooter && <p className="text-xs text-ink-3 whitespace-pre-line">{doc.company.invoiceFooter}</p>}
          </div>
        </Card>
        <Card title={doc.nonTaxable ? "Forderung" : "Steuerzusammenfassung"}>
          <div className="p-4 text-sm flex flex-col gap-1.5">
            {doc.nonTaxable && <div className="flex justify-between"><span className="text-ink-3">Nicht steuerbarer Schadensersatz</span><span className="font-mono tnum">{doc.totals.gross}</span></div>}
            {doc.nonTaxable && <div className="flex justify-between text-base font-semibold border-t-2 border-ink pt-2"><span>{amountLabel}</span><span className="font-mono tnum">{doc.totals.gross}</span></div>}
            {doc.nonTaxable && <p className="text-xs text-ink-3">Keine Umsatzsteuer ausgewiesen (echter Schadensersatz, nicht steuerbar).</p>}
            {!doc.nonTaxable && doc.taxSummary.map((t) => <div key={t.rate} className="flex justify-between"><span className="text-ink-3">{t.rate} USt. auf {t.net}</span><span className="font-mono tnum">{t.tax}</span></div>)}
            {!doc.nonTaxable && <div className="flex justify-between border-t border-line-soft pt-2"><span className="text-ink-3">Nettobetrag</span><span className="font-mono tnum">{doc.totals.net}</span></div>}
            {!doc.nonTaxable && <div className="flex justify-between"><span className="text-ink-3">Steuer</span><span className="font-mono tnum">{doc.totals.tax}</span></div>}
            {!doc.nonTaxable && <div className="flex justify-between text-base font-semibold border-t-2 border-ink pt-2"><span>{amountLabel}</span><span className="font-mono tnum">{doc.totals.gross}</span></div>}
          </div>
        </Card>
      </div>
      {doc.contentHash && <div className="text-[11px] text-ink-3 font-mono break-all">Prüfsumme (SHA-256) {doc.contentHash}</div>}
    </div>
  );
}
