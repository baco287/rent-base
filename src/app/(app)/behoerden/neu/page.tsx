import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { contactOptions } from "@/lib/authority-contacts";
import { Card, Content, PageHeader } from "@/components/ui";
import { createCaseAction } from "../actions";
import { LetterIntake } from "../authority-forms";

export const metadata = { title: "Behördenschreiben erfassen" };

/** Schreiben hochladen (PDF wird gelesen und vorbelegt) oder manuell erfassen; optional mit Kennzeichen eines Fahrzeugs (?fahrzeug=…). */
export default async function NewAuthorityCasePage({ searchParams }: PageProps<"/behoerden/neu">) {
  const { tenant } = await requireRole("DISPO");
  const sp = await searchParams;
  const vehicleId = typeof sp.fahrzeug === "string" ? sp.fahrzeug : "";
  const [vehicle, contacts] = await Promise.all([
    vehicleId ? db.vehicle.findFirst({ where: { id: vehicleId, tenantId: tenant.id }, select: { plate: true } }) : null,
    contactOptions(tenant.id),
  ]);

  return (
    <>
      <PageHeader title="Behördenschreiben erfassen" sub="Bußgeldbescheid, Anhörungsbogen, Zeugenfragebogen, Halteranfrage, Maut …">
        <Link href="/behoerden/einstellungen" className="btn">Adressbuch</Link>
        <Link href="/behoerden" className="btn">Übersicht</Link>
      </PageHeader>
      <Content>
        <Card className="p-5">
          <LetterIntake action={createCaseAction} contacts={contacts} initial={vehicle ? { licensePlate: vehicle.plate } : undefined} />
        </Card>
      </Content>
    </>
  );
}
