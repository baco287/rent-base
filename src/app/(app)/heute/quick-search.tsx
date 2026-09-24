"use client";

// Schnellzugriff „Suche“ auf dem Dashboard: löst dasselbe Tastenkürzel aus, das die Seitenleiste abfängt (Strg/Cmd+K).
export function OpenSearchButton() {
  return (
    <button type="button" className="btn" onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))}>
      Suche <kbd className="text-[11px] text-ink-3 font-mono ml-1">Strg K</kbd>
    </button>
  );
}
