// Mietbedingungen als versionierter Text (Phase 15). Nur Entwürfe sind änderbar. Veröffentlichen ist eine bewusste,
// bestätigte Aktion: danach Prüfsumme, Zeitpunkt, Person – und die Fassung ist unveränderlich (Anwendung und DB-Trigger).
// Eine neue Fassung entsteht nur als Kopie einer veröffentlichten. Archivierte Fassungen bleiben erhalten; Verträge, die
// sie verwenden, zeigen weiterhin genau ihren eingefrorenen Text. Rent-Base erfindet keinen Rechtstext.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { DomainError, sha256 } from "@/lib/integrity";
import { isUniqueViolation } from "@/lib/numbering";
import { TERMS_TEMPLATE_NOTICE } from "@/lib/constants";
import { TERMS_STRUCTURE_TEMPLATE, parseTerms, termsPlainText, validateTermsSource } from "@/lib/terms-markdown";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type TermsRow = Prisma.RentalTermsVersionGetPayload<object>;

function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_(?:DOMAIN|IMMUTABLE): ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}

/** Nächstes Label: „1.0“ für die erste Fassung, sonst Nebenversion + 1 der Quelle (1.3 → 1.4); bei Kollision weiterzählen. */
export function proposeLabel(existing: string[], source: string | null): string {
  const taken = new Set(existing);
  let major = 1, minor = 0;
  const m = source ? /^(\d+)\.(\d+)$/.exec(source) : null;
  if (m) { major = Number(m[1]); minor = Number(m[2]) + 1; }
  else if (existing.length > 0) {
    // freie Labels: höchste erkennbare Hauptversion + nächste Nebenversion
    const parsed = existing.map((l) => /^(\d+)\.(\d+)$/.exec(l)).filter((x): x is RegExpExecArray => !!x).map((x) => [Number(x[1]), Number(x[2])] as const);
    if (parsed.length) { const top = parsed.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0]; major = top[0]; minor = top[1] + 1; }
  }
  let label = `${major}.${minor}`;
  while (taken.has(label)) { minor += 1; label = `${major}.${minor}`; }
  return label;
}

const normalizeLabel = (label: string) => {
  const l = label.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(l)) throw new DomainError("Die Versionsbezeichnung darf nur Buchstaben, Ziffern, Punkt, Bindestrich und Leerzeichen enthalten (max. 40 Zeichen).");
  return l;
};

/** Fortlaufender Zähler am Mandanten: eine Nummer wird nie wiederverwendet, auch nicht nach einem verworfenen Entwurf. */
async function nextVersionNumber(tx: Tx, tenantId: string) {
  const rows = await tx.$queryRaw<{ seq: number }[]>`UPDATE "Tenant" SET "rentalTermsSequence" = GREATEST("rentalTermsSequence", (SELECT COALESCE(MAX("versionNumber"), 0) FROM "RentalTermsVersion" WHERE "tenantId" = ${tenantId})) + 1 WHERE "id" = ${tenantId} RETURNING "rentalTermsSequence" AS seq`;
  return rows[0].seq;
}

export type TermsDraftInput = { label?: string | null; title: string; content: string; changeNote?: string | null; effectiveFrom?: Date | null };

/** Neuer Entwurf – leer (Strukturvorlage), aus dem bisherigen Mandantentext oder aus freiem Text. Nie automatisch veröffentlicht. */
export async function createTermsDraft(tenantId: string, actor: Actor, input: { title?: string | null; content?: string | null; label?: string | null; fromLegacyText?: boolean }): Promise<TermsRow> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`; // parallele Anlagen laufen nacheinander
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { rentalTermsText: true, rentalTermsVersion: true } });
    const open = await tx.rentalTermsVersion.findFirst({ where: { tenantId, status: "DRAFT" } });
    if (open) throw new DomainError(`Es gibt bereits einen Entwurf (Fassung ${open.label}). Bitte diesen bearbeiten, veröffentlichen oder verwerfen.`);
    const content = input.fromLegacyText ? tenant.rentalTermsText?.trim() || "" : input.content?.trim() || TERMS_STRUCTURE_TEMPLATE;
    if (input.fromLegacyText && !content) throw new DomainError("Es ist kein bisheriger Mietbedingungstext hinterlegt.");
    const existing = (await tx.rentalTermsVersion.findMany({ where: { tenantId }, select: { label: true } })).map((r) => r.label);
    const label = input.label ? normalizeLabel(input.label) : proposeLabel(existing, null);
    if (existing.includes(label)) throw new DomainError(`Die Versionsbezeichnung „${label}“ ist bereits vergeben.`);
    const row = await tx.rentalTermsVersion.create({ data: { tenantId, versionNumber: await nextVersionNumber(tx, tenantId), label, title: input.title?.trim() || "Allgemeine Mietbedingungen", content, changeNote: input.fromLegacyText ? `Übernommen aus dem bisherigen Text${tenant.rentalTermsVersion ? ` (Fassung ${tenant.rentalTermsVersion})` : ""}` : null, createdById: actor.id, createdByName: actor.name } });
    await recordAudit(tx, tenantId, actor, { action: "RENTAL_TERMS_DRAFT_CREATED", details: { versionId: row.id, label, fromLegacy: !!input.fromLegacyText } });
    return row;
  }, TX).catch(domainFromDb);
}

export async function updateTermsDraft(tenantId: string, versionId: string, actor: Actor, input: TermsDraftInput): Promise<TermsRow> {
  const problem = validateTermsSource(input.content);
  if (problem) throw new DomainError(problem);
  const title = input.title.trim();
  if (title.length < 3) throw new DomainError("Bitte einen Titel angeben (z. B. Allgemeine Mietbedingungen).");
  return db.$transaction(async (tx) => {
    const row = await tx.rentalTermsVersion.findFirst({ where: { id: versionId, tenantId } });
    if (!row) throw new DomainError("Fassung nicht gefunden.");
    if (row.status !== "DRAFT") throw new DomainError(`Die Fassung ${row.label} ist ${row.status === "PUBLISHED" ? "veröffentlicht" : "archiviert"} und kann nicht mehr geändert werden. Änderungen erzeugen eine neue Fassung.`);
    const label = input.label ? normalizeLabel(input.label) : row.label;
    const updated = await tx.rentalTermsVersion.update({ where: { id: row.id }, data: { label, title, content: input.content.replace(/\r\n?/g, "\n"), changeNote: input.changeNote?.trim() || null, effectiveFrom: input.effectiveFrom ?? null } });
    await recordAudit(tx, tenantId, actor, { action: "RENTAL_TERMS_UPDATED", details: { versionId: row.id, label, contentLength: input.content.length } });
    return updated;
  }, TX).catch((e) => { if (isUniqueViolation(e, "label")) throw new DomainError("Diese Versionsbezeichnung ist bereits vergeben."); return domainFromDb(e); });
}

/** Veröffentlichen: nur nach ausdrücklicher Bestätigung. Setzt Prüfsumme, Zeitpunkt und Person; danach unveränderlich. */
export async function publishTermsVersion(tenantId: string, versionId: string, actor: Actor, opts: { confirmed: boolean }): Promise<TermsRow> {
  if (!opts.confirmed) throw new DomainError("Bitte die Veröffentlichung ausdrücklich bestätigen.");
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "RentalTermsVersion" WHERE "id" = ${versionId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Fassung nicht gefunden.");
    const row = await tx.rentalTermsVersion.findUniqueOrThrow({ where: { id: versionId } });
    if (row.status === "PUBLISHED") return row; // Doppelklick
    if (row.status !== "DRAFT") throw new DomainError("Nur ein Entwurf kann veröffentlicht werden.");
    const problem = validateTermsSource(row.content);
    if (problem) throw new DomainError(problem);
    if (row.content.includes(TERMS_TEMPLATE_NOTICE)) throw new DomainError(`Die Fassung enthält noch den Vorlagenhinweis „${TERMS_TEMPLATE_NOTICE}“. Bitte den Mustertext durch den geprüften Text ersetzen.`);
    if (parseTerms(row.content).filter((b) => b.type !== "heading").length === 0) throw new DomainError("Die Fassung enthält nur Überschriften ohne Inhalt.");
    const checksum = sha256(row.content);
    const published = await tx.rentalTermsVersion.update({ where: { id: row.id }, data: { status: "PUBLISHED", checksum, publishedAt: new Date(), publishedById: actor.id, publishedByName: actor.name } });
    await recordAudit(tx, tenantId, actor, { action: "RENTAL_TERMS_PUBLISHED", details: { versionId: row.id, label: row.label, checksum, effectiveFrom: row.effectiveFrom?.toISOString() ?? null } });
    return published;
  }, TX).catch(domainFromDb);
}

/** Neue Fassung aus einer veröffentlichten (oder archivierten) Fassung: Kopie als Entwurf, Quelle bleibt unverändert. */
export async function createNextVersion(tenantId: string, sourceId: string, actor: Actor, input: { label?: string | null } = {}): Promise<TermsRow> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
    const source = await tx.rentalTermsVersion.findFirst({ where: { id: sourceId, tenantId } });
    if (!source) throw new DomainError("Fassung nicht gefunden.");
    if (source.status === "DRAFT") throw new DomainError("Aus einem Entwurf wird keine neue Fassung erstellt; bitte den Entwurf bearbeiten.");
    const open = await tx.rentalTermsVersion.findFirst({ where: { tenantId, status: "DRAFT" } });
    if (open) throw new DomainError(`Es gibt bereits einen Entwurf (Fassung ${open.label}). Bitte diesen zuerst veröffentlichen oder verwerfen.`);
    const existing = (await tx.rentalTermsVersion.findMany({ where: { tenantId }, select: { label: true } })).map((r) => r.label);
    const label = input.label ? normalizeLabel(input.label) : proposeLabel(existing, source.label);
    if (existing.includes(label)) throw new DomainError(`Die Versionsbezeichnung „${label}“ ist bereits vergeben.`);
    const row = await tx.rentalTermsVersion.create({ data: { tenantId, versionNumber: await nextVersionNumber(tx, tenantId), label, title: source.title, content: source.content, sourceVersionId: source.id, changeNote: null, createdById: actor.id, createdByName: actor.name } });
    await recordAudit(tx, tenantId, actor, { action: "RENTAL_TERMS_NEW_VERSION_CREATED", details: { versionId: row.id, label, sourceVersionId: source.id, sourceLabel: source.label } });
    return row;
  }, TX).catch(domainFromDb);
}

/** Archivieren: die Fassung gilt nicht mehr für neue Verträge; bestehende Verträge behalten ihren eingefrorenen Text. */
export async function archiveTermsVersion(tenantId: string, versionId: string, actor: Actor, reason: string | null = null): Promise<TermsRow> {
  return db.$transaction(async (tx) => {
    const row = await tx.rentalTermsVersion.findFirst({ where: { id: versionId, tenantId } });
    if (!row) throw new DomainError("Fassung nicht gefunden.");
    if (row.status === "ARCHIVED") return row;
    if (row.status !== "PUBLISHED") throw new DomainError("Nur veröffentlichte Fassungen werden archiviert; ein Entwurf wird verworfen.");
    const archived = await tx.rentalTermsVersion.update({ where: { id: row.id }, data: { status: "ARCHIVED", archivedAt: new Date(), archivedById: actor.id, archivedByName: actor.name } });
    const used = await tx.rentalContract.count({ where: { tenantId, rentalTermsVersionId: row.id, status: { not: "DRAFT" } } });
    await recordAudit(tx, tenantId, actor, { action: "RENTAL_TERMS_ARCHIVED", details: { versionId: row.id, label: row.label, usedInContracts: used, reason } });
    return archived;
  }, TX).catch(domainFromDb);
}

/** Entwurf verwerfen (einzige Löschung; veröffentlichte Fassungen werden nie gelöscht). */
export async function discardTermsDraft(tenantId: string, versionId: string, actor: Actor): Promise<void> {
  return db.$transaction(async (tx) => {
    const row = await tx.rentalTermsVersion.findFirst({ where: { id: versionId, tenantId } });
    if (!row) throw new DomainError("Fassung nicht gefunden.");
    if (row.status !== "DRAFT") throw new DomainError("Nur Entwürfe können verworfen werden.");
    await tx.rentalTermsVersion.delete({ where: { id: row.id } });
    await recordAudit(tx, tenantId, actor, { action: "RENTAL_TERMS_DRAFT_DISCARDED", details: { versionId: row.id, label: row.label } });
  }, TX).catch(domainFromDb);
}

/**
 * Aktive Fassung: die höchste veröffentlichte Fassung, deren Gültigkeit begonnen hat (oder ohne Gültigkeitsdatum).
 * Wird beim Anlegen eines Vertragsentwurfs verwendet; ein bestehender Entwurf wechselt nie von selbst.
 */
export async function activeTermsVersion(tx: Tx | typeof db, tenantId: string, now = new Date()): Promise<TermsRow | null> {
  return tx.rentalTermsVersion.findFirst({ where: { tenantId, status: "PUBLISHED", OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] }, orderBy: { versionNumber: "desc" } });
}

/** Wurde je eine Fassung veröffentlicht (auch wenn inzwischen archiviert)? Dann sind versionierte Bedingungen für neue Verträge Pflicht. */
export async function termsFeatureActive(tx: Tx | typeof db, tenantId: string): Promise<boolean> {
  return (await tx.rentalTermsVersion.count({ where: { tenantId, status: { in: ["PUBLISHED", "ARCHIVED"] } } })) > 0;
}

export type TermsOverview = { versions: (TermsRow & { usedInContracts: number; isActive: boolean; effectivePending: boolean })[]; active: TermsRow | null; draft: TermsRow | null; scheduled: TermsRow[]; legacy: { version: string | null; text: string | null } };

export async function termsOverview(tenantId: string, now = new Date()): Promise<TermsOverview> {
  const [versions, usage, tenant, active] = await Promise.all([
    db.rentalTermsVersion.findMany({ where: { tenantId }, orderBy: { versionNumber: "desc" } }),
    db.rentalContract.groupBy({ by: ["rentalTermsVersionId"], where: { tenantId, rentalTermsVersionId: { not: null }, status: { not: "DRAFT" } }, _count: { _all: true } }),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { rentalTermsVersion: true, rentalTermsText: true } }),
    activeTermsVersion(db, tenantId, now),
  ]);
  const counts = new Map(usage.map((u) => [u.rentalTermsVersionId, u._count._all]));
  return {
    versions: versions.map((v) => ({ ...v, usedInContracts: counts.get(v.id) ?? 0, isActive: v.id === active?.id, effectivePending: v.status === "PUBLISHED" && !!v.effectiveFrom && v.effectiveFrom > now })),
    active,
    draft: versions.find((v) => v.status === "DRAFT") ?? null,
    scheduled: versions.filter((v) => v.status === "PUBLISHED" && !!v.effectiveFrom && v.effectiveFrom > now),
    legacy: { version: tenant.rentalTermsVersion, text: tenant.rentalTermsText },
  };
}

export async function termsVersionDetail(tenantId: string, versionId: string) {
  const row = await db.rentalTermsVersion.findFirst({ where: { id: versionId, tenantId } });
  if (!row) throw new DomainError("Fassung nicht gefunden.");
  const [usedInContracts, contracts, active] = await Promise.all([
    db.rentalContract.count({ where: { tenantId, rentalTermsVersionId: row.id, status: { not: "DRAFT" } } }),
    db.rentalContract.findMany({ where: { tenantId, rentalTermsVersionId: row.id }, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, number: true, status: true, bookingId: true, signedAt: true, customerSnapshot: true } }),
    activeTermsVersion(db, tenantId),
  ]);
  return { ...row, blocks: parseTerms(row.content), plain: termsPlainText(parseTerms(row.content)), usedInContracts, contracts, isActive: active?.id === row.id };
}
