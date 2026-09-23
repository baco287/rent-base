import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Content, PageHeader } from "@/components/ui";
import { createCaseAction } from "../actions";
import { CaseForm } from "../authority-forms";

export const metadata = { title: "Behördenschreiben erfassen" };

/** Manuelle Erfassung eines Behördenschreibens; optional mit Kennzeichen eines Fahrzeugs vorbelegt (?fahrzeug=…). */
export default async function NewAuthorityCasePage({ searchParams }: PageProps<"/behoerden/neu">) {
  const { tenant } = await requireRole("DISPO");
  const sp = await searchParams;
  const vehicleId = typeof sp.fahrzeug === "string" ? sp.fahrzeug : "";
  const vehicle = vehicleId ? await db.vehicle.findFirst({ where: { id: vehicleId, tenantId: tenant.id }, select: { plate: true } }) : null;

  return (
    <>
      <PageHeader title="Behördenschreiben erfassen" sub="Bußgeldbescheid, Anhörungsbogen, Zeugenfragebogen, Halteranfrage, Maut …">
        <Link href="/behoerden" className="btn">Übersicht</Link>
      </PageHeader>
      <Content>
        <Card className="p-5 max-w-3xl">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-2">Bitte die Angaben aus dem Schreiben übertragen. Das Schreiben selbst kann danach am Vorgang als PDF oder Foto hochgeladen werden. Es findet keine automatische Texterkennung statt.</p>
            <CaseForm action={createCaseAction} values={vehicle ? { licensePlate: vehicle.plate } : undefined} submitLabel="Vorgang anlegen" />
          </div>
        </Card>
      </Content>
    </>
  );
}
