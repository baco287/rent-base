// Phase 19.5: Fahreridentifikation und Führerscheinprüfung bei der Übergabe.
//
// Kernregel: die ORIGINALPRÜFUNG ist der operative Kern (DriverVerification). Eine Dokumentkopie
// (DriverDocumentCopy) ist ein davon getrennter, optionaler Vorgang und ersetzt die Prüfung nie.
// Wer geprüft werden muss, bestimmt ausschließlich der finalisierte Vertrag (ContractDriver-Snapshot),
// nie die aktuellen Customer-Stammdaten. Ein bestätigter Prüfvermerk ist unveränderlich (Datenbank-Trigger
// rb_driver_verification_guard); eine Korrektur entsteht als neue Fassung (version + supersededById).
//
// Rechtliche Eckpunkte (siehe Abschlussbericht für die geprüften Quellen):
// - § 20 Abs. 2 PAuswG: eine Personalausweiskopie braucht die Zustimmung des Inhabers und muss eindeutig
//   und dauerhaft als Kopie erkennbar sein. § 20 Abs. 3: die Seriennummer wird nicht automatisiert zum
//   Datenabruf verwendet – Rent-Base speichert sie in diesem Prozess nicht.
// - § 6 FeV: Fahrerlaubnisklassen und welche Klasse zusätzlich zu welchen berechtigt (LICENSE_CLASS_IMPLIES).
// - § 29 FeV: ausländische Fahrerlaubnisse außerhalb EU/EWR/Schweiz ohne Übersetzung oder internationalen
//   Führerschein bedürfen der bewussten manuellen Prüfung; keine automatische Rechtsbewertung.
// - Art. 5, 6 DSGVO: Zweckbindung, Datenminimierung, Speicherbegrenzung; nur die für den Vermietvorgang
//   nötigen Daten werden erhoben, eine Dokumentkopie ist nicht Voraussetzung für den Abschluss.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError, ImmutableError, contentHash } from "@/lib/integrity";
import { EU_EEA_CH_COUNTRIES, LICENSE_CLASS_IMPLIES, type LicenseClass } from "@/lib/constants";
import { assertKeyBelongsToTenant, buildStorageKey, getStorage, sniffImageType, MAX_PHOTO_BYTES } from "@/lib/storage";
import { stampAsCopy } from "@/lib/driver-copy-stamp";
import { ACCIDENT_CASE_CLOSED_MESSAGE, accidentCaseClosed } from "@/lib/accident-replacement-events";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };

// ---------------------------------------------------------------------------
// Fahrerlaubnisklassen und Fahrzeuganforderung
// ---------------------------------------------------------------------------

/** Erforderliche Fahrerlaubnisklasse: Fahrzeug > Gruppe > Standard (PKW-Gruppen ohne Angabe gelten als B). */
export function requiredLicenseClassFor(vehicle: { requiredLicenseClass: string | null }, group: { requiredLicenseClass: string | null; bodyType: string } | null): string | null {
  return vehicle.requiredLicenseClass ?? group?.requiredLicenseClass ?? (group?.bodyType === "PKW" ? "B" : null);
}

/** Erfüllt eine gehaltene Klasse (direkt oder über § 6 Abs. 3 FeV eingeschlossen) die erforderliche Klasse? */
export function classSatisfiesRequirement(required: string, held: readonly string[]): boolean {
  for (const h of held) {
    if (h === required) return true;
    const implies = LICENSE_CLASS_IMPLIES[h as LicenseClass];
    if (implies?.includes(required as LicenseClass)) return true;
  }
  return false;
}

/** Land gehört zu EU/EWR/Schweiz: keine Übersetzung nötig (§ 29 FeV); sonst nur mit Übersetzung oder internationalem Führerschein automatisch einordenbar. */
export function isEuEeaChCountry(country: string): boolean {
  return (EU_EEA_CH_COUNTRIES as readonly string[]).includes(country.trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// Erforderliche Fahrer eines Vertrags
// ---------------------------------------------------------------------------

export type RequiredDriver = {
  contractDriverId: string;
  role: "PRIMARY_DRIVER" | "ADDITIONAL_DRIVER";
  firstName: string;
  lastName: string;
  birthDate: Date;
  customerId: string | null;
  licenseNumber: string;
  licenseClass: string;
  licenseCountry: string;
  licenseIssuedAt: Date;
  licenseValidUntil: Date | null;
};

/** Fahrer, die laut finalisiertem Vertrag geprüft werden müssen: Hauptfahrer und alle Zusatzfahrer (nie aus Customer abgeleitet). */
export async function requiredDriversFor(tenantId: string, contractId: string, client: Tx | typeof db = db): Promise<RequiredDriver[]> {
  // Befehl 25: nur wirksame Fahrer – durch einen unterschriebenen Nachtrag aufgenommene zählen, herausgenommene nicht;
  // Fahrer eines Nachtrag-Entwurfs werden erst mit dessen Unterschrift wirksam
  const rows = (await client.contractDriver.findMany({ where: { tenantId, contractId }, orderBy: [{ role: "asc" }, { createdAt: "asc" }], include: { addedBy: { select: { status: true } }, removedBy: { select: { status: true } } } }))
    .filter((r) => (!r.addedByAmendmentId || r.addedBy?.status === "SIGNED") && !(r.removedByAmendmentId && r.removedBy?.status === "SIGNED"));
  return rows.map((r) => ({
    contractDriverId: r.id,
    role: r.role as "PRIMARY_DRIVER" | "ADDITIONAL_DRIVER",
    firstName: r.firstName,
    lastName: r.lastName,
    birthDate: r.birthDate,
    customerId: r.customerId,
    licenseNumber: r.licenseNumber,
    licenseClass: r.licenseClass,
    licenseCountry: r.licenseCountry,
    licenseIssuedAt: r.licenseIssuedAt,
    licenseValidUntil: r.licenseValidUntil,
  }));
}

/** Befehl 25: Fahrer, die ein Nachtrag im Entwurf neu aufnimmt – sie müssen vor der Unterschrift geprüft sein. */
export async function amendmentDriversFor(tenantId: string, amendmentId: string, client: Tx | typeof db = db): Promise<RequiredDriver[]> {
  const rows = await client.contractDriver.findMany({ where: { tenantId, addedByAmendmentId: amendmentId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ contractDriverId: r.id, role: r.role as "PRIMARY_DRIVER" | "ADDITIONAL_DRIVER", firstName: r.firstName, lastName: r.lastName, birthDate: r.birthDate, customerId: r.customerId, licenseNumber: r.licenseNumber, licenseClass: r.licenseClass, licenseCountry: r.licenseCountry, licenseIssuedAt: r.licenseIssuedAt, licenseValidUntil: r.licenseValidUntil }));
}

// ---------------------------------------------------------------------------
// Prüfvermerk: Anlegen, Identität, Führerschein, Bestätigen, Blockieren
// ---------------------------------------------------------------------------

export type VerificationRow = Prisma.DriverVerificationGetPayload<object>;

/**
 * Befehl 25: Kontext einer Fahrerprüfung – die Übergabe (Entwurf) oder ein Nachtrag im Entwurf (Zusatzfahrer während
 * laufender Miete). Ein string ist die Protokoll-Id (bisherige Aufrufe bleiben unverändert).
 */
export type VerificationScope = string | { amendmentId: string };
type OpenContext = { bookingId: string; contractId: string; handoverId: string | null; amendmentId: string | null; /** geplante Rückgabe, gegen die der Führerschein-Ablauf geprüft wird; null = offenes Mietende (Unfallersatz), dann nur „abgelaufen“ */ endAt: Date | null };
const scopeOf = (v: { handoverId: string | null; amendmentId: string | null }): VerificationScope => (v.handoverId ? v.handoverId : { amendmentId: v.amendmentId! });
const scopeWhere = (scope: VerificationScope): Prisma.DriverVerificationWhereInput => (typeof scope === "string" ? { handoverId: scope } : { amendmentId: scope.amendmentId });
/** Referenzprüfungen: alle bestätigten Vermerke außerhalb dieses Kontexts (auch die aus Übergaben bzw. Nachträgen). */
const excludeScopeWhere = (scope: VerificationScope): Prisma.DriverVerificationWhereInput => (typeof scope === "string" ? { OR: [{ handoverId: null }, { handoverId: { not: scope } }] } : { OR: [{ amendmentId: null }, { amendmentId: { not: scope.amendmentId } }] });

async function loadOpenContext(tx: Tx | typeof db, tenantId: string, scope: VerificationScope): Promise<OpenContext> {
  if (typeof scope === "string") {
    const h = await tx.handover.findFirst({ where: { id: scope, tenantId }, select: { id: true, status: true, type: true, bookingId: true, contractId: true, booking: { select: { endAt: true } } } });
    if (!h) throw new DomainError("Protokoll nicht gefunden.");
    if (h.status !== "DRAFT") throw new ImmutableError("Das Protokoll ist finalisiert. Fahrerprüfungen können nicht mehr geändert werden.");
    if (h.type !== "PICKUP") throw new DomainError("Die Fahrerprüfung gehört zur Übergabe, nicht zur Rückgabe.");
    if (!h.contractId) throw new DomainError("Zu diesem Protokoll gehört kein Mietvertrag.");
    // Befehl 29 Phase E: geschlossener Unfallersatzfall – auch die Fahrerprüfung der Übergabe ist gesperrt
    if (await accidentCaseClosed(tx, tenantId, h.bookingId)) throw new DomainError(ACCIDENT_CASE_CLOSED_MESSAGE);
    return { bookingId: h.bookingId, contractId: h.contractId, handoverId: h.id, amendmentId: null, endAt: h.booking.endAt };
  }
  const a = await tx.contractAmendment.findFirst({ where: { id: scope.amendmentId, tenantId }, select: { id: true, status: true, bookingId: true, contractId: true, newEndAt: true, booking: { select: { endAt: true } } } });
  if (!a) throw new DomainError("Nachtrag nicht gefunden.");
  if (a.status !== "DRAFT") throw new ImmutableError("Der Nachtrag ist unterschrieben oder verworfen. Fahrerprüfungen können nicht mehr geändert werden.");
  if (await accidentCaseClosed(tx, tenantId, a.bookingId)) throw new DomainError(ACCIDENT_CASE_CLOSED_MESSAGE);
  return { bookingId: a.bookingId, contractId: a.contractId, handoverId: null, amendmentId: a.id, endAt: a.newEndAt ?? a.booking.endAt };
}

/** Legt den Prüfvermerk eines Fahrers an oder liefert den bestehenden Entwurf zurück; füllt aus dem Vertrags-Snapshot vor. */
export async function startOrGetVerification(tenantId: string, actor: Actor, scope: VerificationScope, contractDriverId: string): Promise<VerificationRow> {
  return db.$transaction(async (tx) => {
    const h = await loadOpenContext(tx, tenantId, scope);
    const existing = await tx.driverVerification.findFirst({ where: { tenantId, ...scopeWhere(scope), contractDriverId }, orderBy: { version: "desc" } });
    if (existing && existing.status !== "CONFIRMED") return existing;
    if (existing && existing.status === "CONFIRMED") return existing; // bestätigt: unverändert anzeigen, keine neue Fassung ohne Anlass

    const driver = await tx.contractDriver.findFirst({ where: { id: contractDriverId, tenantId, contractId: h.contractId } });
    if (!driver) throw new DomainError("Der Fahrer gehört nicht zu diesem Mietvertrag.");
    const row = await tx.driverVerification.create({
      data: {
        tenantId, bookingId: h.bookingId, contractId: h.contractId, handoverId: h.handoverId, amendmentId: h.amendmentId, contractDriverId,
        customerId: driver.customerId, version: 1,
        driverRole: driver.role, driverFirstNameSnapshot: driver.firstName, driverLastNameSnapshot: driver.lastName, driverBirthDateSnapshot: driver.birthDate,
        status: "IN_PROGRESS", createdById: actor.id,
      },
    });
    await recordAudit(tx, tenantId, actor, { action: "DRIVER_VERIFICATION_STARTED", bookingId: h.bookingId, details: { handoverId: h.handoverId, amendmentId: h.amendmentId, contractDriverId, role: driver.role } });
    return row;
  }, TX);
}

function assertEditable(v: { status: string }) {
  if (v.status === "CONFIRMED") throw new ImmutableError("Dieser Prüfvermerk ist bestätigt und kann nicht mehr geändert werden. Eine Korrektur entsteht als neue Fassung.");
}

export type IdentityCheckInput = {
  documentType: string;
  originalSeen: boolean;
  nameMatched: boolean;
  birthDateMatched: boolean;
  notes?: string | null;
};

/** Identitätsprüfung speichern. Ein Namens- oder Geburtsdatumsabgleich, der nicht passt, blockiert automatisch. */
export async function recordIdentityCheck(tenantId: string, actor: Actor, verificationId: string, input: IdentityCheckInput): Promise<VerificationRow> {
  return db.$transaction(async (tx) => {
    const v = await tx.driverVerification.findFirst({ where: { id: verificationId, tenantId } });
    if (!v) throw new DomainError("Prüfvermerk nicht gefunden.");
    assertEditable(v);
    await loadOpenContext(tx, tenantId, scopeOf(v));
    if (!input.originalSeen) throw new DomainError("Ohne Vorlage des Originaldokuments kann die Identität nicht als geprüft gelten.");
    const blocked = !input.nameMatched || !input.birthDateMatched;
    const reasons = new Set(v.blockedReasons);
    if (!input.nameMatched) reasons.add("IDENTITY_NAME_MISMATCH"); else reasons.delete("IDENTITY_NAME_MISMATCH");
    if (!input.birthDateMatched) reasons.add("IDENTITY_BIRTHDATE_MISMATCH"); else reasons.delete("IDENTITY_BIRTHDATE_MISMATCH");
    const row = await tx.driverVerification.update({
      where: { id: v.id },
      data: {
        identityDocumentType: input.documentType, identityOriginalSeen: true, identityNameMatched: input.nameMatched, identityBirthDateMatched: input.birthDateMatched,
        identityCheckedAt: new Date(), identityCheckedById: actor.id, identityCheckedByName: actor.name,
        notes: input.notes ?? v.notes,
        status: blocked ? "BLOCKED" : v.status === "BLOCKED" && reasons.size === 0 ? "IN_PROGRESS" : v.status,
        blockedReasons: [...reasons],
      },
    });
    await recordAudit(tx, tenantId, actor, { action: "DRIVER_IDENTITY_VERIFIED", bookingId: v.bookingId, details: { verificationId: v.id, matched: input.nameMatched && input.birthDateMatched } });
    if (blocked) await recordAudit(tx, tenantId, actor, { action: "DRIVER_VERIFICATION_BLOCKED", bookingId: v.bookingId, details: { verificationId: v.id, reason: "IDENTITY_MISMATCH" } });
    return row;
  }, TX);
}

export type LicenseCheckInput = {
  originalSeen: boolean;
  documentValid: boolean;
  nameMatched: boolean;
  licenseNumber: string;
  licenseCountry: string;
  licenseIssuedAt: Date | null;
  licenseValidUntil: Date | null;
  licenseClasses: string[];
  internationalPermitPresented: boolean;
  translationPresented: boolean;
  manualReviewConfirmed?: boolean;
  deviationConfirmed?: boolean;
  notes?: string | null;
};

/** Führerscheinprüfung speichern: Gültigkeit, Klasse, Abgleich mit Fahrzeuganforderung. Blockiert automatisch bei Mismatch, Ungültigkeit oder fehlender Klasse. */
export async function recordLicenseCheck(tenantId: string, actor: Actor, verificationId: string, input: LicenseCheckInput): Promise<VerificationRow> {
  return db.$transaction(async (tx) => {
    const v = await tx.driverVerification.findFirst({ where: { id: verificationId, tenantId } });
    if (!v) throw new DomainError("Prüfvermerk nicht gefunden.");
    assertEditable(v);
    const h = await loadOpenContext(tx, tenantId, scopeOf(v));
    if (!input.originalSeen) throw new DomainError("Ohne Vorlage des Originalführerscheins kann die Prüfung nicht gespeichert werden.");

    // Rückgabe laut Kontext: im Nachtrag ggf. die verlängerte Rückgabe
    const booking = { ...(await tx.booking.findFirstOrThrow({ where: { id: h.bookingId, tenantId }, select: { vehicleId: true } })), endAt: h.endAt };
    const vehicle = await tx.vehicle.findFirstOrThrow({ where: { id: booking.vehicleId, tenantId }, select: { requiredLicenseClass: true, group: { select: { requiredLicenseClass: true, bodyType: true } } } });
    const requiredClass = requiredLicenseClassFor(vehicle, vehicle.group);
    const classes = [...new Set(input.licenseClasses.map((c) => c.trim().toUpperCase()).filter(Boolean))];
    const classSatisfied = requiredClass ? classSatisfiesRequirement(requiredClass, classes) : classes.length > 0;

    const now = new Date();
    const expiredNow = !!input.licenseValidUntil && input.licenseValidUntil < now;
    const expiresBeforeReturn = !!input.licenseValidUntil && booking.endAt !== null && input.licenseValidUntil < booking.endAt;
    const foreignNeedsManualReview = !isEuEeaChCountry(input.licenseCountry) && !(input.translationPresented || input.internationalPermitPresented);

    const reasons = new Set(v.blockedReasons);
    const set = (key: string, bad: boolean) => { if (bad) reasons.add(key); else reasons.delete(key); };
    set("LICENSE_INVALID", !input.documentValid);
    set("LICENSE_NAME_MISMATCH", !input.nameMatched);
    set("LICENSE_EXPIRED", expiredNow);
    set("LICENSE_EXPIRES_BEFORE_RETURN", expiresBeforeReturn);
    set("LICENSE_CLASS_INSUFFICIENT", requiredClass != null && !classSatisfied);
    set("LICENSE_NO_REQUIRED_CLASS_CONFIGURED", requiredClass == null);
    // Manuelle Prüfung (ausländischer Führerschein ohne Übersetzung/IFS) blockiert nur, solange sie nicht bewusst bestätigt wurde
    set("LICENSE_MANUAL_REVIEW_OPEN", foreignNeedsManualReview && !input.manualReviewConfirmed);
    // Abweichung von den Kundenstammdaten blockiert nur, solange sie nicht bewusst bestätigt wurde
    const customer = v.customerId ? await tx.customer.findFirst({ where: { id: v.customerId, tenantId }, select: { licenseNumber: true, licenseClass: true, licenseValidUntil: true } }) : null;
    const deviates = !!customer && (customer.licenseNumber !== input.licenseNumber || (customer.licenseValidUntil?.getTime() ?? null) !== (input.licenseValidUntil?.getTime() ?? null));
    set("LICENSE_DEVIATES_FROM_CUSTOMER", deviates && !input.deviationConfirmed);

    const blocked = reasons.size > 0;
    const row = await tx.driverVerification.update({
      where: { id: v.id },
      data: {
        licenseOriginalSeen: true, licenseDocumentValid: input.documentValid, licenseNameMatched: input.nameMatched,
        licenseNumberSnapshot: input.licenseNumber, licenseCountrySnapshot: input.licenseCountry.trim().toUpperCase(),
        licenseIssuedAtSnapshot: input.licenseIssuedAt, licenseValidUntilSnapshot: input.licenseValidUntil, licenseClassesSnapshot: classes,
        requiredLicenseClassSnapshot: requiredClass, licenseClassSatisfied: classSatisfied,
        internationalPermitPresented: input.internationalPermitPresented, translationPresented: input.translationPresented,
        manualReviewRequired: foreignNeedsManualReview, manualReviewConfirmed: foreignNeedsManualReview ? !!input.manualReviewConfirmed : null,
        deviatesFromCustomer: deviates, deviationConfirmed: deviates ? !!input.deviationConfirmed : null,
        licenseCheckedAt: now, licenseCheckedById: actor.id, licenseCheckedByName: actor.name,
        notes: input.notes ?? v.notes,
        status: blocked ? "BLOCKED" : "IN_PROGRESS",
        blockedReasons: [...reasons],
      },
    });
    await recordAudit(tx, tenantId, actor, { action: "DRIVER_LICENSE_VERIFIED", bookingId: v.bookingId, details: { verificationId: v.id, requiredClass: requiredClass ?? "", classSatisfied, blocked } });
    if (blocked) await recordAudit(tx, tenantId, actor, { action: "DRIVER_VERIFICATION_BLOCKED", bookingId: v.bookingId, details: { verificationId: v.id, reasons: [...reasons].join(",") } });
    return row;
  }, TX);
}

/** Bestätigt den Prüfvermerk endgültig. Nur möglich, wenn Identität und Führerschein vollständig und ohne offene Blocker geprüft sind. */
export async function confirmVerification(tenantId: string, actor: Actor, verificationId: string): Promise<VerificationRow> {
  return db.$transaction(async (tx) => {
    const v = await tx.driverVerification.findFirst({ where: { id: verificationId, tenantId } });
    if (!v) throw new DomainError("Prüfvermerk nicht gefunden.");
    assertEditable(v);
    await loadOpenContext(tx, tenantId, scopeOf(v));
    if (v.blockedReasons.length > 0) throw new DomainError("Es gibt noch offene Punkte bei diesem Fahrer. Bitte zuerst klären.");
    if (!v.identityOriginalSeen || v.identityNameMatched !== true || v.identityBirthDateMatched !== true) throw new DomainError("Die Identitätsprüfung ist noch nicht vollständig.");
    if (!v.licenseOriginalSeen || v.licenseDocumentValid !== true || v.licenseNameMatched !== true || v.licenseClassSatisfied !== true) throw new DomainError("Die Führerscheinprüfung ist noch nicht vollständig.");
    const content = { driverRole: v.driverRole, identityDocumentType: v.identityDocumentType, identityNameMatched: v.identityNameMatched, identityBirthDateMatched: v.identityBirthDateMatched, licenseNumberSnapshot: v.licenseNumberSnapshot, licenseCountrySnapshot: v.licenseCountrySnapshot, licenseClassesSnapshot: v.licenseClassesSnapshot, licenseValidUntilSnapshot: v.licenseValidUntilSnapshot?.toISOString() ?? null, requiredLicenseClassSnapshot: v.requiredLicenseClassSnapshot };
    const row = await tx.driverVerification.update({ where: { id: v.id }, data: { status: "CONFIRMED", verifiedAt: new Date(), verifiedById: actor.id, verifiedByName: actor.name, contentHash: contentHash(content) } });
    await recordAudit(tx, tenantId, actor, { action: "DRIVER_VERIFICATION_COMPLETED", bookingId: v.bookingId, details: { verificationId: v.id, driver: `${v.driverFirstNameSnapshot} ${v.driverLastNameSnapshot}` } });
    return row;
  }, TX);
}

/** Klartext der Blocker (Oberfläche und Rückmeldung der Aktionen). */
export const DRIVER_BLOCKER_LABELS: Record<string, string> = {
  IDENTITY_NAME_MISMATCH: "Identität: Name stimmt nicht überein.",
  IDENTITY_BIRTHDATE_MISMATCH: "Identität: Geburtsdatum stimmt nicht überein.",
  LICENSE_INVALID: "Führerschein: als ungültig markiert.",
  LICENSE_NAME_MISMATCH: "Führerschein: Name stimmt nicht überein.",
  LICENSE_EXPIRED: "Führerschein: abgelaufen.",
  LICENSE_EXPIRES_BEFORE_RETURN: "Führerschein: läuft vor der geplanten Rückgabe ab.",
  LICENSE_CLASS_INSUFFICIENT: "Führerschein: erforderliche Fahrerlaubnisklasse fehlt.",
  LICENSE_NO_REQUIRED_CLASS_CONFIGURED: "Für dieses Fahrzeug ist keine erforderliche Fahrerlaubnisklasse hinterlegt. Bitte in den Fahrzeug- oder Gruppendaten konfigurieren.",
  LICENSE_MANUAL_REVIEW_OPEN: "Ausländischer Führerschein: manuelle Prüfung noch nicht bestätigt.",
  LICENSE_DEVIATES_FROM_CUSTOMER: "Die vorgelegten Daten unterscheiden sich von den Kundendaten und sind noch nicht bestätigt.",
};

// ---------------------------------------------------------------------------
// Befehl 21: Prüfung in einem Vorgang (ein Knopf statt „Identität speichern“ / „Führerschein speichern“ / „bestätigen“)
// ---------------------------------------------------------------------------
//
// Der Mitarbeiter lässt sich Ausweis und Führerschein im Original zeigen, vergleicht und bestätigt einmal. Der Server
// führt dafür dieselben drei Schritte aus wie bisher – Identität, Führerschein, Bestätigung – mit denselben Prüfungen
// (Ablauf, Klasse, ausländischer Führerschein, Abweichung von den Kundendaten) und demselben Audit. Verletzt der
// Führerschein eine Regel, wird NICHT bestätigt: der Vermerk bleibt blockiert und nennt die Gründe.

export type OneStepCheckInput = {
  documentType: string;
  licenseNumber: string;
  licenseCountry: string;
  licenseIssuedAt: Date | null;
  licenseValidUntil: Date | null;
  licenseClasses: string[];
  internationalPermitPresented: boolean;
  translationPresented: boolean;
  manualReviewConfirmed?: boolean;
  deviationConfirmed?: boolean;
  notes?: string | null;
};

export async function verifyDriverInOneStep(tenantId: string, actor: Actor, handoverId: VerificationScope, contractDriverId: string, input: OneStepCheckInput): Promise<{ row: VerificationRow; confirmed: boolean; blockers: string[] }> {
  const started = await startOrGetVerification(tenantId, actor, handoverId, contractDriverId);
  if (started.status === "CONFIRMED") return { row: started, confirmed: true, blockers: [] };
  await recordIdentityCheck(tenantId, actor, started.id, { documentType: input.documentType, originalSeen: true, nameMatched: true, birthDateMatched: true, notes: input.notes ?? null });
  const checked = await recordLicenseCheck(tenantId, actor, started.id, {
    originalSeen: true, documentValid: true, nameMatched: true,
    licenseNumber: input.licenseNumber, licenseCountry: input.licenseCountry, licenseIssuedAt: input.licenseIssuedAt, licenseValidUntil: input.licenseValidUntil, licenseClasses: input.licenseClasses,
    internationalPermitPresented: input.internationalPermitPresented, translationPresented: input.translationPresented,
    manualReviewConfirmed: input.manualReviewConfirmed, deviationConfirmed: input.deviationConfirmed, notes: input.notes ?? null,
  });
  if (checked.blockedReasons.length > 0) return { row: checked, confirmed: false, blockers: checked.blockedReasons };
  const row = await confirmVerification(tenantId, actor, started.id);
  return { row, confirmed: true, blockers: [] };
}

// ---------------------------------------------------------------------------
// Befehl 20.9: Wiederholungsprüfung bekannter Fahrer (dokumentierte Sichtprüfung, keine blinde Wiederverwendung)
// ---------------------------------------------------------------------------
//
// Ein Fahrer, der bei einer früheren Übergabe vollständig geprüft wurde, muss seine Stammdaten nicht erneut erfassen. Die
// konkrete Übergabe braucht trotzdem einen eigenen Prüfvermerk: der Mitarbeiter bestätigt, dass die Originale vorgelegt
// wurden, die gespeicherten Daten unverändert sind, die erforderliche Klasse vorliegt und die Dokumente gültig sind.
// Der Server prüft dieselben Regeln wie bei der vollständigen Prüfung (Ablauf, Klasse, manuelle Prüfung ausländischer
// Führerscheine, Konsistenz mit Vertrag und Kundenstammdaten) und legt einen NEUEN Vermerk (checkKind REPEAT) an, der auf
// den Referenzvermerk verweist. Der alte Vermerk bleibt unverändert.

export type RepeatReference = {
  verificationId: string;
  verifiedAt: Date | null;
  verifiedByName: string | null;
  bookingNumber: string;
  identityDocumentType: string | null;
  licenseClasses: string[];
  licenseValidUntil: Date | null;
  licenseCountry: string | null;
  /** Schnellbestätigung möglich; sonst die Gründe (werden beim Bestätigen serverseitig erneut geprüft) */
  eligible: boolean;
  reasons: string[];
};

type ReferenceRow = Prisma.DriverVerificationGetPayload<{ include: { booking: { select: { number: true } } } }>;

/** Jüngster vollständig bestätigter Prüfvermerk desselben Fahrers aus einer anderen Übergabe (per Kunde, sonst per Name + Geburtsdatum). */
async function latestConfirmedReference(client: Tx | typeof db, tenantId: string, driver: Pick<RequiredDriver, "customerId" | "firstName" | "lastName" | "birthDate">, excludeScope: VerificationScope): Promise<ReferenceRow | null> {
  const where: Prisma.DriverVerificationWhereInput = driver.customerId
    ? { tenantId, customerId: driver.customerId, status: "CONFIRMED", ...excludeScopeWhere(excludeScope) }
    : { tenantId, status: "CONFIRMED", ...excludeScopeWhere(excludeScope), driverFirstNameSnapshot: driver.firstName, driverLastNameSnapshot: driver.lastName, driverBirthDateSnapshot: driver.birthDate };
  return client.driverVerification.findFirst({ where, orderBy: [{ verifiedAt: "desc" }, { createdAt: "desc" }], include: { booking: { select: { number: true } } } });
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Gründe, aus denen die Schnellbestätigung NICHT zulässig ist. Leer = zulässig. Reine Regeln, keine Datenbank. */
export function repeatCheckReasons(ref: VerificationRow, driver: Pick<RequiredDriver, "firstName" | "lastName" | "birthDate" | "licenseNumber">, requiredClass: string | null, bookingEnd: Date | null, customer: { licenseNumber: string | null; licenseValidUntil: Date | null } | null, now = new Date()): string[] {
  const reasons: string[] = [];
  if (ref.status !== "CONFIRMED") reasons.push("Die letzte Prüfung ist nicht bestätigt.");
  if (norm(ref.driverFirstNameSnapshot) !== norm(driver.firstName) || norm(ref.driverLastNameSnapshot) !== norm(driver.lastName) || ref.driverBirthDateSnapshot.getTime() !== driver.birthDate.getTime()) reasons.push("Name oder Geburtsdatum weichen von der letzten Prüfung ab.");
  if (!ref.identityOriginalSeen || ref.identityNameMatched !== true || ref.identityBirthDateMatched !== true) reasons.push("Die letzte Identitätsprüfung ist nicht vollständig gespeichert.");
  if (!ref.licenseOriginalSeen || ref.licenseDocumentValid !== true || ref.licenseNameMatched !== true || !ref.licenseNumberSnapshot || ref.licenseClassesSnapshot.length === 0) reasons.push("Die letzte Führerscheinprüfung ist nicht vollständig gespeichert.");
  if (ref.licenseValidUntilSnapshot && ref.licenseValidUntilSnapshot < now) reasons.push("Der zuletzt geprüfte Führerschein ist abgelaufen.");
  else if (ref.licenseValidUntilSnapshot && bookingEnd && ref.licenseValidUntilSnapshot < bookingEnd) reasons.push("Der zuletzt geprüfte Führerschein läuft vor der geplanten Rückgabe ab.");
  if (!requiredClass) reasons.push("Für dieses Fahrzeug ist keine erforderliche Fahrerlaubnisklasse hinterlegt.");
  else if (!classSatisfiesRequirement(requiredClass, ref.licenseClassesSnapshot)) reasons.push(`Die für dieses Fahrzeug erforderliche Fahrerlaubnisklasse ${requiredClass} fehlt in der letzten Prüfung.`);
  if (ref.manualReviewRequired && ref.manualReviewConfirmed !== true) reasons.push("Ausländischer Führerschein: die manuelle Prüfung ist nicht bestätigt.");
  if (ref.licenseNumberSnapshot && driver.licenseNumber && norm(ref.licenseNumberSnapshot) !== norm(driver.licenseNumber)) reasons.push("Die Führerscheinnummer im Vertrag weicht von der letzten Prüfung ab.");
  if (customer && (norm(customer.licenseNumber) !== norm(ref.licenseNumberSnapshot) || (customer.licenseValidUntil?.getTime() ?? null) !== (ref.licenseValidUntilSnapshot?.getTime() ?? null))) reasons.push("Die Kundenstammdaten stimmen nicht mit der letzten Prüfung überein.");
  return reasons;
}

function toReference(ref: ReferenceRow, reasons: string[]): RepeatReference {
  return { verificationId: ref.id, verifiedAt: ref.verifiedAt, verifiedByName: ref.verifiedByName, bookingNumber: ref.booking.number, identityDocumentType: ref.identityDocumentType, licenseClasses: ref.licenseClassesSnapshot, licenseValidUntil: ref.licenseValidUntilSnapshot, licenseCountry: ref.licenseCountrySnapshot, eligible: reasons.length === 0, reasons };
}

export type RepeatConfirmations = { originalsPresented: boolean; identityChecked: boolean; licensePresented: boolean; dataUnchanged: boolean; classSufficient: boolean; documentsValid: boolean };

/**
 * Wiederholungsprüfung bestätigen: legt für DIESE Übergabe einen eigenen, sofort bestätigten Prüfvermerk an (Fahrer,
 * Buchung/Übergabe, Zeitpunkt, Mitarbeiter, Referenz + Snapshot der verwendeten Daten, Prüfart REPEAT).
 */
export async function repeatVerification(tenantId: string, actor: Actor, handoverId: VerificationScope, contractDriverId: string, confirmations: RepeatConfirmations): Promise<VerificationRow> {
  if (!Object.values(confirmations).every(Boolean)) throw new DomainError("Bitte alle Punkte bestätigen: Originale vorgelegt, Identität geprüft, Führerschein vorgelegt, Daten unverändert, Klasse vorhanden, Dokumente gültig.");
  return db.$transaction(async (tx) => {
    const h = await loadOpenContext(tx, tenantId, handoverId);
    const driver = await tx.contractDriver.findFirst({ where: { id: contractDriverId, tenantId, contractId: h.contractId } });
    if (!driver) throw new DomainError("Der Fahrer gehört nicht zu diesem Mietvertrag.");
    const existing = await tx.driverVerification.findFirst({ where: { tenantId, ...scopeWhere(handoverId), contractDriverId }, orderBy: { version: "desc" } });
    if (existing?.status === "CONFIRMED") return existing;
    if (existing) throw new DomainError("Für diesen Fahrer wurde bereits die vollständige Prüfung begonnen. Bitte dort fortsetzen.");

    const booking = { ...(await tx.booking.findFirstOrThrow({ where: { id: h.bookingId, tenantId }, select: { vehicleId: true } })), endAt: h.endAt };
    const vehicle = await tx.vehicle.findFirstOrThrow({ where: { id: booking.vehicleId, tenantId }, select: { requiredLicenseClass: true, group: { select: { requiredLicenseClass: true, bodyType: true } } } });
    const requiredClass = requiredLicenseClassFor(vehicle, vehicle.group);
    const ref = await latestConfirmedReference(tx, tenantId, driver, handoverId);
    if (!ref) throw new DomainError("Für diesen Fahrer gibt es keine frühere vollständige Prüfung. Bitte die vollständige Prüfung durchführen.");
    const customer = driver.customerId ? await tx.customer.findFirst({ where: { id: driver.customerId, tenantId }, select: { licenseNumber: true, licenseValidUntil: true } }) : null;
    const reasons = repeatCheckReasons(ref, driver, requiredClass, booking.endAt, customer);
    if (reasons.length > 0) throw new DomainError(`Schnellbestätigung nicht möglich: ${reasons.join(" ")} Bitte die vollständige Prüfung durchführen.`);

    const now = new Date();
    const content = {
      checkKind: "REPEAT", basedOnVerificationId: ref.id, driverRole: driver.role, identityDocumentType: ref.identityDocumentType, identityNameMatched: true, identityBirthDateMatched: true,
      licenseNumberSnapshot: ref.licenseNumberSnapshot, licenseCountrySnapshot: ref.licenseCountrySnapshot, licenseClassesSnapshot: ref.licenseClassesSnapshot, licenseValidUntilSnapshot: ref.licenseValidUntilSnapshot?.toISOString() ?? null, requiredLicenseClassSnapshot: requiredClass,
    };
    const row = await tx.driverVerification.create({
      data: {
        tenantId, bookingId: h.bookingId, contractId: h.contractId, handoverId: h.handoverId, amendmentId: h.amendmentId, contractDriverId, customerId: driver.customerId, version: 1,
        checkKind: "REPEAT", basedOnVerificationId: ref.id,
        driverRole: driver.role, driverFirstNameSnapshot: driver.firstName, driverLastNameSnapshot: driver.lastName, driverBirthDateSnapshot: driver.birthDate,
        status: "CONFIRMED",
        identityDocumentType: ref.identityDocumentType, identityOriginalSeen: true, identityNameMatched: true, identityBirthDateMatched: true, identityCheckedAt: now, identityCheckedById: actor.id, identityCheckedByName: actor.name,
        licenseOriginalSeen: true, licenseDocumentValid: true, licenseNameMatched: true,
        licenseNumberSnapshot: ref.licenseNumberSnapshot, licenseCountrySnapshot: ref.licenseCountrySnapshot, licenseIssuedAtSnapshot: ref.licenseIssuedAtSnapshot, licenseValidUntilSnapshot: ref.licenseValidUntilSnapshot, licenseClassesSnapshot: ref.licenseClassesSnapshot,
        requiredLicenseClassSnapshot: requiredClass, licenseClassSatisfied: true,
        internationalPermitPresented: ref.internationalPermitPresented, translationPresented: ref.translationPresented, manualReviewRequired: ref.manualReviewRequired, manualReviewConfirmed: ref.manualReviewRequired ? true : null,
        deviatesFromCustomer: false, deviationConfirmed: null, licenseCheckedAt: now, licenseCheckedById: actor.id, licenseCheckedByName: actor.name,
        verifiedAt: now, verifiedById: actor.id, verifiedByName: actor.name, blockedReasons: [],
        notes: `Wiederholungsprüfung (Sichtprüfung): Originale vorgelegt, gespeicherte Daten unverändert. Grundlage: vollständige Prüfung vom ${ref.verifiedAt ? ref.verifiedAt.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }) : "–"} (Buchung ${ref.booking.number}).`,
        contentHash: contentHash(content), createdById: actor.id,
      },
    });
    await recordAudit(tx, tenantId, actor, { action: "DRIVER_VERIFICATION_REPEATED", bookingId: h.bookingId, details: { verificationId: row.id, basedOnVerificationId: ref.id, referenceBooking: ref.booking.number, driver: `${driver.firstName} ${driver.lastName}`, handoverId, requiredClass: requiredClass ?? "" } });
    return row;
  }, TX);
}

// ---------------------------------------------------------------------------
// Stand für den Übergabe-Assistenten und den Abschluss-Blocker
// ---------------------------------------------------------------------------

export type DriverVerificationView = { driver: RequiredDriver; verification: VerificationRow | null; status: "NOT_STARTED" | "IN_PROGRESS" | "CONFIRMED" | "BLOCKED"; requiredLicenseClass: string | null; customerDeviates: boolean; /** Befehl 20.9: frühere vollständige Prüfung (nur solange hier keine Prüfung begonnen wurde) */ repeat: RepeatReference | null };

/** Vollständiger Stand: jeder laut Vertrag vorgesehene Fahrer mit seinem aktuellen Prüfvermerk (falls vorhanden). */
export async function driverVerificationOverview(tenantId: string, handoverId: VerificationScope, client: Tx | typeof db = db): Promise<DriverVerificationView[]> {
  // Befehl 25: im Nachtrag sind nur die durch diesen Nachtrag aufgenommenen Fahrer zu prüfen (Rückgabe = ggf. verlängerte)
  const h = typeof handoverId === "string"
    ? await client.handover.findFirst({ where: { id: handoverId, tenantId }, select: { contractId: true, bookingId: true } })
    : await client.contractAmendment.findFirst({ where: { id: handoverId.amendmentId, tenantId }, select: { contractId: true, bookingId: true, newEndAt: true } });
  if (!h?.contractId) return [];
  const [drivers, verifications, booking0] = await Promise.all([
    typeof handoverId === "string" ? requiredDriversFor(tenantId, h.contractId, client) : amendmentDriversFor(tenantId, handoverId.amendmentId, client),
    client.driverVerification.findMany({ where: { tenantId, ...scopeWhere(handoverId) }, orderBy: { version: "desc" } }),
    client.booking.findFirst({ where: { id: h.bookingId, tenantId }, select: { vehicleId: true, endAt: true } }),
  ]);
  const amendedEnd: Date | null = "newEndAt" in h ? (h.newEndAt as Date | null) : null;
  const booking = booking0 ? { ...booking0, endAt: amendedEnd ?? booking0.endAt } : null;
  const vehicle = booking ? await client.vehicle.findFirst({ where: { id: booking.vehicleId, tenantId }, select: { requiredLicenseClass: true, group: { select: { requiredLicenseClass: true, bodyType: true } } } }) : null;
  const requiredClass = vehicle ? requiredLicenseClassFor(vehicle, vehicle.group) : null;
  const byDriver = new Map<string, VerificationRow>();
  for (const v of verifications) if (!byDriver.has(v.contractDriverId)) byDriver.set(v.contractDriverId, v); // erste = höchste Fassung (desc sortiert)
  const out: DriverVerificationView[] = [];
  for (const driver of drivers) {
    const verification = byDriver.get(driver.contractDriverId) ?? null;
    const status: DriverVerificationView["status"] = !verification ? "NOT_STARTED" : verification.status === "CONFIRMED" ? "CONFIRMED" : verification.status === "BLOCKED" ? "BLOCKED" : "IN_PROGRESS";
    let repeat: RepeatReference | null = null;
    if (!verification && booking) {
      const ref = await latestConfirmedReference(client, tenantId, driver, handoverId);
      if (ref) {
        const customer = driver.customerId ? await client.customer.findFirst({ where: { id: driver.customerId, tenantId }, select: { licenseNumber: true, licenseValidUntil: true } }) : null;
        repeat = toReference(ref, repeatCheckReasons(ref, driver, requiredClass, booking.endAt, customer));
      }
    }
    out.push({ driver, verification, status, requiredLicenseClass: requiredClass, customerDeviates: verification?.deviatesFromCustomer ?? false, repeat });
  }
  return out;
}

/** Blocker für den Übergabeabschluss: jeder vorgesehene Fahrer, der nicht bestätigt ist. Serverseitig, kein reiner UI-Hinweis.
 *  Nimmt optional den Transaktions-Client entgegen, damit der Aufruf innerhalb von finalizeHandover keine zweite
 *  Datenbankverbindung braucht (sonst blockiert sich die Transaktion bei knappem Verbindungslimit selbst). */
export async function driverVerificationBlockers(tenantId: string, handoverId: VerificationScope, client: Tx | typeof db = db): Promise<{ code: string; message: string }[]> {
  const overview = await driverVerificationOverview(tenantId, handoverId, client);
  const before = typeof handoverId === "string" ? "bevor übergeben werden kann" : "bevor der Nachtrag unterschrieben werden kann";
  return overview.filter((o) => o.status !== "CONFIRMED").map((o) => {
    const who = `${o.driver.firstName} ${o.driver.lastName}`;
    if (o.status === "BLOCKED") return { code: "DRIVER_BLOCKED", message: `${who}: Prüfung ist blockiert und muss geklärt werden, ${before}.` };
    if (o.status === "IN_PROGRESS") return { code: "DRIVER_INCOMPLETE", message: `${who}: Identitäts- oder Führerscheinprüfung ist noch nicht vollständig.` };
    // Befehl 20.9: bekannter Fahrer – die Stammdaten liegen vor, nur die Bestätigung für diese Übergabe fehlt
    if (o.repeat) return { code: "DRIVER_NOT_VERIFIED", message: `${who}: Dokumente für diese Übergabe noch nicht bestätigt.` };
    return { code: "DRIVER_NOT_VERIFIED", message: `${who}: Identität und Führerschein sind noch nicht geprüft.` };
  });
}

// ---------------------------------------------------------------------------
// Kundenstammdaten: bewusste, separate Übernahme – nie automatisch
// ---------------------------------------------------------------------------

/** Übernimmt die bei dieser Prüfung erfassten Führerscheindaten bewusst in die Kundenstammdaten. Getrennter Aufruf, eigene Rollenprüfung beim Aufrufer. */
export async function updateCustomerLicenseFromVerification(tenantId: string, actor: Actor, verificationId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const v = await tx.driverVerification.findFirst({ where: { id: verificationId, tenantId } });
    if (!v) throw new DomainError("Prüfvermerk nicht gefunden.");
    if (!v.customerId) throw new DomainError("Dieser Fahrer ist keinem Kundenstammdatensatz zugeordnet.");
    if (!v.licenseOriginalSeen) throw new DomainError("Der Führerschein wurde für diese Übergabe noch nicht geprüft.");
    await tx.customer.updateMany({ where: { id: v.customerId, tenantId }, data: { licenseNumber: v.licenseNumberSnapshot, licenseClass: v.licenseClassesSnapshot.join(", "), licenseIssuedAt: v.licenseIssuedAtSnapshot, licenseValidUntil: v.licenseValidUntilSnapshot } });
    await recordAudit(tx, tenantId, actor, { action: "CUSTOMER_LICENSE_UPDATED_FROM_VERIFICATION", bookingId: v.bookingId, details: { verificationId: v.id, customerId: v.customerId } });
  }, TX);
}

// ---------------------------------------------------------------------------
// Dokumentkopien: getrennt von der Prüfung, optional, mit Zweckbindung und Kennzeichnung
// ---------------------------------------------------------------------------

export type RecordCopyInput = {
  bookingId: string;
  handoverId: string;
  verificationId: string;
  contractDriverId: string;
  documentKind: "IDENTITY" | "LICENSE";
  side: "FRONT" | "BACK";
  bytes: Uint8Array;
  consent?: { given: boolean };
};

/** Speichert eine Dokumentkopie: Bildtyp am Inhalt erkannt, serverseitig als Kopie gestempelt, Personalausweis nur mit dokumentierter Zustimmung. */
export async function recordDriverDocumentCopy(tenantId: string, actor: Actor, input: RecordCopyInput) {
  if (input.bytes.length <= 0) throw new DomainError("Die Datei ist leer.");
  if (input.bytes.length > MAX_PHOTO_BYTES) throw new DomainError("Die Datei ist zu groß (maximal 8 MB).");
  const contentType = sniffImageType(input.bytes);
  if (!contentType) throw new DomainError("Bitte ein Foto im Format JPEG, PNG oder WebP aufnehmen.");

  const v = await db.driverVerification.findFirst({ where: { id: input.verificationId, tenantId } });
  if (!v) throw new DomainError("Prüfvermerk nicht gefunden.");
  if (v.handoverId !== input.handoverId || v.bookingId !== input.bookingId || v.contractDriverId !== input.contractDriverId) throw new DomainError("Der Prüfvermerk gehört nicht zu dieser Übergabe oder diesem Fahrer.");
  const handover = await db.handover.findFirst({ where: { id: input.handoverId, tenantId }, select: { status: true } });
  if (!handover) throw new DomainError("Protokoll nicht gefunden.");
  if (handover.status !== "DRAFT") throw new ImmutableError("Das Protokoll ist finalisiert. Es können keine Dokumentkopien mehr hinzugefügt werden.");
  // Befehl 29 Phase E: keine Dokumentkopien zu einem geschlossenen Unfallersatzfall (vor dem Speichern der Datei)
  if (await accidentCaseClosed(db, tenantId, input.bookingId)) throw new DomainError(ACCIDENT_CASE_CLOSED_MESSAGE);

  const consentRequired = input.documentKind === "IDENTITY";
  if (consentRequired && !input.consent?.given) throw new DomainError("Für die Speicherung einer Personalausweiskopie ist die Zustimmung des Ausweisinhabers erforderlich.");

  const label = `KOPIE – RENTBASE / VERMIETVORGANG ${input.bookingId.slice(-8).toUpperCase()}`;
  const stamped = await stampAsCopy(input.bytes, label);
  const storage = getStorage();
  const storageKey = buildStorageKey({ tenantId, area: "driver-verifications", bookingId: input.bookingId, contentType: "image/jpeg" });
  await storage.put(storageKey, stamped.bytes, "image/jpeg");
  try {
    const row = await db.$transaction(async (tx) => {
      const fresh = await tx.driverVerification.findFirst({ where: { id: input.verificationId, tenantId } });
      if (!fresh) throw new DomainError("Prüfvermerk nicht gefunden.");
      assertEditable(fresh);
      const copy = await tx.driverDocumentCopy.create({
        data: {
          tenantId, bookingId: input.bookingId, handoverId: input.handoverId, verificationId: input.verificationId, contractDriverId: input.contractDriverId,
          documentKind: input.documentKind, side: input.side, storageKey, contentType: "image/jpeg", sizeBytes: stamped.bytes.length, checksum: stamped.checksum,
          width: stamped.width ?? null, height: stamped.height ?? null, markedAsCopy: true,
          purposeSnapshot: "Nachweis der Fahrer- und Fahrerlaubnisprüfung zum Vermietvorgang (Mietvertrag); keine Weitergabe an Dritte.",
          consentRequired, consentGiven: consentRequired ? true : false, consentAt: consentRequired ? new Date() : null,
          consentRecordedById: consentRequired ? actor.id : null, consentRecordedByName: consentRequired ? actor.name : null,
          createdById: actor.id, createdByName: actor.name,
        },
      });
      if (consentRequired) await recordAudit(tx, tenantId, actor, { action: "DOCUMENT_COPY_CONSENT_RECORDED", bookingId: input.bookingId, details: { copyId: copy.id, documentKind: input.documentKind } });
      await recordAudit(tx, tenantId, actor, { action: "DRIVER_DOCUMENT_UPLOADED", bookingId: input.bookingId, details: { copyId: copy.id, documentKind: input.documentKind, side: input.side } });
      return copy;
    }, TX);
    return row;
  } catch (e) {
    await storage.remove(storageKey).catch(() => {});
    throw e;
  }
}

/** Liest eine Dokumentkopie für die geschützte Auslieferung; prüft Mandant, Buchungszugehörigkeit und dass sie nicht gelöscht ist. */
export async function readDriverDocumentCopy(tenantId: string, copyId: string) {
  const row = await db.driverDocumentCopy.findFirst({ where: { id: copyId, tenantId } });
  if (!row || row.deletionStatus === "DELETED") return null;
  assertKeyBelongsToTenant(row.storageKey, tenantId);
  const obj = await getStorage().get(row.storageKey);
  if (!obj) return null;
  return { row, body: obj.body, contentType: row.contentType };
}

/** Löscht eine Dokumentkopie datenschutzgerecht (Datei entfernt, Zeile bleibt als Nachweis). Der Prüfvermerk selbst bleibt unberührt. */
export async function deleteDriverDocumentCopy(tenantId: string, actor: Actor, copyId: string, reason: string) {
  const row = await db.driverDocumentCopy.findFirst({ where: { id: copyId, tenantId } });
  if (!row) throw new DomainError("Dokumentkopie nicht gefunden.");
  if (row.deletionStatus === "DELETED") return row;
  await getStorage().remove(row.storageKey).catch(() => {});
  return db.$transaction(async (tx) => {
    const updated = await tx.driverDocumentCopy.update({ where: { id: row.id }, data: { deletionStatus: "DELETED", deletedAt: new Date(), deletedById: actor.id, deletedByName: actor.name, deletionReason: reason } });
    await recordAudit(tx, tenantId, actor, { action: "DRIVER_DOCUMENT_DELETED", bookingId: row.bookingId, details: { copyId: row.id, reason } });
    return updated;
  }, TX);
}

/** Dokumentkopien einer Übergabe (für die Anzeige im Assistenten). */
export function listDriverDocumentCopies(tenantId: string, handoverId: string) {
  return db.driverDocumentCopy.findMany({ where: { tenantId, handoverId, deletionStatus: "ACTIVE" }, orderBy: { createdAt: "asc" } });
}

export type DriverDocumentHistoryEntry = {
  verificationId: string;
  bookingId: string;
  bookingNumber: string;
  driverName: string;
  driverRole: "PRIMARY_DRIVER" | "ADDITIONAL_DRIVER";
  status: "IN_PROGRESS" | "CONFIRMED" | "BLOCKED";
  verifiedAt: Date | null;
  copies: { id: string; documentKind: "IDENTITY" | "LICENSE"; side: "FRONT" | "BACK"; createdAt: Date }[];
};

/** Verlauf der Ausweis-/Führerscheinkopien eines Kunden über alle Vermietvorgänge – rein lesend für die Kundenakte.
 *  Jede Kopie bleibt zweckgebunden an ihren jeweiligen Vermietvorgang; hier wird nur eine Übersicht angezeigt, es
 *  wird nichts wiederverwendet oder in einen neuen Vorgang übernommen. */
export async function driverDocumentHistoryForCustomer(tenantId: string, customerId: string): Promise<DriverDocumentHistoryEntry[]> {
  const verifications = await db.driverVerification.findMany({
    where: { tenantId, customerId },
    orderBy: { createdAt: "desc" },
    include: { documentCopies: { where: { deletionStatus: "ACTIVE" }, orderBy: { createdAt: "asc" } }, booking: { select: { number: true } } },
  });
  return verifications
    .filter((v) => v.documentCopies.length > 0)
    .map((v) => ({
      verificationId: v.id,
      bookingId: v.bookingId,
      bookingNumber: v.booking.number,
      driverName: `${v.driverFirstNameSnapshot} ${v.driverLastNameSnapshot}`,
      driverRole: v.driverRole as "PRIMARY_DRIVER" | "ADDITIONAL_DRIVER",
      status: v.status as "IN_PROGRESS" | "CONFIRMED" | "BLOCKED",
      verifiedAt: v.verifiedAt,
      copies: v.documentCopies.map((c) => ({ id: c.id, documentKind: c.documentKind as "IDENTITY" | "LICENSE", side: c.side as "FRONT" | "BACK", createdAt: c.createdAt })),
    }));
}

// ---------------------------------------------------------------------------
// Zusammenfassung für Dokumente (HTML-Vorschau, PDF): nie Dokumentbilder, nie die volle Führerscheinnummer.
// ---------------------------------------------------------------------------

export type DriverCheckSummary = {
  role: "PRIMARY_DRIVER" | "ADDITIONAL_DRIVER";
  name: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "CONFIRMED" | "BLOCKED";
  identityDocumentType: string | null;
  identityOriginalSeen: boolean;
  identityMatched: boolean | null;
  licenseOriginalSeen: boolean;
  licenseValid: boolean | null;
  requiredLicenseClass: string | null;
  licenseClasses: string[];
  licenseClassSatisfied: boolean | null;
  validUntil: string | null;
  checkedAt: string | null;
  checkedByName: string | null;
};

/** Fahrerprüfungen einer Übergabe für die Dokumentanzeige: nur der Prüfstand, nie Bilder oder die volle Führerscheinnummer. */
export async function driverCheckSummaries(tenantId: string, handoverId: string): Promise<DriverCheckSummary[]> {
  const overview = await driverVerificationOverview(tenantId, handoverId);
  return overview.map((o) => {
    const v = o.verification;
    return {
      role: o.driver.role,
      name: `${o.driver.firstName} ${o.driver.lastName}`,
      status: o.status,
      identityDocumentType: v?.identityDocumentType ?? null,
      identityOriginalSeen: v?.identityOriginalSeen ?? false,
      identityMatched: v ? (v.identityNameMatched === true && v.identityBirthDateMatched === true ? true : v.identityNameMatched === false || v.identityBirthDateMatched === false ? false : null) : null,
      licenseOriginalSeen: v?.licenseOriginalSeen ?? false,
      licenseValid: v?.licenseDocumentValid ?? null,
      requiredLicenseClass: o.requiredLicenseClass,
      licenseClasses: v?.licenseClassesSnapshot ?? [],
      licenseClassSatisfied: v?.licenseClassSatisfied ?? null,
      validUntil: v?.licenseValidUntilSnapshot ? v.licenseValidUntilSnapshot.toISOString() : null,
      checkedAt: v?.verifiedAt ? v.verifiedAt.toISOString() : v?.licenseCheckedAt ? v.licenseCheckedAt.toISOString() : null,
      checkedByName: v?.verifiedByName ?? v?.licenseCheckedByName ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Dashboard: Fahrerprüfstand heutiger Abholungen (Phase 19.5). Eine Abfrage für mehrere Buchungen, kein N+1.
// ---------------------------------------------------------------------------

export type PickupDriverCheckStatus = { required: number; confirmed: number; blocked: number; manualReviewOpen: number; handoverId: string | null };

/** Fahrerprüfstand je Buchung: erforderliche Fahrer aus dem Vertrag, bestätigte/blockierte Prüfungen des aktuellen Übergabeentwurfs. */
export async function pickupDriverCheckStatus(tenantId: string, bookingIds: string[]): Promise<Map<string, PickupDriverCheckStatus>> {
  const out = new Map<string, PickupDriverCheckStatus>();
  if (bookingIds.length === 0) return out;
  const [contracts, handovers] = await Promise.all([
    db.rentalContract.findMany({ where: { tenantId, bookingId: { in: bookingIds }, status: "SIGNED" }, select: { id: true, bookingId: true, _count: { select: { drivers: true } } } }),
    db.handover.findMany({ where: { tenantId, bookingId: { in: bookingIds }, type: "PICKUP", correctsId: null, status: "DRAFT" }, select: { id: true, bookingId: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const handoverByBooking = new Map<string, string>();
  for (const h of handovers) if (!handoverByBooking.has(h.bookingId)) handoverByBooking.set(h.bookingId, h.id); // neuester Entwurf zuerst
  const handoverIds = [...handoverByBooking.values()];
  const verifications = handoverIds.length ? await db.driverVerification.findMany({ where: { tenantId, handoverId: { in: handoverIds } }, orderBy: { version: "desc" }, select: { handoverId: true, contractDriverId: true, status: true, manualReviewRequired: true, manualReviewConfirmed: true } }) : [];
  const latestByDriver = new Map<string, (typeof verifications)[number]>();
  for (const v of verifications) { const key = `${v.handoverId}:${v.contractDriverId}`; if (!latestByDriver.has(key)) latestByDriver.set(key, v); }
  for (const c of contracts) {
    const handoverId = handoverByBooking.get(c.bookingId) ?? null;
    const rows = handoverId ? [...latestByDriver.values()].filter((v) => v.handoverId === handoverId) : [];
    out.set(c.bookingId, {
      required: c._count.drivers,
      confirmed: rows.filter((v) => v.status === "CONFIRMED").length,
      blocked: rows.filter((v) => v.status === "BLOCKED").length,
      manualReviewOpen: rows.filter((v) => v.manualReviewRequired && v.manualReviewConfirmed !== true && v.status !== "CONFIRMED").length,
      handoverId,
    });
  }
  return out;
}
