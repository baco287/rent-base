// Einrichtung und Prüflauf des produktiven Backup-Buckets (scripts/backup-prod-lib.mjs) gegen einen nachgebildeten S3-Bucket.
// Braucht weder Netz noch Datenbank.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  DUMP_EXPIRATION_DAYS, LOCK_DAYS, evaluateDumps, evaluateVersions, expectedLifecycleRules, expectedLockConfiguration, foreignGrants,
  lockState, readTarget, retentionProblem, runCheck, runSetup, sameRules, validateDumpPrefix,
} from "../scripts/backup-prod-lib.mjs";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-11-20T12:00:00Z");
const PREFIX = "data/coolify/backups/databases/root-team-0/rent-base-db-abc123/";
const BUCKET = "rent-base-backup";
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

type Entry = { Key: string; LastModified: Date; IsLatest: boolean; marker?: boolean; Size?: number; VersionId?: string; ETag?: string; retainDays?: number };
type Rule = {
  ID?: string; Status?: string; Filter?: { Prefix?: string; And?: { Prefix?: string } };
  Expiration?: { Days?: number; ExpiredObjectDeleteMarker?: boolean }; NoncurrentVersionExpiration?: { NoncurrentDays?: number };
  AbortIncompleteMultipartUpload?: { DaysAfterInitiation?: number };
};
type LockConfig = { ObjectLockEnabled?: string; Rule?: { DefaultRetention?: { Mode?: string; Days?: number } } } | null;
type Acl = { Owner?: { ID?: string }; Grants?: { Grantee?: { Type?: string; ID?: string; URI?: string }; Permission?: string }[] };
type Input = {
  Key?: string; VersionId?: string; Prefix?: string; ContinuationToken?: string; KeyMarker?: string; ACL?: string;
  ObjectLockConfiguration?: LockConfig; LifecycleConfiguration?: { Rules: Rule[] };
};
type Command = { constructor: { name: string }; input: Input };
type State = ReturnType<typeof healthyState>;

function s3Error(name: string, status = 404) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

const READ_ONLY = new Set([
  "ListBucketsCommand", "GetBucketVersioningCommand", "GetObjectLockConfigurationCommand", "GetBucketLifecycleConfigurationCommand",
  "GetBucketPolicyCommand", "ListObjectsV2Command", "ListObjectVersionsCommand", "ListMultipartUploadsCommand",
  "GetObjectRetentionCommand", "HeadObjectCommand", "GetBucketAclCommand", "GetObjectAclCommand",
]);
const PRIVATE_ACL: Acl = { Owner: { ID: "p1" }, Grants: [{ Grantee: { Type: "CanonicalUser", ID: "p1" }, Permission: "FULL_CONTROL" }] };
const PUBLIC_ACL: Acl = { ...PRIVATE_ACL, Grants: [...(PRIVATE_ACL.Grants ?? []), { Grantee: { Type: "Group", URI: "http://acs.amazonaws.com/groups/global/AllUsers" }, Permission: "READ" }] };
const FOREIGN_ACL: Acl = { ...PRIVATE_ACL, Grants: [...(PRIVATE_ACL.Grants ?? []), { Grantee: { Type: "CanonicalUser", ID: "p999" }, Permission: "READ" }] };

/** Nachgebildeter Bucket. Seitengröße 2, damit die Fortsetzung der Auflistungen mitgeprüft wird. */
function fakeS3(init: Partial<State> = {}) {
  const state = { ...healthyState(), ...init };
  const calls: string[] = [];
  const page = <T,>(items: T[], marker: string | undefined) => {
    const start = marker ? Number(marker) : 0;
    const slice = items.slice(start, start + 2);
    const next = start + 2 < items.length ? String(start + 2) : undefined;
    return { slice, next };
  };
  // Eine fremde Policy, die dem Schlüssel das Lesen und Setzen der Einstellungen verweigert.
  const denied = () => {
    if (state.denyWhilePolicy && state.policy) throw s3Error("AccessDenied", 403);
  };
  const handlers: Record<string, (input: Input) => unknown> = {
    ListBucketsCommand: () => ({ Buckets: state.buckets.map((Name) => ({ Name })) }),
    GetBucketVersioningCommand: () => {
      denied();
      return { Status: state.versioning };
    },
    GetObjectLockConfigurationCommand: () => {
      denied();
      if (!state.lock) throw s3Error("ObjectLockConfigurationNotFoundError");
      return { ObjectLockConfiguration: state.lock };
    },
    PutObjectLockConfigurationCommand: (input) => {
      denied();
      if (state.rejectPut) throw s3Error("AccessDenied", 403);
      state.lock = input.ObjectLockConfiguration ?? null;
      return {};
    },
    GetBucketLifecycleConfigurationCommand: () => {
      denied();
      if (!state.lifecycle) throw s3Error("NoSuchLifecycleConfiguration");
      return { Rules: state.lifecycle };
    },
    PutBucketLifecycleConfigurationCommand: (input) => {
      denied();
      if (state.rejectPut) throw s3Error("MalformedXML", 400);
      // Hetzner darf die Darstellung ändern: andere Reihenfolge, Filter als And, false statt fehlend.
      state.lifecycle = reformat(input.LifecycleConfiguration?.Rules ?? []);
      return {};
    },
    GetBucketPolicyCommand: () => {
      if (!state.policy) throw s3Error("NoSuchBucketPolicy");
      return { Policy: state.policy };
    },
    DeleteBucketPolicyCommand: () => {
      state.policy = null;
      return {};
    },
    GetBucketAclCommand: () => {
      if (state.aclError) throw s3Error("NotImplemented", 501);
      return state.bucketAcl;
    },
    PutBucketAclCommand: (input) => {
      if (input.ACL === "private") state.bucketAcl = PRIVATE_ACL;
      return {};
    },
    GetObjectAclCommand: (input) => (state.foreignAclKeys.includes(input.Key ?? "") ? FOREIGN_ACL : PRIVATE_ACL),
    ListObjectsV2Command: (input) => {
      const items = state.entries.filter((e) => e.IsLatest && !e.marker && e.Key.startsWith(input.Prefix ?? ""));
      const { slice, next } = page(items, input.ContinuationToken);
      return { Contents: slice.map(({ Key, LastModified, Size }) => ({ Key, LastModified, Size })), IsTruncated: !!next, NextContinuationToken: next };
    },
    ListObjectVersionsCommand: (input) => {
      const items = state.entries.filter((e) => e.Key.startsWith(input.Prefix ?? ""));
      const { slice, next } = page(items, input.KeyMarker);
      return {
        Versions: slice.filter((e) => !e.marker).map((e) => ({ Key: e.Key, LastModified: e.LastModified, IsLatest: e.IsLatest, Size: e.Size, VersionId: e.VersionId, ETag: e.ETag })),
        DeleteMarkers: slice.filter((e) => e.marker).map((e) => ({ Key: e.Key, LastModified: e.LastModified, IsLatest: e.IsLatest, VersionId: e.VersionId })),
        IsTruncated: !!next, NextKeyMarker: next, NextVersionIdMarker: next ? "v" : undefined,
      };
    },
    ListMultipartUploadsCommand: () => ({ Uploads: state.uploads, IsTruncated: false }),
    GetObjectRetentionCommand: (input) => {
      const e = state.entries.find((x) => x.Key === input.Key && !x.marker && (input.VersionId ? x.VersionId === input.VersionId : x.IsLatest));
      if (!e || state.unlocked) throw s3Error("NoSuchObjectLockConfiguration");
      return { Retention: { Mode: state.retentionMode, RetainUntilDate: new Date(e.LastModified.getTime() + (e.retainDays ?? state.retentionDays) * DAY) } };
    },
  };
  const client = {
    send: async (cmd: Command) => {
      const name = cmd.constructor.name;
      calls.push(name);
      const h = handlers[name];
      if (!h) throw new Error(`unerwartete Anfrage ${name}`);
      return h(cmd.input);
    },
  };
  return { state, calls, client };
}

/** Hetzner darf die Darstellung ändern: andere Reihenfolge, Filter als And, false statt fehlend. */
function reformat(rules: Rule[]): Rule[] {
  return [...rules].reverse().map((r) => ({
    ...r, Filter: { And: { Prefix: r.Filter?.Prefix } }, Expiration: r.Expiration ? { ExpiredObjectDeleteMarker: false, ...r.Expiration } : undefined,
  }));
}

function hourlyDumps(count: number, size = 4_000_000): Entry[] {
  return Array.from({ length: count }, (_, i) => ({
    Key: `${PREFIX}pg-dump-rent-base-${i}.dmp`, LastModified: at(i * HOUR + 20 * 60_000), IsLatest: true, Size: size, VersionId: `d${i}`, ETag: `"e${i}"`,
  }));
}
const asCurrent = (entries: Entry[]) => entries.map((e) => ({ key: e.Key, lm: e.LastModified.getTime(), size: e.Size ?? 0, versionId: e.VersionId }));

function healthyState() {
  return {
    buckets: [BUCKET] as string[],
    versioning: "Enabled" as string | undefined,
    lock: expectedLockConfiguration() as LockConfig,
    lifecycle: expectedLifecycleRules(PREFIX) as Rule[] | null,
    policy: null as string | null,
    entries: [
      ...hourlyDumps(30),
      { Key: "files-state/missing.json", LastModified: at(30 * 60_000), IsLatest: true, Size: 2, VersionId: "s1" },
      { Key: "files/t/1/contracts/2026/10/a.pdf", LastModified: at(10 * DAY), IsLatest: true, Size: 1000, VersionId: "f1" },
      { Key: "files/t/1/contracts/2026/09/alt.pdf", LastModified: at(60 * DAY), IsLatest: true, Size: 1000, VersionId: "f0" },
    ] as Entry[],
    uploads: [] as { Initiated: Date }[],
    bucketAcl: PRIVATE_ACL,
    foreignAclKeys: [] as string[],
    aclError: false,
    denyWhilePolicy: false,
    retentionMode: "COMPLIANCE",
    retentionDays: LOCK_DAYS,
    unlocked: false,
    rejectPut: false,
  };
}

const collect = () => {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
};
const noPause = async () => {};
const check = async (init: Partial<State>, opts: Partial<Parameters<typeof runCheck>[0]> = {}) => {
  const s3 = fakeS3(init);
  const { lines, out } = collect();
  const counts = await runCheck({ client: s3.client, bucket: BUCKET, dumpPrefix: PREFIX, now: NOW, out, ...opts });
  return { s3, counts, text: lines.join("\n") };
};

test("Lifecycle-Vergleich: Hetzners Darstellung zählt als gleich, jede inhaltliche Änderung nicht", () => {
  const expected = expectedLifecycleRules(PREFIX);
  assert.ok(sameRules(reformat(expected), expected));
  const longer = expected.map((r: Rule) => (r.ID === "datenbank-dumps" ? { ...r, Expiration: { Days: 365 } } : r));
  assert.ok(!sameRules(longer, expected));
  assert.ok(!sameRules([...expected, { ID: "alles-weg", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 1 } }], expected));
  assert.ok(!sameRules(expected.map((r: Rule) => ({ ...r, Status: "Disabled" })), expected));
  assert.ok(!sameRules(expectedLifecycleRules("data/coolify/backups/andere/"), expected));
});

test("Dump-Präfix: nur ein sauberer Ordner außerhalb der Dateisicherung", () => {
  assert.equal(validateDumpPrefix(PREFIX), null);
  for (const bad of ["", "data/coolify", "/data/coolify/", "files/", "files/x/", "files-state/", "data//x/", "data/../x/", "data/*/", "data/x y/"]) {
    assert.notEqual(validateDumpPrefix(bad), null, bad);
  }
});

test("Sperr-Einstellung: nur COMPLIANCE 30 Tage gilt als richtig", () => {
  assert.equal(lockState(expectedLockConfiguration()).state, "richtig");
  assert.equal(lockState(undefined).state, "aus");
  assert.equal(lockState({ ObjectLockEnabled: "Enabled" }).state, "ohne-standard");
  assert.equal(lockState({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 30 } } }).state, "abweichend");
  assert.equal(lockState({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1 } } }).state, "abweichend");
});

test("Sperre einer Fassung: COMPLIANCE und rund 30 Tage ab Hochladen, weder kürzer noch verlängert", () => {
  const lm = NOW.getTime();
  const r = (mode: string, days: number) => ({ Mode: mode, RetainUntilDate: new Date(lm + days * DAY) });
  assert.equal(retentionProblem(r("COMPLIANCE", 30), lm, lm), null);
  assert.equal(retentionProblem(r("COMPLIANCE", 30.9), lm, lm), null);
  assert.match(String(retentionProblem(r("COMPLIANCE", 1), lm, lm)), /nur 1.0 Tage/);
  assert.match(String(retentionProblem(r("COMPLIANCE", 36500), lm, lm)), /verlängert/);
  assert.match(String(retentionProblem(r("GOVERNANCE", 30), lm, lm)), /Modus/);
  assert.match(String(retentionProblem(undefined, lm, lm)), /nicht gesperrt/);
  // Nach planmäßigem Ablauf der Sperre ist eine fehlende Sperre kein Fehler.
  assert.equal(retentionProblem(undefined, lm - 40 * DAY, lm), null);
});

test("Freigaben: nur der Besitzer ist in Ordnung", () => {
  assert.deepEqual(foreignGrants(PRIVATE_ACL), []);
  assert.deepEqual(foreignGrants(PUBLIC_ACL), ["AllUsers:READ"]);
  assert.deepEqual(foreignGrants(FOREIGN_ACL), ["fremdes Konto:READ"]);
});

test("Dumps: Alter, Mindestgröße, Einbruch gegenüber dem Üblichen und Lücken oder Überschuss in 24 h", () => {
  const ok = evaluateDumps(asCurrent(hourlyDumps(30)), { now: NOW });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.last24h, 24);
  assert.match(evaluateDumps(asCurrent(hourlyDumps(30).slice(3)), { now: NOW }).problems.join(), /h alt/);
  const shrunk = hourlyDumps(30);
  shrunk[0] = { ...shrunk[0], Size: 1_000_000 };
  assert.match(evaluateDumps(asCurrent(shrunk), { now: NOW }).problems.join(), /weniger als halb so groß/);
  const tiny = hourlyDumps(30);
  tiny[0] = { ...tiny[0], Size: 10 };
  assert.match(evaluateDumps(asCurrent(tiny), { now: NOW }).problems.join(), /nur 10 Bytes/);
  const gaps = hourlyDumps(30).filter((_, i) => i % 3 === 0);
  assert.match(evaluateDumps(asCurrent(gaps), { now: NOW }).problems.join(), /nur 8 Dumps in den letzten 24 h/);
  const doubled = [...hourlyDumps(30), ...hourlyDumps(30).map((e, i) => ({ ...e, Key: `${e.Key}-x${i}` }))];
  assert.match(evaluateDumps(asCurrent(doubled), { now: NOW }).problems.join(), /48 Dumps in den letzten 24 h/);
  // Am ersten Tag gibt es noch keine 20 Dumps; das ist kein Fehler.
  assert.deepEqual(evaluateDumps(asCurrent(hourlyDumps(5)), { now: NOW }).problems, []);
  assert.match(evaluateDumps([], { now: NOW }).problems.join(), /kein Dump/);
});

test("Fassungen: Fristen je Bereich, vorzeitige Löschmarker, gelöschte und überschriebene Dateien, leere Marker", () => {
  const d = (k: string) => `${PREFIX}${k}`;
  const v = (Key: string, daysAgo: number, IsLatest: boolean, extra = {}) => ({ Key, LastModified: at(daysAgo * DAY), IsLatest, Size: 10, ETag: '"x"', ...extra });
  const m = (Key: string, daysAgo: number) => ({ Key, LastModified: at(daysAgo * DAY), IsLatest: true });
  const areas = evaluateVersions({
    now: NOW, dumpPrefix: PREFIX, bufferDays: 7,
    versions: [
      v(d("frisch.dmp"), 5, true),
      v(d("knapp.dmp"), DUMP_EXPIRATION_DAYS + 6, true), // Ablauf + 6 Tage: noch im Puffer
      v(d("ueberfaellig.dmp"), DUMP_EXPIRATION_DAYS + 9, true),
      v(d("abgelaufen.dmp"), 45, false), // Lifecycle-Marker vor 13 Tagen; endgültig fällig mit Tag 32 → seit 13 Tagen
      // Marker spät (Tag 39) gesetzt: Die Frist zählt ab dem eigenen Hochladen (Tag 32 + 7 Puffer), nicht ab dem Marker.
      v(d("spaet.dmp"), 41, false),
      v(d("geloescht.dmp"), 3, false),
      v(d("ueberschrieben.dmp"), 4, false), v(d("ueberschrieben.dmp"), 0.1, true),
      // files/: Marker vor 20 Tagen, Fassung 25 Tage alt. Ohne Sperre wäre sie seit 13 Tagen fällig; mit Sperre erst ab Tag 30.
      v("files/t/1/photos/2026/10/a.jpg", 25, false),
      v("files/t/1/photos/2026/09/b.jpg", 60, false), // Marker vor 50 Tagen: seit 30 Tagen fällig
      v("files/t/1/contracts/2026/10/vertrag.pdf", 5, false), // Vertrag mit Löschmarker: die Dateisicherung löscht Verträge nie
      v("files/t/1/documents/2026/10/gleich.pdf", 40, false), v("files/t/1/documents/2026/10/gleich.pdf", 2, true),
      v("files/t/1/documents/2026/10/anders.pdf", 10, false, { ETag: '"alt"' }), v("files/t/1/documents/2026/10/anders.pdf", 1, true, { ETag: '"neu"' }),
      v("files-state/missing.json", 45, false), v("files-state/missing.json", 44, false), v("files-state/missing.json", 0.1, true),
      v("anderes/x.txt", 1, true),
    ],
    deleteMarkers: [
      m(d("abgelaufen.dmp"), 13), m(d("spaet.dmp"), 2), m(d("geloescht.dmp"), 1),
      m("files/t/1/photos/2026/10/a.jpg", 20), m("files/t/1/photos/2026/09/b.jpg", 50), m("files/t/1/contracts/2026/10/vertrag.pdf", 1),
      m("files/t/1/photos/2026/08/leer-frisch.jpg", 22), m("files/t/1/photos/2026/07/leer-alt.jpg", 40),
    ],
  });
  assert.deepEqual(areas.dumps.overdue.map((x) => x.key).sort(), [d("abgelaufen.dmp"), d("spaet.dmp"), d("ueberfaellig.dmp")]);
  assert.deepEqual(areas.dumps.premature.map((x) => x.key), [d("geloescht.dmp")]);
  assert.deepEqual(areas.dumps.overwritten.map((x) => x.key), [d("ueberschrieben.dmp")]);
  assert.equal(areas.dumps.current.length, 4); // frisch, knapp, ueberfaellig, ueberschrieben (die übrigen liegen unter Markern)
  assert.deepEqual(areas.dateien.overdue.map((x) => x.key), ["files/t/1/photos/2026/09/b.jpg"]);
  assert.deepEqual(areas.dateien.deleted.map((x) => x.key), ["files/t/1/contracts/2026/10/vertrag.pdf"]);
  assert.equal(areas.dateien.duplicates, 1);
  assert.deepEqual(areas.dateien.overwritten.map((x) => x.key), ["files/t/1/documents/2026/10/anders.pdf"]);
  assert.equal(areas.dateien.staleMarkers, 1);
  assert.equal(areas.merkliste.overdue.length, 1); // Fassung 45 Tage alt, seit 44 Tagen nicht aktuell
  assert.equal(areas.merkliste.overwritten.length, 0);
  assert.equal(areas.sonstige.versions, 1);
});

test("Prüflauf: gesunder Bucket ohne Fehler und Hinweise, und er schickt nur lesende Anfragen", async () => {
  const { s3, counts, text } = await check({}, { full: true });
  assert.equal(counts.fehler, 0, text);
  assert.equal(counts.hinweis, 0, text);
  assert.ok(s3.calls.every((c) => READ_ONLY.has(c)), s3.calls.join());
  // Stündlich: Sperre jeder Fassung der letzten 26 h (26 Dumps, Merkliste); täglich zusätzlich alle 33 aktuellen Fassungen.
  assert.equal(s3.calls.filter((c) => c === "GetObjectRetentionCommand").length, 27 + 33);
  assert.equal(s3.calls.filter((c) => c === "GetObjectAclCommand").length, 33);
  // Vor dem ersten Lauf der Dateisicherung nur ein Hinweis.
  const before = await check({ entries: hourlyDumps(30) });
  assert.equal(before.counts.fehler, 0, before.text);
  assert.match(before.text, /HINWEIS +Dateisicherung: läuft noch nicht/);
});

test("Prüflauf meldet Eingriffe an Einstellungen, Dumps, Dateien, Sperren, ACL und Projekt", async () => {
  const dumps = () => hourlyDumps(30);
  const base = healthyState().entries.slice(30);
  const withShortLock = [...dumps(), ...base]; withShortLock[3] = { ...withShortLock[3], retainDays: 1 };
  const withLongLock = [...dumps(), ...base]; withLongLock[10] = { ...withLongLock[10], retainDays: 36500 };
  const overwritten = [...dumps(), ...base]; overwritten[2] = { ...overwritten[2], IsLatest: false };
  overwritten.push({ ...overwritten[2], LastModified: at(10 * 60_000), IsLatest: true, VersionId: "fake" });
  const hidden = [...dumps(), ...base]; hidden[5] = { ...hidden[5], IsLatest: false };
  hidden.push({ Key: hidden[5].Key, LastModified: at(HOUR), IsLatest: true, marker: true });
  const contractDeleted = [...dumps(), ...base.map((e) => (e.Key.endsWith("a.pdf") ? { ...e, IsLatest: false } : e)), { Key: "files/t/1/contracts/2026/10/a.pdf", LastModified: at(HOUR), IsLatest: true, marker: true }];
  const stateDeleted = [...dumps(), ...base.map((e) => (e.Key === "files-state/missing.json" ? { ...e, IsLatest: false } : e)), { Key: "files-state/missing.json", LastModified: at(HOUR), IsLatest: true, marker: true }];
  const stateStale = [...dumps(), ...base.map((e) => (e.Key === "files-state/missing.json" ? { ...e, LastModified: at(5 * HOUR) } : e))];
  const junk = [...dumps(), ...base, { Key: "fremd/junk.bin", LastModified: at(2 * DAY), IsLatest: true, Size: 5, VersionId: "j1" }];
  const doubled = [...dumps(), ...base, ...dumps().map((e, i) => ({ ...e, Key: `${PREFIX}pg-dump-fake-${i}.dmp`, VersionId: `f${i}` }))];
  const cases: [string, Partial<State>, RegExp][] = [
    ["Sperre 1 Tag", { lock: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1 } } } }, /FEHLER +Standard-Sperre/],
    ["ohne Standard-Sperre", { lock: { ObjectLockEnabled: "Enabled" } }, /FEHLER +Standard-Sperre/],
    ["fremde Regel", { lifecycle: [...expectedLifecycleRules(PREFIX), { ID: "alles-weg", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 1 } }] }, /FEHLER +Lifecycle: weicht ab/],
    ["kein Lifecycle", { lifecycle: null }, /FEHLER +Lifecycle: keine Regeln/],
    ["Policy", { policy: "{}" }, /FEHLER +Bucket-Policy/],
    ["Versionierung", { versioning: "Suspended" }, /FEHLER +Versionierung/],
    ["fremder Bucket", { buckets: [BUCKET, "kosten-bombe"] }, /FEHLER +Buckets im Projekt: 1 unerwartete Buckets.*kosten-bombe/],
    ["öffentliche ACL", { bucketAcl: PUBLIC_ACL }, /FEHLER +Bucket-ACL: Freigabe an andere \(AllUsers:READ\)/],
    ["fremdes Konto in der ACL", { bucketAcl: FOREIGN_ACL }, /FEHLER +Bucket-ACL: Freigabe an andere \(fremdes Konto:READ\)/],
    ["ungesperrt", { unlocked: true }, /FEHLER +Sperre neuer Fassungen: 27 von 27 Fassungen/],
    ["ein Dump nur 1 Tag gesperrt", { entries: withShortLock }, /FEHLER +Sperre neuer Fassungen: 1 von 27 .*pg-dump-rent-base-3.dmp: nur 1.0 Tage/],
    ["ein Dump verlängert", { entries: withLongLock }, /FEHLER +Sperre neuer Fassungen: 1 von 27 .*verlängert/],
    ["überschrieben", { entries: overwritten }, /FEHLER +Dumps überschrieben: 1 Dumps liegen/],
    ["versteckt", { entries: hidden }, /FEHLER +Dumps gelöscht: 1 Dumps vor Ablauf/],
    ["Vertrag gelöscht", { entries: contractDeleted }, /FEHLER +Dateien gelöscht: 1 gesicherte Dateien.*contracts/],
    ["Merkliste gelöscht", { entries: stateDeleted }, /FEHLER +Dateisicherung: files-state\/missing.json wurde gelöscht/],
    ["Dateisicherung steht", { entries: stateStale }, /FEHLER +Dateisicherung: letzter erfolgreicher Lauf vor 5.0 h/],
    ["Fremdobjekt", { entries: junk }, /FEHLER +Objekte außerhalb der Regeln: 1 Schlüssel.*fremd\/junk.bin/],
    ["doppelt so viele", { entries: doubled }, /FEHLER +Dumps: 48 Dumps in den letzten 24 h/],
    ["veraltet", { entries: [...dumps().slice(4), ...base] }, /FEHLER +Dumps: der neueste Dump/],
  ];
  for (const [name, init, pattern] of cases) {
    const { counts, text } = await check(init);
    assert.ok(counts.fehler >= 1, name);
    assert.match(text, pattern, `${name}\n${text}`);
  }
  // Eine nicht lesbare ACL (z. B. von Hetzner nicht unterstützt) ist nur ein Hinweis.
  const unreadable = await check({ aclError: true });
  assert.equal(unreadable.counts.fehler, 0, unreadable.text);
  assert.match(unreadable.text, /HINWEIS +Bucket-ACL: nicht lesbar/);
  // Gelöschte Fotos sind legitim (Entwürfe), gelöschte Verträge nicht.
  const photo = [...dumps(), ...base, { Key: "files/t/1/photos/2026/10/x.jpg", LastModified: at(3 * DAY), IsLatest: false, Size: 5, VersionId: "p1" }, { Key: "files/t/1/photos/2026/10/x.jpg", LastModified: at(HOUR), IsLatest: true, marker: true }];
  assert.equal((await check({ entries: photo })).counts.fehler, 0);
});

test("Prüflauf: geklärte Vorfälle lassen sich quittieren und melden dann nur noch Hinweise", async () => {
  const entries = [...hourlyDumps(30), ...healthyState().entries.slice(30)];
  entries[2] = { ...entries[2], IsLatest: false };
  entries.push({ ...entries[2], LastModified: at(10 * 60_000), IsLatest: true, VersionId: "fake" });
  const open = await check({ entries, buckets: [BUCKET, "kosten-bombe"] });
  assert.equal(open.counts.fehler, 2, open.text);
  const acked = await check({ entries, buckets: [BUCKET, "kosten-bombe"] }, { known: [entries[2].Key, "kosten-bombe"] });
  assert.equal(acked.counts.fehler, 0, acked.text);
  assert.match(acked.text, /HINWEIS +Dumps überschrieben: 1 quittiert/);
  assert.match(acked.text, /HINWEIS +Buckets im Projekt: 1 quittiert/);
  // Ein ausdrücklich erlaubter Bucket (z. B. der Test-Bucket im selben Projekt) ist kein Fehler.
  assert.equal((await check({ buckets: [BUCKET, "rent-base-backup-test"] }, { allowedOtherBuckets: ["rent-base-backup-test"] })).counts.fehler, 0);
  assert.equal((await check({ buckets: [BUCKET, "rent-base-backup-test"] })).counts.fehler, 1);
});

test("Prüflauf voll: Lifecycle-Fristen, Gesamtgröße, Sperre und ACL aller Fassungen, alte Teil-Uploads", async () => {
  const entries: Entry[] = [
    ...hourlyDumps(30),
    { Key: "files-state/missing.json", LastModified: at(30 * 60_000), IsLatest: true, Size: 2, VersionId: "s1" },
    { Key: "files/t/1/contracts/2026/08/alt.pdf", LastModified: at(50 * DAY), IsLatest: true, Size: 200 * 1024 ** 3, VersionId: "f1", retainDays: 3650 },
    { Key: `${PREFIX}pg-dump-rent-base-alt.dmp`, LastModified: at(45 * DAY), IsLatest: true, Size: 4_000_000, VersionId: "old" },
  ];
  const { counts, text } = await check({ entries, uploads: [{ Initiated: at(20 * DAY) }], foreignAclKeys: [`${PREFIX}pg-dump-rent-base-7.dmp`] }, { full: true });
  assert.ok(counts.fehler >= 5, text);
  assert.match(text, /FEHLER +Lifecycle Dumps: 1 von 31 Fassungen sind überfällig/);
  assert.match(text, /FEHLER +Gesamtgröße/);
  assert.match(text, /FEHLER +Sperre aller Fassungen: 1 von 33 .*alt.pdf: 3650 Tage gesperrt \(verlängert\)/);
  assert.match(text, /FEHLER +Objekt-ACL: 1 Fassungen sind für andere freigegeben.*pg-dump-rent-base-7.dmp/);
  assert.match(text, /FEHLER +Teil-Uploads/);
});

test("Prüflauf: falsches Präfix und nicht erreichbarer Bucket führen sofort zu einem Fehler", async () => {
  const { lines, out } = collect();
  const s3 = fakeS3();
  assert.equal((await runCheck({ client: s3.client, bucket: BUCKET, dumpPrefix: "files/", now: NOW, out })).fehler, 1);
  assert.equal(s3.calls.length, 0);
  const broken = { send: async () => { throw s3Error("InvalidAccessKeyId", 403); } };
  const counts = await runCheck({ client: broken, bucket: BUCKET, dumpPrefix: PREFIX, now: NOW, out });
  assert.equal(counts.fehler, 1);
  assert.match(lines.join("\n"), /InvalidAccessKeyId \(HTTP 403\)/);
});

test("Einrichtung --pruefen ändert nichts und schlägt das Dump-Präfix vor", async () => {
  const s3 = fakeS3({ lock: { ObjectLockEnabled: "Enabled" }, lifecycle: null });
  const { lines, out } = collect();
  const code = await runSetup({ client: s3.client, strictClient: s3.client, bucket: BUCKET, mode: "pruefen", out, pause: noPause });
  assert.ok(s3.calls.every((c) => READ_ONLY.has(c)), s3.calls.join());
  assert.match(lines.join("\n"), new RegExp(`Vorschlag Dump-Präfix: ${PREFIX}`));
  assert.match(lines.join("\n"), /Bucket-ACL: 1 Einträge, nur der Besitzer/);
  assert.equal(code, 0);
  const other = fakeS3({ buckets: [BUCKET, "rent-base-files"] });
  assert.equal(await runSetup({ client: other.client, strictClient: other.client, bucket: BUCKET, mode: "pruefen", out, pause: noPause }), 1);
});

test("Einrichtung --sperre: setzt die Sperre nur, wenn noch keine gesetzt ist, und liest sie zurück", async () => {
  const fresh = fakeS3({ lock: { ObjectLockEnabled: "Enabled" }, lifecycle: null, entries: [] });
  const { out } = collect();
  assert.equal(await runSetup({ client: fresh.client, strictClient: fresh.client, bucket: BUCKET, mode: "sperre", out, pause: noPause }), 0);
  assert.equal(lockState(fresh.state.lock).state, "richtig");
  assert.deepEqual(fresh.calls.filter((c) => !READ_ONLY.has(c)), ["PutObjectLockConfigurationCommand"]);

  const again = fakeS3();
  assert.equal(await runSetup({ client: again.client, strictClient: again.client, bucket: BUCKET, mode: "sperre", out, pause: noPause }), 0);
  assert.ok(again.calls.every((c) => READ_ONLY.has(c)));

  const other = fakeS3({ lock: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 5 } } } });
  assert.equal(await runSetup({ client: other.client, strictClient: other.client, bucket: BUCKET, mode: "sperre", out, pause: noPause }), 1);
  assert.ok(other.calls.every((c) => READ_ONLY.has(c)));
});

test("Einrichtung verweigert falsches Projekt, fehlenden Bucket und Bucket ohne Object Lock, ohne etwas zu ändern", async () => {
  const { out } = collect();
  for (const init of [{ buckets: [BUCKET, "rent-base-files"] }, { buckets: ["rent-base-backup-test"] }, { lock: null }, { versioning: undefined }]) {
    const s3 = fakeS3({ ...init, lifecycle: null } as Partial<State>);
    const code = await runSetup({ client: s3.client, strictClient: s3.client, bucket: BUCKET, mode: "sperre", out, pause: noPause });
    assert.equal(code, 3, JSON.stringify(init));
    assert.ok(s3.calls.every((c) => READ_ONLY.has(c)), JSON.stringify(init));
  }
  // Der Test-Bucket daneben ist erlaubt (Produktions-Bucket im Test-Projekt).
  const s3 = fakeS3({ buckets: [BUCKET, "rent-base-backup-test"], lock: { ObjectLockEnabled: "Enabled" } });
  assert.equal(await runSetup({ client: s3.client, strictClient: s3.client, bucket: BUCKET, mode: "sperre", out, pause: noPause }), 0);
});

test("Einrichtung --lifecycle: erst mit gesperrtem Dump, nie über fremde Regeln, mit Rücklesen", async () => {
  const { lines, out } = collect();
  const noDump = fakeS3({ lifecycle: null, entries: [] });
  assert.equal(await runSetup({ client: noDump.client, strictClient: noDump.client, bucket: BUCKET, mode: "lifecycle", dumpPrefix: PREFIX, out, pause: noPause }), 1);
  const noLock = fakeS3({ lifecycle: null, lock: { ObjectLockEnabled: "Enabled" } });
  assert.equal(await runSetup({ client: noLock.client, strictClient: noLock.client, bucket: BUCKET, mode: "lifecycle", dumpPrefix: PREFIX, out, pause: noPause }), 1);
  const unlockedDump = fakeS3({ lifecycle: null, unlocked: true });
  assert.equal(await runSetup({ client: unlockedDump.client, strictClient: unlockedDump.client, bucket: BUCKET, mode: "lifecycle", dumpPrefix: PREFIX, out, pause: noPause }), 1);
  const foreign = fakeS3({ lifecycle: [{ ID: "fremd", Status: "Enabled", Filter: { Prefix: "x/" }, Expiration: { Days: 3 } }] });
  assert.equal(await runSetup({ client: foreign.client, strictClient: foreign.client, bucket: BUCKET, mode: "lifecycle", dumpPrefix: PREFIX, out, pause: noPause }), 1);
  const badPrefix = fakeS3({ lifecycle: null });
  assert.equal(await runSetup({ client: badPrefix.client, strictClient: badPrefix.client, bucket: BUCKET, mode: "lifecycle", dumpPrefix: "files/", out, pause: noPause }), 1);
  for (const s3 of [noDump, noLock, unlockedDump, foreign, badPrefix]) assert.ok(s3.calls.every((c) => READ_ONLY.has(c)), s3.calls.join());

  const ready = fakeS3({ lifecycle: null });
  const strictCalls: string[] = [];
  const strict = { send: (cmd: Command) => { strictCalls.push(cmd.constructor.name); return ready.client.send(cmd); } };
  assert.equal(await runSetup({ client: ready.client, strictClient: strict, bucket: BUCKET, mode: "lifecycle", dumpPrefix: PREFIX, out, pause: noPause }), 0, lines.join("\n"));
  assert.deepEqual(strictCalls, ["PutBucketLifecycleConfigurationCommand"]);
  assert.ok(sameRules(ready.state.lifecycle, expectedLifecycleRules(PREFIX)));

  const rejected = fakeS3({ lifecycle: null, rejectPut: true });
  assert.equal(await runSetup({ client: rejected.client, strictClient: rejected.client, bucket: BUCKET, mode: "lifecycle", dumpPrefix: PREFIX, out, pause: noPause }), 1);
});

test("Einrichtung --wiederherstellen: Policy zuerst, dann ACL, Sperre und Regeln; nie Daten; nicht blockierbar", async () => {
  const { lines, out } = collect();
  const writes = (s3: ReturnType<typeof fakeS3>) => s3.calls.filter((c) => !READ_ONLY.has(c));
  const tampered = fakeS3({
    lock: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1 } } },
    lifecycle: [{ ID: "alles-weg", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 1 } }],
    policy: "{\"Statement\":[]}",
    bucketAcl: PUBLIC_ACL,
  });
  const code = await runSetup({ client: tampered.client, strictClient: tampered.client, bucket: BUCKET, mode: "wiederherstellen", dumpPrefix: PREFIX, out, pause: noPause });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(lockState(tampered.state.lock).state, "richtig");
  assert.ok(sameRules(tampered.state.lifecycle, expectedLifecycleRules(PREFIX)));
  assert.equal(tampered.state.policy, null);
  assert.deepEqual(foreignGrants(tampered.state.bucketAcl), []);
  assert.deepEqual(writes(tampered), ["DeleteBucketPolicyCommand", "PutBucketAclCommand", "PutObjectLockConfigurationCommand", "PutBucketLifecycleConfigurationCommand"]);

  // Angreifer legt einen weiteren Bucket an und sperrt mit einer Policy das Lesen der Einstellungen: läuft trotzdem.
  const blocked = fakeS3({
    buckets: [BUCKET, "kosten-bombe"], denyWhilePolicy: true, policy: "{\"Statement\":[{\"Effect\":\"Deny\"}]}",
    lock: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1 } } }, lifecycle: null,
  });
  assert.equal(await runSetup({ client: blocked.client, strictClient: blocked.client, bucket: BUCKET, mode: "wiederherstellen", dumpPrefix: PREFIX, out, pause: noPause }), 1);
  assert.equal(blocked.state.policy, null);
  assert.equal(lockState(blocked.state.lock).state, "richtig");
  assert.ok(sameRules(blocked.state.lifecycle, expectedLifecycleRules(PREFIX)));

  // Steht alles richtig, ändert es nichts und endet mit 0.
  const healthy = fakeS3();
  assert.equal(await runSetup({ client: healthy.client, strictClient: healthy.client, bucket: BUCKET, mode: "wiederherstellen", dumpPrefix: PREFIX, out, pause: noPause }), 0);
  assert.deepEqual(writes(healthy), []);
  // Ohne gültiges Präfix ändert es nichts; ohne Dumps unter dem Präfix bleibt der Lifecycle unverändert.
  const bad = fakeS3({ lifecycle: null });
  assert.equal(await runSetup({ client: bad.client, strictClient: bad.client, bucket: BUCKET, mode: "wiederherstellen", dumpPrefix: "files/", out, pause: noPause }), 1);
  assert.deepEqual(writes(bad), []);
  const empty = fakeS3({ lifecycle: null });
  assert.equal(await runSetup({ client: empty.client, strictClient: empty.client, bucket: BUCKET, mode: "wiederherstellen", dumpPrefix: "data/coolify/backups/falsch/", out, pause: noPause }), 1);
  assert.deepEqual(writes(empty), []);
});

test("Zugangsdaten über die Standardeingabe: genau zwei Zeilen, sonst Abbruch", async () => {
  const env = { BACKUP_S3_ENDPOINT: "https://hel1.your-objectstorage.com", BACKUP_S3_BUCKET: BUCKET };
  const ok = await readTarget(env, { keysFromStdin: true, stdin: Readable.from(["AKIAEXAMPLEKEY01\nsecretSECRETsecret0123456789abcdef\n"]) });
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.region, "hel1");
  const three = await readTarget(env, { keysFromStdin: true, stdin: Readable.from(["AKIAEXAMPLEKEY01\nAKIAEXAMPLEKEY01\nsecretSECRETsecret0123456789abcdef\n"]) });
  assert.ok(three.missing.length > 0);
  const spaces = await readTarget(env, { keysFromStdin: true, stdin: Readable.from(["AKIA EXAMPLE\nsecret secret secret\n"]) });
  assert.ok(spaces.missing.length > 0);
  const fromEnv = await readTarget({ ...env, BACKUP_S3_ACCESS_KEY: "AKIAEXAMPLEKEY01", BACKUP_S3_SECRET_KEY: "secretSECRETsecret0123456789abcdef" });
  assert.deepEqual(fromEnv.missing, []);
  assert.deepEqual((await readTarget({})).missing.sort(), ["BACKUP_S3_ACCESS_KEY", "BACKUP_S3_BUCKET", "BACKUP_S3_ENDPOINT", "BACKUP_S3_SECRET_KEY"]);
});
