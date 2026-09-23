"use server";

// Mietbedingungen-Fassungen: nur der Inhaber legt an, bearbeitet, veröffentlicht, erstellt neue Fassungen und archiviert.
// Rent-Base liefert keine „rechtssicheren“ Klauseln; der Inhaber hinterlegt seinen geprüften Text.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { archiveTermsVersion, createNextVersion, createTermsDraft, discardTermsDraft, publishTermsVersion, updateTermsDraft } from "@/lib/rental-terms";
import { parseLocalDateTime } from "@/lib/time";

export type TermsState = { error?: string; ok?: string } | undefined;
const BASE = "/einstellungen/mietbedingungen";

function refresh(id?: string) {
  revalidatePath("/einstellungen");
  revalidatePath(BASE);
  if (id) revalidatePath(`${BASE}/${id}`);
}
function asState(e: unknown): TermsState {
  if (e instanceof DomainError) return { error: e.message };
  if (isImmutableError(e)) return { error: "Diese Fassung ist veröffentlicht oder archiviert und kann nicht mehr geändert werden." };
  throw e;
}
const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

export async function createDraftAction(_prev: TermsState, fd: FormData): Promise<TermsState> {
  const { tenant, user } = await requireRole("OWNER");
  const p = z.object({ label: optStr, title: optStr, source: z.enum(["template", "legacy", "empty"]).optional() }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Ungültige Eingabe." };
  let id: string;
  try {
    const row = await createTermsDraft(tenant.id, { id: user.id, name: user.name }, { label: p.data.label, title: p.data.title, fromLegacyText: p.data.source === "legacy", content: p.data.source === "empty" ? "# Allgemeine Mietbedingungen\n\n" : null });
    id = row.id;
  } catch (e) {
    return asState(e);
  }
  refresh(id);
  redirect(`${BASE}/${id}`);
}

const draftSchema = z.object({
  label: z.string().trim().min(1, "Bitte eine Versionsbezeichnung angeben.").max(40),
  title: z.string().trim().min(3, "Bitte einen Titel angeben.").max(160),
  content: z.string().max(200_000, "Der Text ist zu lang."),
  changeNote: optStr,
  effectiveFrom: optStr,
});

export async function saveDraftAction(versionId: string, _prev: TermsState, fd: FormData): Promise<TermsState> {
  const { tenant, user } = await requireRole("OWNER");
  const p = draftSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  const effectiveFrom = p.data.effectiveFrom ? parseLocalDateTime(`${p.data.effectiveFrom}T00:00`) : null;
  if (p.data.effectiveFrom && !effectiveFrom) return { error: "Bitte ein gültiges Datum für „gültig ab“ angeben." };
  try {
    await updateTermsDraft(tenant.id, versionId, { id: user.id, name: user.name }, { ...p.data, effectiveFrom });
  } catch (e) {
    return asState(e);
  }
  refresh(versionId);
  return { ok: "Entwurf gespeichert. Er gilt erst nach der Veröffentlichung." };
}

export async function publishAction(versionId: string, _prev: TermsState, fd: FormData): Promise<TermsState> {
  const { tenant, user } = await requireRole("OWNER");
  if (fd.get("confirm") !== "1") return { error: "Bitte die Veröffentlichung ausdrücklich bestätigen." };
  try {
    await publishTermsVersion(tenant.id, versionId, { id: user.id, name: user.name }, { confirmed: true });
  } catch (e) {
    return asState(e);
  }
  refresh(versionId);
  revalidatePath("/buchungen", "layout");
  redirect(`${BASE}/${versionId}?veroeffentlicht=1`);
}

export async function newVersionAction(sourceId: string, _prev: TermsState, fd: FormData): Promise<TermsState> {
  const { tenant, user } = await requireRole("OWNER");
  const label = typeof fd.get("label") === "string" && String(fd.get("label")).trim() ? String(fd.get("label")).trim() : null;
  let id: string;
  try {
    id = (await createNextVersion(tenant.id, sourceId, { id: user.id, name: user.name }, { label })).id;
  } catch (e) {
    return asState(e);
  }
  refresh(id);
  redirect(`${BASE}/${id}`);
}

export async function archiveAction(versionId: string, _prev: TermsState, fd: FormData): Promise<TermsState> {
  const { tenant, user } = await requireRole("OWNER");
  if (fd.get("confirm") !== "1") return { error: "Bitte das Archivieren bestätigen." };
  try {
    await archiveTermsVersion(tenant.id, versionId, { id: user.id, name: user.name }, typeof fd.get("reason") === "string" ? String(fd.get("reason")).trim() || null : null);
  } catch (e) {
    return asState(e);
  }
  refresh(versionId);
  return { ok: "Fassung archiviert. Bestehende Verträge behalten ihren eingefrorenen Text." };
}

export async function discardDraftAction(versionId: string, _prev: TermsState, fd: FormData): Promise<TermsState> {
  const { tenant, user } = await requireRole("OWNER");
  if (fd.get("confirm") !== "1") return { error: "Bitte das Verwerfen bestätigen." };
  try {
    await discardTermsDraft(tenant.id, versionId, { id: user.id, name: user.name });
  } catch (e) {
    return asState(e);
  }
  refresh();
  redirect(BASE);
}
