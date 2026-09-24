import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { customerToFormValues } from "@/lib/customer-form-values";
import { customerHeader, customerOverview } from "@/lib/customer-file";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { deleteCustomerAction, updateCustomerAction } from "../actions";
import { CustomerForm } from "../customer-form";
import { AuthorityTab, BookingsTab, CommunicationTab, DamagesTab, DepositsTab, DocumentsTab, FinanceTab, HistoryTab, OverviewTab } from "./file-tabs";

const TABS = [
  { key: "uebersicht", label: "Übersicht" },
  { key: "buchungen", label: "Buchungen & Mieten" },
  { key: "finanzen", label: "Finanzen" },
  { key: "kautionen", label: "Kautionen" },
  { key: "schaeden", label: "Schäden" },
  { key: "dokumente", label: "Dokumente" },
  { key: "kommunikation", label: "Kommunikation" },
  { key: "behoerden", label: "Behördenvorgänge" },
  { key: "historie", label: "Historie" },
  { key: "stammdaten", label: "Stammdaten" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** Kundenakte 360°: Kopf, Reiter (?tab=…), alles aus vorhandenen Modulen; keine neuen Geschäftsprozesse. */
export default async function CustomerPage({ params, searchParams }: PageProps<"/kunden/[id]">) {
  const { tenant, user } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "uebersicht") as Tab;
  const page = Math.max(1, parseInt(typeof sp.seite === "string" ? sp.seite : "1", 10) || 1);

  const head = await customerHeader(tenant.id, id);
  if (!head) notFound();
  const c = head.customer;
  const overview = tab === "uebersicht" ? await customerOverview(tenant.id, c.id, c) : null;
  const bookingCount = tab === "stammdaten" ? await db.booking.count({ where: { tenantId: tenant.id, customerId: c.id } }) : 0;
  const canManage = user.role !== "YARD";
  const href = (t: Tab) => `/kunden/${c.id}${t === "uebersicht" ? "" : `?tab=${t}`}`;
  const address = [c.street, `${c.zip ?? ""} ${c.city ?? ""}`.trim(), c.country && c.country !== "DE" ? c.country : null].filter(Boolean).join(", ");
  const salutation = c.type === "COMPANY" ? "Firmenkunde" : "Privatkunde";
  const now = new Date();
  const licenseExpired = !!c.licenseValidUntil && c.licenseValidUntil < now;

  return (
    <>
      <PageHeader title={head.name} sub={`${c.number ?? "ohne Nummer"} · ${salutation}${c.type === "COMPANY" && c.companyName ? ` · ${c.firstName} ${c.lastName}`.trimEnd() : ""}`}>
        {c.blocked && <Chip tone="bad">Gesperrt</Chip>}
        {c.discountPercent > 0 && <Chip tone="info">{c.discountPercent} % Rabatt</Chip>}
        <Link href={href("stammdaten")} className="btn">Bearbeiten</Link>
        {c.email && <a href={`mailto:${encodeURIComponent(c.email)}`} className="btn">E-Mail</a>}
        {c.phone && <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="btn md:hidden">Anrufen</a>}
        {!c.blocked && canManage && <Link href={`/buchungen/neu?kunde=${c.id}`} className="btn btn-primary">+ Neue Buchung</Link>}
      </PageHeader>
      <Content>
        {sp.gespeichert === "1" && <Chip tone="good">Gespeichert</Chip>}
        {sp.fehler === "buchungen" && <Chip tone="bad">Kunde hat Buchungen und kann deshalb nicht gelöscht werden.</Chip>}

        <Card className="p-4">
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-sm">
            <div><dt className="label-xs">Kundennummer</dt><dd className="font-mono tnum">{c.number ?? "–"}</dd></div>
            <div><dt className="label-xs">Anschrift</dt><dd>{address || "–"}</dd></div>
            <div><dt className="label-xs">Telefon</dt><dd>{c.phone ? <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="hover:underline">{c.phone}</a> : "–"}</dd></div>
            <div><dt className="label-xs">E-Mail</dt><dd className="break-all">{c.email ? <a href={`mailto:${encodeURIComponent(c.email)}`} className="hover:underline">{c.email}</a> : "–"}</dd></div>
            <div><dt className="label-xs">Geburtsdatum</dt><dd className="font-mono tnum">{c.birthDate ? fmtDate(c.birthDate) : "–"}</dd></div>
            <div><dt className="label-xs">Führerschein</dt><dd>{c.licenseNumber ? <>{c.licenseClass ? `Klasse ${c.licenseClass}` : "erfasst"}{c.licenseValidUntil ? ` · bis ${fmtDate(c.licenseValidUntil)}` : ""} {licenseExpired ? <Chip tone="bad">abgelaufen</Chip> : <Chip tone="good">gültig</Chip>}</> : <Chip tone="amber">fehlt</Chip>}</dd></div>
            <div><dt className="label-xs">Zuletzt geprüft</dt><dd>{head.licenseLastChecked ? <>{fmtDate(head.licenseLastChecked.verifiedAt)}<span className="block text-[11px] text-ink-3 font-sans">Original-Prüfung bei einer Übergabe{head.licenseLastChecked.expiredAtCheckTime ? " · damals bereits abgelaufen" : ""} – keine Aussage über die heutige Gültigkeit</span></> : <span className="text-ink-3">noch nie geprüft</span>}</dd></div>
            <div><dt className="label-xs">Angelegt</dt><dd className="font-mono tnum">{fmtDate(c.createdAt)}</dd></div>
            <div><dt className="label-xs">Letzte Aktivität</dt><dd className="font-mono tnum">{head.lastActivityAt ? <>{fmtDateTime(head.lastActivityAt)}<span className="block text-[11px] text-ink-3 font-sans">{head.lastActivityWhat}</span></> : "–"}</dd></div>
          </dl>
          {c.blocked && c.blockReason && <p className="mt-3 rounded-md bg-bad-soft text-bad px-3 py-2 text-sm">Gesperrt: {c.blockReason}</p>}
          {c.notes && <p className="mt-3 text-sm text-ink-2 whitespace-pre-line">{c.notes}</p>}
        </Card>

        <nav aria-label="Bereiche der Kundenakte" className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {TABS.map((t) => <Link key={t.key} href={href(t.key)} aria-current={t.key === tab ? "page" : undefined} className={`btn !py-1.5 shrink-0 ${t.key === tab ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{t.label}</Link>)}
        </nav>

        {tab === "uebersicht" && overview && <OverviewTab customerId={c.id} o={overview} />}
        {tab === "buchungen" && <BookingsTab tenantId={tenant.id} customerId={c.id} page={page} now={now.getTime()} />}
        {tab === "finanzen" && <FinanceTab tenantId={tenant.id} customerId={c.id} />}
        {tab === "kautionen" && <DepositsTab tenantId={tenant.id} customerId={c.id} />}
        {tab === "schaeden" && <DamagesTab tenantId={tenant.id} customerId={c.id} />}
        {tab === "dokumente" && <DocumentsTab tenantId={tenant.id} customerId={c.id} role={user.role} />}
        {tab === "kommunikation" && <CommunicationTab tenantId={tenant.id} customerId={c.id} />}
        {tab === "behoerden" && <AuthorityTab tenantId={tenant.id} customerId={c.id} canManage={canManage} />}
        {tab === "historie" && <HistoryTab tenantId={tenant.id} customerId={c.id} />}
        {tab === "stammdaten" && (
          <Card className="p-5">
            <CustomerForm action={updateCustomerAction.bind(null, c.id)} values={customerToFormValues(c)} submitLabel="Speichern" cancelHref={`/kunden/${c.id}`} />
            {user.role === "OWNER" && bookingCount === 0 && (
              <form action={deleteCustomerAction.bind(null, c.id)} className="mt-6 pt-4 border-t border-line-soft">
                <button type="submit" className="btn btn-danger">Kunde löschen</button>
                <span className="text-xs text-ink-3 ml-3">Endgültig, nur ohne Buchungen möglich.</span>
              </form>
            )}
          </Card>
        )}
      </Content>
    </>
  );
}

