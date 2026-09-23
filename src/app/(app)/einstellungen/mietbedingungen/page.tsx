import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, Empty, PageHeader } from "@/components/ui";
import { proposeLabel, termsOverview } from "@/lib/rental-terms";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { createDraftAction } from "./actions";
import { TermsStatusChip } from "./chips";
import { CreateDraftForm } from "./terms-forms";

export const metadata = { title: "Mietbedingungen" };

/** Versionen der Mietbedingungen: aktive Fassung, Entwurf, Historie mit Verwendung. Bearbeiten nur Inhaber. */
export default async function TermsPage() {
  const { tenant, user } = await requireSession();
  const isOwner = user.role === "OWNER";
  const o = await termsOverview(tenant.id);
  const labels = o.versions.map((v) => v.label);

  return (
    <>
      <PageHeader title="Mietbedingungen" sub={o.active ? `Aktiv: Version ${o.active.label}${o.active.effectiveFrom ? ` · gültig seit ${fmtDate(o.active.effectiveFrom)}` : o.active.publishedAt ? ` · veröffentlicht am ${fmtDate(o.active.publishedAt)}` : ""}` : "Noch keine Mietbedingungen veröffentlicht"}>
        <Link href="/einstellungen" className="btn">Einstellungen</Link>
        <Link href="/einstellungen/geschaeftsregeln" className="btn">Geschäftsregeln</Link>
      </PageHeader>
      <Content>
        {!o.active && (
          <p role="status" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm">
            Noch keine Mietbedingungen veröffentlicht. Neue Mietverträge {o.legacy.text ? "nutzen bis dahin den bisherigen, unversionierten Text" : "enthalten bis dahin keinen Bedingungstext"}. {isOwner ? "Legen Sie einen Entwurf an, prüfen Sie ihn und veröffentlichen Sie ihn bewusst." : "Der Inhaber legt Fassungen an und veröffentlicht sie."}
          </p>
        )}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 items-start">
          <Card title="Fassungen" right={<Chip>{o.versions.length}</Chip>}>
            {o.versions.length === 0 ? (
              <Empty>Noch keine Fassung angelegt.</Empty>
            ) : (
              <>
                <ul className="md:hidden divide-y divide-line-soft">
                  {o.versions.map((v) => (
                    <li key={v.id} className="px-4 py-3 flex flex-col gap-1">
                      <div className="flex justify-between items-baseline gap-2"><Link href={`/einstellungen/mietbedingungen/${v.id}`} className="font-medium hover:underline">Version {v.label}</Link><TermsStatusChip status={v.status} active={v.isActive} pending={v.effectivePending} /></div>
                      <div className="text-xs text-ink-3">{v.title} · {v.publishedAt ? `veröffentlicht ${fmtDate(v.publishedAt)} von ${v.publishedByName ?? "–"}` : `Entwurf vom ${fmtDate(v.createdAt)}`}{v.effectiveFrom ? ` · gültig ab ${fmtDate(v.effectiveFrom)}` : ""} · verwendet in {v.usedInContracts} {v.usedInContracts === 1 ? "Mietvertrag" : "Mietverträgen"}</div>
                    </li>
                  ))}
                </ul>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-[13.5px]">
                    <thead><tr className="text-left"><th className="label-xs px-3 py-2 border-b border-line">Version</th><th className="label-xs px-3 py-2 border-b border-line">Titel</th><th className="label-xs px-3 py-2 border-b border-line">Status</th><th className="label-xs px-3 py-2 border-b border-line">Gültig ab</th><th className="label-xs px-3 py-2 border-b border-line">Veröffentlicht</th><th className="label-xs px-3 py-2 border-b border-line text-right">Verwendet in</th></tr></thead>
                    <tbody>
                      {o.versions.map((v) => (
                        <tr key={v.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                          <td className="px-3 py-2.5 font-mono tnum"><Link href={`/einstellungen/mietbedingungen/${v.id}`} className="hover:underline font-medium">{v.label}</Link><div className="text-[11px] text-ink-3">Nr. {v.versionNumber}</div></td>
                          <td className="px-3 py-2.5">{v.title}{v.changeNote && <div className="text-xs text-ink-3">{v.changeNote}</div>}</td>
                          <td className="px-3 py-2.5"><TermsStatusChip status={v.status} active={v.isActive} pending={v.effectivePending} /></td>
                          <td className="px-3 py-2.5 font-mono tnum text-xs">{v.effectiveFrom ? fmtDate(v.effectiveFrom) : "–"}</td>
                          <td className="px-3 py-2.5 text-xs">{v.publishedAt ? <>{fmtDateTime(v.publishedAt)}<div className="text-ink-3">{v.publishedByName ?? "–"}</div></> : <span className="text-ink-3">–</span>}{v.archivedAt && <div className="text-ink-3">archiviert {fmtDate(v.archivedAt)}</div>}</td>
                          <td className="px-3 py-2.5 text-right font-mono tnum">{v.usedInContracts} {v.usedInContracts === 1 ? "Vertrag" : "Verträgen"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <p className="px-4 pb-3 text-xs text-ink-3">Veröffentlichte Fassungen werden nie geändert oder gelöscht. Verträge behalten exakt die Fassung, mit der sie abgeschlossen wurden – auch nach einer Archivierung.</p>
          </Card>

          <div className="flex flex-col gap-4">
            {isOwner && (
              <Card title={o.draft ? "Offener Entwurf" : "Neuen Entwurf anlegen"}>
                <div className="p-4 flex flex-col gap-3 text-sm">
                  {o.draft ? (
                    <>
                      <p>Entwurf <span className="font-medium">Version {o.draft.label}</span> ({o.draft.title}) ist noch nicht veröffentlicht.</p>
                      <Link href={`/einstellungen/mietbedingungen/${o.draft.id}`} className="btn btn-primary">Entwurf bearbeiten</Link>
                    </>
                  ) : (
                    <CreateDraftForm action={createDraftAction} hasLegacy={!!o.legacy.text} proposedLabel={proposeLabel(labels, o.active?.label ?? null)} />
                  )}
                </div>
              </Card>
            )}
            {o.legacy.text && (
              <Card title="Bisheriger Text (vor der Versionierung)" right={<Chip tone="grey">{o.legacy.version ? `Fassung ${o.legacy.version}` : "ohne Fassung"}</Chip>}>
                <details className="p-4 text-sm"><summary className="cursor-pointer">Text anzeigen</summary><p className="mt-2 whitespace-pre-wrap text-ink-2 max-h-80 overflow-y-auto">{o.legacy.text}</p></details>
                <p className="px-4 pb-3 text-xs text-ink-3">{o.active ? "Wird für neue Verträge nicht mehr verwendet; Altverträge behalten ihre Kopie." : "Wird für neue Verträge verwendet, bis eine Fassung veröffentlicht ist."}</p>
              </Card>
            )}
            <Card title="Hinweise">
              <ul className="p-4 text-sm text-ink-2 list-disc pl-8 flex flex-col gap-1">
                <li>Rent-Base erzeugt keine Klauseln und bewertet keine rechtliche Wirksamkeit. Der hinterlegte Text ist vom Vermieter geprüft.</li>
                <li>Änderungen laufen immer über eine neue Fassung; die bisherige bleibt unverändert erhalten.</li>
                <li>Ein offener Vertragsentwurf wechselt nicht von selbst auf eine neuere Fassung.</li>
                <li>Geschäftsregeln (Kaution, Kilometer, Tanken, Ausland …) sind operative Standardwerte und ersetzen den Text nicht.</li>
              </ul>
            </Card>
          </div>
        </div>
      </Content>
    </>
  );
}
