// Befehl 29: Dokumentierte Kürzungen einer abgeschlossenen Rechnung durch den Rechnungsempfänger (Versicherung).
// Reine Dokumentation: Eine Kürzung ändert weder die Rechnungsfassung noch die Forderung noch den Zahlungsstand
// (computeFinancials bleibt unberührt). Sie macht nachvollziehbar, was der Versicherer aus welchem Grund nicht anerkennt.
// Wer die Forderung tatsächlich mindern will, nutzt die Gutschrift (USt-wirksam) oder stellt den Rest dem Mieter in Rechnung.
// Kürzungen werden nie gelöscht, nur mit Grund storniert (Datenbank-Trigger). Beträge in Cent.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { INVOICE_ADJUSTMENT_REASONS, recipientRoleOf, type InvoiceAdjustmentReason } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { accidentCaseEventForBooking, assertAccidentInvoiceCaseOpen } from "@/lib/accident-replacement-events";
import { invoiceFinancials } from "@/lib/counter-documents";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type AdjustmentRow = Prisma.InvoiceAdjustmentGetPayload<object>;

function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_(?:DOMAIN|IMMUTABLE|TENANT): ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}

const cleanText = (v: string | null | undefined, max: number) => (v?.replace(/\s+/g, " ").trim().slice(0, max) || null);

export type AdjustmentInput = {
  invoiceId: string;
  reasonKind: string;
  amountCents: Cents;
  /** Datum des Kürzungsschreibens / der Entscheidung */
  decidedAt: Date;
  note?: string | null;
  /** Versicherungsschreiben in der Fallakte (AccidentReplacementCaseDocument) */
  documentId?: string | null;
};

/**
 * Kürzung dokumentieren. Nur zu abgeschlossenen Unfallersatz-Rechnungen an die Versicherung (Rechnung, nicht Gutschrift/Storno),
 * Betrag > 0 und – zusammen mit den bereits dokumentierten – höchstens die wirksame Forderung (nach Gutschriften/Storno; die
 * Datenbank prüft zusätzlich den Rechnungsbetrag). Optional verknüpft mit einem (nicht archivierten) Versichererschreiben
 * desselben Falls. Geschlossener Fall: gesperrt. Audit mit Betrag; Verlaufseintrag in der Fallakte.
 */
export async function recordInvoiceAdjustment(tenantId: string, actor: Actor, input: AdjustmentInput): Promise<AdjustmentRow> {
  if (!(input.reasonKind in INVOICE_ADJUSTMENT_REASONS)) throw new DomainError("Bitte den Kürzungsgrund wählen.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DomainError("Der Kürzungsbetrag muss größer als 0,00 € sein.");
  if (!(input.decidedAt instanceof Date) || Number.isNaN(input.decidedAt.getTime())) throw new DomainError("Bitte das Datum der Kürzung angeben.");
  if (input.decidedAt.getTime() > Date.now() + 86_400_000) throw new DomainError("Das Datum der Kürzung darf nicht in der Zukunft liegen.");
  const note = cleanText(input.note, 1000);
  try {
    return await db.$transaction(async (tx) => {
      // Phase F: geschlossener Unfallersatzfall – keine Kürzung (vor der Rechnungssperre)
      await assertAccidentInvoiceCaseOpen(tx, tenantId, input.invoiceId);
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${input.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: input.invoiceId }, include: { currentVersion: { select: { grossTotal: true, customerSnapshot: true } } } });
      if (inv.status !== "FINALIZED" || inv.documentType !== "INVOICE" || !inv.currentVersion) throw new DomainError("Kürzungen werden nur zu abgeschlossenen Rechnungen dokumentiert, nicht zu Entwürfen, Gutschriften oder Stornobelegen.");
      if (inv.kind !== "ACCIDENT_REPLACEMENT" || recipientRoleOf(inv.currentVersion.customerSnapshot as { recipientRole?: string } | null) !== "INSURER") throw new DomainError("Kürzungen werden nur zu Unfallersatz-Rechnungen an die Versicherung dokumentiert.");
      const gross = toCents(inv.currentVersion.grossTotal);
      // Obergrenze: wirksame Forderung nach Gutschriften/Storno (eine stornierte Rechnung kann nicht mehr gekürzt werden)
      const effective = (await invoiceFinancials(tenantId, inv.id, tx)).effectiveCents;
      if (effective <= 0) throw new DomainError(`Die Rechnung ${inv.number ?? ""} ist storniert bzw. vollständig gutgeschrieben; eine Kürzung ist nicht mehr möglich.`.replace("  ", " "));
      if (input.amountCents > gross) throw new DomainError(`Die Kürzung (${fmtCents(input.amountCents)}) übersteigt den Rechnungsbetrag (${fmtCents(gross)}).`);
      const confirmed = await sumConfirmed(tx, tenantId, inv.id);
      // Obergrenze: ursprünglicher Rechnungsbetrag – eine Gutschrift, mit der eine Kürzung erledigt wurde, zählt nicht doppelt
      if (confirmed + input.amountCents > gross) throw new DomainError(`Mit den bereits dokumentierten Kürzungen (${fmtCents(confirmed)}) würde die Summe den Rechnungsbetrag (${fmtCents(gross)}) übersteigen.`);
      if (input.documentId) {
        // nur ein Versichererschreiben desselben Falls (Mandant und Buchung der Rechnung), nicht archiviert
        const doc = await tx.accidentReplacementCaseDocument.findFirst({ where: { id: input.documentId, tenantId, case: { bookingId: inv.bookingId ?? "" } }, select: { id: true, type: true, archivedAt: true } });
        if (!doc) throw new DomainError("Das zugeordnete Dokument wurde in der Fallakte dieser Rechnung nicht gefunden.");
        if (doc.type !== "INSURER_LETTER") throw new DomainError("Verknüpft werden kann nur ein Schreiben der Versicherung.");
        if (doc.archivedAt) throw new DomainError("Das gewählte Schreiben ist archiviert und kann nicht verknüpft werden.");
      }
      const row = await tx.invoiceAdjustment.create({ data: { tenantId, invoiceId: inv.id, type: "INSURER_REDUCTION", reasonKind: input.reasonKind, amountCents: input.amountCents, decidedAt: input.decidedAt, note, documentId: input.documentId ?? null, createdById: actor.id, createdByName: actor.name } });
      await recordAudit(tx, tenantId, actor, { action: "INVOICE_ADJUSTMENT_RECORDED", bookingId: inv.bookingId, invoiceId: inv.id, amountCents: input.amountCents, details: { adjustmentId: row.id, invoiceNumber: inv.number, reasonKind: input.reasonKind, invoiceCents: gross, effectiveCents: effective, totalReductionCents: confirmed + input.amountCents, documentId: input.documentId ?? null } });
      if (inv.bookingId) await accidentCaseEventForBooking(tx, tenantId, inv.bookingId, actor, { type: "ADJUSTMENT_RECORDED", toValue: input.reasonKind, note: `${fmtCents(input.amountCents)} zu Rechnung ${inv.number ?? ""}${note ? ` – ${note}` : ""}`.trim() });
      return row;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** Kürzung stornieren (z. B. versehentlich erfasst oder vom Versicherer zurückgenommen). Pflichtgrund; die Zeile bleibt. */
export async function cancelInvoiceAdjustment(tenantId: string, actor: Actor, adjustmentId: string, reason: string): Promise<AdjustmentRow> {
  const why = cleanText(reason, 500);
  if (!why || why.length < 3) throw new DomainError("Bitte den Grund für das Storno der Kürzung angeben.");
  try {
    return await db.$transaction(async (tx) => {
      // Phase F: geschlossener Unfallersatzfall – kein Storno (vor der Zeilensperre)
      await assertAccidentInvoiceCaseOpen(tx, tenantId, (await tx.invoiceAdjustment.findFirst({ where: { id: adjustmentId, tenantId }, select: { invoiceId: true } }))?.invoiceId);
      await tx.$queryRaw`SELECT "id" FROM "InvoiceAdjustment" WHERE "id" = ${adjustmentId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const a = await tx.invoiceAdjustment.findFirst({ where: { id: adjustmentId, tenantId }, include: { invoice: { select: { number: true, bookingId: true } } } });
      if (!a) throw new DomainError("Kürzung nicht gefunden.");
      if (a.status === "CANCELLED") throw new DomainError("Diese Kürzung ist bereits storniert.");
      const row = await tx.invoiceAdjustment.update({ where: { id: a.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: actor.id, cancelledByName: actor.name, cancellationReason: why } });
      await recordAudit(tx, tenantId, actor, { action: "INVOICE_ADJUSTMENT_CANCELLED", bookingId: a.invoice.bookingId, invoiceId: a.invoiceId, amountCents: a.amountCents, details: { adjustmentId: a.id, invoiceNumber: a.invoice.number, reasonKind: a.reasonKind, reason: why } });
      if (a.invoice.bookingId) await accidentCaseEventForBooking(tx, tenantId, a.invoice.bookingId, actor, { type: "ADJUSTMENT_CANCELLED", fromValue: a.reasonKind, reason: why, note: `${fmtCents(a.amountCents)} zu Rechnung ${a.invoice.number ?? ""}`.trim() });
      return row;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

async function sumConfirmed(client: Client, tenantId: string, invoiceId: string): Promise<Cents> {
  const agg = await client.invoiceAdjustment.aggregate({ where: { tenantId, invoiceId, status: "CONFIRMED" }, _sum: { amountCents: true } });
  return agg._sum.amountCents ?? 0;
}

export type AdjustmentSummary = {
  rows: (AdjustmentRow & { reasonLabel: string })[];
  /** Summe der bestätigten (nicht stornierten) Kürzungen – nur Dokumentation, mindert die Forderung nicht */
  reducedCents: Cents;
};

/** Kürzungen einer Rechnung, neueste zuerst, mit Summe der bestätigten. */
export async function adjustmentSummary(tenantId: string, invoiceId: string, client: Client = db): Promise<AdjustmentSummary> {
  const rows = await client.invoiceAdjustment.findMany({ where: { tenantId, invoiceId }, orderBy: { createdAt: "desc" } });
  return { rows: rows.map((r) => ({ ...r, reasonLabel: INVOICE_ADJUSTMENT_REASONS[r.reasonKind as InvoiceAdjustmentReason] ?? r.reasonKind })), reducedCents: rows.filter((r) => r.status === "CONFIRMED").reduce((s, r) => s + r.amountCents, 0) };
}

/** Bestätigte Kürzungen mehrerer Rechnungen (Listen, Fallakte) in einer Abfrage. */
export async function reductionsFor(tenantId: string, invoiceIds: string[], client: Client = db): Promise<Map<string, Cents>> {
  if (invoiceIds.length === 0) return new Map();
  const groups = await client.invoiceAdjustment.groupBy({ by: ["invoiceId"], where: { tenantId, invoiceId: { in: invoiceIds }, status: "CONFIRMED" }, _sum: { amountCents: true } });
  return new Map(groups.map((g) => [g.invoiceId, g._sum.amountCents ?? 0]));
}
