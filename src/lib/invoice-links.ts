// Befehl 23.1: Adresse einer Rechnung. Freie Rechnungen (GENERAL) und alle Belege ohne Buchungsbezug liegen unter
// /rechnungen/<id>; alle anderen Rechnungen weiterhin unter ihrer Buchung. Frei von Server-Importen.
export function invoiceHref(i: { id: string; bookingId: string | null; kind?: string | null }): string {
  return i.bookingId && i.kind !== "GENERAL" ? `/buchungen/${i.bookingId}/rechnung?nr=${i.id}` : `/rechnungen/${i.id}`;
}

/** Bezeichnung des Buchungsbezugs für Listen („Buchung 2026-0010“ bzw. „ohne Buchung“). */
export const bookingLabel = (number: string | null | undefined) => (number ? `Buchung ${number}` : "ohne Buchung");
