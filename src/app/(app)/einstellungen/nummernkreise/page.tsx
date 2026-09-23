import Link from "next/link";
import { Fragment } from "react";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { NUMBER_RANGE_LABELS, RANGE_OF_TYPE, numberRangesOf, type InvoiceDocumentType, type NumberRangeKey } from "@/lib/number-ranges";
import { previewNextNumbers } from "@/lib/numbering";
import { NumberRangesForm } from "./forms";

export const metadata = { title: "Nummernkreise" };

/** Nummernkreise für Rechnungen, Gutschriften und Stornobelege. Inhaber bearbeitet das Präfix, alle anderen sehen den Stand. */
export default async function NumberRangesPage() {
  const { tenant, user } = await requireSession();
  const isOwner = user.role === "OWNER";
  const ranges = numberRangesOf(tenant.numberRanges);
  const next = await previewNextNumbers(db, tenant.id, ranges);
  const nextByKey = { ...Object.fromEntries((Object.keys(RANGE_OF_TYPE) as InvoiceDocumentType[]).map((t) => [RANGE_OF_TYPE[t], next[t]])), payout: next.PAYOUT } as Record<NumberRangeKey, string>;
  const counts = await db.invoice.groupBy({ by: ["documentType"], where: { tenantId: tenant.id, status: "FINALIZED" }, _count: true });
  const payoutCount = await db.payout.count({ where: { tenantId: tenant.id, status: { in: ["COMPLETED", "CANCELLED"] } } });
  const countOf = (t: InvoiceDocumentType) => counts.find((c) => c.documentType === t)?._count ?? 0;

  return (
    <>
      <PageHeader title="Nummernkreise" sub="Belegnummern für Rechnungen, Gutschriften und Stornobelege">
        <Link href="/einstellungen" className="btn">Einstellungen</Link>
        <Link href="/rechnungen" className="btn">Rechnungen</Link>
      </PageHeader>
      <Content>
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 items-start">
          <Card title="Präfixe" right={<Chip>{isOwner ? "Inhaber" : "nur lesend"}</Chip>}>
            {isOwner ? (
              <NumberRangesForm prefixes={{ invoice: ranges.invoice.prefix, creditNote: ranges.creditNote.prefix, cancellation: ranges.cancellation.prefix, payout: ranges.payout.prefix }} next={nextByKey} />
            ) : (
              <dl className="p-5 grid grid-cols-[180px_1fr] gap-y-1.5 text-sm">
                {(Object.keys(NUMBER_RANGE_LABELS) as NumberRangeKey[]).map((k) => (
                  <Fragment key={k}>
                    <dt className="label-xs self-center">{NUMBER_RANGE_LABELS[k]}</dt>
                    <dd className="font-mono tnum">{ranges[k].prefix}-JJJJ-NNNNNN · nächste {nextByKey[k]}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
          </Card>
          <Card title="So funktionieren die Nummern">
            <div className="p-4 text-sm flex flex-col gap-2 text-ink-2">
              <p>Jeder Kreis zählt für sich, fortlaufend je Kalenderjahr: <span className="font-mono">{ranges.invoice.prefix}-{new Date().getFullYear()}-000001</span>, dann 000002 und so weiter. Zum Jahreswechsel beginnt jeder Kreis wieder bei 000001.</p>
              <p>Die Nummer wird erst beim Abschluss vergeben und ist danach fest. Verworfene Entwürfe hatten nie eine Nummer; eine vergebene Nummer wird nie wiederverwendet oder neu vergeben, auch nicht nach einem Storno.</p>
              <p>Ein geändertes Präfix gilt nur für künftige Belege und beginnt einen neuen Zähler. Bestehende Belege behalten ihre Nummer. Die drei Präfixe müssen sich unterscheiden, damit jede Nummer im Mandanten eindeutig bleibt.</p>
              <dl className="grid grid-cols-[1fr_auto] gap-y-1 mt-1">
                <dt>Abgeschlossene Rechnungen</dt><dd className="font-mono tnum text-right">{countOf("INVOICE")}</dd>
                <dt>Abgeschlossene Gutschriften</dt><dd className="font-mono tnum text-right">{countOf("CREDIT_NOTE")}</dd>
                <dt>Abgeschlossene Stornobelege</dt><dd className="font-mono tnum text-right">{countOf("CANCELLATION")}</dd>
                <dt>Abgeschlossene Auszahlungen (inkl. stornierte)</dt><dd className="font-mono tnum text-right">{payoutCount}</dd>
              </dl>
            </div>
          </Card>
        </div>
      </Content>
    </>
  );
}
