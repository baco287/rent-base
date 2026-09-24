"use client";

// Formulare der Fahreridentifikation und Führerscheinprüfung (Phase 19.5). Mobile-first: große Touch-Ziele,
// ein Fahrer je aufklappbarer Karte. Die Dokumentkopie ist immer optional und getrennt von der Prüfung selbst.
import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/ui";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { COUNTRIES, IDENTITY_DOCUMENT_TYPES, LICENSE_CLASSES } from "@/lib/constants";
import type { DriverState } from "./driver-actions";

type Action = (prev: DriverState, fd: FormData) => Promise<DriverState>;
type SimpleAction = (prev: DriverState, fd: FormData) => Promise<DriverState>;

function Feedback({ state }: { state: DriverState }) {
  if (state?.error) return <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{state.error}</p>;
  if (state?.ok) return <p role="status" className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>;
  return null;
}

const radioRow = (name: string, defaultValue: string | undefined, labels: [string, string] = ["Ja", "Nein"]) => (
  <div className="grid grid-cols-2 gap-2 max-w-xs">
    {(["1", "0"] as const).map((v, i) => (
      <label key={v} className="cursor-pointer">
        <input type="radio" name={name} value={v} defaultChecked={defaultValue === v} required className="peer sr-only" />
        <span className={`flex h-11 items-center justify-center rounded-md border border-line bg-panel text-sm font-medium peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-info ${v === "1" ? "peer-checked:bg-good peer-checked:text-white peer-checked:border-good" : "peer-checked:bg-bad peer-checked:text-white peer-checked:border-bad"}`}>{labels[i]}</span>
      </label>
    ))}
  </div>
);

export function IdentityCheckForm({ action, defaultDocumentType, defaultNameMatched, defaultBirthMatched, defaultNotes, disabled }: {
  action: Action; defaultDocumentType?: string | null; defaultNameMatched?: boolean | null; defaultBirthMatched?: boolean | null; defaultNotes?: string | null; disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3">
      <fieldset disabled={disabled || pending} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="documentType" className="label-xs">Vorgelegtes Dokument</label>
          <select id="documentType" name="documentType" defaultValue={defaultDocumentType ?? "PERSONALAUSWEIS"} className="input" required>
            {Object.entries(IDENTITY_DOCUMENT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2.5 rounded-md border border-line bg-panel-2 px-3 py-3 cursor-pointer">
          <input type="checkbox" name="originalSeen" value="1" required className="size-5" />
          <span className="text-sm font-medium">Das Originaldokument wurde vorgelegt und geprüft.</span>
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="label-xs">Name stimmt mit dem Fahrer überein</span>
          {radioRow("nameMatched", defaultNameMatched == null ? undefined : defaultNameMatched ? "1" : "0")}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="label-xs">Geburtsdatum stimmt überein</span>
          {radioRow("birthDateMatched", defaultBirthMatched == null ? undefined : defaultBirthMatched ? "1" : "0")}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="id-notes" className="label-xs">Prüfnotiz (optional, intern)</label>
          <textarea id="id-notes" name="notes" defaultValue={defaultNotes ?? ""} rows={2} className="input" />
        </div>
        <FormError error={state?.error} />
        <Feedback state={state} />
        <div><button type="submit" className="btn btn-primary !py-2.5 w-full sm:w-auto">{pending ? "Wird gespeichert…" : "Identität speichern"}</button></div>
      </fieldset>
    </form>
  );
}

export function LicenseCheckForm({ action, defaults, requiredClass, disabled }: {
  action: Action;
  defaults: {
    documentValid?: boolean | null; nameMatched?: boolean | null; licenseNumber?: string; licenseCountry?: string;
    licenseIssuedAt?: string; licenseValidUntil?: string; licenseClasses?: string[]; internationalPermitPresented?: boolean; translationPresented?: boolean; notes?: string | null;
    manualReviewRequired?: boolean; deviatesFromCustomer?: boolean;
  };
  requiredClass: string | null;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [country, setCountry] = useState(defaults.licenseCountry ?? "DE");
  const foreign = country !== "DE";
  const euEeaCh = new Set(["DE", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "CH"]);
  const needsTranslationOrIfs = foreign && !euEeaCh.has(country);
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-3">
      <fieldset disabled={disabled || pending} className="flex flex-col gap-3">
        <label className="flex items-center gap-2.5 rounded-md border border-line bg-panel-2 px-3 py-3 cursor-pointer">
          <input type="checkbox" name="originalSeen" value="1" required className="size-5" />
          <span className="text-sm font-medium">Der Original-Führerschein wurde vorgelegt und geprüft.</span>
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="label-xs">Dokument gültig</span>
            {radioRow("documentValid", defaults.documentValid == null ? undefined : defaults.documentValid ? "1" : "0")}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="label-xs">Name stimmt überein</span>
            {radioRow("nameMatched", defaults.nameMatched == null ? undefined : defaults.nameMatched ? "1" : "0")}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="licenseNumber" className="label-xs">Führerscheinnummer</label>
            <input id="licenseNumber" name="licenseNumber" defaultValue={defaults.licenseNumber ?? ""} required className="input font-mono" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="licenseCountry" className="label-xs">Ausstellungsland</label>
            <select id="licenseCountry" name="licenseCountry" value={country} onChange={(e) => setCountry(e.target.value)} className="input">
              {Object.entries(COUNTRIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="licenseIssuedAt" className="label-xs">Ausstellungsdatum (soweit vorhanden)</label>
            <input id="licenseIssuedAt" name="licenseIssuedAt" type="date" defaultValue={defaults.licenseIssuedAt ?? ""} className="input" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="licenseValidUntil" className="label-xs">Gültig bis (soweit vorhanden)</label>
            <input id="licenseValidUntil" name="licenseValidUntil" type="date" defaultValue={defaults.licenseValidUntil ?? ""} className="input" />
          </div>
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="label-xs mb-1">Fahrerlaubnisklassen{requiredClass && <span className="normal-case font-normal"> · erforderlich für dieses Fahrzeug: <b>{requiredClass}</b></span>}</legend>
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
            {Object.keys(LICENSE_CLASSES).map((c) => (
              <label key={c} className="cursor-pointer">
                <input type="checkbox" name="licenseClasses" value={c} defaultChecked={defaults.licenseClasses?.includes(c)} className="peer sr-only" />
                <span className="flex h-10 items-center justify-center rounded-md border border-line bg-panel text-xs font-semibold peer-checked:bg-brand peer-checked:text-brand-ink peer-checked:border-brand">{c}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {foreign && (
          <div className="rounded-md bg-amber-soft px-3 py-2.5 flex flex-col gap-2">
            <p className="text-xs text-amber">Rent-Base beurteilt nicht automatisch die rechtliche Gültigkeit ausländischer Fahrerlaubnisse. Ausstellungsstaat, Dokument, Klassen und Gültigkeit werden erfasst; die Freigabe ist eine bewusste manuelle Entscheidung.</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="internationalPermitPresented" value="1" defaultChecked={defaults.internationalPermitPresented} className="size-4" /> Internationaler Führerschein vorgelegt</label>
            {needsTranslationOrIfs && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="translationPresented" value="1" defaultChecked={defaults.translationPresented} className="size-4" /> Beglaubigte Übersetzung vorgelegt</label>}
            {needsTranslationOrIfs && (
              <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="manualReviewConfirmed" value="1" defaultChecked={false} className="size-4" /> Manuelle Prüfung durchgeführt und bewusst bestätigt</label>
            )}
          </div>
        )}
        {defaults.deviatesFromCustomer && (
          <div className="rounded-md bg-amber-soft px-3 py-2.5 flex flex-col gap-2">
            <p className="text-sm font-medium text-amber">Die vorgelegten Daten unterscheiden sich von den Kundendaten.</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="deviationConfirmed" value="1" defaultChecked={false} className="size-4" /> Für diese Übergabe bestätigen (Kundenstammdaten bleiben unverändert)</label>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="lic-notes" className="label-xs">Prüfnotiz (optional, intern)</label>
          <textarea id="lic-notes" name="notes" defaultValue={defaults.notes ?? ""} rows={2} className="input" />
        </div>
        <FormError error={state?.error} />
        <Feedback state={state} />
        <div><button type="submit" className="btn btn-primary !py-2.5 w-full sm:w-auto">{pending ? "Wird gespeichert…" : "Führerschein speichern"}</button></div>
      </fieldset>
    </form>
  );
}

export function StartDriverVerificationButton({ action, label }: { action: Action; label: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Feedback state={state} />
      <button type="submit" disabled={pending} className="btn btn-primary !py-3 w-full justify-center">{pending ? "Wird begonnen…" : label}</button>
    </form>
  );
}

export function ConfirmDriverButton({ action, disabled, blockers }: { action: Action; disabled: boolean; blockers: string[] }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      {blockers.length > 0 && (
        <ul className="text-xs text-bad flex flex-col gap-0.5">{blockers.map((b) => <li key={b}>• {b}</li>)}</ul>
      )}
      <Feedback state={state} />
      <button type="submit" disabled={disabled || pending} className="btn btn-primary !py-3 w-full justify-center">{pending ? "Wird bestätigt…" : "Prüfung bestätigen"}</button>
    </form>
  );
}

export function UpdateCustomerLicenseButton({ action }: { action: SimpleAction }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Feedback state={state} />
      <button type="submit" disabled={pending} className="btn !py-1.5 text-xs">{pending ? "Wird übernommen…" : "Kundenstammdaten aktualisieren"}</button>
    </form>
  );
}

/** Dokumentkopie aufnehmen (Kamera) oder auswählen. IDENTITY braucht die ausdrückliche, nicht vorausgewählte Zustimmung; die Prüfung selbst funktioniert vollständig ohne Kopie. */
export function DriverDocumentUploader({ handoverId, verificationId, contractDriverId, documentKind, copies, editable }: {
  handoverId: string; verificationId: string; contractDriverId: string; documentKind: "IDENTITY" | "LICENSE";
  copies: { id: string; side: string }[]; editable: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [side, setSide] = useState<"FRONT" | "BACK">("FRONT");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requiresConsent = documentKind === "IDENTITY";

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", files[0]);
      body.set("verificationId", verificationId);
      body.set("contractDriverId", contractDriverId);
      body.set("documentKind", documentKind);
      body.set("side", side);
      if (requiresConsent) body.set("consentGiven", consent ? "1" : "0");
      const res = await fetch(`/api/handovers/${handoverId}/driver-documents`, { method: "POST", body });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Die Dokumentkopie konnte nicht gespeichert werden.");
      setConsent(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/driver-documents/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Konnte nicht gelöscht werden.");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-panel p-3 flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-[13px]">{documentKind === "IDENTITY" ? "Ausweiskopie (optional)" : "Führerscheinkopie (optional)"}</span>
        {copies.length > 0 && <span className="chip bg-good-soft text-good">{copies.length}</span>}
      </div>
      <p className="text-xs text-ink-3">{documentKind === "IDENTITY" ? "Für die Speicherung einer Personalausweiskopie ist die Zustimmung des Ausweisinhabers erforderlich. Die Kopie wird dauerhaft als Kopie gekennzeichnet und ersetzt nicht die Originalprüfung." : "Freiwillig, dient nur dem Nachweis zu diesem Vermietvorgang und wird dauerhaft als Kopie gekennzeichnet. Die Originalprüfung funktioniert auch ohne Kopie."}</p>
      {copies.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-ink-2">
          {copies.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded-md bg-panel-2 px-2 py-1.5">
              <span>{c.side === "FRONT" ? "Vorderseite" : "Rückseite"}</span>
              <button type="button" onClick={() => remove(c.id)} disabled={busy} className="text-bad underline">Löschen</button>
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <>
          <div className="flex gap-1.5">
            {(["FRONT", "BACK"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSide(s)} className={`btn !py-1.5 flex-1 ${side === s ? "!bg-brand !text-brand-ink !border-brand" : ""}`}>{s === "FRONT" ? "Vorderseite" : "Rückseite"}</button>
            ))}
          </div>
          {requiresConsent && (
            <label className="flex items-start gap-2.5 rounded-md border border-line bg-panel-2 px-3 py-2.5 cursor-pointer">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-5 shrink-0" />
              <span className="text-xs">Der Ausweisinhaber stimmt der Anfertigung und Speicherung dieser Kopie für den angegebenen Zweck zu.</span>
            </label>
          )}
          {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-xs">{error}</p>}
          <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => upload(e.target.files)} aria-label="Dokument aufnehmen" />
          <button type="button" onClick={() => input.current?.click()} disabled={busy || (requiresConsent && !consent)} className="btn justify-center !py-2.5">
            {busy ? "Wird hochgeladen…" : "Dokument aufnehmen"}
          </button>
        </>
      )}
    </div>
  );
}
