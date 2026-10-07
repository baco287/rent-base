// Rauchtest der Seiten gegen den laufenden Dev-Server (npm run dev) und die lokale Datenbank.
// Legt einen Testmandanten mit Sitzung an, ruft jede Seite auf und räumt danach auf.
// Aufruf: npx tsx tests/smoke-pages.mts [http://localhost:3000] [--keep]
//   --keep  lässt die Testdaten stehen und gibt Sitzung und Buchung aus (für die Sichtprüfung im Browser)
// Lokal gegen PGlite: Entwicklungsserver und Rauchtest mit RB_TX_MAX_WAIT_MS=20000 starten (siehe src/lib/db.ts) –
//   PGlite bedient Verbindungen nacheinander; ohne längere Wartezeit kann ein Transaktionsbeginn mit P2028 abbrechen.
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { createAccidentCase, createFollowUp } from "../src/lib/accident-replacement";
import { answerChecklist, finalizeHandover, getHandoverContentHash, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft, addNewDamage } from "../src/lib/handovers";
import { buildStorageKey } from "../src/lib/storage";
import { sha256 } from "../src/lib/integrity";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { createWorld, fakeSignaturePng, purgeTenants } from "./helpers";
import { ensureContractDocument, ensurePickupDocument, ensureReturnDocument } from "../src/lib/documents";
import { addManualCharge, confirmProposal } from "../src/lib/returns";
import { ensureInvoiceDocument } from "../src/lib/documents";
import { createGeneralInvoiceDraft, ensureInvoiceDraft, finalizeInvoice, startInvoiceEdit, updateInvoiceDraft } from "../src/lib/invoices";
import { recordInvoicePayment } from "../src/lib/payments";
import { recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { chargeCustomer, openDamageCase, setLiability } from "../src/lib/damage-cases";
import { reportDamage } from "../src/lib/damages";
import { completeMaintenance, createMaintenance, createPlan, setMaintenanceCosts } from "../src/lib/maintenance";
import { approveResponse, createAuthorityCase, prepareResponse, setDriver, submitResponse } from "../src/lib/authority";
import { acknowledgeTerms, adoptContractDefaults } from "../src/lib/contracts";
import { createTermsDraft, publishTermsVersion } from "../src/lib/rental-terms";
import { createCancellationDraft, createCreditNoteDraft, finalizeCounterDocument, updateCounterDocumentDraft } from "../src/lib/counter-documents";
import { createPayout } from "../src/lib/payouts";
import { ensurePayoutDocument } from "../src/lib/documents";
import { toDateInputValue, zonedParts } from "../src/lib/time";
import { toDateTimeInput } from "../src/lib/format";
import { confirmVerification, recordIdentityCheck, recordLicenseCheck, startOrGetVerification } from "../src/lib/driver-verification";
import { hashPassword } from "../src/lib/password";
import { createTenantByPlatform, suspendTenant, reactivateTenant } from "../src/lib/platform-tenants";
import { acceptInvitation } from "../src/lib/invitations";
import { requestPasswordReset } from "../src/lib/password-reset";
import { endSupportSession, startSupportSession } from "../src/lib/support-sessions";
import { createDunningNotice, previewDunning } from "../src/lib/dunning";
import { ensureDunningDocument } from "../src/lib/documents";
import { returnedWorld } from "./rental-flow";
import { setTenantFeature } from "../src/lib/features";
import { createRatePlan } from "../src/lib/tariff-admin";
import { upsertSubscription } from "../src/lib/subscriptions";
import { setMailTransport, type MailMessage, type MailTransport } from "../src/lib/mail";
import { saveMailSettings } from "../src/lib/tenant-mail";
import { authorizeKeyDrop, confirmKeyDrop, saveKeyDropSettings, sendKeyDropLink } from "../src/lib/key-drop";
import { pickedUpWorld } from "./rental-flow";
import { createAmendmentDraft, getAmendmentContentHash, saveAmendmentSignature, signAmendment, updateAmendmentDraft } from "../src/lib/amendments";
import { ensureAmendmentDocument } from "../src/lib/documents";
import { discardEmptyReturnDraft } from "../src/lib/handovers";
import { changeBookingStatus } from "../src/lib/booking-status";
import { cancelBooking } from "../src/lib/cancellation";
import { runCancellationFollowUp } from "../src/lib/followup";
import { recordRentalPayment } from "../src/lib/rental-payments";
import { agreeAmendment } from "../src/lib/amendments";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3000";

const w = await createWorld("smoke");
await db.user.update({ where: { id: w.userId }, data: { role: "OWNER" } });
// Befehl 20: zweiter Inhaber, damit w.userId testweise auf andere Rollen umgeschaltet werden kann – der letzte
// aktive Inhaber eines Mandanten lässt sich nicht mehr herabstufen (item 28, DB-Trigger rb_guard_last_owner).
await db.user.create({ data: { tenantId: w.tenantId, email: `zweiter-inhaber-${Date.now()}@example.test`, name: "Zweiter Inhaber", passwordHash: await hashPassword("zweiterinhaberpasswort1"), role: "OWNER" } });
// Phase 19.5: erforderliche Fahrerlaubnisklasse für die Fahrzeuggruppe konfigurieren (sonst blockiert die Übergabe bewusst)
await db.vehicleGroup.update({ where: { id: w.groupId }, data: { requiredLicenseClass: "B" } });
const sessionId = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: sessionId, userId: w.userId, expiresAt: new Date(Date.now() + 6 * 3600_000) } });
const cookie = `rb_session=${sessionId}`;

// Phase 19.5: jeden laut Vertrag vorgesehenen Fahrer identifizieren und die Fahrerlaubnis prüfen (sonst blockiert die Übergabe bewusst)
async function verifyAllDrivers(handoverId: string, contractId: string) {
  const drivers = await db.contractDriver.findMany({ where: { tenantId: w.tenantId, contractId } });
  for (const d of drivers) {
    const v = await startOrGetVerification(w.tenantId, w.actor, handoverId, d.id);
    await recordIdentityCheck(w.tenantId, w.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: true });
    await recordLicenseCheck(w.tenantId, w.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: d.licenseNumber, licenseCountry: d.licenseCountry, licenseIssuedAt: d.licenseIssuedAt, licenseValidUntil: d.licenseValidUntil, licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false });
    await confirmVerification(w.tenantId, w.actor, v.id);
  }
}

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
await verifyAllDrivers(done.id, doneContract.id);
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
await verifyAllDrivers(retPickup.id, retContract.id);
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
  [`/buchungen/${retBooking.id}/rueckgabe`, "Rückgabeprotokoll"],
  [`/fahrzeuge/${v4.id}`, "Nächste Fälligkeiten"],
  [`/fahrzeuge/${v4.id}?tab=schaeden`, "Schadenakte"],
  [`/fahrzeuge/${v4.id}?tab=historie`, "Rückgabe"],
  ["/heute", "Abholungen heute"],
  ["/dispo", "Dispo-Kalender"],
  ["/fahrzeuge", "HB-RT 200"],
  ["/fahrzeuge/gruppen", "kein Tarif – Buchungen erst nach Zuordnung möglich"],
  ["/einstellungen/tarife", "Miettarife"],
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
  // Befehl 29.2: der Umschalter im Formular – „+ Neuer Kunde“ steht jetzt auch in der Kopfleiste jeder Seite
  ["/buchungen/neu", ">Neuer Kunde</button>"],
  ["/buchungen/neu", "Miete &amp; Kaution"],
  ["/buchungen/neu", "Teilweise bezahlt"],
  ["/buchungen/neu", "Kaution jetzt erhalten"],
  [`/buchungen/${w.bookingId}`, "Mietvertrag fortsetzen"],
  [`/buchungen/${w.bookingId}`, "Gesamtpreis (voraussichtlich)"],
  [`/buchungen/${w.bookingId}`, "Noch keine Mietzahlung erfasst"],
  [`/buchungen/${signedBooking.id}`, "Gesamtpreis laut Vertrag"],
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
  [`/buchungen/${signedBooking.id}/vertrag`, "Unterschriften"],
  // Übergabe-Assistent, alle sieben Schritte
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=1`, "Bekannte Schäden"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=2`, "Tankstand in Achteln"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=3`, "gilt als Vorschaden"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=4`, "Kilometerstand"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=5`, "Reifen und Felgen"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=6`, "Fahrer &amp; Dokumente"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=7`, "Unterschrift Mieter"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=8`, "Übergabe verbindlich abschließen"],
  // finalisiertes Protokoll eines Elektrofahrzeugs
  [`/buchungen/${doneBooking.id}/uebergabe`, "Übergabeprotokoll"],
  [`/buchungen/${doneBooking.id}/uebergabe`, "Batteriestand"],
  [`/buchungen/${doneBooking.id}/uebergabe`, "Fahrer- und Führerscheinprüfung"],
  [`/buchungen/${doneBooking.id}/uebergabe`, "Identität im Original geprüft: Ja"],
  [`/buchungen/${signedBooking.id}/uebergabe?schritt=6`, "Fahrer &amp; Dokumente"], // Befehl 20.9: bekannter Fahrer → Wiederholungsprüfung statt „Prüfung für … beginnen“
  [`/buchungen/${w.bookingId}/uebergabe`, "erst möglich, wenn der Mietvertrag abgeschlossen ist"],
];

let failed = 0;
const report = (ok: boolean, text: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FEHL"} ${text}`);
};
for (const [path, expect] of pages) {
  const res = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
  const body = res.status === 200 ? (await res.text()).replace(/<!-- -->/g, "") : "";
  const ok = res.status === 200 && body.includes(expect);
  report(ok, `${res.status} ${path}${ok ? "" : `  (erwartet: "${expect}")`}`);
}

// Befehl 20.8: Prüfsummen bleiben in Datenbank und Integritätsprüfung, erscheinen aber nicht in der normalen Oberfläche
for (const path of [`/buchungen/${retBooking.id}`, `/buchungen/${retBooking.id}/vertrag`, `/buchungen/${retBooking.id}/rueckgabe`, `/buchungen/${retBooking.id}/uebergabe`]) {
  const html = await (await fetch(base + path, { headers: { cookie }, redirect: "manual" })).text();
  report(!/SHA-256|Prüfsumme des/.test(html), `Keine Prüfsumme in der normalen Oberfläche: ${path}`);
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
  [`/buchungen/${doneBooking.id}/uebergabe?schritt=3`, "Übergabeprotokoll"],
  [`/buchungen/${retBooking.id}/rueckgabe?schritt=2`, "Rückgabeprotokoll"],
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
report([`Rechnung ${finalInvoice.number}`, "Finalisiert", "Aktuelle Fassung 1", "Noch nicht übermittelt", "Fassungsverlauf", "Rechnung bearbeiten", "Als an Kunden übergeben markieren", "Rechnungsbetrag", `Rechnung_${finalInvoice.number}_Fassung1.pdf`, "Herunterladen", "E-Mail mit Rechnung", "Rechnung jetzt senden", "Interne Notiz"].every((t) => invFinal.includes(t)) && !invFinal.includes("Entwurf speichern"), "Rechnung: abgeschlossene Ansicht mit Fassungsverlauf, Dokument und E-Mail-Bereich");
const invDoc = await fetch(`${base}/api/documents/${invoicePdf.document.id}?download=1`, { headers: { cookie } });
report(invDoc.status === 200 && (invDoc.headers.get("content-disposition") ?? "").includes(`Rechnung_${finalInvoice.number}_Fassung1.pdf`) && (await invDoc.arrayBuffer()).byteLength === invoicePdf.document.sizeBytes, `${invDoc.status} Rechnungs-PDF herunterladen`);
const retBookingHtml2 = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(retBookingHtml2.includes(`Rechnung ${finalInvoice.number} anzeigen`) && retBookingHtml2.includes("abgeschlossen"), "Buchung: Rechnung anzeigen und Status");

// Zahlungen und Kaution (Phase 9): Buchungsseite mit getrennten Bereichen, Rechnungsseite mit Saldo, Rechnungsliste, Dashboard
const bookingFin0 = await plain(await fetch(`${base}/buchungen/${retBooking.id}`, { headers: { cookie } }));
report(["Mietzahlung", "Zahlung erfassen", "Kaution", "Kaution als erhalten erfassen", "Noch nicht erhalten", "Kautionshistorie", "Zahlungshistorie", "Offen"].every((t) => bookingFin0.includes(t)), "Buchung: Bereiche Zahlungen und Kaution mit Aktionen");
const pickupNotice = await plain(await fetch(`${base}/buchungen/${signedBooking.id}/uebergabe?schritt=1`, { headers: { cookie } }));
report(pickupNotice.includes("noch nicht") && pickupNotice.includes("als erhalten dokumentiert") && pickupNotice.includes("Bekannte Schäden"), "Übergabe: Warnung Kaution nicht dokumentiert, Übergabe nicht blockiert");
const pay1 = await recordInvoicePayment(w.tenantId, w.actor, { invoiceId: invoice.id, amount: "100", method: "CASH", paidAt: new Date(Date.now() - 60_000), reference: "Beleg 77" });
const invPage = await plain(await fetch(`${base}/buchungen/${retBooking.id}/rechnung`, { headers: { cookie } }));
report(invPage.includes("Teilbezahlt") && invPage.includes("100,00") && invPage.includes("Beleg 77") && invPage.includes("Zahlung stornieren") && invPage.includes("Zahlung erfassen"), "Rechnung: Saldo, Status Teilbezahlt, Historie, Storno-Möglichkeit");
// Befehl 20.9: Karte „Kaution & Abrechnung“ auf der Rechnungsseite (Forderung + Kaution, Verrechnung nur bewusst)
report(invPage.includes("Kaution &amp; Abrechnung") && invPage.includes("Aktuell verfügbar") && invPage.includes("Wirksame Forderung"), "Rechnung: Karte Kaution &amp; Abrechnung mit Forderungs- und Kautionsseite");
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
// Vorschlag 4 / Befehl 29.2: Schnellaktionen und Suche in der Kopfleiste (nicht mehr doppelt in der Seitenleiste), Zähler und
// aktive Markierung am Menüpunkt, „Nächster Schritt“ und direkte Zeilenaktion
const navAside = /<aside[\s\S]*?<\/aside>/.exec(casesList)?.[0] ?? "";
const appHeader = /<header[\s\S]*?<\/header>/.exec(casesList)?.[0] ?? "";
const navLink = (aside: string, href: string) => new RegExp(`<a[^>]*href="${href.replace(/\//g, "\\/")}"[^>]*>[\\s\\S]*?</a>`).exec(aside)?.[0] ?? "";
report(appHeader.includes('href="/buchungen/neu"') && appHeader.includes("+ Neue Buchung") && appHeader.includes('href="/kunden/neu"') && appHeader.includes("+ Neuer Kunde") && appHeader.includes('aria-label="Suchen (Strg+K)"') && appHeader.includes('href="/fahrzeuge"'), "Kopfleiste: Suche, Fahrzeug suchen, + Neuer Kunde und + Neue Buchung (Inhaber)");
report(!navAside.includes('href="/buchungen/neu"') && !navAside.includes('href="/kunden/neu"') && !navAside.includes("Suchen (Strg+K)") && !navAside.includes("Suche öffnen"), "Seitenleiste: keine doppelten Schnellaktionen, keine zweite Suche");
report(navLink(navAside, "/schaeden").includes("offene Schadenakte") && navLink(navAside, "/schaeden").includes('aria-current="page"'), "Seitenleiste: Zähler an „Schäden“ mit Erklärung, aktiver Menüpunkt markiert");
const ownerNav = [...navAside.matchAll(/<a[^>]*href="(\/[^"]*)"/g)].map((m) => m[1]);
report(["/heute", "/buchungen", "/dispo", "/kunden", "/fahrzeuge", "/fahrzeuge/wartung", "/rechnungen", "/forderungen", "/auszahlungen", "/schaeden", "/behoerden", "/einstellungen"].every((h) => ownerNav.includes(h)) && !ownerNav.includes("/unfallersatz") && navAside.split('aria-current="page"').length === 2, "Seitenleiste: alle freigeschalteten Bereiche (Unfallersatz ohne Modul nicht), genau ein aktiver Eintrag");
report(casesList.includes("Nächster Schritt:") && casesList.includes(`href="/schaeden/${dc.id}#haftung"`) && casesList.includes("Haftung bewerten"), "Schäden: Nächster Schritt und Zeilenaktion führen zur Haftungsprüfung");
const caseAnchors = await plain(await fetch(`${base}/schaeden/${dc.id}`, { headers: { cookie } }));
report(["haftung", "kosten", "reparatur", "belastung", "abschluss", "fahrzeug"].every((a) => caseAnchors.includes(`id="${a}"`)), "Schadenakte: Sprungziele für die Zeilenaktionen vorhanden");
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
report(["Finanzen", "Schäden &amp; Wartung", "Behörden"].every((t) => todayDmg.includes(t)) && (todayDmg.match(/aria-expanded=/g) ?? []).length >= 3 && todayDmg.includes("Abholungen heute"), "Startseite: Tageskennzahlen oben, drei aufklappbare Bereiche mit Zusammenfassung");
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
report(yardSigned.status === 200 && (await yardSigned.text()).includes("Unterschriften"), `${yardSigned.status} Hofmitarbeiter: abgeschlossenen Vertrag ansehen`);
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
const yardCasesHtml = await plain(yardCases);
const yardAside = /<aside[\s\S]*?<\/aside>/.exec(yardCasesHtml)?.[0] ?? "";
const yardHeader = /<header[\s\S]*?<\/header>/.exec(yardCasesHtml)?.[0] ?? "";
report(!yardHeader.includes('href="/buchungen/neu"') && yardHeader.includes('href="/kunden/neu"') && !yardAside.includes('href="/buchungen/neu"') && !yardAside.includes('href="/kunden/neu"') && !yardCasesHtml.includes('href="/buchungen/neu"'), "Hofmitarbeiter: Schnellaktion nur „+ Neuer Kunde“, keine Buchung (Kopfleiste, Seitenleiste, ganze Seite)");
report(!yardCasesHtml.includes("Nächster Schritt:") && !yardCasesHtml.includes("Haftung bewerten") && yardCasesHtml.includes("Öffnen →"), "Hofmitarbeiter: kein Entscheidungshinweis, Zeilenaktion nur Öffnen");
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
report(bhNew.includes("Behördenschreiben erfassen") && bhNew.includes("Behördenschreiben hochladen") && bhNew.includes("Ohne Datei manuell erfassen") && bhNew.includes("nicht an Dritte übertragen"), "Behörden: Erfassung mit Upload (PDF wird gelesen) oder manuell");
// Posteingang (Behörden-Automatik): Upload mit Erkennung, nur Disposition
const bhIntake = await (async () => { const fd = new FormData(); fd.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "Anhoerung.pdf"); return fetch(`${base}/api/authority-uploads`, { method: "POST", body: fd, headers: { cookie } }); })();
const bhIntakeJson = (await bhIntake.json()) as { id?: string; suggestion?: object };
report(bhIntake.status === 201 && !!bhIntakeJson.id && typeof bhIntakeJson.suggestion === "object", `${bhIntake.status} Posteingang: Schreiben gespeichert, Vorschläge geliefert`);
const bhPage0 = await plain(await fetch(`${base}/behoerden/${bhCase.id}`, { headers: { cookie } }));
report(bhPage0.includes("Vorschlag: Prüfen") && bhPage0.includes("Freigeben und per E-Mail senden") && bhPage0.includes("Ich habe die Angaben mit dem Schreiben verglichen") && bhPage0.includes("Bearbeitungsentgelt"), "Behördenvorgang: Schnellweg mit Vorschau und Pflichtbestätigung, Entgelt-Hinweis");
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
const bhSettings = await plain(await fetch(base + "/behoerden/einstellungen", { headers: { cookie } }));
report(bhSettings.includes("Behörden-Adressbuch") && bhSettings.includes("Stadtamt Bremen") && bhSettings.includes("Fristen-Erinnerung per E-Mail") && bhSettings.includes("ab 7 Uhr"), "Behörden-Einstellungen: Adressbuch gelernt, Erinnerung");
const yardBhSettings = await fetch(base + "/behoerden/einstellungen", { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardBhSettings.status === 307, `${yardBhSettings.status} Hofmitarbeiter: keine Behörden-Einstellungen`);
const yardIntake = await (async () => { const fd = new FormData(); fd.set("file", new Blob([pdfBytes], { type: "application/pdf" }), "x.pdf"); return fetch(`${base}/api/authority-uploads`, { method: "POST", body: fd, headers: { cookie: `rb_session=${yardSession}` } }); })();
report(yardIntake.status === 403, `${yardIntake.status} Hofmitarbeiter: kein Posteingang-Upload`);
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
report(step7a.includes("Kenntnisnahme fehlt") && step7a.includes("Die Mietbedingungen Version 1.0 wurden zur Kenntnisnahme bereitgestellt") && step7a.includes("erst nach der Kenntnisnahme") && step7a.includes("Mit dem Häkchen wird die Kenntnisnahme dokumentiert"), "Vertragsassistent: Kenntnisnahme vor der Mieterunterschrift verlangt");
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
report(listRefundOpen.includes(finalInvoice.number) && listRefundOpen.includes("Guthaben 60,00"), "Rechnungsliste: noch offenes Kundenguthaben (Rest)");
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
report(akteUeb.includes("Offene Forderungen") && akteUeb.includes("Guthaben / Erstattung offen") && akteUeb.includes("Kautionen auszuzahlen") && akteUeb.includes("Offene Akten") && akteUeb.includes("Bearbeiten") && akteUeb.includes(`href="/buchungen/neu?kunde=${w.customerId}"`), "Kundenakte: Übersichtskarten und Aktionen (Buchung für diesen Kunden – nicht die allgemeine Kopfleisten-Aktion)");
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

// ---------------------------------------------------------------------------
// Befehl 20: Super-Admin, Mandantenverwaltung, Einladungen, Sperrung, Supportmodus, Passwort-Reset.
// Mailversand wird für diesen Prozess abgefangen (setMailTransport gilt nur im laufenden Prozess, nicht im
// separaten Dev-Server) – die HTTP-Prüfungen selbst laufen wie überall gegen den echten laufenden Server.
// ---------------------------------------------------------------------------
class SmokeMailTransport implements MailTransport {
  readonly name = "smoke";
  sent: MailMessage[] = [];
  async send(m: MailMessage) { this.sent.push(m); return { messageId: `<smoke-${this.sent.length}@test>` }; }
}
const mail = new SmokeMailTransport();
setMailTransport(mail);
const tokenFromMail = (m: MailMessage, path: string) => new RegExp(`/${path}/([A-Za-z0-9_-]+)`).exec(m.text)![1];
const platformTenants: string[] = [];

const admin = await db.user.create({ data: { tenantId: w.tenantId, email: `superadmin-${Date.now()}@example.test`, name: "Super Admin", passwordHash: await hashPassword("superadminpasswort1"), role: "OWNER" } });
await db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_platform_role_change = 'on'`);
  await tx.user.update({ where: { id: admin.id }, data: { platformRole: "SUPER_ADMIN" } });
});
const adminSessionId = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: adminSessionId, userId: admin.id, expiresAt: new Date(Date.now() + 3600_000) } });
const adminCookie = `rb_session=${adminSessionId}`;

const notAdmin = await fetch(`${base}/admin`, { headers: { cookie }, redirect: "manual" });
report(notAdmin.status === 307, `${notAdmin.status} normaler Inhaber kommt nicht auf /admin`);
const adminHome = await plain(await fetch(`${base}/admin`, { headers: { cookie: adminCookie } }));
report(adminHome.includes("RentBase Control Center"), "Super-Admin: Plattformdashboard erreichbar");

mail.sent = [];
const newTenant = await createTenantByPlatform({ id: admin.id, name: admin.name }, { companyName: `Smoke Neu ${Date.now()}`, ownerFirstName: "Neu", ownerLastName: "Inhaber", ownerEmail: `neu-inhaber-${Date.now()}@example.test`, baseUrl: base });
platformTenants.push(newTenant.id);
report(mail.sent.length === 1 && !/[Pp]ass(?:wort|word)\s*[:=]/.test(mail.sent[0].text), "Mandantenanlage: Einladung versendet, kein Passwortwert in der Mail");
const inviteToken = tokenFromMail(mail.sent[0], "einladung");
const inviteAccept = await fetch(`${base}/einladung/${inviteToken}`, { headers: { cookie: "" } });
report(inviteAccept.status === 200 && (await inviteAccept.clone().text()).includes("Willkommen bei RentBase"), `${inviteAccept.status} Einladungsseite zeigt Willkommen`);
const { userId: newOwnerId } = await acceptInvitation(inviteToken, { name: "Neu Inhaber", password: "ganzneuespasswort1" });
const newOwnerSessionId = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: newOwnerSessionId, userId: newOwnerId, expiresAt: new Date(Date.now() + 3600_000) } });
const newOwnerCookie = `rb_session=${newOwnerSessionId}`;
const newTenantHome = await plain(await fetch(`${base}/heute`, { headers: { cookie: newOwnerCookie } }));
report(newTenantHome.includes("Einrichtung fortsetzen"), "Neuer Mandant: Onboarding-Hinweis auf dem Dashboard (PENDING_SETUP)");

await suspendTenant({ id: admin.id, name: admin.name }, newTenant.id, "Smoke-Test Sperrung");
// Sperrung beendet sofort alle bestehenden Sitzungen (item 11: "keine Sessions still weiterarbeiten lassen") –
// der alte Cookie ist danach schlicht ungültig, keine Sitzung mehr gefunden, normale Login-Weiterleitung.
const oldCookieAfterSuspend = await fetch(`${base}/heute`, { headers: { cookie: newOwnerCookie }, redirect: "manual" });
report(oldCookieAfterSuspend.status === 307 && (oldCookieAfterSuspend.headers.get("location") ?? "").includes("/login"), `${oldCookieAfterSuspend.status} Sperrung beendet die bestehende Sitzung sofort`);
// Eine neue Sitzung (wie bei einer erneuten Anmeldung) sieht die Sperre klar über /gesperrt.
const freshOwnerSessionId = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: freshOwnerSessionId, userId: newOwnerId, expiresAt: new Date(Date.now() + 3600_000) } });
const freshOwnerCookie = `rb_session=${freshOwnerSessionId}`;
const suspendedHome = await fetch(`${base}/heute`, { headers: { cookie: freshOwnerCookie }, redirect: "manual" });
report(suspendedHome.status === 307 && (suspendedHome.headers.get("location") ?? "").includes("/gesperrt"), `${suspendedHome.status} neue Sitzung im gesperrten Mandanten leitet auf /gesperrt`);
const lockedPage = await plain(await fetch(`${base}/gesperrt`, { headers: { cookie: freshOwnerCookie } }));
report(lockedPage.includes("gesperrt") && lockedPage.includes("Smoke-Test Sperrung"), "Sperrseite zeigt Mandant und Grund");
const suspendedApiWrite = await fetch(`${base}/api/photos/irgendeins`, { method: "DELETE", headers: { cookie: freshOwnerCookie } });
report(suspendedApiWrite.status === 403, `${suspendedApiWrite.status} gesperrter Mandant: API-Schreibzugriff abgelehnt`);
await reactivateTenant({ id: admin.id, name: admin.name }, newTenant.id);
const reactivatedHome = await fetch(`${base}/heute`, { headers: { cookie: freshOwnerCookie }, redirect: "manual" });
report(reactivatedHome.status === 200, `${reactivatedHome.status} reaktivierter Mandant hat wieder Zugriff`);

const support = await startSupportSession({ id: admin.id, name: admin.name }, w.tenantId, "Smoke-Test Supportzugriff");
const supportCookies = `${adminCookie}; rb_support=${support.id}`;
const supportHome = await plain(await fetch(`${base}/heute`, { headers: { cookie: supportCookies } }));
report(supportHome.includes("SUPPORTMODUS"), "Supportmodus: Banner sichtbar");
const supportAside = /<aside[\s\S]*?<\/aside>/.exec(supportHome)?.[0] ?? "";
const supportHeader = /<header[\s\S]*?<\/header>/.exec(supportHome)?.[0] ?? "";
report(supportHeader.includes("Suchen (Strg+K)") && ![supportAside, supportHeader].some((x) => x.includes('href="/buchungen/neu"') || x.includes('href="/kunden/neu"') || x.includes("+ Neue Buchung") || x.includes("+ Neuer Kunde")), "Supportmodus: keine Schnellaktionen in Kopf- und Seitenleiste");
const supportCases = await plain(await fetch(`${base}/schaeden`, { headers: { cookie: supportCookies } }));
report(!supportCases.includes("Nächster Schritt:") && !supportCases.includes("Haftung bewerten"), "Supportmodus: Schadenliste ohne Entscheidungsaktionen");
const supportSettings = await plain(await fetch(`${base}/einstellungen`, { headers: { cookie: supportCookies } }));
report(!supportSettings.includes("Mitarbeiter einladen"), "Supportmodus: keine Inhaber-Aktionen sichtbar (read-only)");
// Server Actions sind über requireRole() gesperrt (tests/platform.test.ts); API-Routen über apiSession() –
// die lassen sich hier direkt per HTTP prüfen. Sperre greift vor jeder Datenbankabfrage, daher genügt eine beliebige ID.
for (const [path, label] of [["driver-documents", "Ausweis-/Führerscheinkopie"], ["authority-documents", "Behördendokument"], ["damage-documents", "Schadendokument"]] as const) {
  const blocked = await fetch(`${base}/api/${path}/irgendeins`, { headers: { cookie: supportCookies } });
  const ownerSees = await fetch(`${base}/api/${path}/irgendeins`, { headers: { cookie } });
  report(blocked.status === 403 && (await blocked.text()).includes("Supportmodus") && ownerSees.status === 404, `${blocked.status}/${ownerSees.status} Supportmodus: ${label} gesperrt (Inhaber: nur nicht gefunden)`);
}
const supportDelete = await fetch(`${base}/api/driver-documents/irgendeins`, { method: "DELETE", headers: { cookie: supportCookies } });
report(supportDelete.status === 403, `${supportDelete.status} Supportmodus: API-Löschen abgelehnt`);
const supportUpload = await fetch(`${base}/api/vehicles/${w.vehicleId}/documents`, { method: "POST", headers: { cookie: supportCookies }, body: new FormData() });
report(supportUpload.status === 403, `${supportUpload.status} Supportmodus: API-Upload abgelehnt`);
const foreignSupportSession = await db.supportSession.findFirst({ where: { superAdminId: admin.id, tenantId: newTenant.id } });
report(foreignSupportSession === null, "Supportmodus: keine Session für einen anderen Mandanten entstanden");

// ---------------------------------------------------------------------------
// Befehl 23: Mahnwesen und Forderungen. Eigene Vermietung im Testmandanten, Rechnung abgeschlossen (Zahlungsziel 14 Tage),
// Zahlungserinnerung mit Zeitpunkt in 20 Tagen erstellt (nur Testdaten). Seiten, Rollen, Supportmodus, Mandantentrennung.
// ---------------------------------------------------------------------------
const dnWorld = await returnedWorld("smoke-mahn"); // eigener Mandant (ohne veröffentlichte Mietbedingungen)
platformTenants.push(dnWorld.tenantId);
await db.user.update({ where: { id: dnWorld.userId }, data: { role: "OWNER" } });
const dnSessionId = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: dnSessionId, userId: dnWorld.userId, expiresAt: new Date(Date.now() + 3600_000) } });
const dnCookie = `rb_session=${dnSessionId}`;
const dnYardUser = await db.user.create({ data: { tenantId: dnWorld.tenantId, email: `yard-dn-${Date.now()}@example.test`, name: "Hof Mahnwesen", passwordHash: "x", role: "YARD" } });
const dnYardSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: dnYardSession, userId: dnYardUser.id, expiresAt: new Date(Date.now() + 3600_000) } });
const dnInv = await ensureInvoiceDraft(dnWorld.tenantId, dnWorld.bookingId, dnWorld.actor);
await finalizeInvoice(dnWorld.tenantId, dnInv.id, dnWorld.actor);
const dnNumber = (await db.invoice.findUniqueOrThrow({ where: { id: dnInv.id } })).number!;
const dnLater = new Date(Date.now() + 20 * 86400_000);
const dnPlan = await previewDunning(dnWorld.tenantId, dnInv.id, { now: dnLater });
const dnNotice = (await createDunningNotice(dnWorld.tenantId, dnWorld.actor, { invoiceId: dnInv.id, level: 1, expectedTotalCents: dnPlan.totalCents, idempotencyKey: `smoke-dn-${Date.now()}` }, { now: dnLater })).notice;
const dnDoc = (await ensureDunningDocument(dnWorld.tenantId, dnNotice.id, dnWorld.actor.id)).document;
const dnInvoiceUrl = `${base}/buchungen/${dnWorld.bookingId}/rechnung?nr=${dnInv.id}`;
const dnBookingNumber = (await db.booking.findUniqueOrThrow({ where: { id: dnWorld.bookingId } })).number;
// Knöpfe gezielt prüfen: „Übermittlung vermerken“ steht auch im für alle sichtbaren Satz „Nächster Schritt: …“
const dnActionButtons = (html: string) => />Übermittlung vermerken<\/button>/.test(html) || />Per E-Mail senden<\/button>/.test(html) || />Erneut senden<\/button>/.test(html);
const dnList = await fetch(`${base}/forderungen?filter=erinnerung`, { headers: { cookie: dnCookie } });
const dnListHtml = await plain(dnList);
report(dnList.status === 200 && dnListHtml.includes(dnNumber) && dnListHtml.includes("Zahlungserinnerung erstellt, Versand offen"), `${dnList.status} Forderungen: Filter Zahlungserinnerung zeigt ${dnNumber}`);
const dnAll = await plain(await fetch(`${base}/forderungen`, { headers: { cookie: dnCookie } }));
report(dnAll.includes("Offene Forderungen") && dnAll.includes("Davon überfällig") && dnAll.includes("Ohne Fälligkeit"), "Forderungen: Übersicht mit Kennzahlen und Filtern erreichbar");
const dnSearch = await plain(await fetch(`${base}/forderungen?filter=erinnerung&q=${encodeURIComponent(dnNumber)}`, { headers: { cookie: dnCookie } }));
report(dnSearch.includes(dnBookingNumber), "Forderungen: serverseitige Suche nach Rechnungsnummer findet die Buchung");
const dnHome = await plain(await fetch(`${base}/heute`, { headers: { cookie: dnCookie } }));
report(dnHome.includes("Offene Forderungen") && dnHome.includes("In Mahnung") && dnHome.includes('href="/forderungen"'), "Dashboard: Forderungen und Mahnstufen, verlinkt");
const dnRules = await plain(await fetch(`${base}/einstellungen/geschaeftsregeln`, { headers: { cookie: dnCookie } }));
report(dnRules.includes("Mahnwesen") && dnRules.includes("Mahnwesen speichern") && dnRules.includes("Frist 1. Mahnung"), "Geschäftsregeln: Bereich Mahnwesen (Inhaber)");
const dnRanges = await plain(await fetch(`${base}/einstellungen/nummernkreise`, { headers: { cookie: dnCookie } }));
report(dnRanges.includes("Präfix Mahnungen") && dnRanges.includes("MA-"), "Nummernkreise: Kreis Mahnungen");
const dnInvoiceHtml = await plain(await fetch(dnInvoiceUrl, { headers: { cookie: dnCookie } }));
report(dnInvoiceHtml.includes("Forderung &amp; Mahnwesen") && dnInvoiceHtml.includes("Mahnhistorie") && dnInvoiceHtml.includes(dnNotice.number) && dnActionButtons(dnInvoiceHtml), "Rechnung: Mahnhistorie mit Aktionen (Disposition/Inhaber)");
report(dnInvoiceHtml.includes(dnDoc.fileName), "Dokumente: Mahnschreiben im Dokumentenbereich");
const dnPdf = await fetch(`${base}/api/documents/${dnDoc.id}?download=1`, { headers: { cookie: dnCookie } });
report(dnPdf.status === 200 && (dnPdf.headers.get("content-type") ?? "").includes("pdf"), `${dnPdf.status} Mahnschreiben-PDF abrufbar`);
const dnYard = await plain(await fetch(dnInvoiceUrl, { headers: { cookie: `rb_session=${dnYardSession}` } }));
report(dnYard.includes("Mahnhistorie") && dnYard.includes(dnNotice.number) && !dnActionButtons(dnYard), "Hofmitarbeiter: Mahnhistorie lesend, keine Mahnaktionen");
const dnYardList = await fetch(`${base}/forderungen`, { headers: { cookie: `rb_session=${dnYardSession}` } });
report(dnYardList.status === 200, `${dnYardList.status} Hofmitarbeiter: Forderungen lesbar`);
const dnSupportSession = await startSupportSession({ id: admin.id, name: admin.name }, dnWorld.tenantId, "Smoke-Test Mahnwesen read-only");
const dnSupportCookie = `${adminCookie}; rb_support=${dnSupportSession.id}`;
const dnSupportList = await plain(await fetch(`${base}/forderungen?filter=erinnerung`, { headers: { cookie: dnSupportCookie } }));
report(dnSupportList.includes("SUPPORTMODUS") && dnSupportList.includes(dnBookingNumber) && !dnActionButtons(dnSupportList), "Supportmodus: Forderungen lesbar, keine Mahnaktionen");
// Rechnungsseiten sind im Supportmodus schon bisher gesperrt (Umleitung) – damit auch jede Mahnaktion
const dnSupportInvoice = await fetch(dnInvoiceUrl, { headers: { cookie: dnSupportCookie }, redirect: "manual" });
report(dnSupportInvoice.status === 307 && (dnSupportInvoice.headers.get("location") ?? "").includes("fehler=support"), `${dnSupportInvoice.status} Supportmodus: Rechnung mit Mahnaktionen gesperrt`);
const dnForeignList = await plain(await fetch(`${base}/forderungen?filter=erinnerung&q=${encodeURIComponent(dnNumber)}`, { headers: { cookie } }));
report(!dnForeignList.includes(dnBookingNumber) && dnForeignList.includes("Keine Forderung passt zur Suche."), "Forderungen: fremder Mandant sieht die Forderung nicht");
const dnForeignInvoice = await fetch(dnInvoiceUrl, { headers: { cookie } });
report(dnForeignInvoice.status === 404, `${dnForeignInvoice.status} fremder Mandant: Rechnung mit Mahnhistorie nicht auffindbar`);
const dnForeignPdf = await fetch(`${base}/api/documents/${dnDoc.id}`, { headers: { cookie } });
report(dnForeignPdf.status === 404 || dnForeignPdf.status === 403, `${dnForeignPdf.status} fremder Mandant: Mahnschreiben-PDF gesperrt`);

// Befehl 23.1: freie Rechnungen (ohne Buchung) – Übersicht mit „+ Neue Rechnung“, Anlage, Editor mit Zahlungsziel, Abschluss,
// eigene Seite, Forderungen; Hof ohne Anlage, Supportmodus gesperrt, fremder Mandant ohne Zugriff
const frList = await plain(await fetch(`${base}/rechnungen`, { headers: { cookie: dnCookie } }));
report(frList.includes('href="/rechnungen/neu"') && frList.includes("+ Neue Rechnung"), "Rechnungen: Knopf „+ Neue Rechnung“ (Inhaber)");
const frYardList = await plain(await fetch(`${base}/rechnungen`, { headers: { cookie: `rb_session=${dnYardSession}` } }));
report(!frYardList.includes('href="/rechnungen/neu"'), "Hofmitarbeiter: kein „+ Neue Rechnung“");
const frNew = await fetch(`${base}/rechnungen/neu`, { headers: { cookie: dnCookie } });
const frNewHtml = await plain(frNew);
report(frNew.status === 200 && frNewHtml.includes("Rechnungsempfänger") && frNewHtml.includes("Kein Buchungsbezug"), `${frNew.status} Neue Rechnung: Kundenauswahl und optionaler Buchungsbezug`);
const frNewYard = await fetch(`${base}/rechnungen/neu`, { headers: { cookie: `rb_session=${dnYardSession}` }, redirect: "manual" });
report(frNewYard.status === 307, `${frNewYard.status} Hofmitarbeiter: Neue Rechnung gesperrt`);
const frDraft = (await createGeneralInvoiceDraft(dnWorld.tenantId, dnWorld.actor, { customerId: dnWorld.customerId, nonce: `smoke-free-${Date.now()}` })).invoice;
await updateInvoiceDraft(dnWorld.tenantId, frDraft.id, dnWorld.actor, { items: [{ description: "Sonderreinigung", quantity: "1", unit: "pauschal", unitPrice: "59,50", taxRate: "19" }], paymentTermDays: 3 });
const frDraftHtml = await plain(await fetch(`${base}/rechnungen/${frDraft.id}`, { headers: { cookie: dnCookie } }));
report(frDraftHtml.includes("Zahlungsziel") && frDraftHtml.includes("Sofort fällig") && frDraftHtml.includes("Freie Rechnung") && frDraftHtml.includes("ohne Buchungsbezug"), "Freie Rechnung: Editor mit Zahlungsziel und Fälligkeit");
await finalizeInvoice(dnWorld.tenantId, frDraft.id, dnWorld.actor);
const frNumber = (await db.invoice.findUniqueOrThrow({ where: { id: frDraft.id } })).number!;
const frPage = await fetch(`${base}/rechnungen/${frDraft.id}`, { headers: { cookie: dnCookie } });
const frHtml = await plain(frPage);
report(frPage.status === 200 && frHtml.includes(frNumber) && frHtml.includes("Fällig am") && frHtml.includes("ohne Buchung") && !frHtml.includes("Fahrzeugmiete"), `${frPage.status} Freie Rechnung ${frNumber}: eigene Seite, neutral, mit Fälligkeit`);
report(frHtml.includes("Zahlungen") && frHtml.includes("Gutschrift erstellen") && frHtml.includes("Dokument und E-Mail"), "Freie Rechnung: Zahlungen, Gegenbelege, Dokument und E-Mail");
const frListed = await plain(await fetch(`${base}/rechnungen?art=frei`, { headers: { cookie: dnCookie } }));
report(frListed.includes(frNumber) && frListed.includes("ohne Buchung"), "Rechnungsliste: freie Rechnung mit Fälligkeit, Filter Freie Rechnungen");
const frClaims = await plain(await fetch(`${base}/forderungen?filter=offen&q=${encodeURIComponent(frNumber)}`, { headers: { cookie: dnCookie } }));
report(frClaims.includes(`/rechnungen/${frDraft.id}`), "Forderungen: freie Rechnung als offene Forderung");
const frYard = await fetch(`${base}/rechnungen/${frDraft.id}`, { headers: { cookie: `rb_session=${dnYardSession}` } });
const frYardHtml = await plain(frYard);
report(frYard.status === 200 && !frYardHtml.includes("Gutschrift erstellen") && !frYardHtml.includes("Rechnung bearbeiten"), `${frYard.status} Hofmitarbeiter: freie Rechnung nur lesend`);
const frSupport = await fetch(`${base}/rechnungen/${frDraft.id}`, { headers: { cookie: dnSupportCookie }, redirect: "manual" });
report(frSupport.status === 307 && (frSupport.headers.get("location") ?? "").includes("fehler=support"), `${frSupport.status} Supportmodus: freie Rechnung gesperrt`);
const frForeign = await fetch(`${base}/rechnungen/${frDraft.id}`, { headers: { cookie } });
report(frForeign.status === 404, `${frForeign.status} fremder Mandant: freie Rechnung nicht auffindbar`);

// ---------------------------------------------------------------------------
// Befehl 25: Vertragsnachträge. Laufende Miete im Mahn-Testmandanten (eigenes Fahrzeug): Karte „Vertrag & Nachträge“,
// Entwurf anlegen, Nachtragsseite (Änderungsarten, alt/neu, Unterschrift), Wirksamwerden, PDF, Buchungsseite mit „geändert
// durch“, Rollen (Hof nur Ansicht), Supportmodus nur Ansicht, fremder Mandant ohne Zugriff. Nur Testdaten.
// ---------------------------------------------------------------------------
const amw = await pickedUpWorld("smoke-nt", { within: dnWorld });
const amBooking = await db.booking.findUniqueOrThrow({ where: { id: amw.bookingId } });
const amBookingHtml = await plain(await fetch(`${base}/buchungen/${amw.bookingId}`, { headers: { cookie: dnCookie } }));
report(amBookingHtml.includes("Vertrag &amp; Nachträge") && amBookingHtml.includes("Aktuell vereinbart") && amBookingHtml.includes("+ Vertrag ändern / Nachtrag erstellen") && amBookingHtml.includes("ohne Nachtrag"), "Buchung: Karte „Vertrag &amp; Nachträge“ mit wirksamem Stand und Knopf (Inhaber)");
const amYardBooking = await plain(await fetch(`${base}/buchungen/${amw.bookingId}`, { headers: { cookie: `rb_session=${dnYardSession}` } }));
report(amYardBooking.includes("Vertrag &amp; Nachträge") && !amYardBooking.includes("+ Vertrag ändern / Nachtrag erstellen") && amYardBooking.includes("Nachträge erstellt die Disposition"), "Hofmitarbeiter: Karte lesend, kein Knopf");
const amDraft = (await createAmendmentDraft(amw.tenantId, amw.actor, { bookingId: amw.bookingId, nonce: `smoke-nt-${Date.now()}` })).amendment;
const amUrl = `${base}/buchungen/${amw.bookingId}/nachtrag/${amDraft.id}`;
const amPage = await fetch(amUrl, { headers: { cookie: dnCookie } });
const amHtml = await plain(amPage);
report(amPage.status === 200 && amHtml.includes("Nachtrag zum Mietvertrag") && amHtml.includes("Entwurf") && amHtml.includes("1. Was wird geändert?") && amHtml.includes("Mietdauer / geplante Rückgabe ändern") && amHtml.includes("Mietpreis ändern") && amHtml.includes("Kilometervereinbarung ändern") && amHtml.includes("Vereinbarte Kaution ändern") && amHtml.includes("Rückgabeort ändern") && amHtml.includes("Sonstige Vereinbarung") && amHtml.includes("+ Zusatzfahrer aufnehmen"), `${amPage.status} Nachtrag-Entwurf: alle Änderungsarten, Fahrer, Hinweis „Entwurf ändert nichts“`);
report(amHtml.includes("Ein Entwurf ändert nichts") && amHtml.includes("Noch keine Änderung erfasst") && amHtml.includes("Nachtrag verwerfen"), "Nachtrag-Entwurf: Hinweise und Verwerfen");
const amBookingDraft = await plain(await fetch(`${base}/buchungen/${amw.bookingId}`, { headers: { cookie: dnCookie } }));
report(amBookingDraft.includes("Nachtrag-Entwurf fortsetzen") && !amBookingDraft.includes("+ Vertrag ändern / Nachtrag erstellen"), "Buchung: offener Entwurf wird fortgesetzt, kein zweiter Knopf");
const amContract = await db.rentalContract.findUniqueOrThrow({ where: { id: amw.contractId } });
const amNewEnd = new Date(amContract.endAt!.getTime() + 2 * 86400_000);
const amRow = await updateAmendmentDraft(amw.tenantId, amw.actor, amDraft.id, { newEndAt: amNewEnd, newDepositCents: 60000 });
await updateAmendmentDraft(amw.tenantId, amw.actor, amDraft.id, { priceDeltaCents: amRow.priceProposalCents });
const amDraftHtml = await plain(await fetch(amUrl, { headers: { cookie: dnCookie } }));
report(amDraftHtml.includes("Zusammenfassung alt / neu") && amDraftHtml.includes("Vorschlag der Preislogik") && amDraftHtml.includes("Unterschrift Mieter") && amDraftHtml.includes("Nachtrag unterschreiben und wirksam machen") && amDraftHtml.includes("Alle Voraussetzungen erfüllt"), "Nachtrag-Entwurf: alt/neu, Preisvorschlag, Unterschrift, Wirksam machen");
const amYardDraft = await fetch(amUrl, { headers: { cookie: `rb_session=${dnYardSession}` }, redirect: "manual" });
report(amYardDraft.status === 307, `${amYardDraft.status} Hofmitarbeiter: Nachtrag-Entwurf gesperrt`);
const amSupportDraft = await fetch(amUrl, { headers: { cookie: dnSupportCookie }, redirect: "manual" });
report(amSupportDraft.status === 307, `${amSupportDraft.status} Supportmodus: Nachtrag-Entwurf nur Ansicht (Umleitung)`);
await saveAmendmentSignature(amw.tenantId, amw.actor, amDraft.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(3), seenHash: await getAmendmentContentHash(amw.tenantId, amDraft.id) });
const amSigned = (await signAmendment(amw.tenantId, amw.actor, amDraft.id)).amendment;
const amDoc = (await ensureAmendmentDocument(amw.tenantId, amDraft.id, amw.actor.id)).document;
const amSignedPage = await fetch(`${amUrl}?wirksam=1`, { headers: { cookie: dnCookie } });
const amSignedHtml = await plain(amSignedPage);
report(amSignedPage.status === 200 && amSignedHtml.includes(`Nachtrag ${amSigned.number}`) && amSignedHtml.includes("Unterschrieben und wirksam") && amSignedHtml.includes("Geänderte Vereinbarungen") && amSignedHtml.includes("Stand nach diesem Nachtrag") && amSignedHtml.includes(amDoc.fileName) && amSignedHtml.includes("Nachtrag per E-Mail senden") && amSignedHtml.includes("nicht geändert oder gelöscht"), `${amSignedPage.status} Nachtrag ${amSigned.number}: wirksam, versiegelt, PDF, Versand nur bewusst`);
const amPdf = await fetch(`${base}/api/documents/${amDoc.id}?download=1`, { headers: { cookie: dnCookie } });
report(amPdf.status === 200 && (amPdf.headers.get("content-type") ?? "").includes("pdf"), `${amPdf.status} Nachtrags-PDF abrufbar`);
const amBookingSigned = await plain(await fetch(`${base}/buchungen/${amw.bookingId}`, { headers: { cookie: dnCookie } }));
report(amBookingSigned.includes(amSigned.number!) && amBookingSigned.includes(`geändert durch ${amSigned.number}`) && amBookingSigned.includes("1 Nachtrag wirksam") && amBookingSigned.includes("+ Vertrag ändern / Nachtrag erstellen"), "Buchung: wirksamer Nachtrag in Liste, „geändert durch“, weiterer Nachtrag möglich");
report((await db.booking.findUniqueOrThrow({ where: { id: amw.bookingId } })).endAt!.getTime() === amNewEnd.getTime() && amBooking.endAt!.getTime() !== amNewEnd.getTime(), "Buchung: Zeitraum durch Nachtrag materialisiert (Disposition/Rückgabe)");
report(amBookingSigned.includes("Nachträge zum Mietvertrag") && amBookingSigned.includes(amDoc.fileName), "Dokumente: Nachtrags-PDF im Dokumentenbereich");
const amContractHtml = await plain(await fetch(`${base}/buchungen/${amw.bookingId}/vertrag`, { headers: { cookie: dnCookie } }));
report(amContractHtml.includes("Nachtrag geändert") && amContractHtml.includes(amSigned.number!), "Mietvertrag: Hinweis auf Nachtrag, Original unverändert");
const amDispo = await fetch(`${base}/dispo`, { headers: { cookie: dnCookie } });
report(amDispo.status === 200, `${amDispo.status} Disposition lädt mit verlängerter Buchung`);
const amYardSigned = await fetch(amUrl, { headers: { cookie: `rb_session=${dnYardSession}` } });
const amYardSignedHtml = await plain(amYardSigned);
report(amYardSigned.status === 200 && amYardSignedHtml.includes("Unterschrieben und wirksam") && !amYardSignedHtml.includes("Nachtrag per E-Mail senden"), `${amYardSigned.status} Hofmitarbeiter: wirksamer Nachtrag lesend, kein Versand`);
// Supportmodus: Nachtragsseite wie die Vertragsseite gesperrt (requireRole), die Karte auf der Buchungsseite bleibt lesbar
const amSupportSigned = await fetch(amUrl, { headers: { cookie: dnSupportCookie }, redirect: "manual" });
report(amSupportSigned.status === 307 && (amSupportSigned.headers.get("location") ?? "").includes("fehler=support"), `${amSupportSigned.status} Supportmodus: Nachtragsseite gesperrt`);
const amSupportBooking = await plain(await fetch(`${base}/buchungen/${amw.bookingId}`, { headers: { cookie: dnSupportCookie } }));
report(amSupportBooking.includes("SUPPORTMODUS") && amSupportBooking.includes(amSigned.number!) && amSupportBooking.includes("Im Supportmodus nur Ansicht") && !amSupportBooking.includes("+ Vertrag ändern / Nachtrag erstellen"), "Supportmodus: Karte „Vertrag &amp; Nachträge“ lesend, kein Knopf");
const amForeign = await fetch(amUrl, { headers: { cookie } });
report(amForeign.status === 404, `${amForeign.status} fremder Mandant: Nachtrag nicht auffindbar`);
const amForeignPdf = await fetch(`${base}/api/documents/${amDoc.id}`, { headers: { cookie } });
report(amForeignPdf.status === 404 || amForeignPdf.status === 403, `${amForeignPdf.status} fremder Mandant: Nachtrags-PDF gesperrt`);
const amRangesHtml = await plain(await fetch(`${base}/einstellungen/nummernkreise`, { headers: { cookie: dnCookie } }));
report(amRangesHtml.includes("Präfix Nachträge") && amRangesHtml.includes("NT-") && amRangesHtml.includes("Unterschriebene Nachträge zum Mietvertrag"), "Nummernkreise: Kreis Nachträge mit Zähler");

// ---------------------------------------------------------------------------
// Befehl 27: Korrekturrunde. Storno-Dialog (Inhaber ja, Hof/Support nein, Stornoinfo), Fahrzeugformular mit Tankgröße,
// „+ Schaden erfassen“ in der Fahrzeugakte (Herkunft „Manuell erfasst“), Kundenakte „+ Neue Rechnung“, Dispo „Rückgabe
// überfällig“, Startseite ohne /buchungen/null. Alles im Mahn-Testmandanten mit eigenen Testdaten.
// ---------------------------------------------------------------------------
{
  const krVeh = await db.vehicle.create({ data: { tenantId: dnWorld.tenantId, plate: `HB-KR ${Date.now().toString(36).slice(-4)}`, make: "VW", model: "Polo", groupId: dnWorld.groupId, fuel: "BENZIN", mileage: 12_000, dailyRate: 49, deposit: 300, tankCapacityLiters: 40 } });
  const krStart = new Date(Date.now() + 20 * 86400_000);
  const krBooking = await db.booking.create({ data: { tenantId: dnWorld.tenantId, number: `KR-${Date.now().toString(36)}`, vehicleId: krVeh.id, customerId: dnWorld.customerId, startAt: krStart, endAt: new Date(krStart.getTime() + 2 * 86400_000), dailyRate: 49, deposit: 300 } });
  const krOwner = await plain(await fetch(`${base}/buchungen/${krBooking.id}`, { headers: { cookie: dnCookie } }));
  report(krOwner.includes("Stornieren…"), "Storno: Inhaber sieht „Stornieren…“ (Dialog mit Pflichtgrund)");
  const krYard = await plain(await fetch(`${base}/buchungen/${krBooking.id}`, { headers: { cookie: `rb_session=${dnYardSession}` } }));
  report(!krYard.includes("Stornieren…"), "Storno: Hofmitarbeiter ohne Storno-Knopf");
  const krSupport = await plain(await fetch(`${base}/buchungen/${krBooking.id}`, { headers: { cookie: dnSupportCookie } }));
  report(krSupport.includes("SUPPORTMODUS") && !krSupport.includes("Stornieren…"), "Storno: Supportmodus ohne Storno-Knopf");
  await changeBookingStatus(dnWorld.tenantId, krBooking.id, "CANCELLED", { actor: dnWorld.actor, reason: "Smoke: Kunde hat abgesagt" });
  const krCancelled = await plain(await fetch(`${base}/buchungen/${krBooking.id}`, { headers: { cookie: dnCookie } }));
  report(krCancelled.includes("Storniert") && krCancelled.includes("Grund: Smoke: Kunde hat abgesagt") && !krCancelled.includes("Stornieren…"), "Storno: Grund, Benutzer und Zeitpunkt sichtbar, kein zweites Storno");

  const krForm = await plain(await fetch(`${base}/fahrzeuge/${krVeh.id}?tab=stammdaten`, { headers: { cookie: dnCookie } }));
  report(krForm.includes("Tankgröße (Liter)") && krForm.includes('value="40"'), "Fahrzeugformular: Tankgröße (Liter) gepflegt");
  const krFile = await plain(await fetch(`${base}/fahrzeuge/${krVeh.id}?tab=schaeden`, { headers: { cookie: dnCookie } }));
  report(krFile.includes("+ Schaden erfassen"), "Fahrzeugakte: „+ Schaden erfassen“");
  const krFileYard = await plain(await fetch(`${base}/fahrzeuge/${krVeh.id}?tab=schaeden`, { headers: { cookie: `rb_session=${dnYardSession}` } }));
  report(krFileYard.includes("+ Schaden erfassen"), "Fahrzeugakte: Hofmitarbeiter kann Schaden erfassen");
  await reportDamage(dnWorld.tenantId, dnWorld.actor, { vehicleId: krVeh.id, view: "FRONT", posX: 0.5, posY: 0.4, kind: "CHIP", severity: "MINOR", description: "Smoke: Steinschlag Frontscheibe", note: "Smoke-Notiz" });
  const krFile2 = await plain(await fetch(`${base}/fahrzeuge/${krVeh.id}?tab=schaeden`, { headers: { cookie: dnCookie } }));
  report(krFile2.includes("Smoke: Steinschlag Frontscheibe") && krFile2.includes("Manuell erfasst (ohne Protokoll)"), "Fahrzeugakte: manueller Schaden mit Herkunft „Manuell erfasst“");
  const krFileSupport = await plain(await fetch(`${base}/fahrzeuge/${krVeh.id}?tab=schaeden`, { headers: { cookie: dnSupportCookie } }));
  report(krFileSupport.includes("Smoke: Steinschlag Frontscheibe") && !krFileSupport.includes("+ Schaden erfassen"), "Fahrzeugakte: Supportmodus nur Ansicht");
  const krPhotoSupport = await fetch(`${base}/api/damages/${(await db.damage.findFirstOrThrow({ where: { tenantId: dnWorld.tenantId, vehicleId: krVeh.id } })).id}/photos`, { method: "POST", headers: { cookie: dnSupportCookie }, body: new FormData() });
  report(krPhotoSupport.status === 403, `${krPhotoSupport.status} Schadenfoto: Supportmodus darf nicht hochladen`);

  const krCustomer = await plain(await fetch(`${base}/kunden/${dnWorld.customerId}`, { headers: { cookie: dnCookie } }));
  report(krCustomer.includes("+ Neue Rechnung") && krCustomer.includes(`/rechnungen/neu?kunde=${dnWorld.customerId}`), "Kundenakte: „+ Neue Rechnung“ mit vorbelegtem Kunden");
  const krCustomerFin = await plain(await fetch(`${base}/kunden/${dnWorld.customerId}?tab=finanzen`, { headers: { cookie: dnCookie } }));
  report(!krCustomerFin.includes("/finanzen\""), "Kundenakte: keine Links auf /buchungen/…/finanzen");
  const krCustomerSupport = await plain(await fetch(`${base}/kunden/${dnWorld.customerId}`, { headers: { cookie: dnSupportCookie } }));
  report(!krCustomerSupport.includes("+ Neue Rechnung"), "Kundenakte: Supportmodus ohne „+ Neue Rechnung“");

  const krOver = await pickedUpWorld("smoke-overdue", { within: dnWorld });
  await db.booking.update({ where: { id: krOver.bookingId }, data: { startAt: new Date(Date.now() - 3 * 86400_000), endAt: new Date(Date.now() - 2 * 3600_000) } });
  const krDispo = await plain(await fetch(`${base}/dispo`, { headers: { cookie: dnCookie } }));
  report(krDispo.includes("Rückgabe überfällig"), "Dispo: überfällige Miete sichtbar mit „Rückgabe überfällig“");
  const krToday = await plain(await fetch(`${base}/heute`, { headers: { cookie: dnCookie } }));
  report(!krToday.includes("/buchungen/null"), "Startseite: kein Link auf /buchungen/null");
  const krLogin = await fetch(`${base}/login?weiter=${encodeURIComponent("//evil.example")}`);
  report(krLogin.status === 200, `${krLogin.status} Login mit fremdem Weiterleitungsziel lädt (Ziel wird serverseitig verworfen)`);
}

// ---------------------------------------------------------------------------
// Befehl 28: Storno mit Geld (Gebühr, Erstattung, Guthaben, Kaution), Stornobestätigung, Zeitraum ändern, telefonische
// Verlängerung (vereinbart – Unterschrift ausstehend), Dispo, Überfällig/„Miete verlängern“, Verlauf, Rollen und Supportmodus.
// ---------------------------------------------------------------------------
{
  await db.tenant.update({ where: { id: dnWorld.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14 } });
  const mkVeh = async (plate: string) => db.vehicle.create({ data: { tenantId: dnWorld.tenantId, plate, make: "VW", model: "Polo", groupId: dnWorld.groupId, fuel: "BENZIN", mileage: 10_000, dailyRate: 49, deposit: 300, tankCapacityLiters: 40 } });
  const mkBooking = async (vehicleId: string, days: number) => { const st = new Date(Date.now() + days * 86400_000); return db.booking.create({ data: { tenantId: dnWorld.tenantId, number: `S28-${Math.random().toString(36).slice(2, 8)}`, vehicleId, customerId: dnWorld.customerId, startAt: st, endAt: new Date(st.getTime() + 2 * 86400_000), dailyRate: 250, deposit: 500 } }); };
  // Storno-Assistent + Zeitraum ändern (Inhaber), nicht für Hof/Support
  const v1 = await mkVeh(`HB-S1 ${Date.now().toString(36).slice(-4)}`);
  const b1 = await mkBooking(v1.id, 25);
  const own1 = await plain(await fetch(`${base}/buchungen/${b1.id}`, { headers: { cookie: dnCookie } }));
  report(own1.includes("Stornieren…") && own1.includes("Zeitraum ändern") && own1.includes("Verlauf"), "Buchung: Storno-Assistent, „Zeitraum ändern“ und Verlauf (Inhaber)");
  const yard1 = await plain(await fetch(`${base}/buchungen/${b1.id}`, { headers: { cookie: `rb_session=${dnYardSession}` } }));
  report(!yard1.includes("Stornieren…") && !yard1.includes("Zeitraum ändern"), "Hofmitarbeiter: kein Storno, keine Zeitraumänderung");
  const sup1 = await plain(await fetch(`${base}/buchungen/${b1.id}`, { headers: { cookie: dnSupportCookie } }));
  report(!sup1.includes("Stornieren…") && !sup1.includes("Zeitraum ändern"), "Supportmodus: kein Storno, keine Zeitraumänderung");
  // Storno mit Vorauszahlung 300, Gebühr 90, Erstattung 210 (Testdaten, lokaler Server)
  await recordRentalPayment(dnWorld.tenantId, dnWorld.actor, b1.id, { amount: "300", method: "CASH", paidAt: new Date(Date.now() - 60_000) });
  const r1 = await cancelBooking(dnWorld.tenantId, dnWorld.actor, b1.id, { reason: "Smoke: Kunde storniert", idempotencyKey: randomBytes(12).toString("hex"), fee: { amount: "90", description: "Stornogebühr laut Mietbedingungen", taxTreatment: "TAXABLE_SUPPLY" }, refund: { mode: "PAYOUT", payout: { method: "CASH", confirmed: true, receiptConfirmed: true } } });
  await runCancellationFollowUp(dnWorld.tenantId, r1, dnWorld.actor.id);
  const can1 = await plain(await fetch(`${base}/buchungen/${b1.id}`, { headers: { cookie: dnCookie } }));
  report(can1.includes("Buchung storniert") && can1.includes("Storno-Abrechnung (eingefroren beim Storno)") && can1.includes("Stornobestätigung") && can1.includes("Grund: Smoke: Kunde storniert") && !can1.includes("Stornieren…"), "Storno mit Geld: Abrechnung, Bestätigung, Grund sichtbar");
  const feeInv = await db.invoice.findUniqueOrThrow({ where: { id: r1.feeInvoiceId! } });
  report(can1.includes(`Rechnung ${feeInv.number}`), "Storno: Link zur Stornogebühr-Rechnung");
  report(can1.includes("Keine Mietforderung mehr") && can1.includes("Es besteht keine Mietforderung mehr") && !can1.includes("Gesamtpreis (voraussichtlich)") && !can1.includes("Vertrag folgt") && !can1.includes("Voraussichtlich"), "Stornierte Buchung: keine offene Miete, kein „voraussichtlich“, Verweis auf die Storno-Abrechnung");
  const feePage = await fetch(`${base}/buchungen/${b1.id}/rechnung?nr=${feeInv.id}`, { headers: { cookie: dnCookie } });
  const feeHtml = await plain(feePage);
  report(feePage.status === 200 && feeHtml.includes("Stornogebühr"), `${feePage.status} Stornogebühr-Rechnung lädt`);
  const confDoc = await db.document.findFirst({ where: { tenantId: dnWorld.tenantId, bookingId: b1.id, type: "BOOKING_CANCELLATION" } });
  const confPdf = confDoc ? await fetch(`${base}/api/documents/${confDoc.id}?download=1`, { headers: { cookie: dnCookie } }) : null;
  report(confPdf?.status === 200 && (confPdf.headers.get("content-type") ?? "").includes("pdf"), `${confPdf?.status} Stornobestätigung als PDF abrufbar`);
  const refundPage = await plain(await fetch(`${base}/auszahlungen/${r1.payoutIds[0]}`, { headers: { cookie: dnCookie } }));
  report(refundPage.includes("Erstattung"), "Auszahlung der Erstattung (Rechnungsguthaben) lädt");
  // Storno ohne Gebühr, Vorauszahlung bleibt Guthaben an der Buchung
  const v2 = await mkVeh(`HB-S2 ${Date.now().toString(36).slice(-4)}`);
  const b2 = await mkBooking(v2.id, 26);
  await recordRentalPayment(dnWorld.tenantId, dnWorld.actor, b2.id, { amount: "120", method: "CASH", paidAt: new Date(Date.now() - 60_000) });
  await cancelBooking(dnWorld.tenantId, dnWorld.actor, b2.id, { reason: "Smoke: Termin entfällt", idempotencyKey: randomBytes(12).toString("hex"), refund: { mode: "CREDIT" } });
  const can2 = await plain(await fetch(`${base}/buchungen/${b2.id}`, { headers: { cookie: dnCookie } }));
  report(can2.includes("Guthaben aus der Mietvorauszahlung") && can2.includes("Mietvorauszahlung erstatten"), "Storno ohne Gebühr: Guthaben an der Buchung, Erstattung später möglich");
  report(!can2.includes("es sind aber Mietzahlungen"), "Storno mit Guthaben-Entscheidung: kein Klärungshinweis wie bei Altstornos");
  const fin2 = await plain(await fetch(`${base}/kunden/${dnWorld.customerId}?tab=finanzen`, { headers: { cookie: dnCookie } }));
  report(fin2.includes("Guthaben aus stornierten Buchungen"), "Kundenakte: Guthaben aus stornierten Buchungen");
  const claims2 = await plain(await fetch(`${base}/auszahlungen?filter=offen&quelle=vorauszahlung`, { headers: { cookie: dnCookie } }));
  report(claims2.includes("Storno-Erstattung") && claims2.includes(b2.number), "Auszahlungen: offene Storno-Erstattung sichtbar");
  const yard2 = await plain(await fetch(`${base}/buchungen/${b2.id}`, { headers: { cookie: `rb_session=${dnYardSession}` } }));
  report(yard2.includes("Buchung storniert") && !yard2.includes("Mietvorauszahlung erstatten") && !yard2.includes("Stornobestätigung per E-Mail senden"), "Hofmitarbeiter: Storno lesbar, keine Erstattung, kein Versand");
  // telefonische Verlängerung einer laufenden Miete
  const ext = await pickedUpWorld("smoke-b28-ext", { within: dnWorld });
  const extB = await db.booking.findUniqueOrThrow({ where: { id: ext.bookingId } });
  const ea = (await createAmendmentDraft(dnWorld.tenantId, dnWorld.actor, { bookingId: ext.bookingId, nonce: `smoke-ext-${Date.now()}` })).amendment;
  await updateAmendmentDraft(dnWorld.tenantId, dnWorld.actor, ea.id, { newEndAt: new Date(extB.endAt!.getTime() + 86400_000) });
  const eaDraft = await plain(await fetch(`${base}/buchungen/${ext.bookingId}/nachtrag/${ea.id}`, { headers: { cookie: dnCookie } }));
  report(eaDraft.includes("Telefonisch / extern vereinbart?") && eaDraft.includes("Als vereinbart speichern – Fahrzeug reservieren"), "Nachtrag: „Als vereinbart speichern“ für Zeitraumänderung");
  await agreeAmendment(dnWorld.tenantId, dnWorld.actor, ea.id, { channel: "PHONE", note: "Smoke-Anruf" });
  const extPage = await plain(await fetch(`${base}/buchungen/${ext.bookingId}`, { headers: { cookie: dnCookie } }));
  report(extPage.includes("Vertragsänderung vereinbart – Unterschrift fehlt") && extPage.includes("Unterschrift nachholen"), "Buchung: „Vertragsänderung vereinbart – Unterschrift fehlt“ + „Unterschrift nachholen“");
  const eaAgreed = await plain(await fetch(`${base}/buchungen/${ext.bookingId}/nachtrag/${ea.id}`, { headers: { cookie: dnCookie } }));
  report(eaAgreed.includes("Vereinbart – Unterschrift ausstehend") && eaAgreed.includes("Vereinbarte Änderung zurücknehmen") && eaAgreed.includes("Nachtrag unterschreiben und wirksam machen"), "Nachtrag vereinbart: Status, Zurücknahme, Unterschrift nachholen");
  const extDispo = await plain(await fetch(`${base}/dispo`, { headers: { cookie: dnCookie } }));
  report(extDispo.includes("Verlängerung vereinbart – Unterschrift fehlt"), "Dispo: vorläufig vereinbarte Verlängerung gekennzeichnet");
  const extSupport = await fetch(`${base}/buchungen/${ext.bookingId}/nachtrag/${ea.id}`, { headers: { cookie: dnSupportCookie }, redirect: "manual" });
  report(extSupport.status === 307, `${extSupport.status} Supportmodus: vereinbarte Änderung nicht bearbeitbar`);
  // überfällige Miete (Befehl-27-Testbuchung): „Miete verlängern“
  const overdueB = await db.booking.findFirst({ where: { tenantId: dnWorld.tenantId, status: "ACTIVE", endAt: { lt: new Date() } }, select: { id: true } });
  const overPage = overdueB ? await plain(await fetch(`${base}/buchungen/${overdueB.id}`, { headers: { cookie: dnCookie } })) : "";
  report(overPage.includes("Rückgabe überfällig") && overPage.includes("Miete verlängern"), "Überfällige Miete: „Miete verlängern“ mit Folgekonfliktprüfung");
}

// ---------------------------------------------------------------------------
// Control Center: Navigation je interner Rolle, alle Bereiche erreichbar, Berechtigungen serverseitig, Feature-Gating,
// Mandantendetail mit Tarif/Features/Diagnose. Nutzt den bereits angelegten SUPER_ADMIN (adminCookie) und w.tenantId.
// ---------------------------------------------------------------------------
{
  const ccPages: [string, string][] = [
    ["/admin", "RentBase Control Center"], ["/admin/mandanten", "Kunden"], ["/admin/benutzer", "mandantenübergreifend"], ["/admin/benutzer?tab=einladungen", "Offene Einladungen"],
    ["/admin/abos", "Tarife &amp; Abonnements"], ["/admin/features", "Feature Management"], ["/admin/support", "Support &amp; Diagnose"], ["/admin/audit", "Audit Log"], ["/admin/system", "Berechtigungsmatrix"],
    [`/admin/mandanten/${w.tenantId}`, "Tarif &amp; Abo"], [`/admin/benutzer/${w.userId}`, "Interne Plattformrolle"],
  ];
  for (const [p, needle] of ccPages) {
    const res = await fetch(`${base}${p}`, { headers: { cookie: adminCookie } });
    const html = await plain(res);
    report(res.status === 200 && html.includes(needle), `${res.status} Control Center ${p} zeigt „${needle}“`);
  }
  const ccHome = await plain(await fetch(`${base}/admin`, { headers: { cookie: adminCookie } }));
  report(!/(passwordHash|DATABASE_URL=|SMTP_PASSWORD=|RENTBASE_SECRET_KEY=)/.test(ccHome), "Control Center: keine Geheimnisse im HTML");
  const ccSystem = await plain(await fetch(`${base}/admin/system`, { headers: { cookie: adminCookie } }));
  report(ccSystem.includes("nur gesetzt / fehlt") && !/postgres:\/\//.test(ccSystem), "Systemseite: nur gesetzt/fehlt, keine Verbindungszeichenfolge");

  // Interne Rollen: READ_ONLY sieht alles, ändert nichts; BILLING kommt nicht auf Benutzer/System; SUPPORT darf keinen Mandanten sperren
  const mkAdmin = async (label: string, role: string) => {
    const u = await db.user.create({ data: { tenantId: w.tenantId, email: `${label}-${Date.now()}@example.test`, name: `${label} Test`, passwordHash: await hashPassword("internpasswort1"), role: "DISPO" } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_platform_role_change = 'on'`);
      await tx.user.update({ where: { id: u.id }, data: { platformRole: role } });
    });
    const sid = randomBytes(32).toString("base64url");
    await db.session.create({ data: { id: sid, userId: u.id, expiresAt: new Date(Date.now() + 3600_000) } });
    return { id: u.id, cookie: `rb_session=${sid}` };
  };
  const readOnly = await mkAdmin("readonly", "READ_ONLY_ADMIN");
  const billing = await mkAdmin("billing", "BILLING_ADMIN");
  const supportAdmin = await mkAdmin("support", "SUPPORT_ADMIN");
  const roHome = await fetch(`${base}/admin`, { headers: { cookie: readOnly.cookie } });
  const roHtml = await plain(roHome);
  report(roHome.status === 200 && roHtml.includes("Nur-Lese-Admin") && !roHtml.includes("Neue Autovermietung"), `${roHome.status} READ_ONLY_ADMIN: Dashboard sichtbar, keine Anlage-Schaltfläche`);
  const roNew = await fetch(`${base}/admin/mandanten/neu`, { headers: { cookie: readOnly.cookie }, redirect: "manual" });
  report(roNew.status === 307 && (roNew.headers.get("location") ?? "").includes("fehler=rechte"), `${roNew.status} READ_ONLY_ADMIN: Mandantenanlage serverseitig abgelehnt`);
  const roDetail = await plain(await fetch(`${base}/admin/mandanten/${w.tenantId}`, { headers: { cookie: readOnly.cookie } }));
  report(!roDetail.includes("Mandant sperren") && !roDetail.includes("Supportmodus öffnen") && roDetail.includes("Tarif &amp; Abo"), "READ_ONLY_ADMIN: Detailseite ohne Sperr-/Support-Aktionen");
  const billingUsers = await fetch(`${base}/admin/benutzer`, { headers: { cookie: billing.cookie }, redirect: "manual" });
  report(billingUsers.status === 307 && (billingUsers.headers.get("location") ?? "").includes("fehler=rechte"), `${billingUsers.status} BILLING_ADMIN: Benutzerbereich gesperrt`);
  const billingSystem = await fetch(`${base}/admin/system`, { headers: { cookie: billing.cookie }, redirect: "manual" });
  report(billingSystem.status === 307, `${billingSystem.status} BILLING_ADMIN: Systembereich gesperrt`);
  const billingAbos = await fetch(`${base}/admin/abos`, { headers: { cookie: billing.cookie } });
  report(billingAbos.status === 200 && (await plain(billingAbos)).includes("Tarife &amp; Abonnements"), `${billingAbos.status} BILLING_ADMIN: Abo-Bereich erreichbar`);
  const supportDetail = await plain(await fetch(`${base}/admin/mandanten/${w.tenantId}`, { headers: { cookie: supportAdmin.cookie } }));
  report(supportDetail.includes("Supportmodus") && !supportDetail.includes("Mandant sperren"), "SUPPORT_ADMIN: Supportmodus ja, Sperrung nein");
  const supportAsCustomer = await startSupportSession({ id: supportAdmin.id, name: "Support Test" }, w.tenantId, "Smoke Control Center Support-Admin");
  const supportAdminHome = await plain(await fetch(`${base}/heute`, { headers: { cookie: `${supportAdmin.cookie}; rb_support=${supportAsCustomer.id}` } }));
  report(supportAdminHome.includes("SUPPORTMODUS"), "SUPPORT_ADMIN: „Als Kunde öffnen“ funktioniert über die Matrix");
  const billingAsCustomer = await fetch(`${base}/heute`, { headers: { cookie: `${billing.cookie}; rb_support=${supportAsCustomer.id}` } });
  report(!(await plain(billingAsCustomer)).includes("SUPPORTMODUS"), "BILLING_ADMIN: fremder Support-Cookie wirkt nicht");
  const normalUserAdmin = await fetch(`${base}/admin/features`, { headers: { cookie }, redirect: "manual" });
  report(normalUserAdmin.status === 307 && (normalUserAdmin.headers.get("location") ?? "").includes("/heute"), `${normalUserAdmin.status} Mandanten-Inhaber kommt in keinen Control-Center-Bereich`);

  // Feature-Gating: Behörden sperren → Navigation, Seite, Aktion, API; danach wieder freischalten
  await setTenantFeature({ id: admin.id, name: admin.name }, w.tenantId, "AUTHORITIES", false, "Smoke");
  const gatedNav = await plain(await fetch(`${base}/heute`, { headers: { cookie } }));
  const gatedAside = /<aside[\s\S]*?<\/aside>/.exec(gatedNav)?.[0] ?? "";
  report(!gatedAside.includes('href="/behoerden"') && gatedAside.includes('href="/schaeden"'), "Feature gesperrt: Behörden aus der Navigation, Schäden bleibt");
  const gatedPage = await fetch(`${base}/behoerden`, { headers: { cookie }, redirect: "manual" });
  report(gatedPage.status === 307 && (gatedPage.headers.get("location") ?? "").includes("fehler=funktion"), `${gatedPage.status} Feature gesperrt: Seite leitet mit Hinweis um`);
  const gatedHint = await plain(await fetch(`${base}/heute?fehler=funktion`, { headers: { cookie } }));
  report(gatedHint.includes("nicht freigeschaltet"), "Feature gesperrt: Hinweis auf der Startseite");
  const gatedApi = await fetch(`${base}/api/authority-uploads`, { method: "POST", headers: { cookie }, body: new FormData() });
  report(gatedApi.status === 403 && (await gatedApi.text()).includes("nicht freigeschaltet"), `${gatedApi.status} Feature gesperrt: API-Upload abgelehnt`);
  const otherStillOpen = await fetch(`${base}/behoerden`, { headers: { cookie: `rb_session=${foreignSession}` }, redirect: "manual" });
  report(otherStillOpen.status === 200, `${otherStillOpen.status} Feature gesperrt: anderer Mandant unberührt`);
  const gatedAdminDetail = await plain(await fetch(`${base}/admin/mandanten/${w.tenantId}`, { headers: { cookie: adminCookie } }));
  report(gatedAdminDetail.includes("6 von 8 aktiv"), "Mandantendetail zeigt Feature-Zustand");
  await setTenantFeature({ id: admin.id, name: admin.name }, w.tenantId, "AUTHORITIES", true);
  const ungated = await fetch(`${base}/behoerden`, { headers: { cookie }, redirect: "manual" });
  report(ungated.status === 200, `${ungated.status} Feature freigeschaltet: Seite wieder erreichbar`);
  const featureAudit = await db.auditLog.count({ where: { tenantId: w.tenantId, action: { in: ["FEATURE_DISABLED", "FEATURE_ENABLED"] } } });
  report(featureAudit === 2, `Feature-Änderungen protokolliert (${featureAudit})`);

  // Tarif/Abo mit Limit: Detailseite zeigt den Tarif, Einladung über Limit wird abgelehnt
  await upsertSubscription({ id: admin.id, name: admin.name }, w.tenantId, { plan: "STARTER", status: "ACTIVE", monthlyPriceCents: 4900, maxUsers: 1 });
  const aboDetail = await plain(await fetch(`${base}/admin/mandanten/${w.tenantId}`, { headers: { cookie: adminCookie } }));
  report(aboDetail.includes("Starter") && aboDetail.includes("49,00"), "Mandantendetail zeigt Tarif und Monatspreis");
  const aboList = await plain(await fetch(`${base}/admin/abos`, { headers: { cookie: adminCookie } }));
  report(aboList.includes("MRR") && aboList.includes("49,00"), "Abo-Übersicht zeigt MRR aus erfassten Preisen");
  const auditPage = await plain(await fetch(`${base}/admin/audit?mandant=${w.tenantId}`, { headers: { cookie: adminCookie } }));
  report(auditPage.includes("Tarif/Abo angelegt") && auditPage.includes("Feature gesperrt"), "Audit Log zeigt Plattform-Aktionen des Mandanten mit Filter");
  await db.tenantSubscription.delete({ where: { tenantId: w.tenantId } });
}

// ---------------------------------------------------------------------------
// Befehl 20.5: E-Mail-Versand und Branding (Seiten, Rollen, Supportmodus, Mandantentrennung, kein Geheimnis im HTML)
// ---------------------------------------------------------------------------
await db.user.update({ where: { id: foreign.userId }, data: { role: "OWNER" } }); // fremder Mandant mit vollen Rechten – trotzdem kein Zugriff
const mailPage0 = await plain(await fetch(`${base}/einstellungen/e-mail`, { headers: { cookie } }));
report(mailPage0.includes("Geschäftliche E-Mails werden derzeit über den RentBase-Versanddienst versendet") && mailPage0.includes("SMTP-Zugang") && mailPage0.includes("Eigener E-Mail-Versand, damit Kunden Nachrichten direkt von Ihrer Firmenadresse erhalten"), "E-Mail-Versand: Standard RentBase, Empfehlung sichtbar");
const smokeSecret = `Smoke-Geheim-${randomBytes(6).toString("hex")}`;
process.env.RENTBASE_SECRET_KEY ||= Buffer.from("rentbase-testschluessel-32-bytes").toString("base64");
await saveMailSettings(w.tenantId, w.actor, { host: "smtp.smoke-vermieter.test", port: 587, security: "STARTTLS", username: "vermietung@smoke.test", newPassword: smokeSecret, fromName: "Smoke Vermietung", fromEmail: "vermietung@smoke.test", replyTo: null });
const mailRow = await db.tenantMailSettings.findUniqueOrThrow({ where: { tenantId: w.tenantId } });
const mailPage1 = await plain(await fetch(`${base}/einstellungen/e-mail`, { headers: { cookie } }));
report(mailPage1.includes("•••••••• – gespeichert") && !mailPage1.includes(smokeSecret) && !mailPage1.includes(mailRow.passwordCiphertext!) && mailPage1.includes("smtp.smoke-vermieter.test"), "E-Mail-Versand (Inhaber): Passwort nur als „gespeichert“, nie im HTML");
const dispoMail = await plain(await fetch(`${base}/einstellungen/e-mail`, { headers: { cookie: `rb_session=${dispoSession}` } }));
report(dispoMail.includes("Eingerichtet, nicht getestet") && !dispoMail.includes("smtp.smoke-vermieter.test") && !dispoMail.includes("SMTP-Zugang") && !dispoMail.includes(smokeSecret), "E-Mail-Versand (Disposition): nur Status, kein Server, kein Formular");
const yardMail = await fetch(`${base}/einstellungen/e-mail`, { headers: { cookie: `rb_session=${yardSession}` }, redirect: "manual" });
report(yardMail.status === 307, `${yardMail.status} E-Mail-Versand: Hofmitarbeiter wird umgeleitet`);
const supportMail = await fetch(`${base}/einstellungen/e-mail`, { headers: { cookie: supportCookies }, redirect: "manual" });
report(supportMail.status === 307, `${supportMail.status} E-Mail-Versand: im Supportmodus nicht einsehbar`);
const supportSettings2 = await plain(await fetch(`${base}/einstellungen`, { headers: { cookie: supportCookies } }));
report(!supportSettings2.includes(smokeSecret) && !supportSettings2.includes(mailRow.passwordCiphertext!) && !supportSettings2.includes("Logo hochladen"), "Supportmodus: kein Geheimnis, keine Logo-Aktion in den Einstellungen");
const logoPng = await (await import("sharp")).default({ create: { width: 400, height: 120, channels: 3, background: { r: 22, g: 50, b: 92 } } }).png().toBuffer();
const logoForm = () => { const f = new FormData(); f.set("file", new Blob([new Uint8Array(logoPng)], { type: "image/png" }), "logo.png"); return f; };
const supportLogo = await fetch(`${base}/api/branding/logo`, { method: "POST", headers: { cookie: supportCookies }, body: logoForm() });
const supportLogoDel = await fetch(`${base}/api/branding/logo`, { method: "DELETE", headers: { cookie: supportCookies } });
report(supportLogo.status === 403 && supportLogoDel.status === 403, `${supportLogo.status}/${supportLogoDel.status} Supportmodus: Logo hochladen/entfernen abgelehnt`);
const dispoLogo = await fetch(`${base}/api/branding/logo`, { method: "POST", headers: { cookie: `rb_session=${dispoSession}` }, body: logoForm() });
report(dispoLogo.status === 403, `${dispoLogo.status} Logo: Disposition darf nicht hochladen`);
const ownerLogo = await fetch(`${base}/api/branding/logo`, { method: "POST", headers: { cookie }, body: logoForm() });
report(ownerLogo.status === 201, `${ownerLogo.status} Logo: Inhaber lädt hoch`);
const svgForm = new FormData();
svgForm.set("file", new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: "image/svg+xml" }), "logo.svg");
const svgLogo = await fetch(`${base}/api/branding/logo`, { method: "POST", headers: { cookie }, body: svgForm });
report(svgLogo.status === 422, `${svgLogo.status} Logo: SVG abgelehnt`);
const ownLogo = await fetch(`${base}/api/branding/logo`, { headers: { cookie } });
const foreignLogo = await fetch(`${base}/api/branding/logo`, { headers: { cookie: `rb_session=${foreignSession}` } });
report(ownLogo.status === 200 && ownLogo.headers.get("content-type") === "image/png" && foreignLogo.status === 404, `${ownLogo.status}/${foreignLogo.status} Logo: eigener Mandant sieht es, fremder nicht`);
const foreignLogoDel = await fetch(`${base}/api/branding/logo`, { method: "DELETE", headers: { cookie: `rb_session=${foreignSession}` } });
report(foreignLogoDel.status === 200 && (await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } })).logoStorageKey !== null, "Logo: Entfernen durch fremden Mandanten trifft nur dessen eigenen (leeren) Stand");
const foreignMail = await plain(await fetch(`${base}/einstellungen/e-mail`, { headers: { cookie: `rb_session=${foreignSession}` } }));
report(!foreignMail.includes("smtp.smoke-vermieter.test") && foreignMail.includes("Nicht eingerichtet"), "E-Mail-Versand: fremder Mandant sieht nichts von diesem SMTP");
const setupPage = await plain(await fetch(`${base}/einrichtung`, { headers: { cookie } }));
report(setupPage.includes("E-Mail-Versand") && setupPage.includes("Eigener E-Mail-Versand empfohlen"), "Einrichtung: E-Mail-Versand als Empfehlung");
report(setupPage.includes("Miettarif für jede Fahrzeuggruppe mit Fahrzeugen") && setupPage.includes("/einstellungen/tarife"), "Einrichtung: Miettarif als Voraussetzung für Buchungen");
// ---------------------------------------------------------------------------
// Befehl 20.6: kontaktlose Rückgabe – Buchungsbereich, Rollen, öffentliche Seite mit Token, Supportmodus
// ---------------------------------------------------------------------------
const kdw = await pickedUpWorld("smoke-kd");
platformTenants.push(kdw.tenantId);
await db.user.update({ where: { id: kdw.userId }, data: { role: "OWNER" } });
await db.booking.update({ where: { id: kdw.bookingId }, data: { actualPickupAt: new Date(Date.now() - 86400_000) } });
const kdSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: kdSession, userId: kdw.userId, expiresAt: new Date(Date.now() + 3600_000) } });
const kdCookie = `rb_session=${kdSession}`;
const kdRules = await plain(await fetch(`${base}/einstellungen/geschaeftsregeln`, { headers: { cookie: kdCookie } }));
report(kdRules.includes("Kontaktlose Rückgabe / Schlüsselbox erlauben") && kdRules.includes("Mietbedingungen die kontaktlose Rückgabe"), "Geschäftsregeln: kontaktlose Rückgabe mit Hinweis auf Mietbedingungen");
const kdOff = await plain(await fetch(`${base}/buchungen/${kdw.bookingId}`, { headers: { cookie: kdCookie } }));
report(!kdOff.includes("Kontaktlose Rückgabe vereinbaren"), "Kontaktlose Rückgabe: ohne Freischaltung kein Bereich");
await saveKeyDropSettings(kdw.tenantId, kdw.actor, { enabled: true, label: "Schlüsselbox" });
const kdOn = await plain(await fetch(`${base}/buchungen/${kdw.bookingId}`, { headers: { cookie: kdCookie } }));
report(kdOn.includes("Kontaktlose Rückgabe vereinbaren") && kdOn.includes("Nur aktivieren, wenn die kontaktlose Rückgabe mit dem Kunden vereinbart wurde"), "Kontaktlose Rückgabe: Vereinbaren mit Warnhinweis");
const kd = await authorizeKeyDrop(kdw.tenantId, kdw.actor, kdw.bookingId, { location: "Hof, Stellplatz 4", instructions: "Schlüssel in die Box", expectedReturnAt: new Date(Date.now() + 3600_000), internalNote: "GEHEIM-INTERN", agreedWithCustomer: true });
const kdAgreed = await plain(await fetch(`${base}/buchungen/${kdw.bookingId}`, { headers: { cookie: kdCookie } }));
report(kdAgreed.includes("Rückgabe-Mail versenden") && kdAgreed.includes("An: erika@example.test"), "Kontaktlose Rückgabe: Versand-Knopf mit sichtbarem Empfänger (noch nichts versendet)");
const kdYard = await db.user.create({ data: { tenantId: kdw.tenantId, email: `kd-yard-${Date.now()}@example.test`, name: "Hof KD", passwordHash: "x", role: "YARD" } });
const kdYardSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: kdYardSession, userId: kdYard.id, expiresAt: new Date(Date.now() + 3600_000) } });
const kdYardPage = await plain(await fetch(`${base}/buchungen/${kdw.bookingId}`, { headers: { cookie: `rb_session=${kdYardSession}` } }));
report(kdYardPage.includes("Kontaktlose Rückgabe") && !kdYardPage.includes("Rückgabe-Mail versenden") && !kdYardPage.includes("GEHEIM-INTERN"), "Hofmitarbeiter: sieht Vereinbarung, kein Versand, keine interne Notiz");
mail.sent = [];
await sendKeyDropLink(kdw.tenantId, kdw.actor, kd.id, { nonce: `smoke-${Date.now()}`, baseUrl: base });
const kdToken = tokenFromMail(mail.sent[0], "rueckgabe");
const kdPublic = await fetch(`${base}/rueckgabe/${kdToken}`, { redirect: "manual" });
const kdPublicHtml = (await kdPublic.text()).replace(/<!-- -->/g, "");
report(kdPublic.status === 200 && kdPublicHtml.includes("Rückgabe verbindlich melden") && kdPublicHtml.includes("Hof, Stellplatz 4") && !kdPublicHtml.includes("GEHEIM-INTERN") && !/Kaution|IBAN/.test(kdPublicHtml), `${kdPublic.status} Kundenseite ohne Anmeldung, ohne interne Daten`);
const kdBad = await plain(await fetch(`${base}/rueckgabe/${"x".repeat(43)}`));
report(kdBad.includes("Link nicht gültig"), "Kundenseite: ungültiger Link");
const kdPhotoForm = new FormData();
kdPhotoForm.set("category", "FRONT");
kdPhotoForm.set("file", new Blob([new Uint8Array(await (await import("sharp")).default({ create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer())], { type: "image/jpeg" }), "vorne.jpg");
const kdPhoto = await fetch(`${base}/api/rueckgabe/${kdToken}/foto`, { method: "POST", body: kdPhotoForm });
const kdPhotoJson = (await kdPhoto.json().catch(() => ({}))) as { id?: string };
const kdPhotoGet = kdPhotoJson.id ? await fetch(`${base}/api/rueckgabe/${kdToken}/foto/${kdPhotoJson.id}`) : null;
const kdPhotoWrong = kdPhotoJson.id ? await fetch(`${base}/api/rueckgabe/${"y".repeat(43)}/foto/${kdPhotoJson.id}`) : null;
report(kdPhoto.status === 201 && kdPhotoGet?.status === 200 && kdPhotoWrong?.status === 404, `${kdPhoto.status}/${kdPhotoGet?.status}/${kdPhotoWrong?.status} Kundenfoto nur mit gültigem Link`);
const kdStaffPhoto = kdPhotoJson.id ? await fetch(`${base}/api/photos/${kdPhotoJson.id}`, { headers: { cookie: `rb_session=${foreignSession}` } }) : null;
report(kdStaffPhoto?.status === 404, `${kdStaffPhoto?.status} Kundenfoto für fremden Mandanten nicht auffindbar`);
const kdSupport = await startSupportSession({ id: admin.id, name: admin.name }, kdw.tenantId, "Smoke-Test Schlüsselbox");
const kdSupportPage = await plain(await fetch(`${base}/buchungen/${kdw.bookingId}`, { headers: { cookie: `${adminCookie}; rb_support=${kdSupport.id}` } }));
report(kdSupportPage.includes("Kontaktlose Rückgabe") && !kdSupportPage.includes("Rückgabe-Mail erneut senden") && !kdSupportPage.includes("GEHEIM-INTERN"), "Supportmodus: kontaktlose Rückgabe nur lesend");
await confirmKeyDrop(kdToken, { dropOffAt: new Date(Date.now() - 20 * 60_000), mileage: 45_500, fuelEighths: 6, batteryPercent: null, locationConfirmed: true, locationNote: null, newDamages: false, damageNote: null, remark: null, signerName: "Erika Muster", signatureDataUrl: fakeSignaturePng(), accepted: true });
const kdDash = await plain(await fetch(`${base}/heute`, { headers: { cookie: kdCookie } }));
const kdPlate = (await db.vehicle.findUniqueOrThrow({ where: { id: kdw.vehicleId } })).plate;
report(kdDash.includes("Schlüsselbox-Rückgaben zu prüfen") && kdDash.includes(kdPlate) && kdDash.includes("Abgabe laut Kunde"), "Heute: Schlüsselbox-Rückgaben zu prüfen");
const kdStart = await plain(await fetch(`${base}/buchungen/${kdw.bookingId}/rueckgabe`, { headers: { cookie: kdCookie } }));
report(kdStart.includes("Kontaktlos zurückgegeben – Kontrolle ausstehend") && kdStart.includes("Schlüsselbox-Rückgabe prüfen"), "Rückgabe: Kontrolle nach kontaktloser Rückgabe startbar");
const kdDone = await plain(await fetch(`${base}/rueckgabe/${kdToken}`));
report(kdDone.includes("Rückgabe gemeldet") && !kdDone.includes("Rückgabe verbindlich melden"), "Kundenseite nach Meldung: nur noch Eingangsbestätigung");

// Befehl 20.6 (Nachbesserung): laufender Rückgabeentwurf – Grund sichtbar, leerer Entwurf verwerfbar (nur Inhaber/Disposition)
const kdd = await pickedUpWorld("smoke-kd-draft");
platformTenants.push(kdd.tenantId);
await db.user.update({ where: { id: kdd.userId }, data: { role: "OWNER" } });
await saveKeyDropSettings(kdd.tenantId, kdd.actor, { enabled: true, label: "Schlüsselbox" });
const kddSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: kddSession, userId: kdd.userId, expiresAt: new Date(Date.now() + 3600_000) } });
const kddYard = await db.user.create({ data: { tenantId: kdd.tenantId, email: `kdd-yard-${Date.now()}@example.test`, name: "Hof D", passwordHash: "x", role: "YARD" } });
const kddYardSession = randomBytes(32).toString("base64url");
await db.session.create({ data: { id: kddYardSession, userId: kddYard.id, expiresAt: new Date(Date.now() + 3600_000) } });
const kddDraft = await startHandover(kdd.tenantId, kdd.bookingId, "RETURN", kdd.actor);
const kddOwner = await plain(await fetch(`${base}/buchungen/${kdd.bookingId}`, { headers: { cookie: `rb_session=${kddSession}` } }));
report(kddOwner.includes("bereits eine persönliche Rückgabe begonnen") && kddOwner.includes(kddDraft.number) && kddOwner.includes("Leeren Rückgabeentwurf verwerfen") && !kddOwner.includes("Kontaktlose Rückgabe vereinbaren"), "Laufender Rückgabeentwurf: Grund sichtbar, Inhaber kann leeren Entwurf verwerfen");
const kddYardPage = await plain(await fetch(`${base}/buchungen/${kdd.bookingId}`, { headers: { cookie: `rb_session=${kddYardSession}` } }));
report(kddYardPage.includes("bereits eine persönliche Rückgabe begonnen") && !kddYardPage.includes("Leeren Rückgabeentwurf verwerfen") && !kddYardPage.includes("Kontaktlose Rückgabe vereinbaren"), "Hofmitarbeiter: sieht den Grund, kann nicht verwerfen und nicht vereinbaren");
await updateHandoverDraft(kdd.tenantId, kddDraft.id, { mileage: 45_300 });
const kddFilled = await plain(await fetch(`${base}/buchungen/${kdd.bookingId}`, { headers: { cookie: `rb_session=${kddSession}` } }));
report(kddFilled.includes("kann nicht verworfen werden") && !kddFilled.includes("Leeren Rückgabeentwurf verwerfen"), "Nicht leerer Rückgabeentwurf: kein Verwerfen, Hinweis auf persönliche Rückgabe");
await db.handover.update({ where: { id: kddDraft.id }, data: { mileage: null } });
await discardEmptyReturnDraft(kdd.tenantId, kdd.bookingId, kddDraft.id, kdd.actor);
const kddAfter = await plain(await fetch(`${base}/buchungen/${kdd.bookingId}`, { headers: { cookie: `rb_session=${kddSession}` } }));
report(kddAfter.includes("Kontaktlose Rückgabe vereinbaren") && !kddAfter.includes("bereits eine persönliche Rückgabe begonnen"), "Nach dem Verwerfen: kontaktlose Rückgabe vereinbar");

const settingsWithCards = await plain(await fetch(`${base}/einstellungen`, { headers: { cookie } }));
report(settingsWithCards.includes("E-Mail-Versand einrichten") && settingsWithCards.includes("Logo ersetzen") && settingsWithCards.includes("Website (optional)"), "Einstellungen: E-Mail-Versand, Logo und Website");

mail.sent = [];
await requestPasswordReset((await db.user.findUniqueOrThrow({ where: { id: w.userId } })).email, base);
report(mail.sent.length === 1, "Passwort-Reset: Mail versendet");
const resetToken = tokenFromMail(mail.sent[0], "passwort-vergessen");
const resetPage = await plain(await fetch(`${base}/passwort-vergessen/${resetToken}`));
report(resetPage.includes("Neues Passwort festlegen"), "Passwort-Reset: gültiger Link zeigt Formular");
const badResetPage = await plain(await fetch(`${base}/passwort-vergessen/ungueltiger-token-${Date.now()}`));
report(badResetPage.includes("nicht mehr gültig"), "Passwort-Reset: ungültiger Link zeigt Fehlermeldung");

// Befehl 29 Phase C: Unfallersatz-Wizard – Mietart-Auswahl, Seiten je Rolle, Freischaltung und der direkte Aufruf der
// Server-Aktionen (so, wie ein Skript ohne Oberfläche sie aufrufen würde): Rechte und Freischaltung lassen sich nicht umgehen.
const ue = await createWorld("smoke-ue");
platformTenants.push(ue.tenantId);
const ueV2 = await db.vehicle.create({ data: { tenantId: ue.tenantId, plate: "HB-UE 900", make: "Opel", model: "Astra", groupId: ue.groupId, dailyRate: 55, deposit: 0 } });
const ueV3 = await db.vehicle.create({ data: { tenantId: ue.tenantId, plate: "HB-UE 901", make: "Skoda", model: "Octavia", groupId: ue.groupId, dailyRate: 65, deposit: 0 } });
const ueCookie = async (role: "OWNER" | "DISPO" | "YARD") => {
  const u = await db.user.create({ data: { tenantId: ue.tenantId, email: `ue-${role.toLowerCase()}-${Date.now()}@example.test`, name: `UE ${role}`, passwordHash: "x", role } });
  const sid = randomBytes(32).toString("base64url");
  await db.session.create({ data: { id: sid, userId: u.id, expiresAt: new Date(Date.now() + 3600_000) } });
  return `rb_session=${sid}`;
};
const ueOwner = await ueCookie("OWNER"), ueDispo = await ueCookie("DISPO"), ueYard = await ueCookie("YARD");
/** Aktions-ID einer Seite: über den Namen (Entwicklungsserver), sonst die ans Formular gebundene bzw. die einzige übrige. */
const actionIdOf = (html: string, name: string, fallback: "bound" | "other") => {
  const named = [...html.matchAll(/([0-9a-f]{42})\\?",\\?"bound\\?":null,\\?"name\\?":\\?"(\w+)/g)].find((m) => m[2] === name)?.[1];
  if (named) return named;
  const boundField = /name="\$ACTION_\d+:0" value="([^"]*)"/.exec(html);
  const bound = boundField ? (JSON.parse(boundField[1].replace(/&quot;/g, '"')) as { id: string }).id : "";
  if (fallback === "bound") return bound;
  const plainForms = [...html.matchAll(/name="\$ACTION_ID_([0-9a-f]+)"/g)].map((m) => m[1]);
  const others = [...new Set([...html.matchAll(/(?<![0-9a-f])[0-9a-f]{42}(?![0-9a-f])/g)].map((m) => m[0]))].filter((id) => id !== bound && !plainForms.includes(id));
  return others.length === 1 ? others[0] : "";
};
/** Server-Aktion direkt per HTTP aufrufen (React-Reply-Format: Formularfelder mit Präfix vor dem Wurzelteil „0“). */
const callAction = async (path: string, actionId: string, cookieValue: string, args: { form: Record<string, string>; bound?: unknown[] } | { json: unknown[] }) => {
  const body = new FormData();
  if ("form" in args) {
    for (const [k, v] of Object.entries(args.form)) body.append(`_1_${k}`, v);
    // gebundene Argumente (z. B. die Fall-ID) schickt der Browser selbst mit – ein Angreifer könnte jede ID einsetzen
    body.append("0", JSON.stringify([...(args.bound ?? []), "$undefined", "$K1"]));
  } else body.append("0", JSON.stringify(args.json));
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { cookie: cookieValue, "Next-Action": actionId }, body, redirect: "manual" });
  return { status: res.status, redirectTo: res.headers.get("x-action-redirect") ?? res.headers.get("location") ?? "", text: await res.text() };
};
/** Rückgabewert (Formularzustand) einer Aktion aus der RSC-Antwort. */
const actionState = (text: string): { error?: string; step?: number } | null => {
  const line = text.split("\n").find((l) => /^[0-9a-f]+:\{"error":/.test(l));
  return line ? JSON.parse(line.slice(line.indexOf(":") + 1)) : null;
};
const TECH = /prisma|P20\d\d|constraint|stack|SQL|cm[a-z0-9]{20,}/i;
const ueStart = new Date(Math.ceil((Date.now() + 2 * 3600_000) / 60_000) * 60_000);
const ueForm = (over: Record<string, string> = {}) => ({
  nonce: `smoke-ue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, customerMode: "existing", customerId: ue.customerId,
  damagedPlate: "HB-AB 99", damagedMake: "BMW", damagedModel: "320d", damagedDrivable: "0", damageKind: "REPAIR", accidentDate: toDateInputValue(new Date(Date.now() - 86400_000)),
  insurerName: "Smoke Versicherung AG", liabilityStatus: "REPORTED", vehicleId: ueV2.id, startAt: toDateTimeInput(ueStart), endMode: "open", plannedEndAt: "",
  dailyRate: "55", t_DELIVERY_on: "1", t_DELIVERY_amount: "35", t_DELIVERY_mode: "once", ...over,
});
const ueCases = () => db.accidentReplacementCase.count({ where: { tenantId: ue.tenantId } });
const ueAccidentBookings = () => db.booking.count({ where: { tenantId: ue.tenantId, rentalType: "ACCIDENT_REPLACEMENT" } });

// standardmäßig gesperrt: keine Mietart-Auswahl, der Wizard leitet um, das Standardformular ist unverändert
const ueOffNew = await plain(await fetch(`${base}/buchungen/neu`, { headers: { cookie: ueOwner } }));
report(!ueOffNew.includes('aria-label="Mietart"') && ueOffNew.includes("Preis, Kilometer und Kaution kommen aus dem Miettarif"), "Unfallersatz gesperrt: Neue Buchung ohne Mietart-Auswahl, Standardformular (mit Tarifauswahl, Befehl 29)");
const ueOffWizard = await fetch(`${base}/unfallersatz/neu`, { headers: { cookie: ueOwner }, redirect: "manual" });
report(ueOffWizard.status === 307 && (ueOffWizard.headers.get("location") ?? "").includes("fehler=funktion"), `${ueOffWizard.status} Unfallersatz gesperrt: Wizard leitet mit Hinweis um`);

await setTenantFeature({ id: admin.id, name: admin.name }, ue.tenantId, "ACCIDENT_REPLACEMENT", true, "Smoke Phase C");
const ueOnNew = await plain(await fetch(`${base}/buchungen/neu?fahrzeug=${ueV3.id}`, { headers: { cookie: ueOwner } }));
report(ueOnNew.includes('aria-label="Mietart"') && ueOnNew.includes("Standardvermietung") && ueOnNew.includes(`href="/unfallersatz/neu?fahrzeug=${ueV3.id}"`) && ueOnNew.includes("Preis, Kilometer und Kaution kommen aus dem Miettarif"), "Neue Buchung: Mietart Standard/Unfallersatz, Vorbelegung bleibt, Standardformular (mit Tarifauswahl)");
const ueWizardAs = async (c: string) => { const r = await fetch(`${base}/unfallersatz/neu`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, location: r.headers.get("location") ?? "", html: r.status === 200 ? await plain(r) : "" }; };
const ueOwnerWizard = await ueWizardAs(ueOwner);
const ueFormTag = /<form[^>]*aria-label="Unfallersatz anlegen"[^>]*>/.exec(ueOwnerWizard.html)?.[0] ?? "";
report(ueOwnerWizard.status === 200 && /method="POST"/i.test(ueFormTag) && ueOwnerWizard.html.includes("Mietende offen") && ueOwnerWizard.html.includes("Schadenfall"), `${ueOwnerWizard.status} Inhaber: Wizard erreichbar, Formular sendet per POST`);
const ueDispoWizard = await ueWizardAs(ueDispo);
report(ueDispoWizard.status === 200 && ueDispoWizard.html.includes('aria-label="Unfallersatz anlegen"'), `${ueDispoWizard.status} Disposition: Wizard erreichbar`);
const ueYardWizard = await ueWizardAs(ueYard);
report(ueYardWizard.status === 307 && ueYardWizard.location.includes("fehler=rechte"), `${ueYardWizard.status} Hofmitarbeiter: kein Wizard`);

const ueCreateId = actionIdOf(ueDispoWizard.html, "createAccidentCaseAction", "bound");
const ueAvailId = actionIdOf(ueDispoWizard.html, "accidentAvailabilityAction", "other");
report(/^[0-9a-f]{42}$/.test(ueCreateId) && /^[0-9a-f]{42}$/.test(ueAvailId) && ueCreateId !== ueAvailId, "Aktions-IDs des Wizards ermittelt");
const availInput = [{ startAt: toDateTimeInput(ueStart), endMode: "open", plannedEndAt: "" }];

// direkter Aufruf als Hofmitarbeiter: abgewiesen, nichts angelegt, keine Fahrzeugdaten
const yardCall = await callAction("/unfallersatz/neu", ueCreateId, ueYard, { form: ueForm() });
report(yardCall.redirectTo.includes("fehler=rechte") && (await ueCases()) === 0 && (await ueAccidentBookings()) === 0, `${yardCall.status} Direkter Aufruf als Hofmitarbeiter: abgewiesen, nichts angelegt`);
const yardAvail = await callAction("/unfallersatz/neu", ueAvailId, ueYard, { json: availInput });
report(yardAvail.redirectTo.includes("fehler=rechte") && !yardAvail.text.includes(ueV2.id), `${yardAvail.status} Verfügbarkeit als Hofmitarbeiter: abgewiesen, keine Fahrzeugdaten`);
// direkter Aufruf ohne Freischaltung: abgewiesen
await setTenantFeature({ id: admin.id, name: admin.name }, ue.tenantId, "ACCIDENT_REPLACEMENT", false, "Smoke Phase C");
const offCall = await callAction("/unfallersatz/neu", ueCreateId, ueDispo, { form: ueForm() });
const offAvail = await callAction("/unfallersatz/neu", ueAvailId, ueDispo, { json: availInput });
report(offCall.redirectTo.includes("fehler=funktion") && offAvail.redirectTo.includes("fehler=funktion") && !offAvail.text.includes(ueV2.id) && (await ueCases()) === 0, `${offCall.status} Direkter Aufruf ohne Freischaltung: abgewiesen, nichts angelegt`);
await setTenantFeature({ id: admin.id, name: admin.name }, ue.tenantId, "ACCIDENT_REPLACEMENT", true, "Smoke Phase C");
// Eingaben werden serverseitig geprüft, auch ohne Oberfläche
const quotaCall = actionState((await callAction("/unfallersatz/neu", ueCreateId, ueDispo, { form: ueForm({ liabilityStatus: "QUOTA", liabilityQuotaPercent: "150" }) })).text);
report(quotaCall?.error === "Die Haftungsquote liegt zwischen 0 und 100 %." && quotaCall.step === 3 && (await ueCases()) === 0, "Direkter Aufruf: Quote 150 % serverseitig abgelehnt (Schritt 3)");
const staleCall = actionState((await callAction("/unfallersatz/neu", ueCreateId, ueDispo, { form: ueForm({ nonce: "" }) })).text);
report(staleCall?.error === "Die Seite ist veraltet. Bitte neu laden.", "Direkter Aufruf ohne Formularschlüssel: abgelehnt");
// Disposition legt an (offenes Ende); derselbe Formularschlüssel (Doppelklick) legt nichts Zweites an
const ueKey = ueForm();
const dispoCall = await callAction("/unfallersatz/neu", ueCreateId, ueDispo, { form: ueKey });
const ueCase = await db.accidentReplacementCase.findFirst({ where: { tenantId: ue.tenantId } });
const ueBooking = ueCase ? await db.booking.findUnique({ where: { id: ueCase.bookingId } }) : null;
report(Boolean(ueCase) && ueBooking?.endAt === null && dispoCall.redirectTo.includes(`/unfallersatz/${ueCase?.id}?angelegt=1`), `${dispoCall.status} Disposition: Fall mit offenem Mietende angelegt, weiter zur Fallakte`);
const dispoAgain = await callAction("/unfallersatz/neu", ueCreateId, ueDispo, { form: ueKey });
report((await ueCases()) === 1 && (await ueAccidentBookings()) === 1 && dispoAgain.redirectTo.includes(`/unfallersatz/${ueCase?.id}`), `${dispoAgain.status} Doppelklick: derselbe Fall, keine zweite Buchung`);
// Fahrzeugkonflikt: verständliche Meldung, kein Datenbankfehler
const conflict = actionState((await callAction("/unfallersatz/neu", ueCreateId, ueOwner, { form: ueForm() })).text);
report(Boolean(conflict?.error?.startsWith("Doppelbelegung: HB-UE 900")) && conflict?.step === 4 && !TECH.test(conflict?.error ?? "") && (await ueCases()) === 1, "Fahrzeugkonflikt: verständliche Meldung, Sprung zu Schritt 4, nichts angelegt");
// Inhaber legt an (geplantes Mietende)
const ownerCall = await callAction("/unfallersatz/neu", ueCreateId, ueOwner, { form: ueForm({ vehicleId: ueV3.id, endMode: "known", plannedEndAt: toDateTimeInput(new Date(ueStart.getTime() + 3 * 86400_000)) }) });
report((await ueCases()) === 2 && ownerCall.redirectTo.includes("/unfallersatz/") && ownerCall.redirectTo.includes("angelegt=1"), `${ownerCall.status} Inhaber: Fall mit geplantem Mietende angelegt`);
// Verfügbarkeit: nur eigene Fahrzeuge, belegt mit offenem Ende, offene Miete vor späterer Buchung nicht möglich
const dispoAvail = await callAction("/unfallersatz/neu", ueAvailId, ueDispo, { json: availInput });
report(dispoAvail.status === 200 && dispoAvail.text.includes(ueV2.id) && dispoAvail.text.includes("(Mietende offen)") && dispoAvail.text.includes("Mietende offen nicht möglich") && !dispoAvail.text.includes(w.vehicleId), `${dispoAvail.status} Verfügbarkeit: eigene Flotte, Belegung und offenes Ende verständlich`);
// Buchungsseite des Falls und unveränderte Standardbuchung
const ueBookingPage = await plain(await fetch(`${base}/buchungen/${ueCase?.bookingId}`, { headers: { cookie: ueDispo } }));
report(ueBookingPage.includes(`Unfallersatz ${ueCase?.caseNumber}`) && ueBookingPage.includes(`href="/unfallersatz/${ueCase?.id}"`) && ueBookingPage.includes("Unfallersatzfall öffnen") && ueBookingPage.includes("Kein Mietpreis im Voraus") && ueBookingPage.includes("offen (bis zur Rückgabe)") && !ueBookingPage.includes("Vollständig bezahlt"), "Buchung zum Fall: Kennzeichnung, Link „Unfallersatzfall öffnen“, offenes Mietende, kein Mietpreis im Voraus");
// Phase E: der Vertragsassistent ist für Unfallersatz freigegeben (kein Hinweis „folgt“ mehr)
report(ueBookingPage.includes("Mietvertrag fortsetzen") && !ueBookingPage.includes("Vertragsabschluss für Unfallersatz folgt"), "Buchung zum Fall: Vertrag fortsetzen (Unfallersatz-Vertrag mit offenem Ende im Vertragsassistenten)");
const ueStdPage = await plain(await fetch(`${base}/buchungen/${ue.bookingId}`, { headers: { cookie: ueDispo } }));
report(!ueStdPage.includes("Unfallersatz UE-") && !ueStdPage.includes("Kein Mietpreis im Voraus") && !ueStdPage.includes("offen (bis zur Rückgabe)") && ueStdPage.includes("Gesamtpreis (voraussichtlich)") && ueStdPage.includes("Noch keine Mietzahlung erfasst") && ueStdPage.includes("Änderungen speichern"), "Standardbuchung: Seite unverändert (Gesamtpreis, Mietzahlung, Bearbeiten), ohne Unfallersatz-Anteile");
// Standardbuchung über dieselbe direkte Aufrufart: Mietart bleibt Standard, Ende bleibt Pflicht
// mit action={formAction} am Buchungsformular ist die Aktion ans Formular gebunden, ohne (älterer Stand) nur im RSC-Payload
const stdCreateId = actionIdOf(ueOnNew, "createBookingAction", "bound") || actionIdOf(ueOnNew, "createBookingAction", "other");
/** ID einer gebundenen Aktion (Entwicklungsserver nennt sie „bound <Name>“). */
const boundIdOf = (html: string, name: string) => [...html.matchAll(/([0-9a-f]{42})\\?",\\?"bound\\?":\\?"\$@[0-9a-f]+\\?",\\?"name\\?":\\?"bound (\w+)/g)].find((m) => m[2] === name)?.[1] ?? "";
const stdStart = new Date(ueStart.getTime() + 20 * 86400_000);
// Befehl 29: Standardbuchungen rechnen über einen Miettarif der Fahrzeuggruppe (ohne Tarif keine neue Buchung)
const stdForm = { customerMode: "existing", customerId: ue.customerId, vehicleId: ueV3.id, startAt: toDateTimeInput(stdStart), endAt: toDateTimeInput(new Date(stdStart.getTime() + 2 * 86400_000)), payIntent: "NONE" };
const stdNoTariff = actionState((await callAction("/buchungen/neu", stdCreateId, ueDispo, { form: stdForm })).text);
report(stdNoTariff?.error === "Bitte einen Miettarif wählen." && (await db.booking.count({ where: { tenantId: ue.tenantId, vehicleId: ueV3.id, startAt: stdStart } })) === 0, "Standardbuchung ohne Miettarif: verständlich abgelehnt, nichts angelegt");
const uePlan = await createRatePlan(ue.tenantId, ue.actor, { meta: { name: "SMOKE PLUS", code: null, description: null, sortOrder: 0 }, content: { km: { policy: "FREE_KILOMETERS", kmIncludedPerDay: 200, extraKmRateCents: 25 }, depositCents: 0, groups: [{ groupId: ue.groupId, tiers: [{ days: 1, cents: 6500 }, { days: 7, cents: 39900 }], depositCents: null, km: null }] }, active: true, createKey: `smoke-tarif-${Date.now()}` });
const stdTariffForm = { ...stdForm, ratePlanId: uePlan.id, priceMode: "TARIFF", kmMode: "TARIFF", depositMode: "TARIFF" };
const stdNoEnd = actionState((await callAction("/buchungen/neu", stdCreateId, ueDispo, { form: { ...stdTariffForm, endAt: "" } })).text);
report(stdNoEnd?.error === "Bitte Rückgabe mit Datum und Uhrzeit angeben.", "Standardbuchung: Rückgabe bleibt Pflicht");
const stdStale = actionState((await callAction("/buchungen/neu", stdCreateId, ueDispo, { form: { ...stdTariffForm, seenRegularCents: "100" } })).text);
report(!!stdStale?.error && /geändert/.test(stdStale.error) && (await db.booking.count({ where: { tenantId: ue.tenantId, vehicleId: ueV3.id, startAt: stdStart } })) === 0, "Standardbuchung mit veraltetem Tarifpreis aus der Vorschau: abgelehnt, keine versteckte Preisänderung");
const stdNoReason = actionState((await callAction("/buchungen/neu", stdCreateId, ueDispo, { form: { ...stdTariffForm, priceMode: "INDIVIDUAL", agreedPrice: "0", priceReason: "" } })).text);
report(!!stdNoReason?.error && /Grund/.test(stdNoReason.error), "Individueller Preis ohne Grund: abgelehnt");
const stdCall = await callAction("/buchungen/neu", stdCreateId, ueDispo, { form: stdTariffForm });
const stdBooking = await db.booking.findFirst({ where: { tenantId: ue.tenantId, vehicleId: ueV3.id, startAt: stdStart } });
report(stdBooking?.rentalType === "STANDARD" && stdBooking.endAt !== null && Number(stdBooking.dailyRate) === 65 && stdBooking.ratePlanId === uePlan.id && stdBooking.regularPriceCents === 11_700 && stdCall.redirectTo.includes(`/buchungen/${stdBooking.id}`), `${stdCall.status} Standardbuchung bei freigeschaltetem Unfallersatz: als Standardmiete mit Miettarif angelegt (2 Tage = 130 € − 10 % Kundenrabatt = 117 €; gespeichert ${stdBooking?.regularPriceCents})`);
// Befehl 29: Tarifseiten, Rechte (serverseitig) und Anzeige
{
  const tg = async (c: string, p: string) => { const r = await fetch(`${base}${p}`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, location: r.headers.get("location") ?? "", html: r.status === 200 ? await plain(r) : "" }; };
  const tOwner = await tg(ueOwner, "/einstellungen/tarife");
  report(tOwner.status === 200 && tOwner.html.includes("SMOKE PLUS") && tOwner.html.includes("Tarif anlegen"), `${tOwner.status} Miettarife (Inhaber): Übersicht mit Anlegen`);
  const tDispo = await tg(ueDispo, "/einstellungen/tarife");
  report(tDispo.status === 200 && tDispo.html.includes("SMOKE PLUS") && !tDispo.html.includes("Tarif anlegen"), `${tDispo.status} Miettarife (Disposition): nur lesend`);
  const tNewDispo = await tg(ueDispo, "/einstellungen/tarife/neu");
  report(tNewDispo.status === 307 && decodeURIComponent(tNewDispo.location).includes("fehler=rechte"), `${tNewDispo.status} Tarif anlegen (Disposition): verweigert`);
  const tEdit = await tg(ueOwner, `/einstellungen/tarife/${uePlan.id}`);
  report(tEdit.status === 200 && tEdit.html.includes("SMOKE PLUS") && tEdit.html.includes("Revision") && tEdit.html.includes("Fahrzeugpreise") && tEdit.html.includes("Änderungen speichern"), `${tEdit.status} Tarif bearbeiten (Inhaber): Editor, Revisionen, Fahrzeugpreise`);
  const tYard = await tg(ueYard, `/einstellungen/tarife/${uePlan.id}`);
  report(tYard.status === 200 && tYard.html.includes("SMOKE PLUS") && !tYard.html.includes("Änderungen speichern") && !tYard.html.includes("Duplizieren"), `${tYard.status} Tarif (Hof): nur Ansicht, keine Bearbeitung`);
  const tForeign = await tg(ueOwner, `/einstellungen/tarife/${(await db.ratePlan.findFirst({ where: { tenantId: { not: ue.tenantId } } }))?.id ?? "fremd"}`);
  report(tForeign.status === 404 || (tForeign.status === 200 && !tForeign.html.includes("Revision")), `${tForeign.status} fremder Tarif: nicht auffindbar`);
  // direkter Aufruf der Tarif-Aktionen ohne Inhaberrolle
  const createId = actionIdOf((await tg(ueOwner, "/einstellungen/tarife/neu")).html, "createRatePlanAction", "bound");
  const plansBefore = await db.ratePlan.count({ where: { tenantId: ue.tenantId } });
  const dispoCreate = await callAction("/einstellungen/tarife/neu", createId, ueDispo, { form: { name: "HACK", content: "{}", createKey: `k-${Date.now()}` } });
  report(/^[0-9a-f]{42}$/.test(createId) && dispoCreate.redirectTo.includes("fehler=rechte") && (await db.ratePlan.count({ where: { tenantId: ue.tenantId } })) === plansBefore, `${dispoCreate.status} Tarif anlegen per Direktaufruf (Disposition): verweigert, nichts angelegt`);
  const vOwner = await tg(ueOwner, `/fahrzeuge/${ueV3.id}`);
  const rateId = boundIdOf(vOwner.html, "setVehicleRateOverrideAction") || actionIdOf(vOwner.html, "setVehicleRateOverrideAction", "bound");
  report(vOwner.status === 200 && vOwner.html.includes("Tarifpreise") && vOwner.html.includes("Preis aus Fahrzeuggruppe") && vOwner.html.includes("Fahrzeugpreis bearbeiten"), `${vOwner.status} Fahrzeugakte (Inhaber): Tarifpreise mit Bearbeiten`);
  const vDispo = await tg(ueDispo, `/fahrzeuge/${ueV3.id}`);
  report(vDispo.status === 200 && vDispo.html.includes("Tarifpreise") && !vDispo.html.includes("Fahrzeugpreis bearbeiten"), `${vDispo.status} Fahrzeugakte (Disposition): Tarifpreise nur lesend`);
  if (rateId) {
    const dispoRate = await callAction(`/fahrzeuge/${ueV3.id}`, rateId, ueDispo, { form: { tier_1: "1" }, bound: [ueV3.id, uePlan.id] });
    report(dispoRate.redirectTo.includes("fehler=rechte") && (await db.vehicleRateOverride.count({ where: { tenantId: ue.tenantId } })) === 0, `${dispoRate.status} Fahrzeugpreis per Direktaufruf (Disposition): verweigert`);
  } else report(false, "Fahrzeugpreis-Aktion in der Fahrzeugakte nicht gefunden");
  const vList = await tg(ueDispo, "/fahrzeuge");
  report(vList.status === 200 && vList.html.includes("Standardtarif") && vList.html.includes("SMOKE PLUS"), `${vList.status} Fahrzeugliste: Standardtarif je Fahrzeug`);
  const bNew = await tg(ueDispo, "/buchungen/neu");
  report(bNew.status === 200 && bNew.html.includes("Miettarif"), `${bNew.status} Neue Buchung: Tarifauswahl`);
  const bStd = await tg(ueDispo, `/buchungen/${stdBooking?.id}`);
  report(bStd.status === 200 && bStd.html.includes("SMOKE PLUS") && !bStd.html.includes(uePlan.id + "\""), `${bStd.status} Buchung: Tarif angezeigt`);
  const groupsPage = await tg(ueOwner, "/fahrzeuge/gruppen");
  report(groupsPage.status === 200 && groupsPage.html.includes("SMOKE PLUS"), `${groupsPage.status} Fahrzeuggruppen: Tarife je Gruppe`);
}

// Befehl 29 Phase D: Fallakte /unfallersatz/[id] – Inhaber/Disposition vollständig, Hof nur operativ (serverseitig, auch im
// RSC-Payload), Freischaltung, Mandantentrennung, direkte Aufrufe der Fallakten-Aktionen mit beliebiger Fall-ID
const ueCaseId = ueCase!.id;
const caseUrl = `/unfallersatz/${ueCaseId}`;
const caseAs = async (c: string, q = "") => { const r = await fetch(`${base}${caseUrl}${q}`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, location: r.headers.get("location") ?? "", html: r.status === 200 ? await plain(r) : "" }; };
const ownerCase = await caseAs(ueOwner, "?angelegt=1");
report(ownerCase.status === 200 && ownerCase.html.includes(ueCase!.caseNumber) && ownerCase.html.includes("ist angelegt") && ownerCase.html.includes("Nächste Schritte") && ownerCase.html.includes("Schadennummer der Versicherung fehlt") && ownerCase.html.includes("Smoke Versicherung AG") && ownerCase.html.includes("Mietende offen"), `${ownerCase.status} Fallakte (Inhaber): Kopf, Erfolgshinweis, nächste Schritte, offenes Mietende`);
report(ownerCase.html.includes("Wiedervorlagen") && ownerCase.html.includes("Fall abschließen") && ownerCase.html.includes("Noch nicht abgerechnet"), "Fallakte (Inhaber): Wiedervorlagen, Abschluss, Rechnungsstatus");
for (const [tab, marker] of [["schadenfall", "Beschädigtes Fahrzeug"], ["miete", "Ersatzfahrzeug und Zeitraum"], ["dokumente", "Vertragsunterlagen"], ["abrechnung", "Noch keine Unfallersatz-Rechnung vorhanden."], ["verlauf", "Fall angelegt"]] as const) {
  const pg = await caseAs(ueDispo, `?tab=${tab}`);
  report(pg.status === 200 && pg.html.includes(marker), `${pg.status} Fallakte (Disposition): Bereich ${tab}`);
}
// Hof: operative Sicht – keine Versicherung, kein Schadenfall, kein Tarif, keine Wiedervorlagen; verbotene Bereiche fallen auf die Übersicht zurück
const yardLeaks = (html: string) => ["Smoke Versicherung", "HB-AB 99", "Schadennummer", "Wiedervorlage", "55,00", "35,00", "Beschädigtes Fahrzeug", "Noch keine Unfallersatz-Rechnung"].filter((x) => html.includes(x));
const yardViews = [await caseAs(ueYard), await caseAs(ueYard, "?tab=abrechnung"), await caseAs(ueYard, "?tab=schadenfall"), await caseAs(ueYard, "?tab=miete"), await caseAs(ueYard, "?tab=verlauf")];
report(yardViews.every((v) => v.status === 200) && yardViews[0].html.includes("Operative Ansicht") && yardViews[0].html.includes("HB-UE 900") && yardViews[1].html.includes("Nächste Schritte"), `${yardViews.map((v) => v.status).join("/")} Fallakte (Hof): operative Ansicht, verbotene Bereiche zeigen die Übersicht`);
const leaks = [...new Set(yardViews.flatMap((v) => yardLeaks(v.html)))];
report(leaks.length === 0, `Fallakte (Hof): keine kaufmännischen Daten im HTML/RSC-Payload${leaks.length ? ` – gefunden: ${leaks.join(", ")}` : ""}`);
// fremder Mandant (mit freigeschaltetem Modul): Fall nicht auffindbar
await setTenantFeature({ id: admin.id, name: admin.name }, foreign.tenantId, "ACCIDENT_REPLACEMENT", true, "Smoke Phase D");
const foreignUeCase = await caseAs(`rb_session=${foreignSession}`);
report(foreignUeCase.status === 404, `${foreignUeCase.status} Fallakte: fremder Mandant findet den Fall nicht`);
// direkte Aufrufe der Fallakten-Aktionen
const dispoMiete = (await caseAs(ueDispo, "?tab=miete")).html, dispoOverview = (await caseAs(ueDispo)).html, dispoSchaden = (await caseAs(ueDispo, "?tab=schadenfall")).html;
const idPlanned = boundIdOf(dispoMiete, "updatePlannedEndAction"), idClose = boundIdOf(dispoOverview, "closeCaseAction"), idFollow = boundIdOf(dispoOverview, "createFollowUpAction"), idInsurer = boundIdOf(dispoSchaden, "updateInsurerAction");
report([idPlanned, idClose, idFollow, idInsurer].every((x) => /^[0-9a-f]{42}$/.test(x)), "Aktions-IDs der Fallakte ermittelt");
const yardClose = await callAction(caseUrl, idClose, ueYard, { bound: [ueCaseId], form: { reason: "Hof schließt den Fall" } });
report(yardClose.redirectTo.includes("fehler=rechte") && (await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: ueCaseId } })).status === "OPEN", `${yardClose.status} Direkter Aufruf als Hofmitarbeiter: Abschluss abgewiesen`);
const endBefore = (await db.booking.findUniqueOrThrow({ where: { id: ueCase!.bookingId } })).endAt;
const foreignEnd = actionState((await callAction(caseUrl, idPlanned, `rb_session=${foreignSession}`, { bound: [ueCaseId], form: { endMode: "known", plannedEndAt: toDateTimeInput(new Date(ueStart.getTime() + 5 * 86400_000)), reason: "fremder Mandant" } })).text);
report(foreignEnd?.error === "Unfallersatzfall nicht gefunden." && (await db.booking.findUniqueOrThrow({ where: { id: ueCase!.bookingId } })).endAt?.getTime() === endBefore?.getTime(), "Direkter Aufruf aus fremdem Mandanten: Fall nicht gefunden, Mietende unverändert");
await setTenantFeature({ id: admin.id, name: admin.name }, foreign.tenantId, "ACCIDENT_REPLACEMENT", false, "Smoke Phase D");
const ueBookingsBefore = await db.booking.count({ where: { tenantId: ue.tenantId } });
const plannedOk = await callAction(caseUrl, idPlanned, ueDispo, { bound: [ueCaseId], form: { endMode: "known", plannedEndAt: toDateTimeInput(new Date(ueStart.getTime() + 5 * 86400_000)), reason: "Smoke: Reparaturende laut Werkstatt" } });
const endAfter = (await db.booking.findUniqueOrThrow({ where: { id: ueCase!.bookingId } })).endAt;
report(endAfter?.getTime() === new Date(ueStart.getTime() + 5 * 86400_000).getTime() && (await db.accidentReplacementCaseEvent.count({ where: { caseId: ueCaseId, type: "PLANNED_END_CHANGED" } })) === 1 && (await db.booking.count({ where: { tenantId: ue.tenantId } })) === ueBookingsBefore, `${plannedOk.status} Disposition: Mietdauer aktualisiert, Verlaufseintrag, keine neue Buchung`);
const followOk = actionState((await callAction(caseUrl, idFollow, ueDispo, { bound: [ueCaseId], form: { title: "Smoke: Schadennummer nachfragen", dueDate: toDateInputValue(new Date()) } })).text);
report((await db.caseFollowUp.count({ where: { caseId: ueCaseId, status: "OPEN" } })) === 1 && !followOk?.error, "Disposition: Wiedervorlage angelegt");
const partnerBefore = await db.businessPartner.findFirstOrThrow({ where: { tenantId: ue.tenantId, kind: "INSURER" } });
await callAction(caseUrl, idInsurer, ueDispo, { bound: [ueCaseId], form: { insurerName: "Smoke Versicherung AG", insurerClaimNumber: "SN-SMOKE-1", insurerPhone: "0421 777" } });
const caseAfter = await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: ueCaseId } });
const partnerAfter = await db.businessPartner.findUniqueOrThrow({ where: { id: partnerBefore.id } });
report(caseAfter.insurerClaimNumber === "SN-SMOKE-1" && partnerAfter.phone === partnerBefore.phone && partnerAfter.useCount === partnerBefore.useCount, "Disposition: Schadennummer in der Fall-Kopie, Adressbuch unverändert");
const ownerAfter = await caseAs(ueOwner);
report(ownerAfter.html.includes("SN-SMOKE-1") && !ownerAfter.html.includes("Schadennummer der Versicherung fehlt") && ownerAfter.html.includes("Smoke: Schadennummer nachfragen") && ownerAfter.html.includes("heute fällig"), "Fallakte: Schadennummer ergänzt, Wiedervorlage heute fällig sichtbar");
// Hof nach dem Anlegen der Daten erneut: Schadennummer, Wiedervorlage, Mietdauer-Grund und Versicherung bleiben unsichtbar
const yardAfter = [await caseAs(ueYard), await caseAs(ueYard, "?tab=verlauf"), await caseAs(ueYard, "?tab=miete"), await caseAs(ueYard, "?tab=dokumente")];
const yardLeaks2 = [...new Set(yardAfter.flatMap((v) => ["SN-SMOKE-1", "Smoke: Schadennummer nachfragen", "Smoke: Reparaturende", "Smoke Versicherung", "0421 777"].filter((x) => v.html.includes(x))))];
report(yardAfter.every((v) => v.status === 200) && yardLeaks2.length === 0 && yardAfter[1].html.includes("Geplantes Mietende geändert"), `Fallakte (Hof) nach Änderungen: Verlauf ohne Gründe, keine kaufmännischen Daten${yardLeaks2.length ? ` – gefunden: ${yardLeaks2.join(", ")}` : ""}`);
// geschlossener Fall: nur lesend, keine Knöpfe, die serverseitig scheitern würden; direkte Aktion verständlich abgelehnt
const closeCall = actionState((await callAction(caseUrl, idClose, ueDispo, { bound: [ueCaseId], form: { reason: "Smoke: Fall erledigt", acknowledge: "1" } })).text);
const closedPage = await caseAs(ueDispo), closedSchaden = await caseAs(ueDispo, "?tab=schadenfall"), closedMiete = await caseAs(ueDispo, "?tab=miete");
report(!closeCall?.error && (await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: ueCaseId } })).status === "CLOSED" && closedPage.html.includes("Die Fallakte ist nur noch lesbar") && !closedPage.html.includes("Wiedervorlage anlegen") && !closedPage.html.includes(">Mietdauer aktualisieren<") && !closedSchaden.html.includes(">Bearbeiten<") && !closedSchaden.html.includes("Haftung ändern") && !closedMiete.html.includes(">Mietdauer aktualisieren<") && closedPage.html.includes("Fall wieder öffnen"), "Geschlossener Fall: nur lesbar, keine Bearbeiten-, Mietdauer- oder Wiedervorlage-Knöpfe, Wiederöffnen mit Grund möglich");
const closedFollow = actionState((await callAction(caseUrl, idFollow, ueDispo, { bound: [ueCaseId], form: { title: "nach Abschluss", dueDate: toDateInputValue(new Date()) } })).text);
report(Boolean(closedFollow?.error?.includes("abgeschlossen")) && (await db.caseFollowUp.count({ where: { caseId: ueCaseId } })) === 1, "Geschlossener Fall: direkte Aktion verständlich abgelehnt, nichts angelegt");
// Freischaltung aus: Fallakte gesperrt, Buchung ohne Link
await setTenantFeature({ id: admin.id, name: admin.name }, ue.tenantId, "ACCIDENT_REPLACEMENT", false, "Smoke Phase D");
const offCase = await caseAs(ueOwner);
const offBooking = await plain(await fetch(`${base}/buchungen/${ueCase!.bookingId}`, { headers: { cookie: ueOwner } }));
report(offCase.status === 307 && offCase.location.includes("fehler=funktion") && !offBooking.includes("Unfallersatzfall öffnen"), `${offCase.status} Freischaltung aus: Fallakte gesperrt, kein Link auf der Buchung`);
await setTenantFeature({ id: admin.id, name: admin.name }, ue.tenantId, "ACCIDENT_REPLACEMENT", true, "Smoke Phase D");

// Befehl 29 Phase E: Unfallersatz-Vertrag mit offenem Mietende über den bestehenden Vertragsassistenten (direkter Aufruf wie das
// Formular), Rollen, Unterschrift, Abschluss, Übergabe, laufende und zurückgegebene Miete (Seiten), geschlossener Fall sperrt
// serverseitig, Standardvertrag unverändert. Eigener Block, damit die Namen nicht mit früheren Teilen kollidieren.
{
  const ONLY_CLOSED = "Der Unfallersatzfall ist abgeschlossen und kann nicht mehr bearbeitet werden.";
  const ue2 = await db.accidentReplacementCase.findFirstOrThrow({ where: { tenantId: ue.tenantId, id: { not: ueCaseId } } });
  const ue2Booking = ue2.bookingId;
  const vUrl = `/buchungen/${ue2Booking}/vertrag`;
  const vPage = async (c: string, url: string, q = "") => { const r = await fetch(`${base}${url}${q}`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, location: r.headers.get("location") ?? "", html: r.status === 200 ? await plain(r) : "" }; };
  const NO_ZERO = (html: string) => !/>0,00\s€</.test(html) && !/\b0 Tage\b/.test(html);

  const step3 = await vPage(ueDispo, vUrl, "?schritt=3");
  report(step3.status === 200 && step3.html.includes("Mietzeitraum und Tarif") && step3.html.includes("offen – bis zur Rückgabe") && step3.html.includes("nur Disposition, nicht Vertragsinhalt") && !step3.html.includes("Woche (5 Tage)"), `${step3.status} Vertrag Schritt 3 (Unfallersatz): Mietende offen, geplantes Ende nur als Disposition, keine Wochen-/Monatsstaffel`);
  const step4 = await vPage(ueDispo, vUrl, "?schritt=4");
  report(step4.status === 200 && step4.html.includes("offen – bis zur Rückgabe") && !step4.html.includes('id="endAt"') && !step4.html.includes('id="startAt"') && !step4.html.includes("Abweichend vereinbarter Gesamtmietpreis") && step4.html.includes("Summe je Miettag") && step4.html.includes("Mietpreis je Miettag (Tagessatz)") && !/Mietdauer 0 Tage/.test(step4.html) && step4.html.includes("Kosten für Zusatzfahrer nur als Position im Tarif"), `${step4.status} Vertrag Schritt 4 (Unfallersatz): kein Datumsfeld fürs Ende, Tarif je Miettag, kein abweichender Gesamtpreis, keine Zusatzfahrer-Gebühr aus den Regeln`);
  const idConditions = boundIdOf(step4.html, "saveConditionsStepAction");
  const condForm = { deposit: "0", deductible: "500", kmIncludedPerDay: "150", extraKmRate: "0,30", fuelPolicy: "FULL_TO_FULL", rulesPresent: "1", kmPolicy: "FREE_KILOMETERS", petsPolicy: "BY_APPROVAL", pickupLocation: "Hof", nav: "next" };
  // Hofmitarbeiter: Vertragsseite und direkte Aufrufe der Vertragsaktionen abgewiesen, nichts verändert
  const yardV = await vPage(ueYard, vUrl);
  const yardCond = await callAction(vUrl, idConditions, ueYard, { bound: [ue2Booking], form: { ...condForm, kmIncludedPerDay: "999" } });
  report(yardV.status === 307 && decodeURIComponent(yardV.location).includes("nur Inhaber und Disponenten") && yardCond.redirectTo.includes("fehler=rechte") && (await db.rentalContract.findFirstOrThrow({ where: { bookingId: ue2Booking } })).kmIncludedPerDay !== 999, `${yardCond.status} Hofmitarbeiter: Unfallersatz-Vertrag weder sichtbar (Entwurf) noch per Direktaufruf änderbar`);
  // Mandantenregel „Zusatzfahrer 15 € je Tag“ in den Entwurf übernehmen: das ausgeblendete Feld darf sie beim Speichern nicht zurücksetzen
  const ueRules = (await db.tenant.findUniqueOrThrow({ where: { id: ue.tenantId }, select: { businessRules: true } })).businessRules;
  await db.tenant.update({ where: { id: ue.tenantId }, data: { businessRules: { ...(ueRules && typeof ueRules === "object" ? ueRules as object : {}), additionalDriverFeeType: "PER_DAY", additionalDriverFeeCents: 1500 } } });
  await adoptContractDefaults(ue.tenantId, (await db.rentalContract.findFirstOrThrow({ where: { bookingId: ue2Booking } })).id, ue.actor);
  const condCall = await callAction(vUrl, idConditions, ueDispo, { bound: [ue2Booking], form: { ...condForm, agreedTotal: "1", agreedTotalNote: "untergeschoben", endAt: "2030-01-01T10:00" } });
  const c2 = await db.rentalContract.findFirstOrThrow({ where: { bookingId: ue2Booking } });
  const c2Rules = c2.conditions as { values?: { additionalDriverFeeType?: string; additionalDriverFeeCents?: number } } | null;
  report(/^[0-9a-f]{42}$/.test(idConditions) && condCall.redirectTo.includes("schritt=5") && c2.endAt === null && c2.agreedTotal === null && c2.kmIncludedPerDay === 150 && Number(c2.deposit) === 0 && Number(c2.totalAmount) === 0, `${condCall.status} Direkter Aufruf Schritt 4: gespeichert mit offenem Ende; untergeschobenes Enddatum und Gesamtpreis wirkungslos, Kaution 0 bleibt 0`);
  // Zusatzfahrer-Preisregel ist beim Unfallersatz ausgeblendet: Speichern darf sie nicht stillschweigend auf „kostenlos“ setzen
  report(c2Rules?.values?.additionalDriverFeeType === "PER_DAY" && c2Rules?.values?.additionalDriverFeeCents === 1500 && (await db.auditLog.count({ where: { tenantId: ue.tenantId, action: "CONTRACT_BUSINESS_RULE_OVERRIDDEN", details: { path: ["field"], string_starts_with: "additionalDriverFee" } } })) === 0, "Unfallersatz Schritt 4: Zusatzfahrer-Preisregel (15 € je Tag) bleibt beim Speichern unverändert, kein Audit „überschrieben“");
  const step6 = await vPage(ueDispo, vUrl, "?schritt=6");
  report(step6.html.includes("offen – die Miete endet mit der Rückgabe des Fahrzeugs") && step6.html.includes("nach tatsächlicher Mietdauer") && step6.html.includes("Summe je Miettag") && step6.html.includes("keine Kaution vereinbart") && !step6.html.includes("Geplante Rückgabe") && NO_ZERO(step6.html), "Vertrag Zusammenfassung (Unfallersatz): Mietende offen, Mietpreis je Miettag, keine Kaution, kein Ersatzdatum, kein 0-€-Preis");
  // vor der Unterschrift: Tarif des Falls, noch nicht eingefroren
  const ue2MieteDraft = await plain(await fetch(`${base}/unfallersatz/${ue2.id}?tab=miete`, { headers: { cookie: ueDispo } }));
  report(ue2MieteDraft.includes("wird mit dem Mietvertrag unterschrieben") && !ue2MieteDraft.includes("Tarif laut unterschriebenem Mietvertrag") && (ue2MieteDraft.includes("Vertrag öffnen") || ue2MieteDraft.includes("Vertrag unterschreiben")), "Fallakte Miete (Entwurf): Vertrag öffnen/unterschreiben angeboten, Tarif noch nicht eingefroren");
  const step7 = await vPage(ueDispo, vUrl, "?schritt=7");
  const seen2 = /name="seenHash" value="([0-9a-f]{64})"/.exec(step7.html)?.[1] ?? "";
  const idSig = boundIdOf(step7.html, "saveSignatureAction"), idFinal = boundIdOf(step7.html, "finalizeContractAction");
  report(step7.html.includes("offen – bis zur Rückgabe") && step7.html.includes("je Miettag"), "Vertrag Schritt 7 (Unfallersatz): Kurzfassung mit offenem Mietende und Mietpreis je Miettag");
  const yardSig = await callAction(vUrl, idSig, ueYard, { bound: [ue2Booking], form: { role: "RENTER", signerName: "Hof", imageDataUrl: fakeSignaturePng(), seenHash: seen2 } });
  const yardFin = await callAction(vUrl, idFinal, ueYard, { bound: [ue2Booking], form: {} });
  report(yardSig.redirectTo.includes("fehler=rechte") && yardFin.redirectTo.includes("fehler=rechte") && (await db.signature.count({ where: { contractId: c2.id } })) === 0 && (await db.rentalContract.findFirstOrThrow({ where: { id: c2.id } })).status === "DRAFT", "Hofmitarbeiter: Unterschrift und Abschluss per Direktaufruf abgewiesen");
  const sigCall = await callAction(vUrl, idSig, ueDispo, { bound: [ue2Booking], form: { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: seen2 } });
  const finCall = await callAction(vUrl, idFinal, ueDispo, { bound: [ue2Booking], form: {} });
  const signed2 = await db.rentalContract.findFirstOrThrow({ where: { bookingId: ue2Booking } });
  report(sigCall.redirectTo.includes("schritt=7") && finCall.redirectTo.includes("abgeschlossen=1") && signed2.status === "SIGNED" && signed2.endAt === null && Boolean(signed2.contentHash), `${finCall.status} Unfallersatz-Vertrag per Formularaufruf unterschrieben und abgeschlossen (Mietende offen)`);
  const signedView = await vPage(ueDispo, vUrl, "?abgeschlossen=1");
  report(signedView.html.includes("Übergabe starten") && signedView.html.includes("offen – die Miete endet mit der Rückgabe"), "Abgeschlossener Unfallersatz-Vertrag: nächster Schritt Übergabe, Mietende offen");
  const ue2Miete = await plain(await fetch(`${base}/unfallersatz/${ue2.id}?tab=miete`, { headers: { cookie: ueDispo } }));
  report(ue2Miete.includes("Vertrag ansehen") && ue2Miete.includes("Übergabe starten") && !ue2Miete.includes("freigeschaltet") && ue2Miete.includes("noch kein Ist-Wert") && ue2Miete.includes("Tarif laut unterschriebenem Mietvertrag"), "Fallakte Miete: Vertrag ansehen, Übergabe starten, vor der Übergabe kein Ist-Wert, Tarif eingefroren");
  const ue2BookingSigned = await plain(await fetch(`${base}/buchungen/${ue2Booking}`, { headers: { cookie: ueDispo } }));
  report(ue2BookingSigned.includes("nach tatsächlicher Mietdauer (Tarif laut Mietvertrag)") && ue2BookingSigned.includes("offen (bis zur Rückgabe)") && !/Gesamtmietpreis<\/dt><dd[^>]*>0,00/.test(ue2BookingSigned) && ue2BookingSigned.includes("Mietende offen (bis zur Rückgabe), Tarif laut Vertrag festgeschrieben") && ue2BookingSigned.includes("noch kein Ist-Wert"), "Buchung nach Unterschrift: „Vertrag & Nachträge“ ohne 0-€-Gesamtpreis und ohne Ersatzdatum, Kosten ohne Ist-Wert");
  const ue2Pickup = await vPage(ueDispo, `/buchungen/${ue2Booking}/uebergabe`);
  const idPickup = boundIdOf(ue2Pickup.html, "startPickupAction");
  const pickCall = await callAction(`/buchungen/${ue2Booking}/uebergabe`, idPickup, ueDispo, { bound: [ue2Booking], form: {} });
  const ue2Draft = await db.handover.findFirst({ where: { bookingId: ue2Booking, type: "PICKUP", status: "DRAFT" } });
  report(/^[0-9a-f]{42}$/.test(idPickup) && pickCall.redirectTo.includes("schritt=1") && Boolean(ue2Draft), `${pickCall.status} Übergabe nach Unterschrift gestartet (bestehendes Protokoll)`);

  // Übergabe über die Fachlogik abschließen (Pflichtfotos, Checkliste, Fahrerprüfung, Unterschrift) – dann die Seiten der laufenden Miete
  await db.vehicle.update({ where: { id: ue2Draft!.vehicleId }, data: { requiredLicenseClass: "B" } });
  await updateHandoverDraft(ue.tenantId, ue2Draft!.id, { mileage: (await db.vehicle.findUniqueOrThrow({ where: { id: ue2Draft!.vehicleId } })).mileage + 10, fuelLevelEighths: 8 });
  for (const c of REQUIRED_PHOTO_CATEGORIES) { const key = buildStorageKey({ tenantId: ue.tenantId, area: "photos", bookingId: ue2Booking, contentType: "image/jpeg" }); await registerPhoto(ue.tenantId, ue.actor, { handoverId: ue2Draft!.id, storageKey: key, category: c, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key) }); }
  const ue2Items = await db.handoverChecklistItem.findMany({ where: { handoverId: ue2Draft!.id } });
  await answerChecklist(ue.tenantId, ue2Draft!.id, ue2Items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2" : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  for (const d of await db.contractDriver.findMany({ where: { tenantId: ue.tenantId, contractId: signed2.id } })) {
    const v = await startOrGetVerification(ue.tenantId, ue.actor, ue2Draft!.id, d.id);
    await recordIdentityCheck(ue.tenantId, ue.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: true });
    await recordLicenseCheck(ue.tenantId, ue.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: d.licenseNumber, licenseCountry: d.licenseCountry, licenseIssuedAt: d.licenseIssuedAt, licenseValidUntil: d.licenseValidUntil, licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false });
    await confirmVerification(ue.tenantId, ue.actor, v.id);
  }
  await saveHandoverSignature(ue.tenantId, ue.actor, ue2Draft!.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(ue.tenantId, ue2Draft!.id) });
  await finalizeHandover(ue.tenantId, ue2Draft!.id, ue.actor);
  await db.booking.update({ where: { id: ue2Booking }, data: { actualPickupAt: new Date(Date.now() - (2 * 86400_000 + 2 * 3600_000)) } });
  const listRunning = await plain(await fetch(`${base}/buchungen?filter=alle`, { headers: { cookie: ueDispo } }));
  const runningPage = await plain(await fetch(`${base}/buchungen/${ue2Booking}`, { headers: { cookie: ueDispo } }));
  const caseRunning = await plain(await fetch(`${base}/unfallersatz/${ue2.id}?tab=miete`, { headers: { cookie: ueDispo } }));
  const returnStart = await plain(await fetch(`${base}/buchungen/${ue2Booking}/rueckgabe`, { headers: { cookie: ueDispo } }));
  report(runningPage.includes("Stand jetzt") && runningPage.includes("3 Miettage") && !runningPage.includes("Miete verlängern") && NO_ZERO(listRunning) && listRunning.includes("übergeben") && caseRunning.includes("Bisher (3 Miettage, Stand jetzt)") && returnStart.includes("Rückgabe starten") && !returnStart.includes("Geplante Rückgabe: –"), "Laufende Unfallersatzmiete: Buchung, Liste, Fallakte und Rückgabeseite mit Mietwert „bis jetzt“ (3 Miettage), ohne 0-Werte und ohne Verlängerung per Nachtrag");

  // Rückgabe über die Fachlogik – danach Endwert, Fall offen, keine Standard-Mietrechnung
  const r2 = await startHandover(ue.tenantId, ue2Booking, "RETURN", ue.actor);
  await updateHandoverDraft(ue.tenantId, r2.id, { mileage: (await db.vehicle.findUniqueOrThrow({ where: { id: r2.vehicleId } })).mileage + 300, fuelLevelEighths: 8 });
  for (const c of REQUIRED_PHOTO_CATEGORIES) { const key = buildStorageKey({ tenantId: ue.tenantId, area: "photos", bookingId: ue2Booking, contentType: "image/jpeg" }); await registerPhoto(ue.tenantId, ue.actor, { handoverId: r2.id, storageKey: key, category: c, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key) }); }
  const r2Items = await db.handoverChecklistItem.findMany({ where: { handoverId: r2.id } });
  await answerChecklist(ue.tenantId, r2.id, r2Items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2" : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  await saveHandoverSignature(ue.tenantId, ue.actor, r2.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(ue.tenantId, r2.id) });
  await finalizeHandover(ue.tenantId, r2.id, ue.actor);
  const returnedPage = await plain(await fetch(`${base}/buchungen/${ue2Booking}`, { headers: { cookie: ueDispo } }));
  const returnedReturn = await plain(await fetch(`${base}/buchungen/${ue2Booking}/rueckgabe?abgeschlossen=1`, { headers: { cookie: ueDispo } }));
  const returnedInvoice = await plain(await fetch(`${base}/buchungen/${ue2Booking}/rechnung`, { headers: { cookie: ueDispo } }));
  const caseReturned = await plain(await fetch(`${base}/unfallersatz/${ue2.id}?tab=miete`, { headers: { cookie: ueDispo } }));
  report(returnedPage.includes("Endwert (3 Miettage)") && returnedReturn.includes("Der Unfallersatzfall bleibt offen") && !returnedReturn.includes(">Zur Rechnung<") && returnedInvoice.includes("Zur Abrechnung in der Fallakte") && !returnedInvoice.includes("Rechnung erstellen") && caseReturned.includes("Endwert (3 Miettage)") && caseReturned.includes("der Fall bleibt offen") && (await db.accidentReplacementCase.findUniqueOrThrow({ where: { id: ue2.id } })).status === "OPEN", "Zurückgegebene Unfallersatzmiete: Endwert (3 Miettage), Fall bleibt offen, keine Standard-Mietrechnung (Weg zur Fallakte)");

  // geschlossener Fall (aus Phase D): Vertrag, Konditionen und Übergabe serverseitig gesperrt – verständliche Meldung, nichts verändert
  const closedBookingId = ueCase!.bookingId;
  const closedV = await vPage(ueDispo, `/buchungen/${closedBookingId}/vertrag`, "?schritt=4");
  report(closedV.html.includes(ONLY_CLOSED) && !closedV.html.includes("Speichern &amp; weiter") && !closedV.html.includes("Speichern & weiter"), "Geschlossener Fall: Vertragsentwurf nur lesend, Sperre genannt");
  const closedCond = actionState((await callAction(`/buchungen/${closedBookingId}/vertrag`, idConditions, ueDispo, { bound: [closedBookingId], form: condForm })).text);
  report(closedCond?.error === ONLY_CLOSED && !TECH.test(closedCond?.error ?? ""), "Geschlossener Fall: direkter Aufruf der Vertragskonditionen abgelehnt (verständliche Meldung)");
  const closedPick = await callAction(`/buchungen/${closedBookingId}/uebergabe`, idPickup, ueDispo, { bound: [closedBookingId], form: {} });
  report(decodeURIComponent(closedPick.redirectTo).includes(ONLY_CLOSED) && (await db.handover.count({ where: { bookingId: closedBookingId } })) === 0, `${closedPick.status} Geschlossener Fall: direkter Übergabe-Start abgelehnt, kein Protokoll angelegt`);
  const closedBookingPage = await plain(await fetch(`${base}/buchungen/${closedBookingId}`, { headers: { cookie: ueDispo } }));
  report(closedBookingPage.includes("Fall abgeschlossen – gesperrt") && !closedBookingPage.includes("Mietvertrag fortsetzen") && closedBookingPage.includes("gesperrt, bis der Fall in der Fallakte wieder geöffnet wird"), "Geschlossener Fall: Buchung ohne Vertrags-/Übergabeknöpfe, Grund sichtbar");
  // Standardvertrag über dieselbe Aktion: Rückgabe bleibt Pflicht
  await ensureContractDraft(ue.tenantId, ue.bookingId, null);
  const stdStep4 = await vPage(ueDispo, `/buchungen/${ue.bookingId}/vertrag`, "?schritt=4");
  const stdNoEndCond = actionState((await callAction(`/buchungen/${ue.bookingId}/vertrag`, idConditions, ueDispo, { bound: [ue.bookingId], form: { ...condForm, startAt: toDateTimeInput(new Date(Date.now() + 86400_000)), endAt: "" } })).text);
  report(stdStep4.html.includes('id="endAt"') && stdStep4.html.includes("Abweichend vereinbarter Gesamtmietpreis") && stdNoEndCond?.error === "Bitte die geplante Rückgabe mit Datum und Uhrzeit angeben.", "Standardvertrag: Rückgabe-Feld und abweichender Preis wie bisher, Ende bleibt Pflicht");
}

// Befehl 29 Phase F: Abrechnung (Vorschau, Schlussrechnung, Empfänger), Zahlung, Kürzung, Restforderung, Dokumente über HTTP –
// Seiten, direkte Aktionsaufrufe (Hof abgewiesen), Upload/Download mit Rollen- und Mandantenprüfung, Sperre bei geschlossenem Fall.
{
  const ONLY_CLOSED_F = "Der Unfallersatzfall ist abgeschlossen und kann nicht mehr bearbeitet werden.";
  // Rechnungsstellung braucht die Rechnungsangaben des Mandanten (sonst zeigt die Abrechnung korrekt nur den Einstellungshinweis)
  await db.tenant.update({ where: { id: ue.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678" } });
  // Rechnungsabschluss verlangt eine vollständige Anschrift des Empfängers (Versicherung)
  await db.accidentReplacementCase.updateMany({ where: { tenantId: ue.tenantId, id: { not: ueCaseId } }, data: { insurerStreet: "Versicherungsplatz 1", insurerZip: "10115", insurerCity: "Berlin" } });
  const fCase = await db.accidentReplacementCase.findFirstOrThrow({ where: { tenantId: ue.tenantId, id: { not: ueCaseId } } });
  const fBooking = fCase.bookingId;
  const casePath = `/unfallersatz/${fCase.id}`;
  const fPage = async (c: string, q = "") => { const r = await fetch(`${base}${casePath}${q}`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, location: r.headers.get("location") ?? "", html: r.status === 200 ? await plain(r) : "" }; };
  const invoicesOf = () => db.invoice.findMany({ where: { tenantId: ue.tenantId, bookingId: fBooking, kind: "ACCIDENT_REPLACEMENT", documentType: "INVOICE" }, orderBy: { createdAt: "asc" } });

  const bill0 = await fPage(ueDispo, "?tab=abrechnung");
  report(bill0.status === 200 && bill0.html.includes("Abrechnen") && bill0.html.includes("Schlussrechnung als Entwurf erstellen") && bill0.html.includes("Rechnungsempfänger") && bill0.html.includes("Noch nicht abgerechnet") && bill0.html.includes("Fakturiert (wirksam)") && bill0.html.includes("Rechnungsbetrag (brutto)") && !bill0.html.includes("Abrechnung folgt"), `${bill0.status} Abrechnung (zurückgegeben): Vorschau der Schlussrechnung, Empfängerwahl, Finanzübersicht`);
  const yardBill = await fPage(ueYard, "?tab=abrechnung");
  report(yardBill.status === 200 && !yardBill.html.includes("Fakturiert") && !yardBill.html.includes("Schlussrechnung als Entwurf") && !yardBill.html.includes("Kürzung"), "Hofmitarbeiter: kein Abrechnungs-Tab, keine Beträge");
  const idCreateInv = boundIdOf(bill0.html, "createAccidentInvoiceAction");
  const createForm = { recipientRole: "INSURER", nonce: `smoke-f-${Date.now()}-a` };
  const yardCreate = await callAction(casePath, idCreateInv, ueYard, { bound: [fCase.id], form: createForm });
  report(/^[0-9a-f]{42}$/.test(idCreateInv) && yardCreate.redirectTo.includes("fehler=rechte") && (await invoicesOf()).length === 0, `${yardCreate.status} Hofmitarbeiter: Rechnung per Direktaufruf abgewiesen, nichts angelegt`);
  const otherBad = actionState((await callAction(casePath, idCreateInv, ueDispo, { bound: [fCase.id], form: { recipientRole: "OTHER", nonce: `smoke-f-${Date.now()}-o`, otherType: "COMPANY", otherCompanyName: "", otherStreet: "", otherZip: "", otherCity: "" } })).text);
  report(Boolean(otherBad?.error?.startsWith("Anderer Empfänger")) && (await invoicesOf()).length === 0, "Anderer Empfänger ohne Rechnungsdaten: verständlich abgelehnt");
  const createCall = await callAction(casePath, idCreateInv, ueDispo, { bound: [fCase.id], form: createForm });
  const fInvs = await invoicesOf();
  report(fInvs.length === 1 && createCall.redirectTo.includes(`/buchungen/${fBooking}/rechnung?nr=${fInvs[0]?.id}`), `${createCall.status} Disposition: Schlussrechnung an die Versicherung als Entwurf, weiter in den Rechnungsentwurf`);
  const again = await callAction(casePath, idCreateInv, ueDispo, { bound: [fCase.id], form: createForm });
  report((await invoicesOf()).length === 1 && again.redirectTo.includes(fInvs[0]?.id ?? "-"), "Doppelklick: derselbe Entwurf");
  const fInvId = fInvs[0].id;
  const invDraftPage = await plain(await fetch(`${base}/buchungen/${fBooking}/rechnung?nr=${fInvId}`, { headers: { cookie: ueDispo } }));
  report(invDraftPage.includes("Schlussrechnung") && invDraftPage.includes("Zur Fallakte") && invDraftPage.includes("Die Kaution des Mieters wird mit dieser Rechnung nicht verrechnet") && !invDraftPage.includes("aus Kaution verrechnen") && invDraftPage.includes("Schadennummer"), "Rechnungsentwurf: Fallbezug, Abrechnungsart, keine Kautionsverrechnung bei der Versicherung, Schadennummer bearbeitbar");
  const yardInv = await fetch(`${base}/buchungen/${fBooking}/rechnung?nr=${fInvId}`, { headers: { cookie: ueYard }, redirect: "manual" });
  report(yardInv.status === 307 && decodeURIComponent(yardInv.headers.get("location") ?? "").includes("Unfallersatz-Abrechnung sehen nur Inhaber und Disposition"), `${yardInv.status} Hofmitarbeiter: keine Unfallersatz-Rechnung (auch nicht per Adresse)`);
  const fFinal = await finalizeInvoice(ue.tenantId, fInvId, ue.actor);
  const gross = Number(fFinal.grossTotal);
  const fNumber = (await db.invoice.findUniqueOrThrow({ where: { id: fInvId }, select: { number: true } })).number ?? "-";
  const listOf = async (c: string, p: string) => plain(await fetch(`${base}${p}`, { headers: { cookie: c } }));
  const [listDispo, listYard, recvDispo, recvYard] = await Promise.all([listOf(ueDispo, "/rechnungen?filter=alle"), listOf(ueYard, "/rechnungen?filter=alle"), listOf(ueDispo, "/forderungen"), listOf(ueYard, "/forderungen")]);
  report(listDispo.includes(fNumber) && recvDispo.includes(fNumber) && !listYard.includes(fNumber) && !recvYard.includes(fNumber) && !listYard.includes("art=unfallersatz"), "Hofmitarbeiter: Unfallersatz-Rechnung weder in der Rechnungs- noch in der Forderungsliste");

  // Zahlung über die Fallakte (Teilzahlung); Hof per Direktaufruf abgewiesen
  const bill1 = await fPage(ueDispo, "?tab=abrechnung");
  const idPay = boundIdOf(bill1.html, "recordAccidentPaymentAction");
  const payForm = { amount: "20,00", method: "BANK_TRANSFER", paidAt: toDateTimeInput(new Date()), reference: "Smoke Versicherung", nonce: `smoke-f-${Date.now()}-p` };
  const yardPay = await callAction(casePath, idPay, ueYard, { bound: [fCase.id, fInvId], form: payForm });
  const payCall = actionState((await callAction(casePath, idPay, ueDispo, { bound: [fCase.id, fInvId], form: payForm })).text);
  const paid = await db.payment.findMany({ where: { invoiceId: fInvId, status: "CONFIRMED" } });
  report(bill1.html.includes("Zahlung erfassen") && bill1.html.includes("Kürzung dokumentieren") && yardPay.redirectTo.includes("fehler=rechte") && !payCall?.error && paid.length === 1 && paid[0].amountCents === 2_000, "Zahlung über die Fallakte erfasst (Teilzahlung); Hof per Direktaufruf abgewiesen");

  // Dokumente: Upload (PDF ja, HTML als PDF nein, Hof nein, geschlossener Fall nein), Download nur Inhaber/Disposition des Mandanten
  const upload = async (c: string, caseId: string, bytes: Uint8Array, type = "INSURER_LETTER", name = "Kuerzungsschreiben.pdf") => {
    const body = new FormData();
    body.set("file", new Blob([bytes as BlobPart], { type: "application/pdf" }), name);
    body.set("type", type);
    const r = await fetch(`${base}/api/accident-cases/${caseId}/documents`, { method: "POST", headers: { cookie: c }, body });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as { id?: string; error?: string } };
  };
  const pdfBytes = new TextEncoder().encode("%PDF-1.4\n% Kürzungsschreiben Smoke\n%%EOF\n");
  const upOk = await upload(ueDispo, fCase.id, pdfBytes);
  const upHtml = await upload(ueDispo, fCase.id, new TextEncoder().encode("<html><script>alert(1)</script></html>"));
  const upYard = await upload(ueYard, fCase.id, pdfBytes);
  const upForeign = await upload(cookie, fCase.id, pdfBytes);
  report(upOk.status === 201 && Boolean(upOk.json.id) && upHtml.status === 415 && upYard.status === 403 && upForeign.status !== 201 && (await db.accidentReplacementCaseDocument.count({ where: { caseId: fCase.id } })) === 1, `${upOk.status}/${upHtml.status}/${upYard.status}/${upForeign.status} Upload: PDF angenommen, HTML als PDF abgelehnt, Hof und fremder Mandant abgewiesen`);
  const docId = upOk.json.id ?? "-";
  const dl = await fetch(`${base}/api/accident-documents/${docId}?download=1`, { headers: { cookie: ueDispo } });
  const dlBody = new Uint8Array(await dl.arrayBuffer());
  const dlYard = await fetch(`${base}/api/accident-documents/${docId}`, { headers: { cookie: ueYard } });
  const dlForeign = await fetch(`${base}/api/accident-documents/${docId}`, { headers: { cookie } });
  const dlGuess = await fetch(`${base}/api/accident-documents/${docId}x`, { headers: { cookie: ueDispo } });
  report(dl.status === 200 && dlBody.length === pdfBytes.length && (dl.headers.get("content-disposition") ?? "").startsWith("attachment") && (dl.headers.get("cache-control") ?? "").includes("no-store") && dl.headers.get("x-content-type-options") === "nosniff" && dlYard.status === 403 && dlForeign.status !== 200 && dlGuess.status === 404, `${dl.status}/${dlYard.status}/${dlForeign.status}/${dlGuess.status} Download: Inhaber/Disposition mit no-store und nosniff; Hof, fremder Mandant und erratene ID ohne Zugriff`);
  const docsTab = await fPage(ueDispo, "?tab=dokumente");
  report(docsTab.html.includes("Versicherung") && docsTab.html.includes("Kuerzungsschreiben.pdf") && docsTab.html.includes(`/api/accident-documents/${docId}`) && docsTab.html.includes("Dokument hochladen") && docsTab.html.includes("Vertragsunterlagen"), "Dokumente-Tab: gruppiert, Versichererschreiben mit Öffnen/Herunterladen, Upload");
  const yardDocs = await fPage(ueYard, "?tab=dokumente");
  report(yardDocs.status === 200 && !yardDocs.html.includes("Kuerzungsschreiben.pdf") && !yardDocs.html.includes("Dokument hochladen"), "Hofmitarbeiter: keine Unfallersatz-Dokumente, kein Upload");

  // Kürzung über die Fallakte mit dem Schreiben; offener Betrag bleibt; Restforderung nur mit Bestätigung
  const idAdj = boundIdOf(bill1.html, "recordAccidentAdjustmentAction");
  const adjCall = actionState((await callAction(casePath, idAdj, ueDispo, { bound: [fCase.id, fInvId], form: { reasonKind: "TARIFF", amount: "10,00", decidedAt: toDateInputValue(new Date()), note: "Smoke-Kürzung", documentId: docId } })).text);
  const adjRow = await db.invoiceAdjustment.findFirst({ where: { invoiceId: fInvId } });
  const yardAdj = await callAction(casePath, idAdj, ueYard, { bound: [fCase.id, fInvId], form: { reasonKind: "TARIFF", amount: "1,00", decidedAt: toDateInputValue(new Date()) } });
  const bill2 = await fPage(ueDispo, "?tab=abrechnung");
  const openAfter = Math.round(gross * 100) - 2_000;
  report(!adjCall?.error && adjRow?.documentId === docId && adjRow?.amountCents === 1_000 && yardAdj.redirectTo.includes("fehler=rechte") && bill2.html.includes("Kürzung dokumentiert") && bill2.html.includes("Restforderung an Mieter erstellen") && bill2.html.includes("mindern die offene Forderung nicht"), "Kürzung mit Versichererschreiben dokumentiert; Hof abgewiesen; Restforderung wird angeboten");
  report((await db.invoice.findUniqueOrThrow({ where: { id: fInvId }, select: { currentVersion: { select: { grossTotal: true } } } })).currentVersion!.grossTotal.toString() === fFinal.grossTotal.toString() && openAfter > 0, "Kürzung ändert den Rechnungsbetrag nicht");
  const idRem = boundIdOf(bill2.html, "createAccidentRemainderAction");
  const remNoAck = actionState((await callAction(casePath, idRem, ueDispo, { bound: [fCase.id, fInvId], form: { amount: "10,00", nonce: `smoke-f-${Date.now()}-r` } })).text);
  const remCall = await callAction(casePath, idRem, ueDispo, { bound: [fCase.id, fInvId], form: { amount: "10,00", nonce: `smoke-f-${Date.now()}-r2`, acknowledge: "1" } });
  const remInv = (await invoicesOf()).find((i) => i.id !== fInvId);
  report(Boolean(remNoAck?.error?.includes("bestätigen")) && Boolean(remInv) && remCall.redirectTo.includes(remInv?.id ?? "-"), `${remCall.status} Restforderung an den Mieter nur mit ausdrücklicher Bestätigung (Entwurf)`);
  const remPage = await plain(await fetch(`${base}/buchungen/${fBooking}/rechnung?nr=${remInv?.id}`, { headers: { cookie: ueDispo } }));
  report(remPage.includes("Derselbe Betrag ist auch in der Rechnung") && remPage.includes("per Gutschrift mindern"), "Restforderung im Entwurf: deutliche Warnung zur Doppelforderung");

  // geschlossener Fall: keine neue Zahlung, kein Upload; Abrechnung nur lesbar, Dokumente abrufbar
  const closeCall = actionState((await callAction(casePath, idClose, ueDispo, { bound: [fCase.id], form: { reason: "Smoke Phase F", acknowledge: "1" } })).text);
  const payClosed = actionState((await callAction(casePath, idPay, ueDispo, { bound: [fCase.id, fInvId], form: { ...payForm, nonce: `smoke-f-${Date.now()}-pc` } })).text);
  const upClosed = await upload(ueDispo, fCase.id, pdfBytes);
  const billClosed = await fPage(ueDispo, "?tab=abrechnung");
  const dlClosed = await fetch(`${base}/api/accident-documents/${docId}`, { headers: { cookie: ueDispo } });
  report(!closeCall?.error && payClosed?.error === ONLY_CLOSED_F && upClosed.status === 409 && upClosed.json.error === ONLY_CLOSED_F && billClosed.html.includes("Der Fall ist abgeschlossen. Neue Rechnungen") && !billClosed.html.includes("Zahlung erfassen") && dlClosed.status === 200 && (await db.payment.count({ where: { invoiceId: fInvId } })) === 1, "Geschlossener Fall: Zahlung und Upload abgelehnt (verständliche Meldung), Abrechnung nur lesbar, Dokument weiter abrufbar");
}

// Praxistest-Korrekturrunde: Unfallersatz im Dispo-Kalender (Kennzeichnung, Weg in die Fallakte), auf „Heute“ (Kennzahl, Hof ohne
// Finanzdaten) und die Kaution des Mieters in der Fallakte (bestehender Kautionsbereich, Hof-Direktaufruf abgewiesen).
{
  const kV = await db.vehicle.create({ data: { tenantId: ue.tenantId, plate: "HB-UE 902", make: "Seat", model: "Leon", groupId: ue.groupId, dailyRate: 52, deposit: 0, mileage: 12_000, requiredLicenseClass: "B" } });
  const kCase = await createAccidentCase(ue.tenantId, ue.actor, {
    nonce: `smoke-k-${Date.now()}`, customerId: ue.customerId, vehicleId: kV.id, startAt: new Date(Date.now() + 3600_000), plannedEndAt: null, dailyRateCents: 6_900, depositCents: 50_000, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "HB-KK 1", make: "BMW", model: "320d", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: new Date(Date.now() - 86400_000), place: "Bremen" },
    insurer: { name: "Kautionsprobe Versicherung AG", claimNumber: "KP-1", contactName: null, phone: null, email: null, street: "Weg 1", zip: "28195", city: "Bremen" },
    liability: { status: "CONFIRMED" },
    tariff: [],
  });
  const kBooking = kCase.bookingId;
  const kNumber = kCase.case.caseNumber;
  const page = async (c: string, p: string) => plain(await fetch(`${base}${p}`, { headers: { cookie: c } }));

  // Dispo: Unfallersatz textlich gekennzeichnet, Liste mit Weg in die Fallakte; Standard-Mandant ohne fremde Fälle
  const dispoUe = await page(ueDispo, "/dispo");
  const dispoYard = await page(ueYard, "/dispo");
  const dispoStd = await page(cookie, "/dispo");
  report(dispoUe.includes("Unfallersatz im Zeitraum") && dispoUe.includes(`href="/unfallersatz/${kCase.case.id}"`) && dispoUe.includes("Unfallersatzfall öffnen") && dispoUe.includes(`Unfallersatz ${kNumber}`) && dispoUe.includes("Mietende offen") && dispoUe.includes(">UE<") && dispoUe.includes("= Unfallersatz"), "Dispo: Unfallersatz als Text gekennzeichnet, Liste „Unfallersatz im Zeitraum“ mit „Unfallersatzfall öffnen“");
  report(dispoYard.includes(`href="/unfallersatz/${kCase.case.id}"`) && !dispoYard.includes("Kautionsprobe Versicherung"), "Dispo (Hof): Weg in die (operative) Fallakte, keine Versicherungsdaten");
  report(!dispoStd.includes("Unfallersatz im Zeitraum") && !dispoStd.includes(kNumber) && !dispoStd.includes("Kautionsprobe"), "Dispo: anderer Mandant sieht keinen fremden Unfallersatzfall");

  // Heute: Kennzahl Unfallersatz (offene Fälle); der Hof nur Fallzahl und laufende Mieten
  const heuteUe = await page(ueDispo, "/heute");
  const heuteYard = await page(ueYard, "/heute");
  report(heuteUe.includes("Unfallersatz") && /offene Fälle|offener Fall/.test(heuteUe) && heuteUe.includes("abzurechnen") && heuteUe.includes("fällige Wiedervorlage"), "Heute: Kennzahl Unfallersatz mit offenen Fällen, abzurechnen und fälligen Wiedervorlagen");
  report(heuteYard.includes("Unfallersatz") && /offene Fälle|offener Fall/.test(heuteYard) && !heuteYard.includes("abzurechnen") && !heuteYard.includes("Kautionsprobe Versicherung") && !heuteYard.includes("Schadennummer"), "Heute (Hof): nur Fallzahl und laufende Mieten, keine Abrechnungs- oder Versicherungsdaten");

  // Vertrag mit Kaution 500 €, Übergabe, Kautionseingang, Rückgabe – über die Fachlogik
  const kContract = await db.rentalContract.findFirstOrThrow({ where: { tenantId: ue.tenantId, bookingId: kBooking } });
  const kBk = await db.booking.findUniqueOrThrow({ where: { id: kBooking } });
  await saveConditions(ue.tenantId, kContract.id, { startAt: kBk.startAt, endAt: null, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 500, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: null }, ue.actor);
  await saveContractSignature(ue.tenantId, ue.actor, kContract.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(ue.tenantId, kContract.id) });
  await finalizeContract(ue.tenantId, kContract.id);
  const mieteBefore = await page(ueDispo, `/unfallersatz/${kCase.case.id}?tab=miete`);
  report(mieteBefore.includes('id="kaution"') && mieteBefore.includes("Noch nicht erhalten") && mieteBefore.includes("500,00") && mieteBefore.includes("Die Kaution gehört zum Mieter"), "Fallakte (Miete): Kaution 500 € laut Vertrag, noch nicht erhalten – bestehender Kautionsbereich");
  const handover = async (type: "PICKUP" | "RETURN") => {
    const h = await startHandover(ue.tenantId, kBooking, type, ue.actor);
    await updateHandoverDraft(ue.tenantId, h.id, { mileage: (await db.vehicle.findUniqueOrThrow({ where: { id: kV.id } })).mileage + 10, fuelLevelEighths: 8 });
    for (const c of REQUIRED_PHOTO_CATEGORIES) { const key = buildStorageKey({ tenantId: ue.tenantId, area: "photos", bookingId: kBooking, contentType: "image/jpeg" }); await registerPhoto(ue.tenantId, ue.actor, { handoverId: h.id, category: c, storageKey: key, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key) }); }
    const items = await db.handoverChecklistItem.findMany({ where: { handoverId: h.id } });
    await answerChecklist(ue.tenantId, h.id, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? "2" : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
    if (type === "PICKUP") {
      for (const d of await db.contractDriver.findMany({ where: { tenantId: ue.tenantId, contractId: kContract.id } })) {
        const v = await startOrGetVerification(ue.tenantId, ue.actor, h.id, d.id);
        await recordIdentityCheck(ue.tenantId, ue.actor, v.id, { documentType: "PERSONALAUSWEIS", originalSeen: true, nameMatched: true, birthDateMatched: true });
        await recordLicenseCheck(ue.tenantId, ue.actor, v.id, { originalSeen: true, documentValid: true, nameMatched: true, licenseNumber: d.licenseNumber, licenseCountry: d.licenseCountry, licenseIssuedAt: d.licenseIssuedAt, licenseValidUntil: d.licenseValidUntil, licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false });
        await confirmVerification(ue.tenantId, ue.actor, v.id);
      }
    }
    await saveHandoverSignature(ue.tenantId, ue.actor, h.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(ue.tenantId, h.id) });
    await finalizeHandover(ue.tenantId, h.id, ue.actor);
  };
  await handover("PICKUP");
  await recordDepositReceived(ue.tenantId, ue.actor, { bookingId: kBooking, amount: "500,00", method: "CASH", occurredAt: new Date() });
  const mieteRunning = await page(ueDispo, `/unfallersatz/${kCase.case.id}?tab=miete`);
  report(mieteRunning.includes('id="kaution"') && mieteRunning.includes("Erhalten") && mieteRunning.includes("Freigabe oder Einbehalt wird nach der Rückgabe dokumentiert"), "Fallakte (Miete): Kautionseingang erhalten, Entscheidung erst nach der Rückgabe");
  await handover("RETURN");
  const overview = await page(ueDispo, `/unfallersatz/${kCase.case.id}`);
  const mieteReturned = await page(ueDispo, `/unfallersatz/${kCase.case.id}?tab=miete`);
  const yardMiete = await page(ueYard, `/unfallersatz/${kCase.case.id}?tab=miete`);
  report(overview.includes("Kaution prüfen") && overview.includes("Kaution noch offen – Freigabe oder Einbehalt prüfen.") && mieteReturned.includes("Kaution teilweise freigeben") && mieteReturned.includes("Kaution einbehalten"), "Fallakte nach Rückgabe: „Kaution prüfen“, Abschlusswarnung und Freigabe/Einbehalt über die bestehende Kautionslogik");
  report(!yardMiete.includes('id="kaution"') && !yardMiete.includes("Kaution teilweise freigeben"), "Fallakte (Hof): kein Kautionsbereich, keine Kautionsentscheidung");

  // Hof per Direktaufruf: Kautionsentscheidung serverseitig abgewiesen, nichts verändert
  const idSettle = boundIdOf(mieteReturned, "settleDepositAction");
  const yardSettle = await callAction(`/unfallersatz/${kCase.case.id}`, idSettle, ueYard, { bound: [kBooking], form: { releaseAmount: "500,00", method: "CASH", occurredAt: toDateTimeInput(new Date()), nonce: `smoke-k-${Date.now()}` } });
  const depAfterYard = await db.securityDeposit.findFirstOrThrow({ where: { tenantId: ue.tenantId, bookingId: kBooking } });
  report(/^[0-9a-f]{42}$/.test(idSettle) && yardSettle.redirectTo.includes("fehler=rechte") && depAfterYard.status === "RECEIVED", `${yardSettle.status} Hofmitarbeiter: Kautionsfreigabe per Direktaufruf abgewiesen, Kaution unverändert`);

  // Freigabe (bestehende Logik) → „Kautionsauszahlung offen“ in der Fallakte und in der bestehenden Heute-Kennzahl
  await settleDeposit(ue.tenantId, ue.actor, { bookingId: kBooking, releaseAmount: "500,00", method: "CASH", occurredAt: new Date() });
  const overviewReleased = await page(ueDispo, `/unfallersatz/${kCase.case.id}`);
  const heuteReleased = await page(ueDispo, "/heute");
  report(overviewReleased.includes("Kautionsauszahlung offen") && !overviewReleased.includes("Kaution prüfen") && heuteReleased.includes("Kautionsauszahlung offen · "), "Nach Freigabe: „Kautionsauszahlung offen“ in der Fallakte und in der bestehenden Heute-Liste");
}

// Befehl 29 Phase G: Unfallersatz-Zentrale (/unfallersatz) – Menüpunkt nur mit Modul, Vollsicht und Hof-Sicht, Suche/Filter in der
// Adresse, Heute-Karte und globale Suche führen in die Zentrale; ohne Modul gesperrt.
{
  const get = async (c: string, p: string) => { const r = await fetch(`${base}${p}`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, location: r.headers.get("location") ?? "", html: r.status === 200 ? await plain(r) : "" }; };
  const asideOf = (html: string) => /<aside[\s\S]*?<\/aside>/.exec(html)?.[0] ?? "";
  const gCases = await db.accidentReplacementCase.findMany({ where: { tenantId: ue.tenantId }, select: { id: true, caseNumber: true, status: true } });
  const gOpen = gCases.find((x) => x.status === "OPEN")!;
  const centerFull = await get(ueDispo, "/unfallersatz");
  report(centerFull.status === 200 && centerFull.html.includes("Ersatzmieten, Schadenfälle, Abrechnung und offene Aufgaben im Blick behalten.") && centerFull.html.includes("+ Unfallersatzfall") && centerFull.html.includes("Offene Forderungen") && centerFull.html.includes("Fällige Wiedervorlagen") && centerFull.html.includes(gOpen.caseNumber) && centerFull.html.includes("Fall öffnen") && centerFull.html.includes("Nächster Schritt"), `${centerFull.status} Unfallersatz-Zentrale (Disposition): Kennzahlen, Liste mit nächstem Schritt, Anlage`);
  report(asideOf(centerFull.html).includes('href="/unfallersatz"') && asideOf(centerFull.html).includes(">Unfallersatz<"), "Menüpunkt „Unfallersatz“ mit freigeschaltetem Modul");
  const centerYard = await get(ueYard, "/unfallersatz");
  report(centerYard.status === 200 && centerYard.html.includes(gOpen.caseNumber) && !centerYard.html.includes("+ Unfallersatzfall") && !centerYard.html.includes("Offene Forderungen") && !centerYard.html.includes("Abzurechnen") && !centerYard.html.includes("Smoke Versicherung") && !centerYard.html.includes("Kautionsprobe Versicherung") && !centerYard.html.includes("Schadennummer") && !centerYard.html.includes("Wiedervorlage"), `${centerYard.status} Unfallersatz-Zentrale (Hof): operative Sicht ohne Versicherung, Beträge, Wiedervorlagen, ohne Anlage`);
  const yardFinFilter = await get(ueYard, "/unfallersatz?filter=rechnung_offen");
  // aria-current außerhalb der Seitenleiste: die Filter-Tabs der Seite (die Navigation markiert ihren Menüpunkt selbst)
  report(yardFinFilter.status === 200 && yardFinFilter.html.replace(/<aside[\s\S]*?<\/aside>/, "").includes('aria-current="page"') && !yardFinFilter.html.includes("Rechnung offen"), "Hof: kaufmännischer Filter per Adresse nicht erreichbar (fällt auf „Alle offenen“ zurück)");
  const centerQ = await get(ueDispo, `/unfallersatz?filter=offen&q=${encodeURIComponent(gOpen.caseNumber)}`);
  report(centerQ.status === 200 && centerQ.html.includes(gOpen.caseNumber) && centerQ.html.includes(`Suche „${gOpen.caseNumber}“`) && centerQ.html.includes("Suche löschen"), "Zentrale: Suche über die Fallnummer, Zustand in der Adresse");
  const centerNone = await get(ueDispo, "/unfallersatz?q=keinTrefferXYZ");
  report(centerNone.html.includes("Keine Fälle entsprechen den gewählten Filtern.") && centerNone.html.includes("Filter zurücksetzen"), "Zentrale: Leerzustand bei Filter ohne Treffer");
  const stdCenter = await get(cookie, "/unfallersatz");
  const stdHeute = await get(cookie, "/heute");
  report(stdCenter.status === 307 && stdCenter.location.includes("fehler=funktion") && !asideOf(stdHeute.html).includes('href="/unfallersatz"'), `${stdCenter.status} Ohne Modul: /unfallersatz gesperrt, kein Menüpunkt`);
  const heuteG = await get(ueDispo, "/heute");
  report(heuteG.html.includes('href="/unfallersatz"') && heuteG.html.includes("Unfallersatz öffnen"), "Heute: Karte „Unfallersatz“ führt in die Zentrale");
  const sucheG = await get(ueDispo, `/suche?q=${encodeURIComponent(gOpen.caseNumber)}`);
  const sucheStd = await get(cookie, `/suche?q=${encodeURIComponent(gOpen.caseNumber)}`);
  report(sucheG.html.includes(`Unfallersatz ${gOpen.caseNumber}`) && sucheG.html.includes(`href="/unfallersatz/${gOpen.id}"`) && !sucheStd.html.includes(`Unfallersatz ${gOpen.caseNumber}`) && !sucheStd.html.includes(`href="/unfallersatz/${gOpen.id}"`), "Globale Suche: Unfallersatzfall gefunden (mit Modul; ohne Modul kein Treffer – der Suchbegriff selbst steht dort nur im Kopf)");
}

// Befehl 29 Phase H: Wiedervorlagen-Arbeitsliste in der Zentrale – nur Vollsicht; Erledigen über dieselbe Server-Aktion wie die
// Fallakte (serverseitig geprüft: Hof, Supportmodus, fremder Mandant, manipulierte Fall-ID); Aktionsspalte; Heute → Wiedervorlagen.
{
  const get = async (c: string, p: string) => { const r = await fetch(`${base}${p}`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, location: r.headers.get("location") ?? "", html: r.status === 200 ? await plain(r) : "" }; };
  const hOpen = (await db.accidentReplacementCase.findFirst({ where: { tenantId: ue.tenantId, status: "OPEN" }, orderBy: { createdAt: "asc" }, select: { id: true, caseNumber: true } }))!;
  const hOther = (await db.accidentReplacementCase.findFirst({ where: { tenantId: ue.tenantId, id: { not: hOpen.id } }, select: { id: true } }))!;
  const hDispo = (await db.user.findFirst({ where: { tenantId: ue.tenantId, role: "DISPO", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } }))!;
  const hTitle = `Smoke-H Wiedervorlage ${Date.now()}`;
  const hFu = await createFollowUp(ue.tenantId, hOpen.id, ue.actor, { title: hTitle, dueAt: new Date(), assigneeUserId: hDispo.id });
  const hBoard = await get(ueDispo, "/unfallersatz");
  report(hBoard.status === 200 && hBoard.html.includes('id="wiedervorlagen"') && hBoard.html.includes(hTitle) && hBoard.html.includes(">Aktionen<") && hBoard.html.includes("Erledigen") && hBoard.html.includes("+ Wiedervorlage"), `${hBoard.status} Zentrale: Wiedervorlagen-Arbeitsliste mit fälliger Wiedervorlage, Aktionsspalte, „+ Wiedervorlage“`);
  const hMine = await get(ueDispo, "/unfallersatz?aufgaben=meine");
  report(hMine.html.includes(hTitle) && hMine.html.includes("(Sie)") && hMine.html.replace(/<aside[\s\S]*?<\/aside>/, "").includes('aria-current="page"'),"Zentrale: „Meine Wiedervorlagen“ zeigt die eigene Zuweisung (aufgaben=meine)");
  const hYard = await get(ueYard, "/unfallersatz?aufgaben=meine");
  report(hYard.status === 200 && !hYard.html.includes('id="wiedervorlagen"') && !hYard.html.includes(hTitle) && !hYard.html.includes("+ Wiedervorlage") && !hYard.html.includes("completeFollowUpAction"), "Hof: keine Wiedervorlagen (auch nicht im Seiten-Payload), kein „+ Wiedervorlage“");
  const hDoneId = boundIdOf(hBoard.html, "completeFollowUpAction");
  report(!!hDoneId, "Zentrale: Erledigen ist die gebundene Server-Aktion der Fallakte (completeFollowUpAction)");
  const hYardDone = await callAction("/unfallersatz", hDoneId, ueYard, { bound: [hOpen.id, hFu.id], form: { note: "Hof" } });
  report(hYardDone.redirectTo.includes("fehler=rechte"), "Hof: Erledigen per direktem Aufruf abgewiesen");
  const hSupport = await startSupportSession({ id: admin.id, name: admin.name }, ue.tenantId, "Smoke-Test Phase H Wiedervorlagen");
  const hSupportCookie = `${adminCookie}; rb_support=${hSupport.id}`;
  const hSupBoard = await get(hSupportCookie, "/unfallersatz");
  report(hSupBoard.status === 200 && !hSupBoard.html.includes(hTitle) && !hSupBoard.html.includes('id="wiedervorlagen"'), `${hSupBoard.status} Supportmodus: operative Sicht ohne Wiedervorlagen`);
  const hSupDone = await callAction("/unfallersatz", hDoneId, hSupportCookie, { bound: [hOpen.id, hFu.id], form: { note: "Support" } });
  report(hSupDone.redirectTo.includes("fehler=support"), "Supportmodus: Erledigen gesperrt");
  await endSupportSession({ id: admin.id, name: admin.name }, hSupport.id);
  // fremder Mandant mit Modul und vollen Rechten (Inhaber): scheitert an der Mandantentrennung, nicht an Rolle oder Freischaltung
  await setTenantFeature({ id: admin.id, name: admin.name }, foreign.tenantId, "ACCIDENT_REPLACEMENT", true, "Smoke Phase H");
  const hForeign = await callAction("/unfallersatz", hDoneId, `rb_session=${foreignSession}`, { bound: [hOpen.id, hFu.id], form: { note: "fremd" } });
  await setTenantFeature({ id: admin.id, name: admin.name }, foreign.tenantId, "ACCIDENT_REPLACEMENT", false, "Smoke Phase H");
  report(actionState(hForeign.text)?.error === "Unfallersatzfall nicht gefunden.", "Fremder Mandant (Inhaber, Modul an): fremde Wiedervorlage nicht erledigbar");
  const hWrong = await callAction("/unfallersatz", hDoneId, ueDispo, { bound: [hOther.id, hFu.id], form: { note: "falscher Fall" } });
  report(actionState(hWrong.text)?.error === "Wiedervorlage nicht gefunden.", "Manipulierte Fall-ID: Wiedervorlage nicht über einen anderen Fall erledigbar");
  report((await db.caseFollowUp.findUniqueOrThrow({ where: { id: hFu.id } })).status === "OPEN", "Wiedervorlage nach abgewiesenen Aufrufen unverändert offen");
  const hOk = await callAction("/unfallersatz", hDoneId, ueDispo, { bound: [hOpen.id, hFu.id], form: { note: "Smoke erledigt" } });
  const hAfter = await db.caseFollowUp.findUniqueOrThrow({ where: { id: hFu.id } });
  report(hOk.status === 200 && !actionState(hOk.text)?.error && hAfter.status === "DONE" && hAfter.doneNote === "Smoke erledigt" && hAfter.doneById === hDispo.id, "Disposition: Wiedervorlage aus der Zentrale erledigt (Benutzer und Ergebnis gespeichert)");
  const hBoardAfter = await get(ueDispo, "/unfallersatz");
  report(hBoardAfter.status === 200 && !hBoardAfter.html.includes(hTitle), "Zentrale: erledigte Wiedervorlage verschwindet aus der Arbeitsliste");
  const hHist = await get(ueDispo, `/unfallersatz/${hOpen.id}?tab=verlauf`);
  report(hHist.html.includes("Wiedervorlage erledigt") && hHist.html.includes("Smoke erledigt"), "Verlauf: Erledigen aus der Zentrale mit Ergebnis festgehalten");
  await createFollowUp(ue.tenantId, hOpen.id, ue.actor, { title: `${hTitle} zwei`, dueAt: new Date() });
  const hHeute = await get(ueDispo, "/heute");
  report(hHeute.html.includes(`href="/unfallersatz/${hOpen.id}#wiedervorlagen"`), "Heute: fällige Wiedervorlage führt in die Fallakte zu den Wiedervorlagen");
  const hNew = await get(ueDispo, `/unfallersatz/${hOpen.id}?wv=neu`);
  report(hNew.html.includes('id="wiedervorlagen"') && hNew.html.includes('aria-label="Wiedervorlage anlegen"'), "Fallakte: „+ Wiedervorlage“ (?wv=neu) öffnet das Anlegeformular am Fall");
  const hTodayEmpty = await get(ueDispo, "/unfallersatz?aufgaben=ueberfaellig");
  report(hTodayEmpty.html.includes('id="wiedervorlagen"') && (hTodayEmpty.html.includes("Keine überfälligen Wiedervorlagen.") || hTodayEmpty.html.includes("Tag überfällig") || hTodayEmpty.html.includes("Tage überfällig")), "Zentrale: Filter „Überfällig“ mit Liste oder Leerzustand");
}

// Befehl 30 Phase I (Endabnahme): Hof-Sicht ohne Unfallersatz-Abrechnung auch in Buchungsverlauf, Kundenakte (Übersicht, Finanzen,
// Kommunikation, Historie) und Auszahlungen – geprüft im ausgelieferten HTML samt Server-Payload; Disposition sieht sie weiterhin.
{
  const get = async (c: string, p: string) => { const r = await fetch(`${base}${p}`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, html: r.status === 200 ? await plain(r) : "" }; };
  const iInvs = await db.invoice.findMany({ where: { tenantId: ue.tenantId, kind: "ACCIDENT_REPLACEMENT", status: "FINALIZED", number: { not: null } }, select: { number: true, bookingId: true, booking: { select: { customerId: true } } } });
  const iInv = iInvs.find((x) => x.bookingId && x.booking)!;
  const iSecrets = [...iInvs.map((x) => x.number!), "SN-SMOKE-1", "Smoke Versicherung"];
  const iLeaks = (html: string) => iSecrets.filter((x) => html.includes(x));
  const iPages = [`/buchungen/${iInv.bookingId}`, ...["uebersicht", "finanzen", "kommunikation", "historie"].map((t) => `/kunden/${iInv.booking!.customerId}?tab=${t}`), "/auszahlungen?filter=alle"];
  const iDispo = await get(ueDispo, `/kunden/${iInv.booking!.customerId}?tab=finanzen`);
  report(iDispo.status === 200 && iDispo.html.includes(iInv.number!), "Disposition: Unfallersatz-Rechnung in der Kundenakte (Finanzen) sichtbar");
  const iYard = await Promise.all(iPages.map((p) => get(ueYard, p)));
  const iYardLeaks = [...new Set(iYard.flatMap((x) => iLeaks(x.html)))];
  report(iYard.every((x) => x.status === 200) && iYardLeaks.length === 0, `Hof: Buchungsverlauf, Kundenakte und Auszahlungen ohne Unfallersatz-Abrechnung (${iYard.map((x) => x.status).join("/")}${iYardLeaks.length ? ` · Leck: ${iYardLeaks.join(", ")}` : ""})`);
  const iSupport = await startSupportSession({ id: admin.id, name: admin.name }, ue.tenantId, "Smoke-Test Phase I Hof-Sicht");
  const iSupportCookie = `${adminCookie}; rb_support=${iSupport.id}`;
  const iSup = await Promise.all(iPages.map((p) => get(iSupportCookie, p)));
  const iSupLeaks = [...new Set(iSup.flatMap((x) => iLeaks(x.html)))];
  report(iSup.every((x) => x.status === 200) && iSupLeaks.length === 0, `Supportmodus: dieselben Seiten ohne Unfallersatz-Abrechnung (${iSup.map((x) => x.status).join("/")}${iSupLeaks.length ? ` · Leck: ${iSupLeaks.join(", ")}` : ""})`);
  await endSupportSession({ id: admin.id, name: admin.name }, iSupport.id);
}

const health = await fetch(`${base}/api/health`);
const healthJson = await health.json().catch(() => ({}));
report(health.status === 200 && healthJson.status === "ok" && healthJson.db === "ok", `${health.status} Healthcheck`);

await purgeTenants(platformTenants);

if (keep) {
  console.log(`\nTestdaten bleiben stehen.\nSITZUNG=${sessionId}\nBUCHUNG=${w.bookingId}\nRUECKGABE_ENTWURF=${doneBooking.id}\nRUECKGABE_FERTIG=${retBooking.id}\nRET_DAMAGE=${retDamage.id} UEBERGEBEN=${doneBooking.id} BEREIT=${signedBooking.id}\nVERTRAG=${draft.number}\nMANDANTEN=${w.tenantId},${foreign.tenantId}`);
} else {
  await purgeTenants([w.tenantId, foreign.tenantId]);
}
await db.$disconnect();
console.log(failed === 0 ? "\nAlle Seiten in Ordnung." : `\n${failed} Prüfung(en) fehlgeschlagen.`);
process.exit(failed === 0 ? 0 : 1);
