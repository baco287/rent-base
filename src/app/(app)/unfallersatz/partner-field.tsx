"use client";

// Befehl 29: Name eines Geschäftspartners (Versicherung, Werkstatt, Kanzlei) mit Vorschlägen aus dem Adressbuch – gemeinsam für den
// Anlage-Wizard (Phase C) und die Fallakte (Phase D). Auswahl füllt die übrigen Felder; ein geänderter Name ist ein anderer Partner.

import { useState } from "react";
import type { PartnerOption } from "@/lib/business-partners";

export type PartnerState = { partnerId: string; name: string; contactName: string; phone: string; email: string; street: string; zip: string; city: string };
export const emptyPartner: PartnerState = { partnerId: "", name: "", contactName: "", phone: "", email: "", street: "", zip: "", city: "" };

export type PartnerErrProps = { inv?: (f: string) => object; invCls?: (f: string) => string; err?: (f: string) => string | undefined };

/** Name eines Partners mit Vorschlägen aus dem Adressbuch. Auswahl füllt die übrigen Felder; ein geänderter Name ist ein neuer Eintrag. */
export function PartnerName({ kind, label, options, value, onChange, required, inv = () => ({}), invCls = () => "", err = () => undefined }: { kind: "insurer" | "workshop" | "lawyer"; label: string; options: PartnerOption[]; value: PartnerState; onChange: (p: PartnerState) => void; required?: boolean } & PartnerErrProps) {
  const [open, setOpen] = useState(false);
  const nameField = kind === "lawyer" ? "lawyerFirm" : `${kind}Name`;
  const listId = `${nameField}-vorschlaege`;
  const q = value.name.trim().toLowerCase();
  const hits = options.filter((o) => !q || o.name.toLowerCase().includes(q)).slice(0, 8);
  return (
    <div className="flex flex-col gap-1 min-w-0 relative md:col-span-2" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <label htmlFor={nameField} className="label-xs">{label}{required && <span className="text-bad"> *</span>}{value.partnerId && <span className="chip bg-panel-2 text-ink-2 ml-1.5 normal-case">aus dem Adressbuch</span>}</label>
      <input type="hidden" name={`${kind}PartnerId`} value={value.partnerId} />
      <input id={nameField} name={nameField} value={value.name} autoComplete="off" role="combobox" aria-controls={listId} aria-expanded={open && hits.length > 0} aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        // anderer Name nach Auswahl aus dem Adressbuch = anderer Partner: übernommene Kontaktdaten nicht mitschleppen
        onChange={(e) => { onChange(value.partnerId ? { ...emptyPartner, name: e.target.value } : { ...value, name: e.target.value }); setOpen(true); }}
        // Enter schickt das Formular ab – die Vorschlagsliste darf danach nicht offen stehen bleiben
        onKeyDown={(e) => { if (e.key === "Escape" || e.key === "Enter") setOpen(false); }}
        placeholder={options.length ? "Name eingeben oder aus dem Adressbuch wählen" : "Name eingeben"}
        className={`input${invCls(nameField)}`} {...inv(nameField)} />
      {open && hits.length > 0 && (
        <ul id={listId} role="listbox" className="absolute top-full left-0 right-0 mt-1 z-20 card max-h-64 overflow-y-auto py-1 shadow-lg">
          {hits.map((o) => (
            <li key={o.id}>
              {/* Safari/Firefox (macOS) fokussieren Knöpfe nicht: ohne preventDefault schließt der Blur die Liste vor dem Klick */}
              <button type="button" role="option" aria-selected={o.id === value.partnerId} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange({ partnerId: o.id, name: o.name, contactName: o.contactName, phone: o.phone, email: o.email, street: o.street, zip: o.zip, city: o.city }); setOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-panel-2 flex flex-col min-w-0">
                <span className="font-medium break-words">{o.name}</span>
                {(o.contactName || o.city || o.phone) && <span className="text-xs text-ink-3 truncate">{[o.contactName, o.city, o.phone].filter(Boolean).join(" · ")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {err(nameField) && <span id={`err-${nameField}`} className="text-xs text-bad">{err(nameField)}</span>}
    </div>
  );
}
