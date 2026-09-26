"use client";

import { useActionState } from "react";
import { authorizeKeyDropAction, cancelKeyDropAction, revokeKeyDropLinkAction, sendKeyDropLinkAction, type KeyDropState } from "./key-drop-actions";

function Msg({ state }: { state: KeyDropState }) {
  if (state?.error) return <p className="text-sm text-bad bg-bad-soft rounded-md px-3 py-2">{state.error}</p>;
  if (state?.ok) return <p className="text-sm text-good bg-good-soft rounded-md px-3 py-2">{state.ok}</p>;
  return null;
}

export function KeyDropAuthorizeForm({ bookingId, defaults }: { bookingId: string; defaults: { expectedReturnAt: string; instructions: string; label: string } }) {
  const [state, action, pending] = useActionState<KeyDropState, FormData>(authorizeKeyDropAction.bind(null, bookingId), undefined);
  return (
    <details className="rounded-md border border-line">
      <summary className="cursor-pointer px-3 py-2 font-medium">Kontaktlose Rückgabe vereinbaren</summary>
      <form action={action} className="p-3 flex flex-col gap-3 text-sm">
        <p className="rounded-md bg-amber-soft text-amber px-3 py-2 font-medium">Nur aktivieren, wenn die kontaktlose Rückgabe mit dem Kunden vereinbart wurde.</p>
        <div className="text-ink-2">Rückgabeart: <b>Kontaktlos ({defaults.label})</b></div>
        <label className="flex flex-col gap-1"><span className="label-xs">Vereinbarter Rückgabeort</span><input name="location" required minLength={3} maxLength={300} className="input" placeholder="z. B. Hof Musterstraße 1, Stellplatz 4, Schlüsselbox am Tor" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Erwarteter Rückgabezeitpunkt</span><input name="expectedReturnAt" type="datetime-local" required defaultValue={defaults.expectedReturnAt} className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Anweisung für den Kunden (optional)</span><textarea name="instructions" rows={3} maxLength={1500} defaultValue={defaults.instructions} className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Interne Notiz (optional, nie für den Kunden sichtbar)</span><textarea name="internalNote" rows={2} maxLength={1000} className="input" /></label>
        <label className="flex items-start gap-2"><input type="checkbox" name="agreed" required className="mt-1" /><span>Die kontaktlose Rückgabe wurde mit dem Kunden vereinbart.</span></label>
        <p className="text-xs text-ink-3">Beim Speichern wird keine E-Mail versendet. Der Link an den Kunden geht erst über „Rückgabe-Mail versenden“.</p>
        <Msg state={state} />
        <div><button disabled={pending} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Vereinbarung speichern"}</button></div>
      </form>
    </details>
  );
}

export function KeyDropSendButton({ bookingId, keyDropId, nonce, recipientName, recipientEmail, resend }: { bookingId: string; keyDropId: string; nonce: string; recipientName: string; recipientEmail: string; resend: boolean }) {
  const [state, action, pending] = useActionState<KeyDropState, FormData>(sendKeyDropLinkAction.bind(null, bookingId, keyDropId), undefined);
  const question = `Rückgabe-Mail an ${recipientName} (${recipientEmail}) senden? Der Kunde erhält damit den persönlichen Link für die kontaktlose Fahrzeugrückgabe.${resend ? " Ein bisher versendeter Link wird dabei ungültig." : ""}`;
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm(question)) e.preventDefault(); }} className="flex flex-col gap-2">
      <input type="hidden" name="nonce" value={nonce} />
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={pending} className="btn btn-primary">{pending ? "Wird gesendet…" : resend ? "Rückgabe-Mail erneut senden" : "Rückgabe-Mail versenden"}</button>
        <span className="text-sm text-ink-2 break-all">An: {recipientEmail}</span>
      </div>
      <Msg state={state} />
    </form>
  );
}

export function KeyDropRevokeButton({ bookingId, keyDropId }: { bookingId: string; keyDropId: string }) {
  const [state, action, pending] = useActionState<KeyDropState, FormData>(revokeKeyDropLinkAction.bind(null, bookingId, keyDropId), undefined);
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm("Den aktuellen Rückgabelink ungültig machen? Der Kunde kann ihn danach nicht mehr verwenden.")) e.preventDefault(); }} className="flex flex-col gap-2">
      <div><button disabled={pending} className="btn">{pending ? "Wird widerrufen…" : "Link widerrufen"}</button></div>
      <Msg state={state} />
    </form>
  );
}

export function KeyDropCancelForm({ bookingId, keyDropId }: { bookingId: string; keyDropId: string }) {
  const [state, action, pending] = useActionState<KeyDropState, FormData>(cancelKeyDropAction.bind(null, bookingId, keyDropId), undefined);
  return (
    <details className="rounded-md border border-line">
      <summary className="cursor-pointer px-3 py-2 text-sm">Vereinbarung aufheben (z. B. Kunde bringt das Fahrzeug persönlich)</summary>
      <form action={action} className="p-3 flex flex-col gap-2 text-sm">
        <input name="reason" required minLength={3} maxLength={300} className="input" placeholder="Grund" />
        <Msg state={state} />
        <div><button disabled={pending} className="btn btn-danger">{pending ? "Wird aufgehoben…" : "Vereinbarung aufheben"}</button></div>
      </form>
    </details>
  );
}
