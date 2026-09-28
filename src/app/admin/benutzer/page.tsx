import Link from "next/link";
import { can, requirePlatform } from "@/lib/platform-auth";
import { listPendingInvitationsForPlatform, listUsersForPlatform } from "@/lib/platform-users";
import { tenantOptions } from "@/lib/platform-tenants";
import { Chip, Content, PageHeader } from "@/components/ui";
import { ROLES, type Role } from "@/lib/constants";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { EmptyRow, Notice, Pagination, PlatformRoleChip, Td, TenantStatusChip, Th, withParams } from "../ui";
import { ResendInvitationButton, UserActiveButton } from "./forms";

export const metadata = { title: "Benutzer" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;
const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

export default async function PlatformUsersPage({ searchParams }: PageProps<"/admin/benutzer">) {
  const session = await requirePlatform("USERS_VIEW");
  const sp = await searchParams;
  const tab = str(sp.tab) === "einladungen" ? "einladungen" : "benutzer";
  const query = str(sp.q);
  const tenantId = str(sp.mandant);
  const status = (str(sp.status) as "active" | "inactive" | undefined) ?? "";
  const role = str(sp.rolle);
  const internal = str(sp.intern) === "1";
  const page = Math.max(1, Number(sp.seite) || 1);
  const canManage = can(session, "USER_MANAGE");
  const params = { tab: tab === "einladungen" ? tab : undefined, q: query, mandant: tenantId, status: status || undefined, rolle: role, intern: internal ? "1" : undefined };
  const href = (p: number) => withParams("/admin/benutzer", { ...params, seite: p > 1 ? p : undefined });
  const tenants = await tenantOptions();

  const users = tab === "benutzer" ? await listUsersForPlatform({ query, tenantId, status, role, internal, page, pageSize: PAGE_SIZE }) : null;
  const invitations = tab === "einladungen" ? await listPendingInvitationsForPlatform({ query, page, pageSize: PAGE_SIZE }) : null;

  return (
    <>
      <PageHeader title="Benutzer" sub="mandantenübergreifend">
        <nav className="flex gap-1 text-sm" aria-label="Ansicht">
          <Link href={withParams("/admin/benutzer", { q: query })} className={`px-3 py-1.5 rounded-md ${tab === "benutzer" ? "bg-brand text-white" : "hover:bg-surface-2"}`}>Benutzer</Link>
          <Link href={withParams("/admin/benutzer", { tab: "einladungen", q: query })} className={`px-3 py-1.5 rounded-md ${tab === "einladungen" ? "bg-brand text-white" : "hover:bg-surface-2"}`}>Offene Einladungen</Link>
        </nav>
      </PageHeader>
      <Content>
        <Notice sp={sp} />
        <form className="card p-3 grid grid-cols-2 md:grid-cols-[1fr_auto_auto_auto_auto_auto] gap-2 items-end" action="/admin/benutzer">
          {tab === "einladungen" && <input type="hidden" name="tab" value="einladungen" />}
          <label className="flex flex-col gap-1 col-span-2 md:col-span-1">
            <span className="label-xs">Suche</span>
            <input name="q" defaultValue={query ?? ""} placeholder={tab === "benutzer" ? "Name, E-Mail oder Firma" : "E-Mail oder Firma"} className="input" />
          </label>
          {tab === "benutzer" && (
            <>
              <label className="flex flex-col gap-1">
                <span className="label-xs">Mandant</span>
                <select name="mandant" defaultValue={tenantId ?? ""} className="input max-w-56">
                  <option value="">Alle</option>
                  {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="label-xs">Status</span>
                <select name="status" defaultValue={status} className="input">
                  <option value="">Alle</option>
                  <option value="active">Aktiv</option>
                  <option value="inactive">Gesperrt</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="label-xs">Mandantenrolle</span>
                <select name="rolle" defaultValue={role ?? ""} className="input">
                  <option value="">Alle</option>
                  {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm pb-2.5"><input type="checkbox" name="intern" value="1" defaultChecked={internal} /> nur interne Rollen</label>
            </>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary">Filtern</button>
            <Link href={tab === "einladungen" ? "/admin/benutzer?tab=einladungen" : "/admin/benutzer"} className="btn">Zurücksetzen</Link>
          </div>
        </form>

        {users && (
          <>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-ink-3">
                  <tr><Th>Benutzer</Th><Th>Mandant</Th><Th>Rolle</Th><Th>Status</Th><Th>Letzte Anmeldung</Th><Th>Angelegt</Th><Th className="text-right">Aktion</Th></tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {users.rows.map((u) => (
                    <tr key={u.id} className="hover:bg-surface-2">
                      <Td><Link href={`/admin/benutzer/${u.id}`} className="font-medium text-brand hover:underline">{u.name}</Link><div className="text-xs text-ink-3">{u.email}</div></Td>
                      <Td><Link href={`/admin/mandanten/${u.tenant.id}`} className="hover:underline">{u.tenant.name}</Link><div className="mt-0.5"><TenantStatusChip status={u.tenant.status} /></div></Td>
                      <Td><div className="flex flex-col gap-1 items-start"><Chip tone={u.role === "OWNER" ? "info" : "grey"}>{ROLES[u.role as Role] ?? u.role}</Chip><PlatformRoleChip role={u.platformRole} /></div></Td>
                      <Td>{u.active ? <Chip tone="good">Aktiv</Chip> : <Chip tone="bad">Gesperrt</Chip>}</Td>
                      <Td className="text-ink-3 whitespace-nowrap">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "noch nie"}</Td>
                      <Td className="text-ink-3 whitespace-nowrap">{fmtDate(u.createdAt)}</Td>
                      <Td className="text-right"><UserActiveButton userId={u.id} active={u.active} canManage={canManage && u.id !== session.user.id && u.platformRole === "NONE"} /></Td>
                    </tr>
                  ))}
                  {users.rows.length === 0 && <EmptyRow colSpan={7}>Keine Benutzer gefunden.</EmptyRow>}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={users.total} pageSize={PAGE_SIZE} href={href} />
          </>
        )}

        {invitations && (
          <>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-ink-3">
                  <tr><Th>E-Mail</Th><Th>Mandant</Th><Th>Rolle</Th><Th>Eingeladen</Th><Th>Gültig bis</Th><Th className="text-right">Aktion</Th></tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {invitations.rows.map((inv) => {
                    const expired = inv.expiresAt < new Date();
                    return (
                      <tr key={inv.id} className="hover:bg-surface-2">
                        <Td className="font-medium">{inv.email}</Td>
                        <Td><Link href={`/admin/mandanten/${inv.tenant.id}`} className="hover:underline">{inv.tenant.name}</Link></Td>
                        <Td>{ROLES[inv.role as Role] ?? inv.role}</Td>
                        <Td className="text-ink-3 whitespace-nowrap">{fmtDate(inv.createdAt)}{inv.invitedByName ? ` · ${inv.invitedByName}` : ""}</Td>
                        <Td className="whitespace-nowrap">{expired ? <Chip tone="bad">abgelaufen {fmtDate(inv.expiresAt)}</Chip> : <Chip tone="amber">{fmtDateTime(inv.expiresAt)}</Chip>}</Td>
                        <Td className="text-right"><ResendInvitationButton tenantId={inv.tenant.id} invitationId={inv.id} canManage={canManage} /></Td>
                      </tr>
                    );
                  })}
                  {invitations.rows.length === 0 && <EmptyRow colSpan={6}>Keine offenen Einladungen.</EmptyRow>}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={invitations.total} pageSize={PAGE_SIZE} href={href} />
          </>
        )}
      </Content>
    </>
  );
}
