import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { INVITATION_STATUS, ROLES, type InvitationStatus, type Role } from "@/lib/constants";
import { Card, Chip, Content } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { listInvitations } from "@/lib/invitations";
import { initialsOf } from "@/lib/navigation";
import { resendInvitationAction, revokeInvitationAction, toggleUserActiveAction } from "../actions";
import { InviteUserForm } from "../forms";
import { RoleSelect } from "../role-select";
import { SettingsHeader } from "../settings-ui";

export const metadata = { title: "Mitarbeiter & Berechtigungen" };

/** Kurzbeschreibung der Rollen – dieselbe Aussage wie bisher im Einladungsformular, die Rollenregeln selbst bleiben unverändert. */
const ROLE_INFO: Record<Role, string> = { OWNER: "alles", DISPO: "Buchungen und Stammdaten", YARD: "Übergaben und Kunden" };

/**
 * Befehl 29.3.1: Kategorie „Mitarbeiter & Berechtigungen“. Liste, offene Einladungen und Einladen mit den bestehenden
 * Server Actions (alle requireRole("OWNER"), das eigene Konto ist geschützt). Andere Rollen sehen die Liste wie bisher.
 */
export default async function StaffSettingsPage({ searchParams }: PageProps<"/einstellungen/mitarbeiter">) {
  const { tenant, user: me, supportSession } = await requireSession();
  const sp = await searchParams;
  const canEdit = me.role === "OWNER" && !supportSession;
  const users = await db.user.findMany({ where: { tenantId: tenant.id }, orderBy: [{ active: "desc" }, { name: "asc" }] });
  const invitations = canEdit ? (await listInvitations(tenant.id)).filter((i) => i.status === "PENDING") : [];
  const active = users.filter((u) => u.active).length;

  return (
    <>
      <SettingsHeader title="Mitarbeiter & Berechtigungen" sub="Wer in RentBase arbeitet und mit welcher Rolle. Neue Mitarbeiter erhalten eine Einladung per E-Mail und legen ihr Passwort selbst fest.">
        <Chip>{active} aktiv{users.length > active ? ` · ${users.length - active} deaktiviert` : ""}</Chip>
      </SettingsHeader>
      <Content className="max-w-[1180px]">
        {sp.fehler === "selbst" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">Das eigene Konto kann nicht deaktiviert werden.</p>}
        {typeof sp.fehler === "string" && sp.fehler !== "selbst" && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3.5 py-2.5 text-sm">{decodeURIComponent(sp.fehler)}</p>}
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
          <div className="flex flex-col gap-5 min-w-0">
            <Card title="Mitarbeiter" right={<Chip>{users.length}</Chip>}>
              <ul className="divide-y divide-line-soft">
                {users.map((u) => {
                  const toggle = toggleUserActiveAction.bind(null, u.id);
                  return (
                    <li key={u.id} className={`px-4 py-3 flex items-center gap-3 flex-wrap ${u.active ? "" : "bg-panel-2/40"}`}>
                      <span aria-hidden="true" className={`grid size-9 shrink-0 place-items-center rounded-full text-[12.5px] font-semibold ${u.active ? "bg-brand-soft text-brand" : "bg-panel-2 text-ink-3"}`}>{initialsOf(u.name)}</span>
                      <div className="flex-1 min-w-[160px]">
                        <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium ${u.active ? "" : "text-ink-2"}`}>{u.name}{u.id === me.id ? " (du)" : ""}{!u.active && <Chip tone="bad">Deaktiviert</Chip>}</div>
                        <div className="truncate text-xs text-ink-3">{u.email}</div>
                        <div className="text-xs text-ink-3">{u.lastLoginAt ? `zuletzt angemeldet ${fmtDateTime(u.lastLoginAt)}` : "noch nie angemeldet"}</div>
                      </div>
                      {canEdit && u.id !== me.id ? (
                        <RoleSelect key={`${u.id}-${u.role}`} userId={u.id} currentRole={u.role} label={`Rolle von ${u.name}`} />
                      ) : (
                        <Chip tone={u.role === "OWNER" ? "info" : "grey"}>{ROLES[u.role as Role] ?? u.role}</Chip>
                      )}
                      {canEdit && u.id !== me.id && (
                        <form action={toggle}><button className="btn !py-1">{u.active ? "Deaktivieren" : "Aktivieren"}</button></form>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
            {canEdit && invitations.length > 0 && (
              <Card title="Offene Einladungen" right={<Chip>{invitations.length}</Chip>}>
                <ul className="divide-y divide-line-soft">
                  {invitations.map((inv) => {
                    const resend = resendInvitationAction.bind(null, inv.id);
                    const revoke = revokeInvitationAction.bind(null, inv.id);
                    return (
                      <li key={inv.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
                        <div className="flex-1 min-w-[180px]">
                          <div className="font-medium truncate" title={inv.email}>{inv.email}</div>
                          <div className="text-xs text-ink-3">{ROLES[inv.role as Role] ?? inv.role} · {INVITATION_STATUS[inv.status as InvitationStatus] ?? inv.status} · gültig bis {fmtDateTime(inv.expiresAt)}</div>
                        </div>
                        <form action={resend}><button className="btn !py-1">Erneut senden</button></form>
                        <form action={revoke}><button className="btn !py-1">Widerrufen</button></form>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </div>
          <div className="flex flex-col gap-5 min-w-0">
            {canEdit && (
              <Card title="Mitarbeiter einladen">
                <InviteUserForm />
              </Card>
            )}
            <Card title="Rollen">
              <dl className="px-4 py-3 grid grid-cols-[120px_1fr] gap-y-2 text-sm">
                {(Object.keys(ROLES) as Role[]).map((r) => (
                  <div key={r} className="contents"><dt className="font-medium">{ROLES[r]}</dt><dd className="text-ink-2">{ROLE_INFO[r]}</dd></div>
                ))}
              </dl>
              <p className="px-4 pb-3 text-xs text-ink-3">{canEdit ? "Rollen ändern und Mitarbeiter deaktivieren kann nur der Inhaber; das eigene Konto ist ausgenommen." : "Rollen und Zugänge verwaltet der Inhaber."} Jede Aktion prüft die Rechte zusätzlich serverseitig.</p>
            </Card>
          </div>
        </div>
      </Content>
    </>
  );
}
