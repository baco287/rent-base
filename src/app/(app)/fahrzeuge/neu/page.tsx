import { requireRole } from "@/lib/auth";
import { Card, Content, PageHeader } from "@/components/ui";
import { createVehicleAction } from "../actions";
import { VehicleForm, emptyVehicle } from "../vehicle-form";

export const metadata = { title: "Neues Fahrzeug" };

export default async function NewVehiclePage() {
  await requireRole("DISPO");
  return (
    <>
      <PageHeader title="Neues Fahrzeug" />
      <Content>
        <Card className="p-5 max-w-3xl">
          <VehicleForm action={createVehicleAction} values={emptyVehicle} submitLabel="Fahrzeug anlegen" cancelHref="/fahrzeuge" />
        </Card>
      </Content>
    </>
  );
}
