// Sperrreihenfolge Fall → Buchung → Übergabe. Gleichzeitige Vorgänge an derselben Buchung laufen nacheinander und enden nie in
// einem Deadlock (PostgreSQL 40P01). Aussagekräftig nur gegen echtes PostgreSQL mit mehreren Verbindungen (CI: Pool 5 wie Produktion);
// über eine einzelne Verbindung laufen die Vorgänge ohnehin nacheinander. Jeder Wettlauf wird mit frischen Daten wiederholt.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { changeBookingStatus } from "../src/lib/booking-status";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveContractSignature } from "../src/lib/contracts";
import { answerChecklist, discardEmptyReturnDraft, finalizeHandover, getHandoverContentHash, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { addManualCharge, confirmProposal } from "../src/lib/returns";
import { ensurePickupDocument, ensureReturnDocument } from "../src/lib/documents";
import { DomainError, isImmutableError, sha256 } from "../src/lib/integrity";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { buildStorageKey, getStorage, type StorageDriver } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";

const ROUNDS = 6;
const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-lock-order-"));
  storage = getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const reasonOf = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? String((r.reason as { message?: string })?.message ?? r.reason) : "");
const isDeadlock = (r: PromiseSettledResult<unknown>) => /deadlock detected|40P01/.test(reasonOf(r));
const noDeadlock = (rs: PromiseSettledResult<unknown>[], what: string) => rs.forEach((r, i) => assert.ok(!isDeadlock(r), `${what}, Vorgang ${i + 1}: ${reasonOf(r).slice(0, 300)}`));
const domainRejected = (r: PromiseSettledResult<unknown>) => r.status === "rejected" && (r.reason instanceof DomainError || isImmutableError(r.reason));

async function world(label: string) { await ready; const w = await createWorld(label); tenants.push(w.tenantId); return w; }
async function fillHandover(w: World, handoverId: string, mileage: number) {
  await updateHandoverDraft(w.tenantId, handoverId, { mileage, fuelLevelEighths: 8 });
  for (const category of REQUIRED_PHOTO_CATEGORIES) {
    const storageKey = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
    await registerPhoto(w.tenantId, w.actor, { handoverId, storageKey, category, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(storageKey) });
  }
  const items = await db.handoverChecklistItem.findMany({ where: { handoverId } });
  await answerChecklist(w.tenantId, handoverId, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? (i.itemKey === "remarks" ? "" : "2") : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  await saveHandoverSignature(w.tenantId, w.actor, handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, handoverId) });
}
/** Unterschriebener Vertrag und abschlussbereiter Übergabe-Entwurf (Fahrer geprüft). */
async function pickupReady(label: string) {
  const w = await world(label);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await fillHandover(w, p.id, 50_010);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  return { w, pickupId: p.id };
}
/** Laufende Miete mit Rückgabe-Entwurf: Kilometerstand erfasst (Vorschlag Mehrkilometer offen). */
async function returnDraft(label: string) {
  const { w, pickupId } = await pickupReady(label);
  await finalizeHandover(w.tenantId, pickupId, w.actor);
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 52_000, fuelLevelEighths: 8 });
  return { w, pickupId, returnId: r.id };
}
/** Speicher, dessen Ablage wartet, bis der Test sie freigibt: hält die Archiv-Transaktion gezielt offen (Protokollsperre gehalten). */
function gatedStorage(inner: StorageDriver) {
  let reached!: () => void, release!: () => void;
  const putReached = new Promise<void>((r) => (reached = r));
  const gate = new Promise<void>((r) => (release = r));
  const driver: StorageDriver = { name: inner.name, get: (k) => inner.get(k), remove: (k) => inner.remove(k), put: async (k, b, t) => { reached(); await gate; return inner.put(k, b, t); } };
  return { driver, putReached, release };
}

test("Sperrreihenfolge: Übergabe abschließen ∥ Storno – nie Deadlock, genau ein Ergebnis", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const { w, pickupId } = await pickupReady(`lock-pickup-cancel-${i}`);
    const r = await Promise.allSettled([finalizeHandover(w.tenantId, pickupId, w.actor), changeBookingStatus(w.tenantId, w.bookingId, "CANCELLED", { actor: w.actor, reason: "Test-Storno" })]);
    noDeadlock(r, `Runde ${i}`);
    const booking = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
    const handover = await db.handover.findFirst({ where: { id: pickupId } });
    if (booking.status === "ACTIVE") { assert.equal(r[0].status, "fulfilled"); assert.equal(r[1].status, "rejected"); assert.equal(handover?.status, "FINALIZED"); }
    else { assert.equal(booking.status, "CANCELLED", `Runde ${i}: Abschluss ${reasonOf(r[0]).slice(0, 200)} | Storno ${reasonOf(r[1]).slice(0, 200)}`); assert.equal(r[0].status, "rejected"); assert.equal(handover, null); }
  }
});

test("Sperrreihenfolge: Rückgabe abschließen ∥ Rückgabe-Entwurf verwerfen – nie Deadlock, der Abschluss gewinnt", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const { w, returnId } = await returnDraft(`lock-return-discard-${i}`);
    await confirmProposal(w.tenantId, returnId, w.actor.id, "EXTRA_MILEAGE");
    await fillHandover(w, returnId, 52_000);
    const r = await Promise.allSettled([finalizeHandover(w.tenantId, returnId, w.actor), discardEmptyReturnDraft(w.tenantId, w.bookingId, returnId, w.actor)]);
    noDeadlock(r, `Runde ${i}`);
    assert.equal(r[0].status, "fulfilled", reasonOf(r[0]));
    assert.ok(domainRejected(r[1]), `Verwerfen fachlich abgelehnt: ${reasonOf(r[1]).slice(0, 200)}`);
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "RETURNED");
  }
});

test("Sperrreihenfolge: Vorschlag bestätigen ∥ Rückgabe-Entwurf verwerfen – nie Deadlock, genau eine Position", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const { w, returnId } = await returnDraft(`lock-confirm-discard-${i}`);
    const r = await Promise.allSettled([confirmProposal(w.tenantId, returnId, w.actor.id, "EXTRA_MILEAGE"), discardEmptyReturnDraft(w.tenantId, w.bookingId, returnId, w.actor)]);
    noDeadlock(r, `Runde ${i}`);
    assert.equal(r[0].status, "fulfilled", reasonOf(r[0]));
    assert.ok(domainRejected(r[1]), `Verwerfen fachlich abgelehnt: ${reasonOf(r[1]).slice(0, 200)}`);
    assert.equal(await db.extraCharge.count({ where: { handoverId: returnId } }), 1);
  }
});

test("Sperrreihenfolge: freie Position erfassen ∥ Rückgabe-Entwurf verwerfen – nie Deadlock, genau eine Position", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const { w, returnId } = await returnDraft(`lock-manual-discard-${i}`);
    const r = await Promise.allSettled([
      addManualCharge(w.tenantId, returnId, w.actor.id, { type: "CLEANING", description: "Innenreinigung", quantity: 1, unit: "pauschal", unitPrice: 40 }),
      discardEmptyReturnDraft(w.tenantId, w.bookingId, returnId, w.actor),
    ]);
    noDeadlock(r, `Runde ${i}`);
    assert.equal(r[0].status, "fulfilled", reasonOf(r[0]));
    assert.ok(domainRejected(r[1]), `Verwerfen fachlich abgelehnt: ${reasonOf(r[1]).slice(0, 200)}`);
    assert.equal(await db.extraCharge.count({ where: { handoverId: returnId } }), 1);
  }
});

test("Sperrreihenfolge: Rückgabe-PDF archivieren ∥ Verwerfen aus veralteter Ansicht – kein Deadlock, PDF entsteht, nichts verworfen", async () => {
  const { w, returnId } = await returnDraft("lock-archive-discard");
  await confirmProposal(w.tenantId, returnId, w.actor.id, "EXTRA_MILEAGE");
  await fillHandover(w, returnId, 52_000);
  await finalizeHandover(w.tenantId, returnId, w.actor);
  // Das Archiv hält die Protokollsperre, während die Datei abgelegt wird; genau dann verwirft jemand aus einer veralteten Ansicht
  const gated = gatedStorage(storage);
  const archiving = ensureReturnDocument(w.tenantId, returnId, w.actor.id, { storage: gated.driver });
  await gated.putReached;
  const discarding = discardEmptyReturnDraft(w.tenantId, w.bookingId, returnId, w.actor);
  await new Promise((r) => setTimeout(r, 300));
  gated.release();
  const r = await Promise.allSettled([archiving, discarding]);
  noDeadlock(r, "Archiv ∥ Verwerfen");
  assert.equal(r[0].status, "fulfilled", reasonOf(r[0]));
  assert.ok(domainRejected(r[1]), `Verwerfen fachlich abgelehnt: ${reasonOf(r[1]).slice(0, 200)}`);
  assert.equal(await db.document.count({ where: { handoverId: returnId } }), 1);
  assert.equal((await db.handover.findUniqueOrThrow({ where: { id: returnId } })).status, "FINALIZED");
});

test("Sperrreihenfolge: erneuter Abschluss während der PDF-Archivierung – kein Deadlock, Abschluss fachlich abgelehnt", async () => {
  const { w, pickupId } = await pickupReady("lock-archive-refinalize");
  await finalizeHandover(w.tenantId, pickupId, w.actor);
  const gated = gatedStorage(storage);
  const archiving = ensurePickupDocument(w.tenantId, pickupId, w.actor.id, { storage: gated.driver });
  await gated.putReached;
  const refinalizing = finalizeHandover(w.tenantId, pickupId, w.actor);
  await new Promise((r) => setTimeout(r, 300));
  gated.release();
  const r = await Promise.allSettled([archiving, refinalizing]);
  noDeadlock(r, "Archiv ∥ erneuter Abschluss");
  assert.equal(r[0].status, "fulfilled", reasonOf(r[0]));
  assert.ok(domainRejected(r[1]), `Abschluss fachlich abgelehnt: ${reasonOf(r[1]).slice(0, 200)}`);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "ACTIVE");
});
