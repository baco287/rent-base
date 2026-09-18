// Wandelt einen Kunden aus der Datenbank in die Werte des Kundenformulars.
// Wird von der Kundenverwaltung und vom Vertragsassistenten genutzt (eine Kundenerfassung, zwei Stellen).
import type { Prisma } from "@prisma/client";
import { toDateInput } from "@/lib/format";
import type { CustomerFormValues } from "@/app/(app)/kunden/customer-fields";

export function customerToFormValues(c: Prisma.CustomerGetPayload<object>): CustomerFormValues {
  return {
    type: c.type,
    companyName: c.companyName ?? "",
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email ?? "",
    phone: c.phone ?? "",
    street: c.street ?? "",
    zip: c.zip ?? "",
    city: c.city ?? "",
    country: c.country,
    birthDate: toDateInput(c.birthDate),
    birthPlace: c.birthPlace ?? "",
    nationality: c.nationality ?? "",
    idType: c.idType ?? "",
    idNumber: c.idNumber ?? "",
    idIssuedBy: c.idIssuedBy ?? "",
    idIssuedAt: toDateInput(c.idIssuedAt),
    idValidUntil: toDateInput(c.idValidUntil),
    licenseNumber: c.licenseNumber ?? "",
    licenseClass: c.licenseClass ?? "",
    licenseIssuedBy: c.licenseIssuedBy ?? "",
    licenseIssuedAt: toDateInput(c.licenseIssuedAt),
    licenseValidUntil: toDateInput(c.licenseValidUntil),
    blocked: c.blocked,
    blockReason: c.blockReason ?? "",
    discountPercent: c.discountPercent.toString(),
    notes: c.notes ?? "",
  };
}
