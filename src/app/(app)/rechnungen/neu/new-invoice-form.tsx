"use client";

// Befehl 23.1: Rechnungsempfänger wählen (bestehender Kunde, serverseitige Suche) und optional eine Buchung als Bezug.
import { useActionState, useState, useTransition } from "react";
import { CustomerPicker } from "../../buchungen/customer-picker";
import type { CustomerOption } from "../../buchungen/booking-form";
import { createFreeInvoiceAction, customerBookingsAction, type CustomerBookingOption, type FreeInvoiceState } from "../actions";

export function NewInvoiceForm({ nonce, initialCustomer, initialBookings }: { nonce: string; initialCustomer: CustomerOption | null; initialBookings: CustomerBookingOption[] | null }) {
  const [state, formAction, pending] = useActionState<FreeInvoiceState, FormData>(createFreeInvoiceAction, undefined);
  const [customer, setCustomer] = useState<CustomerOption | null>(initialCustomer);
  const [bookings, setBookings] = useState<CustomerBookingOption[] | null>(initialBookings);
  const [error, setError] = useState<string | null>(null);
  const [loading, start] = useTransition();
  const pick = (c: CustomerOption | null) => {
    setCustomer(c); setBookings(null); setError(null);
    if (!c) return;
    start(async () => {
      const res = await customerBookingsAction(c.id);
      if ("error" in res) setError(res.error); else setBookings(res);
    });
  };
  return (
    <form action={formAction} className="p-4 sm:p-5 flex flex-col gap-4">
      <input type="hidden" name="nonce" value={nonce} />
      <div className="flex flex-col gap-1.5">
        <span className="label-xs">Rechnungsempfänger (Kunde)</span>
        <CustomerPicker value={customer} onChange={pick} allowBlocked />
        <span className="text-xs text-ink-3">Anschrift und Kundennummer werden aus dem Kundenstamm übernommen und beim Abschluss der Rechnung versiegelt.</span>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="label-xs">Buchungsbezug (optional)</span>
        <select name="bookingId" disabled={!customer || loading} className="input" defaultValue="">
          <option value="">Kein Buchungsbezug</option>
          {(bookings ?? []).map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
        <span className="text-xs text-ink-3">{!customer ? "Erst den Kunden wählen." : loading ? "Buchungen werden geladen…" : bookings && bookings.length === 0 ? "Dieser Kunde hat keine Buchungen." : "Nur zur Zuordnung: es werden keine Mietpositionen übernommen, Kaution und Buchung bleiben unverändert."}</span>
      </label>
      {(error || state?.error) && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{error ?? state?.error}</p>}
      <div className="flex flex-col sm:flex-row gap-2">
        <button disabled={!customer || pending} className="btn btn-primary !py-2.5 justify-center">{pending ? "Entwurf wird angelegt…" : "Rechnungsentwurf anlegen"}</button>
      </div>
      <p className="text-xs text-ink-3">Danach Positionen und Zahlungsziel erfassen. Eine Nummer erhält die Rechnung erst beim Abschluss.</p>
    </form>
  );
}
