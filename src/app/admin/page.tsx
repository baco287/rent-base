import Link from "next/link";
import { can, requirePlatform } from "@/lib/platform-auth";
import { platformDashboardStats } from "@/lib/platform-tenants";
import { recentPlatformAudit, auditActionLabel } from "@/lib/platform-audit";
import { systemStatus } from "@/lib/platform-system";
import { Card, Chip, Content, KPI, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { Notice, eur } from "./ui";

export const metadata = { title: "RentBase Control Center" };
export const dynamic = "force-dynamic";

export default async function AdminDashboardPage({ searchParams }: PageProps<"/admin">) {
  const session = await requirePlatform("PLATFORM_VIEW");
  const sp = await searchParams;
  const [s, recent, sys] = await Promise.all([platformDashboardStats(), recentPlatformAudit(10), systemStatus()]);
  const systemOk = sys.db.ok && sys.mail.configured && sys.storage.configured && sys.secretKey.configured && !sys.secretKey.invalid;

  return (
    <>
      <PageHeader title="RentBase Control Center" sub="Zentrale Übersicht der Plattform">
        {can(session, "TENANT_CREATE") && <Link href="/admin/mandanten/neu" className="btn btn-primary">Neue Autovermietung</Link>}
      </PageHeader>
      <Content>
        <Notice sp={sp} />

        <section aria-label="Kunden">
          <div className="label-xs mb-2">Kunden / Mandanten</div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <KPI label="Mandanten gesamt" value={s.tenantsTotal} detail={`${s.tenantsNew30d} neu in 30 Tagen`} />
            <KPI label="Aktive Mandanten" value={s.tenantsActive} />
            <KPI label="Einrichtung offen" value={s.tenantsPending} hot={s.tenantsPending > 0} />
            <KPI label="Gesperrte Mandanten" value={s.tenantsSuspended} hot={s.tenantsSuspended > 0} />
            <KPI label="Testaccounts" value={s.trialTenants} detail={s.subscriptionsTotal === 0 ? "kein Tarif hinterlegt" : s.trialsEndingSoon > 0 ? `${s.trialsEndingSoon} enden in 7 Tagen` : "laut Abo-Status"} hot={s.trialsEndingSoon > 0} />
            <KPI label="Neue Kunden (30 Tage)" value={s.tenantsNew30d} />
          </div>
        </section>

        <section aria-label="Nutzung">
          <div className="label-xs mb-2">Nutzung</div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <KPI label="Benutzer (aktiv)" value={s.usersTotal} detail={`${s.usersLoggedIn30d} in 30 Tagen angemeldet`} />
            <KPI label="Fahrzeuge" value={s.vehiclesTotal} detail="ohne stillgelegte" />
            <KPI label="Buchungen gesamt" value={s.bookingsTotal} detail={`${s.bookingsNew30d} neu in 30 Tagen`} />
            <KPI label="Laufende Mieten" value={s.bookingsActive} />
            <KPI label="Kundenstammdaten" value={s.customersTotal} detail="über alle Mandanten" />
            <KPI label="Offene Einladungen" value={s.invitationsPending} detail={s.invitationsFailedMail > 0 ? `${s.invitationsFailedMail} Mails fehlgeschlagen` : "Mails ok"} hot={s.invitationsFailedMail > 0} />
          </div>
        </section>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
          <Card title="Umsatz (intern erfasst)" right={<Link href="/admin/abos" className="text-sm text-brand hover:underline">Abos</Link>}>
            <div className="p-4 grid grid-cols-2 gap-3">
              <KPI label="MRR" value={s.mrrCents == null ? "–" : eur(s.mrrCents)} detail={s.mrrCents == null ? "noch keine Preise erfasst" : `${s.pricedSubscriptions} zahlende Abos`} />
              <KPI label="ARR" value={s.arrCents == null ? "–" : eur(s.arrCents)} detail="MRR × 12" />
            </div>
            <p className="px-4 pb-4 text-xs text-ink-3">Es gibt keine automatische Abrechnung. Werte stammen ausschließlich aus den im Control Center erfassten Tarifen.</p>
          </Card>

          <Card title="Systemstatus" right={<Link href="/admin/system" className="text-sm text-brand hover:underline">Details</Link>}>
            <ul className="p-4 text-sm flex flex-col gap-2">
              <li className="flex justify-between gap-2"><span>Datenbank</span><Chip tone={sys.db.ok ? "good" : "bad"}>{sys.db.ok ? `ok${sys.db.latencyMs != null ? ` · ${sys.db.latencyMs} ms` : ""}` : "Fehler"}</Chip></li>
              <li className="flex justify-between gap-2"><span>E-Mail-Versand (Plattform)</span><Chip tone={sys.mail.configured ? "good" : "bad"}>{sys.mail.configured ? sys.mail.driver : "nicht konfiguriert"}</Chip></li>
              <li className="flex justify-between gap-2"><span>Dateispeicher</span><Chip tone={sys.storage.configured ? "good" : "bad"}>{sys.storage.configured ? sys.storage.driver : "nicht konfiguriert"}</Chip></li>
              <li className="flex justify-between gap-2"><span>Verschlüsselungsschlüssel</span><Chip tone={sys.secretKey.configured && !sys.secretKey.invalid ? "good" : "amber"}>{sys.secretKey.invalid ? "ungültig" : sys.secretKey.configured ? "gesetzt" : "fehlt"}</Chip></li>
              <li className="flex justify-between gap-2"><span>Fehlgeschlagene Mails (24 h)</span><Chip tone={s.failedMails24h > 0 ? "amber" : "good"}>{s.failedMails24h}</Chip></li>
              <li className="flex justify-between gap-2"><span>Aktive Supportsessions</span><Chip tone={s.activeSupportSessions > 0 ? "amber" : "grey"}>{s.activeSupportSessions}</Chip></li>
              <li className="flex justify-between gap-2 border-t border-line-soft pt-2"><span>Gesamt</span><Chip tone={systemOk ? "good" : "amber"}>{systemOk ? "in Ordnung" : "Hinweise vorhanden"}</Chip></li>
            </ul>
          </Card>

          <Card title="Letzte Plattform-Aktionen" right={<Link href="/admin/audit" className="text-sm text-brand hover:underline">Audit Log</Link>}>
            <ul className="divide-y divide-line-soft text-sm">
              {recent.map((a) => (
                <li key={a.id} className="px-4 py-2 flex flex-col gap-0.5">
                  <div className="flex justify-between gap-2"><span className="font-medium">{auditActionLabel(a.action)}</span><span className="text-xs text-ink-3 tnum">{fmtDateTime(a.createdAt)}</span></div>
                  <div className="text-xs text-ink-3">{a.userName ?? "System"} · <Link href={`/admin/mandanten/${a.tenant.id}`} className="text-brand hover:underline">{a.tenant.name}</Link></div>
                </li>
              ))}
              {recent.length === 0 && <li className="px-4 py-6 text-center text-ink-3">Noch keine Plattform-Aktionen protokolliert.</li>}
            </ul>
          </Card>
        </div>
      </Content>
    </>
  );
}
