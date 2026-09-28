import Link from "next/link";
import { notFound } from "next/navigation";
import { can, requirePlatform } from "@/lib/platform-auth";
import { userDetailForPlatform } from "@/lib/platform-users";
import { auditActionLabel, auditDetailsView } from "@/lib/platform-audit";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { INVITATION_STATUS, PLATFORM_ROLES, ROLES, type InvitationStatus, type PlatformRole, type Role } from "@/lib/constants";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Notice, PlatformRoleChip, Rows, TenantStatusChip } from "../../ui";
import { UserActiveButton } from "../forms";
import { PlatformRoleForm } from "../../system/forms";

export const metadata = { title: "Benutzer" };
export const dynamic = "force-dynamic";

export default async function PlatformUserDetailPage({ params, searchParams }: PageProps<"/admin/benutzer/[id]">) {
  const session = await requirePlatform("USERS_VIEW");
  const { id } = await params;
  const sp = await searchParams;
  const detail = await userDetailForPlatform(id);
  if (!detail) notFound();
  const { user, activeSessions, audit, invitations, supportSessions } = detail;

  return (
    <>
      <PageHeader title={user.name} sub={user.email}>
        {user.active ? <Chip tone="good">Aktiv</Chip> : <Chip tone="bad">Gesperrt</Chip>}
        <Chip tone={user.role === "OWNER" ? "info" : "grey"}>{ROLES[user.role as Role] ?? user.role}</Chip>
        <PlatformRoleChip role={user.platformRole} />
        <Link href="/admin/benutzer" className="btn">Zur Benutzerliste</Link>
      </PageHeader>
      <Content>
        <Notice sp={sp} />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <Card title="Konto">
            <div className="p-4 flex flex-col gap-4">
              <Rows rows={[
                ["Mandant", <span key="t" className="flex items-center gap-2"><Link href={`/admin/mandanten/${user.tenant.id}`} className="text-brand hover:underline">{user.tenant.name}</Link><TenantStatusChip status={user.tenant.status} /></span>],
                ["Mandantenrolle", ROLES[user.role as Role] ?? user.role],
                ["Plattformrolle", PLATFORM_ROLES[user.platformRole as PlatformRole] ?? user.platformRole],
                ["Status", user.active ? "Aktiv" : "Gesperrt (deaktiviert)"],
                ["Letzte Anmeldung", user.lastLoginAt ? fmtDateTime(user.lastLoginAt) : "noch nie"],
                ["Aktive Sitzungen", activeSessions],
                ["Angelegt", fmtDateTime(user.createdAt)],
                ["Zuletzt geändert", fmtDateTime(user.updatedAt)],
                ["Benutzer-ID", <span key="id" className="font-mono text-xs">{user.id}</span>],
              ]} />
              <p className="text-xs text-ink-3">Passwörter werden nie angezeigt oder gesetzt. Ein Benutzer setzt sein Passwort ausschließlich selbst über „Passwort vergessen“.</p>
              <div className="flex gap-2 items-start">
                <UserActiveButton userId={user.id} active={user.active} canManage={can(session, "USER_MANAGE") && user.id !== session.user.id} />
                {user.id === session.user.id && <span className="text-xs text-ink-3">Das eigene Konto kann hier nicht gesperrt werden.</span>}
              </div>
            </div>
          </Card>

          <Card title="Interne Plattformrolle" right={<Chip tone="grey">nur Super-Admin</Chip>}>
            <div className="p-4 flex flex-col gap-3 text-sm">
              <p className="text-ink-2">Interne Rollen gelten für das Control Center und sind von der Mandantenrolle getrennt. Änderungen werden mit vorher/nachher protokolliert; der letzte aktive Super-Admin kann nicht herabgestuft werden.</p>
              {user.id === session.user.id ? <p className="text-xs text-ink-3">Die eigene Plattformrolle kann nicht selbst geändert werden.</p> : <PlatformRoleForm userId={user.id} currentRole={user.platformRole} canManage={can(session, "PLATFORM_ROLE_MANAGE")} compact />}
              {supportSessions.length > 0 && (
                <div>
                  <div className="label-xs mb-1">Supportzugriffe dieses Kontos</div>
                  <ul className="text-xs text-ink-3 flex flex-col gap-1">
                    {supportSessions.map((s) => <li key={s.id}>{fmtDateTime(s.startedAt)} · {s.tenant.name} · „{s.reason}“{s.endedAt ? ` · beendet ${fmtDateTime(s.endedAt)}` : s.expiresAt > new Date() ? " · aktiv" : " · abgelaufen"}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </Card>

          <Card title="Einladungen zu diesem Konto">
            <ul className="divide-y divide-line-soft text-sm">
              {invitations.map((inv) => <li key={inv.id} className="px-4 py-2 flex justify-between gap-2"><span>{ROLES[inv.role as Role] ?? inv.role} · {fmtDate(inv.createdAt)}{inv.invitedByName ? ` · von ${inv.invitedByName}` : ""}</span><Chip tone={inv.status === "ACCEPTED" ? "good" : inv.status === "PENDING" ? "amber" : "grey"}>{INVITATION_STATUS[inv.status as InvitationStatus] ?? inv.status}</Chip></li>)}
              {invitations.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Keine Einladungen (Konto aus der Ersteinrichtung oder aus einer früheren Version).</li>}
            </ul>
          </Card>

          <Card title="Protokoll (ausgeführt von oder betreffend dieses Konto)">
            <ul className="divide-y divide-line-soft text-sm">
              {audit.map((a) => {
                const d = auditDetailsView(a.details);
                return (
                  <li key={a.id} className="px-4 py-2 flex flex-col gap-0.5">
                    <div className="flex justify-between gap-2 flex-wrap"><span className="font-medium">{auditActionLabel(a.action)}</span><span className="text-xs text-ink-3 tnum">{fmtDateTime(a.createdAt)} · {a.userName ?? "System"}</span></div>
                    {(d.fields.length > 0 || d.after.length > 0) && <div className="text-xs text-ink-3 flex flex-wrap gap-x-3">{d.fields.map(([k, v]) => <span key={k}>{k}: {v}</span>)}{d.after.map(([k, v], i) => <span key={`a-${k}`}>{k}: {d.before[i]?.[1] ?? "–"} → {v}</span>)}</div>}
                  </li>
                );
              })}
              {audit.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Keine Einträge.</li>}
            </ul>
          </Card>
        </div>
      </Content>
    </>
  );
}
