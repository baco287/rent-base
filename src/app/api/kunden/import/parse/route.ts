// Liest die hochgeladene Datei (CSV/Excel) serverseitig ein und liefert Kopfzeile, Zeilen und einen Vorschlag für die
// Spaltenzuordnung zurück. Nur OWNER, da ein Massenimport weitreichend ist. Kein dauerhafter Upload: die Datei wird
// nur für diese Anfrage geparst, nichts wird gespeichert.
import { apiSession } from "@/lib/auth";
import { IMPORT_FIELDS, IMPORT_MAX_FILE_BYTES, IMPORT_MAX_ROWS, parseImportFile, suggestColumnMapping } from "@/lib/customer-import";

export async function POST(req: Request) {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  if (session.user.role !== "OWNER") return Response.json({ error: "Nur Inhaber können Kunden importieren." }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Bitte eine Datei auswählen." }, { status: 400 });
  if (file.size === 0) return Response.json({ error: "Die Datei ist leer." }, { status: 422 });
  if (file.size > IMPORT_MAX_FILE_BYTES) return Response.json({ error: "Die Datei ist zu groß (maximal 15 MB)." }, { status: 422 });

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sheet = await parseImportFile(bytes, file.name);
    if (sheet.headers.length === 0) return Response.json({ error: "Die Datei enthält keine erkennbaren Spalten." }, { status: 422 });
    if (sheet.rows.length === 0) return Response.json({ error: "Die Datei enthält außer der Kopfzeile keine Daten." }, { status: 422 });
    if (sheet.rows.length > IMPORT_MAX_ROWS) return Response.json({ error: `Zu viele Zeilen (${sheet.rows.length}). Bitte auf maximal ${IMPORT_MAX_ROWS} pro Datei aufteilen.` }, { status: 422 });
    return Response.json({ headers: sheet.headers, rows: sheet.rows, suggestedMapping: suggestColumnMapping(sheet.headers), fields: IMPORT_FIELDS });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Die Datei konnte nicht gelesen werden." }, { status: 422 });
  }
}
