"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { SignaturePad } from "@/components/signature-pad";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { confirmKeyDropAction, type CustomerState } from "./actions";

type Props = {
  token: string;
  v: {
    energy: { fuel: boolean; battery: boolean };
    location: string;
    requestedPhotos: { category: string; label: string }[];
    photos: { id: string; category: string; categoryLabel: string }[];
    now: string;
    confirmationText: string;
    notInspectionText: string;
    renterName: string;
  };
};

const PHOTO_OPTIONS: [string, string][] = [["FRONT", "Vorne"], ["REAR", "Hinten"], ["LEFT", "Links"], ["RIGHT", "Rechts"], ["ODOMETER", "Kilometerstand"], ["FUEL", "Tank / Batterie"], ["DAMAGE", "Schaden"]];

/** Kundenmeldung der kontaktlosen Rückgabe (mobil). Fotos werden sofort über den Link hochgeladen, die Meldung einmalig bestätigt. */
export function KeyDropCustomerForm({ token, v }: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<CustomerState, FormData>(async (prev, fd) => { const r = await confirmKeyDropAction(token, prev, fd); if (r?.ok) router.refresh(); return r; }, undefined);
  const [photos, setPhotos] = useState(v.photos);
  const [uploading, setUploading] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [locationOk, setLocationOk] = useState(true);
  const [damages, setDamages] = useState<"" | "yes" | "no">("");

  async function upload(category: string, file: File) {
    setUploading(category);
    setPhotoError(null);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("category", category);
    const res = await fetch(`/api/rueckgabe/${token}/foto`, { method: "POST", body: fd });
    const body = (await res.json().catch(() => ({}))) as { id?: string; category?: string; error?: string };
    setUploading(null);
    if (!res.ok || !body.id) { setPhotoError(body.error ?? "Das Foto konnte nicht hochgeladen werden."); return; }
    setPhotos((p) => [...p, { id: body.id!, category, categoryLabel: PHOTO_OPTIONS.find(([k]) => k === category)?.[1] ?? category }]);
  }
  async function remove(id: string) {
    const res = await fetch(`/api/rueckgabe/${token}/foto/${id}`, { method: "DELETE" });
    if (res.ok) setPhotos((p) => p.filter((x) => x.id !== id));
  }

  const wanted = new Set(v.requestedPhotos.map((p) => p.category));
  return (
    <form onSubmit={submitWithoutReset(formAction)} className="flex flex-col gap-4">
      <section className="card p-4 flex flex-col gap-3 text-sm">
        <h2 className="font-semibold">1. Fahrzeug abgestellt</h2>
        <label className="flex flex-col gap-1"><span className="label-xs">Wann haben Sie das Fahrzeug abgestellt?</span><input name="dropOffAt" type="datetime-local" required defaultValue={v.now} className="input" /></label>
        <label className="flex flex-col gap-1"><span className="label-xs">Kilometerstand</span><input name="mileage" inputMode="numeric" required className="input tnum !text-lg" placeholder="z. B. 52140" /></label>
        {v.energy.fuel && (
          <label className="flex flex-col gap-1"><span className="label-xs">Tankstand</span>
            <select name="fuelEighths" required defaultValue="" className="input"><option value="" disabled>Bitte wählen</option>{Array.from({ length: 9 }, (_, n) => <option key={n} value={n}>{n === 0 ? "leer" : n === 8 ? "voll" : `${n}/8`}</option>)}</select>
          </label>
        )}
        {v.energy.battery && <label className="flex flex-col gap-1"><span className="label-xs">Batteriestand in %</span><input name="batteryPercent" inputMode="numeric" required className="input tnum" placeholder="z. B. 65" /></label>}
        <fieldset className="flex flex-col gap-1.5"><legend className="label-xs mb-1">Abstellort</legend>
          <label className="flex items-start gap-2"><input type="radio" name="locationConfirmed" value="yes" defaultChecked onChange={() => setLocationOk(true)} className="mt-1" /><span>Wie vereinbart: {v.location}</span></label>
          <label className="flex items-start gap-2"><input type="radio" name="locationConfirmed" value="no" onChange={() => setLocationOk(false)} className="mt-1" /><span>An einem anderen Ort</span></label>
          {!locationOk && <input name="locationNote" required maxLength={300} className="input" placeholder="Wo steht das Fahrzeug?" />}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5"><legend className="label-xs mb-1">Sind Ihnen neue Schäden bekannt?</legend>
          <div className="flex gap-4"><label className="flex items-center gap-2"><input type="radio" name="newDamages" value="no" required onChange={() => setDamages("no")} />Nein</label><label className="flex items-center gap-2"><input type="radio" name="newDamages" value="yes" onChange={() => setDamages("yes")} />Ja</label></div>
          {damages === "yes" && <textarea name="damageNote" required rows={3} maxLength={1000} className="input" placeholder="Bitte kurz beschreiben (Ort, Art)" />}
        </fieldset>
        <label className="flex flex-col gap-1"><span className="label-xs">Bemerkung (optional)</span><textarea name="remark" rows={2} maxLength={1000} className="input" /></label>
      </section>

      <section className="card p-4 flex flex-col gap-3 text-sm">
        <h2 className="font-semibold">2. Fotos (empfohlen)</h2>
        <p className="text-xs text-ink-3">Fotos helfen, den Zustand bei der Abgabe festzuhalten. Sie werden sofort sicher übertragen.</p>
        <div className="grid grid-cols-2 gap-2">
          {PHOTO_OPTIONS.map(([key, label]) => (
            <label key={key} className={`btn !justify-start !text-left cursor-pointer ${wanted.has(key) ? "" : "opacity-80"}`}>
              <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={uploading !== null} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(key, f); }} />
              {uploading === key ? "Wird hochgeladen…" : `${label}${photos.some((p) => p.category === key) ? " ✓" : ""}`}
            </label>
          ))}
        </div>
        {photoError && <p className="text-bad bg-bad-soft rounded-md px-3 py-2">{photoError}</p>}
        {photos.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {photos.map((p) => (
              <div key={p.id} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/rueckgabe/${token}/foto/${p.id}`} alt={p.categoryLabel} className="aspect-[4/3] w-full object-cover rounded-md border border-line" />
                <div className="flex items-center justify-between gap-1 text-xs"><span className="truncate">{p.categoryLabel}</span><button type="button" onClick={() => void remove(p.id)} className="text-bad underline">Entfernen</button></div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-4 flex flex-col gap-3 text-sm">
        <h2 className="font-semibold">3. Bestätigung</h2>
        <label className="flex items-start gap-2"><input type="checkbox" name="accepted" required className="mt-1" /><span>{v.confirmationText}</span></label>
        <p className="rounded-md bg-panel-2 px-3 py-2 text-ink-2">{v.notInspectionText}</p>
        <label className="flex flex-col gap-1"><span className="label-xs">Ihr Name</span><input name="signerName" required defaultValue={v.renterName} className="input" autoComplete="name" /></label>
        <SignaturePad name="signature" label="Unterschrift" onChange={setHasInk} />
        {state?.error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2">{state.error}</p>}
        <button type="submit" disabled={pending || !hasInk} className="btn btn-primary !py-3">{pending ? "Wird gesendet…" : "Rückgabe verbindlich melden"}</button>
        <p className="text-xs text-ink-3">Nach dem Absenden können die Angaben nicht mehr geändert werden. Sie erhalten eine Eingangsbestätigung per E-Mail.</p>
      </section>
    </form>
  );
}
