// Übergabe (PICKUP) und Rückgabe (RETURN).
//
// Snapshot-Prinzip: Beim Start werden die aktuell sichtbaren Schäden des Fahrzeugs und die gültige
// Checkliste in das Protokoll KOPIERT. Das Protokoll liest danach nie wieder aus der Schadenakte oder
// aus der Vorlage. Beim Finalisieren wird der Inhalt gehasht und das Protokoll gesperrt.
//
// Reihenfolge beim Finalisieren: erst alle Bestandteile schreiben, ganz zum Schluss den Status setzen.
// Danach blockieren Code (assertHandoverDraft) und Datenbank-Trigger jede weitere Änderung.
//
// Jede Funktion verlangt die tenantId und filtert damit jede Abfrage.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { BATTERY_DRIVE_TYPES, REQUIRED_PHOTO_CATEGORIES, VISIBLE_DAMAGE_STATUS, type HandoverType } from "@/lib/constants";
import { DomainError, assertHandoverDraft, contentHash } from "@/lib/integrity";
import { nextHandoverNumber } from "@/lib/numbering";
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, assertKeyBelongsToTenant } from "@/lib/storage";
import { resolveChecklist } from "@/lib/checklists";
import { resolveSketch } from "@/lib/sketches";
import { recordVehicleEvent } from "@/lib/vehicle-events";

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; name: string };

async function loadDraft(tx: Tx, tenantId: string, handoverId: string) {
  const h = await tx.handover.findFirst({ where: { id: handoverId, tenantId } });
  if (!h) throw new DomainError("Protokoll nicht gefunden.");
  assertHandoverDraft(h);
  return h;
}

/**
 * Startet ein Protokoll oder setzt einen vorhandenen Entwurf fort.
 * Kopiert sichtbare Schäden (EXISTING) samt Fotoverweisen und die Checkliste in das Protokoll.
 */
export async function startHandover(tenantId: string, bookingId: string, type: HandoverType, actor: Actor) {
  return db.$transaction(async (tx) => {
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
    if (type === "RETURN" && booking.status !== "ACTIVE") throw new DomainError("Eine Rückgabe ist nur für laufende Mieten möglich.");

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
          marker: "EXISTING",
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

    // Checkliste kopieren: Fragetext und Reihenfolge von jetzt
    const checklist = await resolveChecklist(tx, tenantId, booking.vehicle.groupId, type);
    if (checklist.items.length > 0) {
      await tx.handoverChecklistItem.createMany({
        data: checklist.items.map((item, i) => ({
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
  });
}

export type HandoverDraftInput = {
  mileage?: number | null;
  fuelLevelEighths?: number | null;
  batteryPercent?: number | null;
  accessories?: Prisma.InputJsonValue | null;
  notes?: string | null;
};

/** Ändert Messwerte eines Entwurfs. Finalisierte Protokolle werden abgelehnt. */
export async function updateHandoverDraft(tenantId: string, handoverId: string, input: HandoverDraftInput) {
  return db.$transaction(async (tx) => {
    const h = await loadDraft(tx, tenantId, handoverId);
    if (input.mileage != null && (!Number.isInteger(input.mileage) || input.mileage < 0)) throw new DomainError("Der Kilometerstand muss eine ganze Zahl ab 0 sein.");
    if (input.fuelLevelEighths != null && (input.fuelLevelEighths < 0 || input.fuelLevelEighths > 8)) throw new DomainError("Der Tankstand liegt zwischen 0 und 8 Achteln.");
    if (input.batteryPercent != null && (input.batteryPercent < 0 || input.batteryPercent > 100)) throw new DomainError("Der Batteriestand liegt zwischen 0 und 100 Prozent.");
    return tx.handover.update({
      where: { id: h.id },
      data: {
        ...(input.mileage !== undefined ? { mileage: input.mileage } : {}),
        ...(input.fuelLevelEighths !== undefined ? { fuelLevelEighths: input.fuelLevelEighths } : {}),
        ...(input.batteryPercent !== undefined ? { batteryPercent: input.batteryPercent } : {}),
        ...(input.accessories !== undefined ? { accessories: input.accessories ?? undefined } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
  });
}

export async function answerChecklistItem(tenantId: string, itemId: string, result: string | null, note?: string | null) {
  return db.$transaction(async (tx) => {
    const item = await tx.handoverChecklistItem.findFirst({ where: { id: itemId, tenantId } });
    if (!item) throw new DomainError("Checklistenpunkt nicht gefunden.");
    await loadDraft(tx, tenantId, item.handoverId);
    return tx.handoverChecklistItem.update({ where: { id: item.id }, data: { result, note: note ?? null } });
  });
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

function assertPosition(x: number, y: number) {
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new DomainError("Schadenpositionen werden normalisiert gespeichert (0 bis 1), keine Pixelwerte.");
}

/** Neuer Schaden im Entwurf. Die Schadenakte (Damage) entsteht erst beim Finalisieren. */
export async function addNewDamage(tenantId: string, handoverId: string, input: NewDamageInput) {
  return db.$transaction(async (tx) => {
    const h = await loadDraft(tx, tenantId, handoverId);
    assertPosition(input.posX, input.posY);
    const count = await tx.handoverDamage.count({ where: { tenantId, handoverId: h.id } });
    return tx.handoverDamage.create({
      data: {
        tenantId,
        handoverId: h.id,
        marker: "NEW",
        view: input.view,
        posX: input.posX,
        posY: input.posY,
        kind: input.kind,
        description: input.description,
        size: input.size ?? null,
        severity: input.severity ?? "MINOR",
        sortOrder: count,
      },
    });
  });
}

/** Entfernt einen im Entwurf erfassten neuen Schaden wieder. Kopierte Altschäden lassen sich nicht entfernen. */
export async function removeNewDamage(tenantId: string, handoverDamageId: string) {
  return db.$transaction(async (tx) => {
    const d = await tx.handoverDamage.findFirst({ where: { id: handoverDamageId, tenantId } });
    if (!d) throw new DomainError("Schaden nicht gefunden.");
    await loadDraft(tx, tenantId, d.handoverId);
    if (d.marker !== "NEW") throw new DomainError("Vorhandene Schäden gehören zum Fahrzeugzustand und können im Protokoll nicht entfernt werden.");
    await tx.handoverDamage.delete({ where: { id: d.id } });
  });
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
        category: input.category,
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
    return photo;
  });
}

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
    damages: h.damages.map((d) => ({ marker: d.marker, view: d.view, posX: d.posX, posY: d.posY, kind: d.kind, description: d.description, size: d.size, severity: d.severity, photoRefs: d.photoRefs })),
    checklist: h.checklistItems.map((c) => ({ key: c.itemKey, label: c.label, answerType: c.answerType, required: c.required, result: c.result, note: c.note, templateVersion: c.templateVersion })),
    photos: h.photos.map((p) => ({ category: p.category, storageKey: p.storageKey, checksum: p.checksum })),
    extraCharges: h.extraCharges.map((e) => ({ type: e.type, formula: e.formula, amount: String(e.amount) })),
  };
  return { handover: h, hash: contentHash(content) };
}

/** Hash des aktuellen Entwurfs. Diesen Wert bekommt die Unterschrift mit. */
export async function getHandoverContentHash(tenantId: string, handoverId: string) {
  return db.$transaction(async (tx) => (await handoverContent(tx, tenantId, handoverId)).hash);
}

export type SignatureInput = {
  handoverId: string;
  role: "RENTER" | "EMPLOYEE";
  signerName: string;
  storageKey: string;
  contentHash: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Speichert eine Unterschrift unter ein Protokoll. Stimmt der übergebene Hash nicht mit dem aktuellen
 * Inhalt überein, wurde das Protokoll seit der Anzeige geändert und die Unterschrift wird abgelehnt.
 * Unterschriften unter Verträge laufen über saveContractSignature in lib/contracts.ts.
 */
export async function addSignature(tenantId: string, actor: Actor | null, input: SignatureInput) {
  assertKeyBelongsToTenant(input.storageKey, tenantId);
  return db.$transaction(async (tx) => {
    await loadDraft(tx, tenantId, input.handoverId);
    const { hash } = await handoverContent(tx, tenantId, input.handoverId);
    if (hash !== input.contentHash) throw new DomainError("Das Protokoll wurde seit der Anzeige geändert. Bitte neu laden und erneut unterschreiben.");
    // Eine Rolle unterschreibt nur einmal: vorherige Unterschrift derselben Rolle im Entwurf ersetzen
    await tx.signature.deleteMany({ where: { tenantId, role: input.role, handoverId: input.handoverId } });
    return tx.signature.create({
      data: {
        tenantId,
        handoverId: input.handoverId,
        role: input.role,
        signerName: input.signerName,
        storageKey: input.storageKey,
        contentHash: input.contentHash,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        createdById: actor?.id ?? null,
      },
    });
  });
}

export type FinalizeOptions = {
  /** Pflichtfotos prüfen. Nur für Nachträge oder Sonderfälle abschaltbar. */
  enforcePhotos?: boolean;
};

/**
 * Versiegelt das Protokoll: prüft Pflichtangaben und Unterschrift, legt neue Schäden in der Schadenakte an,
 * schreibt Kilometerstand und Buchungsstatus fort, erzeugt die Fahrzeughistorie und sperrt zum Schluss das Protokoll.
 */
export async function finalizeHandover(tenantId: string, handoverId: string, actor: Actor, options: FinalizeOptions = {}) {
  return db.$transaction(async (tx) => {
    const { handover: h, hash } = await handoverContent(tx, tenantId, handoverId);
    assertHandoverDraft(h);

    // Pflichtangaben
    if (h.mileage == null) throw new DomainError("Der Kilometerstand fehlt.");
    const usesBattery = BATTERY_DRIVE_TYPES.includes(h.driveType);
    if (usesBattery && h.batteryPercent == null) throw new DomainError("Der Batteriestand fehlt.");
    if (!usesBattery && h.fuelLevelEighths == null) throw new DomainError("Der Tankstand fehlt.");
    const open = h.checklistItems.filter((c) => c.required && !c.result);
    if (open.length > 0) throw new DomainError(`Es fehlen noch ${open.length} Pflichtpunkte der Checkliste, zuerst: ${open[0].label}`);
    if (options.enforcePhotos !== false) {
      const have = new Set(h.photos.map((p) => p.category));
      const missing = REQUIRED_PHOTO_CATEGORIES.filter((c) => !have.has(c));
      if (missing.length > 0) throw new DomainError(`Es fehlen Pflichtfotos: ${missing.join(", ")}`);
    }

    const vehicle = await tx.vehicle.findFirst({ where: { id: h.vehicleId, tenantId } });
    const booking = await tx.booking.findFirst({ where: { id: h.bookingId, tenantId } });
    if (!vehicle || !booking) throw new DomainError("Buchung oder Fahrzeug nicht gefunden.");

    if (h.type === "RETURN") {
      const pickup = await tx.handover.findFirst({ where: { tenantId, bookingId: h.bookingId, type: "PICKUP", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" } });
      if (pickup?.mileage != null && h.mileage < pickup.mileage) throw new DomainError(`Der Kilometerstand (${h.mileage}) liegt unter dem der Übergabe (${pickup.mileage}).`);
    }

    // Unterschrift des Mieters über genau diesen Inhalt
    const signatures = await tx.signature.findMany({ where: { tenantId, handoverId: h.id } });
    if (!signatures.some((s) => s.role === "RENTER")) throw new DomainError("Die Unterschrift des Mieters fehlt.");
    if (signatures.some((s) => s.contentHash !== hash)) throw new DomainError("Das Protokoll wurde nach der Unterschrift geändert. Bitte erneut unterschreiben lassen.");

    // Statuswechsel der Buchung: bestehende Statuswerte, keine zweite Logik
    const now = new Date();
    if (h.type === "PICKUP") {
      if (booking.status !== "RESERVED") throw new DomainError("Die Buchung ist nicht mehr reserviert.");
      await tx.booking.update({ where: { id: booking.id }, data: { status: "ACTIVE", actualPickupAt: now } });
    } else {
      if (booking.status !== "ACTIVE") throw new DomainError("Die Miete ist nicht aktiv.");
      await tx.booking.update({ where: { id: booking.id }, data: { status: "RETURNED", actualReturnAt: now } });
    }

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
          bookingId: h.type === "RETURN" ? h.bookingId : null, // bei der Übergabe gefunden: nicht dem Mieter zugeordnet
          reportedById: actor.id,
        },
      });
      await tx.handoverDamage.update({ where: { id: d.id }, data: { damageId: damage.id } });
      await tx.photo.updateMany({ where: { tenantId, handoverDamageId: d.id }, data: { damageId: damage.id } });
      await recordVehicleEvent(tx, { tenantId, vehicleId: h.vehicleId, type: "DAMAGE_DISCOVERED", occurredAt: now, mileage: h.mileage, bookingId: h.bookingId, damageId: damage.id, handoverId: h.id, actor, description: d.description });
    }

    // Kilometerstand fortschreiben, nie zurückdrehen
    if (h.mileage > vehicle.mileage) await tx.vehicle.update({ where: { id: vehicle.id }, data: { mileage: h.mileage } });
    await recordVehicleEvent(tx, { tenantId, vehicleId: h.vehicleId, type: h.type as "PICKUP" | "RETURN", occurredAt: now, mileage: h.mileage, bookingId: h.bookingId, handoverId: h.id, actor, description: `${h.type === "PICKUP" ? "Übergabe" : "Rückgabe"} ${h.number}` });
    await recordVehicleEvent(tx, { tenantId, vehicleId: h.vehicleId, type: "MILEAGE", occurredAt: now, mileage: h.mileage, bookingId: h.bookingId, handoverId: h.id, actor });

    // Ganz zum Schluss versiegeln. Ab hier greifen die Sperren.
    return tx.handover.update({ where: { id: h.id }, data: { status: "FINALIZED", finalizedAt: now, contentHash: hash } });
  });
}

/** Prüft, ob ein finalisiertes Protokoll noch dem gespeicherten Hash entspricht (Nachweis der Unverändertheit). */
export async function verifyHandover(tenantId: string, handoverId: string) {
  return db.$transaction(async (tx) => {
    const { handover, hash } = await handoverContent(tx, tenantId, handoverId);
    return { finalized: handover.status === "FINALIZED", storedHash: handover.contentHash, currentHash: hash, intact: handover.status === "FINALIZED" && handover.contentHash === hash };
  });
}
