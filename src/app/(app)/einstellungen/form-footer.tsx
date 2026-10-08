"use client";

// Befehl 29.3.1: einheitliche Fußleiste der Einstellungsformulare (Speichern rechts) mit Hinweis auf ungespeicherte
// Änderungen. „Verwerfen“ setzt das Formular auf die gespeicherten Werte zurück; solange etwas ungespeichert ist,
// fragt der Browser beim Schließen oder Neuladen nach. Gespeichert wird weiterhin nur über die bestehende Server Action.
import { useEffect, useRef, useState } from "react";

/**
 * Beobachtet ein Formular: jede Eingabe macht es „geändert“, ein Zurücksetzen (Verwerfen oder das automatische
 * Zurücksetzen nach der Server Action) wieder „gespeichert“.
 */
export function useDirtyForm() {
  const ref = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    const on = () => setDirty(true);
    const off = () => setDirty(false);
    f.addEventListener("input", on);
    f.addEventListener("change", on);
    f.addEventListener("reset", off);
    return () => {
      f.removeEventListener("input", on);
      f.removeEventListener("change", on);
      f.removeEventListener("reset", off);
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return { ref, dirty, discard: () => ref.current?.reset() };
}

/** Fußleiste innerhalb eines Formulars mit Innenabstand p-5 (reicht bis an den Kartenrand). */
export function FormFooter({ dirty, pending, onDiscard, label, pendingLabel = "Wird gespeichert…", note }: { dirty: boolean; pending: boolean; onDiscard: () => void; label: string; pendingLabel?: string; note?: string }) {
  return (
    <div className="col-span-full -mx-5 -mb-5 mt-1 flex flex-wrap items-center gap-3 rounded-b-lg border-t border-line-soft bg-[#fafbfd] px-5 py-3">
      <p className="min-w-0 flex-1 text-[12.5px] text-ink-3" aria-live="polite">
        {dirty ? (
          <span className="inline-flex items-center gap-2 text-amber"><span aria-hidden="true" className="size-[7px] rounded-full bg-amber" />Ungespeicherte Änderungen</span>
        ) : (
          note ?? ""
        )}
      </p>
      {dirty && !pending && <button type="button" onClick={onDiscard} className="btn !border-transparent !bg-transparent text-ink-2 hover:!bg-panel-2">Verwerfen</button>}
      <button type="submit" disabled={pending} className="btn btn-primary">{pending ? pendingLabel : label}</button>
    </div>
  );
}
