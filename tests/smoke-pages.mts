// Rauchtest der Seiten gegen den laufenden Dev-Server (npm run dev) und die lokale Datenbank.
// Legt einen Testmandanten mit Sitzung an, ruft jede Seite auf und räumt danach auf.
// Aufruf: npx tsx tests/smoke-pages.mts [http://localhost:3000] [--keep]
//   --keep  lässt die Testdaten stehen und gibt Sitzung und Buchung aus (für die Sichtprüfung im Browser)
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveContractSignature } from "../src/lib/contracts";
import { answerChecklist, finalizeHandover, getHandoverContentHash, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft, addNewDamage } from "../src/lib/handovers";
import { buildStorageKey } from "../src/lib/storage";
import { sha256 } from "../src/lib/integrity";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { createWorld, fakeSignaturePng, purgeTenants } from "./helpers";
import { ensureContractDocument, ensurePickupDocument } from "../src/lib/documents";

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

// Übergabe-Entwurf für die Buchung mit abgeschlossenem Vertrag, samt Altschaden und neuem Schaden
await db.damage.create({ data: { tenantId: w.tenantId, vehicleId: v2.id, view: "LEFT", posX: 0.3, posY: 0.55, kind: "SCRATCH", description: "Kratzer Fahrertür" } });
const pickup = await startHandover(w.tenantId, signedBooking.id, "PICKUP", w.actor);
await addNewDamage(w.tenantId, pickup.id, { view: "FRONT", posX: 0.5, posY: 0.6, kind: "CHIP", description: "Steinschlag Haube", size: "ca. 1 cm" });

// dritte Buchung: Übergabe komplett finalisiert
const v3 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-RT 300", make: "Tesla", model: "Model 3", groupId: w.groupId, fuel: "ELEKTRO", dailyRate: 99, deposit: 500, mileage: 12000 } });
const doneBooking = await db.booking.create({ data: { tenantId: w.tenantId, number: "DONE-1", vehicleId: v3.id, customerId: w.customerId, startAt: start2, endAt: new Date(start2.getTime() + 2 * 86400_000), dailyRate: 99, deposit: 500 } });
const doneContract = await ensureContractDraft(w.tenantId, doneBooking.id, w.actor);
await saveContractSignature(w.tenantId, w.actor, doneContract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, doneContract.id) });
await finalizeContract(w.tenantId, doneContract.id);
const done = await startHandover(w.tenantId, doneBooking.id, "PICKUP", w.actor);
await updateHandoverDraft(w.tenantId, done.id, { mileage: 12040, batteryPercent: 90 });
for (const c of REQUIRED_PHOTO_CATEGORIES) { const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: doneBooking.id, contentType: "image/jpeg" }); await registerPhoto(w.tenantId, w.actor, { handoverId: done.id, storageKey: key, category: c, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key) }); }
const doneItems = await db.handoverChecklistItem.findMany({ where: { handoverId: done.id } });
await answerChecklist(w.tenantId, done.id, doneItems.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2" : i.answerType === "YES_NO" ? "YES" : "OK" })));
await saveHandoverSignature(w.tenantId, w.actor, done.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, done.id) });
await finalizeHandover(w.tenantId, done.id, w.actor);

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
  [`/buchungen/${signedBooking.id}`, "Übergabe fortsetzen"],
  [`/buchungen/${doneBooking.id}`, "Übergabeprotokoll anzeigen"],
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
  // Übergabe-Assistent, alle sieben Schritte
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=1`, "Bekannte Schäden"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=2`, "Tankstand in Achteln"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=3`, "gilt als Vorschaden"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=4`, "Kilometerstand"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=5`, "Reifen und Felgen"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=6`, "Unterschrift Mieter"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=7`, "Übergabe verbindlich abschließen"],
  // finalisiertes Protokoll eines Elektrofahrzeugs
  [`/buchungen/${doneBooking.id}/uebergabe`, "Prüfsumme des versiegelten Protokolls"],
  [`/buchungen/${doneBooking.id}/uebergabe`, "Batteriestand"],
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

// Foto-Upload über die geschützte Adresse: echtes JPEG hoch, wieder abrufen, fremder Mandant und anonym abgewiesen
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const upload = async (file: Blob, headers: Record<string, string>) => { const body = new FormData(); body.set("file", file, "foto.jpg"); body.set("category", "FRONT"); return fetch(`${base}/api/handovers/${pickup.id}/photos`, { method: "POST", body, headers, redirect: "manual" }); };
const up = await upload(new Blob([jpeg], { type: "image/jpeg" }), { cookie });
const upJson = (await up.json().catch(() => ({}))) as { id?: string };
report(up.status === 201 && Boolean(upJson.id), `${up.status} Foto-Upload in den Entwurf`);
const got = await fetch(`${base}/api/photos/${upJson.id}`, { headers: { cookie } });
report(got.status === 200 && got.headers.get("content-type") === "image/jpeg" && (await got.arrayBuffer()).byteLength === jpeg.length, `${got.status} Foto wird unverändert ausgeliefert`);
const fake = await upload(new Blob([new TextEncoder().encode("<svg onload=alert(1)>")], { type: "image/jpeg" }), { cookie });
report(fake.status === 415, `${fake.status} Datei, die kein Bild ist, wird abgelehnt`);
const lockedUp = await fetch(`${base}/api/handovers/${done.id}/photos`, { method: "POST", body: (() => { const b = new FormData(); b.set("file", new Blob([jpeg]), "x.jpg"); b.set("category", "OTHER"); return b; })(), headers: { cookie } });
report(lockedUp.status === 409, `${lockedUp.status} Upload in finalisiertes Protokoll wird abgelehnt`);
const anonUp = await upload(new Blob([jpeg]), {});
report(anonUp.status !== 201, `${anonUp.status} Upload ohne Sitzung wird verweigert`);

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
const foreignPhoto = await fetch(`${base}/api/photos/${upJson.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignPhoto.status === 404, `${foreignPhoto.status} Foto für fremden Mandanten nicht auffindbar`);
const foreignUp = await upload(new Blob([jpeg]), { cookie: `rb_session=${foreignSession}` });
report(foreignUp.status === 404, `${foreignUp.status} Upload in fremdes Protokoll nicht möglich`);
const foreignPage = await fetch(`${base}/buchungen/${w.bookingId}/vertrag`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignPage.status === 404, `${foreignPage.status} Vertrag für fremden Mandanten nicht auffindbar`);

// Phase 5: archivierte Dokumente. Erzeugt wird über dieselbe Bibliothek wie in der App, ausgeliefert über die geschützte Adresse.
const contractPdf = await ensureContractDocument(w.tenantId, doneContract.id, w.actor.id);
const pickupPdf = await ensurePickupDocument(w.tenantId, done.id, w.actor.id);
for (const [name, d] of [["Mietvertrag", contractPdf.document], ["Übergabeprotokoll", pickupPdf.document]] as const) {
  const res = await fetch(`${base}/api/documents/${d.id}`, { headers: { cookie } });
  const body = new Uint8Array(await res.arrayBuffer());
  report(res.status === 200 && res.headers.get("content-type") === "application/pdf" && sha256(body) === d.checksum && (res.headers.get("cache-control") ?? "").includes("no-store") && (res.headers.get("content-disposition") ?? "").startsWith("inline"), `${res.status} ${name}-PDF mit Sitzung, Prüfsumme stimmt, nicht im Cache`);
}
const dl = await fetch(`${base}/api/documents/${pickupPdf.document.id}?download=1`, { headers: { cookie } });
report(dl.status === 200 && (dl.headers.get("content-disposition") ?? "") === `attachment; filename="${pickupPdf.document.fileName}"`, `${dl.status} Herunterladen mit verständlichem Dateinamen (${pickupPdf.document.fileName})`);
const anonDoc = await fetch(`${base}/api/documents/${pickupPdf.document.id}`, { redirect: "manual" });
report(anonDoc.status !== 200, `${anonDoc.status} Dokument ohne Sitzung wird verweigert`);
const foreignDoc = await fetch(`${base}/api/documents/${pickupPdf.document.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignDoc.status === 404, `${foreignDoc.status} Dokument für fremden Mandanten nicht auffindbar`);
const bookingPage = await (await fetch(`${base}/buchungen/${doneBooking.id}`, { headers: { cookie } })).text();
report(bookingPage.includes("Dokumente") && bookingPage.includes(pickupPdf.document.fileName) && bookingPage.includes("E-Mail an den Mieter"), "200 Buchungsseite zeigt Dokumente und E-Mail-Bereich");

const anon = await fetch(base + "/heute", { redirect: "manual" });
report(anon.status === 307 && (anon.headers.get("location") ?? "").includes("/login"), `${anon.status} /heute ohne Sitzung leitet zum Login`);
// Abgelaufene Sitzung: keine Endlosschleife zwischen Startseite und Login, das alte Cookie wird entfernt
const stale = { cookie: "rb_session=gibt-es-nicht-mehr" };
const staleHome = await fetch(base + "/heute", { headers: stale, redirect: "manual" });
const staleLogin = await fetch(base + "/login?abgelaufen=1", { headers: stale, redirect: "manual" });
report(staleHome.status === 307 && (staleHome.headers.get("location") ?? "").includes("/login?abgelaufen=1") && staleLogin.status === 200 && (staleLogin.headers.get("set-cookie") ?? "").includes("rb_session=;"), `${staleHome.status}/${staleLogin.status} abgelaufene Sitzung landet sauber beim Login`);

if (keep) {
  console.log(`\nTestdaten bleiben stehen.\nSITZUNG=${sessionId}\nBUCHUNG=${w.bookingId} UEBERGEBEN=${doneBooking.id} BEREIT=${signedBooking.id}\nVERTRAG=${draft.number}\nMANDANTEN=${w.tenantId},${foreign.tenantId}`);
} else {
  await purgeTenants([w.tenantId, foreign.tenantId]);
}
await db.$disconnect();
console.log(failed === 0 ? "\nAlle Seiten in Ordnung." : `\n${failed} Prüfung(en) fehlgeschlagen.`);
process.exit(failed === 0 ? 0 : 1);
