// Rechnungen mit Fassungen (Phase 10).
//   Invoice        = logische Rechnung: Nummer, Bezug zur Buchung, Zeiger auf die aktuelle Fassung, interne Notiz.
//   InvoiceVersion = unveränderliche Fassung: alle Rechnungsdaten, Positionen, Prüfsumme, PDF, Versand.
// Fassung 1 entsteht aus den versiegelten Quellen (Vertrag, Rückgabe, bestätigte Zusatzkosten). Jede weitere Fassung
// entsteht aus dem Snapshot der Vorfassung, nie aus aktuellen Stammdaten. Nichts Abgeschlossenes wird überschrieben:
// "Rechnung bearbeiten" heißt "diese Rechnung korrigieren", und die alte Fassung bleibt vollständig erhalten.
//
// Fassungsart: REVISION, wenn die Vorfassung dem Kunden nie übermittelt wurde (kein Rent-Base-Versand SENT, keine
// manuelle Übergabemarkierung); CORRECTION, sobald sie übermittelt war (dann Pflichtgrund). Ein PDF-Download ist
// keine Übermittlung. Nach buchhalterischem Export gibt es keine Fassung mehr unter derselben Nummer.
//
// Steuer: Der Satz jeder Position kommt aus der Konfiguration des Mandanten (defaultTaxRate) oder aus einer
// bewussten Auswahl (0 % mit gespeichertem Hinweistext). Ob Beträge brutto oder netto sind, entscheidet der Inhaber
// (pricesIncludeTax). Ohne diese Entscheidungen gibt es keine Rechnung; das System erfindet keine steuerliche Regel.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DAMAGE_TAX_NOTES, DAMAGE_TAX_TREATMENTS, type DamageTaxTreatment } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
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

export type VersionRow = Prisma.InvoiceVersionGetPayload<object>;
export type VersionWithItems = Prisma.InvoiceVersionGetPayload<{ include: { items: true } }>;
export type InvoiceRow = Prisma.InvoiceGetPayload<object>;
export type VersionKind = "ORIGINAL" | "REVISION" | "CORRECTION";

const dateFmt = (d: Date) => d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" });
const withItems = { items: { orderBy: { sortOrder: "asc" as const } } };

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

/** Firmendaten einer Fassung: vollständig? (Prüfung auf der Kopie, nicht auf den aktuellen Einstellungen) */
function companySnapshotMissing(c: CompanySnapshot): string[] {
  const missing: string[] = [];
  if (!c.name?.trim()) missing.push("Unternehmensname");
  if (!c.street?.trim() || !c.zip?.trim() || !c.city?.trim()) missing.push("vollständige Anschrift des Rechnungsstellers");
  if (!c.taxNumber?.trim() && !c.vatId?.trim()) missing.push("Steuernummer oder Umsatzsteuer-Identifikationsnummer");
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

function itemData(tenantId: string, versionId: string, sortOrder: number, c: ComputedItem) {
  return {
    tenantId,
    versionId,
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
// Fassung 1: Entwurf aus den Quellen
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
 * Legt die logische Rechnung mit Fassung 1 (Entwurf) an oder gibt die vorhandene Rechnung zurück. Positionen:
 * Fahrzeugmiete zum finalen Vertragspreis und jede bei der Rückgabe bestätigte Zusatzkostenposition, sonst nichts.
 * Ein festgestellter Schaden erscheint nur, wenn ein Mitarbeiter dort ausdrücklich eine Position vom Typ DAMAGE angelegt hat.
 */
export async function ensureInvoiceDraft(tenantId: string, bookingId: string, actor: Actor): Promise<InvoiceRow> {
  const existing = await db.invoice.findFirst({ where: { tenantId, bookingId, kind: "RENTAL", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "desc" } });
  if (existing) return existing;
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const again = await tx.invoice.findFirst({ where: { tenantId, bookingId, kind: "RENTAL", status: { in: ["DRAFT", "FINALIZED"] } } });
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
    const now = new Date();

    const invoice = await tx.invoice.create({
      data: {
        tenantId,
        bookingId,
        customerId: booking.customerId,
        contractId: contract.id,
        returnHandoverId: ret.id,
        sourceHash: sha256(`${contract.contentHash}:${ret.contentHash}`),
        createdById: actor.id,
        changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Entwurf aus Mietvertrag ${contract.number} und Rückgabe ${ret.number} erstellt (${computed.length} Positionen)` }],
      },
    });
    const version = await tx.invoiceVersion.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        versionNo: 1,
        kind: "ORIGINAL",
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
        createdById: actor.id,
        createdByName: actor.name,
      },
    });
    await tx.invoiceVersionItem.createMany({ data: computed.map((ci, i) => itemData(tenantId, version.id, i, ci)) });
    return invoice;
  }, TX);
}

/**
 * Schadenabrechnung (kind DAMAGE) als Entwurf mit Fassung 1: eine Position über den bewusst festgelegten Belastungsbetrag.
 * Rechnungsempfänger aus der Vertragskopie, Firmendaten aus den Einstellungen; Steuersatz folgt der gewählten steuerlichen
 * Behandlung (echter Schadensersatz → 0 % mit Hinweistext, steuerpflichtiges Entgelt → Standardsatz). Wird von der
 * Schadenakte aufgerufen; die Eindeutigkeit je Akte sichert der Datenbank-Index.
 */
export async function createDamageInvoiceDraft(tx: Tx, tenantId: string, actor: Actor, input: { bookingId: string; damageCaseId: string; damageId: string; caseNumber: string; amountCents: Cents; basis: string; taxTreatment: DamageTaxTreatment }): Promise<InvoiceRow> {
  const booking = await tx.booking.findFirst({ where: { id: input.bookingId, tenantId }, include: { contract: true, tenant: true } });
  if (!booking) throw new DomainError("Buchung nicht gefunden.");
  if (!booking.contract || booking.contract.status !== "SIGNED") throw new DomainError("Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag; ohne Vertragskopie gibt es keinen Rechnungsempfänger.");
  const tenant = booking.tenant;
  const missing = invoiceSettingsMissing(tenant);
  if (missing.length > 0) throw new DomainError(`Bevor Rechnungen erstellt werden können, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
  if (input.amountCents <= 0) throw new DomainError("Der Belastungsbetrag muss größer als 0,00 € sein.");
  const mode = tenant.pricesIncludeTax ? "GROSS" : "NET";
  if (!(input.taxTreatment in DAMAGE_TAX_TREATMENTS)) throw new DomainError("Bitte die steuerliche Behandlung der Kundenbelastung auswählen.");
  // Echter Schadensersatz ist nicht steuerbar: die Position trägt keinen Steuersatz (intern 0 Basispunkte, aber kein „0 %“-Ausweis).
  // Steuerpflichtiges Entgelt folgt der normalen Umsatzsteuerlogik mit dem Standardsatz aus den Einstellungen.
  const nonTaxable = input.taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION";
  const rate = nonTaxable ? 0 : Number(tenant.defaultTaxRate);
  const c = booking.contract.customerSnapshot as Partial<CustomerSnapshot>;
  const item = computeItem(mode, { description: `Schadenabrechnung zur Vermietung ${booking.number} (Schadenakte ${input.caseNumber}): ${input.basis.trim()}`, quantity: 1, unit: "pauschal", unitPrice: centsToDecimalString(input.amountCents), taxRate: rate, source: "MANUAL", reference: `Schadenakte ${input.caseNumber}` });
  const totals = summarize([{ taxRateBp: item.taxRateBp, amounts: item.amounts }]);
  const start = booking.actualPickupAt ?? booking.contract.startAt;
  const end = booking.actualReturnAt ?? booking.contract.endAt;
  const now = new Date();
  const invoice = await tx.invoice.create({
    data: {
      tenantId, bookingId: booking.id, customerId: booking.customerId, contractId: booking.contract.id,
      kind: "DAMAGE", damageCaseId: input.damageCaseId, damageId: input.damageId, taxTreatment: input.taxTreatment,
      sourceHash: sha256(`${booking.contract.contentHash}:${input.damageCaseId}:${input.amountCents}`),
      createdById: actor.id,
      changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Schadenabrechnung zur Schadenakte ${input.caseNumber} als Entwurf erstellt (Kundenbelastung ${fmtCents(input.amountCents)})` }],
    },
  });
  const version = await tx.invoiceVersion.create({
    data: {
      tenantId, invoiceId: invoice.id, versionNo: 1, kind: "ORIGINAL",
      servicePeriodStart: start, servicePeriodEnd: end, pricesIncludeTax: mode === "GROSS",
      customerSnapshot: customerSnapshotFromContract(c), companySnapshot: companySnapshotOf(tenant),
      netTotal: centsToDecimalString(totals.total.net), taxTotal: centsToDecimalString(totals.total.tax), grossTotal: centsToDecimalString(totals.total.gross),
      paymentTermDays: tenant.paymentTermDays, taxNote: nonTaxable ? DAMAGE_TAX_NOTES.NON_TAXABLE_DAMAGE_COMPENSATION : tenant.taxNote, taxTreatment: input.taxTreatment,
      createdById: actor.id, createdByName: actor.name,
    },
  });
  await tx.invoiceVersionItem.create({ data: itemData(tenantId, version.id, 0, item) });
  return invoice;
}

// ---------------------------------------------------------------------------
// Übermittlung und Bearbeitungsmodus
// ---------------------------------------------------------------------------

export type DeliveryState = { sentAt: Date | null; sentTo: string | null; deliveredAt: Date | null; deliveredByName: string | null; deliveredNote: string | null; delivered: boolean };

/** Übermittelt = erfolgreicher Rent-Base-Versand (EmailLog SENT dieser Fassung) oder manuelle Übergabemarkierung. Ein Download zählt nicht. */
export async function deliveryStateOf(tenantId: string, version: { id: string; deliveredAt: Date | null; deliveredByName: string | null; deliveredNote: string | null }, client: Tx | typeof db = db): Promise<DeliveryState> {
  const sent = await client.emailLog.findFirst({ where: { tenantId, invoiceVersionId: version.id, status: "SENT" }, orderBy: { sentAt: "asc" }, select: { sentAt: true, recipient: true } });
  return { sentAt: sent?.sentAt ?? null, sentTo: sent?.recipient ?? null, deliveredAt: version.deliveredAt, deliveredByName: version.deliveredByName, deliveredNote: version.deliveredNote, delivered: !!sent || !!version.deliveredAt };
}

export type EditMode = "A" | "B" | "C" | "D";
export type EditModeInfo = { mode: EditMode; nextKind: "REVISION" | "CORRECTION"; delivered: boolean; exported: boolean; paidCents: Cents; currentGrossCents: Cents; reasons: string[] };

async function editModeOf(client: Tx | typeof db, tenantId: string, invoice: InvoiceRow, current: VersionRow): Promise<EditModeInfo> {
  const [delivery, paid] = await Promise.all([
    deliveryStateOf(tenantId, current, client),
    client.payment.aggregate({ where: { tenantId, invoiceId: invoice.id, status: "CONFIRMED" }, _sum: { amountCents: true } }),
  ]);
  const exported = !!invoice.exportedAt || !!current.exportedAt;
  const paidCents = paid._sum.amountCents ?? 0;
  const mode: EditMode = exported ? "D" : paidCents > 0 ? "C" : delivery.delivered ? "B" : "A";
  const reasons: string[] = [];
  if (delivery.sentAt) reasons.push(`per E-Mail versendet am ${dateFmt(delivery.sentAt)}${delivery.sentTo ? ` an ${delivery.sentTo}` : ""}`);
  if (delivery.deliveredAt) reasons.push(`manuell als übergeben markiert am ${dateFmt(delivery.deliveredAt)}${delivery.deliveredByName ? ` von ${delivery.deliveredByName}` : ""}`);
  return { mode, nextKind: delivery.delivered ? "CORRECTION" : "REVISION", delivered: delivery.delivered, exported, paidCents, currentGrossCents: toCents(current.grossTotal), reasons };
}

/** Bearbeitungsmodus einer abgeschlossenen Rechnung (A nicht übermittelt, B übermittelt, C mit Zahlungen, D exportiert). */
export async function invoiceEditMode(tenantId: string, invoiceId: string): Promise<EditModeInfo & { current: VersionRow }> {
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, tenantId } });
  if (!invoice || !invoice.currentVersionId) throw new DomainError("Rechnung nicht gefunden oder noch nicht abgeschlossen.");
  const current = await db.invoiceVersion.findFirstOrThrow({ where: { id: invoice.currentVersionId, tenantId } });
  return { ...(await editModeOf(db, tenantId, invoice, current)), current };
}

/**
 * „Rechnung bearbeiten“: legt den Entwurf der Fassung n+1 aus dem Snapshot der aktuellen Fassung an (nicht aus
 * Stammdaten) oder gibt den vorhandenen Entwurf zurück. Zwei gleichzeitige Klicks ergeben denselben Entwurf
 * (Fassungsnummer ist je Rechnung eindeutig). Nach Export gesperrt.
 */
export async function startInvoiceEdit(tenantId: string, invoiceId: string, actor: Actor): Promise<VersionWithItems> {
  const open = await db.invoiceVersion.findFirst({ where: { tenantId, invoiceId, status: "DRAFT" }, include: withItems });
  if (open) return open;
  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (invoice.status !== "FINALIZED" || !invoice.currentVersionId) throw new DomainError("Nur abgeschlossene Rechnungen können bearbeitet werden.");
      const again = await tx.invoiceVersion.findFirst({ where: { tenantId, invoiceId, status: "DRAFT" }, include: withItems });
      if (again) return again;
      const current = await tx.invoiceVersion.findFirstOrThrow({ where: { id: invoice.currentVersionId, tenantId }, include: withItems });
      const info = await editModeOf(tx, tenantId, invoice, current);
      if (info.exported) throw new DomainError("Diese Rechnung wurde bereits buchhalterisch exportiert. Eine Änderung unter derselben Rechnungsnummer ist nicht mehr möglich.");
      const max = await tx.invoiceVersion.aggregate({ where: { invoiceId }, _max: { versionNo: true } });
      const versionNo = (max._max.versionNo ?? 0) + 1;
      const draft = await tx.invoiceVersion.create({
        data: {
          tenantId,
          invoiceId,
          versionNo,
          kind: info.nextKind,
          supersedesVersionId: current.id,
          issueDate: current.issueDate,
          servicePeriodStart: current.servicePeriodStart,
          servicePeriodEnd: current.servicePeriodEnd,
          currency: current.currency,
          pricesIncludeTax: current.pricesIncludeTax,
          customerSnapshot: current.customerSnapshot as Prisma.InputJsonValue,
          companySnapshot: current.companySnapshot as Prisma.InputJsonValue,
          netTotal: current.netTotal,
          taxTotal: current.taxTotal,
          grossTotal: current.grossTotal,
          paymentTermDays: current.paymentTermDays,
          customerNote: current.customerNote,
          taxNote: current.taxNote,
          taxTreatment: current.taxTreatment,
          createdById: actor.id,
          createdByName: actor.name,
        },
      });
      await tx.invoiceVersionItem.createMany({
        data: current.items.map((i) => ({ tenantId, versionId: draft.id, sortOrder: i.sortOrder, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, netAmount: i.netAmount, taxRate: i.taxRate, taxAmount: i.taxAmount, grossAmount: i.grossAmount, source: i.source, extraChargeId: i.extraChargeId, reference: i.reference })),
      });
      const log = Array.isArray(invoice.changeLog) ? (invoice.changeLog as Prisma.JsonArray) : [];
      await tx.invoice.update({ where: { id: invoiceId }, data: { changeLog: [...log, { at: new Date().toISOString(), by: actor.name, versionNo, summary: `Bearbeitung begonnen: Entwurf der Fassung ${versionNo} aus Fassung ${current.versionNo} (${info.nextKind === "CORRECTION" ? "Berichtigung, Vorfassung bereits übermittelt" : "Neufassung, Vorfassung nicht übermittelt"})` }] } });
      await recordAudit(tx, tenantId, actor, { action: "INVOICE_VERSION_CREATED", bookingId: invoice.bookingId, invoiceId, amountCents: toCents(current.grossTotal), details: { invoiceNumber: invoice.number, fromVersion: current.versionNo, toVersion: versionNo, kind: info.nextKind } });
      return tx.invoiceVersion.findUniqueOrThrow({ where: { id: draft.id }, include: withItems });
    }, TX);
  } catch (e) {
    if (isUniqueViolation(e, "versionNo")) {
      const winner = await db.invoiceVersion.findFirst({ where: { tenantId, invoiceId, status: "DRAFT" }, include: withItems });
      if (winner) return winner;
    }
    throw e;
  }
}

/** „Als an Kunden übergeben markieren“: einmalig, nur auf abgeschlossene Fassungen, nie still entfernbar (DB-Trigger). */
export async function markVersionDelivered(tenantId: string, versionId: string, actor: Actor, note?: string | null): Promise<VersionRow> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string; deliveredAt: Date | null; invoiceId: string; versionNo: number }[]>`SELECT "id", "status", "deliveredAt", "invoiceId", "versionNo" FROM "InvoiceVersion" WHERE "id" = ${versionId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Rechnungsfassung nicht gefunden.");
    if (locked[0].status !== "FINALIZED") throw new DomainError("Nur abgeschlossene Fassungen können als übergeben markiert werden.");
    if (locked[0].deliveredAt) throw new DomainError("Diese Fassung ist bereits als übergeben markiert.");
    const now = new Date();
    const v = await tx.invoiceVersion.update({ where: { id: versionId }, data: { deliveredAt: now, deliveredById: actor.id, deliveredByName: actor.name, deliveredNote: note?.trim() || null } });
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: locked[0].invoiceId } });
    await recordAudit(tx, tenantId, actor, { action: "INVOICE_DELIVERED_MANUALLY", bookingId: invoice.bookingId, invoiceId: invoice.id, amountCents: toCents(v.grossTotal), details: { invoiceNumber: invoice.number, versionNo: v.versionNo } });
    return v;
  }, TX);
}

// ---------------------------------------------------------------------------
// Entwurf bearbeiten
// ---------------------------------------------------------------------------

export type CustomerInput = Partial<Pick<InvoiceCustomerSnapshot, "type" | "companyName" | "firstName" | "lastName" | "street" | "zip" | "city" | "country" | "email">>;
export type CompanyInput = Partial<Pick<CompanySnapshot, "name" | "legalForm" | "street" | "zip" | "city" | "country" | "email" | "phone" | "vatId" | "taxNumber" | "bankName" | "iban" | "bic" | "invoiceFooter">>;

export type DraftInput = {
  items: ItemInput[];
  customerNote?: string | null;
  taxNote?: string | null;
  /** nur Schadenabrechnung: steuerliche Behandlung der Fassung, bewusst geändert */
  taxTreatment?: string | null;
  notes?: string | null;
  paymentTermDays?: number | null;
  reason?: string | null;
  servicePeriodStart?: Date | null;
  servicePeriodEnd?: Date | null;
  customer?: CustomerInput;
  company?: CompanyInput;
};

/** Der offene Entwurf einer Rechnung (Fassung 1 oder eine spätere), gesperrt. */
async function lockDraft(tx: Tx, tenantId: string, invoiceId: string) {
  const locked = await tx.$queryRaw<{ id: string; status: string; number: string | null; exportedAt: Date | null }[]>`SELECT "id", "status", "number", "exportedAt" FROM "Invoice" WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
  const draft = await tx.invoiceVersion.findFirst({ where: { tenantId, invoiceId, status: "DRAFT" }, include: withItems });
  if (!draft) throw new DomainError(`Die Rechnung ${locked[0].number ?? ""} hat keinen offenen Entwurf; sie ist abgeschlossen und kann nur über „Rechnung bearbeiten“ neu gefasst werden.`.replace("  ", " "));
  await tx.$queryRaw`SELECT "id" FROM "InvoiceVersion" WHERE "id" = ${draft.id} FOR UPDATE`;
  return { invoice: locked[0], draft };
}

const trimOrNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

/** Entwurf speichern: Positionen ersetzen, Summen neu rechnen, Kopien bewusst ändern, Änderung protokollieren. Quellen bleiben unberührt. */
export async function updateInvoiceDraft(tenantId: string, invoiceId: string, actor: Actor, input: DraftInput): Promise<VersionRow> {
  if (input.items.length === 0) throw new DomainError("Eine Rechnung braucht mindestens eine Position.");
  if (input.paymentTermDays != null && !(Number.isInteger(input.paymentTermDays) && input.paymentTermDays >= 0 && input.paymentTermDays <= 365)) throw new DomainError("Das Zahlungsziel liegt zwischen 0 und 365 Tagen.");
  if (input.servicePeriodStart && input.servicePeriodEnd && input.servicePeriodEnd.getTime() < input.servicePeriodStart.getTime()) throw new DomainError("Das Ende des Leistungszeitraums liegt vor dem Beginn.");
  return db.$transaction(async (tx) => {
    const { draft } = await lockDraft(tx, tenantId, invoiceId);
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    // Steuerliche Behandlung (nur Schadenabrechnung): bleibt wie in der Fassung, bis sie bewusst geändert wird
    let taxTreatment = draft.taxTreatment;
    if (input.taxTreatment !== undefined && (input.taxTreatment ?? null) !== (draft.taxTreatment ?? null)) {
      if (invoice.kind !== "DAMAGE") throw new DomainError("Die steuerliche Behandlung wird nur bei Schadenabrechnungen festgelegt.");
      if (!input.taxTreatment || !(input.taxTreatment in DAMAGE_TAX_TREATMENTS)) throw new DomainError("Bitte die steuerliche Behandlung der Schadenabrechnung auswählen.");
      taxTreatment = input.taxTreatment;
    }
    const nonTaxable = taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION";
    // Erlaubte Sätze: konfigurierter Standardsatz, 0 % und alle Sätze, die die Fassung bereits enthält (Korrektur ändert keine Steuerlogik)
    const allowedRates = new Set([toBasisPoints(tenant.defaultTaxRate ?? 0), 0, ...draft.items.map((i) => toBasisPoints(i.taxRate))]);
    const mode = draft.pricesIncludeTax ? "GROSS" : "NET";
    const before = new Map(draft.items.map((i) => [i.id, i]));
    const computed = input.items.map((it) => {
      const prev = it.id ? before.get(it.id) : undefined;
      // Echter Schadensersatz: keine Position trägt einen Steuersatz – unabhängig von der Eingabe
      const ci = computeItem(mode, { ...it, taxRate: nonTaxable ? "0" : it.taxRate, source: prev?.source as ItemInput["source"] | undefined ?? "MANUAL", extraChargeId: prev?.extraChargeId ?? null, reference: prev?.reference ?? it.reference ?? null });
      if (!nonTaxable && !allowedRates.has(ci.taxRateBp)) throw new DomainError(`Position „${ci.description}“: Der Steuersatz ${fmtRate(ci.taxRateBp)} ist nicht konfiguriert. Erlaubt sind ${[...allowedRates].map(fmtRate).join(" und ")}.`);
      return ci;
    });
    const totals = summarize(computed.map((ci) => ({ taxRateBp: ci.taxRateBp, amounts: ci.amounts })));

    const changes: string[] = [];
    const kept = new Set(input.items.map((i) => i.id).filter(Boolean));
    for (const old of draft.items) if (!kept.has(old.id)) changes.push(`Position entfernt: ${old.description} (${fmtCents(toCents(old.grossAmount))})`);
    input.items.forEach((it, i) => {
      const old = it.id ? before.get(it.id) : undefined;
      const ci = computed[i];
      if (!old) changes.push(`Position hinzugefügt: ${ci.description} (${fmtCents(ci.amounts.gross)})`);
      else if (old.description !== ci.description || toCents(old.grossAmount) !== ci.amounts.gross || toBasisPoints(old.taxRate) !== ci.taxRateBp || toHundredths(old.quantity) !== ci.quantityH) changes.push(`Position geändert: ${old.description} (${fmtCents(toCents(old.grossAmount))}) zu ${ci.description} (${fmtCents(ci.amounts.gross)}, ${fmtRate(ci.taxRateBp)})`);
    });
    const customerNote = input.customerNote === undefined ? draft.customerNote : input.customerNote?.trim() || null;
    // Bei echtem Schadensersatz ist der Hinweistext fest; sonst freier Steuerhinweis für 0-%-Positionen
    const taxNote = nonTaxable ? DAMAGE_TAX_NOTES.NON_TAXABLE_DAMAGE_COMPENSATION : input.taxNote === undefined ? draft.taxNote : input.taxNote?.trim() || null;
    if ((taxTreatment ?? null) !== (draft.taxTreatment ?? null)) changes.push(`Steuerliche Behandlung: ${DAMAGE_TAX_TREATMENTS[taxTreatment as DamageTaxTreatment]}`);
    const reason = input.reason === undefined ? draft.reason : input.reason?.trim() || null;
    const paymentTermDays = input.paymentTermDays === undefined ? draft.paymentTermDays : input.paymentTermDays;
    const servicePeriodStart = input.servicePeriodStart ?? draft.servicePeriodStart;
    const servicePeriodEnd = input.servicePeriodEnd ?? draft.servicePeriodEnd;
    if ((draft.customerNote ?? "") !== (customerNote ?? "")) changes.push("Rechnungstext geändert");
    if ((draft.taxNote ?? "") !== (taxNote ?? "")) changes.push("Steuerhinweis geändert");
    if ((draft.reason ?? "") !== (reason ?? "")) changes.push("Änderungsgrund erfasst");
    if ((draft.paymentTermDays ?? null) !== (paymentTermDays ?? null)) changes.push(`Zahlungsziel: ${paymentTermDays ?? "keines"}`);
    if (servicePeriodStart.getTime() !== draft.servicePeriodStart.getTime() || servicePeriodEnd.getTime() !== draft.servicePeriodEnd.getTime()) changes.push("Leistungszeitraum geändert");

    // Kopien bewusst ändern: nur mitgeschickte Felder, alles andere bleibt wie in der Fassung
    const customer = { ...(draft.customerSnapshot as InvoiceCustomerSnapshot) };
    if (input.customer) {
      for (const k of Object.keys(input.customer) as (keyof CustomerInput)[]) {
        const v = trimOrNull(input.customer[k] as string | null | undefined);
        if (v === undefined) continue;
        if (k === "firstName" || k === "lastName" || k === "type" || k === "country") (customer as Record<string, unknown>)[k] = v ?? "";
        else (customer as Record<string, unknown>)[k] = v;
      }
      if (JSON.stringify(customer) !== JSON.stringify(draft.customerSnapshot)) changes.push("Rechnungsempfänger geändert");
    }
    const company = { ...(draft.companySnapshot as CompanySnapshot) };
    if (input.company) {
      for (const k of Object.keys(input.company) as (keyof CompanyInput)[]) {
        const v = trimOrNull(input.company[k] as string | null | undefined);
        if (v === undefined) continue;
        if (k === "name" || k === "country") (company as Record<string, unknown>)[k] = v ?? "";
        else (company as Record<string, unknown>)[k] = v;
      }
      if (JSON.stringify(company) !== JSON.stringify(draft.companySnapshot)) changes.push("Rechnungsstellerdaten geändert");
    }
    const notes = input.notes === undefined ? undefined : input.notes?.trim() || null;

    await tx.invoiceVersionItem.deleteMany({ where: { tenantId, versionId: draft.id } });
    await tx.invoiceVersionItem.createMany({ data: computed.map((ci, i) => itemData(tenantId, draft.id, i, ci)) });
    const log = Array.isArray(invoice.changeLog) ? (invoice.changeLog as Prisma.JsonArray) : [];
    await tx.invoice.update({ where: { id: invoiceId }, data: { ...(notes === undefined ? {} : { notes }), changeLog: changes.length > 0 ? [...log, { at: new Date().toISOString(), by: actor.name, versionNo: draft.versionNo, summary: changes.join("; ") }] : log } });
    return tx.invoiceVersion.update({
      where: { id: draft.id },
      data: {
        netTotal: centsToDecimalString(totals.total.net),
        taxTotal: centsToDecimalString(totals.total.tax),
        grossTotal: centsToDecimalString(totals.total.gross),
        customerNote,
        taxNote,
        taxTreatment,
        reason,
        paymentTermDays,
        servicePeriodStart,
        servicePeriodEnd,
        customerSnapshot: customer as unknown as Prisma.InputJsonValue,
        companySnapshot: company as unknown as Prisma.InputJsonValue,
      },
    });
  }, TX);
}

// ---------------------------------------------------------------------------
// Prüfung und Abschluss
// ---------------------------------------------------------------------------

export type InvoiceIssue = { code: string; severity: "error" | "warning"; message: string };

async function collectIssues(tx: Tx, tenantId: string, invoice: InvoiceRow, draft: VersionWithItems, mode: EditModeInfo | null): Promise<InvoiceIssue[]> {
  const issues: InvoiceIssue[] = [];
  const err = (code: string, message: string) => issues.push({ code, severity: "error", message });
  const warn = (code: string, message: string) => issues.push({ code, severity: "warning", message });
  const booking = await tx.booking.findFirst({ where: { id: invoice.bookingId, tenantId }, include: { contract: { select: { status: true } } } });
  if (!booking) err("BOOKING_MISSING", "Buchung nicht gefunden.");
  if (draft.versionNo === 1 && invoice.kind === "DAMAGE") {
    // Schadenabrechnung: braucht Vertrag (Rechnungsempfänger) und eine Schadenakte mit bestätigter Kundenverantwortung
    if (booking && booking.contract?.status !== "SIGNED") err("CONTRACT", "Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag.");
    const dc = invoice.damageCaseId ? await tx.damageCase.findFirst({ where: { id: invoice.damageCaseId, tenantId } }) : null;
    if (!dc) err("DAMAGE_CASE", "Zu dieser Abrechnung gibt es keine Schadenakte.");
    else if (dc.liabilityStatus !== "CUSTOMER_RESPONSIBILITY_CONFIRMED") err("LIABILITY", "Die Haftung des Kunden ist in der Schadenakte nicht (mehr) bestätigt.");
    if (!draft.taxTreatment) err("TAX_TREATMENT", "Die steuerliche Behandlung der Kundenbelastung ist nicht festgelegt.");
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  } else if (draft.versionNo === 1) {
    if (booking && booking.status !== "RETURNED") err("BOOKING_STATUS", "Die Buchung ist nicht zurückgegeben.");
    if (booking && booking.contract?.status !== "SIGNED") err("CONTRACT", "Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag.");
    const ret = invoice.returnHandoverId ? await tx.handover.findFirst({ where: { id: invoice.returnHandoverId, tenantId, status: "FINALIZED" } }) : null;
    if (!ret) err("RETURN", "Zu dieser Rechnung gibt es keine abgeschlossene Rückgabe.");
    const other = await tx.invoice.count({ where: { tenantId, bookingId: invoice.bookingId, kind: "RENTAL", status: "FINALIZED", id: { not: invoice.id } } });
    if (other > 0) err("INVOICE_EXISTS", "Zu dieser Buchung gibt es bereits eine abgeschlossene Mietrechnung.");
    // Fassung 1 friert die Firmendaten beim Abschluss aus den Einstellungen ein: dort müssen sie vollständig sein
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  } else {
    // spätere Fassungen prüfen ihre eigene Kopie der Firmendaten
    for (const m of companySnapshotMissing(draft.companySnapshot as CompanySnapshot)) err("COMPANY", `Rechnungsstellerdaten unvollständig: ${m}.`);
    if (invoice.exportedAt || mode?.exported) err("EXPORTED", "Diese Rechnung wurde bereits buchhalterisch exportiert. Eine Änderung unter derselben Rechnungsnummer ist nicht mehr möglich.");
    if (mode?.delivered && !(draft.reason && draft.reason.trim().length >= 3)) err("REASON", "Der Kunde hat bereits eine frühere Fassung dieser Rechnung erhalten. Bitte den Grund der Berichtigung angeben.");
  }
  const c = draft.customerSnapshot as InvoiceCustomerSnapshot;
  const name = c.type === "COMPANY" ? c.companyName : `${c.firstName} ${c.lastName}`.trim();
  if (!name) err("CUSTOMER_NAME", "Der Rechnungsempfänger hat keinen Namen.");
  if (!c.street || !c.zip || !c.city) err("CUSTOMER_ADDRESS", "Die Anschrift des Rechnungsempfängers ist unvollständig (Straße, PLZ, Ort).");
  if (draft.servicePeriodEnd.getTime() < draft.servicePeriodStart.getTime()) err("PERIOD", "Das Ende des Leistungszeitraums liegt vor dem Beginn.");

  if (draft.items.length === 0) err("NO_ITEMS", "Die Rechnung hat keine Position.");
  const totals = totalsOf(draft.items);
  if (totals.total.net !== toCents(draft.netTotal) || totals.total.tax !== toCents(draft.taxTotal) || totals.total.gross !== toCents(draft.grossTotal)) err("TOTALS", "Die Gesamtbeträge passen nicht zu den Positionen.");
  for (const it of draft.items) {
    const expected = lineAmounts(draft.pricesIncludeTax ? "GROSS" : "NET", toHundredths(it.quantity), toCents(it.unitPrice), toBasisPoints(it.taxRate));
    if (expected.net !== toCents(it.netAmount) || expected.tax !== toCents(it.taxAmount) || expected.gross !== toCents(it.grossAmount)) err("ITEM_AMOUNTS", `Position „${it.description}“: Beträge und Steuer sind nicht konsistent.`);
    if (draft.versionNo === 1 && it.source === "EXTRA_CHARGE" && it.extraChargeId) {
      const ec = await tx.extraCharge.findFirst({ where: { id: it.extraChargeId, tenantId } });
      if (!ec || ec.handoverId !== invoice.returnHandoverId) err("EXTRA_CHARGE", `Position „${it.description}“ verweist auf keine bestätigte Zusatzkostenposition dieser Rückgabe.`);
    }
  }
  if (invoice.kind === "DAMAGE") {
    // Steuersemantik der Schadenabrechnung: nicht steuerbar ≠ 0 % ≠ steuerfrei. Die Behandlung ist Teil jeder Fassung.
    if (!draft.taxTreatment || !(draft.taxTreatment in DAMAGE_TAX_TREATMENTS)) err("TAX_TREATMENT", "Die steuerliche Behandlung dieser Fassung ist nicht festgelegt.");
    else if (draft.taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION" && draft.items.some((it) => toBasisPoints(it.taxRate) !== 0)) err("TAX_TREATMENT_ITEMS", "Echter Schadensersatz ist nicht steuerbar; die Positionen dürfen keinen Steuersatz tragen.");
  }
  if (draft.taxTreatment !== "NON_TAXABLE_DAMAGE_COMPENSATION" && draft.items.some((it) => toBasisPoints(it.taxRate) === 0) && !draft.taxNote?.trim()) err("TAX_NOTE", "Es gibt Positionen mit 0 % Steuer. Bitte den Steuerhinweis für die Rechnung angeben.");
  if (totals.total.gross === 0) warn("ZERO", "Der Rechnungsbetrag ist 0,00 €.");
  if (mode && mode.paidCents > totals.total.gross) warn("OVERPAID", `Für diese Rechnung wurden bereits ${fmtCents(mode.paidCents)} Zahlungen dokumentiert. Der neue Rechnungsbetrag beträgt ${fmtCents(totals.total.gross)}. Dadurch entsteht eine Überzahlung von ${fmtCents(mode.paidCents - totals.total.gross)}. Rent-Base führt keine automatische Erstattung durch.`);
  return issues;
}

export type InvoiceState = {
  invoice: InvoiceRow;
  /** offener Entwurf, falls vorhanden */
  draft: VersionWithItems | null;
  /** aktuelle abgeschlossene Fassung, falls vorhanden */
  current: VersionWithItems | null;
  versions: VersionRow[];
  issues: InvoiceIssue[];
  allowedRates: number[];
  mode: EditModeInfo | null;
};

export async function getInvoiceState(tenantId: string, invoiceId: string): Promise<InvoiceState> {
  return db.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId } });
    if (!invoice) throw new DomainError("Rechnung nicht gefunden.");
    const versions = await tx.invoiceVersion.findMany({ where: { tenantId, invoiceId }, orderBy: { versionNo: "asc" } });
    const draft = await tx.invoiceVersion.findFirst({ where: { tenantId, invoiceId, status: "DRAFT" }, include: withItems });
    const current = invoice.currentVersionId ? await tx.invoiceVersion.findFirst({ where: { id: invoice.currentVersionId, tenantId }, include: withItems }) : null;
    const mode = current ? await editModeOf(tx, tenantId, invoice, current) : null;
    const issues = draft ? await collectIssues(tx, tenantId, invoice, draft, draft.versionNo > 1 ? mode : null) : [];
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const rates = new Set([toBasisPoints(tenant.defaultTaxRate ?? 0), 0, ...(draft?.items ?? []).map((i) => toBasisPoints(i.taxRate))]);
    return { invoice, draft, current, versions, issues, allowedRates: [...rates].sort((a, b) => b - a).map((bp) => bp / 100), mode };
  }, TX);
}

/** Versiegelter Inhalt einer Fassung (Grundlage der Prüfsumme). */
function sealedContent(invoice: { number: string | null; bookingId: string; contractId: string | null; returnHandoverId: string | null }, v: VersionWithItems) {
  return {
    number: invoice.number,
    versionNo: v.versionNo,
    kind: v.kind,
    supersedesVersionId: v.supersedesVersionId,
    reason: v.reason,
    bookingId: invoice.bookingId,
    contractId: invoice.contractId,
    returnHandoverId: invoice.returnHandoverId,
    issueDate: v.issueDate,
    correctionDate: v.correctionDate,
    servicePeriodStart: v.servicePeriodStart,
    servicePeriodEnd: v.servicePeriodEnd,
    currency: v.currency,
    pricesIncludeTax: v.pricesIncludeTax,
    customer: v.customerSnapshot,
    company: v.companySnapshot,
    netTotal: String(v.netTotal),
    taxTotal: String(v.taxTotal),
    grossTotal: String(v.grossTotal),
    paymentTermDays: v.paymentTermDays,
    paymentDueDate: v.paymentDueDate,
    customerNote: v.customerNote,
    taxNote: v.taxNote,
    ...(v.taxTreatment ? { taxTreatment: v.taxTreatment } : {}),
    items: [...v.items].sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({ description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: String(i.unitPrice), netAmount: String(i.netAmount), taxRate: String(i.taxRate), taxAmount: String(i.taxAmount), grossAmount: String(i.grossAmount), source: i.source, extraChargeId: i.extraChargeId })),
  };
}

/** Prüfsumme der Fassung 1 aus Phase 8/9 (vor der Fassungsarchitektur), damit bestehende Prüfsummen weiter verifizierbar sind. */
function legacySealedContent(invoice: { number: string | null; bookingId: string; contractId: string | null; returnHandoverId: string | null }, v: VersionWithItems) {
  const s = sealedContent(invoice, v);
  return { number: s.number, bookingId: s.bookingId, contractId: s.contractId, returnHandoverId: s.returnHandoverId, issueDate: s.issueDate, servicePeriodStart: s.servicePeriodStart, servicePeriodEnd: s.servicePeriodEnd, currency: s.currency, pricesIncludeTax: s.pricesIncludeTax, customer: s.customer, company: s.company, netTotal: s.netTotal, taxTotal: s.taxTotal, grossTotal: s.grossTotal, paymentTermDays: s.paymentTermDays, paymentDueDate: s.paymentDueDate, customerNote: s.customerNote, taxNote: s.taxNote, items: s.items };
}

// ---------------------------------------------------------------------------
// Strukturierte Differenz zweier Fassungen
// ---------------------------------------------------------------------------

export type VersionDiffEntry = { field: string; label: string; before: string | null; after: string | null };
export type VersionDiff = { fromVersion: number; toVersion: number; entries: VersionDiffEntry[]; grossBefore: string; grossAfter: string };

const addr = (s: { street?: string | null; zip?: string | null; city?: string | null; country?: string | null }) => [s.street, [s.zip, s.city].filter(Boolean).join(" "), s.country && s.country !== "DE" ? s.country : null].filter(Boolean).join(", ");
const custName = (c: InvoiceCustomerSnapshot) => (c.type === "COMPANY" && c.companyName ? [c.companyName, `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()].filter(Boolean).join(", ") : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim());
const dt = (d: Date) => d.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const money = (v: unknown) => fmtCents(toCents(v));

export function diffVersions(prev: VersionWithItems, next: VersionWithItems): VersionDiff {
  const entries: VersionDiffEntry[] = [];
  const push = (field: string, label: string, before: string | null, after: string | null) => { if ((before ?? "") !== (after ?? "")) entries.push({ field, label, before: before || null, after: after || null }); };
  const pc = prev.customerSnapshot as InvoiceCustomerSnapshot, nc = next.customerSnapshot as InvoiceCustomerSnapshot;
  push("customer.name", "Rechnungsempfänger", custName(pc), custName(nc));
  push("customer.address", "Anschrift", addr(pc), addr(nc));
  push("customer.email", "E-Mail des Empfängers", pc.email, nc.email);
  push("customer.number", "Kundennummer", pc.number, nc.number);
  const pf = prev.companySnapshot as CompanySnapshot, nf = next.companySnapshot as CompanySnapshot;
  push("company.name", "Rechnungssteller", [pf.name, pf.legalForm].filter(Boolean).join(" "), [nf.name, nf.legalForm].filter(Boolean).join(" "));
  push("company.address", "Anschrift des Rechnungsstellers", addr(pf), addr(nf));
  push("company.tax", "Steuernummer / USt-IdNr.", [pf.taxNumber, pf.vatId].filter(Boolean).join(" / "), [nf.taxNumber, nf.vatId].filter(Boolean).join(" / "));
  push("company.bank", "Bankverbindung", [pf.bankName, pf.iban, pf.bic].filter(Boolean).join(" · "), [nf.bankName, nf.iban, nf.bic].filter(Boolean).join(" · "));
  push("company.footer", "Fußtext", pf.invoiceFooter, nf.invoiceFooter);
  push("servicePeriod", "Leistungszeitraum", `${dt(prev.servicePeriodStart)} – ${dt(prev.servicePeriodEnd)}`, `${dt(next.servicePeriodStart)} – ${dt(next.servicePeriodEnd)}`);
  push("paymentTermDays", "Zahlungsziel (Tage)", prev.paymentTermDays == null ? null : String(prev.paymentTermDays), next.paymentTermDays == null ? null : String(next.paymentTermDays));
  push("customerNote", "Rechnungstext", prev.customerNote, next.customerNote);
  push("taxNote", "Steuerhinweis", prev.taxNote, next.taxNote);
  push("taxTreatment", "Steuerliche Behandlung", prev.taxTreatment ? DAMAGE_TAX_TREATMENTS[prev.taxTreatment as DamageTaxTreatment] ?? prev.taxTreatment : null, next.taxTreatment ? DAMAGE_TAX_TREATMENTS[next.taxTreatment as DamageTaxTreatment] ?? next.taxTreatment : null);
  push("pricesIncludeTax", "Preisbasis", prev.pricesIncludeTax ? "brutto" : "netto", next.pricesIncludeTax ? "brutto" : "netto");
  // Positionen: nach Reihenfolge verglichen (Beschreibung, Menge, Einzelpreis, Steuersatz, Beträge)
  const pi = [...prev.items].sort((a, b) => a.sortOrder - b.sortOrder), ni = [...next.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const line = (i: VersionWithItems["items"][number]) => `${i.description} · ${Number(i.quantity).toLocaleString("de-DE")} ${i.unit} × ${money(i.unitPrice)} · ${fmtRate(toBasisPoints(i.taxRate))} · Steuer ${money(i.taxAmount)} · ${money(i.grossAmount)}`;
  for (let k = 0; k < Math.max(pi.length, ni.length); k++) push(`item.${k + 1}`, `Position ${k + 1}`, pi[k] ? line(pi[k]) : null, ni[k] ? line(ni[k]) : null);
  push("netTotal", "Nettobetrag", money(prev.netTotal), money(next.netTotal));
  push("taxTotal", "Steuerbetrag", money(prev.taxTotal), money(next.taxTotal));
  push("grossTotal", "Rechnungsbetrag", money(prev.grossTotal), money(next.grossTotal));
  return { fromVersion: prev.versionNo, toVersion: next.versionNo, entries, grossBefore: money(prev.grossTotal), grossAfter: money(next.grossTotal) };
}

// ---------------------------------------------------------------------------
// Abschluss
// ---------------------------------------------------------------------------

export type FinalizeOptions = { reason?: string | null; confirmOverpayment?: boolean };

/**
 * Abschluss des offenen Entwurfs. Fassung 1: Nummer vergeben, Rechnungsdatum setzen, Firmendaten aus den Einstellungen
 * einfrieren. Fassung n+1: Fassungsart erneut aus dem tatsächlichen Übermittlungsstand der Vorfassung bestimmt (ein
 * zwischenzeitlicher Versand macht aus der Neufassung eine Berichtigung), Grund bei Berichtigung Pflicht, Überzahlung
 * nur mit ausdrücklicher Bestätigung, Differenz zur Vorfassung gespeichert. Rechnung und Entwurf sind gesperrt; ein
 * veralteter Entwurf (nicht Nachfolger der aktuellen Fassung) wird abgewiesen. Eine Nummer wird nie wiederverwendet.
 */
export async function finalizeInvoice(tenantId: string, invoiceId: string, actor: Actor, opts: FinalizeOptions = {}): Promise<VersionWithItems> {
  return withNumberRetry(() =>
    db.$transaction(async (tx) => {
      const { invoice: lockedInv, draft: draft0 } = await lockDraft(tx, tenantId, invoiceId);
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: lockedInv.id } });
      let draft = draft0;
      if (opts.reason !== undefined && (opts.reason?.trim() || "") !== (draft.reason ?? "")) {
        draft = await tx.invoiceVersion.update({ where: { id: draft.id }, data: { reason: opts.reason?.trim() || null }, include: withItems });
      }
      const current = invoice.currentVersionId ? await tx.invoiceVersion.findFirstOrThrow({ where: { id: invoice.currentVersionId, tenantId }, include: withItems }) : null;
      const mode = current ? await editModeOf(tx, tenantId, invoice, current) : null;
      if (draft.versionNo > 1) {
        if (!current) throw new DomainError("Die Rechnung hat keine aktuelle Fassung.");
        if (draft.supersedesVersionId !== current.id) throw new DomainError("Dieser Entwurf basiert nicht mehr auf der aktuellen Fassung. Bitte den Entwurf verwerfen und die Bearbeitung neu beginnen.");
        // Fassungsart folgt dem tatsächlichen Übermittlungsstand der Vorfassung zum Zeitpunkt des Abschlusses
        const kind: VersionKind = mode!.delivered ? "CORRECTION" : "REVISION";
        if (kind !== draft.kind) draft = await tx.invoiceVersion.update({ where: { id: draft.id }, data: { kind }, include: withItems });
      }
      const problems = (await collectIssues(tx, tenantId, invoice, draft, draft.versionNo > 1 ? mode : null)).filter((i) => i.severity === "error");
      if (problems.length > 0) throw new DomainError(problems.length === 1 ? problems[0].message : `${problems[0].message} (und ${problems.length - 1} weitere Punkte)`);
      const newGross = toCents(draft.grossTotal);
      if (mode && mode.paidCents > newGross && !opts.confirmOverpayment) {
        throw new DomainError(`Für diese Rechnung wurden bereits ${fmtCents(mode.paidCents)} Zahlungen dokumentiert. Der neue Rechnungsbetrag beträgt ${fmtCents(newGross)}. Dadurch entsteht eine Überzahlung von ${fmtCents(mode.paidCents - newGross)}. Rent-Base führt keine automatische Erstattung durch. Bitte die Überzahlung ausdrücklich bestätigen.`);
      }

      const now = new Date();
      let number = invoice.number;
      let companySnapshot = draft.companySnapshot as Prisma.InputJsonValue;
      let issueDate = draft.issueDate;
      if (draft.versionNo === 1) {
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
        number = await nextInvoiceNumber(tx, tenantId, now);
        companySnapshot = companySnapshotOf(tenant) as unknown as Prisma.InputJsonValue;
        issueDate = now;
      }
      // Zahlungsziel läuft ab dem Abschluss der jeweiligen Fassung (bei einer Berichtigung ab dem Berichtigungsdatum)
      const paymentDueDate = draft.paymentTermDays != null ? new Date(now.getTime() + draft.paymentTermDays * 86400_000) : null;
      const sealedBase = await tx.invoiceVersion.update({
        where: { id: draft.id },
        data: { issueDate, correctionDate: draft.versionNo > 1 ? now : null, paymentDueDate, companySnapshot },
        include: withItems,
      });
      const hash = contentHash(sealedContent({ ...invoice, number }, sealedBase));
      const diff = current ? diffVersions(current, sealedBase) : null;
      const finalized = await tx.invoiceVersion.update({
        where: { id: draft.id },
        data: { status: "FINALIZED", finalizedAt: now, finalizedById: actor.id, finalizedByName: actor.name, contentHash: hash, diffFromPrevious: diff ? (diff as unknown as Prisma.InputJsonValue) : undefined },
        include: withItems,
      });
      const log = Array.isArray(invoice.changeLog) ? (invoice.changeLog as Prisma.JsonArray) : [];
      const summary = draft.versionNo === 1
        ? `Abgeschlossen als ${number} (Fassung 1)`
        : `Fassung ${draft.versionNo} abgeschlossen (${finalized.kind === "CORRECTION" ? "Berichtigung" : "Neufassung"}, ${diff!.entries.length} Änderungen, Betrag ${diff!.grossBefore} → ${diff!.grossAfter})${finalized.reason ? `: ${finalized.reason}` : ""}`;
      if (draft.versionNo === 1) {
        await tx.invoice.update({ where: { id: invoice.id }, data: { number, status: "FINALIZED", finalizedAt: now, currentVersionId: finalized.id, changeLog: [...log, { at: now.toISOString(), by: actor.name, versionNo: 1, summary }] } });
      } else {
        await tx.invoice.update({ where: { id: invoice.id }, data: { currentVersionId: finalized.id, changeLog: [...log, { at: now.toISOString(), by: actor.name, versionNo: draft.versionNo, summary }] } });
        await recordAudit(tx, tenantId, actor, {
          action: finalized.kind === "CORRECTION" ? "INVOICE_CORRECTED" : "INVOICE_REVISED",
          bookingId: invoice.bookingId,
          invoiceId: invoice.id,
          amountCents: newGross,
          details: { invoiceNumber: number, fromVersion: current!.versionNo, toVersion: finalized.versionNo, grossBefore: toCents(current!.grossTotal), grossAfter: newGross, paidCents: mode!.paidCents, overpaidCents: Math.max(0, mode!.paidCents - newGross), reason: finalized.reason, changes: diff!.entries.length },
        });
      }
      return finalized;
    }, TX),
  ).catch((e) => {
    if (isUniqueViolation(e, "damageCaseId")) throw new DomainError("Zu dieser Schadenakte gibt es bereits eine Schadenabrechnung.");
    if (isUniqueViolation(e, "bookingId")) throw new DomainError("Zu dieser Buchung gibt es bereits eine abgeschlossene Mietrechnung.");
    throw e;
  });
}

/** Prüfsumme einer Fassung nachrechnen. Fassung 1 aus der Zeit vor den Fassungen wird mit dem damaligen Inhalt geprüft. */
export async function verifyVersion(tenantId: string, versionId: string) {
  const v = await db.invoiceVersion.findFirst({ where: { id: versionId, tenantId }, include: withItems });
  if (!v) throw new DomainError("Rechnungsfassung nicht gefunden.");
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: v.invoiceId } });
  const current = contentHash(sealedContent(invoice, v));
  const legacy = contentHash(legacySealedContent(invoice, v));
  const intact = v.status === "FINALIZED" && (v.contentHash === current || v.contentHash === legacy);
  return { finalized: v.status === "FINALIZED", storedHash: v.contentHash, currentHash: current, intact, legacyHash: legacy };
}

/** Prüfsumme der aktuellen Fassung einer Rechnung. */
export async function verifyInvoice(tenantId: string, invoiceId: string) {
  const inv = await db.invoice.findFirst({ where: { id: invoiceId, tenantId } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  if (!inv.currentVersionId) return { finalized: false, storedHash: null, currentHash: null, intact: false };
  return verifyVersion(tenantId, inv.currentVersionId);
}

/** Entwurf verwerfen: Fassung 1 → ganze Rechnung, spätere Fassung → nur der Entwurf. Abgeschlossene Fassungen bleiben immer. */
export async function discardInvoiceDraft(tenantId: string, invoiceId: string, actor?: Actor) {
  return db.$transaction(async (tx) => {
    const { draft } = await lockDraft(tx, tenantId, invoiceId);
    await tx.invoiceVersionItem.deleteMany({ where: { tenantId, versionId: draft.id } });
    await tx.invoiceVersion.delete({ where: { id: draft.id } });
    if (draft.versionNo === 1) {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      await tx.invoiceItem.deleteMany({ where: { tenantId, invoiceId } });
      await tx.invoice.delete({ where: { id: invoiceId } });
      if (inv.kind === "DAMAGE" && inv.damageCaseId) {
        // Schadenabrechnung verworfen: die Kundenbelastung an der Akte wird wieder frei, damit sie neu festgelegt werden kann
        const c = await tx.damageCase.findFirst({ where: { id: inv.damageCaseId, tenantId } });
        if (c && c.customerChargeCents != null) {
          await tx.damageCase.update({ where: { id: c.id }, data: { customerChargeCents: null, customerChargeBasis: null, customerChargeTaxTreatment: null, customerChargeAt: null, customerChargeByName: null } });
          await tx.damageCaseEvent.create({ data: { tenantId, caseId: c.id, type: "NOTE_ADDED", note: "Entwurf der Schadenabrechnung verworfen; Kundenbelastung zurückgesetzt", userId: actor?.id ?? null, userName: actor?.name ?? null } });
        }
      }
      return { invoiceDeleted: true, versionNo: 1 };
    }
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const log = Array.isArray(invoice.changeLog) ? (invoice.changeLog as Prisma.JsonArray) : [];
    await tx.invoice.update({ where: { id: invoiceId }, data: { changeLog: [...log, { at: new Date().toISOString(), by: actor?.name ?? "–", versionNo: draft.versionNo, summary: `Entwurf der Fassung ${draft.versionNo} verworfen` }] } });
    return { invoiceDeleted: false, versionNo: draft.versionNo };
  }, TX);
}

/** Fassungen einer Rechnung mit Übermittlungsstand (für Anzeige und Listen). */
export async function listVersions(tenantId: string, invoiceId: string) {
  const versions = await db.invoiceVersion.findMany({ where: { tenantId, invoiceId }, orderBy: { versionNo: "asc" } });
  const sent = await db.emailLog.findMany({ where: { tenantId, invoiceVersionId: { in: versions.map((v) => v.id) }, status: "SENT" }, orderBy: { sentAt: "asc" }, select: { invoiceVersionId: true, sentAt: true, recipient: true } });
  return versions.map((v) => {
    const s = sent.find((x) => x.invoiceVersionId === v.id);
    return { ...v, sentAt: s?.sentAt ?? null, sentTo: s?.recipient ?? null, delivered: !!s || !!v.deliveredAt };
  });
}
