// Behördenvorgänge (Phase 14): Schreiben → Daten → Kennzeichen/Tatzeit → Vermietung → Fahrerkandidaten → bewusste
// Fahrerbestimmung → Antwortfassung → ausdrückliche Freigabe → Übermittlung → Nachweis.
// Harte Regeln: Rent-Base stellt automatisch nur „Tatzeit innerhalb der (tatsächlichen/geplanten) Mietdauer“ und
// „vertraglicher Haupt-/Zusatzfahrer“ fest – nie den tatsächlichen Fahrzeugführer. Ohne Freigabe eines berechtigten
// Mitarbeiters verlässt keine Person diesen Mandanten. Freigegebene Fassungen sind unveränderlich; Korrekturen sind neue
// Fassungen. Ein Bußgeld erzeugt nie Rechnung, Zahlung, Zusatzkosten oder Kautionsbewegung.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { AUTHORITY_CASE_STATUS, AUTHORITY_CASE_TYPES, AUTHORITY_RESPONSE_TYPES, DRIVER_DETERMINATION, RENTAL_MATCH, SUBMISSION_METHODS, type AuthorityCaseStatus, type AuthorityResponseType, type SubmissionMethod } from "@/lib/constants";
import { claimEmail, markEmailFailed, markEmailSent } from "@/lib/email-log";
import { deadlineInfo, matchRentals, matchVehicles, plateKey, portalUrlInfo, type RentalCandidate, type RentalCandidateInput } from "@/lib/authority-matching";
import { DomainError, contentHash, sha256 } from "@/lib/integrity";
import { getMailTransport, isValidEmail, safeMailError, type MailTransport } from "@/lib/mail";
import { toCents, type Cents } from "@/lib/money";
import { isUniqueViolation, nextAuthorityCaseNumber, withNumberRetry } from "@/lib/numbering";
import { renderAuthorityResponsePdf, type AuthorityResponsePdfData } from "@/lib/pdf/authority-pdf";
import { assertKeyBelongsToTenant, buildStorageKey, getStorage, type StorageDriver } from "@/lib/storage";
import { APP_TIME_ZONE, parseLocalDateTime, zonedDayRange, zonedDayStartPlus } from "@/lib/time";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type CaseRow = Prisma.AuthorityCaseGetPayload<object>;
export type ResponseRow = Prisma.AuthorityResponseGetPayload<object>;
export const AUTHORITY_MAIL_TEMPLATE = "AUTHORITY_RESPONSE";

function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_(?:DOMAIN|IMMUTABLE): ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}

const fmtDateTime = (d: Date) => d.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDate = (d: Date) => d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" });
/** Tatzeit-Text: mit oder ohne Uhrzeit – eine unbekannte Uhrzeit wird nie als 00:00 dargestellt. */
export const offenseText = (at: Date, timeKnown: boolean) => (timeKnown ? `${fmtDateTime(at)} Uhr` : `${fmtDate(at)} (Uhrzeit nicht angegeben)`);

async function lockCase(tx: Tx, tenantId: string, id: string): Promise<CaseRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AuthorityCase" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new DomainError("Behördenvorgang nicht gefunden.");
  return tx.authorityCase.findUniqueOrThrow({ where: { id } });
}

function event(tx: Tx, tenantId: string, caseId: string, actor: Actor | null, data: { type: string; fromValue?: string | null; toValue?: string | null; note?: string | null }) {
  return tx.authorityCaseEvent.create({ data: { tenantId, caseId, type: data.type, fromValue: data.fromValue ?? null, toValue: data.toValue ?? null, note: data.note ?? null, userId: actor?.id ?? null, userName: actor?.name ?? null } });
}

const isFinal = (c: CaseRow) => c.status === "CLOSED" || c.status === "CANCELLED";
const assertOpen = (c: CaseRow) => { if (isFinal(c)) throw new DomainError(`Der Vorgang ${c.caseNumber} ist ${AUTHORITY_CASE_STATUS[c.status as AuthorityCaseStatus].toLowerCase()}.`); };

function parseAmount(v: string | number | null | undefined): Cents | null {
  if (v == null || String(v).trim() === "") return null;
  let c: Cents;
  try { c = toCents(v); } catch { throw new DomainError("Der Betrag ist ungültig (z. B. 40,00)."); }
  if (c < 0) throw new DomainError("Der Betrag darf nicht negativ sein.");
  return c;
}

/** Tatzeit aus Datum (Pflicht) und Uhrzeit (optional). Ohne Uhrzeit: 12:00 Europe/Berlin als technischer Anker, offenseTimeKnown = false. */
export function parseOffenseAt(date: string, time: string | null | undefined): { offenseAt: Date; offenseTimeKnown: boolean } {
  const t = time?.trim() || null;
  const at = parseLocalDateTime(`${date.trim()}T${t ?? "12:00"}`);
  if (!at) throw new DomainError("Bitte ein gültiges Tatdatum (und ggf. eine gültige Uhrzeit) angeben.");
  return { offenseAt: at, offenseTimeKnown: !!t };
}

/**
 * Statusableitung aus dem Bearbeitungsstand – nur für offene Vorgänge ohne freigegebene/übermittelte Antwort.
 * RECEIVED bleibt, bis die Zuordnung geprüft wurde; danach entscheidet Zuordnung/Antwortstand.
 */
function derivedStatus(c: Pick<CaseRow, "assignmentStatus" | "status">, hasDraft: boolean, hasApproved: boolean, hasSubmitted: boolean): string {
  if (c.status === "CLOSED" || c.status === "CANCELLED") return c.status;
  if (hasSubmitted) return "SUBMITTED";
  if (hasApproved) return "READY_TO_SEND";
  if (hasDraft) return "RESPONSE_PREPARED";
  if (c.assignmentStatus === "ASSIGNED" || c.assignmentStatus === "NO_MATCH") return "REVIEW_REQUIRED";
  return "ASSIGNMENT_REQUIRED";
}

async function refreshStatus(tx: Tx, tenantId: string, id: string, actor: Actor | null): Promise<CaseRow> {
  const c = await tx.authorityCase.findUniqueOrThrow({ where: { id } });
  const responses = await tx.authorityResponse.findMany({ where: { caseId: id }, select: { status: true } });
  const next = derivedStatus(c, responses.some((r) => r.status === "DRAFT"), responses.some((r) => r.status === "APPROVED" || r.status === "FAILED"), responses.some((r) => r.status === "SUBMITTED"));
  if (next === c.status) return c;
  const updated = await tx.authorityCase.update({ where: { id }, data: { status: next } });
  await event(tx, tenantId, id, actor, { type: "STATUS_CHANGED", fromValue: c.status, toValue: next });
  return updated;
}

// ---------------------------------------------------------------------------
// Zuordnung: Kennzeichen → Fahrzeug, Tatzeit → Vermietung (automatisch, transparent, nie Fahrerbehauptung)
// ---------------------------------------------------------------------------

async function rentalInputs(tx: Tx | typeof db, tenantId: string, vehicleId: string, offenseAt: Date): Promise<RentalCandidateInput[]> {
  const from = new Date(offenseAt.getTime() - 2 * 86_400_000), to = new Date(offenseAt.getTime() + 2 * 86_400_000);
  const rows = await tx.booking.findMany({
    where: { tenantId, vehicleId, status: { not: "CANCELLED" }, OR: [{ startAt: { lt: to }, endAt: { gt: from } }, { actualPickupAt: { lt: to } }] },
    select: { id: true, number: true, status: true, startAt: true, endAt: true, actualPickupAt: true, actualReturnAt: true, contract: { select: { id: true, status: true } } },
  });
  return rows.map((b) => ({ bookingId: b.id, bookingNumber: b.number, status: b.status, startAt: b.startAt, endAt: b.endAt, actualPickupAt: b.actualPickupAt, actualReturnAt: b.actualReturnAt, contractId: b.contract?.id ?? null, contractStatus: b.contract?.status ?? null }));
}

/** Automatische Zuordnung; manuelle Zuordnungen (MANUALLY_ASSIGNED) werden nicht überschrieben. */
async function runMatching(tx: Tx, tenantId: string, c: CaseRow, actor: Actor | null): Promise<CaseRow> {
  const data: Prisma.AuthorityCaseUpdateInput = {};
  let vehicleId = c.vehicleId;
  if (c.vehicleMatch !== "MANUALLY_ASSIGNED") {
    const vehicles = await tx.vehicle.findMany({ where: { tenantId }, select: { id: true, plate: true } });
    const vm = matchVehicles(c.licensePlateSnapshot, vehicles);
    vehicleId = vm.status === "EXACT_MATCH" ? vm.vehicleIds[0] : null;
    data.vehicleMatch = vm.status;
    data.vehicle = vehicleId ? { connect: { id: vehicleId } } : { disconnect: true };
    if (vehicleId !== c.vehicleId) await event(tx, tenantId, c.id, actor, { type: "VEHICLE_MATCHED", fromValue: c.vehicleMatch, toValue: vm.status, note: vehicleId ? "Kennzeichen eindeutig einem Fahrzeug zugeordnet" : vm.status === "AMBIGUOUS" ? "Mehrere Fahrzeuge mit passendem Kennzeichen" : "Kein Fahrzeug mit diesem Kennzeichen" });
  }
  if (c.rentalMatch !== "MANUALLY_ASSIGNED") {
    let rm: string = "NONE";
    let bookingId: string | null = null;
    let contractId: string | null = null;
    let dayOnly = false;
    if (vehicleId) {
      const r = matchRentals(await rentalInputs(tx, tenantId, vehicleId, c.offenseAt), c.offenseAt, c.offenseTimeKnown);
      rm = r.status;
      dayOnly = r.dayOnly;
      if (r.selected) { bookingId = r.selected.bookingId; contractId = r.selected.contractId; }
    } else {
      rm = "UNMATCHED";
    }
    data.rentalMatch = rm;
    data.rentalMatchDayOnly = dayOnly;
    data.booking = bookingId ? { connect: { id: bookingId } } : { disconnect: true };
    data.contract = contractId ? { connect: { id: contractId } } : { disconnect: true };
    if (bookingId !== c.bookingId || rm !== c.rentalMatch) await event(tx, tenantId, c.id, actor, { type: "RENTAL_MATCHED", fromValue: c.rentalMatch, toValue: rm, note: RENTAL_MATCH[rm as keyof typeof RENTAL_MATCH] + (dayOnly ? " – nur tagesgenau, Uhrzeit unbekannt" : "") });
    data.assignmentStatus = bookingId ? "ASSIGNED" : vehicleId ? (rm === "NONE" ? "NO_MATCH" : "VEHICLE_ONLY") : c.vehicleMatch === "NO_MATCH" || data.vehicleMatch === "NO_MATCH" ? "NO_MATCH" : "UNASSIGNED";
  }
  const updated = await tx.authorityCase.update({ where: { id: c.id }, data });
  if (updated.vehicleId && updated.vehicleId !== c.vehicleId) await recordAudit(tx, tenantId, actor ?? { id: "system", name: "System" }, { action: "AUTHORITY_CASE_ASSIGNED_TO_VEHICLE", details: { caseNumber: c.caseNumber, vehicleId: updated.vehicleId, match: updated.vehicleMatch } });
  if (updated.bookingId && updated.bookingId !== c.bookingId) await recordAudit(tx, tenantId, actor ?? { id: "system", name: "System" }, { action: "AUTHORITY_CASE_ASSIGNED_TO_BOOKING", bookingId: updated.bookingId, details: { caseNumber: c.caseNumber, match: updated.rentalMatch, dayOnly: updated.rentalMatchDayOnly } });
  return updated;
}

// ---------------------------------------------------------------------------
// Anlage und Stammdaten
// ---------------------------------------------------------------------------

export type CaseInput = {
  type: string; authorityName: string; authorityDepartment?: string | null; authorityReference: string; authorityAddress?: string | null; authorityEmail?: string | null; authorityPortalUrl?: string | null;
  offenseType?: string | null; offenseDescription?: string | null; offenseDate: string; offenseTime?: string | null; offenseLocation?: string | null;
  licensePlate: string; responseDeadline?: Date | null; noticeAmount?: string | number | null; notes?: string | null;
};

function caseData(input: CaseInput) {
  if (!(input.type in AUTHORITY_CASE_TYPES)) throw new DomainError("Ungültige Vorgangsart.");
  const authorityName = input.authorityName.trim(); if (authorityName.length < 2) throw new DomainError("Bitte die Behörde angeben.");
  const authorityReference = input.authorityReference.trim(); if (authorityReference.length < 1) throw new DomainError("Bitte das behördliche Aktenzeichen angeben.");
  const licensePlateSnapshot = input.licensePlate.trim(); if (!plateKey(licensePlateSnapshot)) throw new DomainError("Bitte das Kennzeichen wie im Schreiben angeben.");
  const { offenseAt, offenseTimeKnown } = parseOffenseAt(input.offenseDate, input.offenseTime);
  if (offenseAt.getTime() > Date.now() + 86_400_000) throw new DomainError("Die Tatzeit liegt in der Zukunft.");
  const email = input.authorityEmail?.trim() || null;
  if (email && !isValidEmail(email)) throw new DomainError("Die E-Mail-Adresse der Behörde ist ungültig.");
  const portal = input.authorityPortalUrl?.trim() || null;
  if (portal && !portalUrlInfo(portal).ok) throw new DomainError("Die Portaladresse muss eine vollständige https-Adresse sein.");
  return {
    type: input.type, authorityName, authorityDepartment: input.authorityDepartment?.trim() || null, authorityReference, authorityAddress: input.authorityAddress?.trim() || null, authorityEmail: email, authorityPortalUrl: portal,
    offenseType: input.offenseType?.trim() || null, offenseDescription: input.offenseDescription?.trim() || null, offenseAt, offenseTimeKnown, offenseLocation: input.offenseLocation?.trim() || null,
    licensePlateSnapshot, licensePlateNormalized: plateKey(licensePlateSnapshot), responseDeadline: input.responseDeadline ?? null, noticeAmountCents: parseAmount(input.noticeAmount), notes: input.notes?.trim() || null,
  };
}

/** Manuelle Erfassung eines Schreibens; danach automatische Zuordnung (Fahrzeug, Vermietung) – keine Fahrerbehauptung. */
export async function createAuthorityCase(tenantId: string, actor: Actor, input: CaseInput): Promise<CaseRow> {
  const data = caseData(input);
  try {
    return await withNumberRetry(() =>
      db.$transaction(async (tx) => {
        const caseNumber = await nextAuthorityCaseNumber(tx, tenantId);
        const created = await tx.authorityCase.create({ data: { tenantId, caseNumber, ...data, createdById: actor.id, createdByName: actor.name } });
        await event(tx, tenantId, created.id, actor, { type: "CREATED", toValue: "RECEIVED", note: `${AUTHORITY_CASE_TYPES[input.type as keyof typeof AUTHORITY_CASE_TYPES]} · ${data.authorityName} · ${data.authorityReference}` });
        await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_CASE_CREATED", details: { caseNumber, type: input.type, authorityName: data.authorityName, plate: data.licensePlateSnapshot } });
        const matched = await runMatching(tx, tenantId, created, actor);
        return refreshStatus(tx, tenantId, matched.id, actor);
      }, TX),
    );
  } catch (e) {
    return domainFromDb(e);
  }
}

export async function updateAuthorityCase(tenantId: string, id: string, actor: Actor, input: CaseInput): Promise<CaseRow> {
  const data = caseData(input);
  try {
    return await db.$transaction(async (tx) => {
      const c = await lockCase(tx, tenantId, id);
      assertOpen(c);
      await tx.authorityCase.update({ where: { id: c.id }, data });
      await event(tx, tenantId, c.id, actor, { type: "UPDATED", note: "Vorgangsdaten geändert" });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_CASE_UPDATED", details: { caseNumber: c.caseNumber } });
      const changedKey = data.licensePlateNormalized !== c.licensePlateNormalized || data.offenseAt.getTime() !== c.offenseAt.getTime() || data.offenseTimeKnown !== c.offenseTimeKnown;
      const after = await tx.authorityCase.findUniqueOrThrow({ where: { id: c.id } });
      const matched = changedKey ? await runMatching(tx, tenantId, after, actor) : after;
      return refreshStatus(tx, tenantId, matched.id, actor);
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

export async function rematchCase(tenantId: string, id: string, actor: Actor): Promise<CaseRow> {
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, id);
    assertOpen(c);
    const reset = await tx.authorityCase.update({ where: { id: c.id }, data: { vehicleMatch: "UNMATCHED", rentalMatch: "UNMATCHED" } });
    const matched = await runMatching(tx, tenantId, reset, actor);
    return refreshStatus(tx, tenantId, matched.id, actor);
  }, TX);
}

/** Manuelle Fahrzeugzuordnung (z. B. bei abweichender Schreibweise); die Vermietung wird danach neu gesucht. */
export async function assignVehicle(tenantId: string, id: string, actor: Actor, vehicleId: string | null): Promise<CaseRow> {
  try {
    return await db.$transaction(async (tx) => {
      const c = await lockCase(tx, tenantId, id);
      assertOpen(c);
      if (vehicleId) {
        const v = await tx.vehicle.findFirst({ where: { id: vehicleId, tenantId } });
        if (!v) throw new DomainError("Fahrzeug nicht gefunden.");
      }
      await tx.authorityCase.update({ where: { id: c.id }, data: { vehicleId, vehicleMatch: vehicleId ? "MANUALLY_ASSIGNED" : "UNMATCHED", rentalMatch: "UNMATCHED", bookingId: null, contractId: null, assignmentStatus: "UNASSIGNED" } });
      await event(tx, tenantId, c.id, actor, { type: "VEHICLE_MATCHED", fromValue: c.vehicleMatch, toValue: vehicleId ? "MANUALLY_ASSIGNED" : "UNMATCHED", note: vehicleId ? "Fahrzeug manuell zugeordnet" : "Fahrzeugzuordnung entfernt" });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_CASE_ASSIGNED_TO_VEHICLE", details: { caseNumber: c.caseNumber, vehicleId, manual: true } });
      const after = await tx.authorityCase.findUniqueOrThrow({ where: { id: c.id } });
      const matched = vehicleId ? await runMatching(tx, tenantId, after, actor) : after;
      return refreshStatus(tx, tenantId, matched.id, actor);
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** Manuelle Auswahl einer Vermietung (z. B. bei mehreren Kandidaten) – die Buchung muss zum Fahrzeug des Vorgangs gehören (DB-Regel). */
export async function assignBooking(tenantId: string, id: string, actor: Actor, bookingId: string | null): Promise<CaseRow> {
  try {
    return await db.$transaction(async (tx) => {
      const c = await lockCase(tx, tenantId, id);
      assertOpen(c);
      let contractId: string | null = null;
      let vehicleId = c.vehicleId;
      if (bookingId) {
        const b = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, include: { contract: { select: { id: true, status: true } } } });
        if (!b) throw new DomainError("Buchung nicht gefunden.");
        if (c.vehicleId && b.vehicleId !== c.vehicleId) throw new DomainError("Die Buchung gehört nicht zum zugeordneten Fahrzeug.");
        vehicleId = b.vehicleId;
        contractId = b.contract?.status === "SIGNED" ? b.contract.id : null;
      }
      await tx.authorityCase.update({ where: { id: c.id }, data: { bookingId, contractId, vehicleId, vehicleMatch: vehicleId && c.vehicleMatch === "UNMATCHED" ? "MANUALLY_ASSIGNED" : c.vehicleMatch, rentalMatch: bookingId ? "MANUALLY_ASSIGNED" : "NONE", rentalMatchDayOnly: false, assignmentStatus: bookingId ? "ASSIGNED" : vehicleId ? "NO_MATCH" : "UNASSIGNED", driverDeterminationStatus: bookingId === c.bookingId ? c.driverDeterminationStatus : "UNDETERMINED", driverSnapshot: bookingId === c.bookingId ? undefined : Prisma.DbNull, driverContractDriverId: bookingId === c.bookingId ? c.driverContractDriverId : null, driverCustomerId: bookingId === c.bookingId ? c.driverCustomerId : null } });
      await event(tx, tenantId, c.id, actor, { type: "RENTAL_MATCHED", fromValue: c.rentalMatch, toValue: bookingId ? "MANUALLY_ASSIGNED" : "NONE", note: bookingId ? "Vermietung manuell zugeordnet" : "Zuordnung der Vermietung entfernt" });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_CASE_ASSIGNED_TO_BOOKING", bookingId, details: { caseNumber: c.caseNumber, manual: true } });
      return refreshStatus(tx, tenantId, c.id, actor);
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

// ---------------------------------------------------------------------------
// Fahrerkandidaten (nur aus dem versiegelten Vertrag) und bewusste Fahrerbestimmung
// ---------------------------------------------------------------------------

export type DriverCandidate = { contractDriverId: string; customerId: string | null; role: "PRIMARY_DRIVER" | "ADDITIONAL_DRIVER"; roleLabel: string; firstName: string; lastName: string; birthDate: Date; street: string; zip: string; city: string; country: string };

export async function driverCandidatesOf(tx: Tx | typeof db, tenantId: string, contractId: string | null): Promise<DriverCandidate[]> {
  if (!contractId) return [];
  const rows = await tx.contractDriver.findMany({ where: { tenantId, contractId }, orderBy: [{ role: "desc" }, { createdAt: "asc" }] });
  return rows.map((d) => ({ contractDriverId: d.id, customerId: d.customerId, role: d.role === "PRIMARY_DRIVER" ? "PRIMARY_DRIVER" : "ADDITIONAL_DRIVER", roleLabel: d.role === "PRIMARY_DRIVER" ? "Vertraglicher Hauptfahrer" : "Zusätzlicher Vertragsfahrer", firstName: d.firstName, lastName: d.lastName, birthDate: d.birthDate, street: d.street, zip: d.zip, city: d.city, country: d.country }));
}

export type DriverSnapshot = { source: "CONTRACT_DRIVER" | "OTHER_PERSON"; role: string | null; firstName: string; lastName: string; birthDate: string | null; street: string | null; zip: string | null; city: string | null; country: string | null };
export type DriverInput =
  | { mode: "CONTRACT"; contractDriverId: string; confirmed: boolean; note?: string | null }
  | { mode: "OTHER"; person: { firstName: string; lastName: string; birthDate?: string | null; street?: string | null; zip?: string | null; city?: string | null; country?: string | null }; confirmed: boolean; note?: string | null }
  | { mode: "NOT_IDENTIFIABLE" | "NO_INFORMATION" | "UNDETERMINED"; note?: string | null };

/**
 * Fahrerbestimmung durch einen berechtigten Mitarbeiter. Ein Vertragsfahrer wird nur mit ausdrücklicher Bestätigung
 * übernommen. „Nicht feststellbar“ ist immer möglich. Nach einer übermittelten Antwort bleibt die Änderung möglich,
 * wirkt aber nur auf neue Fassungen (die übermittelte bleibt unverändert).
 */
export async function setDriver(tenantId: string, id: string, actor: Actor, input: DriverInput): Promise<CaseRow> {
  try {
    return await db.$transaction(async (tx) => {
      const c = await lockCase(tx, tenantId, id);
      assertOpen(c);
      let status: string;
      let snapshot: DriverSnapshot | null = null;
      let contractDriverId: string | null = null;
      let customerId: string | null = null;
      if (input.mode === "CONTRACT") {
        if (!input.confirmed) throw new DomainError("Bitte bestätigen Sie ausdrücklich, dass für die Benennung dieser Person eine ausreichende Grundlage vorliegt.");
        const cand = (await driverCandidatesOf(tx, tenantId, c.contractId)).find((d) => d.contractDriverId === input.contractDriverId);
        if (!cand) throw new DomainError("Der ausgewählte Fahrer gehört nicht zum zugeordneten Mietvertrag.");
        status = "CONTRACT_DRIVER_SELECTED";
        contractDriverId = cand.contractDriverId;
        customerId = cand.customerId;
        snapshot = { source: "CONTRACT_DRIVER", role: cand.role, firstName: cand.firstName, lastName: cand.lastName, birthDate: cand.birthDate.toISOString().slice(0, 10), street: cand.street, zip: cand.zip, city: cand.city, country: cand.country };
      } else if (input.mode === "OTHER") {
        if (!input.confirmed) throw new DomainError("Bitte bestätigen Sie ausdrücklich, dass für die Benennung dieser Person eine ausreichende Grundlage vorliegt.");
        const p = input.person;
        if (!p.firstName?.trim() || !p.lastName?.trim()) throw new DomainError("Bitte Vor- und Nachname der Person angeben.");
        status = "OTHER_DRIVER_ENTERED";
        snapshot = { source: "OTHER_PERSON", role: null, firstName: p.firstName.trim(), lastName: p.lastName.trim(), birthDate: p.birthDate?.trim() || null, street: p.street?.trim() || null, zip: p.zip?.trim() || null, city: p.city?.trim() || null, country: p.country?.trim() || null };
      } else {
        status = input.mode === "NOT_IDENTIFIABLE" ? "NOT_IDENTIFIABLE" : input.mode === "NO_INFORMATION" ? "NO_DRIVER_INFORMATION" : "UNDETERMINED";
      }
      const updated = await tx.authorityCase.update({ where: { id: c.id }, data: { driverDeterminationStatus: status, driverSnapshot: snapshot ? (snapshot as unknown as Prisma.InputJsonValue) : Prisma.DbNull, driverContractDriverId: contractDriverId, driverCustomerId: customerId, driverNote: input.note?.trim() || null } });
      const first = c.driverDeterminationStatus === "UNDETERMINED";
      // Historie und Audit nur mit Name der bewusst bestimmten Person, keine weiteren Personendaten
      await event(tx, tenantId, c.id, actor, { type: first ? "DRIVER_SELECTED" : "DRIVER_CHANGED", fromValue: c.driverDeterminationStatus, toValue: status, note: snapshot ? `${snapshot.firstName} ${snapshot.lastName}${snapshot.role === "PRIMARY_DRIVER" ? " (vertraglicher Hauptfahrer)" : snapshot.role === "ADDITIONAL_DRIVER" ? " (zusätzlicher Vertragsfahrer)" : " (andere Person)"}` : DRIVER_DETERMINATION[status as keyof typeof DRIVER_DETERMINATION] });
      await recordAudit(tx, tenantId, actor, { action: first ? "AUTHORITY_DRIVER_SELECTED" : "AUTHORITY_DRIVER_CHANGED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, from: c.driverDeterminationStatus, to: status, source: snapshot?.source ?? null } });
      void updated;
      return refreshStatus(tx, tenantId, c.id, actor);
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

// ---------------------------------------------------------------------------
// Antwortfassungen: Entwurf → Freigabe (unveränderlich, PDF) → Übermittlung → Nachweis
// ---------------------------------------------------------------------------

export type ResponseInput = { responseType: string; submissionMethod: string; freeText?: string | null; includeBirthDate?: boolean; includeAddress?: boolean; recipientEmail?: string | null };

function statementFor(type: AuthorityResponseType): string {
  switch (type) {
    case "DRIVER_IDENTIFIED": return "Das Fahrzeug war zum genannten Zeitpunkt vermietet. Nach Prüfung unserer Unterlagen benennen wir die nachstehende Person als Fahrzeugführer/in zum Tatzeitpunkt.";
    case "MULTIPLE_POSSIBLE_DRIVERS": return "Das Fahrzeug war zum genannten Zeitpunkt vermietet. Im Mietvertrag waren die nachstehenden Personen als Fahrer eingetragen. Wer das Fahrzeug zum Tatzeitpunkt tatsächlich geführt hat, können wir nicht feststellen.";
    case "DRIVER_NOT_IDENTIFIABLE": return "Das Fahrzeug war zum genannten Zeitpunkt vermietet. Der Fahrzeugführer zum Tatzeitpunkt ist für uns nicht eindeutig feststellbar.";
    case "NO_MATCHING_RENTAL": return "Für das genannte Fahrzeug liegt uns zum genannten Zeitpunkt keine Vermietung vor.";
    case "VEHICLE_NOT_IN_FLEET": return "Das genannte Kennzeichen ist keinem Fahrzeug unseres Bestands zugeordnet.";
    default: return "";
  }
}

const personFields = (s: DriverSnapshot, includeBirthDate: boolean, includeAddress: boolean) => {
  const fields: { label: string; value: string }[] = [{ label: "Vorname", value: s.firstName }, { label: "Nachname", value: s.lastName }];
  if (includeBirthDate && s.birthDate) fields.push({ label: "Geburtsdatum", value: fmtDate(new Date(`${s.birthDate}T12:00:00`)) });
  if (includeAddress && (s.street || s.city)) fields.push({ label: "Anschrift", value: [s.street, [s.zip, s.city].filter(Boolean).join(" "), s.country && s.country !== "DE" ? s.country : null].filter(Boolean).join(", ") });
  return fields;
};

/** Antwortentwurf (neue Fassung) aus dem aktuellen Stand; nur bewusst ausgewählte Personendaten werden aufgenommen. */
export async function prepareResponse(tenantId: string, id: string, actor: Actor, input: ResponseInput): Promise<ResponseRow> {
  if (!(input.responseType in AUTHORITY_RESPONSE_TYPES)) throw new DomainError("Ungültige Antwortart.");
  if (!(input.submissionMethod in SUBMISSION_METHODS)) throw new DomainError("Ungültiger Übermittlungsweg.");
  if (input.submissionMethod === "VERIFIED_API") throw new DomainError("Für diesen Empfänger gibt es keine verifizierte Schnittstelle. Bitte Post, E-Mail oder Behördenportal wählen.");
  const responseType = input.responseType as AuthorityResponseType;
  try {
    return await db.$transaction(async (tx) => {
      const c = await lockCase(tx, tenantId, id);
      assertOpen(c);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const email = input.recipientEmail?.trim() || c.authorityEmail || null;
      if (input.submissionMethod === "EMAIL") {
        if (!email || !isValidEmail(email)) throw new DomainError("Für den E-Mail-Versand muss eine E-Mail-Adresse der Behörde aus dem Schreiben erfasst sein.");
      }
      const driver = c.driverSnapshot as DriverSnapshot | null;
      let persons: { role: string; fields: { label: string; value: string }[] }[] = [];
      if (responseType === "DRIVER_IDENTIFIED") {
        if (!driver || (c.driverDeterminationStatus !== "CONTRACT_DRIVER_SELECTED" && c.driverDeterminationStatus !== "OTHER_DRIVER_ENTERED")) throw new DomainError("„Fahrer benannt“ setzt eine bewusste Fahrerbestimmung voraus (Vertragsfahrer ausgewählt oder andere Person erfasst).");
        persons = [{ role: driver.role === "PRIMARY_DRIVER" ? "Vertraglicher Hauptfahrer" : driver.role === "ADDITIONAL_DRIVER" ? "Zusätzlicher Vertragsfahrer" : "Benannte Person", fields: personFields(driver, !!input.includeBirthDate, !!input.includeAddress) }];
      } else if (responseType === "MULTIPLE_POSSIBLE_DRIVERS") {
        const cands = await driverCandidatesOf(tx, tenantId, c.contractId);
        if (cands.length === 0) throw new DomainError("Zu diesem Vorgang ist kein Mietvertrag mit Fahrern zugeordnet.");
        persons = cands.map((d) => ({ role: d.roleLabel, fields: personFields({ source: "CONTRACT_DRIVER", role: d.role, firstName: d.firstName, lastName: d.lastName, birthDate: d.birthDate.toISOString().slice(0, 10), street: d.street, zip: d.zip, city: d.city, country: d.country }, !!input.includeBirthDate, !!input.includeAddress) }));
      } else if (responseType === "CUSTOM_RESPONSE" && !input.freeText?.trim()) {
        throw new DomainError("Eine individuelle Antwort braucht einen Text.");
      }
      const booking = c.bookingId ? await tx.booking.findFirst({ where: { id: c.bookingId, tenantId }, select: { number: true, actualPickupAt: true, actualReturnAt: true, startAt: true, endAt: true, contract: { select: { number: true, status: true } } } }) : null;
      const vehicle = c.vehicleId ? await tx.vehicle.findFirst({ where: { id: c.vehicleId, tenantId }, select: { plate: true, make: true, model: true } }) : null;
      const actual = !!booking?.actualPickupAt;
      const rentalSnapshot = booking && responseType !== "NO_MATCHING_RENTAL" && responseType !== "VEHICLE_NOT_IN_FLEET"
        ? { bookingNumber: booking.number, contractNumber: booking.contract?.status === "SIGNED" ? booking.contract.number : null, windowStart: (actual ? booking.actualPickupAt! : booking.startAt).toISOString(), windowEnd: actual ? booking.actualReturnAt?.toISOString() ?? null : booking.endAt.toISOString(), basis: actual ? "ACTUAL" : "PLANNED", dayOnly: c.rentalMatchDayOnly }
        : null;
      // vorhandenen Entwurf ersetzen, freigegebene aber nicht übermittelte Fassungen als ersetzt markieren
      const existing = await tx.authorityResponse.findMany({ where: { caseId: c.id } });
      for (const r of existing) {
        if (r.status === "DRAFT") await tx.authorityResponse.delete({ where: { id: r.id } });
        else if (r.status === "APPROVED" || r.status === "FAILED") await tx.authorityResponse.update({ where: { id: r.id }, data: { status: "SUPERSEDED" } });
      }
      const version = (existing.length ? Math.max(...existing.map((r) => r.version)) : 0) + (existing.some((r) => r.status === "DRAFT") ? 0 : 1);
      const created = await tx.authorityResponse.create({
        data: {
          tenantId, caseId: c.id, version, status: "DRAFT", responseType, submissionMethod: input.submissionMethod, authorityReference: c.authorityReference,
          recipientSnapshot: { name: c.authorityName, department: c.authorityDepartment, address: c.authorityAddress, email: input.submissionMethod === "EMAIL" ? email : null, portalUrl: c.authorityPortalUrl },
          senderSnapshot: { name: [tenant.name, tenant.legalForm].filter(Boolean).join(" "), street: tenant.street, zip: tenant.zip, city: tenant.city, email: tenant.email, phone: tenant.phone },
          vehicleSnapshot: { plate: c.licensePlateSnapshot, vehicle: vehicle ? `${vehicle.make} ${vehicle.model} (${vehicle.plate})` : null },
          offenseSnapshot: { type: c.type, typeLabel: AUTHORITY_CASE_TYPES[c.type as keyof typeof AUTHORITY_CASE_TYPES], offenseAt: c.offenseAt.toISOString(), timeKnown: c.offenseTimeKnown, atText: offenseText(c.offenseAt, c.offenseTimeKnown), location: c.offenseLocation },
          rentalSnapshot: rentalSnapshot ?? undefined,
          personSnapshot: persons.length ? { persons } : undefined,
          freeText: input.freeText?.trim() || null,
          createdById: actor.id, createdByName: actor.name,
        },
      });
      await event(tx, tenantId, c.id, actor, { type: "RESPONSE_CREATED", toValue: String(version), note: `${AUTHORITY_RESPONSE_TYPES[responseType]} · ${SUBMISSION_METHODS[input.submissionMethod as SubmissionMethod]}` });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_RESPONSE_CREATED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, version, responseType, submissionMethod: input.submissionMethod, persons: persons.length } });
      await refreshStatus(tx, tenantId, c.id, actor);
      return created;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

export function buildResponsePdfData(c: CaseRow, r: ResponseRow): AuthorityResponsePdfData {
  const rec = r.recipientSnapshot as { name: string; department: string | null; address: string | null; email: string | null };
  const snd = r.senderSnapshot as { name: string; street: string | null; zip: string | null; city: string | null; email: string | null; phone: string | null };
  const veh = r.vehicleSnapshot as { plate: string; vehicle: string | null };
  const off = r.offenseSnapshot as { typeLabel: string; atText: string; location: string | null };
  const rental = r.rentalSnapshot as { bookingNumber: string; contractNumber: string | null; windowStart: string; windowEnd: string | null; basis: string; dayOnly: boolean } | null;
  const persons = (r.personSnapshot as { persons: { role: string; fields: { label: string; value: string }[] }[] } | null)?.persons ?? [];
  return {
    caseNumber: c.caseNumber, version: r.version, date: fmtDate(r.approvedAt ?? r.createdAt),
    sender: { name: snd.name, addressLines: [snd.street, [snd.zip, snd.city].filter(Boolean).join(" ")].filter((x): x is string => !!x), contact: [snd.phone, snd.email].filter(Boolean).join(" · ") },
    recipient: { name: rec.name, department: rec.department, addressLines: (rec.address ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean), email: rec.email },
    authorityReference: r.authorityReference,
    vehicle: { plate: veh.plate, description: veh.vehicle },
    offense: { typeLabel: off.typeLabel, atText: off.atText, location: off.location },
    responseTypeLabel: AUTHORITY_RESPONSE_TYPES[r.responseType as AuthorityResponseType] ?? r.responseType,
    statement: statementFor(r.responseType as AuthorityResponseType),
    rental: rental ? { bookingNumber: rental.bookingNumber, contractNumber: rental.contractNumber, windowText: `${fmtDateTime(new Date(rental.windowStart))} bis ${rental.windowEnd ? fmtDateTime(new Date(rental.windowEnd)) : "laufend"}`, basisText: rental.basis === "ACTUAL" ? "Tatsächliche Übergabe- und Rückgabezeit laut Protokoll" : "Geplante Buchungszeit (keine finalisierte Übergabe)" } : null,
    persons, freeText: r.freeText, contentHash: r.contentHash,
  };
}

/** Freigabe: Prüfsumme über den Snapshot, Fassung wird unveränderlich, PDF wird erzeugt und privat abgelegt. */
export async function approveResponse(tenantId: string, responseId: string, actor: Actor, opts: { storage?: StorageDriver } = {}): Promise<ResponseRow> {
  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; caseId: string; status: string }[]>`SELECT "id", "caseId", "status" FROM "AuthorityResponse" WHERE "id" = ${responseId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("Antwortfassung nicht gefunden.");
      const c = await lockCase(tx, tenantId, locked[0].caseId);
      assertOpen(c);
      const r = await tx.authorityResponse.findUniqueOrThrow({ where: { id: responseId } });
      if (r.status !== "DRAFT") return r; // Doppelklick: bereits freigegeben
      const now = new Date();
      const hash = contentHash({ caseNumber: c.caseNumber, version: r.version, responseType: r.responseType, submissionMethod: r.submissionMethod, recipient: r.recipientSnapshot, sender: r.senderSnapshot, authorityReference: r.authorityReference, vehicle: r.vehicleSnapshot, offense: r.offenseSnapshot, rental: r.rentalSnapshot, persons: r.personSnapshot, freeText: r.freeText, approvedAt: now.toISOString(), approvedBy: actor.id });
      const approved = await tx.authorityResponse.update({ where: { id: r.id }, data: { status: "APPROVED", approvedAt: now, approvedById: actor.id, approvedByName: actor.name, contentHash: hash } });
      const pdf = await renderAuthorityResponsePdf(buildResponsePdfData(c, approved));
      const storage = opts.storage ?? getStorage();
      const storageKey = buildStorageKey({ tenantId, area: "documents", contentType: "application/pdf" });
      await storage.put(storageKey, pdf.bytes, "application/pdf");
      const doc = await tx.authorityCaseDocument.create({ data: { tenantId, caseId: c.id, responseId: r.id, type: "RESPONSE_PDF", fileName: `Antwort_${c.caseNumber}_Fassung${r.version}.pdf`, storageKey, contentType: "application/pdf", sizeBytes: pdf.bytes.length, checksum: sha256(pdf.bytes), createdById: actor.id, createdByName: actor.name } });
      const final = await tx.authorityResponse.update({ where: { id: r.id }, data: { pdfDocumentId: doc.id } });
      await event(tx, tenantId, c.id, actor, { type: "RESPONSE_APPROVED", toValue: String(r.version), note: "Angaben geprüft und Antwort freigegeben" });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_RESPONSE_APPROVED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, version: r.version, contentHash: hash } });
      await refreshStatus(tx, tenantId, c.id, actor);
      return final;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

export type SubmitInput = { submittedAt?: Date | null; reference?: string | null; note?: string | null; receiptDocumentId?: string | null; nonce?: string | null; transport?: MailTransport; storage?: StorageDriver };
export type SubmitResult = { response: ResponseRow; outcome: "SUBMITTED" | "FAILED" | "ALREADY_SUBMITTED"; error?: string };

/**
 * Übermittlung der freigegebenen Fassung. E-Mail: nur an die aus dem Schreiben erfasste Adresse, idempotent über EmailLog,
 * bei Fehler bleibt der Vorgang offen (FAILED, erneuter Versuch möglich). Post/Portal/Sonstiges: der Mitarbeiter markiert
 * die extern erfolgte Übermittlung mit Datum; Rent-Base kann dort nicht prüfen, ob extern doppelt gesendet wurde.
 */
export async function submitResponse(tenantId: string, responseId: string, actor: Actor, input: SubmitInput = {}): Promise<SubmitResult> {
  const base = await db.authorityResponse.findFirst({ where: { id: responseId, tenantId } });
  if (!base) throw new DomainError("Antwortfassung nicht gefunden.");
  if (base.status === "SUBMITTED") return { response: base, outcome: "ALREADY_SUBMITTED" };
  if (base.status !== "APPROVED" && base.status !== "FAILED") throw new DomainError("Nur eine freigegebene Antwortfassung kann übermittelt werden.");
  if (base.submissionMethod === "EMAIL") return submitByEmail(tenantId, base, actor, input);
  const submittedAt = input.submittedAt ?? null;
  if (!submittedAt) throw new DomainError("Bitte das Übermittlungsdatum angeben.");
  if (submittedAt.getTime() > Date.now() + 3_600_000) throw new DomainError("Das Übermittlungsdatum liegt in der Zukunft.");
  try {
    let already = false;
    const response = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "AuthorityResponse" WHERE "id" = ${responseId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (locked[0]?.status === "SUBMITTED") { already = true; return tx.authorityResponse.findUniqueOrThrow({ where: { id: responseId } }); }
      const c = await lockCase(tx, tenantId, base.caseId);
      if (input.receiptDocumentId) {
        const d = await tx.authorityCaseDocument.findFirst({ where: { id: input.receiptDocumentId, tenantId, caseId: c.id } });
        if (!d) throw new DomainError("Der Nachweis gehört nicht zu diesem Vorgang.");
      }
      const updated = await tx.authorityResponse.update({ where: { id: responseId }, data: { status: "SUBMITTED", submittedAt, submittedById: actor.id, submittedByName: actor.name, submissionReference: input.reference?.trim() || null } });
      await tx.authoritySubmissionReceipt.create({ data: { tenantId, caseId: c.id, responseId, method: base.submissionMethod, submittedAt, reference: input.reference?.trim() || null, note: input.note?.trim() || null, documentId: input.receiptDocumentId || null, createdById: actor.id, createdByName: actor.name } });
      await event(tx, tenantId, c.id, actor, { type: "RESPONSE_SUBMITTED", toValue: String(base.version), note: `${SUBMISSION_METHODS[base.submissionMethod as SubmissionMethod]}${input.reference ? ` · ${input.reference.trim()}` : ""}` });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_RESPONSE_SUBMITTED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, version: base.version, method: base.submissionMethod } });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_SUBMISSION_RECEIPT_ADDED", details: { caseNumber: c.caseNumber, version: base.version, method: base.submissionMethod, hasDocument: !!input.receiptDocumentId } });
      await refreshStatus(tx, tenantId, c.id, actor);
      return updated;
    }, TX);
    return { response, outcome: already ? "ALREADY_SUBMITTED" : "SUBMITTED" };
  } catch (e) {
    return domainFromDb(e);
  }
}

async function submitByEmail(tenantId: string, r: ResponseRow, actor: Actor, input: SubmitInput): Promise<SubmitResult> {
  const c = await db.authorityCase.findFirstOrThrow({ where: { id: r.caseId, tenantId } });
  const rec = r.recipientSnapshot as { email: string | null; name: string };
  if (!rec.email || !isValidEmail(rec.email)) throw new DomainError("Die freigegebene Fassung enthält keine gültige E-Mail-Adresse der Behörde.");
  const pdfDoc = r.pdfDocumentId ? await db.authorityCaseDocument.findFirst({ where: { id: r.pdfDocumentId, tenantId } }) : null;
  if (!pdfDoc) throw new DomainError("Das Antwort-PDF fehlt.");
  // Idempotenz: eine Fassung wird höchstens einmal gesendet; ohne neuen Versuchsschlüssel (Nonce) wird nie erneut gesendet
  const idempotencyKey = `${AUTHORITY_MAIL_TEMPLATE}:${r.id}:v${r.version}${input.nonce ? `:retry:${input.nonce}` : ""}`;
  const subject = `Antwort auf Ihre Anfrage – Aktenzeichen ${r.authorityReference}`;
  const { log, created } = await claimEmail({ tenantId, bookingId: c.bookingId, recipient: rec.email, subject, template: AUTHORITY_MAIL_TEMPLATE, attachments: [{ documentId: pdfDoc.id, fileName: pdfDoc.fileName, checksum: pdfDoc.checksum, type: "AUTHORITY_RESPONSE_PDF" }], trigger: "MANUAL", createdById: actor.id, idempotencyKey });
  if (!created) {
    const fresh = await db.authorityResponse.findUniqueOrThrow({ where: { id: r.id } });
    return { response: fresh, outcome: fresh.status === "SUBMITTED" ? "ALREADY_SUBMITTED" : "FAILED", error: log.status === "FAILED" ? log.error ?? undefined : "Diese Fassung wurde bereits gesendet oder der Versand läuft." };
  }
  try {
    const storage = input.storage ?? getStorage();
    assertKeyBelongsToTenant(pdfDoc.storageKey, tenantId);
    const file = await storage.get(pdfDoc.storageKey);
    if (!file || sha256(file.body) !== pdfDoc.checksum) throw new DomainError("Das Antwort-PDF konnte nicht unverändert aus dem Archiv gelesen werden.");
    const snd = r.senderSnapshot as { name: string; email: string | null };
    const text = [`Sehr geehrte Damen und Herren,`, ``, `anbei erhalten Sie unsere Antwort zu Ihrem Aktenzeichen ${r.authorityReference} (Kennzeichen ${(r.vehicleSnapshot as { plate: string }).plate}).`, ``, `Mit freundlichen Grüßen`, snd.name].join("\n");
    const transport = input.transport ?? getMailTransport();
    const result = await transport.send({ to: rec.email, subject, text, html: `<p>${text.replace(/\n/g, "<br>")}</p>`, fromName: snd.name, replyTo: snd.email, attachments: [{ filename: pdfDoc.fileName, content: file.body, contentType: "application/pdf" }] });
    await markEmailSent(tenantId, log.id, result.messageId);
    const now = new Date();
    const response = await db.$transaction(async (tx) => {
      const updated = await tx.authorityResponse.update({ where: { id: r.id }, data: { status: "SUBMITTED", submittedAt: now, submittedById: actor.id, submittedByName: actor.name, emailLogId: log.id, failureReason: null } });
      await tx.authoritySubmissionReceipt.create({ data: { tenantId, caseId: c.id, responseId: r.id, method: "EMAIL", submittedAt: now, reference: result.messageId ?? null, note: `E-Mail an ${rec.email}`, createdById: actor.id, createdByName: actor.name } });
      await event(tx, tenantId, c.id, actor, { type: "RESPONSE_SUBMITTED", toValue: String(r.version), note: `E-Mail an ${rec.email}` });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_RESPONSE_SUBMITTED", bookingId: c.bookingId, details: { caseNumber: c.caseNumber, version: r.version, method: "EMAIL" } });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_SUBMISSION_RECEIPT_ADDED", details: { caseNumber: c.caseNumber, version: r.version, method: "EMAIL" } });
      await refreshStatus(tx, tenantId, c.id, actor);
      return updated;
    }, TX);
    return { response, outcome: "SUBMITTED" };
  } catch (e) {
    const message = safeMailError(e);
    await markEmailFailed(tenantId, log.id, message);
    const response = await db.$transaction(async (tx) => {
      const updated = await tx.authorityResponse.update({ where: { id: r.id }, data: { status: "FAILED", failureReason: message, emailLogId: log.id } });
      await event(tx, tenantId, c.id, actor, { type: "SUBMISSION_FAILED", toValue: String(r.version), note: message });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_SUBMISSION_FAILED", details: { caseNumber: c.caseNumber, version: r.version, method: "EMAIL" } });
      await refreshStatus(tx, tenantId, c.id, actor);
      return updated;
    }, TX);
    return { response, outcome: "FAILED", error: message };
  }
}

// ---------------------------------------------------------------------------
// Abschluss, Wiederöffnen, Storno, Notizen, Dokumente
// ---------------------------------------------------------------------------

export async function closeAuthorityCase(tenantId: string, id: string, actor: Actor, reason: string): Promise<CaseRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Abschlussgrund angeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, id);
    assertOpen(c);
    const updated = await tx.authorityCase.update({ where: { id: c.id }, data: { status: "CLOSED", closedAt: new Date(), closedById: actor.id, closedByName: actor.name, closeReason: why } });
    await event(tx, tenantId, c.id, actor, { type: "CLOSED", fromValue: c.status, toValue: "CLOSED", note: why });
    await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_CASE_CLOSED", details: { caseNumber: c.caseNumber, from: c.status, reason: why } });
    return updated;
  }, TX);
}

export async function reopenAuthorityCase(tenantId: string, id: string, actor: Actor, reason: string): Promise<CaseRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund für das Wiederöffnen angeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, id);
    if (c.status !== "CLOSED" && c.status !== "CANCELLED") throw new DomainError("Der Vorgang ist nicht abgeschlossen.");
    await tx.authorityCase.update({ where: { id: c.id }, data: { status: "REVIEW_REQUIRED", closedAt: null, closedById: null, closedByName: null, closeReason: null } });
    await event(tx, tenantId, c.id, actor, { type: "REOPENED", fromValue: c.status, toValue: "REVIEW_REQUIRED", note: why });
    await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_CASE_REOPENED", details: { caseNumber: c.caseNumber, reason: why } });
    return refreshStatus(tx, tenantId, c.id, actor);
  }, TX);
}

export async function cancelAuthorityCase(tenantId: string, id: string, actor: Actor, reason: string): Promise<CaseRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Stornogrund angeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, id);
    assertOpen(c);
    const submitted = await tx.authorityResponse.count({ where: { caseId: c.id, status: "SUBMITTED" } });
    if (submitted > 0) throw new DomainError("Ein Vorgang mit übermittelter Antwort wird abgeschlossen, nicht storniert.");
    const updated = await tx.authorityCase.update({ where: { id: c.id }, data: { status: "CANCELLED", closeReason: why } });
    await event(tx, tenantId, c.id, actor, { type: "CANCELLED", fromValue: c.status, toValue: "CANCELLED", note: why });
    await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_CASE_CANCELLED", details: { caseNumber: c.caseNumber, reason: why } });
    return updated;
  }, TX);
}

export async function addAuthorityNote(tenantId: string, id: string, actor: Actor, note: string) {
  const text = note.trim();
  if (text.length < 2) throw new DomainError("Bitte eine Notiz eingeben.");
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, id);
    return event(tx, tenantId, c.id, actor, { type: "NOTE_ADDED", note: text.slice(0, 2000) });
  }, TX);
}

export async function setInternalNote(tenantId: string, id: string, actor: Actor, note: string | null) {
  return db.$transaction(async (tx) => {
    const c = await lockCase(tx, tenantId, id);
    const updated = await tx.authorityCase.update({ where: { id: c.id }, data: { internalNote: note?.trim() || null } });
    await event(tx, tenantId, c.id, actor, { type: "NOTE_ADDED", note: "Interne Notiz aktualisiert" });
    return updated;
  }, TX);
}

export async function registerAuthorityDocument(tenantId: string, id: string, actor: Actor, input: { type: string; fileName: string; storageKey: string; contentType: string; sizeBytes: number; checksum: string; note?: string | null }) {
  if (!["INCOMING_NOTICE", "EVIDENCE", "RESPONSE_DRAFT", "SUBMISSION_RECEIPT", "CORRESPONDENCE", "OTHER"].includes(input.type)) throw new DomainError("Unbekannter Dokumenttyp.");
  try {
    return await db.$transaction(async (tx) => {
      const c = await lockCase(tx, tenantId, id);
      if (c.status === "CANCELLED") throw new DomainError("Der Vorgang ist storniert.");
      const doc = await tx.authorityCaseDocument.create({ data: { tenantId, caseId: c.id, type: input.type, fileName: input.fileName.slice(0, 200), storageKey: input.storageKey, contentType: input.contentType, sizeBytes: input.sizeBytes, checksum: input.checksum, note: input.note?.trim() || null, createdById: actor.id, createdByName: actor.name } });
      await event(tx, tenantId, c.id, actor, { type: "DOCUMENT_ADDED", toValue: input.type, note: doc.fileName });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_DOCUMENT_ADDED", details: { caseNumber: c.caseNumber, type: input.type, documentId: doc.id } });
      return doc;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** Archivieren statt löschen; Antwort-PDFs und Nachweise übermittelter Fassungen bleiben immer aktiv. */
export async function archiveAuthorityDocument(tenantId: string, documentId: string, actor: Actor, reason: string) {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund für die Archivierung angeben.");
  try {
    return await db.$transaction(async (tx) => {
      const doc = await tx.authorityCaseDocument.findFirst({ where: { id: documentId, tenantId } });
      if (!doc) throw new DomainError("Dokument nicht gefunden.");
      if (doc.archivedAt) throw new DomainError("Das Dokument ist bereits archiviert.");
      if (doc.type === "RESPONSE_PDF") throw new DomainError("Erzeugte Antwort-PDFs werden nicht archiviert; eine Korrektur ist eine neue Fassung.");
      if (doc.responseId) {
        const r = await tx.authorityResponse.findUniqueOrThrow({ where: { id: doc.responseId } });
        if (r.status === "SUBMITTED") throw new DomainError("Dokumente einer übermittelten Fassung bleiben erhalten.");
      }
      const receipt = await tx.authoritySubmissionReceipt.count({ where: { documentId: doc.id } });
      if (receipt > 0) throw new DomainError("Ein Übermittlungsnachweis bleibt erhalten.");
      const updated = await tx.authorityCaseDocument.update({ where: { id: doc.id }, data: { archivedAt: new Date(), archivedByName: actor.name, archiveReason: why } });
      await event(tx, tenantId, doc.caseId, actor, { type: "DOCUMENT_ARCHIVED", note: `${doc.fileName}: ${why}` });
      await recordAudit(tx, tenantId, actor, { action: "AUTHORITY_DOCUMENT_ARCHIVED", details: { documentId: doc.id, reason: why } });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

// ---------------------------------------------------------------------------
// Sichten
// ---------------------------------------------------------------------------

export type AuthorityCaseView = Awaited<ReturnType<typeof authorityCaseView>>;

export async function authorityCaseView(tenantId: string, id: string, now = new Date()) {
  const c = await db.authorityCase.findFirst({
    where: { id, tenantId },
    include: {
      vehicle: { select: { id: true, plate: true, make: true, model: true, status: true } },
      booking: { select: { id: true, number: true, status: true, startAt: true, endAt: true, actualPickupAt: true, actualReturnAt: true, customer: { select: { id: true, type: true, companyName: true, firstName: true, lastName: true } }, contract: { select: { id: true, number: true, status: true } } } },
      documents: { orderBy: { createdAt: "desc" } },
      responses: { orderBy: { version: "desc" } },
      receipts: { orderBy: { submittedAt: "desc" } },
      events: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!c) throw new DomainError("Behördenvorgang nicht gefunden.");
  const [ambiguousVehicles, candidates, drivers] = await Promise.all([
    c.vehicleMatch === "AMBIGUOUS" || !c.vehicleId ? db.vehicle.findMany({ where: { tenantId, status: { not: "INACTIVE" } }, select: { id: true, plate: true, make: true, model: true }, orderBy: { plate: "asc" } }) : Promise.resolve([]),
    c.vehicleId ? rentalInputs(db, tenantId, c.vehicleId, c.offenseAt).then((rows) => matchRentals(rows, c.offenseAt, c.offenseTimeKnown).candidates) : Promise.resolve([] as RentalCandidate[]),
    driverCandidatesOf(db, tenantId, c.contractId),
  ]);
  const plateHits = ambiguousVehicles.filter((v) => plateKey(v.plate) === c.licensePlateNormalized);
  return {
    ...c,
    deadline: deadlineInfo(c.responseDeadline, now),
    portal: portalUrlInfo(c.authorityPortalUrl),
    vehicleOptions: ambiguousVehicles,
    plateHits,
    rentalCandidates: candidates,
    driverCandidates: drivers,
    driver: c.driverSnapshot as DriverSnapshot | null,
    currentResponse: c.responses.find((r) => r.status === "SUBMITTED") ?? c.responses.find((r) => r.status === "APPROVED" || r.status === "FAILED") ?? c.responses.find((r) => r.status === "DRAFT") ?? null,
    activeDocuments: c.documents.filter((d) => !d.archivedAt),
    archivedDocuments: c.documents.filter((d) => !!d.archivedAt),
    offenseText: offenseText(c.offenseAt, c.offenseTimeKnown),
  };
}

export type AuthorityFilter = "alle" | "neu" | "zuordnung" | "pruefung" | "vorbereitet" | "versandbereit" | "ueberfaellig" | "uebermittelt" | "abgeschlossen";
export const AUTHORITY_FILTERS: { key: AuthorityFilter; label: string }[] = [
  { key: "neu", label: "Neu" }, { key: "zuordnung", label: "Zuordnung erforderlich" }, { key: "pruefung", label: "Prüfung erforderlich" }, { key: "vorbereitet", label: "Antwort vorbereitet" },
  { key: "versandbereit", label: "Versandbereit" }, { key: "ueberfaellig", label: "Überfällig" }, { key: "uebermittelt", label: "Übermittelt" }, { key: "abgeschlossen", label: "Abgeschlossen" }, { key: "alle", label: "Alle" },
];
/** Offene Vorgänge (noch nicht übermittelt, geschlossen oder storniert) – auch für das Dashboard. */
export const AUTHORITY_OPEN_STATUS = ["RECEIVED", "ASSIGNMENT_REQUIRED", "REVIEW_REQUIRED", "RESPONSE_PREPARED", "READY_TO_SEND"];
const OPEN_STATUS = AUTHORITY_OPEN_STATUS;

export type ListOptions = { filter?: AuthorityFilter; q?: string; page?: number; pageSize?: number; type?: string | null; vehicleId?: string | null; assigned?: "ja" | "nein" | null; driver?: "ja" | "nein" | null; submitted?: "ja" | "nein" | null; deadline?: "ueberfaellig" | "bald" | "ohne" | null };

/** Inbox/Übersicht: Filter, Suche (ohne Personendaten in der Liste), Serverseiten. */
export async function listAuthorityCases(tenantId: string, opts: ListOptions = {}, now = new Date()) {
  const filter = opts.filter ?? "alle";
  const q = opts.q?.trim() ?? "";
  const pageSize = Math.min(100, Math.max(10, opts.pageSize ?? 30));
  const page = Math.max(1, opts.page ?? 1);
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const in3 = new Date(startOfToday.getTime() + 4 * 86_400_000);
  const byFilter: Record<AuthorityFilter, Prisma.AuthorityCaseWhereInput> = {
    alle: {}, neu: { status: "RECEIVED" }, zuordnung: { status: "ASSIGNMENT_REQUIRED" }, pruefung: { status: "REVIEW_REQUIRED" }, vorbereitet: { status: "RESPONSE_PREPARED" }, versandbereit: { status: "READY_TO_SEND" },
    ueberfaellig: { status: { in: OPEN_STATUS }, responseDeadline: { lt: startOfToday } }, uebermittelt: { status: "SUBMITTED" }, abgeschlossen: { status: { in: ["CLOSED", "CANCELLED"] } },
  };
  const extra: Prisma.AuthorityCaseWhereInput[] = [];
  if (opts.type) extra.push({ type: opts.type });
  if (opts.vehicleId) extra.push({ vehicleId: opts.vehicleId });
  if (opts.assigned === "ja") extra.push({ bookingId: { not: null } });
  if (opts.assigned === "nein") extra.push({ bookingId: null });
  if (opts.driver === "ja") extra.push({ driverDeterminationStatus: { in: ["CONTRACT_DRIVER_SELECTED", "OTHER_DRIVER_ENTERED"] } });
  if (opts.driver === "nein") extra.push({ driverDeterminationStatus: { notIn: ["CONTRACT_DRIVER_SELECTED", "OTHER_DRIVER_ENTERED"] } });
  if (opts.submitted === "ja") extra.push({ responses: { some: { status: "SUBMITTED" } } });
  if (opts.submitted === "nein") extra.push({ responses: { none: { status: "SUBMITTED" } } });
  if (opts.deadline === "ueberfaellig") extra.push({ status: { in: OPEN_STATUS }, responseDeadline: { lt: startOfToday } });
  if (opts.deadline === "bald") extra.push({ status: { in: OPEN_STATUS }, responseDeadline: { gte: startOfToday, lt: in3 } });
  if (opts.deadline === "ohne") extra.push({ responseDeadline: null });
  const search: Prisma.AuthorityCaseWhereInput = q
    ? { OR: [
        { caseNumber: { contains: q, mode: "insensitive" } }, { authorityReference: { contains: q, mode: "insensitive" } }, { authorityName: { contains: q, mode: "insensitive" } },
        { licensePlateSnapshot: { contains: q, mode: "insensitive" } }, { licensePlateNormalized: { contains: plateKey(q) } },
        { vehicle: { plate: { contains: q, mode: "insensitive" } } },
        { booking: { OR: [{ number: { contains: q, mode: "insensitive" } }, { contract: { number: { contains: q, mode: "insensitive" } } }, { customer: { OR: [{ lastName: { contains: q, mode: "insensitive" } }, { firstName: { contains: q, mode: "insensitive" } }, { companyName: { contains: q, mode: "insensitive" } }] } }] } },
      ] }
    : {};
  const where: Prisma.AuthorityCaseWhereInput = { tenantId, AND: [byFilter[filter], ...extra, search] };
  const [total, rows] = await Promise.all([
    db.authorityCase.count({ where }),
    db.authorityCase.findMany({ where, orderBy: [{ responseDeadline: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize, include: { vehicle: { select: { id: true, plate: true, make: true, model: true } }, booking: { select: { id: true, number: true } }, responses: { where: { status: "SUBMITTED" }, select: { id: true, version: true, submittedAt: true, submissionMethod: true } } } }),
  ]);
  return { items: rows.map((r) => ({ ...r, deadline: deadlineInfo(r.responseDeadline, now), offenseText: offenseText(r.offenseAt, r.offenseTimeKnown) })), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), filter, q };
}

export async function authorityCounts(tenantId: string, now = new Date()) {
  // Kalendertage in der Anwendungszeitzone (Europe/Berlin), nicht in der Zeitzone des Servers
  const { start: startOfToday, end: endOfToday } = zonedDayRange(now);
  const in3 = zonedDayStartPlus(now, 4);
  const [received, assignment, dueSoon, overdue, dueToday] = await Promise.all([
    db.authorityCase.count({ where: { tenantId, status: "RECEIVED" } }),
    db.authorityCase.count({ where: { tenantId, status: "ASSIGNMENT_REQUIRED" } }),
    db.authorityCase.count({ where: { tenantId, status: { in: OPEN_STATUS }, responseDeadline: { gte: startOfToday, lt: in3 } } }),
    db.authorityCase.count({ where: { tenantId, status: { in: OPEN_STATUS }, responseDeadline: { lt: startOfToday } } }),
    db.authorityCase.findMany({ where: { tenantId, status: { in: OPEN_STATUS }, responseDeadline: { lt: endOfToday } }, orderBy: { responseDeadline: "asc" }, take: 10, select: { id: true, caseNumber: true, type: true, authorityName: true, responseDeadline: true, licensePlateSnapshot: true } }),
  ]);
  return { received, assignment, dueSoon, overdue, dueToday: dueToday.map((c) => ({ ...c, deadline: deadlineInfo(c.responseDeadline, now) })) };
}

const overviewSelect = { id: true, caseNumber: true, type: true, status: true, authorityName: true, authorityReference: true, offenseAt: true, offenseTimeKnown: true, responseDeadline: true, licensePlateSnapshot: true, bookingId: true, vehicleId: true, booking: { select: { id: true, number: true } }, vehicle: { select: { id: true, plate: true } }, responses: { where: { status: "SUBMITTED" }, select: { id: true } } } as const;
const decorate = <T extends { offenseAt: Date; offenseTimeKnown: boolean; responseDeadline: Date | null }>(rows: T[]) => rows.map((r) => ({ ...r, offenseText: offenseText(r.offenseAt, r.offenseTimeKnown), deadline: deadlineInfo(r.responseDeadline) }));

/** Fahrzeugakte / Buchung: Übersicht ohne Personendaten. */
export async function casesForVehicle(tenantId: string, vehicleId: string) {
  return decorate(await db.authorityCase.findMany({ where: { tenantId, vehicleId }, orderBy: { offenseAt: "desc" }, select: overviewSelect }));
}
export async function casesForBooking(tenantId: string, bookingId: string) {
  return decorate(await db.authorityCase.findMany({ where: { tenantId, bookingId }, orderBy: { offenseAt: "desc" }, select: overviewSelect }));
}
/** Kundenakte: nur Vorgänge, in denen diese Person bewusst als Fahrer bestimmt wurde – nicht jede Buchung des Kunden. */
export async function casesForCustomer(tenantId: string, customerId: string) {
  return decorate(await db.authorityCase.findMany({ where: { tenantId, driverCustomerId: customerId }, orderBy: { offenseAt: "desc" }, select: overviewSelect }));
}

export const authorityDomainError = (e: unknown) => (e instanceof DomainError ? e.message : null);
export const isUnique = isUniqueViolation;
