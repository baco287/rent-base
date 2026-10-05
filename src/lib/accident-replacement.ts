// Befehl 29: Unfallersatz. Eine Unfallersatzmiete ist eine normale Buchung (rentalType ACCIDENT_REPLACEMENT) mit Mietvertrag,
// Übergabe, Rückgabe, Rechnungen und Zahlungen – plus genau einer Fallakte (AccidentReplacementCase). Hier liegt nur, was
// das Kernsystem nicht hat: Anlage von Buchung + Fallakte in einer Transaktion, das disponierte Mietende (offen oder geplant),
// Schadenfall-, Versicherungs-, Werkstatt- und Anwaltsdaten, Tarifpositionen, Wiedervorlagen, Dokumente, Abschluss.
// Harte Regeln: Kein Zustand wird doppelt gespeichert – Miet-, Rechnungs- und Zahlungsstand werden aus Buchung, Rechnungen
// und Zahlungen abgeleitet. Rent-Base berechnet und dokumentiert; es entscheidet weder Haftung noch Erstattungsfähigkeit.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { ACCIDENT_CASE_CLOSED_MESSAGE, accidentCaseEvent } from "@/lib/accident-replacement-events";
import { agreedEndOf, assertVehicleBookable, findConflicts, nextBookingNumber, occupiedUntil, pricingEnd, vehicleStatusProblem } from "@/lib/bookings";
import { learnPartner } from "@/lib/business-partners";
import {
  ACCIDENT_CASE_DOCUMENT_TYPES, ACCIDENT_DAMAGE_KINDS, ACCIDENT_LIABILITY_STATUS, ACCIDENT_TARIFF_KINDS, BOOKING_STATUS,
  type AccidentLiabilityStatus, type AccidentTariffKind, type BookingStatus,
} from "@/lib/constants";
import { ensureContractDraft, refreshContractDraft } from "@/lib/contracts";
import { financialsFor, type InvoiceFinancials } from "@/lib/counter-documents";
import { customerToData, type CustomerInput } from "@/lib/customer-schema";
import { customerName, fmtDateTime } from "@/lib/format";
import { DomainError } from "@/lib/integrity";
import { reductionsFor } from "@/lib/invoice-adjustments";
import { isValidEmail } from "@/lib/mail";
import { centsToDecimalString, fmtCents, toCents, type Cents } from "@/lib/money";
import { assertFeature } from "@/lib/features";
import { isUniqueViolation, nextAccidentCaseNumber, nextCustomerNumber } from "@/lib/numbering";
import { calculateRentalPrice, rentalDays } from "@/lib/pricing";
import { accidentBillingOf, type AccidentBillingType } from "@/lib/constants";
import { MAX_DOCUMENT_BYTES, assertKeyBelongsToTenant } from "@/lib/storage";
import { rentValue } from "@/lib/accident-pricing";
import { toDateInputValue } from "@/lib/time";
import { securityDepositFinancials, type DepositFinancials } from "@/lib/deposits";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;
const TX = { timeout: 25_000, maxWait: 10_000 };
export type CaseRow = Prisma.AccidentReplacementCaseGetPayload<object>;
export type TariffRow = Prisma.AccidentReplacementTariffItemGetPayload<object>;
export type FollowUpRow = Prisma.CaseFollowUpGetPayload<object>;
export type CaseDocumentRow = Prisma.AccidentReplacementCaseDocumentGetPayload<object>;

function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_(?:DOMAIN|IMMUTABLE|TENANT): ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}

const clean = (v: string | null | undefined, max = 200) => (v?.replace(/\s+/g, " ").trim().slice(0, max) || null);
const cleanMulti = (v: string | null | undefined, max = 2000) => (v?.replace(/\r\n/g, "\n").trim().slice(0, max) || null);
const validDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
const checkEmail = (v: string | null | undefined, label: string) => {
  const e = clean(v);
  if (e && !isValidEmail(e)) throw new DomainError(`${label}: Die E-Mail-Adresse ist ungültig.`);
  return e;
};

/** Fallakte unter Zeilensperre laden (parallele Änderungen laufen nacheinander). */
async function lockCase(tx: Tx, tenantId: string, caseId: string): Promise<CaseRow> {
  // FOR NO KEY UPDATE: serialisiert Änderungen an der Akte, blockiert aber nicht die Fremdschlüsselprüfung beim Anfügen von Verlaufseinträgen (kein Deadlock mit Übergabe/Rechnung)
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AccidentReplacementCase" WHERE "id" = ${caseId} AND "tenantId" = ${tenantId} FOR NO KEY UPDATE`;
  if (locked.length === 0) throw new DomainError("Unfallersatzfall nicht gefunden.");
  return tx.accidentReplacementCase.findUniqueOrThrow({ where: { id: caseId } });
}
// Phase E: dieselbe Meldung wie die Sperre in Vertrag, Übergabe, Rückgabe, Storno und Nachtrag (accident-replacement-events)
const assertOpen = (c: CaseRow) => { if (c.status === "CLOSED") throw new DomainError(ACCIDENT_CASE_CLOSED_MESSAGE); };
const auditBase = (c: CaseRow) => ({ bookingId: c.bookingId, details: { caseNumber: c.caseNumber } });
/** Stimmen alle Felder der Änderung mit der Akte überein? (Datumswerte nach Zeitpunkt) – dann entsteht kein Verlaufseintrag. */
function sameAsCase(c: CaseRow, data: Record<string, unknown>): boolean {
  const row = c as unknown as Record<string, unknown>;
  return Object.entries(data).every(([k, v]) => {
    const cur = row[k];
    if (cur instanceof Date || v instanceof Date) return (cur instanceof Date ? cur.getTime() : cur ?? null) === (v instanceof Date ? v.getTime() : v ?? null);
    return (cur ?? null) === (v ?? null);
  });
}

// ---------------------------------------------------------------------------
// Eingaben
// ---------------------------------------------------------------------------

export type DamagedVehicleInput = { plate: string; make: string; model: string; drivable: boolean; firstRegistration?: Date | null; vehicleClass?: string | null; location?: string | null; damageKind: string };
export type AccidentInput = { accidentAt?: Date | null; place?: string | null; opponentPlate?: string | null; opponentName?: string | null; policeFileNumber?: string | null; note?: string | null };
export type InsurerInput = { name: string; claimNumber?: string | null; contactName?: string | null; phone?: string | null; email?: string | null; street?: string | null; zip?: string | null; city?: string | null };
export type LiabilityInput = { status: string; quotaPercent?: number | null; note?: string | null };
export type WorkshopInput = { name: string; contactName?: string | null; phone?: string | null; email?: string | null; repairStartAt?: Date | null; repairEndAt?: Date | null };
export type LawyerInput = { firm: string; contactName?: string | null; phone?: string | null; email?: string | null };
export type TariffItemInput = { kind: string; label?: string | null; perDay: boolean; unitPriceCents: Cents; quantityHundredths?: number | null };

export type CreateAccidentCaseInput = {
  /** einmaliger Formularschlüssel (Doppelklick, zwei Tabs) */
  nonce: string;
  /** bestehender Kunde oder neuer Kunde über die bestehende Kundenlogik (customerSchema) */
  customerId?: string | null;
  newCustomer?: CustomerInput | null;
  /** Ersatzfahrzeug aus der Flotte und disponierter Zeitraum; plannedEndAt null = Mietende offen */
  vehicleId: string;
  startAt: Date;
  plannedEndAt: Date | null;
  /** Geld immer in ganzen Cent (keine Gleitkommarechnung) */
  dailyRateCents: Cents;
  depositCents?: Cents | null;
  kmIncludedPerDay?: number | null;
  extraKmRateCents?: Cents | null;
  /** Befehl 29 Phase C: im Wizard gewählter Adressbucheintrag (nur zur Vorbelegung; der Fall speichert die Kopie). Muss zum Mandanten gehören. */
  insurerPartnerId?: string | null;
  workshopPartnerId?: string | null;
  lawyerPartnerId?: string | null;
  damaged: DamagedVehicleInput;
  accident?: AccidentInput | null;
  insurer?: InsurerInput | null;
  liability?: LiabilityInput | null;
  workshop?: WorkshopInput | null;
  lawyer?: LawyerInput | null;
  tariff?: TariffItemInput[] | null;
  internalNote?: string | null;
};

function damagedData(d: DamagedVehicleInput) {
  const plate = clean(d.plate, 20);
  if (!plate) throw new DomainError("Bitte das Kennzeichen des beschädigten Fahrzeugs angeben.");
  const make = clean(d.make, 80), model = clean(d.model, 80);
  if (!make || !model) throw new DomainError("Bitte Hersteller und Modell des beschädigten Fahrzeugs angeben.");
  if (!(d.damageKind in ACCIDENT_DAMAGE_KINDS)) throw new DomainError("Bitte die Schadenart wählen.");
  if (d.firstRegistration != null && !validDate(d.firstRegistration)) throw new DomainError("Die Erstzulassung ist kein gültiges Datum.");
  return { damagedPlate: plate.toUpperCase(), damagedMake: make, damagedModel: model, damagedDrivable: !!d.drivable, damagedFirstRegistration: d.firstRegistration ?? null, damagedVehicleClass: clean(d.vehicleClass, 60), damagedLocation: clean(d.location), damageKind: d.damageKind };
}
function accidentData(a: AccidentInput | null | undefined) {
  if (a?.accidentAt != null && !validDate(a.accidentAt)) throw new DomainError("Das Unfalldatum ist kein gültiges Datum.");
  if (a?.accidentAt && a.accidentAt.getTime() > Date.now() + 86_400_000) throw new DomainError("Das Unfalldatum darf nicht in der Zukunft liegen.");
  return { accidentAt: a?.accidentAt ?? null, accidentPlace: clean(a?.place), opponentPlate: clean(a?.opponentPlate, 20)?.toUpperCase() ?? null, opponentName: clean(a?.opponentName), policeFileNumber: clean(a?.policeFileNumber, 80), accidentNote: cleanMulti(a?.note) };
}
function insurerData(i: InsurerInput | null | undefined) {
  if (!i || !clean(i.name)) return { insurerName: null, insurerClaimNumber: null, insurerContactName: null, insurerPhone: null, insurerEmail: null, insurerStreet: null, insurerZip: null, insurerCity: null };
  return { insurerName: clean(i.name), insurerClaimNumber: clean(i.claimNumber, 80), insurerContactName: clean(i.contactName), insurerPhone: clean(i.phone, 60), insurerEmail: checkEmail(i.email, "Versicherung"), insurerStreet: clean(i.street), insurerZip: clean(i.zip, 20), insurerCity: clean(i.city) };
}
function liabilityData(l: LiabilityInput | null | undefined) {
  const status = l?.status ?? "UNKNOWN";
  if (!(status in ACCIDENT_LIABILITY_STATUS)) throw new DomainError("Unbekannter Haftungsstatus.");
  let quota: number | null = null;
  if (status === "QUOTA") {
    if (l?.quotaPercent == null || !Number.isInteger(l.quotaPercent) || l.quotaPercent < 0 || l.quotaPercent > 100) throw new DomainError("Bitte die Haftungsquote des Gegners als ganze Zahl von 0 bis 100 angeben.");
    quota = l.quotaPercent;
  } else if (l?.quotaPercent != null) throw new DomainError("Eine Haftungsquote gibt es nur beim Status „Haftungsquote“.");
  return { liabilityStatus: status, liabilityQuotaPercent: quota, liabilityNote: cleanMulti(l?.note, 1000) };
}
function workshopData(w: WorkshopInput | null | undefined) {
  if (!w || !clean(w.name)) return { workshopName: null, workshopContactName: null, workshopPhone: null, workshopEmail: null, repairStartAt: null, repairEndAt: null };
  if (w.repairStartAt != null && !validDate(w.repairStartAt)) throw new DomainError("Der Reparaturbeginn ist kein gültiges Datum.");
  if (w.repairEndAt != null && !validDate(w.repairEndAt)) throw new DomainError("Das Reparaturende ist kein gültiges Datum.");
  if (w.repairStartAt && w.repairEndAt && w.repairEndAt < w.repairStartAt) throw new DomainError("Das voraussichtliche Reparaturende liegt vor dem Reparaturbeginn.");
  return { workshopName: clean(w.name), workshopContactName: clean(w.contactName), workshopPhone: clean(w.phone, 60), workshopEmail: checkEmail(w.email, "Werkstatt"), repairStartAt: w.repairStartAt ?? null, repairEndAt: w.repairEndAt ?? null };
}
function lawyerData(l: LawyerInput | null | undefined) {
  if (!l || !clean(l.firm)) return { lawyerFirm: null, lawyerContactName: null, lawyerPhone: null, lawyerEmail: null };
  return { lawyerFirm: clean(l.firm), lawyerContactName: clean(l.contactName), lawyerPhone: clean(l.phone, 60), lawyerEmail: checkEmail(l.email, "Rechtsanwalt") };
}
function tariffData(items: TariffItemInput[] | null | undefined) {
  const out = (items ?? []).map((t, i) => {
    if (!(t.kind in ACCIDENT_TARIFF_KINDS)) throw new DomainError(`Tarifposition ${i + 1}: unbekannte Art.`);
    if (!Number.isInteger(t.unitPriceCents) || t.unitPriceCents < 0) throw new DomainError(`Tarifposition ${i + 1}: Bitte einen Betrag ab 0,00 € angeben.`);
    const quantityHundredths = t.perDay ? 100 : t.quantityHundredths ?? 100;
    if (!Number.isInteger(quantityHundredths) || quantityHundredths <= 0) throw new DomainError(`Tarifposition ${i + 1}: Die Menge muss größer als 0 sein.`);
    const label = clean(t.label, 200) ?? ACCIDENT_TARIFF_KINDS[t.kind as AccidentTariffKind];
    return { sortOrder: i, kind: t.kind, label, perDay: !!t.perDay, unitPriceCents: t.unitPriceCents, quantityHundredths };
  });
  if (out.length > 30) throw new DomainError("Höchstens 30 Tarifpositionen.");
  return out;
}
type PartnerKindName = "INSURER" | "WORKSHOP" | "LAWYER";
async function learnPartners(tx: Tx, tenantId: string, kinds: readonly PartnerKindName[], c: Pick<CaseRow, "insurerName" | "insurerContactName" | "insurerPhone" | "insurerEmail" | "insurerStreet" | "insurerZip" | "insurerCity" | "workshopName" | "workshopContactName" | "workshopPhone" | "workshopEmail" | "lawyerFirm" | "lawyerContactName" | "lawyerPhone" | "lawyerEmail">) {
  if (kinds.includes("INSURER") && c.insurerName) await learnPartner(tx, tenantId, "INSURER", { name: c.insurerName, contactName: c.insurerContactName, phone: c.insurerPhone, email: c.insurerEmail, street: c.insurerStreet, zip: c.insurerZip, city: c.insurerCity });
  if (kinds.includes("WORKSHOP") && c.workshopName) await learnPartner(tx, tenantId, "WORKSHOP", { name: c.workshopName, contactName: c.workshopContactName, phone: c.workshopPhone, email: c.workshopEmail });
  if (kinds.includes("LAWYER") && c.lawyerFirm) await learnPartner(tx, tenantId, "LAWYER", { name: c.lawyerFirm, contactName: c.lawyerContactName, phone: c.lawyerPhone, email: c.lawyerEmail });
}

/**
 * Adressbuch-Bezug aus dem Wizard: der Eintrag muss zum Mandanten und zur Art gehören (sonst „nicht gefunden“). Der Wizard
 * übernimmt die Angaben des Eintrags beim Auswählen ins Formular; gespeichert wird genau das Abgeschickte als Kopie im Fall.
 * Was der Benutzer danach geleert oder geändert hat, wird hier nicht aus dem Adressbuch wieder aufgefüllt.
 */
async function withPartner<T>(tx: Tx, tenantId: string, kind: "INSURER" | "WORKSHOP" | "LAWYER", partnerId: string | null | undefined, input: T | null | undefined): Promise<T | null> {
  if (!partnerId) return input ?? null;
  const p = await tx.businessPartner.findFirst({ where: { id: partnerId, tenantId, kind }, select: { id: true } });
  if (!p) throw new DomainError(kind === "INSURER" ? "Die gewählte Versicherung wurde im Adressbuch nicht gefunden." : kind === "WORKSHOP" ? "Die gewählte Werkstatt wurde im Adressbuch nicht gefunden." : "Die gewählte Kanzlei wurde im Adressbuch nicht gefunden.");
  return input ?? null;
}

// ---------------------------------------------------------------------------
// Anlage: Kunde (bestehend oder neu), Buchung mit Mietart Unfallersatz, Fallakte, Tarif – eine Transaktion
// ---------------------------------------------------------------------------

export type CreateAccidentCaseResult = { case: CaseRow; bookingId: string; created: boolean; /** Vertragsentwurf konnte nicht angelegt werden (Fall besteht trotzdem) */ contractError: string | null };

/**
 * Legt Buchung und Fallakte an. Verfügbarkeit unter Fahrzeugsperre (assertVehicleBookable) – mit offenem Ende belegt die
 * Buchung das Fahrzeug ab Mietbeginn unbegrenzt. Der Kunde entsteht erst nach bestandener Konfliktprüfung. Nummern:
 * Buchung JJJJ-NNNN, Fall UE-JJJJ-NNNNNN; Kollisionen werden erneut gezogen. Danach wird der Vertragsentwurf angelegt
 * (offenes Vertragsende) – scheitert das, bleibt der Fall bestehen und die Fallakte zeigt den nächsten Schritt.
 */
export async function createAccidentCase(tenantId: string, actor: Actor, input: CreateAccidentCaseInput): Promise<CreateAccidentCaseResult> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  if (!validDate(input.startAt)) throw new DomainError("Bitte den Mietbeginn mit Datum und Uhrzeit angeben.");
  if (input.plannedEndAt !== null && !validDate(input.plannedEndAt)) throw new DomainError("Bitte das geplante Mietende angeben oder „Mietende offen“ wählen.");
  if (input.plannedEndAt && !(input.plannedEndAt > input.startAt)) throw new DomainError("Das geplante Mietende muss nach dem Mietbeginn liegen.");
  if (!(Number.isInteger(input.dailyRateCents) && input.dailyRateCents > 0)) throw new DomainError("Bitte den Tagessatz (größer 0 €) angeben.");
  if (input.depositCents != null && !(Number.isInteger(input.depositCents) && input.depositCents >= 0)) throw new DomainError("Kaution: bitte einen Wert ab 0 eingeben.");
  if (input.kmIncludedPerDay != null && !(Number.isInteger(input.kmIncludedPerDay) && input.kmIncludedPerDay >= 0)) throw new DomainError("Freikilometer: bitte eine ganze Zahl ab 0 eingeben.");
  if (input.extraKmRateCents != null && !(Number.isInteger(input.extraKmRateCents) && input.extraKmRateCents >= 0)) throw new DomainError("Mehrkilometerpreis: bitte einen Wert ab 0 eingeben.");
  if (!input.customerId && !input.newCustomer) throw new DomainError("Bitte einen Kunden wählen oder neu anlegen.");
  const damaged = damagedData(input.damaged);
  const accident = accidentData(input.accident);
  const liability = liabilityData(input.liability);
  const tariff = tariffData(input.tariff);
  const newCustomer = input.newCustomer ? customerToData(input.newCustomer) : null;
  const idempotencyKey = input.nonce;

  const existing = await db.accidentReplacementCase.findFirst({ where: { tenantId, idempotencyKey } });
  if (existing) return { case: existing, bookingId: existing.bookingId, created: false, contractError: null };

  let result: { case: CaseRow; bookingId: string; created: boolean } | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 6 && !result; attempt++) {
    try {
      result = await db.$transaction(async (tx) => {
        // Freischaltung serverseitig (zusätzlich zu requireFeature in Seite und Server Action)
        await assertFeature(tenantId, "ACCIDENT_REPLACEMENT", tx);
        const again = await tx.accidentReplacementCase.findFirst({ where: { tenantId, idempotencyKey } });
        if (again) return { case: again, bookingId: again.bookingId, created: false };
        // Adressbuch-Bezüge müssen zum Mandanten und zur Art gehören; gespeichert werden die abgeschickten Angaben
        const insurer = insurerData(await withPartner(tx, tenantId, "INSURER", input.insurerPartnerId, input.insurer));
        const workshop = workshopData(await withPartner(tx, tenantId, "WORKSHOP", input.workshopPartnerId, input.workshop));
        const lawyer = lawyerData(await withPartner(tx, tenantId, "LAWYER", input.lawyerPartnerId, input.lawyer));
        const vehicle = await tx.vehicle.findFirst({ where: { id: input.vehicleId, tenantId } });
        if (!vehicle) throw new DomainError("Ersatzfahrzeug nicht gefunden.");
        const statusProblem = vehicleStatusProblem(vehicle.status);
        if (statusProblem) throw new DomainError(statusProblem);
        let customer = input.customerId ? await tx.customer.findFirst({ where: { id: input.customerId, tenantId } }) : null;
        if (input.customerId && !customer) throw new DomainError("Kunde nicht gefunden.");
        if (customer?.blocked) throw new DomainError(`${customerName(customer)} ist gesperrt${customer.blockReason ? `: ${customer.blockReason}` : "."}`);
        // Verfügbarkeit unter Fahrzeugsperre – offenes Ende (null) zählt als unbegrenzt
        const { conflicts } = await assertVehicleBookable(tx, tenantId, vehicle.id, input.startAt, input.plannedEndAt);
        // gleicher Formularschlüssel parallel: nach der Fahrzeugsperre ist die erste Anlage sichtbar → denselben Fall liefern statt „Doppelbelegung“
        const afterLock = await tx.accidentReplacementCase.findFirst({ where: { tenantId, idempotencyKey } });
        if (afterLock) return { case: afterLock, bookingId: afterLock.bookingId, created: false };
        if (conflicts.length > 0) {
          const c = conflicts[0];
          const until = occupiedUntil({ ...c, agreedEndAt: agreedEndOf(c) });
          // offenes Mietende scheitert an einer späteren Buchung: Grund und Ausweg nennen
          if (input.plannedEndAt === null && c.startAt > input.startAt) throw new DomainError(`Mietende offen ist mit ${vehicle.plate} nicht möglich: Das Fahrzeug ist ab ${fmtDateTime(c.startAt)} für Buchung ${c.number} vorgesehen. Bitte ein geplantes Mietende vor diesem Zeitpunkt wählen oder ein anderes Fahrzeug.`);
          throw new DomainError(`Doppelbelegung: ${vehicle.plate} ist von ${fmtDateTime(c.startAt)} bis ${until ? fmtDateTime(until) : "zur Rückgabe (offenes Mietende)"} an ${customerName(c.customer)} vergeben (Nr. ${c.number}).`);
        }
        if (!customer) customer = await tx.customer.create({ data: { tenantId, number: await nextCustomerNumber(tx, tenantId), ...newCustomer! } });
        const number = await nextBookingNumber(tx, tenantId, input.startAt);
        // Preis-Snapshot: nur der Tagessatz (Unfallersatz rechnet je Tag ab); Wochen-/Monatsstufen bewusst leer
        const booking = await tx.booking.create({
          data: {
            tenantId, number, rentalType: "ACCIDENT_REPLACEMENT", vehicleId: vehicle.id, customerId: customer.id,
            startAt: input.startAt, endAt: input.plannedEndAt, dailyRate: centsToDecimalString(input.dailyRateCents), deposit: centsToDecimalString(input.depositCents ?? 0),
            kmIncludedPerDay: input.kmIncludedPerDay ?? null, extraKmRate: input.extraKmRateCents != null ? centsToDecimalString(input.extraKmRateCents) : null,
          },
        });
        const caseNumber = await nextAccidentCaseNumber(tx, tenantId);
        const created = await tx.accidentReplacementCase.create({
          data: { tenantId, bookingId: booking.id, caseNumber, idempotencyKey, ...damaged, ...accident, ...insurer, ...liability, ...workshop, ...lawyer, internalNote: cleanMulti(input.internalNote), createdById: actor.id, createdByName: actor.name },
        });
        if (tariff.length > 0) await tx.accidentReplacementTariffItem.createMany({ data: tariff.map((t) => ({ tenantId, caseId: created.id, ...t })) });
        await learnPartners(tx, tenantId, ["INSURER", "WORKSHOP", "LAWYER"], created);
        await accidentCaseEvent(tx, tenantId, created.id, actor, { type: "CREATED", toValue: "OPEN", note: `Buchung ${number}, ${vehicle.plate}, Mietbeginn ${fmtDateTime(input.startAt)}, Mietende ${input.plannedEndAt ? `geplant ${fmtDateTime(input.plannedEndAt)}` : "offen"}` });
        await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_CREATED", bookingId: booking.id, details: { caseNumber, bookingNumber: number, vehicleId: vehicle.id, openEnd: input.plannedEndAt === null, dailyRateCents: input.dailyRateCents, tariffItems: tariff.length, liabilityStatus: liability.liabilityStatus } });
        return { case: created, bookingId: booking.id, created: true };
      }, TX);
    } catch (e) {
      // Nummernkollision (Buchung oder Fall) bei gleichzeitiger Anlage: erneut ziehen; alles andere ist ein echter Fehler
      if (isUniqueViolation(e, "number") || isUniqueViolation(e, "caseNumber")) { lastError = e; await new Promise((r) => setTimeout(r, 15 * (attempt + 1) + Math.random() * 25)); continue; }
      if (isUniqueViolation(e, "idempotencyKey")) {
        const winner = await db.accidentReplacementCase.findFirst({ where: { tenantId, idempotencyKey } });
        if (winner) return { case: winner, bookingId: winner.bookingId, created: false, contractError: null };
      }
      return domainFromDb(e);
    }
  }
  if (!result) throw lastError ?? new DomainError("Die Nummernvergabe ist mehrfach kollidiert. Bitte erneut versuchen.");
  // gleichzeitig abgeschickt (Doppelklick): die andere Absendung hat angelegt und legt auch den Vertragsentwurf an
  if (!result.created) return { ...result, contractError: null };
  // Vertragsentwurf mit offenem Ende – separat, damit der Fall auch bei einem Fehler hier besteht
  let contractError: string | null = null;
  try {
    await ensureContractDraft(tenantId, result.bookingId, actor);
  } catch (e) {
    contractError = e instanceof DomainError ? e.message : "Der Vertragsentwurf konnte nicht angelegt werden.";
  }
  return { ...result, contractError };
}

// ---------------------------------------------------------------------------
// Fallakte pflegen
// ---------------------------------------------------------------------------

export async function updateDamagedVehicle(tenantId: string, caseId: string, actor: Actor, input: DamagedVehicleInput): Promise<CaseRow> {
  const data = damagedData(input);
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    if (sameAsCase(c, data)) return c;
    const row = await tx.accidentReplacementCase.update({ where: { id: c.id }, data });
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "DAMAGED_VEHICLE_CHANGED", fromValue: `${c.damagedPlate} · ${ACCIDENT_DAMAGE_KINDS[c.damageKind as keyof typeof ACCIDENT_DAMAGE_KINDS]}`, toValue: `${data.damagedPlate} · ${ACCIDENT_DAMAGE_KINDS[data.damageKind as keyof typeof ACCIDENT_DAMAGE_KINDS]}` });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_UPDATED", ...auditBase(c), details: { ...auditBase(c).details, section: "DAMAGED_VEHICLE" } });
    return row;
  }, TX).catch(domainFromDb);
}

export async function updateAccident(tenantId: string, caseId: string, actor: Actor, input: AccidentInput): Promise<CaseRow> {
  const data = accidentData(input);
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    if (sameAsCase(c, data)) return c;
    const row = await tx.accidentReplacementCase.update({ where: { id: c.id }, data });
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "ACCIDENT_CHANGED", note: [data.accidentAt ? `Unfall ${fmtDateTime(data.accidentAt)}` : null, data.policeFileNumber ? `Az. ${data.policeFileNumber}` : null].filter(Boolean).join(" · ") || null });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_UPDATED", ...auditBase(c), details: { ...auditBase(c).details, section: "ACCIDENT" } });
    return row;
  }, TX).catch(domainFromDb);
}

/**
 * Versicherung (Kopie im Fall) und optional Haftungsstatus. Geändert wird nur die Kopie im Fall; das globale Adressbuch nur,
 * wenn ausdrücklich gewünscht (addressBook) – nie nebenbei. Ohne Änderung entsteht kein Verlaufseintrag.
 */
export async function updateInsurer(tenantId: string, caseId: string, actor: Actor, input: { insurer: InsurerInput | null; liability?: LiabilityInput | null; addressBook?: boolean }): Promise<CaseRow> {
  const ins = insurerData(input.insurer);
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    const liab = input.liability ? liabilityData(input.liability) : {};
    if (sameAsCase(c, { ...ins, ...liab })) {
      // nichts am Fall geändert – auf Wunsch nur ins Adressbuch übernehmen (Audit), kein Verlaufseintrag „geändert“
      if (input.addressBook) { await learnPartners(tx, tenantId, ["INSURER"], c); await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_UPDATED", ...auditBase(c), details: { ...auditBase(c).details, section: "INSURER", addressBook: true, caseUnchanged: true } }); }
      return c;
    }
    const row = await tx.accidentReplacementCase.update({ where: { id: c.id }, data: { ...ins, ...liab } });
    if (input.addressBook) await learnPartners(tx, tenantId, ["INSURER"], row);
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "INSURER_CHANGED", fromValue: c.insurerName, toValue: row.insurerName, note: row.insurerClaimNumber ? `Schadennummer ${row.insurerClaimNumber}` : "ohne Schadennummer" });
    if (input.liability && (row.liabilityStatus !== c.liabilityStatus || row.liabilityQuotaPercent !== c.liabilityQuotaPercent)) await liabilityChanged(tx, tenantId, c, row, actor);
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_UPDATED", ...auditBase(c), details: { ...auditBase(c).details, section: "INSURER", claimNumberPresent: !!row.insurerClaimNumber, addressBook: !!input.addressBook } });
    return row;
  }, TX).catch(domainFromDb);
}

async function liabilityChanged(tx: Tx, tenantId: string, before: CaseRow, after: CaseRow, actor: Actor) {
  const label = (r: CaseRow) => `${ACCIDENT_LIABILITY_STATUS[r.liabilityStatus as AccidentLiabilityStatus] ?? r.liabilityStatus}${r.liabilityQuotaPercent != null ? ` ${r.liabilityQuotaPercent} %` : ""}`;
  await accidentCaseEvent(tx, tenantId, before.id, actor, { type: "LIABILITY_CHANGED", fromValue: label(before), toValue: label(after), note: after.liabilityNote });
  await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_LIABILITY_CHANGED", ...auditBase(before), details: { ...auditBase(before).details, before: { status: before.liabilityStatus, quota: before.liabilityQuotaPercent }, after: { status: after.liabilityStatus, quota: after.liabilityQuotaPercent } } });
}

/** Haftungsstatus ist eine Information des Versicherers, die der Mitarbeiter einträgt – nie eine Bewertung durch Rent-Base. */
export async function setLiability(tenantId: string, caseId: string, actor: Actor, input: LiabilityInput): Promise<CaseRow> {
  const data = liabilityData(input);
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    const row = await tx.accidentReplacementCase.update({ where: { id: c.id }, data });
    if (row.liabilityStatus !== c.liabilityStatus || row.liabilityQuotaPercent !== c.liabilityQuotaPercent || row.liabilityNote !== c.liabilityNote) await liabilityChanged(tx, tenantId, c, row, actor);
    return row;
  }, TX).catch(domainFromDb);
}

/** Werkstatt (Kopie im Fall); null entfernt die Angaben. Adressbuch nur auf ausdrücklichen Wunsch. */
export async function updateWorkshop(tenantId: string, caseId: string, actor: Actor, input: WorkshopInput | null, opts: { addressBook?: boolean } = {}): Promise<CaseRow> {
  const data = workshopData(input);
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    if (sameAsCase(c, data)) {
      if (opts.addressBook) { await learnPartners(tx, tenantId, ["WORKSHOP"], c); await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_UPDATED", ...auditBase(c), details: { ...auditBase(c).details, section: "WORKSHOP", addressBook: true, caseUnchanged: true } }); }
      return c;
    }
    const row = await tx.accidentReplacementCase.update({ where: { id: c.id }, data });
    if (opts.addressBook) await learnPartners(tx, tenantId, ["WORKSHOP"], row);
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "WORKSHOP_CHANGED", fromValue: c.workshopName, toValue: row.workshopName, note: row.repairEndAt ? `Reparaturende voraussichtlich ${fmtDateTime(row.repairEndAt)}` : null });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_UPDATED", ...auditBase(c), details: { ...auditBase(c).details, section: "WORKSHOP", addressBook: !!opts.addressBook } });
    return row;
  }, TX).catch(domainFromDb);
}

/** Rechtsanwalt (Kopie im Fall); null entfernt die Angaben. Adressbuch nur auf ausdrücklichen Wunsch. */
export async function updateLawyer(tenantId: string, caseId: string, actor: Actor, input: LawyerInput | null, opts: { addressBook?: boolean } = {}): Promise<CaseRow> {
  const data = lawyerData(input);
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    if (sameAsCase(c, data)) {
      if (opts.addressBook) { await learnPartners(tx, tenantId, ["LAWYER"], c); await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_UPDATED", ...auditBase(c), details: { ...auditBase(c).details, section: "LAWYER", addressBook: true, caseUnchanged: true } }); }
      return c;
    }
    const row = await tx.accidentReplacementCase.update({ where: { id: c.id }, data });
    if (opts.addressBook) await learnPartners(tx, tenantId, ["LAWYER"], row);
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "LAWYER_CHANGED", fromValue: c.lawyerFirm, toValue: row.lawyerFirm });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_UPDATED", ...auditBase(c), details: { ...auditBase(c).details, section: "LAWYER", addressBook: !!opts.addressBook } });
    return row;
  }, TX).catch(domainFromDb);
}

export async function addCaseNote(tenantId: string, caseId: string, actor: Actor, note: string): Promise<void> {
  const text = cleanMulti(note, 2000);
  if (!text) throw new DomainError("Bitte eine Notiz eingeben.");
  await db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "NOTE_ADDED", note: text });
  }, TX).catch(domainFromDb);
}

export async function setInternalNote(tenantId: string, caseId: string, actor: Actor, note: string | null): Promise<CaseRow> {
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    return tx.accidentReplacementCase.update({ where: { id: c.id }, data: { internalNote: cleanMulti(note, 4000) } });
  }, TX).catch(domainFromDb);
}

/**
 * Tarifpositionen ersetzen (nur offene Akte, Datenbank-Trigger). Bereits erstellte Rechnungen tragen ihre eigenen Positionen
 * und bleiben unverändert; der Verlauf hält alt/neu fest.
 * Phase E: Der Tarif gehört zum Mietvertrag. Im Vertragsentwurf wird er sofort übernommen (vorhandene Unterschriften verfallen,
 * weil sich der Inhalt ändert); nach der Unterschrift ist er eingefroren und hier nicht mehr änderbar.
 */
export async function setTariff(tenantId: string, caseId: string, actor: Actor, items: TariffItemInput[]): Promise<TariffRow[]> {
  const data = tariffData(items);
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    const contract = await tx.rentalContract.findFirst({ where: { tenantId, bookingId: c.bookingId }, select: { id: true, status: true } });
    if (contract && contract.status !== "DRAFT") throw new DomainError("Der Tarif ist im unterschriebenen Mietvertrag festgeschrieben und kann nicht mehr geändert werden.");
    const before = await tx.accidentReplacementTariffItem.findMany({ where: { tenantId, caseId: c.id }, orderBy: { sortOrder: "asc" } });
    await tx.accidentReplacementTariffItem.deleteMany({ where: { tenantId, caseId: c.id } });
    if (data.length > 0) await tx.accidentReplacementTariffItem.createMany({ data: data.map((t) => ({ tenantId, caseId: c.id, ...t })) });
    const describe = (rows: { label: string; perDay: boolean; unitPriceCents: number; quantityHundredths: number }[]) => rows.map((t) => `${t.label} ${fmtCents(t.unitPriceCents)}${t.perDay ? "/Tag" : t.quantityHundredths !== 100 ? ` × ${(t.quantityHundredths / 100).toLocaleString("de-DE")}` : ""}`).join("; ") || "keine";
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "TARIFF_CHANGED", fromValue: describe(before), toValue: describe(data) });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_TARIFF_CHANGED", ...auditBase(c), details: { ...auditBase(c).details, before: { items: before.length, perDayCents: before.filter((t) => t.perDay).reduce((s, t) => s + t.unitPriceCents, 0) }, after: { items: data.length, perDayCents: data.filter((t) => t.perDay).reduce((s, t) => s + t.unitPriceCents, 0) } } });
    if (contract) await refreshContractDraft(tx, tenantId, contract.id);
    return tx.accidentReplacementTariffItem.findMany({ where: { tenantId, caseId: c.id }, orderBy: { sortOrder: "asc" } });
  }, TX).catch(domainFromDb);
}

// ---------------------------------------------------------------------------
// Geplantes Mietende (Dispositionswert der Buchung; der Vertrag läuft „bis zur Rückgabe“)
// ---------------------------------------------------------------------------

export type PlannedEndPreview = { before: Date | null; after: Date | null; conflict: string | null; estimateBeforeCents: Cents; estimateAfterCents: Cents };

/**
 * Geschätzter Mietwert wie in der Unfallersatz-Rechnung: Miettage × (Tagessatz + Tagespositionen) + Einmalpositionen, ab der
 * tatsächlichen Übergabe (sonst geplanter Beginn) bis zum (geplanten) Ende, bei offenem Ende bis jetzt.
 */
function estimateCents(b: { status: string; startAt: Date; endAt: Date | null; actualPickupAt: Date | null; actualReturnAt: Date | null; dailyRate: unknown }, tariff: Pick<TariffRow, "label" | "perDay" | "unitPriceCents" | "quantityHundredths">[], end: Date | null, now: Date): Cents {
  // laufende Miete mit bereits überschrittenem Ende: der Mietwert wächst bis zur Rückgabe – mindestens bis jetzt
  const until = end ? (b.status === "ACTIVE" && !b.actualReturnAt && end < now ? now : end) : pricingEnd({ endAt: null, actualReturnAt: b.actualReturnAt }, now);
  return rentValue({ from: b.actualPickupAt ?? b.startAt, until, dailyRateCents: toCents(Number(b.dailyRate).toFixed(2)), items: tariff })?.cents ?? 0;
}

export async function previewPlannedEnd(tenantId: string, caseId: string, plannedEndAt: Date | null): Promise<PlannedEndPreview> {
  const c = await db.accidentReplacementCase.findFirst({ where: { id: caseId, tenantId }, include: { booking: { include: { vehicle: { select: { status: true } } } }, tariffItems: true } });
  if (!c) throw new DomainError("Unfallersatzfall nicht gefunden.");
  const b = c.booking;
  const now = new Date();
  let conflict: string | null = null;
  if (plannedEndAt !== null && !validDate(plannedEndAt)) conflict = "Bitte ein gültiges Datum angeben oder „Mietende offen“ wählen.";
  else if (plannedEndAt && !(plannedEndAt > b.startAt)) conflict = "Das geplante Mietende muss nach dem Mietbeginn liegen.";
  else if (vehicleStatusProblem(b.vehicle.status)) conflict = vehicleStatusProblem(b.vehicle.status);
  else {
    const conflicts = await findConflicts(db, tenantId, b.vehicleId, b.startAt, plannedEndAt, b.id, now);
    if (conflicts.length > 0) conflict = `Das Fahrzeug ist ab ${fmtDateTime(conflicts[0].startAt)} bereits für Buchung ${conflicts[0].number} vorgesehen.`;
  }
  return { before: b.endAt, after: plannedEndAt, conflict, estimateBeforeCents: estimateCents(b, c.tariffItems, b.endAt, now), estimateAfterCents: estimateCents(b, c.tariffItems, plannedEndAt, now) };
}

/**
 * „Mietdauer aktualisieren“: geplantes Ende setzen, verschieben oder öffnen – ohne neue Buchung und ohne Nachtrag. Unter
 * Sperren (Fall → Buchung → Fahrzeug) mit derselben Konfliktprüfung wie jede Buchung; Zahlungen, Kaution und Vertrag
 * bleiben unberührt. Pflichtgrund, Audit mit alt/neu und Mietwert-Schätzung, Verlaufseintrag.
 */
export async function updatePlannedEnd(tenantId: string, caseId: string, actor: Actor, input: { plannedEndAt: Date | null; reason: string }): Promise<{ before: Date | null; after: Date | null }> {
  const reason = clean(input.reason, 500);
  if (!reason || reason.length < 3) throw new DomainError("Bitte den Grund der Änderung angeben (z. B. Reparaturende laut Werkstatt).");
  if (input.plannedEndAt !== null && !validDate(input.plannedEndAt)) throw new DomainError("Bitte ein gültiges Datum angeben oder „Mietende offen“ wählen.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${c.bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const b = await tx.booking.findUniqueOrThrow({ where: { id: c.bookingId } });
    if (b.status !== "RESERVED" && b.status !== "ACTIVE") throw new DomainError(b.status === "RETURNED" ? "Die Miete ist beendet; das Mietende steht mit der Rückgabe fest." : "Die Buchung ist storniert.");
    if (input.plannedEndAt && !(input.plannedEndAt > b.startAt)) throw new DomainError("Das geplante Mietende muss nach dem Mietbeginn liegen.");
    if ((b.endAt?.getTime() ?? null) === (input.plannedEndAt?.getTime() ?? null)) throw new DomainError("Das geplante Mietende ist unverändert.");
    const { conflicts } = await assertVehicleBookable(tx, tenantId, b.vehicleId, b.startAt, input.plannedEndAt, b.id);
    if (conflicts.length > 0) throw new DomainError(`Das Fahrzeug ist ab ${fmtDateTime(conflicts[0].startAt)} bereits für Buchung ${conflicts[0].number} vorgesehen.`);
    const now = new Date();
    const tariff = await tx.accidentReplacementTariffItem.findMany({ where: { tenantId, caseId: c.id } });
    const estimateBefore = estimateCents(b, tariff, b.endAt, now), estimateAfter = estimateCents(b, tariff, input.plannedEndAt, now);
    await tx.booking.update({ where: { id: b.id }, data: { endAt: input.plannedEndAt } });
    const text = (d: Date | null) => (d ? fmtDateTime(d) : "offen");
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "PLANNED_END_CHANGED", fromValue: text(b.endAt), toValue: text(input.plannedEndAt), reason });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_PLANNED_END_CHANGED", bookingId: b.id, amountCents: estimateAfter, details: { caseNumber: c.caseNumber, bookingNumber: b.number, endBefore: b.endAt?.toISOString() ?? null, endAfter: input.plannedEndAt?.toISOString() ?? null, estimateBeforeCents: estimateBefore, estimateAfterCents: estimateAfter, reason } });
    return { before: b.endAt, after: input.plannedEndAt };
  }, TX).catch(domainFromDb);
}

// ---------------------------------------------------------------------------
// Wiedervorlagen (klein: Titel, Fälligkeit, Status, optional Zuständiger und Notiz)
// ---------------------------------------------------------------------------

export async function createFollowUp(tenantId: string, caseId: string, actor: Actor, input: { title: string; dueAt: Date; assigneeUserId?: string | null; note?: string | null }): Promise<FollowUpRow> {
  const title = clean(input.title, 200);
  if (!title) throw new DomainError("Bitte einen Titel für die Wiedervorlage angeben.");
  if (!validDate(input.dueAt)) throw new DomainError("Bitte das Fälligkeitsdatum angeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    let assignee: { id: string; name: string } | null = null;
    if (input.assigneeUserId) {
      assignee = await tx.user.findFirst({ where: { id: input.assigneeUserId, tenantId, active: true }, select: { id: true, name: true } });
      if (!assignee) throw new DomainError("Der Zuständige wurde nicht gefunden.");
    }
    const row = await tx.caseFollowUp.create({ data: { tenantId, caseId: c.id, title, dueAt: input.dueAt, assigneeUserId: assignee?.id ?? null, assigneeName: assignee?.name ?? null, note: cleanMulti(input.note, 1000), createdById: actor.id, createdByName: actor.name } });
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "FOLLOW_UP_CREATED", toValue: title, note: `fällig ${fmtDateTime(input.dueAt)}${assignee ? ` · ${assignee.name}` : ""}` });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_FOLLOW_UP_CREATED", ...auditBase(c), details: { ...auditBase(c).details, followUpId: row.id, dueAt: input.dueAt.toISOString() } });
    return row;
  }, TX).catch(domainFromDb);
}

export async function completeFollowUp(tenantId: string, followUpId: string, actor: Actor, note?: string | null, opts: { caseId?: string } = {}): Promise<FollowUpRow> {
  return db.$transaction(async (tx) => {
    const f = await tx.caseFollowUp.findFirst({ where: { id: followUpId, tenantId, ...(opts.caseId ? { caseId: opts.caseId } : {}) }, include: { case: true } });
    if (!f) throw new DomainError("Wiedervorlage nicht gefunden.");
    assertOpen(f.case);
    if (f.status !== "OPEN") throw new DomainError("Diese Wiedervorlage ist bereits erledigt oder verworfen.");
    const row = await tx.caseFollowUp.update({ where: { id: f.id }, data: { status: "DONE", doneAt: new Date(), doneById: actor.id, doneByName: actor.name, doneNote: cleanMulti(note, 1000) } });
    await accidentCaseEvent(tx, tenantId, f.caseId, actor, { type: "FOLLOW_UP_DONE", toValue: f.title, note: row.doneNote });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_FOLLOW_UP_DONE", bookingId: f.case.bookingId, details: { caseNumber: f.case.caseNumber, followUpId: f.id } });
    return row;
  }, TX).catch(domainFromDb);
}

export async function cancelFollowUp(tenantId: string, followUpId: string, actor: Actor, reason: string, opts: { caseId?: string } = {}): Promise<FollowUpRow> {
  const why = clean(reason, 500);
  if (!why || why.length < 3) throw new DomainError("Bitte den Grund angeben, warum die Wiedervorlage entfällt.");
  return db.$transaction(async (tx) => {
    const f = await tx.caseFollowUp.findFirst({ where: { id: followUpId, tenantId, ...(opts.caseId ? { caseId: opts.caseId } : {}) }, include: { case: true } });
    if (!f) throw new DomainError("Wiedervorlage nicht gefunden.");
    assertOpen(f.case);
    if (f.status !== "OPEN") throw new DomainError("Diese Wiedervorlage ist bereits erledigt oder verworfen.");
    const row = await tx.caseFollowUp.update({ where: { id: f.id }, data: { status: "CANCELLED", doneAt: new Date(), doneById: actor.id, doneByName: actor.name, doneNote: why } });
    await accidentCaseEvent(tx, tenantId, f.caseId, actor, { type: "FOLLOW_UP_CANCELLED", toValue: f.title, reason: why });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_FOLLOW_UP_CANCELLED", bookingId: f.case.bookingId, details: { caseNumber: f.case.caseNumber, followUpId: f.id, reason: why } });
    return row;
  }, TX).catch(domainFromDb);
}

// ---------------------------------------------------------------------------
// Dokumente (Uploads; die Datei liegt bereits im privaten Speicher)
// ---------------------------------------------------------------------------

/** Erlaubte Dateiarten der Falldokumente – am Dateiinhalt erkannt (storage.sniffDocumentType), nie aus der Browserangabe. */
const ACCIDENT_DOCUMENT_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
/** Dateiname ohne Pfad- und Steuerzeichen (Anzeige und Download). */
export const safeDocumentFileName = (name: string) => (name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 200) || "dokument");

export async function registerAccidentDocument(tenantId: string, caseId: string, actor: Actor, input: { type: string; fileName: string; storageKey: string; contentType: string; sizeBytes: number; checksum: string; note?: string | null }): Promise<CaseDocumentRow> {
  if (!(input.type in ACCIDENT_CASE_DOCUMENT_TYPES)) throw new DomainError("Unbekannter Dokumenttyp.");
  // Phase F: dieselben Regeln wie die Upload-Route – auch für jeden anderen Aufrufer
  if (!ACCIDENT_DOCUMENT_CONTENT_TYPES.has(input.contentType)) throw new DomainError("Bitte ein PDF oder ein Bild (JPEG, PNG, WebP) hochladen.");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_DOCUMENT_BYTES) throw new DomainError("Das Dokument ist leer oder zu groß (maximal 8 MB).");
  if (!/^[0-9a-f]{64}$/.test(input.checksum)) throw new DomainError("Die Prüfsumme des Dokuments fehlt.");
  assertKeyBelongsToTenant(input.storageKey, tenantId);
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId); assertOpen(c);
    const doc = await tx.accidentReplacementCaseDocument.create({ data: { tenantId, caseId: c.id, type: input.type, fileName: safeDocumentFileName(input.fileName), storageKey: input.storageKey, contentType: input.contentType, sizeBytes: input.sizeBytes, checksum: input.checksum, note: clean(input.note, 500), createdById: actor.id, createdByName: actor.name } });
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "DOCUMENT_ADDED", toValue: input.type, note: doc.fileName });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_DOCUMENT_ADDED", ...auditBase(c), details: { ...auditBase(c).details, type: input.type, documentId: doc.id } });
    return doc;
  }, TX).catch(domainFromDb);
}

/**
 * Archivieren statt löschen (Datenbank-Trigger); Grund Pflicht, einmalig. Phase F: nur bei offenem Fall (Sperre des Falls, dann
 * erneute Prüfung) und – über die Fallakte – nur Dokumente genau dieses Falls (opts.caseId). Archivierte bleiben abrufbar.
 */
export async function archiveAccidentDocument(tenantId: string, documentId: string, actor: Actor, reason: string, opts: { caseId?: string } = {}): Promise<CaseDocumentRow> {
  const why = clean(reason, 500);
  if (!why || why.length < 3) throw new DomainError("Bitte den Grund der Archivierung angeben.");
  return db.$transaction(async (tx) => {
    const d0 = await tx.accidentReplacementCaseDocument.findFirst({ where: { id: documentId, tenantId, ...(opts.caseId ? { caseId: opts.caseId } : {}) }, select: { caseId: true } });
    if (!d0) throw new DomainError("Dokument nicht gefunden.");
    const c = await lockCase(tx, tenantId, d0.caseId); assertOpen(c);
    const d = await tx.accidentReplacementCaseDocument.findFirst({ where: { id: documentId, tenantId, caseId: c.id }, include: { case: true } });
    if (!d) throw new DomainError("Dokument nicht gefunden.");
    if (d.archivedAt) throw new DomainError("Dieses Dokument ist bereits archiviert.");
    const row = await tx.accidentReplacementCaseDocument.update({ where: { id: d.id }, data: { archivedAt: new Date(), archivedById: actor.id, archivedByName: actor.name, archiveReason: why } });
    await accidentCaseEvent(tx, tenantId, d.caseId, actor, { type: "DOCUMENT_ARCHIVED", fromValue: d.type, reason: why, note: d.fileName });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_DOCUMENT_ARCHIVED", bookingId: d.case.bookingId, details: { caseNumber: d.case.caseNumber, documentId: d.id, reason: why } });
    return row;
  }, TX).catch(domainFromDb);
}

// ---------------------------------------------------------------------------
// Abgeleitete Zustände, Finanzen, nächste Schritte
// ---------------------------------------------------------------------------

export type RentalState = "RESERVED" | "ACTIVE" | "RETURNED" | "CANCELLED";
export type InvoiceState = "NONE" | "DRAFT" | "ISSUED";
export type PaymentState = "NONE" | "OPEN" | "PARTIAL" | "PAID";
/** Phase F: eine abgeschlossene Unfallersatz-Rechnung mit Stand aus der zentralen Saldenquelle (computeFinancials). */
export type CaseInvoiceFinance = {
  id: string; number: string | null; recipientRole: string;
  /** Zwischen-/Schlussrechnung bzw. Restforderung; null = ältere Rechnung ohne Angabe (zählt als Leistung) */
  billingType: AccidentBillingType | null;
  /** nur Restforderung: die gekürzte Versicherungsrechnung */
  remainderOfId: string | null; remainderOfNumber: string | null;
  /** ursprünglicher Rechnungsbetrag */
  invoiceCents: Cents;
  /** wirksame Forderung nach Gutschriften/Storno */
  grossCents: Cents; creditedCents: Cents; cancelledCents: Cents; paidCents: Cents; openCents: Cents;
  /** Zahlungen über der wirksamen Forderung (Guthaben) und davon noch nicht ausgezahlt */
  creditCents: Cents; refundOpenCents: Cents;
  /** dokumentierte Kürzungen (bestätigt) – mindern die Forderung NICHT */
  reducedCents: Cents;
  paymentStatus: InvoiceFinancials["paymentStatus"]; chain: InvoiceFinancials["chain"];
  /** vollständig storniert oder gutgeschrieben – zählt nicht als Abrechnung */
  neutralized: boolean;
  servicePeriodStart: Date | null; servicePeriodEnd: Date | null; issueDate: Date | null;
};
export type CaseFinancials = {
  /** abgeschlossene Unfallersatz-Rechnungen des Falls */
  invoices: CaseInvoiceFinance[];
  drafts: number;
  /** abgeschlossene Rechnungen, die nicht storniert bzw. vollständig gutgeschrieben sind */
  active: number;
  /** Ende des spätesten wirksam abgerechneten Leistungszeitraums (Zwischen-/Schlussrechnungen, ohne Restforderungen) */
  billedUntil: Date | null;
  /** eine wirksame Schlussrechnung liegt vor */
  finalBilled: boolean;
  /** Summe der wirksamen Forderungen (alle Rechnungen, nach Gutschriften/Storno) */
  grossCents: Cents;
  /** auf wirksame Forderungen gezahlt (je Rechnung höchstens deren Forderung; Mehrzahlungen siehe creditCents) */
  paidCents: Cents;
  /** Summe der offenen Forderungen je Rechnung (computeFinancials) */
  openCents: Cents;
  /** dokumentierte Kürzungen wirksamer Rechnungen – mindern die offene Forderung NICHT */
  reducedCents: Cents;
  /** wirksame Restforderungen an den Mieter (betreffen dieselbe Leistung wie eine Versicherungsrechnung) */
  remainderCents: Cents;
  /**
   * doppelt gefordert: Versicherungsrechnung (nach Gutschriften) und Restforderungen dazu verlangen zusammen mehr als den
   * ursprünglichen Rechnungsbetrag – unabhängig davon, ob und von wem schon gezahlt wurde
   */
  doubleClaimCents: Cents;
  /** woran die Doppelforderung liegt (für den Hinweis): Versicherung hat auch den gekürzten Teil gezahlt, Mieter hat gezahlt, beides offen */
  doubleClaimHint: "INSURER_PAID" | "RENTER_PAID" | "BOTH_OPEN" | null;
  /** tatsächlich noch einzufordern – ohne doppelt geforderte Beträge (Versicherungsrechnung und Restforderung als ein Anspruch) */
  economicOpenCents: Cents;
  /** Restforderung zu einer stornierten bzw. vollständig gutgeschriebenen Versicherungsrechnung (Grundlage entfallen) */
  orphanRemainderCents: Cents;
  /** Restforderung über der (noch bestätigten) dokumentierten Kürzung, z. B. nach Storno der Kürzung */
  remainderExcessCents: Cents;
  /** dokumentierte Kürzung, deren Betrag bei der Versicherung offen ist – weder per Gutschrift gemindert noch als Restforderung gestellt */
  unresolvedReductionCents: Cents;
  /** Guthaben aus Zahlungen über der wirksamen Forderung (z. B. nach Storno/Gutschrift); refundOpenCents = noch nicht ausgezahlt */
  creditCents: Cents;
  refundOpenCents: Cents;
  /** offene Mahngebühren zu Rechnungen des Falls (eigene Gebührenrechnungen) */
  feesOpenCents: Cents;
  /** über die tatsächliche Rückgabe hinaus berechnete Miettage (z. B. Zwischenrechnung nach einer Schlüsselbox-Abgabe) */
  overbilledDays: number;
  /** Lücken in der Leistungskette (z. B. mittlere Rechnung storniert) */
  gaps: { from: Date; until: Date }[];
  /** tatsächliche Übergabe (Grundlage der Miettage) */
  pickupAt: Date | null;
  /** bei der Rückgabe bestätigte Zusatzkosten, die noch in keiner wirksamen Leistungsrechnung stehen */
  unbilledChargeCount: number;
};
export type DerivedState = { rental: RentalState; rentalLabel: string; liability: AccidentLiabilityStatus; liabilityLabel: string; invoice: InvoiceState; payment: PaymentState; openEnd: boolean; overdue: boolean; daysSoFar: number; estimateCents: Cents };
export type NextStep = { code: string; text: string; tone: "bad" | "amber" | "info" | "grey"; href?: string };

/**
 * Ist die Miete nach der Rückgabe nur teilweise abgerechnet (z. B. nur Zwischenrechnung)? Phase F: gezählt in Miettagen (eine
 * Zwischenrechnung berechnet den angefangenen Miettag bereits voll – endet die Miete in diesem Tag, ist nichts mehr offen) und
 * an noch nicht berechneten Zusatzkosten der Rückgabe. Ohne Übergabedatum (ältere Daten) wie bisher nach Uhrzeit.
 */
export function finalInvoiceMissing(fin: Pick<CaseFinancials, "active" | "billedUntil"> & Partial<Pick<CaseFinancials, "finalBilled" | "pickupAt" | "unbilledChargeCount">>, returnedAt: Date | null | undefined): boolean {
  if (!(fin.active > 0) || !fin.billedUntil || !returnedAt || fin.finalBilled) return false;
  if ((fin.unbilledChargeCount ?? 0) > 0) return true;
  if (fin.pickupAt && fin.billedUntil > fin.pickupAt) return rentalDays(fin.pickupAt, returnedAt) > rentalDays(fin.pickupAt, fin.billedUntil);
  return fin.billedUntil.getTime() < returnedAt.getTime() - 60_000;
}

const isNeutralized = (chain: InvoiceFinancials["chain"]) => chain === "CANCELLED" || chain === "CREDITED";
const latest = (dates: (Date | null)[]) => dates.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null);

type FinanceRow = { id: string; number: string | null; status: string; currentVersion: { grossTotal: unknown; customerSnapshot: unknown; servicePeriodStart: Date; servicePeriodEnd: Date; issueDate: Date | null; items?: { extraChargeId: string | null }[] } | null };
const FINANCE_SELECT = { id: true, number: true, status: true, currentVersion: { select: { grossTotal: true, customerSnapshot: true, servicePeriodStart: true, servicePeriodEnd: true, issueDate: true, items: { where: { extraChargeId: { not: null } }, select: { extraChargeId: true } } } } } as const;
export type CaseFinanceContext = { pickupAt?: Date | null; returnedAt?: Date | null; returnChargeIds?: readonly string[]; feesOpenCents?: Cents };

/**
 * Phase F: Finanzstand eines Falls aus den Einzelständen der zentralen Saldenquelle (eine Ableitung für Fallakte, Liste und
 * Abschluss). Nichts wird verrechnet oder umgebucht: Kürzungen bleiben Dokumentation, eine Restforderung an den Mieter mindert
 * die Versicherungsrechnung nicht. Versicherungsrechnung und ihre Restforderungen sind EIN Anspruch über den ursprünglichen
 * Rechnungsbetrag: Was zusammen darüber hinaus verlangt wird, ist doppelt gefordert und wird ausgewiesen – nie still.
 * Gutschriften auf der Versicherungsrechnung gelten als Minderung dieses Anspruchs (typisch: Übertragung auf den Mieter).
 */
export function summarizeCaseFinance(rows: readonly FinanceRow[], fin: Map<string, InvoiceFinancials>, red: Map<string, Cents>, ctx: CaseFinanceContext = {}): CaseFinancials {
  const pickupAt = ctx.pickupAt ?? null;
  const finals = rows.filter((r) => r.status === "FINALIZED" && r.currentVersion && fin.has(r.id));
  const invoices: CaseInvoiceFinance[] = finals.map((r) => {
    const f = fin.get(r.id)!;
    const v = r.currentVersion!;
    const billing = accidentBillingOf(v.customerSnapshot);
    return {
      id: r.id, number: r.number, recipientRole: (v.customerSnapshot as { recipientRole?: string } | null)?.recipientRole ?? "RENTER",
      billingType: billing?.type ?? null, remainderOfId: billing?.remainderOf?.invoiceId ?? null, remainderOfNumber: billing?.remainderOf?.number ?? null,
      invoiceCents: f.invoiceCents, grossCents: f.effectiveCents, creditedCents: f.creditedCents, cancelledCents: f.cancelledCents, paidCents: f.paidCents, openCents: f.openCents,
      creditCents: f.customerCreditCents, refundOpenCents: f.refundRemainingCents,
      reducedCents: red.get(r.id) ?? 0, paymentStatus: f.paymentStatus, chain: f.chain, neutralized: isNeutralized(f.chain),
      servicePeriodStart: v.servicePeriodStart ?? null, servicePeriodEnd: v.servicePeriodEnd ?? null, issueDate: v.issueDate ?? null,
    };
  });
  const live = invoices.filter((i) => !i.neutralized);
  const service = live.filter((i) => i.billingType !== "REMAINDER").sort((a, b) => (a.servicePeriodStart?.getTime() ?? 0) - (b.servicePeriodStart?.getTime() ?? 0));
  const remainders = live.filter((i) => i.billingType === "REMAINDER");
  // Versicherungsrechnung + ihre Restforderungen = ein Anspruch über den ursprünglichen Rechnungsbetrag V
  let doubleClaimCents = 0, orphanRemainderCents = 0, remainderExcessCents = 0, unresolvedReductionCents = 0, pairedOpenCents = 0;
  let hint: CaseFinancials["doubleClaimHint"] = null;
  const paired = new Set<string>();
  for (const i of invoices.filter((x) => x.recipientRole === "INSURER" && x.billingType !== "REMAINDER")) {
    const rs = remainders.filter((r) => r.remainderOfId === i.id);
    rs.forEach((r) => paired.add(r.id));
    const rEff = rs.reduce((s, r) => s + r.grossCents, 0), rOpen = rs.reduce((s, r) => s + r.openCents, 0), rPaid = rs.reduce((s, r) => s + Math.min(r.paidCents, r.grossCents), 0);
    remainderExcessCents += Math.max(0, rEff - i.reducedCents);
    if (i.neutralized) {
      // Grundlage entfallen: die Restforderung steht allein (und bleibt offen, bis sie storniert ist)
      orphanRemainderCents += rEff;
      pairedOpenCents += rOpen;
      continue;
    }
    paired.add(i.id);
    const V = i.invoiceCents, paidI = Math.min(i.paidCents, i.grossCents);
    const over = Math.max(0, i.grossCents + rEff - V);
    doubleClaimCents += over;
    if (over > 0 && !hint) hint = paidI > V - rEff ? "INSURER_PAID" : rPaid > 0 ? "RENTER_PAID" : "BOTH_OPEN";
    pairedOpenCents += Math.max(0, Math.min(V, i.grossCents + rEff) - (paidI + rPaid));
    unresolvedReductionCents += Math.max(0, Math.min(Math.max(0, i.reducedCents - i.creditedCents), i.openCents) - rEff);
  }
  const otherOpen = live.filter((i) => !paired.has(i.id)).reduce((s, i) => s + i.openCents, 0);
  const gaps: CaseFinancials["gaps"] = [];
  let cursor: Date | null = pickupAt ?? service[0]?.servicePeriodStart ?? null;
  for (const i of service) {
    if (cursor && i.servicePeriodStart && i.servicePeriodStart.getTime() - cursor.getTime() > 60_000) gaps.push({ from: cursor, until: i.servicePeriodStart });
    if (i.servicePeriodEnd && (!cursor || i.servicePeriodEnd > cursor)) cursor = i.servicePeriodEnd;
  }
  const serviceIds = new Set(service.map((i) => i.id));
  const billedCharges = new Set(finals.filter((r) => serviceIds.has(r.id)).flatMap((r) => (r.currentVersion!.items ?? []).map((x) => x.extraChargeId).filter((x): x is string => !!x)));
  const billedUntil = latest(service.map((i) => i.servicePeriodEnd));
  const overbilledDays = pickupAt && ctx.returnedAt && billedUntil && billedUntil > ctx.returnedAt ? Math.max(0, rentalDays(pickupAt, billedUntil) - rentalDays(pickupAt, ctx.returnedAt)) : 0;
  return {
    invoices, drafts: rows.length - finals.length, active: live.length,
    billedUntil, finalBilled: service.some((i) => i.billingType === "FINAL"),
    grossCents: invoices.reduce((s, i) => s + i.grossCents, 0),
    paidCents: live.reduce((s, i) => s + Math.min(i.paidCents, i.grossCents), 0),
    openCents: live.reduce((s, i) => s + i.openCents, 0),
    reducedCents: live.reduce((s, i) => s + i.reducedCents, 0),
    remainderCents: remainders.reduce((s, i) => s + i.grossCents, 0),
    doubleClaimCents, doubleClaimHint: hint, economicOpenCents: pairedOpenCents + otherOpen, orphanRemainderCents, remainderExcessCents, unresolvedReductionCents,
    creditCents: invoices.reduce((s, i) => s + i.creditCents, 0), refundOpenCents: invoices.reduce((s, i) => s + i.refundOpenCents, 0),
    feesOpenCents: ctx.feesOpenCents ?? 0, overbilledDays,
    gaps: pickupAt || service.length ? gaps : [],
    pickupAt, unbilledChargeCount: service.length > 0 ? (ctx.returnChargeIds ?? []).filter((id) => !billedCharges.has(id)).length : 0,
  };
}

export async function caseFinancials(tenantId: string, bookingId: string, client: Client = db): Promise<CaseFinancials> {
  const [rows, booking, ret] = await Promise.all([
    client.invoice.findMany({ where: { tenantId, bookingId, kind: "ACCIDENT_REPLACEMENT", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, select: FINANCE_SELECT, orderBy: { createdAt: "asc" } }),
    client.booking.findFirst({ where: { id: bookingId, tenantId }, select: { actualPickupAt: true, actualReturnAt: true } }),
    client.handover.findFirst({ where: { tenantId, bookingId, type: "RETURN", status: "FINALIZED", correctsId: null }, orderBy: { finalizedAt: "desc" }, select: { extraCharges: { select: { id: true } } } }),
  ]);
  const finals = rows.filter((r) => r.status === "FINALIZED" && r.currentVersion);
  // Mahngebühren zu Rechnungen des Falls (eigene Gebührenrechnungen, z. B. an die Versicherung)
  const fees = finals.length ? await client.dunningNotice.findMany({ where: { tenantId, invoiceId: { in: finals.map((r) => r.id) }, feeInvoice: { status: "FINALIZED" } }, select: { feeInvoice: { select: { id: true, currentVersion: { select: { grossTotal: true } } } } } }) : [];
  const feeRows = fees.map((f) => f.feeInvoice).filter((f): f is NonNullable<typeof f> => !!f && !!f.currentVersion);
  const [fin, red, feeFin] = await Promise.all([
    financialsFor(tenantId, finals.map((r) => ({ id: r.id, grossTotal: r.currentVersion!.grossTotal })), client),
    reductionsFor(tenantId, finals.map((r) => r.id), client),
    financialsFor(tenantId, feeRows.map((f) => ({ id: f.id, grossTotal: f.currentVersion!.grossTotal })), client),
  ]);
  return summarizeCaseFinance(rows, fin, red, { pickupAt: booking?.actualPickupAt ?? null, returnedAt: booking?.actualReturnAt ?? null, returnChargeIds: ret?.extraCharges.map((e) => e.id) ?? [], feesOpenCents: [...feeFin.values()].reduce((s, f) => s + f.openCents, 0) });
}

/** Reine Ableitung aus Fall, Buchung und Finanzstand – nichts davon wird gespeichert. */
export function deriveState(c: Pick<CaseRow, "liabilityStatus">, b: { status: string; startAt: Date; endAt: Date | null; actualPickupAt: Date | null; actualReturnAt: Date | null; dailyRate: unknown }, fin: CaseFinancials, now = new Date()): DerivedState {
  const rental = (["RESERVED", "ACTIVE", "RETURNED", "CANCELLED"].includes(b.status) ? b.status : "RESERVED") as RentalState;
  const start = b.actualPickupAt ?? b.startAt;
  const until = b.actualReturnAt ?? (b.status === "ACTIVE" ? now : b.endAt ?? now);
  const daysSoFar = b.status === "RESERVED" ? 0 : rentalDays(start, until);
  const estimateCents = b.status === "RESERVED" || b.status === "CANCELLED" ? 0 : toCents(calculateRentalPrice({ start, end: until, rates: { dailyRate: Number(b.dailyRate) }, strategy: "DAILY_ONLY" }).total.toFixed(2));
  const invoice: InvoiceState = fin.active > 0 ? "ISSUED" : fin.drafts > 0 ? "DRAFT" : "NONE";
  const payment: PaymentState = fin.active === 0 ? "NONE" : fin.economicOpenCents === 0 ? "PAID" : fin.paidCents > 0 ? "PARTIAL" : "OPEN";
  const liability = (c.liabilityStatus in ACCIDENT_LIABILITY_STATUS ? c.liabilityStatus : "UNKNOWN") as AccidentLiabilityStatus;
  return {
    rental, rentalLabel: BOOKING_STATUS[rental as BookingStatus] ?? rental, liability, liabilityLabel: ACCIDENT_LIABILITY_STATUS[liability], invoice, payment,
    openEnd: b.endAt === null && b.status !== "RETURNED", overdue: b.status === "ACTIVE" && b.endAt !== null && b.endAt < now, daysSoFar, estimateCents,
  };
}

/**
 * Phase F: Hinweise aus dem Finanzstand – dieselben Texte in nächsten Schritten, Abschlusswarnungen und Fallakte. Nichts wird
 * automatisch korrigiert; jeder Hinweis nennt den bewussten Schritt (Gutschrift, Storno, Auszahlung).
 */
export function financeWarnings(fin: CaseFinancials): { code: string; text: string }[] {
  const w: { code: string; text: string }[] = [];
  if (fin.doubleClaimCents > 0) w.push({ code: "DOUBLE_CLAIM", text: fin.doubleClaimHint === "INSURER_PAID"
    ? `Doppelt gefordert: ${fmtCents(fin.doubleClaimCents)} – die Versicherung hat auch den gekürzten Betrag bezahlt, die Restforderung an den Mieter besteht noch. Restforderung stornieren bzw. gutschreiben.`
    : fin.doubleClaimHint === "RENTER_PAID"
      ? `Doppelt gefordert: ${fmtCents(fin.doubleClaimCents)} – der Mieter hat die Restforderung bezahlt, die Versicherungsrechnung verlangt denselben Betrag noch. Versicherungsrechnung per Gutschrift mindern.`
      : `Doppelt gefordert: ${fmtCents(fin.doubleClaimCents)} stehen zugleich in der Versicherungsrechnung und in der Restforderung an den Mieter. Wird der Mieter in Anspruch genommen, die Versicherungsrechnung per Gutschrift mindern – zahlt die Versicherung doch, die Restforderung stornieren.` });
  if (fin.orphanRemainderCents > 0) w.push({ code: "REMAINDER_ORPHAN", text: `Restforderung an den Mieter über ${fmtCents(fin.orphanRemainderCents)} zu einer stornierten bzw. vollständig gutgeschriebenen Versicherungsrechnung – Grundlage entfallen, bitte prüfen (ggf. stornieren).` });
  if (fin.remainderExcessCents > 0) w.push({ code: "REMAINDER_EXCESS", text: `Restforderung übersteigt die dokumentierte Kürzung um ${fmtCents(fin.remainderExcessCents)} (z. B. Kürzung storniert) – bitte prüfen.` });
  if (fin.unresolvedReductionCents > 0) w.push({ code: "REDUCTION_OPEN", text: `Dokumentierte Kürzung über ${fmtCents(fin.unresolvedReductionCents)} ohne Gutschrift oder Restforderung – die Rechnung an die Versicherung ist in dieser Höhe weiter offen.` });
  if (fin.refundOpenCents > 0) w.push({ code: "REFUND_OPEN", text: `Guthaben ${fmtCents(fin.refundOpenCents)} aus Zahlungen über der wirksamen Forderung (z. B. nach Storno oder Gutschrift) – noch nicht ausgezahlt bzw. geklärt.` });
  if (fin.feesOpenCents > 0) w.push({ code: "FEES_OPEN", text: `Offene Mahngebühren ${fmtCents(fin.feesOpenCents)}.` });
  if (fin.overbilledDays > 0) w.push({ code: "BILLED_BEYOND_RETURN", text: `${fin.overbilledDays} ${fin.overbilledDays === 1 ? "Miettag ist" : "Miettage sind"} über die tatsächliche Rückgabe hinaus berechnet (z. B. Zwischenrechnung nach einer Schlüsselbox-Abgabe) – die betreffende Rechnung stornieren und neu abrechnen.` });
  for (const g of fin.gaps) w.push({ code: "BILLING_GAP", text: `Lücke in der Abrechnung: ${fmtDateTime(g.from)} bis ${fmtDateTime(g.until)} ist nicht wirksam abgerechnet.` });
  return w;
}

/** Fälligkeit einer Wiedervorlage nach Kalendertag (Europe/Berlin): überfällig, heute oder später. */
export function followUpDue(dueAt: Date, now = new Date()): "OVERDUE" | "TODAY" | "LATER" {
  const due = toDateInputValue(dueAt), today = toDateInputValue(now);
  return due < today ? "OVERDUE" : due === today ? "TODAY" : "LATER";
}

/**
 * Praxistest-Korrekturrunde: Kaution des Mieters in der Fallakte – nur aus der bestehenden Kautionsrechnung (deposits.ts:
 * securityDepositFinancials), keine eigene Kautionslogik. Getrennt von jeder Unfallersatz-Rechnung (keine Verrechnung).
 * - DEPOSIT_OPEN: nach der Rückgabe (bzw. Storno) erhaltene Kaution, die weder freigegeben noch einbehalten oder verrechnet ist
 * - DEPOSIT_PAYOUT_OPEN: freigegeben, aber noch nicht (vollständig) ausgezahlt
 * Während der Miete ist eine gehaltene Kaution normal und erzeugt keinen Hinweis.
 */
export type CaseDeposit = Pick<DepositFinancials, "expectedCents" | "receivedCents" | "remainingCents" | "payoutRemainingCents">;
export function depositSignals(d: CaseDeposit | null | undefined, bookingStatus: string): { code: "DEPOSIT_OPEN" | "DEPOSIT_PAYOUT_OPEN"; step: string; close: string }[] {
  if (!d) return [];
  const out: { code: "DEPOSIT_OPEN" | "DEPOSIT_PAYOUT_OPEN"; step: string; close: string }[] = [];
  if ((bookingStatus === "RETURNED" || bookingStatus === "CANCELLED") && d.remainingCents > 0) {
    out.push({ code: "DEPOSIT_OPEN", step: `Kaution prüfen: ${fmtCents(d.remainingCents)} erhalten, noch nicht freigegeben oder einbehalten.`, close: "Kaution noch offen – Freigabe oder Einbehalt prüfen." });
  }
  if (d.payoutRemainingCents > 0) {
    out.push({ code: "DEPOSIT_PAYOUT_OPEN", step: `Kautionsauszahlung offen: ${fmtCents(d.payoutRemainingCents)} freigegeben, noch nicht ausgezahlt.`, close: `Kautionsauszahlung offen: ${fmtCents(d.payoutRemainingCents)} freigegeben, noch nicht ausgezahlt.` });
  }
  return out;
}

/** Hinweise aus realen Daten – kein separat gepflegter Status. */
export function nextSteps(c: Pick<CaseRow, "id" | "status" | "insurerName" | "insurerClaimNumber" | "liabilityStatus" | "bookingId">, b: { status: string; endAt: Date | null; actualReturnAt?: Date | null; contract: { status: string } | null; handovers: { type: string; status: string }[]; /** Praxistest: Kaution des Mieters (optional) */ depositState?: CaseDeposit | null }, fin: CaseFinancials, openFollowUps: readonly { dueAt: Date }[], now = new Date()): NextStep[] {
  const out: NextStep[] = [];
  const bookingHref = `/buchungen/${c.bookingId}`;
  const billingHref = `/unfallersatz/${c.id}?tab=abrechnung`;
  if (c.status === "CLOSED") return [{ code: "CLOSED", text: "Der Fall ist abgeschlossen.", tone: "grey" }];
  if (!c.insurerName) out.push({ code: "INSURER_MISSING", text: "Versicherung noch nicht erfasst.", tone: "amber" });
  else if (!c.insurerClaimNumber) out.push({ code: "CLAIM_NUMBER_MISSING", text: "Schadennummer der Versicherung fehlt.", tone: "amber" });
  if (c.liabilityStatus === "UNKNOWN" || c.liabilityStatus === "REPORTED" || c.liabilityStatus === "UNCLEAR") out.push({ code: "LIABILITY_OPEN", text: `Haftung: ${ACCIDENT_LIABILITY_STATUS[c.liabilityStatus as AccidentLiabilityStatus]}.`, tone: "info" });
  if (b.status === "RESERVED") {
    // Phase E: Unfallersatz-Vertrag (Mietende „bis zur Rückgabe“) im Vertragsassistenten vorbereiten, unterschreiben, abschließen
    if (!b.contract || b.contract.status !== "SIGNED") out.push({ code: "CONTRACT", text: b.contract ? "Mietvertrag vorbereitet, noch nicht unterschrieben. Erst nach dem Abschluss ist die Übergabe möglich." : "Mietvertrag noch nicht angelegt.", tone: "amber", href: `${bookingHref}/vertrag` });
    else out.push({ code: "PICKUP", text: b.handovers.some((h) => h.type === "PICKUP" && h.status === "DRAFT") ? "Übergabe begonnen, noch nicht abgeschlossen." : "Übergabe noch nicht durchgeführt.", tone: "amber", href: `${bookingHref}/uebergabe` });
  } else if (b.status === "ACTIVE") {
    if (b.endAt === null) out.push({ code: "OPEN_END", text: "Mietende offen – Fahrzeug bleibt bis zur Rückgabe belegt.", tone: "info" });
    else if (b.endAt < now) out.push({ code: "OVERDUE", text: `Geplantes Mietende ${fmtDateTime(b.endAt)} überschritten – Mietdauer aktualisieren oder Rückgabe durchführen.`, tone: "bad", href: `${bookingHref}/rueckgabe` });
    else if (b.endAt.getTime() - now.getTime() < 2 * 86_400_000) out.push({ code: "RETURN_DUE", text: `Rückgabe geplant ${fmtDateTime(b.endAt)}.`, tone: "info", href: `${bookingHref}/rueckgabe` });
    if (b.handovers.some((h) => h.type === "RETURN" && h.status === "DRAFT")) out.push({ code: "RETURN_DRAFT", text: "Rückgabe begonnen, noch nicht abgeschlossen.", tone: "amber", href: `${bookingHref}/rueckgabe` });
  } else if (b.status === "RETURNED") {
    if (fin.active === 0 && fin.drafts === 0) out.push({ code: "INVOICE_MISSING", text: fin.invoices.length > 0 ? "Fahrzeug zurückgegeben; die Rechnung ist storniert bzw. gutgeschrieben – noch nicht neu abgerechnet." : "Fahrzeug zurückgegeben, noch nicht abgerechnet – Schlussrechnung erstellen.", tone: "amber", href: billingHref });
    else if (fin.drafts > 0) out.push({ code: "INVOICE_DRAFT", text: `${fin.drafts} Rechnungsentwurf${fin.drafts === 1 ? "" : "e"} offen.`, tone: "amber", href: billingHref });
    else if (finalInvoiceMissing(fin, b.actualReturnAt)) out.push({ code: "FINAL_INVOICE_MISSING", text: `Schlussrechnung fehlt: abgerechnet bis ${fmtDateTime(fin.billedUntil!)}, zurückgegeben ${fmtDateTime(b.actualReturnAt!)}.`, tone: "amber", href: billingHref });
  } else if (b.status === "CANCELLED") out.push({ code: "CANCELLED", text: "Die Buchung ist storniert.", tone: "grey" });
  if (b.status === "ACTIVE" && fin.drafts > 0) out.push({ code: "INVOICE_DRAFT", text: `${fin.drafts} Rechnungsentwurf${fin.drafts === 1 ? "" : "e"} offen.`, tone: "amber", href: billingHref });
  if (fin.active > 0 && fin.economicOpenCents > 0) out.push({ code: fin.paidCents > 0 ? "PARTIALLY_PAID" : "INVOICE_OPEN", text: `${fin.paidCents > 0 ? "Rechnung teilweise bezahlt" : "Rechnung offen"}: ${fmtCents(fin.economicOpenCents)} offen${fin.reducedCents > 0 ? ` (dokumentierte Kürzungen ${fmtCents(fin.reducedCents)})` : ""}.`, tone: "amber", href: billingHref });
  for (const w of financeWarnings(fin)) out.push({ ...w, tone: w.code === "REDUCTION_OPEN" || w.code === "FEES_OPEN" ? "amber" : "bad", href: billingHref });
  for (const d of depositSignals(b.depositState, b.status)) out.push({ code: d.code, text: d.step, tone: "amber", href: `/unfallersatz/${c.id}?tab=miete#kaution` });
  const due = openFollowUps.map((f) => followUpDue(f.dueAt, now));
  const overdueCount = due.filter((d) => d === "OVERDUE").length, todayCount = due.filter((d) => d === "TODAY").length;
  if (overdueCount > 0) out.push({ code: "FOLLOW_UP_OVERDUE", text: `${overdueCount} Wiedervorlage${overdueCount === 1 ? "" : "n"} überfällig.`, tone: "bad" });
  if (todayCount > 0) out.push({ code: "FOLLOW_UP_TODAY", text: `${todayCount} Wiedervorlage${todayCount === 1 ? "" : "n"} heute fällig.`, tone: "amber" });
  return out;
}

// ---------------------------------------------------------------------------
// Abschluss (bewusst, mit Grund; Warnungen werden dokumentiert, blockieren aber nicht)
// ---------------------------------------------------------------------------

export type CloseWarning = { code: string; text: string };

export async function closeWarnings(tenantId: string, caseId: string, client: Client = db): Promise<CloseWarning[]> {
  const c = await client.accidentReplacementCase.findFirst({ where: { id: caseId, tenantId }, include: { booking: { select: { status: true, actualReturnAt: true, handovers: { where: { type: "RETURN", status: "FINALIZED" }, select: { id: true } } } } } });
  if (!c) throw new DomainError("Unfallersatzfall nicht gefunden.");
  const fin = await caseFinancials(tenantId, c.bookingId, client);
  const openFollowUps = await client.caseFollowUp.count({ where: { tenantId, caseId: c.id, status: "OPEN" } });
  // Praxistest: Kaution des Mieters – Hinweis, keine Sperre (Kautionsvorgänge bleiben nach dem Abschluss möglich)
  const deposit = await securityDepositFinancials(tenantId, c.bookingId, client);
  const w: CloseWarning[] = [];
  if (c.booking.status === "RESERVED" || c.booking.status === "ACTIVE") w.push({ code: "RENTAL_RUNNING", text: c.booking.status === "ACTIVE" ? "Die Miete läuft noch (Fahrzeug nicht zurückgegeben)." : "Die Buchung ist noch reserviert (Fahrzeug nicht übergeben)." });
  if (c.booking.status !== "CANCELLED" && c.booking.handovers.length === 0) w.push({ code: "NO_RETURN", text: "Es gibt kein abgeschlossenes Rückgabeprotokoll." });
  if (c.booking.status === "RETURNED" && fin.active === 0) w.push({ code: "NO_INVOICE", text: fin.invoices.length > 0 ? "Die Rechnung ist storniert bzw. gutgeschrieben; es gibt keine wirksame Rechnung." : "Es wurde keine Rechnung abgeschlossen." });
  if (c.booking.status === "RETURNED" && finalInvoiceMissing(fin, c.booking.actualReturnAt)) w.push({ code: "FINAL_INVOICE_MISSING", text: `Schlussrechnung fehlt: abgerechnet bis ${fmtDateTime(fin.billedUntil!)}.` });
  if (fin.drafts > 0) w.push({ code: "INVOICE_DRAFT", text: `${fin.drafts} Rechnungsentwurf${fin.drafts === 1 ? "" : "e"} offen.` });
  if (fin.economicOpenCents > 0) w.push({ code: "OPEN_AMOUNT", text: `Offene Forderung ${fmtCents(fin.economicOpenCents)}.` });
  w.push(...financeWarnings(fin));
  for (const d of depositSignals(deposit, c.booking.status)) w.push({ code: d.code, text: d.close });
  if (openFollowUps > 0) w.push({ code: "FOLLOW_UPS", text: `${openFollowUps} offene Wiedervorlage${openFollowUps === 1 ? "" : "n"}.` });
  if (c.liabilityStatus === "UNKNOWN" || c.liabilityStatus === "REPORTED" || c.liabilityStatus === "UNCLEAR") w.push({ code: "LIABILITY_OPEN", text: `Haftung: ${ACCIDENT_LIABILITY_STATUS[c.liabilityStatus as AccidentLiabilityStatus]}.` });
  return w;
}

/** Schließen trotz Warnungen nur mit ausdrücklicher Bestätigung (acknowledgeWarnings); die Warnungen bleiben am Fall dokumentiert. */
export async function closeCase(tenantId: string, caseId: string, actor: Actor, input: { reason: string; acknowledgeWarnings?: boolean }): Promise<CaseRow> {
  const reason = clean(input.reason, 500);
  if (!reason || reason.length < 3) throw new DomainError("Bitte den Grund für den Abschluss angeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    if (c.status === "CLOSED") throw new DomainError(`Der Fall ${c.caseNumber} ist bereits abgeschlossen.`);
    const warnings = await closeWarnings(tenantId, c.id, tx);
    if (warnings.length > 0 && !input.acknowledgeWarnings) throw new DomainError(`Der Fall hat offene Punkte: ${warnings.map((x) => x.text).join(" ")} Zum Abschließen trotzdem bitte bewusst bestätigen.`);
    const row = await tx.accidentReplacementCase.update({ where: { id: c.id }, data: { status: "CLOSED", closedAt: new Date(), closedById: actor.id, closedByName: actor.name, closeReason: reason, closeWarnings: warnings as unknown as Prisma.InputJsonValue } });
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "CLOSED", fromValue: "OPEN", toValue: "CLOSED", reason, note: warnings.length ? `Trotz offener Punkte abgeschlossen: ${warnings.map((x) => x.text).join(" ")}` : null });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_CLOSED", ...auditBase(c), details: { ...auditBase(c).details, reason, warnings: warnings.map((x) => x.code).join(",") || null } });
    return row;
  }, TX).catch(domainFromDb);
}

export async function reopenCase(tenantId: string, caseId: string, actor: Actor, reason: string): Promise<CaseRow> {
  const why = clean(reason, 500);
  if (!why || why.length < 3) throw new DomainError("Bitte den Grund für das Wiederöffnen angeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, caseId);
    if (c.status !== "CLOSED") throw new DomainError("Der Fall ist nicht abgeschlossen.");
    const row = await tx.accidentReplacementCase.update({ where: { id: c.id }, data: { status: "OPEN", closedAt: null, closedById: null, closedByName: null, closeReason: null, closeWarnings: Prisma.DbNull } });
    await accidentCaseEvent(tx, tenantId, c.id, actor, { type: "REOPENED", fromValue: "CLOSED", toValue: "OPEN", reason: why });
    await recordAudit(tx, tenantId, actor, { action: "ACCIDENT_CASE_REOPENED", ...auditBase(c), details: { ...auditBase(c).details, reason: why } });
    return row;
  }, TX).catch(domainFromDb);
}

// ---------------------------------------------------------------------------
// Ansicht und Liste
// ---------------------------------------------------------------------------

export type CaseView = Awaited<ReturnType<typeof accidentCaseView>>;

/** Alles für die Fallakte in einer Abfrage-Runde; Zustände abgeleitet, Finanzen aus der zentralen Saldenquelle. */
export async function accidentCaseView(tenantId: string, caseId: string) {
  const c = await db.accidentReplacementCase.findFirst({
    where: { id: caseId, tenantId },
    include: {
      booking: { include: { customer: true, vehicle: true, contract: { select: { id: true, number: true, status: true, signedAt: true } }, handovers: { where: { correctsId: null }, select: { id: true, type: true, status: true, number: true, finalizedAt: true } } } },
      tariffItems: { orderBy: { sortOrder: "asc" } },
      documents: { orderBy: { createdAt: "desc" } },
      followUps: { orderBy: [{ status: "asc" }, { dueAt: "asc" }] },
      events: { orderBy: { createdAt: "desc" }, take: 200 },
    },
  });
  if (!c) throw new DomainError("Unfallersatzfall nicht gefunden.");
  const fin = await caseFinancials(tenantId, c.bookingId);
  const open = c.followUps.filter((f) => f.status === "OPEN");
  const state = deriveState(c, c.booking, fin);
  const steps = nextSteps(c, c.booking, fin, open);
  return { case: c, booking: c.booking, financials: fin, state, nextSteps: steps, openFollowUps: open.length };
}

export const CASE_FILTERS = {
  alle: "Alle", laufend: "Laufend", haftung_offen: "Haftung offen", rueckgabe_faellig: "Rückgabe fällig", abzurechnen: "Abzurechnen", zahlung_offen: "Zahlung offen", abgeschlossen: "Abgeschlossen",
} as const;
export type CaseFilter = keyof typeof CASE_FILTERS;

export type CaseListRow = { id: string; caseNumber: string; status: string; customerName: string; customerId: string; vehicle: string; plate: string; insurerName: string | null; claimNumber: string | null; startAt: Date; plannedEndAt: Date | null; actualReturnAt: Date | null; state: DerivedState; grossCents: Cents; openCents: Cents; reducedCents: Cents; createdAt: Date };

/** Liste mit Filter aus realen Daten (Buchungsstatus, Haftung, Rechnungen, Zahlungen). Suche über Fallnummer, Kunde, Kennzeichen, Versicherung, Schadennummer. */
export async function listAccidentCases(tenantId: string, opts: { filter?: CaseFilter; q?: string | null; take?: number } = {}): Promise<CaseListRow[]> {
  const filter: CaseFilter = opts.filter && opts.filter in CASE_FILTERS ? opts.filter : "alle";
  const q = opts.q?.trim();
  const where: Prisma.AccidentReplacementCaseWhereInput = {
    tenantId,
    ...(filter === "abgeschlossen" ? { status: "CLOSED" } : filter === "alle" ? {} : { status: "OPEN" }),
    ...(filter === "laufend" ? { booking: { status: { in: ["RESERVED", "ACTIVE"] } } } : {}),
    ...(filter === "haftung_offen" ? { liabilityStatus: { in: ["UNKNOWN", "REPORTED", "UNCLEAR"] } } : {}),
    ...(filter === "rueckgabe_faellig" ? { booking: { status: "ACTIVE", endAt: { not: null, lt: new Date(Date.now() + 2 * 86_400_000) } } } : {}),
    ...(filter === "abzurechnen" ? { booking: { status: "RETURNED", invoices: { none: { kind: "ACCIDENT_REPLACEMENT", documentType: "INVOICE", status: "FINALIZED" } } } } : {}),
    ...(q ? { OR: [{ caseNumber: { contains: q, mode: "insensitive" } }, { insurerName: { contains: q, mode: "insensitive" } }, { insurerClaimNumber: { contains: q, mode: "insensitive" } }, { damagedPlate: { contains: q, mode: "insensitive" } }, { booking: { OR: [{ number: { contains: q, mode: "insensitive" } }, { vehicle: { plate: { contains: q, mode: "insensitive" } } }, { customer: { OR: [{ lastName: { contains: q, mode: "insensitive" } }, { firstName: { contains: q, mode: "insensitive" } }, { companyName: { contains: q, mode: "insensitive" } }] } }] } }] } : {}),
  };
  const rows = await db.accidentReplacementCase.findMany({ where, include: { booking: { include: { customer: { select: { id: true, type: true, firstName: true, lastName: true, companyName: true } }, vehicle: { select: { make: true, model: true, plate: true } } } } }, orderBy: { createdAt: "desc" }, take: opts.take ?? 300 });
  // Finanzstand aller Fälle in einer Runde
  const invRows = rows.length ? await db.invoice.findMany({ where: { tenantId, bookingId: { in: rows.map((r) => r.bookingId) }, kind: "ACCIDENT_REPLACEMENT", documentType: "INVOICE", status: { in: ["DRAFT", "FINALIZED"] } }, select: { ...FINANCE_SELECT, bookingId: true }, orderBy: { createdAt: "asc" } }) : [];
  const finals = invRows.filter((i) => i.status === "FINALIZED" && i.currentVersion);
  const [fin, red] = await Promise.all([financialsFor(tenantId, finals.map((i) => ({ id: i.id, grossTotal: i.currentVersion!.grossTotal }))), reductionsFor(tenantId, finals.map((i) => i.id))]);
  const now = new Date();
  const out: CaseListRow[] = [];
  for (const r of rows) {
    const cf = summarizeCaseFinance(invRows.filter((i) => i.bookingId === r.bookingId), fin, red, { pickupAt: r.booking.actualPickupAt, returnedAt: r.booking.actualReturnAt });
    if (filter === "zahlung_offen" && !(cf.active > 0 && cf.economicOpenCents > 0)) continue;
    const state = deriveState(r, r.booking, cf, now);
    out.push({ id: r.id, caseNumber: r.caseNumber, status: r.status, customerName: customerName(r.booking.customer), customerId: r.booking.customer.id, vehicle: `${r.booking.vehicle.make} ${r.booking.vehicle.model}`, plate: r.booking.vehicle.plate, insurerName: r.insurerName, claimNumber: r.insurerClaimNumber, startAt: r.booking.startAt, plannedEndAt: r.booking.endAt, actualReturnAt: r.booking.actualReturnAt, state, grossCents: cf.grossCents, openCents: cf.economicOpenCents, reducedCents: cf.reducedCents, createdAt: r.createdAt });
  }
  return out;
}

export type CaseCounts = { running: number; liabilityOpen: number; toInvoice: number; paymentOpen: number; reduced: number; closed: number };

/** Kennzahlen der Unfallersatz-Zentrale – aus denselben Ableitungen wie die Liste. */
export async function accidentCaseCounts(tenantId: string): Promise<CaseCounts> {
  const all = await listAccidentCases(tenantId, { filter: "alle", take: 2000 });
  return {
    running: all.filter((r) => r.status === "OPEN" && (r.state.rental === "RESERVED" || r.state.rental === "ACTIVE")).length,
    liabilityOpen: all.filter((r) => r.status === "OPEN" && ["UNKNOWN", "REPORTED", "UNCLEAR"].includes(r.state.liability)).length,
    toInvoice: all.filter((r) => r.status === "OPEN" && r.state.rental === "RETURNED" && r.state.invoice !== "ISSUED").length,
    paymentOpen: all.filter((r) => r.state.invoice === "ISSUED" && r.openCents > 0).length,
    reduced: all.filter((r) => r.reducedCents > 0).length,
    closed: all.filter((r) => r.status === "CLOSED").length,
  };
}

/** Offene Wiedervorlagen (für „Heute“), fällige zuerst. */
export async function dueFollowUps(tenantId: string, until: Date, take = 100) {
  return db.caseFollowUp.findMany({ where: { tenantId, status: "OPEN", dueAt: { lt: until } }, include: { case: { select: { id: true, caseNumber: true, bookingId: true, booking: { select: { customer: { select: { type: true, firstName: true, lastName: true, companyName: true } }, vehicle: { select: { plate: true } } } } } } }, orderBy: { dueAt: "asc" }, take });
}

// ---------------------------------------------------------------------------
// Praxistest-Korrekturrunde: Unfallersatz auf „Heute“ – offene Fälle (Fallstatus OPEN, nicht Buchungen) und ihr Handlungsbedarf
// aus derselben Ableitung wie die Fallakte (caseFinancials + nextSteps). Keine zweite „Nächste Schritte“-Logik, kein Statusfeld.
// ---------------------------------------------------------------------------

/**
 * Schritte der Fallakte, die auf „Heute“ als Handlungsbedarf erscheinen. Bewusst nicht: Vertrag, Übergabe, Rückgabe, Überfälligkeit
 * (eigene Miet-Aufgaben des Dashboards), offenes Mietende (normal laufende Miete), Erstattung (Rechnungsaufgabe), Kaution
 * (bestehende Kautionsaufgaben und -kennzahlen) und Wiedervorlagen (je Wiedervorlage eine eigene Aufgabe).
 */
export const DASHBOARD_CASE_STEPS = new Set([
  "INSURER_MISSING", "CLAIM_NUMBER_MISSING", "LIABILITY_OPEN",
  "INVOICE_MISSING", "INVOICE_DRAFT", "FINAL_INVOICE_MISSING", "INVOICE_OPEN", "PARTIALLY_PAID",
  "DOUBLE_CLAIM", "REMAINDER_ORPHAN", "REMAINDER_EXCESS", "REDUCTION_OPEN", "FEES_OPEN", "BILLED_BEYOND_RETURN", "BILLING_GAP",
]);
const TO_INVOICE_STEPS = new Set(["INVOICE_MISSING", "INVOICE_DRAFT", "FINAL_INVOICE_MISSING"]);
/** Statuswort der Aufgabe (Reihenfolge = Vorrang, wenn ein Fall mehrere Punkte hat) */
const DASHBOARD_STEP_STATUS: [string, string][] = [
  ["DOUBLE_CLAIM", "Doppelforderung"], ["BILLED_BEYOND_RETURN", "Prüfen"], ["BILLING_GAP", "Prüfen"], ["REMAINDER_ORPHAN", "Prüfen"], ["REMAINDER_EXCESS", "Prüfen"],
  ["INVOICE_MISSING", "Abzurechnen"], ["FINAL_INVOICE_MISSING", "Schlussrechnung fehlt"], ["INVOICE_DRAFT", "Entwurf offen"],
  ["REDUCTION_OPEN", "Kürzung ungeklärt"], ["PARTIALLY_PAID", "Teilbezahlt"], ["INVOICE_OPEN", "Rechnung offen"], ["FEES_OPEN", "Mahngebühren offen"],
  ["INSURER_MISSING", "Versicherung fehlt"], ["CLAIM_NUMBER_MISSING", "Schadennummer fehlt"], ["LIABILITY_OPEN", "Haftung ungeklärt"],
];
const DAMAGE_TAB_STEPS = new Set(["INSURER_MISSING", "CLAIM_NUMBER_MISSING", "LIABILITY_OPEN"]);

export type AccidentDashboardCase = { caseId: string; caseNumber: string; customerName: string; plate: string; returnedAt: Date | null; steps: NextStep[]; status: string; href: string };
export type AccidentDashboardFollowUp = { id: string; title: string; dueAt: Date; due: "OVERDUE" | "TODAY" | "LATER"; assigneeName: string | null; caseId: string; caseNumber: string; customerName: string; plate: string };
export type AccidentDashboard = {
  /** offene Fälle (Fallstatus OPEN) */
  open: number;
  /** davon Miete läuft (Fahrzeug übergeben) bzw. reserviert */
  running: number; reserved: number;
  /** nur Vollsicht (Inhaber, Disposition) – für den Hof null: Abrechnungs-, Rechnungs- und Wiedervorlagenzahlen */
  toInvoice: number | null; invoicesOpen: number | null; followUpsDue: number | null;
  /** genau ein offener Fall: direkter Link in die Fallakte */
  singleCaseId: string | null;
  cases: AccidentDashboardCase[];
  followUps: AccidentDashboardFollowUp[];
};

/**
 * Kennzahl und Aufmerksamkeit für „Heute“. full = Vollsicht (Inhaber, Disposition): Finanzstand und Wiedervorlagen je Fall wie in
 * der Fallakte. Ohne full (Hof, Supportmodus) werden Versicherung, Beträge und Wiedervorlagen gar nicht abgefragt.
 * until: Wiedervorlagen bis zu diesem Zeitpunkt (Ende des gewählten Zeitraums) als Aufgaben.
 */
export async function accidentDashboard(tenantId: string, opts: { full: boolean; until: Date; now?: Date }): Promise<AccidentDashboard> {
  const now = opts.now ?? new Date();
  const cases = await db.accidentReplacementCase.findMany({
    where: { tenantId, status: "OPEN" },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: {
      id: true, caseNumber: true, status: true, bookingId: true,
      ...(opts.full ? { insurerName: true, insurerClaimNumber: true, liabilityStatus: true } : {}),
      booking: {
        select: {
          status: true, endAt: true, actualReturnAt: true,
          contract: { select: { status: true } },
          handovers: { where: { correctsId: null }, select: { type: true, status: true } },
          customer: { select: { type: true, firstName: true, lastName: true, companyName: true } },
          vehicle: { select: { plate: true } },
        },
      },
      ...(opts.full ? { followUps: { where: { status: "OPEN" }, orderBy: { dueAt: "asc" }, select: { id: true, title: true, dueAt: true, assigneeName: true } } } : {}),
    },
  });
  const running = cases.filter((c) => c.booking.status === "ACTIVE").length;
  const reserved = cases.filter((c) => c.booking.status === "RESERVED").length;
  const base = { open: cases.length, running, reserved, singleCaseId: cases.length === 1 ? cases[0].id : null };
  if (!opts.full) return { ...base, toInvoice: null, invoicesOpen: null, followUpsDue: null, cases: [], followUps: [] };

  // derselbe Finanzstand wie in der Fallakte (je Fall; offene Unfallersatzfälle sind wenige) – in kleinen Paketen
  const fins = new Map<string, CaseFinancials>();
  for (let i = 0; i < cases.length; i += 8) {
    const part = cases.slice(i, i + 8);
    const res = await Promise.all(part.map((c) => caseFinancials(tenantId, c.bookingId)));
    part.forEach((c, k) => fins.set(c.id, res[k]));
  }
  const out: AccidentDashboardCase[] = [];
  const followUps: AccidentDashboardFollowUp[] = [];
  let toInvoice = 0, invoicesOpen = 0, followUpsDue = 0;
  for (const c of cases) {
    const full = c as typeof c & { insurerName: string | null; insurerClaimNumber: string | null; liabilityStatus: string; followUps: { id: string; title: string; dueAt: Date; assigneeName: string | null }[] };
    const b = c.booking;
    const steps = nextSteps({ id: c.id, status: c.status, bookingId: c.bookingId, insurerName: full.insurerName, insurerClaimNumber: full.insurerClaimNumber, liabilityStatus: full.liabilityStatus }, { status: b.status, endAt: b.endAt, actualReturnAt: b.actualReturnAt, contract: b.contract, handovers: b.handovers }, fins.get(c.id)!, full.followUps, now)
      .filter((s) => DASHBOARD_CASE_STEPS.has(s.code));
    const name = customerName(b.customer);
    if (steps.some((s) => TO_INVOICE_STEPS.has(s.code))) toInvoice++;
    if (steps.some((s) => s.code === "INVOICE_OPEN" || s.code === "PARTIALLY_PAID")) invoicesOpen++;
    for (const f of full.followUps) {
      const due = followUpDue(f.dueAt, now);
      if (due !== "LATER") followUpsDue++;
      if (f.dueAt < opts.until || due !== "LATER") followUps.push({ id: f.id, title: f.title, dueAt: f.dueAt, due, assigneeName: f.assigneeName, caseId: c.id, caseNumber: c.caseNumber, customerName: name, plate: b.vehicle.plate });
    }
    if (steps.length === 0) continue;
    const lead = DASHBOARD_STEP_STATUS.find(([code]) => steps.some((s) => s.code === code));
    const first = steps.find((s) => s.code === lead?.[0]) ?? steps[0];
    out.push({
      caseId: c.id, caseNumber: c.caseNumber, customerName: name, plate: b.vehicle.plate, returnedAt: b.actualReturnAt, steps,
      status: lead?.[1] ?? "Prüfen",
      href: first.href ?? `/unfallersatz/${c.id}${DAMAGE_TAB_STEPS.has(first.code) ? "?tab=schadenfall" : ""}`,
    });
  }
  return { ...base, toInvoice, invoicesOpen, followUpsDue, cases: out, followUps };
}
