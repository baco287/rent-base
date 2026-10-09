// Tests für die Dateisicherung (scripts/backup-files.mjs) und die Prüfung einer Wiederherstellung (scripts/check-restore.mjs).
// Die Buckets sind hier Attrappen im Speicher; die Wiederherstellungsprüfung läuft gegen die echte Testdatenbank.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { buildStorageKey } from "../src/lib/storage";
import { sha256 } from "../src/lib/integrity";
import { FILES_PREFIX, MISSING_STATE_KEY, copyMissing, loadReferences, makeIsPrunable, pruneDeleted, sha256Hex, storageArea } from "../scripts/backup-lib.mjs";
import { checkRestore } from "../scripts/check-restore.mjs";
import { createWorld, purgeTenants } from "./helpers";

type StoredObject = { body: Uint8Array; contentType: string; metadata?: Record<string, string> };

function memoryBucket(initial: Record<string, string | Uint8Array> = {}) {
  const objects = new Map<string, StoredObject>();
  for (const [key, v] of Object.entries(initial)) objects.set(key, { body: typeof v === "string" ? new TextEncoder().encode(v) : v, contentType: "application/octet-stream" });
  return {
    objects,
    label: "Speicher",
    async list(prefix = "") {
      const out = new Map<string, number>();
      for (const [key, o] of objects) if (key.startsWith(prefix)) out.set(key.slice(prefix.length), o.body.length);
      return out;
    },
    async get(key: string) {
      return objects.get(key) ?? null;
    },
    async put(key: string, body: Uint8Array, contentType: string, metadata: Record<string, string> = {}) {
      objects.set(key, { body, contentType, metadata });
    },
    async remove(key: string) {
      objects.delete(key);
    },
  };
}

const text = (o: StoredObject | undefined) => (o ? new TextDecoder().decode(o.body) : undefined);

// Schlüssel wie aus buildStorageKey: t/<mandant>/<bereich>/<jahr>/<monat>/[<buchung>/]<zufall>.<endung>
const k = (area: string, name: string) => `t/mandant/${area}/2026/10/buchung/${name}`;
const NONE = { photoKeys: new Set<string>(), activeDriverCopyKeys: new Set<string>() };

test("Sicherung kopiert nur neue Dateien, mit Prüfsumme, und lässt Fremdes im Backup-Bucket stehen", async () => {
  const app = memoryBucket({ [k("photos", "1.jpg")]: "eins", [k("photos", "2.jpg")]: "zwei" });
  const backup = memoryBucket({ [FILES_PREFIX + k("photos", "1.jpg")]: "eins", "coolify/db-dump": "x" });

  const first = await copyMissing({ from: app, to: backup, toPrefix: FILES_PREFIX });
  assert.deepEqual({ copied: first.copied, alreadyPresent: first.alreadyPresent, failed: first.failed.length, mismatched: first.mismatched.length }, { copied: 1, alreadyPresent: 1, failed: 0, mismatched: 0 });
  assert.equal(text(backup.objects.get(FILES_PREFIX + k("photos", "2.jpg"))), "zwei");
  assert.equal(backup.objects.get(FILES_PREFIX + k("photos", "2.jpg"))?.metadata?.sha256, sha256Hex(new TextEncoder().encode("zwei")));
  assert.equal(text(backup.objects.get("coolify/db-dump")), "x");

  const second = await copyMissing({ from: app, to: backup, toPrefix: FILES_PREFIX });
  assert.equal(second.copied, 0, "zweiter Lauf kopiert nichts mehr");
});

test("Angriff 1 (Regression): manipulierte Datei mit anderer Größe überschreibt das Backup nicht, sondern wird gemeldet", async () => {
  const vertrag = k("documents", "vertrag.pdf");
  const app = memoryBucket({ [vertrag]: "MANIPULIERT-LAENGER" });
  const backup = memoryBucket({ [FILES_PREFIX + vertrag]: "ORIGINAL" });
  const result = await copyMissing({ from: app, to: backup, toPrefix: FILES_PREFIX });
  assert.equal(text(backup.objects.get(FILES_PREFIX + vertrag)), "ORIGINAL", "die gesicherte Fassung bleibt");
  assert.equal(result.copied, 0);
  assert.deepEqual(result.mismatched, [{ key: vertrag, sourceSize: 19, targetSize: 8 }]);
});

test("Wiederherstellung überschreibt im App-Bucket nie etwas und meldet Abweichungen", async () => {
  const backup = memoryBucket({ "files/k1": "richtig", "files/k2": "neu" });
  backup.objects.get("files/k2")!.contentType = "image/jpeg";
  const target = memoryBucket({ k1: "anders!!" });
  const restored = await copyMissing({ from: backup, fromPrefix: FILES_PREFIX, to: target });
  assert.equal(restored.copied, 1);
  assert.equal(text(target.objects.get("k1")), "anders!!", "vorhandene Datei bleibt unangetastet");
  assert.deepEqual(restored.mismatched.map((m: { key: string }) => m.key), ["k1"]);
  assert.equal(text(target.objects.get("k2")), "neu");
  assert.equal(target.objects.get("k2")?.contentType, "image/jpeg");
});

test("eine nicht lesbare Datei wird als Fehler gemeldet, der Rest wird trotzdem gesichert", async () => {
  const app = memoryBucket({ gut: "a", weg: "b" });
  const flaky = { ...app, get: async (key: string) => (key === "weg" ? null : app.get(key)) };
  const backup = memoryBucket();
  const result = await copyMissing({ from: flaky, to: backup, toPrefix: FILES_PREFIX });
  assert.equal(result.copied, 1);
  assert.deepEqual(result.failed.map((f: { key: string }) => f.key), ["weg"]);
});

test("Löschregel: nur nicht mehr referenzierte Fotos und gelöschte Führerscheinkopien, nie Verträge, Protokolle, Unterschriften oder Logos", () => {
  const photoRef = k("photos", "protokoll.jpg");
  const copyActive = k("driver-verifications", "aktiv.jpg");
  const isPrunable = makeIsPrunable({ photoKeys: new Set([photoRef]), activeDriverCopyKeys: new Set([copyActive]) });
  assert.equal(storageArea(k("documents", "x.pdf")), "documents");
  assert.equal(storageArea("unbekannt"), null);

  assert.equal(isPrunable(k("photos", "entwurf-geloescht.jpg")), true, "Entwurfsfoto ohne Datenbank-Zeile");
  assert.equal(isPrunable(photoRef), false, "Foto, auf das die Datenbank noch verweist");
  assert.equal(isPrunable(k("driver-verifications", "geloescht.jpg")), true, "Führerscheinkopie gelöscht oder ohne Zeile");
  assert.equal(isPrunable(copyActive), false, "aktive Führerscheinkopie");
  for (const area of ["documents", "signatures", "branding", "sketches"]) assert.equal(isPrunable(k(area, "x")), false, area);
  assert.equal(isPrunable("files-state/missing.json"), false);
  assert.equal(isPrunable("irgendwas"), false);
});

const DAY_MS = 86_400_000;
const stateOf = (bucket: ReturnType<typeof memoryBucket>) => JSON.parse(text(bucket.objects.get(MISSING_STATE_KEY)) ?? "{}");

test("legitim gelöschte Datei verschwindet erst nach der Frist aus dem Backup", async () => {
  const bleibt = k("photos", "bleibt.jpg");
  const geloescht = k("photos", "geloescht.jpg");
  const zurueck = k("photos", "kommt-zurueck.jpg");
  const app = memoryBucket({ [bleibt]: "a" });
  const backup = memoryBucket({ [FILES_PREFIX + bleibt]: "a", [FILES_PREFIX + geloescht]: "b", [FILES_PREFIX + zurueck]: "c", "coolify/db-dump": "x" });
  const isPrunable = makeIsPrunable(NONE);
  const t0 = new Date("2026-10-01T02:15:00Z");

  const first = await pruneDeleted({ source: app, backup, graceDays: 30, now: t0, isPrunable });
  assert.deepEqual({ missing: first.missing, newlyMissing: first.newlyMissing, deleted: first.deleted }, { missing: 2, newlyMissing: 2, deleted: 0 });
  assert.ok(backup.objects.has(FILES_PREFIX + geloescht), "innerhalb der Frist bleibt die Datei im Backup");
  assert.equal(stateOf(backup)[geloescht], t0.toISOString());

  // Die Datei taucht in der App wieder auf (z. B. nach --restore): Vormerkung entfällt
  app.objects.set(zurueck, { body: new TextEncoder().encode("c"), contentType: "x" });
  const later = await pruneDeleted({ source: app, backup, graceDays: 30, now: new Date(t0.getTime() + 29 * DAY_MS), isPrunable });
  assert.equal(later.deleted, 0);
  assert.deepEqual(Object.keys(stateOf(backup)), [geloescht]);

  const after30 = await pruneDeleted({ source: app, backup, graceDays: 30, now: new Date(t0.getTime() + 30 * DAY_MS), isPrunable });
  assert.equal(after30.deleted, 1);
  assert.ok(!backup.objects.has(FILES_PREFIX + geloescht));
  assert.ok(backup.objects.has(FILES_PREFIX + zurueck) && backup.objects.has(FILES_PREFIX + bleibt));
  assert.ok(backup.objects.has("coolify/db-dump"), "Datenbank-Backups außerhalb von files/ bleiben unberührt");
  assert.deepEqual(stateOf(backup), {});
});

test("ohne Löschregel löscht die Sicherung nie etwas", async () => {
  const backup = memoryBucket({ [FILES_PREFIX + k("photos", "a.jpg")]: "a" });
  const result = await pruneDeleted({ source: memoryBucket(), backup, now: new Date("2027-12-01T00:00:00Z") });
  assert.equal(result.deleted, 0);
  assert.equal(result.protectedMissing.length, 1);
  assert.ok(backup.objects.has(FILES_PREFIX + k("photos", "a.jpg")));
});

test("Schutzschwelle: fehlen auf einmal viele löschbare Dateien, wird nichts vorgemerkt und nichts gelöscht", async () => {
  const initial: Record<string, string> = {};
  for (let i = 0; i < 100; i++) initial[FILES_PREFIX + k("photos", `f${i}.jpg`)] = "x";
  const backup = memoryBucket(initial);
  const emptyApp = memoryBucket(); // z. B. falscher Bucket oder leere Antwort
  await assert.rejects(() => pruneDeleted({ source: emptyApp, backup, now: new Date("2026-12-01T00:00:00Z"), isPrunable: makeIsPrunable(NONE) }), /Zur Sicherheit wurde nichts vorgemerkt und nichts gelöscht/);
  assert.equal([...backup.objects.keys()].filter((key) => key.startsWith(FILES_PREFIX)).length, 100);
  assert.ok(!backup.objects.has(MISSING_STATE_KEY));
});

test("Angriff 2 (Regression): schleichendes Löschen im App-Bucket leert das Backup nicht", async () => {
  // 150 Verträge/Protokolle und 50 Protokollfotos, auf die die Datenbank verweist; dazu ein legitim gelöschtes Entwurfsfoto.
  const keys = [...Array.from({ length: 150 }, (_, i) => k("documents", `d${i}.pdf`)), ...Array.from({ length: 50 }, (_, i) => k("photos", `p${i}.jpg`))];
  const references = { photoKeys: new Set(keys.filter((key) => storageArea(key) === "photos")), activeDriverCopyKeys: new Set<string>() };
  const entwurf = k("photos", "entwurf.jpg");
  const app = memoryBucket(Object.fromEntries(keys.map((key) => [key, "x"])));
  const backup = memoryBucket(Object.fromEntries([...keys, entwurf].map((key) => [FILES_PREFIX + key, "x"])));
  const isPrunable = makeIsPrunable(references);

  // Angreifer mit App-Zugangsdaten löscht 15 Dateien pro Nacht, unter der Schutzschwelle
  const t0 = Date.parse("2026-11-01T02:15:00Z");
  let last: Awaited<ReturnType<typeof pruneDeleted>> | undefined;
  for (let night = 0; night < 45; night++) {
    for (const key of keys.slice(night * 15, night * 15 + 15)) app.objects.delete(key);
    last = await pruneDeleted({ source: app, backup, now: new Date(t0 + night * DAY_MS), isPrunable });
  }
  assert.equal(app.objects.size, 0, "im App-Bucket ist alles weg");
  for (const key of keys) assert.ok(backup.objects.has(FILES_PREFIX + key), `${key} muss im Backup bleiben`);
  assert.equal(last!.protectedMissing.length, 200, "jede fehlende geschützte Datei wird gemeldet");
  assert.ok(!backup.objects.has(FILES_PREFIX + entwurf), "das legitim gelöschte Entwurfsfoto ist nach der Frist entfernt");
});


// Die Prüfung soll nur die Daten dieses Tests sehen, nicht den übrigen Inhalt der Entwicklungsdatenbank.
const SCOPED_MODELS = new Set([
  "tenant", "user", "customer", "vehicle", "booking", "rentalContract", "contractAmendment", "handover", "damage", "damageCase",
  "photo", "signature", "document", "invoice", "payment", "securityDeposit", "extraCharge", "auditLog",
  "damageCaseDocument", "vehicleDocument", "authorityUpload", "authorityCaseDocument", "accidentReplacementCaseDocument", "driverDocumentCopy",
]);
type Delegate = Record<"count" | "findMany" | "aggregate", (args: { where?: object }) => Promise<unknown>>;

function scopedToTenant(tenantId: string) {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value === "function") return value.bind(target);
      if (typeof prop !== "string" || !SCOPED_MODELS.has(prop)) return value;
      const delegate = value as Delegate;
      const where = prop === "tenant" ? { id: tenantId } : { tenantId };
      const scoped = (fn: keyof Delegate) => (args: { where?: object } = {}) => delegate[fn]({ ...args, where: { ...args.where, ...where } });
      return { count: scoped("count"), findMany: scoped("findMany"), aggregate: scoped("aggregate") };
    },
  });
}

const tenants: string[] = [];
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
});

test("Wiederherstellungsprüfung: vollständig, fehlende Datei, veränderte Datei", async () => {
  const w = await createWorld("restore");
  tenants.push(w.tenantId);
  const bytes = new TextEncoder().encode("foto-1");
  const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
  await db.photo.create({ data: { tenantId: w.tenantId, storageKey: key, category: "FRONT", contentType: "image/jpeg", sizeBytes: bytes.length, checksum: sha256(bytes) } });
  const client = scopedToTenant(w.tenantId);
  const errors = (f: { level: string; text: string }[]) => f.filter((x) => x.level === "FEHLER").map((x) => x.text);

  // Löschregel gegen die echte Datenbank: ein gespeichertes Foto ist referenziert und darf nie aus dem Backup gelöscht werden
  const references = await loadReferences(client);
  assert.ok(references.photoKeys.has(key));
  assert.equal(makeIsPrunable(references)(key), false);

  const complete = await checkRestore({ prod: client, restored: client, backup: memoryBucket({ [FILES_PREFIX + key]: bytes }), sampleSize: 10 });
  assert.deepEqual(errors(complete), []);
  assert.ok(complete.some((f: { text: string }) => f.text.includes("alle 1 referenzierten Dateien")));
  assert.ok(complete.some((f: { text: string }) => f.text.startsWith("Buchungen: 1 im Backup, 1 live")));
  assert.ok(complete.some((f: { text: string }) => f.text.includes("Prüfsummen stimmen")));

  const missing = await checkRestore({ prod: client, restored: client, backup: memoryBucket() });
  assert.match(errors(missing).join("\n"), /1 von 1 Dateien fehlen im Backup/);

  // gleiche Größe, anderer Inhalt: fällt nur über die Prüfsumme auf
  const tampered = await checkRestore({ prod: client, restored: client, backup: memoryBucket({ [FILES_PREFIX + key]: "foto-X" }), sampleSize: 10 });
  assert.match(errors(tampered).join("\n"), /Prüfsumme stimmt nicht bei 1 von 1/);
});
