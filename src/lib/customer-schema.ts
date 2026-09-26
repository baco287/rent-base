// Validierung der Kundendaten. Wird vom Kundenformular und vom Buchungsformular (Kunde direkt anlegen) genutzt.
import { z } from "zod";
import { CUSTOMER_TYPES, ID_TYPES } from "@/lib/constants";

const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());
const optDate = z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.coerce.date().optional());

export const customerSchema = z
  .object({
    type: z.enum(Object.keys(CUSTOMER_TYPES) as [string, ...string[]]),
    companyName: optStr,
    firstName: z.string({ message: "Bitte den Vornamen eingeben." }).trim().min(1, "Bitte den Vornamen eingeben."),
    lastName: z.string({ message: "Bitte den Nachnamen eingeben." }).trim().min(1, "Bitte den Nachnamen eingeben."),
    email: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().toLowerCase().email("Die E-Mail-Adresse ist ungültig.").optional()),
    phone: optStr,
    street: optStr,
    zip: optStr,
    city: optStr,
    country: z.preprocess((v) => (v === "" || v === undefined ? "DE" : v), z.string().trim().min(2).max(10)),
    birthDate: optDate,
    birthPlace: optStr,
    nationality: optStr,
    idType: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.enum(Object.keys(ID_TYPES) as [string, ...string[]]).optional()),
    idNumber: optStr,
    idIssuedBy: optStr,
    idIssuedAt: optDate,
    idValidUntil: optDate,
    licenseNumber: optStr,
    licenseClass: optStr,
    licenseIssuedBy: optStr,
    licenseIssuedAt: optDate,
    licenseValidUntil: optDate,
    blocked: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
    blockReason: optStr,
    discountPercent: z.preprocess((v) => (v === "" || v === undefined ? 0 : v), z.coerce.number().int().min(0).max(100)),
    notes: optStr,
    legacyNumber: optStr,
  })
  .refine((d) => d.type !== "COMPANY" || d.companyName, { message: "Bei Firmenkunden bitte den Firmennamen eingeben.", path: ["companyName"] });

export type CustomerInput = z.infer<typeof customerSchema>;

/** Wandelt geprüfte Eingaben in Datenbankfelder (leere Angaben werden zu null). */
export function customerToData(d: CustomerInput) {
  return {
    type: d.type,
    companyName: d.type === "COMPANY" ? d.companyName ?? null : null,
    firstName: d.firstName,
    lastName: d.lastName,
    email: d.email ?? null,
    phone: d.phone ?? null,
    street: d.street ?? null,
    zip: d.zip ?? null,
    city: d.city ?? null,
    country: d.country,
    birthDate: d.birthDate ?? null,
    birthPlace: d.birthPlace ?? null,
    nationality: d.nationality ?? null,
    idType: d.idType ?? null,
    idNumber: d.idNumber ?? null,
    idIssuedBy: d.idIssuedBy ?? null,
    idIssuedAt: d.idIssuedAt ?? null,
    idValidUntil: d.idValidUntil ?? null,
    licenseNumber: d.licenseNumber ?? null,
    licenseClass: d.licenseClass ?? null,
    licenseIssuedBy: d.licenseIssuedBy ?? null,
    licenseIssuedAt: d.licenseIssuedAt ?? null,
    licenseValidUntil: d.licenseValidUntil ?? null,
    blocked: d.blocked,
    blockReason: d.blocked ? d.blockReason ?? null : null,
    discountPercent: d.discountPercent,
    notes: d.notes ?? null,
    legacyNumber: d.legacyNumber ?? null,
  };
}

/** Liest Kundenfelder mit Präfix aus einem Formular, z. B. "c_firstName" im Buchungsformular. */
export function customerFieldsFromForm(formData: FormData, prefix: string) {
  const out: Record<string, FormDataEntryValue> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}
