import { requireSession } from "@/lib/auth";
import { handoverCenter } from "@/lib/handover-center";
import { PageHeader } from "@/components/ui";
import { HandoverCenterView } from "@/components/handover-center-view";

export const metadata = { title: "Übergaben" };

/**
 * Befehl 29.7: Übergabezentrale – heute, überfällig, anstehend, in Bearbeitung, abgeschlossen. Nur Übersicht: durchgeführt
 * wird im Übergabe-Assistenten der Buchung (dort Rollen-, Vertrags-, Fahrer- und Verfügbarkeitsprüfung). Lesen dürfen Inhaber,
 * Disposition, Hof und der Supportmodus (nur lesend, ohne Assistenten-Links). Filter, Suche, Zeitraum und Seite stehen in
 * der Adresse (filter, q, von, bis, seite); ungültige Werte fallen auf den Standard zurück.
 */
export default async function HandoversPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant, user, supportSession } = await requireSession();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const c = await handoverCenter(tenant.id, {
    kind: "PICKUP",
    filter: one(sp.filter),
    q: one(sp.q),
    von: one(sp.von),
    bis: one(sp.bis),
    page: one(sp.seite),
    viewer: { role: user.role, support: !!supportSession },
  });

  return (
    <>
      <PageHeader
        title="Übergaben"
        sub={<>Anstehende, laufende und abgeschlossene Fahrzeugübergaben.<span className="block text-xs">Durchgeführt wird im Übergabe-Assistenten der Buchung.</span></>}
      />
      <HandoverCenterView c={c} />
    </>
  );
}
