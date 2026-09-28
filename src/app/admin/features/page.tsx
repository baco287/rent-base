import Link from "next/link";
import { can, requirePlatform } from "@/lib/platform-auth";
import { featureMatrix } from "@/lib/features";
import { Card, Content, PageHeader } from "@/components/ui";
import { FEATURES, FEATURE_KEYS } from "@/lib/constants";
import { EmptyRow, Notice, Td, TenantStatusChip, Th } from "../ui";
import { FeatureToggle } from "./forms";

export const metadata = { title: "Features" };
export const dynamic = "force-dynamic";

export default async function FeaturesPage({ searchParams }: PageProps<"/admin/features">) {
  const session = await requirePlatform("FEATURES_VIEW");
  const sp = await searchParams;
  const query = typeof sp.q === "string" && sp.q ? sp.q : undefined;
  const { rows, counts } = await featureMatrix({ query });
  const canManage = can(session, "FEATURE_MANAGE");

  return (
    <>
      <PageHeader title="Feature Management" sub="Freischaltungen je Mandant" />
      <Content>
        <Notice sp={sp} />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {FEATURE_KEYS.map((k) => (
            <Card key={k} title={FEATURES[k].label} right={<span className="text-xs text-ink-3 tnum">{counts[k].enabled} an · {counts[k].disabled} aus</span>}>
              <p className="px-3.5 py-3 text-sm text-ink-2">{FEATURES[k].description}</p>
              <p className="px-3.5 pb-3 text-xs text-ink-3">Standard für neue Mandanten: {FEATURES[k].defaultEnabled ? "freigeschaltet" : "gesperrt"}{FEATURES[k].nav.length ? ` · Navigation: ${FEATURES[k].nav.join(", ")}` : ""}</p>
            </Card>
          ))}
        </div>

        <form className="card p-3 flex gap-2 items-end" action="/admin/features">
          <label className="flex flex-col gap-1 flex-1 max-w-md"><span className="label-xs">Mandant suchen</span><input name="q" defaultValue={query ?? ""} placeholder="Firmenname oder Kurzname" className="input" /></label>
          <button type="submit" className="btn btn-primary">Filtern</button>
          <Link href="/admin/features" className="btn">Zurücksetzen</Link>
        </form>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-ink-3">
              <tr>
                <Th>Mandant</Th>
                {FEATURE_KEYS.map((k) => <Th key={k} className="text-center whitespace-nowrap">{FEATURES[k].label.split(" ")[0]}<span className="sr-only"> {FEATURES[k].label}</span></Th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rows.map((r) => (
                <tr key={r.tenantId} className="hover:bg-surface-2">
                  <Td><Link href={`/admin/mandanten/${r.tenantId}#features`} className="font-medium text-brand hover:underline">{r.tenantName}</Link><div className="mt-0.5"><TenantStatusChip status={r.tenantStatus} /></div></Td>
                  {FEATURE_KEYS.map((k) => (
                    <Td key={k} className="text-center">
                      <div className="flex flex-col items-center gap-1">
                        <FeatureToggle tenantId={r.tenantId} featureKey={k} label={FEATURES[k].label} enabled={r.state[k]} canManage={canManage} compact />
                        {r.overrides[k] && <span className="text-[10px] text-ink-3" title={r.overrides[k]?.note ?? undefined}>{r.overrides[k]?.updatedByName ?? "geändert"}</span>}
                      </div>
                    </Td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && <EmptyRow colSpan={FEATURE_KEYS.length + 1}>Keine Mandanten gefunden.</EmptyRow>}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-3">Neue Module: Schlüssel in FEATURES (lib/constants.ts) ergänzen und an den Einstiegspunkten requireFeature()/featureForApi() aufrufen – die Matrix, die Mandantenseite und das Audit übernehmen den Rest. Ohne Eintrag gilt der Standardwert, Bestandsmandanten bleiben unverändert.</p>
      </Content>
    </>
  );
}
