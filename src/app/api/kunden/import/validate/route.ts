// Prüflauf: validiert die zugeordneten Zeilen wie bei der Kundenanlage und meldet Fehler/mögliche Dubletten,
// ohne etwas zu speichern. Dieselbe Logik wie /commit (processImportRows), nur ohne Schreiben.
import { apiSession } from "@/lib/auth";
import { IMPORT_MAX_ROWS, processImportRows, type ImportRowInput } from "@/lib/customer-import";

export async function POST(req: Request) {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  if (session.user.role !== "OWNER") return Response.json({ error: "Nur Inhaber können Kunden importieren." }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { rows?: ImportRowInput[] } | null;
  if (!body?.rows || !Array.isArray(body.rows)) return Response.json({ error: "Keine Zeilen übermittelt." }, { status: 400 });
  if (body.rows.length === 0) return Response.json({ error: "Keine Zeilen übermittelt." }, { status: 400 });
  if (body.rows.length > IMPORT_MAX_ROWS) return Response.json({ error: `Zu viele Zeilen (maximal ${IMPORT_MAX_ROWS}).` }, { status: 422 });

  const { results } = await processImportRows(session.tenant.id, body.rows, { commit: false });
  return Response.json({ results });
}
