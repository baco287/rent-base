// Aufräumlauf für Dateien gelöschter Ausweis- und Führerscheinkopien (scripts/driver-copy-cleanup-lib.mjs).
// Szenario „Absturz“: das Storno ist committet (Kopien DELETED), das Entfernen der Dateien danach fand nie statt.
// Der Lauf richtet sich nur nach der Datenbank, bleibt im Kopienbereich des eigenen Mandanten und rührt aktive Kopien nie an.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { changeBookingStatus } from "../src/lib/booking-status";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveContractSignature } from "../src/lib/contracts";
import { recordDriverDocumentCopy, startOrGetVerification } from "../src/lib/driver-verification";
import { startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { copyPrefix, refusalOf, sweepDeletedCopyFiles } from "../scripts/driver-copy-cleanup-lib.mjs";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup } from "./helpers";
import { photoJpeg } from "./pdf-fixtures";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-copy-cleanup-"));
  process.env.LOCAL_STORAGE_DIR = dir; // derselbe Speicher wie in der Anwendung
  storage = getStorage();
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

type Bucket = { list(prefix: string): Promise<Map<string, number>>; remove(key: string): Promise<void> };
/** Bucket-Sicht auf den lokalen Dateispeicher der App: Auflisten über das Dateisystem, Löschen über den App-Treiber. */
const localBucket: Bucket = {
  async list(prefix) {
    const out = new Map<string, number>();
    const walk = async (rel: string) => {
      const entries = await readdir(path.join(dir, ...rel.split("/").filter(Boolean)), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(child);
        else if (!e.name.endsWith(".type")) out.set(child.slice(prefix.length), 1);
      }
    };
    await walk(prefix.replace(/\/$/, ""));
    return out;
  },
  remove: (key) => storage.remove(key),
};
const exists = async (key: string) => (await storage.get(key)) !== null;

/** Übergabe-Entwurf mit Ausweis- und Führerscheinkopie des Hauptfahrers, Prüfung bestätigt. */
async function withCopies(label: string) {
  await ready;
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  const p = await startHandover(w.tenantId, w.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 50_010, fuelLevelEighths: 8 });
  const primary = await db.contractDriver.findFirstOrThrow({ where: { tenantId: w.tenantId, contractId: c.id, role: "PRIMARY_DRIVER" } });
  const v = await startOrGetVerification(w.tenantId, w.actor, p.id, primary.id);
  const copies = [
    await recordDriverDocumentCopy(w.tenantId, w.actor, { bookingId: w.bookingId, handoverId: p.id, verificationId: v.id, contractDriverId: primary.id, documentKind: "IDENTITY", side: "FRONT", bytes: await photoJpeg("Ausweis", 400, 300), consent: { given: true } }),
    await recordDriverDocumentCopy(w.tenantId, w.actor, { bookingId: w.bookingId, handoverId: p.id, verificationId: v.id, contractDriverId: primary.id, documentKind: "LICENSE", side: "FRONT", bytes: await photoJpeg("Fuehrerschein", 400, 300) }),
  ];
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  return { w, handoverId: p.id, copies };
}
/** Storno committet, danach „Absturz“: removeCancellationFiles läuft nie. */
const cancelAndCrash = async (x: Awaited<ReturnType<typeof withCopies>>) => { await changeBookingStatus(x.w.tenantId, x.w.bookingId, "CANCELLED", { actor: x.w.actor, reason: "Absturz-Simulation" }); };
const audits = (tenantId: string) => db.auditLog.findMany({ where: { tenantId, action: "STORAGE_FILE_REMOVAL_FAILED" } });

test("Regeln: nur der Kopienbereich des eigenen Mandanten, nie aktive Kopien, keine ungültigen Schlüssel", () => {
  assert.equal(copyPrefix("abc"), "t/abc/driver-verifications/");
  assert.equal(copyPrefix("a/../b"), "t/ab/driver-verifications/", "Mandanten-Id wird wie beim Anlegen bereinigt");
  const none = new Set<string>();
  assert.equal(refusalOf("t/abc/driver-verifications/2026/10/b/x.jpg", "abc", none), null);
  assert.match(refusalOf("t/xyz/driver-verifications/2026/10/b/x.jpg", "abc", none)!, /nicht im Kopienbereich/);
  assert.match(refusalOf("t/abc/photos/2026/10/b/x.jpg", "abc", none)!, /nicht im Kopienbereich/);
  assert.match(refusalOf("t/abc/driver-verifications/../photos/x.jpg", "abc", none)!, /ungültig/);
  assert.match(refusalOf("t/abc/driver-verifications/2026/10/b/x.jpg", "abc", new Set(["t/abc/driver-verifications/2026/10/b/x.jpg"]))!, /aktiven Kopie/);
  assert.match(refusalOf("", "abc", none)!, /kein Speicherschlüssel/);
});

test("Absturz zwischen Storno-Commit und Dateilöschung: der Aufräumlauf entfernt genau diese Dateien, mandantengetrennt und wiederholbar", async () => {
  const a = await withCopies("cleanup-a");
  const b = await withCopies("cleanup-b-active");
  const c = await withCopies("cleanup-c");
  await cancelAndCrash(a);
  await cancelAndCrash(c);
  const keysA = a.copies.map((x) => x.storageKey), keysB = b.copies.map((x) => x.storageKey), keysC = c.copies.map((x) => x.storageKey);
  assert.ok((await db.driverDocumentCopy.findMany({ where: { storageKey: { in: [...keysA, ...keysC] } } })).every((x) => x.deletionStatus === "DELETED"));
  for (const k of [...keysA, ...keysB, ...keysC]) assert.ok(await exists(k), "nach dem Absturz liegen alle Dateien noch");

  // Nur Bericht: nichts wird gelöscht
  const dry = await sweepDeletedCopyFiles({ db, bucket: localBucket, tenantId: a.w.tenantId, dryRun: true });
  assert.deepEqual([dry.checked, dry.wouldRemove, dry.removed, dry.failed.length], [2, 2, 0, 0]);
  assert.ok(await exists(keysA[0]));

  // Nur Mandant A: A geräumt, C (anderer Mandant, ebenfalls gelöscht) und B (aktiv) unberührt
  const onlyA = await sweepDeletedCopyFiles({ db, bucket: localBucket, tenantId: a.w.tenantId });
  assert.deepEqual([onlyA.tenants, onlyA.removed, onlyA.failed.length, onlyA.refused.length], [1, 2, 0, 0]);
  for (const k of keysA) assert.equal(await exists(k), false, "Datei der gelöschten Kopie entfernt");
  for (const k of [...keysB, ...keysC]) assert.equal(await exists(k), true, "andere Mandanten unberührt");

  // Alle Mandanten: C wird nachgeholt, B (aktive Kopien) bleibt, A ist bereits sauber
  const all = await sweepDeletedCopyFiles({ db, bucket: localBucket, tenantId: null });
  const ours = (x: { tenantId: string }) => [a.w.tenantId, b.w.tenantId, c.w.tenantId].includes(x.tenantId);
  assert.equal(all.failed.filter(ours).length + all.refused.filter(ours).length, 0);
  for (const k of keysC) assert.equal(await exists(k), false);
  for (const k of keysB) assert.equal(await exists(k), true, "aktive Kopien bleiben immer");
  // Wiederholung ist unschädlich: nichts mehr zu tun
  const again = await sweepDeletedCopyFiles({ db, bucket: localBucket, tenantId: a.w.tenantId });
  assert.deepEqual([again.removed, again.alreadyGone, again.failed.length], [0, 2, 0]);
  assert.equal((await audits(a.w.tenantId)).length, 0, "kein Fehler protokolliert");
});

test("Verweigert statt gelöscht: Schlüssel außerhalb des Kopienbereichs des Mandanten (manipulierte Zeile)", async () => {
  const a = await withCopies("cleanup-refuse-a");
  const b = await withCopies("cleanup-refuse-b");
  await cancelAndCrash(a);
  // Testmanipulation an der Datenbankregel vorbei: die gelöschte Kopie von A zeigt plötzlich auf eine Datei im Bereich von B
  const foreignKey = `t/${b.w.tenantId}/driver-verifications/2026/10/${b.w.bookingId}/fremd.jpg`;
  await storage.put(foreignKey, await photoJpeg("Fremd", 200, 150), "image/jpeg");
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_purge = 'on'`);
    await tx.driverDocumentCopy.update({ where: { id: a.copies[0].id }, data: { storageKey: foreignKey } });
  });
  const r = await sweepDeletedCopyFiles({ db, bucket: localBucket, tenantId: a.w.tenantId });
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].reason, /nicht im Kopienbereich dieses Mandanten/);
  assert.equal(await exists(foreignKey), true, "fremde Datei bleibt");
  assert.equal(r.removed, 1, "die ordnungsgemäße zweite Kopie wird entfernt");
  for (const x of b.copies) assert.equal(await exists(x.storageKey), true);
});

test("Fehlerfälle: Speicher nicht erreichbar, Auflisten scheitert, Datei bleibt trotz Löschen – protokolliert, nichts falsch gelöscht, erneuter Lauf holt nach", async () => {
  const a = await withCopies("cleanup-fail");
  await cancelAndCrash(a);
  const keys = a.copies.map((x) => x.storageKey);
  const down: Bucket = { list: localBucket.list, remove: async () => { throw new Error("Speicher nicht erreichbar"); } };
  const r1 = await sweepDeletedCopyFiles({ db, bucket: down, tenantId: a.w.tenantId });
  assert.deepEqual([r1.removed, r1.failed.length], [0, 2]);
  assert.ok(r1.failed.every((f) => f.error.includes("Speicher nicht erreichbar")));
  const logged = await audits(a.w.tenantId);
  assert.equal(logged.length, 2, "jeder Fehlschlag im Audit-Log");
  assert.deepEqual(logged.map((l) => (l.details as { copyId: string }).copyId).sort(), a.copies.map((x) => x.id).sort());
  assert.ok(logged.every((l) => l.userName === "Aufräumlauf" && (l.details as { source: string }).source === "cleanup-driver-copies"));
  for (const k of keys) assert.equal(await exists(k), true);

  const noList: Bucket = { list: async () => { throw new Error("Auflisten verweigert"); }, remove: localBucket.remove };
  const r2 = await sweepDeletedCopyFiles({ db, bucket: noList, tenantId: a.w.tenantId });
  assert.deepEqual([r2.removed, r2.failed.length], [0, 2]);
  assert.ok(r2.failed.every((f) => f.error.startsWith("Auflisten fehlgeschlagen")));
  for (const k of keys) assert.equal(await exists(k), true, "ohne Auflistung wird nichts gelöscht");

  const stuck: Bucket = { list: localBucket.list, remove: async () => {} };
  const r3 = await sweepDeletedCopyFiles({ db, bucket: stuck, tenantId: a.w.tenantId });
  assert.deepEqual([r3.removed, r3.failed.length], [0, 2]);
  assert.ok(r3.failed.every((f) => f.error === "Datei nach dem Löschen weiterhin vorhanden"), "Löschen wird durch erneutes Auflisten bestätigt");

  const r4 = await sweepDeletedCopyFiles({ db, bucket: localBucket, tenantId: a.w.tenantId });
  assert.deepEqual([r4.removed, r4.failed.length], [2, 0], "erneuter Lauf holt nach");
  for (const k of keys) assert.equal(await exists(k), false);
});
