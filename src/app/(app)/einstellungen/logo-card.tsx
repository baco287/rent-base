"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Logo hochladen/ersetzen/entfernen (nur Inhaber). Die Vorschau lädt das Logo des eigenen Mandanten über die geschützte Adresse. */
export function LogoManager({ hasLogo, version, canEdit }: { hasLogo: boolean; version: string; canEdit: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("file", file);
    const res = await fetch("/api/branding/logo", { method: "POST", body: fd });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) { setError(body.error ?? "Das Logo konnte nicht gespeichert werden."); return; }
    router.refresh();
  }

  async function remove() {
    if (!confirm("Logo entfernen? Bereits erzeugte Dokumente behalten ihr Logo.")) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/branding/logo", { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { setError("Das Logo konnte nicht entfernt werden."); return; }
    router.refresh();
  }

  return (
    <div className="p-5 flex flex-col gap-3 text-sm">
      <div className="rounded-md border border-line bg-panel-2 flex items-center justify-center h-28 px-4 overflow-hidden">
        {hasLogo
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={`/api/branding/logo?v=${encodeURIComponent(version)}`} alt="Firmenlogo" className="max-h-20 max-w-full object-contain" />
          : <span className="text-ink-3">Noch kein Logo hinterlegt</span>}
      </div>
      <p className="text-xs text-ink-3">Erscheint auf neuen Verträgen, Protokollen, Rechnungen und Belegen sowie in geschäftlichen E-Mails. PNG, JPEG oder WebP, höchstens 2 MB. Bereits erzeugte Dokumente bleiben unverändert.</p>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
          <button type="button" disabled={busy} className="btn btn-primary" onClick={() => input.current?.click()}>{busy ? "Bitte warten…" : hasLogo ? "Logo ersetzen" : "Logo hochladen"}</button>
          {hasLogo && <button type="button" disabled={busy} className="btn" onClick={() => void remove()}>Logo entfernen</button>}
        </div>
      )}
      {error && <p className="text-bad bg-bad-soft rounded-md px-3 py-2">{error}</p>}
    </div>
  );
}
