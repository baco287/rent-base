"use client";

// Gemeinsame deutsche Fehleransicht für error.tsx und global-error.tsx.
// Unterscheidet drei Fälle, weil die richtige Handlung für den Benutzer jeweils eine andere ist:
// - Update: Die Seite stammt aus einer älteren Version (Server Action unbekannt, Programmteil fehlt) → neu laden.
// - Verbindung: Server kurz nicht erreichbar, z. B. während eines Deploys → kurz warten, erneut versuchen.
// - Sonstiges: unerwarteter Fehler → erneut versuchen, sonst neu laden; Fehlercode für den Support.

import { useEffect } from "react";
import { unstable_isUnrecognizedActionError } from "next/navigation";

type Kind = "update" | "offline" | "general";

export function classifyError(error: unknown): Kind {
  if (unstable_isUnrecognizedActionError(error)) return "update";
  const e = error as { name?: string; message?: string } | null;
  const message = e?.message ?? "";
  if (e?.name === "ChunkLoadError" || /Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/i.test(message)) return "update";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  if (error instanceof TypeError && /fetch|network|load failed/i.test(message)) return "offline";
  return "general";
}

const TEXT: Record<Kind, { title: string; body: string }> = {
  update: {
    title: "RentBase wurde gerade aktualisiert",
    body: "Ihre letzte Aktion wurde deshalb nicht ausgeführt. Bitte laden Sie die Seite neu und prüfen Sie danach, ob die Eingaben übernommen wurden. Bereits gespeicherte Schritte bleiben erhalten.",
  },
  offline: {
    title: "Keine Verbindung zum Server",
    body: "Der Server war kurz nicht erreichbar, zum Beispiel während eines Updates. Bitte warten Sie einen Moment und versuchen Sie es dann erneut.",
  },
  general: {
    title: "Diese Seite konnte nicht geladen werden",
    body: "Beim Laden ist ein Fehler aufgetreten. Bereits gespeicherte Daten sind davon nicht betroffen. Bitte versuchen Sie es erneut oder laden Sie die Seite neu.",
  },
};

export function ErrorView({ error, retry, homeHref }: { error: Error & { digest?: string }; retry: () => void; homeHref?: string | null }) {
  const kind = classifyError(error);
  const text = TEXT[kind];

  useEffect(() => {
    console.error(error);
  }, [error]);

  const reload = () => window.location.reload();

  return (
    <div role="alert" className="mx-auto w-full max-w-lg px-4 py-12">
      <div className="card p-6">
        <h1 className="text-lg font-semibold text-ink">{text.title}</h1>
        <p className="mt-2 text-sm text-ink-2 leading-relaxed">{text.body}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {kind === "update" ? (
            <button type="button" className="btn btn-primary" onClick={reload}>Seite neu laden</button>
          ) : (
            <>
              <button type="button" className="btn btn-primary" onClick={() => retry()}>Erneut versuchen</button>
              <button type="button" className="btn" onClick={reload}>Seite neu laden</button>
            </>
          )}
          {homeHref && <a href={homeHref} className="btn">Zur Startseite</a>}
        </div>
        {error.digest && <p className="mt-4 text-xs text-ink-3">Fehlercode für den Support: <span className="font-mono">{error.digest}</span></p>}
      </div>
    </div>
  );
}
