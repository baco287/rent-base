"use client";

import { useActionState } from "react";
import { setPlatformRoleAction } from "@/app/admin/actions";
import { FormError } from "@/components/ui";
import { PLATFORM_ROLES } from "@/lib/constants";

/**
 * Interne Plattformrolle vergeben oder entziehen (nur SUPER_ADMIN). Entweder für ein konkretes Konto (userId) oder
 * per E-Mail-Adresse eines bestehenden Kontos. Kein Passwort, keine Kontoanlage – interne Konten entstehen über eine
 * normale Einladung in einen Mandanten (in der Regel den Betreiber-Mandanten).
 */
export function PlatformRoleForm({ userId, currentRole, canManage, compact = false }: { userId?: string; currentRole?: string; canManage: boolean; compact?: boolean }) {
  const [state, formAction, pending] = useActionState(setPlatformRoleAction, undefined);
  if (!canManage) return null;
  return (
    <form action={formAction} className={compact ? "flex flex-wrap items-end gap-2" : "grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end"}>
      {userId ? <input type="hidden" name="userId" value={userId} /> : (
        <label className="flex flex-col gap-1">
          <span className="label-xs">E-Mail des bestehenden Kontos</span>
          <input name="email" type="email" required className="input" placeholder="name@rent-base.de" />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="label-xs">Plattformrolle</span>
        <select name="role" defaultValue={currentRole ?? "NONE"} className="input">
          {Object.entries(PLATFORM_ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" name="confirm" required /> Änderung der internen Rolle bestätigen</label>
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Wird gesetzt…" : "Rolle setzen"}</button>
      </div>
      {state?.ok && <p className="md:col-span-3 text-good bg-good-soft rounded-md px-3 py-2 text-sm">{state.ok}</p>}
      <FormError error={state?.error} />
    </form>
  );
}
