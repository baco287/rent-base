// Befehl 25: Karte „Vertrag & Nachträge“ auf der Buchungsseite. Liest den wirksamen Vertragsstand ausschließlich aus
// lib/amendments (effectiveStateForBooking); hier wird nichts zusammengerechnet.
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { db } from "@/lib/db";
import { Card, Chip } from "@/components/ui";
import { AMENDMENT_HELP, AMENDMENT_STATUS, type AmendmentStatus } from "@/lib/constants";
import { amendmentAllowed, amendmentKindsLabel, effectiveStateForBooking, listAmendments, pendingSettlements } from "@/lib/amendments";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { createAmendmentAction, createAmendmentSettlementAction } from "./actions";

const tone: Record<AmendmentStatus, "amber" | "good" | "grey"> = { DRAFT: "amber", SIGNED: "good", DISCARDED: "grey" };

export async function AmendmentsCard({ tenantId, bookingId, role, supportMode }: { tenantId: string; bookingId: string; role: string; supportMode: boolean }) {
  const booking = await db.booking.findFirst({ where: { id: bookingId, tenantId }, select: { status: true, contract: { select: { id: true, number: true, status: true, signedAt: true } } } });
  if (!booking?.contract || booking.contract.status !== "SIGNED") return null;
  const [state, amendments, pending] = await Promise.all([effectiveStateForBooking(tenantId, bookingId), listAmendments(tenantId, bookingId), pendingSettlements(tenantId, bookingId)]);
  if (!state) return null;
  const canManage = role !== "YARD" && !supportMode;
  const allowed = amendmentAllowed(booking, booking.contract);
  const openDraft = amendments.find((a) => a.status === "DRAFT");
  const changed = (n: string | null) => (n ? <span className="block text-[11px] text-ink-3 font-sans">geändert durch {n}</span> : null);
  const rate = state.extraKmRate.toLocaleString("de-DE", { minimumFractionDigits: 2 });
  const rentalInvoiceFinal = pending.length > 0;

  return (
    <div id="vertrag" className="scroll-mt-20">
      <Card title="Vertrag & Nachträge" right={<Chip tone={state.amendments.length ? "info" : "grey"}>{state.amendments.length === 0 ? "ohne Nachtrag" : `${state.amendments.length} ${state.amendments.length === 1 ? "Nachtrag" : "Nachträge"} wirksam`}</Chip>}>
        <div className="p-4 flex flex-col gap-4">
          <ul className="divide-y divide-line-soft text-sm">
            <li className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link href={`/buchungen/${bookingId}/vertrag`} className="font-mono tnum font-medium hover:underline">{booking.contract.number}</Link>
              <span>Mietvertrag</span>
              <Chip tone="good">Unterschrieben</Chip>
              <span className="text-ink-3 text-xs">{booking.contract.signedAt ? fmtDateTime(booking.contract.signedAt) : ""}</span>
            </li>
            {amendments.map((a) => (
              <li key={a.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link href={`/buchungen/${bookingId}/nachtrag/${a.id}`} className="font-mono tnum font-medium hover:underline">{a.number ?? "Entwurf"}</Link>
                <span>{a.status === "SIGNED" && a.sequenceNo ? `${a.sequenceNo}. Nachtrag` : "Nachtrag"} · {amendmentKindsLabel(a)}</span>
                <Chip tone={tone[a.status as AmendmentStatus] ?? "grey"}>{AMENDMENT_STATUS[a.status as AmendmentStatus] ?? a.status}</Chip>
                <span className="text-ink-3 text-xs">{a.status === "SIGNED" && a.signedAt ? `wirksam seit ${fmtDateTime(a.signedAt)}` : a.status === "DISCARDED" && a.discardedAt ? `verworfen ${fmtDate(a.discardedAt)}` : `angelegt ${fmtDate(a.createdAt)}`}</span>
                {a.status === "SIGNED" && (a.documents[0] ? <a href={`/api/documents/${a.documents[0].id}`} target="_blank" rel="noopener noreferrer" className="text-xs underline">PDF</a> : <span className="text-xs text-ink-3">PDF noch nicht erzeugt</span>)}
                {a.status === "SIGNED" && (a.emailLogs[0] ? <Chip tone="good">versendet {fmtDate(a.emailLogs[0].sentAt ?? new Date())}</Chip> : <Chip>nicht versendet</Chip>)}
              </li>
            ))}
          </ul>

          <div className="rounded-md bg-panel-2 p-3.5 flex flex-col gap-2">
            <div className="label-xs">Aktuell vereinbart{state.amendments.length ? ` (Vertrag + ${state.amendments.map((a) => a.number).join(", ")})` : ""}</div>
            <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-2 text-sm">
              <div><dt className="text-ink-3">Mietbeginn</dt><dd className="font-mono tnum">{fmtDateTime(state.startAt)}</dd></div>
              <div><dt className="text-ink-3">Geplante Rückgabe</dt><dd className="font-mono tnum">{fmtDateTime(state.endAt)}{changed(state.changedBy.endAt)}</dd></div>
              <div><dt className="text-ink-3">Gesamtmietpreis</dt><dd className="font-mono tnum">{fmtCents(state.totalCents)}{changed(state.changedBy.total)}</dd></div>
              <div><dt className="text-ink-3">Kilometer</dt><dd className="font-mono tnum">{state.kmIncludedPerDay.toLocaleString("de-DE")} km/Tag · {rate} €/km{changed(state.changedBy.km)}</dd></div>
              <div><dt className="text-ink-3">Vereinbarte Kaution</dt><dd className="font-mono tnum">{fmtCents(state.depositCents)}{changed(state.changedBy.deposit)}</dd></div>
              <div><dt className="text-ink-3">Rückgabeort</dt><dd>{state.returnLocation ?? state.pickupLocation ?? "wie Abholort"}{changed(state.changedBy.returnLocation)}</dd></div>
              <div className="sm:col-span-2 xl:col-span-3"><dt className="text-ink-3">Fahrer</dt><dd>{state.drivers.map((d) => `${d.firstName} ${d.lastName}${d.role === "PRIMARY_DRIVER" ? " (Hauptfahrer)" : ""}${d.addedBy ? ` – aufgenommen durch ${state.amendments.find((a) => a.id === d.addedBy)?.number ?? "Nachtrag"}` : ""}`).join(" · ")}</dd></div>
              {state.agreements.length > 0 && <div className="sm:col-span-2 xl:col-span-3"><dt className="text-ink-3">Sonstige Vereinbarungen</dt><dd className="flex flex-col gap-1">{state.agreements.map((g) => <span key={g.number} className="whitespace-pre-wrap"><span className="font-mono tnum text-xs text-ink-3">{g.number}: </span>{g.text}</span>)}</dd></div>}
            </dl>
          </div>

          {pending.length > 0 && (
            <div className="rounded-md bg-amber-soft text-amber px-3.5 py-3 text-sm flex flex-col gap-2">
              <div className="font-semibold">Noch abzurechnende Vertragsänderung</div>
              {pending.map((p) => (
                <div key={p.amendment.id} className="flex flex-wrap items-center gap-2">
                  <span>{p.amendment.number}: {p.deltaCents > 0 ? "+" : "−"}{fmtCents(Math.abs(p.deltaCents))} – die Mietrechnung {p.invoiceNumber} ist bereits abgeschlossen und wird nicht verändert.</span>
                  {canManage && p.deltaCents > 0 && (
                    <form action={createAmendmentSettlementAction.bind(null, bookingId, p.amendment.id)}><input type="hidden" name="nonce" value={randomUUID()} /><button className="btn !py-1.5">Rechnung über {fmtCents(p.deltaCents)} erstellen</button></form>
                  )}
                  {canManage && p.deltaCents < 0 && <Link href={`/buchungen/${bookingId}/rechnung?nr=${p.invoiceId}`} className="btn !py-1.5">Gutschrift zur Mietrechnung erstellen</Link>}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
            {canManage && allowed.ok && !openDraft && (
              <form action={createAmendmentAction.bind(null, bookingId)}><input type="hidden" name="nonce" value={randomUUID()} /><button className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">+ Vertrag ändern / Nachtrag erstellen</button></form>
            )}
            {canManage && openDraft && <Link href={`/buchungen/${bookingId}/nachtrag/${openDraft.id}`} className="btn btn-primary !py-3 !px-5 !text-[15px] w-full sm:w-auto justify-center">Nachtrag-Entwurf fortsetzen</Link>}
            {canManage && !allowed.ok && !rentalInvoiceFinal && <span className="text-sm text-ink-3">{allowed.reason}</span>}
            {!canManage && <span className="text-sm text-ink-3">{supportMode ? "Im Supportmodus nur Ansicht." : "Nachträge erstellt die Disposition."}</span>}
          </div>
          <p className="text-xs text-ink-3 max-w-[80ch]">{AMENDMENT_HELP.ORIGINAL_UNCHANGED} {AMENDMENT_HELP.NO_EFFECT_DRAFT}</p>
        </div>
      </Card>
    </div>
  );
}
