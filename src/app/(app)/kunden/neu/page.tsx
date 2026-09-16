import { requireRole } from "@/lib/auth";
import { Card, Content, PageHeader } from "@/components/ui";
import { createCustomerAction } from "../actions";
import { CustomerForm, emptyCustomer } from "../customer-form";

export const metadata = { title: "Neuer Kunde" };

export default async function NewCustomerPage() {
  await requireRole("DISPO", "YARD");
  return (
    <>
      <PageHeader title="Neuer Kunde" />
      <Content>
        <Card className="p-5 max-w-3xl">
          <CustomerForm action={createCustomerAction} values={emptyCustomer} submitLabel="Kunde anlegen" cancelHref="/kunden" />
        </Card>
      </Content>
    </>
  );
}
