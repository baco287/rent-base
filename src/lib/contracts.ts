// Mietvertrag: hängt 1:1 an der Buchung. Beim Anlegen werden Kunde, Fahrzeug, Preise und Konditionen
// kopiert (Snapshot). Spätere Änderungen an Stammdaten wirken nicht auf den Vertrag.
// Jede Funktion verlangt die tenantId und filtert damit jede Abfrage.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DomainError, assertContractDraft, contentHash } from "@/lib/integrity";
import { nextContractNumber } from "@/lib/numbering";
import { calculateRentalPrice, rateCardFrom, toNumber } from "@/lib/pricing";

type Tx = Prisma.TransactionClient;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Kopie der Kundendaten, wie sie auf dem Vertrag stehen. */
export function snapshotCustomer(c: Prisma.CustomerGetPayload<object>) {
  return {
    id: c.id,
    type: c.type,
    companyName: c.companyName,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    street: c.street,
    zip: c.zip,
    city: c.city,
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

export type ContractOptions = {
  deductible?: number;
  fuelPolicy?: "SAME_LEVEL" | "FULL_TO_FULL";
  fuelPricePerLiter?: number | null;
  termsVersion?: string | null;
  termsText?: string | null; // daraus wird termsHash berechnet
  conditions?: Record<string, unknown> | null;
};

/**
 * Legt den Vertragsentwurf zur Buchung an und friert Kunde, Fahrzeug, Preise und Konditionen ein.
 * Preise kommen aus der Buchung (dort bereits als Snapshot), Kilometer-Konditionen aus dem Fahrzeug.
 */
export async function createContractDraft(tenantId: string, bookingId: string, userId: string | null, options: ContractOptions = {}) {
  return db.$transaction(async (tx) => {
    const booking = await tx.booking.findFirst({
      where: { id: bookingId, tenantId },
      include: { customer: true, vehicle: { include: { group: true } }, contract: true },
    });
    if (!booking) throw new DomainError("Buchung nicht gefunden.");
    if (booking.contract) throw new DomainError(`Zu dieser Buchung gibt es bereits den Vertrag ${booking.contract.number}.`);
    if (booking.status === "CANCELLED" || booking.status === "RETURNED") throw new DomainError("Für abgeschlossene oder stornierte Buchungen wird kein Vertrag mehr angelegt.");

    const price = calculateRentalPrice({
      start: booking.startAt,
      end: booking.endAt,
      rates: rateCardFrom(booking),
      discountPercent: booking.customer.discountPercent,
    });

    const number = await nextContractNumber(tx, tenantId, booking.startAt);
    return tx.rentalContract.create({
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
        totalAmount: price.total,
        discountPercent: price.discountPercent,
        deposit: booking.deposit,
        kmIncludedPerDay: booking.vehicle.kmIncludedPerDay,
        extraKmRate: booking.vehicle.extraKmRate,
        deductible: options.deductible ?? 0,
        fuelPolicy: options.fuelPolicy ?? "SAME_LEVEL",
        fuelPricePerLiter: options.fuelPricePerLiter ?? null,
        conditions: (options.conditions ?? undefined) as Prisma.InputJsonValue | undefined,
        termsVersion: options.termsVersion ?? null,
        termsHash: options.termsText ? contentHash(options.termsText) : null,
        createdById: userId,
      },
    });
  });
}

export type DriverInput = {
  customerId?: string | null;
  role?: "MAIN" | "ADDITIONAL";
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

/** Fahrer oder Zusatzfahrer am Vertrag. Die Daten werden kopiert, eine Kundenkarte ist nicht nötig. */
export async function addContractDriver(tenantId: string, contractId: string, input: DriverInput) {
  return db.$transaction(async (tx) => {
    const contract = await tx.rentalContract.findFirst({ where: { id: contractId, tenantId } });
    if (!contract) throw new DomainError("Vertrag nicht gefunden.");
    assertContractDraft(contract);
    if (input.customerId) {
      const c = await tx.customer.count({ where: { id: input.customerId, tenantId } });
      if (c !== 1) throw new DomainError("Der verknüpfte Kunde gehört nicht zu diesem Mandanten.");
    }
    return tx.contractDriver.create({
      data: {
        tenantId,
        contractId,
        customerId: input.customerId ?? null,
        role: input.role ?? "ADDITIONAL",
        firstName: input.firstName,
        lastName: input.lastName,
        birthDate: input.birthDate,
        street: input.street,
        zip: input.zip,
        city: input.city,
        country: input.country ?? "DE",
        licenseNumber: input.licenseNumber,
        licenseClass: input.licenseClass,
        licenseIssuedAt: input.licenseIssuedAt,
        licenseValidUntil: input.licenseValidUntil ?? null,
        licenseCountry: input.licenseCountry ?? "DE",
        licenseIssuedBy: input.licenseIssuedBy ?? null,
      },
    });
  });
}

/** Inhalt, über den der Vertrags-Hash gebildet wird. Unterschriften beziehen sich auf genau diesen Hash. */
async function contractContent(tx: Tx, tenantId: string, contractId: string) {
  const c = await tx.rentalContract.findFirst({ where: { id: contractId, tenantId }, include: { drivers: { orderBy: { createdAt: "asc" } } } });
  if (!c) throw new DomainError("Vertrag nicht gefunden.");
  const content = {
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
    fuelPricePerLiter: toNumber(c.fuelPricePerLiter),
    conditions: c.conditions,
    termsVersion: c.termsVersion,
    termsHash: c.termsHash,
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
  return { contract: c, hash: contentHash(content) };
}

/** Hash des aktuellen Entwurfs. Diesen Wert bekommt die Unterschrift mit. */
export async function getContractContentHash(tenantId: string, contractId: string) {
  return db.$transaction(async (tx) => (await contractContent(tx, tenantId, contractId)).hash);
}

/**
 * Schließt den Vertrag ab. Verlangt mindestens die Unterschrift des Mieters, und zwar über genau den
 * Inhalt, der jetzt versiegelt wird. Danach ist der Vertrag gesperrt (Code und Datenbank-Trigger).
 */
export async function signContract(tenantId: string, contractId: string) {
  return db.$transaction(async (tx) => {
    const { contract, hash } = await contractContent(tx, tenantId, contractId);
    assertContractDraft(contract);
    const signatures = await tx.signature.findMany({ where: { tenantId, contractId } });
    if (!signatures.some((s) => s.role === "RENTER")) throw new DomainError("Die Unterschrift des Mieters fehlt.");
    const stale = signatures.find((s) => s.contentHash !== hash);
    if (stale) throw new DomainError("Der Vertrag wurde nach der Unterschrift geändert. Bitte erneut unterschreiben lassen.");
    return tx.rentalContract.update({ where: { id: contract.id }, data: { status: "SIGNED", signedAt: new Date(), contentHash: hash } });
  });
}
