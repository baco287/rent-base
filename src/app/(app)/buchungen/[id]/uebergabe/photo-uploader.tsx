"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const MAX_EDGE = 2000;

/** Verkleinert ein Foto im Browser auf höchstens 2000 px Kantenlänge und wandelt es in JPEG. Spart Datenvolumen auf dem Hof. */
async function downscale(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file; // Browser kann das Format nicht lesen: Original senden, der Server prüft den Typ
  }
}

/**
 * Foto aufnehmen oder auswählen und direkt in den geschützten Speicher hochladen.
 * Auf dem Smartphone öffnet "capture" die Rückkamera. Angezeigt werden Fotos nur über die geschützte Adresse der App.
 */
export function PhotoUploader({
  handoverId,
  category,
  label,
  handoverDamageId,
  photos,
  editable,
  required = false,
  compact = false,
}: {
  handoverId: string;
  category: string;
  label: string;
  handoverDamageId?: string;
  photos: { id: string; url: string }[];
  editable: boolean;
  required?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.set("file", await downscale(file), "foto.jpg");
        body.set("category", category);
        if (handoverDamageId) body.set("handoverDamageId", handoverDamageId);
        const res = await fetch(`/api/handovers/${handoverId}/photos`, { method: "POST", body });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? "Das Foto konnte nicht gespeichert werden.");
        }
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/photos/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Das Foto konnte nicht gelöscht werden.");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const missing = required && photos.length === 0;
  return (
    <div className={`rounded-lg border p-2.5 flex flex-col gap-2 ${missing ? "border-amber bg-amber-soft/40" : "border-line bg-panel"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-[13px]">{label}{required && <span className="text-ink-3 font-normal"> · Pflicht</span>}</span>
        {photos.length > 0 ? <span className="chip bg-good-soft text-good">{photos.length}</span> : missing ? <span className="chip bg-amber-soft text-amber">fehlt</span> : null}
      </div>
      {photos.length > 0 && (
        <div className={`grid gap-2 ${compact ? "grid-cols-3" : "grid-cols-2"}`}>
          {photos.map((p) => (
            <div key={p.id} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={label} loading="lazy" className="w-full aspect-[4/3] object-cover rounded-md border border-line bg-panel-2" />
              {editable && (
                <button type="button" onClick={() => remove(p.id)} disabled={busy} aria-label={`Foto ${label} löschen`} className="absolute top-1 right-1 size-7 rounded-full bg-black/60 text-white text-sm leading-none">
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {editable && (
        <>
          <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => upload(e.target.files)} aria-label={`Foto ${label} aufnehmen`} />
          <button type="button" onClick={() => input.current?.click()} disabled={busy} className="btn justify-center !py-2.5">
            {busy ? "Wird hochgeladen…" : photos.length > 0 ? "Weiteres Foto" : "Foto aufnehmen"}
          </button>
        </>
      )}
      {error && <p role="alert" className="text-bad text-xs">{error}</p>}
    </div>
  );
}
