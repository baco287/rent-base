// Buchungsentwurf („Zwischenspeichern“ in der Buchungsanlage): reine Funktionen ohne DOM und ohne Server – der Speicher
// (im Browser localStorage) wird übergeben. Ein Entwurf ist nur eine Gedächtnisstütze im Browser des Mitarbeiters: Er legt
// keine Buchung an, verbucht keine Mietzahlung und keinen Kautionseingang, reserviert kein Fahrzeug und erzeugt weder Rechnung,
// Vertrag noch E-Mail. Erst „Buchung anlegen“ prüft alles serverseitig neu (Tarif, Preis, Verfügbarkeit, Beträge).
//
// Bewusst NICHT gespeichert:
// - Zahlungs- und Kautionskennungen (payNonce/depNonce): Jede Seite behält ihre eigene. Eine wiederverwendete Kennung würde die
//   Zahlung einer neuen Buchung still verschlucken (Duplikatsuche je Mandant und Kennung).
// - Stände der Tarifvorschau (seenRevisionId/seenRegularCents): Sie kommen immer aus der aktuellen Vorschau.
// - Daten eines neuen Kunden (Ausweis, Führerschein, Geburtsdatum, Anschrift …) und Name/Kontakt bestehender Kunden – nur die ID.
// Getrennt je Mandant und Benutzer (eigener Schlüssel, Prüfung beim Lesen), mehrere Entwürfe nebeneinander, nach Ablauf verworfen.

import { PAYMENT_METHODS, RENTAL_PAYMENT_INTENTS, type PaymentMethod, type RentalPaymentIntent } from "@/lib/constants";

export const DRAFT_VERSION = 1;
export const DRAFT_KEY_PREFIX = "rb.buchung.entwurf.";
/** Entwürfe gelten 7 Tage ab dem letzten Speichern. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Höchstens so viele Entwürfe je Mandant und Benutzer; der älteste fällt weg. */
export const DRAFT_MAX_COUNT = 5;
/** Notizen im Entwurf (längere werden nicht still gekürzt, sondern das Zwischenspeichern wird abgelehnt). */
export const DRAFT_NOTES_MAX = 20000;

export type DraftScope = { tenantId: string; userId: string };
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export type DraftTariff = {
  ratePlanId: string;
  /** regulärer Tarifpreis beim Speichern – nur für den Hinweis „Preis seit dem Entwurf geändert“, nie für die Anlage */
  regularCents: number | null;
  price: { on: boolean; text: string; reason: string };
  km: { on: boolean; policy: "FREE_KILOMETERS" | "UNLIMITED"; perDay: string; rate: string; reason: string };
  deposit: { on: boolean; text: string; reason: string };
  /** Befehl 29.5: abweichende Selbstbeteiligung; fehlt bei Entwürfen von vorher */
  deductible?: { on: boolean; text: string; reason: string };
};
export type DraftPayment = {
  intent: RentalPaymentIntent;
  amount: string;
  /** bei „Vollständig bezahlt“: Mietpreis beim Speichern (null = noch nicht berechnet) */
  fullCents: number | null;
  method: PaymentMethod;
  paidAt: string;
  reference: string;
  note: string;
};
export type DraftDeposit = { received: boolean; amount: string | null; method: PaymentMethod; occurredAt: string; reference: string; note: string };
export type BookingDraftData = {
  vehicleId: string;
  startAt: string;
  endAt: string;
  notes: string;
  customerMode: "existing" | "new";
  customerId: string;
  tariff: DraftTariff;
  pay: DraftPayment;
  dep: DraftDeposit;
};
export type BookingDraft = BookingDraftData & { v: typeof DRAFT_VERSION; id: string; tenantId: string; userId: string; savedAt: number; rev: number };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DRAFT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const AMOUNT_RE = /^[0-9.,\s€]{0,20}$/;

/** Kennung eines Entwurfs (auch im Redirect nach der Anlage geprüft). */
export function isDraftId(v: unknown): v is string {
  return typeof v === "string" && DRAFT_ID_RE.test(v);
}

export function draftStorageKey(scope: DraftScope): string {
  return `${DRAFT_KEY_PREFIX}${scope.tenantId}.${scope.userId}`;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const pattern = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : "");
const bool = (v: unknown) => v === true;
const centsOrNull = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const method = (v: unknown): PaymentMethod => (typeof v === "string" && Object.hasOwn(PAYMENT_METHODS, v) ? (v as PaymentMethod) : "CASH");

/** Inhalt eines Entwurfs feldweise prüfen: Unbekanntes fällt weg, Ungültiges wird zum leeren Standardwert. */
export function sanitizeDraftData(raw: unknown): BookingDraftData {
  const r = obj(raw);
  const t = obj(r.tariff);
  const tp = obj(t.price);
  const tk = obj(t.km);
  const td = obj(t.deposit);
  const tdd = t.deductible !== undefined ? obj(t.deductible) : null;
  const p = obj(r.pay);
  const d = obj(r.dep);
  const intent: RentalPaymentIntent = typeof p.intent === "string" && Object.hasOwn(RENTAL_PAYMENT_INTENTS, p.intent) ? (p.intent as RentalPaymentIntent) : "NONE";
  const customerMode = r.customerMode === "new" ? "new" : "existing";
  return {
    vehicleId: pattern(r.vehicleId, ID_RE),
    startAt: pattern(r.startAt, LOCAL_DT_RE),
    endAt: pattern(r.endAt, LOCAL_DT_RE),
    notes: text(r.notes, DRAFT_NOTES_MAX),
    customerMode,
    customerId: customerMode === "existing" ? pattern(r.customerId, ID_RE) : "",
    tariff: {
      ratePlanId: pattern(t.ratePlanId, ID_RE),
      regularCents: centsOrNull(t.regularCents),
      price: { on: bool(tp.on), text: pattern(tp.text, AMOUNT_RE), reason: text(tp.reason, 300) },
      km: { on: bool(tk.on), policy: tk.policy === "UNLIMITED" ? "UNLIMITED" : "FREE_KILOMETERS", perDay: pattern(tk.perDay, AMOUNT_RE), rate: pattern(tk.rate, AMOUNT_RE), reason: text(tk.reason, 300) },
      deposit: { on: bool(td.on), text: pattern(td.text, AMOUNT_RE), reason: text(td.reason, 300) },
      // Befehl 29.5: nur übernehmen, wenn der Entwurf das Feld kennt (ältere Entwürfe bleiben unverändert)
      ...(tdd ? { deductible: { on: bool(tdd.on), text: pattern(tdd.text, AMOUNT_RE), reason: text(tdd.reason, 300) } } : {}),
    },
    pay: {
      intent,
      amount: intent === "NONE" ? "" : pattern(p.amount, AMOUNT_RE),
      fullCents: intent === "FULL" ? centsOrNull(p.fullCents) : null,
      method: method(p.method),
      // Datum nur, wenn eine Zahlung erfasst war – sonst gilt beim Fortsetzen „jetzt“ statt der Ladezeit der alten Seite
      paidAt: intent === "NONE" ? "" : pattern(p.paidAt, LOCAL_DT_RE),
      reference: text(p.reference, 120),
      note: text(p.note, 500),
    },
    dep: {
      received: bool(d.received),
      // Betrag und Datum nur bei „Kaution jetzt erhalten“ – sonst folgt der Betrag beim Fortsetzen der aktuell vereinbarten Kaution
      amount: bool(d.received) && typeof d.amount === "string" && AMOUNT_RE.test(d.amount) ? d.amount : null,
      method: method(d.method),
      occurredAt: bool(d.received) ? pattern(d.occurredAt, LOCAL_DT_RE) : "",
      reference: text(d.reference, 120),
      note: text(d.note, 500),
    },
  };
}

/** Vollständiger Entwurf: nur Version 1, nur für genau diesen Mandanten und Benutzer, nicht abgelaufen. */
export function sanitizeDraft(raw: unknown, scope: DraftScope, now: number): BookingDraft | null {
  const r = obj(raw);
  if (r.v !== DRAFT_VERSION || !isDraftId(r.id)) return null;
  if (r.tenantId !== scope.tenantId || r.userId !== scope.userId) return null;
  const savedAt = r.savedAt;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt) || savedAt > now + 5 * 60 * 1000 || now - savedAt > DRAFT_MAX_AGE_MS) return null;
  const rev = typeof r.rev === "number" && Number.isSafeInteger(r.rev) && r.rev >= 1 ? r.rev : 1;
  return { v: DRAFT_VERSION, id: r.id, tenantId: scope.tenantId, userId: scope.userId, savedAt, rev, ...sanitizeDraftData(r) };
}

/** Liste aus dem gespeicherten Text: geprüft, ohne Doppelte, neueste zuerst. */
export function parseDrafts(raw: string | null | undefined, scope: DraftScope, now: number): BookingDraft[] {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: BookingDraft[] = [];
  for (const item of list) {
    const d = sanitizeDraft(item, scope, now);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out.sort((a, b) => b.savedAt - a.savedAt).slice(0, DRAFT_MAX_COUNT);
}

export function readDraftsRaw(storage: DraftStorage | null, scope: DraftScope): string {
  try {
    return storage?.getItem(draftStorageKey(scope)) ?? "";
  } catch {
    return ""; // privates Fenster / gesperrter Speicher
  }
}

export function readDrafts(storage: DraftStorage | null, scope: DraftScope, now: number): BookingDraft[] {
  return parseDrafts(readDraftsRaw(storage, scope), scope, now);
}

function writeDrafts(storage: DraftStorage, scope: DraftScope, list: BookingDraft[]): boolean {
  try {
    if (list.length === 0) storage.removeItem(draftStorageKey(scope));
    else storage.setItem(draftStorageKey(scope), JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export type SaveDraftResult =
  | { ok: true; draft: BookingDraft; forked: null | "changed" | "missing" }
  | { ok: false };

/**
 * Entwurf speichern. Gleichzeitig geöffnete Entwürfe vermischen sich nie: Jeder Entwurf wird als Ganzes ersetzt. Hat ein anderes
 * Fenster denselben Entwurf inzwischen gespeichert („changed“) oder entfernt – etwa verworfen oder als Buchung angelegt
 * („missing“) –, wird nichts überschrieben und nichts wiederbelebt, sondern ein eigener neuer Entwurf angelegt.
 */
export function saveDraft(
  storage: DraftStorage | null,
  scope: DraftScope,
  input: { id: string | null; knownRev: number; data: BookingDraftData; newId: () => string; now: number },
): SaveDraftResult {
  if (!storage) return { ok: false };
  const list = readDrafts(storage, scope, input.now);
  const existing = input.id ? list.find((d) => d.id === input.id) : undefined;
  const forked = input.id && existing && existing.rev !== input.knownRev ? "changed" : input.id && !existing && input.knownRev > 0 ? "missing" : null;
  const fresh = forked !== null || !input.id;
  const id = fresh ? input.newId() : input.id!;
  if (!isDraftId(id)) return { ok: false };
  const draft: BookingDraft = { v: DRAFT_VERSION, id, tenantId: scope.tenantId, userId: scope.userId, savedAt: input.now, rev: fresh ? 1 : (existing?.rev ?? 0) + 1, ...sanitizeDraftData(input.data) };
  const next = [draft, ...list.filter((d) => d.id !== id)].slice(0, DRAFT_MAX_COUNT);
  return writeDrafts(storage, scope, next) ? { ok: true, draft, forked } : { ok: false };
}

export function removeDraft(storage: DraftStorage | null, scope: DraftScope, id: string, now: number): boolean {
  if (!storage) return false;
  return writeDrafts(storage, scope, readDrafts(storage, scope, now).filter((d) => d.id !== id));
}

/** Nach erfolgreicher Anlage: Entwurf mit dieser Kennung überall im Browser entfernen (Kennungen sind zufällig und eindeutig). */
export function removeDraftEverywhere(storage: DraftStorage | null, id: string): void {
  if (!storage || !isDraftId(id)) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(DRAFT_KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const list: unknown = JSON.parse(storage.getItem(k) ?? "[]");
      if (!Array.isArray(list)) continue;
      const rest = list.filter((x) => obj(x).id !== id);
      if (rest.length === list.length) continue;
      if (rest.length === 0) storage.removeItem(k);
      else storage.setItem(k, JSON.stringify(rest));
    }
  } catch {
    // ohne Speicher gibt es auch keinen Entwurf
  }
}

/** Abgelaufene oder unlesbare Entwürfe in allen Schlüsseln dieses Browsers entfernen (auch anderer Benutzer – nur abgelaufene). */
export function pruneExpiredDrafts(storage: DraftStorage | null, now: number): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(DRAFT_KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      let list: unknown;
      try {
        list = JSON.parse(storage.getItem(k) ?? "null");
      } catch {
        list = null;
      }
      const keep = Array.isArray(list)
        ? list.filter((x) => {
            const s = obj(x).savedAt;
            return typeof s === "number" && Number.isFinite(s) && s <= now + 5 * 60 * 1000 && now - s <= DRAFT_MAX_AGE_MS;
          })
        : [];
      if (keep.length === 0) storage.removeItem(k);
      else if (Array.isArray(list) && keep.length !== list.length) storage.setItem(k, JSON.stringify(keep));
    }
  } catch {
    // ohne Speicher nichts aufzuräumen
  }
}

/**
 * Änderung an den Zahlungseingaben übernehmen. Die Prüfung eines wiederhergestellten „Vollständig bezahlt“ (fullCheck) endet nur,
 * wenn der Mitarbeiter Status oder Betrag bewusst ändert oder die Abweichung schon angezeigt wird (dann gilt die angezeigte
 * Teilzahlung). Zahlungsart, Datum, Referenz oder Notiz heben sie nicht auf – sonst würde ein später berechneter, anderer
 * Mietpreis still als „vollständig bezahlt“ übernommen.
 */
export function patchPayment<T extends { intent: RentalPaymentIntent; amount: string; fullCheck?: number | null }>(pay: T, effective: { intent: RentalPaymentIntent; mismatch: boolean }, patch: Partial<T>): T {
  const decisive = "intent" in patch || "amount" in patch || effective.mismatch;
  return decisive ? { ...pay, intent: effective.intent, fullCheck: undefined, ...patch } : { ...pay, ...patch };
}

/** Vergleichswert für „Ungespeicherte Änderungen“. */
export function draftSnapshot(data: BookingDraftData): string {
  return JSON.stringify(sanitizeDraftData(data));
}

/**
 * Wiederhergestelltes „Vollständig bezahlt“: Der Betrag folgt im Formular dem aktuellen Mietpreis. Weicht dieser vom Mietpreis
 * beim Speichern ab (oder war er da noch nicht berechnet), wird nicht still ein anderer Betrag als bezahlt dokumentiert –
 * die Zahlung erscheint als Teilzahlung über den gespeicherten Betrag, bis der Mitarbeiter den Status bewusst wählt.
 * `fullCheck` undefined = keine Prüfung (Mitarbeiter hat selbst gewählt).
 */
export function effectivePayIntent(intent: RentalPaymentIntent, fullCheck: number | null | undefined, totals: { ready: boolean; totalCents: number }): { intent: RentalPaymentIntent; mismatch: boolean } {
  if (intent !== "FULL" || fullCheck === undefined || !totals.ready) return { intent, mismatch: false };
  if (fullCheck !== null && fullCheck === totals.totalCents) return { intent, mismatch: false };
  return { intent: "PARTIAL", mismatch: true };
}

/**
 * Fortsetzen: gespeicherte Auswahl gegen den aktuellen Stand prüfen. Fahrzeug nur aus der Fahrzeugliste dieses Mandanten (nicht
 * deaktiviert), Kunde nur, wenn der Server ihn für diesen Mandanten geladen hat; sonst leer mit Hinweis. Zeitraum nur in gültigem
 * Format, sonst der Vorschlag der Seite.
 */
export function restoreTargets(
  draft: BookingDraftData,
  vehicles: ReadonlyArray<{ id: string; status: string }>,
  loadedCustomerId: string | null,
  fallback: { startAt: string; endAt: string },
  nowLocal: string,
): { vehicleId: string; startAt: string; endAt: string; customerOk: boolean; notices: string[] } {
  const notices: string[] = [];
  const vehicleOk = !!draft.vehicleId && vehicles.some((v) => v.id === draft.vehicleId && v.status !== "INACTIVE");
  if (draft.vehicleId && !vehicleOk) notices.push("Das Fahrzeug aus dem Entwurf ist nicht mehr verfügbar – bitte ein Fahrzeug wählen.");
  const customerOk = draft.customerMode === "existing" && !!draft.customerId && loadedCustomerId === draft.customerId;
  if (draft.customerMode === "existing" && draft.customerId && !customerOk) notices.push("Der Kunde aus dem Entwurf wurde nicht gefunden – bitte einen Kunden wählen.");
  if (draft.customerMode === "new") notices.push("Die Daten des neuen Kunden werden aus Datenschutzgründen nicht zwischengespeichert – bitte erneut eingeben.");
  const periodOk = !!draft.startAt && !!draft.endAt;
  if (!periodOk) notices.push("Abholung und Rückgabe aus dem Entwurf waren unvollständig – bitte den Zeitraum prüfen.");
  else if (draft.startAt < nowLocal) notices.push(`Die Abholung im Entwurf (${localInputText(draft.startAt)}) liegt in der Vergangenheit – bitte den Zeitraum prüfen.`);
  return { vehicleId: vehicleOk ? draft.vehicleId : "", startAt: periodOk ? draft.startAt : fallback.startAt, endAt: periodOk ? draft.endAt : fallback.endAt, customerOk, notices };
}

/** „2026-10-16T09:00“ → „16.10.2026, 09:00“ */
export function localInputText(v: string): string {
  const m = LOCAL_DT_RE.test(v) ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(v) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}, ${m[4]}` : "–";
}
