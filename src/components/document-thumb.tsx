"use client";

// Miniaturansicht einer Fahrer-Dokumentkopie mit Klick-Vorschau (Lightbox). Liefert das Bild über die geschützte,
// mandantengebundene Adresse /api/driver-documents/[id] – keine öffentliche, keine weitergebbare Adresse.
import { useState } from "react";

export function DocumentThumb({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block shrink-0 rounded-md overflow-hidden border border-line h-12 w-16 bg-panel-2" aria-label={`${label} vergrößern`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/driver-documents/${id}`} alt={label} className="h-full w-full object-cover" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setOpen(false)} role="dialog" aria-modal="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/driver-documents/${id}`} alt={label} className="max-h-[90vh] max-w-[90vw] rounded-md object-contain" />
          <button type="button" onClick={() => setOpen(false)} className="btn !absolute top-4 right-4 !bg-white">Schließen</button>
        </div>
      )}
    </>
  );
}
