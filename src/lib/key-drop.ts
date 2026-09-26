// Befehl 20.6: kontaktlose Rückgabe / Schlüsselbox.
//
// Vier getrennte Vorgänge, nie automatisch miteinander verbunden:
//   1. Vereinbarung durch den Vermieter (OWNER/DISPO) – nachdem sie mit dem Kunden abgesprochen wurde. Keine Mail.
//   2. „Rückgabe-Mail versenden“ – ausschließlich durch bewussten Klick; erzeugt einen persönlichen Link (Token, nur
//      als Hash gespeichert). Erneuter Versand widerruft den alten Link und erzeugt einen neuen (nie zwei gültige).
//   3. Kundenmeldung über den Link: Abstellzeitpunkt, Kilometer, Tank/Batterie, Ort, Schäden, Fotos, Bestätigung,
//      Unterschrift. Danach unveränderlich; automatische Eingangsbestätigung (keine Zustandsbestätigung).
//   4. Nachträgliche Kontrolle durch Mitarbeiter über die bestehende Rückgabe (handovers.ts). Erst sie schließt ab.
//
// Kaution, Rechnung, Zusatzkosten, Fahrzeugstatus und Haftung werden hier nie berührt.

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { claimEmail, markEmailFailed, markEmailSent } from "@/lib/email-log";
import { DomainError, contentHash, sha256 } from "@/lib/integrity";
import { deliveryMetaOf, isValidEmail, safeMailError, type MailTransport } from "@/lib/mail";
import { sendBusinessMail } from "@/lib/tenant-mail";
import { logoRefOf } from "@/lib/branding-ref";
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, assertKeyBelongsToTenant, buildStorageKey, getStorage, sniffImageType, type StorageDriver } from "@/lib/storage";
import {
  KEY_DROP_CONFIRMATION_TEXT, KEY_DROP_NOT_INSPECTION_TEXT, KEY_DROP_PHOTO_CATEGORIES, PHOTO_CATEGORIES, energyRequirements,
  type KeyDropStatus, type PhotoCategory,
} from "@/lib/constants";
import { APP_TIME_ZONE } from "@/lib/time";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export const KEY_DROP_LINK_TEMPLATE = "KEY_DROP_LINK";
export const KEY_DROP_CONFIRMATION_TEMPLATE = "KEY_DROP_CONFIRMATION";
const MAX_CUSTOMER_PHOTOS = 20;

const fmt = (d: Date | null | undefined) => (d ? d.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const clean = (v: string | null | undefined, max: number) => { const t = (v ?? "").replace(/\r\n/g, "\n").trim(); return t ? t.slice(0, max) : null; };

// ---------------------------------------------------------------------------
// Mandanten-Einstellung
// ---------------------------------------------------------------------------

export type KeyDropSettings = { label: string; defaultInstructions: string | null; parkingNote: string | null; keyNote: string | null; requestedPhotos: PhotoCategory[] };
export const DEFAULT_KEY_DROP_SETTINGS: KeyDropSettings = { label: "Schlüsselbox", defaultInstructions: null, parkingNote: null, keyNote: null, requestedPhotos: ["FRONT", "REAR", "LEFT", "RIGHT", "ODOMETER", "FUEL"] };

export function keyDropSettingsOf(raw: unknown): KeyDropSettings {
  const s = (raw ?? {}) as Partial<KeyDropSettings>;
  const photos = Array.isArray(s.requestedPhotos) ? s.requestedPhotos.filter((c): c is PhotoCategory => KEY_DROP_PHOTO_CATEGORIES.includes(c as PhotoCategory)) : DEFAULT_KEY_DROP_SETTINGS.requestedPhotos;
  return {
    label: typeof s.label === "string" && s.label.trim() ? s.label.trim().slice(0, 60) : DEFAULT_KEY_DROP_SETTINGS.label,
    defaultInstructions: typeof s.defaultInstructions === "string" ? clean(s.defaultInstructions, 1500) : null,
    parkingNote: typeof s.parkingNote === "string" ? clean(s.parkingNote, 600) : null,
    keyNote: typeof s.keyNote === "string" ? clean(s.keyNote, 600) : null,
    requestedPhotos: photos,
  };
}

export async function saveKeyDropSettings(tenantId: string, actor: Actor, input: { enabled: boolean } & Partial<KeyDropSettings>) {
  const next = keyDropSettingsOf(input);
  await db.$transaction(async (tx) => {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { keyDropEnabled: true, keyDropSettings: true } });
    await tx.tenant.update({ where: { id: tenantId }, data: { keyDropEnabled: input.enabled, keyDropSettings: next as unknown as Prisma.InputJsonValue } });
    if (t.keyDropEnabled !== input.enabled) await recordAudit(tx, tenantId, actor, { action: input.enabled ? "KEY_DROP_ENABLED" : "KEY_DROP_DISABLED", details: { label: next.label } });
    else if (JSON.stringify(keyDropSettingsOf(t.keyDropSettings)) !== JSON.stringify(next)) await recordAudit(tx, tenantId, actor, { action: "KEY_DROP_SETTINGS_UPDATED", details: { label: next.label, requestedPhotos: next.requestedPhotos.join(",") } });
  });
}

// ---------------------------------------------------------------------------
// Vereinbarung
// ---------------------------------------------------------------------------

/** Empfänger aus der versiegelten Vertragskopie (dieselbe Quelle wie Übergabe-/Rückgabeunterlagen), nie frei eingegeben. */
function recipientFromContract(customerSnapshot: unknown): { name: string; email: string | null } {
  const c = (customerSnapshot ?? {}) as { firstName?: string; lastName?: string; companyName?: string | null; type?: string; email?: string | null };
  const person = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  const name = c.type === "COMPANY" && c.companyName ? (person ? `${c.companyName}, ${person}` : c.companyName) : person;
  const email = typeof c.email === "string" && c.email.trim() ? c.email.trim().toLowerCase() : null;
  return { name: name || "Kunde", email };
}

export type AuthorizeInput = { location: string; instructions?: string | null; expectedReturnAt: Date | null; internalNote?: string | null; agreedWithCustomer: boolean };

export async function authorizeKeyDrop(tenantId: string, actor: Actor, bookingId: string, input: AuthorizeInput) {
  if (!input.agreedWithCustomer) throw new DomainError("Bitte bestätigen, dass die kontaktlose Rückgabe mit dem Kunden vereinbart wurde.");
  const location = clean(input.location, 300);
  if (!location || location.length < 3) throw new DomainError("Bitte den vereinbarten Rückgabeort angeben.");
  if (!input.expectedReturnAt || Number.isNaN(input.expectedReturnAt.getTime())) throw new DomainError("Bitte den erwarteten Rückgabezeitpunkt angeben.");
  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { keyDropEnabled: true, keyDropSettings: true } });
    if (!tenant.keyDropEnabled) throw new DomainError("Die kontaktlose Rückgabe ist in den Einstellungen nicht freigeschaltet (Einstellungen → Geschäftsregeln).");
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("Buchung nicht gefunden.");
    const booking = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId }, include: { contract: { select: { status: true, customerSnapshot: true } } } });
    if (booking.status !== "ACTIVE") throw new DomainError("Eine kontaktlose Rückgabe kann nur für eine laufende Miete vereinbart werden.");
    if (booking.contract?.status !== "SIGNED") throw new DomainError("Zu dieser Miete gibt es keinen abgeschlossenen Mietvertrag.");
    const pickup = await tx.handover.count({ where: { tenantId, bookingId, type: "PICKUP", status: "FINALIZED" } });
    if (pickup === 0) throw new DomainError("Zu dieser Miete gibt es kein abgeschlossenes Übergabeprotokoll.");
    const ret = await tx.handover.count({ where: { tenantId, bookingId, type: "RETURN", correctsId: null } });
    if (ret > 0) throw new DomainError("Die Rückgabe dieser Miete ist bereits begonnen oder abgeschlossen.");
    const active = await tx.keyDropReturn.count({ where: { tenantId, bookingId, status: { not: "CANCELLED" } } });
    if (active > 0) throw new DomainError("Für diese Miete ist bereits eine kontaktlose Rückgabe vereinbart.");
    const settings = keyDropSettingsOf(tenant.keyDropSettings);
    const recipient = recipientFromContract(booking.contract.customerSnapshot);
    const kd = await tx.keyDropReturn.create({
      data: {
        tenantId, bookingId, agreedById: actor.id, agreedByName: actor.name, location,
        instructions: clean(input.instructions, 1500) ?? settings.defaultInstructions,
        expectedReturnAt: input.expectedReturnAt!, internalNote: clean(input.internalNote, 1000),
        settingsSnapshot: settings as unknown as Prisma.InputJsonValue,
        recipientName: recipient.name, recipientEmail: recipient.email,
      },
    });
    await recordAudit(tx, tenantId, actor, { action: "KEY_DROP_AUTHORIZED", bookingId, details: { keyDropId: kd.id, expectedReturnAt: kd.expectedReturnAt.toISOString() } });
    return kd;
  }, TX);
}

async function lockKeyDrop(tx: Tx, tenantId: string, keyDropId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "KeyDropReturn" WHERE "id" = ${keyDropId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (rows.length === 0) throw new DomainError("Kontaktlose Rückgabe nicht gefunden.");
  return tx.keyDropReturn.findUniqueOrThrow({ where: { id: keyDropId } });
}

async function revokeActive(tx: Tx, tenantId: string, keyDropId: string, reason: string) {
  const res = await tx.keyDropAccess.updateMany({ where: { tenantId, keyDropId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  return res.count;
}

/** Aufheben (z. B. Kunde bringt das Fahrzeug doch persönlich). Nur solange der Kunde die Abgabe nicht gemeldet hat. */
export async function cancelKeyDrop(tenantId: string, actor: Actor, keyDropId: string, reason: string) {
  const why = clean(reason, 300);
  if (!why || why.length < 3) throw new DomainError("Bitte einen Grund für die Aufhebung angeben.");
  return db.$transaction(async (tx) => {
    const kd = await lockKeyDrop(tx, tenantId, keyDropId);
    if (kd.status !== "AUTHORIZED") throw new DomainError("Nach der Rückgabemeldung des Kunden kann die kontaktlose Rückgabe nicht mehr aufgehoben werden.");
    if (await tx.handover.count({ where: { tenantId, keyDropId } })) throw new DomainError("Die Kontrolle dieser Rückgabe ist bereits begonnen.");
    const revoked = await revokeActive(tx, tenantId, keyDropId, "Vereinbarung aufgehoben");
    await tx.keyDropReturn.update({ where: { id: kd.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: actor.id, cancelledByName: actor.name, cancelReason: why } });
    if (revoked > 0) await recordAudit(tx, tenantId, actor, { action: "KEY_DROP_TOKEN_REVOKED", bookingId: kd.bookingId, details: { keyDropId: kd.id, reason: "Vereinbarung aufgehoben" } });
    await recordAudit(tx, tenantId, actor, { action: "KEY_DROP_CANCELLED", bookingId: kd.bookingId, details: { keyDropId: kd.id, reason: why } });
  }, TX);
}

/** Link sofort ungültig machen (z. B. falscher Empfänger). Ein neuer Link entsteht nur durch erneuten Versand. */
export async function revokeKeyDropLink(tenantId: string, actor: Actor, keyDropId: string) {
  return db.$transaction(async (tx) => {
    const kd = await lockKeyDrop(tx, tenantId, keyDropId);
    const revoked = await revokeActive(tx, tenantId, keyDropId, "Vom Vermieter widerrufen");
    if (revoked > 0) await recordAudit(tx, tenantId, actor, { action: "KEY_DROP_TOKEN_REVOKED", bookingId: kd.bookingId, details: { keyDropId: kd.id, reason: "Vom Vermieter widerrufen" } });
    return revoked;
  }, TX);
}

// ---------------------------------------------------------------------------
// Rückgabe-Mail (nur durch bewussten Klick)
// ---------------------------------------------------------------------------

type LinkMailFacts = { renterName: string; landlordName: string; vehicleTitle: string; plate: string; location: string; expectedAt: string; link: string; instructions: string | null; parkingNote: string | null; keyNote: string | null; label: string };

export function composeKeyDropLinkMail(f: LinkMailFacts) {
  const subject = `Ihre kontaktlose Fahrzeugrückgabe – ${f.landlordName}`;
  const extra = [f.instructions, f.parkingNote ? `Abstellen: ${f.parkingNote}` : null, f.keyNote ? `Schlüssel: ${f.keyNote}` : null].filter(Boolean) as string[];
  const lines = [
    `Hallo ${f.renterName},`, "",
    "wie vereinbart können Sie Ihr Mietfahrzeug außerhalb unserer Geschäftszeiten kontaktlos zurückgeben.", "",
    `Fahrzeug: ${f.vehicleTitle}`, `Kennzeichen: ${f.plate}`, "",
    `Vereinbarter Rückgabeort: ${f.location}`, `Voraussichtliche Rückgabe: ${f.expectedAt}`, `Rückgabeart: ${f.label}`, "",
    "Bitte öffnen Sie bei der tatsächlichen Rückgabe den folgenden persönlichen Link:", f.link, "",
    "Dort dokumentieren Sie den Kilometerstand, Tank-/Ladestand, den Fahrzeugzustand und die Schlüsselhinterlegung.",
    `Die Fahrzeugkontrolle durch ${f.landlordName} erfolgt anschließend separat. Ihre Angaben stellen keine gemeinsame Fahrzeugkontrolle dar.`,
    ...(extra.length ? ["", "Hinweise zur Rückgabe:", ...extra] : []),
    "", "Bitte geben Sie diesen Link nicht weiter.", "", "Freundliche Grüße", f.landlordName,
  ];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a2230">
<p>Hallo ${esc(f.renterName)},</p>
<p>wie vereinbart können Sie Ihr Mietfahrzeug außerhalb unserer Geschäftszeiten kontaktlos zurückgeben.</p>
<table style="border-collapse:collapse;font-size:15px" cellpadding="0" cellspacing="0">
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Fahrzeug</td><td>${esc(f.vehicleTitle)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Kennzeichen</td><td>${esc(f.plate)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Rückgabeort</td><td>${esc(f.location)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#4a5568">Voraussichtlich</td><td>${esc(f.expectedAt)}</td></tr>
</table>
<p>Bitte öffnen Sie bei der tatsächlichen Rückgabe den folgenden persönlichen Link:</p>
<p><a href="${esc(f.link)}" style="display:inline-block;background:#16325c;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Rückgabe starten</a></p>
<p>Dort dokumentieren Sie den Kilometerstand, Tank-/Ladestand, den Fahrzeugzustand und die Schlüsselhinterlegung. Die Fahrzeugkontrolle durch ${esc(f.landlordName)} erfolgt anschließend separat. Ihre Angaben stellen keine gemeinsame Fahrzeugkontrolle dar.</p>
${extra.length ? `<p><b>Hinweise zur Rückgabe</b><br>${extra.map((e) => esc(e).replace(/\n/g, "<br>")).join("<br>")}</p>` : ""}
<p style="color:#4a5568;font-size:13px">Bitte geben Sie diesen Link nicht weiter.</p>
<p>Freundliche Grüße<br>${esc(f.landlordName)}</p>
</div>`;
  return { subject, text: lines.join("\n"), html };
}

function linkExpiry(expectedReturnAt: Date, now = new Date()) {
  const byExpected = expectedReturnAt.getTime() + 14 * 86400_000;
  const min = now.getTime() + 3 * 86400_000;
  const max = now.getTime() + 60 * 86400_000;
  return new Date(Math.min(max, Math.max(min, byExpected)));
}

export type SendLinkResult = { status: "SENT" | "FAILED" | "DUPLICATE"; error?: string; resent: boolean };

/**
 * „Rückgabe-Mail versenden“ / „erneut senden“. Derselbe Formularwert (nonce) sendet nie zweimal (Doppelklick).
 * Jeder Versand widerruft einen noch gültigen Link und erzeugt einen neuen – es gibt nie zwei gültige Links.
 * Der Link (Token) steht nur in der Mail; gespeichert wird ausschließlich sein Hash.
 */
export async function sendKeyDropLink(tenantId: string, actor: Actor, keyDropId: string, opts: { nonce: string; baseUrl: string; transport?: MailTransport; storage?: StorageDriver }): Promise<SendLinkResult> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(opts.nonce)) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  const kd0 = await db.keyDropReturn.findFirst({ where: { id: keyDropId, tenantId }, include: { booking: { include: { vehicle: true, contract: { select: { vehicleSnapshot: true } } } }, tenant: { select: { name: true } } } });
  if (!kd0) throw new DomainError("Kontaktlose Rückgabe nicht gefunden.");
  if (kd0.status !== "AUTHORIZED") throw new DomainError(kd0.status === "CANCELLED" ? "Die kontaktlose Rückgabe wurde aufgehoben." : "Der Kunde hat die Rückgabe bereits gemeldet. Ein neuer Link ist nicht mehr nötig.");
  if (!isValidEmail(kd0.recipientEmail)) throw new DomainError("Im Mietvertrag ist keine gültige E-Mail-Adresse des Mieters hinterlegt. Die Rückgabe-Mail kann nicht versendet werden.");
  const earlier = await db.keyDropAccess.count({ where: { tenantId, keyDropId } });
  const resent = earlier > 0;
  const subject = `Ihre kontaktlose Fahrzeugrückgabe – ${kd0.tenant.name}`;
  const { log, created } = await claimEmail({ tenantId, bookingId: kd0.bookingId, recipient: kd0.recipientEmail!, subject, template: KEY_DROP_LINK_TEMPLATE, trigger: "MANUAL", createdById: actor.id, idempotencyKey: `${KEY_DROP_LINK_TEMPLATE}:${kd0.id}:${opts.nonce}` });
  if (!created) return { status: "DUPLICATE", resent };

  const rawToken = randomBytes(32).toString("base64url");
  try {
    await db.$transaction(async (tx) => {
      const kd = await lockKeyDrop(tx, tenantId, keyDropId);
      if (kd.status !== "AUTHORIZED") throw new DomainError("Der Kunde hat die Rückgabe bereits gemeldet oder die Vereinbarung wurde aufgehoben.");
      if (await tx.handover.count({ where: { tenantId, keyDropId } })) throw new DomainError("Die Kontrolle dieser Rückgabe ist bereits begonnen.");
      const revoked = await revokeActive(tx, tenantId, keyDropId, "Durch neuen Link ersetzt");
      await tx.keyDropAccess.create({ data: { tenantId, keyDropId, tokenHash: sha256(rawToken), expiresAt: linkExpiry(kd.expectedReturnAt), createdById: actor.id, createdByName: actor.name, emailLogId: log.id } });
      if (revoked > 0) await recordAudit(tx, tenantId, actor, { action: "KEY_DROP_TOKEN_REVOKED", bookingId: kd.bookingId, details: { keyDropId: kd.id, reason: "Durch neuen Link ersetzt" } });
      await recordAudit(tx, tenantId, actor, { action: "KEY_DROP_LINK_CREATED", bookingId: kd.bookingId, details: { keyDropId: kd.id, emailLogId: log.id } });
    }, TX);
  } catch (e) {
    await markEmailFailed(tenantId, log.id, e instanceof DomainError ? e.message : "Link konnte nicht erzeugt werden");
    if (e instanceof DomainError) return { status: "FAILED", error: e.message, resent };
    throw e;
  }

  const v = (kd0.booking.contract?.vehicleSnapshot ?? {}) as { make?: string; model?: string; plate?: string };
  const settings = keyDropSettingsOf(kd0.settingsSnapshot);
  const mail = composeKeyDropLinkMail({
    renterName: kd0.recipientName, landlordName: kd0.tenant.name, vehicleTitle: `${v.make ?? kd0.booking.vehicle.make} ${v.model ?? kd0.booking.vehicle.model}`.trim(), plate: v.plate ?? kd0.booking.vehicle.plate,
    location: kd0.location, expectedAt: fmt(kd0.expectedReturnAt), link: `${opts.baseUrl.replace(/\/+$/, "")}/rueckgabe/${rawToken}`,
    instructions: kd0.instructions, parkingNote: settings.parkingNote, keyNote: settings.keyNote, label: settings.label,
  });
  try {
    const res = await sendBusinessMail(tenantId, { to: kd0.recipientEmail!, subject: mail.subject, text: mail.text, html: mail.html, fromName: kd0.tenant.name, replyTo: null, attachments: [] }, { transport: opts.transport, storage: opts.storage });
    await markEmailSent(tenantId, log.id, res.messageId, res.meta);
    await db.$transaction((tx) => recordAudit(tx, tenantId, actor, { action: resent ? "KEY_DROP_MAIL_RESENT" : "KEY_DROP_MAIL_SENT", bookingId: kd0.bookingId, details: { keyDropId: kd0.id, emailLogId: log.id, channel: res.meta.channel } }));
    return { status: "SENT", resent };
  } catch (e) {
    const message = safeMailError(e);
    await markEmailFailed(tenantId, log.id, message, deliveryMetaOf(e));
    return { status: "FAILED", error: message, resent };
  }
}

// ---------------------------------------------------------------------------
// Öffentliche Seite (Token)
// ---------------------------------------------------------------------------

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{40,64}$/;

/** Löst einen Link auf. Nur gültige, nicht widerrufene, nicht abgelaufene Links einer nicht aufgehobenen Rückgabe. */
export async function resolveKeyDropToken(rawToken: string) {
  if (!TOKEN_FORMAT.test(rawToken)) return null;
  const access = await db.keyDropAccess.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!access || access.revokedAt || access.expiresAt < new Date()) return null;
  const kd = await db.keyDropReturn.findFirst({ where: { id: access.keyDropId, tenantId: access.tenantId } });
  if (!kd || kd.status === "CANCELLED" || kd.status === "INSPECTED") return null;
  return { access, kd };
}

/** Nur, was der Kunde für die Rückgabe braucht – keine internen Notizen, keine Kaution, keine anderen Daten. */
export type PublicKeyDropView = {
  landlordName: string;
  hasLogo: boolean;
  vehicleTitle: string;
  plate: string;
  bookingNumber: string;
  label: string;
  location: string;
  instructions: string | null;
  parkingNote: string | null;
  keyNote: string | null;
  expectedAt: string;
  requestedPhotos: { category: PhotoCategory; label: string }[];
  energy: { fuel: boolean; battery: boolean };
  renterName: string;
  photos: { id: string; category: string; categoryLabel: string }[];
  confirmed: null | { at: string; dropOffAt: string; mileage: number | null };
};

export async function publicKeyDropView(rawToken: string): Promise<PublicKeyDropView | null> {
  const r = await resolveKeyDropToken(rawToken);
  if (!r) return null;
  const { kd, access } = r;
  const [tenant, booking, photos] = await Promise.all([
    db.tenant.findUniqueOrThrow({ where: { id: kd.tenantId }, select: { name: true, logoStorageKey: true } }),
    db.booking.findFirstOrThrow({ where: { id: kd.bookingId, tenantId: kd.tenantId }, select: { number: true, vehicle: { select: { make: true, model: true, plate: true, fuel: true } }, contract: { select: { vehicleSnapshot: true } } } }),
    db.photo.findMany({ where: { tenantId: kd.tenantId, keyDropId: kd.id }, orderBy: { uploadedAt: "asc" }, select: { id: true, category: true } }),
  ]);
  // Erster Aufruf: protokollieren (einmalig), Link als benutzt markieren
  if (!kd.customerStartedAt && kd.status === "AUTHORIZED") {
    const updated = await db.keyDropReturn.updateMany({ where: { id: kd.id, customerStartedAt: null }, data: { customerStartedAt: new Date() } });
    if (updated.count === 1) await db.$transaction((tx) => recordAudit(tx, kd.tenantId, null, { action: "KEY_DROP_CUSTOMER_STARTED", bookingId: kd.bookingId, details: { keyDropId: kd.id } }));
  }
  await db.keyDropAccess.updateMany({ where: { id: access.id, revokedAt: null }, data: { lastUsedAt: new Date() } });
  const v = (booking.contract?.vehicleSnapshot ?? {}) as { make?: string; model?: string; plate?: string; fuel?: string };
  const settings = keyDropSettingsOf(kd.settingsSnapshot);
  const e = energyRequirements(v.fuel ?? booking.vehicle.fuel);
  return {
    landlordName: tenant.name,
    hasLogo: Boolean(tenant.logoStorageKey),
    vehicleTitle: `${v.make ?? booking.vehicle.make} ${v.model ?? booking.vehicle.model}`.trim(),
    plate: v.plate ?? booking.vehicle.plate,
    bookingNumber: booking.number,
    label: settings.label,
    location: kd.location,
    instructions: kd.instructions,
    parkingNote: settings.parkingNote,
    keyNote: settings.keyNote,
    expectedAt: fmt(kd.expectedReturnAt),
    requestedPhotos: settings.requestedPhotos.map((c) => ({ category: c, label: PHOTO_CATEGORIES[c] })),
    energy: { fuel: e.fuel, battery: e.battery },
    renterName: kd.recipientName,
    photos: photos.map((p) => ({ id: p.id, category: p.category, categoryLabel: PHOTO_CATEGORIES[p.category as PhotoCategory] ?? p.category })),
    confirmed: kd.confirmedAt ? { at: fmt(kd.confirmedAt), dropOffAt: fmt(kd.customerDropOffAt), mileage: kd.customerMileage } : null,
  };
}

/** Kundenfoto zur kontaktlosen Rückgabe. Bild wird neu kodiert (Metadaten weg), privat unter dem Mandanten abgelegt. */
export async function uploadKeyDropPhoto(rawToken: string, category: string, bytes: Uint8Array, storage: StorageDriver = getStorage()) {
  const r = await resolveKeyDropToken(rawToken);
  if (!r) throw new DomainError("Dieser Rückgabelink ist nicht mehr gültig.");
  const { kd } = r;
  if (kd.status !== "AUTHORIZED" || kd.confirmedAt) throw new DomainError("Die Rückgabe ist bereits gemeldet. Fotos können nicht mehr ergänzt werden.");
  if (!KEY_DROP_PHOTO_CATEGORIES.includes(category as PhotoCategory)) throw new DomainError("Unbekannte Fotoart.");
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw new DomainError("Das Foto ist leer oder zu groß.");
  if (!sniffImageType(bytes)) throw new DomainError("Bitte ein Foto (JPEG, PNG oder WebP) hochladen.");
  const count = await db.photo.count({ where: { tenantId: kd.tenantId, keyDropId: kd.id } });
  if (count >= MAX_CUSTOMER_PHOTOS) throw new DomainError(`Es können höchstens ${MAX_CUSTOMER_PHOTOS} Fotos hochgeladen werden.`);
  let body: Buffer;
  let meta: { width: number; height: number };
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(bytes, { limitInputPixels: 60_000_000 }).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    body = out.data;
    meta = { width: out.info.width, height: out.info.height };
  } catch {
    throw new DomainError("Das Foto konnte nicht gelesen werden. Bitte ein anderes Foto wählen.");
  }
  const contentType: (typeof ALLOWED_PHOTO_TYPES)[number] = "image/jpeg";
  const storageKey = buildStorageKey({ tenantId: kd.tenantId, area: "photos", bookingId: kd.bookingId, contentType });
  await storage.put(storageKey, body, contentType);
  try {
    return await db.photo.create({ data: { tenantId: kd.tenantId, keyDropId: kd.id, storageKey, category, contentType, sizeBytes: body.length, checksum: sha256(body), width: meta.width, height: meta.height, takenAt: new Date() }, select: { id: true, category: true } });
  } catch (e) {
    await storage.remove(storageKey).catch(() => {});
    throw e;
  }
}

export async function deleteKeyDropPhoto(rawToken: string, photoId: string, storage: StorageDriver = getStorage()) {
  const r = await resolveKeyDropToken(rawToken);
  if (!r) throw new DomainError("Dieser Rückgabelink ist nicht mehr gültig.");
  const photo = await db.photo.findFirst({ where: { id: photoId, tenantId: r.kd.tenantId, keyDropId: r.kd.id } });
  if (!photo) throw new DomainError("Foto nicht gefunden.");
  await db.photo.delete({ where: { id: photo.id } }); // Trigger sperrt nach der Bestätigung
  await storage.remove(photo.storageKey).catch(() => {});
}

/** Liest ein Kundenfoto über den Link – nur Fotos genau dieser Rückgabe. */
export async function readKeyDropPhoto(rawToken: string, photoId: string, storage: StorageDriver = getStorage()) {
  const r = await resolveKeyDropToken(rawToken);
  if (!r) return null;
  const photo = await db.photo.findFirst({ where: { id: photoId, tenantId: r.kd.tenantId, keyDropId: r.kd.id } });
  if (!photo) return null;
  assertKeyBelongsToTenant(photo.storageKey, r.kd.tenantId);
  const obj = await storage.get(photo.storageKey);
  return obj && sha256(obj.body) === photo.checksum ? { body: obj.body, contentType: photo.contentType } : null;
}

export type ConfirmInput = {
  dropOffAt: Date | null;
  mileage: number | null;
  fuelEighths: number | null;
  batteryPercent: number | null;
  locationConfirmed: boolean;
  locationNote: string | null;
  newDamages: boolean | null;
  damageNote: string | null;
  remark: string | null;
  signerName: string;
  signatureDataUrl: string;
  accepted: boolean;
};

const PNG_PREFIX = "data:image/png;base64,";

/**
 * Kundenmeldung der tatsächlichen Abgabe. Einmalig: danach unveränderlich (Code und Trigger). Beendet die Rückgabe
 * NICHT – Buchung, Fahrzeug, Kaution, Rechnung und Zusatzkosten bleiben unberührt, bis ein Mitarbeiter kontrolliert.
 */
export async function confirmKeyDrop(rawToken: string, input: ConfirmInput, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  const r = await resolveKeyDropToken(rawToken);
  if (!r) throw new DomainError("Dieser Rückgabelink ist nicht mehr gültig. Bitte wenden Sie sich an den Vermieter.");
  if (!input.accepted) throw new DomainError("Bitte die Bestätigung ankreuzen.");
  const signer = clean(input.signerName, 120);
  if (!signer || signer.length < 2) throw new DomainError("Bitte Ihren Namen angeben.");
  if (!input.signatureDataUrl.startsWith(PNG_PREFIX)) throw new DomainError("Bitte im Feld unterschreiben.");
  const image = Buffer.from(input.signatureDataUrl.slice(PNG_PREFIX.length), "base64");
  const isPng = image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
  if (!isPng || image.length > 400_000 || image.length < 800) throw new DomainError("Die Unterschrift ist leer oder ungültig. Bitte erneut unterschreiben.");
  if (!input.dropOffAt || Number.isNaN(input.dropOffAt.getTime())) throw new DomainError("Bitte den Zeitpunkt der Abgabe angeben.");
  if (input.dropOffAt.getTime() > Date.now() + 10 * 60_000) throw new DomainError("Der Abgabezeitpunkt liegt in der Zukunft. Bitte den Link erst bei der tatsächlichen Rückgabe bestätigen.");
  if (input.mileage == null || !Number.isInteger(input.mileage) || input.mileage < 0 || input.mileage > 5_000_000) throw new DomainError("Bitte den Kilometerstand als ganze Zahl angeben.");
  if (input.fuelEighths != null && (!Number.isInteger(input.fuelEighths) || input.fuelEighths < 0 || input.fuelEighths > 8)) throw new DomainError("Der Tankstand liegt zwischen 0 und 8 Achteln.");
  if (input.batteryPercent != null && (!Number.isInteger(input.batteryPercent) || input.batteryPercent < 0 || input.batteryPercent > 100)) throw new DomainError("Der Batteriestand liegt zwischen 0 und 100 Prozent.");
  if (input.newDamages == null) throw new DomainError("Bitte angeben, ob neue Schäden bekannt sind.");
  if (input.newDamages && !clean(input.damageNote, 1000)) throw new DomainError("Bitte die neuen Schäden kurz beschreiben.");
  if (!input.locationConfirmed && !clean(input.locationNote, 300)) throw new DomainError("Bitte angeben, wo das Fahrzeug abgestellt wurde.");

  const { kd } = r;
  const confirmed = await db.$transaction(async (tx) => {
    const cur = await lockKeyDrop(tx, kd.tenantId, kd.id);
    if (cur.status !== "AUTHORIZED" || cur.confirmedAt) throw new DomainError("Diese Rückgabe wurde bereits gemeldet.");
    if (await tx.handover.count({ where: { tenantId: kd.tenantId, keyDropId: kd.id } })) throw new DomainError("Die Rückgabe wird bereits vom Vermieter kontrolliert. Eine Meldung ist nicht mehr möglich.");
    const booking = await tx.booking.findFirstOrThrow({ where: { id: kd.bookingId, tenantId: kd.tenantId }, select: { status: true, actualPickupAt: true, vehicle: { select: { fuel: true } }, contract: { select: { vehicleSnapshot: true } } } });
    if (booking.status !== "ACTIVE") throw new DomainError("Diese Miete ist bereits abgeschlossen.");
    if (booking.actualPickupAt && input.dropOffAt!.getTime() < booking.actualPickupAt.getTime()) throw new DomainError("Der Abgabezeitpunkt liegt vor dem Mietbeginn.");
    const pickup = await tx.handover.findFirst({ where: { tenantId: kd.tenantId, bookingId: kd.bookingId, type: "PICKUP", status: "FINALIZED" }, orderBy: { finalizedAt: "desc" }, select: { mileage: true } });
    if (pickup?.mileage != null && input.mileage! < pickup.mileage) throw new DomainError(`Der Kilometerstand liegt unter dem Stand bei der Übergabe (${pickup.mileage.toLocaleString("de-DE")} km). Bitte prüfen.`);
    const fuel = ((booking.contract?.vehicleSnapshot ?? {}) as { fuel?: string }).fuel ?? booking.vehicle.fuel;
    const energy = energyRequirements(fuel);
    if (energy.fuel && input.fuelEighths == null) throw new DomainError("Bitte den Tankstand angeben.");
    if (energy.battery && input.batteryPercent == null) throw new DomainError("Bitte den Batteriestand angeben.");

    const photos = await tx.photo.findMany({ where: { tenantId: kd.tenantId, keyDropId: kd.id }, orderBy: { uploadedAt: "asc" }, select: { category: true, checksum: true } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: kd.tenantId }, select: { logoStorageKey: true, logoChecksum: true } });
    const values = {
      customerDropOffAt: input.dropOffAt!, customerMileage: input.mileage, customerFuelEighths: energy.fuel ? input.fuelEighths : null, customerBatteryPercent: energy.battery ? input.batteryPercent : null,
      customerLocationConfirmed: input.locationConfirmed, customerLocationNote: clean(input.locationNote, 300), customerNewDamages: input.newDamages,
      customerDamageNote: input.newDamages ? clean(input.damageNote, 1000) : null, customerRemark: clean(input.remark, 1000), customerSignerName: signer,
    };
    const confirmationText = `${KEY_DROP_CONFIRMATION_TEXT} ${KEY_DROP_NOT_INSPECTION_TEXT}`;
    const hash = contentHash({ keyDropId: kd.id, bookingId: kd.bookingId, location: kd.location, ...values, customerDropOffAt: values.customerDropOffAt.toISOString(), confirmationText, signature: sha256(image), photos });
    // Unterschrift zuerst (Trigger lässt nach der Bestätigung keine Änderung mehr zu), dann die Angaben versiegeln
    await tx.signature.create({ data: { tenantId: kd.tenantId, keyDropId: kd.id, role: "RENTER", signerName: signer, storageKey: buildStorageKey({ tenantId: kd.tenantId, area: "signatures", bookingId: kd.bookingId, contentType: "image/png" }), imageData: image, imageChecksum: sha256(image), contentHash: hash, ipAddress: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null } });
    const now = new Date();
    const updated = await tx.keyDropReturn.update({ where: { id: kd.id }, data: { ...values, confirmationText, confirmationHash: hash, confirmedAt: now, status: "CUSTOMER_CONFIRMED", logoRef: (logoRefOf(tenant) ?? undefined) as Prisma.InputJsonValue | undefined } });
    await recordAudit(tx, kd.tenantId, null, { action: "KEY_DROP_CUSTOMER_CONFIRMED", bookingId: kd.bookingId, details: { keyDropId: kd.id, dropOffAt: values.customerDropOffAt.toISOString(), photos: photos.length } });
    return updated;
  }, TX);
  return confirmed;
}

// ---------------------------------------------------------------------------
// Eingangsbestätigung an den Kunden (automatisch nach der Meldung) – keine Zustandsbestätigung
// ---------------------------------------------------------------------------

export function composeKeyDropConfirmationMail(f: { renterName: string; landlordName: string; vehicleTitle: string; plate: string; dropOffAt: string; mileage: number | null; fuel: string | null; battery: string | null }) {
  const subject = "Bestätigung Ihrer kontaktlosen Fahrzeugrückgabe";
  const rows: [string, string][] = [["Fahrzeug", f.vehicleTitle], ["Kennzeichen", f.plate], ["Abgabe laut Ihrer Angabe", f.dropOffAt], ["Kilometerstand laut Ihrer Angabe", f.mileage != null ? `${f.mileage.toLocaleString("de-DE")} km` : "–"], ...(f.fuel ? [["Tankstand laut Ihrer Angabe", f.fuel] as [string, string]] : []), ...(f.battery ? [["Batteriestand laut Ihrer Angabe", f.battery] as [string, string]] : [])];
  const note = `Die Fahrzeugkontrolle durch ${f.landlordName} steht noch aus. Diese E-Mail bestätigt nur den Eingang Ihrer Rückgabemeldung.`;
  const text = [`Hallo ${f.renterName},`, "", "wir haben Ihre Rückgabemeldung erhalten.", "", ...rows.map(([k, v]) => `${k}: ${v}`), "", note, "", "Freundliche Grüße", f.landlordName].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a2230"><p>Hallo ${esc(f.renterName)},</p><p>wir haben Ihre Rückgabemeldung erhalten.</p><table style="border-collapse:collapse;font-size:15px" cellpadding="0" cellspacing="0">${rows.map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0;color:#4a5568">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table><p><b>${esc(note)}</b></p><p>Freundliche Grüße<br>${esc(f.landlordName)}</p></div>`;
  return { subject, text, html };
}

/** Nach der Kundenmeldung: Bestätigungs-PDF archivieren und Eingangsbestätigung senden. Wirft nie (Meldung bleibt gültig). */
export async function runKeyDropConfirmationFollowUp(tenantId: string, keyDropId: string, opts: { transport?: MailTransport; storage?: StorageDriver } = {}) {
  const { ensureKeyDropConfirmationDocument } = await import("@/lib/documents");
  let doc: Awaited<ReturnType<typeof ensureKeyDropConfirmationDocument>>["document"] | null = null;
  try {
    doc = (await ensureKeyDropConfirmationDocument(tenantId, keyDropId, null, { storage: opts.storage })).document;
  } catch (e) {
    console.error("Bestätigungs-PDF kontaktlose Rückgabe fehlgeschlagen:", (e as Error).name);
  }
  const kd = await db.keyDropReturn.findFirst({ where: { id: keyDropId, tenantId }, include: { booking: { include: { vehicle: true, contract: { select: { vehicleSnapshot: true } } } }, tenant: { select: { name: true } } } });
  if (!kd || !kd.confirmedAt || !isValidEmail(kd.recipientEmail)) return;
  const v = (kd.booking.contract?.vehicleSnapshot ?? {}) as { make?: string; model?: string; plate?: string };
  const mail = composeKeyDropConfirmationMail({ renterName: kd.recipientName, landlordName: kd.tenant.name, vehicleTitle: `${v.make ?? kd.booking.vehicle.make} ${v.model ?? kd.booking.vehicle.model}`.trim(), plate: v.plate ?? kd.booking.vehicle.plate, dropOffAt: fmt(kd.customerDropOffAt), mileage: kd.customerMileage, fuel: kd.customerFuelEighths != null ? `${kd.customerFuelEighths}/8` : null, battery: kd.customerBatteryPercent != null ? `${kd.customerBatteryPercent} %` : null });
  const { log, created } = await claimEmail({ tenantId, bookingId: kd.bookingId, recipient: kd.recipientEmail!, subject: mail.subject, template: KEY_DROP_CONFIRMATION_TEMPLATE, attachments: doc ? [{ documentId: doc.id, fileName: doc.fileName, checksum: doc.checksum, version: doc.version, type: doc.type }] : [], trigger: "AUTO", idempotencyKey: `${KEY_DROP_CONFIRMATION_TEMPLATE}:${kd.id}` });
  if (!created) return;
  try {
    const { readDocumentFile } = await import("@/lib/documents");
    const file = doc ? await readDocumentFile(tenantId, doc.id, opts.storage) : null;
    const res = await sendBusinessMail(tenantId, { to: kd.recipientEmail!, subject: mail.subject, text: mail.text, html: mail.html, fromName: kd.tenant.name, replyTo: null, attachments: file && doc ? [{ filename: doc.fileName, content: file.body, contentType: "application/pdf" }] : [] }, { transport: opts.transport, storage: opts.storage });
    await markEmailSent(tenantId, log.id, res.messageId, res.meta);
    await db.$transaction((tx) => recordAudit(tx, tenantId, null, { action: "KEY_DROP_CONFIRMATION_SENT", bookingId: kd.bookingId, details: { keyDropId: kd.id, emailLogId: log.id, channel: res.meta.channel } }));
  } catch (e) {
    await markEmailFailed(tenantId, log.id, safeMailError(e), deliveryMetaOf(e));
  }
}

// ---------------------------------------------------------------------------
// Anzeige für Mitarbeiter
// ---------------------------------------------------------------------------

export async function keyDropForBooking(tenantId: string, bookingId: string) {
  const kd = await db.keyDropReturn.findFirst({ where: { tenantId, bookingId, status: { not: "CANCELLED" } }, include: { accesses: { orderBy: { createdAt: "desc" } }, photos: { orderBy: { uploadedAt: "asc" }, select: { id: true, category: true } }, signatures: { select: { id: true, signerName: true, signedAt: true } }, inspection: { select: { id: true, number: true, status: true } } } });
  const mails = await db.emailLog.findMany({ where: { tenantId, bookingId, template: { in: [KEY_DROP_LINK_TEMPLATE, KEY_DROP_CONFIRMATION_TEMPLATE] } }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, template: true, status: true, recipient: true, createdAt: true, sentAt: true, error: true, channel: true, createdById: true } });
  return { keyDrop: kd, mails };
}

/** Folgebuchung desselben Fahrzeugs, die bald beginnt (Warnung, keine automatische Änderung). */
export async function nextBookingOfVehicle(tenantId: string, vehicleId: string, afterBookingId: string, withinHours = 72) {
  return db.booking.findFirst({ where: { tenantId, vehicleId, id: { not: afterBookingId }, status: "RESERVED", startAt: { lt: new Date(Date.now() + withinHours * 3600_000) } }, orderBy: { startAt: "asc" }, select: { id: true, number: true, startAt: true } });
}

export type KeyDropToInspect = { id: string; bookingId: string; bookingNumber: string; customer: string; vehicle: string; plate: string; dropOffAt: Date | null; plannedEnd: Date; confirmedAt: Date | null; nextBooking: { number: string; startAt: Date } | null; inspectionStarted: boolean };

/** Dashboard „Schlüsselbox-Rückgaben zu prüfen“: gemeldet, Kontrolle ausstehend. */
export async function keyDropsToInspect(tenantId: string): Promise<KeyDropToInspect[]> {
  const rows = await db.keyDropReturn.findMany({ where: { tenantId, status: "CUSTOMER_CONFIRMED" }, orderBy: { confirmedAt: "asc" }, take: 50, include: { booking: { select: { id: true, number: true, endAt: true, vehicleId: true, vehicle: { select: { make: true, model: true, plate: true } } } }, inspection: { select: { id: true } } } });
  const out: KeyDropToInspect[] = [];
  for (const r of rows) {
    const next = await nextBookingOfVehicle(tenantId, r.booking.vehicleId, r.booking.id);
    out.push({ id: r.id, bookingId: r.booking.id, bookingNumber: r.booking.number, customer: r.recipientName, vehicle: `${r.booking.vehicle.make} ${r.booking.vehicle.model}`, plate: r.booking.vehicle.plate, dropOffAt: r.customerDropOffAt, plannedEnd: r.booking.endAt, confirmedAt: r.confirmedAt, nextBooking: next ? { number: next.number, startAt: next.startAt } : null, inspectionStarted: Boolean(r.inspection) });
  }
  return out;
}

export function keyDropStatusLabel(status: string): string {
  return ({ AUTHORIZED: "Vereinbart", CUSTOMER_CONFIRMED: "Kontaktlos zurückgegeben – Kontrolle ausstehend", INSPECTED: "Kontrolle abgeschlossen", CANCELLED: "Aufgehoben" } as Record<KeyDropStatus, string>)[status as KeyDropStatus] ?? status;
}
