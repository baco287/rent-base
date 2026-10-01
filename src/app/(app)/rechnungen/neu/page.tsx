import { randomUUID } from "node:crypto";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { Card, Content, PageHeader } from "@/components/ui";
import { loadCustomerOption } from "../../buchungen/customer-option";
import { NewInvoiceForm } from "./new-invoice-form";
import { customerBookingsAction } from "../actions";

export const metadata = { title: "Neue Rechnung" };

/** Befehl 23.1: freie Rechnung – Kunde wählen, optional Buchungsbezug; danach der normale Rechnungseditor. */
export default async function NewInvoicePage({ searchParams }: PageProps<"/rechnungen/neu">) {
  const { tenant } = await requireRole("DISPO");
  const sp = await searchParams;
  const initial = typeof sp.kunde === "string" ? await loadCustomerOption(tenant.id, sp.kunde) : null;
  const loaded = initial ? await customerBookingsAction(initial.id) : null;
  const initialBookings = loaded && !("error" in loaded) ? loaded : null;
  return (
    <>
      <PageHeader title="Neue Rechnung" sub="Freie Rechnung, z. B. Reinigung, Zubehör, Sonderleistung oder Nachberechnung">
        <Link href="/rechnungen" className="btn">Rechnungen</Link>
      </PageHeader>
      <Content>
        <div className="max-w-2xl w-full">
          <Card title="Rechnungsempfänger und Bezug">
            <NewInvoiceForm nonce={randomUUID()} initialCustomer={initial} initialBookings={initialBookings} />
          </Card>
        </div>
      </Content>
    </>
  );
}
