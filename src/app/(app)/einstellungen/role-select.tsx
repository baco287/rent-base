"use client";

import { useActionState } from "react";
import { ROLES } from "@/lib/constants";
import { changeUserRoleAction } from "./actions";

/** Rollenwechsel direkt in der Mitarbeiterliste (Befehl 20, item 30). Auswahl sendet sofort ab. */
export function RoleSelect({ userId, currentRole }: { userId: string; currentRole: string }) {
  const [state, formAction, pending] = useActionState(changeUserRoleAction, undefined);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <select
        name="role"
        defaultValue={currentRole}
        disabled={pending}
        className="input !py-1 !w-auto text-sm"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {Object.entries(ROLES).map(([k, l]) => (
          <option key={k} value={k}>{l}</option>
        ))}
      </select>
      {state?.error && <span className="text-bad text-xs">{state.error}</span>}
    </form>
  );
}
