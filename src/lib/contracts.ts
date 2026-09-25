// Mietvertrag: hängt 1:1 an der Buchung (Booking bleibt der Anker).
//
// Entwurf:   Kopien von Kunde, Fahrzeug, Preis und Mietbedingungen werden laufend aus den Stammdaten
//            aufgefrischt (refreshContractDraft), damit der Assistent immer den aktuellen Stand zeigt.
// Abschluss: Beim Finalisieren wird ein letztes Mal aufgefrischt, alles geprüft, der Inhalt gehasht und
//            der Vertrag gesperrt. Danach wirken Änderungen an Kunde, Fahrzeug oder Preisen nicht mehr.
// Unterschrift: gehört zu genau einem Inhalts-Hash. Ändert sich der Inhalt, wird sie verworfen.
//
// Mietbedingungen (Phase 15): Beim Anlegen wird die aktive veröffentlichte Fassung gewählt und ihr Text eingefroren.
//            Ein Entwurf wechselt nie von selbst auf eine neuere Fassung; das ist eine bewusste Aktion (adoptTermsVersion).
//            Die Kenntnisnahme bezieht sich auf genau eine Fassung und ist vor der Mieterunterschrift Pflicht.
// Geschäftsregeln: konkrete Werte samt Herkunft liegen in conditions (Snapshot). Geänderte Standardwerte wirken auf
//            einen Entwurf nur nach „Aktuelle Standardwerte übernehmen“, auf abgeschlossene Verträge nie.
// Jede Funktion verlangt die tenantId und filtert damit jede Abfrage.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { findConflicts } from "@/lib/bookings";
import { additionalDriverFee, adoptDefaults, applyContractOverrides, contractRuleIssues, depositSourceOf, initialContractRules, readContractRules, resolveDeposit, resolveRules, rulesFingerprint, type BusinessRules, type ContractRuleKey, type ContractRules, type ResolvedDeposit, type ResolvedRules } from "@/lib/business-rules";
import { checkCustomer, checkDriver, errorsOf, type Issue } from "@/lib/contract-checks";
import { driveClassOf } from "@/lib/constants";
import { DomainError, assertContractDraft, contentHash, sha256 } from "@/lib/integrity";
import { landlordFromTenant } from "@/lib/contract-view";
import { isUniqueViolation, nextContractNumber, withNumberRetry } from "@/lib/numbering";
import { calculateRentalPrice, rateCardFrom, toNumber, type PriceBreakdown } from "@/lib/pricing";
import { activeTermsVersion, termsFeatureActive, type TermsRow } from "@/lib/rental-terms";
import { buildStorageKey } from "@/lib/storage";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type Actor = { id: string; name: string };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Kopie der Kundendaten, wie sie auf dem Vertrag stehen. */
export function snapshotCustomer(c: Prisma.CustomerGetPayload<object>) {
  return {
    id: c.id,
    number: c.number,
    type: c.type,
    companyName: c.companyName,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    street: c.street,
    zip: c.zip,
    city: c.city,
    country: c.country,
    birthDate: iso(c.birthDate),
    birthPlace: c.birthPlace,
    nationality: c.nationality,
    idType: c.idType,
    idNumber: c.idNumber,
    idIssuedBy: c.idIssuedBy,
    idIssuedAt: iso(c.idIssuedAt),
    idValidUntil: iso(c.idValidUntil),
    licenseNumber: c.licenseNumber,
    licenseClass: c.licenseClass,
    licenseIssuedBy: c.licenseIssuedBy,
    licenseIssuedAt: iso(c.licenseIssuedAt),
    licenseValidUntil: iso(c.licenseValidUntil),
  };
}
export type CustomerSnapshot = ReturnType<typeof snapshotCustomer>;

/** Kopie der Fahrzeugdaten, wie sie auf dem Vertrag stehen. */
export function snapshotVehicle(v: Prisma.VehicleGetPayload<{ include: { group: true } }>) {
  return {
    id: v.id,
    plate: v.plate,
    make: v.make,
    model: v.model,
    vin: v.vin,
    color: v.color,
    year: v.year,
    fuel: v.fuel,
    groupId: v.groupId,
    groupName: v.group?.name ?? null,
    bodyType: v.group?.bodyType ?? "PKW",
    tankCapacityLiters: v.tankCapacityLiters,
    mileageAtContract: v.mileage,
  };
}
export type VehicleSnapshot = ReturnType<typeof snapshotVehicle>;

/** Eigene Preisposition neben dem Mietpreis, z. B. Zusatzfahrer. Nie im Basispreis versteckt. */
export type PriceExtra = { key: "ADDITIONAL_DRIVER"; label: string; quantity: number; unitPrice: number; amount: number };
export type ContractPriceSnapshot = PriceBreakdown & { agreedTotal: number | null; agreedTotalNote: string | null; extras?: PriceExtra[]; extrasTotal?: number; finalTotal: number };

/**
 * Die eine Stelle, an der der Vertragspreis entsteht: zentrale Preisfunktion plus optional abweichend
 * vereinbarter Gesamtpreis, plus eigene Zusatzpositionen (Zusatzfahrer laut Geschäftsregel). Die Kernpreislogik
 * (günstigste Kombination Tag/Woche/Monat) bleibt unverändert in lib/pricing.ts.
 */
export function contractPrice(
  booking: { startAt: Date; endAt: Date; dailyRate: unknown; workWeekRate?: unknown; weeklyRate?: unknown; monthlyRate?: unknown },
  discountPercent: number,
  agreedTotal: number | null,
  agreedTotalNote: string | null,
  extrasInput?: { additionalDrivers: number; rules: Pick<BusinessRules, "additionalDriverFeeType" | "additionalDriverFeeCents"> | null },
): ContractPriceSnapshot {
  const price = calculateRentalPrice({ start: booking.startAt, end: booking.endAt, rates: rateCardFrom(booking), discountPercent });
  const extras: PriceExtra[] = [];
  if (extrasInput?.rules) {
    const fee = additionalDriverFee(extrasInput.rules, extrasInput.additionalDrivers, price.days);
    if (fee) extras.push({ key: "ADDITIONAL_DRIVER", label: fee.label, quantity: fee.quantity, unitPrice: fee.unitCents / 100, amount: fee.amountCents / 100 });
  }
  const extrasTotal = Math.round(extras.reduce((a, e) => a + e.amount * 100, 0)) / 100;
  const base = agreedTotal ?? price.total;
  return { ...price, agreedTotal, agreedTotalNote: agreedTotal != null ? agreedTotalNote : null, ...(extras.length ? { extras, extrasTotal } : {}), finalTotal: Math.round((base + extrasTotal) * 100) / 100 };
}

/** Eingefrorene Mietbedingungen für einen neuen Entwurf: aktive Fassung, sonst (Altbestand) der Mandantentext. */
function termsForNewDraft(tenant: { rentalTermsVersion: string | null; rentalTermsText: string | null }, active: TermsRow | null) {
  if (active) return { rentalTermsVersionId: active.id, termsVersion: active.label, termsText: active.content, termsHash: active.checksum, termsFormat: "MARKDOWN" as const };
  return { rentalTermsVersionId: null, termsVersion: tenant.rentalTermsVersion, termsText: tenant.rentalTermsText, termsHash: tenant.rentalTermsText ? sha256(tenant.rentalTermsText) : null, termsFormat: tenant.rentalTermsText ? ("PLAIN" as const) : null };
}

type BookingWithContext = Prisma.BookingGetPayload<{ include: { customer: true; vehicle: { include: { group: true } }; tenant: true } }>;

function resolveFor(booking: BookingWithContext): ResolvedRules {
  return resolveRules(booking.tenant.businessRules, booking.vehicle.group, booking.vehicle);
}
/** Kautionsvorgabe: Fahrzeug → Gruppe → Mandantenstandard; 0 in Fahrzeug/Gruppe bedeutet „nicht gesetzt“. */
function depositFor(booking: BookingWithContext): ResolvedDeposit {
  return resolveDeposit(booking.tenant.businessRules, booking.vehicle.group, booking.vehicle);
}
/** Vertragskaution beim Anlegen: eine in der Buchung gesetzte Kaution gilt; ohne (0) greift die Vorgabekette. */
const initialDeposit = (booking: BookingWithContext, resolved: ResolvedDeposit) => (Math.round(Number(booking.deposit) * 100) > 0 ? Number(booking.deposit) : resolved.cents / 100);
const feeRules = (rules: ContractRules | null) => (rules ? { additionalDriverFeeType: rules.values.additionalDriverFeeType, additionalDriverFeeCents: rules.values.additionalDriverFeeCents } : null);

// ---------------------------------------------------------------------------
// Entwurf anlegen und aktuell halten
// ---------------------------------------------------------------------------

/**
 * Gibt den Vertrag der Buchung zurück und legt ihn bei Bedarf als Entwurf an.
 * Eine Buchung hat höchstens einen Vertrag (eindeutiger Index auf bookingId). Gleichzeitige Anfragen
 * erzeugen deshalb nie zwei Verträge, und die Vertragsnummer wird bei Kollision neu gezogen.
 */
export async function ensureContractDraft(tenantId: string, bookingId: string, actor: Actor | null) {
  const existing = await db.rentalContract.findFirst({ where: { tenantId, bookingId } });
  if (existing) return existing;
  try {
    return await withNumberRetry(() =>
      db.$transaction(async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, include: { customer: true, vehicle: { include: { group: true } }, tenant: true } });
        if (!booking) throw new DomainError("Buchung nicht gefunden.");
        if (booking.status !== "RESERVED") throw new DomainError("Ein Mietvertrag wird nur für reservierte Buchungen angelegt.");
        const resolved = resolveFor(booking);
        const depositRule = depositFor(booking);
        const rules = initialContractRules(resolved, new Date(), depositRule);
        const price = contractPrice(booking, booking.customer.discountPercent, null, null, { additionalDrivers: 0, rules: feeRules(rules) });
        const terms = termsForNewDraft(booking.tenant, await activeTermsVersion(tx, tenantId));
        const number = await nextContractNumber(tx, tenantId, booking.startAt);
        const contract = await tx.rentalContract.create({
          data: {
            tenantId,
            bookingId: booking.id,
            number,
            customerId: booking.customerId,
            vehicleId: booking.vehicleId,
            customerSnapshot: snapshotCustomer(booking.customer),
            vehicleSnapshot: snapshotVehicle(booking.vehicle),
            priceSnapshot: price as unknown as Prisma.InputJsonValue,
            startAt: booking.startAt,
            endAt: booking.endAt,
            totalAmount: price.finalTotal,
            discountPercent: price.discountPercent,
            deposit: initialDeposit(booking, depositRule),
            kmIncludedPerDay: booking.vehicle.kmIncludedPerDay,
            extraKmRate: booking.vehicle.extraKmRate,
            deductible: (resolved.values.deductibleCents ?? 0) / 100,
            fuelPolicy: resolved.values.fuelRule,
            conditions: rules as unknown as Prisma.InputJsonValue,
            ...terms,
            createdById: actor?.id ?? null,
          },
        });
        await syncPrimaryDriver(tx, tenantId, contract.id, "RENTER", booking.customer);
        if (terms.rentalTermsVersionId) await recordAudit(tx, tenantId, actor, { action: "CONTRACT_TERMS_SELECTED", bookingId: booking.id, details: { contractNumber: number, versionId: terms.rentalTermsVersionId, label: terms.termsVersion, checksum: terms.termsHash, automatic: true } });
        return contract;
      }, TX),
    );
  } catch (e) {
    // Zwei gleichzeitige Klicks: der zweite findet den Vertrag des ersten
    if (isUniqueViolation(e, "bookingId")) {
      const c = await db.rentalContract.findFirst({ where: { tenantId, bookingId } });
      if (c) return c;
    }
    throw e;
  }
}

/** Fahrer-Kopie aus dem Mieter, sobald dessen Daten dafür reichen. Sonst gibt es (noch) keinen Fahrer. */
async function syncPrimaryDriver(tx: Tx, tenantId: string, contractId: string, driverMode: string, c: Prisma.CustomerGetPayload<object>) {
  if (driverMode !== "RENTER") return;
  const complete = c.firstName && c.lastName && c.birthDate && c.street && c.zip && c.city && c.licenseNumber && c.licenseClass && c.licenseIssuedAt;
  const current = await tx.contractDriver.findFirst({ where: { tenantId, contractId, role: "PRIMARY_DRIVER" } });
  if (!complete) {
    if (current) await tx.contractDriver.delete({ where: { id: current.id } });
    return;
  }
  const data = {
    customerId: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    birthDate: c.birthDate!,
    street: c.street!,
    zip: c.zip!,
    city: c.city!,
    country: c.country,
    licenseNumber: c.licenseNumber!,
    licenseClass: c.licenseClass!,
    licenseIssuedAt: c.licenseIssuedAt!,
    licenseValidUntil: c.licenseValidUntil,
    licenseCountry: c.country,
    licenseIssuedBy: c.licenseIssuedBy,
  };
  if (current) await tx.contractDriver.update({ where: { id: current.id }, data });
  else await tx.contractDriver.create({ data: { tenantId, contractId, role: "PRIMARY_DRIVER", ...data } });
}

/**
 * Bringt einen Entwurf auf den Stand der Stammdaten: Kunde, Fahrzeug, Zeitraum, Preis, Mietbedingungen,
 * Fahrer bei "Mieter fährt selbst". Passt danach keine Unterschrift mehr zum Inhalt, wird sie verworfen.
 * Unterschriebene Verträge werden nie angefasst.
 */
export async function refreshContractDraft(tx: Tx, tenantId: string, contractId: string) {
  const contract = await tx.rentalContract.findFirst({ where: { id: contractId, tenantId } });
  if (!contract) throw new DomainError("Vertrag nicht gefunden.");
  if (contract.status !== "DRAFT") return contract;

  const booking = await tx.booking.findFirst({ where: { id: contract.bookingId, tenantId }, include: { customer: true, vehicle: { include: { group: true } }, tenant: true } });
  if (!booking) throw new DomainError("Buchung nicht gefunden.");
  const vehicleChanged = booking.vehicleId !== contract.vehicleId;
  // Geschäftsregeln: der Schnappschuss bleibt; nur ein Fahrzeugwechsel löst die Vorgaben neu auf (wie die Kilometerkonditionen)
  let rules = readContractRules(contract.conditions);
  const depositRule = depositFor(booking);
  if (!rules || vehicleChanged) rules = initialContractRules(resolveFor(booking), new Date(), depositRule);
  const additionalDrivers = await tx.contractDriver.count({ where: { tenantId, contractId, role: "ADDITIONAL_DRIVER" } });
  const price = contractPrice(booking, booking.customer.discountPercent, toNumber(contract.agreedTotal), contract.agreedTotalNote, { additionalDrivers, rules: feeRules(rules) });
  // Mietbedingungen: ein versionierter Entwurf wechselt nie von selbst. Ohne Fassung (Altbestand, noch nicht bestätigt)
  // wird die aktive Fassung übernommen; ohne veröffentlichte Fassung gilt weiter der bisherige Mandantentext.
  const featureActive = await termsFeatureActive(tx, tenantId);
  let terms: Partial<ReturnType<typeof termsForNewDraft>> = {};
  if (!featureActive) terms = termsForNewDraft(booking.tenant, null);
  else if (!contract.rentalTermsVersionId && !contract.termsAcknowledgedAt) {
    const active = await activeTermsVersion(tx, tenantId);
    if (active) {
      terms = termsForNewDraft(booking.tenant, active);
      await recordAudit(tx, tenantId, null, { action: "CONTRACT_TERMS_SELECTED", bookingId: booking.id, details: { contractNumber: contract.number, versionId: active.id, label: active.label, checksum: active.checksum, automatic: true } });
    }
  }

  const updated = await tx.rentalContract.update({
    where: { id: contract.id },
    data: {
      customerId: booking.customerId,
      vehicleId: booking.vehicleId,
      customerSnapshot: snapshotCustomer(booking.customer),
      vehicleSnapshot: snapshotVehicle(booking.vehicle),
      priceSnapshot: price as unknown as Prisma.InputJsonValue,
      startAt: booking.startAt,
      endAt: booking.endAt,
      totalAmount: price.finalTotal,
      discountPercent: price.discountPercent,
      // Kilometer-Konditionen gehören zum Fahrzeug: bei Fahrzeugwechsel neu übernehmen
      ...(vehicleChanged ? { kmIncludedPerDay: booking.vehicle.kmIncludedPerDay, extraKmRate: booking.vehicle.extraKmRate, deductible: (rules.values.deductibleCents ?? 0) / 100, fuelPolicy: rules.values.fuelRule, deposit: depositRule.cents / 100 } : {}),
      conditions: rules as unknown as Prisma.InputJsonValue,
      ...terms,
    },
  });
  await syncPrimaryDriver(tx, tenantId, contract.id, contract.driverMode, booking.customer);
  await dropStaleSignatures(tx, tenantId, contract.id);
  return updated;
}

// ---------------------------------------------------------------------------
// Inhalt, Hash, Unterschriften
// ---------------------------------------------------------------------------

async function loadContract(tx: Tx, tenantId: string, contractId: string) {
  const c = await tx.rentalContract.findFirst({ where: { id: contractId, tenantId }, include: { drivers: { orderBy: [{ role: "desc" }, { createdAt: "asc" }] } } });
  if (!c) throw new DomainError("Vertrag nicht gefunden.");
  return c;
}

/** Alles, was der Mieter unterschreibt. Interne Notiz und Assistenten-Schritt gehören nicht dazu. */
function signedContent(c: Awaited<ReturnType<typeof loadContract>>) {
  return {
    number: c.number,
    bookingId: c.bookingId,
    customer: c.customerSnapshot,
    vehicle: c.vehicleSnapshot,
    price: c.priceSnapshot,
    startAt: c.startAt,
    endAt: c.endAt,
    totalAmount: toNumber(c.totalAmount),
    discountPercent: c.discountPercent,
    deposit: toNumber(c.deposit),
    kmIncludedPerDay: c.kmIncludedPerDay,
    extraKmRate: toNumber(c.extraKmRate),
    deductible: toNumber(c.deductible),
    fuelPolicy: c.fuelPolicy,
    fuelPolicyNote: c.fuelPolicyNote,
    fuelPricePerLiter: toNumber(c.fuelPricePerLiter),
    agreedTotal: toNumber(c.agreedTotal),
    pickupLocation: c.pickupLocation,
    returnLocation: c.returnLocation,
    conditions: c.conditions,
    termsVersion: c.termsVersion,
    termsHash: c.termsHash,
    ...(c.rentalTermsVersionId ? { rentalTermsVersionId: c.rentalTermsVersionId } : {}),
    ...(c.termsFormat ? { termsFormat: c.termsFormat } : {}),
    ...(c.individualAgreements ? { individualAgreements: c.individualAgreements } : {}),
    driverMode: c.driverMode,
    drivers: c.drivers.map((d) => ({
      role: d.role,
      firstName: d.firstName,
      lastName: d.lastName,
      birthDate: d.birthDate,
      street: d.street,
      zip: d.zip,
      city: d.city,
      country: d.country,
      licenseNumber: d.licenseNumber,
      licenseClass: d.licenseClass,
      licenseIssuedAt: d.licenseIssuedAt,
      licenseValidUntil: d.licenseValidUntil,
      licenseCountry: d.licenseCountry,
    })),
  };
}

async function currentHash(tx: Tx, tenantId: string, contractId: string) {
  return contentHash(signedContent(await loadContract(tx, tenantId, contractId)));
}

/** Verwirft Unterschriften, die nicht mehr zum aktuellen Inhalt gehören. Nur im Entwurf möglich. */
async function dropStaleSignatures(tx: Tx, tenantId: string, contractId: string) {
  const hash = await currentHash(tx, tenantId, contractId);
  const stale = await tx.signature.findMany({ where: { tenantId, contractId, contentHash: { not: hash } }, select: { id: true } });
  if (stale.length > 0) await tx.signature.deleteMany({ where: { tenantId, id: { in: stale.map((s) => s.id) } } });
  return { hash, dropped: stale.length };
}

/** Hash des aktuellen Inhalts. Diesen Wert zeigt die Unterschriftsseite und gibt ihn beim Unterschreiben zurück. */
export async function getContractContentHash(tenantId: string, contractId: string) {
  return db.$transaction((tx) => currentHash(tx, tenantId, contractId), TX);
}

const PNG_PREFIX = "data:image/png;base64,";
const MAX_SIGNATURE_BYTES = 400_000;

export type ContractSignatureInput = {
  role: "RENTER" | "EMPLOYEE";
  signerName: string;
  imageDataUrl: string;
  /** Hash, den die Seite beim Anzeigen hatte. Weicht er ab, hat sich der Vertrag inzwischen geändert. */
  seenHash: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Speichert eine Unterschrift zu genau dem Inhalt, den der Unterzeichner gesehen hat. */
export async function saveContractSignature(tenantId: string, actor: Actor | null, contractId: string, input: ContractSignatureInput) {
  if (!input.signerName.trim()) throw new DomainError("Bitte den Namen des Unterzeichners angeben.");
  if (!input.imageDataUrl.startsWith(PNG_PREFIX)) throw new DomainError("Die Unterschrift konnte nicht gelesen werden. Bitte erneut unterschreiben.");
  const image = Buffer.from(input.imageDataUrl.slice(PNG_PREFIX.length), "base64");
  const isPng = image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
  if (!isPng || image.length > MAX_SIGNATURE_BYTES) throw new DomainError("Die Unterschrift ist ungültig oder zu groß. Bitte erneut unterschreiben.");
  if (image.length < 800) throw new DomainError("Die Unterschrift ist leer. Bitte im Feld unterschreiben.");

  return db.$transaction(async (tx) => {
    const contract = await refreshContractDraft(tx, tenantId, contractId);
    assertContractDraft(contract);
    const hash = await currentHash(tx, tenantId, contractId);
    if (hash !== input.seenHash) throw new DomainError("Der Vertrag wurde seit der Anzeige geändert. Bitte die Zusammenfassung erneut prüfen und dann unterschreiben.");
    if (input.role === "RENTER" && contract.rentalTermsVersionId && !acknowledgementValid(contract)) throw new DomainError("Vor der Unterschrift des Mieters muss die Kenntnisnahme der Mietbedingungen bestätigt werden.");
    await tx.signature.deleteMany({ where: { tenantId, contractId, role: input.role } });
    return tx.signature.create({
      data: {
        tenantId,
        contractId,
        role: input.role,
        signerName: input.signerName.trim(),
        storageKey: buildStorageKey({ tenantId, area: "signatures", bookingId: contract.bookingId, contentType: "image/png" }),
        imageData: image,
        imageChecksum: sha256(image),
        contentHash: hash,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        createdById: actor?.id ?? null,
      },
      select: { id: true, role: true, signerName: true, signedAt: true, contentHash: true },
    });
  }, TX);
}

export async function removeContractSignature(tenantId: string, contractId: string, role: "RENTER" | "EMPLOYEE") {
  return db.$transaction(async (tx) => {
    assertContractDraft(await loadContract(tx, tenantId, contractId));
    await tx.signature.deleteMany({ where: { tenantId, contractId, role } });
  }, TX);
}

// ---------------------------------------------------------------------------
// Fahrer und Konditionen (nur im Entwurf)
// ---------------------------------------------------------------------------

export type DriverInput = {
  customerId?: string | null;
  firstName: string;
  lastName: string;
  birthDate: Date;
  street: string;
  zip: string;
  city: string;
  country?: string;
  licenseNumber: string;
  licenseClass: string;
  licenseIssuedAt: Date;
  licenseValidUntil?: Date | null;
  licenseCountry?: string;
  licenseIssuedBy?: string | null;
};

function driverData(input: DriverInput) {
  return {
    customerId: input.customerId ?? null,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    birthDate: input.birthDate,
    street: input.street.trim(),
    zip: input.zip.trim(),
    city: input.city.trim(),
    country: input.country ?? "DE",
    licenseNumber: input.licenseNumber.trim().toUpperCase(),
    licenseClass: input.licenseClass.trim(),
    licenseIssuedAt: input.licenseIssuedAt,
    licenseValidUntil: input.licenseValidUntil ?? null,
    licenseCountry: input.licenseCountry ?? "DE",
    licenseIssuedBy: input.licenseIssuedBy ?? null,
  };
}

async function assertLinkedCustomer(tx: Tx, tenantId: string, customerId: string | null | undefined) {
  if (!customerId) return;
  if ((await tx.customer.count({ where: { id: customerId, tenantId } })) !== 1) throw new DomainError("Der verknüpfte Kunde gehört nicht zu diesem Mandanten.");
}

/** "Mieter fährt selbst": Fahrer wird aus dem Mieter abgeleitet. */
export async function setRenterDrives(tenantId: string, contractId: string) {
  return db.$transaction(async (tx) => {
    const c = await loadContract(tx, tenantId, contractId);
    assertContractDraft(c);
    await tx.rentalContract.update({ where: { id: c.id }, data: { driverMode: "RENTER" } });
    await tx.contractDriver.deleteMany({ where: { tenantId, contractId, role: "PRIMARY_DRIVER" } });
    return refreshContractDraft(tx, tenantId, contractId);
  }, TX);
}

/** "Abweichender Fahrer": eigene Kopie der Fahrerdaten am Vertrag, auch wenn ein Kunde als Vorlage diente. */
export async function setOtherDriver(tenantId: string, contractId: string, input: DriverInput) {
  return db.$transaction(async (tx) => {
    const c = await loadContract(tx, tenantId, contractId);
    assertContractDraft(c);
    await assertLinkedCustomer(tx, tenantId, input.customerId);
    await tx.rentalContract.update({ where: { id: c.id }, data: { driverMode: "OTHER" } });
    const current = c.drivers.find((d) => d.role === "PRIMARY_DRIVER");
    if (current) await tx.contractDriver.update({ where: { id: current.id }, data: driverData(input) });
    else await tx.contractDriver.create({ data: { tenantId, contractId, role: "PRIMARY_DRIVER", ...driverData(input) } });
    return refreshContractDraft(tx, tenantId, contractId);
  }, TX);
}

export async function addAdditionalDriver(tenantId: string, contractId: string, input: DriverInput) {
  return db.$transaction(async (tx) => {
    assertContractDraft(await loadContract(tx, tenantId, contractId));
    await assertLinkedCustomer(tx, tenantId, input.customerId);
    const driver = await tx.contractDriver.create({ data: { tenantId, contractId, role: "ADDITIONAL_DRIVER", ...driverData(input) } });
    await refreshContractDraft(tx, tenantId, contractId);
    return driver;
  }, TX);
}

export async function removeAdditionalDriver(tenantId: string, contractId: string, driverId: string) {
  return db.$transaction(async (tx) => {
    assertContractDraft(await loadContract(tx, tenantId, contractId));
    await tx.contractDriver.deleteMany({ where: { id: driverId, tenantId, contractId, role: "ADDITIONAL_DRIVER" } });
    await refreshContractDraft(tx, tenantId, contractId);
  }, TX);
}

export type ConditionsInput = {
  startAt: Date;
  endAt: Date;
  deposit: number;
  kmIncludedPerDay: number;
  extraKmRate: number;
  deductible: number;
  fuelPolicy: "FULL_TO_FULL" | "SAME_LEVEL" | "MINIMUM_LEVEL" | "INCLUDED" | "OTHER";
  fuelPolicyNote?: string | null;
  fuelPricePerLiter?: number | null;
  agreedTotal?: number | null;
  agreedTotalNote?: string | null;
  pickupLocation?: string | null;
  returnLocation?: string | null;
  internalNote?: string | null;
  /** Phase 15: Geschäftsregeln des Vertrags (nur erlaubte Schlüssel) und individuelle Vereinbarungen */
  rules?: Partial<Pick<BusinessRules, ContractRuleKey>> & { kmPolicyNote?: string | null };
  individualAgreements?: string | null;
};

/**
 * Speichert die Konditionen. Zeitraum und Kaution gehören zur Buchung und werden dort geändert,
 * mit derselben Konfliktprüfung wie beim Bearbeiten einer Buchung.
 */
export async function saveConditions(tenantId: string, contractId: string, input: ConditionsInput, actor: Actor | null = null) {
  if (!(input.endAt > input.startAt)) throw new DomainError("Die Rückgabe muss nach dem Mietbeginn liegen.");
  if (input.fuelPolicy === "OTHER" && !input.fuelPolicyNote?.trim()) throw new DomainError("Bitte die individuelle Tankregelung beschreiben.");
  if (input.individualAgreements && input.individualAgreements.length > 6000) throw new DomainError("Individuelle Vereinbarungen: maximal 6.000 Zeichen.");
  for (const [label, v] of [["Kaution", input.deposit], ["Freikilometer", input.kmIncludedPerDay], ["Mehrkilometerpreis", input.extraKmRate], ["Selbstbeteiligung", input.deductible]] as const) {
    if (!(v >= 0)) throw new DomainError(`${label}: bitte einen Wert ab 0 eingeben.`);
  }
  if (input.agreedTotal != null && !(input.agreedTotal >= 0)) throw new DomainError("Vereinbarter Mietpreis: bitte einen Wert ab 0 eingeben.");
  if (input.agreedTotal != null && !input.agreedTotalNote?.trim()) throw new DomainError("Bitte kurz begründen, warum der Mietpreis von der Berechnung abweicht.");

  return db.$transaction(async (tx) => {
    const c = await loadContract(tx, tenantId, contractId);
    assertContractDraft(c);
    const booking = await tx.booking.findFirst({ where: { id: c.bookingId, tenantId }, include: { vehicle: true } });
    if (!booking) throw new DomainError("Buchung nicht gefunden.");

    const periodChanged = booking.startAt.getTime() !== input.startAt.getTime() || booking.endAt.getTime() !== input.endAt.getTime();
    if (periodChanged) {
      const conflicts = await findConflicts(tx, tenantId, booking.vehicleId, input.startAt, input.endAt, booking.id);
      if (conflicts.length > 0) throw new DomainError(`Der neue Zeitraum überschneidet sich mit Buchung ${conflicts[0].number}. ${booking.vehicle.plate} ist dann bereits vergeben.`);
    }
    await tx.booking.update({ where: { id: booking.id }, data: { startAt: input.startAt, endAt: input.endAt, deposit: input.deposit } });
    // Geschäftsregeln des Vertrags: erlaubte Schlüssel anpassen, Herkunft „Individuell angepasst“ bei Abweichung, Audit je Änderung
    const withContext = await tx.booking.findFirstOrThrow({ where: { id: c.bookingId, tenantId }, include: { customer: true, vehicle: { include: { group: true } }, tenant: true } });
    const resolved = resolveFor(withContext);
    let rules = readContractRules(c.conditions) ?? initialContractRules(resolved);
    const changes: { key: string; from: unknown; to: unknown }[] = [];
    const applied = applyContractOverrides(rules, resolved, { ...(input.rules ?? {}), fuelRule: input.fuelPolicy });
    rules = applied.rules;
    changes.push(...applied.changes);
    rules = { ...rules, values: { ...rules.values, deductibleCents: Math.round(input.deductible * 100) }, sources: { ...rules.sources, deductibleCents: Math.round(input.deductible * 100) === (resolved.values.deductibleCents ?? 0) ? resolved.sources.deductibleCents : "CONTRACT" } };
    if (Math.round(Number(c.deductible) * 100) !== Math.round(input.deductible * 100)) changes.push({ key: "deductibleCents", from: Math.round(Number(c.deductible) * 100), to: Math.round(input.deductible * 100) });
    for (const ch of changes) await recordAudit(tx, tenantId, actor, { action: "CONTRACT_BUSINESS_RULE_OVERRIDDEN", bookingId: c.bookingId, details: { contractNumber: c.number, field: ch.key, from: ch.from == null ? null : typeof ch.from === "object" ? JSON.stringify(ch.from) : (ch.from as string | number | boolean), to: ch.to == null ? null : typeof ch.to === "object" ? JSON.stringify(ch.to) : (ch.to as string | number | boolean) } });
    await tx.rentalContract.update({
      where: { id: c.id },
      data: {
        conditions: rules as unknown as Prisma.InputJsonValue,
        individualAgreements: input.individualAgreements?.trim() || null,
        deposit: input.deposit,
        kmIncludedPerDay: Math.round(input.kmIncludedPerDay),
        extraKmRate: input.extraKmRate,
        deductible: input.deductible,
        fuelPolicy: input.fuelPolicy,
        fuelPolicyNote: input.fuelPolicy === "OTHER" ? input.fuelPolicyNote!.trim() : null,
        fuelPricePerLiter: input.fuelPricePerLiter ?? null,
        agreedTotal: input.agreedTotal ?? null,
        agreedTotalNote: input.agreedTotal != null ? input.agreedTotalNote!.trim() : null,
        pickupLocation: input.pickupLocation?.trim() || null,
        returnLocation: input.returnLocation?.trim() || null,
        internalNote: input.internalNote?.trim() || null,
      },
    });
    return refreshContractDraft(tx, tenantId, contractId);
  }, TX);
}

export async function setWizardStep(tenantId: string, contractId: string, step: number) {
  await db.rentalContract.updateMany({ where: { id: contractId, tenantId, status: "DRAFT" }, data: { wizardStep: Math.min(7, Math.max(1, Math.round(step))) } });
}

// ---------------------------------------------------------------------------
// Prüfung und Abschluss
// ---------------------------------------------------------------------------

/** Alle Prüfungen auf einen Blick. Dieselbe Funktion speist den Assistenten und entscheidet beim Abschluss. */
async function collectIssues(tx: Tx, tenantId: string, contractId: string, opts: { requireSignature: boolean }): Promise<Issue[]> {
  const c = await loadContract(tx, tenantId, contractId);
  const issues: Issue[] = [];
  const err = (area: Issue["area"], code: string, message: string) => issues.push({ area, code, severity: "error", message });

  const booking = await tx.booking.findFirst({ where: { id: c.bookingId, tenantId } });
  const customer = await tx.customer.findFirst({ where: { id: c.customerId, tenantId } });
  const vehicle = await tx.vehicle.findFirst({ where: { id: c.vehicleId, tenantId }, include: { group: true } });
  const tenantRow = await tx.tenant.findUnique({ where: { id: tenantId }, select: { businessRules: true } });
  if (!booking) err("PERIOD", "BOOKING_MISSING", "Die Buchung gehört nicht zu diesem Mandanten.");
  if (!customer) err("CUSTOMER", "CUSTOMER_MISSING", "Der Kunde gehört nicht zu diesem Mandanten.");
  if (!vehicle) err("VEHICLE", "VEHICLE_MISSING", "Das Fahrzeug gehört nicht zu diesem Mandanten.");
  if (!booking || !customer || !vehicle) return issues;

  if (booking.status !== "RESERVED") err("PERIOD", "BOOKING_STATUS", "Die Buchung ist nicht mehr reserviert. Ein Vertrag kann nur für reservierte Buchungen abgeschlossen werden.");
  if (!(c.endAt > c.startAt)) err("PERIOD", "PERIOD_INVALID", "Die Rückgabe muss nach dem Mietbeginn liegen.");

  // Mieter: geprüft wird, was tatsächlich auf dem Vertrag steht
  issues.push(...checkCustomer({ ...(c.customerSnapshot as CustomerSnapshot), blocked: customer.blocked, blockReason: customer.blockReason }, c.startAt));

  // Geschäftsregeln des Vertrags (Schnappschuss) und aktuelle Vorgaben
  const rules = readContractRules(c.conditions);
  const driverRules = { minimumAge: rules?.values.minimumDriverAge ?? 18, minimumLicenseMonths: rules?.values.minimumLicenseHoldingMonths ?? 0 };

  // Fahrer
  const primary = c.drivers.find((d) => d.role === "PRIMARY_DRIVER");
  if (!primary) {
    if (c.driverMode === "RENTER") issues.push(...checkDriver({ ...(c.customerSnapshot as CustomerSnapshot), licenseCountry: customer.country }, c.startAt, "Fahrer (Mieter)", "DRIVER", driverRules));
    else err("DRIVER", "DRIVER_MISSING", "Es ist noch kein Fahrer erfasst.");
  } else {
    issues.push(...checkDriver(primary, c.startAt, c.driverMode === "RENTER" ? "Fahrer (Mieter)" : `Fahrer ${primary.firstName} ${primary.lastName}`, "DRIVER", driverRules));
  }
  const additional = c.drivers.filter((x) => x.role === "ADDITIONAL_DRIVER");
  for (const d of additional) issues.push(...checkDriver(d, c.startAt, `Zusatzfahrer ${d.firstName} ${d.lastName}`, "ADDITIONAL_DRIVER", driverRules));

  // Fahrzeug: Status und die bestehende Verfügbarkeitsprüfung, keine zweite Logik
  if (vehicle.status !== "AVAILABLE") err("VEHICLE", "VEHICLE_STATUS", `${vehicle.plate} ist derzeit nicht vermietbar (Status: ${vehicle.status === "WORKSHOP" ? "Werkstatt" : vehicle.status === "BLOCKED" ? "Gesperrt" : "Inaktiv"}).`);
  const conflicts = await findConflicts(tx, tenantId, vehicle.id, c.startAt, c.endAt, booking.id);
  if (conflicts.length > 0) err("VEHICLE", "VEHICLE_CONFLICT", `${vehicle.plate} ist im Zeitraum bereits durch Buchung ${conflicts[0].number} belegt.`);

  // Preis
  const price = c.priceSnapshot as unknown as ContractPriceSnapshot | null;
  if (!price || !(price.days > 0) || !Array.isArray(price.lines) || price.lines.length === 0) err("PRICE", "PRICE_INVALID", "Die Preisberechnung ist unvollständig.");
  else if (!(price.finalTotal >= 0) || Math.abs(price.finalTotal - Number(c.totalAmount)) > 0.005) err("PRICE", "PRICE_MISMATCH", "Der Gesamtpreis passt nicht zur Berechnung.");
  if (price && price.finalTotal === 0) issues.push({ area: "PRICE", code: "PRICE_ZERO", severity: "warning", message: "Der Mietpreis beträgt 0 €." });

  // Konditionen
  if (!c.number) err("CONDITIONS", "NUMBER_MISSING", "Die Vertragsnummer fehlt.");
  if (c.fuelPolicy === "OTHER" && !c.fuelPolicyNote) err("CONDITIONS", "FUEL_NOTE", "Die individuelle Tankregelung ist nicht beschrieben.");
  if (!c.pickupLocation) issues.push({ area: "CONDITIONS", code: "PICKUP_LOCATION", severity: "warning", message: "Kein Abholort angegeben." });
  for (const [label, v] of [["Kaution", Number(c.deposit)], ["Selbstbeteiligung", Number(c.deductible)], ["Mehrkilometerpreis", Number(c.extraKmRate)]] as const) if (!(v >= 0)) err("CONDITIONS", "NEGATIVE_VALUE", `${label} darf nicht negativ sein.`);
  if (!rules) err("CONDITIONS", "RULES_MISSING", "Die Geschäftsregeln des Vertrags sind nicht vollständig eingefroren.");
  else {
    const vehicleSnap = c.vehicleSnapshot as VehicleSnapshot;
    const resolved = resolveRules(tenantRow?.businessRules, vehicle.group, vehicle);
    for (const m of contractRuleIssues(rules, resolved, { driveClass: driveClassOf(vehicleSnap.fuel ?? vehicle.fuel), additionalDrivers: additional.length })) err("CONDITIONS", "RULES_INCONSISTENT", m);
    if (rules.defaultsFingerprint !== rulesFingerprint(resolved.values)) issues.push({ area: "CONDITIONS", code: "RULES_NEWER", severity: "warning", message: "Für diesen Vertragsentwurf sind neuere Standardwerte verfügbar. Sie werden nur auf Wunsch übernommen (Schritt Konditionen)." });
  }

  // Mietbedingungen: nach Aktivierung Pflicht; ein Entwurf wechselt nie von selbst auf eine neuere Fassung
  const featureActive = await termsFeatureActive(tx, tenantId);
  if (featureActive) {
    const active = await activeTermsVersion(tx, tenantId);
    if (!c.rentalTermsVersionId) err("CONDITIONS", "TERMS_REQUIRED", "Es ist keine veröffentlichte Mietbedingungen-Fassung zugeordnet. Bitte die aktuelle Fassung übernehmen.");
    else {
      const selected = await tx.rentalTermsVersion.findFirst({ where: { id: c.rentalTermsVersionId, tenantId }, select: { status: true, label: true, checksum: true } });
      if (!selected) err("CONDITIONS", "TERMS_UNKNOWN", "Die zugeordnete Mietbedingungen-Fassung wurde nicht gefunden.");
      else if (selected.status !== "PUBLISHED") err("CONDITIONS", "TERMS_ARCHIVED", `Die Mietbedingungen-Fassung ${selected.label} wurde archiviert. Bitte ${active ? `Fassung ${active.label}` : "eine veröffentlichte Fassung"} übernehmen.`);
      else if (selected.checksum !== c.termsHash) err("CONDITIONS", "TERMS_HASH", "Der eingefrorene Bedingungstext passt nicht zur Fassung. Bitte die Fassung erneut übernehmen.");
      else if (active && active.id !== c.rentalTermsVersionId) issues.push({ area: "CONDITIONS", code: "TERMS_NEWER", severity: "warning", message: `Eine neuere Mietbedingungen-Fassung ist verfügbar (Version ${active.label}). Der Entwurf behält Version ${c.termsVersion}, bis sie bewusst übernommen wird.` });
      if (!acknowledgementValid(c)) err("SIGNATURE", "TERMS_ACK_MISSING", `Die Kenntnisnahme der Mietbedingungen (Version ${c.termsVersion}) fehlt. Sie wird im Schritt Unterschrift bestätigt.`);
    }
  } else if (!c.termsText) issues.push({ area: "CONDITIONS", code: "TERMS_MISSING", severity: "warning", message: "Noch keine Mietbedingungen veröffentlicht (Einstellungen → Mietbedingungen). Der Vertrag enthält dann keinen Bedingungstext." });

  if (opts.requireSignature) {
    const hash = contentHash(signedContent(c));
    const signatures = await tx.signature.findMany({ where: { tenantId, contractId }, select: { role: true, contentHash: true } });
    const renter = signatures.find((s) => s.role === "RENTER");
    if (!renter) err("SIGNATURE", "SIGNATURE_MISSING", "Die Unterschrift des Mieters fehlt.");
    else if (renter.contentHash !== hash) err("SIGNATURE", "SIGNATURE_STALE", "Der Vertrag wurde nach der Unterschrift geändert. Der Mieter muss erneut unterschreiben.");
    if (signatures.some((s) => s.role === "EMPLOYEE" && s.contentHash !== hash)) err("SIGNATURE", "SIGNATURE_STALE_EMPLOYEE", "Die Unterschrift des Mitarbeiters passt nicht mehr zum Vertrag.");
  }
  return issues;
}

/** Stand des Vertrags für den Assistenten: aufgefrischter Entwurf, Fahrer, Unterschriften (ohne Bilddaten), Prüfergebnis, Hash. */
export async function getContractState(tenantId: string, contractId: string) {
  return db.$transaction(async (tx) => {
    await refreshContractDraft(tx, tenantId, contractId);
    const contract = await loadContract(tx, tenantId, contractId);
    const signatures = await tx.signature.findMany({ where: { tenantId, contractId }, select: { id: true, role: true, signerName: true, signedAt: true, contentHash: true }, orderBy: { signedAt: "asc" } });
    const issues = contract.status === "DRAFT" ? await collectIssues(tx, tenantId, contractId, { requireSignature: false }) : [];
    const hash = contract.status === "DRAFT" ? contentHash(signedContent(contract)) : contract.contentHash ?? "";
    const terms = await termsStateOf(tx, tenantId, contract);
    const rules = await rulesStateOf(tx, tenantId, contract);
    return { contract, signatures, issues, hash, terms, rules };
  }, TX);
}

// ---------------------------------------------------------------------------
// Mietbedingungen und Geschäftsregeln am Vertrag (Phase 15)
// ---------------------------------------------------------------------------

export const acknowledgementHash = (c: { rentalTermsVersionId: string | null; termsHash: string | null }) => (c.rentalTermsVersionId && c.termsHash ? `${c.rentalTermsVersionId}:${c.termsHash}` : null);
/** Kenntnisnahme gilt nur für genau die zugeordnete Fassung. */
export function acknowledgementValid(c: { rentalTermsVersionId: string | null; termsHash: string | null; termsAcknowledgedAt: Date | null; termsAcknowledgedHash: string | null }) {
  const h = acknowledgementHash(c);
  return !!h && !!c.termsAcknowledgedAt && c.termsAcknowledgedHash === h;
}

export type ContractTermsState = { featureActive: boolean; selected: { id: string; label: string; status: string; title: string } | null; active: { id: string; label: string } | null; newerAvailable: boolean; acknowledged: boolean; acknowledgedAt: Date | null; acknowledgedByName: string | null; legacy: boolean };
async function termsStateOf(tx: Tx, tenantId: string, c: Awaited<ReturnType<typeof loadContract>>): Promise<ContractTermsState> {
  const featureActive = await termsFeatureActive(tx, tenantId);
  const selected = c.rentalTermsVersionId ? await tx.rentalTermsVersion.findFirst({ where: { id: c.rentalTermsVersionId, tenantId }, select: { id: true, label: true, status: true, title: true } }) : null;
  const active = c.status === "DRAFT" && featureActive ? await activeTermsVersion(tx, tenantId) : null;
  return { featureActive, selected, active: active ? { id: active.id, label: active.label } : null, newerAvailable: !!active && active.id !== c.rentalTermsVersionId, acknowledged: acknowledgementValid(c), acknowledgedAt: c.termsAcknowledgedAt, acknowledgedByName: c.termsAcknowledgedByName, legacy: !c.rentalTermsVersionId && !!c.termsText };
}

export type ContractRulesState = { snapshot: ContractRules | null; resolved: ResolvedRules; deposit: ResolvedDeposit; depositSource: RuleSourceOf; newerDefaults: boolean; driveClass: "COMBUSTION" | "ELECTRIC" | "PHEV" };
type RuleSourceOf = ReturnType<typeof depositSourceOf>;
async function rulesStateOf(tx: Tx, tenantId: string, c: Awaited<ReturnType<typeof loadContract>>): Promise<ContractRulesState> {
  const booking = await tx.booking.findFirstOrThrow({ where: { id: c.bookingId, tenantId }, include: { customer: true, vehicle: { include: { group: true } }, tenant: true } });
  const resolved = resolveFor(booking);
  const deposit = depositFor(booking);
  const snapshot = readContractRules(c.conditions);
  // neuere Standardwerte: Regeln oder Kautionsvorgabe weichen vom Stand des Schnappschusses ab (Kaution nur, wenn der Schnappschuss sie kennt)
  const depositChanged = !!snapshot && snapshot.depositResolvedCents != null && snapshot.depositResolvedCents !== deposit.cents;
  return { snapshot, resolved, deposit, depositSource: depositSourceOf(Math.round(Number(c.deposit) * 100), deposit), newerDefaults: c.status === "DRAFT" && !!snapshot && (snapshot.defaultsFingerprint !== rulesFingerprint(resolved.values) || depositChanged), driveClass: driveClassOf((c.vehicleSnapshot as VehicleSnapshot).fuel ?? booking.vehicle.fuel) };
}

/** Bewusster Wechsel auf eine (neuere) veröffentlichte Fassung. Setzt die Kenntnisnahme zurück; Unterschriften verfallen. */
export async function adoptTermsVersion(tenantId: string, contractId: string, actor: Actor, versionId: string | null = null) {
  return db.$transaction(async (tx) => {
    const c = await loadContract(tx, tenantId, contractId);
    assertContractDraft(c);
    const version = versionId ? await tx.rentalTermsVersion.findFirst({ where: { id: versionId, tenantId } }) : await activeTermsVersion(tx, tenantId);
    if (!version) throw new DomainError("Es gibt keine veröffentlichte Mietbedingungen-Fassung.");
    if (version.status !== "PUBLISHED") throw new DomainError(`Die Fassung ${version.label} ist nicht veröffentlicht.`);
    if (version.effectiveFrom && version.effectiveFrom > new Date()) throw new DomainError(`Die Fassung ${version.label} gilt erst ab einem späteren Zeitpunkt.`);
    if (version.id === c.rentalTermsVersionId && c.termsHash === version.checksum) return c;
    await tx.rentalContract.update({ where: { id: c.id }, data: { rentalTermsVersionId: version.id, termsVersion: version.label, termsText: version.content, termsHash: version.checksum, termsFormat: "MARKDOWN", termsAcknowledgedAt: null, termsAcknowledgedById: null, termsAcknowledgedByName: null, termsAcknowledgedHash: null } });
    await recordAudit(tx, tenantId, actor, { action: "CONTRACT_TERMS_SELECTED", bookingId: c.bookingId, details: { contractNumber: c.number, versionId: version.id, label: version.label, checksum: version.checksum, from: c.termsVersion, automatic: false } });
    return refreshContractDraft(tx, tenantId, contractId);
  }, TX).catch(domainFromDb);
}

/** Kenntnisnahme: bewusst bestätigt, mit Zeitpunkt, Person und Fassung. Nie vorausgewählt, serverseitig geprüft. */
export async function acknowledgeTerms(tenantId: string, contractId: string, actor: Actor, input: { confirmed: boolean }) {
  if (!input.confirmed) throw new DomainError("Bitte die Kenntnisnahme der Mietbedingungen ausdrücklich bestätigen.");
  return db.$transaction(async (tx) => {
    const c = await loadContract(tx, tenantId, contractId);
    assertContractDraft(c);
    const h = acknowledgementHash(c);
    if (!h) throw new DomainError("Dem Vertrag ist keine Mietbedingungen-Fassung zugeordnet.");
    const version = await tx.rentalTermsVersion.findFirst({ where: { id: c.rentalTermsVersionId!, tenantId }, select: { status: true, checksum: true, label: true } });
    if (!version || version.status !== "PUBLISHED" || version.checksum !== c.termsHash) throw new DomainError("Die zugeordnete Fassung ist nicht mehr gültig. Bitte die aktuelle Fassung übernehmen.");
    if (c.termsAcknowledgedHash === h && c.termsAcknowledgedAt) return c;
    const updated = await tx.rentalContract.update({ where: { id: c.id }, data: { termsAcknowledgedAt: new Date(), termsAcknowledgedById: actor.id, termsAcknowledgedByName: actor.name, termsAcknowledgedHash: h } });
    await recordAudit(tx, tenantId, actor, { action: "CONTRACT_TERMS_ACKNOWLEDGED", bookingId: c.bookingId, details: { contractNumber: c.number, versionId: c.rentalTermsVersionId, label: version.label, checksum: c.termsHash } });
    return updated;
  }, TX).catch(domainFromDb);
}

/** „Aktuelle Standardwerte übernehmen“: nur Werte ohne individuelle Anpassung; Unterschriften verfallen (Inhalt ändert sich). */
export async function adoptContractDefaults(tenantId: string, contractId: string, actor: Actor) {
  return db.$transaction(async (tx) => {
    const c = await loadContract(tx, tenantId, contractId);
    assertContractDraft(c);
    const booking = await tx.booking.findFirstOrThrow({ where: { id: c.bookingId, tenantId }, include: { customer: true, vehicle: { include: { group: true } }, tenant: true } });
    const resolved = resolveFor(booking);
    const depositRule = depositFor(booking);
    const current = readContractRules(c.conditions) ?? initialContractRules(resolved, new Date(), depositRule);
    const next = adoptDefaults(current, resolved, new Date(), depositRule);
    const deductibleDefault = (next.values.deductibleCents ?? 0) / 100;
    // Kaution: nur übernehmen, wenn sie noch der bisherigen Vorgabe entspricht (nicht individuell angepasst); Buchung folgt dem Vertragswert
    const depositFollows = current.depositResolvedCents != null && Math.round(Number(c.deposit) * 100) === current.depositResolvedCents && depositRule.cents !== current.depositResolvedCents;
    if (depositFollows) await tx.booking.update({ where: { id: c.bookingId }, data: { deposit: depositRule.cents / 100 } });
    await tx.rentalContract.update({ where: { id: c.id }, data: { conditions: next as unknown as Prisma.InputJsonValue, ...(depositFollows ? { deposit: depositRule.cents / 100 } : {}), ...(next.sources.deductibleCents !== "CONTRACT" ? { deductible: deductibleDefault } : {}), ...(next.sources.fuelRule !== "CONTRACT" ? { fuelPolicy: next.values.fuelRule } : {}) } });
    await recordAudit(tx, tenantId, actor, { action: "CONTRACT_DEFAULTS_ADOPTED", bookingId: c.bookingId, details: { contractNumber: c.number, fingerprint: next.defaultsFingerprint } });
    return refreshContractDraft(tx, tenantId, contractId);
  }, TX).catch(domainFromDb);
}

function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_(?:DOMAIN|IMMUTABLE): ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}

/**
 * Verbindlicher Abschluss. Sperrt die Vertragszeile, frischt ein letztes Mal auf, prüft alles erneut und
 * versiegelt. Ein zweiter Aufruf, auch gleichzeitig, scheitert: Der Vertrag ist dann kein Entwurf mehr.
 */
export async function finalizeContract(tenantId: string, contractId: string) {
  return db.$transaction(async (tx) => {
    // Zeilensperre: parallele Abschlüsse laufen nacheinander
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "RentalContract" WHERE "id" = ${contractId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Vertrag nicht gefunden.");
    if (locked[0].status === "SIGNED") throw new DomainError("Der Mietvertrag ist bereits abgeschlossen.");
    if (locked[0].status !== "DRAFT") throw new DomainError("Dieser Vertrag kann nicht mehr abgeschlossen werden.");

    await refreshContractDraft(tx, tenantId, contractId);
    const problems = errorsOf(await collectIssues(tx, tenantId, contractId, { requireSignature: true }));
    if (problems.length > 0) throw new DomainError(problems.length === 1 ? problems[0].message : `${problems[0].message} (und ${problems.length - 1} weitere Punkte)`);

    const contract = await loadContract(tx, tenantId, contractId);
    const hash = contentHash(signedContent(contract));
    // Vermieterdaten einfrieren: Dokumente zeigen später den Briefkopf von heute, auch wenn sich die Stammdaten ändern
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, street: true, zip: true, city: true, phone: true, email: true, website: true, logoStorageKey: true, logoChecksum: true } });
    return tx.rentalContract.update({ where: { id: contract.id }, data: { status: "SIGNED", signedAt: new Date(), contentHash: hash, wizardStep: 7, landlordSnapshot: landlordFromTenant(tenant) } });
  }, TX).catch(domainFromDb);
}

/** Nachweis: passt der gespeicherte Hash eines unterschriebenen Vertrags noch zum Inhalt? */
export async function verifyContract(tenantId: string, contractId: string) {
  return db.$transaction(async (tx) => {
    const c = await loadContract(tx, tenantId, contractId);
    const hash = contentHash(signedContent(c));
    return { signed: c.status === "SIGNED", storedHash: c.contentHash, currentHash: hash, intact: c.status === "SIGNED" && c.contentHash === hash };
  }, TX);
}
