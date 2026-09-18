// Rauchtest der Seiten gegen den laufenden Dev-Server (npm run dev) und die lokale Datenbank.
// Legt einen Testmandanten mit Sitzung an, ruft jede Seite auf und räumt danach auf.
// Aufruf: npx tsx tests/smoke-pages.mts [http://localhost:3000] [--keep]
//   --keep  lässt die Testdaten stehen und gibt Sitzung und Buchung aus (für die Sichtprüfung im Browser)
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveContractSignature } from "../src/lib/contracts";
import { createWorld, fakeSignaturePng, purgeTenants } from "./helpers";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3000";

const w = await createWorld("smoke");
await db.user.update({ where: { id: w.userId }, data: { role: "OWNER" } });
const sessionId = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: sessionId, userId: w.userId, expiresAt: new Date(Date.now() + 6 * 3600_000) } });
const cookie = `rb_session=${sessionId}`;

// zweite, alte Buchung ohne Preisstufen (wie vor Phase 2) und eine dritte für den abgeschlossenen Vertrag
const old = await db.booking.create({ data: { tenantId: w.tenantId, number: "ALT-1", vehicleId: w.vehicleId, customerId: w.customerId, startAt: new Date(Date.now() - 40 * 86400_000), endAt: new Date(Date.now() - 30 * 86400_000), dailyRate: 89, deposit: 500, status: "RETURNED" } });
const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-RT 200", make: "VW", model: "Golf", groupId: w.groupId, dailyRate: 49, deposit: 300 } });
const start2 = new Date(Date.now() + 3 * 86400_000);
const signedBooking = await db.booking.create({ data: { tenantId: w.tenantId, number: "SIGN-1", vehicleId: v2.id, customerId: w.customerId, startAt: start2, endAt: new Date(start2.getTime() + 2 * 86400_000), dailyRate: 49, deposit: 300 } });
const signedContract = await ensureContractDraft(w.tenantId, signedBooking.id, w.actor);
const sig = await saveContractSignature(w.tenantId, w.actor, signedContract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, signedContract.id) });
await finalizeContract(w.tenantId, signedContract.id);

// Entwurf für die erste Buchung
const draft = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);

const pages: [string, string][] = [
  ["/heute", "Abholungen heute"],
  ["/dispo", "Dispo-Kalender"],
  ["/fahrzeuge", "HB-RT 200"],
  ["/fahrzeuge/gruppen", "Kalenderwoche"],
  ["/fahrzeuge/neu", "Fahrzeuggruppe"],
  [`/fahrzeuge/${w.vehicleId}`, "Crafter"],
  ["/kunden", "Muster"],
  ["/kunden/neu", "Ausweisnummer"],
  [`/kunden/${w.customerId}`, "K-00001"],
  ["/buchungen", "Bereit zur Übergabe"],
  ["/buchungen?filter=alle", "ALT-1"],
  ["/buchungen/neu", "Neuer Kunde"],
  [`/buchungen/${w.bookingId}`, "Mietvertrag fortsetzen"],
  [`/buchungen/${old.id}`, "Muster"],
  [`/buchungen/${signedBooking.id}`, "Übergabe starten"],
  ["/einstellungen", "Mietbedingungen für Verträge"],
  // Vertragsassistent, alle sieben Schritte
  [`/buchungen/${w.bookingId}/vertrag?schritt=1`, "Die Daten des Mieters sind vollständig"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=2`, "Mieter fährt selbst"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=3`, "Das Fahrzeug ist vermietbar und im Zeitraum frei"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=4`, "So entsteht der Mietpreis"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=5`, "Zusatzfahrer hinzufügen"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=6`, "Gesamtmietpreis (brutto)"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=7`, "Mietvertrag verbindlich abschließen"],
  // abgeschlossener Vertrag und vorbereitete Übergabeseite
  [`/buchungen/${signedBooking.id}/vertrag`, "Prüfsumme des unterschriebenen Inhalts"],
  [`/buchungen/${signedBooking.id}/uebergabe`, "Übergabe noch nicht gestartet"],
  [`/buchungen/${w.bookingId}/uebergabe`, "erst möglich, wenn der Mietvertrag abgeschlossen ist"],
];

let failed = 0;
const report = (ok: boolean, text: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FEHL"} ${text}`);
};
for (const [path, expect] of pages) {
  const res = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
  const body = res.status === 200 ? await res.text() : "";
  const ok = res.status === 200 && body.includes(expect);
  report(ok, `${res.status} ${path}${ok ? "" : `  (erwartet: "${expect}")`}`);
}

// Unterschriftsbild: nur mit Sitzung des richtigen Mandanten
const img = await fetch(`${base}/api/signatures/${sig.id}`, { headers: { cookie } });
report(img.status === 200 && img.headers.get("content-type") === "image/png" && (img.headers.get("cache-control") ?? "").includes("no-store"), `${img.status} Unterschriftsbild mit Sitzung, nicht im Cache`);
const anonImg = await fetch(`${base}/api/signatures/${sig.id}`, { redirect: "manual" });
report(anonImg.status !== 200, `${anonImg.status} Unterschriftsbild ohne Sitzung wird verweigert`);
const foreign = await createWorld("smoke-fremd");
const foreignSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: foreignSession, userId: foreign.userId, expiresAt: new Date(Date.now() + 3600_000) } });
const foreignImg = await fetch(`${base}/api/signatures/${sig.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignImg.status === 404, `${foreignImg.status} Unterschriftsbild für fremden Mandanten nicht auffindbar`);
const foreignPage = await fetch(`${base}/buchungen/${w.bookingId}/vertrag`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignPage.status === 404, `${foreignPage.status} Vertrag für fremden Mandanten nicht auffindbar`);

const anon = await fetch(base + "/heute", { redirect: "manual" });
report(anon.status === 307 && (anon.headers.get("location") ?? "").includes("/login"), `${anon.status} /heute ohne Sitzung leitet zum Login`);

if (keep) {
  console.log(`\nTestdaten bleiben stehen.\nSITZUNG=${sessionId}\nBUCHUNG=${w.bookingId}\nVERTRAG=${draft.number}\nMANDANTEN=${w.tenantId},${foreign.tenantId}`);
} else {
  await purgeTenants([w.tenantId, foreign.tenantId]);
}
await db.$disconnect();
console.log(failed === 0 ? "\nAlle Seiten in Ordnung." : `\n${failed} Prüfung(en) fehlgeschlagen.`);
process.exit(failed === 0 ? 0 : 1);
