import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Content, PageHeader, Plate, VehicleStatusChip } from "@/components/ui";
import { MAINTENANCE_TYPES } from "@/lib/constants";
import { createMaintenanceAction } from "../actions";
import { CreateMaintenanceForm } from "../maintenance-forms";

export const metadata = { title: "Wartung / Werkstatt hinzufügen" };

/** „Wartung / Werkstatt hinzufügen“ für ein Fahrzeug (?fahrzeug=…), optional aus Plan (?plan=), Schadenakte (?akte=) oder Art (?art=). */
export default async function NewMaintenancePage({ searchParams }: PageProps<"/fahrzeuge/wartung/neu">) {
  const { tenant } = await requireRole("DISPO");
  const sp = await searchParams;
  const vehicleId = typeof sp.fahrzeug === "string" ? sp.fahrzeug : "";
  const vehicle = vehicleId ? await db.vehicle.findFirst({ where: { id: vehicleId, tenantId: tenant.id }, select: { id: true, plate: true, make: true, model: true, status: true, mileage: true } }) : null;
  if (!vehicle) notFound();
  const [plans, cases] = await Promise.all([
    db.maintenancePlan.findMany({ where: { tenantId: tenant.id, vehicleId: vehicle.id, isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, type: true } }),
    db.damageCase.findMany({ where: { tenantId: tenant.id, vehicleId: vehicle.id, status: { not: "CLOSED" } }, orderBy: { createdAt: "desc" }, select: { id: true, caseNumber: true, description: true } }),
  ]);
  const presetPlan = typeof sp.plan === "string" && plans.some((p) => p.id === sp.plan) ? sp.plan : null;
  const presetCase = typeof sp.akte === "string" && cases.some((c) => c.id === sp.akte) ? sp.akte : null;
  const presetType = typeof sp.art === "string" && sp.art in MAINTENANCE_TYPES ? sp.art : presetPlan ? plans.find((p) => p.id === presetPlan)!.type : null;

  return (
    <>
      <PageHeader title="Wartung / Werkstatt hinzufügen" sub={<><Plate>{vehicle.plate}</Plate> {vehicle.make} {vehicle.model} · {vehicle.mileage.toLocaleString("de-DE")} km</>}>
        <VehicleStatusChip status={vehicle.status} />
        <Link href={`/fahrzeuge/${vehicle.id}?tab=wartung`} className="btn">Zur Fahrzeugakte</Link>
      </PageHeader>
      <Content>
        <Card className="p-5 max-w-3xl">
          <CreateMaintenanceForm action={createMaintenanceAction.bind(null, vehicle.id)} plans={plans} cases={cases} presetPlanId={presetPlan} presetCaseId={presetCase} presetType={presetType} vehicleMileage={vehicle.mileage} />
        </Card>
      </Content>
    </>
  );
}
