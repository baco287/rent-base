import Link from "next/link";
import { requirePlatform } from "@/lib/platform-auth";
import { PLATFORM_AUDIT_ACTIONS, auditActionLabel, auditDetailsView, listPlatformAudit, platformAuditActors } from "@/lib/platform-audit";
import { tenantOptions } from "@/lib/platform-tenants";
import { Content, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { EmptyRow, Notice, Pagination, Td, Th, withParams } from "../ui";

export const metadata = { title: "Audit Log" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
const dateOf = (v: string | undefined, end = false) => (v ? new Date(`${v}T${end ? "23:59:59" : "00:00:00"}`) : undefined);

export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  await requirePlatform("AUDIT_VIEW");
  const sp = await searchParams;
  const f = { tenantId: str(sp.mandant), action: str(sp.aktion), actorId: str(sp.akteur), query: str(sp.q), von: str(sp.von), bis: str(sp.bis), scope: str(sp.umfang) === "alle" ? ("all" as const) : ("platform" as const) };
  const page = Math.max(1, Number(sp.seite) || 1);
  const [{ rows, total }, tenants, actors] = await Promise.all([
    listPlatformAudit({ tenantId: f.tenantId, action: f.action, actorId: f.actorId, query: f.query, from: dateOf(f.von), to: dateOf(f.bis, true), scope: f.scope, page, pageSize: PAGE_SIZE }),
    tenantOptions(),
    platformAuditActors(),
  ]);
  const href = (p: number) => withParams("/admin/audit", { mandant: f.tenantId, aktion: f.action, akteur: f.actorId, q: f.query, von: f.von, bis: f.bis, umfang: f.scope === "all" ? "alle" : undefined, seite: p > 1 ? p : undefined });

  return (
    <>
      <PageHeader title="Audit Log" sub={`${total} Einträge · ${f.scope === "all" ? "alle Aktionen" : "Plattform-Aktionen"}`} />
      <Content>
        <Notice sp={sp} />
        <form className="card p-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-[1fr_1fr_1fr_1fr_auto_auto_auto] gap-2 items-end" action="/admin/audit">
          <label className="flex flex-col gap-1"><span className="label-xs">Mandant</span>
            <select name="mandant" defaultValue={f.tenantId ?? ""} className="input"><option value="">Alle</option>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </label>
          <label className="flex flex-col gap-1"><span className="label-xs">Aktion</span>
            <select name="aktion" defaultValue={f.action ?? ""} className="input"><option value="">Alle Plattform-Aktionen</option>{PLATFORM_AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{auditActionLabel(a)}</option>)}</select>
          </label>
          <label className="flex flex-col gap-1"><span className="label-xs">Akteur</span>
            <select name="akteur" defaultValue={f.actorId ?? ""} className="input"><option value="">Alle</option>{actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          </label>
          <label className="flex flex-col gap-1"><span className="label-xs">Suche (Akteur/Firma)</span><input name="q" defaultValue={f.query ?? ""} className="input" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Von</span><input type="date" name="von" defaultValue={f.von ?? ""} className="input" /></label>
          <label className="flex flex-col gap-1"><span className="label-xs">Bis</span><input type="date" name="bis" defaultValue={f.bis ?? ""} className="input" /></label>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" name="umfang" value="alle" defaultChecked={f.scope === "all"} /> alle Aktionen (auch fachliche)</label>
            <div className="flex gap-2"><button type="submit" className="btn btn-primary">Filtern</button><Link href="/admin/audit" className="btn">Zurücksetzen</Link></div>
          </div>
        </form>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-ink-3">
              <tr><Th>Zeitpunkt</Th><Th>Akteur</Th><Th>Aktion</Th><Th>Ziel / Mandant</Th><Th>Details (vorher → nachher)</Th></tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rows.map((a) => {
                const d = auditDetailsView(a.details);
                return (
                  <tr key={a.id} className="hover:bg-surface-2 align-top">
                    <Td className="whitespace-nowrap tnum text-ink-2">{fmtDateTime(a.createdAt)}</Td>
                    <Td>{a.userName ?? <span className="text-ink-3">System</span>}{a.userId && <div className="text-[10px] text-ink-3 font-mono">{a.userId.slice(0, 10)}…</div>}</Td>
                    <Td className="font-medium">{auditActionLabel(a.action)}</Td>
                    <Td><Link href={`/admin/mandanten/${a.tenant.id}`} className="text-brand hover:underline">{a.tenant.name}</Link>{a.bookingId && <div className="text-xs text-ink-3">Buchung {a.bookingId.slice(0, 8)}…</div>}</Td>
                    <Td>
                      <div className="text-xs text-ink-2 flex flex-col gap-0.5">
                        {d.fields.map(([k, v]) => <span key={k}><span className="text-ink-3">{k}:</span> {v}</span>)}
                        {d.after.map(([k, v], i) => <span key={`a-${k}`}><span className="text-ink-3">{k}:</span> <span className="line-through text-ink-3">{d.before[i]?.[1] ?? "–"}</span> → <span className="font-medium">{v}</span></span>)}
                        {d.fields.length === 0 && d.after.length === 0 && <span className="text-ink-3">–</span>}
                      </div>
                    </Td>
                  </tr>
                );
              })}
              {rows.length === 0 && <EmptyRow colSpan={5}>Keine Einträge für diesen Filter.</EmptyRow>}
            </tbody>
          </table>
        </div>
        <Pagination page={page} total={total} pageSize={PAGE_SIZE} href={href} />
        <p className="text-xs text-ink-3">Das Protokoll wird in derselben Transaktion wie die jeweilige Aktion geschrieben. Passwörter, Tokens und Verbindungsdaten werden nie protokolliert; Felder mit solchen Namen werden zusätzlich bei der Anzeige unterdrückt.</p>
      </Content>
    </>
  );
}
