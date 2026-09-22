// Rechnungen. Entwurf aus den versiegelten Quellen (Vertrag, Rückgabe, bestätigte Zusatzkosten), Bearbeitung
// nur im Entwurf mit Änderungsprotokoll, Abschluss transaktional mit Rechnungsnummer aus der zentralen
// Nummerierung. Danach ist alles Kopie: Anzeige und PDF rechnen nichts mehr aus Buchung oder Zusatzkosten.
//
// Steuer: Der Satz jeder Position kommt aus der Konfiguration des Mandanten (defaultTaxRate) oder aus einer
// bewussten Auswahl (0 % mit gespeichertem Hinweistext). Ob Vertrags- und Zusatzkostenbeträge brutto oder netto
// sind, entscheidet der Inhaber in den Einstellungen (pricesIncludeTax). Ohne diese Entscheidungen gibt es
// keine Rechnung; das System erfindet keine steuerliche Regel.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { EXTRA_CHARGE_TYPES, INVOICE_ITEM_SOURCES, INVOICE_STATUS, INVOICE_UNITS, type ExtraChargeType } from "@/lib/constants";
import type { CustomerSnapshot, VehicleSnapshot } from "@/lib/contracts";
import { DomainError, contentHash, sha256 } from "@/lib/integrity";
import { centsToDecimalString, fmtCents, fmtRate, lineAmounts, summarize, toBasisPoints, toCents, toHundredths, type Cents } from "@/lib/money";
import { isUniqueViolation, nextInvoiceNumber, withNumberRetry } from "@/lib/numbering";
import { rentalDays } from "@/lib/pricing";
import { APP_TIME_ZONE } from "@/lib/time";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type Actor = { id: string; name: string };

export { INVOICE_STATUS, INVOICE_ITEM_SOURCES, INVOICE_UNITS };

const dateFmt = (d: Date) => d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" });

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export type CompanySnapshot = {
  name: string;
  legalForm: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  vatId: string | null;
  taxNumber: string | null;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  invoiceFooter: string | null;
};

export type InvoiceCustomerSnapshot = {
  number: string | null;
  type: string;
  companyName: string | null;
  firstName: string;
  lastName: string;
  street: string | null;
  zip: string | null;
  city: string | null;
  country: string;
  email: string | null;
};

type TenantRow = Prisma.TenantGetPayload<object>;

export function companySnapshotOf(t: TenantRow): CompanySnapshot {
  return { name: t.name, legalForm: t.legalForm, street: t.street, zip: t.zip, city: t.city, country: t.country, email: t.email, phone: t.phone, vatId: t.vatId, taxNumber: t.taxNumber, bankName: t.bankName, iban: t.iban, bic: t.bic, invoiceFooter: t.invoiceFooter };
}

export function customerSnapshotFromContract(c: Partial<CustomerSnapshot>): InvoiceCustomerSnapshot {
  return { number: c.number ?? null, type: c.type ?? "PRIVATE", companyName: c.companyName ?? null, firstName: c.firstName ?? "", lastName: c.lastName ?? "", street: c.street ?? null, zip: c.zip ?? null, city: c.city ?? null, country: c.country ?? "DE", email: c.email ?? null };
}

/** Was in den Einstellungen fehlt, bevor Rechnungen möglich sind. Keine Vermutung, nur die Liste. */
export function invoiceSettingsMissing(t: TenantRow): string[] {
  const missing: string[] = [];
  if (!t.name?.trim()) missing.push("Unternehmensname");
  if (!t.street?.trim() || !t.zip?.trim() || !t.city?.trim()) missing.push("vollständige Anschrift (Straße mit Hausnummer, PLZ, Ort)");
  if (t.defaultTaxRate == null) missing.push("Steuersatz für Rechnungspositionen");
  if (t.pricesIncludeTax == null) missing.push("Angabe, ob Miet- und Zusatzkostenpreise Brutto- oder Nettobeträge sind");
  if (!t.taxNumber?.trim() && !t.vatId?.trim()) missing.push("Steuernummer oder Umsatzsteuer-Identifikationsnummer");
  return missing;
}

// ---------------------------------------------------------------------------
// Positionen
// ---------------------------------------------------------------------------

export type ItemInput = {
  id?: string; // vorhandene Position (Entwurf), sonst neu
  description: string;
  quantity: number | string;
  unit: string;
  unitPrice: number | string; // brutto oder netto laut pricesIncludeTax
  taxRate: number | string; // Prozent
  source?: "RENTAL" | "EXTRA_CHARGE" | "MANUAL";
  extraChargeId?: string | null;
  reference?: string | null;
};

type ComputedItem = { description: string; unit: string; source: string; extraChargeId: string | null; reference: string | null; quantityH: number; unitPriceC: Cents; taxRateBp: number; amounts: ReturnType<typeof lineAmounts> };

function computeItem(mode: "NET" | "GROSS", it: ItemInput): ComputedItem {
  const description = it.description.trim();
  if (description.length < 2) throw new DomainError("Bitte jede Position beschreiben.");
  if (!(INVOICE_UNITS as readonly string[]).includes(it.unit)) throw new DomainError(`Unbekannte Einheit „${it.unit}“.`);
  let quantityH: number, unitPriceC: Cents, taxRateBp: number;
  try {
    quantityH = toHundredths(it.quantity);
    unitPriceC = toCents(it.unitPrice);
    taxRateBp = toBasisPoints(it.taxRate);
  } catch (e) {
    throw new DomainError(`Position „${description}“: ${(e as Error).message}`);
  }
  try {
    return { description, unit: it.unit, source: it.source ?? "MANUAL", extraChargeId: it.extraChargeId ?? null, reference: it.reference ?? null, quantityH, unitPriceC, taxRateBp, amounts: lineAmounts(mode, quantityH, unitPriceC, taxRateBp) };
  } catch (e) {
    throw new DomainError(`Position „${description}“: ${(e as Error).message}`);
  }
}

function itemData(tenantId: string, invoiceId: string, sortOrder: number, c: ComputedItem) {
  return {
    tenantId,
    invoiceId,
    sortOrder,
    description: c.description,
    quantity: (c.quantityH / 100).toFixed(2),
    unit: c.unit,
    unitPrice: centsToDecimalString(c.unitPriceC),
    netAmount: centsToDecimalString(c.amounts.net),
    taxRate: (c.taxRateBp / 100).toFixed(2),
    taxAmount: centsToDecimalString(c.amounts.tax),
    grossAmount: centsToDecimalString(c.amounts.gross),
    source: c.source,
    extraChargeId: c.extraChargeId,
    reference: c.reference,
  };
}

/** Summen aus den gespeicherten (bereits gerundeten) Positionen. */
export function totalsOf(items: { netAmount: unknown; taxAmount: unknown; grossAmount: unknown; taxRate: unknown }[]) {
  return summarize(items.map((i) => ({ taxRateBp: toBasisPoints(i.taxRate), amounts: { net: toCents(i.netAmount), tax: toCents(i.taxAmount), gross: toCents(i.grossAmount) } })));
}

// ---------------------------------------------------------------------------
// Entwurf
// ---------------------------------------------------------------------------

async function loadSources(tx: Tx, tenantId: string, bookingId: string) {
  const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, include: { contract: true, tenant: true } });
  if (!booking) throw new DomainError("Buchung nicht gefunden.");
  if (booking.status !== "RETURNED") throw new DomainError("Eine Rechnung wird erst nach abgeschlossener Rückgabe erstellt.");
  if (!booking.contract || booking.contract.status !== "SIGNED" || !booking.contract.contentHash) throw new DomainError("Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag.");
  const ret = await tx.handover.findFirst({ where: { tenantId, bookingId, type: "RETURN", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" }, include: { extraCharges: { orderBy: { createdAt: "asc" } } } });
  if (!ret || !ret.contentHash) throw new DomainError("Zu dieser Buchung gibt es keine abgeschlossene Rückgabe.");
  const pickup = await tx.handover.findFirst({ where: { tenantId, bookingId, type: "PICKUP", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" } });
  return { booking, contract: booking.contract, tenant: booking.tenant, ret, pickup };
}

/**
 * Legt den Rechnungsentwurf an oder gibt den vorhandenen zurück. Positionen: Fahrzeugmiete zum finalen
 * Vertragspreis und jede bei der Rückgabe bestätigte Zusatzkostenposition, sonst nichts. Ein bei der Rückgabe
 * festgestellter Schaden erscheint nur, wenn ein Mitarbeiter dort ausdrücklich eine Position vom Typ DAMAGE angelegt hat.
 */
export async function ensureInvoiceDraft(tenantId: string, bookingId: string, actor: Actor) {
  const existing = await db.invoice.findFirst({ where: { tenantId, bookingId, status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "desc" } });
  if (existing) return existing;
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const again = await tx.invoice.findFirst({ where: { tenantId, bookingId, status: { in: ["DRAFT", "FINALIZED"] } } });
    if (again) return again;
    const { booking, contract, tenant, ret, pickup } = await loadSources(tx, tenantId, bookingId);
    const missing = invoiceSettingsMissing(tenant);
    if (missing.length > 0) throw new DomainError(`Bevor Rechnungen erstellt werden können, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
    const mode = tenant.pricesIncludeTax ? "GROSS" : "NET";
    const rate = Number(tenant.defaultTaxRate);
    const v = contract.vehicleSnapshot as Partial<VehicleSnapshot>;
    const c = contract.customerSnapshot as Partial<CustomerSnapshot>;
    const start = booking.actualPickupAt ?? pickup?.finalizedAt ?? contract.startAt;
    const end = booking.actualReturnAt ?? ret.finalizedAt ?? contract.endAt;
    const days = rentalDays(contract.startAt, contract.endAt);

    const items: ItemInput[] = [
      {
        description: `Fahrzeugmiete ${[v.make, v.model].filter(Boolean).join(" ")}${v.plate ? ` (${v.plate})` : ""}, ${dateFmt(contract.startAt)} bis ${dateFmt(contract.endAt)}, ${days} ${days === 1 ? "Tag" : "Tage"}, laut Mietvertrag ${contract.number}`,
        quantity: 1,
        unit: "pauschal",
        unitPrice: String(contract.totalAmount),
        taxRate: rate,
        source: "RENTAL",
        reference: `Mietvertrag ${contract.number}`,
      },
      ...ret.extraCharges.map((e): ItemInput => ({
        description: `${EXTRA_CHARGE_TYPES[e.type as ExtraChargeType] ?? e.type}: ${e.description}`,
        quantity: String(e.quantity),
        unit: (INVOICE_UNITS as readonly string[]).includes(e.unit) ? e.unit : "pauschal",
        unitPrice: String(e.unitPrice),
        taxRate: rate,
        source: "EXTRA_CHARGE",
        extraChargeId: e.id,
        reference: `${ret.number}: ${e.formula}`,
      })),
    ];
    // Bei Zusatzkosten mit Menge und Einzelpreis muss Menge × Einzelpreis den bestätigten Betrag ergeben; sonst als Pauschale
    const computed = items.map((it) => computeItem(mode, it));
    computed.forEach((ci, i) => {
      const src = items[i].extraChargeId ? ret.extraCharges.find((e) => e.id === items[i].extraChargeId) : null;
      if (src && (mode === "GROSS" ? ci.amounts.gross : ci.amounts.net) !== toCents(src.amount)) {
        computed[i] = computeItem(mode, { ...items[i], quantity: 1, unit: "pauschal", unitPrice: String(src.amount) });
      }
    });
    const totals = summarize(computed.map((ci) => ({ taxRateBp: ci.taxRateBp, amounts: ci.amounts })));

    const invoice = await tx.invoice.create({
      data: {
        tenantId,
        bookingId,
        customerId: booking.customerId,
        contractId: contract.id,
        returnHandoverId: ret.id,
        servicePeriodStart: start,
        servicePeriodEnd: end,
        pricesIncludeTax: mode === "GROSS",
        customerSnapshot: customerSnapshotFromContract(c),
        companySnapshot: companySnapshotOf(tenant),
        netTotal: centsToDecimalString(totals.total.net),
        taxTotal: centsToDecimalString(totals.total.tax),
        grossTotal: centsToDecimalString(totals.total.gross),
        paymentTermDays: tenant.paymentTermDays,
        taxNote: tenant.taxNote,
        sourceHash: sha256(`${contract.contentHash}:${ret.contentHash}`),
        createdById: actor.id,
        changeLog: [{ at: new Date().toISOString(), by: actor.name, summary: `Entwurf aus Mietvertrag ${contract.number} und Rückgabe ${ret.number} erstellt (${computed.length} Positionen)` }],
      },
    });
    await tx.invoiceItem.createMany({ data: computed.map((ci, i) => itemData(tenantId, invoice.id, i, ci)) });
    return invoice;
  }, TX);
}

export type DraftInput = {
  items: ItemInput[];
  customerNote?: string | null;
  taxNote?: string | null;
  notes?: string | null;
  paymentTermDays?: number | null;
};

async function loadDraft(tx: Tx, tenantId: string, invoiceId: string) {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, include: { items: { orderBy: { sortOrder: "asc" } } } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  if (inv.status !== "DRAFT") throw new DomainError(`Die Rechnung ${inv.number ?? ""} ist abgeschlossen und kann nicht mehr geändert werden.`);
  return inv;
}

/** Entwurf speichern: Positionen ersetzen, Summen neu rechnen, Änderung protokollieren. Quellen (Vertrag, Zusatzkosten) bleiben unberührt. */
export async function updateInvoiceDraft(tenantId: string, invoiceId: string, actor: Actor, input: DraftInput) {
  if (input.items.length === 0) throw new DomainError("Eine Rechnung braucht mindestens eine Position.");
  if (input.paymentTermDays != null && !(Number.isInteger(input.paymentTermDays) && input.paymentTermDays >= 0 && input.paymentTermDays <= 365)) throw new DomainError("Das Zahlungsziel liegt zwischen 0 und 365 Tagen.");
  return db.$transaction(async (tx) => {
    const inv = await loadDraft(tx, tenantId, invoiceId);
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const allowedRates = new Set([toBasisPoints(tenant.defaultTaxRate ?? 0), 0]);
    const mode = inv.pricesIncludeTax ? "GROSS" : "NET";
    const before = new Map(inv.items.map((i) => [i.id, i]));
    const computed = input.items.map((it) => {
      const prev = it.id ? before.get(it.id) : undefined;
      const ci = computeItem(mode, { ...it, source: prev?.source as ItemInput["source"] | undefined ?? "MANUAL", extraChargeId: prev?.extraChargeId ?? null, reference: prev?.reference ?? it.reference ?? null });
      if (!allowedRates.has(ci.taxRateBp)) throw new DomainError(`Position „${ci.description}“: Der Steuersatz ${fmtRate(ci.taxRateBp)} ist nicht konfiguriert. Erlaubt sind ${[...allowedRates].map(fmtRate).join(" und ")}.`);
      return ci;
    });
    const totals = summarize(computed.map((ci) => ({ taxRateBp: ci.taxRateBp, amounts: ci.amounts })));

    // Änderungen nachvollziehbar festhalten
    const changes: string[] = [];
    const kept = new Set(input.items.map((i) => i.id).filter(Boolean));
    for (const old of inv.items) if (!kept.has(old.id)) changes.push(`Position entfernt: ${old.description} (${fmtCents(toCents(old.grossAmount))})`);
    input.items.forEach((it, i) => {
      const old = it.id ? before.get(it.id) : undefined;
      const ci = computed[i];
      if (!old) changes.push(`Position hinzugefügt: ${ci.description} (${fmtCents(ci.amounts.gross)})`);
      else if (old.description !== ci.description || toCents(old.grossAmount) !== ci.amounts.gross || toBasisPoints(old.taxRate) !== ci.taxRateBp || toHundredths(old.quantity) !== ci.quantityH) changes.push(`Position geändert: ${old.description} (${fmtCents(toCents(old.grossAmount))}) zu ${ci.description} (${fmtCents(ci.amounts.gross)}, ${fmtRate(ci.taxRateBp)})`);
    });
    // Felder, die nicht mitgeschickt werden (undefined), bleiben unverändert; leer gilt als gelöscht
    const customerNote = input.customerNote === undefined ? inv.customerNote : input.customerNote?.trim() || null;
    const taxNote = input.taxNote === undefined ? inv.taxNote : input.taxNote?.trim() || null;
    const notes = input.notes === undefined ? inv.notes : input.notes?.trim() || null;
    const paymentTermDays = input.paymentTermDays === undefined ? inv.paymentTermDays : input.paymentTermDays;
    if ((inv.customerNote ?? "") !== (customerNote ?? "")) changes.push("Rechnungstext geändert");
    if ((inv.taxNote ?? "") !== (taxNote ?? "")) changes.push("Steuerhinweis geändert");
    if ((inv.paymentTermDays ?? null) !== (paymentTermDays ?? null)) changes.push(`Zahlungsziel: ${paymentTermDays ?? "keines"}`);

    await tx.invoiceItem.deleteMany({ where: { tenantId, invoiceId: inv.id } });
    await tx.invoiceItem.createMany({ data: computed.map((ci, i) => itemData(tenantId, inv.id, i, ci)) });
    const log = Array.isArray(inv.changeLog) ? (inv.changeLog as Prisma.JsonArray) : [];
    return tx.invoice.update({
      where: { id: inv.id },
      data: {
        netTotal: centsToDecimalString(totals.total.net),
        taxTotal: centsToDecimalString(totals.total.tax),
        grossTotal: centsToDecimalString(totals.total.gross),
        customerNote,
        taxNote,
        notes,
        paymentTermDays,
        changeLog: changes.length > 0 ? [...log, { at: new Date().toISOString(), by: actor.name, summary: changes.join("; ") }] : log,
      },
    });
  }, TX);
}

// ---------------------------------------------------------------------------
// Prüfung und Abschluss
// ---------------------------------------------------------------------------

export type InvoiceIssue = { code: string; severity: "error" | "warning"; message: string };

async function collectIssues(tx: Tx, tenantId: string, invoiceId: string): Promise<InvoiceIssue[]> {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, include: { items: true } });
  if (!inv) return [{ code: "NOT_FOUND", severity: "error", message: "Rechnung nicht gefunden." }];
  const issues: InvoiceIssue[] = [];
  const err = (code: string, message: string) => issues.push({ code, severity: "error", message });
  const warn = (code: string, message: string) => issues.push({ code, severity: "warning", message });
  const booking = await tx.booking.findFirst({ where: { id: inv.bookingId, tenantId }, include: { contract: { select: { status: true } } } });
  if (!booking) err("BOOKING_MISSING", "Buchung nicht gefunden.");
  else {
    if (booking.status !== "RETURNED") err("BOOKING_STATUS", "Die Buchung ist nicht zurückgegeben.");
    if (booking.contract?.status !== "SIGNED") err("CONTRACT", "Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag.");
  }
  const ret = inv.returnHandoverId ? await tx.handover.findFirst({ where: { id: inv.returnHandoverId, tenantId, status: "FINALIZED" } }) : null;
  if (!ret) err("RETURN", "Zu dieser Rechnung gibt es keine abgeschlossene Rückgabe.");
  const other = await tx.invoice.count({ where: { tenantId, bookingId: inv.bookingId, status: "FINALIZED", id: { not: inv.id } } });
  if (other > 0) err("INVOICE_EXISTS", "Zu dieser Buchung gibt es bereits eine abgeschlossene Rechnung.");

  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  const c = inv.customerSnapshot as InvoiceCustomerSnapshot;
  const name = c.type === "COMPANY" ? c.companyName : `${c.firstName} ${c.lastName}`.trim();
  if (!name) err("CUSTOMER_NAME", "Der Rechnungsempfänger hat keinen Namen.");
  if (!c.street || !c.zip || !c.city) err("CUSTOMER_ADDRESS", "Die Anschrift des Rechnungsempfängers ist unvollständig (Straße, PLZ, Ort).");

  if (inv.items.length === 0) err("NO_ITEMS", "Die Rechnung hat keine Position.");
  const totals = totalsOf(inv.items);
  if (totals.total.net !== toCents(inv.netTotal) || totals.total.tax !== toCents(inv.taxTotal) || totals.total.gross !== toCents(inv.grossTotal)) err("TOTALS", "Die Gesamtbeträge passen nicht zu den Positionen.");
  for (const it of inv.items) {
    const expected = lineAmounts(inv.pricesIncludeTax ? "GROSS" : "NET", toHundredths(it.quantity), toCents(it.unitPrice), toBasisPoints(it.taxRate));
    if (expected.net !== toCents(it.netAmount) || expected.tax !== toCents(it.taxAmount) || expected.gross !== toCents(it.grossAmount)) err("ITEM_AMOUNTS", `Position „${it.description}“: Beträge und Steuer sind nicht konsistent.`);
    if (it.source === "EXTRA_CHARGE" && it.extraChargeId) {
      const ec = await tx.extraCharge.findFirst({ where: { id: it.extraChargeId, tenantId } });
      if (!ec || ec.handoverId !== inv.returnHandoverId) err("EXTRA_CHARGE", `Position „${it.description}“ verweist auf keine bestätigte Zusatzkostenposition dieser Rückgabe.`);
    }
  }
  if (inv.items.some((it) => toBasisPoints(it.taxRate) === 0) && !inv.taxNote?.trim()) err("TAX_NOTE", "Es gibt Positionen mit 0 % Steuer. Bitte den Steuerhinweis für die Rechnung angeben.");
  if (totals.total.gross === 0) warn("ZERO", "Der Rechnungsbetrag ist 0,00 €.");
  return issues;
}

export async function getInvoiceState(tenantId: string, invoiceId: string) {
  return db.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    if (!invoice) throw new DomainError("Rechnung nicht gefunden.");
    const issues = invoice.status === "DRAFT" ? await collectIssues(tx, tenantId, invoiceId) : [];
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    return { invoice, issues, allowedRates: [...new Set([toBasisPoints(tenant.defaultTaxRate ?? 0), 0])].map((bp) => bp / 100) };
  }, TX);
}

function sealedContent(inv: Prisma.InvoiceGetPayload<{ include: { items: true } }>) {
  return {
    number: inv.number,
    bookingId: inv.bookingId,
    contractId: inv.contractId,
    returnHandoverId: inv.returnHandoverId,
    issueDate: inv.issueDate,
    servicePeriodStart: inv.servicePeriodStart,
    servicePeriodEnd: inv.servicePeriodEnd,
    currency: inv.currency,
    pricesIncludeTax: inv.pricesIncludeTax,
    customer: inv.customerSnapshot,
    company: inv.companySnapshot,
    netTotal: String(inv.netTotal),
    taxTotal: String(inv.taxTotal),
    grossTotal: String(inv.grossTotal),
    paymentTermDays: inv.paymentTermDays,
    paymentDueDate: inv.paymentDueDate,
    customerNote: inv.customerNote,
    taxNote: inv.taxNote,
    items: [...inv.items].sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({ description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: String(i.unitPrice), netAmount: String(i.netAmount), taxRate: String(i.taxRate), taxAmount: String(i.taxAmount), grossAmount: String(i.grossAmount), source: i.source, extraChargeId: i.extraChargeId })),
  };
}

/**
 * Abschluss: Zeile sperren, alles erneut prüfen, Firmendaten von jetzt einfrieren, Rechnungsnummer vergeben,
 * Zahlungsziel setzen, Hash versiegeln, Status setzen. Eine Nummer wird nie wiederverwendet: der Index verhindert
 * Doppelte, bei Kollision wird der ganze Abschluss mit der nächsten Nummer wiederholt.
 */
export async function finalizeInvoice(tenantId: string, invoiceId: string, actor: Actor) {
  return withNumberRetry(() =>
    db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Invoice" WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
      if (locked[0].status !== "DRAFT") throw new DomainError("Die Rechnung ist bereits abgeschlossen.");
      const problems = (await collectIssues(tx, tenantId, invoiceId)).filter((i) => i.severity === "error");
      if (problems.length > 0) throw new DomainError(problems.length === 1 ? problems[0].message : `${problems[0].message} (und ${problems.length - 1} weitere Punkte)`);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const now = new Date();
      const number = await nextInvoiceNumber(tx, tenantId, now);
      const paymentTermDays = (await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).paymentTermDays;
      const paymentDueDate = paymentTermDays != null ? new Date(now.getTime() + paymentTermDays * 86400_000) : null;
      const sealedBase = await tx.invoice.update({
        where: { id: invoiceId },
        data: { number, issueDate: now, paymentDueDate, companySnapshot: companySnapshotOf(tenant) },
        include: { items: true },
      });
      const hash = contentHash(sealedContent(sealedBase));
      return tx.invoice.update({ where: { id: invoiceId }, data: { status: "FINALIZED", finalizedAt: now, contentHash: hash, changeLog: [...((sealedBase.changeLog as Prisma.JsonArray) ?? []), { at: now.toISOString(), by: actor.name, summary: `Abgeschlossen als ${number}` }] }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    }, TX),
  ).catch((e) => {
    if (isUniqueViolation(e, "bookingId")) throw new DomainError("Zu dieser Buchung gibt es bereits eine abgeschlossene Rechnung.");
    throw e;
  });
}

export async function verifyInvoice(tenantId: string, invoiceId: string) {
  const inv = await db.invoice.findFirst({ where: { id: invoiceId, tenantId }, include: { items: true } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  const hash = contentHash(sealedContent(inv));
  return { finalized: inv.status === "FINALIZED", storedHash: inv.contentHash, currentHash: hash, intact: inv.status === "FINALIZED" && inv.contentHash === hash };
}

/** Entwurf verwerfen (nur DRAFT). Abgeschlossene Rechnungen bleiben immer erhalten. */
export async function discardInvoiceDraft(tenantId: string, invoiceId: string) {
  return db.$transaction(async (tx) => {
    const inv = await loadDraft(tx, tenantId, invoiceId);
    await tx.invoiceItem.deleteMany({ where: { tenantId, invoiceId: inv.id } });
    await tx.invoice.delete({ where: { id: inv.id } });
  }, TX);
}
