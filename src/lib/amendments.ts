// Befehl 25: Nachträge zum Mietvertrag.
//
// Grundsätze
// - Ein unterschriebener Mietvertrag wird nie verändert. Jede spätere Vereinbarung ist ein eigener Nachtrag (ContractAmendment)
//   mit alt/neu, der erst nach Unterschrift wirksam ist (SIGNED) und danach versiegelt bleibt (snapshot, contentHash, DB-Trigger).
// - Der aktuell wirksame Vertragsstand wird NUR hier abgeleitet (effectiveContractState): Vertrag + alle unterschriebenen
//   Nachträge in der Reihenfolge sequenceNo. Rückgabe, Rechnung, Kaution, Übergabe und Oberfläche lesen diesen Stand.
// - Ein Entwurf hat keine Wirkung. Beim Wirksamwerden werden Buchungszeitraum (Disposition, Verfügbarkeit, Rückgabe) und
//   die vereinbarte Kaution (SecurityDeposit.expectedAmountCents) materialisiert – unter Sperren und mit erneuter
//   Verfügbarkeitsprüfung. Nichts wird automatisch bezahlt, erstattet, berechnet oder versendet.
// - Fahrer: Aufnahme/Herausnahme über ContractDriver.addedByAmendmentId/removedByAmendmentId (Zeilen bleiben). Ein neu
//   aufgenommener Fahrer durchläuft dieselbe Fahrerprüfung wie bei der Übergabe (Kontext = Nachtrag).
// - Preis: Vorschlag aus der Preislogik des Vertrags (Zeitraum neu − Zeitraum bisher); Abweichung nur mit Begründung.
// - Kilometer: eine Änderung gilt als neue Gesamtkondition für die gesamte Mietdauer (bewusste Regel Version 1).

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { assertVehicleBookable, vehicleStatusProblem } from "@/lib/bookings";
import { AMENDMENT_CHANGE_KINDS, type AmendmentChangeKind } from "@/lib/constants";
import { assertLinkedCustomer, driverData, type CustomerSnapshot, type DriverInput, type VehicleSnapshot } from "@/lib/contracts";
import { driverVerificationBlockers } from "@/lib/driver-verification";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { DomainError, ImmutableError, contentHash, sha256 } from "@/lib/integrity";
import { companySnapshotOf, customerSnapshotFromContract, type CompanySnapshot, type InvoiceCustomerSnapshot } from "@/lib/invoices";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation, nextAmendmentNumber, withNumberRetry } from "@/lib/numbering";
import { calculateRentalPrice, rentalDays, toNumber, type PriceBreakdown } from "@/lib/pricing";
import { buildStorageKey } from "@/lib/storage";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;
const TX = { timeout: 30_000, maxWait: 15_000 };

export type AmendmentRow = Prisma.ContractAmendmentGetPayload<object>;
export type DriverRow = Prisma.ContractDriverGetPayload<object>;

// ---------------------------------------------------------------------------
// Wirksamer Vertragsstand (zentrale Ableitung)
// ---------------------------------------------------------------------------

export type EffectiveDriver = { id: string; role: string; firstName: string; lastName: string; birthDate: Date; licenseNumber: string; licenseClass: string; licenseCountry: string; licenseValidUntil: Date | null; customerId: string | null; addedBy: string | null; removedBy: string | null };
export type EffectiveContractState = {
  contractId: string;
  contractNumber: string;
  bookingId: string;
  startAt: Date;
  endAt: Date;
  totalCents: Cents;
  kmIncludedPerDay: number;
  extraKmRate: number;
  depositCents: Cents;
  returnLocation: string | null;
  pickupLocation: string | null;
  /** Fahrer laut wirksamem Stand (Hauptfahrer zuerst) */
  drivers: EffectiveDriver[];
  /** sonstige Vereinbarungen aus Nachträgen (Nummer, Text) */
  agreements: { number: string; text: string }[];
  /** welcher Nachtrag den jeweiligen Wert zuletzt geändert hat (null = Originalvertrag) */
  changedBy: { endAt: string | null; total: string | null; km: string | null; deposit: string | null; returnLocation: string | null };
  amendments: AmendmentRow[];
  /** Stand des Originalvertrags (nie verändert) */
  original: { endAt: Date; totalCents: Cents; kmIncludedPerDay: number; extraKmRate: number; depositCents: Cents; returnLocation: string | null };
};

export async function effectiveContractState(tenantId: string, contractId: string, client: Client = db): Promise<EffectiveContractState> {
  const c = await client.rentalContract.findFirst({ where: { id: contractId, tenantId }, include: { drivers: { orderBy: [{ role: "desc" }, { createdAt: "asc" }] }, amendments: { where: { status: "SIGNED" }, orderBy: { sequenceNo: "asc" } } } });
  if (!c) throw new DomainError("Vertrag nicht gefunden.");
  return applyAmendments(c, c.drivers, c.amendments);
}

/** Reine Ableitung (testbar ohne Datenbank): Vertrag + unterschriebene Nachträge in sequenceNo-Reihenfolge. */
export function applyAmendments(c: Prisma.RentalContractGetPayload<object>, drivers: DriverRow[], signed: AmendmentRow[]): EffectiveContractState {
  const ordered = [...signed].filter((a) => a.status === "SIGNED").sort((a, b) => (a.sequenceNo ?? 0) - (b.sequenceNo ?? 0));
  const original = { endAt: c.endAt, totalCents: toCents(c.totalAmount), kmIncludedPerDay: c.kmIncludedPerDay, extraKmRate: toNumber(c.extraKmRate) ?? 0, depositCents: toCents(c.deposit), returnLocation: c.returnLocation };
  const state = { ...original, pickupLocation: c.pickupLocation };
  const changedBy = { endAt: null as string | null, total: null as string | null, km: null as string | null, deposit: null as string | null, returnLocation: null as string | null };
  const agreements: { number: string; text: string }[] = [];
  for (const a of ordered) {
    if (a.newEndAt) { state.endAt = a.newEndAt; changedBy.endAt = a.number; }
    if (a.priceDeltaCents) { state.totalCents += a.priceDeltaCents; changedBy.total = a.number; }
    if (a.newKmIncludedPerDay != null) { state.kmIncludedPerDay = a.newKmIncludedPerDay; changedBy.km = a.number; }
    if (a.newExtraKmRate != null) { state.extraKmRate = toNumber(a.newExtraKmRate) ?? state.extraKmRate; changedBy.km = a.number; }
    if (a.newDepositCents != null) { state.depositCents = a.newDepositCents; changedBy.deposit = a.number; }
    if (a.newReturnLocation != null) { state.returnLocation = a.newReturnLocation; changedBy.returnLocation = a.number; }
    if (a.agreementText) agreements.push({ number: a.number ?? "", text: a.agreementText });
  }
  const signedIds = new Set(ordered.map((a) => a.id));
  const effectiveDrivers = drivers
    .filter((d) => (!d.addedByAmendmentId || signedIds.has(d.addedByAmendmentId)) && !(d.removedByAmendmentId && signedIds.has(d.removedByAmendmentId)))
    .map((d) => ({ id: d.id, role: d.role, firstName: d.firstName, lastName: d.lastName, birthDate: d.birthDate, licenseNumber: d.licenseNumber, licenseClass: d.licenseClass, licenseCountry: d.licenseCountry, licenseValidUntil: d.licenseValidUntil, customerId: d.customerId, addedBy: d.addedByAmendmentId, removedBy: d.removedByAmendmentId }));
  return { contractId: c.id, contractNumber: c.number, bookingId: c.bookingId, startAt: c.startAt, ...state, drivers: effectiveDrivers, agreements, changedBy, amendments: ordered, original };
}

/**
 * Vertragszeile mit den wirksamen Werten überlagert (gleiche Form wie RentalContract, plus `amended`). Für Rückgabe,
 * Rechnung, Kaution, Übergabe und Anzeige, damit vorhandene Logik unverändert „den Vertrag“ liest. Die Zeile in der
 * Datenbank bleibt unverändert; der Originalstand steht in `amended.original`.
 */
export type EffectiveContractRow = Prisma.RentalContractGetPayload<object> & { amended: { numbers: string[]; changedBy: EffectiveContractState["changedBy"]; original: EffectiveContractState["original"]; totalCents: Cents } };

export function overlayAmendments(contract: Prisma.RentalContractGetPayload<object>, signed: AmendmentRow[]): EffectiveContractRow {
  const st = applyAmendments(contract, [], signed);
  const dec = (cents: Cents) => new Prisma.Decimal((cents / 100).toFixed(2));
  return { ...contract, endAt: st.endAt, totalAmount: dec(st.totalCents), kmIncludedPerDay: st.kmIncludedPerDay, extraKmRate: new Prisma.Decimal(st.extraKmRate), deposit: dec(st.depositCents), returnLocation: st.returnLocation, amended: { numbers: st.amendments.map((a) => a.number ?? ""), changedBy: st.changedBy, original: st.original, totalCents: st.totalCents } };
}

/** Lädt die unterschriebenen Nachträge zum Vertrag und überlagert sie (bei nicht unterschriebenem Vertrag unverändert). */
export async function loadEffectiveContract<T extends Prisma.RentalContractGetPayload<object>>(client: Client, tenantId: string, contract: T): Promise<T & EffectiveContractRow> {
  const signed = contract.status === "SIGNED" ? await client.contractAmendment.findMany({ where: { tenantId, contractId: contract.id, status: "SIGNED" }, orderBy: { sequenceNo: "asc" } }) : [];
  return { ...contract, ...overlayAmendments(contract, signed) } as T & EffectiveContractRow;
}

/** Kleine, reine Ableitungen für Stellen, die nur einen Wert brauchen (Kaution, Gesamtpreis) – dieselbe Regel wie applyAmendments. */
export const SIGNED_AMENDMENTS_SELECT = { where: { status: "SIGNED" }, orderBy: { sequenceNo: "asc" }, select: { id: true, number: true, sequenceNo: true, priceDeltaCents: true, newDepositCents: true, newEndAt: true } } as const;
type MiniAmendment = { sequenceNo: number | null; priceDeltaCents?: number | null; newDepositCents?: number | null };
const bySeq = <T extends MiniAmendment>(xs: T[]) => [...xs].sort((a, b) => (a.sequenceNo ?? 0) - (b.sequenceNo ?? 0));
export function effectiveDepositCents(contractDeposit: Prisma.Decimal | number | string, signed: MiniAmendment[]): Cents {
  return bySeq(signed).reduce<Cents>((acc, a) => (a.newDepositCents != null ? a.newDepositCents : acc), toCents(contractDeposit));
}
export function effectiveTotalCents(contractTotal: Prisma.Decimal | number | string, signed: MiniAmendment[]): Cents {
  return bySeq(signed).reduce<Cents>((acc, a) => acc + (a.priceDeltaCents ?? 0), toCents(contractTotal));
}
/** Vereinbarte Kaution laut wirksamem Stand für einen Vertrag (Abfrage nur der Kautionsänderungen). */
export async function loadEffectiveDepositCents(client: Client, tenantId: string, contract: { id: string; deposit: Prisma.Decimal | number | string }): Promise<Cents> {
  const signed = await client.contractAmendment.findMany({ where: { tenantId, contractId: contract.id, status: "SIGNED", newDepositCents: { not: null } }, select: { sequenceNo: true, newDepositCents: true } });
  return effectiveDepositCents(contract.deposit, signed);
}

/** Wirksamer Stand zur Buchung (null, wenn es keinen unterschriebenen Vertrag gibt). */
export async function effectiveStateForBooking(tenantId: string, bookingId: string, client: Client = db): Promise<EffectiveContractState | null> {
  const c = await client.rentalContract.findFirst({ where: { tenantId, bookingId, status: "SIGNED" }, select: { id: true } });
  return c ? effectiveContractState(tenantId, c.id, client) : null;
}

// ---------------------------------------------------------------------------
// Entwurf anlegen, ändern, verwerfen
// ---------------------------------------------------------------------------

async function loadAmendment(tx: Client, tenantId: string, amendmentId: string) {
  const a = await tx.contractAmendment.findFirst({ where: { id: amendmentId, tenantId }, include: { contract: { include: { drivers: { orderBy: [{ role: "desc" }, { createdAt: "asc" }] }, amendments: { where: { status: "SIGNED" }, orderBy: { sequenceNo: "asc" } } } }, booking: { select: { id: true, number: true, status: true, vehicleId: true, startAt: true, endAt: true } }, signatures: { orderBy: { signedAt: "asc" } } } });
  if (!a) throw new DomainError("Nachtrag nicht gefunden.");
  return a;
}
type LoadedAmendment = Awaited<ReturnType<typeof loadAmendment>>;
function assertDraft(a: { status: string }) {
  if (a.status === "SIGNED") throw new ImmutableError("Der Nachtrag ist unterschrieben und wirksam. Änderungen nur durch einen neuen Nachtrag.");
  if (a.status === "DISCARDED") throw new ImmutableError("Der Nachtrag wurde verworfen.");
}

/** Kann zu dieser Buchung ein Nachtrag erstellt werden? (unterschriebener Vertrag, Miete noch nicht beendet) */
export function amendmentAllowed(booking: { status: string }, contract: { status: string } | null): { ok: boolean; reason: string | null } {
  if (!contract || contract.status !== "SIGNED") return { ok: false, reason: "Nachträge gibt es nur zu einem unterschriebenen Mietvertrag." };
  if (booking.status === "RETURNED") return { ok: false, reason: "Die Miete ist beendet. Nach der Rückgabe gibt es keine Nachträge mehr." };
  if (booking.status === "CANCELLED") return { ok: false, reason: "Die Buchung ist storniert." };
  return { ok: true, reason: null };
}

export async function createAmendmentDraft(tenantId: string, actor: Actor, input: { bookingId: string; nonce: string }): Promise<{ amendment: AmendmentRow; created: boolean }> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.nonce ?? "")) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const key = `amendment:${input.nonce}`;
  const existing = await db.contractAmendment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
  if (existing) return { amendment: existing, created: false };
  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string; number: string }[]>`SELECT "id", "status", "number" FROM "Booking" WHERE "id" = ${input.bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
      const dup = await tx.contractAmendment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (dup) return { amendment: dup, created: false };
      const contract = await tx.rentalContract.findFirst({ where: { tenantId, bookingId: input.bookingId }, select: { id: true, status: true, number: true } });
      const allowed = amendmentAllowed(locked[0], contract);
      if (!allowed.ok || !contract) throw new DomainError(allowed.reason ?? "Kein Nachtrag möglich.");
      const open = await tx.contractAmendment.findFirst({ where: { tenantId, contractId: contract.id, status: "DRAFT" }, select: { id: true } });
      if (open) return { amendment: await tx.contractAmendment.findUniqueOrThrow({ where: { id: open.id } }), created: false };
      const amendment = await tx.contractAmendment.create({ data: { tenantId, contractId: contract.id, bookingId: input.bookingId, idempotencyKey: key, createdById: actor.id, createdByName: actor.name } });
      await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_CREATED", bookingId: input.bookingId, details: { amendmentId: amendment.id, contractNumber: contract.number, bookingNumber: locked[0].number } });
      return { amendment, created: true };
    }, TX);
  } catch (e) {
    if (isUniqueViolation(e, "idempotencyKey")) {
      const winner = await db.contractAmendment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (winner) return { amendment: winner, created: false };
    }
    throw e;
  }
}

export type AmendmentChangesInput = {
  /** undefined = unverändert lassen, null = Änderung entfernen */
  newEndAt?: Date | null;
  priceDeltaCents?: Cents | null;
  priceReason?: string | null;
  newKmIncludedPerDay?: number | null;
  newExtraKmRate?: number | null;
  newDepositCents?: Cents | null;
  newReturnLocation?: string | null;
  agreementText?: string | null;
};

const cleanText = (v: string | null | undefined, max: number) => {
  const t = (v ?? "").replace(/<[^>]*>/g, "").replace(/\r\n/g, "\n").trim();
  if (t.length > max) throw new DomainError(`Der Text ist zu lang (höchstens ${max} Zeichen).`);
  return t || null;
};

/** Preisvorschlag für einen neuen Zeitraum aus der eingefrorenen Preislogik des Vertrags (Zeitraum neu − Zeitraum bisher). */
export function extensionPriceProposal(contract: Prisma.RentalContractGetPayload<object>, currentEndAt: Date, newEndAt: Date): Cents | null {
  const snap = contract.priceSnapshot as Partial<PriceBreakdown> | null;
  const rates = snap?.rates;
  if (!rates || typeof rates.dailyRate !== "number") return null;
  const price = (end: Date) => calculateRentalPrice({ start: contract.startAt, end, rates: { dailyRate: rates.dailyRate ?? 0, workWeekRate: rates.workWeekRate ?? null, weeklyRate: rates.weeklyRate ?? null, monthlyRate: rates.monthlyRate ?? null }, discountPercent: contract.discountPercent, strategy: snap?.strategy }).total;
  return Math.round((price(newEndAt) - price(currentEndAt)) * 100);
}

/** Entwurf ändern. Jede Änderung macht vorhandene Unterschriften ungültig (sie werden entfernt). */
export async function updateAmendmentDraft(tenantId: string, actor: Actor, amendmentId: string, input: AmendmentChangesInput): Promise<AmendmentRow> {
  return db.$transaction(async (tx) => {
    const a = await loadAmendment(tx, tenantId, amendmentId);
    assertDraft(a);
    const eff = applyAmendments(a.contract, a.contract.drivers, a.contract.amendments);
    const data: Prisma.ContractAmendmentUpdateInput = {};
    if (input.newEndAt !== undefined) {
      if (input.newEndAt) {
        if (!(input.newEndAt > a.contract.startAt)) throw new DomainError("Die neue Rückgabe muss nach dem Mietbeginn liegen.");
        if (input.newEndAt.getTime() === eff.endAt.getTime()) throw new DomainError("Die neue Rückgabe entspricht der bisher vereinbarten.");
        data.newEndAt = input.newEndAt;
        data.priceProposalCents = extensionPriceProposal(a.contract, eff.endAt, input.newEndAt);
      } else { data.newEndAt = null; data.priceProposalCents = null; }
    }
    if (input.priceDeltaCents !== undefined) {
      if (input.priceDeltaCents != null) {
        if (!Number.isInteger(input.priceDeltaCents) || input.priceDeltaCents === 0) throw new DomainError("Die Preisänderung muss ein Betrag ungleich 0,00 € sein (mit Vorzeichen).");
        if (eff.totalCents + input.priceDeltaCents < 0) throw new DomainError(`Der Vertragsgesamtpreis würde negativ (bisher ${fmtCents(eff.totalCents)}).`);
        data.priceDeltaCents = input.priceDeltaCents;
      } else data.priceDeltaCents = null;
    }
    if (input.priceReason !== undefined) data.priceReason = cleanText(input.priceReason, 300);
    if (input.newKmIncludedPerDay !== undefined) {
      if (input.newKmIncludedPerDay != null && (!Number.isInteger(input.newKmIncludedPerDay) || input.newKmIncludedPerDay < 0 || input.newKmIncludedPerDay > 100_000)) throw new DomainError("Freikilometer je Tag: bitte eine ganze Zahl ab 0 angeben.");
      data.newKmIncludedPerDay = input.newKmIncludedPerDay;
    }
    if (input.newExtraKmRate !== undefined) {
      if (input.newExtraKmRate != null && (!Number.isFinite(input.newExtraKmRate) || input.newExtraKmRate < 0 || input.newExtraKmRate > 100)) throw new DomainError("Mehrkilometerpreis: bitte einen Betrag ab 0,00 € je km angeben.");
      data.newExtraKmRate = input.newExtraKmRate;
    }
    if (input.newDepositCents !== undefined) {
      if (input.newDepositCents != null && (!Number.isInteger(input.newDepositCents) || input.newDepositCents < 0)) throw new DomainError("Die vereinbarte Kaution darf nicht negativ sein.");
      if (input.newDepositCents != null && input.newDepositCents === eff.depositCents) throw new DomainError("Die vereinbarte Kaution entspricht der bisherigen.");
      data.newDepositCents = input.newDepositCents;
    }
    if (input.newReturnLocation !== undefined) data.newReturnLocation = input.newReturnLocation === null ? null : cleanText(input.newReturnLocation, 200);
    if (input.agreementText !== undefined) data.agreementText = input.agreementText === null ? null : cleanText(input.agreementText, 2000);
    const row = await tx.contractAmendment.update({ where: { id: a.id }, data });
    await tx.signature.deleteMany({ where: { tenantId, amendmentId: a.id } });
    return row;
  }, TX);
}

/** Zusatzfahrer in den Nachtrag aufnehmen (wird erst mit der Unterschrift wirksam; vorher Fahrerprüfung im Nachtrag). */
export async function addAmendmentDriver(tenantId: string, actor: Actor, amendmentId: string, input: DriverInput): Promise<DriverRow> {
  return db.$transaction(async (tx) => {
    const a = await loadAmendment(tx, tenantId, amendmentId);
    assertDraft(a);
    await assertLinkedCustomer(tx, tenantId, input.customerId);
    const eff = applyAmendments(a.contract, a.contract.drivers, a.contract.amendments);
    const d = driverData(input);
    const present = [...eff.drivers, ...a.contract.drivers.filter((x) => x.addedByAmendmentId === a.id)];
    if (present.some((x) => x.firstName.toLowerCase() === d.firstName.toLowerCase() && x.lastName.toLowerCase() === d.lastName.toLowerCase() && x.birthDate.getTime() === d.birthDate.getTime())) throw new DomainError("Diese Person ist bereits als Fahrer im Vertrag.");
    const row = await tx.contractDriver.create({ data: { tenantId, contractId: a.contractId, role: "ADDITIONAL_DRIVER", addedByAmendmentId: a.id, ...d } });
    await tx.signature.deleteMany({ where: { tenantId, amendmentId: a.id } });
    void actor;
    return row;
  }, TX);
}

/** Einen im Entwurf aufgenommenen Fahrer wieder entfernen (nur solange nicht unterschrieben). */
export async function dropAmendmentDriver(tenantId: string, amendmentId: string, driverId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const a = await loadAmendment(tx, tenantId, amendmentId);
    assertDraft(a);
    const hasVerification = await tx.driverVerification.count({ where: { tenantId, amendmentId: a.id, contractDriverId: driverId } });
    if (hasVerification > 0) throw new DomainError("Für diesen Fahrer wurde im Nachtrag bereits eine Prüfung begonnen; der Vermerk bleibt. Bitte den Nachtrag verwerfen, wenn der Fahrer nicht aufgenommen werden soll.");
    await tx.contractDriver.deleteMany({ where: { id: driverId, tenantId, addedByAmendmentId: a.id } });
    await tx.signature.deleteMany({ where: { tenantId, amendmentId: a.id } });
  }, TX);
}

/** Bestehenden Zusatzfahrer durch diesen Nachtrag herausnehmen (historische Zeile bleibt) bzw. die Herausnahme zurücknehmen. */
export async function setAmendmentDriverRemoval(tenantId: string, amendmentId: string, driverId: string, removed: boolean): Promise<void> {
  await db.$transaction(async (tx) => {
    const a = await loadAmendment(tx, tenantId, amendmentId);
    assertDraft(a);
    const eff = applyAmendments(a.contract, a.contract.drivers, a.contract.amendments);
    const d = eff.drivers.find((x) => x.id === driverId);
    if (removed) {
      if (!d) throw new DomainError("Dieser Fahrer ist nicht im wirksamen Vertragsstand.");
      if (d.role === "PRIMARY_DRIVER") throw new DomainError("Der Hauptfahrer kann nicht herausgenommen werden.");
      if (d.addedBy === a.id) throw new DomainError("Ein in diesem Nachtrag aufgenommener Fahrer wird stattdessen entfernt.");
      await tx.contractDriver.update({ where: { id: driverId }, data: { removedByAmendmentId: a.id } });
    } else {
      await tx.contractDriver.updateMany({ where: { id: driverId, tenantId, removedByAmendmentId: a.id }, data: { removedByAmendmentId: null } });
    }
    await tx.signature.deleteMany({ where: { tenantId, amendmentId: a.id } });
  }, TX);
}

export async function discardAmendment(tenantId: string, actor: Actor, amendmentId: string): Promise<AmendmentRow> {
  return db.$transaction(async (tx) => {
    const a = await loadAmendment(tx, tenantId, amendmentId);
    assertDraft(a);
    await tx.signature.deleteMany({ where: { tenantId, amendmentId: a.id } });
    await tx.contractDriver.updateMany({ where: { tenantId, removedByAmendmentId: a.id }, data: { removedByAmendmentId: null } });
    // ohne Prüfvermerk aufgenommene Fahrer verschwinden; mit Prüfvermerk bleiben sie als unwirksame Zeile (Vermerke werden nie gelöscht)
    const verified = await tx.driverVerification.findMany({ where: { tenantId, amendmentId: a.id }, select: { contractDriverId: true } });
    await tx.contractDriver.deleteMany({ where: { tenantId, addedByAmendmentId: a.id, id: { notIn: verified.map((v) => v.contractDriverId) } } });
    const row = await tx.contractAmendment.update({ where: { id: a.id }, data: { status: "DISCARDED", discardedAt: new Date() } });
    await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_DISCARDED", bookingId: a.bookingId, details: { amendmentId: a.id, contractNumber: a.contract.number } });
    return row;
  }, TX);
}

// ---------------------------------------------------------------------------
// Inhalt, Prüfung, Unterschrift
// ---------------------------------------------------------------------------

export type AmendmentChange = { kind: AmendmentChangeKind; label: string; before: string; after: string; note?: string | null };

/** Alt/neu-Darstellung der Änderungen eines Nachtrags gegenüber dem bis dahin wirksamen Stand. */
export function describeChanges(a: AmendmentRow, eff: EffectiveContractState, drivers: DriverRow[]): AmendmentChange[] {
  const out: AmendmentChange[] = [];
  const eur = (c: number) => fmtCents(c);
  if (a.newEndAt) {
    const diff = rentalDays(eff.startAt, a.newEndAt) - rentalDays(eff.startAt, eff.endAt);
    out.push({ kind: "PERIOD", label: AMENDMENT_CHANGE_KINDS.PERIOD, before: fmtDateTime(eff.endAt), after: fmtDateTime(a.newEndAt), note: diff === 0 ? "Mietdauer in Tagen unverändert" : diff > 0 ? `zusätzliche Mietdauer: ${diff} ${diff === 1 ? "Tag" : "Tage"}` : `verkürzte Mietdauer: ${-diff} ${-diff === 1 ? "Tag" : "Tage"}` });
  }
  if (a.priceDeltaCents) {
    out.push({ kind: "PRICE", label: AMENDMENT_CHANGE_KINDS.PRICE, before: eur(eff.totalCents), after: eur(eff.totalCents + a.priceDeltaCents), note: `Änderung ${a.priceDeltaCents > 0 ? "+" : "−"}${eur(Math.abs(a.priceDeltaCents))}${a.priceReason ? ` · ${a.priceReason}` : ""}` });
  }
  if (a.newKmIncludedPerDay != null || a.newExtraKmRate != null) {
    const rate = (v: number) => `${v.toLocaleString("de-DE", { minimumFractionDigits: 2 })} €/km`;
    out.push({ kind: "KM", label: AMENDMENT_CHANGE_KINDS.KM, before: `${eff.kmIncludedPerDay} km/Tag · ${rate(eff.extraKmRate)}`, after: `${a.newKmIncludedPerDay ?? eff.kmIncludedPerDay} km/Tag · ${rate(a.newExtraKmRate != null ? toNumber(a.newExtraKmRate) ?? eff.extraKmRate : eff.extraKmRate)}`, note: "gilt für die gesamte Mietdauer" });
  }
  for (const d of drivers.filter((d) => d.addedByAmendmentId === a.id)) out.push({ kind: "DRIVER_ADDED", label: AMENDMENT_CHANGE_KINDS.DRIVER_ADDED, before: "–", after: `${d.firstName} ${d.lastName} (${fmtDate(d.birthDate)}, Klasse ${d.licenseClass})` });
  for (const d of drivers.filter((d) => d.removedByAmendmentId === a.id)) out.push({ kind: "DRIVER_REMOVED", label: AMENDMENT_CHANGE_KINDS.DRIVER_REMOVED, before: `${d.firstName} ${d.lastName}`, after: "nicht mehr als Zusatzfahrer vereinbart" });
  if (a.newDepositCents != null) out.push({ kind: "DEPOSIT", label: AMENDMENT_CHANGE_KINDS.DEPOSIT, before: eur(eff.depositCents), after: eur(a.newDepositCents), note: a.newDepositCents > eff.depositCents ? "zusätzlicher Eingang wird gesondert als Kautionsbewegung dokumentiert" : "keine automatische Auszahlung; Freigabe und Rückzahlung wie bisher" });
  if (a.newReturnLocation != null) out.push({ kind: "RETURN_LOCATION", label: AMENDMENT_CHANGE_KINDS.RETURN_LOCATION, before: eff.returnLocation ?? eff.pickupLocation ?? "–", after: a.newReturnLocation });
  if (a.agreementText) out.push({ kind: "AGREEMENT", label: AMENDMENT_CHANGE_KINDS.AGREEMENT, before: "–", after: a.agreementText });
  return out;
}

/** Alles, was der Mieter unterschreibt. Hash über den Vertragsstand vorher und die Änderungen. */
function signedContent(a: LoadedAmendment, eff: EffectiveContractState) {
  const added = a.contract.drivers.filter((d) => d.addedByAmendmentId === a.id).map((d) => ({ firstName: d.firstName, lastName: d.lastName, birthDate: d.birthDate, licenseNumber: d.licenseNumber, licenseClass: d.licenseClass, licenseValidUntil: d.licenseValidUntil, licenseCountry: d.licenseCountry }));
  const removed = a.contract.drivers.filter((d) => d.removedByAmendmentId === a.id).map((d) => ({ id: d.id, firstName: d.firstName, lastName: d.lastName, birthDate: d.birthDate }));
  return {
    contractId: a.contractId, contractNumber: a.contract.number, contractHash: a.contract.contentHash, bookingId: a.bookingId,
    base: { endAt: eff.endAt, totalCents: eff.totalCents, kmIncludedPerDay: eff.kmIncludedPerDay, extraKmRate: eff.extraKmRate, depositCents: eff.depositCents, returnLocation: eff.returnLocation, priorAmendments: eff.amendments.map((x) => x.number) },
    changes: { newEndAt: a.newEndAt, priceDeltaCents: a.priceDeltaCents, priceReason: a.priceReason, newKmIncludedPerDay: a.newKmIncludedPerDay, newExtraKmRate: toNumber(a.newExtraKmRate), newDepositCents: a.newDepositCents, newReturnLocation: a.newReturnLocation, agreementText: a.agreementText, added, removed },
  };
}

export async function getAmendmentContentHash(tenantId: string, amendmentId: string): Promise<string> {
  const a = await loadAmendment(db, tenantId, amendmentId);
  return contentHash(signedContent(a, applyAmendments(a.contract, a.contract.drivers, a.contract.amendments)));
}

export type AmendmentIssue = { code: string; severity: "error" | "warning"; message: string };

async function collectIssues(client: Client, tenantId: string, a: LoadedAmendment, opts: { requireSignature: boolean; now?: Date }): Promise<AmendmentIssue[]> {
  const issues: AmendmentIssue[] = [];
  const err = (code: string, message: string) => issues.push({ code, severity: "error", message });
  const eff = applyAmendments(a.contract, a.contract.drivers, a.contract.amendments);
  const added = a.contract.drivers.filter((d) => d.addedByAmendmentId === a.id);
  const removed = a.contract.drivers.filter((d) => d.removedByAmendmentId === a.id);
  const hasChange = !!a.newEndAt || !!a.priceDeltaCents || a.newKmIncludedPerDay != null || a.newExtraKmRate != null || a.newDepositCents != null || a.newReturnLocation != null || !!a.agreementText || added.length > 0 || removed.length > 0;
  if (!hasChange) err("NO_CHANGES", "Der Nachtrag enthält noch keine Änderung.");
  if (a.booking.status === "RETURNED" || a.booking.status === "CANCELLED") err("BOOKING_STATUS", "Die Miete ist beendet oder storniert; der Nachtrag kann nicht mehr wirksam werden.");
  if (a.newEndAt) {
    const vehicle = await client.vehicle.findFirst({ where: { id: a.booking.vehicleId, tenantId }, select: { status: true, plate: true } });
    const problem = vehicle ? vehicleStatusProblem(vehicle.status) : null;
    if (problem) err("VEHICLE_STATUS", problem);
    const conflicts = await client.booking.findMany({ where: { tenantId, vehicleId: a.booking.vehicleId, status: { in: ["RESERVED", "ACTIVE"] }, id: { not: a.bookingId }, startAt: { lt: a.newEndAt }, endAt: { gt: a.contract.startAt } }, select: { number: true, startAt: true }, orderBy: { startAt: "asc" } });
    for (const c of conflicts) err("CONFLICT", `Verlängerung nicht möglich. Das Fahrzeug ist ab ${fmtDateTime(c.startAt)} bereits für Buchung ${c.number} eingeplant.`);
  }
  if (a.newEndAt || a.newKmIncludedPerDay != null || a.newExtraKmRate != null) {
    // Mietdauer/Kilometer fließen in den Rückgabevergleich: eine bereits begonnene Rückgabe wird nicht unter der Hand verändert
    const openReturn = await client.handover.findFirst({ where: { tenantId, bookingId: a.bookingId, type: "RETURN", status: "DRAFT" }, select: { number: true } });
    if (openReturn) err("RETURN_STARTED", `Die Rückgabe (${openReturn.number}) ist bereits begonnen. Mietdauer und Kilometervereinbarung können jetzt nicht mehr durch Nachtrag geändert werden.`);
  }
  if (a.priceDeltaCents && a.priceDeltaCents !== (a.priceProposalCents ?? null) && !(a.priceReason && a.priceReason.trim().length >= 3)) err("PRICE_REASON", "Bitte die Preisänderung begründen (abweichend vom Vorschlag der Preislogik bzw. manuelle Preisänderung).");
  if (a.priceDeltaCents && eff.totalCents + a.priceDeltaCents < 0) err("PRICE_NEGATIVE", "Der Vertragsgesamtpreis würde negativ.");
  if (added.length > 0) for (const b of await driverVerificationBlockers(tenantId, { amendmentId: a.id }, client)) err(b.code, b.message);
  if (removed.some((d) => d.role === "PRIMARY_DRIVER")) err("PRIMARY_DRIVER", "Der Hauptfahrer kann nicht herausgenommen werden.");
  if (opts.requireSignature) {
    const hash = contentHash(signedContent(a, eff));
    const renter = a.signatures.find((s) => s.role === "RENTER");
    if (!renter) err("SIGNATURE", "Die Unterschrift des Mieters fehlt.");
    else if (renter.contentHash !== hash) err("SIGNATURE_STALE", "Der Nachtrag wurde nach der Unterschrift geändert. Bitte erneut unterschreiben.");
  }
  return issues;
}

export type AmendmentState = { amendment: LoadedAmendment; effective: EffectiveContractState; changes: AmendmentChange[]; issues: AmendmentIssue[]; hash: string; addedDrivers: DriverRow[]; removedDrivers: DriverRow[] };

export async function getAmendmentState(tenantId: string, amendmentId: string): Promise<AmendmentState> {
  const a = await loadAmendment(db, tenantId, amendmentId);
  const eff = applyAmendments(a.contract, a.contract.drivers, a.contract.amendments.filter((x) => x.status === "SIGNED" && (a.status !== "SIGNED" || (x.sequenceNo ?? 0) < (a.sequenceNo ?? 0))));
  const changes = describeChanges(a, eff, a.contract.drivers);
  const issues = a.status === "DRAFT" ? await collectIssues(db, tenantId, a, { requireSignature: false }) : [];
  return { amendment: a, effective: eff, changes, issues, hash: a.contentHash ?? contentHash(signedContent(a, eff)), addedDrivers: a.contract.drivers.filter((d) => d.addedByAmendmentId === a.id), removedDrivers: a.contract.drivers.filter((d) => d.removedByAmendmentId === a.id) };
}

const PNG_PREFIX = "data:image/png;base64,";
export type AmendmentSignatureInput = { role: "RENTER" | "EMPLOYEE"; signerName: string; imageDataUrl: string; seenHash: string; ipAddress?: string | null; userAgent?: string | null };

/** Unterschrift zu genau dem Inhalt, den der Unterzeichner gesehen hat (wie beim Mietvertrag). */
export async function saveAmendmentSignature(tenantId: string, actor: Actor | null, amendmentId: string, input: AmendmentSignatureInput) {
  if (!input.signerName.trim()) throw new DomainError("Bitte den Namen des Unterzeichners angeben.");
  if (!input.imageDataUrl.startsWith(PNG_PREFIX)) throw new DomainError("Die Unterschrift konnte nicht gelesen werden. Bitte erneut unterschreiben.");
  const image = Buffer.from(input.imageDataUrl.slice(PNG_PREFIX.length), "base64");
  const isPng = image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
  if (!isPng || image.length > 400_000) throw new DomainError("Die Unterschrift ist ungültig oder zu groß. Bitte erneut unterschreiben.");
  if (image.length < 800) throw new DomainError("Die Unterschrift ist leer. Bitte im Feld unterschreiben.");
  return db.$transaction(async (tx) => {
    const a = await loadAmendment(tx, tenantId, amendmentId);
    assertDraft(a);
    const hash = contentHash(signedContent(a, applyAmendments(a.contract, a.contract.drivers, a.contract.amendments)));
    if (hash !== input.seenHash) throw new DomainError("Der Nachtrag wurde seit der Anzeige geändert. Bitte die Zusammenfassung erneut prüfen und dann unterschreiben.");
    await tx.signature.deleteMany({ where: { tenantId, amendmentId: a.id, role: input.role } });
    return tx.signature.create({ data: { tenantId, amendmentId: a.id, role: input.role, signerName: input.signerName.trim(), storageKey: buildStorageKey({ tenantId, area: "signatures", bookingId: a.bookingId, contentType: "image/png" }), imageData: image, imageChecksum: sha256(image), contentHash: hash, ipAddress: input.ipAddress ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null, createdById: actor?.id ?? null }, select: { id: true, role: true, signerName: true, signedAt: true, contentHash: true } });
  }, TX);
}

export async function removeAmendmentSignature(tenantId: string, amendmentId: string, role: "RENTER" | "EMPLOYEE") {
  await db.$transaction(async (tx) => {
    const a = await loadAmendment(tx, tenantId, amendmentId);
    assertDraft(a);
    await tx.signature.deleteMany({ where: { tenantId, amendmentId: a.id, role } });
  }, TX);
}

function vehicleRef(snapshot: unknown) {
  const v = (snapshot ?? {}) as Partial<VehicleSnapshot>;
  return { make: v.make ?? null, model: v.model ?? null, plate: v.plate ?? null };
}

export type AmendmentSnapshot = {
  v: 1; number: string; sequenceNo: number; signedAt: string;
  company: CompanySnapshot; customer: InvoiceCustomerSnapshot; vehicle: { make: string | null; model: string | null; plate: string | null };
  contract: { id: string; number: string; contentHash: string | null; startAt: string; signedAt: string | null };
  bookingNumber: string;
  priorAmendments: { number: string; signedAt: string | null }[];
  before: { endAt: string; totalCents: Cents; kmIncludedPerDay: number; extraKmRate: number; depositCents: Cents; returnLocation: string | null; drivers: { role: string; name: string }[] };
  after: { endAt: string; totalCents: Cents; kmIncludedPerDay: number; extraKmRate: number; depositCents: Cents; returnLocation: string | null; drivers: { role: string; name: string }[] };
  changes: AmendmentChange[];
  priceProposalCents: Cents | null;
  signatures: { role: string; signerName: string; signedAt: string }[];
  createdByName: string | null; signedByName: string;
};

/**
 * Wirksamwerden: unter Sperren (Buchung → Vertrag → Fahrzeug) erneut prüfen, Nummer vergeben, Snapshot versiegeln, Buchung
 * und Kaution materialisieren, Audit je Änderung. Idempotent: ein bereits unterschriebener Nachtrag wird unverändert zurückgegeben.
 */
export async function signAmendment(tenantId: string, actor: Actor, amendmentId: string, opts: { now?: Date } = {}): Promise<{ amendment: AmendmentRow; created: boolean }> {
  const pre = await db.contractAmendment.findFirst({ where: { id: amendmentId, tenantId }, select: { status: true } });
  if (!pre) throw new DomainError("Nachtrag nicht gefunden.");
  if (pre.status === "SIGNED") return { amendment: (await db.contractAmendment.findUniqueOrThrow({ where: { id: amendmentId } })), created: false };
  return withNumberRetry(() => db.$transaction(async (tx) => {
    const now = opts.now ?? new Date();
    const lockedBooking = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = (SELECT "bookingId" FROM "ContractAmendment" WHERE "id" = ${amendmentId} AND "tenantId" = ${tenantId}) FOR UPDATE`;
    if (lockedBooking.length === 0) throw new DomainError("Nachtrag nicht gefunden.");
    await tx.$queryRaw`SELECT "id" FROM "RentalContract" WHERE "id" = (SELECT "contractId" FROM "ContractAmendment" WHERE "id" = ${amendmentId}) FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ContractAmendment" WHERE "id" = ${amendmentId} FOR UPDATE`;
    const a = await loadAmendment(tx, tenantId, amendmentId);
    if (a.status === "SIGNED") return { amendment: a, created: false };
    assertDraft(a);
    const eff = applyAmendments(a.contract, a.contract.drivers, a.contract.amendments);
    // Verlängerung: Verfügbarkeit erneut unter der Fahrzeugsperre prüfen (zwischen Vorschau und Unterschrift kann eine Buchung entstanden sein)
    if (a.newEndAt) {
      const { conflicts } = await assertVehicleBookable(tx, tenantId, a.booking.vehicleId, a.contract.startAt, a.newEndAt, a.bookingId);
      if (conflicts.length > 0) throw new DomainError(`Verlängerung nicht möglich. Das Fahrzeug ist ab ${fmtDateTime(conflicts[0].startAt)} bereits für Buchung ${conflicts[0].number} eingeplant.`);
    }
    const problems = (await collectIssues(tx, tenantId, a, { requireSignature: true, now })).filter((i) => i.severity === "error");
    if (problems.length > 0) throw new DomainError(problems.length === 1 ? problems[0].message : `${problems[0].message} (und ${problems.length - 1} weitere Punkte)`);

    const hash = contentHash(signedContent(a, eff));
    const number = await nextAmendmentNumber(tx, tenantId, now);
    const sequenceNo = (await tx.contractAmendment.count({ where: { tenantId, contractId: a.contractId, status: "SIGNED" } })) + 1;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const after = { ...eff, endAt: a.newEndAt ?? eff.endAt, totalCents: eff.totalCents + (a.priceDeltaCents ?? 0), kmIncludedPerDay: a.newKmIncludedPerDay ?? eff.kmIncludedPerDay, extraKmRate: a.newExtraKmRate != null ? toNumber(a.newExtraKmRate) ?? eff.extraKmRate : eff.extraKmRate, depositCents: a.newDepositCents ?? eff.depositCents, returnLocation: a.newReturnLocation ?? eff.returnLocation };
    const driverName = (d: { role: string; firstName: string; lastName: string }) => ({ role: d.role, name: `${d.firstName} ${d.lastName}` });
    const afterDrivers = a.contract.drivers.filter((d) => (!d.addedByAmendmentId || d.addedByAmendmentId === a.id || eff.amendments.some((x) => x.id === d.addedByAmendmentId)) && !(d.removedByAmendmentId && (d.removedByAmendmentId === a.id || eff.amendments.some((x) => x.id === d.removedByAmendmentId))));
    const changes = describeChanges(a, eff, a.contract.drivers);
    const snapshot: AmendmentSnapshot = {
      v: 1, number, sequenceNo, signedAt: now.toISOString(),
      company: companySnapshotOf(tenant), customer: customerSnapshotFromContract(a.contract.customerSnapshot as Partial<CustomerSnapshot>), vehicle: vehicleRef(a.contract.vehicleSnapshot),
      contract: { id: a.contract.id, number: a.contract.number, contentHash: a.contract.contentHash, startAt: a.contract.startAt.toISOString(), signedAt: a.contract.signedAt?.toISOString() ?? null },
      bookingNumber: a.booking.number,
      priorAmendments: eff.amendments.map((x) => ({ number: x.number ?? "", signedAt: x.signedAt?.toISOString() ?? null })),
      before: { endAt: eff.endAt.toISOString(), totalCents: eff.totalCents, kmIncludedPerDay: eff.kmIncludedPerDay, extraKmRate: eff.extraKmRate, depositCents: eff.depositCents, returnLocation: eff.returnLocation, drivers: eff.drivers.map(driverName) },
      after: { endAt: after.endAt.toISOString(), totalCents: after.totalCents, kmIncludedPerDay: after.kmIncludedPerDay, extraKmRate: after.extraKmRate, depositCents: after.depositCents, returnLocation: after.returnLocation, drivers: afterDrivers.map(driverName) },
      changes, priceProposalCents: a.priceProposalCents,
      signatures: a.signatures.map((s) => ({ role: s.role, signerName: s.signerName, signedAt: s.signedAt.toISOString() })),
      createdByName: a.createdByName, signedByName: actor.name,
    };
    const row = await tx.contractAmendment.update({ where: { id: a.id }, data: { status: "SIGNED", number, sequenceNo, snapshot: snapshot as unknown as Prisma.InputJsonValue, contentHash: hash, signedAt: now, signedById: actor.id, signedByName: actor.name } });

    // Materialisierung: operative Buchung (Disposition, Verfügbarkeit, Rückgabe) und vereinbarte Kaution
    if (a.newEndAt) await tx.booking.update({ where: { id: a.bookingId }, data: { endAt: a.newEndAt } });
    if (a.newDepositCents != null) {
      await tx.booking.update({ where: { id: a.bookingId }, data: { deposit: (a.newDepositCents / 100).toFixed(2) } });
      await tx.securityDeposit.updateMany({ where: { tenantId, bookingId: a.bookingId }, data: { expectedAmountCents: a.newDepositCents } });
    }
    const base = { bookingId: a.bookingId, details: { amendmentId: a.id, number, contractNumber: a.contract.number } };
    await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_SIGNED", ...base, amountCents: a.priceDeltaCents ?? null, details: { ...base.details, sequenceNo, changes: changes.map((c) => c.kind).join(", ") } });
    if (a.newEndAt) await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_PERIOD_CHANGED", ...base, details: { ...base.details, before: eff.endAt.toISOString(), after: a.newEndAt.toISOString() } });
    if (a.priceDeltaCents) await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_PRICE_CHANGED", ...base, amountCents: a.priceDeltaCents, details: { ...base.details, before: eff.totalCents, delta: a.priceDeltaCents, after: after.totalCents, proposal: a.priceProposalCents, reason: a.priceReason } });
    if (a.newKmIncludedPerDay != null || a.newExtraKmRate != null) await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_KM_CHANGED", ...base, details: { ...base.details, before: `${eff.kmIncludedPerDay} km/Tag · ${eff.extraKmRate} €/km`, after: `${after.kmIncludedPerDay} km/Tag · ${after.extraKmRate} €/km` } });
    for (const d of a.contract.drivers.filter((d) => d.addedByAmendmentId === a.id)) await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_DRIVER_ADDED", ...base, details: { ...base.details, contractDriverId: d.id, driver: `${d.firstName} ${d.lastName}` } });
    for (const d of a.contract.drivers.filter((d) => d.removedByAmendmentId === a.id)) await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_DRIVER_REMOVED", ...base, details: { ...base.details, contractDriverId: d.id, driver: `${d.firstName} ${d.lastName}` } });
    if (a.newDepositCents != null) await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_DEPOSIT_CHANGED", ...base, amountCents: a.newDepositCents, details: { ...base.details, before: eff.depositCents, after: a.newDepositCents } });
    if (a.newReturnLocation != null) await recordAudit(tx, tenantId, actor, { action: "AMENDMENT_RETURN_LOCATION_CHANGED", ...base, details: { ...base.details, before: eff.returnLocation, after: a.newReturnLocation } });
    return { amendment: row, created: true };
  }, TX));
}

/** Liste für die Karte „Vertrag & Nachträge“ (alle Nachträge der Buchung, unterschriebene in Reihenfolge). */
export function listAmendments(tenantId: string, bookingId: string, client: Client = db) {
  return client.contractAmendment.findMany({ where: { tenantId, bookingId }, orderBy: [{ sequenceNo: "asc" }, { createdAt: "asc" }], include: { documents: { where: { type: "CONTRACT_AMENDMENT" }, orderBy: { version: "desc" }, take: 1, select: { id: true, fileName: true } }, emailLogs: { where: { status: "SENT" }, orderBy: { sentAt: "asc" }, take: 1, select: { sentAt: true, recipient: true } }, addedDrivers: { select: { firstName: true, lastName: true } }, removedDrivers: { select: { firstName: true, lastName: true } } } });
}

/** Kurzbeschreibung der Änderungsarten eines Nachtrags (Listen). */
export function amendmentKindsLabel(a: { newEndAt: Date | null; priceDeltaCents: number | null; newKmIncludedPerDay: number | null; newExtraKmRate: unknown; newDepositCents: number | null; newReturnLocation: string | null; agreementText: string | null; addedDrivers: unknown[]; removedDrivers: unknown[] }): string {
  const parts: string[] = [];
  if (a.newEndAt) parts.push("Mietdauer");
  if (a.priceDeltaCents) parts.push(a.priceDeltaCents > 0 ? "Preis +" : "Preis −");
  if (a.newKmIncludedPerDay != null || a.newExtraKmRate != null) parts.push("Kilometer");
  if (a.addedDrivers.length) parts.push("Zusatzfahrer +");
  if (a.removedDrivers.length) parts.push("Zusatzfahrer −");
  if (a.newDepositCents != null) parts.push("Kaution");
  if (a.newReturnLocation != null) parts.push("Rückgabeort");
  if (a.agreementText) parts.push("Vereinbarung");
  return parts.join(" · ") || "ohne Änderung";
}

// ---------------------------------------------------------------------------
// Abrechnung nach finaler Mietrechnung (Absicherung): noch nicht abgerechnete Preisänderungen
// ---------------------------------------------------------------------------

export type PendingSettlement = { amendment: AmendmentRow; invoiceId: string; invoiceNumber: string | null; deltaCents: Cents };

/**
 * Unterschriebene Nachträge mit Preisänderung, die in keiner abgeschlossenen Rechnung dieser Buchung als Position stehen und
 * noch keinen Abrechnungsbeleg haben – nur relevant, wenn die Mietrechnung bereits abgeschlossen ist (im Normalfall entstehen
 * die Positionen beim Erstellen der Mietrechnung nach der Rückgabe).
 */
export async function pendingSettlements(tenantId: string, bookingId: string, client: Client = db): Promise<PendingSettlement[]> {
  const invoice = await client.invoice.findFirst({ where: { tenantId, bookingId, kind: "RENTAL", documentType: "INVOICE", status: "FINALIZED" }, select: { id: true, number: true, createdAt: true } });
  if (!invoice) return [];
  const rows = await client.contractAmendment.findMany({ where: { tenantId, bookingId, status: "SIGNED", priceDeltaCents: { not: null }, settlementInvoiceId: null }, orderBy: { sequenceNo: "asc" } });
  const billed = new Set((await client.invoiceVersionItem.findMany({ where: { tenantId, amendmentId: { in: rows.map((r) => r.id) }, version: { status: "FINALIZED" } }, select: { amendmentId: true } })).map((i) => i.amendmentId));
  // Erhöhungen stehen als eigene Position in der Rechnung; Minderungen sind in den Mietpreis eingerechnet, sofern der
  // Nachtrag beim Erstellen der Rechnung bereits wirksam war (später wirksame Minderungen bleiben offen → Gutschrift)
  const open = (r: AmendmentRow) => ((r.priceDeltaCents ?? 0) > 0 ? !billed.has(r.id) : !!r.signedAt && r.signedAt > invoice.createdAt);
  return rows.filter((r) => r.priceDeltaCents && open(r)).map((r) => ({ amendment: r, invoiceId: invoice.id, invoiceNumber: invoice.number, deltaCents: r.priceDeltaCents! }));
}
