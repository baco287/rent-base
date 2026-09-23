// Dokumenterkennung für Behördenschreiben – Adapter-Schnittstelle. In dieser Ausbaustufe gibt es keinen aktiven Extraktor:
// Im Stack ist keine OCR-Bibliothek vorhanden, und eine externe OCR-Cloud kommt ohne ausdrückliche Entscheidung nicht in
// Frage (Kundendaten, Behördenschreiben). Die Erfassung ist manuell; jedes spätere Ergebnis eines Extraktors ist nur ein
// „erkannter Vorschlag“, den der Mitarbeiter bestätigt oder korrigiert – nie automatisch verbindlich.

export type ExtractionSuggestion = {
  authorityName?: string;
  authorityReference?: string;
  licensePlate?: string;
  offenseDate?: string; // JJJJ-MM-TT
  offenseTime?: string; // HH:MM
  offenseLocation?: string;
  responseDeadline?: string; // JJJJ-MM-TT
  noticeAmount?: string;
  portalUrl?: string;
  /** 0..1, nur Anhaltspunkt für die Oberfläche */
  confidence?: number;
};

export interface DocumentExtractor {
  readonly name: string;
  /** Liefert Vorschläge oder null, wenn nichts erkannt werden konnte. Wirft nie. */
  extract(bytes: Uint8Array, contentType: string): Promise<ExtractionSuggestion | null>;
}

/** Kein Extraktor aktiv: manuelle Erfassung. */
export const noopExtractor: DocumentExtractor = {
  name: "manual",
  async extract() {
    return null;
  },
};

let active: DocumentExtractor = noopExtractor;

export function getDocumentExtractor(): DocumentExtractor {
  return active;
}

/** Nur für Tests oder eine spätere, bewusst eingebundene lokale Erkennung. */
export function setDocumentExtractor(extractor: DocumentExtractor | null) {
  active = extractor ?? noopExtractor;
}
