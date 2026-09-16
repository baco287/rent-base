import { requireRole } from "@/lib/auth";
import { Card, Content, PageHeader } from "@/components/ui";
import { createVehicleAction } from "../actions";
import { loadGroupOptions } from "../groups";
import { VehicleForm, emptyVehicle } from "../vehicle-form";

export const metadata = { title: "Neues Fahrzeug" };

export default async function NewVehiclePage({ searchParams }: PageProps<"/fahrzeuge/neu">) {
  const { tenant } = await requireRole("DISPO");
  const sp = await searchParams;
  const groups = await loadGroupOptions(tenant.id);
  const preset = groups.find((g) => g.id === sp.gruppe);

  const values = preset
    ? { ...emptyVehicle, groupId: preset.id, dailyRate: preset.dailyRate, weeklyRate: preset.weeklyRate, monthlyRate: preset.monthlyRate, kmIncludedPerDay: preset.kmIncludedPerDay, extraKmRate: preset.extraKmRate, deposit: preset.deposit }
    : emptyVehicle;

  return (
    <>
      <PageHeader title="Neues Fahrzeug" sub={preset ? `Gruppe ${preset.name}` : undefined} />
      <Content>
        <Card className="p-5 max-w-3xl">
          <VehicleForm action={createVehicleAction} values={values} groups={groups} submitLabel="Fahrzeug anlegen" cancelHref="/fahrzeuge" />
        </Card>
      </Content>
    </>
  );
}
