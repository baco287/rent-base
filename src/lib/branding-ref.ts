// Verweis auf eine unveränderliche Logo-Datei, wie er in Dokument-Snapshots eingefroren wird (Befehl 20.5).
// Bewusst ohne Abhängigkeiten: wird auch von reinen Ansichtsmodellen (contract-view, invoices) verwendet.
export type LogoRef = { key: string; checksum: string };

export function logoRefOf(t: { logoStorageKey?: string | null; logoChecksum?: string | null } | null | undefined): LogoRef | null {
  return t?.logoStorageKey && t.logoChecksum ? { key: t.logoStorageKey, checksum: t.logoChecksum } : null;
}

/** Liest einen Logo-Verweis aus einem Snapshot (ältere Snapshots haben keinen: dann ohne Logo, wie bisher). */
export function logoRefFromSnapshot(snapshot: unknown): LogoRef | null {
  const l = (snapshot as { logo?: unknown } | null)?.logo as Partial<LogoRef> | null | undefined;
  return l && typeof l.key === "string" && typeof l.checksum === "string" ? { key: l.key, checksum: l.checksum } : null;
}
