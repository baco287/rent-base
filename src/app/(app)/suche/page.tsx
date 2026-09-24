import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, Empty, PageHeader } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { globalSearch, SEARCH_MAX, SEARCH_MIN, searchQuerySchema, type SearchResult } from "@/lib/search";

export const metadata = { title: "Suche" };

/** Vollständige Trefferliste (auch ohne JavaScript erreichbar): ?q= im Adressfeld, je Vorgangsart bis zu 20 Treffer. */
export default async function SearchPage({ searchParams }: PageProps<"/suche">) {
  const { tenant, user } = await requireSession();
  const sp = await searchParams;
  const raw = typeof sp.q === "string" ? sp.q.slice(0, SEARCH_MAX) : "";
  const parsed = searchQuerySchema.safeParse(raw);
  const result: SearchResult | null = parsed.success ? await globalSearch(tenant.id, user.role, parsed.data, { perType: 20 }) : null;

  return (
    <>
      <PageHeader title="Suche" sub={result ? `${result.total} Treffer für „${result.q}“` : "Kunden, Buchungen, Fahrzeuge, Belege, Vorgänge"}>
        <form action="/suche" role="search" className="flex gap-2">
          <label htmlFor="suche-q" className="sr-only">Suchbegriff</label>
          <input id="suche-q" name="q" defaultValue={raw} minLength={SEARCH_MIN} maxLength={SEARCH_MAX} placeholder="Nummer, Name, Kennzeichen, E-Mail, Telefon" className="input !w-64 !min-h-[36px]" autoFocus={!raw} />
          <button className="btn">Suchen</button>
        </form>
      </PageHeader>
      <Content>
        {!raw && <Card><Empty>Suchbegriff eingeben – mindestens {SEARCH_MIN} Zeichen. Gefunden werden Kundennummern, Buchungs-, Vertrags- und Belegnummern (RE, GS, ST, AZ, SCH, WA, BH), Kennzeichen, Namen, Firmen, E-Mail-Adressen und Telefonnummern.</Empty></Card>}
        {raw && !parsed.success && <Card><Empty>{parsed.error.issues[0].message}</Empty></Card>}
        {result && result.groups.length === 0 && <Card><Empty>Nichts gefunden für „{result.q}“. Tipp: Kennzeichen ohne Leerzeichen, Nummern vollständig eingeben.</Empty></Card>}
        {result?.groups.map((g) => (
          <Card key={g.type} title={g.label} right={<div className="flex items-center gap-2"><Chip>{g.hits.length}{g.more ? "+" : ""}</Chip>{g.more && g.moreHref && <Link href={g.moreHref} className="text-xs underline">alle in der Liste</Link>}</div>}>
            <ul className="divide-y divide-line-soft text-sm">
              {g.hits.map((h) => (
                <li key={h.id}>
                  <Link href={h.href} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-panel-2/60">
                    <span className="font-medium">{h.label}</span>
                    {h.status && <Chip tone={h.status.tone}>{h.status.text}</Chip>}
                    <span className="text-ink-3 min-w-0 truncate">{h.context}</span>
                    {h.date && <span className="ml-auto font-mono tnum text-xs text-ink-3">{fmtDate(h.date)}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </Content>
    </>
  );
}
