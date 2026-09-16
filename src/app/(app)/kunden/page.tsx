import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDate } from "@/lib/format";
import { Card, Chip, Content, Empty, PageHeader } from "@/components/ui";

export const metadata = { title: "Kunden" };

function licenseChip(c: { licenseValidUntil: Date | null; licenseNumber: string | null }) {
  if (!c.licenseNumber) return <Chip tone="amber">fehlt</Chip>;
  if (c.licenseValidUntil && c.licenseValidUntil < new Date()) return <Chip tone="bad">abgelaufen</Chip>;
  return <Chip tone="good">erfasst</Chip>;
}

export default async function CustomersPage({ searchParams }: PageProps<"/kunden">) {
  const { tenant } = await requireSession();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";

  const customers = await db.customer.findMany({
    where: {
      tenantId: tenant.id,
      ...(q
        ? { OR: [{ lastName: { contains: q } }, { firstName: { contains: q } }, { companyName: { contains: q } }, { phone: { contains: q } }, { email: { contains: q } }] }
        : {}),
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    include: { _count: { select: { bookings: true } }, bookings: { orderBy: { startAt: "desc" }, take: 1, select: { startAt: true } } },
    take: 200,
  });

  return (
    <>
      <PageHeader title="Kunden" sub={`${customers.length} Einträge`}>
        <form className="flex gap-2">
          <input name="q" defaultValue={q} placeholder="Name, Firma, Telefon" className="input !w-56 !min-h-[36px]" />
          <button className="btn">Suchen</button>
        </form>
        <Link href="/kunden/neu" className="btn btn-primary">+ Kunde</Link>
      </PageHeader>
      <Content>
        <Card>
          {customers.length === 0 ? (
            <Empty action={q ? undefined : { href: "/kunden/neu", label: "Ersten Kunden anlegen" }}>
              {q ? `Nichts gefunden für „${q}“.` : "Noch keine Kunden angelegt."}
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="text-left">
                    <th className="label-xs px-3 py-2 border-b border-line">Kunde</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Kontakt</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Führerschein</th>
                    <th className="label-xs px-3 py-2 border-b border-line text-right">Mieten</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Letzte Miete</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Hinweis</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                      <td className="px-3 py-2.5">
                        <Link href={`/kunden/${c.id}`} className="font-medium hover:underline">{customerName(c)}</Link>
                        <div className="text-xs text-ink-3">
                          {c.type === "COMPANY" ? `Firma · ${c.firstName} ${c.lastName}` : "Privat"}{c.city ? ` · ${c.city}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {c.phone && <div>{c.phone}</div>}
                        {c.email && <div className="text-xs text-ink-3">{c.email}</div>}
                      </td>
                      <td className="px-3 py-2.5">{licenseChip(c)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tnum">{c._count.bookings}</td>
                      <td className="px-3 py-2.5 font-mono tnum">{c.bookings[0] ? fmtDate(c.bookings[0].startAt) : "–"}</td>
                      <td className="px-3 py-2.5 flex gap-1.5 flex-wrap">
                        {c.blocked && <Chip tone="bad">Gesperrt{c.blockReason ? ` · ${c.blockReason}` : ""}</Chip>}
                        {c.discountPercent > 0 && <Chip tone="info">{c.discountPercent} % Rabatt</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Content>
    </>
  );
}
