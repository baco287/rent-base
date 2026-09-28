import Link from "next/link";
import { can, requirePlatform } from "@/lib/platform-auth";
import { systemStatus } from "@/lib/platform-system";
import { listInternalAdmins } from "@/lib/platform-users";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { PLATFORM_PERMISSIONS, PLATFORM_PERMISSION_MATRIX, INTERNAL_PLATFORM_ROLES, PLATFORM_ROLES, type PlatformPermission } from "@/lib/constants";
import { fmtDateTime } from "@/lib/format";
import { Notice, PlatformRoleChip, Rows } from "../ui";
import { PlatformRoleForm } from "./forms";

export const metadata = { title: "System" };
export const dynamic = "force-dynamic";

function Status({ ok, label }: { ok: boolean; label: string }) {
  return <Chip tone={ok ? "good" : "bad"}>{label}</Chip>;
}

export default async function SystemPage({ searchParams }: PageProps<"/admin/system">) {
  const session = await requirePlatform("SYSTEM_VIEW");
  const sp = await searchParams;
  const [s, admins] = await Promise.all([systemStatus(), listInternalAdmins()]);
  const uptimeH = Math.floor(s.app.uptimeSeconds / 3600);
  const uptimeM = Math.floor((s.app.uptimeSeconds % 3600) / 60);

  return (
    <>
      <PageHeader title="System" sub="Status, Konfiguration (nur gesetzt/fehlt), interne Rollen" />
      <Content>
        <Notice sp={sp} />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <Card title="Anwendung">
            <div className="p-4">
              <Rows rows={[
                ["Version", s.app.version ?? "unbekannt"],
                ["Commit", s.app.commit ? <span key="c" className="font-mono">{s.app.commit}</span> : "nicht gesetzt (SOURCE_COMMIT)"],
                ["Umgebung", s.app.env],
                ["Node.js", s.app.nodeVersion],
                ["Zeitzone", s.app.timeZone],
                ["Läuft seit", `${fmtDateTime(s.app.startedAt)} (${uptimeH} h ${uptimeM} min)`],
              ]} />
            </div>
          </Card>

          <Card title="Datenbank" right={<Status ok={s.db.ok} label={s.db.ok ? "erreichbar" : "Fehler"} />}>
            <div className="p-4">
              <Rows rows={[
                ["Antwortzeit", s.db.latencyMs == null ? null : `${s.db.latencyMs} ms`],
                ["Migrationen angewendet", s.db.migrationsApplied],
                ["Migrationen offen", s.db.migrationsPending == null ? null : s.db.migrationsPending === 0 ? "keine" : <span key="p" className="text-bad">{s.db.migrationsPending}</span>],
                ["Letzte Migration", s.db.lastMigration ? <span key="m"><span className="font-mono text-xs">{s.db.lastMigration.name}</span>{s.db.lastMigration.finishedAt ? ` · ${fmtDateTime(s.db.lastMigration.finishedAt)}` : ""}</span> : null],
              ]} />
            </div>
          </Card>

          <Card title="Integrationen & Konfiguration" right={<Chip tone="grey">nur gesetzt / fehlt</Chip>}>
            <ul className="divide-y divide-line-soft text-sm">
              <li className="px-4 py-2.5 flex justify-between gap-3"><div><div className="font-medium">Plattform-E-Mail (SMTP)</div><div className="text-xs text-ink-3">{s.mail.configured ? `Treiber ${s.mail.driver}` : `fehlend: ${s.mail.missing.join(", ")}`}</div></div><Status ok={s.mail.configured} label={s.mail.configured ? "konfiguriert" : "fehlt"} /></li>
              <li className="px-4 py-2.5 flex justify-between gap-3"><div><div className="font-medium">Dateispeicher (S3)</div><div className="text-xs text-ink-3">{s.storage.configured ? `Treiber ${s.storage.driver}` : `fehlend: ${s.storage.missing.join(", ")}`}</div></div><Status ok={s.storage.configured} label={s.storage.configured ? "konfiguriert" : "fehlt"} /></li>
              <li className="px-4 py-2.5 flex justify-between gap-3"><div><div className="font-medium">Verschlüsselungsschlüssel (RENTBASE_SECRET_KEY)</div><div className="text-xs text-ink-3">für SMTP-Passwörter der Mandanten</div></div><Chip tone={s.secretKey.invalid ? "bad" : s.secretKey.configured ? "good" : "amber"}>{s.secretKey.invalid ? "ungültig" : s.secretKey.configured ? "gesetzt" : "fehlt"}</Chip></li>
              <li className="px-4 py-2.5 flex justify-between gap-3"><div><div className="font-medium">Behörden-Fristenerinnerung (Scheduler)</div><div className="text-xs text-ink-3">{s.authorityReminders.source}</div></div><Chip tone={s.authorityReminders.enabled ? "good" : "grey"}>{s.authorityReminders.enabled ? "aktiv" : "aus"}</Chip></li>
              {s.optional.map((o) => <li key={o.name} className="px-4 py-2.5 flex justify-between gap-3"><div><div className="font-medium font-mono text-xs">{o.name}</div><div className="text-xs text-ink-3">{o.purpose}</div></div><Chip tone={o.set ? "good" : "grey"}>{o.set ? "gesetzt" : "nicht gesetzt"}</Chip></li>)}
            </ul>
            <p className="px-4 py-3 text-xs text-ink-3 border-t border-line-soft">Werte werden nie angezeigt – nur ob eine Variable gesetzt ist. Der Healthcheck unter /api/health liefert dieselbe Datenbankprüfung ohne Anmeldung.</p>
          </Card>

          <Card title="Interne Rollen" right={<Chip>{admins.length} Konten</Chip>}>
            <ul className="divide-y divide-line-soft text-sm">
              {admins.map((a) => (
                <li key={a.id} className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0"><Link href={`/admin/benutzer/${a.id}`} className="font-medium text-brand hover:underline">{a.name}</Link><div className="text-xs text-ink-3">{a.email} · {a.tenant.name}{a.lastLoginAt ? ` · zuletzt ${fmtDateTime(a.lastLoginAt)}` : ""}</div></div>
                  <PlatformRoleChip role={a.platformRole} />
                  {!a.active && <Chip tone="bad">Gesperrt</Chip>}
                </li>
              ))}
            </ul>
            {can(session, "PLATFORM_ROLE_MANAGE") && (
              <div className="px-4 py-3 border-t border-line-soft flex flex-col gap-2">
                <div className="label-xs">Rolle vergeben oder entziehen</div>
                <PlatformRoleForm canManage />
                <p className="text-xs text-ink-3">Interne Konten sind normale RentBase-Konten (in der Regel im Betreiber-Mandanten), denen eine Plattformrolle gegeben wird. Es gibt keine eigene Kontoanlage und keinen Passwortweg im Control Center.</p>
              </div>
            )}
          </Card>

          <Card title="Berechtigungsmatrix" className="xl:col-span-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-ink-3"><tr><th className="px-3 py-2 text-left font-medium">Berechtigung</th>{INTERNAL_PLATFORM_ROLES.map((r) => <th key={r} className="px-3 py-2 text-center font-medium">{PLATFORM_ROLES[r]}</th>)}</tr></thead>
                <tbody className="divide-y divide-line-soft">
                  {(Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[]).map((p) => (
                    <tr key={p}><td className="px-3 py-1.5">{PLATFORM_PERMISSIONS[p]}<div className="text-[10px] text-ink-3 font-mono">{p}</div></td>{INTERNAL_PLATFORM_ROLES.map((r) => <td key={r} className="px-3 py-1.5 text-center">{PLATFORM_PERMISSION_MATRIX[p].includes(r) ? <span className="text-good font-semibold">✓</span> : <span className="text-ink-3">–</span>}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-xs text-ink-3 border-t border-line-soft">Die Matrix ist im Code festgelegt (lib/constants.ts) und wird serverseitig in jeder Seite und Aktion geprüft (requirePlatform). Die Navigation zeigt nur, was erlaubt ist – entscheidend ist die Serverprüfung.</p>
          </Card>
        </div>
      </Content>
    </>
  );
}
