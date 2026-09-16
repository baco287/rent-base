import { requireRole } from "@/lib/auth";
import { toDateTimeInput } from "@/lib/format";
import { Card, Content, PageHeader } from "@/components/ui";
import { createBookingAction } from "../actions";
import { BookingForm } from "../booking-form";
import { loadBookingOptions } from "../options";

export const metadata = { title: "Neue Buchung" };

export default async function NewBookingPage({ searchParams }: PageProps<"/buchungen/neu">) {
  const { tenant } = await requireRole("DISPO");
  const sp = await searchParams;
  const { vehicles, customers } = await loadBookingOptions(tenant.id);

  const vehicleId = typeof sp.fahrzeug === "string" ? sp.fahrzeug : "";
  const customerId = typeof sp.kunde === "string" ? sp.kunde : "";
  const v = vehicles.find((x) => x.id === vehicleId);

  // Vorschlag: morgen 09:00 bis übermorgen 09:00, oder der Tag aus dem Kalender
  const start = new Date();
  if (typeof sp.tag === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.tag)) {
    const [y, m, d] = sp.tag.split("-").map(Number);
    start.setFullYear(y, m - 1, d);
  } else {
    start.setDate(start.getDate() + 1);
  }
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return (
    <>
      <PageHeader title="Neue Buchung" />
      <Content>
        <Card className="p-5 max-w-3xl">
          <BookingForm
            action={createBookingAction}
            values={{
              vehicleId,
              customerId,
              startAt: toDateTimeInput(start),
              endAt: toDateTimeInput(end),
              dailyRate: v?.dailyRate ?? "",
              deposit: v?.deposit ?? "",
              notes: "",
            }}
            vehicles={vehicles}
            customers={customers}
            submitLabel="Buchung anlegen"
            cancelHref="/buchungen"
          />
        </Card>
      </Content>
    </>
  );
}
