// Kaution: Sicherheitsleistung, fachlich getrennt von Rechnung und Zahlung. Der vereinbarte Betrag kommt aus dem
// abgeschlossenen Mietvertrag. Erhalten, freigegeben und einbehalten ergeben sich nur aus bestätigten Bewegungen.
// Harte Regel dieser Phase: keine automatische Verrechnung mit Rechnungen, Zusatzkosten oder Schäden. Ein Einbehalt ist
// ein dokumentierter Kautionsstatus, keine Forderung, keine Einnahme und keine Haftungsfeststellung.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, type Actor } from "@/lib/audit";
import { PAYMENT_METHODS, type DepositStatus, type PaymentMethod } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { fmtCents, toCents, type Cents } from "@/lib/money";
import { isUniqueViolation } from "@/lib/numbering";

type Tx = Prisma.TransactionClient;
const TX = { timeout: 20_000, maxWait: 10_000 };
export type DepositRow = Prisma.SecurityDepositGetPayload<object>;
export type DepositEventRow = Prisma.SecurityDepositEventGetPayload<object>;

export type DepositBalance = { expectedCents: Cents; receivedCents: Cents; releasedCents: Cents; retainedCents: Cents; remainingCents: Cents; status: DepositStatus };

/** Status aus den Summen. Nach einer Entscheidung (Freigabe/Einbehalt) ist immer die ganze erhaltene Kaution zugeordnet. */
export function deriveDepositStatus(receivedCents: Cents, releasedCents: Cents, retainedCents: Cents): DepositStatus {
  if (receivedCents <= 0) return "EXPECTED";
  const settled = releasedCents + retainedCents;
  if (settled <= 0) return "RECEIVED";
  if (settled < receivedCents) return "PARTIALLY_RELEASED";
  if (retainedCents === 0) return "RELEASED";
  if (releasedCents === 0) return "RETAINED";
  return "PARTIALLY_RELEASED";
}

export function balanceOf(expectedCents: Cents, events: { type: string; amountCents: number; status: string }[]): DepositBalance {
  let receivedCents = 0, releasedCents = 0, retainedCents = 0;
  for (const e of events) {
    if (e.status !== "CONFIRMED") continue;
    if (e.type === "RECEIVED") receivedCents += e.amountCents;
    else if (e.type === "RELEASED") releasedCents += e.amountCents;
    else if (e.type === "RETAINED") retainedCents += e.amountCents;
  }
  return { expectedCents, receivedCents, releasedCents, retainedCents, remainingCents: receivedCents - releasedCents - retainedCents, status: deriveDepositStatus(receivedCents, releasedCents, retainedCents) };
}

export type DepositView = DepositBalance & {
  deposit: DepositRow | null;
  events: DepositEventRow[];
  contractNumber: string | null;
  /** Vertrag abgeschlossen, also gibt es eine vereinbarte Kaution */
  contractSigned: boolean;
  bookingStatus: string;
};

/** Stand der Kaution einer Buchung. Ohne gespeicherte Kaution gilt der Vertragswert als vereinbart und nichts als erhalten. */
export async function depositView(tenantId: string, bookingId: string): Promise<DepositView> {
  const booking = await db.booking.findFirst({ where: { id: bookingId, tenantId }, select: { status: true, contract: { select: { number: true, status: true, deposit: true } }, securityDeposit: { include: { events: { orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }] } } } } });
  if (!booking) throw new DomainError("Buchung nicht gefunden.");
  const signed = booking.contract?.status === "SIGNED";
  const deposit = booking.securityDeposit;
  const expected = deposit ? deposit.expectedAmountCents : signed ? toCents(booking.contract!.deposit) : 0;
  const events = deposit?.events ?? [];
  return { ...balanceOf(expected, events), deposit, events, contractNumber: booking.contract?.number ?? null, contractSigned: signed, bookingStatus: booking.status };
}

/** Legt die Kaution aus dem abgeschlossenen Vertrag an oder gibt die vorhandene zurück (innerhalb einer Transaktion, gesperrt). */
async function lockOrCreateDeposit(tx: Tx, tenantId: string, bookingId: string, actor: Actor) {
  const bookingLock = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status" FROM "Booking" WHERE "id" = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (bookingLock.length === 0) throw new DomainError("Buchung nicht gefunden.");
  let row = await tx.securityDeposit.findFirst({ where: { tenantId, bookingId } });
  if (!row) {
    const contract = await tx.rentalContract.findFirst({ where: { tenantId, bookingId }, select: { id: true, status: true, deposit: true } });
    if (!contract || contract.status !== "SIGNED") throw new DomainError("Die Kaution ergibt sich aus dem abgeschlossenen Mietvertrag. Bitte zuerst den Vertrag abschließen.");
    row = await tx.securityDeposit.create({ data: { tenantId, bookingId, contractId: contract.id, expectedAmountCents: toCents(contract.deposit), createdById: actor.id } });
  }
  await tx.$queryRaw`SELECT "id" FROM "SecurityDeposit" WHERE "id" = ${row.id} FOR UPDATE`;
  const events = await tx.securityDepositEvent.findMany({ where: { tenantId, depositId: row.id } });
  return { row, balance: balanceOf(row.expectedAmountCents, events), bookingStatus: bookingLock[0].status };
}

async function syncStatus(tx: Tx, tenantId: string, depositId: string) {
  const row = await tx.securityDeposit.findFirstOrThrow({ where: { id: depositId, tenantId } });
  const events = await tx.securityDepositEvent.findMany({ where: { tenantId, depositId } });
  const b = balanceOf(row.expectedAmountCents, events);
  if (b.status !== row.status) await tx.securityDeposit.update({ where: { id: depositId }, data: { status: b.status } });
  return b;
}

function parseAmount(v: string | number, what = "Der Betrag"): Cents {
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

function checkKey(key: string | null | undefined) {
  const k = key?.trim() || null;
  if (k && !/^[A-Za-z0-9-]{8,64}$/.test(k)) throw new DomainError("Die Seite ist veraltet. Bitte neu laden.");
  return k;
}

function checkDate(d: Date, what: string) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new DomainError(`Bitte ${what} angeben.`);
  if (d.getTime() > Date.now() + 5 * 60_000) throw new DomainError(`${what} darf nicht in der Zukunft liegen.`);
}

const byKey = (tenantId: string, key: string) => db.securityDepositEvent.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });

/** Fehler des Datenbank-Triggers in eine Fachmeldung übersetzen. */
function domainFromDb(e: unknown): never {
  const msg = String((e as { message?: string })?.message ?? "");
  const m = /RB_DOMAIN: ([^\n"]+)/.exec(msg);
  if (m) throw new DomainError(`${m[1].trim()}.`);
  throw e;
}

export type ReceiveInput = { bookingId: string; amount: string | number; method: string; occurredAt: Date; reference?: string | null; note?: string | null; idempotencyKey?: string | null };

/** „Kaution als erhalten erfassen“: nur Dokumentation, keine Abbuchung. Erhalten darf die vereinbarte Kaution nicht übersteigen. */
export async function recordDepositReceived(tenantId: string, actor: Actor, input: ReceiveInput): Promise<{ event: DepositEventRow; created: boolean }> {
  const amountCents = parseAmount(input.amount);
  if (amountCents <= 0) throw new DomainError("Der Betrag muss größer als 0,00 € sein.");
  const method = checkMethod(input.method);
  checkDate(input.occurredAt, "den Zeitpunkt");
  const key = checkKey(input.idempotencyKey);
  if (key) {
    const existing = await byKey(tenantId, key);
    if (existing) return { event: existing, created: false };
  }
  try {
    const outcome = await db.$transaction(async (tx) => {
      const { row, balance } = await lockOrCreateDeposit(tx, tenantId, input.bookingId, actor);
      // unter der Sperre erneut prüfen: ein paralleler Klick mit demselben Schlüssel war vielleicht schneller
      if (key) {
        const dup = await tx.securityDepositEvent.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
        if (dup) return { event: dup, created: false };
      }
      if (balance.receivedCents + amountCents > balance.expectedCents) throw new DomainError(`Vereinbart sind ${fmtCents(balance.expectedCents)}, erhalten bereits ${fmtCents(balance.receivedCents)}. Mehr als die vereinbarte Kaution kann nicht als erhalten dokumentiert werden.`);
      const event = await tx.securityDepositEvent.create({ data: { tenantId, depositId: row.id, type: "RECEIVED", amountCents, method, occurredAt: input.occurredAt, reference: input.reference?.trim() || null, note: input.note?.trim() || null, idempotencyKey: key, createdById: actor.id, createdByName: actor.name } });
      await syncStatus(tx, tenantId, row.id);
      await recordAudit(tx, tenantId, actor, { action: "DEPOSIT_RECEIVED", bookingId: input.bookingId, depositId: row.id, amountCents, details: { method, expected: balance.expectedCents, receivedBefore: balance.receivedCents } });
      return { event, created: true };
    }, TX);
    return outcome;
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
      const method = plan.releaseCents > 0 ? checkMethod(input.method) : null;
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
export async function openDepositCounts(tenantId: string) {
  const [candidates, expectedActive] = await Promise.all([
    db.securityDeposit.findMany({ where: { tenantId, status: { in: ["RECEIVED", "PARTIALLY_RELEASED"] }, booking: { status: { in: ["RETURNED", "CANCELLED"] } } }, include: { events: { select: { type: true, amountCents: true, status: true } } } }),
    db.booking.count({ where: { tenantId, status: "ACTIVE", contract: { status: "SIGNED", deposit: { gt: 0 } }, OR: [{ securityDeposit: null }, { securityDeposit: { status: "EXPECTED" } }] } }),
  ]);
  const held = candidates.filter((d) => balanceOf(d.expectedAmountCents, d.events).remainingCents > 0).length;
  return { held, expectedActive };
}
