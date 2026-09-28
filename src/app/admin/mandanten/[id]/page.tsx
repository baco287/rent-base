import Link from "next/link";
import { notFound } from "next/navigation";
import { can, requirePlatform } from "@/lib/platform-auth";
import { tenantDetailForPlatform } from "@/lib/platform-tenants";
import { tenantDiagnostics } from "@/lib/platform-system";
import { listPlatformAudit, auditActionLabel, auditDetailsView } from "@/lib/platform-audit";
import { resendOwnerInvitationAction, revokeOwnerInvitationAction } from "@/app/admin/actions";
import { Card, Chip, Content, KPI, PageHeader } from "@/components/ui";
import { FEATURES, FEATURE_KEYS, INVITATION_STATUS, ROLES, SMTP_MODES, SMTP_STATUS, type InvitationStatus, type Role, type SmtpMode, type SmtpStatus } from "@/lib/constants";
import { fmtDate, fmtDateTime, toDateInput } from "@/lib/format";
import { Notice, PlanChip, PlatformRoleChip, Rows, SectionNav, SubscriptionStatusChip, TenantStatusChip, eur } from "../../ui";
import { ReactivateTenantForm, StartSupportForm, SuspendTenantForm } from "./forms";
import { FeatureToggle } from "../../features/forms";
import { SubscriptionForm } from "../../abos/forms";
import { UserActiveButton } from "../../benutzer/forms";

export const metadata = { title: "Mandant" };
export const dynamic = "force-dynamic";

export default async function TenantDetailPage({ params, searchParams }: PageProps<"/admin/mandanten/[id]">) {
  const session = await requirePlatform("PLATFORM_VIEW");
  const { id } = await params;
  const sp = await searchParams;
  const detail = await tenantDetailForPlatform(id);
  if (!detail) notFound();
  const { tenant, users, invitations, supportSessions, usage, features } = detail;
  const [diag, audit] = await Promise.all([can(session, "SUPPORT_VIEW") ? tenantDiagnostics(tenant.id) : null, listPlatformAudit({ tenantId: tenant.id, scope: "all", page: 1, pageSize: 15 })]);
  const sub = tenant.subscription;
  const subValues = sub ? { plan: sub.plan, status: sub.status, startedAt: toDateInput(sub.startedAt), trialEndsAt: toDateInput(sub.trialEndsAt), cancelledAt: toDateInput(sub.cancelledAt), endsAt: toDateInput(sub.endsAt), monthlyPriceEur: sub.monthlyPriceCents == null ? "" : (sub.monthlyPriceCents / 100).toFixed(2).replace(".", ","), maxUsers: sub.maxUsers?.toString() ?? "", maxVehicles: sub.maxVehicles?.toString() ?? "", note: sub.note ?? "" } : null;
  const address = [tenant.street, [tenant.zip, tenant.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const sections: [string, string][] = [["stammdaten", "Stammdaten"], ["status", "Status"], ["abo", "Tarif & Abo"], ["features", "Features"], ["nutzung", "Nutzung"], ["benutzer", "Benutzer"], ["einladungen", "Einladungen"], ["support", "Support & Diagnose"], ["audit", "Audit"]];

  return (
    <>
      <PageHeader title={tenant.name} sub={<span className="font-mono">{tenant.slug}</span>}>
        <TenantStatusChip status={tenant.status} />
        <PlanChip plan={sub?.plan} />
        <SubscriptionStatusChip status={sub?.status} />
        <Link href="/admin/mandanten" className="btn">Zur Kundenliste</Link>
      </PageHeader>
      <Content>
        <Notice sp={sp} />
        <SectionNav sections={sections} />

        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3" id="nutzung">
          <KPI label="Benutzer aktiv" value={users.filter((u) => u.active).length} detail={`${users.length} gesamt`} />
          <KPI label="Fahrzeuge" value={usage.vehiclesActive} detail={`${usage.vehicles} inkl. stillgelegte`} />
          <KPI label="Buchungen" value={usage.bookings} detail={`${usage.bookingsActive} laufend`} />
          <KPI label="Kunden" value={usage.customers} />
          <KPI label="Belege" value={usage.invoices} />
          <KPI label="Schadenakten" value={usage.damageCases} />
          <KPI label="Behördenvorgänge" value={usage.authorityCases} />
          <KPI label="Letzte Aktivität" value={usage.lastActivityAt ? fmtDate(usage.lastActivityAt) : "–"} detail={usage.lastActivityAt ? fmtDateTime(usage.lastActivityAt) : "noch keine Anmeldung"} />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <Card title="Stammdaten" className="scroll-mt-4" right={<span id="stammdaten" />}>
            <div className="p-4">
              <Rows rows={[
                ["Firma", `${tenant.name}${tenant.legalForm ? ` (${tenant.legalForm})` : ""}`],
                ["Kundennummer / ID", <span key="id" className="font-mono text-xs">{tenant.slug} · {tenant.id}</span>],
                ["Adresse", address || null],
                ["Kontakt", [tenant.phone, tenant.email, tenant.website].filter(Boolean).join(" · ") || null],
                ["USt-IdNr. / Steuernr.", [tenant.vatId, tenant.taxNumber].filter(Boolean).join(" · ") || null],
                ["Registriert", fmtDateTime(tenant.createdAt)],
                ["Zuletzt geändert", fmtDateTime(tenant.updatedAt)],
              ]} />
              <p className="mt-3 text-xs text-ink-3">Stammdaten pflegt der Inhaber selbst in den Einstellungen des Mandanten. Das Control Center zeigt sie nur an.</p>
            </div>
          </Card>

          <Card title="Status & Sperre" className="scroll-mt-4" right={<span id="status"><TenantStatusChip status={tenant.status} /></span>}>
            <div className="p-4 flex flex-col gap-3 text-sm">
              {tenant.status === "SUSPENDED" ? (
                <Rows rows={[["Gesperrt seit", tenant.suspendedAt ? fmtDateTime(tenant.suspendedAt) : null], ["Grund", tenant.suspendedReason], ["Gesperrt von", tenant.suspendedByName]]} />
              ) : (
                <p className="text-ink-2">{tenant.status === "PENDING_SETUP" ? "Die Einrichtung durch den Inhaber ist noch nicht abgeschlossen (nur Hinweis, blockiert nichts)." : "Der Mandant ist aktiv. Eine Sperre meldet sofort alle Benutzer ab; Daten bleiben erhalten."}</p>
              )}
              {can(session, "TENANT_SUSPEND") ? (tenant.status === "SUSPENDED" ? <ReactivateTenantForm tenantId={tenant.id} /> : <SuspendTenantForm tenantId={tenant.id} tenantName={tenant.name} />) : <p className="text-xs text-ink-3">Sperren/Freigeben ist dem Super-Admin vorbehalten.</p>}
            </div>
          </Card>

          <Card title="Tarif & Abo" className="scroll-mt-4" right={<span id="abo" className="flex gap-2"><PlanChip plan={sub?.plan} /><SubscriptionStatusChip status={sub?.status} /></span>}>
            <div className="p-4 flex flex-col gap-4">
              {sub ? (
                <Rows rows={[
                  ["Seit", fmtDate(sub.startedAt)],
                  ["Testphase bis", sub.trialEndsAt ? fmtDate(sub.trialEndsAt) : null],
                  ["Gekündigt am", sub.cancelledAt ? fmtDate(sub.cancelledAt) : null],
                  ["Laufzeitende", sub.endsAt ? fmtDate(sub.endsAt) : null],
                  ["Monatspreis netto", sub.monthlyPriceCents == null ? null : eur(sub.monthlyPriceCents)],
                  ["Limits", `${sub.maxUsers ?? "∞"} Benutzer · ${sub.maxVehicles ?? "∞"} Fahrzeuge`],
                  ["Zuletzt geändert", `${fmtDateTime(sub.updatedAt)}${sub.updatedByName ? ` · ${sub.updatedByName}` : ""}`],
                ]} />
              ) : (
                <p className="text-sm text-ink-2">Für diesen Mandanten ist noch kein Tarif hinterlegt.</p>
              )}
              {can(session, "BILLING_VIEW") && (
                <details open={!sub} className="border-t border-line-soft pt-3">
                  <summary className="cursor-pointer text-sm font-medium">{can(session, "BILLING_MANAGE") ? (sub ? "Tarif/Abo bearbeiten" : "Tarif/Abo anlegen") : "Details"}</summary>
                  <div className="mt-3"><SubscriptionForm tenantId={tenant.id} values={subValues} canManage={can(session, "BILLING_MANAGE")} /></div>
                </details>
              )}
            </div>
          </Card>

          <Card title="Features" className="scroll-mt-4" right={<span id="features" className="text-xs text-ink-3">{FEATURE_KEYS.filter((k) => features[k]).length} von {FEATURE_KEYS.length} aktiv</span>}>
            <ul className="divide-y divide-line-soft text-sm">
              {FEATURE_KEYS.map((k) => (
                <li key={k} className="px-4 py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{FEATURES[k].label}</div>
                    <div className="text-xs text-ink-3">{FEATURES[k].description}</div>
                  </div>
                  <FeatureToggle tenantId={tenant.id} featureKey={k} label={FEATURES[k].label} enabled={features[k]} canManage={can(session, "FEATURE_MANAGE")} />
                </li>
              ))}
            </ul>
            <p className="px-4 py-3 text-xs text-ink-3 border-t border-line-soft">Gesperrte Module verschwinden aus der Navigation des Mandanten; Seiten, Aktionen und Uploads werden serverseitig abgelehnt. Bestehende Daten bleiben erhalten.</p>
          </Card>

          <Card title="Benutzer" className="xl:col-span-2 scroll-mt-4" right={<span id="benutzer"><Chip>{users.filter((u) => u.active).length} aktiv</Chip></span>}>
            <ul className="divide-y divide-line-soft">
              {users.map((u) => (
                <li key={u.id} className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <Link href={`/admin/benutzer/${u.id}`} className="font-medium text-brand hover:underline">{u.name}</Link>
                    <div className="text-xs text-ink-3">{u.email}{u.lastLoginAt ? ` · zuletzt angemeldet ${fmtDateTime(u.lastLoginAt)}` : " · noch nie angemeldet"}</div>
                  </div>
                  <Chip tone={u.role === "OWNER" ? "info" : "grey"}>{ROLES[u.role as Role] ?? u.role}</Chip>
                  <PlatformRoleChip role={u.platformRole} />
                  {!u.active && <Chip tone="bad">Gesperrt</Chip>}
                  <UserActiveButton userId={u.id} active={u.active} canManage={can(session, "USER_MANAGE") && u.id !== session.user.id && u.platformRole === "NONE"} />
                </li>
              ))}
              {users.length === 0 && <li className="px-4 py-6 text-center text-ink-3 text-sm">Noch kein Benutzer – die Einladung des Inhabers wurde noch nicht angenommen.</li>}
            </ul>
          </Card>

          <Card title="Einladungen" className="xl:col-span-2 scroll-mt-4" right={<span id="einladungen" />}>
            <ul className="divide-y divide-line-soft">
              {invitations.map((inv) => {
                const resend = resendOwnerInvitationAction.bind(null, tenant.id, inv.id);
                const revoke = revokeOwnerInvitationAction.bind(null, tenant.id, inv.id);
                const expired = inv.status === "PENDING" && inv.expiresAt < new Date();
                return (
                  <li key={inv.id} className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{inv.email}</div>
                      <div className="text-xs text-ink-3">{ROLES[inv.role as Role] ?? inv.role} · angelegt {fmtDate(inv.createdAt)}{inv.invitedByName ? ` von ${inv.invitedByName}` : ""}{inv.status === "PENDING" ? ` · gültig bis ${fmtDateTime(inv.expiresAt)}` : ""}</div>
                    </div>
                    <Chip tone={expired ? "bad" : inv.status === "PENDING" ? "amber" : inv.status === "ACCEPTED" ? "good" : "grey"}>{expired ? "Abgelaufen" : INVITATION_STATUS[inv.status as InvitationStatus] ?? inv.status}</Chip>
                    {inv.status === "PENDING" && can(session, "USER_MANAGE") && (
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

          <Card title="Support & Diagnose" className="xl:col-span-2 scroll-mt-4" right={<span id="support" className="flex items-center gap-2"><Chip tone="grey">read-only</Chip>{usage.activeSupportSessions > 0 && <Chip tone="amber">{usage.activeSupportSessions} aktive Session</Chip>}</span>}>
            <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-5 text-sm">
              <div className="flex flex-col gap-3">
                <p className="text-ink-2">„Als Kunde öffnen“ zeigt die normale Oberfläche dieses Mandanten schreibgeschützt, zeitlich begrenzt und vollständig protokolliert. Ausweis-/Führerscheinkopien, Behörden- und Schadendokumente bleiben auch dann gesperrt.</p>
                {can(session, "SUPPORT_SESSION") ? <StartSupportForm tenantId={tenant.id} /> : <p className="text-xs text-ink-3">Der Supportmodus ist Super-Admin und Support-Admin vorbehalten.</p>}
                {supportSessions.length > 0 && (
                  <div>
                    <div className="label-xs mb-1">Letzte Supportzugriffe</div>
                    <ul className="text-xs text-ink-3 flex flex-col gap-1">
                      {supportSessions.map((s) => (
                        <li key={s.id}>{fmtDateTime(s.startedAt)} · {s.superAdminName} · „{s.reason}“{s.endedAt ? ` · beendet ${fmtDateTime(s.endedAt)}` : s.expiresAt > new Date() ? " · aktiv" : " · abgelaufen"}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {diag && (
                <div className="flex flex-col gap-3">
                  <Rows rows={[
                    ["Letzte Anmeldung", diag.lastLogin?.lastLoginAt ? `${fmtDateTime(diag.lastLogin.lastLoginAt)} · ${diag.lastLogin.name}` : null],
                    ["Letzte Aktion", diag.lastAudit ? `${fmtDateTime(diag.lastAudit.createdAt)} · ${auditActionLabel(diag.lastAudit.action)}${diag.lastAudit.userName ? ` · ${diag.lastAudit.userName}` : ""}` : null],
                    ["E-Mails (30 Tage)", <span key="m">{diag.mail30.sent} gesendet · <span className={diag.mail30.failed ? "text-bad" : ""}>{diag.mail30.failed} fehlgeschlagen</span>{diag.mail30.pending ? ` · ${diag.mail30.pending} offen` : ""}</span>],
                    ["E-Mail-Versandweg", diag.mailSettings ? `${SMTP_MODES[diag.mailSettings.mode as SmtpMode] ?? diag.mailSettings.mode} · ${SMTP_STATUS[diag.mailSettings.status as SmtpStatus] ?? diag.mailSettings.status}${diag.mailSettings.lastErrorCode ? ` · letzter Fehler ${diag.mailSettings.lastErrorCode}` : ""}` : "RentBase-Versanddienst (Standard)"],
                    ["Einladungen", `${diag.invitations.pending} offen · ${diag.invitations.expired} abgelaufen`],
                    ["Behördenübermittlungen", diag.failedSubmissions.length ? <span key="a" className="text-bad">{diag.failedSubmissions.length} fehlgeschlagen</span> : "keine Fehler"],
                    ["Dateien", `${diag.storage.photos} Fotos · ${diag.storage.documents} Dokumente · ${diag.storage.signatures} Unterschriften · ${diag.storage.driverDocumentCopies} Ausweiskopien`],
                    ["Logo", diag.settings?.logoStorageKey ? `hochgeladen${diag.settings.logoUpdatedAt ? ` ${fmtDate(diag.settings.logoUpdatedAt)}` : ""}` : "kein Logo"],
                    ["Schlüsselbox", diag.settings?.keyDropEnabled ? "vom Inhaber aktiviert" : "aus"],
                    ["Fristen-Erinnerung", diag.settings ? (diag.settings.authorityReminderDays > 0 ? `${diag.settings.authorityReminderDays} Tage${diag.settings.authorityReminderEmail ? ` an ${diag.settings.authorityReminderEmail}` : ""}` : "aus") : null],
                  ]} />
                  {diag.failedMails.length > 0 && (
                    <div>
                      <div className="label-xs mb-1">Fehlgeschlagene E-Mails (letzte 10)</div>
                      <ul className="text-xs flex flex-col gap-1">
                        {diag.failedMails.map((m) => <li key={m.id} className="flex justify-between gap-2"><span>{m.template}{m.channel ? ` · ${m.channel}` : ""}{m.errorCode ? ` · ${m.errorCode}` : ""} · Versuch {m.attempts}</span><span className="text-ink-3 tnum">{fmtDateTime(m.createdAt)}</span></li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card title="Audit (dieser Mandant)" className="xl:col-span-2 scroll-mt-4" right={<Link id="audit" href={`/admin/audit?mandant=${tenant.id}&umfang=alle`} className="text-sm text-brand hover:underline">Alle Einträge</Link>}>
            <ul className="divide-y divide-line-soft text-sm">
              {audit.rows.map((a) => {
                const d = auditDetailsView(a.details);
                return (
                  <li key={a.id} className="px-4 py-2 flex flex-col gap-0.5">
                    <div className="flex justify-between gap-2 flex-wrap"><span className="font-medium">{auditActionLabel(a.action)}</span><span className="text-xs text-ink-3 tnum">{fmtDateTime(a.createdAt)} · {a.userName ?? "System"}</span></div>
                    {(d.fields.length > 0 || d.after.length > 0) && (
                      <div className="text-xs text-ink-3 flex flex-wrap gap-x-3">
                        {d.fields.map(([k, v]) => <span key={k}>{k}: {v}</span>)}
                        {d.after.map(([k, v], i) => <span key={`a-${k}`}>{k}: {d.before[i]?.[1] ?? "–"} → {v}</span>)}
                      </div>
                    )}
                  </li>
                );
              })}
              {audit.rows.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Noch keine Einträge.</li>}
            </ul>
          </Card>
        </div>
      </Content>
    </>
  );
}
