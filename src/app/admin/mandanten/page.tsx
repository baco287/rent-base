import Link from "next/link";
import { requirePlatform } from "@/lib/platform-auth";
import { listTenantsForPlatform } from "@/lib/platform-tenants";
import { Content, PageHeader, Chip } from "@/components/ui";
import { TENANT_STATUS, type TenantStatus } from "@/lib/constants";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Mandanten" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function statusTone(status: string): "good" | "amber" | "bad" | "grey" {
  return status === "ACTIVE" ? "good" : status === "SUSPENDED" ? "bad" : "amber";
}

export default async function TenantListPage({ searchParams }: PageProps<"/admin/mandanten">) {
  await requirePlatform();
  const sp = await searchParams;
  const query = typeof sp.q === "string" ? sp.q : undefined;
  const page = Math.max(1, Number(sp.seite) || 1);
  const { rows, total } = await listTenantsForPlatform({ query, page, pageSize: PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader title="Mandanten" sub={`${total} Autovermietungen`}>
        <Link href="/admin/mandanten/neu" className="btn btn-primary">Neue Autovermietung</Link>
      </PageHeader>
      <Content>
        <form className="mb-4 flex gap-2" action="/admin/mandanten">
          <input name="q" defaultValue={query ?? ""} placeholder="Firmenname, Owner-E-Mail oder Kurzname" className="input flex-1 max-w-md" />
          <button type="submit" className="btn">Suchen</button>
        </form>

        <div className="card">
          {rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-ink-3">Keine Mandanten gefunden.</div>
          ) : (
            <>
              {/* Smartphone: Karten statt breiter Tabelle */}
              <ul className="md:hidden divide-y divide-line-soft">
                {rows.map((t) => (
                  <li key={t.id} className="px-4 py-3 flex flex-col gap-1">
                    <div className="flex justify-between items-baseline gap-2">
                      <Link href={`/admin/mandanten/${t.id}`} className="font-medium text-brand hover:underline">{t.name}</Link>
                      <Chip tone={statusTone(t.status)}>{TENANT_STATUS[t.status as TenantStatus] ?? t.status}</Chip>
                    </div>
                    <div className="text-xs text-ink-3">{t.slug} · angelegt {fmtDate(t.createdAt)}</div>
                    <div className="text-sm">{t.owner ? `${t.owner.name} · ${t.owner.email}` : t.pendingOwnerInvite ? <span className="text-amber">Einladung offen: {t.pendingOwnerInvite.email}</span> : <span className="text-ink-3">Kein Inhaber</span>}</div>
                    <div className="text-xs text-ink-3">{t.userCount} Benutzer · {t.vehicleCount} Fahrzeuge</div>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-ink-3 text-left">
                    <tr>
                      <th className="px-4 py-2 font-medium">Firma</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Inhaber</th>
                      <th className="px-4 py-2 font-medium">Benutzer</th>
                      <th className="px-4 py-2 font-medium">Fahrzeuge</th>
                      <th className="px-4 py-2 font-medium">Angelegt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {rows.map((t) => (
                      <tr key={t.id} className="hover:bg-surface-2">
                        <td className="px-4 py-2.5"><Link href={`/admin/mandanten/${t.id}`} className="font-medium text-brand hover:underline">{t.name}</Link><div className="text-xs text-ink-3">{t.slug}</div></td>
                        <td className="px-4 py-2.5"><Chip tone={statusTone(t.status)}>{TENANT_STATUS[t.status as TenantStatus] ?? t.status}</Chip></td>
                        <td className="px-4 py-2.5">{t.owner ? <>{t.owner.name}<div className="text-xs text-ink-3">{t.owner.email}</div></> : t.pendingOwnerInvite ? <span className="text-amber">Einladung offen: {t.pendingOwnerInvite.email}</span> : <span className="text-ink-3">–</span>}</td>
                        <td className="px-4 py-2.5">{t.userCount}</td>
                        <td className="px-4 py-2.5">{t.vehicleCount}</td>
                        <td className="px-4 py-2.5 text-ink-3">{fmtDate(t.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {pages > 1 && (
          <div className="mt-4 flex gap-2 items-center text-sm">
            {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
              <Link key={p} href={`/admin/mandanten?${query ? `q=${encodeURIComponent(query)}&` : ""}seite=${p}`} className={`px-2.5 py-1 rounded-md ${p === page ? "bg-brand text-white" : "hover:bg-surface-2"}`}>{p}</Link>
            ))}
          </div>
        )}
      </Content>
    </>
  );
}
