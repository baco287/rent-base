import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDateTime } from "@/lib/format";
import { customerToFormValues } from "@/lib/customer-form-values";
import { BookingStatusChip, Card, Chip, Content, PageHeader, Plate } from "@/components/ui";
import { deleteCustomerAction, updateCustomerAction } from "../actions";
import { CustomerForm } from "../customer-form";
import { AuthorityCasesPanel } from "../../behoerden/authority-panel";

export default async function CustomerPage({ params, searchParams }: PageProps<"/kunden/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  const c = await db.customer.findFirst({
    where: { id, tenantId: tenant.id },
    include: { bookings: { include: { vehicle: true }, orderBy: { startAt: "desc" }, take: 10 } },
  });
  if (!c) notFound();

  const values = customerToFormValues(c);

  const update = updateCustomerAction.bind(null, c.id);
  const remove = deleteCustomerAction.bind(null, c.id);

  return (
    <>
      <PageHeader title={customerName(c)} sub={`${c.number ?? "ohne Nummer"} · ${c.type === "COMPANY" ? "Firmenkunde" : "Privatkunde"}`}>
        {c.blocked && <Chip tone="bad">Gesperrt</Chip>}
        {!c.blocked && <Link href={`/buchungen/neu?kunde=${c.id}`} className="btn btn-primary">+ Buchung</Link>}
      </PageHeader>
      <Content>
        {sp.gespeichert === "1" && <Chip tone="good">Gespeichert</Chip>}
        {sp.fehler === "buchungen" && <Chip tone="bad">Kunde hat Buchungen und kann deshalb nicht gelöscht werden.</Chip>}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 items-start">
          <Card className="p-5">
            <CustomerForm action={update} values={values} submitLabel="Speichern" cancelHref="/kunden" />
            {user.role === "OWNER" && c.bookings.length === 0 && (
              <form action={remove} className="mt-6 pt-4 border-t border-line-soft">
                <button type="submit" className="btn btn-danger">Kunde löschen</button>
                <span className="text-xs text-ink-3 ml-3">Endgültig, nur ohne Buchungen möglich.</span>
              </form>
            )}
          </Card>
          <div className="flex flex-col gap-4">
          <Card title="Letzte Buchungen">
            {c.bookings.length === 0 ? (
              <p className="p-4 text-ink-3 text-sm">Noch keine Buchungen.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {c.bookings.map((b) => (
                  <li key={b.id} className="px-4 py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <Link href={`/buchungen/${b.id}`} className="font-medium hover:underline">{b.vehicle.make} {b.vehicle.model}</Link>
                      <div className="text-xs text-ink-3 font-mono tnum">{fmtDateTime(b.startAt)} bis {fmtDateTime(b.endAt)}</div>
                    </div>
                    <Plate>{b.vehicle.plate}</Plate>
                    <BookingStatusChip status={b.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <AuthorityCasesPanel tenantId={tenant.id} scope={{ customerId: c.id }} canManage={user.role !== "YARD"} />
          </div>
        </div>
      </Content>
    </>
  );
}
