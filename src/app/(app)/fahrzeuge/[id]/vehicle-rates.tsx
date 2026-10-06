// Befehl 29: Karte „Tarifpreise“ der Fahrzeugakte – je Tarif der Fahrzeuggruppe der wirksame Preis, gekennzeichnet als
// „Preis aus Fahrzeuggruppe“ oder „Individueller Fahrzeugpreis“. Bearbeiten nur der Inhaber (außerhalb des Supportmodus).
import Link from "next/link";
import { Card, Chip } from "@/components/ui";
import { fmtCents } from "@/lib/money";
import { kmRuleText, type KmRule } from "@/lib/tariffs";
import { vehicleRateView } from "@/lib/tariff-admin";
import { setVehicleRateOverrideAction } from "../../einstellungen/tarife/actions";
import { VehicleRateForm } from "./vehicle-rate-form";

const label = (t: { days: number; label?: string | null }) => t.label || (t.days === 1 ? "Tag" : `${t.days} Tage`);

export async function VehicleRates({ tenantId, vehicleId, canEdit }: { tenantId: string; vehicleId: string; canEdit: boolean }) {
  const view = await vehicleRateView(tenantId, vehicleId);
  return (
    <Card title="Tarifpreise" id="tarife" right={<Link href="/einstellungen/tarife" className="text-xs underline">Miettarife</Link>}>
      {view.rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-3">{view.groupName ? `Für die Fahrzeuggruppe „${view.groupName}“ ist noch kein Miettarif hinterlegt.` : "Dem Fahrzeug ist keine Fahrzeuggruppe zugeordnet."}</p>
      ) : (
        <div className="divide-y divide-line-soft">
          {view.rows.map((r) => {
            const effective = new Map(r.groupTiers.map((t) => [t.days, { ...t, vehicle: false }]));
            for (const t of r.override?.tiers ?? []) {
              if (t.cents == null) effective.delete(t.days);
              else effective.set(t.days, { days: t.days, cents: t.cents, label: effective.get(t.days)?.label ?? null, vehicle: true });
            }
            const rows = [...effective.values()].sort((a, b) => a.days - b.days);
            return (
              <div key={r.ratePlanId} className="p-4 flex flex-col gap-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <b>{r.name}</b>
                  {!r.active && <Chip tone="grey">deaktiviert</Chip>}
                  {r.isDefault && <Chip tone="info">Standard</Chip>}
                  <Chip tone={r.override ? "amber" : "grey"}>{r.override ? "Individueller Fahrzeugpreis" : "Preis aus Fahrzeuggruppe"}</Chip>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {rows.map((t) => <span key={t.days} className="tnum">{label(t)} <span className={`font-mono ${t.vehicle ? "font-semibold" : ""}`}>{fmtCents(t.cents)}</span>{t.vehicle ? " (Fahrzeug)" : ""}</span>)}
                </div>
                {r.override?.depositCents != null && <div className="text-xs">Kaution für dieses Fahrzeug: {fmtCents(r.override.depositCents)}</div>}
                {r.override?.km && <div className="text-xs">Kilometer für dieses Fahrzeug: {kmRuleText(r.override.km as KmRule)}</div>}
                {canEdit && (
                  <details>
                    <summary className="cursor-pointer text-ink-2">Fahrzeugpreis bearbeiten</summary>
                    <div className="pt-2">
                      <VehicleRateForm action={setVehicleRateOverrideAction.bind(null, vehicleId, r.ratePlanId)} groupTiers={r.groupTiers} override={r.override} />
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
