// Fahrerdaten aus dem Formular (Zusatzfahrer, abweichender Fahrer). Gemeinsam für Vertragsassistent und Nachtrag (Befehl 25):
// dieselben Felder (DriverFields), dieselbe Validierung, dieselbe Serverlogik.
import { z } from "zod";
import type { DriverInput } from "@/lib/contracts";

const reqDate = (msg: string) => z.preprocess((v) => (v === "" ? undefined : v), z.coerce.date({ message: msg }));
export const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const driverSchema = z.object({
  customerId: optStr,
  firstName: z.string().trim().min(1, "Bitte den Vornamen des Fahrers eingeben."),
  lastName: z.string().trim().min(1, "Bitte den Nachnamen des Fahrers eingeben."),
  birthDate: reqDate("Bitte das Geburtsdatum des Fahrers eingeben."),
  street: z.string().trim().min(1, "Bitte Straße und Hausnummer des Fahrers eingeben."),
  zip: z.string().trim().min(1, "Bitte die Postleitzahl des Fahrers eingeben."),
  city: z.string().trim().min(1, "Bitte den Ort des Fahrers eingeben."),
  country: z.string().trim().min(2).default("DE"),
  licenseNumber: z.string().trim().min(1, "Bitte die Führerscheinnummer eingeben."),
  licenseClass: z.string().trim().min(1, "Bitte die Führerscheinklasse eingeben."),
  licenseIssuedAt: reqDate("Bitte das Ausstellungsdatum des Führerscheins eingeben."),
  licenseValidUntil: reqDate("Bitte das Ablaufdatum des Führerscheins eingeben."),
  licenseCountry: z.string().trim().min(2, "Bitte das Ausstellungsland wählen."),
  licenseIssuedBy: optStr,
});

export function parseDriver(formData: FormData, prefix = ""): { ok: true; data: DriverInput } | { ok: false; error: string } {
  const raw: Record<string, FormDataEntryValue> = {};
  for (const [k, v] of formData.entries()) if (k.startsWith(prefix)) raw[k.slice(prefix.length)] = v;
  const parsed = driverSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  return { ok: true, data: { ...parsed.data, customerId: parsed.data.customerId ?? null, licenseIssuedBy: parsed.data.licenseIssuedBy ?? null } };
}
