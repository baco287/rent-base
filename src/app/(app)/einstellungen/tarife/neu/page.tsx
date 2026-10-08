import { randomUUID } from "node:crypto";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Content } from "@/components/ui";
import { SettingsHeader } from "../../settings-ui";
import { createRatePlanAction } from "../actions";
import { TariffEditor } from "../tariff-editor";

export const metadata = { title: "Miettarif anlegen" };

export default async function NewRatePlanPage() {
  const { tenant } = await requireRole("OWNER");
  const groups = await db.vehicleGroup.findMany({ where: { tenantId: tenant.id }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, defaultRatePlan: { select: { name: true } }, _count: { select: { vehicles: true } } } });
  return (
    <>
      <SettingsHeader title="Miettarif anlegen" sub="Name frei wählbar (z. B. BASIC, PLUS, CITY 100). Preise je Fahrzeuggruppe.">
        <Link href="/einstellungen/tarife" className="btn">Zurück</Link>
      </SettingsHeader>
      <Content>
        <div className="max-w-4xl">
          <TariffEditor
            action={createRatePlanAction}
            mode="create"
            canEdit
            createKey={randomUUID()}
            groups={groups.map((g) => ({ id: g.id, name: g.name, vehicles: g._count.vehicles, defaultElsewhere: g.defaultRatePlan?.name ?? null }))}
            initial={{ name: "", code: "", description: "", sortOrder: "0", km: { policy: "FREE_KILOMETERS", kmIncludedPerDay: "200", extraKmRate: "0,25" }, deposit: "500,00", groups: {} }}
          />
        </div>
      </Content>
    </>
  );
}
