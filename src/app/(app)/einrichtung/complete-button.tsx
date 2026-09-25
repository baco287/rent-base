"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { completeOnboardingAction } from "./actions";

export function CompleteOnboardingButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      className="btn btn-primary"
      onClick={() => startTransition(async () => { await completeOnboardingAction(); router.push("/heute"); })}
    >
      {pending ? "Wird abgeschlossen…" : "Zur RentBase-Oberfläche"}
    </button>
  );
}
