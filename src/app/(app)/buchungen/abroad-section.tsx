"use client";

// Bereich „Auslandsfahrten“ im Buchungsformular: Genehmigung, konkret genehmigte Länder (nur aus der Freigabeliste des Fahrzeugs)
// und ein EINMALIGER Aufpreis. Nichts wird still korrigiert: nicht mehr freigegebene Länder (z. B. nach Fahrzeugwechsel) bleiben
// sichtbar markiert, bis sie bewusst entfernt werden. Der Server prüft beim Speichern erneut (lib/abroad.ts).
import { countryName } from "@/lib/abroad";

export type AbroadState = { on: boolean; countries: string[]; surcharge: string };

export function AbroadSection({ value, onChange, vehicle, legacy, error }: {
  value: AbroadState;
  onChange: (v: AbroadState) => void;
  /** Freigabe für das gewählte Fahrzeug; null = noch kein Fahrzeug */
  vehicle: { plate: string; possible: boolean; countries: string[] } | null;
  /** bestehende Buchung ohne Festlegung (vor dieser Funktion): ohne Häkchen bestimmt weiterhin der Mietvertrag */
  legacy: boolean;
  /** Prüfmeldung zum Aufpreis (Format, Grenze) */
  error: string | null;
}) {
  const allowed = vehicle?.countries ?? [];
  const outside = value.countries.filter((c) => !allowed.includes(c));
  const toggle = (c: string, checked: boolean) => onChange({ ...value, countries: checked ? [...new Set([...value.countries, c])] : value.countries.filter((x) => x !== c) });
  return (
    <fieldset className="md:col-span-2 rounded-lg border border-line p-4 flex flex-col gap-3">
      <legend className="label-xs px-1">Auslandsfahrten</legend>
      <input type="hidden" name="abroadSection" value="1" />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="abroadAllowed" value="1" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} disabled={!value.on && (!vehicle || !vehicle.possible)} className="size-4" />
        Auslandsfahrten gestattet
      </label>
      {!vehicle && <p className="text-xs text-ink-3">Bitte zuerst ein Fahrzeug wählen – dann erscheinen die freigegebenen Länder.</p>}
      {vehicle && !vehicle.possible && (
        <p className={`text-xs ${value.on ? "text-bad bg-bad-soft rounded-md px-3 py-2" : "text-ink-3"}`} role={value.on ? "alert" : undefined}>
          Für {vehicle.plate} sind nach den Geschäftsregeln des Vermieters keine Auslandsfahrten vorgesehen (Einstellung durch den Inhaber).{value.on ? " Bitte das Häkchen entfernen." : ""}
        </p>
      )}
      {legacy && !value.on && <p className="text-xs text-ink-3">Bisher legt der Mietvertrag die Auslandsfahrt fest. Ohne Häkchen bleibt es dabei.</p>}
      {legacy && value.on && <p role="status" className="text-xs text-amber bg-amber-soft rounded-md px-3 py-2">Ab dem Speichern legt die Buchung die Auslandsfahrt fest (Genehmigung, Länder, Aufpreis). Ein vorhandener Vertragsentwurf wird angepasst; dort bereits geleistete Unterschriften verfallen und werden erneut eingeholt.</p>}
      {value.on && (
        <div className="flex flex-col gap-3 pl-6">
          <div className="flex flex-col gap-1.5">
            <span className="label-xs">Genehmigte Länder</span>
            {allowed.length > 0 ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                {allowed.map((c) => (
                  <label key={c} className="flex items-center gap-1.5"><input type="checkbox" name="abroadCountries" value={c} checked={value.countries.includes(c)} onChange={(e) => toggle(c, e.target.checked)} className="size-4" /> {countryName(c)}</label>
                ))}
              </div>
            ) : (
              vehicle && vehicle.possible && <p className="text-xs text-ink-3">Für dieses Fahrzeug ist kein Land freigegeben.</p>
            )}
            {outside.length > 0 && (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-bad bg-bad-soft rounded-md px-3 py-2">
                <span>Nicht in der Freigabeliste{vehicle ? ` für ${vehicle.plate}` : ""}:</span>
                {outside.map((c) => (
                  <span key={c} className="chip bg-panel text-bad inline-flex items-center gap-1">
                    <input type="hidden" name="abroadCountries" value={c} />
                    {countryName(c)}
                    <button type="button" onClick={() => toggle(c, false)} className="underline">entfernen</button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <label className="flex flex-col gap-1 sm:max-w-xs">
            <span className="label-xs">Auslandsfahrt-Aufpreis (€)</span>
            <input name="abroadSurcharge" inputMode="decimal" value={value.surcharge} onChange={(e) => onChange({ ...value, surcharge: e.target.value })} placeholder="0,00" required className="input tnum" aria-describedby="abroad-surcharge-hint" />
          </label>
          {error && <p role="alert" className="text-xs text-bad bg-bad-soft rounded-md px-3 py-2">{error}</p>}
          <p id="abroad-surcharge-hint" className="text-xs text-ink-3">Einmaliger Aufpreis für die genehmigte Auslandsfahrt – kommt einmalig zum Mietpreis hinzu, auch zu einem individuell vereinbarten. Nicht je Land oder Miettag, kein Rabatt, nicht Teil der Kaution. 0,00 € ist zulässig.</p>
        </div>
      )}
    </fieldset>
  );
}
