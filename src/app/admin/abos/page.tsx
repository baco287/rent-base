import Link from "next/link";
import { can, requirePlatform } from "@/lib/platform-auth";
import { billingOverview } from "@/lib/subscriptions";
import { Content, KPI, PageHeader } from "@/components/ui";
import { PLANS, SUBSCRIPTION_STATUS } from "@/lib/constants";
import { fmtDate } from "@/lib/format";
import { EmptyRow, Notice, PlanChip, SubscriptionStatusChip, Td, TenantStatusChip, Th, eur } from "../ui";

export const metadata = { title: "Abos" };
export const dynamic = "force-dynamic";

const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

export default async function BillingPage({ searchParams }: PageProps<"/admin/abos">) {
  const session = await requirePlatform("BILLING_VIEW");
  const sp = await searchParams;
  const query = str(sp.q);
  const status = str(sp.status);
  const plan = str(sp.tarif);
  const { rows, totals } = await billingOverview({ query, status, plan });
  const canManage = can(session, "BILLING_MANAGE");
  const now = new Date();

  return (
    <>
      <PageHeader title="Tarife & Abonnements" sub="interne Erfassung – keine automatische Abrechnung" />
      <Content>
        <Notice sp={sp} />
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <KPI label="MRR" value={totals.mrrCents == null ? "–" : eur(totals.mrrCents)} detail={totals.mrrCents == null ? "keine Preise erfasst" : `${totals.pricedCount} Abos mit Preis`} />
          <KPI label="ARR" value={totals.arrCents == null ? "–" : eur(totals.arrCents)} detail="MRR × 12" />
          <KPI label="Aktiv" value={totals.byStatus.ACTIVE} />
          <KPI label="Testphase" value={totals.byStatus.TRIAL} detail={totals.trialsEndingSoon > 0 ? `${totals.trialsEndingSoon} enden in 7 Tagen` : undefined} hot={totals.trialsEndingSoon > 0} />
          <KPI label="Überfällig / gekündigt" value={totals.byStatus.PAST_DUE + totals.byStatus.CANCELLED} detail={`${totals.byStatus.ENDED} beendet`} hot={totals.byStatus.PAST_DUE > 0} />
          <KPI label="Ohne Tarif" value={totals.withoutSubscription} hot={totals.withoutSubscription > 0} />
        </div>

        <form className="card p-3 grid grid-cols-2 md:grid-cols-[1fr_auto_auto_auto] gap-2 items-end" action="/admin/abos">
          <label className="flex flex-col gap-1 col-span-2 md:col-span-1"><span className="label-xs">Suche</span><input name="q" defaultValue={query ?? ""} placeholder="Firmenname oder Kurzname" className="input" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Abo-Status</span>
            <select name="status" defaultValue={status ?? ""} className="input"><option value="">Alle</option><option value="NONE">Ohne Tarif</option>{Object.entries(SUBSCRIPTION_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
          <label className="flex flex-col gap-1"><span className="label-xs">Tarif</span>
            <select name="tarif" defaultValue={plan ?? ""} className="input"><option value="">Alle</option>{Object.entries(PLANS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
          <div className="flex gap-2"><button type="submit" className="btn btn-primary">Filtern</button><Link href="/admin/abos" className="btn">Zurücksetzen</Link></div>
        </form>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-ink-3">
              <tr><Th>Mandant</Th><Th>Tarif</Th><Th>Abo-Status</Th><Th>Start</Th><Th>Testphase bis</Th><Th>Kündigung</Th><Th className="text-right">Monatspreis</Th><Th className="text-right">Benutzer</Th><Th className="text-right">Fahrzeuge</Th><Th className="text-right">Aktion</Th></tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rows.map((r) => {
                const s = r.subscription;
                const userLimit = s?.maxUsers ? `${r.activeUsers} / ${s.maxUsers}` : `${r.activeUsers}`;
                const vehicleLimit = s?.maxVehicles ? `${r.vehicles} / ${s.maxVehicles}` : `${r.vehicles}`;
                return (
                  <tr key={r.tenantId} className="hover:bg-surface-2">
                    <Td><Link href={`/admin/mandanten/${r.tenantId}#abo`} className="font-medium text-brand hover:underline">{r.tenantName}</Link><div className="mt-0.5"><TenantStatusChip status={r.tenantStatus} /></div></Td>
                    <Td><PlanChip plan={s?.plan} /></Td>
                    <Td><SubscriptionStatusChip status={s?.status} /></Td>
                    <Td className="text-ink-3 whitespace-nowrap">{s ? fmtDate(s.startedAt) : "–"}</Td>
                    <Td className="whitespace-nowrap">{s?.trialEndsAt ? <span className={s.trialEndsAt < now ? "text-bad" : ""}>{fmtDate(s.trialEndsAt)}</span> : "–"}</Td>
                    <Td className="text-ink-3 whitespace-nowrap">{s?.cancelledAt ? `${fmtDate(s.cancelledAt)}${s.endsAt ? ` → ${fmtDate(s.endsAt)}` : ""}` : "–"}</Td>
                    <Td className="text-right tnum">{eur(s?.monthlyPriceCents)}</Td>
                    <Td className={`text-right tnum ${s?.maxUsers && r.activeUsers >= s.maxUsers ? "text-amber font-medium" : ""}`}>{userLimit}</Td>
                    <Td className={`text-right tnum ${s?.maxVehicles && r.vehicles >= s.maxVehicles ? "text-amber font-medium" : ""}`}>{vehicleLimit}</Td>
                    <Td className="text-right"><Link href={`/admin/mandanten/${r.tenantId}#abo`} className="btn !py-1">{canManage ? (s ? "Bearbeiten" : "Tarif anlegen") : "Ansehen"}</Link></Td>
                  </tr>
                );
              })}
              {rows.length === 0 && <EmptyRow colSpan={10}>Keine Mandanten für diesen Filter.</EmptyRow>}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-3">Tarifnamen und Status sind interne Kennzeichnungen (lib/constants.ts). Limits werden beim Einladen von Benutzern und beim Anlegen von Fahrzeugen serverseitig geprüft; „∞“ bzw. leer = unbegrenzt.</p>
      </Content>
    </>
  );
}
