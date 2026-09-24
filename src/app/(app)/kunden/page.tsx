import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerName, fmtDate } from "@/lib/format";
import { customerSearchWhere, SEARCH_MAX } from "@/lib/search";
import { Card, Chip, Content, Empty, PageHeader } from "@/components/ui";

export const metadata = { title: "Kunden" };
const PAGE = 50;

function licenseChip(c: { licenseValidUntil: Date | null; licenseNumber: string | null }) {
  if (!c.licenseNumber) return <Chip tone="amber">fehlt</Chip>;
  if (c.licenseValidUntil && c.licenseValidUntil < new Date()) return <Chip tone="bad">abgelaufen</Chip>;
  return <Chip tone="good">erfasst</Chip>;
}

function idChip(c: { idNumber: string | null; idValidUntil: Date | null }) {
  if (!c.idNumber) return <Chip tone="amber">fehlt</Chip>;
  if (c.idValidUntil && c.idValidUntil < new Date()) return <Chip tone="bad">abgelaufen</Chip>;
  return <Chip tone="good">erfasst</Chip>;
}

/** Kundenliste: Suche (Nummer, Name, Firma, E-Mail, Telefon – case-insensitiv, Telefon normalisiert) und Serverseiten. */
export default async function CustomersPage({ searchParams }: PageProps<"/kunden">) {
  const { tenant } = await requireSession();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim().slice(0, SEARCH_MAX) : "";
  const page = Math.max(1, parseInt(typeof params.seite === "string" ? params.seite : "1", 10) || 1);
  const where = q ? await customerSearchWhere(tenant.id, q) : { tenantId: tenant.id };
  const qs = (p: number) => `/kunden?${new URLSearchParams({ ...(q ? { q } : {}), seite: String(p) }).toString()}`;

  const [total, customers] = await Promise.all([
    db.customer.count({ where }),
    db.customer.findMany({
      where,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      include: { _count: { select: { bookings: true } }, bookings: { orderBy: { startAt: "desc" }, take: 1, select: { startAt: true } } },
      skip: (page - 1) * PAGE,
      take: PAGE,
    }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <PageHeader title="Kunden" sub={q ? `${total} Treffer für „${q}“` : `${total} Einträge`}>
        <form className="flex gap-2" role="search">
          <label htmlFor="kunden-q" className="sr-only">Kunden suchen</label>
          <input id="kunden-q" name="q" defaultValue={q} maxLength={SEARCH_MAX} placeholder="Nummer, Name, Firma, E-Mail, Telefon" className="input !w-64 !min-h-[36px]" />
          <button className="btn">Suchen</button>
          {q && <Link href="/kunden" className="btn">Zurücksetzen</Link>}
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
                    <th className="label-xs px-3 py-2 border-b border-line">Nr.</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Kunde</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Kontakt</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Ausweis</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Führerschein</th>
                    <th className="label-xs px-3 py-2 border-b border-line text-right">Mieten</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Letzte Miete</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Hinweis</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.id} className="border-b border-line-soft last:border-0 hover:bg-panel-2/60">
                      <td className="px-3 py-2.5 font-mono tnum text-ink-2">{c.number ?? "–"}</td>
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
                      <td className="px-3 py-2.5">{idChip(c)}</td>
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
          {pages > 1 && (
            <nav aria-label="Seiten" className="px-4 py-3 border-t border-line-soft flex items-center gap-2">
              {page > 1 && <Link href={qs(page - 1)} className="btn !py-1.5">Zurück</Link>}
              <Chip>Seite {page} von {pages}</Chip>
              {page < pages && <Link href={qs(page + 1)} className="btn !py-1.5">Weiter</Link>}
            </nav>
          )}
        </Card>
      </Content>
    </>
  );
}
