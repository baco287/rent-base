"use client";

// Paket 1: telefonische Zustimmung des Mieters zu einem Nachtrag. Der Mitarbeiter unterschreibt nicht für den Mieter, sondern
// dokumentiert dessen Zustimmung – erst nach ausdrücklicher Bestätigung ist der Knopf aktiv. Prüfung, Nummer, Versiegelung und
// Übernahme in Buchung/Kaution laufen serverseitig unverändert (lib/amendments.signAmendment mit phoneConsent).
import { useActionState, useState } from "react";
import { FormError } from "@/components/ui";

type State = { error?: string; ok?: string } | undefined;

export function PhoneConsentForm({ action, seenHash, renterName, employeeName }: {
  action: (prev: State, fd: FormData) => Promise<State>;
  seenHash: string;
  renterName: string;
  employeeName: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="seenHash" value={seenHash} />
      <p className="text-ink-2">
        {renterName || "Der Mieter"} hat der oben zusammengefassten Änderung telefonisch zugestimmt und kann nicht vor Ort unterschreiben. Eine
        Unterschrift ist dann nicht nötig: Die Zustimmung wird mit Ihrem Namen ({employeeName}) und dem aktuellen Zeitpunkt im Nachtrag, im PDF und im
        Verlauf dokumentiert.
      </p>
      <label className="flex flex-col gap-1">
        <span className="label-xs">Notiz zum Anruf (optional)</span>
        <input name="note" maxLength={500} className="input" placeholder="z. B. Anruf 15:05, Kunde bestätigt Verlängerung bis morgen 18:00" />
      </label>
      <label className="flex items-start gap-2.5 rounded-md border border-line bg-panel-2 px-3 py-2.5 cursor-pointer">
        <input type="checkbox" name="confirmed" value="1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} required className="mt-0.5 size-5 shrink-0" />
        <span>Ich bestätige, dass der Mieter dieser Änderung telefonisch zugestimmt hat. Ich dokumentiere seine Zustimmung – ich unterschreibe nicht für ihn.</span>
      </label>
      <FormError error={state?.error} />
      <button type="submit" disabled={!confirmed || pending} className="btn btn-primary justify-center !py-2.5 !whitespace-normal text-center">
        {pending ? "Nachtrag wird wirksam gemacht…" : "Telefonische Zustimmung dokumentieren und Nachtrag wirksam machen"}
      </button>
    </form>
  );
}
