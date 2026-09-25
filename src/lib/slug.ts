/** Eindeutiger, URL-sicherer Kurzname aus einem Firmennamen. Kollisionen löst der Aufrufer (z. B. Zähler anhängen). */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "vermietung"
  );
}
