"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { CHARGE_UNITS, EXTRA_CHARGE_TYPES } from "@/lib/constants";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { getStorage } from "@/lib/storage";
import { runReturnFollowUp } from "@/lib/followup";
import { addNewDamage, answerChecklist, finalizeHandover, removeHandoverSignature, removeNewDamage, saveHandoverSignature, setHandoverStep, startHandover, updateHandoverDraft, updateNewDamage } from "@/lib/handovers";
import { addManualCharge, confirmProposal, removeCharge } from "@/lib/returns";

export type StepState = { error?: string } | undefined;
type Result = { error?: string } | undefined;

// "use server"-Dateien dürfen nur Funktionen exportieren
const RETURN_STEP_COUNT = 9;
const base = (bookingId: string) => `/buchungen/${bookingId}/rueckgabe`;

/** Rolle, Mandant und das Rückgabeprotokoll der Buchung. Rückgaben führen Inhaber, Disponent und Hofmitarbeiter durch. */
async function context(bookingId: string) {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  const handover = await db.handover.findFirst({ where: { bookingId, tenantId: tenant.id, type: "RETURN", correctsId: null }, orderBy: { createdAt: "desc" } });
  if (!handover) redirect(base(bookingId));
  return { tenant, user, handover, actor: { id: user.id, name: user.name } };
}

function asState(e: unknown): StepState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Das Protokoll ist finalisiert und kann nicht mehr geändert werden." };
  throw e;
}

async function go(bookingId: string, handoverId: string, tenantId: string, from: number, formData: FormData): Promise<never> {
  const step = Math.min(RETURN_STEP_COUNT, Math.max(1, formData.get("nav") === "back" ? from - 1 : from + 1));
  await setHandoverStep(tenantId, handoverId, step);
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=${step}`);
}

export async function startReturnAction(bookingId: string) {
  const { tenant, user } = await requireRole("DISPO", "YARD");
  try {
    await startHandover(tenant.id, bookingId, "RETURN", { id: user.id, name: user.name });
  } catch (e) {
    if (e instanceof DomainError) redirect(`${base(bookingId)}?hinweis=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidatePath(`/buchungen/${bookingId}`);
  redirect(`${base(bookingId)}?schritt=1`);
}

/**
 * Befehl 20.6: Kontrolle einer vereinbarten kontaktlosen Rückgabe OHNE Kundenmeldung. Nur Inhaber und Disposition,
 * Pflichtgrund; der Rückgabelink wird dabei sofort ungültig (siehe startHandover).
 */
export async function startKeyDropExceptionAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, user } = await requireRole("DISPO");
  try {
    await startHandover(tenant.id, bookingId, "RETURN", { id: user.id, name: user.name }, { keyDropException: String(formData.get("reason") ?? "") });
  } catch (e) {
    return asState(e);
  }
  revalidatePath(`/buchungen/${bookingId}`);
  redirect(`${base(bookingId)}?schritt=1`);
}

export async function navigateStepAction(bookingId: string, step: number, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, handover } = await context(bookingId);
  return go(bookingId, handover.id, tenant.id, step, formData);
}

const optInt = (msg: string, min: number, max: number) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : typeof v === "string" ? v.replace(/\./g, "").trim() : v), z.coerce.number({ message: msg }).int(msg).min(min, msg).max(max, msg).optional());
const optMoney = (msg: string) =>
  z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : typeof v === "string" ? v.replace(/\./g, "").replace(",", ".").trim() : v), z.coerce.number({ message: msg }).min(0, msg).max(100, msg).optional());

// Schritt 2: Rückgabe-Kilometerstand. Der Fahrzeugstand ändert sich erst beim Abschluss.
const mileageSchema = z.object({ mileage: optInt("Bitte den Kilometerstand als ganze Zahl eingeben.", 0, 9_999_999) });
export async function saveMileageAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, handover } = await context(bookingId);
  const back = formData.get("nav") === "back";
  const parsed = mileageSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back ? go(bookingId, handover.id, tenant.id, 2, formData) : { error: parsed.error.issues[0].message };
  try {
    await updateHandoverDraft(tenant.id, handover.id, { mileage: parsed.data.mileage ?? null });
  } catch (e) {
    return asState(e);
  }
  return go(bookingId, handover.id, tenant.id, 2, formData);
}

// Schritt 3: Tank/Batterie, optional ein Literpreis für diese Rückgabe, Bemerkung
const energySchema = z.object({
  fuelLevelEighths: optInt("Bitte den Tankstand wählen.", 0, 8),
  batteryPercent: optInt("Der Batteriestand liegt zwischen 0 und 100 Prozent.", 0, 100),
  fuelPricePerLiter: optMoney("Bitte einen Literpreis zwischen 0 und 100 Euro angeben."),
  notes: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(2000).optional()),
});
export async function saveEnergyAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, handover } = await context(bookingId);
  const back = formData.get("nav") === "back";
  const parsed = energySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back ? go(bookingId, handover.id, tenant.id, 3, formData) : { error: parsed.error.issues[0].message };
  try {
    const d = parsed.data;
    await updateHandoverDraft(tenant.id, handover.id, { fuelLevelEighths: d.fuelLevelEighths ?? null, batteryPercent: d.batteryPercent ?? null, fuelPricePerLiter: d.fuelPricePerLiter ?? null, notes: d.notes ?? null });
  } catch (e) {
    return asState(e);
  }
  return go(bookingId, handover.id, tenant.id, 3, formData);
}

// Schritt 4: Schäden auf der Skizze, normalisierte Positionen 0 bis 1
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
  try { await addNewDamage(tenant.id, handover.id, parsed.data); } catch (e) { return asResult(e); }
  revalidatePath(base(bookingId));
}
export async function updateDamageAction(bookingId: string, damageId: string, payload: unknown): Promise<Result> {
  const { tenant, handover } = await context(bookingId);
  const parsed = damageSchema.partial().safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    if ((await db.handoverDamage.count({ where: { id: damageId, tenantId: tenant.id, handoverId: handover.id } })) !== 1) return { error: "Schaden nicht gefunden." };
    await updateNewDamage(tenant.id, damageId, parsed.data);
  } catch (e) { return asResult(e); }
  revalidatePath(base(bookingId));
}
export async function removeDamageAction(bookingId: string, damageId: string): Promise<Result> {
  const { tenant, handover } = await context(bookingId);
  try {
    if ((await db.handoverDamage.count({ where: { id: damageId, tenantId: tenant.id, handoverId: handover.id } })) !== 1) return { error: "Schaden nicht gefunden." };
    const keys = await removeNewDamage(tenant.id, damageId);
    await Promise.all(keys.map((k) => Promise.resolve().then(() => getStorage().remove(k)).catch(() => {})));
  } catch (e) { return asResult(e); }
  revalidatePath(base(bookingId));
}

// Schritt 6: Checkliste
export async function saveChecklistAction(bookingId: string, _prev: StepState, formData: FormData): Promise<StepState> {
  const { tenant, handover } = await context(bookingId);
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: tenant.id, handoverId: handover.id }, select: { id: true } });
  const answers = items.map((i) => ({ itemId: i.id, result: (formData.get(`r_${i.id}`) as string | null) ?? null, note: (formData.get(`n_${i.id}`) as string | null) ?? null }));
  try { await answerChecklist(tenant.id, handover.id, answers); } catch (e) { return asState(e); }
  return go(bookingId, handover.id, tenant.id, 6, formData);
}

// Schritt 7: Zusatzkosten. Vorschläge bestätigen, manuelle Positionen, löschen. Beträge rechnet der Server.
export async function confirmProposalAction(bookingId: string, key: "EXTRA_MILEAGE" | "FUEL"): Promise<Result> {
  const { tenant, handover, actor } = await context(bookingId);
  try { await confirmProposal(tenant.id, handover.id, actor.id, key); } catch (e) { return asResult(e); }
  revalidatePath(base(bookingId));
}
const chargeSchema = z.object({
  type: z.enum(Object.keys(EXTRA_CHARGE_TYPES) as [string, ...string[]]),
  description: z.string().trim().min(3, "Bitte die Position kurz beschreiben.").max(200),
  quantity: z.number().positive("Die Menge muss größer als 0 sein.").max(100_000),
  unit: z.enum(CHARGE_UNITS),
  unitPrice: z.number().min(0, "Der Einzelpreis darf nicht negativ sein.").max(1_000_000),
  internalNote: z.string().trim().max(500).optional(),
  handoverDamageId: z.string().optional(),
});
export async function addChargeAction(bookingId: string, payload: unknown): Promise<Result> {
  const { tenant, handover, actor } = await context(bookingId);
  const parsed = chargeSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const d = parsed.data;
    await addManualCharge(tenant.id, handover.id, actor.id, { type: d.type as keyof typeof EXTRA_CHARGE_TYPES, description: d.description, quantity: d.quantity, unit: d.unit, unitPrice: d.unitPrice, internalNote: d.internalNote ?? null, handoverDamageId: d.handoverDamageId || null });
  } catch (e) { return asResult(e); }
  revalidatePath(base(bookingId));
}
export async function removeChargeAction(bookingId: string, chargeId: string): Promise<Result> {
  const { tenant, handover } = await context(bookingId);
  try { await removeCharge(tenant.id, handover.id, chargeId); } catch (e) { return asResult(e); }
  revalidatePath(base(bookingId));
}

// Schritt 8: Unterschrift, gebunden an den angezeigten Protokollstand
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
  } catch (e) { return asState(e); }
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=8`);
}
export async function removeSignatureAction(bookingId: string, role: "RENTER" | "EMPLOYEE") {
  const { tenant, handover } = await context(bookingId);
  try { await removeHandoverSignature(tenant.id, handover.id, role); } catch (e) { if (!(e instanceof DomainError) && !isImmutableError(e)) throw e; }
  revalidatePath(base(bookingId));
  redirect(`${base(bookingId)}?schritt=8`);
}

// Schritt 9: Abschluss. Der Server prüft alles erneut; erst hier geht die Buchung auf "Zurückgegeben".
export async function finalizeReturnAction(bookingId: string, _prev: StepState, _formData: FormData): Promise<StepState> {
  void _formData;
  const { tenant, handover, actor } = await context(bookingId);
  try {
    await finalizeHandover(tenant.id, handover.id, actor);
  } catch (e) {
    if (e instanceof DomainError) {
      // Zwischen Anzeige und Klick hat sich etwas geändert: aktuelle Liste nachladen und klar sagen, dass es offene Punkte gibt
      revalidatePath(base(bookingId));
      return { error: `Die Rückgabe kann noch nicht abgeschlossen werden. Es sind neue offene Punkte vorhanden: ${e.message}` };
    }
    return asState(e);
  }
  // Ab hier gilt das Fahrzeug als zurückgegeben. PDF und E-Mail sind Nachbearbeitung und werfen nie.
  await runReturnFollowUp(tenant.id, { id: handover.id }, actor.id);
  for (const p of [`/buchungen/${bookingId}`, "/buchungen", "/heute", "/dispo", "/fahrzeuge", `/fahrzeuge/${handover.vehicleId}`]) revalidatePath(p);
  redirect(`${base(bookingId)}?abgeschlossen=1`);
}
