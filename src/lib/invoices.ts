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

import { logoRefOf, type LogoRef } from "@/lib/branding-ref";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ACCIDENT_BILLING_TYPES, DAMAGE_TAX_NOTES, CANCELLATION_FEE_TAX_NOTE, CANCELLATION_FEE_TAX_TREATMENTS, DAMAGE_TAX_TREATMENTS, INVOICE_RECIPIENT_ROLES, accidentBillingOf, recipientRoleOf, type AccidentBilling, type AccidentBillingType, type DamageTaxTreatment, type InvoiceRecipientRole } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { EXTRA_CHARGE_TYPES, INVOICE_ITEM_SOURCES, INVOICE_STATUS, INVOICE_UNITS, type ExtraChargeType } from "@/lib/constants";
import type { CustomerSnapshot, VehicleSnapshot } from "@/lib/contracts";
import { DomainError, contentHash, sha256 } from "@/lib/integrity";
import { centsToDecimalString, fmtCents, fmtRate, lineAmounts, summarize, toBasisPoints, toCents, toHundredths, type Cents } from "@/lib/money";
import { isUniqueViolation, nextInvoiceNumber, withNumberRetry } from "@/lib/numbering";
import { rentalDays } from "@/lib/pricing";
import { ACCIDENT_CASE_CLOSED_MESSAGE, accidentCaseClosed, accidentCaseEvent, assertAccidentCaseOpen, assertAccidentInvoiceCaseOpen } from "@/lib/accident-replacement-events";
import { contractTariffItems } from "@/lib/accident-pricing";
import { overlayAmendments } from "@/lib/amendments";
import { linkRentalPaymentsToInvoice, lockUnlinkedRentalPayments } from "@/lib/rental-payment-link";
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
  website?: string | null;
  logo?: LogoRef | null;
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
  /** Befehl 29: Rolle des Rechnungsempfängers (ohne Angabe = Mieter). Teil der versiegelten Kopie (sealedContent nimmt die ganze Kopie). */
  recipientRole?: InvoiceRecipientRole;
  /** Schadennummer der Versicherung (Empfänger INSURER) */
  claimNumber?: string | null;
  /** Geschädigter/Mieter, wenn der Empfänger nicht der Mieter ist */
  insuredName?: string | null;
  /** Unfalldatum (ISO) */
  accidentDate?: string | null;
  /** Unfallersatz-Fallnummer UE-… */
  caseNumber?: string | null;
  /** Phase F: Abrechnungsart (Zwischen-/Schlussrechnung, Restforderung) – versiegelt, über Fassungen unverändert */
  accidentBilling?: AccidentBilling;
};

export { recipientRoleOf, accidentBillingOf, ACCIDENT_BILLING_TYPES, type AccidentBilling, type AccidentBillingType };

type TenantRow = Prisma.TenantGetPayload<object>;

export function companySnapshotOf(t: TenantRow): CompanySnapshot {
  // Befehl 20.5: Logo-Verweis wird mit eingefroren (neue Fassungen); ältere Snapshots haben keinen und bleiben ohne Logo
  return { name: t.name, legalForm: t.legalForm, street: t.street, zip: t.zip, city: t.city, country: t.country, email: t.email, phone: t.phone, vatId: t.vatId, taxNumber: t.taxNumber, bankName: t.bankName, iban: t.iban, bic: t.bic, invoiceFooter: t.invoiceFooter, website: t.website, logo: logoRefOf(t) };
}

/** Befehl 23.1: Rechnungsempfänger direkt aus dem Kundenstamm (freie Rechnung) – nur Rechnungsdaten, keine Ausweis-/Führerscheindaten. */
export function customerSnapshotFromCustomer(c: { number: string | null; type: string; companyName: string | null; firstName: string; lastName: string; street: string | null; zip: string | null; city: string | null; country: string | null; email: string | null }): InvoiceCustomerSnapshot {
  return { number: c.number ?? null, type: c.type ?? "PRIVATE", companyName: c.companyName ?? null, firstName: c.firstName ?? "", lastName: c.lastName ?? "", street: c.street ?? null, zip: c.zip ?? null, city: c.city ?? null, country: c.country ?? "DE", email: c.email ?? null };
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
  source?: "RENTAL" | "EXTRA_CHARGE" | "AMENDMENT" | "MANUAL";
  extraChargeId?: string | null;
  amendmentId?: string | null; // Befehl 25: Position aus einem Nachtrag (Abrechnungsbezug, nie doppelt)
  reference?: string | null;
};

type ComputedItem = { description: string; unit: string; source: string; extraChargeId: string | null; amendmentId: string | null; reference: string | null; quantityH: number; unitPriceC: Cents; taxRateBp: number; amounts: ReturnType<typeof lineAmounts> };

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
    return { description, unit: it.unit, source: it.source ?? "MANUAL", extraChargeId: it.extraChargeId ?? null, amendmentId: it.amendmentId ?? null, reference: it.reference ?? null, quantityH, unitPriceC, taxRateBp, amounts: lineAmounts(mode, quantityH, unitPriceC, taxRateBp) };
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
    amendmentId: c.amendmentId,
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
  // Befehl 25: unterschriebene Nachträge – der Mietpreis ist der wirksame Gesamtpreis; Erhöhungen werden als eigene Positionen ausgewiesen
  const amendments = await tx.contractAmendment.findMany({ where: { tenantId, contractId: booking.contract.id, status: "SIGNED" }, orderBy: { sequenceNo: "asc" } });
  return { booking, contract: overlayAmendments(booking.contract, amendments), amendments, tenant: booking.tenant, ret, pickup };
}

/** Befehl 25: Positionstext einer Preiserhöhung aus einem Nachtrag (Verlängerung oder vereinbarte Preisänderung). */
export function amendmentItemDescription(a: { number: string | null; newEndAt: Date | null; priceReason: string | null; snapshot: Prisma.JsonValue | null }, contractNumber: string): string {
  const snap = a.snapshot as { before?: { endAt?: string } } | null;
  const before = snap?.before?.endAt ? new Date(snap.before.endAt) : null;
  if (a.newEndAt && before && a.newEndAt > before) {
    const extraDays = rentalDays(before, a.newEndAt);
    return `Verlängerung der Mietdauer bis ${dateFmt(a.newEndAt)} (${extraDays} ${extraDays === 1 ? "Tag" : "Tage"}), laut Nachtrag ${a.number} zum Mietvertrag ${contractNumber}`;
  }
  return `Vertragsänderung laut Nachtrag ${a.number} zum Mietvertrag ${contractNumber}${a.priceReason ? `: ${a.priceReason}` : ""}`;
}

/**
 * Legt die logische Rechnung mit Fassung 1 (Entwurf) an oder gibt die vorhandene Rechnung zurück. Positionen:
 * Fahrzeugmiete zum finalen Vertragspreis und jede bei der Rückgabe bestätigte Zusatzkostenposition, sonst nichts.
 * Ein festgestellter Schaden erscheint nur, wenn ein Mitarbeiter dort ausdrücklich eine Position vom Typ DAMAGE angelegt hat.
 */
export async function ensureInvoiceDraft(tenantId: string, bookingId: string, actor: Actor): Promise<InvoiceRow> {
  const existing = await db.invoice.findFirst({ where: { tenantId, bookingId, kind: "RENTAL", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, orderBy: { createdAt: "desc" } });
  if (existing) return existing;
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const again = await tx.invoice.findFirst({ where: { tenantId, bookingId, kind: "RENTAL", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } } });
    if (again) return again;
    const { booking, contract, amendments, tenant, ret, pickup } = await loadSources(tx, tenantId, bookingId);
    // Befehl 29: Unfallersatz rechnet nach tatsächlicher Mietdauer und Tarif über die Fallakte ab (eigene Rechnungsart), nicht über die Mietrechnung
    if (booking.rentalType === "ACCIDENT_REPLACEMENT") throw new DomainError("Eine Unfallersatzmiete wird über die Fallakte abgerechnet (Unfallersatz-Rechnung), nicht über die Mietrechnung.");
    const contractEnd = contract.endAt;
    if (!contractEnd) throw new DomainError("Der Mietvertrag hat kein Mietende; eine Mietrechnung zum Vertragspreis ist nicht möglich.");
    const missing = invoiceSettingsMissing(tenant);
    if (missing.length > 0) throw new DomainError(`Bevor Rechnungen erstellt werden können, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
    const mode = tenant.pricesIncludeTax ? "GROSS" : "NET";
    const rate = Number(tenant.defaultTaxRate);
    const v = contract.vehicleSnapshot as Partial<VehicleSnapshot>;
    const c = contract.customerSnapshot as Partial<CustomerSnapshot>;
    const start = booking.actualPickupAt ?? pickup?.finalizedAt ?? contract.startAt;
    const end = booking.actualReturnAt ?? ret.finalizedAt ?? contractEnd;
    const days = rentalDays(contract.startAt, contractEnd);

    // Eigene Vertragspositionen (z. B. Zusatzfahrer) erscheinen getrennt; der Mietpreis ist der Vertragsbetrag ohne diese Positionen.
    const priceSnap = contract.priceSnapshot as { extras?: { label: string; quantity: number; unitPrice: number; amount: number }[]; extrasTotal?: number } | null;
    const extras = priceSnap?.extras ?? [];
    const extrasTotal = extras.reduce((a, e) => a + Math.round(e.amount * 100), 0);
    // Befehl 25: Preiserhöhungen aus Nachträgen sind eigene Positionen (Abrechnungsbezug amendmentId); Preisminderungen können
    // keine negative Position sein und mindern den Mietpreis (notfalls die Vertragspositionen). Summe = wirksamer Gesamtpreis.
    const increases = amendments.filter((a) => (a.priceDeltaCents ?? 0) > 0);
    const reductionTotal = amendments.reduce((sum, a) => sum + Math.min(0, a.priceDeltaCents ?? 0), 0);
    let rentalCents = contract.amended.original.totalCents - extrasTotal + reductionTotal;
    const extraAmounts = extras.map((e) => Math.round(e.amount * 100));
    if (rentalCents < 0) {
      let rest = -rentalCents;
      rentalCents = 0;
      for (let i = extraAmounts.length - 1; i >= 0 && rest > 0; i--) { const take = Math.min(extraAmounts[i], rest); extraAmounts[i] -= take; rest -= take; }
    }
    const periodNote = contract.amended.changedBy.endAt ? ` und Nachtrag ${contract.amended.changedBy.endAt}` : "";
    const reductionNote = reductionTotal < 0 ? ` (Preisminderung ${fmtCents(reductionTotal)} laut Nachtrag berücksichtigt)` : "";
    const items: ItemInput[] = [
      {
        description: `Fahrzeugmiete ${[v.make, v.model].filter(Boolean).join(" ")}${v.plate ? ` (${v.plate})` : ""}, ${dateFmt(contract.startAt)} bis ${dateFmt(contractEnd)}, ${days} ${days === 1 ? "Tag" : "Tage"}, laut Mietvertrag ${contract.number}${periodNote}${reductionNote}`,
        quantity: 1,
        unit: "pauschal",
        unitPrice: (rentalCents / 100).toFixed(2),
        taxRate: rate,
        source: "RENTAL",
        reference: `Mietvertrag ${contract.number}`,
      },
      ...extras.map((e, i): ItemInput => ({
        description: `${e.label}, laut Mietvertrag ${contract.number}`,
        quantity: 1,
        unit: "pauschal",
        unitPrice: (extraAmounts[i] / 100).toFixed(2),
        taxRate: rate,
        source: "RENTAL",
        reference: `Mietvertrag ${contract.number}`,
      })),
      ...increases.map((a): ItemInput => ({
        description: amendmentItemDescription(a, contract.number),
        quantity: 1,
        unit: "pauschal",
        unitPrice: ((a.priceDeltaCents ?? 0) / 100).toFixed(2),
        taxRate: rate,
        source: "AMENDMENT",
        amendmentId: a.id,
        reference: `Nachtrag ${a.number}`,
      })),
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
        sourceHash: sha256(`${contract.contentHash}:${ret.contentHash}${amendments.map((a) => `:${a.contentHash}`).join("")}`),
        createdById: actor.id,
        changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Entwurf aus Mietvertrag ${contract.number}${amendments.length ? `, Nachtrag ${amendments.map((a) => a.number).join(", ")}` : ""} und Rückgabe ${ret.number} erstellt (${computed.length} Positionen)` }],
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
  const now = new Date();
  const start = booking.actualPickupAt ?? booking.contract.startAt;
  // offenes Vertragsende (Unfallersatz) und noch nicht zurückgegeben: Leistungszeitraum bis heute
  const end = booking.actualReturnAt ?? booking.contract.endAt ?? now;
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

/**
 * Bearbeitungsentgelt zu einem Behördenvorgang (kind AUTHORITY_FEE) als Entwurf mit Fassung 1: eine Position über den im
 * Mietvertrag eingefrorenen Betrag. Steuer wie jede Leistung des Vermieters (Standardsatz aus den Einstellungen);
 * Rechnungsempfänger aus der Vertragskopie. Eindeutigkeit je Vorgang sichert der Datenbank-Index.
 */
export async function createAuthorityFeeInvoiceDraft(tx: Tx, tenantId: string, actor: Actor, input: { bookingId: string; authorityCaseId: string; caseNumber: string; authorityName: string; authorityReference: string; amountCents: Cents }): Promise<InvoiceRow> {
  const booking = await tx.booking.findFirst({ where: { id: input.bookingId, tenantId }, include: { contract: true, tenant: true } });
  if (!booking) throw new DomainError("Buchung nicht gefunden.");
  if (!booking.contract || booking.contract.status !== "SIGNED") throw new DomainError("Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag; ohne Vertragskopie gibt es keinen Rechnungsempfänger.");
  const tenant = booking.tenant;
  const missing = invoiceSettingsMissing(tenant);
  if (missing.length > 0) throw new DomainError(`Bevor Rechnungen erstellt werden können, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
  if (input.amountCents <= 0) throw new DomainError("Das Bearbeitungsentgelt muss größer als 0,00 € sein.");
  const mode = tenant.pricesIncludeTax ? "GROSS" : "NET";
  const c = booking.contract.customerSnapshot as Partial<CustomerSnapshot>;
  const item = computeItem(mode, { description: `Bearbeitungsentgelt für die Beantwortung einer Behördenanfrage (${input.authorityName}, Az. ${input.authorityReference}) zur Vermietung ${booking.number}, laut Mietvertrag ${booking.contract.number}`, quantity: 1, unit: "pauschal", unitPrice: centsToDecimalString(input.amountCents), taxRate: Number(tenant.defaultTaxRate), source: "MANUAL", reference: `Behördenvorgang ${input.caseNumber}` });
  const totals = summarize([{ taxRateBp: item.taxRateBp, amounts: item.amounts }]);
  const now = new Date();
  const invoice = await tx.invoice.create({
    data: {
      tenantId, bookingId: booking.id, customerId: booking.customerId, contractId: booking.contract.id,
      kind: "AUTHORITY_FEE", authorityCaseId: input.authorityCaseId,
      sourceHash: sha256(`${booking.contract.contentHash}:${input.authorityCaseId}:${input.amountCents}`),
      createdById: actor.id,
      changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Bearbeitungsentgelt zum Behördenvorgang ${input.caseNumber} als Entwurf erstellt (${fmtCents(input.amountCents)} laut Mietvertrag)` }],
    },
  });
  const version = await tx.invoiceVersion.create({
    data: {
      tenantId, invoiceId: invoice.id, versionNo: 1, kind: "ORIGINAL",
      servicePeriodStart: now, servicePeriodEnd: now, pricesIncludeTax: mode === "GROSS",
      customerSnapshot: customerSnapshotFromContract(c), companySnapshot: companySnapshotOf(tenant),
      netTotal: centsToDecimalString(totals.total.net), taxTotal: centsToDecimalString(totals.total.tax), grossTotal: centsToDecimalString(totals.total.gross),
      paymentTermDays: tenant.paymentTermDays, taxNote: tenant.taxNote,
      createdById: actor.id, createdByName: actor.name,
    },
  });
  await tx.invoiceVersionItem.create({ data: itemData(tenantId, version.id, 0, item) });
  return invoice;
}

/**
 * Befehl 23: Mahngebühr als eigene Nebenrechnung (kind DUNNING_FEE) – nur innerhalb der Mahn-Transaktion. Eine Position über
 * die beim Erstellen eingefrorene Gebühr der Stufe, 0 % USt (Mahngebühren sind kein Leistungsentgelt; die Einordnung
 * trifft der Vermieter mit seiner Steuerberatung, Rent-Base prüft keine Zulässigkeit). Rechnungsempfänger = Empfänger der
 * gemahnten Rechnung (deren Kopie), Fälligkeit = Frist des Mahnschreibens. Die gemahnte Rechnung bleibt unverändert.
 */
export async function createDunningFeeInvoiceDraft(tx: Tx, tenantId: string, actor: Actor, input: { invoiceId: string; invoiceNumber: string; levelLabel: string; noticeNumber: string; feeCents: Cents; deadlineDays: number }): Promise<InvoiceRow> {
  const main = await tx.invoice.findFirst({ where: { id: input.invoiceId, tenantId }, include: { currentVersion: true, tenant: true } });
  if (!main || !main.currentVersion) throw new DomainError("Rechnung nicht gefunden.");
  if (input.feeCents <= 0) throw new DomainError("Die Mahngebühr muss größer als 0,00 € sein.");
  const tenant = main.tenant;
  const missing = invoiceSettingsMissing(tenant);
  if (missing.length > 0) throw new DomainError(`Bevor eine Mahngebühr berechnet werden kann, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
  const mode = tenant.pricesIncludeTax ? "GROSS" : "NET";
  const item = computeItem(mode, { description: `Mahngebühr ${input.levelLabel} ${input.noticeNumber} zu Rechnung ${input.invoiceNumber}`, quantity: 1, unit: "pauschal", unitPrice: centsToDecimalString(input.feeCents), taxRate: 0, source: "MANUAL", reference: `Mahnschreiben ${input.noticeNumber}` });
  const totals = summarize([{ taxRateBp: item.taxRateBp, amounts: item.amounts }]);
  const now = new Date();
  const invoice = await tx.invoice.create({
    data: {
      tenantId, bookingId: main.bookingId, customerId: main.customerId, contractId: main.contractId,
      kind: "DUNNING_FEE",
      sourceHash: sha256(`${main.id}:${input.noticeNumber}:${input.feeCents}`),
      createdById: actor.id,
      changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Mahngebühr ${fmtCents(input.feeCents)} zu ${input.invoiceNumber} (${input.levelLabel} ${input.noticeNumber})` }],
    },
  });
  const version = await tx.invoiceVersion.create({
    data: {
      tenantId, invoiceId: invoice.id, versionNo: 1, kind: "ORIGINAL",
      servicePeriodStart: now, servicePeriodEnd: now, pricesIncludeTax: mode === "GROSS",
      customerSnapshot: main.currentVersion.customerSnapshot as Prisma.InputJsonValue, companySnapshot: companySnapshotOf(tenant),
      netTotal: centsToDecimalString(totals.total.net), taxTotal: centsToDecimalString(totals.total.tax), grossTotal: centsToDecimalString(totals.total.gross),
      paymentTermDays: input.deadlineDays, taxNote: "Mahngebühr ohne Umsatzsteuer (kein Leistungsentgelt).",
      createdById: actor.id, createdByName: actor.name,
    },
  });
  await tx.invoiceVersionItem.create({ data: itemData(tenantId, version.id, 0, item) });
  return invoice;
}

/**
 * Befehl 28: Stornogebühr als eigene Rechnung (kind CANCELLATION_FEE) – nur innerhalb des Storno-Abschlusses, nur zu einer
 * stornierten Buchung. Eine Position über den bewusst erfassten Betrag; die steuerliche Behandlung wählt der Vermieter je Storno
 * (TAXABLE_SUPPLY = Standardsatz aus den Einstellungen, NON_TAXABLE_FEE = nicht steuerbar, ohne Steuersatz). Rechnungsempfänger:
 * Vertragskopie, ohne Vertrag der Kundenstamm. Der ursprüngliche Mietpreis wird nicht verändert; die Gebühr ist eine eigene Forderung.
 */
export async function createCancellationFeeInvoiceDraft(tx: Tx, tenantId: string, actor: Actor, input: { bookingId: string; amountCents: Cents; description: string; taxTreatment: string }): Promise<InvoiceRow> {
  const booking = await tx.booking.findFirst({ where: { id: input.bookingId, tenantId }, include: { contract: true, tenant: true, customer: true } });
  if (!booking) throw new DomainError("Buchung nicht gefunden.");
  if (booking.status !== "CANCELLED") throw new DomainError("Eine Stornogebühr gibt es nur zu einer stornierten Buchung.");
  const tenant = booking.tenant;
  const missing = invoiceSettingsMissing(tenant);
  if (missing.length > 0) throw new DomainError(`Bevor eine Stornogebühr berechnet werden kann, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DomainError("Die Stornogebühr muss größer als 0,00 € sein.");
  if (!(input.taxTreatment in CANCELLATION_FEE_TAX_TREATMENTS)) throw new DomainError("Bitte die steuerliche Behandlung der Stornogebühr auswählen.");
  const description = input.description.replace(/\s+/g, " ").trim();
  if (description.length < 3) throw new DomainError("Bitte die Stornogebühr kurz beschreiben (z. B. „Stornogebühr laut Mietbedingungen“).");
  if (description.length > 300) throw new DomainError("Die Beschreibung der Stornogebühr ist zu lang (höchstens 300 Zeichen).");
  const nonTaxable = input.taxTreatment === "NON_TAXABLE_FEE";
  const rate = nonTaxable ? 0 : Number(tenant.defaultTaxRate);
  const mode = tenant.pricesIncludeTax ? "GROSS" : "NET";
  const contractSnapshot = booking.contract && booking.contract.status !== "DRAFT" ? (booking.contract.customerSnapshot as Partial<CustomerSnapshot>) : null;
  const item = computeItem(mode, { description: `${description} – Buchung ${booking.number}${booking.contract && booking.contract.status !== "DRAFT" ? `, Mietvertrag ${booking.contract.number}` : ""}`, quantity: 1, unit: "pauschal", unitPrice: centsToDecimalString(input.amountCents), taxRate: rate, source: "MANUAL", reference: `Storno Buchung ${booking.number}` });
  const totals = summarize([{ taxRateBp: item.taxRateBp, amounts: item.amounts }]);
  const now = new Date();
  const invoice = await tx.invoice.create({
    data: {
      tenantId, bookingId: booking.id, customerId: booking.customerId, contractId: booking.contract && booking.contract.status !== "DRAFT" ? booking.contract.id : null,
      kind: "CANCELLATION_FEE", taxTreatment: input.taxTreatment,
      sourceHash: sha256(`cancellation-fee:${booking.id}:${input.amountCents}`),
      createdById: actor.id,
      changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Stornogebühr ${fmtCents(input.amountCents)} zur stornierten Buchung ${booking.number}` }],
    },
  });
  const version = await tx.invoiceVersion.create({
    data: {
      tenantId, invoiceId: invoice.id, versionNo: 1, kind: "ORIGINAL",
      servicePeriodStart: now, servicePeriodEnd: now, pricesIncludeTax: mode === "GROSS",
      customerSnapshot: contractSnapshot ? customerSnapshotFromContract(contractSnapshot) : customerSnapshotFromCustomer(booking.customer), companySnapshot: companySnapshotOf(tenant),
      netTotal: centsToDecimalString(totals.total.net), taxTotal: centsToDecimalString(totals.total.tax), grossTotal: centsToDecimalString(totals.total.gross),
      paymentTermDays: tenant.paymentTermDays, taxNote: nonTaxable ? CANCELLATION_FEE_TAX_NOTE : tenant.taxNote, taxTreatment: input.taxTreatment,
      createdById: actor.id, createdByName: actor.name,
    },
  });
  await tx.invoiceVersionItem.create({ data: itemData(tenantId, version.id, 0, item) });
  return invoice;
}

/**
 * Befehl 23.1: freie Rechnung (kind GENERAL) als Entwurf ohne Positionen. Rechnungsempfänger = bestehender Kunde (Kopie aus
 * dem Kundenstamm, beim Abschluss versiegelt); optionaler Buchungsbezug nur zur Zuordnung (muss zum Kunden gehören) –
 * es werden keine Mietpositionen übernommen, Kaution und Buchung bleiben unberührt. Zahlungsziel = Mandantenstandard,
 * je Rechnung änderbar. Doppelklick: derselbe Formularschlüssel liefert denselben Entwurf (sourceHash).
 */
export async function createGeneralInvoiceDraft(tenantId: string, actor: Actor, input: { customerId: string; bookingId?: string | null; nonce: string }): Promise<{ invoice: InvoiceRow; created: boolean }> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const sourceHash = sha256(`general:${tenantId}:${input.nonce}`);
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Customer" WHERE "id" = ${input.customerId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Kunde nicht gefunden.");
    const existing = await tx.invoice.findFirst({ where: { tenantId, kind: "GENERAL", sourceHash } });
    if (existing) return { invoice: existing, created: false };
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: input.customerId } });
    let booking: { id: string; number: string; customerId: string } | null = null;
    if (input.bookingId) {
      booking = await tx.booking.findFirst({ where: { id: input.bookingId, tenantId }, select: { id: true, number: true, customerId: true } });
      if (!booking) throw new DomainError("Buchung nicht gefunden.");
      if (booking.customerId !== customer.id) throw new DomainError("Die gewählte Buchung gehört nicht zu diesem Kunden.");
    }
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const missing = invoiceSettingsMissing(tenant);
    if (missing.length > 0) throw new DomainError(`Bevor Rechnungen erstellt werden können, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
    const now = new Date();
    const invoice = await tx.invoice.create({
      data: {
        tenantId, bookingId: booking?.id ?? null, customerId: customer.id, kind: "GENERAL", sourceHash, createdById: actor.id,
        changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Freie Rechnung als Entwurf angelegt${booking ? ` (Bezug Buchung ${booking.number})` : " (ohne Buchungsbezug)"}` }],
      },
    });
    await tx.invoiceVersion.create({
      data: {
        tenantId, invoiceId: invoice.id, versionNo: 1, kind: "ORIGINAL",
        servicePeriodStart: now, servicePeriodEnd: now, pricesIncludeTax: tenant.pricesIncludeTax ?? true,
        customerSnapshot: customerSnapshotFromCustomer(customer), companySnapshot: companySnapshotOf(tenant),
        paymentTermDays: tenant.paymentTermDays, taxNote: tenant.taxNote,
        createdById: actor.id, createdByName: actor.name,
      },
    });
    await recordAudit(tx, tenantId, actor, { action: "INVOICE_DRAFT_CREATED", bookingId: booking?.id ?? null, invoiceId: invoice.id, details: { kind: "GENERAL", customerId: customer.id, bookingNumber: booking?.number ?? null } });
    return { invoice, created: true };
  });
}

// ---------------------------------------------------------------------------
// Befehl 29: Unfallersatz-Abrechnung (Phase F). Eine Leistung – die Miete ab der tatsächlichen Übergabe bis zur Rückgabe – wird je
// Fall genau einmal fakturiert, gleich an wen: Zwischenrechnungen bis zu einem Stichtag (nie in der Zukunft), danach die
// Schlussrechnung bis zur tatsächlichen Rückgabe. Jede Rechnung setzt am Ende der zuletzt wirksam abgerechneten an; Miettage,
// Tagespositionen, Einmalpositionen und Zusatzkosten erscheinen dadurch nie doppelt. Stornierte bzw. vollständig gutgeschriebene
// Rechnungen zählen nicht (die Leistung ist dann wieder offen). Eine Restforderung an den Mieter ist keine neue Leistung, sondern
// ein bewusst gestellter Teil einer gekürzten Versicherungsrechnung (Bezug in der versiegelten Kopie). Rent-Base bucht nichts um.
// ---------------------------------------------------------------------------


type Client = Tx | typeof db;
export type AccidentChainInvoice = {
  id: string; number: string | null; status: string; createdAt: Date; role: InvoiceRecipientRole; billing: AccidentBilling | null;
  periodStart: Date; periodEnd: Date; grossCents: Cents;
  /** abgeschlossen und weder storniert noch vollständig gutgeschrieben */
  effective: boolean;
  items: { source: string; unit: string; quantity: unknown; extraChargeId: string | null; reference: string | null }[];
};
export type AccidentChain = {
  invoices: AccidentChainInvoice[];
  /** wirksame Leistungsrechnungen (ohne Restforderungen), nach Leistungszeitraum sortiert */
  service: AccidentChainInvoice[];
  /** offene Entwürfe (Fassung 1) */
  drafts: AccidentChainInvoice[];
  /** Ende des zuletzt wirksam abgerechneten Leistungszeitraums */
  billedUntil: Date | null;
  oneOffBilled: boolean;
  billedChargeIds: Set<string>;
  /** Lücken zwischen wirksamen Leistungszeiträumen (z. B. eine mittlere Rechnung wurde storniert) */
  gaps: { from: Date; until: Date }[];
};

/**
 * Alle Unfallersatz-Rechnungen einer Buchung mit ihrem Stand in der Abrechnungskette. Abgeschlossene Rechnungen mit ihrer
 * aktuellen Fassung (nicht einem offenen Bearbeitungsentwurf), Entwürfe mit ihrer Entwurfsfassung.
 */
export async function accidentInvoiceChain(client: Client, tenantId: string, bookingId: string, opts: { excludeInvoiceId?: string; pickupAt?: Date | null } = {}): Promise<AccidentChain> {
  const rows = await client.invoice.findMany({
    where: { tenantId, bookingId, kind: "ACCIDENT_REPLACEMENT", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] }, ...(opts.excludeInvoiceId ? { id: { not: opts.excludeInvoiceId } } : {}) },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, number: true, status: true, createdAt: true,
      currentVersion: { select: { servicePeriodStart: true, servicePeriodEnd: true, customerSnapshot: true, grossTotal: true, items: { select: { source: true, unit: true, quantity: true, extraChargeId: true, reference: true } } } },
      versions: { where: { versionNo: 1 }, take: 1, select: { servicePeriodStart: true, servicePeriodEnd: true, customerSnapshot: true, grossTotal: true, items: { select: { source: true, unit: true, quantity: true, extraChargeId: true, reference: true } } } },
    },
  });
  const finals = rows.filter((r) => r.status === "FINALIZED" && r.currentVersion);
  const counters = finals.length ? await client.invoice.findMany({ where: { tenantId, originalInvoiceId: { in: finals.map((r) => r.id) }, status: "FINALIZED", documentType: { in: ["CREDIT_NOTE", "CANCELLATION"] } }, select: { originalInvoiceId: true, documentType: true, currentVersion: { select: { grossTotal: true } } } }) : [];
  const invoices: AccidentChainInvoice[] = rows.map((r): AccidentChainInvoice | null => {
    const v = r.status === "FINALIZED" ? r.currentVersion : r.versions[0];
    if (!v) return null;
    const gross = toCents(v.grossTotal);
    const mine = counters.filter((c) => c.originalInvoiceId === r.id);
    const cancelled = mine.some((c) => c.documentType === "CANCELLATION");
    const credited = mine.filter((c) => c.documentType === "CREDIT_NOTE").reduce((s, c) => s + toCents(c.currentVersion?.grossTotal ?? 0), 0);
    return {
      id: r.id, number: r.number, status: r.status, createdAt: r.createdAt, role: recipientRoleOf(v.customerSnapshot as { recipientRole?: string } | null), billing: accidentBillingOf(v.customerSnapshot),
      periodStart: v.servicePeriodStart, periodEnd: v.servicePeriodEnd, grossCents: gross,
      effective: r.status === "FINALIZED" && !cancelled && !(credited > 0 && credited >= gross),
      items: v.items,
    };
  }).filter((x): x is AccidentChainInvoice => x !== null);
  const service = invoices.filter((i) => i.effective && i.billing?.type !== "REMAINDER").sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
  const billedUntil = service.reduce<Date | null>((m, i) => (!m || i.periodEnd > m ? i.periodEnd : m), null);
  const gaps: AccidentChain["gaps"] = [];
  let cursor = opts.pickupAt ?? service[0]?.periodStart ?? null;
  for (const i of service) {
    if (cursor && i.periodStart.getTime() - cursor.getTime() > 60_000) gaps.push({ from: cursor, until: i.periodStart });
    if (!cursor || i.periodEnd > cursor) cursor = i.periodEnd;
  }
  return {
    invoices, service, drafts: invoices.filter((i) => i.status === "DRAFT"), billedUntil,
    // Einmalpositionen des Tarifs (Bezug „Tarif Fall …“, ältere Rechnungen „Fall …“, nicht je Tag) – aus den Positionen, nicht aus der Anzahl
    oneOffBilled: service.some((i) => i.items.some(isOneOffTariffItem)),
    billedChargeIds: new Set(service.flatMap((i) => i.items.map((x) => x.extraChargeId).filter((x): x is string => !!x))),
    gaps,
  };
}

const isOneOffTariffItem = (x: { source: string; unit: string; reference: string | null }) => x.source === "MANUAL" && x.unit !== "Tag" && /^(Tarif )?Fall /.test(x.reference ?? "");

/**
 * Phase F: Storno bzw. vollständige Gutschrift einer Leistungsrechnung nur, wenn danach keine wirksame Leistungsrechnung folgt –
 * sonst entstünde eine Lücke, die keine neue Rechnung mehr schließen kann. Teilgutschriften bleiben möglich. Restforderungen
 * und andere Rechnungsarten: keine Einschränkung.
 */
export async function assertNotMidChain(client: Client, tenantId: string, invoiceId: string): Promise<void> {
  const inv = await client.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { kind: true, bookingId: true, number: true, currentVersion: { select: { customerSnapshot: true, servicePeriodEnd: true } } } });
  if (!inv || inv.kind !== "ACCIDENT_REPLACEMENT" || !inv.bookingId || !inv.currentVersion) return;
  if (accidentBillingOf(inv.currentVersion.customerSnapshot)?.type === "REMAINDER") return;
  const chain = await accidentInvoiceChain(client, tenantId, inv.bookingId, { excludeInvoiceId: invoiceId });
  const later = chain.service.filter((i) => i.periodStart.getTime() >= inv.currentVersion!.servicePeriodEnd.getTime() - 60_000);
  if (later.length > 0) throw new DomainError(`Die Rechnung ${inv.number} liegt mitten in der Unfallersatz-Abrechnung (danach: ${later.map((i) => i.number).join(", ")}). Ein Storno oder eine vollständige Gutschrift würde eine Lücke hinterlassen, die sich nicht mehr abrechnen lässt. Bitte zuerst die späteren Rechnungen stornieren oder diese Rechnung über „Rechnung bearbeiten“ berichtigen (z. B. anderer Empfänger).`);
}

/** Miettage der Grundmiete in den Positionen einer Fassung (Einheit „Tag“ aus der Miete). */
export const rentalDaysInItems = (items: readonly { source: string; unit: string; quantity: unknown }[]) => items.filter((i) => i.source === "RENTAL" && i.unit === "Tag").reduce((s, i) => s + Number(i.quantity), 0);

export type AccidentRecipientInput = { type?: string | null; companyName?: string | null; firstName?: string | null; lastName?: string | null; street?: string | null; zip?: string | null; city?: string | null; country?: string | null; email?: string | null };

type AccidentCaseForBilling = Prisma.AccidentReplacementCaseGetPayload<{ include: { tariffItems: true } }>;
type AccidentService = {
  booking: Prisma.BookingGetPayload<{ include: { contract: true; tenant: true; customer: true } }>;
  ret: Prisma.HandoverGetPayload<{ include: { extraCharges: true } }> | null;
  type: "INTERIM" | "FINAL";
  periodStart: Date; end: Date; days: number; totalDays: number; priorDays: number; prior: string[];
  mode: "NET" | "GROSS"; items: ItemInput[];
  chain: AccidentChain;
};

/**
 * Daten der nächsten Leistungsrechnung (Zwischen- oder Schlussrechnung) – dieselbe Rechnung für Vorschau und Entwurf.
 * Grundlage: tatsächliche Übergabe → Stichtag bzw. tatsächliche Rückgabe; Tarif aus dem unterschriebenen Mietvertrag
 * (Phase E: eingefroren), nie aus aktuellen Stammdaten oder dem geplanten Mietende.
 */
async function accidentServiceData(client: Client, tenantId: string, c: AccidentCaseForBilling, periodEnd: Date | null | undefined, now = new Date()): Promise<AccidentService> {
  const booking = await client.booking.findFirstOrThrow({ where: { id: c.bookingId, tenantId }, include: { contract: true, tenant: true, customer: true } });
  if (booking.status === "CANCELLED") throw new DomainError("Die Buchung ist storniert; es gibt keine Miete abzurechnen.");
  if (!booking.contract || booking.contract.status !== "SIGNED" || !booking.contract.contentHash) throw new DomainError("Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag.");
  if (!booking.actualPickupAt) throw new DomainError("Das Fahrzeug wurde noch nicht übergeben; abgerechnet wird erst ab der Übergabe.");
  const missing = invoiceSettingsMissing(booking.tenant);
  if (missing.length > 0) throw new DomainError(`Bevor Rechnungen erstellt werden können, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
  const returned = booking.status === "RETURNED";
  const ret = returned ? await client.handover.findFirst({ where: { tenantId, bookingId: booking.id, type: "RETURN", status: "FINALIZED", correctsId: null }, orderBy: { finalizedAt: "desc" }, include: { extraCharges: { orderBy: { createdAt: "asc" } } } }) : null;
  const start = booking.actualPickupAt;
  let end: Date;
  if (returned) {
    // nach der Rückgabe gibt es nur noch die Schlussrechnung bis zur tatsächlichen Rückgabe
    end = booking.actualReturnAt ?? ret?.finalizedAt ?? now;
  } else {
    if (booking.status !== "ACTIVE") throw new DomainError("Abgerechnet wird erst ab der Übergabe.");
    const dropped = await client.keyDropReturn.findFirst({ where: { tenantId, bookingId: booking.id, status: "CUSTOMER_CONFIRMED" }, select: { customerDropOffAt: true } });
    if (dropped) throw new DomainError(`Die Rückgabe per Schlüsselbox ist gemeldet${dropped.customerDropOffAt ? ` (Abgabe ${dateFmt(dropped.customerDropOffAt)})` : ""}. Bitte zuerst die Rückgabe kontrollieren und abschließen; abgerechnet wird dann mit der Schlussrechnung über die tatsächliche Mietdauer.`);
    if (!periodEnd) throw new DomainError("Die Miete läuft noch. Für eine Zwischenrechnung bitte den Stichtag angeben, bis zu dem abgerechnet wird.");
    if (periodEnd.getTime() > now.getTime() + 60_000) throw new DomainError("Der Stichtag einer Zwischenrechnung darf nicht in der Zukunft liegen.");
    end = periodEnd;
  }
  if (!(end > start)) throw new DomainError("Das Ende des Leistungszeitraums muss nach der Übergabe liegen.");
  const chain = await accidentInvoiceChain(client, tenantId, booking.id, { pickupAt: start });
  const prevEnd = chain.billedUntil;
  if (returned && prevEnd && prevEnd > end && rentalDays(start, prevEnd) > rentalDays(start, end)) throw new DomainError(`Bereits abgerechnet bis ${dateFmt(prevEnd)} – mehr Miettage als bis zur tatsächlichen Rückgabe (${dateFmt(end)}). Bitte die letzte Zwischenrechnung (${chain.service[chain.service.length - 1]?.number ?? ""}) stornieren; danach wird die Schlussrechnung über die tatsächliche Mietdauer erstellt.`);
  if (!returned && prevEnd && !(end > prevEnd)) throw new DomainError(`Die Miete ist bis ${dateFmt(prevEnd)} bereits abgerechnet. Der Stichtag muss danach liegen.`);
  // Beginn = Ende der zuletzt wirksam abgerechneten Leistung (nie nach dem Ende dieses Zeitraums)
  const periodStart = prevEnd && prevEnd > start ? (prevEnd > end ? end : prevEnd) : start;
  const totalDays = rentalDays(start, end);
  const priorDays = prevEnd && prevEnd > start ? rentalDays(start, prevEnd) : 0;
  const days = Math.max(0, totalDays - priorDays);
  const mode = booking.tenant.pricesIncludeTax ? "GROSS" : "NET";
  const rate = Number(booking.tenant.defaultTaxRate);
  const snap = booking.contract.priceSnapshot as { rates?: { dailyRate?: number | null } } | null;
  // Phase E: Tarifpositionen wie im Mietvertrag unterschrieben (eingefroren); nur ältere Verträge ohne Kopie lesen den Fall.
  // Wie Vertrag und Fallakte: nur Positionen mit Betrag (0-€-Positionen sind nicht Teil der Abrechnung)
  const tariffItems = (contractTariffItems(booking.contract.priceSnapshot) ?? c.tariffItems).filter((t) => t.unitPriceCents > 0 && (t.perDay || t.quantityHundredths > 0));
  const dailyRate = typeof snap?.rates?.dailyRate === "number" && snap.rates.dailyRate > 0 ? snap.rates.dailyRate : Number(booking.dailyRate);
  if (!(dailyRate > 0)) throw new DomainError("Für diese Miete ist kein Tagessatz hinterlegt.");
  const v = booking.contract.vehicleSnapshot as Partial<VehicleSnapshot>;
  const dayWord = days === 1 ? "Tag" : "Tage";
  const periodText = `${dateFmt(periodStart)} bis ${dateFmt(end)}`;
  const items: ItemInput[] = [
    ...(days > 0 ? [{ description: `Unfallersatzfahrzeug ${[v.make, v.model].filter(Boolean).join(" ")}${v.plate ? ` (${v.plate})` : ""}, ${periodText}, ${days} ${dayWord} Grundmiete laut Mietvertrag ${booking.contract.number} (Fall ${c.caseNumber})`, quantity: days, unit: "Tag", unitPrice: dailyRate.toFixed(2), taxRate: rate, source: "RENTAL", reference: `Mietvertrag ${booking.contract.number}` } as ItemInput] : []),
    ...tariffItems.filter((t) => (t.perDay ? days > 0 : !chain.oneOffBilled)).map((t): ItemInput => (t.perDay
      ? { description: `${t.label}, ${days} ${dayWord} (${periodText})`, quantity: days, unit: "Tag", unitPrice: (t.unitPriceCents / 100).toFixed(2), taxRate: rate, source: "MANUAL", reference: `Tarif Fall ${c.caseNumber}` }
      : { description: t.label, quantity: (t.quantityHundredths / 100).toFixed(2), unit: t.quantityHundredths === 100 ? "pauschal" : "Stk", unitPrice: (t.unitPriceCents / 100).toFixed(2), taxRate: rate, source: "MANUAL", reference: `Tarif Fall ${c.caseNumber}` })),
    ...(ret?.extraCharges ?? []).filter((e) => !chain.billedChargeIds.has(e.id)).map((e): ItemInput => ({ description: `${EXTRA_CHARGE_TYPES[e.type as ExtraChargeType] ?? e.type}: ${e.description}`, quantity: String(e.quantity), unit: (INVOICE_UNITS as readonly string[]).includes(e.unit) ? e.unit : "pauschal", unitPrice: String(e.unitPrice), taxRate: rate, source: "EXTRA_CHARGE", extraChargeId: e.id, reference: `${ret!.number}: ${e.formula}` })),
  ];
  if (items.length === 0) throw new DomainError(returned ? "Die Miete ist bereits vollständig abgerechnet: Alle Miettage bis zur Rückgabe und alle Zusatzkosten stehen in früheren Rechnungen." : "Für diesen Zeitraum ist nichts mehr abzurechnen – die Miettage bis zum Stichtag sind bereits berechnet.");
  return { booking, ret, type: returned ? "FINAL" : "INTERIM", periodStart, end, days, totalDays, priorDays, prior: chain.service.map((i) => i.number).filter((n): n is string => !!n), mode, items, chain };
}

function computeAccidentItems(mode: "NET" | "GROSS", items: ItemInput[], ret: AccidentService["ret"]) {
  const computed = items.map((it) => computeItem(mode, it));
  // Zusatzkosten exakt wie bei der Rückgabe bestätigt (Rundung der Formel nicht neu interpretieren)
  computed.forEach((ci, i) => {
    const src = items[i].extraChargeId ? ret?.extraCharges.find((e) => e.id === items[i].extraChargeId) : null;
    if (src && (mode === "GROSS" ? ci.amounts.gross : ci.amounts.net) !== toCents(src.amount)) computed[i] = computeItem(mode, { ...items[i], quantity: 1, unit: "pauschal", unitPrice: String(src.amount) });
  });
  return { computed, totals: summarize(computed.map((ci) => ({ taxRateBp: ci.taxRateBp, amounts: ci.amounts }))) };
}

export type AccidentInvoicePreview = {
  type: "INTERIM" | "FINAL"; typeLabel: string; periodStart: Date; end: Date; days: number; totalDays: number; priorDays: number; prior: string[];
  pricesIncludeTax: boolean;
  items: { description: string; quantity: string; unit: string; unitPriceCents: Cents; netCents: Cents; taxCents: Cents; grossCents: Cents }[];
  netCents: Cents; taxCents: Cents; grossCents: Cents;
};

/** Vorschau der nächsten Leistungsrechnung (nichts wird gespeichert) – dieselbe Rechnung wie createAccidentInvoiceDraft. */
export async function previewAccidentInvoice(tenantId: string, input: { caseId: string; periodEnd?: Date | null }): Promise<AccidentInvoicePreview> {
  const c = await db.accidentReplacementCase.findFirst({ where: { id: input.caseId, tenantId }, include: { tariffItems: { orderBy: { sortOrder: "asc" } } } });
  if (!c) throw new DomainError("Unfallersatzfall nicht gefunden.");
  const s = await accidentServiceData(db, tenantId, c, input.periodEnd);
  const { computed, totals } = computeAccidentItems(s.mode, s.items, s.ret);
  return {
    type: s.type, typeLabel: ACCIDENT_BILLING_TYPES[s.type], periodStart: s.periodStart, end: s.end, days: s.days, totalDays: s.totalDays, priorDays: s.priorDays, prior: s.prior,
    pricesIncludeTax: s.mode === "GROSS",
    items: computed.map((ci) => ({ description: ci.description, quantity: (ci.quantityH / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 }), unit: ci.unit, unitPriceCents: ci.unitPriceC, netCents: ci.amounts.net, taxCents: ci.amounts.tax, grossCents: ci.amounts.gross })),
    netCents: totals.total.net, taxCents: totals.total.tax, grossCents: totals.total.gross,
  };
}

const cleanField = (v: string | null | undefined, max = 200) => v?.replace(/\s+/g, " ").trim().slice(0, max) || null;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Anderer Rechnungsempfänger: Rechnungsdaten manuell erfasst (kein Kundenstamm, kein stiller Rückgriff auf den Mieter). */
function otherRecipientOf(o: AccidentRecipientInput | null | undefined): InvoiceCustomerSnapshot {
  const type = o?.type === "COMPANY" ? "COMPANY" : "PRIVATE";
  const companyName = cleanField(o?.companyName), firstName = cleanField(o?.firstName, 100) ?? "", lastName = cleanField(o?.lastName, 100) ?? "";
  const street = cleanField(o?.street), zip = cleanField(o?.zip, 20), city = cleanField(o?.city, 100), email = cleanField(o?.email, 320);
  const country = (cleanField(o?.country, 2) ?? "DE").toUpperCase();
  if (type === "COMPANY" ? !companyName : !lastName) throw new DomainError(type === "COMPANY" ? "Anderer Empfänger: bitte den Firmennamen angeben." : "Anderer Empfänger: bitte den Namen angeben.");
  if (!street || !zip || !city) throw new DomainError("Anderer Empfänger: bitte die vollständige Anschrift angeben (Straße, PLZ, Ort).");
  if (email && !EMAIL_RE.test(email)) throw new DomainError("Anderer Empfänger: die E-Mail-Adresse ist ungültig.");
  return { number: null, type, companyName: type === "COMPANY" ? companyName : null, firstName, lastName, street, zip, city, country, email };
}

/**
 * Befehl 29: Unfallersatz-Rechnung (kind ACCIDENT_REPLACEMENT) als Entwurf mit Fassung 1. Leistungsrechnung (Zwischen- oder
 * Schlussrechnung) aus der tatsächlichen Mietdauer und dem Vertragstarif; Rechnungsempfänger bewusst gewählt: Versicherung
 * (Kopie aus der Fallakte), Mieter (Vertragskopie) oder anderer Empfänger (manuell erfasst). Je Fall höchstens ein offener
 * Entwurf. Doppelklick: derselbe Formularschlüssel liefert denselben Entwurf (sourceHash). Geschlossener Fall: gesperrt.
 */
export async function createAccidentInvoiceDraft(tenantId: string, actor: Actor, input: { caseId: string; recipientRole: InvoiceRecipientRole; periodEnd?: Date | null; nonce: string; other?: AccidentRecipientInput | null }): Promise<{ invoice: InvoiceRow; created: boolean }> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  if (!(input.recipientRole in INVOICE_RECIPIENT_ROLES)) throw new DomainError("Bitte den Rechnungsempfänger wählen.");
  const other = input.recipientRole === "OTHER" ? otherRecipientOf(input.other) : null;
  const sourceHash = sha256(`accident:${tenantId}:${input.caseId}:${input.nonce}`);
  return db.$transaction(async (tx) => {
    const c = await tx.accidentReplacementCase.findFirst({ where: { id: input.caseId, tenantId }, include: { tariffItems: { orderBy: { sortOrder: "asc" } } } });
    if (!c) throw new DomainError("Unfallersatzfall nicht gefunden.");
    // Reihenfolge der Sperren: Fall (geteilt) → Buchung
    await assertAccidentCaseOpen(tx, tenantId, c.bookingId);
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${c.bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const existing = await tx.invoice.findFirst({ where: { tenantId, kind: "ACCIDENT_REPLACEMENT", sourceHash } });
    if (existing) return { invoice: existing, created: false };
    const openDraft = await tx.invoice.findFirst({ where: { tenantId, bookingId: c.bookingId, kind: "ACCIDENT_REPLACEMENT", documentType: "INVOICE", status: "DRAFT" }, select: { createdAt: true } });
    if (openDraft) throw new DomainError(`Zu diesem Fall ist bereits ein Rechnungsentwurf offen (angelegt ${dateFmt(openDraft.createdAt)}). Bitte zuerst abschließen oder verwerfen.`);
    const s = await accidentServiceData(tx, tenantId, c, input.periodEnd);
    const { booking, ret } = s;
    const { computed, totals } = computeAccidentItems(s.mode, s.items, ret);
    const now = new Date();
    const dayWord = s.days === 1 ? "Tag" : "Tage";
    // Empfänger nach Rolle; der Mieter bleibt als Geschädigter immer nachvollziehbar
    const renter = customerSnapshotFromContract(booking.contract!.customerSnapshot as Partial<CustomerSnapshot>);
    const renterName = renter.type === "COMPANY" && renter.companyName ? renter.companyName : `${renter.firstName} ${renter.lastName}`.trim();
    const billing: AccidentBilling = { type: s.type, days: s.days, totalDays: s.totalDays, priorDays: s.priorDays, prior: s.prior };
    const common = { claimNumber: c.insurerClaimNumber ?? null, accidentDate: c.accidentAt?.toISOString() ?? null, caseNumber: c.caseNumber, accidentBilling: billing };
    let customer: InvoiceCustomerSnapshot;
    if (input.recipientRole === "INSURER") {
      if (!c.insurerName?.trim()) throw new DomainError("In der Fallakte ist keine Versicherung erfasst. Bitte zuerst die Versicherung eintragen.");
      customer = { number: null, type: "COMPANY", companyName: c.insurerName.trim(), firstName: "", lastName: "", street: c.insurerStreet ?? null, zip: c.insurerZip ?? null, city: c.insurerCity ?? null, country: "DE", email: c.insurerEmail ?? null, recipientRole: "INSURER", insuredName: renterName, ...common };
    } else if (input.recipientRole === "OTHER") {
      customer = { ...other!, recipientRole: "OTHER", insuredName: renterName, ...common };
    } else {
      customer = { ...renter, recipientRole: "RENTER", ...common };
    }
    const invoice = await tx.invoice.create({
      data: {
        tenantId, bookingId: booking.id, customerId: booking.customerId, contractId: booking.contract!.id, returnHandoverId: ret?.id ?? null,
        kind: "ACCIDENT_REPLACEMENT", sourceHash, createdById: actor.id,
        changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `${ACCIDENT_BILLING_TYPES[s.type]} zum Fall ${c.caseNumber} als Entwurf erstellt (${INVOICE_RECIPIENT_ROLES[input.recipientRole]}, ${s.days} ${dayWord}${s.priorDays ? `, bereits berechnet ${s.priorDays}` : ""}, ${computed.length} Positionen)` }],
      },
    });
    const version = await tx.invoiceVersion.create({
      data: {
        tenantId, invoiceId: invoice.id, versionNo: 1, kind: "ORIGINAL",
        servicePeriodStart: s.periodStart, servicePeriodEnd: s.end, pricesIncludeTax: s.mode === "GROSS",
        customerSnapshot: customer as unknown as Prisma.InputJsonValue, companySnapshot: companySnapshotOf(booking.tenant),
        netTotal: centsToDecimalString(totals.total.net), taxTotal: centsToDecimalString(totals.total.tax), grossTotal: centsToDecimalString(totals.total.gross),
        paymentTermDays: booking.tenant.paymentTermDays, taxNote: booking.tenant.taxNote,
        createdById: actor.id, createdByName: actor.name,
      },
    });
    await tx.invoiceVersionItem.createMany({ data: computed.map((ci, i) => itemData(tenantId, version.id, i, ci)) });
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "INVOICE_CREATED", toValue: input.recipientRole, note: `${ACCIDENT_BILLING_TYPES[s.type]} als Entwurf über ${fmtCents(totals.total.gross)} (${s.days} ${dayWord})` });
    await recordAudit(tx, tenantId, actor, { action: "INVOICE_DRAFT_CREATED", bookingId: booking.id, invoiceId: invoice.id, amountCents: totals.total.gross, details: { kind: "ACCIDENT_REPLACEMENT", caseNumber: c.caseNumber, recipientRole: input.recipientRole, billingType: s.type, days: s.days, priorDays: s.priorDays } });
    return { invoice, created: true };
  }, TX);
}

/** Restbetrag einer gekürzten Versicherungsrechnung, der noch nicht als Restforderung gestellt ist (wirksame Restforderungen). */
export async function remainderAvailability(client: Client, tenantId: string, insurerInvoiceId: string, opts: { excludeInvoiceId?: string } = {}) {
  const inv = await client.invoice.findFirst({ where: { id: insurerInvoiceId, tenantId, kind: "ACCIDENT_REPLACEMENT", documentType: "INVOICE" }, select: { id: true, number: true, status: true, bookingId: true, currentVersion: { select: { customerSnapshot: true } } } });
  if (!inv) throw new DomainError("Rechnung nicht gefunden.");
  const reduced = (await client.invoiceAdjustment.aggregate({ where: { tenantId, invoiceId: inv.id, status: "CONFIRMED" }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
  const chain = inv.bookingId ? await accidentInvoiceChain(client, tenantId, inv.bookingId, { excludeInvoiceId: opts.excludeInvoiceId }) : null;
  const remainders = (chain?.invoices ?? []).filter((i) => i.billing?.type === "REMAINDER" && i.billing.remainderOf?.invoiceId === inv.id && (i.effective || i.status === "DRAFT"));
  const claimedCents = remainders.reduce((s, i) => s + i.grossCents, 0);
  const self = chain?.invoices.find((i) => i.id === inv.id) ?? null;
  // Was die Versicherung bereits gezahlt hat, kann nicht zusätzlich beim Mieter verlangt werden: höchstens der Teil des
  // ursprünglichen Rechnungsbetrags, den sie (noch) nicht gezahlt hat – und höchstens die dokumentierte Kürzung
  const paidByInsurer = (await client.payment.aggregate({ where: { tenantId, invoiceId: inv.id, status: "CONFIRMED" }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
  const cap = Math.min(reduced, Math.max(0, (self?.grossCents ?? 0) - paidByInsurer));
  return { invoice: inv, role: recipientRoleOf(inv.currentVersion?.customerSnapshot as { recipientRole?: string } | null), effective: !!self?.effective, reducedCents: reduced, paidByInsurerCents: paidByInsurer, claimedCents, availableCents: Math.max(0, cap - claimedCents), remainders };
}

/**
 * Restforderung an den Mieter – bewusst, nie automatisch: eine Position über den gewählten Betrag (höchstens die dokumentierte
 * Kürzung abzüglich bereits gestellter Restforderungen), Bezug auf die Versicherungsrechnung in der versiegelten Kopie.
 * Rent-Base entscheidet nicht, ob der Mieter den Betrag schuldet, und bucht nichts um: Die Versicherungsrechnung bleibt
 * unverändert offen, bis sie bezahlt oder per Gutschrift gemindert wird (Hinweis in Prüfliste, Fallakte und Abschluss).
 * Beträge sind Bruttobeträge (die Kürzung ist brutto dokumentiert) – deshalb rechnet diese Fassung immer brutto.
 */
export async function createAccidentRemainderDraft(tenantId: string, actor: Actor, input: { caseId: string; invoiceId: string; amountCents: Cents; nonce: string }): Promise<{ invoice: InvoiceRow; created: boolean }> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DomainError("Der Betrag der Restforderung muss größer als 0,00 € sein.");
  const sourceHash = sha256(`accident-remainder:${tenantId}:${input.caseId}:${input.nonce}`);
  return db.$transaction(async (tx) => {
    const c = await tx.accidentReplacementCase.findFirst({ where: { id: input.caseId, tenantId } });
    if (!c) throw new DomainError("Unfallersatzfall nicht gefunden.");
    await assertAccidentCaseOpen(tx, tenantId, c.bookingId);
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${c.bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const existing = await tx.invoice.findFirst({ where: { tenantId, kind: "ACCIDENT_REPLACEMENT", sourceHash } });
    if (existing) return { invoice: existing, created: false };
    const openDraft = await tx.invoice.findFirst({ where: { tenantId, bookingId: c.bookingId, kind: "ACCIDENT_REPLACEMENT", documentType: "INVOICE", status: "DRAFT" }, select: { createdAt: true } });
    if (openDraft) throw new DomainError(`Zu diesem Fall ist bereits ein Rechnungsentwurf offen (angelegt ${dateFmt(openDraft.createdAt)}). Bitte zuerst abschließen oder verwerfen.`);
    const a = await remainderAvailability(tx, tenantId, input.invoiceId);
    if (a.invoice.bookingId !== c.bookingId) throw new DomainError("Die Rechnung gehört nicht zu diesem Unfallersatzfall.");
    if (a.invoice.status !== "FINALIZED") throw new DomainError("Eine Restforderung gibt es nur zu einer abgeschlossenen Rechnung.");
    if (a.role !== "INSURER") throw new DomainError("Eine Restforderung an den Mieter gibt es nur zu einer Rechnung an die Versicherung.");
    if (!a.effective) throw new DomainError(`Die Rechnung ${a.invoice.number} ist storniert bzw. vollständig gutgeschrieben.`);
    if (a.reducedCents <= 0) throw new DomainError(`Zur Rechnung ${a.invoice.number} ist keine Kürzung der Versicherung dokumentiert.`);
    if (input.amountCents > a.availableCents) throw new DomainError(a.availableCents === 0 ? (a.claimedCents > 0 ? `Die dokumentierte Kürzung zur Rechnung ${a.invoice.number} ist bereits vollständig als Restforderung gestellt.` : `Die Versicherung hat die Rechnung ${a.invoice.number} bereits (bis auf weniger als die Kürzung) bezahlt; eine Restforderung an den Mieter ist dafür nicht möglich.`) : `Höchstens ${fmtCents(a.availableCents)}: dokumentierte Kürzung ${fmtCents(a.reducedCents)}, von der Versicherung bereits gezahlt ${fmtCents(a.paidByInsurerCents)}, bereits als Restforderung gestellt ${fmtCents(a.claimedCents)}.`);
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: c.bookingId }, include: { contract: true, tenant: true } });
    if (!booking.contract) throw new DomainError("Zu dieser Buchung gibt es keinen Mietvertrag.");
    const tenant = booking.tenant;
    const missing = invoiceSettingsMissing(tenant);
    if (missing.length > 0) throw new DomainError(`Bevor Rechnungen erstellt werden können, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
    const iv = (await tx.invoice.findUniqueOrThrow({ where: { id: a.invoice.id }, select: { currentVersion: { select: { servicePeriodStart: true, servicePeriodEnd: true, customerSnapshot: true } } } })).currentVersion;
    if (!iv) throw new DomainError("Die Versicherungsrechnung hat keine abgeschlossene Fassung.");
    const ic = iv.customerSnapshot as InvoiceCustomerSnapshot;
    const renter = customerSnapshotFromContract(booking.contract.customerSnapshot as Partial<CustomerSnapshot>);
    const customer: InvoiceCustomerSnapshot = {
      ...renter, recipientRole: "RENTER", claimNumber: ic.claimNumber ?? c.insurerClaimNumber ?? null, accidentDate: c.accidentAt?.toISOString() ?? null, caseNumber: c.caseNumber,
      accidentBilling: { type: "REMAINDER", remainderOf: { invoiceId: a.invoice.id, number: a.invoice.number, insurerName: ic.companyName ?? null } },
    };
    const item = computeItem("GROSS", {
      description: `Restforderung zur Rechnung ${a.invoice.number} an ${ic.companyName ?? "die Versicherung"} (Unfallersatzfall ${c.caseNumber}${customer.claimNumber ? `, Schadennummer ${customer.claimNumber}` : ""}): von der Versicherung nicht übernommener Betrag`,
      quantity: 1, unit: "pauschal", unitPrice: centsToDecimalString(input.amountCents), taxRate: Number(tenant.defaultTaxRate), source: "MANUAL", reference: `Restforderung zu ${a.invoice.number}`,
    });
    const totals = summarize([{ taxRateBp: item.taxRateBp, amounts: item.amounts }]);
    const now = new Date();
    const invoice = await tx.invoice.create({
      data: {
        tenantId, bookingId: booking.id, customerId: booking.customerId, contractId: booking.contract.id, returnHandoverId: null,
        kind: "ACCIDENT_REPLACEMENT", sourceHash, createdById: actor.id,
        changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Restforderung an den Mieter zur Rechnung ${a.invoice.number} über ${fmtCents(input.amountCents)} als Entwurf erstellt (dokumentierte Kürzung ${fmtCents(a.reducedCents)})` }],
      },
    });
    const version = await tx.invoiceVersion.create({
      data: {
        tenantId, invoiceId: invoice.id, versionNo: 1, kind: "ORIGINAL",
        servicePeriodStart: iv.servicePeriodStart, servicePeriodEnd: iv.servicePeriodEnd, pricesIncludeTax: true,
        customerSnapshot: customer as unknown as Prisma.InputJsonValue, companySnapshot: companySnapshotOf(tenant),
        netTotal: centsToDecimalString(totals.total.net), taxTotal: centsToDecimalString(totals.total.tax), grossTotal: centsToDecimalString(totals.total.gross),
        paymentTermDays: tenant.paymentTermDays, taxNote: tenant.taxNote,
        createdById: actor.id, createdByName: actor.name,
      },
    });
    await tx.invoiceVersionItem.createMany({ data: [itemData(tenantId, version.id, 0, item)] });
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "INVOICE_CREATED", toValue: "RENTER", note: `Restforderung zur Rechnung ${a.invoice.number} über ${fmtCents(input.amountCents)} (Entwurf)` });
    await recordAudit(tx, tenantId, actor, { action: "INVOICE_DRAFT_CREATED", bookingId: booking.id, invoiceId: invoice.id, amountCents: input.amountCents, details: { kind: "ACCIDENT_REPLACEMENT", caseNumber: c.caseNumber, recipientRole: "RENTER", billingType: "REMAINDER", remainderOf: a.invoice.number, reducedCents: a.reducedCents } });
    return { invoice, created: true };
  }, TX);
}

/** Prüfliste einer Unfallersatz-Rechnung (Fassung 1 und spätere): Fall offen, Abrechnungskette, Restforderung, Miettage. */
async function accidentIssues(tx: Tx, tenantId: string, invoice: InvoiceRow, draft: VersionWithItems, booking: { id: string; status: string; actualPickupAt: Date | null; actualReturnAt: Date | null } | null, err: (code: string, message: string) => void, warn: (code: string, message: string) => void) {
  if (!booking) return;
  if (await accidentCaseClosed(tx, tenantId, booking.id)) err("CASE_CLOSED", ACCIDENT_CASE_CLOSED_MESSAGE);
  const billing = accidentBillingOf(draft.customerSnapshot);
  const pickup = booking.actualPickupAt;
  if (billing?.type === "REMAINDER") {
    if (!billing.remainderOf) return;
    const a = await remainderAvailability(tx, tenantId, billing.remainderOf.invoiceId, { excludeInvoiceId: invoice.id });
    if (!a.effective) err("REMAINDER_SOURCE", `Die Versicherungsrechnung ${a.invoice.number} ist storniert bzw. vollständig gutgeschrieben. Bitte diesen Entwurf verwerfen.`);
    const gross = toCents(draft.grossTotal);
    if (gross > a.availableCents) err("REMAINDER_AMOUNT", `Die Restforderung (${fmtCents(gross)}) übersteigt den zulässigen Betrag (${fmtCents(a.availableCents)}: dokumentierte Kürzung, abzüglich bereits von der Versicherung gezahlt und bereits gestellter Restforderungen).`);
    warn("REMAINDER_DOUBLE", `Derselbe Betrag ist auch in der Rechnung ${a.invoice.number} an die Versicherung enthalten und bleibt dort offen. Rent-Base bucht nichts um: Wird der Mieter in Anspruch genommen, die Versicherungsrechnung entsprechend per Gutschrift mindern – sonst ist der Betrag doppelt gefordert.`);
    return;
  }
  if (!pickup) return;
  if (draft.versionNo === 1) {
    const chain = await accidentInvoiceChain(tx, tenantId, booking.id, { excludeInvoiceId: invoice.id, pickupAt: pickup });
    const chained = chain.billedUntil && chain.billedUntil > pickup ? chain.billedUntil : pickup;
    const expectedStart = chained > draft.servicePeriodEnd ? draft.servicePeriodEnd : chained;
    if (Math.abs(draft.servicePeriodStart.getTime() - expectedStart.getTime()) > 60_000) err("PERIOD_CHAIN", `Die Abrechnung hat sich seit dem Entwurf geändert (abgerechnet bis ${dateFmt(expectedStart)}). Bitte diesen Entwurf verwerfen und neu erstellen, damit kein Miettag doppelt oder gar nicht berechnet wird.`);
    if (billing?.type === "FINAL") {
      if (booking.status !== "RETURNED" || !booking.actualReturnAt) err("FINAL_NOT_RETURNED", "Eine Schlussrechnung gibt es erst nach der Rückgabe.");
      else if (Math.abs(draft.servicePeriodEnd.getTime() - booking.actualReturnAt.getTime()) > 60_000) err("FINAL_PERIOD", "Die Schlussrechnung endet nicht mit der tatsächlichen Rückgabe. Bitte diesen Entwurf verwerfen und neu erstellen.");
    }
    if (chain.service.some((i) => i.billing?.type === "FINAL")) err("FINAL_EXISTS", "Zu diesem Fall gibt es bereits eine wirksame Schlussrechnung.");
  }
  // Grundmiete: Miettage laut Leistungszeitraum (Abweichung nur als Hinweis – bewusst geänderte Mengen bleiben möglich)
  const expected = Math.max(0, rentalDays(pickup, draft.servicePeriodEnd) - (draft.servicePeriodStart > pickup ? rentalDays(pickup, draft.servicePeriodStart) : 0));
  const inItems = rentalDaysInItems(draft.items);
  if (inItems !== expected) warn("DAYS", `Grundmiete: ${inItems.toLocaleString("de-DE")} ${inItems === 1 ? "Tag" : "Tage"} in den Positionen, laut Leistungszeitraum ${expected} ${expected === 1 ? "Miettag" : "Miettage"}.`);
}

/**
 * Befehl 25 (Absicherung): Preiserhöhung aus einem Nachtrag, der in der bereits abgeschlossenen Mietrechnung nicht enthalten
 * ist, als eigene freie Rechnung (Entwurf, Bezug Buchung) mit genau einer Position (Abrechnungsbezug amendmentId). Die
 * abgeschlossene Rechnung bleibt unverändert; der Nachtrag merkt sich den Abrechnungsbeleg (einmalig, Datenbank-Trigger).
 */
export async function createAmendmentSettlementDraft(tenantId: string, actor: Actor, input: { amendmentId: string; nonce: string }): Promise<{ invoice: InvoiceRow; created: boolean }> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const sourceHash = sha256(`amendment-settlement:${tenantId}:${input.amendmentId}`);
  return db.$transaction(async (tx) => {
    const lockedA = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ContractAmendment" WHERE "id" = ${input.amendmentId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (lockedA.length === 0) throw new DomainError("Nachtrag nicht gefunden.");
    const a = await tx.contractAmendment.findUniqueOrThrow({ where: { id: input.amendmentId }, include: { booking: { select: { id: true, number: true, customerId: true, status: true } }, contract: { select: { number: true } } } });
    if (a.status !== "SIGNED" || !a.number) throw new DomainError("Abgerechnet wird nur ein unterschriebener, wirksamer Nachtrag.");
    if (!a.priceDeltaCents || a.priceDeltaCents <= 0) throw new DomainError("Dieser Nachtrag enthält keine Preiserhöhung. Eine Preisminderung nach abgeschlossener Rechnung wird als Gutschrift zur Mietrechnung erstellt.");
    if (a.settlementInvoiceId) {
      const existing = await tx.invoice.findFirst({ where: { id: a.settlementInvoiceId, tenantId } });
      if (existing) return { invoice: existing, created: false };
    }
    const sameSource = await tx.invoice.findFirst({ where: { tenantId, kind: "GENERAL", sourceHash } });
    if (sameSource) return { invoice: sameSource, created: false };
    const billed = await tx.invoiceVersionItem.count({ where: { tenantId, amendmentId: a.id, version: { status: "FINALIZED" } } });
    if (billed > 0) throw new DomainError("Diese Vertragsänderung ist bereits in einer abgeschlossenen Rechnung enthalten.");
    const rental = await tx.invoice.findFirst({ where: { tenantId, bookingId: a.bookingId, kind: "RENTAL", documentType: "INVOICE", status: "FINALIZED" }, select: { number: true } });
    if (!rental) throw new DomainError("Die Mietrechnung ist noch nicht abgeschlossen; die Vertragsänderung wird dort als Position aufgenommen.");
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: a.booking.customerId } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const missing = invoiceSettingsMissing(tenant);
    if (missing.length > 0) throw new DomainError(`Bevor Rechnungen erstellt werden können, muss der Inhaber in den Einstellungen ergänzen: ${missing.join("; ")}.`);
    const mode = tenant.pricesIncludeTax ? "GROSS" : "NET";
    const item = computeItem(mode, { description: amendmentItemDescription(a, a.contract.number), quantity: 1, unit: "pauschal", unitPrice: centsToDecimalString(a.priceDeltaCents), taxRate: Number(tenant.defaultTaxRate), source: "AMENDMENT", amendmentId: a.id, reference: `Nachtrag ${a.number}` });
    const totals = summarize([{ taxRateBp: item.taxRateBp, amounts: item.amounts }]);
    const snap = a.snapshot as { before?: { endAt?: string } } | null;
    const periodStart = snap?.before?.endAt ? new Date(snap.before.endAt) : a.signedAt ?? new Date();
    const periodEnd = a.newEndAt && a.newEndAt > periodStart ? a.newEndAt : periodStart;
    const now = new Date();
    const invoice = await tx.invoice.create({
      data: {
        tenantId, bookingId: a.bookingId, customerId: customer.id, contractId: a.contractId, kind: "GENERAL", sourceHash, createdById: actor.id,
        changeLog: [{ at: now.toISOString(), by: actor.name, versionNo: 1, summary: `Abrechnung der Vertragsänderung laut Nachtrag ${a.number} als Entwurf angelegt (Mietrechnung ${rental.number} bereits abgeschlossen, Bezug Buchung ${a.booking.number})` }],
      },
    });
    const version = await tx.invoiceVersion.create({
      data: {
        tenantId, invoiceId: invoice.id, versionNo: 1, kind: "ORIGINAL",
        servicePeriodStart: periodStart, servicePeriodEnd: periodEnd, pricesIncludeTax: mode === "GROSS",
        customerSnapshot: customerSnapshotFromCustomer(customer), companySnapshot: companySnapshotOf(tenant),
        netTotal: centsToDecimalString(totals.total.net), taxTotal: centsToDecimalString(totals.total.tax), grossTotal: centsToDecimalString(totals.total.gross),
        paymentTermDays: tenant.paymentTermDays, taxNote: tenant.taxNote,
        createdById: actor.id, createdByName: actor.name,
      },
    });
    await tx.invoiceVersionItem.create({ data: itemData(tenantId, version.id, 0, item) });
    await tx.contractAmendment.update({ where: { id: a.id }, data: { settlementInvoiceId: invoice.id } });
    await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_SETTLEMENT_CREATED", bookingId: a.bookingId, invoiceId: invoice.id, amountCents: a.priceDeltaCents, details: { amendmentId: a.id, number: a.number, rentalInvoice: rental.number } });
    return { invoice, created: true };
  }, TX);
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
export type EditModeInfo = { mode: EditMode; nextKind: "REVISION" | "CORRECTION"; delivered: boolean; exported: boolean; paidCents: Cents; currentGrossCents: Cents; reasons: string[]; /** abgeschlossene Gutschriften/Stornobelege: danach keine Berichtigung mehr */ counterFinalized: number; counterDraft: boolean; editable: boolean; blockedReason: string | null; /** Phase 18: bereits erstattet (abgeschlossene Auszahlungen); Befehl 22: inkl. Rückführungen zur Kaution */ completedRefundCents: Cents };

async function editModeOf(client: Tx | typeof db, tenantId: string, invoice: InvoiceRow, current: VersionRow): Promise<EditModeInfo> {
  const [delivery, paid, counters, refunds, returns] = await Promise.all([
    deliveryStateOf(tenantId, current, client),
    client.payment.aggregate({ where: { tenantId, invoiceId: invoice.id, status: "CONFIRMED" }, _sum: { amountCents: true } }),
    client.invoice.findMany({ where: { tenantId, originalInvoiceId: invoice.id, status: { in: ["DRAFT", "FINALIZED"] } }, select: { status: true } }),
    client.payout.aggregate({ where: { tenantId, invoiceId: invoice.id, status: "COMPLETED" }, _sum: { amountCents: true } }),
    client.securityDepositEvent.aggregate({ where: { tenantId, invoiceId: invoice.id, type: "OFFSET_RETURN", status: "CONFIRMED" }, _sum: { amountCents: true } }),
  ]);
  const exported = !!invoice.exportedAt || !!current.exportedAt;
  const paidCents = paid._sum.amountCents ?? 0;
  const mode: EditMode = exported ? "D" : paidCents > 0 ? "C" : delivery.delivered ? "B" : "A";
  const reasons: string[] = [];
  if (delivery.sentAt) reasons.push(`per E-Mail versendet am ${dateFmt(delivery.sentAt)}${delivery.sentTo ? ` an ${delivery.sentTo}` : ""}`);
  if (delivery.deliveredAt) reasons.push(`manuell als übergeben markiert am ${dateFmt(delivery.deliveredAt)}${delivery.deliveredByName ? ` von ${delivery.deliveredByName}` : ""}`);
  const counterFinalized = counters.filter((c) => c.status === "FINALIZED").length;
  const counterDraft = counters.some((c) => c.status === "DRAFT");
  const blockedReason = invoice.documentType !== "INVOICE"
    ? "Gutschriften und Stornobelege erhalten keine weitere Fassung. Ein fehlerhafter Beleg wird durch einen weiteren Beleg korrigiert."
    : exported ? "Diese Rechnung wurde bereits buchhalterisch exportiert. Eine Änderung unter derselben Rechnungsnummer ist nicht mehr möglich; Korrekturen laufen über Gutschrift oder Stornobeleg."
    : counterFinalized > 0 ? `Zu dieser Rechnung gibt es bereits ${counterFinalized === 1 ? "einen abgeschlossenen Gegenbeleg" : `${counterFinalized} abgeschlossene Gegenbelege`} (Gutschrift oder Storno). Sie wird nicht mehr berichtigt; weitere Änderungen nur über einen weiteren Gegenbeleg.`
    : counterDraft ? "Zu dieser Rechnung ist ein Entwurf einer Gutschrift oder eines Stornobelegs offen. Bitte zuerst abschließen oder verwerfen."
    : null;
  return { mode, nextKind: delivery.delivered ? "CORRECTION" : "REVISION", delivered: delivery.delivered, exported, paidCents, currentGrossCents: toCents(current.grossTotal), reasons, counterFinalized, counterDraft, editable: blockedReason === null, blockedReason, completedRefundCents: (refunds._sum.amountCents ?? 0) + (returns._sum.amountCents ?? 0) };
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
      await assertAccidentInvoiceCaseOpen(tx, tenantId, invoiceId);
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Rechnung nicht gefunden.");
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (invoice.status !== "FINALIZED" || !invoice.currentVersionId) throw new DomainError("Nur abgeschlossene Rechnungen können bearbeitet werden.");
      const again = await tx.invoiceVersion.findFirst({ where: { tenantId, invoiceId, status: "DRAFT" }, include: withItems });
      if (again) return again;
      const current = await tx.invoiceVersion.findFirstOrThrow({ where: { id: invoice.currentVersionId, tenantId }, include: withItems });
      const info = await editModeOf(tx, tenantId, invoice, current);
      if (info.blockedReason) throw new DomainError(info.blockedReason);
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
        data: current.items.map((i) => ({ tenantId, versionId: draft.id, sortOrder: i.sortOrder, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, netAmount: i.netAmount, taxRate: i.taxRate, taxAmount: i.taxAmount, grossAmount: i.grossAmount, source: i.source, extraChargeId: i.extraChargeId, amendmentId: i.amendmentId, reference: i.reference })),
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

export type CustomerInput = Partial<Pick<InvoiceCustomerSnapshot, "type" | "companyName" | "firstName" | "lastName" | "street" | "zip" | "city" | "country" | "email" | "claimNumber" | "insuredName">>;
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
  const locked = await tx.$queryRaw<{ id: string; status: string; number: string | null; exportedAt: Date | null; documentType: string }[]>`SELECT "id", "status", "number", "exportedAt", "documentType" FROM "Invoice" WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
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
  const kindOf = await db.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { documentType: true } });
  if (kindOf && kindOf.documentType !== "INVOICE") throw new DomainError("Gutschriften und Stornobelege werden über ihren eigenen Entwurf bearbeitet.");
  if (input.paymentTermDays != null && !(Number.isInteger(input.paymentTermDays) && input.paymentTermDays >= 0 && input.paymentTermDays <= 365)) throw new DomainError("Das Zahlungsziel liegt zwischen 0 und 365 Tagen.");
  if (input.servicePeriodStart && input.servicePeriodEnd && input.servicePeriodEnd.getTime() < input.servicePeriodStart.getTime()) throw new DomainError("Das Ende des Leistungszeitraums liegt vor dem Beginn.");
  return db.$transaction(async (tx) => {
    // Phase F: geschlossener Unfallersatzfall – kein Bearbeiten (vor der Rechnungssperre)
    await assertAccidentInvoiceCaseOpen(tx, tenantId, invoiceId);
    const { draft } = await lockDraft(tx, tenantId, invoiceId);
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    // Steuerliche Behandlung (Schadenabrechnung, Befehl 28 auch Stornogebühr): bleibt wie in der Fassung, bis sie bewusst geändert wird
    let taxTreatment = draft.taxTreatment;
    if (input.taxTreatment !== undefined && (input.taxTreatment ?? null) !== (draft.taxTreatment ?? null)) {
      const allowed = invoice.kind === "DAMAGE" ? DAMAGE_TAX_TREATMENTS : invoice.kind === "CANCELLATION_FEE" ? CANCELLATION_FEE_TAX_TREATMENTS : null;
      if (!allowed) throw new DomainError("Die steuerliche Behandlung wird nur bei Schadenabrechnungen und Stornogebühren festgelegt.");
      if (!input.taxTreatment || !(input.taxTreatment in allowed)) throw new DomainError("Bitte die steuerliche Behandlung auswählen.");
      taxTreatment = input.taxTreatment;
    }
    const nonTaxable = taxTreatment === "NON_TAXABLE_DAMAGE_COMPENSATION" || taxTreatment === "NON_TAXABLE_FEE";
    // Erlaubte Sätze: konfigurierter Standardsatz, 0 % und alle Sätze, die die Fassung bereits enthält (Korrektur ändert keine Steuerlogik)
    const allowedRates = new Set([toBasisPoints(tenant.defaultTaxRate ?? 0), 0, ...draft.items.map((i) => toBasisPoints(i.taxRate))]);
    const mode = draft.pricesIncludeTax ? "GROSS" : "NET";
    const before = new Map(draft.items.map((i) => [i.id, i]));
    const computed = input.items.map((it) => {
      const prev = it.id ? before.get(it.id) : undefined;
      // Echter Schadensersatz: keine Position trägt einen Steuersatz – unabhängig von der Eingabe
      const ci = computeItem(mode, { ...it, taxRate: nonTaxable ? "0" : it.taxRate, source: prev?.source as ItemInput["source"] | undefined ?? "MANUAL", extraChargeId: prev?.extraChargeId ?? null, amendmentId: prev?.amendmentId ?? null, reference: prev?.reference ?? it.reference ?? null });
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
    // Phase F: Unfallersatz – der Leistungszeitraum ergibt sich aus Übergabe, Stichtag bzw. Rückgabe (Abrechnungskette), nie frei
    if (invoice.kind === "ACCIDENT_REPLACEMENT" && (servicePeriodStart.getTime() !== draft.servicePeriodStart.getTime() || servicePeriodEnd.getTime() !== draft.servicePeriodEnd.getTime())) throw new DomainError("Der Leistungszeitraum einer Unfallersatz-Rechnung ergibt sich aus Übergabe, Stichtag bzw. Rückgabe und ist nicht änderbar.");
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
  // Befehl 23.1: freie Rechnungen (GENERAL) und deren Mahngebühren dürfen ohne Buchung bestehen; alle anderen Arten brauchen ihre Buchung
  const booking = invoice.bookingId ? await tx.booking.findFirst({ where: { id: invoice.bookingId, tenantId }, include: { contract: { select: { status: true } } } }) : null;
  if (!booking && (invoice.bookingId || (invoice.kind !== "GENERAL" && invoice.kind !== "DUNNING_FEE"))) err("BOOKING_MISSING", "Buchung nicht gefunden.");
  if (draft.versionNo === 1 && invoice.kind === "DAMAGE") {
    // Schadenabrechnung: braucht Vertrag (Rechnungsempfänger) und eine Schadenakte mit bestätigter Kundenverantwortung
    if (booking && booking.contract?.status !== "SIGNED") err("CONTRACT", "Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag.");
    const dc = invoice.damageCaseId ? await tx.damageCase.findFirst({ where: { id: invoice.damageCaseId, tenantId } }) : null;
    if (!dc) err("DAMAGE_CASE", "Zu dieser Abrechnung gibt es keine Schadenakte.");
    else if (dc.liabilityStatus !== "CUSTOMER_RESPONSIBILITY_CONFIRMED") err("LIABILITY", "Die Haftung des Kunden ist in der Schadenakte nicht (mehr) bestätigt.");
    if (!draft.taxTreatment) err("TAX_TREATMENT", "Die steuerliche Behandlung der Kundenbelastung ist nicht festgelegt.");
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  } else if (draft.versionNo === 1 && invoice.kind === "AUTHORITY_FEE") {
    // Bearbeitungsentgelt: braucht Vertrag (Rechnungsempfänger) und den Behördenvorgang dieser Vermietung
    if (booking && booking.contract?.status !== "SIGNED") err("CONTRACT", "Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag.");
    const ac = invoice.authorityCaseId ? await tx.authorityCase.findFirst({ where: { id: invoice.authorityCaseId, tenantId } }) : null;
    if (!ac) err("AUTHORITY_CASE", "Zu diesem Bearbeitungsentgelt gibt es keinen Behördenvorgang.");
    else if (ac.bookingId !== invoice.bookingId) err("AUTHORITY_CASE", "Der Behördenvorgang ist nicht (mehr) dieser Vermietung zugeordnet.");
    else if (ac.status === "CANCELLED") err("AUTHORITY_CASE", "Der Behördenvorgang wurde storniert.");
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  } else if (draft.versionNo === 1 && invoice.kind === "DUNNING_FEE") {
    // Befehl 23: Mahngebühr – entsteht nur im Mahnvorgang; braucht vollständige Firmendaten
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  } else if (draft.versionNo === 1 && invoice.kind === "CANCELLATION_FEE") {
    // Befehl 28: Stornogebühr – nur zu einer stornierten Buchung, eine je Buchung; Steuerbehandlung wird unten geprüft
    if (booking && booking.status !== "CANCELLED") err("BOOKING_STATUS", "Eine Stornogebühr gibt es nur zu einer stornierten Buchung.");
    const other = await tx.invoice.count({ where: { tenantId, bookingId: invoice.bookingId, kind: "CANCELLATION_FEE", documentType: "INVOICE", status: "FINALIZED", id: { not: invoice.id } } });
    if (other > 0) err("INVOICE_EXISTS", "Zu dieser Buchung gibt es bereits eine Stornogebühr.");
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  } else if (draft.versionNo === 1 && invoice.kind === "GENERAL") {
    // Befehl 23.1: freie Rechnung – Kunde als Empfänger; eine Buchung ist nur Bezug (keine Mietpositionen, keine Kaution)
    if (!invoice.customerId) err("CUSTOMER", "Bitte einen Rechnungsempfänger (Kunden) wählen.");
    if (booking && invoice.customerId && booking.customerId !== invoice.customerId) err("BOOKING_CUSTOMER", "Die gewählte Buchung gehört nicht zu diesem Kunden.");
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  } else if (draft.versionNo === 1 && invoice.kind === "ACCIDENT_REPLACEMENT") {
    // Befehl 29: Unfallersatz – Vertrag unterschrieben, Fahrzeug übergeben; Leistungszeitraum nie in der Zukunft (keine erfundene Mietdauer)
    if (booking && booking.rentalType !== "ACCIDENT_REPLACEMENT") err("RENTAL_TYPE", "Diese Buchung ist keine Unfallersatzmiete.");
    if (booking && booking.contract?.status !== "SIGNED") err("CONTRACT", "Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag.");
    if (booking && !booking.actualPickupAt) err("PICKUP", "Das Fahrzeug wurde noch nicht übergeben; abgerechnet wird erst ab der Übergabe.");
    if (draft.servicePeriodEnd.getTime() > Date.now() + 60_000) err("PERIOD_FUTURE", "Der Leistungszeitraum endet in der Zukunft. Abgerechnet wird nur die tatsächliche Mietdauer (Rückgabe oder Stichtag bis heute).");
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  } else if (draft.versionNo === 1) {
    if (booking && booking.status !== "RETURNED") err("BOOKING_STATUS", "Die Buchung ist nicht zurückgegeben.");
    if (booking && booking.contract?.status !== "SIGNED") err("CONTRACT", "Zu dieser Buchung gibt es keinen abgeschlossenen Mietvertrag.");
    const ret = invoice.returnHandoverId ? await tx.handover.findFirst({ where: { id: invoice.returnHandoverId, tenantId, status: "FINALIZED" } }) : null;
    if (!ret) err("RETURN", "Zu dieser Rechnung gibt es keine abgeschlossene Rückgabe.");
    const other = await tx.invoice.count({ where: { tenantId, bookingId: invoice.bookingId, kind: "RENTAL", documentType: "INVOICE", status: "FINALIZED", id: { not: invoice.id } } });
    if (other > 0) err("INVOICE_EXISTS", "Zu dieser Buchung gibt es bereits eine abgeschlossene Mietrechnung.");
    // Fassung 1 friert die Firmendaten beim Abschluss aus den Einstellungen ein: dort müssen sie vollständig sein
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    for (const m of invoiceSettingsMissing(tenant)) err("COMPANY", `Firmendaten unvollständig: ${m}.`);
  } else {
    // spätere Fassungen prüfen ihre eigene Kopie der Firmendaten
    for (const m of companySnapshotMissing(draft.companySnapshot as CompanySnapshot)) err("COMPANY", `Rechnungsstellerdaten unvollständig: ${m}.`);
    if (invoice.exportedAt || mode?.exported) err("EXPORTED", "Diese Rechnung wurde bereits buchhalterisch exportiert. Eine Änderung unter derselben Rechnungsnummer ist nicht mehr möglich.");
    if (mode && mode.counterFinalized > 0) err("COUNTER_DOCUMENT", "Zu dieser Rechnung gibt es bereits eine Gutschrift oder einen Stornobeleg. Sie wird nicht mehr berichtigt; weitere Änderungen nur über einen weiteren Gegenbeleg.");
    if (mode?.delivered && !(draft.reason && draft.reason.trim().length >= 3)) err("REASON", "Der Kunde hat bereits eine frühere Fassung dieser Rechnung erhalten. Bitte den Grund der Berichtigung angeben.");
  }
  // Phase F: Unfallersatz – Fall offen, Abrechnungskette, Restforderung, Miettage (alle Fassungen)
  if (invoice.kind === "ACCIDENT_REPLACEMENT") await accidentIssues(tx, tenantId, invoice, draft, booking, err, warn);
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
  if (invoice.kind === "CANCELLATION_FEE") {
    // Befehl 28: Stornogebühr – Behandlung je Storno bewusst gewählt; nicht steuerbar heißt: kein Steuersatz
    if (!draft.taxTreatment || !(draft.taxTreatment in CANCELLATION_FEE_TAX_TREATMENTS)) err("TAX_TREATMENT", "Die steuerliche Behandlung der Stornogebühr ist nicht festgelegt.");
    else if (draft.taxTreatment === "NON_TAXABLE_FEE" && draft.items.some((it) => toBasisPoints(it.taxRate) !== 0)) err("TAX_TREATMENT_ITEMS", "Eine nicht steuerbare Stornogebühr trägt keinen Steuersatz.");
  }
  if (draft.taxTreatment !== "NON_TAXABLE_DAMAGE_COMPENSATION" && draft.items.some((it) => toBasisPoints(it.taxRate) === 0) && !draft.taxNote?.trim()) err("TAX_NOTE", "Es gibt Positionen mit 0 % Steuer. Bitte den Steuerhinweis für die Rechnung angeben.");
  if (totals.total.gross === 0) warn("ZERO", "Der Rechnungsbetrag ist 0,00 €.");
  if (invoice.kind === "GENERAL" && totals.total.gross <= 0 && draft.items.length > 0) err("AMOUNT", "Der Rechnungsbetrag einer freien Rechnung muss größer als 0,00 € sein.");
  if (mode && mode.completedRefundCents > 0 && mode.completedRefundCents > Math.max(0, mode.paidCents - totals.total.gross)) err("REFUNDED", `Zu dieser Rechnung wurden bereits ${fmtCents(mode.completedRefundCents)} an den Kunden erstattet. Der neue Rechnungsbetrag würde dieses Guthaben unterschreiten. Bitte zuerst die Auszahlung stornieren.`);
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
function sealedContent(invoice: { number: string | null; bookingId: string | null; contractId: string | null; returnHandoverId: string | null }, v: VersionWithItems) {
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
function legacySealedContent(invoice: { number: string | null; bookingId: string | null; contractId: string | null; returnHandoverId: string | null }, v: VersionWithItems) {
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
  push("customer.role", "Empfängerrolle", INVOICE_RECIPIENT_ROLES[recipientRoleOf(pc)], INVOICE_RECIPIENT_ROLES[recipientRoleOf(nc)]);
  push("customer.claimNumber", "Schadennummer", pc.claimNumber ?? null, nc.claimNumber ?? null);
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
  return withNumberRetry(() => db.$transaction(async (tx) => { await assertAccidentInvoiceCaseOpen(tx, tenantId, invoiceId); return finalizeInvoiceIn(tx, tenantId, invoiceId, actor, opts); }, TX)).catch(finalizeErrorOf);
}

/** Eindeutigkeitsverletzungen des Abschlusses als Fachmeldung. */
export function finalizeErrorOf(e: unknown): never {
  if (isUniqueViolation(e, "damageCaseId")) throw new DomainError("Zu dieser Schadenakte gibt es bereits eine Schadenabrechnung.");
  if (isUniqueViolation(e, "authorityCaseId") || isUniqueViolation(e, "one_per_authority_case")) throw new DomainError("Zu diesem Behördenvorgang gibt es bereits ein Bearbeitungsentgelt.");
  if (isUniqueViolation(e, "bookingId")) throw new DomainError("Zu dieser Buchung gibt es bereits eine abgeschlossene Mietrechnung.");
  throw e;
}

/**
 * Kern des Abschlusses in einer laufenden Transaktion (Befehl 21: auch gemeinsam mit einer bewusst bestätigten
 * Kautionsverrechnung – lib/invoice-settlement.ts). Inhaltlich unverändert.
 */
export async function finalizeInvoiceIn(tx: Tx, tenantId: string, invoiceId: string, actor: Actor, opts: FinalizeOptions = {}): Promise<VersionWithItems> {
  const { invoice: lockedInv, draft: draft0 } = await lockDraft(tx, tenantId, invoiceId);
  if (lockedInv.documentType !== "INVOICE") throw new DomainError("Gutschriften und Stornobelege werden über ihren eigenen Abschluss finalisiert.");
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
  // Erste Fassung der Mietrechnung: vorab an der Buchung erfasste Mietzahlungen werden ihr zugeordnet (Buchung gesperrt)
  // Befehl 28: ebenso die Stornogebühr-Rechnung einer stornierten Buchung (Rest der Vorauszahlung = Kundenguthaben der Rechnung)
  const linksRentalPayments = draft.versionNo === 1 && (invoice.kind === "RENTAL" || invoice.kind === "CANCELLATION_FEE");
  const prepaidCents = linksRentalPayments ? await lockUnlinkedRentalPayments(tx, tenantId, invoice.bookingId!) : 0;
  if (prepaidCents > newGross && !opts.confirmOverpayment) {
    throw new DomainError(`Zu dieser Buchung wurden bereits ${fmtCents(prepaidCents)} Mietzahlungen dokumentiert. Der Rechnungsbetrag beträgt ${fmtCents(newGross)}. Dadurch entsteht eine Überzahlung von ${fmtCents(prepaidCents - newGross)}. Rent-Base führt keine automatische Erstattung durch. Bitte die Überzahlung ausdrücklich bestätigen.`);
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
    if (linksRentalPayments) await linkRentalPaymentsToInvoice(tx, tenantId, actor, { id: invoice.id, bookingId: invoice.bookingId!, number });
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
}

/** Prüfsumme einer Fassung nachrechnen. Fassung 1 aus der Zeit vor den Fassungen wird mit dem damaligen Inhalt geprüft. */
export async function verifyVersion(tenantId: string, versionId: string) {
  const v = await db.invoiceVersion.findFirst({ where: { id: versionId, tenantId }, include: withItems });
  if (!v) throw new DomainError("Rechnungsfassung nicht gefunden.");
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: v.invoiceId } });
  if (invoice.documentType !== "INVOICE") {
    const { sealedCounterContent } = await import("@/lib/counter-documents");
    const own = contentHash(sealedCounterContent(invoice, v));
    return { finalized: v.status === "FINALIZED", storedHash: v.contentHash, currentHash: own, intact: v.status === "FINALIZED" && v.contentHash === own, legacyHash: own };
  }
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
    await assertAccidentInvoiceCaseOpen(tx, tenantId, invoiceId);
    const { draft } = await lockDraft(tx, tenantId, invoiceId);
    await tx.invoiceVersionItem.deleteMany({ where: { tenantId, versionId: draft.id } });
    await tx.invoiceVersion.delete({ where: { id: draft.id } });
    if (draft.versionNo === 1) {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      await tx.invoiceItem.deleteMany({ where: { tenantId, invoiceId } });
      await tx.invoice.delete({ where: { id: invoiceId } });
      if (inv.kind === "DAMAGE" && inv.damageCaseId && inv.documentType === "INVOICE") {
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
