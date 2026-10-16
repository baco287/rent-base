"use client";

// Neue Buchung mit Entwurf („Zwischenspeichern“): Hinweis auf gespeicherte Entwürfe dieses Mandanten und Benutzers mit
// „Entwurf fortsetzen“ / „Entwurf verwerfen“ – bestehende Formularwerte werden nie ungefragt überschrieben. Fortsetzen lädt die
// Seite mit ?entwurf=<id> (und ?kunde=<id>, damit der Server den Kunden mandantengeprüft lädt); der Entwurf wird beim Laden einmal
// geprüft und eingefroren. Die eigentliche Anlage bleibt unverändert createBookingAction (alle Prüfungen serverseitig).
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui";
import { fmtCents } from "@/lib/money";
import { localInputText, pruneExpiredDrafts, removeDraft, restoreTargets, type BookingDraft, type DraftScope } from "@/lib/booking-draft";
import { countryNames } from "@/lib/abroad";
import { BookingForm, type BookingFormValues, type CustomerOption, type InitialPaymentConfig, type VehicleOption } from "./booking-form";
import type { FormState } from "./actions";
import { browserDraftStorage, draftsOf, localNowInput, notifyDrafts, savedAtText, useDraftsRaw } from "./booking-draft-store";

type Props = {
  scope: DraftScope;
  /** ?entwurf=<id>: diesen Entwurf fortsetzen */
  resumeId: string | null;
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  values: BookingFormValues;
  vehicles: VehicleOption[];
  initialCustomer: CustomerOption | null;
  initialPayment: InitialPaymentConfig;
};

function payText(d: BookingDraft) {
  if (d.pay.intent === "FULL") return `vollständig bezahlt${d.pay.fullCents != null ? ` (${fmtCents(d.pay.fullCents)})` : ""}`;
  if (d.pay.intent === "PARTIAL") return `teilweise bezahlt${d.pay.amount ? ` (${d.pay.amount} €)` : ""}`;
  return "offen";
}

function depText(d: BookingDraft) {
  return d.dep.received ? `erhalten${d.dep.amount ? ` (${d.dep.amount} €)` : ""}` : "noch nicht erhalten";
}

export function NewBookingForm({ scope, resumeId, action, values, vehicles, initialCustomer, initialPayment }: Props) {
  const raw = useDraftsRaw(scope);
  const drafts = useMemo(() => draftsOf(raw, scope), [raw, scope]);
  const [ownId, setOwnId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmContinue, setConfirmContinue] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const onDraftIdChange = useCallback((id: string | null) => setOwnId(id), []);
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);
  // Abgelaufene Entwürfe (älter als 7 Tage) in diesem Browser tatsächlich entfernen, nicht nur ausblenden
  useEffect(() => {
    pruneExpiredDrafts(browserDraftStorage(), Date.now());
    notifyDrafts();
  }, []);

  // Fortsetzen: den Entwurf beim ersten Lesen im Browser einfrieren – spätere Änderungen am Speicher (eigenes Speichern, Verwerfen,
  // anderes Fenster) setzen das Formular nicht zurück
  const [frozen, setFrozen] = useState<{ draft: BookingDraft | null; nowLocal: string } | null>(null);
  if (resumeId && raw !== null && frozen === null) setFrozen({ draft: drafts.find((d) => d.id === resumeId) ?? null, nowLocal: localNowInput() });

  const plateOf = (id: string) => vehicles.find((v) => v.id === id)?.plate ?? null;
  const formProps = { action, vehicles, allowNewCustomer: true, initialPayment, submitLabel: "Buchung anlegen", cancelHref: "/buchungen" } as const;

  if (resumeId) {
    if (!frozen) return <Card className="p-5 max-w-3xl"><p role="status" className="text-sm text-ink-3">Entwurf wird geladen…</p></Card>;
    const d = frozen.draft;
    if (!d) {
      return (
        <>
          <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 text-sm max-w-3xl">Der Entwurf wurde nicht gefunden – er wurde verworfen, ist abgelaufen oder wurde bereits als Buchung angelegt. Unten steht ein neues, leeres Formular.</p>
          <Card className="p-5 max-w-3xl">
            <BookingForm {...formProps} values={values} initialCustomer={null} draft={{ scope, restored: null }} />
          </Card>
        </>
      );
    }
    const t = restoreTargets(d, vehicles, initialCustomer?.id ?? null, values, frozen.nowLocal);
    return (
      <>
        <section aria-label="Entwurf fortgesetzt" className="rounded-md bg-info-soft text-info px-3.5 py-2.5 text-sm max-w-3xl flex flex-col gap-1">
          <p className="font-medium">Entwurf vom {savedAtText(d.savedAt)} fortgesetzt.</p>
          <p>Tarif, Preis und Verfügbarkeit werden beim Anlegen neu geprüft – erst dann entstehen Buchung, Mietzahlung und Kautionseingang.</p>
          {t.notices.map((n) => <p key={n} className="text-amber">{n}</p>)}
        </section>
        <Card className="p-5 max-w-3xl">
          <BookingForm
            {...formProps}
            values={{ ...values, vehicleId: t.vehicleId, customerId: t.customerOk ? d.customerId : "", startAt: t.startAt, endAt: t.endAt, notes: d.notes }}
            initialCustomer={t.customerOk ? initialCustomer : null}
            draft={{ scope, restored: d }}
          />
        </Card>
      </>
    );
  }

  const others = drafts.filter((d) => d.id !== ownId);
  return (
    <>
      {others.length > 0 && (
        <section aria-label="Gespeicherte Buchungsentwürfe" className="rounded-xl border border-brand/30 bg-brand-soft/40 p-4 max-w-3xl flex flex-col gap-3">
          <p className="font-semibold">{others.length === 1 ? "Es gibt einen gespeicherten Buchungsentwurf." : `Es gibt ${others.length} gespeicherte Buchungsentwürfe.`}</p>
          <ul className="flex flex-col gap-2">
            {others.map((d) => {
              const href = `/buchungen/neu?entwurf=${d.id}${d.customerMode === "existing" && d.customerId ? `&kunde=${encodeURIComponent(d.customerId)}` : ""}`;
              return (
                <li key={d.id} className="rounded-lg border border-line bg-panel p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                  <div className="flex-1 min-w-0 text-sm">
                    <div className="font-medium tnum">{(d.vehicleId && plateOf(d.vehicleId)) || "Ohne Fahrzeug"} · {localInputText(d.startAt)} – {localInputText(d.endAt)}</div>
                    <div className="text-xs text-ink-3">
                      Gespeichert {savedAtText(d.savedAt)} · Miete {payText(d)} · Kaution {depText(d)}
                      {d.abroad ? ` · Ausland ${countryNames(d.abroad.countries)}${d.abroad.surcharge ? ` (+${d.abroad.surcharge} €)` : ""}` : ""}
                      {d.customerMode === "new" ? " · Neuer Kunde (Daten nicht gespeichert)" : d.customerId ? " · Kunde gewählt" : ""}
                    </div>
                  </div>
                  {confirmContinue === d.id ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span>Ihre aktuellen Eingaben in diesem Formular (auch Daten eines neuen Kunden) werden nicht übernommen.</span>
                      <Link href={href} className="btn btn-primary !py-1.5">Trotzdem fortsetzen</Link>
                      <button type="button" onClick={() => setConfirmContinue(null)} className="btn !py-1.5">Abbrechen</button>
                    </div>
                  ) : confirmDiscard === d.id ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span>Entwurf wirklich verwerfen?</span>
                      <button type="button" onClick={() => { removeDraft(browserDraftStorage(), scope, d.id, Date.now()); notifyDrafts(); setConfirmDiscard(null); }} className="btn !py-1.5 text-bad">Verwerfen</button>
                      <button type="button" onClick={() => setConfirmDiscard(null)} className="btn !py-1.5">Behalten</button>
                    </div>
                  ) : (
                    <div className="flex flex-col min-[420px]:flex-row gap-2 sm:shrink-0">
                      <Link href={href} onClick={(e) => { if (dirty) { e.preventDefault(); setConfirmContinue(d.id); } }} className="btn btn-primary justify-center !py-2.5 min-[420px]:flex-1 sm:flex-none">Entwurf fortsetzen</Link>
                      <button type="button" onClick={() => { setConfirmDiscard(d.id); setConfirmContinue(null); }} className="btn justify-center !py-2.5 min-[420px]:flex-1 sm:flex-none">Entwurf verwerfen</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-ink-3">Ein Entwurf ist noch keine Buchung: keine Mietzahlung, kein Kautionseingang, keine Reservierung. Entwürfe liegen nur in diesem Browser und werden nach 7 Tagen verworfen.</p>
        </section>
      )}
      <Card className="p-5 max-w-3xl">
        <BookingForm {...formProps} values={values} initialCustomer={initialCustomer} draft={{ scope, restored: null, onDirtyChange, onDraftIdChange }} />
      </Card>
    </>
  );
}
