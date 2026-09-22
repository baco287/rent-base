// Schäden mit Stand ihrer Akte – für Buchung, Rückgabe und Fahrzeug. „Schadenakte eröffnen“ ist eine bewusste Aktion je Schaden;
// historische Schäden ohne Akte bleiben Schäden ohne Akte (keine Massenanlage).
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Card, Chip } from "@/components/ui";
import { DAMAGE_KINDS, DAMAGE_STATUS, DAMAGE_VIEWS, type DamageKind, type DamageStatus, type DamageView } from "@/lib/constants";
import { damagesWithCases } from "@/lib/damage-cases";
import { fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { CaseStatusChip, LiabilityChip } from "./chips";
import { openDamageCaseAction } from "./[id]/actions";
import { ActionButton } from "./[id]/case-forms";

export type DamageWithCase = Awaited<ReturnType<typeof damagesWithCases>>[number];

/** Eine Zeile je Schaden: Akte vorhanden → Link und Stand; sonst Eröffnen-Knopf (alle Rollen). */
export function DamageCaseRow({ d, showVehicleLink = false }: { d: DamageWithCase; showVehicleLink?: boolean }) {
  const dc = d.damageCase;
  const inv = dc?.invoices[0] ?? null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{DAMAGE_KINDS[d.kind as DamageKind] ?? d.kind} · {DAMAGE_VIEWS[d.view as DamageView] ?? d.view}</span>
        <Chip tone={d.status === "REPAIRED" ? "good" : d.status === "OPEN" ? "amber" : "grey"}>{DAMAGE_STATUS[d.status as DamageStatus] ?? d.status}</Chip>
        {d.settlementReview && !dc && d.status !== "REPAIRED" && <Chip tone="bad">Schadenabrechnung prüfen</Chip>}
      </div>
      <div className="text-ink-2 text-sm">{d.description}{d.size ? ` (${d.size})` : ""}</div>
      <div className="text-xs text-ink-3 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>{d.discoveredIn ? (d.discoveredIn.type === "RETURN" ? `Bei Rückgabe festgestellt (${d.discoveredIn.number})` : `Vorschaden bei Übergabe (${d.discoveredIn.number})`) : "Auf dem Hof erfasst"}</span>
        <span className="font-mono tnum">{fmtDateTime(d.discoveredAt)}</span>
        {showVehicleLink && <Link href={`/fahrzeuge/${d.vehicleId}`} className="underline">Fahrzeug</Link>}
      </div>
      {dc ? (
        <div className="flex flex-wrap items-center gap-2 text-xs mt-0.5">
          <Link href={`/schaeden/${dc.id}`} className="btn !py-1.5 font-mono tnum">{dc.caseNumber}</Link>
          <CaseStatusChip status={dc.status} />
          <LiabilityChip status={dc.liabilityStatus} />
          {dc.customerChargeCents != null && <Chip tone="info">Belastung {fmtCents(dc.customerChargeCents)}</Chip>}
          {inv && <Link href={`/buchungen/${inv.bookingId}/rechnung?nr=${inv.id}`} className="underline">Schadenabrechnung {inv.number ?? "(Entwurf)"}</Link>}
        </div>
      ) : (
        <div className="mt-0.5"><ActionButton action={openDamageCaseAction.bind(null, d.id)} label="Schadenakte eröffnen" pendingLabel="Wird eröffnet…" small /></div>
      )}
    </div>
  );
}

export async function DamageCasesPanel({ tenantId, where, title = "Schäden", empty = "Keine Schäden dokumentiert.", showVehicleLink = false }: { tenantId: string; where: Prisma.DamageWhereInput; title?: string; empty?: string; showVehicleLink?: boolean }) {
  const damages = await damagesWithCases(tenantId, where);
  const withCase = damages.filter((d) => d.damageCase).length;
  return (
    <Card title={title} right={<><Chip tone={damages.length > 0 ? "amber" : "good"}>{damages.length} {damages.length === 1 ? "Schaden" : "Schäden"}</Chip>{withCase > 0 && <Chip>{withCase} {withCase === 1 ? "Akte" : "Akten"}</Chip>}</>}>
      {damages.length === 0 ? (
        <p className="p-4 text-ink-3 text-sm">{empty}</p>
      ) : (
        <ul className="divide-y divide-line-soft text-sm">
          {damages.map((d) => <li key={d.id} className="px-4 py-2.5"><DamageCaseRow d={d} showVehicleLink={showVehicleLink} /></li>)}
        </ul>
      )}
      <p className="px-4 pb-3 text-xs text-ink-3">Ein Schaden ist eine Feststellung. Haftung, Kosten und Kundenbelastung werden ausschließlich in der Schadenakte entschieden.</p>
    </Card>
  );
}
