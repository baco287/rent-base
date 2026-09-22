"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { customerSchema, customerToData } from "@/lib/customer-schema";
import { DomainError, isImmutableError } from "@/lib/integrity";
import {
  addAdditionalDriver,
  ensureContractDraft,
  finalizeContract,
  removeAdditionalDriver,
  removeContractSignature,
  saveConditions,
  saveContractSignature,
  setOtherDriver,
  setRenterDrives,
  setWizardStep,
  type DriverInput,
} from "@/lib/contracts";

import { runContractFollowUp } from "@/lib/followup";
import { parseLocalDateTime } from "@/lib/time";

export type StepState = { error?: string } | undefined;

const base = (bookingId: string) => `/buchungen/${bookingId}/vertrag`;

/** Rolle, Mandant und Vertrag der Buchung. Verträge erstellen, bearbeiten und abschließen dürfen nur Inhaber und Disponent. */
async function context(bookingId: string) {
  const { tenant, user } = await requireRole("DISPO");
  const contract = await db.rentalContract.findFirst({ where: { bookingId, tenantId: tenant.id } });
  if (!contract) redirect(`/buchungen/${bookingId}`);
  return { tenant, user, contract, actor: { id: user.id, name: user.name } };
}

/** Fachliche Fehler werden zur Meldung im Formular, alles andere bleibt ein echter Fehler. */
function asState(e: unknown): StepState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Der Vertrag ist abgeschlossen und kann nicht mehr geändert werden." };
  throw e;
}

async function go(bookingId: string, contractId: string, tenantId: string, from: number, formData: FormData): Promise<never> {
  const target = formData.get("nav") === "back" ? from - 1 : from + 1;
  const step = Math.min(7, Math.max(1, target));
  await setWizardStep(tenantId, contractId, step);
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=${step}`);
}

export async function startContractAction(bookingId: string) {
  const { tenant, user } = await requireRole("DISPO");
  try {
    await ensureContractDraft(tenant.id, bookingId, { id: user.id, name: user.name });
  } catch (e) {
    if (e instanceof DomainError) redirect(`/buchungen/${bookingId}?hinweis=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidatePath(`/buchungen/${bookingId}`);
  redirect(base(bookingId));
}

// Schritt 1: Kunde. Nutzt dieselbe Validierung und dieselben Felder wie die Kundenverwaltung.
export async function saveCustomerStepAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, contract } = await context(bookingId);
  const back = formData.get("nav") === "back";
  const parsed = customerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    if (back) return go(bookingId, contract.id, tenant.id, 1, formData);
    return { error: parsed.error.issues[0].message };
  }
  try {
    if (contract.status !== "DRAFT") throw new DomainError("Der Vertrag ist abgeschlossen und kann nicht mehr geändert werden.");
    // Sperre und Rabatt werden hier nicht verändert: das bleibt der Kundenverwaltung vorbehalten
    const { blocked: _b, blockReason: _r, discountPercent: _d, notes: _n, ...data } = customerToData(parsed.data);
    void _b; void _r; void _d; void _n;
    await db.customer.updateMany({ where: { id: contract.customerId, tenantId: tenant.id }, data });
    revalidatePath("/kunden");
  } catch (e) {
    return asState(e);
  }
  return go(bookingId, contract.id, tenant.id, 1, formData);
}

const reqDate = (msg: string) => z.preprocess((v) => (v === "" ? undefined : v), z.coerce.date({ message: msg }));
const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

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

function parseDriver(formData: FormData, prefix = ""): { ok: true; data: DriverInput } | { ok: false; error: string } {
  const raw: Record<string, FormDataEntryValue> = {};
  for (const [k, v] of formData.entries()) if (k.startsWith(prefix)) raw[k.slice(prefix.length)] = v;
  const parsed = driverSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  return { ok: true, data: { ...parsed.data, customerId: parsed.data.customerId ?? null, licenseIssuedBy: parsed.data.licenseIssuedBy ?? null } };
}

// Schritt 2: Fahrer
export async function saveDriverStepAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, contract } = await context(bookingId);
  const back = formData.get("nav") === "back";
  try {
    if (formData.get("driverMode") === "OTHER") {
      const d = parseDriver(formData, "d_");
      if (!d.ok) {
        if (back) return go(bookingId, contract.id, tenant.id, 2, formData);
        return { error: d.error };
      }
      await setOtherDriver(tenant.id, contract.id, d.data);
    } else {
      await setRenterDrives(tenant.id, contract.id);
    }
  } catch (e) {
    return asState(e);
  }
  return go(bookingId, contract.id, tenant.id, 2, formData);
}

// Schritte ohne eigene Eingaben (3 Fahrzeug, 5 Zusatzfahrer, 6 Zusammenfassung): nur weiter oder zurück
export async function navigateStepAction(bookingId: string, step: number, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, contract } = await context(bookingId);
  return go(bookingId, contract.id, tenant.id, step, formData);
}

const money = (msg: string) => z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: msg }).min(0, msg));
const optMoney = (msg: string) => z.preprocess((v) => (v === "" || v === undefined ? undefined : typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: msg }).min(0, msg).optional());

const conditionsSchema = z.object({
  startAt: z.preprocess(parseLocalDateTime, z.date({ message: "Bitte den Mietbeginn mit Datum und Uhrzeit angeben." })),
  endAt: z.preprocess(parseLocalDateTime, z.date({ message: "Bitte die geplante Rückgabe mit Datum und Uhrzeit angeben." })),
  deposit: money("Kaution: bitte eine Zahl ab 0 eingeben."),
  kmIncludedPerDay: money("Freikilometer: bitte eine Zahl ab 0 eingeben."),
  extraKmRate: money("Mehrkilometerpreis: bitte eine Zahl ab 0 eingeben."),
  deductible: money("Selbstbeteiligung: bitte eine Zahl ab 0 eingeben."),
  fuelPolicy: z.enum(["FULL_TO_FULL", "SAME_LEVEL", "INCLUDED", "OTHER"]),
  fuelPolicyNote: optStr,
  fuelPricePerLiter: optMoney("Preis je Liter: bitte eine Zahl ab 0 eingeben."),
  agreedTotal: optMoney("Vereinbarter Mietpreis: bitte eine Zahl ab 0 eingeben."),
  agreedTotalNote: optStr,
  pickupLocation: optStr,
  returnLocation: optStr,
  internalNote: optStr,
});

// Schritt 4: Konditionen
export async function saveConditionsStepAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, contract } = await context(bookingId);
  const back = formData.get("nav") === "back";
  const parsed = conditionsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    if (back) return go(bookingId, contract.id, tenant.id, 4, formData);
    return { error: parsed.error.issues[0].message };
  }
  try {
    await saveConditions(tenant.id, contract.id, parsed.data);
    revalidatePath(`/buchungen/${bookingId}`);
    revalidatePath("/dispo");
  } catch (e) {
    if (back && e instanceof DomainError) return go(bookingId, contract.id, tenant.id, 4, formData);
    return asState(e);
  }
  return go(bookingId, contract.id, tenant.id, 4, formData);
}

// Schritt 5: Zusatzfahrer
export async function addDriverAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, contract } = await context(bookingId);
  const d = parseDriver(formData, "a_");
  if (!d.ok) return { error: d.error };
  try {
    await addAdditionalDriver(tenant.id, contract.id, d.data);
  } catch (e) {
    return asState(e);
  }
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=5`);
}

export async function removeDriverAction(bookingId: string, driverId: string) {
  const { tenant, contract } = await context(bookingId);
  try {
    await removeAdditionalDriver(tenant.id, contract.id, driverId);
  } catch (e) {
    if (!(e instanceof DomainError) && !isImmutableError(e)) throw e;
  }
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=5`);
}

// Schritt 7: Unterschrift und Abschluss
const signatureSchema = z.object({
  role: z.enum(["RENTER", "EMPLOYEE"]),
  signerName: z.string().trim().min(2, "Bitte den Namen des Unterzeichners angeben."),
  imageDataUrl: z.string().min(1, "Bitte zuerst im Feld unterschreiben."),
  seenHash: z.string().length(64, "Die Seite ist veraltet. Bitte neu laden."),
});

export async function saveSignatureAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, contract, actor } = await context(bookingId);
  const parsed = signatureSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const h = await headers();
    await saveContractSignature(tenant.id, actor, contract.id, {
      ...parsed.data,
      ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: h.get("user-agent"),
    });
  } catch (e) {
    return asState(e);
  }
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=7`);
}

export async function removeSignatureAction(bookingId: string, role: "RENTER" | "EMPLOYEE") {
  const { tenant, contract } = await context(bookingId);
  try {
    await removeContractSignature(tenant.id, contract.id, role);
  } catch (e) {
    if (!(e instanceof DomainError) && !isImmutableError(e)) throw e;
  }
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=7`);
}

export async function finalizeContractAction(bookingId: string, _prev: StepState, _formData: FormData): Promise<StepState> {
  void _formData;
  const { tenant, user, contract } = await context(bookingId);
  try {
    await finalizeContract(tenant.id, contract.id);
  } catch (e) {
    return asState(e);
  }
  // Der Vertrag ist abgeschlossen. Das PDF entsteht danach; scheitert es, bleibt der Abschluss gültig und
  // das Dokument lässt sich auf der Buchungsseite nachträglich erzeugen.
  await runContractFollowUp(tenant.id, contract.id, user.id);
  revalidatePath(`/buchungen/${bookingId}`);
  revalidatePath("/buchungen");
  revalidatePath("/heute");
  redirect(`${base(bookingId)}?abgeschlossen=1`);
}
