// Schadenakte und Historie eines Fahrzeugs. Beides sind eigene Tabellen (Damage, VehicleEvent), keine Textfelder:
// Übergabe und Rückgabe mit Kilometerstand, jeder Schaden mit Zeitpunkt, Protokoll und Buchung.
import Link from "next/link";
import { db } from "@/lib/db";
import { Card, Chip } from "@/components/ui";
import { DAMAGE_KINDS, DAMAGE_SEVERITY, DAMAGE_STATUS, DAMAGE_VIEWS, VEHICLE_EVENT_TYPES, type DamageKind, type DamageSeverity, type DamageStatus, type DamageView, type VehicleEventType } from "@/lib/constants";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { listVehicleEvents } from "@/lib/vehicle-events";
import { CaseStatusChip, LiabilityChip } from "../../schaeden/chips";
import { openDamageCaseAction } from "../../schaeden/[id]/actions";
import { ActionButton } from "../../schaeden/[id]/case-forms";

export async function VehicleFile({ tenantId, vehicleId }: { tenantId: string; vehicleId: string }) {
  const [damages, events] = await Promise.all([
    db.damage.findMany({
      where: { tenantId, vehicleId },
      orderBy: [{ status: "asc" }, { discoveredAt: "desc" }],
      include: { discoveredIn: { select: { id: true, number: true, type: true, bookingId: true } }, booking: { select: { id: true, number: true } }, photos: { select: { id: true }, orderBy: { uploadedAt: "asc" } }, damageCase: { select: { id: true, caseNumber: true, status: true, liabilityStatus: true } } },
    }),
    listVehicleEvents(db, tenantId, vehicleId, 60),
  ]);
  const open = damages.filter((d) => d.status !== "REPAIRED");
  const repaired = damages.filter((d) => d.status === "REPAIRED");
  const origin = (d: (typeof damages)[number]) => {
    if (!d.discoveredIn) return "Auf dem Hof erfasst";
    return d.discoveredIn.type === "RETURN" ? `Bei Rückgabe festgestellt (${d.discoveredIn.number})` : `Vorschaden bei Übergabe (${d.discoveredIn.number})`;
  };
  const href = (d: (typeof damages)[number]) => (d.discoveredIn ? `/buchungen/${d.discoveredIn.bookingId}/${d.discoveredIn.type === "RETURN" ? "rueckgabe" : "uebergabe"}` : null);

  return (
    <>
      <Card title="Schadenakte" right={<><Chip tone={open.length > 0 ? "amber" : "good"}>{open.length} offen</Chip>{repaired.length > 0 && <Chip>{repaired.length} repariert</Chip>}</>}>
        {damages.length === 0 ? (
          <p className="p-4 text-ink-3 text-sm">Keine Schäden dokumentiert.</p>
        ) : (
          <ul className="divide-y divide-line-soft text-sm">
            {[...open, ...repaired].map((d) => (
              <li key={d.id} className="px-4 py-2.5 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{DAMAGE_KINDS[d.kind as DamageKind] ?? d.kind} · {DAMAGE_VIEWS[d.view as DamageView] ?? d.view}</span>
                  <Chip tone={d.status === "REPAIRED" ? "good" : d.status === "OPEN" ? "amber" : "grey"}>{DAMAGE_STATUS[d.status as DamageStatus] ?? d.status}</Chip>
                  {d.settlementReview && !d.damageCase && d.status !== "REPAIRED" && <Chip tone="bad">Schadenabrechnung prüfen</Chip>}
                  {d.damageCase && <><Link href={`/schaeden/${d.damageCase.id}`} className="font-mono tnum underline">{d.damageCase.caseNumber}</Link><CaseStatusChip status={d.damageCase.status} /><LiabilityChip status={d.damageCase.liabilityStatus} /></>}
                </div>
                <div className="text-ink-2">{d.description}{d.size ? ` (${d.size})` : ""} · {DAMAGE_SEVERITY[d.severity as DamageSeverity] ?? d.severity}</div>
                <div className="text-xs text-ink-3 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>{origin(d)}</span>
                  <span className="font-mono tnum">{fmtDateTime(d.discoveredAt)}</span>
                  {d.booking && <Link href={`/buchungen/${d.booking.id}`} className="underline">Buchung {d.booking.number}</Link>}
                  {href(d) && <Link href={href(d)!} className="underline">Protokoll</Link>}
                  <span>{d.photos.length} {d.photos.length === 1 ? "Foto" : "Fotos"}</span>
                  {d.repairedAt && <span>repariert am {fmtDateTime(d.repairedAt)}</span>}
                </div>
                {!d.damageCase && <div className="mt-1"><ActionButton action={openDamageCaseAction.bind(null, d.id)} label="Schadenakte eröffnen" pendingLabel="Wird eröffnet…" small /></div>}
                {d.photos.length > 0 && (
                  <div className="flex gap-2 flex-wrap mt-1">
                    {d.photos.slice(0, 4).map((p) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <a key={p.id} href={`/api/photos/${p.id}`} target="_blank" rel="noopener noreferrer"><img src={`/api/photos/${p.id}`} alt="Schadenfoto" loading="lazy" className="h-16 w-20 object-cover rounded border border-line bg-panel-2" /></a>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Historie" right={<Chip>{events.length}</Chip>}>
        {events.length === 0 ? (
          <p className="p-4 text-ink-3 text-sm">Noch keine Einträge.</p>
        ) : (
          <ul className="divide-y divide-line-soft text-sm">
            {events.filter((e) => e.type !== "MILEAGE").map((e) => (
              <li key={e.id} className="px-4 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-mono tnum text-xs text-ink-3 w-[11ch]">{fmtDateTime(e.occurredAt)}</span>
                <span className="font-medium">{VEHICLE_EVENT_TYPES[e.type as VehicleEventType] ?? e.type}</span>
                {e.mileage != null && <span className="font-mono tnum">{fmtInt(e.mileage)} km</span>}
                {e.description && <span className="text-ink-2 flex-1 min-w-[12ch]">{e.description}</span>}
                {e.bookingId && <Link href={`/buchungen/${e.bookingId}`} className="text-xs underline text-ink-3">Buchung</Link>}
                {e.userName && <span className="text-xs text-ink-3">{e.userName}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
