import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, Empty } from "@/components/ui";
import { SettingsHeader } from "../settings-ui";
import { fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { listRatePlans } from "@/lib/tariff-admin";
import { kmRuleText } from "@/lib/tariffs";

export const metadata = { title: "Miettarife" };

/** Befehl 29: Übersicht der Miettarife des Mandanten. Inhaber verwaltet, andere Rollen sehen die Tarife. */
export default async function RatePlansPage() {
  const { tenant, user, supportSession } = await requireSession();
  const canEdit = user.role === "OWNER" && !supportSession;
  const plans = await listRatePlans(tenant.id);
  return (
    <>
      <SettingsHeader title="Miettarife" sub="Eigene Tarife je Fahrzeuggruppe: Preisstufen, Kilometerregel und Kaution. Der Tarif liefert den regulären Preis – je Buchung kann mit Grund abgewichen werden.">
        {canEdit && <Link href="/einstellungen/tarife/neu" className="btn btn-primary">+ Tarif anlegen</Link>}
      </SettingsHeader>
      <Content>
        {plans.length === 0 ? (
          <Empty action={canEdit ? { href: "/einstellungen/tarife/neu", label: "Ersten Tarif anlegen" } : undefined}>Noch keine Miettarife. Ohne Tarif können keine neuen Buchungen angelegt werden.</Empty>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {plans.map((p) => (
              <Link key={p.id} href={`/einstellungen/tarife/${p.id}`} className="block min-w-0">
                <Card className="h-full hover:border-ink-3">
                  <div className="p-4 flex flex-col gap-2 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-base break-words">{p.name}{p.code ? <span className="text-ink-3 font-normal"> · {p.code}</span> : null}</span>
                      <Chip tone={p.active ? "good" : "grey"}>{p.active ? "Aktiv" : "Deaktiviert"}</Chip>
                    </div>
                    <div className="text-ink-2">{p.groups.length ? p.groups.join(", ") : <span className="text-amber">keine Fahrzeuggruppe zugeordnet</span>}</div>
                    {p.defaultFor.length > 0 && <div className="text-xs"><Chip tone="info">Standard</Chip> für {p.defaultFor.join(", ")}</div>}
                    <div className="text-xs text-ink-3">{p.km ? kmRuleText(p.km) : "–"} · Kaution {fmtCents(p.depositCents)}</div>
                    <div className="text-xs text-ink-3">Revision {p.revision} · zuletzt geändert {fmtDateTime(p.updatedAt)}{p.updatedByName ? ` von ${p.updatedByName}` : ""}</div>
                    <div className="text-xs text-ink-3">{p.bookings} {p.bookings === 1 ? "Buchung" : "Buchungen"}{p.vehicleOverrides ? ` · ${p.vehicleOverrides} Fahrzeugpreis${p.vehicleOverrides === 1 ? "" : "e"}` : ""}</div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
        {!canEdit && <p className="text-xs text-ink-3">Miettarife verwaltet der Inhaber.</p>}
      </Content>
    </>
  );
}
