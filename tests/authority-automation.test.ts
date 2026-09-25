// Behörden-Automatik Stufe 1: PDF-Erkennung (lokal, nur Vorschläge), Posteingang mit Anhang am Vorgang, Behörden-Adressbuch,
// Schnellweg „Prüfen & senden“ (nie ohne Bestätigung, nie bei Mehrdeutigkeit), Bearbeitungsentgelt nur laut Vertrag als
// Rechnungsentwurf, tägliche Fristen-Erinnerung idempotent.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { addAdditionalDriver, ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { authorityCaseView, createAuthorityCase, submitResponse, updateAuthorityCase, type CaseInput } from "../src/lib/authority";
import { extractPdfText, parseAuthorityLetter } from "../src/lib/authority-extraction";
import { uploadAuthorityLetter } from "../src/lib/authority-intake";
import { contactKey, deleteContact, listContacts, updateContact } from "../src/lib/authority-contacts";
import { planQuickResponse, quickPreview, runQuickResponse } from "../src/lib/authority-quick";
import { authorityFeeState, ensureAuthorityFeeInvoice } from "../src/lib/authority-fee";
import { sendAuthorityReminders } from "../src/lib/authority-reminders";
import { finalizeInvoice, getInvoiceState } from "../src/lib/invoices";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { toDateInputValue, zonedParts } from "../src/lib/time";
import { createWorld, fakeSignaturePng, purgeTenants } from "./helpers";
import { returnedWorld } from "./rental-flow";
import { LETTER_LINES, LETTER_TEXT, letterPdf } from "./fixtures/authority-letter";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-auth-auto-"));
  storage = getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

class FakeTransport implements MailTransport {
  readonly name = "fake";
  sent: MailMessage[] = [];
  fail: unknown = null;
  async send(m: MailMessage) {
    if (this.fail) throw this.fail;
    this.sent.push(m);
    return { messageId: `<fake-${this.sent.length}@test>` };
  }
}

const DAY = 86_400_000;
const at = (offsetDays: number, hour = 10) => { const d = new Date(Date.now() + offsetDays * DAY); d.setHours(hour, 15, 0, 0); return d; };
const dateTime = (d: Date) => { const p = zonedParts(d); return { offenseDate: toDateInputValue(d), offenseTime: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` }; };
const input = (plate: string, when: Date, over: Partial<CaseInput> = {}): CaseInput => ({ type: "SPEEDING", authorityName: "Stadtamt Bremen, Bußgeldstelle", authorityReference: `AZ-${Math.random().toString(36).slice(2, 8)}`, authorityAddress: "Stresemannstr. 48\n28207 Bremen", licensePlate: plate, ...dateTime(when), offenseLocation: "A27", ...over });
const plateOf = async (vehicleId: string) => (await db.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).plate;
const ctx = { fleetPlates: ["HB-JR 204", "HB-JR 205"], contacts: [], tenant: { name: "JetRent GmbH", email: "info@jetrent.de", zip: "28217", street: "Hafenstraße 12" } };

/** Zurückgegebene Miete (Hauptfahrer = Mieterin), tatsächliche Zeiten vor 5 bis vor 1 Tag. */
async function rentedWorld(label: string, tenant?: Record<string, unknown>) {
  await ready;
  const w = await returnedWorld(label, { tenant });
  tenants.push(w.tenantId);
  await db.booking.update({ where: { id: w.bookingId }, data: { actualPickupAt: at(-5, 9), actualReturnAt: at(-1, 16) } });
  return w;
}

// ---------------------------------------------------------------------------
// Erkennung (rein)
// ---------------------------------------------------------------------------

test("Erkennung: PDF-Textebene liefert Kennzeichen (Flotte), Tatzeit, Tatort, Aktenzeichen, Frist, Betrag, Art und Behörde – nie die eigenen Firmendaten", async () => {
  const text = await extractPdfText(await letterPdf());
  assert.ok(text.includes("Aktenzeichen"), "Textebene des PDFs gelesen");
  for (const s of [parseAuthorityLetter(text, ctx), parseAuthorityLetter(LETTER_TEXT, ctx)]) {
    assert.equal(s.licensePlate?.value, "HB-JR 204");
    assert.equal(s.licensePlate?.confidence, "HIGH");
    assert.equal(s.offenseDate?.value, "2026-08-28");
    assert.equal(s.offenseTime?.value, "14:32");
    assert.equal(s.offenseLocation?.value, "Bremen, Hochstraße B75 Richtung Delmenhorst");
    assert.equal(s.authorityReference?.value, "502.117.884-26");
    assert.equal(s.responseDeadline?.value, "2026-09-16");
    assert.equal(s.responseDeadline?.confidence, "HIGH", "ausdrückliches Datum vor berechneter Frist");
    assert.equal(s.noticeAmount?.value, "70,00");
    assert.equal(s.type?.value, "SPEEDING");
    assert.equal(s.offenseType?.value, "21 km/h zu schnell innerorts");
    assert.equal(s.authorityName?.value, "Freie Hansestadt Bremen, Stadtamt – Bußgeldstelle");
    assert.equal(s.authorityAddress?.value, "Stresemannstraße 48\n28207 Bremen", "nicht die Empfängeranschrift der Vermietung");
    assert.equal(s.authorityEmail?.value, "bussgeldstelle@stadtamt.bremen.de");
    assert.equal(s.authorityPortalUrl?.value, "https://anhoerung.bremen.de/owi");
  }
  // Adressbuch hat Vorrang und liefert die bekannte E-Mail
  const book = parseAuthorityLetter(LETTER_TEXT, { ...ctx, contacts: [{ name: "Stadtamt – Bußgeldstelle", address: "Postfach 10 77 20\n28077 Bremen", email: "owi@stadtamt.bremen.de" }] });
  assert.equal(book.authorityName?.value, "Stadtamt – Bußgeldstelle");
  assert.equal(book.authorityName?.hint, "aus dem Behörden-Adressbuch");
  assert.equal(book.authorityAddress?.value, "Postfach 10 77 20\n28077 Bremen");
  assert.equal(book.authorityEmail?.value, "bussgeldstelle@stadtamt.bremen.de", "E-Mail im Schreiben hat Vorrang vor dem Adressbuch");
  const bookOnly = parseAuthorityLetter(LETTER_LINES.filter((l) => !l.includes("@")).join("\n"), { ...ctx, contacts: [{ name: "Stadtamt – Bußgeldstelle", email: "owi@stadtamt.bremen.de" }] });
  assert.equal(bookOnly.authorityEmail?.value, "owi@stadtamt.bremen.de", "Adressbuch ergänzt fehlende E-Mail");
  // ein Name, der nur in einer E-Mail- oder Webadresse vorkommt, ist kein Treffer
  assert.equal(parseAuthorityLetter(LETTER_TEXT, { ...ctx, contacts: [{ name: "Stadtamt Bremen", email: "x@y.de" }] }).authorityName?.hint, "aus dem Briefkopf");
  // fremdes Kennzeichen nur neben „Kennzeichen“, mittlere Sicherheit; eigene E-Mail nie
  const foreign = parseAuthorityLetter(LETTER_TEXT.replace("HB-JR 204", "HH-AB 12").replace("bussgeldstelle@stadtamt.bremen.de", "info@jetrent.de"), ctx);
  assert.equal(foreign.licensePlate?.value, "HH-AB 12");
  assert.equal(foreign.licensePlate?.confidence, "MEDIUM");
  assert.equal(foreign.authorityEmail, undefined);
  // relative Frist: Briefdatum + 1 Woche, nur schwacher Vorschlag
  const rel = parseAuthorityLetter(LETTER_LINES.filter((l) => !l.includes("spätestens")).concat("Bitte antworten Sie innerhalb einer Woche.").join("\n"), ctx);
  assert.equal(rel.responseDeadline?.value, "2026-09-09");
  assert.equal(rel.responseDeadline?.confidence, "LOW");
  // kein Text → keine Vorschläge; ungültiges Datum wird ignoriert
  assert.deepEqual(parseAuthorityLetter("   ", ctx), {});
  assert.equal(parseAuthorityLetter("Tatzeit: 31.02.2026, 10:00 Uhr\nweiterer Text ohne Bedeutung", ctx).offenseDate, undefined);
  assert.equal(await extractPdfText(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), "", "kein PDF → kein Text, kein Fehler");
});

// ---------------------------------------------------------------------------
// Posteingang + Adressbuch
// ---------------------------------------------------------------------------

test("Posteingang: Upload erkennt Vorschläge, Anlage hängt das Schreiben genau einmal an, Adressbuch lernt, Doppelerfassung wird gemeldet, Mandanten getrennt", async () => {
  const w = await rentedWorld("auto-intake");
  const other = await createWorld("auto-intake-other");
  tenants.push(other.tenantId);
  // realistisches Kennzeichen (die Testwelt nutzt Buchstaben als Zählfolge)
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { plate: "HB-JR 204" } });
  const plate = "HB-JR 204";
  const pdf = await letterPdf();
  const up = await uploadAuthorityLetter(w.tenantId, w.actor, { bytes: pdf, fileName: "anhoerung.pdf" }, { storage });
  assert.equal(up.textFound, true);
  assert.equal(up.suggestion.licensePlate?.value, plate, "Flottenkennzeichen erkannt");
  assert.equal(up.duplicates.length, 0);
  const row = await db.authorityUpload.findUniqueOrThrow({ where: { id: up.id } });
  assert.equal(row.caseId, null);
  assert.ok((await storage.get(row.storageKey))?.body.length === pdf.length, "Datei privat gespeichert");

  const values = Object.fromEntries(Object.entries(up.suggestion).map(([k, v]) => [k, v!.value])) as Record<string, string>;
  const c = await createAuthorityCase(w.tenantId, w.actor, { ...values, type: values.type, authorityName: values.authorityName, authorityReference: values.authorityReference, licensePlate: values.licensePlate, offenseDate: dateTime(at(-3, 14)).offenseDate, offenseTime: "14:32", responseDeadline: new Date(`${values.responseDeadline}T12:00:00`), uploadId: up.id });
  assert.equal(c.bookingId, w.bookingId);
  const docs = await db.authorityCaseDocument.findMany({ where: { caseId: c.id } });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].type, "INCOMING_NOTICE");
  assert.equal(docs[0].storageKey, row.storageKey);
  assert.equal(docs[0].checksum, row.checksum);
  const used = await db.authorityUpload.findUniqueOrThrow({ where: { id: up.id } });
  assert.equal(used.caseId, c.id);
  assert.ok(used.usedAt);
  await assert.rejects(() => createAuthorityCase(w.tenantId, w.actor, input(plate, at(-3), { uploadId: up.id })), /bereits einem Vorgang zugeordnet/);
  await assert.rejects(() => createAuthorityCase(other.tenantId, other.actor, input("HB-XX 1", at(-3), { uploadId: up.id })), /nicht gefunden/, "fremder Mandant");
  const otherCase = await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-2)));
  await assert.rejects(() => db.authorityUpload.update({ where: { id: up.id }, data: { caseId: otherCase.id } }), /bereits einem Vorgang zugeordnet/, "DB: Zuordnung endgültig");

  // gleiche Datei erneut → Hinweis auf den Vorgang
  const again = await uploadAuthorityLetter(w.tenantId, w.actor, { bytes: pdf, fileName: "nochmal.pdf" }, { storage });
  assert.ok(again.duplicates.some((d) => d.caseId === c.id));

  // Adressbuch: gelernt aus dem Vorgang, leere Felder löschen nichts, neue Angaben ersetzen
  const book = await listContacts(w.tenantId);
  const entry = book.find((b) => b.nameKey === contactKey(values.authorityName))!;
  assert.ok(entry, "Behörde im Adressbuch");
  assert.equal(entry.email, "bussgeldstelle@stadtamt.bremen.de");
  assert.equal(entry.portalUrl, "https://anhoerung.bremen.de/owi");
  await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-2), { authorityName: values.authorityName.toUpperCase(), authorityEmail: null, authorityAddress: null }));
  const after2 = (await listContacts(w.tenantId)).find((b) => b.id === entry.id)!;
  assert.equal(after2.email, "bussgeldstelle@stadtamt.bremen.de", "leere Angabe löscht nichts");
  assert.ok(after2.useCount >= 2);
  // nächste Erkennung nutzt das Adressbuch
  const third = await uploadAuthorityLetter(w.tenantId, w.actor, { bytes: await letterPdf(LETTER_LINES.filter((l) => !l.includes("@"))), fileName: "ohne-mail.pdf" }, { storage });
  assert.equal(third.suggestion.authorityEmail?.value, "bussgeldstelle@stadtamt.bremen.de");
  assert.equal(third.suggestion.authorityEmail?.hint, "aus dem Behörden-Adressbuch");
  // bearbeiten/löschen: Validierung, fremder Mandant, bestehende Vorgänge unverändert
  await assert.rejects(() => updateContact(w.tenantId, entry.id, w.actor, { name: "X", email: "kaputt" }), /Namen|ungültig/);
  await assert.rejects(() => updateContact(other.tenantId, entry.id, other.actor, { name: "Fremd" }), /nicht gefunden/);
  await updateContact(w.tenantId, entry.id, w.actor, { name: entry.name, email: "neu@stadtamt.bremen.de", portalUrl: "https://neu.bremen.de" });
  await deleteContact(w.tenantId, entry.id, w.actor);
  assert.equal((await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } })).authorityEmail, "bussgeldstelle@stadtamt.bremen.de", "Vorgang behält seine Daten");
  // Foto: gespeichert, aber keine Vorschläge
  const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const photo = await uploadAuthorityLetter(w.tenantId, w.actor, { bytes: png, fileName: "foto.png" }, { storage });
  assert.equal(photo.textFound, false);
  assert.deepEqual(photo.suggestion, {});
  await assert.rejects(() => uploadAuthorityLetter(w.tenantId, w.actor, { bytes: new TextEncoder().encode("<html>"), fileName: "x.html" }, { storage }), /PDF oder ein Bild/);
});

// ---------------------------------------------------------------------------
// Schnellweg
// ---------------------------------------------------------------------------

test("Schnellweg: einziger Vertragsfahrer + E-Mail → Vorschau, Bestätigung Pflicht, Stand-Prüfung, ein Klick bis zur übermittelten Antwort", async () => {
  const w = await rentedWorld("auto-quick");
  const plate = await plateOf(w.vehicleId);
  const c = await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-3, 14), { authorityEmail: "owi@stadt.example.de", responseDeadline: at(5) }));
  const view = await authorityCaseView(w.tenantId, c.id);
  const plan = planQuickResponse(view);
  assert.ok(plan.available);
  if (!plan.available) return;
  assert.equal(plan.responseType, "DRIVER_IDENTIFIED");
  assert.equal(plan.submissionMethod, "EMAIL");
  assert.equal(plan.driverToConfirm?.lastName, "Muster");
  const preview = await quickPreview(w.tenantId, view, plan, { includeBirthDate: true, includeAddress: true });
  assert.equal(preview.persons.length, 1);
  assert.equal(preview.recipient.email, "owi@stadt.example.de");
  assert.equal((await db.authorityCase.findUniqueOrThrow({ where: { id: c.id } })).driverDeterminationStatus, "UNDETERMINED", "Vorschau speichert nichts");
  assert.equal(await db.authorityResponse.count({ where: { caseId: c.id } }), 0);

  const mail = new FakeTransport();
  await assert.rejects(() => runQuickResponse(w.tenantId, c.id, w.actor, { fingerprint: plan.fingerprint, confirmed: false, includeBirthDate: true, includeAddress: true, transport: mail, storage }), /ausdrücklich/);
  await assert.rejects(() => runQuickResponse(w.tenantId, c.id, w.actor, { fingerprint: "veraltet-123", confirmed: true, includeBirthDate: true, includeAddress: true, transport: mail, storage }), /zwischenzeitlich geändert/);
  // Stand ändert sich (Frist geändert) → alter Fingerabdruck gilt nicht mehr
  await updateAuthorityCase(w.tenantId, c.id, w.actor, input(plate, at(-3, 14), { authorityReference: c.authorityReference, authorityEmail: "owi@stadt.example.de", responseDeadline: at(6) }));
  await assert.rejects(() => runQuickResponse(w.tenantId, c.id, w.actor, { fingerprint: plan.fingerprint, confirmed: true, includeBirthDate: true, includeAddress: true, transport: mail, storage }), /zwischenzeitlich geändert/);
  assert.equal(mail.sent.length, 0);

  const fresh = planQuickResponse(await authorityCaseView(w.tenantId, c.id));
  assert.ok(fresh.available);
  if (!fresh.available) return;
  const r = await runQuickResponse(w.tenantId, c.id, w.actor, { fingerprint: fresh.fingerprint, confirmed: true, includeBirthDate: false, includeAddress: true, transport: mail, storage });
  assert.equal(r.submit?.outcome, "SUBMITTED");
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, "owi@stadt.example.de");
  assert.equal(mail.sent[0].attachments.length, 1);
  const done = await authorityCaseView(w.tenantId, c.id);
  assert.equal(done.status, "SUBMITTED");
  assert.equal(done.driverDeterminationStatus, "CONTRACT_DRIVER_SELECTED");
  assert.match(done.driverNote ?? "", /Prüfen & senden/);
  const resp = done.responses[0];
  assert.equal(resp.status, "SUBMITTED");
  const persons = (resp.personSnapshot as { persons: { fields: { label: string }[] }[] }).persons;
  assert.ok(!persons[0].fields.some((f) => f.label === "Geburtsdatum"), "Geburtsdatum bewusst weggelassen");
  assert.ok(persons[0].fields.some((f) => f.label === "Anschrift"));
  assert.deepEqual(done.events.map((e) => e.type).filter((t) => ["DRIVER_SELECTED", "RESPONSE_CREATED", "RESPONSE_APPROVED", "RESPONSE_SUBMITTED"].includes(t)).sort(), ["DRIVER_SELECTED", "RESPONSE_APPROVED", "RESPONSE_CREATED", "RESPONSE_SUBMITTED"]);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "AUTHORITY_QUICK_RESPONSE" } }), 1);
  // danach kein Schnellweg mehr; ohne vereinbartes Entgelt keine Rechnung
  assert.equal(planQuickResponse(done).available, false);
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, kind: "AUTHORITY_FEE" } }), 0);
  assert.equal((await authorityFeeState(w.tenantId, c.id)).status, "NOT_AGREED");
});

test("Schnellweg: mehrere Fahrer → alle nennen ohne Auswahl; fremdes Kennzeichen → Post; keine Vermietung; kein Schnellweg bei nur geplanter Zeit oder mehreren Fahrzeugen", async () => {
  await ready;
  // zwei Vertragsfahrer, laufende Miete
  const w = await createWorld("auto-multi");
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { legalForm: "GmbH", email: "post@jetrent.test" } });
  const k = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  await addAdditionalDriver(w.tenantId, k.id, { firstName: "Max", lastName: "Beifahrer", birthDate: new Date("1990-07-01"), street: "Nebenweg 2", zip: "28199", city: "Bremen", licenseNumber: "Z999", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2035-01-01") });
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, k.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, k.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, k.id) });
  await finalizeContract(w.tenantId, k.id);
  await db.booking.update({ where: { id: w.bookingId }, data: { status: "ACTIVE", actualPickupAt: at(-3, 8), actualReturnAt: null } });
  const plate = await plateOf(w.vehicleId);

  const multi = await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-1, 12), { authorityPortalUrl: "https://portal.example.de/owi" }));
  const pm = planQuickResponse(await authorityCaseView(w.tenantId, multi.id));
  assert.ok(pm.available);
  if (!pm.available) return;
  assert.equal(pm.responseType, "MULTIPLE_POSSIBLE_DRIVERS");
  assert.equal(pm.driverToConfirm, null, "kein Fahrer wird ausgewählt");
  assert.equal(pm.submissionMethod, "MANUAL_PORTAL");
  const r = await runQuickResponse(w.tenantId, multi.id, w.actor, { fingerprint: pm.fingerprint, confirmed: true, includeBirthDate: true, includeAddress: true, storage });
  assert.equal(r.submit, null, "Portal: nur PDF, Übermittlung markiert der Mitarbeiter");
  const mv = await authorityCaseView(w.tenantId, multi.id);
  assert.equal(mv.status, "READY_TO_SEND");
  assert.equal(mv.driverDeterminationStatus, "UNDETERMINED");
  assert.equal((mv.currentResponse!.personSnapshot as { persons: unknown[] }).persons.length, 2);

  const foreign = await createAuthorityCase(w.tenantId, w.actor, input("HH-ZZ 999", at(-1)));
  const pf = planQuickResponse(await authorityCaseView(w.tenantId, foreign.id));
  assert.ok(pf.available && pf.responseType === "VEHICLE_NOT_IN_FLEET" && pf.submissionMethod === "POST" && pf.warnings.some((x) => /Tippfehler/.test(x)));

  const none = await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-10)));
  const pn = planQuickResponse(await authorityCaseView(w.tenantId, none.id));
  assert.ok(pn.available && pn.responseType === "NO_MATCHING_RENTAL");

  // nur geplante Zeit (keine Übergabe)
  const p2 = await createWorld("auto-planned", { startInDays: -2 });
  tenants.push(p2.tenantId);
  const planned = await createAuthorityCase(p2.tenantId, p2.actor, input(await plateOf(p2.vehicleId), at(-1, 11)));
  const pp = planQuickResponse(await authorityCaseView(p2.tenantId, planned.id));
  assert.equal(pp.available, false);
  // zwei Fahrzeuge mit gleichem Schlüssel
  await db.vehicle.create({ data: { tenantId: w.tenantId, plate: plate.replace("-", "").replace(" ", "-"), make: "VW", model: "Caddy", groupId: w.groupId, fuel: "DIESEL", mileage: 1000, dailyRate: 50, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 100 } });
  const amb = await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-1, 13)));
  const pa = planQuickResponse(await authorityCaseView(w.tenantId, amb.id));
  assert.equal(pa.available, false);
  if (!pa.available) assert.match(pa.reason, /Mehrere Fahrzeuge/);
});

// ---------------------------------------------------------------------------
// Bearbeitungsentgelt
// ---------------------------------------------------------------------------

test("Bearbeitungsentgelt: nur laut Vertragsschnappschuss, erst nach Übermittlung, als Entwurf; genau einmal je Vorgang; abschließbar; Mietrechnung unberührt", async () => {
  const w = await rentedWorld("auto-fee", { businessRules: { authorityHandlingFeeEnabled: true, authorityHandlingFeeCents: 2500 } });
  const plate = await plateOf(w.vehicleId);
  // spätere Änderung der Einstellungen wirkt nicht auf den geschlossenen Vertrag
  await db.tenant.update({ where: { id: w.tenantId }, data: { businessRules: { authorityHandlingFeeEnabled: true, authorityHandlingFeeCents: 9900 } } });
  const c = await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-3, 14)));
  const s0 = await authorityFeeState(w.tenantId, c.id);
  assert.equal(s0.status, "NOT_YET");
  assert.equal((await ensureAuthorityFeeInvoice(w.tenantId, c.id, w.actor)).status, "NOT_YET", "vor der Übermittlung nichts");
  const plan = planQuickResponse(await authorityCaseView(w.tenantId, c.id));
  assert.ok(plan.available && plan.submissionMethod === "POST");
  if (!plan.available) return;
  const q = await runQuickResponse(w.tenantId, c.id, w.actor, { fingerprint: plan.fingerprint, confirmed: true, includeBirthDate: true, includeAddress: true, storage });
  const sub = await submitResponse(w.tenantId, q.responseId, w.actor, { submittedAt: new Date(), reference: "Einschreiben RR123" });
  assert.equal(sub.outcome, "SUBMITTED");
  assert.equal(sub.fee?.status, "CREATED");
  const fees = await db.invoice.findMany({ where: { tenantId: w.tenantId, kind: "AUTHORITY_FEE" }, include: { versions: { include: { items: true } } } });
  assert.equal(fees.length, 1);
  assert.equal(fees[0].status, "DRAFT");
  assert.equal(fees[0].authorityCaseId, c.id);
  assert.equal(fees[0].bookingId, w.bookingId);
  assert.equal(Number(fees[0].versions[0].grossTotal), 25, "Betrag aus dem Vertrag, nicht aus den heutigen Einstellungen");
  assert.match(fees[0].versions[0].items[0].description, /Bearbeitungsentgelt/);
  assert.equal((await ensureAuthorityFeeInvoice(w.tenantId, c.id, w.actor)).status, "EXISTS");
  assert.equal((await authorityFeeState(w.tenantId, c.id)).status, "INVOICED");
  assert.ok((await authorityCaseView(w.tenantId, c.id)).events.some((e) => e.type === "FEE_INVOICE_CREATED"));
  // DB: kein zweites Entgelt für denselben Vorgang, keine AUTHORITY_FEE ohne Vorgang
  await assert.rejects(() => db.invoice.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, kind: "AUTHORITY_FEE", authorityCaseId: c.id, createdById: w.actor.id } }));
  await assert.rejects(() => db.invoice.create({ data: { tenantId: w.tenantId, bookingId: w.bookingId, kind: "AUTHORITY_FEE", createdById: w.actor.id } }));
  // Abschluss über das normale Rechnungsmodul
  const state = await getInvoiceState(w.tenantId, fees[0].id);
  assert.deepEqual(state.issues.filter((i) => i.severity === "error"), []);
  await finalizeInvoice(w.tenantId, fees[0].id, w.actor);
  const fin = await db.invoice.findUniqueOrThrow({ where: { id: fees[0].id } });
  assert.equal(fin.status, "FINALIZED");
  assert.match(fin.number ?? "", /^RE-\d{4}-\d{6}$/);
  // die Mietrechnung der Buchung ist davon unabhängig
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId, kind: "RENTAL" } }), 0);
});

// ---------------------------------------------------------------------------
// Fristen-Erinnerung
// ---------------------------------------------------------------------------

test("Fristen-Erinnerung: überfällig/heute/bald je Empfänger einmal pro Tag, aus = nichts, feste Adresse, fremde Mandanten unberührt", async () => {
  const w = await rentedWorld("auto-remind");
  await db.tenant.update({ where: { id: w.tenantId }, data: { authorityReminderDays: 3 } });
  await db.user.create({ data: { tenantId: w.tenantId, email: `chef-${w.tenantId}@example.test`, name: "Chefin", passwordHash: "x", role: "OWNER" } });
  const plate = await plateOf(w.vehicleId);
  await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-4), { responseDeadline: at(-1) }));
  await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-4), { responseDeadline: at(2) }));
  await createAuthorityCase(w.tenantId, w.actor, input(plate, at(-4), { responseDeadline: at(10) }));
  const mail = new FakeTransport();
  const res = await sendAuthorityReminders({ tenantId: w.tenantId, transport: mail });
  assert.deepEqual(res.map((r) => r.status), ["SENT"], "nur Inhaber/Disponenten, nicht der Hofmitarbeiter");
  assert.equal(res[0].count, 2, "Frist in 10 Tagen nicht dabei");
  assert.match(mail.sent[0].subject, /1 überfällig/);
  assert.match(mail.sent[0].text, /\/behoerden\//);
  assert.deepEqual((await sendAuthorityReminders({ tenantId: w.tenantId, transport: mail })).map((r) => r.status), ["ALREADY"]);
  assert.equal(mail.sent.length, 1);
  // feste Adresse
  await db.tenant.update({ where: { id: w.tenantId }, data: { authorityReminderEmail: "dispo@example.test" } });
  const fixed = await sendAuthorityReminders({ tenantId: w.tenantId, transport: mail });
  assert.equal(fixed[0].recipient, "dispo@example.test");
  // ausgeschaltet
  await db.tenant.update({ where: { id: w.tenantId }, data: { authorityReminderDays: 0 } });
  assert.deepEqual(await sendAuthorityReminders({ tenantId: w.tenantId, transport: mail }), []);
  await assert.rejects(() => db.tenant.update({ where: { id: w.tenantId }, data: { authorityReminderDays: 99 } }));
  // Versandfehler → FAILED protokolliert, nächster Aufruf versucht nicht erneut am selben Tag
  await db.tenant.update({ where: { id: w.tenantId }, data: { authorityReminderDays: 3, authorityReminderEmail: "fehler@example.test" } });
  mail.fail = Object.assign(new Error("x"), { code: "ECONNREFUSED" });
  assert.deepEqual((await sendAuthorityReminders({ tenantId: w.tenantId, transport: mail })).map((r) => r.status), ["FAILED"]);
  const log = await db.emailLog.findFirst({ where: { tenantId: w.tenantId, recipient: "fehler@example.test" } });
  assert.equal(log?.status, "FAILED");
  assert.equal(log?.error, "SMTP-Verbindung fehlgeschlagen");
});
