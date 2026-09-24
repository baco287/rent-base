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
import { ensureContractDocument, ensurePickupDocument, ensureReturnDocument } from "../src/lib/documents";
import { addManualCharge, confirmProposal } from "../src/lib/returns";
import { ensureInvoiceDocument } from "../src/lib/documents";
import { ensureInvoiceDraft, finalizeInvoice, startInvoiceEdit, updateInvoiceDraft } from "../src/lib/invoices";
import { recordInvoicePayment } from "../src/lib/payments";
import { recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { chargeCustomer, openDamageCase, setLiability } from "../src/lib/damage-cases";
import { reportDamage } from "../src/lib/damages";
import { completeMaintenance, createMaintenance, createPlan, setMaintenanceCosts } from "../src/lib/maintenance";
import { approveResponse, createAuthorityCase, prepareResponse, setDriver, submitResponse } from "../src/lib/authority";
import { acknowledgeTerms } from "../src/lib/contracts";
import { createTermsDraft, publishTermsVersion } from "../src/lib/rental-terms";
import { createCancellationDraft, createCreditNoteDraft, finalizeCounterDocument, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { createPayout } from "../src/lib/payouts";
import { ensurePayoutDocument } from "../src/lib/documents";
import { toDateInputValue, zonedParts } from "../src/lib/time";

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

// Rückgabe-Entwurf für die übergebene Buchung (Elektro): Vergleich, Vorschlag, manuelle Position
const ret = await startHandover(w.tenantId, doneBooking.id, "RETURN", w.actor);
await updateHandoverDraft(w.tenantId, ret.id, { mileage: 12690, batteryPercent: 30 });
const retDamage = await addNewDamage(w.tenantId, ret.id, { view: "REAR", posX: 0.7, posY: 0.5, kind: "DENT", severity: "MINOR", description: "Delle Heckklappe, bei Rückgabe" });
await addManualCharge(w.tenantId, ret.id, w.userId, { type: "CLEANING", description: "Innenreinigung", quantity: 1, unit: "pauschal", unitPrice: 30 });

// Zweite übergebene Buchung mit abgeschlossener Rückgabe (Vergleich, Zusatzkosten, Return-PDF)
const v4 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: "HB-RT 400", make: "Ford", model: "Transit", groupId: w.groupId, fuel: "DIESEL", dailyRate: 89, deposit: 500, mileage: 20000, tankCapacityLiters: 80 } });
const retBooking = await db.booking.create({ data: { tenantId: w.tenantId, number: "RET-1", vehicleId: v4.id, customerId: w.customerId, startAt: new Date(Date.now() - 4 * 86400_000), endAt: new Date(Date.now() - 3600_000), dailyRate: 89, deposit: 500 } });
const retContract = await ensureContractDraft(w.tenantId, retBooking.id, w.actor);
await saveContractSignature(w.tenantId, w.actor, retContract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, retContract.id) });
await finalizeContract(w.tenantId, retContract.id);
const fillHandover = async (handoverId: string, bookingId: string, mileage: number, fuel: number) => {
  await updateHandoverDraft(w.tenantId, handoverId, { mileage, fuelLevelEighths: fuel });
  for (const c of REQUIRED_PHOTO_CATEGORIES) { const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId, contentType: "image/jpeg" }); await registerPhoto(w.tenantId, w.actor, { handoverId, storageKey: key, category: c, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key) }); }
  const items = await db.handoverChecklistItem.findMany({ where: { handoverId } });
  await answerChecklist(w.tenantId, handoverId, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? (i.itemKey === "remarks" ? "" : "2") : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  await saveHandoverSignature(w.tenantId, w.actor, handoverId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, handoverId) });
  await finalizeHandover(w.tenantId, handoverId, w.actor);
};
const retPickup = await startHandover(w.tenantId, retBooking.id, "PICKUP", w.actor);
await fillHandover(retPickup.id, retBooking.id, 20010, 8);
const retReturn = await startHandover(w.tenantId, retBooking.id, "RETURN", w.actor);
await updateHandoverDraft(w.tenantId, retReturn.id, { mileage: 21600, fuelLevelEighths: 5, fuelPricePerLiter: 1.85 });
await confirmProposal(w.tenantId, retReturn.id, w.userId, "EXTRA_MILEAGE");
await confirmProposal(w.tenantId, retReturn.id, w.userId, "FUEL");
await fillHandover(retReturn.id, retBooking.id, 21600, 5);

// Entwurf für die erste Buchung
const draft = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);

const pages: [string, string][] = [
  [`/buchungen/${doneBooking.id}`, "Rückgabe fortsetzen"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=1`, "mit dem dokumentierten Übergabezustand"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=2`, "650 km"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=3`, "Prozentpunkte"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=4`, "Bei Rückgabe neu festgestellt"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=5`, "Übergabe (vorher)"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=6`, "Anzahl zurückgegebener Schlüssel"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=7`, "Innenreinigung"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=8`, "kein Anerkenntnis"],
  [`/buchungen/${doneBooking.id}/rueckgabe?schritt=9`, "Fahrzeugrückgabe verbindlich abschließen"],
  [`/buchungen/${retBooking.id}`, "Rückgabeprotokoll anzeigen"],
  [`/buchungen/${retBooking.id}`, "Zusatzkosten"],
  [`/buchungen/${retBooking.id}/rueckgabe`, "Vergleich mit der Übergabe"],
  [`/buchungen/${retBooking.id}/rueckgabe`, "Prüfsumme des versiegelten Protokolls"],
  [`/fahrzeuge/${v4.id}`, "Nächste Fälligkeiten"],
  [`/fahrzeuge/${v4.id}?tab=schaeden`, "Schadenakte"],
  [`/fahrzeuge/${v4.id}?tab=historie`, "Rückgabe"],
  ["/heute", "Abholungen heute"],
  ["/dispo", "Dispo-Kalender"],
  ["/fahrzeuge", "HB-RT 200"],
  ["/fahrzeuge/gruppen", "Kalenderwoche"],
  ["/fahrzeuge/neu", "Fahrzeuggruppe"],
  [`/fahrzeuge/${w.vehicleId}`, "Crafter"],
  ["/kunden", "Muster"],
  ["/kunden/neu", "Ausweisnummer"],
  [`/kunden/${w.customerId}`, "K-00001"],
  // Phase 19: Kundenakte 360°, Suche, Dashboard
  [`/kunden/${w.customerId}`, "Letzte Aktivität"],
  [`/kunden/${w.customerId}?tab=buchungen`, "Buchungen als Mieter"],
  [`/kunden/${w.customerId}?tab=buchungen`, "Als Fahrer eingetragen"],
  [`/kunden/${w.customerId}?tab=finanzen`, "Wirksames Rechnungsvolumen"],
  [`/kunden/${w.customerId}?tab=kautionen`, "Kautionen je Buchung"],
  [`/kunden/${w.customerId}?tab=schaeden`, "Schadenakten zu Vermietungen dieser Person"],
  [`/kunden/${w.customerId}?tab=dokumente`, "Dokumente"],
  [`/kunden/${w.customerId}?tab=kommunikation`, "E-Mail-Verlauf"],
  [`/kunden/${w.customerId}?tab=behoerden`, "als Fahrer bestimmt"],
  [`/kunden/${w.customerId}?tab=historie`, "Kunde angelegt"],
  [`/kunden/${w.customerId}?tab=stammdaten`, "Ausweisnummer"],
  ["/kunden?q=k-00001", "Muster"],
  ["/kunden?q=0421%2012345", "Muster"],
  ["/buchungen?filter=alle&q=hbrt200", "SIGN-1"],
  ["/buchungen?filter=alle&q=muster", "ALT-1"],
  ["/fahrzeuge?q=hbrt300", "HB-RT 300"],
  ["/suche", "Suchbegriff eingeben"],
  ["/suche?q=K-00001", "Muster"],
  ["/suche?q=hbrt200", "HB-RT 200"],
  ["/suche?q=SIGN-1", "Buchung SIGN-1"],
  ["/suche?q=a", "mindestens 2 Zeichen"],
  ["/heute", "Was braucht Aufmerksamkeit?"],
  ["/heute?zeitraum=7", "Bald"],
  ["/heute?zeitraum=30", "30 Tage"],
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
const returnPdf = await ensureReturnDocument(w.tenantId, retReturn.id, w.actor.id);
for (const [name, d] of [["Mietvertrag", contractPdf.document], ["Übergabeprotokoll", pickupPdf.document], ["Rückgabeprotokoll", returnPdf.document]] as const) {
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
report(bookingPage.includes("Dokumente") && bookingPage.includes(pickupPdf.document.fileName) && bookingPage.includes("E-Mail nach der Übergabe"), "200 Buchungsseite zeigt Dokumente und E-Mail-Bereich");

// Audit: Upload-Angriffe. Der Server erkennt den Typ am Inhalt, nicht an Name oder Content-Type.
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, 0, 0, 0, 0]);
const attack = async (label: string, body: Uint8Array | string, type: string, expect: number, name = "foto.jpg") => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body; const fd = new FormData(); fd.set("file", new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type }), name); fd.set("category", "OTHER");
  const r = await fetch(`${base}/api/handovers/${pickup.id}/photos`, { method: "POST", body: fd, headers: { cookie } });
  report(r.status === expect, `${r.status} Upload: ${label} (erwartet ${expect})`);
};
await attack("gültiges PNG", png, "image/png", 201, "bild.png");
await attack("gültiges WebP", webp, "image/webp", 201, "bild.webp");
await attack("Endung JPG, Inhalt Text", "kein bild", "image/jpeg", 415);
await attack("SVG mit Skript", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "image/svg+xml", 415, "foto.svg");
await attack("HTML als JPG getarnt", "<html><script>alert(1)</script></html>", "image/jpeg", 415);
await attack("JavaScript", "alert(1)", "text/javascript", 415, "foto.js");
await attack("PDF als Foto", "%PDF-1.7 ...", "application/pdf", 415, "foto.pdf");
await attack("0-Byte-Datei", new Uint8Array(0), "image/jpeg", 400);
await attack("zu große Datei", new Uint8Array(8 * 1024 * 1024 + 1), "image/jpeg", 413);
await attack("beschädigtes JPEG (nur Kopf)", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "image/jpeg", 201);

// Audit: direkte URLs mit falschem Prozessstand
const direct: [string, string][] = [
  [`/buchungen/${w.bookingId}/rueckgabe`, "nur für Fahrzeuge möglich, die unterwegs sind"],
  [`/buchungen/${old.id}/uebergabe`, "kein Übergabeprotokoll"],
  [`/buchungen/${old.id}/rueckgabe`, "Zurückgegeben"],
  [`/buchungen/${w.bookingId}/vertrag?schritt=7`, "Mietvertrag"],
  [`/buchungen/${doneBooking.id}/uebergabe?schritt=3`, "Prüfsumme des versiegelten Protokolls"],
  [`/buchungen/${retBooking.id}/rueckgabe?schritt=2`, "Prüfsumme des versiegelten Protokolls"],
];
for (const [path, expected] of direct) {
  const r = await fetch(base + path, { headers: { cookie } });
  const html = await r.text();
  report(r.status === 200 && html.includes(expected), `${r.status} Direkt-URL ${path} zeigt "${expected}"`);
}
const foreignRet = await fetch(`${base}/buchungen/${retBooking.id}/rueckgabe`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignRet.status === 404, `${foreignRet.status} Rückgabeprotokoll für fremden Mandanten nicht auffindbar`);
const foreignVehicle = await fetch(`${base}/fahrzeuge/${v4.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignVehicle.status === 404, `${foreignVehicle.status} Fahrzeugakte für fremden Mandanten nicht auffindbar`);

// Rechnungsmodul: Startseite ohne Einstellungen, Entwurf, Abschluss, PDF, Buchungsseite
// (React trennt Text und Ausdrücke im HTML durch Kommentare; für die Textsuche werden sie entfernt)
const plain = async (res: Response) => (await res.text()).replace(/<!-- -->/g, "");
const invStart0 = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(invStart0.includes("Rechnung zur Buchung RET-1 erstellen") && invStart0.includes("Steuersatz für Rechnungspositionen") && invStart0.includes("disabled"), "Rechnung: Startseite nennt fehlende Steuereinstellungen, Knopf gesperrt");
await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Testbank" } });
const settingsHtml = await (await fetch(base + "/einstellungen", { headers: { cookie } })).text();
report(settingsHtml.includes("Rechnungsdaten und Steuer") && settingsHtml.includes("DE02120300000000202051"), "Einstellungen: Rechnungsdaten und Steuer");
const invStart1 = await (await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } })).text();
report(invStart1.includes("Rechnung erstellen") && !invStart1.includes("Steuersatz für Rechnungspositionen"), "Rechnung: Startseite bereit");
const retBookingHtml0 = await (await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } })).text();
report(retBookingHtml0.includes("Rechnung erstellen") && retBookingHtml0.includes("noch nicht erstellt"), "Buchung: Rechnung erstellen sichtbar");
const invoice = await ensureInvoiceDraft(w.tenantId, retBooking.id, w.actor);
const invDraft = await (await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } })).text();
report(["Rechnung (Entwurf)", "Alle Prüfungen bestanden", "Rechnungsempfänger", "Quellen des Entwurfs", "Mehrkilometer", "Kraftstoff", "Entwurf speichern", "Rechnung finalisieren", "Position hinzufügen", "Steuerzusammenfassung", "Änderungsprotokoll", "Entwurf verwerfen"].every((t) => invDraft.includes(t)), "Rechnung: Entwurfsseite mit allen Bereichen");
const retBookingHtml1 = await (await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } })).text();
report(retBookingHtml1.includes("Rechnung fortsetzen"), "Buchung: Rechnung fortsetzen");
const finalVersion = await finalizeInvoice(w.tenantId, invoice.id, w.actor);
const finalInvoice = { number: (await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).number!, versionId: finalVersion.id };
const invoicePdf = await ensureInvoiceDocument(w.tenantId, finalVersion.id, w.actor.id);
const invFinal = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?abgeschlossen=1`, { headers: { cookie } }));
report([`Rechnung ${finalInvoice.number}`, "Finalisiert", "Aktuelle Fassung 1", "Noch nicht übermittelt", "Fassungsverlauf", "Rechnung bearbeiten", "Als an Kunden übergeben markieren", "Prüfsumme (SHA-256)", "Rechnungsbetrag", `Rechnung_${finalInvoice.number}_Fassung1.pdf`, "Herunterladen", "E-Mail mit Rechnung", "Rechnung jetzt senden", "Interne Notiz"].every((t) => invFinal.includes(t)) && !invFinal.includes("Entwurf speichern"), "Rechnung: abgeschlossene Ansicht mit Fassungsverlauf, Dokument und E-Mail-Bereich");
const invDoc = await fetch(`${base}/api/documents/${invoicePdf.document.id}?download=1`, { headers: { cookie } });
report(invDoc.status === 200 && (invDoc.headers.get("content-disposition") ?? "").includes(`Rechnung_${finalInvoice.number}_Fassung1.pdf`) && (await invDoc.arrayBuffer()).byteLength === invoicePdf.document.sizeBytes, `${invDoc.status} Rechnungs-PDF herunterladen`);
const retBookingHtml2 = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(retBookingHtml2.includes(`Rechnung ${finalInvoice.number} anzeigen`) && retBookingHtml2.includes("abgeschlossen"), "Buchung: Rechnung anzeigen und Status");

// Zahlungen und Kaution (Phase 9): Buchungsseite mit getrennten Bereichen, Rechnungsseite mit Saldo, Rechnungsliste, Dashboard
const bookingFin0 = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(["Zahlungen", "Zahlung erfassen", "Kaution", "Kaution als erhalten erfassen", "Noch nicht erhalten", "Kautionshistorie", "Zahlungshistorie", "Offen"].every((t) => bookingFin0.includes(t)), "Buchung: Bereiche Zahlungen und Kaution mit Aktionen");
const pickupNotice = await plain(await fetch(`${base}/buchungen/${signedBooking.id}/uebergabe?schritt=1`, { headers: { cookie } }));
report(pickupNotice.includes("noch nicht") && pickupNotice.includes("als erhalten dokumentiert") && pickupNotice.includes("Bekannte Schäden"), "Übergabe: Warnung Kaution nicht dokumentiert, Übergabe nicht blockiert");
const pay1 = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: invoice.id, amount: "100", method: "CASH", paidAt: new Date(Date.now() - 60_000), reference: "Beleg 77" });
const invPage = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(invPage.includes("Teilbezahlt") && invPage.includes("100,00") && invPage.includes("Beleg 77") && invPage.includes("Zahlung stornieren") && invPage.includes("Zahlung erfassen"), "Rechnung: Saldo, Status Teilbezahlt, Historie, Storno-Möglichkeit");
await recordDepositReceived(w.tenantId, w.actor, { bookingId: retBooking.id, amount: "500", method: "CASH", occurredAt: new Date(Date.now() - 60_000) });
await settleDeposit(w.tenantId, w.actor, { bookingId: retBooking.id, releaseAmount: "350", method: "CASH", reason: "Prüfung eines bei Rückgabe festgestellten Schadens", occurredAt: new Date(Date.now() - 30_000) });
const bookingFin1 = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(["Teilweise freigegeben", "350,00", "150,00", "Prüfung eines bei Rückgabe festgestellten Schadens", "keine Verrechnung", "Bewegung korrigieren"].every((t) => bookingFin1.includes(t)) && !bookingFin1.includes("Kaution als erhalten erfassen"), "Buchung: Kaution teilweise freigegeben, Historie, Hinweis keine Verrechnung");
const invList = await plain(await fetch(base + "/rechnungen?filter=teilbezahlt", { headers: { cookie } }));
report(invList.includes(finalInvoice.number) && invList.includes("Teilbezahlt") && invList.includes("100,00") && invList.includes("nicht übermittelt"), "Rechnungsliste: Filter Teilbezahlt mit Beträgen und Übermittlungsstatus");
const invListPaid = await plain(await fetch(base + "/rechnungen?filter=bezahlt", { headers: { cookie } }));
report(!invListPaid.includes(finalInvoice.number) && invListPaid.includes("Keine Belege"), "Rechnungsliste: Filter Bezahlt leer");
// Rechnungsfassungen: Bearbeiten (Modus A, nicht übermittelt), Fassung 2 finalisieren, Verlauf, PDF je Fassung, Hof sieht nur
const fassung2Draft = await startInvoiceEdit(w.tenantId, invoice.id, w.actor);
const editPage = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(editPage.includes("Fassung 2 (Entwurf)") && editPage.includes("noch nicht übermittelt") && editPage.includes("Änderungsgrund (optional)") && editPage.includes("Rechnungsempfänger") && editPage.includes("Fassung 2 finalisieren") && editPage.includes("Zahlungen zu dieser Rechnung"), "Rechnung bearbeiten: Entwurf Fassung 2 aus Fassung 1, Modus A mit Zahlungsvorschau");
await updateInvoiceDraft(w.tenantId, invoice.id, w.actor, { items: fassung2Draft.items.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), unit: i.unit, unitPrice: String(i.unitPrice), taxRate: String(i.taxRate) })), customer: { street: "Neue Straße 5" }, reason: "Anschrift korrigiert" });
const fassung2 = await finalizeInvoice(w.tenantId, invoice.id, w.actor);
const v2pdf = await ensureInvoiceDocument(w.tenantId, fassung2.id, w.actor.id);
const afterV2 = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(afterV2.includes("Aktuelle Fassung 2") && afterV2.includes("2 Fassungen") && afterV2.includes("Ersetzt") && afterV2.includes("Neufassung") && afterV2.includes("Neue Straße 5") && afterV2.includes("Änderungen gegenüber Fassung 1") && afterV2.includes(`Rechnung_${finalInvoice.number}_Fassung2.pdf`), "Rechnung: Fassung 2 aktuell, Fassung 1 ersetzt, Differenz sichtbar");
const oldView = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?fassung=1`, { headers: { cookie } }));
report(oldView.includes("Sie sehen die ersetzte Fassung 1") && oldView.includes("Weg 1"), "Rechnung: historische Fassung 1 weiterhin lesbar mit alten Daten");
const oldPdf = await fetch(`${base}/api/documents/${invoicePdf.document.id}?download=1`, { headers: { cookie } });
report(oldPdf.status === 200 && (await oldPdf.arrayBuffer()).byteLength === invoicePdf.document.sizeBytes, `${oldPdf.status} altes PDF der Fassung 1 unverändert abrufbar`);
void v2pdf;
const retBookingV = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(retBookingV.includes("2 Fassungen") && retBookingV.includes("aktuell 2"), "Buchung: Fassungshinweis");
const today = await plain(await fetch(base + "/heute", { headers: { cookie } }));
report(today.includes("Offene Rechnungen") && today.includes("Überfällige Rechnungen") && today.includes("Offene Kautionen") && today.includes("Rechnungserstattungen offen"), "Dashboard: Kennzahlen Rechnungen und Kaution");
void pay1;

// Phase 12: Schadenmanagement. Schaden → Akte → Uploads → Haftung → Kundenbelastung → Schadenabrechnung neben der Mietrechnung.
const hofDamage = await reportDamage(w.tenantId, w.actor, { vehicleId: v4.id, view: "LEFT", posX: 0.4, posY: 0.5, kind: "SCRATCH", description: "Kratzer Schiebetür, nach Rückgabe bemerkt", bookingId: retBooking.id });
const { damageCase: dc } = await openDamageCase(w.tenantId, hofDamage.id, w.actor);
const casesList = await plain(await fetch(base + "/schaeden", { headers: { cookie } }));
report(casesList.includes(dc.caseNumber) && casesList.includes("Noch nicht bewertet") && casesList.includes("HB-RT 400"), "Schäden: Liste mit Akte, Haftung und Fahrzeug");
const casesSearch = await plain(await fetch(base + "/schaeden?filter=alle&q=gibt-es-nicht", { headers: { cookie } }));
report(!casesSearch.includes(dc.caseNumber) && casesSearch.includes("Keine Schadenakten"), "Schäden: Suche ohne Treffer");
const casePage0 = await plain(await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie } }));
report(casePage0.includes(`Schadenakte ${dc.caseNumber}`) && casePage0.includes("Haftungsprüfung") && casePage0.includes("Kaution und Forderung wurden noch nicht miteinander verrechnet") && casePage0.includes("Fahrzeug wegen Schaden sperren") && casePage0.includes("Schadenakte schließen") && casePage0.includes("Selbstbeteiligung") && !casePage0.includes("Schaden dem Kunden berechnen"), "Schadenakte: Abschnitte, Kautionshinweis, ohne bestätigte Haftung keine Belastung");
const caseUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "f.jpg"); fd.set("caption", "Werkstattaufnahme"); return fetch(`${base}/api/damage-cases/${dc.id}/photos`, { method: "POST", body: fd, headers: { cookie } }); })();
report(caseUp.status === 201, `${caseUp.status} Schadenakte: Foto hochgeladen`);
const pdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const caseDoc = await (async () => { const fd = new FormData(); fd.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "KV-4711.pdf"); fd.set("type", "ESTIMATE"); return fetch(`${base}/api/damage-cases/${dc.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
const caseDocJson = (await caseDoc.json()) as { id: string };
report(caseDoc.status === 201, `${caseDoc.status} Schadenakte: Kostenvoranschlag (PDF) hochgeladen`);
const caseDocBad = await (async () => { const fd = new FormData(); fd.set("file", new Blob([new TextEncoder().encode("<html>x</html>")], { type: "application/pdf" }), "x.pdf"); fd.set("type", "OTHER"); return fetch(`${base}/api/damage-cases/${dc.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
report(caseDocBad.status === 415, `${caseDocBad.status} Schadenakte: Datei ohne PDF/Bild-Signatur abgewiesen`);
const caseDocGet = await fetch(`${base}/api/damage-documents/${caseDocJson.id}`, { headers: { cookie } });
report(caseDocGet.status === 200 && caseDocGet.headers.get("content-type") === "application/pdf", `${caseDocGet.status} Schadenakte: Dokument über geschützte Adresse`);
const foreignCase = await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignCase.status === 404, `${foreignCase.status} Schadenakte für fremden Mandanten nicht auffindbar`);
const foreignCaseDoc = await fetch(`${base}/api/damage-documents/${caseDocJson.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignCaseDoc.status === 404, `${foreignCaseDoc.status} Schadendokument für fremden Mandanten nicht auffindbar`);
const foreignCaseUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "f.jpg"); return fetch(`${base}/api/damage-cases/${dc.id}/photos`, { method: "POST", body: fd, headers: { cookie: `rb_session=${foreignSession}` } }); })();
report(foreignCaseUp.status === 404, `${foreignCaseUp.status} Upload in fremde Schadenakte nicht möglich`);
await setLiability(w.tenantId, dc.id, w.actor, "CUSTOMER_RESPONSIBILITY_CONFIRMED", "Mieter hat den Kratzer bei Rückgabe eingeräumt");
const casePage1 = await plain(await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie } }));
report(casePage1.includes("Kunde verantwortlich (bestätigt)") && casePage1.includes("Schaden dem Kunden berechnen") && casePage1.includes("Werkstattaufnahme") && casePage1.includes("KV-4711.pdf"), "Schadenakte: Haftung bestätigt, Belastung möglich, Foto und Dokument sichtbar");
const charge = await chargeCustomer(w.tenantId, dc.id, w.actor, { amount: "350", basis: "Lackierung Schiebetür laut Kostenvoranschlag KV-4711", taxTreatment: "NON_TAXABLE_DAMAGE_COMPENSATION" });
const dmgDraft = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${charge.invoiceId}`, { headers: { cookie } }));
report(dmgDraft.includes("Schadenabrechnung (Entwurf)") && dmgDraft.includes("Zur Schadenakte") && dmgDraft.includes(dc.caseNumber) && dmgDraft.includes("nicht steuerbar") && !dmgDraft.includes("Quellen des Entwurfs"), "Schadenabrechnung: Entwurf über ?nr= mit Aktenbezug und Steuerhinweis");
const rentalStill = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(rentalStill.includes(`Rechnung ${finalInvoice.number}`) && rentalStill.includes("Aktuelle Fassung 2"), "Mietrechnung ohne ?nr= unverändert erreichbar");
const dmgVersion = await finalizeInvoice(w.tenantId, charge.invoiceId, w.actor);
const dmgInvoice = await db.invoice.findUniqueOrThrow({ where: { id: charge.invoiceId } });
const dmgPdf = await ensureInvoiceDocument(w.tenantId, dmgVersion.id, w.actor.id);
const dmgFinal = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${charge.invoiceId}&abgeschlossen=1`, { headers: { cookie } }));
report(dmgFinal.includes(`Schadenabrechnung ${dmgInvoice.number}`) && dmgFinal.includes("Finalisiert") && dmgFinal.includes("Zahlungen zur Schadenabrechnung") && dmgFinal.includes(`Schadenabrechnung ${dmgInvoice.number}`) && dmgFinal.includes("Herunterladen"), "Schadenabrechnung: finalisiert, Zahlungen und PDF je Rechnung");
report(dmgPdf.document.fileName.includes(dmgInvoice.number ?? "?"), `PDF ${dmgPdf.document.fileName}`);
const casePage2 = await plain(await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie } }));
report(casePage2.includes(`Schadenabrechnung ${dmgInvoice.number}`) && casePage2.includes("Fassung 1") && casePage2.includes("Offen") && casePage2.includes("350,00") && !casePage2.includes("Schaden dem Kunden berechnen") && casePage2.includes("Die Kundenbelastung ist festgelegt"), "Schadenakte: Rechnung, Fassung, Zahlungsstatus, Belastung einmalig");
const invListDmg = await plain(await fetch(base + "/rechnungen?filter=alle&art=schaden", { headers: { cookie } }));
const invListRent = await plain(await fetch(base + "/rechnungen?filter=alle&art=miete", { headers: { cookie } }));
report(invListDmg.includes(dmgInvoice.number!) && invListDmg.includes(dc.caseNumber) && !invListDmg.includes(finalInvoice.number!) && invListRent.includes(finalInvoice.number!) && !invListRent.includes(dmgInvoice.number!), "Rechnungsliste: Filter Mietrechnung / Schadensrechnung");
const bookingDmg = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(bookingDmg.includes("Schadenabrechnung") && bookingDmg.includes(dc.caseNumber) && bookingDmg.includes("Schäden dieser Vermietung") && bookingDmg.includes("Rechnung " + finalInvoice.number), "Buchung: Mietrechnung und Schadenabrechnung getrennt, Schäden-Karte");
const vehicleDmg = await plain(await fetch(`${base}/fahrzeuge/${v4.id}?tab=schaeden`, { headers: { cookie } }));
report(vehicleDmg.includes(dc.caseNumber) && vehicleDmg.includes("Kunde verantwortlich (bestätigt)"), "Fahrzeugakte: Schaden mit Aktenbezug und Haftungsstand");
const todayDmg = await plain(await fetch(base + "/heute", { headers: { cookie } }));
report(todayDmg.includes("Offene Schadenakten") && todayDmg.includes("wegen Schaden gesperrt") && todayDmg.includes("Haftung ungeklärt") && todayDmg.includes("in Reparatur"), "Dashboard: Schaden-Kennzahlen");
const hofOnly = await reportDamage(w.tenantId, w.actor, { vehicleId: v3.id, view: "FRONT", posX: 0.2, posY: 0.4, kind: "CHIP", description: "Steinschlag ohne Miete" });
const { damageCase: dcHof } = await openDamageCase(w.tenantId, hofOnly.id, w.actor);
const hofCase = await plain(await fetch(`${base}/schaeden/${dcHof.id}`, { headers: { cookie } }));
report(hofCase.includes("keiner Vermietung zugeordnet") && !hofCase.includes("Schaden dem Kunden berechnen"), "Schadenakte ohne Vermietung: keine Kundenbelastung möglich");

// Phase 13: Flotten- und Wartungsmanagement. Plan → Fälligkeit → Vorgang → Beleg → Abschluss → Fahrzeugakte, Übersicht, Dashboard.
const huPlan = await createPlan(w.tenantId, w.actor, { vehicleId: v4.id, type: "HU_AU", nextDueDate: new Date(Date.now() + 5 * 86400_000) });
const inspPlan = await createPlan(w.tenantId, w.actor, { vehicleId: v4.id, type: "INSPECTION", intervalMonths: "12", intervalKilometers: "20000", nextDueDate: new Date(Date.now() + 200 * 86400_000), nextDueMileage: "22000" });
const maintRes = await createMaintenance(w.tenantId, w.actor, { vehicleId: v4.id, type: "INSPECTION", title: "Inspektion 20.000 km", planId: inspPlan.id, workshopName: "Autohaus Muster GmbH", scheduledAt: new Date(Date.now() + 2 * 86400_000), estimatedCostCents: "650" });
const maint = maintRes.record;
const wartung = await plain(await fetch(base + "/fahrzeuge/wartung", { headers: { cookie } }));
report(wartung.includes("Werkstattvorgänge") && wartung.includes("Anstehende Fälligkeiten") && wartung.includes(maint.maintenanceNumber) && wartung.includes("HU/AU") && wartung.includes("Bald fällig") && wartung.includes("HB-RT 400"), "Wartungsübersicht: Fälligkeiten und Vorgänge");
const wartungFilter = await plain(await fetch(base + "/fahrzeuge/wartung?filter=erledigt", { headers: { cookie } }));
report(!wartungFilter.includes(maint.maintenanceNumber), "Wartungsübersicht: Filter Erledigt blendet offene Vorgänge aus");
const maintPage0 = await plain(await fetch(`${base}/fahrzeuge/wartung/${maint.id}`, { headers: { cookie } }));
report(maintPage0.includes(maint.maintenanceNumber) && maintPage0.includes("Werkstatttermin") && maintPage0.includes("Autohaus Muster GmbH") && maintPage0.includes("Fahrzeug für Wartung sperren") && maintPage0.includes("Als erledigt markieren") && maintPage0.includes("Kilometer dokumentieren"), "Wartungsvorgang: Termin, Werkstatt, Aktionen");
const maintUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "Werkstattrechnung.pdf"); fd.set("type", "WORKSHOP_INVOICE"); fd.set("description", "Rechnung 4711"); return fetch(`${base}/api/maintenance/${maint.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
const maintUpJson = (await maintUp.json()) as { id: string };
report(maintUp.status === 201, `${maintUp.status} Wartungsvorgang: Werkstattrechnung hochgeladen`);
const maintUpBad = await (async () => { const fd = new FormData(); fd.set("file", new Blob([new TextEncoder().encode("<html>")], { type: "application/pdf" }), "x.pdf"); return fetch(`${base}/api/maintenance/${maint.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
report(maintUpBad.status === 415, `${maintUpBad.status} Wartungsvorgang: Datei ohne PDF/Bild-Signatur abgewiesen`);
const vdocGet = await fetch(`${base}/api/vehicle-documents/${maintUpJson.id}`, { headers: { cookie } });
report(vdocGet.status === 200 && vdocGet.headers.get("content-type") === "application/pdf", `${vdocGet.status} Fahrzeugdokument über geschützte Adresse`);
const vdocForeign = await fetch(`${base}/api/vehicle-documents/${maintUpJson.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(vdocForeign.status === 404, `${vdocForeign.status} Fahrzeugdokument für fremden Mandanten nicht auffindbar`);
const maintForeign = await fetch(`${base}/fahrzeuge/wartung/${maint.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(maintForeign.status === 404, `${maintForeign.status} Wartungsvorgang für fremden Mandanten nicht auffindbar`);
const genUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "Zulassung.pdf"); fd.set("type", "REGISTRATION"); return fetch(`${base}/api/vehicles/${v4.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
report(genUp.status === 201, `${genUp.status} Allgemeines Fahrzeugdokument hochgeladen`);
await setMaintenanceCosts(w.tenantId, maint.id, w.actor, { actual: "684,32" });
const maintDone = await completeMaintenance(w.tenantId, maint.id, w.actor, { completedAt: new Date(), mileage: "21900", actualCost: "684,32", workDone: "Inspektion nach Herstellervorgabe", setNextDue: true, nextDueDate: new Date(Date.now() + 365 * 86400_000), nextDueMileage: "41900" });
report(maintDone.record.status === "COMPLETED" && maintDone.plan?.nextDueMileage === 41_900, "Wartungsvorgang erledigt, Plan fortgeschrieben");
const maintPage1 = await plain(await fetch(`${base}/fahrzeuge/wartung/${maint.id}`, { headers: { cookie } }));
report(maintPage1.includes("Erledigt") && maintPage1.includes("684,32") && maintPage1.includes("Werkstattrechnung.pdf") && maintPage1.includes("21.900 km") && !maintPage1.includes("Als erledigt markieren"), "Wartungsvorgang: erledigt mit Kosten, Beleg, Kilometer");
const vehWartung = await plain(await fetch(`${base}/fahrzeuge/${v4.id}?tab=wartung`, { headers: { cookie } }));
report(vehWartung.includes("Wartung / Werkstatt hinzufügen") && vehWartung.includes(maint.maintenanceNumber) && vehWartung.includes("Gesamt Wartung/Werkstatt") && vehWartung.includes("684,32"), "Fahrzeugakte: Wartung & Werkstatt mit Kostenhistorie");
const vehFaellig = await plain(await fetch(`${base}/fahrzeuge/${v4.id}?tab=faelligkeiten`, { headers: { cookie } }));
report(vehFaellig.includes("Wartungspläne") && vehFaellig.includes("Bald fällig") && vehFaellig.includes("Nächste HU") && vehFaellig.includes("Wartungsplan anlegen"), "Fahrzeugakte: Fälligkeiten und Pläne");
const vehDocs = await plain(await fetch(`${base}/fahrzeuge/${v4.id}?tab=dokumente`, { headers: { cookie } }));
report(vehDocs.includes("Zulassung.pdf") && vehDocs.includes("Werkstattrechnung.pdf") && vehDocs.includes("KV-4711.pdf"), "Fahrzeugakte: allgemeine, Wartungs- und Schadendokumente an einem Ort");
const vehUeb = await plain(await fetch(`${base}/fahrzeuge/${v4.id}`, { headers: { cookie } }));
report(vehUeb.includes("Nächste Fälligkeiten") && vehUeb.includes("Wartung / Werkstatt") && vehUeb.includes("Übersicht"), "Fahrzeugakte: Reiter und Übersicht");
const maintNew = await plain(await fetch(`${base}/fahrzeuge/wartung/neu?fahrzeug=${v4.id}&akte=${dc.id}&art=DAMAGE_REPAIR`, { headers: { cookie } }));
report(maintNew.includes("Wartung / Werkstatt hinzufügen") && maintNew.includes("Zugehörige Schadenakte") && maintNew.includes(dc.caseNumber) && maintNew.includes("Fahrzeug jetzt für die Werkstatt sperren"), "Neuanlage: aus Schadenakte vorbelegt, Sperre als bewusste Option");
const casePage3 = await plain(await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie } }));
report(casePage3.includes("Kein Reparaturvorgang verknüpft") && casePage3.includes("Reparaturvorgang anlegen"), "Schadenakte: Bereich Reparatur & Werkstatt");
const todayMaint = await plain(await fetch(base + "/heute", { headers: { cookie } }));
report(todayMaint.includes("Wartung") && todayMaint.includes("fällig/überfällig") && todayMaint.includes("Termine heute") && todayMaint.includes("in Werkstatt"), "Dashboard: Wartungskennzahlen");
void huPlan;

// Audit: Rollen. Hofmitarbeiter dürfen Buchungen weder anlegen noch stornieren, Übergabe und Rückgabe aber durchführen.
const yard = await db.user.create({ data: { tenantId: w.tenantId, email: `yard-${Date.now()}@example.test`, name: "Hof", passwordHash: "x", role: "YARD" } });
const yardSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: yardSession, userId: yard.id, expiresAt: new Date(Date.now() + 3600_000) } });
const yardNew = await fetch(base + "/buchungen/neu", { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardNew.status === 307 && (yardNew.headers.get("location") ?? "").includes("fehler=rechte"), `${yardNew.status} Hofmitarbeiter: keine neue Buchung`);
const yardPickup = await fetch(`${base}/buchungen/${doneBooking.id}/uebergabe`, { headers: { cookie: `rb_session=${yardSession}` } });
report(yardPickup.status === 200, `${yardPickup.status} Hofmitarbeiter: Übergabe erlaubt`);
const yardBooking = await (await fetch(`${base}/buchungen/${w.bookingId}`, { headers: { cookie: `rb_session=${yardSession}` } })).text();
report(!yardBooking.includes(">Stornieren<"), "Hofmitarbeiter: kein Storno-Knopf");
const yardSettings = await fetch(base + "/einstellungen", { headers: { cookie: `rb_session=${yardSession}` } });
report(yardSettings.status === 200, `${yardSettings.status} Einstellungen lesbar (Aktionen nur Inhaber)`);

// Hofmitarbeiter: Vertragsentwurf gesperrt, abgeschlossener Vertrag einsehbar, Übergabe und Rückgabe erlaubt, Dokumente und E-Mail-Bereich sichtbar
const yardDraft = await fetch(`${base}/buchungen/${w.bookingId}/vertrag`, { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardDraft.status === 307 && decodeURIComponent(yardDraft.headers.get("location") ?? "").includes("nur Inhaber und Disponenten"), `${yardDraft.status} Hofmitarbeiter: Vertragsentwurf nicht bearbeitbar`);
const yardSigned = await fetch(`${base}/buchungen/${doneBooking.id}/vertrag`, { headers: { cookie: `rb_session=${yardSession}` } });
report(yardSigned.status === 200 && (await yardSigned.text()).includes("Prüfsumme"), `${yardSigned.status} Hofmitarbeiter: abgeschlossenen Vertrag ansehen`);
const yardReturn = await fetch(`${base}/buchungen/${retBooking.id}/rueckgabe`, { headers: { cookie: `rb_session=${yardSession}` } });
const yardReturnHtml = await yardReturn.text();
report(yardReturn.status === 200 && yardReturnHtml.includes("Herunterladen") && /Unterlagen (jetzt|erneut) senden|E-Mail erneut senden/.test(yardReturnHtml), `${yardReturn.status} Hofmitarbeiter: Rückgabeprotokoll, Dokumente und E-Mail erneut senden`);
const yardDoc = await fetch(`${base}/api/documents/${returnPdf.document.id}?download=1`, { headers: { cookie: `rb_session=${yardSession}` } });
report(yardDoc.status === 200, `${yardDoc.status} Hofmitarbeiter: Dokument herunterladen`);
const yardInvoice = await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie: `rb_session=${yardSession}` } });
const yardInvoiceHtml = await yardInvoice.text();
report(yardInvoice.status === 200 && yardInvoiceHtml.includes("Herunterladen") && yardInvoiceHtml.includes("Fassungsverlauf") && !yardInvoiceHtml.includes("Rechnung bearbeiten") && !yardInvoiceHtml.includes("Als an Kunden übergeben markieren") && yardInvoiceHtml.includes("Der Versand erfolgt durch die Disposition") && !yardInvoiceHtml.includes("Interne Notiz"), `${yardInvoice.status} Hofmitarbeiter: Fassungen ansehen, kein Bearbeiten, keine Übergabemarkierung, kein Versand, keine interne Notiz`);
const yardInvoiceDoc = await fetch(`${base}/api/documents/${invoicePdf.document.id}?download=1`, { headers: { cookie: `rb_session=${yardSession}` } });
report(yardInvoiceDoc.status === 200, `${yardInvoiceDoc.status} Hofmitarbeiter: Rechnungs-PDF herunterladen`);
const yardNoInvoice = await fetch(`${base}/buchungen/${doneBooking.id}/rechnung`, { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardNoInvoice.status === 307, `${yardNoInvoice.status} Hofmitarbeiter: keine Rechnungsanlage`);
const yardRetBooking = await (await fetch(`${base}/buchungen/${old.id}`, { headers: { cookie: `rb_session=${yardSession}` } })).text();
report(!yardRetBooking.includes("Rechnung erstellen"), "Hofmitarbeiter: kein Knopf „Rechnung erstellen“");
const yardFin = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardFin.includes("Teilbezahlt") && yardFin.includes("Teilweise freigegeben") && !yardFin.includes("Zahlung erfassen") && !yardFin.includes("Zahlung stornieren") && !yardFin.includes("Bewegung korrigieren") && yardFin.includes("erfasst und korrigiert die Disposition"), "Hofmitarbeiter: sieht Zahlungs- und Kautionsstatus, keine Erfassung/Storno/Korrektur");
const yardPickupDeposit = await plain(await fetch(`${base}/buchungen/${signedBooking.id}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardPickupDeposit.includes("Kaution als erhalten erfassen"), "Hofmitarbeiter: darf Kaution bei Übergabe als erhalten dokumentieren");
const yardList = await fetch(base + "/rechnungen", { headers: { cookie: `rb_session=${yardSession}` } });
report(yardList.status === 200, `${yardList.status} Hofmitarbeiter: Rechnungsliste lesbar`);
const yardCase = await plain(await fetch(`${base}/schaeden/${dcHof.id}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardCase.includes("Notiz speichern") && yardCase.includes("Foto aufnehmen") && yardCase.includes("Dokument hochladen") && !yardCase.includes("Haftung festlegen") && !yardCase.includes("Kosten speichern") && !yardCase.includes("Fahrzeug wegen Schaden sperren") && !yardCase.includes("Schadenakte schließen") && !yardCase.includes("Schaden dem Kunden berechnen") && yardCase.includes("entscheidet die Disposition"), "Hofmitarbeiter: Schadenakte sehen, Notiz/Foto/Dokument, keine Haftung/Kosten/Sperre/Abschluss/Belastung");
const yardCaseUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "f.jpg"); return fetch(`${base}/api/damage-cases/${dcHof.id}/photos`, { method: "POST", body: fd, headers: { cookie: `rb_session=${yardSession}` } }); })();
report(yardCaseUp.status === 201, `${yardCaseUp.status} Hofmitarbeiter: Foto an Schadenakte`);
const yardMaint = await plain(await fetch(`${base}/fahrzeuge/wartung/${maint.id}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardMaint.includes(maint.maintenanceNumber) && !yardMaint.includes("Vorgang bearbeiten") && !yardMaint.includes("Kosten speichern") && !yardMaint.includes("Fahrzeug für Wartung sperren") && !yardMaint.includes("Als erledigt markieren") && !yardMaint.includes("Archivieren") && yardMaint.includes("entscheidet die Disposition"), "Hofmitarbeiter: Wartungsvorgang ansehen, keine Kosten/Sperre/Abschluss/Archivierung");
const yardMaintNew = await fetch(`${base}/fahrzeuge/wartung/neu?fahrzeug=${v4.id}`, { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardMaintNew.status === 307, `${yardMaintNew.status} Hofmitarbeiter: keine Anlage von Wartungsvorgängen`);
const yardGenUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "Vers.pdf"); fd.set("type", "INSURANCE"); return fetch(`${base}/api/vehicles/${v4.id}/documents`, { method: "POST", body: fd, headers: { cookie: `rb_session=${yardSession}` } }); })();
report(yardGenUp.status === 403, `${yardGenUp.status} Hofmitarbeiter: keine allgemeinen Fahrzeugdokumente`);
const yardVehDocs = await plain(await fetch(`${base}/fahrzeuge/${v4.id}?tab=dokumente`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardVehDocs.includes("Zulassung.pdf") && !yardVehDocs.includes("Archivieren"), "Hofmitarbeiter: Fahrzeugdokumente sehen, nicht archivieren");
const yardCases = await fetch(base + "/schaeden", { headers: { cookie: `rb_session=${yardSession}` } });
report(yardCases.status === 200, `${yardCases.status} Hofmitarbeiter: Schadenliste lesbar`);
const yardDmgInvoice = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${charge.invoiceId}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardDmgInvoice.includes(`Schadenabrechnung ${dmgInvoice.number}`) && !yardDmgInvoice.includes("Rechnung bearbeiten"), "Hofmitarbeiter: Schadenabrechnung ansehen, nicht bearbeiten");
const yardUpload = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "f.jpg"); fd.set("category", "OTHER"); return fetch(`${base}/api/handovers/${pickup.id}/photos`, { method: "POST", body: fd, headers: { cookie: `rb_session=${yardSession}` } }); })();
report(yardUpload.status === 201, `${yardUpload.status} Hofmitarbeiter: Foto im Übergabe-Entwurf hochladen`);
const yardBookingNoStart = await (await fetch(`${base}/buchungen/${old.id}`, { headers: { cookie: `rb_session=${yardSession}` } })).text();
report(!yardBookingNoStart.includes("Mietvertrag erstellen") && !yardBookingNoStart.includes("Mietvertrag fortsetzen"), "Hofmitarbeiter: keine Vertragsknöpfe");
// Behördenvorgänge (Phase 14): Erfassung, automatische Zuordnung, Fahrerbestimmung, Antwort, Freigabe, Übermittlung, Rollen
// RET-1 wurde im Test binnen Sekunden übergeben und zurückgegeben – für die Tatzeit-Zuordnung bekommt sie realistische tatsächliche Zeiten
const bhBk = await db.booking.update({ where: { id: retBooking.id }, data: { actualPickupAt: new Date(Date.now() - 4 * 86400_000), actualReturnAt: new Date(Date.now() - 3600_000) } });
const bhOffense = new Date(bhBk.actualPickupAt!.getTime() + 2 * 3600_000);
const bhParts = zonedParts(bhOffense);
const bhCase = await createAuthorityCase(w.tenantId, w.actor, { type: "SPEEDING", authorityName: "Stadtamt Bremen", authorityReference: "AZ 12/345", licensePlate: "hb rt 400", offenseDate: toDateInputValue(bhOffense), offenseTime: `${String(bhParts.hour).padStart(2, "0")}:${String(bhParts.minute).padStart(2, "0")}`, responseDeadline: new Date(Date.now() + 2 * 86400_000), noticeAmount: "48,50", authorityAddress: "Stresemannstr. 48\n28207 Bremen", authorityEmail: "bussgeld@example.test" });
report(bhCase.vehicleId === v4.id && bhCase.bookingId === retBooking.id && bhCase.rentalMatch === "ACTUAL_PERIOD" && bhCase.status === "REVIEW_REQUIRED" && bhCase.driverDeterminationStatus === "UNDETERMINED", "Behördenvorgang: Kennzeichen und Vermietung automatisch zugeordnet, kein Fahrer");
const bhList = await plain(await fetch(base + "/behoerden", { headers: { cookie } }));
report(bhList.includes(bhCase.caseNumber) && bhList.includes("Zuordnung erforderlich") && bhList.includes("noch 2 Tage") && bhList.includes("Schreiben erfassen") && bhList.includes("48,50"), "Behördenübersicht: Vorgang, Abschnitte, Frist, Betrag nur als Information");
const bhSearch = await plain(await fetch(base + "/behoerden?filter=alle&q=gibt-es-nicht", { headers: { cookie } }));
report(!bhSearch.includes(bhCase.caseNumber), "Behördenübersicht: Suche filtert");
const bhSearchPlate = await plain(await fetch(base + "/behoerden?filter=alle&q=hbrt400", { headers: { cookie } }));
report(bhSearchPlate.includes(bhCase.caseNumber), "Behördenübersicht: Suche nach Kennzeichen in anderer Schreibweise");
const bhNew = await plain(await fetch(`${base}/behoerden/neu?fahrzeug=${v4.id}`, { headers: { cookie } }));
report(bhNew.includes("Behördenschreiben erfassen") && bhNew.includes("HB-RT 400") && bhNew.includes("Zeit unbekannt") && bhNew.includes("keine automatische Texterkennung"), "Behörden: Erfassung mit vorbelegtem Kennzeichen, manuelle Eingabe");
const bhPage0 = await plain(await fetch(`${base}/behoerden/${bhCase.id}`, { headers: { cookie } }));
report(bhPage0.includes(bhCase.caseNumber) && bhPage0.includes("Fahrerbestimmung") && bhPage0.includes("Bitte bestätigen Sie nur eine Person als Fahrer") && bhPage0.includes("Vertraglicher Hauptfahrer") && bhPage0.includes("Antwort vorbereiten") && bhPage0.includes("Fahrer nicht eindeutig feststellbar") && bhPage0.includes("RET-1") && bhPage0.includes("Tatzeit innerhalb der tatsächlichen Mietdauer") && bhPage0.includes("Vorgang abschließen"), "Behördenvorgang: Zuordnung, Kandidaten, Pflichthinweis, Aktionen");
const bhUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "Anhoerung.pdf"); fd.set("type", "INCOMING_NOTICE"); return fetch(`${base}/api/authority-cases/${bhCase.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
const bhUpJson = (await bhUp.json()) as { id: string };
report(bhUp.status === 201, `${bhUp.status} Behördenvorgang: Schreiben hochgeladen`);
const bhUpBad = await (async () => { const fd = new FormData(); fd.set("file", new Blob([new TextEncoder().encode("<html>")], { type: "application/pdf" }), "x.pdf"); return fetch(`${base}/api/authority-cases/${bhCase.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
report(bhUpBad.status === 415, `${bhUpBad.status} Behördenvorgang: Datei ohne PDF/Bild-Signatur abgewiesen`);
const bhDocGet = await fetch(`${base}/api/authority-documents/${bhUpJson.id}`, { headers: { cookie } });
report(bhDocGet.status === 200 && bhDocGet.headers.get("content-type") === "application/pdf", `${bhDocGet.status} Behördendokument abrufbar`);
const bhDocForeign = await fetch(`${base}/api/authority-documents/${bhUpJson.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(bhDocForeign.status === 404, `${bhDocForeign.status} Behördendokument für fremden Mandanten unsichtbar`);
const bhForeign = await fetch(`${base}/behoerden/${bhCase.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(bhForeign.status === 404, `${bhForeign.status} Behördenvorgang für fremden Mandanten nicht auffindbar`);
const bhDriver = (await db.contractDriver.findFirstOrThrow({ where: { tenantId: w.tenantId, contractId: bhCase.contractId!, role: "PRIMARY_DRIVER" } })).id;
await setDriver(w.tenantId, bhCase.id, w.actor, { mode: "CONTRACT", contractDriverId: bhDriver, confirmed: true, note: "Mieter hat sich selbst als Fahrer bestätigt" });
const bhDraft = await prepareResponse(w.tenantId, bhCase.id, w.actor, { responseType: "DRIVER_IDENTIFIED", submissionMethod: "EMAIL", includeBirthDate: true, includeAddress: true });
const bhPage1 = await plain(await fetch(`${base}/behoerden/${bhCase.id}`, { headers: { cookie } }));
report(bhPage1.includes("Vertragsfahrer bestimmt") && bhPage1.includes("Vorschau") && bhPage1.includes("Angaben geprüft und Antwort freigeben") && bhPage1.includes("Fahrer benannt") && bhPage1.includes("Muster") && !bhPage1.includes("B072RRE2I55") && !bhPage1.includes("Antwort-PDF öffnen"), "Behördenvorgang: Fahrer bestimmt, Entwurf mit Vorschau, Freigabe verlangt, keine Führerscheinnummer");
const bhApproved = await approveResponse(w.tenantId, bhDraft.id, w.actor);
const bhPage2 = await plain(await fetch(`${base}/behoerden/${bhCase.id}`, { headers: { cookie } }));
report(bhPage2.includes("Versandbereit") && bhPage2.includes("Antwort-PDF öffnen") && bhPage2.includes("Jetzt per E-Mail senden") && bhPage2.includes("bussgeld@example.test") && bhPage2.includes("Prüfsumme"), "Behördenvorgang: freigegeben, PDF, E-Mail-Versand als bewusste Aktion");
const bhPdf = await fetch(`${base}/api/authority-documents/${bhApproved.pdfDocumentId}`, { headers: { cookie } });
report(bhPdf.status === 200 && bhPdf.headers.get("content-type") === "application/pdf", `${bhPdf.status} Antwort-PDF aus dem privaten Speicher`);
const bhSent = await submitResponse(w.tenantId, bhApproved.id, w.actor, { transport: { name: "fake", async send() { return { messageId: "<smoke@test>" }; } } });
const bhPage3 = await plain(await fetch(`${base}/behoerden/${bhCase.id}`, { headers: { cookie } }));
report(bhSent.outcome === "SUBMITTED" && bhPage3.includes("Übermittelt") && bhPage3.includes("Übermittlungsnachweise") && bhPage3.includes("E-Mail an bussgeld@example.test") && !bhPage3.includes("Antwort vorbereiten"), "Behördenvorgang: übermittelt mit Nachweis, keine weitere Fassung");
const bhVeh = await plain(await fetch(`${base}/fahrzeuge/${v4.id}?tab=behoerden`, { headers: { cookie } }));
report(bhVeh.includes(bhCase.caseNumber) && bhVeh.includes("Schreiben erfassen"), "Fahrzeugakte: Reiter Behörden");
const bhBooking = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(bhBooking.includes("Behördenvorgänge") && bhBooking.includes(bhCase.caseNumber), "Buchung: Behördenvorgänge");
const bhCustomer = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=behoerden`, { headers: { cookie } }));
report(bhCustomer.includes("Behördenvorgänge") && bhCustomer.includes(bhCase.caseNumber) && bhCustomer.includes("bewusst als Fahrer bestimmt"), "Kundenakte: nur bewusst bestimmte Fahrer, neutrale Wortwahl");
const bhToday = await plain(await fetch(base + "/heute", { headers: { cookie } }));
report(bhToday.includes("Behördenfristen") && bhToday.includes("Behörden: Bearbeitung") && bhToday.includes("versandbereit"), "Heute: Behörden-Kennzahlen");
const yardBh = await plain(await fetch(`${base}/behoerden/${bhCase.id}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardBh.includes(bhCase.caseNumber) && yardBh.includes("Lesender Zugriff") && !yardBh.includes("Fahrerbestimmung speichern") && !yardBh.includes("Antwort vorbereiten") && !yardBh.includes("Vorgang abschließen") && !yardBh.includes("Dokument hochladen") && !yardBh.includes("Vorgangsdaten bearbeiten"), "Hofmitarbeiter: Behördenvorgang nur lesen");
const yardBhUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "x.pdf"); fd.set("type", "EVIDENCE"); return fetch(`${base}/api/authority-cases/${bhCase.id}/documents`, { method: "POST", body: fd, headers: { cookie: `rb_session=${yardSession}` } }); })();
report(yardBhUp.status === 403, `${yardBhUp.status} Hofmitarbeiter: kein Dokument-Upload an Behördenvorgänge`);
const yardBhNew = await fetch(base + "/behoerden/neu", { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardBhNew.status === 307, `${yardBhNew.status} Hofmitarbeiter: keine Erfassung von Behördenschreiben`);
const yardBhList = await fetch(base + "/behoerden", { headers: { cookie: `rb_session=${yardSession}` } });
report(yardBhList.status === 200 && !(await yardBhList.text()).includes("Schreiben erfassen"), `${yardBhList.status} Hofmitarbeiter: Behördenliste lesbar ohne Erfassen-Knopf`);
// Mietbedingungen & Geschäftsregeln (Phase 15): Einrichtung, Fassung, Vertragsassistent mit Kenntnisnahme, Rollen
const setup0 = await plain(await fetch(base + "/einstellungen/mietbedingungen", { headers: { cookie } }));
report(setup0.includes("Noch keine Mietbedingungen veröffentlicht") && setup0.includes("Entwurf anlegen") && setup0.includes("Bisheriger Text"), "Mietbedingungen: Einrichtungshinweis, Entwurf anlegen, bisheriger Text sichtbar");
const rulesPage = await plain(await fetch(base + "/einstellungen/geschaeftsregeln", { headers: { cookie } }));
report(rulesPage.includes("Mindestalter Fahrer") && rulesPage.includes("Auslandsfahrten erlaubt") && rulesPage.includes("Richtwerte") && rulesPage.includes("Bearbeitungsentgelt") && rulesPage.includes("Keine Regel erzeugt automatisch"), "Geschäftsregeln: Bereiche und Schutzhinweis");
const termsDraft = await createTermsDraft(w.tenantId, w.actor, { content: "# Allgemeine Mietbedingungen\n\n## 1. Geltungsbereich\nDiese Bedingungen gelten für alle Mietverträge (Beispieltext für den Rauchtest).\n\n## 2. Fahrer\n- Nur eingetragene Fahrer\n- **Gültige** Fahrerlaubnis\n" });
const draftPage = await plain(await fetch(`${base}/einstellungen/mietbedingungen/${termsDraft.id}`, { headers: { cookie } }));
report(draftPage.includes("Entwurf bearbeiten") && draftPage.includes("Veröffentlichen") && draftPage.includes("Vorschau") && draftPage.includes("Diese Fassung als Mietbedingungen veröffentlichen") && draftPage.includes("Version 1.0"), "Mietbedingungen: Entwurf mit Editor, Vorschau und bewusster Veröffentlichung");
const termsPub = await publishTermsVersion(w.tenantId, termsDraft.id, w.actor, { confirmed: true });
const pubPage = await plain(await fetch(`${base}/einstellungen/mietbedingungen/${termsPub.id}`, { headers: { cookie } }));
report(pubPage.includes("Veröffentlicht") && pubPage.includes("Inhalt der Fassung (unveränderlich)") && pubPage.includes("Neue Fassung erstellen") && pubPage.includes("Archivieren") && !pubPage.includes("Entwurf bearbeiten") && pubPage.includes(termsPub.checksum!), "Mietbedingungen: veröffentlichte Fassung nicht editierbar, Prüfsumme sichtbar");
const termsList = await plain(await fetch(base + "/einstellungen/mietbedingungen", { headers: { cookie } }));
report(termsList.includes("aktiv") && termsList.includes("Verwendet in") && !termsList.includes("Noch keine Mietbedingungen veröffentlicht"), "Mietbedingungen: Übersicht mit aktiver Fassung");
const settingsTerms = await plain(await fetch(base + "/einstellungen", { headers: { cookie } }));
report(settingsTerms.includes("Version 1.0 aktiv"), "Einstellungen: aktive Mietbedingungen ausgewiesen");
// neuer Vertrag nach Veröffentlichung: Fassung eingefroren, Kenntnisnahme vor Unterschrift
const start5 = new Date(Date.now() + 12 * 86400_000);
const termsBooking = await db.booking.create({ data: { tenantId: w.tenantId, number: "AGB-1", vehicleId: v2.id, customerId: w.customerId, startAt: start5, endAt: new Date(start5.getTime() + 2 * 86400_000), dailyRate: 49, deposit: 300 } });
const termsContract = await ensureContractDraft(w.tenantId, termsBooking.id, w.actor);
report(termsContract.rentalTermsVersionId === termsPub.id && termsContract.termsHash === termsPub.checksum, "Vertrag: aktive Fassung beim Anlegen eingefroren");
const step4 = await plain(await fetch(`${base}/buchungen/${termsBooking.id}/vertrag?schritt=4`, { headers: { cookie } }));
report(step4.includes("Kilometerregel") && step4.includes("Quelle:") && step4.includes("Individuelle Vereinbarungen") && step4.includes("Auslandsfahrten gestattet") && step4.includes("Zusatzfahrer-Preisregel"), "Vertragsassistent: Geschäftsregeln mit Herkunft und individuelle Vereinbarungen");
const step7a = await plain(await fetch(`${base}/buchungen/${termsBooking.id}/vertrag?schritt=7`, { headers: { cookie } }));
report(step7a.includes("Kenntnisnahme fehlt") && step7a.includes("Die Mietbedingungen Version 1.0 wurden zur Kenntnisnahme bereitgestellt") && step7a.includes("erst nach der Kenntnisnahme") && step7a.includes("Kenntnisnahme bestätigen"), "Vertragsassistent: Kenntnisnahme vor der Mieterunterschrift verlangt");
await acknowledgeTerms(w.tenantId, termsContract.id, w.actor, { confirmed: true });
const step7b = await plain(await fetch(`${base}/buchungen/${termsBooking.id}/vertrag?schritt=7`, { headers: { cookie } }));
report(step7b.includes("Kenntnisnahme bestätigt") && step7b.includes("Unterschrift Mieter") && !step7b.includes("erst nach der Kenntnisnahme"), "Vertragsassistent: nach Kenntnisnahme ist die Mieterunterschrift möglich");
await saveContractSignature(w.tenantId, w.actor, termsContract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, termsContract.id) });
await finalizeContract(w.tenantId, termsContract.id);
const termsView = await plain(await fetch(`${base}/buchungen/${termsBooking.id}/vertrag`, { headers: { cookie } }));
report(termsView.includes("Allgemeine Mietbedingungen – Version 1.0") && termsView.includes("Geschäftsregeln dieses Vertrags") && termsView.includes("Individuelle Vereinbarungen") && termsView.includes("Zur Kenntnisnahme bereitgestellt am"), "Vertrag: Fassung, Geschäftsregeln und Kenntnisnahme im abgeschlossenen Vertrag");
const termsDoc = await ensureContractDocument(w.tenantId, termsContract.id, w.actor.id);
const termsPdf = await fetch(`${base}/api/documents/${termsDoc.document.id}`, { headers: { cookie } });
report(termsPdf.status === 200 && termsPdf.headers.get("content-type") === "application/pdf", `${termsPdf.status} Vertrags-PDF mit Mietbedingungen abrufbar`);
const usage = await plain(await fetch(`${base}/einstellungen/mietbedingungen/${termsPub.id}`, { headers: { cookie } }));
report(usage.includes(termsContract.number) && usage.includes("1 Mietvertrag"), "Mietbedingungen: Verwendung zeigt den Vertrag");
const groupsRules = await plain(await fetch(base + "/fahrzeuge/gruppen", { headers: { cookie } }));
report(groupsRules.includes("Abweichende Geschäftsregeln dieser Gruppe"), "Fahrzeuggruppen: Abweichungen für den Inhaber");
const vehicleRules = await plain(await fetch(`${base}/fahrzeuge/${v2.id}?tab=stammdaten`, { headers: { cookie } }));
report(vehicleRules.includes("Abweichende Geschäftsregeln dieses Fahrzeugs"), "Fahrzeugakte: Abweichungen für den Inhaber");
const yardTerms = await plain(await fetch(base + "/einstellungen/mietbedingungen", { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardTerms.includes("Version 1.0") && !yardTerms.includes("Entwurf anlegen") && !yardTerms.includes("Neue Fassung erstellen"), "Hofmitarbeiter: Mietbedingungen ansehen, nicht anlegen");
const yardTermsDetail = await plain(await fetch(`${base}/einstellungen/mietbedingungen/${termsPub.id}`, { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardTermsDetail.includes("Inhalt der Fassung") && !yardTermsDetail.includes("Archivieren") && !yardTermsDetail.includes("Neue Fassung erstellen"), "Hofmitarbeiter: Fassung lesen, keine Aktionen");
const yardRules = await plain(await fetch(base + "/einstellungen/geschaeftsregeln", { headers: { cookie: `rb_session=${yardSession}` } }));
report(yardRules.includes("Ändern kann diese Werte nur der Inhaber") && !yardRules.includes("Speichern"), "Hofmitarbeiter: Geschäftsregeln nur lesen");
// Disponent: Vertrag bearbeiten, Buchung anlegen, keine Einstellungen
const dispo = await db.user.create({ data: { tenantId: w.tenantId, email: `dispo-${Date.now()}@example.test`, name: "Dispo", passwordHash: "x", role: "DISPO" } });
const dispoSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: dispoSession, userId: dispo.id, expiresAt: new Date(Date.now() + 3600_000) } });
const dispoDraft = await fetch(`${base}/buchungen/${w.bookingId}/vertrag?schritt=4`, { headers: { cookie: `rb_session=${dispoSession}` } });
report(dispoDraft.status === 200 && (await dispoDraft.text()).includes("Konditionen"), `${dispoDraft.status} Disponent: Vertragsentwurf bearbeiten`);
const dispoNew = await fetch(base + "/buchungen/neu", { headers: { cookie: `rb_session=${dispoSession}` } });
report(dispoNew.status === 200, `${dispoNew.status} Disponent: neue Buchung`);
const dispoTerms = await plain(await fetch(`${base}/einstellungen/mietbedingungen/${termsPub.id}`, { headers: { cookie: `rb_session=${dispoSession}` } }));
report(dispoTerms.includes("Inhalt der Fassung") && !dispoTerms.includes("Archivieren") && !dispoTerms.includes("Neue Fassung erstellen"), "Disponent: Fassungen ansehen, nicht veröffentlichen oder archivieren");
const dispoRules = await plain(await fetch(base + "/einstellungen/geschaeftsregeln", { headers: { cookie: `rb_session=${dispoSession}` } }));
report(dispoRules.includes("Ändern kann diese Werte nur der Inhaber"), "Disponent: Geschäftsregeln nur lesen");
// Inhaber (Testsitzung ist OWNER): Vertragsentwurf und Einstellungen
const ownerDraft = await fetch(`${base}/buchungen/${w.bookingId}/vertrag?schritt=7`, { headers: { cookie } });
report(ownerDraft.status === 200 && (await ownerDraft.text()).includes("Mietvertrag verbindlich abschließen"), `${ownerDraft.status} Inhaber: Vertrag abschließen sichtbar`);

const anon = await fetch(base + "/heute", { redirect: "manual" });
report(anon.status === 307 && (anon.headers.get("location") ?? "").includes("/login"), `${anon.status} /heute ohne Sitzung leitet zum Login`);
// Abgelaufene Sitzung: keine Endlosschleife zwischen Startseite und Login, das alte Cookie wird entfernt
const stale = { cookie: "rb_session=gibt-es-nicht-mehr" };
const staleHome = await fetch(base + "/heute", { headers: stale, redirect: "manual" });
const staleLogin = await fetch(base + "/login?abgelaufen=1", { headers: stale, redirect: "manual" });
report(staleHome.status === 307 && (staleHome.headers.get("location") ?? "").includes("/login?abgelaufen=1") && staleLogin.status === 200 && (staleLogin.headers.get("set-cookie") ?? "").includes("rb_session=;"), `${staleHome.status}/${staleLogin.status} abgelaufene Sitzung landet sauber beim Login`);

// Gutschriften, Stornobelege & Kundenguthaben (Phase 17): Belegkette, Assistenten, Nummernkreise, Liste, Dashboard, Rollen, Mandantentrennung
const chainPage = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(["Belegkette", "Gutschrift erstellen", "Rechnung stornieren", "Berichtigen, Gutschrift oder Storno", "Verbleibende Forderung"].every((t) => chainPage.includes(t)), "Rechnung: Belegkette mit Aktionen und Erklärung");
const creditDraft = await createCreditNoteDraft(w.tenantId, invoice.id, w.actor);
const creditPage = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${creditDraft.id}`, { headers: { cookie } }));
report(["Gutschrift (Entwurf)", "Zu Rechnung", "Positionen der Rechnung", "Restbetrag vollständig gutschreiben", "Manuelle Gutschriftpositionen", "Grund der Gutschrift", "Wirkung auf die Rechnung", "Gutschrift finalisieren", "Entwurf verwerfen", "Vorschau des Belegs"].every((t) => creditPage.includes(t)), "Gutschrift: Entwurfsseite mit Positionen, Grund, Vorschau und Abschluss");
const blockedPage = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(!blockedPage.includes("Rechnung bearbeiten") && blockedPage.includes("Entwurf einer Gutschrift") && blockedPage.includes("Entwurf eines Gegenbelegs ist offen"), "Rechnung: mit offenem Gutschrift-Entwurf keine Berichtigung");
const creditItems = await db.invoiceVersionItem.findMany({ where: { versionId: fassung2.id }, orderBy: { sortOrder: "asc" } });
await updateCounterDocumentDraft(w.tenantId, creditDraft.id, w.actor, { items: [{ sourceItemId: creditItems[0].id, mode: "AMOUNT", grossAmount: "10" }], reason: "Kulanz nach Rücksprache" });
const creditVersion = await finalizeCounterDocument(w.tenantId, creditDraft.id, w.actor, { confirmed: true });
const creditNumber = (await db.invoice.findUniqueOrThrow({ where: { id: creditDraft.id } })).number!;
const creditPdf = await ensureInvoiceDocument(w.tenantId, creditVersion.id, w.actor.id);
const creditFinal = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${creditDraft.id}&abgeschlossen=1`, { headers: { cookie } }));
report(creditNumber.startsWith("GS-") && [`Gutschrift ${creditNumber}`, "Finalisiert", "Wirkung: Minderung", "Belegkette", `Gutschrift_${creditNumber}.pdf`, "E-Mail mit Gutschrift", "Gutschrift jetzt senden", "Kulanz nach Rücksprache", "abgeschlossen und versiegelt"].every((t) => creditFinal.includes(t)) && !creditFinal.includes("Zahlung erfassen"), `Gutschrift ${creditNumber}: abgeschlossene Ansicht mit PDF, Versand und Kette, ohne Zahlungen`);
const creditDoc = await fetch(`${base}/api/documents/${creditPdf.document.id}?download=1`, { headers: { cookie } });
report(creditDoc.status === 200 && (creditDoc.headers.get("content-disposition") ?? "").includes(`Gutschrift_${creditNumber}.pdf`), `${creditDoc.status} Gutschrift-PDF herunterladen`);
const afterCredit = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(["Teilweise gutgeschrieben", "Wirksame Forderung", creditNumber, "nicht mehr berichtigt"].every((t) => afterCredit.includes(t)) && !afterCredit.includes("Rechnung bearbeiten"), "Rechnung: teilweise gutgeschrieben, Kette zeigt Gutschrift, keine Berichtigung mehr");
const listCredited = await plain(await fetch(base + "/rechnungen?filter=gutgeschrieben", { headers: { cookie } }));
report(listCredited.includes(finalInvoice.number) && listCredited.includes("Teilweise gutgeschrieben"), "Rechnungsliste: Filter Gutgeschrieben");
const listDocs = await plain(await fetch(base + "/rechnungen?beleg=gutschriften&filter=alle", { headers: { cookie } }));
report(listDocs.includes(creditNumber) && listDocs.includes("Gutschrift") && listDocs.includes(finalInvoice.number), "Rechnungsliste: Gutschriften als eigene Zeilen mit Bezug");
const stornoDraft = await createCancellationDraft(w.tenantId, invoice.id, w.actor);
const stornoPage = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${stornoDraft.id}`, { headers: { cookie } }));
report(["Stornobeleg (Entwurf)", "Storno der Rechnung", "Bereits gutgeschrieben", "Stornobetrag (verbleibender Rest)", "Grund des Stornos", "Stornobeleg finalisieren", "Kundenguthaben danach"].every((t) => stornoPage.includes(t)), "Storno: Entwurfsseite mit Wirkung, Zahlungen und Erstattungsbedarf");
const stornoVersion = await finalizeCounterDocument(w.tenantId, stornoDraft.id, w.actor, { confirmed: true, reason: "Rechnung insgesamt zurückgenommen" });
await ensureInvoiceDocument(w.tenantId, stornoVersion.id, w.actor.id);
const afterStorno = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(afterStorno.includes("Storniert") && afterStorno.includes("Kundenguthaben") && afterStorno.includes("Erstattung erforderlich") && !afterStorno.includes("Gutschrift erstellen") && afterStorno.includes("weitere Gegenbelege sind nicht möglich"), "Rechnung: storniert, Guthaben aus der Zahlung ausgewiesen, keine weiteren Belege");
const listRefund = await plain(await fetch(base + "/rechnungen?filter=erstattung", { headers: { cookie } }));
report(listRefund.includes(finalInvoice.number) && listRefund.includes("Erstattung") && listRefund.includes("Storniert"), "Rechnungsliste: Filter Erstattung erforderlich mit Storno-Kennzeichen");
const todayRefund = await plain(await fetch(base + "/heute", { headers: { cookie } }));
report(todayRefund.includes("Rechnungserstattungen offen") && todayRefund.includes("noch auszuzahlen"), "Dashboard: offene Rechnungserstattungen aus der zentralen Summierung");
const bookingChain = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(bookingChain.includes("Gutschriften / Storno") && bookingChain.includes(creditNumber), "Buchung: Gegenbelege sichtbar");
const settingsRanges = await plain(await fetch(base + "/einstellungen", { headers: { cookie } }));
report(settingsRanges.includes("Nummernkreise der Belege") && settingsRanges.includes("RE · GS · ST"), "Einstellungen: Nummernkreise-Karte");
const rangesPage = await plain(await fetch(base + "/einstellungen/nummernkreise", { headers: { cookie } }));
report(["Präfix Rechnungen", "Präfix Gutschriften", "Präfix Stornobelege", "Nummernkreise speichern", "Nächste Nummer", "Abgeschlossene Gutschriften"].every((t) => rangesPage.includes(t)), "Nummernkreise: Formular mit nächsten Nummern");
const foreignCredit = await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${creditDraft.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignCredit.status === 404, `${foreignCredit.status} Gutschrift für fremden Mandanten nicht auffindbar`);
await db.user.update({ where: { id: w.userId }, data: { role: "YARD" } });
const yardCredit = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung?nr=${creditDraft.id}`, { headers: { cookie } }));
report(yardCredit.includes(`Gutschrift ${creditNumber}`) && !yardCredit.includes("Gutschrift jetzt senden") && !yardCredit.includes("Interne Notiz"), "Hofmitarbeiter: Gutschrift lesbar, kein Versand, keine interne Notiz");
const yardChain = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(yardChain.includes("Belegkette") && !yardChain.includes("Gutschrift erstellen") && !yardChain.includes("Rechnung stornieren"), "Hofmitarbeiter: Belegkette lesbar, keine Aktionen");
const yardRanges = await plain(await fetch(base + "/einstellungen/nummernkreise", { headers: { cookie } }));
report(yardRanges.includes("nur lesend") && !yardRanges.includes("Nummernkreise speichern"), "Hofmitarbeiter: Nummernkreise nur lesend");
await db.user.update({ where: { id: w.userId }, data: { role: "OWNER" } });

// Auszahlungen, Erstattungen & Kautionsrückzahlung (Phase 18)
const payoutsOpen = await plain(await fetch(base + "/auszahlungen", { headers: { cookie } }));
report(["Auszahlungen", "Offene Ansprüche", "Rechnungserstattung", finalInvoice.number, "Kautionsauszahlung", "RET-1", "Entwürfe", "Alle Wege"].every((t) => payoutsOpen.includes(t)), "Auszahlungen: offene Ansprüche aus Storno-Guthaben und Kautionsfreigabe ohne Entwurf sichtbar");
const invRefund = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(["Erstattungen an den Kunden", "Erstattung erfassen", "Noch auszuzahlen", "Zahlung stornieren:", "Erstattung erfassen:"].every((t) => invRefund.includes(t)), "Rechnung: Erstattungsbereich mit Erklärung Zahlungsstorno vs. Erstattung");
const bookingDep = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(["Zur Auszahlung freigegeben", "Tatsächlich ausgezahlt", "Noch auszuzahlen", "Kautionsauszahlung (tatsächlicher Geldfluss)", "Kaution auszahlen"].every((t) => bookingDep.includes(t)), "Buchung: Kaution mit Auszahlungsdimension und Aktion");
const refundDraft = (await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId: invoice.id }, { amount: "40", method: "BANK_TRANSFER", iban: "DE02120300000000202051", executedAt: new Date(Date.now() - 3600_000), reference: "Erstattung Storno" }, { complete: false })).payout;
const payoutDraftPage = await plain(await fetch(`${base}/auszahlungen/${refundDraft.id}`, { headers: { cookie } }));
report(["Auszahlungsbeleg Entwurf", "Entwurf: Es ist noch kein Geldfluss dokumentiert", "Entwurf bearbeiten", "Als tatsächlich erfolgt erfassen", "Entwurf aufheben", "DE** **** **** **** **20 51", "Heute noch auszuzahlen"].every((t) => payoutDraftPage.includes(t)) && !payoutDraftPage.includes("Nachweis hochladen"), "Auszahlung: Entwurfsseite mit Bearbeitung, Abschluss und verkürzter IBAN");
const refund = (await createPayout(w.tenantId, w.actor, { sourceType: "INVOICE_REFUND", invoiceId: invoice.id }, { amount: "40", method: "CASH", executedAt: new Date(Date.now() - 3600_000), receiptConfirmed: true }, { complete: true, confirmed: true })).payout;
const refundPdf = await ensurePayoutDocument(w.tenantId, refund.id, w.actor.id);
const payoutPage = await plain(await fetch(`${base}/auszahlungen/${refund.id}`, { headers: { cookie } }));
report(refund.number!.startsWith("AZ-") && [`Auszahlungsbeleg ${refund.number}`, "Ausgezahlt", "Barauszahlung", "Erstattung zu Rechnung", "Auszahlungsbeleg per E-Mail senden", "Herunterladen", "Nachweis hochladen", "Auszahlung stornieren (Fehlbuchung)", "Empfang bestätigt", "Prüfsumme"].every((t) => payoutPage.includes(t)), `Auszahlung ${refund.number}: Detailseite mit Beleg, Nachweis, Versand, Storno`);
const payoutDoc = await fetch(`${base}/api/documents/${refundPdf.document.id}?download=1`, { headers: { cookie } });
report(payoutDoc.status === 200 && (payoutDoc.headers.get("content-disposition") ?? "").includes(`Auszahlungsbeleg_${refund.number}.pdf`), `${payoutDoc.status} Auszahlungsbeleg-PDF herunterladen`);
const attUp = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "quittung.jpg"); return fetch(`${base}/api/payouts/${refund.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
report(attUp.status === 201, `${attUp.status} Auszahlung: Nachweis hochgeladen`);
const attId = ((await attUp.json()) as { id: string }).id;
const attGet = await fetch(`${base}/api/documents/${attId}`, { headers: { cookie } });
report(attGet.status === 200 && (attGet.headers.get("content-type") ?? "").includes("image/jpeg"), `${attGet.status} Auszahlung: Nachweis mit richtigem Inhaltstyp abrufbar`);
const payoutList = await plain(await fetch(base + "/auszahlungen?filter=abgeschlossen", { headers: { cookie } }));
report(payoutList.includes(refund.number!) && payoutList.includes("Rechnungserstattung") && payoutList.includes("40,00"), "Auszahlungsliste: abgeschlossene Auszahlung mit Quelle");
const invAfterRefund = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(invAfterRefund.includes(refund.number!) && invAfterRefund.includes("40,00") && invAfterRefund.includes("noch auszuzahlen 60,00"), "Rechnung: Auszahlungshistorie und Rest nach Teilerstattung");
const listRefundOpen = await plain(await fetch(base + "/rechnungen?filter=erstattung", { headers: { cookie } }));
report(listRefundOpen.includes(finalInvoice.number) && listRefundOpen.includes("Erstattung 60,00"), "Rechnungsliste: noch zu erstattender Rest");
const depPayout = (await createPayout(w.tenantId, w.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: retBooking.id }, { amount: "350", method: "BANK_TRANSFER", iban: "DE02120300000000202051", executedAt: new Date(Date.now() - 3600_000), reference: "Kaution RET-1" }, { complete: true, confirmed: true })).payout;
const bookingDep2 = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(depPayout.sourceType === "SECURITY_DEPOSIT_REFUND" && bookingDep2.includes(depPayout.number!) && bookingDep2.includes("ausgezahlt 350,00") && !bookingDep2.includes("Kaution auszahlen"), "Buchung: Kaution vollständig ausgezahlt, keine weitere Auszahlung");
const todayPayouts = await plain(await fetch(base + "/heute", { headers: { cookie } }));
report(todayPayouts.includes("Rechnungserstattungen offen") && todayPayouts.includes("60,00"), "Dashboard: offene Rechnungserstattungen aus der zentralen Summierung");
const customerPage = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=finanzen`, { headers: { cookie } }));
report(customerPage.includes("Auszahlungen") && customerPage.includes(refund.number!), "Kunde: Auszahlungsreferenz");
const rangesPayout = await plain(await fetch(base + "/einstellungen/nummernkreise", { headers: { cookie } }));
report(rangesPayout.includes("Präfix Auszahlungen") && rangesPayout.includes("AZ-"), "Nummernkreise: Kreis Auszahlungen");
const foreignPayout = await fetch(`${base}/auszahlungen/${refund.id}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignPayout.status === 404, `${foreignPayout.status} Auszahlung für fremden Mandanten nicht auffindbar`);
const foreignUpload = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "x.jpg"); return fetch(`${base}/api/payouts/${refund.id}/documents`, { method: "POST", body: fd, headers: { cookie: `rb_session=${foreignSession}` } }); })();
report(foreignUpload.status === 403 || foreignUpload.status === 404, `${foreignUpload.status} Nachweis-Upload für fremden Mandanten abgelehnt`);
await db.user.update({ where: { id: w.userId }, data: { role: "YARD" } });
const yardPayout = await plain(await fetch(`${base}/auszahlungen/${refund.id}`, { headers: { cookie } }));
report(yardPayout.includes(`Auszahlungsbeleg ${refund.number}`) && !yardPayout.includes("vollständig anzeigen") && !yardPayout.includes("Auszahlung stornieren") && !yardPayout.includes("Nachweis hochladen") && !yardPayout.includes("per E-Mail senden"), "Hofmitarbeiter: Auszahlung lesbar, keine volle IBAN, keine Aktionen");
const yardInvRefund = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(yardInvRefund.includes("Auszahlungen erfasst die Disposition") && !yardInvRefund.includes(">Erstattung erfassen<"), "Hofmitarbeiter: keine Erstattung erfassen");
const yardPayoutUpload = await (async () => { const fd = new FormData(); fd.set("file", new Blob([jpeg], { type: "image/jpeg" }), "x.jpg"); return fetch(`${base}/api/payouts/${refund.id}/documents`, { method: "POST", body: fd, headers: { cookie } }); })();
report(yardPayoutUpload.status === 403, `${yardPayoutUpload.status} Hofmitarbeiter: kein Nachweis-Upload`);
await db.user.update({ where: { id: w.userId }, data: { role: "OWNER" } });

// Phase 19: Sicherheitskopfzeilen, Kundenakte nach den Vorgängen, Suche nach allen Nummernarten, Dashboard, Rollen, fremder Mandant
const headRes = await fetch(base + "/heute", { headers: { cookie } });
report(headRes.headers.get("x-content-type-options") === "nosniff" && (headRes.headers.get("referrer-policy") ?? "").includes("strict-origin") && headRes.headers.get("x-frame-options") === "DENY" && (headRes.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"), "Sicherheitskopfzeilen gesetzt (nosniff, Referrer, Frame, frame-ancestors)");
const akteUeb = await plain(await fetch(`${base}/kunden/${w.customerId}`, { headers: { cookie } }));
report(akteUeb.includes("Offene Forderungen") && akteUeb.includes("Guthaben / Erstattung offen") && akteUeb.includes("Kautionen auszuzahlen") && akteUeb.includes("Offene Akten") && akteUeb.includes("Bearbeiten") && akteUeb.includes("+ Neue Buchung"), "Kundenakte: Übersichtskarten und Aktionen");
const akteFin = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=finanzen`, { headers: { cookie } }));
report(akteFin.includes(finalInvoice.number) && akteFin.includes(refund.number!) && akteFin.includes(depPayout.number!) && akteFin.includes("Storniert") && akteFin.includes("Gutschrift"), "Kundenakte Finanzen: Belege, Zahlungen mit Storno, Auszahlungen, Gutschrift");
const akteKau = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=kautionen`, { headers: { cookie } }));
report(akteKau.includes("RET-1") && akteKau.includes("Ausgezahlt") && akteKau.includes("350,00"), "Kundenakte Kautionen: Stand je Buchung mit Auszahlung");
const akteSch = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=schaeden`, { headers: { cookie } }));
report(akteSch.includes(dc.caseNumber) && !akteSch.includes("Steinschlag ohne Miete"), "Kundenakte Schäden: nur Akten mit Bezug, hofinterner Schaden fehlt");
const akteDok = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=dokumente`, { headers: { cookie } }));
report(akteDok.includes("/api/documents/") && akteDok.includes("Mietvertrag") && akteDok.includes("Auszahlungsbeleg") && !/https?:\/\/[^"]*\.(pdf|jpg)/.test(akteDok), "Kundenakte Dokumente: geschützte Adressen, keine öffentlichen Links");
const akteKom = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=kommunikation`, { headers: { cookie } }));
report(akteKom.includes("E-Mail-Verlauf") && akteKom.includes("erika@example.test"), "Kundenakte Kommunikation: Versandprotokoll");
const akteBh = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=behoerden`, { headers: { cookie } }));
report(akteBh.includes(bhCase.caseNumber), "Kundenakte Behörden: Vorgang mit bestätigtem Fahrer");
const akteHist = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=historie`, { headers: { cookie } }));
report(akteHist.includes("Mietvertrag") && akteHist.includes("Rechnung") && akteHist.includes("Zahlung") && akteHist.includes("Auszahlung"), "Kundenakte Historie: Zeitleiste aus gespeicherten Ereignissen");
for (const [q, expect] of [[finalInvoice.number, "Rechnung " + finalInvoice.number], [refund.number!, "Auszahlung " + refund.number], [dc.caseNumber, "Schadenakte " + dc.caseNumber], [maintRes.record.maintenanceNumber, maintRes.record.maintenanceNumber], [bhCase.caseNumber, bhCase.caseNumber], [retContract.number, "Mietvertrag " + retContract.number], [creditNumber, "Gutschrift " + creditNumber]] as [string, string][]) {
  const s = await plain(await fetch(`${base}/suche?q=${encodeURIComponent(q)}`, { headers: { cookie } }));
  report(s.includes(expect), `Suche „${q}“ findet ${expect}`);
}
const dash = await plain(await fetch(base + "/heute", { headers: { cookie } }));
report(dash.includes("Überfällig") && dash.includes("Hinweise") && dash.includes("Heute auf dem Hof") && dash.includes("Rechnungserstattungen offen") && dash.includes("Fehlende Dokumente") && dash.includes("E-Mail-Probleme"), "Dashboard: Gruppen, Kennzahlen, Hinweise");
await db.user.update({ where: { id: w.userId }, data: { role: "YARD" } });
const yardAkte = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=finanzen`, { headers: { cookie } }));
report(yardAkte.includes("Wirksames Rechnungsvolumen") && !/DE02120300000000202051/.test(yardAkte), "Hofmitarbeiter: Kundenakte lesbar, keine volle IBAN");
const yardDok = await plain(await fetch(`${base}/kunden/${w.customerId}?tab=dokumente`, { headers: { cookie } }));
report(!yardDok.includes("/api/authority-documents/") && yardDok.includes("Behördendokumente sind der Disposition vorbehalten"), "Hofmitarbeiter: keine Behördendokumente in der Kundenakte");
const yardSearch = await plain(await fetch(base + "/suche?q=muster", { headers: { cookie } }));
report(yardSearch.includes("Muster") && !yardSearch.includes("FIN "), "Hofmitarbeiter: Suche ohne FIN");
await db.user.update({ where: { id: w.userId }, data: { role: "OWNER" } });
const foreignAkte = await fetch(`${base}/kunden/${w.customerId}`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignAkte.status === 404, `${foreignAkte.status} Kundenakte für fremden Mandanten nicht auffindbar`);
const foreignSearch = await plain(await fetch(`${base}/suche?q=${encodeURIComponent(finalInvoice.number)}`, { headers: { cookie: `rb_session=${foreignSession}` } }));
report(foreignSearch.includes("Nichts gefunden"), "Suche: fremder Mandant findet die Rechnung nicht");
const anonSearch = await fetch(base + "/suche?q=muster", { redirect: "manual" });
report(anonSearch.status === 307 || anonSearch.status === 302, `${anonSearch.status} Suche ohne Sitzung leitet zum Login`);

if (keep) {
  console.log(`\nTestdaten bleiben stehen.\nSITZUNG=${sessionId}\nBUCHUNG=${w.bookingId}\nRUECKGABE_ENTWURF=${doneBooking.id}\nRUECKGABE_FERTIG=${retBooking.id}\nRET_DAMAGE=${retDamage.id} UEBERGEBEN=${doneBooking.id} BEREIT=${signedBooking.id}\nVERTRAG=${draft.number}\nMANDANTEN=${w.tenantId},${foreign.tenantId}`);
} else {
  await purgeTenants([w.tenantId, foreign.tenantId]);
}
await db.$disconnect();
console.log(failed === 0 ? "\nAlle Seiten in Ordnung." : `\n${failed} Prüfung(en) fehlgeschlagen.`);
process.exit(failed === 0 ? 0 : 1);
