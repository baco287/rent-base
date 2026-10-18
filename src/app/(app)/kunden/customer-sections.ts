// Befehl 29.6: Abschnitte der Kundenfelder (neutrales Modul ohne "use client" – Werte aus einem Client-Modul kämen in einer
// Server-Komponente nur als Client-Referenz an). Der Vertragsassistent erzeugt seine Karten in Schritt 1 aus CONTRACT_CUSTOMER_CARDS;
// zusammen ergeben die Abschnitte genau die Felder von CustomerFields compact (kein Feld fehlt, keins doppelt).
export type CustomerSection = "contact" | "identity" | "license" | "admin";

export const CONTRACT_CUSTOMER_SECTIONS = ["contact", "identity", "license"] as const satisfies readonly CustomerSection[];

export const CONTRACT_CUSTOMER_CARDS = [
  { section: "contact", id: "kunde-kontakt", title: "Kontakt & Anschrift", icon: "user" },
  { section: "identity", id: "kunde-ausweis", title: "Ausweis & Geburtsdaten", icon: "id" },
  { section: "license", id: "kunde-fs", title: "Führerschein", icon: "id" },
] as const satisfies readonly { section: CustomerSection; id: string; title: string; icon: string }[];
