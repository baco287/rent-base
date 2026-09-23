// Gutschriften, Stornobelege und Kundenguthaben (Phase 17).
//
// Drei verschiedene Dinge:
//   Berichtigung  = neue Fassung derselben Rechnung (InvoiceVersion, unverändert aus Phase 10) – nur solange kein Gegenbeleg existiert.
//   Gutschrift    = eigener Beleg (Invoice mit documentType CREDIT_NOTE), eigene Nummer aus dem Kreis GS, teilweise oder vollständig,
//                   positive Beträge, Wirkung CREDIT: die Summierung zieht ihn von der Rechnung ab (1.000 − 200 = 800 offen).
//   Stornobeleg   = eigener Beleg (CANCELLATION), eigene Nummer aus dem Kreis ST, neutralisiert genau den verbleibenden Betrag.
// Das Original wird nie verändert: keine negativen Positionen, keine Nummernänderung, kein Ersatz des PDFs, keine Fassung mehr,
// sobald ein Gegenbeleg abgeschlossen ist. Der Stand der Rechnung (teilweise gutgeschrieben, gutgeschrieben, storniert) wird aus
// der Belegkette abgeleitet und nie gespeichert. Zahlungen bleiben unberührt; Rent-Base erstattet, verrechnet und zahlt nichts aus –
// ein Kundenguthaben wird nur ausgewiesen (Auszahlung: Befehl 18).
//
// Sicherheit gegen Überschreitung: Rechnung und Gegenbeleg werden beim Abschluss gesperrt (FOR UPDATE), der Rest wird unter der
// Sperre neu gerechnet, zusätzlich prüft der Datenbank-Trigger rb_check_counter_document dieselben Regeln.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DAMAGE_TAX_TREATMENTS, INVOICE_UNITS, type InvoiceChainStatus } from "@/lib/constants";
import { DomainError, contentHash } from "@/lib/integrity";
import { companySnapshotOf, invoiceSettingsMissing, type CompanySnapshot, type InvoiceCustomerSnapshot, type InvoiceRow, type VersionWithItems } from "@/lib/invoices";
import { centsToDecimalString, fmtCents, fmtRate, lineAmounts, summarize, toBasisPoints, toCents, toHundredths, type Cents } from "@/lib/money";
import { isUniqueViolation, nextDocumentNumber, withNumberRetry } from "@/lib/numbering";
import { domainFromDb } from "@/lib/db-errors";
import type { InvoiceDocumentType } from "@/lib/number-ranges";
import { APP_TIME_ZONE } from "@/lib/time";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;
const TX = { timeout: 20_000, maxWait: 10_000 };
const withItems = { items: { orderBy: { sortOrder: "asc" as const } } };
const dateFmt = (d: Date | null) => (d ? d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }) : null);

export type CounterDocumentType = Exclude<InvoiceDocumentType, "INVOICE">;
export const COUNTER_WORD: Record<CounterDocumentType, string> = { CREDIT_NOTE: "Gutschrift", CANCELLATION: "Stornobeleg" };

/** Unveränderliche Kopie der Originaldaten, die der Gegenbeleg bei der Anlage festhält. */
export type OriginalSnapshot = {
  invoiceId: string;
  number: string;
  versionId: string;
  versionNo: number;
  issueDate: string | null;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  customerName: string;
  grossTotal: string;
  kind: string;
  taxTreatment: string | null;
};

const customerNameOf = (c: InvoiceCustomerSnapshot) => {
  const person = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  return c.type === "COMPANY" && c.companyName ? (person ? `${c.companyName}, ${person}` : c.companyName) : person;
};

// ---------------------------------------------------------------------------
// Restbeträge: was von einer Rechnung noch nicht gutgeschrieben ist (gesamt, je Position, je Steuersatz)
// ---------------------------------------------------------------------------

export type Triple = { net: Cents; tax: Cents; gross: Cents };
const zero = (): Triple => ({ net: 0, tax: 0, gross: 0 });
const add = (a: Triple, b: Triple): Triple => ({ net: a.net + b.net, tax: a.tax + b.tax, gross: a.gross + b.gross });
const sub = (a: Triple, b: Triple): Triple => ({ net: a.net - b.net, tax: a.tax - b.tax, gross: a.gross - b.gross });
const tripleOf = (i: { netAmount: unknown; taxAmount: unknown; grossAmount: unknown }): Triple => ({ net: toCents(i.netAmount), tax: toCents(i.taxAmount), gross: toCents(i.grossAmount) });

export type ItemResidual = { itemId: string; sortOrder: number; description: string; quantity: string; unit: string; unitPrice: Cents; taxRateBp: number; original: Triple; credited: Triple; remaining: Triple };
export type Residuals = {
  /** Bruttobetrag der aktuellen Originalfassung */
  invoice: Triple;
  /** Summe abgeschlossener Gegenbelege (Gutschriften und Storno) */
  credited: Triple;
  remaining: Triple;
  items: ItemResidual[];
  byRate: Map<number, { original: Triple; credited: Triple; remaining: Triple }>;
  /** abgeschlossene Gegenbelege, die in die Summen eingehen */
  counted: { id: string; number: string | null; documentType: string; gross: Cents }[];
  hasCancellation: boolean;
};

/** Rest der aktuellen Fassung nach allen abgeschlossenen Gegenbelegen. exceptId: ein Beleg, der nicht mitgezählt wird (der eigene Entwurf). */
export async function residualsOf(client: Client, tenantId: string, original: { id: string; currentVersionId: string | null }, exceptId?: string): Promise<Residuals> {
  if (!original.currentVersionId) throw new DomainError("Die Rechnung hat keine aktuelle Fassung.");
  const version = await client.invoiceVersion.findFirstOrThrow({ where: { id: original.currentVersionId, tenantId }, include: withItems });
  const counters = await client.invoice.findMany({
    where: { tenantId, originalInvoiceId: original.id, status: "FINALIZED", ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, number: true, documentType: true, currentVersion: { select: { netTotal: true, taxTotal: true, grossTotal: true, items: { select: { sourceInvoiceVersionItemId: true, netAmount: true, taxAmount: true, grossAmount: true, taxRate: true } } } } },
  });
  const perItem = new Map<string, Triple>();
  const perRate = new Map<number, Triple>();
  let credited = zero();
  for (const c of counters) {
    const cv = c.currentVersion;
    if (!cv) continue;
    credited = add(credited, { net: toCents(cv.netTotal), tax: toCents(cv.taxTotal), gross: toCents(cv.grossTotal) });
    for (const it of cv.items) {
      const t = tripleOf(it);
      if (it.sourceInvoiceVersionItemId) perItem.set(it.sourceInvoiceVersionItemId, add(perItem.get(it.sourceInvoiceVersionItemId) ?? zero(), t));
      const bp = toBasisPoints(it.taxRate);
      perRate.set(bp, add(perRate.get(bp) ?? zero(), t));
    }
  }
  const invoice = { net: toCents(version.netTotal), tax: toCents(version.taxTotal), gross: toCents(version.grossTotal) };
  const items: ItemResidual[] = version.items.map((i) => {
    const original = tripleOf(i);
    const cr = perItem.get(i.id) ?? zero();
    return { itemId: i.id, sortOrder: i.sortOrder, description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: toCents(i.unitPrice), taxRateBp: toBasisPoints(i.taxRate), original, credited: cr, remaining: sub(original, cr) };
  });
  const byRate = new Map<number, { original: Triple; credited: Triple; remaining: Triple }>();
  for (const i of version.items) {
    const bp = toBasisPoints(i.taxRate);
    const e = byRate.get(bp) ?? { original: zero(), credited: zero(), remaining: zero() };
    e.original = add(e.original, tripleOf(i));
    byRate.set(bp, e);
  }
  for (const [bp, e] of byRate) { e.credited = perRate.get(bp) ?? zero(); e.remaining = sub(e.original, e.credited); }
  return { invoice, credited, remaining: sub(invoice, credited), items, byRate, counted: counters.map((c) => ({ id: c.id, number: c.number, documentType: c.documentType, gross: toCents(c.currentVersion?.grossTotal ?? 0) })), hasCancellation: counters.some((c) => c.documentType === "CANCELLATION") };
}

// ---------------------------------------------------------------------------
// Positionen eines Gegenbelegs
// ---------------------------------------------------------------------------

/** Eingabe einer Gutschriftposition: Bezug auf eine Originalposition (teilweise nach Menge oder Betrag, oder der ganze Rest) oder manuell. */
export type CreditItemInput =
  | { sourceItemId: string; mode: "REMAINING" }
  | { sourceItemId: string; mode: "QUANTITY"; quantity: string | number }
  | { sourceItemId: string; mode: "AMOUNT"; grossAmount: string | number }
  | { manual: true; description: string; quantity: string | number; unit: string; unitPrice: string | number; taxRate: string | number; reason: string };

type Line = { description: string; quantityH: number; unit: string; unitPriceC: Cents; taxRateBp: number; amounts: Triple; sourceItemId: string | null; reference: string | null; source: "RENTAL" | "EXTRA_CHARGE" | "MANUAL" };

const money = (c: Cents) => fmtCents(c);

/**
 * Teilbetrag einer Originalposition: Netto und Steuer anteilig aus dem Bruttoanteil, Rundung wie die Engine (halb auf), anschließend
 * so begrenzt, dass der Rest der Position nie negativ wird und brutto = netto + steuer bleibt.
 */
function partialOf(r: ItemResidual, gross: Cents, computed?: Triple): Triple {
  let net = computed ? computed.net : r.original.gross === 0 ? 0 : Math.round((gross * r.original.net) / r.original.gross);
  let tax = gross - net;
  if (net > r.remaining.net) { net = r.remaining.net; tax = gross - net; }
  if (tax > r.remaining.tax) { tax = r.remaining.tax; net = gross - tax; }
  if (net < 0 || tax < 0) throw new DomainError(`Position „${r.description}“: Der Teilbetrag lässt sich nicht konsistent auf Netto und Steuer aufteilen.`);
  return { net, tax, gross };
}

/** Rechnet die Positionen eines Gutschrift-Entwurfs gegen die Restbeträge der Originalposition (nie darüber hinaus). */
export function creditLines(mode: "NET" | "GROSS", residuals: Residuals, inputs: CreditItemInput[], opts: { nonTaxable: boolean; allowedRates: Set<number> }): Line[] {
  if (inputs.length === 0) throw new DomainError("Eine Gutschrift braucht mindestens eine Position.");
  const used = new Set<string>();
  const lines: Line[] = [];
  for (const it of inputs) {
    if ("manual" in it) {
      const description = it.description.trim();
      if (description.length < 2) throw new DomainError("Bitte jede manuelle Gutschriftposition beschreiben.");
      const reason = it.reason.trim();
      if (reason.length < 3) throw new DomainError(`Position „${description}“: Bitte den Grund der manuellen Gutschrift angeben.`);
      if (!(INVOICE_UNITS as readonly string[]).includes(it.unit)) throw new DomainError(`Unbekannte Einheit „${it.unit}“.`);
      let quantityH: number, unitPriceC: Cents, taxRateBp: number;
      try { quantityH = toHundredths(it.quantity); unitPriceC = toCents(it.unitPrice); taxRateBp = opts.nonTaxable ? 0 : toBasisPoints(it.taxRate); } catch (e) { throw new DomainError(`Position „${description}“: ${(e as Error).message}`); }
      if (!opts.nonTaxable && !opts.allowedRates.has(taxRateBp)) throw new DomainError(`Position „${description}“: Der Steuersatz ${fmtRate(taxRateBp)} kommt in der Rechnung nicht vor. Eine Gutschrift spiegelt die Steuersätze der Rechnung.`);
      let amounts: Triple;
      try { amounts = lineAmounts(mode, quantityH, unitPriceC, taxRateBp); } catch (e) { throw new DomainError(`Position „${description}“: ${(e as Error).message}`); }
      if (amounts.gross <= 0) throw new DomainError(`Position „${description}“: Der Betrag muss größer als 0,00 € sein.`);
      lines.push({ description, quantityH, unit: it.unit, unitPriceC, taxRateBp, amounts, sourceItemId: null, reference: reason, source: "MANUAL" });
      continue;
    }
    const r = residuals.items.find((x) => x.itemId === it.sourceItemId);
    if (!r) throw new DomainError("Eine gewählte Position gehört nicht zur Bezugsfassung der Rechnung.");
    if (used.has(r.itemId)) throw new DomainError(`Position „${r.description}“ ist doppelt aufgeführt.`);
    used.add(r.itemId);
    if (r.remaining.gross <= 0) throw new DomainError(`Position „${r.description}“ ist bereits vollständig gutgeschrieben.`);
    const base = { description: r.description, taxRateBp: r.taxRateBp, sourceItemId: r.itemId, reference: null, source: "MANUAL" as const };
    if (it.mode === "REMAINING") {
      const partial = r.credited.gross > 0;
      lines.push({ ...base, description: partial ? `${r.description} (Restbetrag)` : r.description, quantityH: partial ? 100 : toHundredths(r.quantity), unit: partial ? "pauschal" : r.unit, unitPriceC: partial ? (mode === "GROSS" ? r.remaining.gross : r.remaining.net) : r.unitPrice, amounts: r.remaining });
      continue;
    }
    if (it.mode === "QUANTITY") {
      let quantityH: number;
      try { quantityH = toHundredths(it.quantity); } catch (e) { throw new DomainError(`Position „${r.description}“: ${(e as Error).message}`); }
      const computed = lineAmounts(mode, quantityH, r.unitPrice, r.taxRateBp);
      if (computed.gross > r.remaining.gross) throw new DomainError(`Position „${r.description}“: ${quantityH / 100} ${r.unit} ergeben ${money(computed.gross)}, gutschreibbar sind noch ${money(r.remaining.gross)}.`);
      if (computed.gross === r.remaining.gross) { lines.push({ ...base, quantityH, unit: r.unit, unitPriceC: r.unitPrice, amounts: r.remaining }); continue; }
      lines.push({ ...base, quantityH, unit: r.unit, unitPriceC: r.unitPrice, amounts: partialOf(r, computed.gross, computed) });
      continue;
    }
    let gross: Cents;
    try { gross = toCents(it.grossAmount); } catch (e) { throw new DomainError(`Position „${r.description}“: ${(e as Error).message}`); }
    if (gross <= 0) throw new DomainError(`Position „${r.description}“: Der Gutschriftbetrag muss größer als 0,00 € sein.`);
    if (gross > r.remaining.gross) throw new DomainError(`Position „${r.description}“: ${money(gross)} übersteigen den gutschreibbaren Rest von ${money(r.remaining.gross)}.`);
    const amounts = gross === r.remaining.gross ? r.remaining : partialOf(r, gross);
    lines.push({ ...base, description: gross === r.remaining.gross && r.credited.gross > 0 ? `${r.description} (Restbetrag)` : gross === r.remaining.gross ? r.description : `${r.description} (Teilbetrag)`, quantityH: 100, unit: "pauschal", unitPriceC: mode === "GROSS" ? amounts.gross : amounts.net, amounts });
  }
  return lines;
}

/** Storno: ohne frühere Gegenbelege spiegelt der Beleg die Originalpositionen, sonst den Rest je Steuersatz – in Summe exakt der Rest. */
export function cancellationLines(mode: "NET" | "GROSS", residuals: Residuals, originalNumber: string): Line[] {
  if (residuals.counted.length === 0) {
    return residuals.items.map((r): Line => ({ description: r.description, quantityH: toHundredths(r.quantity), unit: r.unit, unitPriceC: r.unitPrice, taxRateBp: r.taxRateBp, amounts: r.original, sourceItemId: r.itemId, reference: null, source: "MANUAL" }));
  }
  const lines: Line[] = [];
  for (const [bp, e] of [...residuals.byRate.entries()].sort((a, b) => b[0] - a[0])) {
    if (e.remaining.gross <= 0) continue;
    lines.push({ description: `Storno Rechnung ${originalNumber}, verbleibender Betrag${residuals.byRate.size > 1 ? ` (Positionen mit ${fmtRate(bp)})` : ""}`, quantityH: 100, unit: "pauschal", unitPriceC: mode === "GROSS" ? e.remaining.gross : e.remaining.net, taxRateBp: bp, amounts: e.remaining, sourceItemId: null, reference: null, source: "MANUAL" });
  }
  return lines;
}

function itemRows(tenantId: string, versionId: string, lines: Line[]) {
  return lines.map((l, i) => ({
    tenantId, versionId, sortOrder: i, description: l.description, quantity: (l.quantityH / 100).toFixed(2), unit: l.unit, unitPrice: centsToDecimalString(l.unitPriceC),
    netAmount: centsToDecimalString(l.amounts.net), taxRate: (l.taxRateBp / 100).toFixed(2), taxAmount: centsToDecimalString(l.amounts.tax), grossAmount: centsToDecimalString(l.amounts.gross),
    source: l.source, extraChargeId: null, reference: l.reference, sourceInvoiceVersionItemId: l.sourceItemId,
  }));
}

const totalsOfLines = (lines: Line[]) => summarize(lines.map((l) => ({ taxRateBp: l.taxRateBp, amounts: l.amounts }))).total;

// ---------------------------------------------------------------------------
// Entwurf anlegen
// ---------------------------------------------------------------------------

async function lockOriginal(tx: Tx, tenantId: string, invoiceId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
  const original = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (original.documentType !== "INVOICE") throw new DomainError("Gutschriften und Stornobelege beziehen sich immer auf eine Rechnung, nie auf eine Gutschrift oder einen Stornobeleg.");
  if (original.status !== "FINALIZED" || !original.number || !original.currentVersionId) throw new DomainError("Gutschriften und Stornobelege gibt es nur zu abgeschlossenen Rechnungen.");
  const current = await tx.invoiceVersion.findFirstOrThrow({ where: { id: original.currentVersionId, tenantId }, include: withItems });
  const openRevision = await tx.invoiceVersion.findFirst({ where: { tenantId, invoiceId, status: "DRAFT" }, select: { versionNo: true } });
  if (openRevision) throw new DomainError(`Zur Rechnung ${original.number} ist noch ein Entwurf der Fassung ${openRevision.versionNo} offen. Bitte zuerst abschließen oder verwerfen.`);
  return { original, current };
}

async function createCounterDraft(tenantId: string, invoiceId: string, actor: Actor, type: CounterDocumentType, inputs: CreditItemInput[] | null): Promise<InvoiceRow> {
  try {
    return await db.$transaction(async (tx) => {
      const { original, current } = await lockOriginal(tx, tenantId, invoiceId);
      const existing = await tx.invoice.findFirst({ where: { tenantId, originalInvoiceId: original.id, status: "DRAFT" } });
      if (existing) throw new DomainError(`Zur Rechnung ${original.number} ist bereits ein Entwurf (${COUNTER_WORD[existing.documentType as CounterDocumentType]}) offen. Bitte zuerst abschließen oder verwerfen.`);
      const residuals = await residualsOf(tx, tenantId, original);
      if (residuals.hasCancellation) throw new DomainError(`Die Rechnung ${original.number} ist bereits storniert; weitere Gutschriften oder Stornobelege sind nicht möglich.`);
      if (residuals.remaining.gross <= 0) throw new DomainError(`Die Rechnung ${original.number} ist bereits vollständig gutgeschrieben; weitere Gutschriften oder Stornobelege sind nicht möglich.`);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const missing = invoiceSettingsMissing(tenant);
      if (missing.length > 0) throw new DomainError(`Bevor Belege erstellt werden können, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
      const mode = current.pricesIncludeTax ? "GROSS" : "NET";
      const nonTaxable = current.taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION";
      const allowedRates = new Set(residuals.items.map((i) => i.taxRateBp));
      const lines = type === "CANCELLATION" ? cancellationLines(mode, residuals, original.number!) : creditLines(mode, residuals, inputs ?? residuals.items.filter((i) => i.remaining.gross > 0).map((i): CreditItemInput => ({ sourceItemId: i.itemId, mode: "REMAINING" })), { nonTaxable, allowedRates });
      const totals = totalsOfLines(lines);
      if (totals.gross > residuals.remaining.gross) throw new DomainError(`Der Beleg (${money(totals.gross)}) übersteigt den noch nicht gutgeschriebenen Betrag der Rechnung ${original.number} (${money(residuals.remaining.gross)}).`);
      const c = current.customerSnapshot as InvoiceCustomerSnapshot;
      const snapshot: OriginalSnapshot = { invoiceId: original.id, number: original.number!, versionId: current.id, versionNo: current.versionNo, issueDate: current.issueDate?.toISOString() ?? null, servicePeriodStart: current.servicePeriodStart.toISOString(), servicePeriodEnd: current.servicePeriodEnd.toISOString(), customerName: customerNameOf(c), grossTotal: centsToDecimalString(residuals.invoice.gross), kind: original.kind, taxTreatment: current.taxTreatment };
      const now = new Date();
      const word = COUNTER_WORD[type];
      const invoice = await tx.invoice.create({
        data: {
          tenantId, bookingId: original.bookingId, customerId: original.customerId, contractId: original.contractId, returnHandoverId: null,
          kind: original.kind, damageCaseId: original.damageCaseId, damageId: original.damageId, taxTreatment: original.taxTreatment,
          documentType: type, originalInvoiceId: original.id, originalVersionId: current.id, originalSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          sourceHash: current.contentHash, createdById: actor.id,
          changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `${word} zur Rechnung ${original.number} (Fassung ${current.versionNo}) als Entwurf angelegt: ${lines.length} Positionen, ${money(totals.gross)}` }],
        },
      });
      const version = await tx.invoiceVersion.create({
        data: {
          tenantId, invoiceId: invoice.id, versionNo: 1, kind: "ORIGINAL",
          servicePeriodStart: current.servicePeriodStart, servicePeriodEnd: current.servicePeriodEnd, currency: current.currency, pricesIncludeTax: current.pricesIncludeTax,
          customerSnapshot: current.customerSnapshot as Prisma.InputJsonValue, companySnapshot: current.companySnapshot as Prisma.InputJsonValue,
          netTotal: centsToDecimalString(totals.net), taxTotal: centsToDecimalString(totals.tax), grossTotal: centsToDecimalString(totals.gross),
          paymentTermDays: null, taxNote: current.taxNote, taxTreatment: current.taxTreatment, createdById: actor.id, createdByName: actor.name,
        },
      });
      await tx.invoiceVersionItem.createMany({ data: itemRows(tenantId, version.id, lines) });
      await recordAudit(tx, tenantId, actor, { action: type === "CANCELLATION" ? "CANCELLATION_DRAFT_CREATED" : "CREDIT_NOTE_DRAFT_CREATED", bookingId: original.bookingId, invoiceId: invoice.id, amountCents: totals.gross, details: { originalInvoiceId: original.id, originalNumber: original.number, originalVersion: current.versionNo, remainingBefore: residuals.remaining.gross, items: lines.length } });
      return invoice;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** „Gutschrift erstellen“: Entwurf mit allen noch offenen Positionen als Vorschlag (Restbetrag), Beträge im Entwurf anpassbar. */
export function createCreditNoteDraft(tenantId: string, invoiceId: string, actor: Actor, items?: CreditItemInput[]) {
  return createCounterDraft(tenantId, invoiceId, actor, "CREDIT_NOTE", items ?? null);
}

/** „Rechnung stornieren“: Entwurf des Stornobelegs über genau den verbleibenden Betrag. */
export function createCancellationDraft(tenantId: string, invoiceId: string, actor: Actor) {
  return createCounterDraft(tenantId, invoiceId, actor, "CANCELLATION", null);
}

// ---------------------------------------------------------------------------
// Entwurf bearbeiten (nur Gutschrift: Positionen; beide: Grund und Text)
// ---------------------------------------------------------------------------

async function lockCounterDraft(tx: Tx, tenantId: string, counterId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${counterId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Beleg nicht gefunden.");
  const counter = await tx.invoice.findUniqueOrThrow({ where: { id: counterId } });
  if (counter.documentType === "INVOICE" || !counter.originalInvoiceId) throw new DomainError("Dieser Beleg ist keine Gutschrift und kein Stornobeleg.");
  if (counter.status !== "DRAFT") throw new DomainError(`${COUNTER_WORD[counter.documentType as CounterDocumentType]} ${counter.number ?? ""} ist abgeschlossen und kann nicht mehr geändert werden.`.replace("  ", " "));
  const draft = await tx.invoiceVersion.findFirstOrThrow({ where: { tenantId, invoiceId: counterId, status: "DRAFT" }, include: withItems });
  return { counter, draft, type: counter.documentType as CounterDocumentType };
}

export type CounterDraftInput = { items?: CreditItemInput[]; reason?: string | null; customerNote?: string | null; notes?: string | null };

export async function updateCounterDocumentDraft(tenantId: string, counterId: string, actor: Actor, input: CounterDraftInput): Promise<VersionWithItems> {
  return db.$transaction(async (tx) => {
    const { counter, draft, type } = await lockCounterDraft(tx, tenantId, counterId);
    // Reihenfolge der Sperren immer Gegenbeleg → Original (wie beim Abschluss), damit sich parallele Vorgänge nicht verklemmen
    const { original, current } = await lockOriginal(tx, tenantId, counter.originalInvoiceId!);
    if (current.id !== counter.originalVersionId) throw new DomainError(`Die Rechnung ${original.number} hat inzwischen eine neuere Fassung. Bitte diesen Entwurf verwerfen und neu erstellen.`);
    const changes: string[] = [];
    let totals = { net: toCents(draft.netTotal), tax: toCents(draft.taxTotal), gross: toCents(draft.grossTotal) };
    if (input.items) {
      if (type === "CANCELLATION") throw new DomainError("Ein Stornobeleg neutralisiert immer den vollständigen Rest; Positionen werden nicht bearbeitet. Für Teilbeträge eine Gutschrift verwenden.");
      const residuals = await residualsOf(tx, tenantId, original, counter.id);
      const mode = current.pricesIncludeTax ? "GROSS" : "NET";
      const lines = creditLines(mode, residuals, input.items, { nonTaxable: current.taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION", allowedRates: new Set(residuals.items.map((i) => i.taxRateBp)) });
      totals = totalsOfLines(lines);
      if (totals.gross > residuals.remaining.gross) throw new DomainError(`Die Gutschrift (${money(totals.gross)}) übersteigt den noch nicht gutgeschriebenen Betrag der Rechnung ${original.number} (${money(residuals.remaining.gross)}).`);
      await tx.invoiceVersionItem.deleteMany({ where: { tenantId, versionId: draft.id } });
      await tx.invoiceVersionItem.createMany({ data: itemRows(tenantId, draft.id, lines) });
      changes.push(`Positionen: ${lines.length}, Betrag ${money(totals.gross)}`);
    }
    const reason = input.reason === undefined ? draft.reason : input.reason?.trim() || null;
    const customerNote = input.customerNote === undefined ? draft.customerNote : input.customerNote?.trim() || null;
    if ((reason ?? "") !== (draft.reason ?? "")) changes.push("Grund erfasst");
    if ((customerNote ?? "") !== (draft.customerNote ?? "")) changes.push("Belegtext geändert");
    const notes = input.notes === undefined ? undefined : input.notes?.trim() || null;
    const log = Array.isArray(counter.changeLog) ? (counter.changeLog as Prisma.JsonArray) : [];
    await tx.invoice.update({ where: { id: counter.id }, data: { ...(notes === undefined ? {} : { notes }), changeLog: changes.length ? [...log, { at: new Date().toISOString(), by: actor.name, versionNo: 1, summary: changes.join("; ") }] : log } });
    return tx.invoiceVersion.update({ where: { id: draft.id }, data: { reason, customerNote, netTotal: centsToDecimalString(totals.net), taxTotal: centsToDecimalString(totals.tax), grossTotal: centsToDecimalString(totals.gross) }, include: withItems });
  }, TX);
}

/** Entwurf verwerfen: der ganze Gegenbeleg verschwindet (er hatte nie eine Nummer). Abgeschlossene Belege bleiben immer. */
export async function discardCounterDocumentDraft(tenantId: string, counterId: string, actor: Actor) {
  return db.$transaction(async (tx) => {
    const { counter, draft, type } = await lockCounterDraft(tx, tenantId, counterId);
    await tx.invoiceVersionItem.deleteMany({ where: { tenantId, versionId: draft.id } });
    await tx.invoiceVersion.delete({ where: { id: draft.id } });
    await tx.invoice.delete({ where: { id: counter.id } });
    await recordAudit(tx, tenantId, actor, { action: type === "CANCELLATION" ? "CANCELLATION_DRAFT_DISCARDED" : "CREDIT_NOTE_DRAFT_DISCARDED", bookingId: counter.bookingId, invoiceId: counter.originalInvoiceId, amountCents: toCents(draft.grossTotal), details: { originalInvoiceId: counter.originalInvoiceId } });
    return { originalInvoiceId: counter.originalInvoiceId!, type };
  }, TX);
}

// ---------------------------------------------------------------------------
// Prüfung und Abschluss
// ---------------------------------------------------------------------------

export type CounterIssue = { code: string; severity: "error" | "warning"; message: string };

function checkLines(draft: VersionWithItems, residuals: Residuals, type: CounterDocumentType, originalNumber: string): CounterIssue[] {
  const issues: CounterIssue[] = [];
  const err = (code: string, message: string) => issues.push({ code, severity: "error", message });
  if (draft.items.length === 0) err("NO_ITEMS", "Der Beleg hat keine Position.");
  const totals = summarize(draft.items.map((i) => ({ taxRateBp: toBasisPoints(i.taxRate), amounts: tripleOf(i) }))).total;
  if (totals.net !== toCents(draft.netTotal) || totals.tax !== toCents(draft.taxTotal) || totals.gross !== toCents(draft.grossTotal)) err("TOTALS", "Die Gesamtbeträge passen nicht zu den Positionen.");
  if (totals.gross <= 0) err("ZERO", "Ein Beleg über 0,00 € wird nicht abgeschlossen.");
  if (totals.gross > residuals.remaining.gross) err("OVER_CREDIT", `Der Beleg (${money(totals.gross)}) übersteigt den noch nicht gutgeschriebenen Betrag der Rechnung ${originalNumber} (${money(residuals.remaining.gross)}).`);
  if (type === "CANCELLATION" && totals.gross !== residuals.remaining.gross) err("CANCELLATION_REMAINING", `Der Stornobeleg (${money(totals.gross)}) entspricht nicht mehr dem verbleibenden Betrag der Rechnung ${originalNumber} (${money(residuals.remaining.gross)}); inzwischen wurde eine Gutschrift abgeschlossen. Bitte den Entwurf verwerfen und neu erstellen.`);
  const perItem = new Map<string, Triple>();
  const perRate = new Map<number, Triple>();
  for (const i of draft.items) {
    const t = tripleOf(i);
    if (t.net < 0 || t.tax < 0 || t.gross < 0 || t.gross !== t.net + t.tax) err("ITEM_AMOUNTS", `Position „${i.description}“: Beträge sind nicht konsistent.`);
    if (i.sourceInvoiceVersionItemId) perItem.set(i.sourceInvoiceVersionItemId, add(perItem.get(i.sourceInvoiceVersionItemId) ?? zero(), t));
    const bp = toBasisPoints(i.taxRate);
    perRate.set(bp, add(perRate.get(bp) ?? zero(), t));
    if (!residuals.byRate.has(bp) && !(residuals.byRate.size === 0)) err("RATE", `Position „${i.description}“: Der Steuersatz ${fmtRate(bp)} kommt in der Rechnung nicht vor.`);
  }
  for (const [id, t] of perItem) {
    const r = residuals.items.find((x) => x.itemId === id);
    if (!r) err("SOURCE", "Eine Position bezieht sich auf eine Position, die nicht zur Bezugsfassung gehört.");
    else if (t.gross > r.remaining.gross || t.net > r.remaining.net || t.tax > r.remaining.tax) err("OVER_ITEM", `Position „${r.description}“: gutschreibbar sind noch ${money(r.remaining.gross)}, im Beleg stehen ${money(t.gross)}.`);
  }
  for (const [bp, t] of perRate) {
    const e = residuals.byRate.get(bp);
    if (e && (t.gross > e.remaining.gross || t.net > e.remaining.net || t.tax > e.remaining.tax)) err("OVER_RATE", `Zum Steuersatz ${fmtRate(bp)} sind noch ${money(e.remaining.gross)} gutschreibbar, im Beleg stehen ${money(t.gross)}.`);
  }
  if (draft.taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION" && draft.items.some((i) => toBasisPoints(i.taxRate) !== 0)) err("TAX_TREATMENT", "Echter Schadensersatz ist nicht steuerbar; die Positionen dürfen keinen Steuersatz tragen.");
  if (draft.taxTreatment !== "NON_TAXABLE_DAMAGE_COMPENSATION" && draft.items.some((i) => toBasisPoints(i.taxRate) === 0) && !draft.taxNote?.trim()) err("TAX_NOTE", "Es gibt Positionen mit 0 % Steuer. Bitte den Steuerhinweis angeben.");
  const c = draft.customerSnapshot as InvoiceCustomerSnapshot;
  if (!customerNameOf(c)) err("CUSTOMER_NAME", "Der Belegempfänger hat keinen Namen.");
  return issues;
}

/** Versiegelter Inhalt eines Gegenbelegs (Grundlage der Prüfsumme): wie eine Rechnungsfassung, ergänzt um Belegart und Originalbezug. */
export function sealedCounterContent(inv: { number: string | null; documentType: string; originalInvoiceId: string | null; originalVersionId: string | null; originalSnapshot: unknown; bookingId: string; contractId: string | null }, v: VersionWithItems) {
  return {
    documentType: inv.documentType,
    number: inv.number,
    original: { invoiceId: inv.originalInvoiceId, versionId: inv.originalVersionId, snapshot: inv.originalSnapshot },
    reason: v.reason,
    bookingId: inv.bookingId,
    contractId: inv.contractId,
    issueDate: v.issueDate,
    servicePeriodStart: v.servicePeriodStart,
    servicePeriodEnd: v.servicePeriodEnd,
    currency: v.currency,
    pricesIncludeTax: v.pricesIncludeTax,
    customer: v.customerSnapshot,
    company: v.companySnapshot,
    netTotal: String(v.netTotal),
    taxTotal: String(v.taxTotal),
    grossTotal: String(v.grossTotal),
    customerNote: v.customerNote,
    taxNote: v.taxNote,
    ...(v.taxTreatment ? { taxTreatment: v.taxTreatment } : {}),
    items: [...v.items].sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({ description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: String(i.unitPrice), netAmount: String(i.netAmount), taxRate: String(i.taxRate), taxAmount: String(i.taxAmount), grossAmount: String(i.grossAmount), source: i.source, sourceInvoiceVersionItemId: i.sourceInvoiceVersionItemId, reference: i.reference })),
  };
}

export type CounterFinalizeOptions = { reason?: string | null; confirmed: boolean };

/**
 * Abschluss: Sperren auf Gegenbeleg und Original, Bezugsfassung muss die aktuelle sein, Rest unter der Sperre neu gerechnet
 * (nie mehr als offen; Storno exakt der Rest; kein Beleg nach Storno oder vollständiger Gutschrift), Grund Pflicht, ausdrückliche
 * Bestätigung Pflicht. Dann: Nummer aus dem eigenen Kreis, Firmendaten eingefroren, Prüfsumme, Audit. Keine Zahlung, keine
 * Kautionsbewegung, keine Verrechnung, keine Erstattung – nur der Beleg.
 */
export async function finalizeCounterDocument(tenantId: string, counterId: string, actor: Actor, opts: CounterFinalizeOptions): Promise<VersionWithItems> {
  if (!opts.confirmed) throw new DomainError("Bitte den Abschluss ausdrücklich bestätigen.");
  return withNumberRetry(() =>
    db.$transaction(async (tx) => {
      const { counter, draft: draft0, type } = await lockCounterDraft(tx, tenantId, counterId);
      const { original, current } = await lockOriginal(tx, tenantId, counter.originalInvoiceId!);
      let draft = draft0;
      if (opts.reason !== undefined && (opts.reason?.trim() || "") !== (draft.reason ?? "")) draft = await tx.invoiceVersion.update({ where: { id: draft.id }, data: { reason: opts.reason?.trim() || null }, include: withItems });
      if (!draft.reason || draft.reason.trim().length < 3) throw new DomainError(`Bitte den Grund ${type === "CANCELLATION" ? "des Stornos" : "der Gutschrift"} angeben.`);
      if (current.id !== counter.originalVersionId) throw new DomainError(`Die Rechnung ${original.number} hat inzwischen eine neuere Fassung (${current.versionNo}). Dieser Entwurf beruht auf Fassung ${(counter.originalSnapshot as OriginalSnapshot).versionNo}; bitte verwerfen und neu erstellen.`);
      const residuals = await residualsOf(tx, tenantId, original, counter.id);
      if (residuals.hasCancellation) throw new DomainError(`Die Rechnung ${original.number} ist bereits storniert; weitere Gutschriften oder Stornobelege sind nicht möglich.`);
      if (residuals.remaining.gross <= 0) throw new DomainError(`Die Rechnung ${original.number} ist bereits vollständig gutgeschrieben; weitere Gutschriften oder Stornobelege sind nicht möglich.`);
      const problems = checkLines(draft, residuals, type, original.number!).filter((i) => i.severity === "error");
      if (problems.length > 0) throw new DomainError(problems.length === 1 ? problems[0].message : `${problems[0].message} (und ${problems.length - 1} weitere Punkte)`);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      for (const m of invoiceSettingsMissing(tenant)) throw new DomainError(`Firmendaten unvollständig: ${m}.`);
      const now = new Date();
      const number = await nextDocumentNumber(tx, tenantId, type, now);
      const sealedBase = await tx.invoiceVersion.update({ where: { id: draft.id }, data: { issueDate: now, companySnapshot: companySnapshotOf(tenant) as unknown as Prisma.InputJsonValue, paymentDueDate: null, paymentTermDays: null }, include: withItems });
      const hash = contentHash(sealedCounterContent({ ...counter, number }, sealedBase));
      const finalized = await tx.invoiceVersion.update({ where: { id: draft.id }, data: { status: "FINALIZED", finalizedAt: now, finalizedById: actor.id, finalizedByName: actor.name, contentHash: hash }, include: withItems });
      const gross = toCents(finalized.grossTotal);
      const paid = await tx.payment.aggregate({ where: { tenantId, invoiceId: original.id, status: "CONFIRMED" }, _sum: { amountCents: true } });
      const paidCents = paid._sum.amountCents ?? 0;
      const effectiveAfter = residuals.remaining.gross - gross;
      const log = Array.isArray(counter.changeLog) ? (counter.changeLog as Prisma.JsonArray) : [];
      await tx.invoice.update({ where: { id: counter.id }, data: { number, status: "FINALIZED", finalizedAt: now, currentVersionId: finalized.id, changeLog: [...log, { at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Abgeschlossen als ${number} über ${money(gross)} zur Rechnung ${original.number}: ${finalized.reason}` }] } });
      const olog = Array.isArray(original.changeLog) ? (original.changeLog as Prisma.JsonArray) : [];
      await tx.invoice.update({ where: { id: original.id }, data: { changeLog: [...olog, { at: now.toISOString(), by: actor.name, summary: `${COUNTER_WORD[type]} ${number} über ${money(gross)} abgeschlossen; verbleibende Forderung ${money(effectiveAfter)}` }] } });
      await recordAudit(tx, tenantId, actor, {
        action: type === "CANCELLATION" ? "CANCELLATION_FINALIZED" : "CREDIT_NOTE_FINALIZED",
        bookingId: original.bookingId, invoiceId: counter.id, amountCents: gross,
        details: { number, originalInvoiceId: original.id, originalNumber: original.number, originalVersion: current.versionNo, reason: finalized.reason, invoiceCents: residuals.invoice.gross, creditedBefore: residuals.credited.gross, effectiveAfter, paidCents, customerCreditCents: Math.max(0, paidCents - effectiveAfter) },
      });
      return finalized;
    }, TX),
  ).catch((e) => {
    if (isUniqueViolation(e, "originalInvoiceId")) throw new DomainError("Zu dieser Rechnung wurde inzwischen ein Stornobeleg abgeschlossen.");
    return domainFromDb(e);
  });
}

// ---------------------------------------------------------------------------
// Belegkette und zentrale Finanzsummierung
// ---------------------------------------------------------------------------

export type ChainEntry = { id: string; documentType: InvoiceDocumentType; number: string | null; status: string; issueDate: Date | null; finalizedAt: Date | null; grossCents: Cents; reason: string | null; versionNo: number; bookingId: string; href: string };

export type InvoiceFinancials = {
  invoiceId: string;
  /** Betrag der aktuellen Rechnungsfassung */
  invoiceCents: Cents;
  creditedCents: Cents;
  cancelledCents: Cents;
  /** wirksame Forderung = Rechnung − Gutschriften − Storno (nie negativ) */
  effectiveCents: Cents;
  /** bestätigte Zahlungen (unverändert durch Gegenbelege) */
  paidCents: Cents;
  openCents: Cents;
  /** Kundenguthaben = Zahlungen über der wirksamen Forderung (wirtschaftlicher Anspruch, vor Auszahlungen) */
  customerCreditCents: Cents;
  /** Phase 18: tatsächlich ausgezahlt (nur abgeschlossene Auszahlungen), Rest und Überhang */
  refundRequiredBeforePayoutsCents: Cents;
  completedRefundCents: Cents;
  refundRemainingCents: Cents;
  /** ausgezahlt über das heutige Guthaben hinaus (nur nach späteren Änderungen möglich; historischer Geldfluss bleibt wahr) */
  refundExcessCents: Cents;
  chain: InvoiceChainStatus;
  paymentStatus: "OPEN" | "PARTIAL" | "PAID";
  /** wirtschaftliches Guthaben vorhanden (unabhängig davon, ob schon ausgezahlt) */
  refundRequired: boolean;
  /** noch auszuzahlen > 0 */
  refundOpen: boolean;
  hasDraftCounter: boolean;
  /** nichts mehr gutschreibbar (Storno oder vollständig gutgeschrieben) */
  fullyNeutralized: boolean;
};

export function computeFinancials(invoiceId: string, invoiceCents: Cents, creditedCents: Cents, cancelledCents: Cents, paidCents: Cents, hasDraftCounter = false, completedRefundCents: Cents = 0): InvoiceFinancials {
  const effectiveCents = Math.max(0, invoiceCents - creditedCents - cancelledCents);
  const openCents = Math.max(0, effectiveCents - paidCents);
  const customerCreditCents = Math.max(0, paidCents - effectiveCents);
  const refundRemainingCents = Math.max(0, customerCreditCents - completedRefundCents);
  const refundExcessCents = Math.max(0, completedRefundCents - customerCreditCents);
  const chain: InvoiceChainStatus = cancelledCents > 0 ? "CANCELLED" : creditedCents > 0 && effectiveCents === 0 ? "CREDITED" : creditedCents > 0 ? "PARTIALLY_CREDITED" : "NONE";
  const paymentStatus = openCents === 0 ? "PAID" : paidCents > 0 ? "PARTIAL" : "OPEN";
  return { invoiceId, invoiceCents, creditedCents, cancelledCents, effectiveCents, paidCents, openCents, customerCreditCents, refundRequiredBeforePayoutsCents: customerCreditCents, completedRefundCents, refundRemainingCents, refundExcessCents, chain, paymentStatus, refundRequired: customerCreditCents > 0, refundOpen: refundRemainingCents > 0, hasDraftCounter, fullyNeutralized: chain === "CANCELLED" || chain === "CREDITED" };
}

/** Finanzstand mehrerer Rechnungen in zwei Abfragen (Listen, Kennzahlen). Gegenbelege in der Liste erhalten den Stand ihres Originals nicht – sie sind keine Forderung. */
export async function financialsFor(tenantId: string, invoices: { id: string; grossTotal: unknown }[], client: Client = db): Promise<Map<string, InvoiceFinancials>> {
  const ids = invoices.map((i) => i.id);
  if (ids.length === 0) return new Map();
  const [pay, counters, payouts] = await Promise.all([
    client.payment.groupBy({ by: ["invoiceId"], where: { tenantId, invoiceId: { in: ids }, status: "CONFIRMED" }, _sum: { amountCents: true } }),
    client.invoice.findMany({ where: { tenantId, originalInvoiceId: { in: ids }, status: { in: ["DRAFT", "FINALIZED"] } }, select: { originalInvoiceId: true, documentType: true, status: true, currentVersion: { select: { grossTotal: true } } } }),
    client.payout.groupBy({ by: ["invoiceId"], where: { tenantId, invoiceId: { in: ids }, status: "COMPLETED" }, _sum: { amountCents: true } }),
  ]);
  const paid = new Map(pay.map((g) => [g.invoiceId, g._sum.amountCents ?? 0]));
  const refunded = new Map(payouts.map((g) => [g.invoiceId, g._sum.amountCents ?? 0]));
  const credited = new Map<string, Cents>(), cancelled = new Map<string, Cents>(), drafts = new Set<string>();
  for (const c of counters) {
    const oid = c.originalInvoiceId!;
    if (c.status === "DRAFT") { drafts.add(oid); continue; }
    const g = toCents(c.currentVersion?.grossTotal ?? 0);
    if (c.documentType === "CANCELLATION") cancelled.set(oid, (cancelled.get(oid) ?? 0) + g);
    else credited.set(oid, (credited.get(oid) ?? 0) + g);
  }
  return new Map(invoices.map((i) => [i.id, computeFinancials(i.id, toCents(i.grossTotal), credited.get(i.id) ?? 0, cancelled.get(i.id) ?? 0, paid.get(i.id) ?? 0, drafts.has(i.id), refunded.get(i.id) ?? 0)]));
}

export async function invoiceFinancials(tenantId: string, invoiceId: string, client: Client = db): Promise<InvoiceFinancials> {
  const inv = await client.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, grossTotal: true, currentVersion: { select: { grossTotal: true } } } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  const m = await financialsFor(tenantId, [{ id: inv.id, grossTotal: inv.currentVersion?.grossTotal ?? inv.grossTotal }], client);
  return m.get(inv.id)!;
}

const hrefOf = (bookingId: string, id: string) => `/buchungen/${bookingId}/rechnung?nr=${id}`;

/** Belegkette einer Rechnung: das Original und alle Gegenbelege (auch Entwürfe), älteste zuerst. Für einen Gegenbeleg: die Kette seines Originals. */
export async function documentChain(tenantId: string, invoiceId: string): Promise<{ original: ChainEntry; counters: ChainEntry[]; financials: InvoiceFinancials }> {
  const self = await db.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, originalInvoiceId: true } });
  if (!self) throw new DomainError("Rechnung nicht gefunden.");
  const originalId = self.originalInvoiceId ?? self.id;
  const sel = { id: true, documentType: true, number: true, status: true, bookingId: true, finalizedAt: true, currentVersion: { select: { issueDate: true, grossTotal: true, reason: true, versionNo: true } }, versions: { where: { status: "DRAFT" }, select: { grossTotal: true, reason: true }, take: 1 } } as const;
  const original = await db.invoice.findFirstOrThrow({ where: { id: originalId, tenantId }, select: sel });
  const counters = await db.invoice.findMany({ where: { tenantId, originalInvoiceId: originalId, status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: [{ finalizedAt: "asc" }, { createdAt: "asc" }], select: sel });
  const entry = (r: typeof original): ChainEntry => ({ id: r.id, documentType: r.documentType as InvoiceDocumentType, number: r.number, status: r.status, issueDate: r.currentVersion?.issueDate ?? null, finalizedAt: r.finalizedAt, grossCents: toCents(r.currentVersion?.grossTotal ?? r.versions[0]?.grossTotal ?? 0), reason: r.currentVersion?.reason ?? r.versions[0]?.reason ?? null, versionNo: r.currentVersion?.versionNo ?? 1, bookingId: r.bookingId, href: hrefOf(r.bookingId, r.id) });
  const financials = await invoiceFinancials(tenantId, originalId);
  return { original: entry(original), counters: counters.map(entry), financials };
}

/** Zustand eines Gegenbelegs für die Oberfläche: Entwurf mit Prüfung und Restbeträgen oder abgeschlossener Beleg. */
export type CounterDocumentState = {
  invoice: InvoiceRow;
  type: CounterDocumentType;
  original: { id: string; number: string; bookingId: string; snapshot: OriginalSnapshot; href: string; currentVersionNo: number; stale: boolean; kind: string; taxTreatmentLabel: string | null; pricesIncludeTax: boolean };
  draft: VersionWithItems | null;
  current: VersionWithItems | null;
  residuals: Residuals | null;
  issues: CounterIssue[];
  financials: InvoiceFinancials;
  /** Zahlungen des Originals, damit der Erstattungsbedarf vor dem Abschluss sichtbar ist */
  paidCents: Cents;
  /** Guthaben nach dem Abschluss dieses Entwurfs */
  customerCreditAfter: Cents;
  effectiveAfter: Cents;
};

export async function getCounterDocumentState(tenantId: string, counterId: string): Promise<CounterDocumentState> {
  const invoice = await db.invoice.findFirst({ where: { id: counterId, tenantId } });
  if (!invoice || invoice.documentType === "INVOICE" || !invoice.originalInvoiceId) throw new DomainError("Beleg nicht gefunden.");
  const type = invoice.documentType as CounterDocumentType;
  const original = await db.invoice.findFirstOrThrow({ where: { id: invoice.originalInvoiceId, tenantId }, include: { currentVersion: { select: { versionNo: true, pricesIncludeTax: true, taxTreatment: true } } } });
  const snapshot = invoice.originalSnapshot as unknown as OriginalSnapshot;
  const draft = await db.invoiceVersion.findFirst({ where: { tenantId, invoiceId: counterId, status: "DRAFT" }, include: withItems });
  const current = invoice.currentVersionId ? await db.invoiceVersion.findFirst({ where: { id: invoice.currentVersionId, tenantId }, include: withItems }) : null;
  const financials = await invoiceFinancials(tenantId, original.id);
  const residuals = draft ? await residualsOf(db, tenantId, original, counterId) : null;
  const stale = original.currentVersionId !== invoice.originalVersionId;
  const issues: CounterIssue[] = draft && residuals ? checkLines(draft, residuals, type, original.number!) : [];
  if (draft && stale) issues.unshift({ code: "STALE", severity: "error", message: `Die Rechnung ${original.number} hat inzwischen eine neuere Fassung. Bitte diesen Entwurf verwerfen und neu erstellen.` });
  if (draft && residuals?.hasCancellation) issues.unshift({ code: "CANCELLED", severity: "error", message: `Die Rechnung ${original.number} ist bereits storniert.` });
  if (draft && !draft.reason?.trim()) issues.push({ code: "REASON", severity: "error", message: `Der Grund ${type === "CANCELLATION" ? "des Stornos" : "der Gutschrift"} ist Pflicht.` });
  const gross = toCents((draft ?? current)?.grossTotal ?? 0);
  const effectiveAfter = draft ? Math.max(0, financials.effectiveCents - gross) : financials.effectiveCents;
  const tt = original.currentVersion?.taxTreatment ?? null;
  return {
    invoice, type,
    original: { id: original.id, number: original.number!, bookingId: original.bookingId, snapshot, href: hrefOf(original.bookingId, original.id), currentVersionNo: original.currentVersion?.versionNo ?? 1, stale, kind: original.kind, taxTreatmentLabel: tt && tt in DAMAGE_TAX_TREATMENTS ? DAMAGE_TAX_TREATMENTS[tt as keyof typeof DAMAGE_TAX_TREATMENTS] : null, pricesIncludeTax: original.currentVersion?.pricesIncludeTax ?? true },
    draft, current, residuals, issues, financials, paidCents: financials.paidCents, customerCreditAfter: Math.max(0, financials.paidCents - effectiveAfter), effectiveAfter,
  };
}

/** Prüfsumme eines abgeschlossenen Gegenbelegs nachrechnen. */
export async function verifyCounterDocument(tenantId: string, counterId: string) {
  const inv = await db.invoice.findFirst({ where: { id: counterId, tenantId } });
  if (!inv || inv.documentType === "INVOICE" || !inv.currentVersionId) return { finalized: false, intact: false, storedHash: null as string | null, currentHash: null as string | null };
  const v = await db.invoiceVersion.findFirstOrThrow({ where: { id: inv.currentVersionId, tenantId }, include: withItems });
  const currentHash = contentHash(sealedCounterContent(inv, v));
  return { finalized: v.status === "FINALIZED", intact: v.status === "FINALIZED" && v.contentHash === currentHash, storedHash: v.contentHash, currentHash };
}

export const originalDateLabel = (s: OriginalSnapshot) => dateFmt(s.issueDate ? new Date(s.issueDate) : null);
export type { CompanySnapshot };
