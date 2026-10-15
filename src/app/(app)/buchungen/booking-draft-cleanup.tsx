"use client";

// Nach erfolgreicher Anlage aus einem Entwurf (Redirect mit ?ausEntwurf=<id>): den Entwurf im Browser entfernen, damit er nicht
// erneut als neue Buchung angeboten wird, und den Parameter aus der Adresse nehmen (kein erneutes Laden der Seite).
import { useEffect } from "react";
import { removeDraftEverywhere } from "@/lib/booking-draft";
import { browserDraftStorage, notifyDrafts } from "./booking-draft-store";

export function BookingDraftCleanup({ draftId }: { draftId: string }) {
  useEffect(() => {
    removeDraftEverywhere(browserDraftStorage(), draftId);
    notifyDrafts();
    const url = new URL(window.location.href);
    if (url.searchParams.has("ausEntwurf")) {
      url.searchParams.delete("ausEntwurf");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [draftId]);
  return <p role="status" className="rounded-md bg-good-soft text-good px-3.5 py-2.5 text-sm">Buchung aus dem Entwurf angelegt. Der Entwurf wurde aus diesem Browser entfernt.</p>;
}
