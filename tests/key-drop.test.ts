// Befehl 20.6: kontaktlose Rückgabe / Schlüsselbox – Vereinbarung, Mail nur per Klick, Token, Kundenmeldung,
// nachträgliche Kontrolle, Trennung Kunden-/Mitarbeiterwerte, keine Automatik bei Kaution/Rechnung/Haftung, Rollen,
// Mandantentrennung, Race Conditions, unveränderte Bestandsprotokolle.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { purgeTenants, fakeSignaturePng } from "./helpers";
import { pickedUpWorld, returnedWorld, type PickedUpWorld } from "./rental-flow";
import { setMailTransport, type MailMessage, type MailTransport } from "../src/lib/mail";
import { clearAllRateLimits } from "../src/lib/rate-limit";
import { DomainError, sha256 } from "../src/lib/integrity";
import {
  authorizeKeyDrop, cancelKeyDrop, confirmKeyDrop, keyDropsToInspect, publicKeyDropView, readKeyDropPhoto, resolveKeyDropToken, revokeKeyDropLink,
  runKeyDropConfirmationFollowUp, saveKeyDropSettings, sendKeyDropLink, uploadKeyDropPhoto, type ConfirmInput,
} from "../src/lib/key-drop";
import { answerChecklist, finalizeHandover, getHandoverContentHash, registerPhoto, saveHandoverSignature, startHandover, updateHandoverDraft, addNewDamage, verifyHandover } from "../src/lib/handovers";
import { getHandoverCompletionStatus } from "../src/lib/completion";
import { loadHandoverDocumentData } from "../src/lib/document-data";
import { renderHandoverPdf } from "../src/lib/pdf/handover-pdf";
import { loadDashboard } from "../src/lib/dashboard";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { buildStorageKey } from "../src/lib/storage";

const tenants: string[] = [];
class FakeTransport implements MailTransport {
  readonly name = "fake";
  sent: MailMessage[] = [];
  async send(m: MailMessage) { this.sent.push(m); return { messageId: `<kd-${this.sent.length}@test>` }; }
}
const mail = new FakeTransport();
before(() => setMailTransport(mail));
beforeEach(() => clearAllRateLimits());
after(async () => {
  setMailTransport(null);
  await purgeTenants(tenants);
  await db.$disconnect();
});

const BASE = "https://app.rent-base.test";
const nonce = () => `n-${Math.random().toString(36).slice(2, 12)}`;
const tokenOf = (m: MailMessage) => /\/rueckgabe\/([A-Za-z0-9_-]+)/.exec(m.text)![1];
const HOUR = 3600_000;

async function world(label: string, opts: { enabled?: boolean; customer?: Record<string, unknown> } = {}) {
  const w = await pickedUpWorld(label, { customer: opts.customer });
  tenants.push(w.tenantId);
  await db.user.update({ where: { id: w.userId }, data: { role: "OWNER" } });
  // Übergabe liegt realistisch zurück (sonst läge jede Abgabe „vor dem Mietbeginn“)
  await db.booking.update({ where: { id: w.bookingId }, data: { actualPickupAt: new Date(Date.now() - 2 * 86400_000) } });
  if (opts.enabled !== false) await saveKeyDropSettings(w.tenantId, w.actor, { enabled: true, label: "Schlüsselbox Hof", parkingNote: "Parkplatz 4", keyNote: "Briefkasten links" });
  return w;
}
async function agree(w: PickedUpWorld, extra: Partial<Parameters<typeof authorizeKeyDrop>[3]> = {}) {
  return authorizeKeyDrop(w.tenantId, w.actor, w.bookingId, { location: "Hof Hafenstr. 1, Stellplatz 4", instructions: "Schlüssel in die Box am Tor", expectedReturnAt: new Date(Date.now() + 2 * HOUR), internalNote: "INTERN: Kunde zahlt spät", agreedWithCustomer: true, ...extra });
}
async function sendLink(w: PickedUpWorld, kdId: string, n = nonce()) {
  const before = mail.sent.length;
  const res = await sendKeyDropLink(w.tenantId, w.actor, kdId, { nonce: n, baseUrl: BASE });
  return { res, token: mail.sent.length > before ? tokenOf(mail.sent.at(-1)!) : null };
}
const confirmInput = (over: Partial<ConfirmInput> = {}): ConfirmInput => ({ dropOffAt: new Date(Date.now() - 10 * 60_000), mileage: 45_600, fuelEighths: 6, batteryPercent: null, locationConfirmed: true, locationNote: null, newDamages: false, damageNote: null, remark: "Alles gut", signerName: "Erika Muster", signatureDataUrl: fakeSignaturePng(), accepted: true, ...over });

async function staffInspect(w: PickedUpWorld, opts: { exception?: string; mileage?: number; damage?: boolean } = {}) {
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor, { keyDropException: opts.exception ?? null });
  await updateHandoverDraft(w.tenantId, r.id, { mileage: opts.mileage ?? 45_602, fuelLevelEighths: 5 });
  if (opts.damage) {
    const d = await addNewDamage(w.tenantId, r.id, { view: "LEFT", posX: 0.4, posY: 0.5, kind: "SCRATCH", severity: "MINOR", description: "Kratzer Tür links" });
    const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
    await registerPhoto(w.tenantId, w.actor, { handoverId: r.id, handoverDamageId: d.id, storageKey: key, category: "DAMAGE", contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key) });
  }
  for (const cat of REQUIRED_PHOTO_CATEGORIES) {
    const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" });
    await registerPhoto(w.tenantId, w.actor, { handoverId: r.id, storageKey: key, category: cat, contentType: "image/jpeg", sizeBytes: 1000, checksum: sha256(key) });
  }
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId: r.id } });
  await answerChecklist(w.tenantId, r.id, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? (i.itemKey === "keys" || i.itemKey === "keys_returned" ? "2" : "") : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  return r;
}

async function sealedState(w: PickedUpWorld) {
  const [booking, vehicle, deposits, invoices, charges, events] = await Promise.all([
    db.booking.findUniqueOrThrow({ where: { id: w.bookingId }, select: { status: true, actualReturnAt: true } }),
    db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId }, select: { status: true, mileage: true } }),
    db.securityDepositEvent.count({ where: { tenantId: w.tenantId } }),
    db.invoice.count({ where: { tenantId: w.tenantId } }),
    db.extraCharge.count({ where: { tenantId: w.tenantId } }),
    db.damageCase.count({ where: { tenantId: w.tenantId } }),
  ]);
  return { booking, vehicle, deposits, invoices, charges, events };
}

test("Einstellung aus = keine Vereinbarung; Vereinbarung nur mit Bestätigung der Absprache; Vereinbarung sendet KEINE Mail", async () => {
  const off = await world("kd-off", { enabled: false });
  await assert.rejects(agree(off), (e: Error) => e instanceof DomainError && /nicht freigeschaltet/.test(e.message));
  const w = await world("kd-agree");
  await assert.rejects(agree(w, { agreedWithCustomer: false }), /vereinbart wurde/);
  const m0 = mail.sent.length;
  const kd = await agree(w);
  assert.equal(kd.status, "AUTHORIZED");
  assert.equal(kd.recipientEmail, "erika@example.test");
  assert.equal(mail.sent.length, m0, "Vereinbaren versendet nichts");
  assert.equal(await db.emailLog.count({ where: { tenantId: w.tenantId, template: "KEY_DROP_LINK" } }), 0);
  assert.equal(await db.keyDropAccess.count({ where: { tenantId: w.tenantId } }), 0, "kein Link ohne Versand");
  assert.deepEqual((await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { startsWith: "KEY_DROP" } }, orderBy: { createdAt: "asc" } })).map((a) => a.action), ["KEY_DROP_ENABLED", "KEY_DROP_AUTHORIZED"]);
  await assert.rejects(agree(w), /bereits eine kontaktlose Rückgabe/);
});

test("Mail nur per Klick über TENANT_BUSINESS an die Adresse aus der Vertragskopie; Token nur gehasht; fehlende Adresse blockiert", async () => {
  const w = await world("kd-send");
  const kd = await agree(w);
  // Kundenadresse nachträglich geändert: maßgeblich bleibt die Vertragskopie
  await db.customer.update({ where: { id: w.customerId }, data: { email: "neu@example.test" } });
  const { res, token } = await sendLink(w, kd.id);
  assert.equal(res.status, "SENT");
  const m = mail.sent.at(-1)!;
  assert.equal(m.to, "erika@example.test");
  assert.equal(m.subject, `Ihre kontaktlose Fahrzeugrückgabe – ${(await db.tenant.findUniqueOrThrow({ where: { id: w.tenantId } })).name}`);
  assert.match(m.text, /keine gemeinsame Fahrzeugkontrolle/);
  assert.ok(!/mangelfrei|mängelfrei|vollständig abgeschlossen|haften für alle/i.test(m.text));
  assert.match(m.text, /Parkplatz 4/);
  assert.ok(token && token.length >= 43, "32 Byte Zufall, base64url");
  const log = await db.emailLog.findFirstOrThrow({ where: { tenantId: w.tenantId, template: "KEY_DROP_LINK" } });
  assert.deepEqual([log.category, log.channel, log.bookingId, log.trigger], ["TENANT_BUSINESS", "PLATFORM_SMTP", w.bookingId, "MANUAL"]);
  const access = await db.keyDropAccess.findFirstOrThrow({ where: { keyDropId: kd.id } });
  assert.equal(access.tokenHash, sha256(token!));
  const everything = JSON.stringify({ logs: await db.emailLog.findMany({ where: { tenantId: w.tenantId } }), audit: await db.auditLog.findMany({ where: { tenantId: w.tenantId } }), access: await db.keyDropAccess.findMany({ where: { tenantId: w.tenantId } }), kd: await db.keyDropReturn.findMany({ where: { tenantId: w.tenantId } }) });
  assert.ok(!everything.includes(token!), "Token nirgends im Klartext gespeichert");
  assert.ok(access.expiresAt.getTime() > Date.now() + 2 * 86400_000, "befristet, aber lange genug");

  const noMail = await world("kd-nomail", { customer: { email: null } });
  const kd2 = await agree(noMail);
  await assert.rejects(sendKeyDropLink(noMail.tenantId, noMail.actor, kd2.id, { nonce: nonce(), baseUrl: BASE }), /keine gültige E-Mail-Adresse/);
});

test("Erneut senden widerruft den alten Link (nie zwei gültige); Doppelklick sendet nicht doppelt; Widerruf, Ablauf", async () => {
  const w = await world("kd-resend");
  const kd = await agree(w);
  const n = nonce();
  const [a, b] = await Promise.all([sendKeyDropLink(w.tenantId, w.actor, kd.id, { nonce: n, baseUrl: BASE }), sendKeyDropLink(w.tenantId, w.actor, kd.id, { nonce: n, baseUrl: BASE })]);
  assert.deepEqual([a.status, b.status].sort(), ["DUPLICATE", "SENT"], "Doppelklick: genau ein Versand");
  const first = tokenOf(mail.sent.at(-1)!);
  const { res, token: second } = await sendLink(w, kd.id);
  assert.deepEqual([res.status, res.resent], ["SENT", true]);
  assert.equal(await resolveKeyDropToken(first), null, "alter Link ungültig");
  assert.ok(await resolveKeyDropToken(second!), "neuer Link gültig");
  assert.equal(await db.keyDropAccess.count({ where: { keyDropId: kd.id, revokedAt: null } }), 1);
  await assert.rejects(db.keyDropAccess.updateMany({ where: { keyDropId: kd.id, revokedAt: { not: null } }, data: { revokedAt: null } }), /widerrufen/);
  const actions = (await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { startsWith: "KEY_DROP" } }, orderBy: { createdAt: "asc" } })).map((x) => x.action);
  assert.ok(actions.includes("KEY_DROP_MAIL_SENT") && actions.includes("KEY_DROP_MAIL_RESENT") && actions.includes("KEY_DROP_TOKEN_REVOKED") && actions.filter((x) => x === "KEY_DROP_LINK_CREATED").length === 2);
  await revokeKeyDropLink(w.tenantId, w.actor, kd.id);
  assert.equal(await resolveKeyDropToken(second!), null, "widerrufen");
  const { token: third } = await sendLink(w, kd.id);
  await db.keyDropAccess.updateMany({ where: { tokenHash: sha256(third!) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await resolveKeyDropToken(third!), null, "abgelaufen");
  assert.equal(await resolveKeyDropToken("../../etc/passwd"), null);
  assert.equal(await resolveKeyDropToken(w.bookingId), null, "Buchungs-ID ist keine Berechtigung");
});

test("Kundenseite zeigt nur Nötiges; Kundenmeldung beendet die Rückgabe NICHT; Eingangsbestätigung + unveränderliches PDF; zweite Meldung abgelehnt", async () => {
  const w = await world("kd-confirm");
  const kd = await agree(w);
  const { token } = await sendLink(w, kd.id);
  const view = await publicKeyDropView(token!);
  assert.ok(view);
  const json = JSON.stringify(view);
  assert.ok(!json.includes("INTERN") && !/deposit|kaution|iban|invoice/i.test(json), "keine internen Daten");
  await publicKeyDropView(token!);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "KEY_DROP_CUSTOMER_STARTED" } }), 1, "Öffnen einmal protokolliert");
  const sharp = (await import("sharp")).default;
  const jpg = new Uint8Array(await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer());
  const photo = await uploadKeyDropPhoto(token!, "ODOMETER", jpg);
  const stored = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
  assert.ok(stored.storageKey.startsWith(`t/${w.tenantId}/`) && stored.keyDropId === kd.id && stored.handoverId === null);
  assert.ok(await readKeyDropPhoto(token!, photo.id));

  await assert.rejects(confirmKeyDrop(token!, confirmInput({ dropOffAt: new Date(Date.now() + 3 * HOUR) })), /Zukunft/);
  await assert.rejects(confirmKeyDrop(token!, confirmInput({ mileage: 100 })), /unter dem Stand bei der Übergabe/);
  await assert.rejects(confirmKeyDrop(token!, confirmInput({ accepted: false })), /Bestätigung/);
  await assert.rejects(confirmKeyDrop(token!, confirmInput({ fuelEighths: null })), /Tankstand/);

  const before = await sealedState(w);
  const [r1, r2] = await Promise.allSettled([confirmKeyDrop(token!, confirmInput()), confirmKeyDrop(token!, confirmInput())]);
  assert.equal([r1, r2].filter((r) => r.status === "fulfilled").length, 1, "zwei Tabs: genau eine Meldung");
  const confirmed = await db.keyDropReturn.findUniqueOrThrow({ where: { id: kd.id } });
  assert.equal(confirmed.status, "CUSTOMER_CONFIRMED");
  assert.equal(await db.signature.count({ where: { keyDropId: kd.id } }), 1);
  const afterState = await sealedState(w);
  assert.deepEqual(afterState, before, "Buchung, Fahrzeug, Kaution, Rechnung, Zusatzkosten, Schadenakten unverändert");
  assert.equal(afterState.booking.status, "ACTIVE", "Rückgabe nicht abgeschlossen");
  await assert.rejects(db.keyDropReturn.update({ where: { id: kd.id }, data: { customerMileage: 1 } }), /bestätigte Kundenangaben/);
  await assert.rejects(uploadKeyDropPhoto(token!, "FRONT", jpg), /bereits gemeldet/);

  const m0 = mail.sent.length;
  await runKeyDropConfirmationFollowUp(w.tenantId, kd.id);
  await runKeyDropConfirmationFollowUp(w.tenantId, kd.id); // idempotent
  assert.equal(mail.sent.length, m0 + 1);
  const conf = mail.sent.at(-1)!;
  assert.equal(conf.subject, "Bestätigung Ihrer kontaktlosen Fahrzeugrückgabe");
  assert.match(conf.text, /Fahrzeugkontrolle durch .* steht noch aus/);
  assert.ok(!/mängelfrei|mangelfrei|Kaution.*frei|abgeschlossen/i.test(conf.text.replace(/Versendet mit RentBase[\s\S]*/, "")));
  assert.equal(conf.attachments.filter((a) => a.contentType === "application/pdf").length, 1);
  const doc = await db.document.findFirstOrThrow({ where: { tenantId: w.tenantId, type: "KEY_DROP_CONFIRMATION", keyDropId: kd.id } });
  assert.equal(doc.sourceHash, confirmed.confirmationHash);
  const log = await db.emailLog.findFirstOrThrow({ where: { tenantId: w.tenantId, template: "KEY_DROP_CONFIRMATION" } });
  assert.deepEqual([log.status, log.category, log.channel], ["SENT", "TENANT_BUSINESS", "PLATFORM_SMTP"]);
  const pub = await publicKeyDropView(token!);
  assert.ok(pub?.confirmed, "Kunde sieht nur noch die Eingangsbestätigung");

  // Dashboard: offene Kontrolle, nicht „überfällig“
  await db.booking.update({ where: { id: w.bookingId }, data: { endAt: new Date(Date.now() - 5 * HOUR) } });
  const todo = await keyDropsToInspect(w.tenantId);
  assert.equal(todo.length, 1);
  assert.equal(todo[0].dropOffAt?.getTime(), confirmed.customerDropOffAt?.getTime());
  const dash = await loadDashboard(w.tenantId);
  const all = Object.values(dash.groups).flat();
  assert.ok(all.some((t) => t.key === `keydrop-${w.bookingId}`) && !all.some((t) => t.key === `return-overdue-${w.bookingId}`));
});

test("Kontrolle: Kundenwerte getrennt, keine Kundenunterschrift, Abschluss erst durch Mitarbeiter, Schaden ohne Automatik, PDF mit zwei Bereichen", async () => {
  const w = await world("kd-inspect");
  const kd = await agree(w);
  const { token } = await sendLink(w, kd.id);
  const dropOff = new Date(Date.now() - 30 * 60_000);
  await confirmKeyDrop(token!, confirmInput({ dropOffAt: dropOff, mileage: 45_600, newDamages: false }));
  const r = await staffInspect(w, { mileage: 45_602, damage: true });
  const h = await db.handover.findUniqueOrThrow({ where: { id: r.id } });
  assert.deepEqual([h.returnMode, h.keyDropId, h.customerDropOffAt?.getTime()], ["KEY_DROP", kd.id, dropOff.getTime()]);
  await assert.rejects(saveHandoverSignature(w.tenantId, w.actor, r.id, { role: "RENTER", signerName: "Erika", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, r.id) }), /unterschreibt der Kunde nicht/);
  const completion = await getHandoverCompletionStatus(w.tenantId, r.id);
  assert.ok(completion.ready, completion.blockers.map((b) => b.message).join("; "));
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).status, "ACTIVE", "vor der Kontrolle nicht abgeschlossen");
  await finalizeHandover(w.tenantId, r.id, w.actor);
  const [booking, done, vehicle] = await Promise.all([db.booking.findUniqueOrThrow({ where: { id: w.bookingId } }), db.keyDropReturn.findUniqueOrThrow({ where: { id: kd.id } }), db.vehicle.findUniqueOrThrow({ where: { id: w.vehicleId } })]);
  assert.equal(booking.status, "RETURNED");
  assert.equal(booking.actualReturnAt?.getTime(), dropOff.getTime(), "Mietende = Abgabe laut Kunde");
  assert.equal(done.status, "INSPECTED");
  assert.ok(done.inspectedAt && done.inspectedAt.getTime() > dropOff.getTime() && done.inspectedById === w.actor.id, "Kontrollzeitpunkt getrennt vom Kundenzeitpunkt");
  assert.deepEqual([done.customerMileage, vehicle.mileage], [45_600, 45_602], "Kundenwert bleibt, Fahrzeug übernimmt den Kontrollwert");
  assert.equal(await resolveKeyDropToken(token!), null, "Link nach der Kontrolle ungültig");
  // Schaden: bestehende Logik, Quelle „nachträgliche Kontrolle“, keine Haftung, keine Rechnung
  const ev = await db.vehicleEvent.findFirstOrThrow({ where: { tenantId: w.tenantId, type: "DAMAGE_DISCOVERED" } });
  assert.match(ev.description ?? "", /nachträglicher Kontrolle nach kontaktloser Rückgabe/);
  assert.equal(await db.damageCase.count({ where: { tenantId: w.tenantId } }), 0, "keine automatische Schadenakte/Haftung");
  assert.equal(await db.invoice.count({ where: { tenantId: w.tenantId } }), 0, "keine automatische Rechnung");
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId, type: { not: "RECEIVED" } } }), 0, "keine Kautionsverrechnung");
  const data = await loadHandoverDocumentData(w.tenantId, r.id);
  const pdf = await renderHandoverPdf(data.doc, { sketchSvg: null, photos: new Map(), signatures: data.signatureImages });
  const text = pdf.trace.texts.join("\n");
  assert.match(text, /ANGABEN DES KUNDEN BEI KONTAKTLOSER RÜCKGABE/);
  assert.match(text, /NACHTRÄGLICHE FAHRZEUGKONTROLLE/);
  assert.match(text, /nicht anwesend/);
  assert.match(text, /45\.600 km/);
  assert.ok(!data.doc.signatures.some((s) => s.role === "RENTER"), "keine Kundenunterschrift unter den Kontrollfeststellungen");
  assert.ok(pdf.trace.boxes.every((b) => !b.overflow));
  assert.equal((await verifyHandover(w.tenantId, r.id)).intact, true);
});

test("Ausnahme ohne Kundenmeldung nur mit Grund; Aufheben vor der Meldung; normale Rückgabe unverändert; Bestandsprotokoll unverändert", async () => {
  const w = await world("kd-exc");
  const kd = await agree(w);
  const { token } = await sendLink(w, kd.id);
  await assert.rejects(startHandover(w.tenantId, w.bookingId, "RETURN", w.actor), /noch nicht gemeldet/);
  await assert.rejects(startHandover(w.tenantId, w.bookingId, "RETURN", w.actor, { keyDropException: "kurz" }), /mindestens 10 Zeichen/);
  // Race: Kunde meldet, während die Ausnahme gestartet wird – genau ein konsistenter Zustand
  const [c, s] = await Promise.allSettled([confirmKeyDrop(token!, confirmInput()), startHandover(w.tenantId, w.bookingId, "RETURN", w.actor, { keyDropException: "Kunde telefonisch: Link geht nicht" })]);
  const h = await db.handover.findFirstOrThrow({ where: { bookingId: w.bookingId, type: "RETURN" } });
  const k = await db.keyDropReturn.findUniqueOrThrow({ where: { id: kd.id } });
  assert.equal(s.status, "fulfilled");
  if (c.status === "fulfilled") assert.deepEqual([k.status, h.keyDropExceptionReason], ["CUSTOMER_CONFIRMED", null], "Meldung zuerst: normale Kontrolle ohne Ausnahme");
  else assert.deepEqual([k.confirmedAt, typeof h.keyDropExceptionReason], [null, "string"], "Ausnahme zuerst: Meldung abgelehnt");
  if (c.status === "rejected") {
    assert.equal(await resolveKeyDropToken(token!), null, "Link bei Ausnahme ungültig");
    assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "KEY_DROP_EXCEPTION_USED" } }), 1);
  }

  const w2 = await world("kd-cancel");
  const kd2 = await agree(w2);
  const { token: t2 } = await sendLink(w2, kd2.id);
  await cancelKeyDrop(w2.tenantId, w2.actor, kd2.id, "Kunde bringt es persönlich");
  assert.equal(await resolveKeyDropToken(t2!), null);
  const inPerson = await startHandover(w2.tenantId, w2.bookingId, "RETURN", w2.actor);
  assert.deepEqual([inPerson.returnMode, inPerson.keyDropId], ["IN_PERSON", null]);
  const st = await getHandoverCompletionStatus(w2.tenantId, inPerson.id);
  assert.ok(st.blockers.some((b) => b.code === "SIGNATURE_MISSING"), "persönliche Rückgabe verlangt weiter die Mieterunterschrift");

  const w3 = await world("kd-cancel-late");
  const kd3 = await agree(w3);
  const { token: t3 } = await sendLink(w3, kd3.id);
  await confirmKeyDrop(t3!, confirmInput());
  await assert.rejects(cancelKeyDrop(w3.tenantId, w3.actor, kd3.id, "zu spät"), /nicht mehr aufgehoben/);
  await assert.rejects(db.keyDropReturn.update({ where: { id: kd3.id }, data: { status: "CANCELLED" } }), /nicht mehr aufgehoben/);

  // Bestandsprotokoll (ohne Rückgabeart) bleibt exakt versiegelt
  const old = await returnedWorld("kd-legacy");
  tenants.push(old.tenantId);
  const legacy = await db.handover.findUniqueOrThrow({ where: { id: old.returnId } });
  assert.equal(legacy.returnMode, "IN_PERSON");
  assert.equal((await verifyHandover(old.tenantId, old.returnId)).intact, true);
  await db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_purge = 'on'`); await tx.handover.update({ where: { id: old.returnId }, data: { returnMode: null } }); });
  assert.equal((await verifyHandover(old.tenantId, old.returnId)).intact, true, "Hash unabhängig von der Rückgabeart bei persönlicher Rückgabe");
});

test("Mandantentrennung, Rollen und Sicherheit im Code", async () => {
  const a = await world("kd-iso-a");
  const b = await world("kd-iso-b");
  const kdA = await agree(a);
  const { token: tA } = await sendLink(a, kdA.id);
  await assert.rejects(sendKeyDropLink(b.tenantId, b.actor, kdA.id, { nonce: nonce(), baseUrl: BASE }), /nicht gefunden/);
  await assert.rejects(cancelKeyDrop(b.tenantId, b.actor, kdA.id, "fremd"), /nicht gefunden/);
  const kdB = await agree(b);
  const { token: tB } = await sendLink(b, kdB.id);
  const sharp = (await import("sharp")).default;
  const jpg = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer());
  const photoB = await uploadKeyDropPhoto(tB!, "FRONT", jpg);
  assert.equal(await readKeyDropPhoto(tA!, photoB.id), null, "Token A liest kein Foto von B");
  const viewA = await publicKeyDropView(tA!);
  assert.ok(viewA && !viewA.photos.some((p) => p.id === photoB.id));
  assert.equal((await keyDropsToInspect(a.tenantId)).length, 0);

  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  const actions = read("src/app/(app)/buchungen/[id]/key-drop-actions.ts");
  const bodies = [...actions.matchAll(/export async function (\w+)[\s\S]*?\n}/g)];
  assert.equal(bodies.length, 4);
  for (const m of bodies) {
    assert.match(m[0], /requireRole\("DISPO"\)/, `${m[1]}: nur Inhaber/Disposition (kein Hofmitarbeiter, kein Supportmodus)`);
    if (m[1] !== "authorizeKeyDropAction") assert.match(m[0], /ownKeyDrop\(tenant\.id, bookingId, keyDropId\)/, `${m[1]}: gehört zum Mandanten und zur Buchung`);
  }
  assert.match(read("src/app/(app)/buchungen/[id]/rueckgabe/actions.ts"), /export async function startKeyDropExceptionAction[\s\S]*?requireRole\("DISPO"\)/, "Ausnahme nur Inhaber/Disposition");
  assert.match(read("src/app/(app)/einstellungen/geschaeftsregeln/actions.ts"), /export async function updateKeyDropSettingsAction[\s\S]*?requireRole\("OWNER"\)/, "Einstellung nur Inhaber");
  for (const f of ["src/app/rueckgabe/[token]/page.tsx", "src/app/rueckgabe/[token]/actions.ts", "src/app/api/rueckgabe/[token]/foto/route.ts"]) {
    const src = read(f);
    assert.ok(!/internalNote|deposit|iban|getSession|requireSession/.test(src), `${f}: keine internen Daten, keine Sitzung`);
    assert.match(src, /consume\(/, `${f}: Rate-Limit`);
  }
  const lib = read("src/lib/key-drop.ts");
  assert.ok(!/(setInterval|cron|schedule)/i.test(lib), "kein zeitgesteuerter Versand");
  assert.match(lib, /tokenHash: sha256\(rawToken\)/);
  assert.ok(!/recordAudit\([^)]*rawToken/.test(lib) && !/console\.\w+\([^)]*rawToken/.test(lib), "Token nie in Audit oder Log");
  assert.match(read("src/proxy.ts"), /"\/rueckgabe", "\/api\/rueckgabe"/);
});
