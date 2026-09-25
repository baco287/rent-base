"use client";

import { useActionState, useState } from "react";
import { Field, FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { SMTP_ALLOWED_PORTS, SMTP_SECURITY } from "@/lib/constants";
import { disableTenantSmtpAction, enableTenantSmtpAction, saveMailSettingsAction, sendTestMailAction, testConnectionAction, type MailFormState } from "./actions";

function Ok({ state }: { state: MailFormState }) {
  if (!state?.ok) return null;
  return <p className="md:col-span-2 text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
}

/** Werte ohne Passwort: das gespeicherte Passwort erreicht den Browser nie, nur die Information „gespeichert“. */
export type SmtpFormValues = { host: string; port: number; security: string; username: string; hasPassword: boolean; fromName: string; fromEmail: string; replyTo: string };

export function SmtpSettingsForm({ v, disabled }: { v: SmtpFormValues; disabled: boolean }) {
  const [state, formAction, pending] = useActionState(saveMailSettingsAction, undefined);
  const [security, setSecurity] = useState(v.security || "STARTTLS");
  const [port, setPort] = useState(String(v.port || 587));
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 p-5" autoComplete="off">
      <Field label="SMTP-Server" htmlFor="host" full hint="Hostname Ihres Mailanbieters, z. B. smtp.ionos.de oder smtp.office365.com – ohne https:// und ohne Port.">
        <input id="host" name="host" defaultValue={v.host} required disabled={disabled} className="input" inputMode="url" autoCapitalize="none" spellCheck={false} />
      </Field>
      <Field label="Verschlüsselung" htmlFor="security">
        <select id="security" name="security" value={security} disabled={disabled} onChange={(e) => { setSecurity(e.target.value); setPort(e.target.value === "SSL_TLS" ? "465" : "587"); }} className="input">
          {Object.entries(SMTP_SECURITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Port" htmlFor="port">
        <select id="port" name="port" value={port} disabled={disabled} onChange={(e) => setPort(e.target.value)} className="input">
          {SMTP_ALLOWED_PORTS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </Field>
      <Field label="Benutzername" htmlFor="username" full hint="Meist die vollständige E-Mail-Adresse des Postfachs.">
        <input id="username" name="username" defaultValue={v.username} required disabled={disabled} className="input" autoCapitalize="none" spellCheck={false} autoComplete="off" />
      </Field>
      <Field label={v.hasPassword ? "Neues Passwort / App-Passwort" : "Passwort / App-Passwort"} htmlFor="newPassword" full hint={v.hasPassword ? "Leer lassen, um das gespeicherte Passwort zu behalten." : "Wird verschlüsselt gespeichert und nie wieder angezeigt. Bei Microsoft 365 oder Gmail in der Regel ein App-Passwort."}>
        {v.hasPassword && <span className="text-sm text-ink-2 mb-1 block">•••••••• – gespeichert</span>}
        <input id="newPassword" name="newPassword" type="password" required={!v.hasPassword} disabled={disabled} className="input" autoComplete="new-password" />
      </Field>
      <Field label="Absendername" htmlFor="fromName" hint="So erscheint der Absender bei Ihren Kunden.">
        <input id="fromName" name="fromName" defaultValue={v.fromName} required disabled={disabled} className="input" />
      </Field>
      <Field label="Absenderadresse" htmlFor="fromEmail" hint="Muss zu diesem Postfach gehören, sonst lehnt der Anbieter den Versand ab.">
        <input id="fromEmail" name="fromEmail" type="email" defaultValue={v.fromEmail} required disabled={disabled} className="input" autoCapitalize="none" />
      </Field>
      <Field label="Antwortadresse (optional)" htmlFor="replyTo" full hint="Nur nötig, wenn Antworten an eine andere Adresse gehen sollen.">
        <input id="replyTo" name="replyTo" type="email" defaultValue={v.replyTo} disabled={disabled} className="input" autoCapitalize="none" />
      </Field>
      <FormError error={state?.error} />
      <Ok state={state} />
      <div className="md:col-span-2"><button disabled={pending || disabled} className="btn btn-primary">{pending ? "Wird gespeichert…" : "Speichern"}</button></div>
    </form>
  );
}

function ActionButton({ action, label, pendingLabel, tone = "btn", disabled, extra, note }: { action: (s: MailFormState, fd: FormData) => Promise<MailFormState>; label: string; pendingLabel: string; tone?: string; disabled?: boolean; extra?: Record<string, string>; note?: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      {extra && Object.entries(extra).map(([k, val]) => <input key={k} type="hidden" name={k} value={val} />)}
      <button disabled={pending || disabled} className={tone}>{pending ? pendingLabel : label}</button>
      {note && <p className="text-xs text-ink-3 break-all">{note}</p>}
      {state?.error && <p className="text-sm text-bad bg-bad-soft rounded-md px-3 py-2">{state.error}</p>}
      {state?.ok && <p className="text-sm text-good bg-good-soft rounded-md px-3 py-2">{state.ok}</p>}
    </form>
  );
}

export function TestConnectionButton({ disabled }: { disabled: boolean }) {
  return <ActionButton action={testConnectionAction} label="Verbindung testen" pendingLabel="Wird geprüft…" disabled={disabled} />;
}

export function SendTestMailButton({ disabled, nonce, recipient }: { disabled: boolean; nonce: string; recipient: string }) {
  return <ActionButton action={sendTestMailAction} label="Testmail senden" pendingLabel="Wird gesendet…" disabled={disabled} extra={{ nonce }} note={`Empfänger: ${recipient} (Ihr eigenes Konto)`} />;
}

export function EnableButton({ disabled }: { disabled: boolean }) {
  return <ActionButton action={enableTenantSmtpAction} label="Eigenen Versand aktivieren" pendingLabel="Wird aktiviert…" tone="btn btn-primary" disabled={disabled} />;
}

export function DisableButton() {
  return <ActionButton action={disableTenantSmtpAction} label="Eigenen Versand deaktivieren" pendingLabel="Wird deaktiviert…" />;
}
