// Bearbeitungsentgelt für Behördenanfragen. Grundlage ist allein der beim Vertragsabschluss eingefrorene Geschäftsregel-
// Schnappschuss (authorityHandlingFeeEnabled/-Cents) – nie die aktuellen Einstellungen. Rent-Base legt nach einer
// übermittelten Antwort nur einen Rechnungsentwurf an; Prüfen, Abschließen und Versenden bleibt im Rechnungsmodul.
// Das Bußgeld selbst wird nie weiterberechnet.

import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { readContractRules } from "@/lib/business-rules";
import { createAuthorityFeeInvoiceDraft } from "@/lib/invoices";
import { DomainError } from "@/lib/integrity";
import { fmtCents } from "@/lib/money";

export type FeeState =
  | { status: "NOT_AGREED" | "NO_RENTAL"; message: string }
  | { status: "NOT_YET"; cents: number; message: string }
  | { status: "READY"; cents: number; message: string }
  | { status: "INVOICED"; cents: number; message: string; invoice: { id: string; number: string | null; status: string; bookingId: string } };

export type FeeOutcome = { status: "CREATED" | "EXISTS" | "NOT_AGREED" | "NO_RENTAL" | "NOT_YET" | "FAILED"; message: string; invoiceId?: string };

/** Vereinbartes Entgelt laut Vertragsschnappschuss (null = nicht vereinbart). */
export function agreedFeeCents(conditions: unknown): number | null {
  const rules = readContractRules(conditions);
  const v = rules?.values;
  return v && v.authorityHandlingFeeEnabled && v.authorityHandlingFeeCents > 0 ? v.authorityHandlingFeeCents : null;
}

async function loadBasis(client: typeof db, tenantId: string, caseId: string) {
  const c = await client.authorityCase.findFirst({ where: { id: caseId, tenantId }, select: { id: true, caseNumber: true, bookingId: true, authorityName: true, authorityReference: true, status: true, contract: { select: { status: true, conditions: true } }, responses: { where: { status: "SUBMITTED" }, select: { id: true } }, invoices: { where: { documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, select: { id: true, number: true, status: true, bookingId: true } } } });
  if (!c) throw new DomainError("Behördenvorgang nicht gefunden.");
  return c;
}

export async function authorityFeeState(tenantId: string, caseId: string): Promise<FeeState> {
  const c = await loadBasis(db, tenantId, caseId);
  if (!c.bookingId || c.contract?.status !== "SIGNED") return { status: "NO_RENTAL", message: "Kein Mietvertrag zugeordnet – kein Bearbeitungsentgelt." };
  const cents = agreedFeeCents(c.contract.conditions);
  if (cents == null) return { status: "NOT_AGREED", message: "Im Mietvertrag ist kein Bearbeitungsentgelt für Behördenanfragen vereinbart." };
  if (c.invoices[0]) return { status: "INVOICED", cents, invoice: c.invoices[0], message: `Bearbeitungsentgelt ${fmtCents(cents)} ${c.invoices[0].status === "DRAFT" ? "als Rechnungsentwurf angelegt" : `berechnet mit ${c.invoices[0].number}`}.` };
  if (c.responses.length === 0) return { status: "NOT_YET", cents, message: `Laut Mietvertrag ${fmtCents(cents)} – wird nach der Übermittlung der Antwort als Rechnungsentwurf angelegt.` };
  return { status: "READY", cents, message: `Laut Mietvertrag ${fmtCents(cents)}; noch nicht berechnet.` };
}

/** Legt den Entwurf an, wenn vereinbart und die Antwort übermittelt ist. Idempotent; wirft nie für fachliche Gründe. */
export async function ensureAuthorityFeeInvoice(tenantId: string, caseId: string, actor: Actor): Promise<FeeOutcome> {
  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AuthorityCase" WHERE "id" = ${caseId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Behördenvorgang nicht gefunden.");
      const c = await loadBasis(tx as unknown as typeof db, tenantId, caseId);
      if (!c.bookingId || c.contract?.status !== "SIGNED") return { status: "NO_RENTAL" as const, message: "Kein Mietvertrag zugeordnet – kein Bearbeitungsentgelt." };
      const cents = agreedFeeCents(c.contract.conditions);
      if (cents == null) return { status: "NOT_AGREED" as const, message: "Im Mietvertrag ist kein Bearbeitungsentgelt vereinbart." };
      if (c.invoices[0]) return { status: "EXISTS" as const, message: "Das Bearbeitungsentgelt ist bereits angelegt.", invoiceId: c.invoices[0].id };
      if (c.responses.length === 0) return { status: "NOT_YET" as const, message: "Das Bearbeitungsentgelt wird erst nach der Übermittlung der Antwort berechnet." };
      const invoice = await createAuthorityFeeInvoiceDraft(tx, tenantId, actor, { bookingId: c.bookingId, authorityCaseId: c.id, caseNumber: c.caseNumber, authorityName: c.authorityName, authorityReference: c.authorityReference, amountCents: cents });
      await tx.authorityCaseEvent.create({ data: { tenantId, caseId: c.id, type: "FEE_INVOICE_CREATED", toValue: invoice.id, note: `${fmtCents(cents)} laut Mietvertrag – Rechnungsentwurf zur Prüfung`, userId: actor.id, userName: actor.name } });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_FEE_INVOICE_CREATED", bookingId: c.bookingId, invoiceId: invoice.id, amountCents: cents, details: { caseNumber: c.caseNumber } });
      return { status: "CREATED" as const, message: `Bearbeitungsentgelt ${fmtCents(cents)} als Rechnungsentwurf angelegt – bitte prüfen und abschließen.`, invoiceId: invoice.id };
    });
  } catch (e) {
    if (e instanceof DomainError) return { status: "FAILED", message: e.message };
    if ((e as { code?: string })?.code === "P2002") return { status: "EXISTS", message: "Das Bearbeitungsentgelt ist bereits angelegt." };
    throw e;
  }
}
