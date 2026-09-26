"use client";

import { useState } from "react";
import { COUNTRIES, CUSTOMER_TYPES, ID_TYPES } from "@/lib/constants";
import { Field } from "@/components/ui";

export type CustomerFormValues = {
  type: string;
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  birthDate: string;
  birthPlace: string;
  nationality: string;
  idType: string;
  idNumber: string;
  idIssuedBy: string;
  idIssuedAt: string;
  idValidUntil: string;
  licenseNumber: string;
  licenseClass: string;
  licenseIssuedBy: string;
  licenseIssuedAt: string;
  licenseValidUntil: string;
  blocked: boolean;
  blockReason: string;
  discountPercent: string;
  notes: string;
  legacyNumber: string;
};

export const emptyCustomer: CustomerFormValues = {
  type: "PRIVATE", companyName: "", firstName: "", lastName: "", email: "", phone: "", street: "", zip: "", city: "", country: "DE",
  birthDate: "", birthPlace: "", nationality: "deutsch", idType: "PERSONALAUSWEIS", idNumber: "", idIssuedBy: "", idIssuedAt: "", idValidUntil: "",
  licenseNumber: "", licenseClass: "B", licenseIssuedBy: "", licenseIssuedAt: "", licenseValidUntil: "",
  blocked: false, blockReason: "", discountPercent: "0", notes: "", legacyNumber: "",
};

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="md:col-span-2 text-base font-semibold mt-2">{children}</h2>;
}

/**
 * Eingabefelder für einen Kunden. Wird im Kundenformular und im Buchungsformular (Kunde direkt anlegen) verwendet.
 * prefix: Feldnamen-Präfix, z. B. "c_" in der Buchung, damit sich Namen nicht überschneiden.
 * compact: ohne Sperre, Rabatt und Notizen (für die Buchung).
 */
export function CustomerFields({ values, prefix = "", compact = false, disabled = false }: { values: CustomerFormValues; prefix?: string; compact?: boolean; disabled?: boolean }) {
  const [type, setType] = useState(values.type);
  const [blocked, setBlocked] = useState(values.blocked);
  const v = values;
  const n = (name: string) => `${prefix}${name}`;

  return (
    <fieldset disabled={disabled} className="contents">
      <H>Kunde</H>
      <Field label="Kundenart" htmlFor={n("type")}>
        <select id={n("type")} name={n("type")} value={type} onChange={(e) => setType(e.target.value)} className="input">
          {Object.entries(CUSTOMER_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      {type === "COMPANY" ? (
        <Field label="Firmenname" htmlFor={n("companyName")}>
          <input id={n("companyName")} name={n("companyName")} defaultValue={v.companyName} required className="input" />
        </Field>
      ) : (
        <div className="hidden md:block" />
      )}
      <Field label={type === "COMPANY" ? "Ansprechpartner / Fahrer Vorname" : "Vorname"} htmlFor={n("firstName")}>
        <input id={n("firstName")} name={n("firstName")} defaultValue={v.firstName} required className="input" autoComplete="off" />
      </Field>
      <Field label={type === "COMPANY" ? "Ansprechpartner / Fahrer Nachname" : "Nachname"} htmlFor={n("lastName")}>
        <input id={n("lastName")} name={n("lastName")} defaultValue={v.lastName} required className="input" autoComplete="off" />
      </Field>
      <Field label="Telefon" htmlFor={n("phone")}>
        <input id={n("phone")} name={n("phone")} type="tel" defaultValue={v.phone} className="input" />
      </Field>
      <Field label="E-Mail" htmlFor={n("email")}>
        <input id={n("email")} name={n("email")} type="email" defaultValue={v.email} className="input" />
      </Field>
      <Field label="Straße und Hausnummer" htmlFor={n("street")} full>
        <input id={n("street")} name={n("street")} defaultValue={v.street} className="input" />
      </Field>
      <Field label="PLZ" htmlFor={n("zip")}>
        <input id={n("zip")} name={n("zip")} defaultValue={v.zip} className="input" inputMode="numeric" />
      </Field>
      <Field label="Ort" htmlFor={n("city")}>
        <input id={n("city")} name={n("city")} defaultValue={v.city} className="input" />
      </Field>
      <Field label="Land" htmlFor={n("country")}>
        <select id={n("country")} name={n("country")} defaultValue={v.country || "DE"} className="input">
          {Object.entries(COUNTRIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <div className="hidden md:block" />

      <H>Ausweis</H>
      <Field label="Geburtsdatum" htmlFor={n("birthDate")}>
        <input id={n("birthDate")} name={n("birthDate")} type="date" defaultValue={v.birthDate} className="input" />
      </Field>
      <Field label="Geburtsort" htmlFor={n("birthPlace")}>
        <input id={n("birthPlace")} name={n("birthPlace")} defaultValue={v.birthPlace} className="input" />
      </Field>
      <Field label="Staatsangehörigkeit" htmlFor={n("nationality")}>
        <input id={n("nationality")} name={n("nationality")} defaultValue={v.nationality} className="input" />
      </Field>
      <Field label="Ausweisart" htmlFor={n("idType")}>
        <select id={n("idType")} name={n("idType")} defaultValue={v.idType} className="input">
          <option value="">Nicht erfasst</option>
          {Object.entries(ID_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Ausweisnummer" htmlFor={n("idNumber")}>
        <input id={n("idNumber")} name={n("idNumber")} defaultValue={v.idNumber} className="input font-mono uppercase" autoComplete="off" />
      </Field>
      <Field label="Ausstellende Behörde" htmlFor={n("idIssuedBy")}>
        <input id={n("idIssuedBy")} name={n("idIssuedBy")} defaultValue={v.idIssuedBy} className="input" placeholder="z. B. Stadt Bremen" />
      </Field>
      <Field label="Ausgestellt am" htmlFor={n("idIssuedAt")}>
        <input id={n("idIssuedAt")} name={n("idIssuedAt")} type="date" defaultValue={v.idIssuedAt} className="input" />
      </Field>
      <Field label="Gültig bis" htmlFor={n("idValidUntil")}>
        <input id={n("idValidUntil")} name={n("idValidUntil")} type="date" defaultValue={v.idValidUntil} className="input" />
      </Field>

      <H>Führerschein</H>
      <Field label="Führerscheinnummer" htmlFor={n("licenseNumber")}>
        <input id={n("licenseNumber")} name={n("licenseNumber")} defaultValue={v.licenseNumber} className="input font-mono uppercase" autoComplete="off" />
      </Field>
      <Field label="Klasse" htmlFor={n("licenseClass")}>
        <input id={n("licenseClass")} name={n("licenseClass")} defaultValue={v.licenseClass} className="input" placeholder="B" />
      </Field>
      <Field label="Ausstellende Behörde" htmlFor={n("licenseIssuedBy")}>
        <input id={n("licenseIssuedBy")} name={n("licenseIssuedBy")} defaultValue={v.licenseIssuedBy} className="input" />
      </Field>
      <Field label="Ausgestellt am" htmlFor={n("licenseIssuedAt")} hint="Wichtig für Fahranfänger-Regeln">
        <input id={n("licenseIssuedAt")} name={n("licenseIssuedAt")} type="date" defaultValue={v.licenseIssuedAt} className="input" />
      </Field>
      <Field label="Gültig bis" htmlFor={n("licenseValidUntil")}>
        <input id={n("licenseValidUntil")} name={n("licenseValidUntil")} type="date" defaultValue={v.licenseValidUntil} className="input" />
      </Field>

      {!compact && (
        <>
          <H>Konditionen, Sperre und Notizen</H>
          <Field label="Rabatt in %" htmlFor={n("discountPercent")} hint="Für Stammkunden, wird bei Buchungen abgezogen">
            <input id={n("discountPercent")} name={n("discountPercent")} type="number" min={0} max={100} defaultValue={v.discountPercent} className="input tnum" />
          </Field>
          <Field label="Alte Kundennummer" htmlFor={n("legacyNumber")} hint="Nur Referenz, z. B. aus der Vorsoftware">
            <input id={n("legacyNumber")} name={n("legacyNumber")} defaultValue={v.legacyNumber} className="input font-mono" autoComplete="off" />
          </Field>
          <div className="md:col-span-2 flex items-center gap-2">
            <input id={n("blocked")} name={n("blocked")} type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} className="size-4" />
            <label htmlFor={n("blocked")} className="font-medium">Kunde gesperrt, keine neuen Buchungen möglich</label>
          </div>
          {blocked && (
            <Field label="Grund der Sperre" htmlFor={n("blockReason")} full>
              <input id={n("blockReason")} name={n("blockReason")} defaultValue={v.blockReason} className="input" placeholder="z. B. Schaden nicht bezahlt" />
            </Field>
          )}
          <Field label="Notizen" htmlFor={n("notes")} full>
            <textarea id={n("notes")} name={n("notes")} defaultValue={v.notes} rows={3} className="input" />
          </Field>
        </>
      )}
    </fieldset>
  );
}
