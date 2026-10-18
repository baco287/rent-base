"use client";
// Befehl 29.6: Rahmen des Vertragsentwurfs im Browser – nur Darstellung, keine Fachlogik, kein Autosave.
// - --bar-h: Höhe der Aktionsleiste (ResizeObserver); daraus scroll-margin-bottom für alle fokussierbaren Elemente,
//   damit ein fokussiertes Feld nie unter der sticky Leiste liegt (WCAG 2.4.11).
// - data-typing: Bildschirmtastatur offen (Fokus in einem Textfeld) – die Leiste wird mobil statisch, solange getippt wird.
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const TEXT_INPUT_EXCLUDED = new Set(["checkbox", "radio", "file", "hidden", "range", "submit", "button", "reset", "image", "color"]);
const isTextField = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !TEXT_INPUT_EXCLUDED.has(el.type);
};

export function WizardShell({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onIn = (e: FocusEvent) => {
      if (timer) clearTimeout(timer);
      if (isTextField(e.target)) root.dataset.typing = "true";
    };
    const onOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      // Wechsel in ein anderes Textfeld oder in die Leiste: Zustand bleibt (kein Springen der Leiste beim Antippen)
      if (isTextField(next) || (next instanceof HTMLElement && next.closest("[data-action-bar]"))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { delete root.dataset.typing; }, 300);
    };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    return () => {
      if (timer) clearTimeout(timer);
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
    };
  }, []);
  return (
    <div ref={ref} data-wizard="" className="group/wizard flex flex-col gap-4 [&_:is(input,select,textarea,button,a,summary)]:scroll-mb-[calc(var(--bar-h,8rem)+0.75rem)]">
      {children}
    </div>
  );
}

/** Höhe der Aktionsleiste als --bar-h am Rahmen des Assistenten (für scroll-margin-bottom). */
export function useBarHeight(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const bar = ref.current;
    const root = bar?.closest<HTMLElement>("[data-wizard]");
    if (!bar || !root || typeof ResizeObserver === "undefined") return;
    const set = () => root.style.setProperty("--bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [ref]);
}
