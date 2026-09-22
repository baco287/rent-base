// Kompletter Mietprozess für Tests, die auf einer abgeschlossenen Rückgabe aufsetzen (z. B. Rechnungen).
// Vertrag → Übergabe → Rückgabe mit bestätigten und unbestätigten Zusatzkosten. Fotos sind Platzhalter im lokalen Speicher.
import { db } from "../src/lib/db";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { addNewDamage, answerChecklist, finalizeHandover, getHandoverContentHash, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { sha256 } from "../src/lib/integrity";
import { addManualCharge, confirmProposal } from "../src/lib/returns";
import { buildStorageKey } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, type World } from "./helpers";

async function photo(w: World, handoverId: string, category: string, handoverDamageId?: string) {
  const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  return registerPhoto(w.tenantId, w.actor, { handoverId, handoverDamageId, storageKey, category, contentType: "image/jpeg", sizeBytes: 250_000, checksum: sha256(storageKey) });
}

async function sign(w: World, handoverId: string) {
  return saveHandoverSignature(w.tenantId, w.actor, handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, handoverId), ipAddress: null, userAgent: "test" });
}

async function answerAll(w: World, handoverId: string) {
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId } });
  await answerChecklist(w.tenantId, handoverId, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? (i.itemKey === "keys" || i.itemKey === "keys_returned" ? "2" : "") : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
}

export type ReturnedWorld = World & { contractId: string; pickupId: string; returnId: string; charges: { mileageId: string; cleaningId: string; damageId: string | null } };

/**
 * Buchung bis zur abgeschlossenen Rückgabe. Vertrag: 6 Tage, 0,25 €/km ab 200 km/Tag, Voll/Voll mit Literpreis 1,80.
 * Rückgabe: 2.000 km gefahren (800 km über Inklusivkilometern → Vorschlag bestätigt), Tank 4/8 statt 7/8
 * (Kraftstoffvorschlag bewusst NICHT bestätigt), Innenreinigung 30 € manuell, neuer Schaden (optional mit DAMAGE-Position).
 */
export async function returnedWorld(label: string, opts: { damageCharge?: boolean; tenant?: Record<string, unknown>; customer?: Record<string, unknown>; within?: World } = {}): Promise<ReturnedWorld> {
  let w: World;
  if (opts.within) {
    // zweite Miete im bestehenden Mandanten: eigenes Fahrzeug, gleicher Kunde
    const run = `${label}-${Date.now().toString(36)}`;
    const vehicle = await db.vehicle.create({ data: { tenantId: opts.within.tenantId, plate: `HB-RB ${run.slice(-4)}`, make: "VW", model: "Crafter", groupId: opts.within.groupId, fuel: "DIESEL", mileage: 45_000, dailyRate: 89, workWeekRate: 420, weeklyRate: 540, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 500, tankCapacityLiters: 75 } });
    const start = new Date(Date.now() + 86400_000);
    const booking = await db.booking.create({ data: { tenantId: opts.within.tenantId, number: `T-${run}`, vehicleId: vehicle.id, customerId: opts.within.customerId, startAt: start, endAt: new Date(start.getTime() + 6 * 86400_000), dailyRate: 89, workWeekRate: 420, weeklyRate: 540, deposit: 500 } });
    w = { ...opts.within, vehicleId: vehicle.id, bookingId: booking.id };
  } else {
    w = await createWorld(label, { customer: opts.customer });
    await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH", ...(opts.tenant ?? {}) } });
    await db.vehicle.update({ where: { id: w.vehicleId }, data: { mileage: 45_000 } });
  }
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);

  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 45_210, fuelLevelEighths: 7 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, p.id, cat);
  await answerAll(w, p.id);
  await sign(w, p.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);

  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 47_210, fuelLevelEighths: 4 });
  const dmg = await addNewDamage(w.tenantId, r.id, { view: "REAR", posX: 0.8, posY: 0.6, kind: "DENT", severity: "MODERATE", description: "Delle Heckklappe, bei Rückgabe" });
  await photo(w, r.id, "DAMAGE", dmg.id);
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(w, r.id, cat);
  await answerAll(w, r.id);
  await confirmProposal(w.tenantId, r.id, w.actor.id, "EXTRA_MILEAGE");
  const cleaning = await addManualCharge(w.tenantId, r.id, w.actor.id, { type: "CLEANING", description: "Innenreinigung", quantity: 1, unit: "pauschal", unitPrice: 30 });
  const damage = opts.damageCharge ? await addManualCharge(w.tenantId, r.id, w.actor.id, { type: "DAMAGE", description: "Kostenvoranschlag Heckklappe", quantity: 1, unit: "pauschal", unitPrice: 240, handoverDamageId: dmg.id }) : null;
  await sign(w, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
  const mileage = await db.extraCharge.findFirstOrThrow({ where: { tenantId: w.tenantId, handoverId: r.id, type: "EXTRA_MILEAGE" } });
  return { ...w, contractId: c.id, pickupId: p.id, returnId: r.id, charges: { mileageId: mileage.id, cleaningId: cleaning.id, damageId: damage?.id ?? null } };
}
