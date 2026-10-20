import { requireSession } from "@/lib/auth";
import { handoverCenter } from "@/lib/handover-center";
import { PageHeader } from "@/components/ui";
import { HandoverCenterView } from "@/components/handover-center-view";

export const metadata = { title: "Rückgaben" };

/**
 * Befehl 29.7: Rückgabezentrale – heute (inkl. gemeldeter Schlüsselbox-Rückgaben), überfällig (ohne Unfallersatz), anstehend,
 * in Bearbeitung, offenes Mietende (Unfallersatz), abgeschlossen. Nur Übersicht: durchgeführt wird im Rückgabe-Assistenten der
 * Buchung (dort Rollen-, Vertrags-, Nachtrags- und Schlüsselbox-Prüfung). Lesen dürfen Inhaber, Disposition, Hof und der
 * Supportmodus (nur lesend, ohne Assistenten-Links). Filter, Suche, Zeitraum und Seite stehen in der Adresse.
 */
export default async function ReturnsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant, user, supportSession } = await requireSession();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const c = await handoverCenter(tenant.id, {
    kind: "RETURN",
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
        title="Rückgaben"
        sub={<>Geplante, laufende und abgeschlossene Fahrzeugrückgaben.<span className="block text-xs">Durchgeführt wird im Rückgabe-Assistenten der Buchung.</span></>}
      />
      <HandoverCenterView c={c} />
    </>
  );
}
