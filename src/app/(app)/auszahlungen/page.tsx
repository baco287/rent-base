import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, Empty, PageHeader } from "@/components/ui";
import { PAYOUT_METHODS, PAYOUT_SOURCE_TYPES, type PayoutMethod, type PayoutSourceType } from "@/lib/constants";
import { customerName, fmtDate, fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { listPayouts, openPayoutClaims, type PayoutFilter } from "@/lib/payouts";
import { parseLocalDateTime } from "@/lib/time";
import { PayoutStatusChip } from "./payout-panel";

export const metadata = { title: "Auszahlungen" };

const STATUS: { key: NonNullable<PayoutFilter["status"]>; label: string }[] = [
  { key: "offen", label: "Offen" },
  { key: "abgeschlossen", label: "Ausgezahlt" },
  { key: "storniert", label: "Storniert" },
  { key: "alle", label: "Alle" },
];
const SOURCES: { key: NonNullable<PayoutFilter["source"]>; label: string }[] = [
  { key: "alle", label: "Alle Quellen" },
  { key: "rechnung", label: "Rechnungserstattungen" },
  { key: "kaution", label: "Kautionsauszahlungen" },
];

/**
 * Zentrale Auszahlungsübersicht. „Offen“ heißt: Ansprüche mit noch auszuzahlendem Betrag (auch ohne Entwurf) plus Entwürfe.
 * Nichts hier löst eine Auszahlung aus; Erfassung nur auf der Rechnungs- bzw. Kautionsseite mit Bestätigung.
 */
export default async function PayoutsPage({ searchParams }: PageProps<"/auszahlungen">) {
  const { tenant } = await requireSession();
  const sp = await searchParams;
  const status = STATUS.find((s) => s.key === sp.filter)?.key ?? "offen";
  const source = SOURCES.find((s) => s.key === sp.quelle)?.key ?? "alle";
  const method = typeof sp.weg === "string" && sp.weg in PAYOUT_METHODS ? sp.weg : null;
  const from = typeof sp.von === "string" && sp.von ? parseLocalDateTime(`${sp.von}T00:00`) : null;
  const to = typeof sp.bis === "string" && sp.bis ? parseLocalDateTime(`${sp.bis}T23:59`) : null;
  const q = typeof sp.q === "string" ? sp.q : "";
  const qs = (over: Record<string, string>) => { const u = new URLSearchParams({ filter: status, quelle: source, ...(method ? { weg: method } : {}), ...(typeof sp.von === "string" ? { von: sp.von } : {}), ...(typeof sp.bis === "string" ? { bis: sp.bis } : {}), ...(q ? { q } : {}), ...over }); return `/auszahlungen?${u.toString()}`; };

  const rows = await listPayouts(tenant.id, { status, source, method, from, to: to ? new Date(to.getTime() + 60_000) : null, q });
  const claims = status === "offen" ? await openPayoutClaims(tenant.id) : { invoices: [], deposits: [] };
  const openClaims = [...(source !== "kaution" ? claims.invoices : []), ...(source !== "rechnung" ? claims.deposits : [])].filter((c) => !q || c.number.toLowerCase().includes(q.toLowerCase()) || c.customerName.toLowerCase().includes(q.toLowerCase()) || c.bookingNumber.toLowerCase().includes(q.toLowerCase()));
  const totalOpen = openClaims.reduce((a, c) => a + c.remainingCents, 0);
  const totalRows = rows.filter((p) => p.status === "COMPLETED").reduce((a, p) => a + p.amountCents, 0);
  const sub = status === "offen" ? `${openClaims.length} offene Ansprüche · ${fmtCents(totalOpen)} noch auszuzahlen · ${rows.length} Entwürfe` : `${rows.length} Auszahlungen${status === "abgeschlossen" || status === "alle" ? ` · ausgezahlt ${fmtCents(totalRows)}` : ""}`;

  return (
    <>
      <PageHeader title="Auszahlungen" sub={sub} />
      <Content>
        <div className="flex gap-1.5 flex-wrap">
          {STATUS.map((s) => <Link key={s.key} href={qs({ filter: s.key })} className={`btn !py-1.5 ${s.key === status ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{s.label}</Link>)}
        </div>
        <div className="flex gap-1.5 flex-wrap items-center" aria-label="Quelle">
          {SOURCES.map((s) => <Link key={s.key} href={qs({ quelle: s.key })} className={`btn !py-1.5 ${s.key === source ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{s.label}</Link>)}
          <form className="flex flex-wrap gap-1.5 items-center ml-auto" action="/auszahlungen">
            <input type="hidden" name="filter" value={status} /><input type="hidden" name="quelle" value={source} />
            <select name="weg" defaultValue={method ?? ""} className="input !py-1.5"><option value="">Alle Wege</option>{Object.entries(PAYOUT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <input type="date" name="von" defaultValue={typeof sp.von === "string" ? sp.von : ""} className="input !py-1.5" aria-label="von" />
            <input type="date" name="bis" defaultValue={typeof sp.bis === "string" ? sp.bis : ""} className="input !py-1.5" aria-label="bis" />
            <input name="q" defaultValue={q} placeholder="Nummer, Kunde, Referenz" className="input !py-1.5" />
            <button className="btn !py-1.5">Filtern</button>
          </form>
        </div>

        {status === "offen" && (
          <Card title="Offene Ansprüche" right={<Chip tone={openClaims.length ? "bad" : "grey"}>{openClaims.length}</Chip>}>
            {openClaims.length === 0 ? (
              <Empty>Keine offenen Erstattungen oder Kautionsauszahlungen.</Empty>
            ) : (
              <ul className="divide-y divide-line-soft text-sm">
                {openClaims.map((c) => (
                  <li key={`${c.kind}-${c.number}`} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Chip tone={c.kind === "INVOICE" ? "info" : "amber"}>{c.kind === "INVOICE" ? "Rechnungserstattung" : "Kautionsauszahlung"}</Chip>
                    <Link href={c.href} className="font-mono tnum font-medium hover:underline">{c.kind === "INVOICE" ? c.number : `Buchung ${c.number}`}</Link>
                    <span>{c.customerName}</span>
                    {c.draftCents > 0 && <Chip tone="amber">Entwurf {fmtCents(c.draftCents)}</Chip>}
                    <span className="ml-auto font-mono tnum font-semibold text-bad">{fmtCents(c.remainingCents)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="px-4 pb-3 text-xs text-ink-3">Ansprüche entstehen aus Gutschriften, Stornobelegen, Überzahlungen und Kautionsfreigaben. Erfasst wird eine Auszahlung auf der jeweiligen Rechnungs- oder Buchungsseite; Rent-Base zahlt nichts automatisch aus.</p>
          </Card>
        )}

        <Card title={status === "offen" ? "Entwürfe" : "Auszahlungen"}>
          {rows.length === 0 ? (
            <Empty>{status === "offen" ? "Keine Entwürfe." : "Keine Auszahlungen in dieser Ansicht."}</Empty>
          ) : (
            <>
              <ul className="md:hidden divide-y divide-line-soft">
                {rows.map((p) => (
                  <li key={p.id} className="px-4 py-3 flex flex-col gap-1">
                    <div className="flex justify-between items-baseline gap-2"><Link href={`/auszahlungen/${p.id}`} className="font-mono tnum font-medium hover:underline">{p.number ?? "Entwurf"}</Link><PayoutStatusChip status={p.status} /></div>
                    <div className="text-sm">{p.customer ? customerName(p.customer) : p.recipientName} <span className="text-ink-3">· {PAYOUT_SOURCE_TYPES[p.sourceType as PayoutSourceType]} · {p.executedAt ? fmtDate(p.executedAt) : "ohne Datum"}</span></div>
                    <div className="text-xs flex justify-between"><span className="text-ink-3">{PAYOUT_METHODS[p.method as PayoutMethod]}</span><span className={`font-mono tnum font-semibold ${p.status === "CANCELLED" ? "line-through text-ink-3" : ""}`}>{fmtCents(p.amountCents)}</span></div>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-[13.5px]">
                  <thead><tr className="text-left"><th className="label-xs px-3 py-2 border-b border-line">Nr.</th><th className="label-xs px-3 py-2 border-b border-line">Status</th><th className="label-xs px-3 py-2 border-b border-line">Quelle</th><th className="label-xs px-3 py-2 border-b border-line">Kunde / Empfänger</th><th className="label-xs px-3 py-2 border-b border-line">Weg</th><th className="label-xs px-3 py-2 border-b border-line">Auszahlungsdatum</th><th className="label-xs px-3 py-2 border-b border-line text-right">Betrag</th></tr></thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                        <td className="px-3 py-2.5 font-mono tnum"><Link href={`/auszahlungen/${p.id}`} className="hover:underline font-medium">{p.number ?? "Entwurf"}</Link></td>
                        <td className="px-3 py-2.5"><PayoutStatusChip status={p.status} />{p.historicalEntry && <> <Chip tone="grey">nacherfasst</Chip></>}</td>
                        <td className="px-3 py-2.5 text-xs">{PAYOUT_SOURCE_TYPES[p.sourceType as PayoutSourceType]}<div className="text-ink-3">{p.invoice?.number ? <Link href={`/buchungen/${p.booking.id}/rechnung?nr=${p.invoice.id}`} className="font-mono tnum hover:underline">{p.invoice.number}</Link> : <Link href={`/buchungen/${p.booking.id}#kaution`} className="font-mono tnum hover:underline">{p.booking.number}</Link>}</div></td>
                        <td className="px-3 py-2.5">{p.customer ? <Link href={`/kunden/${p.customer.id}`} className="hover:underline">{customerName(p.customer)}</Link> : "–"}{p.recipientDeviates && <div className="text-xs text-ink-3">Empfänger: {p.recipientName}</div>}</td>
                        <td className="px-3 py-2.5 text-xs">{PAYOUT_METHODS[p.method as PayoutMethod]}{p.ibanMasked && <div className="text-ink-3 font-mono">{p.ibanMasked}</div>}</td>
                        <td className="px-3 py-2.5 font-mono tnum text-xs">{p.executedAt ? fmtDateTime(p.executedAt) : p.plannedAt ? `geplant ${fmtDate(p.plannedAt)}` : "–"}</td>
                        <td className={`px-3 py-2.5 text-right font-mono tnum font-semibold ${p.status === "CANCELLED" ? "line-through text-ink-3" : ""}`}>{fmtCents(p.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
        <p className="text-xs text-ink-3">Nur als „Ausgezahlt“ erfasste Auszahlungen zählen finanziell. Entwürfe mindern nichts; stornierte Auszahlungen bleiben sichtbar und zählen nicht mehr. Rent-Base führt keine Überweisung, Karten- oder Providertransaktion aus.</p>
      </Content>
    </>
  );
}
