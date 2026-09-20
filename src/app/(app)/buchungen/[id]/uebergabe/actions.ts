"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { getStorage } from "@/lib/storage";
import {
  HANDOVER_STEPS,
  addNewDamage,
  answerChecklist,
  finalizeHandover,
  removeHandoverSignature,
  removeNewDamage,
  saveHandoverSignature,
  setHandoverStep,
  startHandover,
  updateHandoverDraft,
  updateNewDamage,
} from "@/lib/handovers";

export type StepState = { error?: string } | undefined;
type Result = { error?: string } | undefined;

const base = (bookingId: string) => `/buchungen/${bookingId}/uebergabe`;

/** Rolle, Mandant und das Übergabeprotokoll der Buchung. Übergaben führen Inhaber, Disponent und Hofmitarbeiter durch. */
async function context(bookingId: string) {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const handover = await db.handover.findFirst({ where: { bookingId, tenantId: tenant.id, type: "PICKUP", correctsId: null }, orderBy: { createdAt: "desc" } });
  if (!handover) redirect(base(bookingId));
  return { tenant, user, handover, actor: { id: user.id, name: user.name } };
}

function asState(e: unknown): StepState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Das Protokoll ist finalisiert und kann nicht mehr geändert werden." };
  throw e;
}

async function go(bookingId: string, handoverId: string, tenantId: string, from: number, formData: FormData): Promise<never> {
  const step = Math.min(HANDOVER_STEPS, Math.max(1, formData.get("nav") === "back" ? from - 1 : from + 1));
  await setHandoverStep(tenantId, handoverId, step);
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=${step}`);
}

export async function startPickupAction(bookingId: string) {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  try {
    await startHandover(tenant.id, bookingId, "PICKUP", { id: user.id, name: user.name });
  } catch (e) {
    if (e instanceof DomainError) redirect(`${base(bookingId)}?hinweis=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidatePath(`/buchungen/${bookingId}`);
  redirect(`${base(bookingId)}?schritt=1`);
}

/** Schritte ohne eigene Eingaben: nur weiter oder zurück. */
export async function navigateStepAction(bookingId: string, step: number, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, handover } = await context(bookingId);
  return go(bookingId, handover.id, tenant.id, step, formData);
}

const optInt = (msg: string, min: number, max: number) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : typeof v === "string" ? v.replace(/\./g, "").trim() : v), z.coerce.number({ message: msg }).int(msg).min(min, msg).max(max, msg).optional());

const readingsSchema = z.object({
  mileage: optInt("Bitte den Kilometerstand als ganze Zahl eingeben.", 0, 9_999_999),
  fuelLevelEighths: optInt("Bitte den Tankstand wählen.", 0, 8),
  batteryPercent: optInt("Der Batteriestand liegt zwischen 0 und 100 Prozent.", 0, 100),
  notes: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(2000).optional()),
});

// Schritt 2: Kilometer und Tank/Batterie. Der Kilometerstand des Fahrzeugs ändert sich erst beim Finalisieren.
export async function saveReadingsAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, handover } = await context(bookingId);
  const back = formData.get("nav") === "back";
  const parsed = readingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    if (back) return go(bookingId, handover.id, tenant.id, 2, formData);
    return { error: parsed.error.issues[0].message };
  }
  try {
    const d = parsed.data;
    await updateHandoverDraft(tenant.id, handover.id, { mileage: d.mileage ?? null, fuelLevelEighths: d.fuelLevelEighths ?? null, batteryPercent: d.batteryPercent ?? null, notes: d.notes ?? null });
  } catch (e) {
    return asState(e);
  }
  return go(bookingId, handover.id, tenant.id, 2, formData);
}

// Schritt 3: Schäden auf der Skizze. Positionen kommen normalisiert (0 bis 1) an und werden so gespeichert.
const damageSchema = z.object({
  view: z.string().min(1),
  posX: z.number().min(0).max(1),
  posY: z.number().min(0).max(1),
  kind: z.string().min(1),
  severity: z.string().min(1),
  size: z.string().max(80).optional(),
  description: z.string().trim().min(3, "Bitte den Schaden kurz beschreiben.").max(500),
});

function asResult(e: unknown): Result {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Das Protokoll ist finalisiert und kann nicht mehr geändert werden." };
  throw e;
}

export async function addDamageAction(bookingId: string, payload: unknown): Promise<Result> {
  const { tenant, handover } = await context(bookingId);
  const parsed = damageSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    await addNewDamage(tenant.id, handover.id, parsed.data);
  } catch (e) {
    return asResult(e);
  }
  revalidatePath(base(bookingId));
}

export async function updateDamageAction(bookingId: string, damageId: string, payload: unknown): Promise<Result> {
  const { tenant, handover } = await context(bookingId);
  const parsed = damageSchema.partial().safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const owned = await db.handoverDamage.count({ where: { id: damageId, tenantId: tenant.id, handoverId: handover.id } });
    if (owned !== 1) return { error: "Schaden nicht gefunden." };
    await updateNewDamage(tenant.id, damageId, parsed.data);
  } catch (e) {
    return asResult(e);
  }
  revalidatePath(base(bookingId));
}

export async function removeDamageAction(bookingId: string, damageId: string): Promise<Result> {
  const { tenant, handover } = await context(bookingId);
  try {
    const owned = await db.handoverDamage.count({ where: { id: damageId, tenantId: tenant.id, handoverId: handover.id } });
    if (owned !== 1) return { error: "Schaden nicht gefunden." };
    const keys = await removeNewDamage(tenant.id, damageId);
    // Dateien der gelöschten Fotos aufräumen; ein Fehler hier darf den Vorgang nicht scheitern lassen
    await Promise.all(keys.map((k) => Promise.resolve().then(() => getStorage().remove(k)).catch(() => {})));
  } catch (e) {
    return asResult(e);
  }
  revalidatePath(base(bookingId));
}

// Schritt 5: Checkliste. Felder r_<id> für die Antwort, n_<id> für die Bemerkung.
export async function saveChecklistAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, handover } = await context(bookingId);
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: tenant.id, handoverId: handover.id }, select: { id: true } });
  const answers = items.map((i) => ({ itemId: i.id, result: (formData.get(`r_${i.id}`) as string | null) ?? null, note: (formData.get(`n_${i.id}`) as string | null) ?? null }));
  try {
    await answerChecklist(tenant.id, handover.id, answers);
  } catch (e) {
    return asState(e);
  }
  return go(bookingId, handover.id, tenant.id, 5, formData);
}

// Schritt 6: Unterschrift, gebunden an den angezeigten Protokollstand
const signatureSchema = z.object({
  role: z.enum(["RENTER", "EMPLOYEE"]),
  signerName: z.string().trim().min(2, "Bitte den Namen des Unterzeichners angeben."),
  imageDataUrl: z.string().min(1, "Bitte zuerst im Feld unterschreiben."),
  seenHash: z.string().length(64, "Die Seite ist veraltet. Bitte neu laden."),
});

export async function saveSignatureAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, handover, actor } = await context(bookingId);
  const parsed = signatureSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const h = await headers();
    await saveHandoverSignature(tenant.id, actor, handover.id, { ...parsed.data, ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: h.get("user-agent") });
  } catch (e) {
    return asState(e);
  }
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=6`);
}

export async function removeSignatureAction(bookingId: string, role: "RENTER" | "EMPLOYEE") {
  const { tenant, handover } = await context(bookingId);
  try {
    await removeHandoverSignature(tenant.id, handover.id, role);
  } catch (e) {
    if (!(e instanceof DomainError) && !isImmutableError(e)) throw e;
  }
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=6`);
}

// Schritt 7: Abschluss. Der Server prüft alles erneut; erst hier geht die Buchung auf "Unterwegs".
export async function finalizePickupAction(bookingId: string, _prev: StepState, _formData: FormData): Promise<StepState> {
  void _formData;
  const { tenant, handover, actor } = await context(bookingId);
  try {
    await finalizeHandover(tenant.id, handover.id, actor);
  } catch (e) {
    return asState(e);
  }
  for (const p of [`/buchungen/${bookingId}`, "/buchungen", "/heute", "/dispo", "/fahrzeuge"]) revalidatePath(p);
  redirect(`${base(bookingId)}?abgeschlossen=1`);
}
