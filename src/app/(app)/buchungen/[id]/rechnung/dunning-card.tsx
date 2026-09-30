// Befehl 23: Forderung und Mahnwesen einer abgeschlossenen Rechnung. Stand aus der zentralen Summierung (lib/dunning.ts),
// nächster sinnvoller Schritt, Mahnhistorie. Nichts wird automatisch erstellt oder versendet.
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Card, Chip } from "@/components/ui";
import { db } from "@/lib/db";
import { DUNNING_HELP, type ReceivableStatus } from "@/lib/constants";
import { receivableOf } from "@/lib/dunning";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fmtCents } from "@/lib/money";
import { createDunningAction, markDunningDeliveredAction, previewDunningAction, sendDunningAction } from "./dunning-actions";
import { DunningCreateForm, DunningDeliveredForm, DunningSendForm } from "./dunning-forms";

export const receivableTone = (s: ReceivableStatus): "good" | "bad" | "amber" | "info" | "grey" =>
  s === "SETTLED" ? "good" : s === "FURTHER_ACTION" || s === "OVERDUE" ? "bad" : s === "NOT_DUE" ? "info" : s === "NO_DUE_DATE" ? "grey" : "amber";

const Tile = ({ label, value, tone, sub }: { label: string; value: string; tone?: "bad" | "good"; sub?: string }) => (
  <div className="rounded-md bg-panel-2 p-3 min-w-0"><div className="label-xs">{label}</div><div className={`font-mono tnum text-lg font-semibold ${tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : ""}`}>{value}</div>{sub && <div className="text-[11px] text-ink-3">{sub}</div>}</div>
);

export async function DunningCard({ tenantId, bookingId, role, invoiceId }: { tenantId: string; bookingId: string; role: string; invoiceId: string }) {
  const r = await receivableOf(tenantId, invoiceId);
  if (!r) return null;
  if (r.notices.length === 0 && (r.status === "SETTLED" || r.status === "NOT_DUE") && r.totalOpenCents === 0) return null;
  const canManage = role !== "YARD";
  const docs = r.notices.length ? await db.document.findMany({ where: { tenantId, dunningNoticeId: { in: r.notices.map((n) => n.id) } }, orderBy: { version: "desc" }, select: { id: true, dunningNoticeId: true } }) : [];
  const docOf = (id: string) => docs.find((d) => d.dunningNoticeId === id) ?? null;
  const next = r.next;
  return (
    <Card title="Forderung & Mahnwesen" right={<Chip tone={receivableTone(r.status)}>{r.status === "SETTLED" ? "✓ Forderung erledigt" : r.statusLabel}</Chip>}>
      <div className="p-4 flex flex-col gap-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <Tile label="Fällig am" value={r.dueDate ? fmtDate(r.dueDate) : "–"} sub={r.daysOverdue > 0 ? `${r.daysOverdue} ${r.daysOverdue === 1 ? "Tag" : "Tage"} überfällig` : r.dueDate ? undefined : "kein Zahlungsziel"} />
          <Tile label="Offen (Rechnung)" value={fmtCents(r.principalOpenCents)} tone={r.principalOpenCents > 0 ? "bad" : "good"} />
          <Tile label="Offene Mahngebühren" value={fmtCents(r.feesOpenCents)} tone={r.feesOpenCents > 0 ? "bad" : undefined} />
          <Tile label="Gesamt offen" value={fmtCents(r.totalOpenCents)} tone={r.totalOpenCents > 0 ? "bad" : "good"} />
        </div>
        {r.financials.customerCreditCents > 0 && <p className="text-sm text-ink-2">Aus dieser Rechnung besteht ein Kundenguthaben; es ist keine Forderung und wird unter „Kundenguthaben“ geführt.</p>}

        {r.totalOpenCents > 0 && (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium">Nächster Schritt: {next.label}{next.kind === "WAIT_DUE" || next.kind === "WAIT_DEADLINE" ? ` – bis ${fmtDate(next.until)}` : ""}</div>
            {next.kind === "NO_DUE_DATE" && <p className="text-sm text-ink-2">{DUNNING_HELP.NO_DUE_DATE}</p>}
            {next.kind === "CREATE" && canManage && <DunningCreateForm levelLabel={next.label.replace(/ erstellen$/, "")} preview={previewDunningAction.bind(null, invoiceId, next.level)} action={createDunningAction.bind(null, bookingId, invoiceId, next.level)} nonce={randomUUID()} />}
            {next.kind === "FURTHER_ACTION" && <p className="text-sm text-ink-2">Alle drei Stufen sind versendet und die letzte Frist ist abgelaufen. Rent-Base übergibt nichts an Dritte und berechnet keine Verzugszinsen.</p>}
            {!canManage && (next.kind === "CREATE" || next.kind === "DELIVER") && <p className="text-xs text-ink-3">Mahnschreiben erstellt und versendet die Disposition.</p>}
          </div>
        )}

        {r.notices.length > 0 && (
          <div>
            <div className="label-xs mb-1">Mahnhistorie</div>
            <ul className="divide-y divide-line-soft text-sm">
              {[...r.notices].reverse().map((n) => {
                const doc = docOf(n.id);
                return (
                  <li key={n.id} className="py-3 flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span><span className="font-mono tnum text-xs text-ink-3">{fmtDate(n.issuedAt)}</span> · <span className="font-medium">{n.label}</span> <span className="font-mono tnum text-xs">{n.number}</span></span>
                      <span className="font-mono tnum font-semibold">{fmtCents(n.totalCents)}</span>
                    </div>
                    <div className="text-xs text-ink-3 flex flex-col gap-0.5">
                      <span>offen {fmtCents(n.principalOpenCents)}{n.priorFeesOpenCents > 0 ? ` + frühere Gebühren ${fmtCents(n.priorFeesOpenCents)}` : ""}{n.feeCents > 0 ? ` + Gebühr ${fmtCents(n.feeCents)}` : ""} · Frist bis {fmtDate(n.deadlineAt)} · erstellt von {n.createdByName ?? "–"}</span>
                      {n.sentAt && <span className="text-good">versendet am {fmtDateTime(n.sentAt)} an {n.sentTo}{n.sendCount > 1 ? ` · insgesamt ${n.sendCount}× versendet` : ""}</span>}
                      {n.manualDeliveredAt && <span className="text-good">übermittelt (vermerkt) am {fmtDateTime(n.manualDeliveredAt)} von {n.manualDeliveredByName ?? "–"}{n.manualDeliveredNote ? ` · ${n.manualDeliveredNote}` : ""}</span>}
                      {!n.delivered && <span className="text-amber">noch nicht übermittelt</span>}
                      {n.feeInvoiceId && <span>Gebührenrechnung <Link href={`/buchungen/${bookingId}/rechnung?nr=${n.feeInvoiceId}`} className="underline">{n.feeInvoiceNumber}</Link>{(() => { const c = r.feeClaims.find((x) => x.invoiceId === n.feeInvoiceId); return c ? ` · offen ${fmtCents(c.openCents)}` : ""; })()}</span>}
                    </div>
                    <div className="flex flex-wrap gap-2 items-start">
                      {doc ? <a href={`/api/documents/${doc.id}?download=1`} className="btn !py-2.5">PDF</a> : <span className="text-xs text-ink-3">PDF wird beim Versand erzeugt</span>}
                      {canManage && n.recipientEmail && <DunningSendForm action={sendDunningAction.bind(null, bookingId)} id={n.id} nonce={randomUUID()} label={n.sentAt ? "Erneut senden" : "Per E-Mail senden"} question={`${n.label} an ${n.recipientName} (${n.recipientEmail}) ${n.sentAt ? "erneut " : ""}senden?`} />}
                      {canManage && !n.delivered && <DunningDeliveredForm action={markDunningDeliveredAction.bind(null, bookingId)} id={n.id} />}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <p className="text-xs text-ink-3">{DUNNING_HELP.NO_AUTOMATION} {DUNNING_HELP.NO_INTEREST}</p>
      </div>
    </Card>
  );
}

/** Gebührenrechnung (kind DUNNING_FEE): Bezug zum Mahnschreiben und zur gemahnten Rechnung. */
export async function DunningFeeNote({ tenantId, bookingId, invoiceId }: { tenantId: string; bookingId: string; invoiceId: string }) {
  const n = await db.dunningNotice.findFirst({ where: { tenantId, feeInvoiceId: invoiceId }, select: { number: true, level: true, invoiceId: true, invoice: { select: { number: true } } } });
  if (!n) return null;
  return (
    <p className="rounded-md bg-panel-2 px-3.5 py-2.5 text-sm">Mahngebühr aus {n.level === 2 ? "der 1. Mahnung" : "der 2. Mahnung"} {n.number} zu <Link href={`/buchungen/${bookingId}/rechnung?nr=${n.invoiceId}`} className="underline">Rechnung {n.invoice.number}</Link>. Die gemahnte Rechnung bleibt unverändert; Zahlungen auf diese Gebühr werden hier erfasst.</p>
  );
}
