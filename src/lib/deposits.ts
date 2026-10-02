// Kaution: Sicherheitsleistung, fachlich getrennt von Rechnung und Zahlung. Der vereinbarte Betrag kommt aus dem
// abgeschlossenen Mietvertrag. Erhalten, freigegeben und einbehalten ergeben sich nur aus bestätigten Bewegungen.
// Harte Regel dieser Phase: keine automatische Verrechnung mit Rechnungen, Zusatzkosten oder Schäden. Ein Einbehalt ist
// ein dokumentierter Kautionsstatus, keine Forderung, keine Einnahme und keine Haftungsfeststellung.
// Befehl 20.7: Eine Verrechnung mit einer konkreten Forderung gibt es nur als bewusste, bestätigte Aktion des Mitarbeiters
// (deposit-offset.ts). Sie erscheint hier als Bewegung OFFSET und verbraucht Kaution wie ein Einbehalt – bleibt aber
// fachlich davon getrennt (Einbehalt = ungeklärt zurückgehalten, Verrechnung = gegen eine Rechnung verwendet).
// Sperr-Reihenfolge aller Geldaktionen (gegen Verklemmung): Booking → SecurityDeposit → Invoice → Payment/Payout.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { SIGNED_AMENDMENTS_SELECT, effectiveDepositCents, loadEffectiveDepositCents } from "@/lib/amendments";
import { recordAudit, type Actor } from "@/lib/audit";
import { PAYMENT_METHODS, type DepositStatus, type PaymentMethod } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation } from "@/lib/numbering";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type DepositRow = Prisma.SecurityDepositGetPayload<object>;
export type DepositEventRow = Prisma.SecurityDepositEventGetPayload<object>;

/**
 * offsetCents (Befehl 20.7): mit Forderungen verrechnete Kaution – verbraucht, nicht mehr verfügbar, kein Einbehalt.
 * Befehl 22: offsetCents ist NETTO (Verrechnungen − Rückführungen aus Kundenguthaben); alle Salden rechnen damit.
 * offsetGrossCents / offsetReturnedCents zeigen die Herkunft: 95 verrechnet, davon 40 zurückgeführt, netto 55.
 */
export type DepositBalance = { expectedCents: Cents; receivedCents: Cents; releasedCents: Cents; retainedCents: Cents; offsetCents: Cents; offsetGrossCents: Cents; offsetReturnedCents: Cents; remainingCents: Cents; status: DepositStatus };

/**
 * Status aus den Summen. Nach einer Entscheidung (Freigabe/Einbehalt/Verrechnung) ist immer die ganze erhaltene Kaution
 * zugeordnet. Verrechnete Kaution zählt für den Status wie einbehalten (kein sechster Status – alle Anzeigen schalten auf
 * die fünf bekannten Werte); die Anzeige unterscheidet über offsetCents.
 */
export function deriveDepositStatus(receivedCents: Cents, releasedCents: Cents, retainedCents: Cents, offsetCents: Cents = 0): DepositStatus {
  if (receivedCents <= 0) return "EXPECTED";
  const kept = retainedCents + offsetCents;
  const settled = releasedCents + kept;
  if (settled <= 0) return "RECEIVED";
  if (settled < receivedCents) return "PARTIALLY_RELEASED";
  if (kept === 0) return "RELEASED";
  if (releasedCents === 0) return "RETAINED";
  return "PARTIALLY_RELEASED";
}

export function balanceOf(expectedCents: Cents, events: { type: string; amountCents: number; status: string }[]): DepositBalance {
  let receivedCents = 0, releasedCents = 0, retainedCents = 0, offsetGrossCents = 0, offsetReturnedCents = 0;
  for (const e of events) {
    if (e.status !== "CONFIRMED") continue;
    if (e.type === "RECEIVED") receivedCents += e.amountCents;
    else if (e.type === "RELEASED") releasedCents += e.amountCents;
    else if (e.type === "RETAINED") retainedCents += e.amountCents;
    else if (e.type === "OFFSET") offsetGrossCents += e.amountCents;
    else if (e.type === "OFFSET_RETURN") offsetReturnedCents += e.amountCents;
  }
  const offsetCents = offsetGrossCents - offsetReturnedCents;
  return { expectedCents, receivedCents, releasedCents, retainedCents, offsetCents, offsetGrossCents, offsetReturnedCents, remainingCents: receivedCents - releasedCents - retainedCents - offsetCents, status: deriveDepositStatus(receivedCents, releasedCents, retainedCents, offsetCents) };
}

/**
 * Phase 18: Kautionsstand mit Auszahlungsdimension. Freigabe (RELEASED) ist die Entscheidung, Auszahlung (Payout COMPLETED) der
 * tatsächliche Geldfluss. Auszahlbar ist höchstens freigegeben und nie mehr als erhalten − einbehalten; abzüglich bereits ausgezahlt.
 * Alte RELEASED-Bewegungen ohne dokumentierte Auszahlung werden nicht umgedeutet („Freigegeben – Auszahlung nicht dokumentiert“).
 */
export type DepositFinancials = DepositBalance & { completedPayoutCents: Cents; payoutRemainingCents: Cents; payoutExcessCents: Cents; releasedWithoutPayoutCents: Cents };

export function computeDepositFinancials(balance: DepositBalance, completedPayoutCents: Cents): DepositFinancials {
  // verrechnete Kaution ist verbraucht: nie auszahlbar (gleiche Formel wie rb_deposit_payout_remaining in der Datenbank)
  const payable = Math.max(0, Math.min(balance.releasedCents, balance.receivedCents - balance.retainedCents - balance.offsetCents));
  return { ...balance, completedPayoutCents, payoutRemainingCents: Math.max(0, payable - completedPayoutCents), payoutExcessCents: Math.max(0, completedPayoutCents - payable), releasedWithoutPayoutCents: Math.max(0, balance.releasedCents - completedPayoutCents) };
}

/** Stand mehrerer Kautionen inkl. Auszahlungen (Listen, Kennzahlen). */
export async function depositFinancialsFor(tenantId: string, deposits: { id: string; expectedAmountCents: number; events: { type: string; amountCents: number; status: string }[] }[], client: Tx | typeof db = db): Promise<Map<string, DepositFinancials>> {
  const ids = deposits.map((d) => d.id);
  const groups = ids.length ? await client.payout.groupBy({ by: ["securityDepositId"], where: { tenantId, securityDepositId: { in: ids }, status: "COMPLETED" }, _sum: { amountCents: true } }) : [];
  const paid = new Map(groups.map((g) => [g.securityDepositId, g._sum.amountCents ?? 0]));
  return new Map(deposits.map((d) => [d.id, computeDepositFinancials(balanceOf(d.expectedAmountCents, d.events), paid.get(d.id) ?? 0)]));
}

/** Zentrale Auszahlungsrechnung einer Kaution (Buchung). Ohne Kautionszeile ist nichts auszahlbar. */
export async function securityDepositFinancials(tenantId: string, bookingId: string, client: Tx | typeof db = db): Promise<DepositFinancials & { depositId: string | null }> {
  const booking = await client.booking.findFirst({ where: { id: bookingId, tenantId }, select: { contract: { select: { status: true, deposit: true, amendments: SIGNED_AMENDMENTS_SELECT } }, securityDeposit: { include: { events: { select: { type: true, amountCents: true, status: true } } } } } });
  if (!booking) throw new DomainError("Buchung nicht gefunden.");
  const dep = booking.securityDeposit;
  // Befehl 25: ohne Kautionszeile gilt die vereinbarte Kaution laut wirksamem Vertragsstand (Vertrag + Nachträge)
  const expected = dep ? dep.expectedAmountCents : booking.contract?.status === "SIGNED" ? effectiveDepositCents(booking.contract.deposit, booking.contract.amendments) : 0;
  if (!dep) return { ...computeDepositFinancials(balanceOf(expected, []), 0), depositId: null };
  const m = await depositFinancialsFor(tenantId, [dep], client);
  return { ...m.get(dep.id)!, depositId: dep.id };
}

export type DepositView = DepositFinancials & {
  deposit: DepositRow | null;
  events: DepositEventRow[];
  contractNumber: string | null;
  /** Vertrag abgeschlossen, also gibt es eine vereinbarte Kaution */
  contractSigned: boolean;
  bookingStatus: string;
  /** Befehl 21: Kautionsbetrag der Buchung – nur als „vereinbart“ anzeigbar, solange es weder Vertrag noch Kautionszeile gibt */
  bookingDepositCents: Cents;
};

/**
 * Befehl 21: Eingangsstand der Kaution für die Anzeige. „Erhalten“ stammt ausschließlich aus dokumentierten, bestätigten
 * Kautionsbewegungen (receivedCents) – nie aus dem vereinbarten Betrag von Buchung oder Vertrag abgeleitet.
 */
export type DepositReceiptState = "NONE_AGREED" | "NOT_RECEIVED" | "PARTIALLY_RECEIVED" | "RECEIVED";
export const DEPOSIT_RECEIPT_LABELS: Record<DepositReceiptState, string> = { NONE_AGREED: "Keine Kaution vereinbart", NOT_RECEIVED: "Noch nicht erhalten", PARTIALLY_RECEIVED: "Teilweise erhalten", RECEIVED: "Erhalten" };
export function depositReceiptState(agreedCents: Cents, receivedCents: Cents): DepositReceiptState {
  if (receivedCents <= 0) return agreedCents > 0 ? "NOT_RECEIVED" : "NONE_AGREED";
  return receivedCents < agreedCents ? "PARTIALLY_RECEIVED" : "RECEIVED";
}

/** Stand der Kaution einer Buchung. Ohne gespeicherte Kaution gilt der Vertragswert als vereinbart und nichts als erhalten. */
export async function depositView(tenantId: string, bookingId: string): Promise<DepositView> {
  const booking = await db.booking.findFirst({ where: { id: bookingId, tenantId }, select: { status: true, deposit: true, contract: { select: { number: true, status: true, deposit: true, amendments: SIGNED_AMENDMENTS_SELECT } }, securityDeposit: { include: { events: { orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }] } } } } });
  if (!booking) throw new DomainError("Buchung nicht gefunden.");
  const signed = booking.contract?.status === "SIGNED";
  const deposit = booking.securityDeposit;
  const expected = deposit ? deposit.expectedAmountCents : signed ? effectiveDepositCents(booking.contract!.deposit, booking.contract!.amendments) : 0;
  const events = deposit?.events ?? [];
  const fin = deposit ? (await depositFinancialsFor(tenantId, [deposit])).get(deposit.id)! : computeDepositFinancials(balanceOf(expected, []), 0);
  return { ...fin, deposit, events, contractNumber: booking.contract?.number ?? null, contractSigned: signed, bookingStatus: booking.status, bookingDepositCents: toCents(booking.deposit) };
}

/**
 * Legt die Kaution an oder gibt die vorhandene zurück (innerhalb einer Transaktion, gesperrt). Vereinbart ist die Kaution des
 * abgeschlossenen Vertrags. Befehl 20.9: Wird die Kaution schon bei der Buchungsanlage als erhalten dokumentiert
 * (fromBooking), gilt der Kautionsbetrag der Buchung als vereinbart; der Vertrag wird später verknüpft (linkDepositToContract)
 * und muss denselben Betrag tragen – die vereinbarte Kaution ist ab der ersten Bewegung fest (Datenbank-Trigger).
 */
export async function lockOrCreateDeposit(tx: Tx, tenantId: string, bookingId: string, actor: Actor, opts: { fromBooking?: boolean } = {}) {
  const bookingLock = await tx.$queryRaw<{ id: string; status: string; deposit: Prisma.Decimal }[]>`SELECT "id", "status", "deposit" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (bookingLock.length === 0) throw new DomainError("Buchung nicht gefunden.");
  let row = await tx.securityDeposit.findFirst({ where: { tenantId, bookingId } });
  if (!row) {
    const contract = await tx.rentalContract.findFirst({ where: { tenantId, bookingId }, select: { id: true, status: true, deposit: true } });
    if (contract && contract.status === "SIGNED") {
      // Befehl 25: vereinbart ist die Kaution laut wirksamem Vertragsstand (ein Nachtrag kann sie geändert haben)
      row = await tx.securityDeposit.create({ data: { tenantId, bookingId, contractId: contract.id, expectedAmountCents: await loadEffectiveDepositCents(tx, tenantId, contract), createdById: actor.id } });
    } else if (opts.fromBooking) {
      const expected = toCents(bookingLock[0].deposit);
      if (expected <= 0) throw new DomainError("Zu dieser Buchung ist keine Kaution vereinbart. Bitte zuerst den Kautionsbetrag der Buchung eintragen.");
      if (bookingLock[0].status === "CANCELLED") throw new DomainError("Die Buchung ist storniert. Es wird keine Kaution mehr dokumentiert.");
      row = await tx.securityDeposit.create({ data: { tenantId, bookingId, contractId: null, expectedAmountCents: expected, createdById: actor.id } });
    } else {
      throw new DomainError("Die Kaution ergibt sich aus dem abgeschlossenen Mietvertrag. Bitte zuerst den Vertrag abschließen.");
    }
  }
  await tx.$queryRaw`SELECT "id" FROM "SecurityDeposit" WHERE "id" = ${row.id} FOR UPDATE`;
  const events = await tx.securityDepositEvent.findMany({ where: { tenantId, depositId: row.id } });
  return { row, balance: balanceOf(row.expectedAmountCents, events), bookingStatus: bookingLock[0].status };
}

/**
 * Befehl 20.9: Kautionsbetrag der Buchung ist fest, sobald eine Kautionszeile existiert (z. B. Eingang bei der Buchungsanlage).
 * Liefert die Fachmeldung, falls `depositCents` davon abweicht – für Vertragskonditionen und Vertragsabschluss.
 */
export async function depositAgreedAmountConflict(tx: Tx, tenantId: string, bookingId: string, depositCents: Cents): Promise<string | null> {
  const row = await tx.securityDeposit.findFirst({ where: { tenantId, bookingId }, select: { expectedAmountCents: true } });
  if (!row || row.expectedAmountCents === depositCents) return null;
  return `Zu dieser Buchung ist bereits eine Kaution über ${fmtCents(row.expectedAmountCents)} dokumentiert (Eingang bei der Buchung). Der vereinbarte Kautionsbetrag ist damit fest; ${fmtCents(depositCents)} können nicht mehr vereinbart werden. Bei Bedarf zuerst die Kautionsbewegung stornieren.`;
}

/** Beim Vertragsabschluss: eine bei der Buchung angelegte Kaution dem Vertrag zuordnen (nur die Zuordnung, der Betrag bleibt). */
export async function linkDepositToContract(tx: Tx, tenantId: string, bookingId: string, contract: { id: string; deposit: Prisma.Decimal | number | string }) {
  const row = await tx.securityDeposit.findFirst({ where: { tenantId, bookingId }, select: { id: true, contractId: true, expectedAmountCents: true } });
  if (!row) return;
  const conflict = await depositAgreedAmountConflict(tx, tenantId, bookingId, toCents(contract.deposit));
  if (conflict) throw new DomainError(conflict);
  if (!row.contractId) await tx.securityDeposit.update({ where: { id: row.id }, data: { contractId: contract.id } });
}

export async function syncStatus(tx: Tx, tenantId: string, depositId: string) {
  const row = await tx.securityDeposit.findFirstOrThrow({ where: { id: depositId, tenantId } });
  const events = await tx.securityDepositEvent.findMany({ where: { tenantId, depositId } });
  const b = balanceOf(row.expectedAmountCents, events);
  if (b.status !== row.status) await tx.securityDeposit.update({ where: { id: depositId }, data: { status: b.status } });
  return b;
}

export function parseAmount(v: string | number, what = "Der Betrag"): Cents {
  let cents: Cents;
  try {
    cents = toCents(v);
  } catch {
    throw new DomainError("Bitte einen gültigen Betrag eingeben (z. B. 500,00).");
  }
  if (cents < 0) throw new DomainError(`${what} darf nicht negativ sein.`);
  if (cents > 100_000_000_00) throw new DomainError(`${what} ist unplausibel hoch.`);
  return cents;
}

function checkMethod(m: string | null | undefined): PaymentMethod {
  if (!m || !(m in PAYMENT_METHODS)) throw new DomainError("Bitte eine Zahlungsart wählen.");
  return m as PaymentMethod;
}

export function checkKey(key: string | null | undefined) {
  const k = key?.trim() || null;
  if (k && !/^[A-Za-z0-9-]{8,64}$/.test(k)) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  return k;
}

export function checkDate(d: Date, what: string) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new DomainError(`Bitte ${what} angeben.`);
  if (d.getTime() > Date.now() + 5 * 60_000) throw new DomainError(`${what} darf nicht in der Zukunft liegen.`);
}

const byKey = (tenantId: string, key: string) => db.securityDepositEvent.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });

/** Fehler des Datenbank-Triggers in eine Fachmeldung übersetzen. */
export function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_DOMAIN: ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}

export type ReceiveInput = { bookingId: string; amount: string | number; method: string; occurredAt: Date; reference?: string | null; note?: string | null; idempotencyKey?: string | null };

/** Eingabe prüfen, ohne Datenbank (auch für das Buchungsformular, bevor eine Buchung existiert). */
export function checkReceiveInput(input: Omit<ReceiveInput, "bookingId">): { amountCents: Cents; method: PaymentMethod; key: string | null } {
  const amountCents = parseAmount(input.amount);
  if (amountCents <= 0) throw new DomainError("Der Betrag muss größer als 0,00 € sein.");
  const method = checkMethod(input.method);
  checkDate(input.occurredAt, "den Zeitpunkt");
  return { amountCents, method, key: checkKey(input.idempotencyKey) };
}

/**
 * Kern: Kautionseingang in einer laufenden Transaktion dokumentieren (auch direkt beim Anlegen der Buchung, Befehl 20.9).
 * Sperrt Buchung und Kaution, lehnt mehr als die vereinbarte Kaution ab; gleicher Schlüssel bucht nie doppelt.
 * Nur Dokumentation, keine Abbuchung, keine Mietzahlung, kein Mietumsatz.
 */
export async function insertDepositReceived(tx: Tx, tenantId: string, actor: Actor, input: ReceiveInput, opts: { fromBooking?: boolean } = {}): Promise<{ event: DepositEventRow; created: boolean }> {
  const { amountCents, method, key } = checkReceiveInput(input);
  const { row, balance } = await lockOrCreateDeposit(tx, tenantId, input.bookingId, actor, opts);
  // unter der Sperre erneut prüfen: ein paralleler Klick mit demselben Schlüssel war vielleicht schneller
  if (key) {
    const dup = await tx.securityDepositEvent.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
    if (dup) return { event: dup, created: false };
  }
  if (balance.receivedCents + amountCents > balance.expectedCents) throw new DomainError(`Vereinbart sind ${fmtCents(balance.expectedCents)}, erhalten bereits ${fmtCents(balance.receivedCents)}. Mehr als die vereinbarte Kaution kann nicht als erhalten dokumentiert werden.`);
  const event = await tx.securityDepositEvent.create({ data: { tenantId, depositId: row.id, type: "RECEIVED", amountCents, method, occurredAt: input.occurredAt, reference: input.reference?.trim() || null, note: input.note?.trim() || null, idempotencyKey: key, createdById: actor.id, createdByName: actor.name } });
  await syncStatus(tx, tenantId, row.id);
  await recordAudit(tx, tenantId, actor, { action: "DEPOSIT_RECEIVED", bookingId: input.bookingId, depositId: row.id, amountCents, details: { method, expected: balance.expectedCents, receivedBefore: balance.receivedCents, ...(row.contractId ? {} : { agreedFrom: "BOOKING" }) } });
  return { event, created: true };
}

/** „Kaution als erhalten erfassen“: nur Dokumentation, keine Abbuchung. Erhalten darf die vereinbarte Kaution nicht übersteigen. */
export async function recordDepositReceived(tenantId: string, actor: Actor, input: ReceiveInput): Promise<{ event: DepositEventRow; created: boolean }> {
  const { key } = checkReceiveInput(input);
  if (key) {
    const existing = await byKey(tenantId, key);
    if (existing) return { event: existing, created: false };
  }
  try {
    return await db.$transaction((tx) => insertDepositReceived(tx, tenantId, actor, input), TX);
  } catch (e) {
    if (key && isUniqueViolation(e, "idempotencyKey")) {
      const winner = await byKey(tenantId, key);
      if (winner) return { event: winner, created: false };
    }
    return domainFromDb(e);
  }
}

export type SettleInput = {
  bookingId: string;
  /** freizugebender Betrag; der Rest der noch nicht zugeordneten Kaution wird einbehalten */
  releaseAmount: string | number;
  method?: string | null; // Rückgabeweg bei Freigabe
  reason?: string | null; // Pflicht, sobald etwas einbehalten wird
  note?: string | null;
  occurredAt: Date;
  idempotencyKey?: string | null;
};

export type SettlePreview = { remainingCents: Cents; releaseCents: Cents; retainCents: Cents; kind: "RELEASE" | "PARTIAL" | "RETAIN"; statusAfter: DepositStatus; error: string | null };

function planSettlement(balance: DepositBalance, releaseAmount: string | number, bookingStatus: string): SettlePreview {
  let error: string | null = null;
  let releaseCents = 0;
  try {
    releaseCents = parseAmount(releaseAmount, "Der Freigabebetrag");
    if (bookingStatus !== "RETURNED" && bookingStatus !== "CANCELLED") throw new DomainError("Die Kaution wird erst nach der Rückgabe (oder bei Storno) freigegeben oder einbehalten.");
    if (balance.remainingCents <= 0) throw new DomainError(balance.receivedCents <= 0 ? "Es wurde noch keine Kaution als erhalten dokumentiert." : "Die erhaltene Kaution ist bereits vollständig freigegeben oder einbehalten.");
    if (releaseCents > balance.remainingCents) throw new DomainError(`Freigabe über die erhaltene Kaution hinaus: noch nicht zugeordnet sind ${fmtCents(balance.remainingCents)}, eingegeben wurden ${fmtCents(releaseCents)}.`);
  } catch (e) {
    error = e instanceof DomainError ? e.message : "Ungültige Eingabe.";
  }
  const retainCents = Math.max(0, balance.remainingCents - releaseCents);
  const kind = releaseCents === 0 ? "RETAIN" : retainCents === 0 ? "RELEASE" : "PARTIAL";
  const statusAfter = deriveDepositStatus(balance.receivedCents, balance.releasedCents + releaseCents, balance.retainedCents + retainCents);
  return { remainingCents: balance.remainingCents, releaseCents, retainCents, kind, statusAfter, error };
}

export async function previewDepositSettlement(tenantId: string, bookingId: string, releaseAmount: string | number): Promise<SettlePreview> {
  const v = await depositView(tenantId, bookingId);
  return planSettlement(v, releaseAmount, v.bookingStatus);
}

/**
 * Freigabe / teilweise Freigabe / Einbehalt der noch nicht zugeordneten Kaution. Immer wird der gesamte offene Rest
 * zugeordnet: Freigabebetrag + Einbehalt = Rest. Einbehalt braucht einen Grund. Nur nach Rückgabe oder Storno.
 */
export async function settleDeposit(tenantId: string, actor: Actor, input: SettleInput): Promise<{ events: DepositEventRow[]; created: boolean; kind: SettlePreview["kind"] }> {
  const key = checkKey(input.idempotencyKey);
  checkDate(input.occurredAt, "den Zeitpunkt");
  if (key) {
    const existing = await byKey(tenantId, key);
    if (existing) {
      const sibling = await byKey(tenantId, `${key}-r`);
      return { events: [existing, ...(sibling ? [sibling] : [])], created: false, kind: sibling ? "PARTIAL" : existing.type === "RELEASED" ? "RELEASE" : "RETAIN" };
    }
  }
  try {
    const result = await db.$transaction(async (tx) => {
      const { row, balance, bookingStatus } = await lockOrCreateDeposit(tx, tenantId, input.bookingId, actor);
      if (key) {
        const dup = await tx.securityDepositEvent.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
        if (dup) {
          const sibling = await tx.securityDepositEvent.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: `${key}-r` } } });
          return { events: [dup, ...(sibling ? [sibling] : [])], created: false, kind: (sibling ? "PARTIAL" : dup.type === "RELEASED" ? "RELEASE" : "RETAIN") as SettlePreview["kind"] };
        }
      }
      const plan = planSettlement(balance, input.releaseAmount, bookingStatus);
      if (plan.error) throw new DomainError(plan.error);
      const reason = input.reason?.trim() || null;
      if (plan.retainCents > 0 && (!reason || reason.length < 3)) throw new DomainError("Bitte den Grund für den einbehaltenen Betrag angeben.");
      const method = plan.releaseCents > 0 && input.method ? checkMethod(input.method) : null;
      const note = input.note?.trim() || null;
      const events: DepositEventRow[] = [];
      if (plan.releaseCents > 0) {
        events.push(await tx.securityDepositEvent.create({ data: { tenantId, depositId: row.id, type: "RELEASED", amountCents: plan.releaseCents, method, note, occurredAt: input.occurredAt, idempotencyKey: key, createdById: actor.id, createdByName: actor.name } }));
      }
      if (plan.retainCents > 0) {
        events.push(await tx.securityDepositEvent.create({ data: { tenantId, depositId: row.id, type: "RETAINED", amountCents: plan.retainCents, reason, note, occurredAt: input.occurredAt, idempotencyKey: key ? (plan.releaseCents > 0 ? `${key}-r` : key) : null, createdById: actor.id, createdByName: actor.name } }));
      }
      const after = await syncStatus(tx, tenantId, row.id);
      const action = plan.kind === "RELEASE" ? "DEPOSIT_RELEASED" : plan.kind === "PARTIAL" ? "DEPOSIT_PARTIALLY_RELEASED" : "DEPOSIT_RETAINED";
      await recordAudit(tx, tenantId, actor, { action, bookingId: input.bookingId, depositId: row.id, amountCents: plan.releaseCents, details: { released: plan.releaseCents, retained: plan.retainCents, reason, method, statusAfter: after.status } });
      return { events, kind: plan.kind, created: true };
    }, TX);
    return result;
  } catch (e) {
    if (key && isUniqueViolation(e, "idempotencyKey")) {
      const winner = await byKey(tenantId, key);
      if (winner) return { events: [winner], created: false, kind: winner.type === "RELEASED" ? "RELEASE" : "RETAIN" };
    }
    return domainFromDb(e);
  }
}

/** Storno einer Kautionsbewegung mit Pflichtgrund. Die Zeile bleibt; Summen und Status werden neu abgeleitet. */
export async function cancelDepositEvent(tenantId: string, actor: Actor, eventId: string, reason: string): Promise<DepositEventRow> {
  const why = reason.trim();
  if (why.length < 3) throw new DomainError("Bitte den Grund der Korrektur angeben.");
  try {
    return await db.$transaction(async (tx) => {
      const ev = await tx.securityDepositEvent.findFirst({ where: { id: eventId, tenantId } });
      if (!ev) throw new DomainError("Kautionsbewegung nicht gefunden.");
      await tx.$queryRaw`SELECT "id" FROM "SecurityDeposit" WHERE "id" = ${ev.depositId} FOR UPDATE`;
      const fresh = await tx.securityDepositEvent.findFirstOrThrow({ where: { id: eventId, tenantId } });
      if (fresh.status !== "CONFIRMED") throw new DomainError("Diese Bewegung ist bereits storniert.");
      // Eine Verrechnung hat zwei Seiten (Rechnung und Kaution); sie wird nur gemeinsam storniert (deposit-offset.ts)
      if (fresh.type === "OFFSET") throw new DomainError("Diese Bewegung ist eine Kautionsverrechnung. Bitte die Verrechnung unter „Zahlungen“ stornieren; damit werden Rechnung und Kaution gemeinsam korrigiert.");
      // Befehl 22: eine Rückführung verbraucht Kundenguthaben der Rechnung und wird nur über ihren eigenen Storno korrigiert
      if (fresh.type === "OFFSET_RETURN") throw new DomainError("Diese Bewegung ist eine Rückführung aus Kundenguthaben. Bitte „Rückführung stornieren“ verwenden; damit werden Kaution und Kundenguthaben gemeinsam korrigiert.");
      if (fresh.type !== "RETAINED") {
        const others = await tx.securityDepositEvent.findMany({ where: { tenantId, depositId: ev.depositId, status: "CONFIRMED", id: { not: eventId } }, select: { type: true, amountCents: true, status: true } });
        const dep0 = await tx.securityDeposit.findFirstOrThrow({ where: { id: ev.depositId, tenantId } });
        const paidOut = (await tx.payout.aggregate({ where: { tenantId, securityDepositId: ev.depositId, status: "COMPLETED" }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
        const after = computeDepositFinancials(balanceOf(dep0.expectedAmountCents, others), paidOut);
        if (after.payoutExcessCents > 0) throw new DomainError(`Von dieser Kaution wurden bereits ${fmtCents(paidOut)} ausgezahlt. Diese Bewegung kann erst storniert werden, wenn die Auszahlung storniert ist.`);
      }
      const now = new Date();
      const updated = await tx.securityDepositEvent.update({ where: { id: eventId }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id, cancelledByName: actor.name, cancellationReason: why } });
      const after = await syncStatus(tx, tenantId, ev.depositId);
      const dep = await tx.securityDeposit.findFirstOrThrow({ where: { id: ev.depositId } });
      await recordAudit(tx, tenantId, actor, { action: "DEPOSIT_CORRECTION", bookingId: dep.bookingId, depositId: dep.id, amountCents: ev.amountCents, details: { eventType: ev.type, reason: why, statusAfter: after.status } });
      return updated;
    }, TX);
  } catch (e) {
    return domainFromDb(e);
  }
}

/** Kennzahl: Kautionen, die erhalten, aber noch nicht vollständig zugeordnet sind, sowie erwartete bei laufenden Mieten. */
/** Offene Kautionen als Zeilen (Dashboard, Kennzahlen): nach Rückgabe noch nicht entschieden; unterwegs ohne Eingang. */
export async function openDepositRows(tenantId: string) {
  const [candidates, expectedActive] = await Promise.all([
    db.securityDeposit.findMany({ where: { tenantId, status: { in: ["RECEIVED", "PARTIALLY_RELEASED"] }, booking: { status: { in: ["RETURNED", "CANCELLED"] } } }, include: { events: { select: { type: true, amountCents: true, status: true } }, booking: { select: { id: true, number: true, actualReturnAt: true, endAt: true, customer: { select: { type: true, firstName: true, lastName: true, companyName: true } } } } } }),
    db.booking.findMany({ where: { tenantId, status: "ACTIVE", contract: { status: "SIGNED", deposit: { gt: 0 } }, OR: [{ securityDeposit: null }, { securityDeposit: { status: "EXPECTED" } }] }, select: { id: true, number: true, startAt: true, endAt: true, contract: { select: { deposit: true } }, customer: { select: { type: true, firstName: true, lastName: true, companyName: true } } }, orderBy: { startAt: "asc" } }),
  ]);
  const held = candidates.map((d) => ({ ...d, balance: balanceOf(d.expectedAmountCents, d.events) })).filter((d) => d.balance.remainingCents > 0);
  return { held, expectedActive };
}

export async function openDepositCounts(tenantId: string) {
  const rows = await openDepositRows(tenantId);
  return { held: rows.held.length, expectedActive: rows.expectedActive.length };
}
