"use client";

import { useActionState, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Field, FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { quoteTariffsAction, type FormState } from "./actions";
import { TariffPicker, type TariffTotals } from "./tariff-picker";
import type { TariffChoices } from "@/lib/tariffs";
import { CustomerFields, emptyCustomer } from "../kunden/customer-fields";
import { CustomerPicker } from "./customer-picker";
import { PAYMENT_METHODS, RENTAL_PAYMENT_INTENTS, type PaymentMethod, type RentalPaymentIntent } from "@/lib/constants";
import { fmtCents, toCents } from "@/lib/money";
import { DRAFT_NOTES_MAX, draftSnapshot, effectivePayIntent, patchPayment, removeDraft, saveDraft, type BookingDraft, type BookingDraftData, type DraftScope, type DraftTariff } from "@/lib/booking-draft";
import { browserDraftStorage, newDraftId, notifyDrafts, nowMs, savedAtText } from "./booking-draft-store";
import { parseSurchargeCents } from "@/lib/abroad";
import { AbroadSection, type AbroadState } from "./abroad-section";

/** Nur bei neuer Buchung: erste Mietzahlung direkt mit erfassen. */
export type InitialPaymentConfig = { nonce: string; defaultWhen: string };

/**
 * Nur bei neuer Buchung: „Zwischenspeichern“ als Entwurf im Browser (lib/booking-draft.ts). Ein Entwurf ist keine Buchung,
 * keine Zahlung, kein Kautionseingang und keine Reservierung; `restored` ist der fortgesetzte Entwurf (sonst null).
 */
export type BookingDraftConfig = {
  scope: DraftScope;
  restored: BookingDraft | null;
  onDirtyChange?: (dirty: boolean) => void;
  onDraftIdChange?: (id: string | null) => void;
};

/** Eingaben „Miete“ (fullCheck: wiederhergestelltes „Vollständig bezahlt“ wird gegen den aktuellen Mietpreis geprüft). */
type PayState = { intent: RentalPaymentIntent; amount: string; method: PaymentMethod; paidAt: string; reference: string; note: string; fullCheck?: number | null };
/** Eingaben „Kaution“ (amount null = vereinbarte Kaution übernehmen). */
type DepState = { received: boolean; amount: string | null; method: PaymentMethod; occurredAt: string; reference: string; note: string };

const euro = (c: number) => (c / 100).toFixed(2).replace(".", ",");

function centsOf(input: string): number | null {
  try {
    const c = toCents(input.trim());
    return c > 0 ? c : null;
  } catch {
    return null;
  }
}

/**
 * Bereich „Miete & Kaution“ im Formular (Befehl 20.8/20.9): Miete und Kaution nebeneinander, finanziell getrennt.
 * Gespeichert wird nur die tatsächliche Mietzahlung; „Offen / Teilweise / Vollständig“ ist die Absicht, der Status der
 * Buchung wird danach immer aus den Zahlungen berechnet. Kaution: entweder „Noch nicht erhalten“ (Eingang später auf der
 * Buchungsseite) oder „Kaution jetzt erhalten“ – dann wird der Eingang zusammen mit der Anlage gesendet und serverseitig
 * erst nach dem Anlegen der Buchung über die bestehende Kautionserfassung dokumentiert. Die Kaution ist nie eine Mietzahlung.
 * Die Eingaben liegen in BookingForm (pay/dep), damit „Zwischenspeichern“ sie vollständig erfasst – auch ausgeblendete.
 */
function PaymentSection({ totalCents, depositCents, totalsReady, config, pay, onPay, dep, onDep, footer }: {
  totalCents: number;
  depositCents: number;
  totalsReady: boolean;
  config: InitialPaymentConfig;
  pay: PayState;
  onPay: (p: PayState) => void;
  dep: DepState;
  onDep: (d: DepState) => void;
  footer?: ReactNode;
}) {
  // Wiederhergestelltes „Vollständig bezahlt“ bei geändertem Mietpreis: als Teilzahlung über den gespeicherten Betrag (lib/booking-draft)
  const eff = effectivePayIntent(pay.intent, pay.fullCheck, { ready: totalsReady, totalCents });
  const intent = eff.intent;
  const amount = pay.amount;
  const setPay = (patch: Partial<PayState>) => onPay(patchPayment(pay, eff, patch));
  const setDep = (patch: Partial<DepState>) => onDep({ ...dep, ...patch });
  const depositNow = dep.received;
  const depositDefault = euro(depositCents);
  const depositEntered = dep.amount ?? depositDefault;
  const depositEnteredCents = centsOf(depositEntered) ?? 0;
  const paid = intent === "FULL" ? totalCents : intent === "PARTIAL" ? centsOf(amount) ?? 0 : 0;
  const open = Math.max(0, totalCents - paid);
  const fullAmount = euro(totalCents);
  const status = intent === "FULL" || (intent === "PARTIAL" && paid >= totalCents && totalCents > 0) ? "Vollständig bezahlt" : intent === "PARTIAL" && paid > 0 ? "Teilweise bezahlt" : "Offen";
  return (
    <fieldset className="md:col-span-2 rounded-lg border border-line p-4 flex flex-col gap-3">
      <legend className="label-xs px-1">Miete & Kaution</legend>
      <input type="hidden" name="payNonce" value={config.nonce} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="flex flex-col gap-2.5" aria-label="Miete">
          <div className="flex items-center gap-2"><span className="font-semibold text-sm">Miete</span><span className={`chip ${status === "Vollständig bezahlt" ? "bg-good-soft text-good" : status === "Teilweise bezahlt" ? "bg-amber-soft text-amber" : "bg-panel-2 text-ink-2"}`}>{status}</span></div>
          <div className="grid grid-cols-3 gap-2 text-sm tnum">
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Gesamtmietpreis</div><div className="font-mono font-semibold">{fmtCents(totalCents)}</div></div>
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Bereits bezahlt</div><div className="font-mono font-semibold text-good">{fmtCents(paid)}</div></div>
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Noch offen</div><div className={`font-mono font-semibold ${open > 0 ? "text-bad" : ""}`}>{fmtCents(open)}</div></div>
          </div>
          <div className="flex rounded-md border border-line overflow-hidden text-[13px] font-medium" role="radiogroup" aria-label="Zahlungsstatus">
            {(Object.keys(RENTAL_PAYMENT_INTENTS) as RentalPaymentIntent[]).map((k) => (
              <label key={k} className={`flex-1 px-3 py-1.5 text-center cursor-pointer ${intent === k ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>
                <input type="radio" name="payIntent" value={k} checked={intent === k} onChange={() => setPay({ intent: k })} className="sr-only" />
                {RENTAL_PAYMENT_INTENTS[k]}
              </label>
            ))}
          </div>
          {eff.mismatch && (
            <p role="alert" className="text-xs text-amber bg-amber-soft rounded-md px-3 py-2">
              Im Entwurf war „Vollständig bezahlt“ gewählt{pay.fullCheck != null ? ` (Mietpreis damals ${fmtCents(pay.fullCheck)})` : ", der Mietpreis war da noch nicht berechnet"}. Der Mietpreis beträgt jetzt {fmtCents(totalCents)}. Die Zahlung wurde deshalb als Teilzahlung über den gespeicherten Betrag übernommen – bitte Zahlungsstatus und Betrag prüfen.
            </p>
          )}
          {intent !== "NONE" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="label-xs">Tatsächlich gezahlter Betrag €</span>
                {intent === "FULL" ? (
                  <input name="payAmount" value={fullAmount} readOnly className="input tnum bg-panel-2" />
                ) : (
                  <input name="payAmount" inputMode="decimal" value={amount} onChange={(e) => setPay({ amount: e.target.value })} placeholder="0,00" required className="input tnum" />
                )}
              </label>
              <label className="flex flex-col gap-1">
                <span className="label-xs">Zahlungsart</span>
                <select name="payMethod" value={pay.method} onChange={(e) => setPay({ method: e.target.value as PaymentMethod })} className="input">
                  {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1"><span className="label-xs">Zahlungsdatum</span><input name="payPaidAt" type="datetime-local" value={pay.paidAt} onChange={(e) => setPay({ paidAt: e.target.value })} required className="input tnum" /></label>
              <label className="flex flex-col gap-1"><span className="label-xs">Referenz (optional)</span><input name="payReference" maxLength={120} value={pay.reference} onChange={(e) => setPay({ reference: e.target.value })} placeholder="z. B. Belegnummer" className="input" /></label>
              <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="payNote" maxLength={500} value={pay.note} onChange={(e) => setPay({ note: e.target.value })} className="input" /></label>
            </div>
          )}
          <p className="text-xs text-ink-3">Nur dokumentiert, nicht eingezogen. Weitere Teilzahlungen später auf der Buchung unter „Mietzahlung“.</p>
        </section>
        <section className="flex flex-col gap-2.5 md:border-l md:border-line-soft md:pl-4" aria-label="Kaution">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">Kaution</span>
            {depositNow && depositCents > 0 ? <span className="chip bg-good-soft text-good">{depositEnteredCents >= depositCents ? "Wird als erhalten dokumentiert" : "Wird als teilweise erhalten dokumentiert"}</span> : <span className="chip bg-amber-soft text-amber">Noch nicht erhalten</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm tnum">
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Vereinbarte Kaution</div><div className="font-mono font-semibold">{fmtCents(depositCents)}</div></div>
            <div className="rounded-md bg-panel-2 p-2.5"><div className="label-xs">Erhalten</div><div className="font-mono font-semibold">{fmtCents(depositNow ? Math.min(depositEnteredCents, depositCents) : 0)}</div></div>
          </div>
          <input type="hidden" name="depNonce" value={`${config.nonce}-dep`} />
          <div className="flex rounded-md border border-line overflow-hidden text-[13px] font-medium" role="radiogroup" aria-label="Kautionsstatus">
            {([["NONE", "Noch nicht erhalten"], ["RECEIVED", "Kaution jetzt erhalten"]] as const).map(([k, label]) => (
              <label key={k} className={`flex-1 px-3 py-1.5 text-center cursor-pointer ${(depositNow ? "RECEIVED" : "NONE") === k ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"} ${k === "RECEIVED" && depositCents <= 0 ? "opacity-50" : ""}`}>
                <input type="radio" name="depIntent" value={k} checked={(depositNow ? "RECEIVED" : "NONE") === k} onChange={() => setDep({ received: k === "RECEIVED" })} disabled={k === "RECEIVED" && depositCents <= 0} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
          {depositNow && depositCents > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1"><span className="label-xs">Erhaltener Betrag €</span><input name="depAmount" inputMode="decimal" value={depositEntered} onChange={(e) => setDep({ amount: e.target.value })} required className="input tnum" /></label>
              <label className="flex flex-col gap-1"><span className="label-xs">Zahlungsart</span><select name="depMethod" value={dep.method} onChange={(e) => setDep({ method: e.target.value as PaymentMethod })} className="input">{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="flex flex-col gap-1"><span className="label-xs">Datum und Uhrzeit</span><input name="depOccurredAt" type="datetime-local" value={dep.occurredAt} onChange={(e) => setDep({ occurredAt: e.target.value })} required className="input tnum" /></label>
              <label className="flex flex-col gap-1"><span className="label-xs">Referenz (optional)</span><input name="depReference" maxLength={120} value={dep.reference} onChange={(e) => setDep({ reference: e.target.value })} placeholder="z. B. Belegnummer" className="input" /></label>
              <label className="flex flex-col gap-1 sm:col-span-2"><span className="label-xs">Notiz (optional)</span><input name="depNote" maxLength={500} value={dep.note} onChange={(e) => setDep({ note: e.target.value })} className="input" /></label>
              {depositEnteredCents > depositCents && <p role="alert" className="sm:col-span-2 text-xs text-bad bg-bad-soft rounded-md px-3 py-2">Mehr als die vereinbarte Kaution kann nicht als erhalten dokumentiert werden.</p>}
            </div>
          )}
          <p className="text-xs text-ink-3">{depositNow ? "Der Eingang wird mit der Buchung dokumentiert – nur Dokumentation, keine Abbuchung." : "Der Eingang kann auch später auf der Buchungsseite unter „Kaution“ dokumentiert werden."} Die Kaution ist eine Sicherheitsleistung, keine Mietzahlung, und verringert den offenen Mietpreis nicht.</p>
        </section>
      </div>
      {footer}
    </fieldset>
  );
}

export type TierRates = { workWeekRate: string | null; weeklyRate: string | null; monthlyRate: string | null };
export type VehicleOption = { id: string; plate: string; label: string; group: string; dailyRate: string; deposit: string; kmIncludedPerDay: string; extraKmRate: string; status: string; /** Freigabeliste Auslandsfahrten (Mandant → Gruppe → Fahrzeug) */ abroad: { possible: boolean; countries: string[] } } & TierRates;
/** Treffer der Kundensuche bzw. vorbelegter Kunde: eindeutig durch Nummer + Name/Firma + Kontaktdaten. */
export type CustomerOption = { id: string; label: string; number: string | null; context: string; blocked: boolean; discountPercent: number };

export type BookingFormValues = {
  vehicleId: string;
  customerId: string;
  startAt: string;
  endAt: string;
  notes: string;
  /** Befehl 29: bestehende Buchung – ihre ID (eingefrorener Tarif) und bisherige Abweichungen (Preis, Kilometer, Kaution) */
  bookingId?: string;
  choices?: TariffChoices;
  /** Buchung ohne Tarif (Altbestand): bisherige Preisvereinbarung */
  legacy?: { totalCents: number; text: string; depositCents: number } | null;
  /** bestehende Buchung: Auslandsfahrt (allowed null = vor dieser Funktion, der Vertrag bestimmt) */
  abroad?: { allowed: boolean | null; countries: string[]; surchargeCents: number | null };
  /** bestehende Buchung: bereits bestätigte Mietzahlungen (Hinweis, wenn der neue Gesamtmietpreis darunter fällt) */
  paidCents?: number;
};

export function BookingForm({
  action,
  values,
  vehicles,
  initialCustomer,
  submitLabel,
  cancelHref,
  allowNewCustomer = false,
  initialPayment,
  periodLocked = false,
  periodChangeable = true,
  draft,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  values: BookingFormValues;
  vehicles: VehicleOption[];
  /** Vorbelegter Kunde (bestehende Buchung oder ?kunde=…); die Auswahl selbst läuft über die serverseitige Suche. */
  initialCustomer: CustomerOption | null;
  submitLabel: string;
  cancelHref: string;
  /** Nur bei neuer Buchung: Bereich „Zahlung“ im Formular. Bestehende Buchungen erfassen Zahlungen unter „Mietzahlung“. */
  initialPayment?: InitialPaymentConfig;
  /** Nur bei neuer Buchung: Kunde kann direkt mit angelegt werden. */
  allowNewCustomer?: boolean;
  /** Befehl 28: bestehende Buchung – Zeitraum nur über „Zeitraum ändern“ (mit Grund und Audit), hier nur angezeigt */
  periodLocked?: boolean;
  /** Befehl 28: false, wenn der Dialog „Zeitraum ändern“ für diese Rolle bzw. diesen Stand nicht angeboten wird */
  periodChangeable?: boolean;
  /** Nur bei neuer Buchung: Zwischenspeichern als Entwurf im Browser */
  draft?: BookingDraftConfig;
}) {
  const restored = draft?.restored ?? null;
  const [state, formAction, pending] = useActionState(action, undefined);
  const [vehicleId, setVehicleId] = useState(values.vehicleId);
  const [customer, setCustomer] = useState<CustomerOption | null>(initialCustomer);
  const [customerMode, setCustomerMode] = useState<"existing" | "new">(allowNewCustomer && restored?.customerMode === "new" ? "new" : "existing");
  const [startAt, setStartAt] = useState(values.startAt);
  const [endAt, setEndAt] = useState(values.endAt);
  const [notes, setNotes] = useState(values.notes);
  // Befehl 29: Mietpreis und Kaution kommen aus dem gewählten Miettarif (Abweichungen mit Grund in der Tarifauswahl)
  const [totals, setTotals] = useState<TariffTotals>({ totalCents: 0, depositCents: 0, ready: false });
  const onTotals = useCallback((t: TariffTotals) => setTotals((p) => (p.totalCents === t.totalCents && p.depositCents === t.depositCents && p.ready === t.ready ? p : t)), []);
  const defaultWhen = initialPayment?.defaultWhen ?? "";
  const [pay, setPay] = useState<PayState>(() => ({
    intent: restored?.pay.intent ?? "NONE",
    amount: restored?.pay.amount ?? "",
    method: restored?.pay.method ?? "CASH",
    paidAt: restored?.pay.paidAt || defaultWhen,
    reference: restored?.pay.reference ?? "",
    note: restored?.pay.note ?? "",
    fullCheck: restored?.pay.intent === "FULL" ? restored.pay.fullCents : undefined,
  }));
  const [dep, setDep] = useState<DepState>(() => ({
    received: restored?.dep.received ?? false,
    amount: restored?.dep.amount ?? null,
    method: restored?.dep.method ?? "CASH",
    occurredAt: restored?.dep.occurredAt || defaultWhen,
    reference: restored?.dep.reference ?? "",
    note: restored?.dep.note ?? "",
  }));

  // Auslandsfahrt (Genehmigung, Länder, einmaliger Aufpreis): neue Buchung „nicht gestattet“ (bewusste Freigabe), sonst wie gespeichert
  const [abroad, setAbroad] = useState<AbroadState>(() =>
    restored?.abroad ? { on: true, countries: restored.abroad.countries, surcharge: restored.abroad.surcharge }
    : values.abroad?.allowed ? { on: true, countries: values.abroad.countries, surcharge: euro(values.abroad.surchargeCents ?? 0) }
    : { on: false, countries: [], surcharge: "" });

  // Zwischenspeichern (nur neue Buchung): Stand des Entwurfs in diesem Fenster
  const [tariffDraft, setTariffDraft] = useState<DraftTariff | null>(null);
  const onDraftState = useCallback((t: DraftTariff) => setTariffDraft((p) => (p && JSON.stringify(p) === JSON.stringify(t) ? p : t)), []);
  const [draftId, setDraftId] = useState<string | null>(restored?.id ?? null);
  const [knownRev, setKnownRev] = useState(restored?.rev ?? 0);
  const [savedAt, setSavedAt] = useState<number | null>(restored?.savedAt ?? null);
  const [savedSnap, setSavedSnap] = useState<string | null>(() => (restored ? draftSnapshot(restored) : null));
  const [touched, setTouched] = useState(false);
  const [draftNote, setDraftNote] = useState<{ tone: "bad" | "info"; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const vehicle = useMemo(() => vehicles.find((v) => v.id === vehicleId), [vehicles, vehicleId]);
  const eur = (c: number) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

  // Gesamtmietpreis = Grundmiete (Tarif bzw. Sonderpreis) + einmaliger Auslandsfahrt-Aufpreis; die Kaution bleibt unabhängig
  const abroadVehicle = vehicle ? { plate: vehicle.plate, possible: vehicle.abroad.possible, countries: vehicle.abroad.countries } : null;
  const abroadParsed = abroad.on ? parseSurchargeCents(abroad.surcharge) : null;
  const abroadCents = abroadParsed && "cents" in abroadParsed ? abroadParsed.cents : 0;
  const abroadReady = !abroad.on || (!!abroadParsed && "cents" in abroadParsed && abroad.countries.length > 0 && !!abroadVehicle?.possible && abroad.countries.every((c) => abroadVehicle.countries.includes(c)));
  const grand: TariffTotals = { totalCents: totals.totalCents + abroadCents, depositCents: totals.depositCents, ready: totals.ready && abroadReady };

  // Inhalt des Entwurfs – nur Whitelist-Felder, keine Kennungen (Nonce), keine Tarifvorschau-Stände, keine Neukundendaten
  const effPay = effectivePayIntent(pay.intent, pay.fullCheck, grand);
  const draftData: BookingDraftData | null = draft
    ? {
        vehicleId,
        startAt,
        endAt,
        notes,
        customerMode,
        customerId: customerMode === "existing" ? customer?.id ?? "" : "",
        tariff: tariffDraft ?? restored?.tariff ?? { ratePlanId: "", regularCents: null, price: { on: false, text: "", reason: "" }, km: { on: false, policy: "FREE_KILOMETERS", perDay: "", rate: "", reason: "" }, deposit: { on: false, text: "", reason: "" } },
        pay: {
          intent: effPay.intent,
          amount: effPay.intent === "FULL" ? (grand.ready ? euro(grand.totalCents) : "") : effPay.intent === "PARTIAL" ? pay.amount : "",
          fullCents: effPay.intent === "FULL" && grand.ready ? grand.totalCents : null,
          method: pay.method,
          paidAt: pay.paidAt,
          reference: pay.reference,
          note: pay.note,
        },
        // „Kaution jetzt erhalten“: der angezeigte Betrag ist bestätigt und wird festgehalten; sonst folgt er später der vereinbarten Kaution
        dep: { received: dep.received, amount: dep.received ? dep.amount ?? (totals.ready && totals.depositCents > 0 ? euro(totals.depositCents) : null) : null, method: dep.method, occurredAt: dep.occurredAt, reference: dep.reference, note: dep.note },
        ...(abroad.on ? { abroad: { on: true as const, countries: abroad.countries, surcharge: abroad.surcharge } } : {}),
      }
    : null;
  const dirty = !!draftData && touched && draftSnapshot(draftData) !== savedSnap;
  const onDirtyChange = draft?.onDirtyChange;
  const onDraftIdChange = draft?.onDraftIdChange;
  // Daten eines neuen Kunden liegen nie im Entwurf: Wer sie eingibt, wird vor dem Wechsel zu einem anderen Entwurf gefragt
  useEffect(() => onDirtyChange?.(dirty || customerMode === "new"), [onDirtyChange, dirty, customerMode]);
  useEffect(() => onDraftIdChange?.(draftId), [onDraftIdChange, draftId]);
  const markTouched = () => {
    if (draft && !touched) setTouched(true);
  };

  function saveDraftNow() {
    if (!draft || !draftData || pending) return;
    if (notes.length > DRAFT_NOTES_MAX) {
      setDraftNote({ tone: "bad", text: "Die Notizen sind für einen Entwurf zu lang – bitte kürzen." });
      return;
    }
    const res = saveDraft(browserDraftStorage(), draft.scope, { id: draftId, knownRev, data: draftData, newId: newDraftId, now: nowMs() });
    if (!res.ok) {
      setDraftNote({ tone: "bad", text: "Zwischenspeichern ist in diesem Browser nicht möglich (z. B. privates Fenster oder gesperrter Speicher)." });
      return;
    }
    // Fortgesetzter Entwurf: Adresse auf den gespeicherten Stand bringen, damit Neuladen genau diesen Entwurf (und Kunden) lädt
    if (draft.restored) {
      const url = new URL(window.location.href);
      url.searchParams.set("entwurf", res.draft.id);
      if (res.draft.customerMode === "existing" && res.draft.customerId) url.searchParams.set("kunde", res.draft.customerId);
      else url.searchParams.delete("kunde");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setDraftId(res.draft.id);
    setKnownRev(res.draft.rev);
    setSavedAt(res.draft.savedAt);
    setSavedSnap(draftSnapshot(res.draft));
    setTouched(false);
    setConfirmDiscard(false);
    setDraftNote(
      res.forked === "changed"
        ? { tone: "info", text: "Dieser Entwurf wurde inzwischen in einem anderen Fenster geändert. Ihre Eingaben wurden deshalb als eigener, neuer Entwurf gespeichert." }
        : res.forked === "missing"
          ? { tone: "info", text: "Der bisherige Entwurf existiert nicht mehr (verworfen oder bereits als Buchung angelegt). Ihre Eingaben wurden als neuer Entwurf gespeichert." }
          : null,
    );
    notifyDrafts();
  }

  function discardDraftNow() {
    if (!draft || !draftId || pending) return;
    removeDraft(browserDraftStorage(), draft.scope, draftId, nowMs());
    notifyDrafts();
    setDraftId(null);
    setKnownRev(0);
    setSavedAt(null);
    setSavedSnap(null);
    setTouched(true);
    setConfirmDiscard(false);
    setDraftNote({ tone: "info", text: "Entwurf verworfen. Die Eingaben bleiben auf dieser Seite stehen, bis Sie sie verlassen." });
  }

  const draftBar = draft && (
    <div className="border-t border-line-soft pt-3 flex flex-col gap-2">
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3">
        <button type="button" onClick={saveDraftNow} disabled={pending} className="btn justify-center !py-2.5 w-full sm:w-auto">Zwischenspeichern</button>
        <span role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm">
          {dirty ? <span className="chip bg-amber-soft text-amber">Ungespeicherte Änderungen</span> : savedAt ? <span className="chip bg-good-soft text-good">Entwurf gespeichert · {savedAtText(savedAt)}</span> : null}
        </span>
        {draftId && savedAt && !confirmDiscard && <button type="button" onClick={() => setConfirmDiscard(true)} disabled={pending} className="text-sm text-ink-3 underline underline-offset-2 hover:text-ink self-start sm:self-auto sm:ml-auto">Entwurf verwerfen</button>}
        {confirmDiscard && (
          <span className="flex flex-wrap items-center gap-2 text-sm sm:ml-auto">
            Entwurf wirklich verwerfen?
            <button type="button" onClick={discardDraftNow} disabled={pending} className="btn !py-1.5 text-bad">Verwerfen</button>
            <button type="button" onClick={() => setConfirmDiscard(false)} className="btn !py-1.5">Behalten</button>
          </span>
        )}
      </div>
      {draftNote && <p role={draftNote.tone === "bad" ? "alert" : "status"} className={`rounded-md px-3 py-2 text-xs ${draftNote.tone === "bad" ? "bg-bad-soft text-bad" : "bg-info-soft text-info"}`}>{draftNote.text}</p>}
      <p className="text-xs text-ink-3">
        Sichert die Eingaben dieses Formulars als Entwurf nur in diesem Browser – noch keine Buchung, keine Mietzahlung, kein Kautionseingang, keine Reservierung.{customerMode === "new" ? " Die Daten des neuen Kunden werden dabei nicht gespeichert." : ""}
      </p>
    </div>
  );

  function pickVehicle(id: string) {
    setVehicleId(id);
  }

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} onInput={markTouched} onChange={markTouched} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
      {draft && <input type="hidden" name="draftId" value={draftId ?? ""} />}
      <Field label="Fahrzeug" htmlFor="vehicleId" hint="Preis, Kilometer und Kaution kommen aus dem Miettarif der Fahrzeuggruppe, ebenso die Selbstbeteiligung">
        <select id="vehicleId" name="vehicleId" value={vehicleId} onChange={(e) => pickVehicle(e.target.value)} required className="input">
          <option value="">Bitte wählen…</option>
          {Array.from(new Set(vehicles.map((v) => v.group))).map((g) => (
            <optgroup key={g} label={g}>
              {vehicles.filter((v) => v.group === g).map((v) => (
                <option key={v.id} value={v.id} disabled={v.status === "INACTIVE"}>
                  {v.plate} · {v.label}{v.status === "WORKSHOP" ? " (Werkstatt)" : v.status === "BLOCKED" ? " (gesperrt)" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      <Field label="Kunde" htmlFor="customerId">
        {allowNewCustomer && (
          <div className="flex rounded-md border border-line overflow-hidden mb-1.5 text-[13px] font-medium" role="group" aria-label="Kunde">
            <button type="button" onClick={() => { setCustomerMode("existing"); markTouched(); }} className={`flex-1 px-3 py-1.5 ${customerMode === "existing" ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>Bestehender Kunde</button>
            <button type="button" onClick={() => { setCustomerMode("new"); markTouched(); }} className={`flex-1 px-3 py-1.5 ${customerMode === "new" ? "bg-brand text-brand-ink" : "bg-panel text-ink-2"}`}>Neuer Kunde</button>
          </div>
        )}
        <input type="hidden" name="customerMode" value={customerMode} />
        {customerMode === "new" ? (
          <p className="text-xs text-ink-3">Die Kundendaten stehen unten im Formular und werden zusammen mit der Buchung gespeichert.</p>
        ) : (
          <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); markTouched(); }} />
        )}
      </Field>
      <Field label="Abholung" htmlFor="startAt">
        <input id="startAt" name="startAt" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} required readOnly={periodLocked} aria-describedby={periodLocked ? "period-locked-hint" : undefined} className={`input tnum ${periodLocked ? "bg-panel-2 text-ink-2" : ""}`} />
      </Field>
      <Field label="Rückgabe" htmlFor="endAt">
        <input id="endAt" name="endAt" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} required readOnly={periodLocked} aria-describedby={periodLocked ? "period-locked-hint" : undefined} className={`input tnum ${periodLocked ? "bg-panel-2 text-ink-2" : ""}`} min={startAt || undefined} />
      </Field>
      {periodLocked && <p id="period-locked-hint" className="text-xs text-ink-3 sm:col-span-2 -mt-1">{periodChangeable ? "Der Zeitraum wird über „Zeitraum ändern“ geändert – mit Grund, Preisvorschlag und Verfügbarkeitsprüfung." : "Der Zeitraum kann hier nicht geändert werden."}</p>}
      <TariffPicker
        quote={quoteTariffsAction}
        vehicleId={vehicleId}
        startAt={startAt}
        endAt={endAt}
        customerId={customerMode === "new" ? null : customer?.id ?? null}
        bookingId={values.bookingId}
        bookingVehicleId={values.bookingId ? values.vehicleId : undefined}
        legacy={values.legacy ?? null}
        initial={values.choices}
        onTotals={onTotals}
        restore={restored?.tariff ?? null}
        onDraftState={draft ? onDraftState : undefined}
      />
      <AbroadSection
        value={abroad}
        onChange={(v) => { setAbroad(v); markTouched(); }}
        vehicle={abroadVehicle}
        legacy={!!values.bookingId && values.abroad?.allowed === null}
        error={abroadParsed && "error" in abroadParsed && abroad.surcharge.trim() !== "" ? abroadParsed.error : null}
      />
      <Field label="Notizen" htmlFor="notes" full>
        {/* Bearbeiten (ohne Entwurf) unverändert unkontrolliert; nur die neue Buchung führt die Notizen für das Zwischenspeichern mit */}
        {draft ? (
          <textarea id="notes" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="input" placeholder="z. B. Abholung am Nebeneingang, Zusatzfahrer folgt" />
        ) : (
          <textarea id="notes" name="notes" defaultValue={values.notes} rows={2} className="input" placeholder="z. B. Abholung am Nebeneingang, Zusatzfahrer folgt" />
        )}
      </Field>

      {customerMode === "new" && (
        <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 rounded-lg border border-line bg-bg/60 p-4 -mx-1">
          <CustomerFields values={emptyCustomer} prefix="c_" compact />
        </div>
      )}

      <div className="md:col-span-2 rounded-lg bg-panel-2 px-4 py-3 text-sm flex flex-wrap gap-x-6 gap-y-1 tnum">
        <span>Mietpreis: <b>{totals.ready ? eur(totals.totalCents) : "–"}</b></span>
        {abroad.on && abroadCents > 0 && <span>+ Auslandsfahrt-Aufpreis (einmalig): <b>{eur(abroadCents)}</b></span>}
        {abroad.on && abroadCents > 0 && <span>= Gesamtmietpreis: <b>{grand.ready ? eur(grand.totalCents) : "–"}</b></span>}
        <span className="text-ink-3">zzgl. Kaution {totals.ready ? eur(totals.depositCents) : "–"}</span>
        {vehicle && <span className="text-ink-3">Fahrzeug {vehicle.plate}</span>}
      </div>
      {values.bookingId && values.paidCents != null && values.paidCents > 0 && grand.ready && values.paidCents > grand.totalCents && (
        <p role="status" className="md:col-span-2 -mt-1 text-xs text-amber bg-amber-soft rounded-md px-3 py-2">Bereits gezahlt: {eur(values.paidCents)}. Das ist mehr als der neue Gesamtmietpreis ({eur(grand.totalCents)}); nach dem Speichern sind {eur(values.paidCents - grand.totalCents)} zu viel erfasst – Erstattung oder Guthaben über den Bereich „Mietzahlung“.</p>
      )}

      {initialPayment && <PaymentSection totalCents={grand.totalCents} depositCents={totals.depositCents} totalsReady={grand.ready} config={initialPayment} pay={pay} onPay={setPay} dep={dep} onDep={setDep} footer={draftBar} />}

      <FormError error={state?.error} />
      <div className="md:col-span-2 flex items-center gap-2 mt-1">
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird geprüft…" : submitLabel}</button>
        <Link href={cancelHref} className="btn">Abbrechen</Link>
      </div>
    </form>
  );
}
