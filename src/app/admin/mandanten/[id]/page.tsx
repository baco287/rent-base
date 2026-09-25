import { notFound } from "next/navigation";
import { requirePlatform } from "@/lib/platform-auth";
import { tenantDetailForPlatform } from "@/lib/platform-tenants";
import { reactivateTenantAction, resendOwnerInvitationAction, revokeOwnerInvitationAction } from "@/app/admin/actions";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { ROLES, TENANT_STATUS, INVITATION_STATUS, type Role, type TenantStatus, type InvitationStatus } from "@/lib/constants";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { SuspendTenantForm, StartSupportForm } from "./forms";

export const metadata = { title: "Mandant" };
export const dynamic = "force-dynamic";

function statusTone(status: string): "good" | "amber" | "bad" | "grey" {
  return status === "ACTIVE" ? "good" : status === "SUSPENDED" ? "bad" : "amber";
}

export default async function TenantDetailPage({ params }: PageProps<"/admin/mandanten/[id]">) {
  await requirePlatform();
  const { id } = await params;
  const detail = await tenantDetailForPlatform(id);
  if (!detail) notFound();
  const { tenant, users, invitations, supportSessions, vehicleCount } = detail;
  const reactivate = reactivateTenantAction.bind(null, tenant.id);

  return (
    <>
      <PageHeader title={tenant.name} sub={tenant.slug}>
        <Chip tone={statusTone(tenant.status)}>{TENANT_STATUS[tenant.status as TenantStatus] ?? tenant.status}</Chip>
      </PageHeader>
      <Content>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <Card title="Mandant">
            <dl className="p-5 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
              <dt className="label-xs self-center">Angelegt</dt><dd>{fmtDate(tenant.createdAt)}</dd>
              <dt className="label-xs self-center">Benutzer</dt><dd>{users.filter((u) => u.active).length} aktiv von {users.length}</dd>
              <dt className="label-xs self-center">Fahrzeuge</dt><dd>{vehicleCount}</dd>
              {tenant.status === "SUSPENDED" && (
                <>
                  <dt className="label-xs self-center">Gesperrt seit</dt><dd>{tenant.suspendedAt ? fmtDateTime(tenant.suspendedAt) : "–"}</dd>
                  <dt className="label-xs self-center">Grund</dt><dd>{tenant.suspendedReason}</dd>
                  <dt className="label-xs self-center">Gesperrt von</dt><dd>{tenant.suspendedByName}</dd>
                </>
              )}
            </dl>
            <div className="px-5 pb-5">
              {tenant.status === "SUSPENDED" ? (
                <form action={reactivate}><button type="submit" className="btn btn-primary">Mandant reaktivieren</button></form>
              ) : (
                <SuspendTenantForm tenantId={tenant.id} />
              )}
            </div>
          </Card>

          <Card title="Supportzugriff" right={<Chip tone="grey">read-only</Chip>}>
            <div className="p-5 flex flex-col gap-4 text-sm">
              <p className="text-ink-2">Zeigt die normale Oberfläche dieses Mandanten schreibgeschützt, zeitlich begrenzt und vollständig protokolliert. Ausweis-/Führerscheinkopien, Behörden- und Schadendokumente bleiben auch hier gesperrt.</p>
              <StartSupportForm tenantId={tenant.id} />
              {supportSessions.length > 0 && (
                <div>
                  <div className="label-xs mb-1">Letzte Zugriffe</div>
                  <ul className="text-xs text-ink-3 flex flex-col gap-1">
                    {supportSessions.map((s) => (
                      <li key={s.id}>{fmtDateTime(s.startedAt)} · {s.superAdminName} · „{s.reason}“{s.endedAt ? ` · beendet ${fmtDateTime(s.endedAt)}` : s.expiresAt > new Date() ? " · aktiv" : " · abgelaufen"}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Card>

          <Card title="Benutzer" className="xl:col-span-2">
            <ul className="divide-y divide-line-soft">
              {users.map((u) => (
                <li key={u.id} className="px-4 py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-ink-3">{u.email}{u.lastLoginAt ? ` · zuletzt angemeldet ${fmtDateTime(u.lastLoginAt)}` : " · noch nie angemeldet"}</div>
                  </div>
                  <Chip tone={u.role === "OWNER" ? "info" : "grey"}>{ROLES[u.role as Role] ?? u.role}</Chip>
                  {!u.active && <Chip tone="bad">Deaktiviert</Chip>}
                </li>
              ))}
              {users.length === 0 && <li className="px-4 py-6 text-center text-ink-3 text-sm">Noch kein Benutzer – die Einladung des Inhabers wurde noch nicht angenommen.</li>}
            </ul>
          </Card>

          <Card title="Einladungen" className="xl:col-span-2">
            <ul className="divide-y divide-line-soft">
              {invitations.map((inv) => {
                const resend = resendOwnerInvitationAction.bind(null, tenant.id, inv.id);
                const revoke = revokeOwnerInvitationAction.bind(null, tenant.id, inv.id);
                return (
                  <li key={inv.id} className="px-4 py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{inv.email}</div>
                      <div className="text-xs text-ink-3">{ROLES[inv.role as Role] ?? inv.role} · angelegt {fmtDate(inv.createdAt)}{inv.status === "PENDING" ? ` · gültig bis ${fmtDateTime(inv.expiresAt)}` : ""}</div>
                    </div>
                    <Chip tone={inv.status === "PENDING" ? "amber" : inv.status === "ACCEPTED" ? "good" : "grey"}>{INVITATION_STATUS[inv.status as InvitationStatus] ?? inv.status}</Chip>
                    {inv.status === "PENDING" && (
                      <div className="flex gap-2">
                        <form action={resend}><button className="btn !py-1">Erneut senden</button></form>
                        <form action={revoke}><button className="btn !py-1">Widerrufen</button></form>
                      </div>
                    )}
                  </li>
                );
              })}
              {invitations.length === 0 && <li className="px-4 py-6 text-center text-ink-3 text-sm">Keine Einladungen.</li>}
            </ul>
          </Card>
        </div>
      </Content>
    </>
  );
}
