// Übergabe (PICKUP) und Rückgabe (RETURN).
//
// Snapshot-Prinzip: Beim Start werden die aktuell sichtbaren Schäden des Fahrzeugs und die gültige
// Checkliste in das Protokoll KOPIERT. Das Protokoll liest danach nie wieder aus der Schadenakte oder
// aus der Vorlage. Beim Finalisieren wird der Inhalt gehasht und das Protokoll gesperrt.
//
// Unterschrift: gehört zu genau einem Inhalts-Hash. Jede inhaltliche Änderung im Entwurf verwirft
// vorhandene Unterschriften (touch), der Mieter unterschreibt dann erneut.
//
// Reihenfolge beim Finalisieren: erst alle Bestandteile schreiben, ganz zum Schluss den Status setzen.
// Danach blockieren Code (assertHandoverDraft) und Datenbank-Trigger jede weitere Änderung.
//
// Jede Funktion verlangt die tenantId und filtert damit jede Abfrage.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { balanceOf } from "@/lib/deposits";
import { fmtCents, toCents } from "@/lib/money";
import { DAMAGE_KINDS, DAMAGE_SEVERITY, DAMAGE_VIEWS, PHOTO_CATEGORIES, REQUIRED_PHOTO_CATEGORIES, RETURN_ATTENTION_ON_YES, VISIBLE_DAMAGE_STATUS, energyRequirements, type HandoverType } from "@/lib/constants";
import { DomainError, assertHandoverDraft, contentHash, sha256 } from "@/lib/integrity";
import { nextHandoverNumber } from "@/lib/numbering";
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, assertKeyBelongsToTenant, buildStorageKey } from "@/lib/storage";
import { itemsForDrive, resolveChecklist } from "@/lib/checklists";
import { vehicleStatusProblem } from "@/lib/bookings";
import { resolveSketch } from "@/lib/sketches";
import { recordVehicleEvent } from "@/lib/vehicle-events";
import { driverVerificationBlockers } from "@/lib/driver-verification";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type Actor = { id: string; name: string };

// Pickup: 1 Übersicht · 2 Kilometer & Energie · 3 Schäden · 4 Fotos · 5 Checkliste · 6 Fahrer & Dokumente (Phase 19.5) · 7 Unterschrift · 8 Abschluss
export const HANDOVER_STEPS = 8;

async function loadDraft(tx: Tx, tenantId: string, handoverId: string) {
  const h = await tx.handover.findFirst({ where: { id: handoverId, tenantId } });
  if (!h) throw new DomainError("Protokoll nicht gefunden.");
  assertHandoverDraft(h);
  return h;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Startet ein Protokoll oder setzt den vorhandenen Entwurf fort. Je Buchung und Art gibt es höchstens
 * einen Entwurf: die Buchungszeile wird gesperrt, gleichzeitige Starts laufen nacheinander.
 * Kopiert sichtbare Schäden (EXISTING) samt Fotoverweisen und die Checkliste in das Protokoll.
 */
export async function startHandover(tenantId: string, bookingId: string, type: HandoverType, actor: Actor) {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const booking = await tx.booking.findFirst({
      where: { id: bookingId, tenantId },
      include: { vehicle: { include: { group: true } }, contract: true },
    });
    if (!booking) throw new DomainError("Buchung nicht gefunden.");

    const existing = await tx.handover.findMany({ where: { tenantId, bookingId, type, correctsId: null } });
    const draft = existing.find((h) => h.status === "DRAFT");
    if (draft) return draft; // Abbruch und Fortsetzen ist erlaubt
    if (existing.some((h) => h.status === "FINALIZED")) throw new DomainError(type === "PICKUP" ? "Die Übergabe ist bereits abgeschlossen." : "Die Rückgabe ist bereits abgeschlossen.");

    if (type === "PICKUP" && booking.status !== "RESERVED") throw new DomainError("Eine Übergabe ist nur für reservierte Buchungen möglich.");
    if (type === "PICKUP" && booking.contract?.status !== "SIGNED") throw new DomainError("Die Übergabe kann erst starten, wenn der Mietvertrag abgeschlossen ist.");
    let pickupId: string | null = null;
    if (type === "RETURN") {
      if (booking.status !== "ACTIVE") throw new DomainError("Eine Rückgabe ist nur für laufende Mieten möglich.");
      if (booking.contract?.status !== "SIGNED") throw new DomainError("Zu dieser Miete gibt es keinen abgeschlossenen Mietvertrag. Die Rückgabe über das Protokoll ist nur mit Vertrag möglich.");
      const pickup = await tx.handover.findFirst({ where: { tenantId, bookingId, type: "PICKUP", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" }, select: { id: true } });
      if (!pickup) throw new DomainError("Zu dieser Miete gibt es kein abgeschlossenes Übergabeprotokoll. Ohne dokumentierten Übergabezustand ist kein Vergleich möglich.");
      pickupId = pickup.id;
    }

    const sketch = await resolveSketch(tx, tenantId, booking.vehicle.group);
    const number = await nextHandoverNumber(tx, tenantId, type);
    const handover = await tx.handover.create({
      data: {
        tenantId,
        bookingId: booking.id,
        vehicleId: booking.vehicleId,
        contractId: booking.contract?.id ?? null,
        type,
        number,
        employeeId: actor.id,
        employeeName: actor.name,
        driveType: booking.vehicle.fuel,
        sketchId: sketch?.id ?? null,
        sketchVersion: sketch?.version ?? null,
        sketchAssetHash: sketch?.assetHash ?? null,
      },
    });

    // Schäden kopieren: der Zustand von jetzt, unabhängig von späteren Änderungen an der Schadenakte
    const damages = await tx.damage.findMany({
      where: { tenantId, vehicleId: booking.vehicleId, status: { in: VISIBLE_DAMAGE_STATUS } },
      include: { photos: { select: { id: true, storageKey: true, checksum: true }, orderBy: { uploadedAt: "asc" } } },
      orderBy: { discoveredAt: "asc" },
    });
    if (damages.length > 0) {
      await tx.handoverDamage.createMany({
        data: damages.map((d, i) => ({
          tenantId,
          handoverId: handover.id,
          damageId: d.id,
          // Rückgabe: Vorschäden, die bei der Übergabe dieser Miete dokumentiert wurden, bleiben als solche erkennbar
          marker: pickupId && d.discoveredInHandoverId === pickupId ? "PICKUP_NEW" : "EXISTING",
          view: d.view,
          posX: d.posX,
          posY: d.posY,
          kind: d.kind,
          description: d.description,
          size: d.size,
          severity: d.severity,
          photoRefs: d.photos.map((p) => ({ photoId: p.id, storageKey: p.storageKey, checksum: p.checksum })),
          sortOrder: i,
        })),
      });
    }

    // Checkliste kopieren: Fragetext und Reihenfolge von jetzt. Ohne eigene Vorlage greift der Standard.
    // Checkliste kopieren, dabei nur Punkte, die zum Antrieb passen (z. B. Ladezubehör nur bei Elektro/Plug-in-Hybrid)
    const checklist = await resolveChecklist(tx, tenantId, booking.vehicle.groupId, type);
    const applicable = itemsForDrive(checklist.items, booking.vehicle.fuel);
    if (applicable.length > 0) {
      await tx.handoverChecklistItem.createMany({
        data: applicable.map((item, i) => ({
          tenantId,
          handoverId: handover.id,
          templateId: checklist.templateId,
          templateVersion: checklist.version,
          itemKey: item.key,
          label: item.label,
          answerType: item.answerType,
          required: item.required,
          sortOrder: i,
        })),
      });
    }
    return handover;
  }, TX);
}

// ---------------------------------------------------------------------------
// Inhalt, Hash, Unterschriften
// ---------------------------------------------------------------------------

/** Alles, was das Protokoll inhaltlich ausmacht. Unterschriften sind nicht Teil des Inhalts, sie verweisen auf den Hash. */
async function handoverContent(tx: Tx, tenantId: string, handoverId: string) {
  const h = await tx.handover.findFirst({
    where: { id: handoverId, tenantId },
    include: {
      damages: { orderBy: { sortOrder: "asc" } },
      checklistItems: { orderBy: { sortOrder: "asc" } },
      photos: { orderBy: { uploadedAt: "asc" } },
      extraCharges: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!h) throw new DomainError("Protokoll nicht gefunden.");
  const content = {
    number: h.number,
    type: h.type,
    bookingId: h.bookingId,
    vehicleId: h.vehicleId,
    contractId: h.contractId,
    employeeName: h.employeeName,
    mileage: h.mileage,
    fuelLevelEighths: h.fuelLevelEighths,
    batteryPercent: h.batteryPercent,
    driveType: h.driveType,
    accessories: h.accessories,
    notes: h.notes,
    sketch: { id: h.sketchId, version: h.sketchVersion, assetHash: h.sketchAssetHash },
    correctsId: h.correctsId,
    ...(h.fuelPricePerLiter != null ? { fuelPricePerLiter: String(h.fuelPricePerLiter) } : {}),
    damages: h.damages.map((d) => ({ marker: d.marker, view: d.view, posX: d.posX, posY: d.posY, kind: d.kind, description: d.description, size: d.size, severity: d.severity, photoRefs: d.photoRefs })),
    checklist: h.checklistItems.map((c) => ({ key: c.itemKey, label: c.label, answerType: c.answerType, required: c.required, result: c.result, note: c.note, templateVersion: c.templateVersion })),
    photos: h.photos.map((p) => ({ category: p.category, storageKey: p.storageKey, checksum: p.checksum })),
    extraCharges: h.extraCharges.map((e) => ({ type: e.type, description: e.description, formula: e.formula, amount: String(e.amount), source: e.source, handoverDamageId: e.handoverDamageId })),
  };
  return { handover: h, hash: contentHash(content) };
}

/** Nach jeder inhaltlichen Änderung: Unterschriften, die nicht mehr zum Inhalt passen, werden verworfen. */
async function touch(tx: Tx, tenantId: string, handoverId: string) {
  const { hash } = await handoverContent(tx, tenantId, handoverId);
  const stale = await tx.signature.findMany({ where: { tenantId, handoverId, contentHash: { not: hash } }, select: { id: true } });
  if (stale.length > 0) await tx.signature.deleteMany({ where: { tenantId, id: { in: stale.map((s) => s.id) } } });
  return { hash, dropped: stale.length };
}

/** Für andere Module (Zusatzkosten): nach einer inhaltlichen Änderung außerhalb dieser Datei aufrufen. */
export async function touchHandover(tx: Tx, tenantId: string, handoverId: string) {
  await loadDraft(tx, tenantId, handoverId);
  return touch(tx, tenantId, handoverId);
}

/** Hash des aktuellen Entwurfs. Diesen Wert zeigt die Unterschriftsseite und gibt ihn beim Unterschreiben zurück. */
export async function getHandoverContentHash(tenantId: string, handoverId: string) {
  return db.$transaction(async (tx) => (await handoverContent(tx, tenantId, handoverId)).hash, TX);
}

const PNG_PREFIX = "data:image/png;base64,";
const MAX_SIGNATURE_BYTES = 400_000;

export type HandoverSignatureInput = {
  role: "RENTER" | "EMPLOYEE";
  signerName: string;
  imageDataUrl: string;
  /** Hash, den die Seite beim Anzeigen hatte. Weicht er ab, hat sich das Protokoll inzwischen geändert. */
  seenHash: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Speichert eine Unterschrift zu genau dem Protokollstand, den der Unterzeichner gesehen hat. */
export async function saveHandoverSignature(tenantId: string, actor: Actor | null, handoverId: string, input: HandoverSignatureInput) {
  if (!input.signerName.trim()) throw new DomainError("Bitte den Namen des Unterzeichners angeben.");
  if (!input.imageDataUrl.startsWith(PNG_PREFIX)) throw new DomainError("Die Unterschrift konnte nicht gelesen werden. Bitte erneut unterschreiben.");
  const image = Buffer.from(input.imageDataUrl.slice(PNG_PREFIX.length), "base64");
  const isPng = image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
  if (!isPng || image.length > MAX_SIGNATURE_BYTES) throw new DomainError("Die Unterschrift ist ungültig oder zu groß. Bitte erneut unterschreiben.");
  if (image.length < 800) throw new DomainError("Die Unterschrift ist leer. Bitte im Feld unterschreiben.");

  return db.$transaction(async (tx) => {
    const h = await loadDraft(tx, tenantId, handoverId);
    const { hash } = await handoverContent(tx, tenantId, handoverId);
    if (hash !== input.seenHash) throw new DomainError("Das Protokoll wurde seit der Anzeige geändert. Bitte die Angaben erneut prüfen und dann unterschreiben.");
    await tx.signature.deleteMany({ where: { tenantId, handoverId, role: input.role } });
    return tx.signature.create({
      data: {
        tenantId,
        handoverId,
        role: input.role,
        signerName: input.signerName.trim(),
        storageKey: buildStorageKey({ tenantId, area: "signatures", bookingId: h.bookingId, contentType: "image/png" }),
        imageData: image,
        imageChecksum: sha256(image),
        contentHash: hash,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        createdById: actor?.id ?? null,
      },
      select: { id: true, role: true, signerName: true, signedAt: true, contentHash: true },
    });
  }, TX);
}

export async function removeHandoverSignature(tenantId: string, handoverId: string, role: "RENTER" | "EMPLOYEE") {
  return db.$transaction(async (tx) => {
    await loadDraft(tx, tenantId, handoverId);
    await tx.signature.deleteMany({ where: { tenantId, handoverId, role } });
  }, TX);
}

// ---------------------------------------------------------------------------
// Entwurf bearbeiten
// ---------------------------------------------------------------------------

export type HandoverDraftInput = {
  mileage?: number | null;
  fuelLevelEighths?: number | null;
  batteryPercent?: number | null;
  accessories?: Prisma.InputJsonValue | null;
  notes?: string | null;
  /** nur Rückgabe: ausdrücklich angegebener Literpreis für die Nachberechnung */
  fuelPricePerLiter?: number | null;
};

/** Ändert Messwerte eines Entwurfs. Der Kilometerstand des Fahrzeugs bleibt unberührt, bis das Protokoll finalisiert ist. */
export async function updateHandoverDraft(tenantId: string, handoverId: string, input: HandoverDraftInput) {
  return db.$transaction(async (tx) => {
    const h = await loadDraft(tx, tenantId, handoverId);
    if (input.mileage != null && (!Number.isInteger(input.mileage) || input.mileage < 0)) throw new DomainError("Der Kilometerstand muss eine ganze Zahl ab 0 sein.");
    if (input.fuelLevelEighths != null && (!Number.isInteger(input.fuelLevelEighths) || input.fuelLevelEighths < 0 || input.fuelLevelEighths > 8)) throw new DomainError("Der Tankstand liegt zwischen 0 und 8 Achteln.");
    if (input.batteryPercent != null && (!Number.isInteger(input.batteryPercent) || input.batteryPercent < 0 || input.batteryPercent > 100)) throw new DomainError("Der Batteriestand liegt zwischen 0 und 100 Prozent.");
    if (input.fuelPricePerLiter != null && !(Number.isFinite(input.fuelPricePerLiter) && input.fuelPricePerLiter >= 0 && input.fuelPricePerLiter < 100)) throw new DomainError("Bitte einen Literpreis zwischen 0 und 100 Euro angeben.");
    const updated = await tx.handover.update({
      where: { id: h.id },
      data: {
        ...(input.mileage !== undefined ? { mileage: input.mileage } : {}),
        ...(input.fuelLevelEighths !== undefined ? { fuelLevelEighths: input.fuelLevelEighths } : {}),
        ...(input.batteryPercent !== undefined ? { batteryPercent: input.batteryPercent } : {}),
        ...(input.accessories !== undefined ? { accessories: input.accessories ?? undefined } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.fuelPricePerLiter !== undefined ? { fuelPricePerLiter: input.fuelPricePerLiter } : {}),
      },
    });
    await touch(tx, tenantId, h.id);
    return updated;
  }, TX);
}

export async function setHandoverStep(tenantId: string, handoverId: string, step: number) {
  await db.handover.updateMany({ where: { id: handoverId, tenantId, status: "DRAFT" }, data: { wizardStep: Math.min(HANDOVER_STEPS, Math.max(1, Math.round(step))) } });
}

export async function answerChecklistItem(tenantId: string, itemId: string, result: string | null, note?: string | null) {
  return db.$transaction(async (tx) => {
    const item = await tx.handoverChecklistItem.findFirst({ where: { id: itemId, tenantId } });
    if (!item) throw new DomainError("Checklistenpunkt nicht gefunden.");
    await loadDraft(tx, tenantId, item.handoverId);
    const updated = await tx.handoverChecklistItem.update({ where: { id: item.id }, data: { result, note: note ?? null } });
    await touch(tx, tenantId, item.handoverId);
    return updated;
  }, TX);
}

const ALLOWED_RESULTS: Record<string, string[]> = { OK_NOT_OK: ["OK", "NOT_OK", "NA"], YES_NO: ["YES", "NO", "NA"] };

/** Speichert alle Antworten der Checkliste auf einmal (ein Schritt im Assistenten). */
export async function answerChecklist(tenantId: string, handoverId: string, answers: { itemId: string; result: string | null; note?: string | null }[]) {
  return db.$transaction(async (tx) => {
    await loadDraft(tx, tenantId, handoverId);
    const items = await tx.handoverChecklistItem.findMany({ where: { tenantId, handoverId } });
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const a of answers) {
      const item = byId.get(a.itemId);
      if (!item) throw new DomainError("Ein Checklistenpunkt gehört nicht zu diesem Protokoll.");
      const result = a.result?.trim() || null;
      if (result && ALLOWED_RESULTS[item.answerType] && !ALLOWED_RESULTS[item.answerType].includes(result)) throw new DomainError(`Ungültige Antwort bei „${item.label}“.`);
      await tx.handoverChecklistItem.update({ where: { id: item.id }, data: { result, note: a.note?.trim() || null } });
    }
    await touch(tx, tenantId, handoverId);
  }, TX);
}

export type NewDamageInput = {
  view: string;
  posX: number;
  posY: number;
  kind: string;
  description: string;
  size?: string | null;
  severity?: string;
};

function assertDamageInput(input: Partial<NewDamageInput>) {
  if (input.posX !== undefined || input.posY !== undefined) {
    const { posX: x, posY: y } = input;
    if (!(typeof x === "number" && typeof y === "number" && x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new DomainError("Schadenpositionen werden normalisiert gespeichert (0 bis 1), keine Pixelwerte.");
  }
  if (input.view !== undefined && !(input.view in DAMAGE_VIEWS)) throw new DomainError("Unbekannte Fahrzeugansicht.");
  if (input.kind !== undefined && !(input.kind in DAMAGE_KINDS)) throw new DomainError("Bitte die Art des Schadens wählen.");
  if (input.severity !== undefined && !(input.severity in DAMAGE_SEVERITY)) throw new DomainError("Bitte den Schweregrad wählen.");
  if (input.description !== undefined && input.description.trim().length < 3) throw new DomainError("Bitte den Schaden kurz beschreiben.");
}

/** Neuer Schaden im Entwurf. Die Schadenakte (Damage) entsteht erst beim Finalisieren. */
export async function addNewDamage(tenantId: string, handoverId: string, input: NewDamageInput) {
  assertDamageInput({ ...input, severity: input.severity ?? "MINOR" });
  return db.$transaction(async (tx) => {
    const h = await loadDraft(tx, tenantId, handoverId);
    if (h.sketchId) {
      const sketch = await tx.vehicleSketch.findFirst({ where: { id: h.sketchId } });
      const views = Array.isArray(sketch?.views) ? (sketch!.views as { key?: string }[]).map((v) => v.key) : [];
      if (views.length > 0 && !views.includes(input.view)) throw new DomainError("Diese Ansicht gibt es in der Fahrzeugskizze nicht.");
    }
    const last = await tx.handoverDamage.findFirst({ where: { tenantId, handoverId: h.id }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    const created = await tx.handoverDamage.create({
      data: {
        tenantId,
        handoverId: h.id,
        marker: "NEW",
        view: input.view,
        posX: input.posX,
        posY: input.posY,
        kind: input.kind,
        description: input.description.trim(),
        size: input.size?.trim() || null,
        severity: input.severity ?? "MINOR",
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    await touch(tx, tenantId, h.id);
    return created;
  }, TX);
}

async function loadNewDamage(tx: Tx, tenantId: string, handoverDamageId: string) {
  const d = await tx.handoverDamage.findFirst({ where: { id: handoverDamageId, tenantId } });
  if (!d) throw new DomainError("Schaden nicht gefunden.");
  await loadDraft(tx, tenantId, d.handoverId);
  if (d.marker !== "NEW") throw new DomainError("Vorhandene Schäden gehören zum dokumentierten Fahrzeugzustand und können im Protokoll nicht verändert werden.");
  return d;
}

/** Im Entwurf erfassten Schaden bearbeiten oder auf der Skizze verschieben. */
export async function updateNewDamage(tenantId: string, handoverDamageId: string, input: Partial<NewDamageInput>) {
  assertDamageInput(input);
  return db.$transaction(async (tx) => {
    const d = await loadNewDamage(tx, tenantId, handoverDamageId);
    const updated = await tx.handoverDamage.update({
      where: { id: d.id },
      data: {
        ...(input.view !== undefined ? { view: input.view } : {}),
        ...(input.posX !== undefined ? { posX: input.posX } : {}),
        ...(input.posY !== undefined ? { posY: input.posY } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.size !== undefined ? { size: input.size?.trim() || null } : {}),
        ...(input.severity !== undefined ? { severity: input.severity } : {}),
      },
    });
    await touch(tx, tenantId, d.handoverId);
    return updated;
  }, TX);
}

/** Entfernt einen im Entwurf erfassten Schaden samt seinen Fotos. Gibt die Speicherschlüssel zum Aufräumen zurück. */
export async function removeNewDamage(tenantId: string, handoverDamageId: string): Promise<string[]> {
  return db.$transaction(async (tx) => {
    const d = await loadNewDamage(tx, tenantId, handoverDamageId);
    const photos = await tx.photo.findMany({ where: { tenantId, handoverDamageId: d.id }, select: { id: true, storageKey: true } });
    await tx.photo.deleteMany({ where: { tenantId, id: { in: photos.map((p) => p.id) } } });
    await tx.handoverDamage.delete({ where: { id: d.id } });
    await touch(tx, tenantId, d.handoverId);
    return photos.map((p) => p.storageKey);
  }, TX);
}

export type PhotoInput = {
  handoverId: string;
  handoverDamageId?: string | null;
  storageKey: string;
  category: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  width?: number | null;
  height?: number | null;
  takenAt?: Date | null;
};

/** Trägt ein bereits hochgeladenes Foto ein. Gespeichert wird nur der Storage Key, keine URL. */
export async function registerPhoto(tenantId: string, actor: Actor, input: PhotoInput) {
  return db.$transaction(async (tx) => {
    const h = await loadDraft(tx, tenantId, input.handoverId);
    assertKeyBelongsToTenant(input.storageKey, tenantId);
    if (!(input.category in PHOTO_CATEGORIES)) throw new DomainError("Unbekannte Fotokategorie.");
    if (!(ALLOWED_PHOTO_TYPES as readonly string[]).includes(input.contentType)) throw new DomainError("Dieser Dateityp ist für Fotos nicht erlaubt.");
    if (input.sizeBytes <= 0 || input.sizeBytes > MAX_PHOTO_BYTES) throw new DomainError("Das Foto ist zu groß.");
    if (!/^[a-f0-9]{64}$/.test(input.checksum)) throw new DomainError("Die Prüfsumme des Fotos fehlt oder ist ungültig.");

    let snapshotRow = null;
    if (input.handoverDamageId) {
      snapshotRow = await tx.handoverDamage.findFirst({ where: { id: input.handoverDamageId, tenantId, handoverId: h.id } });
      if (!snapshotRow) throw new DomainError("Der Schaden gehört nicht zu diesem Protokoll.");
    }
    const photo = await tx.photo.create({
      data: {
        tenantId,
        handoverId: h.id,
        handoverDamageId: snapshotRow?.id ?? null,
        damageId: snapshotRow?.damageId ?? null,
        storageKey: input.storageKey,
        category: snapshotRow ? "DAMAGE" : input.category,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        checksum: input.checksum,
        width: input.width ?? null,
        height: input.height ?? null,
        takenAt: input.takenAt ?? null,
        createdById: actor.id,
      },
    });
    if (snapshotRow) {
      const refs = Array.isArray(snapshotRow.photoRefs) ? (snapshotRow.photoRefs as Prisma.JsonArray) : [];
      await tx.handoverDamage.update({
        where: { id: snapshotRow.id },
        data: { photoRefs: [...refs, { photoId: photo.id, storageKey: photo.storageKey, checksum: photo.checksum }] },
      });
    }
    await touch(tx, tenantId, h.id);
    return photo;
  }, TX);
}

/** Löscht ein im Entwurf aufgenommenes Foto. Gibt den Speicherschlüssel zum Aufräumen zurück. */
export async function removePhoto(tenantId: string, photoId: string): Promise<string> {
  return db.$transaction(async (tx) => {
    const photo = await tx.photo.findFirst({ where: { id: photoId, tenantId } });
    if (!photo || !photo.handoverId) throw new DomainError("Foto nicht gefunden.");
    await loadDraft(tx, tenantId, photo.handoverId);
    if (photo.handoverDamageId) {
      const row = await tx.handoverDamage.findFirst({ where: { id: photo.handoverDamageId, tenantId } });
      if (row) {
        const refs = (Array.isArray(row.photoRefs) ? (row.photoRefs as { photoId?: string }[]) : []).filter((r) => r.photoId !== photo.id);
        await tx.handoverDamage.update({ where: { id: row.id }, data: { photoRefs: refs as Prisma.InputJsonValue } });
      }
    }
    await tx.photo.delete({ where: { id: photo.id } });
    await touch(tx, tenantId, photo.handoverId);
    return photo.storageKey;
  }, TX);
}

// ---------------------------------------------------------------------------
// Prüfung, Stand, Abschluss
// ---------------------------------------------------------------------------

export type HandoverIssue = {
  code: string;
  area: "BOOKING" | "READINGS" | "DAMAGES" | "PHOTOS" | "CHECKLIST" | "CHARGES" | "SIGNATURE" | "DRIVERS";
  severity: "error" | "warning";
  message: string;
};

export type FinalizeOptions = {
  /** Pflichtfotos prüfen. Nur für Nachträge oder Sonderfälle abschaltbar. */
  enforcePhotos?: boolean;
};

/** Eine Antwort ist auffällig, wenn sie der Erwartung widerspricht: Nein / Nicht in Ordnung, bei "ungewöhnlich verschmutzt" das Ja. */
const isAttention = (x: { itemKey: string; result: string | null }) => (RETURN_ATTENTION_ON_YES.has(x.itemKey) ? x.result === "YES" : x.result === "NO" || x.result === "NOT_OK");

/** Alle Prüfungen auf einen Blick. Dieselbe Funktion speist den Assistenten und entscheidet beim Abschluss. */
async function collectIssues(tx: Tx, tenantId: string, handoverId: string, opts: { requireSignature: boolean; enforcePhotos: boolean }): Promise<HandoverIssue[]> {
  const { handover: h, hash } = await handoverContent(tx, tenantId, handoverId);
  const issues: HandoverIssue[] = [];
  const err = (area: HandoverIssue["area"], code: string, message: string) => issues.push({ area, code, severity: "error", message });
  const warn = (area: HandoverIssue["area"], code: string, message: string) => issues.push({ area, code, severity: "warning", message });

  const booking = await tx.booking.findFirst({ where: { id: h.bookingId, tenantId }, include: { contract: { select: { status: true } } } });
  const vehicle = await tx.vehicle.findFirst({ where: { id: h.vehicleId, tenantId } });
  if (!booking || !vehicle) {
    err("BOOKING", "BOOKING_MISSING", "Buchung oder Fahrzeug gehören nicht zu diesem Mandanten.");
    return issues;
  }
  if (h.type === "PICKUP") {
    if (booking.status !== "RESERVED") err("BOOKING", "BOOKING_STATUS", "Die Buchung ist nicht mehr reserviert.");
    if (booking.contract?.status !== "SIGNED") err("BOOKING", "CONTRACT_NOT_SIGNED", "Der Mietvertrag ist nicht abgeschlossen.");
    if (booking.vehicleId !== h.vehicleId) err("BOOKING", "VEHICLE_CHANGED", "Das Fahrzeug der Buchung wurde geändert. Bitte die Übergabe neu starten.");
    const statusProblem = vehicleStatusProblem(vehicle.status);
    if (statusProblem) err("BOOKING", "VEHICLE_NOT_RENTABLE", statusProblem);
    const elsewhere = await tx.booking.count({ where: { tenantId, vehicleId: h.vehicleId, status: "ACTIVE", id: { not: booking.id } } });
    if (elsewhere > 0) err("BOOKING", "VEHICLE_ALREADY_OUT", "Das Fahrzeug ist laut einer anderen Buchung noch unterwegs. Bitte zuerst die Rückgabe dieser Miete abschließen.");
  } else {
    if (booking.status !== "ACTIVE") err("BOOKING", "BOOKING_STATUS", "Die Miete ist nicht aktiv.");
    if (booking.contract?.status !== "SIGNED") err("BOOKING", "CONTRACT_NOT_SIGNED", "Zu dieser Miete gibt es keinen abgeschlossenen Mietvertrag.");
    const others = await tx.handover.count({ where: { tenantId, bookingId: h.bookingId, type: "RETURN", status: "FINALIZED", id: { not: h.id } } });
    if (others > 0) err("BOOKING", "RETURN_EXISTS", "Zu dieser Miete gibt es bereits ein abgeschlossenes Rückgabeprotokoll.");
  }
  const pickup = h.type === "RETURN" ? await tx.handover.findFirst({ where: { tenantId, bookingId: h.bookingId, type: "PICKUP", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" }, include: { checklistItems: true } }) : null;
  if (h.type === "RETURN" && !pickup) err("BOOKING", "PICKUP_MISSING", "Zu dieser Miete gibt es kein abgeschlossenes Übergabeprotokoll.");

  // Messwerte
  if (h.mileage == null) err("READINGS", "MILEAGE_MISSING", "Der Kilometerstand fehlt.");
  else {
    if (h.type === "PICKUP" && h.mileage < vehicle.mileage) err("READINGS", "MILEAGE_BELOW_VEHICLE", `Der Kilometerstand (${h.mileage.toLocaleString("de-DE")}) liegt unter dem letzten bekannten Stand des Fahrzeugs (${vehicle.mileage.toLocaleString("de-DE")} km).`);
    if (h.type === "PICKUP" && h.mileage - vehicle.mileage > 2000) warn("READINGS", "MILEAGE_JUMP", `Der Kilometerstand liegt ${(h.mileage - vehicle.mileage).toLocaleString("de-DE")} km über dem letzten bekannten Stand. Bitte prüfen.`);
    if (h.type === "RETURN" && pickup?.mileage != null) {
      // Ein Rückgabestand unter dem Übergabestand wird nie still akzeptiert. Eine Korrektur des Übergabestands
      // gibt es nur als eigenes, dokumentiertes Nachtragsprotokoll (correctsId), nicht hier.
      if (h.mileage < pickup.mileage) err("READINGS", "MILEAGE_BELOW_PICKUP", `Der Rückgabe-Kilometerstand (${h.mileage.toLocaleString("de-DE")} km) liegt unter dem Übergabestand (${pickup.mileage.toLocaleString("de-DE")} km). Bitte prüfen; ein niedrigerer Stand kann nicht übernommen werden.`);
      else if (h.mileage - pickup.mileage > 5000) warn("READINGS", "MILEAGE_JUMP", `Seit der Übergabe wurden ${(h.mileage - pickup.mileage).toLocaleString("de-DE")} km gefahren. Bitte den Stand prüfen.`);
    }
  }
  const energy = energyRequirements(h.driveType);
  if (energy.fuel && h.fuelLevelEighths == null) err("READINGS", "FUEL_MISSING", "Der Tankstand fehlt.");
  if (energy.battery && h.batteryPercent == null) err("READINGS", "BATTERY_MISSING", "Der Batteriestand fehlt.");

  // Schäden
  const newDamages = h.damages.filter((d) => d.marker === "NEW");
  newDamages.forEach((d, i) => {
    const refs = Array.isArray(d.photoRefs) ? d.photoRefs.length : 0;
    if (refs === 0) err("DAMAGES", "DAMAGE_PHOTO_MISSING", `Neuer Schaden ${i + 1} (${d.description}): es fehlt mindestens ein Foto.`);
  });

  // Fotos
  if (opts.enforcePhotos) {
    const have = new Set(h.photos.map((p) => p.category));
    const missing = REQUIRED_PHOTO_CATEGORIES.filter((c) => !have.has(c));
    if (missing.length > 0) err("PHOTOS", "PHOTOS_MISSING", `Es fehlen Pflichtfotos: ${missing.map((c) => PHOTO_CATEGORIES[c]).join(", ")}.`);
  }

  // Zusatzkosten (nur Rückgabe): jede Position muss zu einem Schaden dieses Protokolls passen, wenn sie einen nennt
  for (const c of h.extraCharges) {
    if (Number(c.amount) < 0 || Number(c.quantity) <= 0) err("CHARGES", "CHARGE_INVALID", `Zusatzkosten „${c.description}“: Betrag oder Menge sind ungültig.`);
    if (c.handoverDamageId && !h.damages.some((d) => d.id === c.handoverDamageId && d.marker === "NEW")) err("CHARGES", "CHARGE_DAMAGE_MISSING", `Zusatzkosten „${c.description}“: der verknüpfte Schaden ist nicht mehr im Protokoll.`);
  }

  // Rückgabe: fehlende Gegenstände und Verspätung nur als Hinweis, nie als automatische Forderung
  if (h.type === "RETURN" && pickup) {
    const given = parseInt(pickup.checklistItems.find((c) => c.itemKey === "keys")?.result ?? "", 10);
    const returned = parseInt(h.checklistItems.find((c) => c.itemKey === "keys_returned")?.result ?? "", 10);
    if (Number.isFinite(given) && Number.isFinite(returned) && returned < given) warn("CHECKLIST", "ACCESSORY_MISSING", `Bei der Übergabe wurden ${given} Schlüssel dokumentiert, zurück kamen ${returned}. Falls etwas fehlt, kann in Schritt 7 eine Position „Fehlendes Zubehör“ erfasst werden.`);
    for (const c of h.checklistItems.filter(isAttention)) warn("CHECKLIST", "CHECKLIST_ATTENTION", `Auffällig: ${c.label}${c.note ? ` (${c.note})` : ""}.`);
    if (booking.endAt.getTime() < Date.now() - 15 * 60_000) {
      const minutes = Math.round((Date.now() - booking.endAt.getTime()) / 60_000);
      warn("BOOKING", "LATE_RETURN", `Die Rückgabe liegt ${Math.floor(minutes / 60)} Std. ${minutes % 60} Min. nach der vereinbarten Zeit. Eine Gebühr entsteht nur, wenn sie in Schritt 7 bewusst erfasst wird.`);
    }
  }

  // Übergabe: Kaution laut Vertrag noch nicht als erhalten dokumentiert – nur Hinweis, blockiert nie (Entscheidung Phase 9)
  if (h.type === "PICKUP" && booking.contract?.status === "SIGNED") {
    const contract = await tx.rentalContract.findFirst({ where: { bookingId: h.bookingId, tenantId }, select: { deposit: true } });
    const expected = contract ? toCents(contract.deposit) : 0;
    if (expected > 0) {
      const dep = await tx.securityDeposit.findFirst({ where: { tenantId, bookingId: h.bookingId }, include: { events: { select: { type: true, amountCents: true, status: true } } } });
      const received = dep ? balanceOf(dep.expectedAmountCents, dep.events).receivedCents : 0;
      if (received < expected) warn("BOOKING", "DEPOSIT_NOT_RECEIVED", `Kaution laut Vertrag (${fmtCents(expected)}) noch nicht ${received > 0 ? "vollständig " : ""}als erhalten dokumentiert. Die Übergabe kann trotzdem abgeschlossen werden.`);
    }
  }

  // Fahrer & Dokumente (nur Übergabe, Phase 19.5): jeder laut Vertrag vorgesehene Fahrer muss bestätigt geprüft sein.
  // Serverseitiger Blocker, keine reine UI-Regel – dieselbe Funktion entscheidet Anzeige und Abschluss.
  if (h.type === "PICKUP") {
    const driverBlockers = await driverVerificationBlockers(tenantId, handoverId, tx);
    for (const b of driverBlockers) err("DRIVERS", b.code, b.message);
  }

  // Checkliste
  const open = h.checklistItems.filter((c) => c.required && !c.result);
  if (open.length > 0) err("CHECKLIST", "CHECKLIST_OPEN", `Es fehlen noch ${open.length} Pflichtpunkte der Checkliste, zuerst: ${open[0].label}`);
  for (const c of h.checklistItems.filter((x) => isAttention(x) && !x.note)) err("CHECKLIST", "CHECKLIST_NOTE", `Checkliste „${c.label}“: bitte kurz notieren, was aufgefallen ist.`);

  if (opts.requireSignature) {
    const signatures = await tx.signature.findMany({ where: { tenantId, handoverId }, select: { role: true, contentHash: true } });
    const renter = signatures.find((s) => s.role === "RENTER");
    if (!renter) err("SIGNATURE", "SIGNATURE_MISSING", "Die Unterschrift des Mieters fehlt.");
    else if (renter.contentHash !== hash) err("SIGNATURE", "SIGNATURE_STALE", "Das Protokoll wurde nach der Unterschrift geändert. Der Mieter muss erneut unterschreiben.");
    if (signatures.some((s) => s.role === "EMPLOYEE" && s.contentHash !== hash)) err("SIGNATURE", "SIGNATURE_STALE_EMPLOYEE", "Die Unterschrift des Mitarbeiters passt nicht mehr zum Protokoll.");
  }
  return issues;
}

/** Stand des Protokolls für den Assistenten und die Anzeige: Inhalt, Unterschriften (ohne Bilddaten), Prüfergebnis, Hash, Skizze. */
export async function getHandoverState(tenantId: string, handoverId: string) {
  return db.$transaction(async (tx) => {
    const { handover, hash } = await handoverContent(tx, tenantId, handoverId);
    if (handover.status === "DRAFT") await touch(tx, tenantId, handoverId);
    const signatures = await tx.signature.findMany({ where: { tenantId, handoverId }, select: { id: true, role: true, signerName: true, signedAt: true, contentHash: true }, orderBy: { signedAt: "asc" } });
    const sketch = handover.sketchId ? await tx.vehicleSketch.findFirst({ where: { id: handover.sketchId } }) : null;
    const issues = handover.status === "DRAFT" ? await collectIssues(tx, tenantId, handoverId, { requireSignature: false, enforcePhotos: true }) : [];
    return { handover, signatures, sketch, issues, hash: handover.status === "DRAFT" ? hash : handover.contentHash ?? hash };
  }, TX);
}

/**
 * Versiegelt das Protokoll: sperrt die Zeile, prüft alles erneut, legt neue Schäden in der Schadenakte an,
 * schreibt Kilometerstand und Buchungsstatus fort, erzeugt die Fahrzeughistorie und sperrt zum Schluss das Protokoll.
 * Ein zweiter Aufruf, auch gleichzeitig, scheitert: das Protokoll ist dann kein Entwurf mehr.
 */
export async function finalizeHandover(tenantId: string, handoverId: string, actor: Actor, options: FinalizeOptions = {}) {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Handover" WHERE "id" = ${handoverId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Protokoll nicht gefunden.");
    const { handover: h, hash } = await handoverContent(tx, tenantId, handoverId);
    assertHandoverDraft(h);

    const problems = (await collectIssues(tx, tenantId, handoverId, { requireSignature: true, enforcePhotos: options.enforcePhotos !== false })).filter((i) => i.severity === "error");
    if (problems.length > 0) throw new DomainError(problems.length === 1 ? problems[0].message : `${problems[0].message} (und ${problems.length - 1} weitere Punkte)`);

    const vehicle = await tx.vehicle.findFirstOrThrow({ where: { id: h.vehicleId, tenantId } });
    const booking = await tx.booking.findFirstOrThrow({ where: { id: h.bookingId, tenantId } });
    const mileage = h.mileage!;

    // Statuswechsel der Buchung: bestehende Statuswerte, keine zweite Logik. Nur hier entsteht "Unterwegs".
    const now = new Date();
    if (h.type === "PICKUP") await tx.booking.update({ where: { id: booking.id }, data: { status: "ACTIVE", actualPickupAt: now } });
    else await tx.booking.update({ where: { id: booking.id }, data: { status: "RETURNED", actualReturnAt: now } });

    // Neue Schäden in die Schadenakte übernehmen. Die Kopie im Protokoll bleibt davon unabhängig.
    for (const d of h.damages.filter((x) => x.marker === "NEW" && !x.damageId)) {
      const damage = await tx.damage.create({
        data: {
          tenantId,
          vehicleId: h.vehicleId,
          view: d.view,
          posX: d.posX,
          posY: d.posY,
          kind: d.kind,
          description: d.description,
          size: d.size,
          severity: d.severity,
          status: "OPEN",
          discoveredAt: now,
          discoveredInHandoverId: h.id,
          // Bei der Übergabe entdeckt = Vorschaden: keinem Mieter zugeordnet. Nur bei der Rückgabe zählt die Buchung.
          bookingId: h.type === "RETURN" ? h.bookingId : null,
          reportedById: actor.id,
        },
      });
      await tx.handoverDamage.update({ where: { id: d.id }, data: { damageId: damage.id } });
      await tx.photo.updateMany({ where: { tenantId, handoverDamageId: d.id }, data: { damageId: damage.id } });
      if (h.type === "RETURN") {
        // Festgestellt heißt nicht verursacht: die Akte merkt nur vor, dass die Abrechnung intern zu prüfen ist
        await tx.damage.update({ where: { id: damage.id }, data: { settlementReview: true } });
        await tx.extraCharge.updateMany({ where: { tenantId, handoverId: h.id, handoverDamageId: d.id }, data: { damageId: damage.id } });
      }
      await recordVehicleEvent(tx, { tenantId, vehicleId: h.vehicleId, type: "DAMAGE_DISCOVERED", occurredAt: now, mileage, bookingId: h.bookingId, damageId: damage.id, handoverId: h.id, actor, description: h.type === "PICKUP" ? `Vorschaden bei Übergabe: ${d.description}` : `Bei Rückgabe festgestellt: ${d.description}` });
    }

    // Kilometerstand erst jetzt fortschreiben, nie zurückdrehen
    if (mileage > vehicle.mileage) await tx.vehicle.update({ where: { id: vehicle.id }, data: { mileage } });
    await recordVehicleEvent(tx, { tenantId, vehicleId: h.vehicleId, type: h.type as "PICKUP" | "RETURN", occurredAt: now, mileage, bookingId: h.bookingId, handoverId: h.id, actor, description: `${h.type === "PICKUP" ? "Übergabe" : "Rückgabe"} ${h.number}` });
    await recordVehicleEvent(tx, { tenantId, vehicleId: h.vehicleId, type: "MILEAGE", occurredAt: now, mileage, bookingId: h.bookingId, handoverId: h.id, actor });

    // Ganz zum Schluss versiegeln. Ab hier greifen die Sperren.
    return tx.handover.update({ where: { id: h.id }, data: { status: "FINALIZED", finalizedAt: now, contentHash: hash, wizardStep: HANDOVER_STEPS } });
  }, TX);
}

/** Prüft, ob ein finalisiertes Protokoll noch dem gespeicherten Hash entspricht (Nachweis der Unverändertheit). */
export async function verifyHandover(tenantId: string, handoverId: string) {
  return db.$transaction(async (tx) => {
    const { handover, hash } = await handoverContent(tx, tenantId, handoverId);
    return { finalized: handover.status === "FINALIZED", storedHash: handover.contentHash, currentHash: hash, intact: handover.status === "FINALIZED" && handover.contentHash === hash };
  }, TX);
}
