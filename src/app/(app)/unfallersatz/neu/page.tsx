import { randomUUID } from "node:crypto";
import { requireFeature, requireRole } from "@/lib/auth";
import { partnerOptions } from "@/lib/business-partners";
import { db } from "@/lib/db";
import { toDateTimeInput } from "@/lib/format";
import { parseLocalDateTime, toDateInputValue } from "@/lib/time";
import { Content, PageHeader } from "@/components/ui";
import { loadCustomerOption } from "../../buchungen/customer-option";
import { loadBookingOptions } from "../../buchungen/options";
import { RentalTypeSwitch, carryQuery } from "../../buchungen/rental-type-switch";
import { accidentAvailabilityAction, createAccidentCaseAction } from "./actions";
import { AccidentWizard } from "./wizard";

export const metadata = { title: "Neue Buchung – Unfallersatz" };

/**
 * Befehl 29 Phase C: geführte Anlage einer Unfallersatzmiete. Nur OWNER und DISPO, nur bei freigeschaltetem Modul – geprüft hier
 * und im Modul-Layout (eine Teil-Navigation kann das Layout überspringen; die Seite liefert Adressbuch und Flotte).
 */
export default async function NewAccidentCasePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await requireRole("DISPO");
  await requireFeature("ACCIDENT_REPLACEMENT");
  const sp = await searchParams;
  const customerId = typeof sp.kunde === "string" ? sp.kunde : "";
  const vehicleId = typeof sp.fahrzeug === "string" ? sp.fahrzeug : "";
  const [{ vehicles }, insurers, workshops, lawyers, initialCustomer, t] = await Promise.all([
    loadBookingOptions(tenant.id),
    partnerOptions(tenant.id, "INSURER"),
    partnerOptions(tenant.id, "WORKSHOP"),
    partnerOptions(tenant.id, "LAWYER"),
    loadCustomerOption(tenant.id, customerId),
    db.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { pricesIncludeTax: true } }),
  ]);
  // Unfallersatz beginnt meist sofort: Vorschlag ist die nächste Viertelstunde; ein künftiger Tag aus dem Kalender beginnt um 09:00
  const now = new Date();
  const tag = typeof sp.tag === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.tag) && sp.tag > toDateInputValue(now) ? parseLocalDateTime(`${sp.tag}T09:00`) : null;
  const start = tag ?? new Date(Math.ceil(now.getTime() / 900_000) * 900_000);
  return (
    <>
      <PageHeader title="Neue Buchung" sub="Unfallersatz" />
      <Content>
        <RentalTypeSwitch current="ACCIDENT_REPLACEMENT" query={carryQuery(sp)} />
        <AccidentWizard
          action={createAccidentCaseAction}
          availabilityAction={accidentAvailabilityAction}
          vehicles={vehicles.filter((v) => v.status !== "INACTIVE")}
          partners={{ insurers, workshops, lawyers }}
          initialCustomer={initialCustomer?.blocked ? null : initialCustomer}
          initialVehicleId={vehicles.some((v) => v.id === vehicleId) ? vehicleId : ""}
          defaultStartAt={toDateTimeInput(start)}
          nonce={randomUUID()}
          pricesIncludeTax={t.pricesIncludeTax !== false}
        />
      </Content>
    </>
  );
}
