import Link from "next/link";
import { requirePlatform } from "@/lib/platform-auth";
import { platformDiagnostics } from "@/lib/platform-system";
import { Card, Chip, Content, KPI, PageHeader } from "@/components/ui";
import { SMTP_MODES, SMTP_STATUS, type SmtpMode, type SmtpStatus } from "@/lib/constants";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Notice } from "../ui";

export const metadata = { title: "Support" };
export const dynamic = "force-dynamic";

export default async function SupportPage({ searchParams }: PageProps<"/admin/support">) {
  await requirePlatform("SUPPORT_VIEW");
  const sp = await searchParams;
  const days = Math.min(90, Math.max(1, Number(sp.tage) || 7));
  const d = await platformDiagnostics(days);

  return (
    <>
      <PageHeader title="Support & Diagnose" sub={`Auffälligkeiten der letzten ${days} Tage`}>
        <nav className="flex gap-1 text-sm" aria-label="Zeitraum">
          {[1, 7, 30].map((n) => <Link key={n} href={`/admin/support?tage=${n}`} className={`px-3 py-1.5 rounded-md ${days === n ? "bg-brand text-white" : "hover:bg-surface-2"}`}>{n === 1 ? "24 Stunden" : `${n} Tage`}</Link>)}
        </nav>
      </PageHeader>
      <Content>
        <Notice sp={sp} />
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <KPI label="Fehlgeschlagene Mails" value={d.failedMailCount} hot={d.failedMailCount > 0} />
          <KPI label="SMTP mit Problemen" value={d.smtpErrorTenants.length} hot={d.smtpErrorTenants.length > 0} detail="Mandanten" />
          <KPI label="Behördenübermittlung fehlgeschlagen" value={d.failedSubmissions.length} hot={d.failedSubmissions.length > 0} />
          <KPI label="Abgelaufene Einladungen" value={d.expiredInvitations.length} hot={d.expiredInvitations.length > 0} />
          <KPI label="Aktive Supportsessions" value={d.activeSupport.length} hot={d.activeSupport.length > 0} />
          <KPI label="Gesperrte Mandanten" value={d.suspended.length} hot={d.suspended.length > 0} />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <Card title="Fehlgeschlagene E-Mails" right={<Chip tone={d.failedMailCount ? "bad" : "good"}>{d.failedMailCount}</Chip>}>
            <ul className="divide-y divide-line-soft text-sm">
              {d.failedMails.map((m) => (
                <li key={m.id} className="px-4 py-2 flex flex-col gap-0.5">
                  <div className="flex justify-between gap-2 flex-wrap"><span className="font-medium">{m.template}{m.errorCode ? <span className="text-bad"> · {m.errorCode}</span> : null}</span><span className="text-xs text-ink-3 tnum">{fmtDateTime(m.createdAt)}</span></div>
                  <div className="text-xs text-ink-3"><Link href={`/admin/mandanten/${m.tenant.id}#support`} className="text-brand hover:underline">{m.tenant.name}</Link>{m.channel ? ` · ${m.channel}` : ""}{m.category ? ` · ${m.category}` : ""} · Versuch {m.attempts}</div>
                </li>
              ))}
              {d.failedMails.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Keine fehlgeschlagenen E-Mails im Zeitraum.</li>}
            </ul>
          </Card>

          <Card title="E-Mail-Versandwege mit Problemen" right={<Chip tone={d.smtpErrorTenants.length ? "amber" : "good"}>{d.smtpErrorTenants.length}</Chip>}>
            <ul className="divide-y divide-line-soft text-sm">
              {d.smtpErrorTenants.map((s) => (
                <li key={s.tenantId} className="px-4 py-2 flex justify-between gap-2 flex-wrap">
                  <Link href={`/admin/mandanten/${s.tenantId}#support`} className="text-brand hover:underline font-medium">{s.tenant.name}</Link>
                  <span className="text-xs text-ink-3">{SMTP_MODES[s.mode as SmtpMode] ?? s.mode} · {SMTP_STATUS[s.status as SmtpStatus] ?? s.status}{s.lastErrorCode ? ` · ${s.lastErrorCode}` : ""}{s.lastErrorAt ? ` · ${fmtDateTime(s.lastErrorAt)}` : ""}</span>
                </li>
              ))}
              {d.smtpErrorTenants.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Alle eigenen SMTP-Zugänge sind geprüft oder es wird der RentBase-Versand genutzt.</li>}
            </ul>
          </Card>

          <Card title="Fehlgeschlagene Behördenübermittlungen">
            <ul className="divide-y divide-line-soft text-sm">
              {d.failedSubmissions.map((f) => <li key={f.id} className="px-4 py-2 flex justify-between gap-2"><Link href={`/admin/mandanten/${f.tenant.id}#support`} className="text-brand hover:underline">{f.tenant.name}</Link><span className="text-xs text-ink-3 tnum">{fmtDateTime(f.createdAt)}</span></li>)}
              {d.failedSubmissions.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Keine Fehler im Zeitraum.</li>}
            </ul>
          </Card>

          <Card title="Abgelaufene, nicht angenommene Einladungen">
            <ul className="divide-y divide-line-soft text-sm">
              {d.expiredInvitations.map((i) => <li key={i.id} className="px-4 py-2 flex justify-between gap-2 flex-wrap"><span>{i.email} · <Link href={`/admin/mandanten/${i.tenant.id}#einladungen`} className="text-brand hover:underline">{i.tenant.name}</Link></span><span className="text-xs text-ink-3">abgelaufen {fmtDate(i.expiresAt)}</span></li>)}
              {d.expiredInvitations.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Keine abgelaufenen Einladungen.</li>}
            </ul>
          </Card>

          <Card title="Aktive Supportsessions">
            <ul className="divide-y divide-line-soft text-sm">
              {d.activeSupport.map((s) => <li key={s.id} className="px-4 py-2 flex justify-between gap-2 flex-wrap"><span>{s.superAdminName} · <Link href={`/admin/mandanten/${s.tenant.id}#support`} className="text-brand hover:underline">{s.tenant.name}</Link> · „{s.reason}“</span><span className="text-xs text-ink-3">seit {fmtDateTime(s.startedAt)} · bis {fmtDateTime(s.expiresAt)}</span></li>)}
              {d.activeSupport.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Derzeit keine aktive Supportsession.</li>}
            </ul>
          </Card>

          <Card title="Gesperrte Mandanten">
            <ul className="divide-y divide-line-soft text-sm">
              {d.suspended.map((t) => <li key={t.id} className="px-4 py-2 flex flex-col gap-0.5"><Link href={`/admin/mandanten/${t.id}#status`} className="text-brand hover:underline font-medium">{t.name}</Link><span className="text-xs text-ink-3">{t.suspendedAt ? fmtDateTime(t.suspendedAt) : ""}{t.suspendedByName ? ` · ${t.suspendedByName}` : ""} · „{t.suspendedReason}“</span></li>)}
              {d.suspended.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Kein Mandant gesperrt.</li>}
            </ul>
          </Card>

          <Card title="Aktive Mandanten ohne Anmeldung seit 30 Tagen" className="xl:col-span-2">
            <ul className="divide-y divide-line-soft text-sm">
              {d.staleTenants.map((t) => <li key={t.id} className="px-4 py-2 flex justify-between gap-2"><Link href={`/admin/mandanten/${t.id}`} className="text-brand hover:underline">{t.name}</Link><span className="text-xs text-ink-3">registriert {fmtDate(t.createdAt)}</span></li>)}
              {d.staleTenants.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Alle aktiven Mandanten waren in den letzten 30 Tagen angemeldet.</li>}
            </ul>
          </Card>
        </div>
        <p className="text-xs text-ink-3">Quelle sind ausschließlich vorhandene RentBase-Daten (E-Mail-Protokoll, Versandeinstellungen, Behördenantworten, Einladungen, Supportsessions). Eine eigene Monitoring-Plattform gibt es bewusst nicht.</p>
      </Content>
    </>
  );
}
