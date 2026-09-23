import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { TermsBlocksView } from "@/components/terms-view";
import { DomainError } from "@/lib/integrity";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { proposeLabel, termsOverview, termsVersionDetail } from "@/lib/rental-terms";
import { toDateInputValue } from "@/lib/time";
import { archiveAction, discardDraftAction, newVersionAction, publishAction, saveDraftAction } from "../actions";
import { TermsStatusChip } from "../chips";
import { ConfirmForm, DraftEditor } from "../terms-forms";

export const metadata = { title: "Mietbedingungen-Fassung" };

export default async function TermsVersionPage({ params, searchParams }: PageProps<"/einstellungen/mietbedingungen/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  const isOwner = user.role === "OWNER";
  let v: Awaited<ReturnType<typeof termsVersionDetail>>;
  try {
    v = await termsVersionDetail(tenant.id, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const overview = await termsOverview(tenant.id);
  const renterOf = (snap: unknown) => { const c = snap as { firstName?: string; lastName?: string; companyName?: string | null } | null; return c ? [c.companyName, `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()].filter(Boolean).join(", ") : ""; };

  return (
    <>
      <PageHeader title={`Mietbedingungen Version ${v.label}`} sub={v.title}>
        <TermsStatusChip status={v.status} active={v.isActive} pending={v.status === "PUBLISHED" && !!v.effectiveFrom && v.effectiveFrom > new Date()} />
        <Link href="/einstellungen/mietbedingungen" className="btn">Alle Fassungen</Link>
      </PageHeader>
      <Content>
        {sp.veroeffentlicht === "1" && <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm font-medium">Version {v.label} ist veröffentlicht und unveränderlich. {v.effectiveFrom && v.effectiveFrom > new Date() ? `Sie gilt für neue Verträge ab ${fmtDate(v.effectiveFrom)}.` : "Neue Mietverträge verwenden ab jetzt diese Fassung."}</p>}
        <dl className="card px-4 py-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-1 text-sm">
          <div><dt className="label-xs">Interne Nummer</dt><dd className="font-mono tnum">{v.versionNumber}</dd></div>
          <div><dt className="label-xs">Angelegt</dt><dd>{fmtDateTime(v.createdAt)}{v.createdByName ? ` von ${v.createdByName}` : ""}</dd></div>
          <div><dt className="label-xs">Veröffentlicht</dt><dd>{v.publishedAt ? `${fmtDateTime(v.publishedAt)}${v.publishedByName ? ` von ${v.publishedByName}` : ""}` : "–"}</dd></div>
          <div><dt className="label-xs">Gültig ab</dt><dd>{v.effectiveFrom ? fmtDate(v.effectiveFrom) : v.publishedAt ? "ab Veröffentlichung" : "–"}</dd></div>
          <div><dt className="label-xs">Prüfsumme</dt><dd className="font-mono text-xs break-all">{v.checksum ?? "– (erst bei Veröffentlichung)"}</dd></div>
          <div><dt className="label-xs">Verwendet in</dt><dd>{v.usedInContracts} {v.usedInContracts === 1 ? "Mietvertrag" : "Mietverträgen"}</dd></div>
          {v.archivedAt && <div><dt className="label-xs">Archiviert</dt><dd>{fmtDateTime(v.archivedAt)}{v.archivedByName ? ` von ${v.archivedByName}` : ""}</dd></div>}
          {v.changeNote && <div className="sm:col-span-2"><dt className="label-xs">Änderungshinweis</dt><dd>{v.changeNote}</dd></div>}
        </dl>

        {v.status === "DRAFT" && isOwner ? (
          <Card title="Entwurf bearbeiten">
            <div className="p-4"><DraftEditor action={saveDraftAction.bind(null, v.id)} values={{ label: v.label, title: v.title, content: v.content, changeNote: v.changeNote ?? "", effectiveFrom: v.effectiveFrom ? toDateInputValue(v.effectiveFrom) : "" }} /></div>
          </Card>
        ) : (
          <Card title={v.status === "DRAFT" ? "Entwurf (nur Inhaber bearbeitet)" : "Inhalt der Fassung (unveränderlich)"}>
            <div className="p-4 max-w-4xl"><TermsBlocksView blocks={v.blocks} /></div>
          </Card>
        )}

        {isOwner && (
          <Card title="Aktionen">
            <div className="p-4 flex flex-wrap gap-3 items-start text-sm">
              {v.status === "DRAFT" && (
                <>
                  <ConfirmForm action={publishAction.bind(null, v.id)} label="Veröffentlichen" question={`Diese Fassung als Mietbedingungen veröffentlichen (Version ${v.label})?`} hint="Danach ist die Fassung unveränderlich und wird für neue Mietverträge verwendet. Bitte vorher die Vorschau prüfen. Änderungen sind später nur als neue Fassung möglich." submitLabel="Diese Fassung als Mietbedingungen veröffentlichen" pendingLabel="Wird veröffentlicht…" />
                  <ConfirmForm action={discardDraftAction.bind(null, v.id)} label="Entwurf verwerfen" question="Entwurf verwerfen? Der Text geht verloren." submitLabel="Ja, verwerfen" danger />
                </>
              )}
              {v.status !== "DRAFT" && (
                <ConfirmForm action={newVersionAction.bind(null, v.id)} label="Neue Fassung erstellen" question={`Neue Fassung aus Version ${v.label} erstellen?`} hint={`Es entsteht ein Entwurf als Kopie. Version ${v.label} bleibt unverändert.${overview.draft ? " Achtung: Es gibt bereits einen offenen Entwurf." : ""}`} submitLabel="Entwurf anlegen" fields={<label className="flex flex-col gap-1"><span className="label-xs">Versionsbezeichnung</span><input name="label" defaultValue={proposeLabel(overview.versions.map((x) => x.label), v.label)} maxLength={40} className="input" /></label>} />
              )}
              {v.status === "PUBLISHED" && (
                <ConfirmForm action={archiveAction.bind(null, v.id)} label="Archivieren" question={`Version ${v.label} archivieren?`} hint={`Sie gilt dann nicht mehr für neue Verträge. ${v.usedInContracts} bestehende Verträge behalten ihren eingefrorenen Text unverändert.${v.isActive && !overview.versions.some((x) => x.status === "PUBLISHED" && x.id !== v.id) ? " Achtung: Danach gibt es keine aktive Fassung mehr." : ""}`} submitLabel="Ja, archivieren" withReason danger />
              )}
            </div>
          </Card>
        )}

        <Card title="Verwendung" right={<Chip>{v.usedInContracts}</Chip>}>
          {v.contracts.length === 0 ? (
            <p className="p-4 text-sm text-ink-3">Noch in keinem Mietvertrag verwendet.</p>
          ) : (
            <ul className="divide-y divide-line-soft text-sm">
              {v.contracts.map((c) => (
                <li key={c.id} className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={`/buchungen/${c.bookingId}/vertrag`} className="font-mono tnum font-medium hover:underline">{c.number}</Link>
                  <Chip tone={c.status === "SIGNED" ? "good" : c.status === "DRAFT" ? "amber" : "grey"}>{c.status === "SIGNED" ? "Abgeschlossen" : c.status === "DRAFT" ? "Entwurf" : "Storniert"}</Chip>
                  <span className="text-ink-2">{renterOf(c.customerSnapshot)}</span>
                  {c.signedAt && <span className="text-xs text-ink-3">{fmtDateTime(c.signedAt)}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Content>
    </>
  );
}
