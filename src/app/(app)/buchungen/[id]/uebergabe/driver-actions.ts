"use server";

// Fahreridentifikation und Führerscheinprüfung (Phase 19.5). Inhaber, Disponent und Hofmitarbeiter führen die
// Übergabe vollständig durch, deshalb dieselbe Rolle wie die übrigen Übergabe-Aktionen. Die Übernahme geprüfter
// Führerscheindaten in die Kundenstammdaten ist ein bewusster, separater Schritt (siehe updateCustomerLicenseAction).

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { parseLocalDateTime } from "@/lib/time";
import {
  confirmVerification,
  recordIdentityCheck,
  recordLicenseCheck,
  startOrGetVerification,
  updateCustomerLicenseFromVerification,
  type IdentityCheckInput,
  type LicenseCheckInput,
} from "@/lib/driver-verification";

export type DriverState = { error?: string; ok?: string } | undefined;

const base = (bookingId: string) => `/buchungen/${bookingId}/uebergabe`;

function asState(e: unknown): DriverState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Das Protokoll ist finalisiert. Fahrerprüfungen können nicht mehr geändert werden." };
  throw e;
}

function refresh(bookingId: string) {
  revalidatePath(base(bookingId));
}

/** Legt den Prüfvermerk eines Fahrers an bzw. öffnet den bestehenden Entwurf. */
export async function startDriverVerificationAction(bookingId: string, handoverId: string, contractDriverId: string, _prev: DriverState, _formData: FormData): Promise<DriverState> {
  void _formData;
  const { tenant, user } = await requireRole("DISPO", "YARD");
  try {
    await startOrGetVerification(tenant.id, { id: user.id, name: user.name }, handoverId, contractDriverId);
    refresh(bookingId);
    return { ok: "Prüfung begonnen." };
  } catch (e) {
    return asState(e);
  }
}

const identitySchema = z.object({
  documentType: z.enum(["PERSONALAUSWEIS", "REISEPASS", "SONSTIGER_AMTLICHER_LICHTBILDAUSWEIS"], { message: "Bitte die Dokumentart wählen." }),
  originalSeen: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()),
  nameMatched: z.enum(["1", "0"], { message: "Bitte angeben, ob der Name übereinstimmt." }),
  birthDateMatched: z.enum(["1", "0"], { message: "Bitte angeben, ob das Geburtsdatum übereinstimmt." }),
  notes: z.string().trim().max(1000).optional(),
});

/** Identitätsprüfung speichern: Dokumentart, Original vorgelegt, Namens- und Geburtsdatumsabgleich. */
export async function saveIdentityCheckAction(bookingId: string, verificationId: string, _prev: DriverState, formData: FormData): Promise<DriverState> {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const parsed = identitySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!parsed.data.originalSeen) return { error: "Bitte bestätigen, dass das Originaldokument vorgelegt wurde." };
  const input: IdentityCheckInput = {
    documentType: parsed.data.documentType,
    originalSeen: true,
    nameMatched: parsed.data.nameMatched === "1",
    birthDateMatched: parsed.data.birthDateMatched === "1",
    notes: parsed.data.notes || null,
  };
  try {
    await recordIdentityCheck(tenant.id, { id: user.id, name: user.name }, verificationId, input);
    refresh(bookingId);
    return { ok: "Identität gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

const licenseSchema = z.object({
  originalSeen: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()),
  documentValid: z.enum(["1", "0"], { message: "Bitte angeben, ob der Führerschein gültig ist." }),
  nameMatched: z.enum(["1", "0"], { message: "Bitte angeben, ob der Name übereinstimmt." }),
  licenseNumber: z.string().trim().min(1, "Bitte die Führerscheinnummer eingeben."),
  licenseCountry: z.string().trim().min(2, "Bitte das Ausstellungsland wählen."),
  licenseIssuedAt: z.string().optional(),
  licenseValidUntil: z.string().optional(),
  licenseClasses: z.union([z.array(z.string()), z.string()]).optional(),
  internationalPermitPresented: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional(),
  translationPresented: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional(),
  manualReviewConfirmed: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional(),
  deviationConfirmed: z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional(),
  notes: z.string().trim().max(1000).optional(),
});

/** Führerscheinprüfung speichern: Gültigkeit, Klassen, Abgleich mit Fahrzeuganforderung; ausländische/abweichende Fälle brauchen die bewusste Bestätigung. */
export async function saveLicenseCheckAction(bookingId: string, verificationId: string, _prev: DriverState, formData: FormData): Promise<DriverState> {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const parsed = licenseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!parsed.data.originalSeen) return { error: "Bitte bestätigen, dass der Original-Führerschein vorgelegt wurde." };
  const classes = formData.getAll("licenseClasses").map(String);
  const issuedAt = parsed.data.licenseIssuedAt ? parseLocalDateTime(`${parsed.data.licenseIssuedAt}T00:00`) : null;
  const validUntil = parsed.data.licenseValidUntil ? parseLocalDateTime(`${parsed.data.licenseValidUntil}T00:00`) : null;
  const input: LicenseCheckInput = {
    originalSeen: true,
    documentValid: parsed.data.documentValid === "1",
    nameMatched: parsed.data.nameMatched === "1",
    licenseNumber: parsed.data.licenseNumber,
    licenseCountry: parsed.data.licenseCountry,
    licenseIssuedAt: issuedAt,
    licenseValidUntil: validUntil,
    licenseClasses: classes,
    internationalPermitPresented: !!parsed.data.internationalPermitPresented,
    translationPresented: !!parsed.data.translationPresented,
    manualReviewConfirmed: !!parsed.data.manualReviewConfirmed,
    deviationConfirmed: !!parsed.data.deviationConfirmed,
    notes: parsed.data.notes || null,
  };
  try {
    await recordLicenseCheck(tenant.id, { id: user.id, name: user.name }, verificationId, input);
    refresh(bookingId);
    return { ok: "Führerschein gespeichert." };
  } catch (e) {
    return asState(e);
  }
}

/** Bestätigt den Prüfvermerk endgültig (unveränderlich danach). */
export async function confirmDriverVerificationAction(bookingId: string, verificationId: string, _prev: DriverState, _formData: FormData): Promise<DriverState> {
  void _formData;
  const { tenant, user } = await requireRole("DISPO", "YARD");
  try {
    const row = await confirmVerification(tenant.id, { id: user.id, name: user.name }, verificationId);
    refresh(bookingId);
    return { ok: `Prüfung von ${row.driverFirstNameSnapshot} ${row.driverLastNameSnapshot} bestätigt.` };
  } catch (e) {
    return asState(e);
  }
}

/** Übernimmt die bei dieser Prüfung erfassten Führerscheindaten bewusst in die Kundenstammdaten. Nur Inhaber und Disposition. */
export async function updateCustomerLicenseAction(bookingId: string, verificationId: string, _prev: DriverState, _formData: FormData): Promise<DriverState> {
  void _formData;
  const { tenant, user } = await requireRole("DISPO");
  try {
    await updateCustomerLicenseFromVerification(tenant.id, { id: user.id, name: user.name }, verificationId);
    refresh(bookingId);
    return { ok: "Kundenstammdaten aktualisiert." };
  } catch (e) {
    return asState(e);
  }
}
