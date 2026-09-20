// Mietvertrag: hängt 1:1 an der Buchung (Booking bleibt der Anker).
//
// Entwurf:   Kopien von Kunde, Fahrzeug, Preis und Mietbedingungen werden laufend aus den Stammdaten
//            aufgefrischt (refreshContractDraft), damit der Assistent immer den aktuellen Stand zeigt.
// Abschluss: Beim Finalisieren wird ein letztes Mal aufgefrischt, alles geprüft, der Inhalt gehasht und
//            der Vertrag gesperrt. Danach wirken Änderungen an Kunde, Fahrzeug oder Preisen nicht mehr.
// Unterschrift: gehört zu genau einem Inhalts-Hash. Ändert sich der Inhalt, wird sie verworfen.
//
// Jede Funktion verlangt die tenantId und filtert damit jede Abfrage.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { findConflicts } from "@/lib/bookings";
import { checkCustomer, checkDriver, errorsOf, type Issue } from "@/lib/contract-checks";
import { DomainError, assertContractDraft, contentHash, sha256 } from "@/lib/integrity";
import { landlordFromTenant } from "@/lib/contract-view";
import { isUniqueViolation, nextContractNumber, withNumberRetry } from "@/lib/numbering";
import { calculateRentalPrice, rateCardFrom, toNumber, type PriceBreakdown } from "@/lib/pricing";
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

export type ContractPriceSnapshot = PriceBreakdown & { agreedTotal: number | null; agreedTotalNote: string | null; finalTotal: number };

/**
 * Die eine Stelle, an der der Vertragspreis entsteht: zentrale Preisfunktion plus optional abweichend
 * vereinbarter Gesamtpreis. Eine geänderte Tariflogik wird nur in lib/pricing.ts angepasst.
 */
export function contractPrice(
  booking: { startAt: Date; endAt: Date; dailyRate: unknown; workWeekRate?: unknown; weeklyRate?: unknown; monthlyRate?: unknown },
  discountPercent: number,
  agreedTotal: number | null,
  agreedTotalNote: string | null,
): ContractPriceSnapshot {
  const price = calculateRentalPrice({ start: booking.startAt, end: booking.endAt, rates: rateCardFrom(booking), discountPercent });
  return { ...price, agreedTotal, agreedTotalNote: agreedTotal != null ? agreedTotalNote : null, finalTotal: agreedTotal ?? price.total };
}

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
        const price = contractPrice(booking, booking.customer.discountPercent, null, null);
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
            deposit: booking.deposit,
            kmIncludedPerDay: booking.vehicle.kmIncludedPerDay,
            extraKmRate: booking.vehicle.extraKmRate,
            termsVersion: booking.tenant.rentalTermsVersion,
            termsText: booking.tenant.rentalTermsText,
            termsHash: booking.tenant.rentalTermsText ? sha256(booking.tenant.rentalTermsText) : null,
            createdById: actor?.id ?? null,
          },
        });
        await syncPrimaryDriver(tx, tenantId, contract.id, "RENTER", booking.customer);
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
  const price = contractPrice(booking, booking.customer.discountPercent, toNumber(contract.agreedTotal), contract.agreedTotalNote);

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
      ...(vehicleChanged ? { kmIncludedPerDay: booking.vehicle.kmIncludedPerDay, extraKmRate: booking.vehicle.extraKmRate } : {}),
      termsVersion: booking.tenant.rentalTermsVersion,
      termsText: booking.tenant.rentalTermsText,
      termsHash: booking.tenant.rentalTermsText ? sha256(booking.tenant.rentalTermsText) : null,
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
  fuelPolicy: "FULL_TO_FULL" | "SAME_LEVEL" | "INCLUDED" | "OTHER";
  fuelPolicyNote?: string | null;
  fuelPricePerLiter?: number | null;
  agreedTotal?: number | null;
  agreedTotalNote?: string | null;
  pickupLocation?: string | null;
  returnLocation?: string | null;
  internalNote?: string | null;
};

/**
 * Speichert die Konditionen. Zeitraum und Kaution gehören zur Buchung und werden dort geändert,
 * mit derselben Konfliktprüfung wie beim Bearbeiten einer Buchung.
 */
export async function saveConditions(tenantId: string, contractId: string, input: ConditionsInput) {
  if (!(input.endAt > input.startAt)) throw new DomainError("Die Rückgabe muss nach dem Mietbeginn liegen.");
  if (input.fuelPolicy === "OTHER" && !input.fuelPolicyNote?.trim()) throw new DomainError("Bitte die individuelle Tankregelung beschreiben.");
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
    await tx.rentalContract.update({
      where: { id: c.id },
      data: {
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
  const vehicle = await tx.vehicle.findFirst({ where: { id: c.vehicleId, tenantId } });
  if (!booking) err("PERIOD", "BOOKING_MISSING", "Die Buchung gehört nicht zu diesem Mandanten.");
  if (!customer) err("CUSTOMER", "CUSTOMER_MISSING", "Der Kunde gehört nicht zu diesem Mandanten.");
  if (!vehicle) err("VEHICLE", "VEHICLE_MISSING", "Das Fahrzeug gehört nicht zu diesem Mandanten.");
  if (!booking || !customer || !vehicle) return issues;

  if (booking.status !== "RESERVED") err("PERIOD", "BOOKING_STATUS", "Die Buchung ist nicht mehr reserviert. Ein Vertrag kann nur für reservierte Buchungen abgeschlossen werden.");
  if (!(c.endAt > c.startAt)) err("PERIOD", "PERIOD_INVALID", "Die Rückgabe muss nach dem Mietbeginn liegen.");

  // Mieter: geprüft wird, was tatsächlich auf dem Vertrag steht
  issues.push(...checkCustomer({ ...(c.customerSnapshot as CustomerSnapshot), blocked: customer.blocked, blockReason: customer.blockReason }, c.startAt));

  // Fahrer
  const primary = c.drivers.find((d) => d.role === "PRIMARY_DRIVER");
  if (!primary) {
    if (c.driverMode === "RENTER") issues.push(...checkDriver({ ...(c.customerSnapshot as CustomerSnapshot), licenseCountry: customer.country }, c.startAt, "Fahrer (Mieter)"));
    else err("DRIVER", "DRIVER_MISSING", "Es ist noch kein Fahrer erfasst.");
  } else {
    issues.push(...checkDriver(primary, c.startAt, c.driverMode === "RENTER" ? "Fahrer (Mieter)" : `Fahrer ${primary.firstName} ${primary.lastName}`));
  }
  for (const d of c.drivers.filter((x) => x.role === "ADDITIONAL_DRIVER")) issues.push(...checkDriver(d, c.startAt, `Zusatzfahrer ${d.firstName} ${d.lastName}`, "ADDITIONAL_DRIVER"));

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
  if (!c.termsText) issues.push({ area: "CONDITIONS", code: "TERMS_MISSING", severity: "warning", message: "Es sind keine Mietbedingungen hinterlegt (Einstellungen). Der Vertrag enthält dann keinen Bedingungstext." });
  if (!c.pickupLocation) issues.push({ area: "CONDITIONS", code: "PICKUP_LOCATION", severity: "warning", message: "Kein Abholort angegeben." });

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
    return { contract, signatures, issues, hash };
  }, TX);
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
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, street: true, zip: true, city: true, phone: true, email: true } });
    return tx.rentalContract.update({ where: { id: contract.id }, data: { status: "SIGNED", signedAt: new Date(), contentHash: hash, wizardStep: 7, landlordSnapshot: landlordFromTenant(tenant) } });
  }, TX);
}

/** Nachweis: passt der gespeicherte Hash eines unterschriebenen Vertrags noch zum Inhalt? */
export async function verifyContract(tenantId: string, contractId: string) {
  return db.$transaction(async (tx) => {
    const c = await loadContract(tx, tenantId, contractId);
    const hash = contentHash(signedContent(c));
    return { signed: c.status === "SIGNED", storedHash: c.contentHash, currentHash: hash, intact: c.status === "SIGNED" && c.contentHash === hash };
  }, TX);
}
