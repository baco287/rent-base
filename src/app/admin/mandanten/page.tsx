import Link from "next/link";
import { can, requirePlatform } from "@/lib/platform-auth";
import { listTenantsForPlatform } from "@/lib/platform-tenants";
import { Content, PageHeader } from "@/components/ui";
import { PLANS, SUBSCRIPTION_STATUS, TENANT_STATUS } from "@/lib/constants";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { EmptyRow, Notice, Pagination, PlanChip, SubscriptionStatusChip, Td, TenantStatusChip, Th, withParams } from "../ui";

export const metadata = { title: "Kunden" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

export default async function TenantListPage({ searchParams }: PageProps<"/admin/mandanten">) {
  const session = await requirePlatform("PLATFORM_VIEW");
  const sp = await searchParams;
  const filter = { query: str(sp.q), status: str(sp.status), plan: str(sp.tarif), subscriptionStatus: str(sp.abo), sort: (str(sp.sort) as "newest" | "name" | "activity" | undefined) ?? "newest" };
  const page = Math.max(1, Number(sp.seite) || 1);
  const { rows, total } = await listTenantsForPlatform({ ...filter, page, pageSize: PAGE_SIZE });
  const href = (p: number) => withParams("/admin/mandanten", { q: filter.query, status: filter.status, tarif: filter.plan, abo: filter.subscriptionStatus, sort: filter.sort === "newest" ? undefined : filter.sort, seite: p > 1 ? p : undefined });

  return (
    <>
      <PageHeader title="Kunden" sub={`${total} Mandanten`}>
        {can(session, "TENANT_CREATE") && <Link href="/admin/mandanten/neu" className="btn btn-primary">Neue Autovermietung</Link>}
      </PageHeader>
      <Content>
        <Notice sp={sp} />
        <form className="card p-3 grid grid-cols-2 md:grid-cols-[1fr_auto_auto_auto_auto_auto] gap-2 items-end" action="/admin/mandanten">
          <label className="flex flex-col gap-1 col-span-2 md:col-span-1">
            <span className="label-xs">Suche</span>
            <input name="q" defaultValue={filter.query ?? ""} placeholder="Firmenname, Kurzname oder Benutzer-E-Mail" className="input" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-xs">Status</span>
            <select name="status" defaultValue={filter.status ?? ""} className="input">
              <option value="">Alle</option>
              {Object.entries(TENANT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-xs">Tarif</span>
            <select name="tarif" defaultValue={filter.plan ?? ""} className="input">
              <option value="">Alle</option>
              <option value="NONE">Kein Tarif</option>
              {Object.entries(PLANS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-xs">Abo-Status</span>
            <select name="abo" defaultValue={filter.subscriptionStatus ?? ""} className="input">
              <option value="">Alle</option>
              {Object.entries(SUBSCRIPTION_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-xs">Sortierung</span>
            <select name="sort" defaultValue={filter.sort} className="input">
              <option value="newest">Neueste zuerst</option>
              <option value="name">Firmenname</option>
              <option value="activity">Letzte Aktivität</option>
            </select>
          </label>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary">Filtern</button>
            <Link href="/admin/mandanten" className="btn">Zurücksetzen</Link>
          </div>
        </form>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-ink-3">
              <tr>
                <Th>Firma</Th>
                <Th>Kundennr.</Th>
                <Th>Status</Th>
                <Th>Tarif</Th>
                <Th className="text-right">Benutzer</Th>
                <Th className="text-right">Fahrzeuge</Th>
                <Th className="text-right">Buchungen</Th>
                <Th>Registriert</Th>
                <Th>Letzte Aktivität</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-surface-2">
                  <Td>
                    <Link href={`/admin/mandanten/${t.id}`} className="font-medium text-brand hover:underline">{t.name}</Link>
                    <div className="text-xs text-ink-3">{t.owner ? `${t.owner.name} · ${t.owner.email}` : t.pendingOwnerInvite ? <span className="text-amber">Einladung offen: {t.pendingOwnerInvite.email}</span> : "Kein Inhaber"}</div>
                  </Td>
                  <Td><span className="font-mono text-xs">{t.slug}</span></Td>
                  <Td><TenantStatusChip status={t.status} /></Td>
                  <Td>
                    <div className="flex flex-col gap-1 items-start"><PlanChip plan={t.plan} /><SubscriptionStatusChip status={t.subscriptionStatus} /></div>
                    {t.subscriptionStatus === "TRIAL" && t.trialEndsAt && <div className="text-xs text-ink-3 mt-1">bis {fmtDate(t.trialEndsAt)}</div>}
                  </Td>
                  <Td className="text-right tnum">{t.userCount}</Td>
                  <Td className="text-right tnum">{t.vehicleCount}</Td>
                  <Td className="text-right tnum">{t.bookingCount}</Td>
                  <Td className="text-ink-3 whitespace-nowrap">{fmtDate(t.createdAt)}</Td>
                  <Td className="text-ink-3 whitespace-nowrap">{t.lastActivityAt ? fmtDateTime(t.lastActivityAt) : "noch keine Anmeldung"}</Td>
                </tr>
              ))}
              {rows.length === 0 && <EmptyRow colSpan={9}>Keine Mandanten gefunden.</EmptyRow>}
            </tbody>
          </table>
        </div>
        <Pagination page={page} total={total} pageSize={PAGE_SIZE} href={href} />
      </Content>
    </>
  );
}
