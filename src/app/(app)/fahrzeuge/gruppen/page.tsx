import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { resolveRules } from "@/lib/business-rules";
import { overrideValues } from "@/lib/business-rules-form";
import { deleteGroupAction, updateGroupRulesAction } from "./actions";
import { GroupForm } from "./forms";
import { OverrideForm } from "../../einstellungen/geschaeftsregeln/rules-forms";

export const metadata = { title: "Fahrzeuggruppen" };

export default async function GroupsPage({ searchParams }: PageProps<"/fahrzeuge/gruppen">) {
  const { tenant, user } = await requireSession();
  const sp = await searchParams;
  const groups = await db.vehicleGroup.findMany({
    where: { tenantId: tenant.id },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { vehicles: true } } },
  });
  const canEdit = user.role === "OWNER" || user.role === "DISPO";
  const inherited = resolveRules(tenant.businessRules, null, null).values;
  const dec = (v: { toString(): string } | null) => (v === null ? "" : v.toString().replace(".", ","));

  return (
    <>
      <PageHeader title="Fahrzeuggruppen" sub={`${groups.length} Gruppen`}>
        <Link href="/fahrzeuge" className="btn">Zurück zu den Fahrzeugen</Link>
      </PageHeader>
      <Content>
        {sp.fehler === "belegt" && <Chip tone="bad">Die Gruppe enthält noch Fahrzeuge und kann deshalb nicht gelöscht werden.</Chip>}
        <p className="text-sm text-ink-2 max-w-[70ch]">
          Gruppen ordnen die Flotte, zum Beispiel Transporter 3,5 t, Kompaktklasse, Kombi. Die Preise der Gruppe werden beim Anlegen eines Fahrzeugs vorgeschlagen und können je Fahrzeug abweichen. Die Reihenfolge bestimmt die Sortierung in Liste und Kalender.
        </p>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          {groups.map((g) => (
            <Card
              key={g.id}
              title={g.name}
              right={
                <>
                  <Chip>{g._count.vehicles} {g._count.vehicles === 1 ? "Fahrzeug" : "Fahrzeuge"}</Chip>
                  {user.role === "OWNER" && g._count.vehicles === 0 && (
                    <form action={deleteGroupAction.bind(null, g.id)}><button className="btn btn-danger !py-1">Löschen</button></form>
                  )}
                </>
              }
            >
              {canEdit ? (
                <GroupForm
                  id={g.id}
                  values={{
                    name: g.name, description: g.description ?? "", sortOrder: g.sortOrder.toString(),
                    dailyRate: dec(g.dailyRate), workWeekRate: dec(g.workWeekRate), weeklyRate: dec(g.weeklyRate), monthlyRate: dec(g.monthlyRate),
                    kmIncludedPerDay: g.kmIncludedPerDay.toString(), extraKmRate: dec(g.extraKmRate), deposit: dec(g.deposit),
                  }}
                />
              ) : (
                <p className="p-4 text-sm text-ink-3">{g.description || "Keine Beschreibung."}</p>
              )}
              {user.role === "OWNER" && (
                <div className="border-t border-line-soft">
                  <div className="px-4 pt-3 label-xs">Abweichende Geschäftsregeln dieser Gruppe</div>
                  <OverrideForm action={updateGroupRulesAction.bind(null, g.id)} values={overrideValues(g.businessRules)} inherited={inherited} scopeLabel={`Gruppe „${g.name}“`} />
                </div>
              )}
            </Card>
          ))}
          {canEdit && (
            <Card title="Neue Gruppe" className="border-dashed">
              <GroupForm values={{ name: "", description: "", sortOrder: String((groups.at(-1)?.sortOrder ?? 0) + 10), dailyRate: "", workWeekRate: "", weeklyRate: "", monthlyRate: "", kmIncludedPerDay: "200", extraKmRate: "0,25", deposit: "" }} />
            </Card>
          )}
        </div>
      </Content>
    </>
  );
}
