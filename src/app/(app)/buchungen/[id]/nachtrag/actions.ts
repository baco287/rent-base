"use server";

// Befehl 25: Nachträge zum Mietvertrag. Anlegen, ändern, Fahrer, Unterschrift, Wirksamwerden, Verwerfen, Versand.
// Nur Inhaber und Disposition (wie der Mietvertrag). Jede Aktion läuft über lib/amendments bzw. die bestehende
// Fahrerprüfung, Dokument- und Mailarchitektur; hier steht keine Fachlogik.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { parseLocalDateTime } from "@/lib/time";
import {
  addAmendmentDriver,
  createAmendmentDraft,
  discardAmendment,
  dropAmendmentDriver,
  removeAmendmentSignature,
  saveAmendmentSignature,
  setAmendmentDriverRemoval,
  signAmendment,
  updateAmendmentDraft,
  type AmendmentChangesInput,
} from "@/lib/amendments";
import { sendAmendment } from "@/lib/amendment-mail";
import { ensureAmendmentDocument } from "@/lib/documents";
import { DRIVER_BLOCKER_LABELS, repeatVerification, verifyDriverInOneStep } from "@/lib/driver-verification";
import { createAmendmentSettlementDraft } from "@/lib/invoices";
import { invoiceHref } from "@/lib/invoice-links";
import { parseOneStepCheck } from "../uebergabe/driver-schema";
import { parseDriver } from "../vertrag/driver-schema";

export type AmendmentState = { error?: string; ok?: string } | undefined;

const page = (bookingId: string, amendmentId: string) => `/buchungen/${bookingId}/nachtrag/${amendmentId}`;

async function context() {
  const { tenant, user } = await requireRole("DISPO");
  return { tenant, user, actor: { id: user.id, name: user.name } };
}

function asState(e: unknown): AmendmentState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Der Nachtrag ist wirksam oder verworfen und kann nicht mehr geändert werden. Änderungen nur durch einen neuen Nachtrag." };
  throw e;
}

function refresh(bookingId: string, amendmentId?: string) {
  revalidatePath(`/buchungen/${bookingId}`);
  if (amendmentId) revalidatePath(page(bookingId, amendmentId));
}

/** „+ Vertrag ändern / Nachtrag erstellen“: legt den Entwurf an (oder öffnet den offenen) und führt zur Nachtragsseite. */
export async function createAmendmentAction(bookingId: string, formData: FormData) {
  const { tenant, actor } = await context();
  const nonce = String(formData.get("nonce") ?? "");
  let id: string;
  try {
    id = (await createAmendmentDraft(tenant.id, actor, { bookingId, nonce })).amendment.id;
  } catch (e) {
    if (e instanceof DomainError) redirect(`/buchungen/${bookingId}?hinweis=${encodeURIComponent(e.message)}`);
    throw e;
  }
  refresh(bookingId, id);
  redirect(page(bookingId, id));
}

const optMoney = (msg: string) => z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: msg }).optional());
const optInt = (msg: string) => z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : v), z.coerce.number({ message: msg }).int(msg).optional());
const on = (v: unknown) => v === "1" || v === "on" || v === true;

const changesSchema = z.object({
  changePeriod: z.preprocess(on, z.boolean()),
  newEndAt: z.preprocess((v) => (v === "" || v == null ? undefined : parseLocalDateTime(String(v))), z.date({ message: "Bitte die neue Rückgabe mit Datum und Uhrzeit angeben." }).optional()),
  changePrice: z.preprocess(on, z.boolean()),
  priceSign: z.enum(["+", "-"]).optional(),
  priceDelta: optMoney("Preisänderung: bitte einen Betrag eingeben."),
  priceReason: z.string().trim().max(300, "Begründung: höchstens 300 Zeichen.").optional(),
  changeKm: z.preprocess(on, z.boolean()),
  newKmIncludedPerDay: optInt("Freikilometer je Tag: bitte eine ganze Zahl ab 0 eingeben."),
  newExtraKmRate: optMoney("Mehrkilometerpreis: bitte einen Betrag ab 0 eingeben."),
  changeDeposit: z.preprocess(on, z.boolean()),
  newDeposit: optMoney("Kaution: bitte einen Betrag ab 0 eingeben."),
  changeReturnLocation: z.preprocess(on, z.boolean()),
  newReturnLocation: z.string().trim().max(200, "Rückgabeort: höchstens 200 Zeichen.").optional(),
  changeAgreement: z.preprocess(on, z.boolean()),
  agreementText: z.string().trim().max(2000, "Sonstige Vereinbarung: höchstens 2000 Zeichen.").optional(),
});

/** Änderungen des Entwurfs speichern. Nicht angehakte Änderungsarten werden aus dem Entwurf entfernt. */
export async function saveAmendmentChangesAction(bookingId: string, amendmentId: string, _prev: AmendmentState, formData: FormData): Promise<AmendmentState> {
  const { tenant, actor } = await context();
  const parsed = changesSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const d = parsed.data;
  const input: AmendmentChangesInput = {};
  if (d.changePeriod) { if (!d.newEndAt) return { error: "Bitte die neue geplante Rückgabe angeben." }; input.newEndAt = d.newEndAt; } else input.newEndAt = null;
  if (d.changePrice) {
    if (d.priceDelta == null || !(d.priceDelta > 0)) return { error: "Bitte den Betrag der Preisänderung (größer 0,00 €) und das Vorzeichen angeben." };
    input.priceDeltaCents = Math.round(d.priceDelta * 100) * (d.priceSign === "-" ? -1 : 1);
    input.priceReason = d.priceReason ?? null;
  } else { input.priceDeltaCents = null; input.priceReason = null; }
  if (d.changeKm) {
    if (d.newKmIncludedPerDay == null && d.newExtraKmRate == null) return { error: "Bitte Freikilometer je Tag und/oder Mehrkilometerpreis angeben." };
    input.newKmIncludedPerDay = d.newKmIncludedPerDay ?? null;
    input.newExtraKmRate = d.newExtraKmRate ?? null;
  } else { input.newKmIncludedPerDay = null; input.newExtraKmRate = null; }
  if (d.changeDeposit) { if (d.newDeposit == null) return { error: "Bitte die neue vereinbarte Kaution angeben." }; input.newDepositCents = Math.round(d.newDeposit * 100); } else input.newDepositCents = null;
  input.newReturnLocation = d.changeReturnLocation ? (d.newReturnLocation ?? "") : null;
  if (d.changeReturnLocation && !(d.newReturnLocation ?? "").trim()) return { error: "Bitte den neuen Rückgabeort angeben." };
  input.agreementText = d.changeAgreement ? (d.agreementText ?? "") : null;
  if (d.changeAgreement && !(d.agreementText ?? "").trim()) return { error: "Bitte den Text der sonstigen Vereinbarung eingeben." };
  try {
    await updateAmendmentDraft(tenant.id, actor, amendmentId, input);
  } catch (e) {
    return asState(e);
  }
  refresh(bookingId, amendmentId);
  return { ok: "Änderungen gespeichert. Bitte die Zusammenfassung prüfen." };
}

export async function addAmendmentDriverAction(bookingId: string, amendmentId: string, _prev: AmendmentState, formData: FormData): Promise<AmendmentState> {
  const { tenant, actor } = await context();
  const d = parseDriver(formData, "a_");
  if (!d.ok) return { error: d.error };
  try {
    await addAmendmentDriver(tenant.id, actor, amendmentId, d.data);
  } catch (e) {
    return asState(e);
  }
  refresh(bookingId, amendmentId);
  redirect(`${page(bookingId, amendmentId)}#fahrer`);
}

export async function dropAmendmentDriverAction(bookingId: string, amendmentId: string, driverId: string) {
  const { tenant } = await context();
  try {
    await dropAmendmentDriver(tenant.id, amendmentId, driverId);
  } catch (e) {
    if (e instanceof DomainError) redirect(`${page(bookingId, amendmentId)}?hinweis=${encodeURIComponent(e.message)}#fahrer`);
    if (!isImmutableError(e)) throw e;
  }
  refresh(bookingId, amendmentId);
  redirect(`${page(bookingId, amendmentId)}#fahrer`);
}

export async function setDriverRemovalAction(bookingId: string, amendmentId: string, driverId: string, removed: boolean) {
  const { tenant } = await context();
  try {
    await setAmendmentDriverRemoval(tenant.id, amendmentId, driverId, removed);
  } catch (e) {
    if (e instanceof DomainError) redirect(`${page(bookingId, amendmentId)}?hinweis=${encodeURIComponent(e.message)}#fahrer`);
    if (!isImmutableError(e)) throw e;
  }
  refresh(bookingId, amendmentId);
  redirect(`${page(bookingId, amendmentId)}#fahrer`);
}

/** Fahrerprüfung eines im Nachtrag aufgenommenen Fahrers – dieselbe Prüfung wie bei der Übergabe, Kontext Nachtrag. */
export async function verifyAmendmentDriverAction(bookingId: string, amendmentId: string, contractDriverId: string, _prev: AmendmentState, formData: FormData): Promise<AmendmentState> {
  const { tenant, actor } = await context();
  const parsed = parseOneStepCheck(formData);
  if (!parsed.ok) return { error: parsed.error };
  try {
    const res = await verifyDriverInOneStep(tenant.id, actor, { amendmentId }, contractDriverId, parsed.input);
    refresh(bookingId, amendmentId);
    if (!res.confirmed) return { error: `Die Prüfung kann nicht bestätigt werden: ${res.blockers.map((b) => DRIVER_BLOCKER_LABELS[b] ?? b).join(" ")}` };
    return { ok: `Prüfung von ${res.row.driverFirstNameSnapshot} ${res.row.driverLastNameSnapshot} bestätigt.` };
  } catch (e) {
    return asState(e);
  }
}

export async function repeatAmendmentDriverAction(bookingId: string, amendmentId: string, contractDriverId: string, _prev: AmendmentState, _formData: FormData): Promise<AmendmentState> {
  void _formData;
  const { tenant, actor } = await context();
  const confirmations = { originalsPresented: true, identityChecked: true, licensePresented: true, dataUnchanged: true, classSufficient: true, documentsValid: true };
  try {
    const row = await repeatVerification(tenant.id, actor, { amendmentId }, contractDriverId, confirmations);
    refresh(bookingId, amendmentId);
    return { ok: `Wiederholungsprüfung von ${row.driverFirstNameSnapshot} ${row.driverLastNameSnapshot} für diesen Nachtrag dokumentiert.` };
  } catch (e) {
    return asState(e);
  }
}

const signatureSchema = z.object({
  role: z.enum(["RENTER", "EMPLOYEE"]),
  signerName: z.string().trim().min(2, "Bitte den Namen des Unterzeichners angeben."),
  imageDataUrl: z.string().min(1, "Bitte zuerst im Feld unterschreiben."),
  seenHash: z.string().length(64, "Die Seite ist veraltet. Bitte neu laden."),
});

export async function saveAmendmentSignatureAction(bookingId: string, amendmentId: string, _prev: AmendmentState, formData: FormData): Promise<AmendmentState> {
  const { tenant, actor } = await context();
  const parsed = signatureSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const h = await headers();
    await saveAmendmentSignature(tenant.id, actor, amendmentId, { ...parsed.data, ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: h.get("user-agent") });
  } catch (e) {
    refresh(bookingId, amendmentId); // veralteter Hash: Seite erneuern, damit der nächste Versuch den aktuellen Stand trägt
    return asState(e);
  }
  refresh(bookingId, amendmentId);
  redirect(`${page(bookingId, amendmentId)}#unterschrift`);
}

export async function removeAmendmentSignatureAction(bookingId: string, amendmentId: string, role: "RENTER" | "EMPLOYEE") {
  const { tenant } = await context();
  try {
    await removeAmendmentSignature(tenant.id, amendmentId, role);
  } catch (e) {
    if (!(e instanceof DomainError) && !isImmutableError(e)) throw e;
  }
  refresh(bookingId, amendmentId);
  redirect(`${page(bookingId, amendmentId)}#unterschrift`);
}

/** Wirksam machen: Nummer, Snapshot, Materialisierung – alles in lib/amendments. Das PDF entsteht danach; scheitert es, bleibt der Nachtrag wirksam. */
export async function signAmendmentAction(bookingId: string, amendmentId: string, _prev: AmendmentState, _formData: FormData): Promise<AmendmentState> {
  void _formData;
  const { tenant, actor } = await context();
  try {
    await signAmendment(tenant.id, actor, amendmentId);
  } catch (e) {
    refresh(bookingId, amendmentId);
    return asState(e);
  }
  try {
    await ensureAmendmentDocument(tenant.id, amendmentId, actor.id);
  } catch (e) {
    console.error("[amendment] PDF nach Unterschrift nicht erzeugt", e instanceof Error ? e.message : e);
  }
  refresh(bookingId, amendmentId);
  revalidatePath("/buchungen");
  revalidatePath("/heute");
  revalidatePath("/dispo");
  redirect(`${page(bookingId, amendmentId)}?wirksam=1`);
}

export async function discardAmendmentAction(bookingId: string, amendmentId: string) {
  const { tenant, actor } = await context();
  try {
    await discardAmendment(tenant.id, actor, amendmentId);
  } catch (e) {
    if (e instanceof DomainError) redirect(`${page(bookingId, amendmentId)}?hinweis=${encodeURIComponent(e.message)}`);
    if (!isImmutableError(e)) throw e;
  }
  refresh(bookingId, amendmentId);
  redirect(`/buchungen/${bookingId}?hinweis=${encodeURIComponent("Der Nachtrag wurde verworfen. Der Vertrag bleibt unverändert.")}#vertrag`);
}

export async function createAmendmentDocumentAction(bookingId: string, amendmentId: string) {
  const { tenant, actor } = await context();
  try {
    await ensureAmendmentDocument(tenant.id, amendmentId, actor.id);
  } catch (e) {
    if (e instanceof DomainError) redirect(`${page(bookingId, amendmentId)}?hinweis=${encodeURIComponent(e.message)}`);
    throw e;
  }
  refresh(bookingId, amendmentId);
  redirect(page(bookingId, amendmentId));
}

export async function sendAmendmentAction(bookingId: string, amendmentId: string, _prev: AmendmentState, formData: FormData): Promise<AmendmentState> {
  const { tenant, actor } = await context();
  const nonce = String(formData.get("nonce") ?? "");
  try {
    const res = await sendAmendment(tenant.id, actor, amendmentId, { nonce });
    refresh(bookingId, amendmentId);
    if (res.status === "SENT") return { ok: res.resend ? "Nachtrag erneut versendet." : "Nachtrag versendet." };
    if (res.status === "DUPLICATE") return { ok: "Dieser Versand wurde bereits ausgeführt." };
    return { error: `Versand fehlgeschlagen: ${res.log.error ?? "unbekannter Fehler"}. Der Nachtrag bleibt wirksam; der Versand kann wiederholt werden.` };
  } catch (e) {
    return asState(e);
  }
}

/** Nach abgeschlossener Mietrechnung: Preiserhöhung bewusst als eigene Rechnung abrechnen (Entwurf, prüfbar, dann abschließen). */
export async function createAmendmentSettlementAction(bookingId: string, amendmentId: string, formData: FormData) {
  const { tenant, actor } = await context();
  const nonce = String(formData.get("nonce") ?? "");
  let href: string;
  try {
    const { invoice } = await createAmendmentSettlementDraft(tenant.id, actor, { amendmentId, nonce });
    href = invoiceHref(invoice);
  } catch (e) {
    if (e instanceof DomainError) redirect(`/buchungen/${bookingId}?hinweis=${encodeURIComponent(e.message)}#vertrag`);
    throw e;
  }
  refresh(bookingId, amendmentId);
  redirect(href);
}
