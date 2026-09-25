import Link from "next/link";
import { requirePlatform } from "@/lib/platform-auth";
import { platformDashboardStats } from "@/lib/platform-tenants";
import { Content, KPI, PageHeader } from "@/components/ui";

export const metadata = { title: "RentBase Administration" };
export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  await requirePlatform();
  const s = await platformDashboardStats();

  return (
    <>
      <PageHeader title="RentBase Administration" sub="Plattformübersicht" />
      <Content>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KPI label="Mandanten gesamt" value={s.tenantsTotal} />
          <KPI label="Aktive Mandanten" value={s.tenantsActive} />
          <KPI label="Gesperrte Mandanten" value={s.tenantsSuspended} hot={s.tenantsSuspended > 0} />
          <KPI label="Einrichtung offen" value={s.tenantsPending} />
          <KPI label="Benutzer gesamt" value={s.usersTotal} />
          <KPI label="Offene Einladungen" value={s.invitationsPending} />
          <KPI label="Fehlgeschlagene Einladungsmails" value={s.invitationsFailedMail} hot={s.invitationsFailedMail > 0} />
        </div>
        <div className="mt-5">
          <Link href="/admin/mandanten/neu" className="btn btn-primary">Neue Autovermietung</Link>
        </div>
      </Content>
    </>
  );
}
