"use client";

import { useActionState } from "react";
import { setFeatureAction } from "@/app/admin/actions";
import { FormError } from "@/components/ui";

/**
 * Feature je Mandant umschalten. Der Schalter zeigt den wirksamen Zustand; ohne FEATURE_MANAGE nur Anzeige.
 * Sperren eines Features ist eine kritische Aktion (Modul verschwindet für den Mandanten) – daher Bestätigung.
 */
export function FeatureToggle({ tenantId, featureKey, label, enabled, canManage, compact = false }: { tenantId: string; featureKey: string; label: string; enabled: boolean; canManage: boolean; compact?: boolean }) {
  const [state, formAction, pending] = useActionState(setFeatureAction, undefined);
  const next = enabled ? "0" : "1";
  const chip = <span className={`chip ${enabled ? "bg-good-soft text-good" : "bg-panel-2 text-ink-3"}`}>{enabled ? "an" : "aus"}</span>;
  if (!canManage) return chip;
  return (
    <form
      action={formAction}
      className={compact ? "inline-flex items-center gap-1.5" : "flex items-center gap-2"}
      onSubmit={(e) => {
        const question = enabled ? `„${label}“ für diesen Mandanten sperren? Das Modul verschwindet aus der Navigation, Aktionen werden serverseitig abgelehnt. Daten bleiben erhalten.` : `„${label}“ für diesen Mandanten freischalten?`;
        if (!window.confirm(question)) e.preventDefault();
      }}
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="key" value={featureKey} />
      <input type="hidden" name="enabled" value={next} />
      <button type="submit" disabled={pending} role="switch" aria-checked={enabled} aria-label={`${label} ${enabled ? "sperren" : "freischalten"}`} className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? "bg-good" : "bg-line"} ${pending ? "opacity-60" : ""}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4.5" : "translate-x-0.5"}`} />
      </button>
      {!compact && chip}
      {state?.error && <FormError error={state.error} />}
    </form>
  );
}
