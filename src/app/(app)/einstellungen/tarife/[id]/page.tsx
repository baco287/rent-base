import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { ratePlanEditorState } from "@/lib/tariff-admin";
import { tierLabel } from "@/lib/pricing";
import { duplicateRatePlanAction, saveRatePlanAction, setRatePlanActiveAction } from "../actions";
import { TariffEditor, type EditorInitial } from "../tariff-editor";
import { DuplicateForm } from "../tariff-forms";

export const metadata = { title: "Miettarif" };

const euro = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));

export default async function RatePlanPage({ params, searchParams }: PageProps<"/einstellungen/tarife/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { tenant, user, supportSession } = await requireSession();
  const s = await ratePlanEditorState(tenant.id, id);
  if (!s) notFound();
  const canEdit = user.role === "OWNER" && !supportSession;
  const { plan, content } = s;
  const kmOf = (k: { policy: "FREE_KILOMETERS" | "UNLIMITED"; kmIncludedPerDay: number | null; extraKmRateCents: number | null }) => ({ policy: k.policy, kmIncludedPerDay: k.kmIncludedPerDay == null ? "" : String(k.kmIncludedPerDay), extraKmRate: euro(k.extraKmRateCents) });
  const initial: EditorInitial = {
    name: plan.name,
    code: plan.code ?? "",
    description: plan.description ?? "",
    sortOrder: String(plan.sortOrder),
    km: content ? kmOf(content.km) : { policy: "FREE_KILOMETERS", kmIncludedPerDay: "", extraKmRate: "" },
    deposit: euro(content?.depositCents ?? 0),
    groups: Object.fromEntries((content?.groups ?? []).map((g) => [g.groupId, { tiers: g.tiers.map((t) => ({ days: String(t.days), price: euro(t.cents), label: t.label ?? "" })), deposit: euro(g.depositCents), km: g.km ? kmOf(g.km) : null, isDefault: s.defaultGroupIds.includes(g.groupId) }])),
  };
  const fehler = typeof sp.fehler === "string" ? sp.fehler : null;
  return (
    <>
      <PageHeader title={`Miettarif ${plan.name}`} sub={<span className="flex flex-wrap items-center gap-2"><Chip tone={plan.active ? "good" : "grey"}>{plan.active ? "Aktiv" : "Deaktiviert"}</Chip><span className="text-ink-3">Revision {plan.revisions[0]?.revision ?? 0} · {plan._count.bookings} {plan._count.bookings === 1 ? "Buchung" : "Buchungen"}</span></span>}>
        <Link href="/einstellungen/tarife" className="btn">Alle Tarife</Link>
        {canEdit && (plan.active
          ? <form action={setRatePlanActiveAction.bind(null, plan.id, false)}><button className="btn">Deaktivieren</button></form>
          : <form action={setRatePlanActiveAction.bind(null, plan.id, true)}><button className="btn btn-primary">Aktivieren</button></form>)}
      </PageHeader>
      <Content>
        {sp.gespeichert === "1" && <p role="status" className="rounded-md bg-good-soft text-good px-3 py-2 text-sm">Gespeichert.</p>}
        {sp.kopie === "1" && <p role="status" className="rounded-md bg-info-soft text-info px-3 py-2 text-sm">Kopie angelegt (deaktiviert). Bitte prüfen und aktivieren.</p>}
        {fehler && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3 py-2 text-sm">{fehler}</p>}
        {!plan.active && <p className="rounded-md bg-panel-2 px-3 py-2 text-sm text-ink-2">Deaktiviert: wird für neue Buchungen nicht angeboten. Bestehende Buchungen und Verträge behalten ihren eingefrorenen Stand.</p>}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4 items-start">
          <div className="min-w-0">
            <TariffEditor
              action={saveRatePlanAction.bind(null, plan.id)}
              mode="edit"
              canEdit={canEdit}
              expectedRevisionId={plan.currentRevisionId ?? ""}
              groups={s.groups.map((g) => ({ id: g.id, name: g.name, vehicles: g._count.vehicles, defaultElsewhere: g.defaultRatePlanId && g.defaultRatePlanId !== plan.id ? "anderer Tarif" : null }))}
              initial={initial}
            />
          </div>
          <div className="flex flex-col gap-4 min-w-0">
            <Card title="Revisionen">
              <ul className="divide-y divide-line-soft text-sm">
                {plan.revisions.map((r) => (
                  <li key={r.id} className="px-4 py-2 flex flex-col">
                    <span><b>Revision {r.revision}</b>{r.id === plan.currentRevisionId ? <span className="text-good"> · aktuell</span> : ""}</span>
                    <span className="text-xs text-ink-3">{fmtDateTime(r.createdAt)}{r.createdByName ? ` · ${r.createdByName}` : ""}</span>
                    {r.note && <span className="text-xs text-ink-2">{r.note}</span>}
                  </li>
                ))}
              </ul>
              <p className="px-4 pb-3 text-xs text-ink-3">Jede Preisänderung ist eine neue Revision. Buchungen und Verträge rechnen mit ihrer eingefrorenen Revision.</p>
            </Card>
            <Card title="Fahrzeugpreise">
              {plan.vehicleOverrides.length === 0 ? (
                <p className="px-4 py-3 text-sm text-ink-3">Alle Fahrzeuge nutzen den Preis ihrer Fahrzeuggruppe. Abweichungen werden in der Fahrzeugakte gepflegt.</p>
              ) : (
                <ul className="divide-y divide-line-soft text-sm">
                  {plan.vehicleOverrides.map((o) => (
                    <li key={o.id} className="px-4 py-2 flex flex-col">
                      <Link href={`/fahrzeuge/${o.vehicle.id}#tarife`} className="font-medium hover:underline">{o.vehicle.plate} · {o.vehicle.make} {o.vehicle.model}</Link>
                      <span className="text-xs text-ink-2">{o.tiers.map((t) => `${tierLabel(t.durationDays)} ${t.priceCents == null ? "nicht angeboten" : fmtCents(t.priceCents)}`).join(" · ")}{o.depositCents != null ? ` · Kaution ${fmtCents(o.depositCents)}` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {canEdit && (
              <Card title="Duplizieren">
                <div className="p-4"><DuplicateForm action={duplicateRatePlanAction.bind(null, plan.id)} createKey={randomUUID()} suggestion={`${plan.name} (Kopie)`.slice(0, 60)} /></div>
              </Card>
            )}
          </div>
        </div>
      </Content>
    </>
  );
}
