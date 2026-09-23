// Liefert ein archiviertes Dokument aus dem privaten Speicher. Nur für angemeldete Mitarbeiter desselben Mandanten.
// Die Datei läuft über den App-Server: Es gibt keine öffentliche und keine weitergebbare Adresse.
// Vor der Auslieferung wird die gespeicherte Prüfsumme gegen die Datei geprüft.
import { getSession } from "@/lib/auth";
import { DocumentIntegrityError, readDocumentFile } from "@/lib/documents";
import { DomainError } from "@/lib/integrity";

const STAFF_ROLES = ["OWNER", "DISPO", "YARD"];

export async function GET(req: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const session = await getSession();
  if (!session) return new Response("Nicht angemeldet", { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) return new Response("Keine Berechtigung", { status: 403 });
  const { id } = await ctx.params;
  try {
    const file = await readDocumentFile(session.tenant.id, id);
    if (!file) return new Response("Nicht gefunden", { status: 404 });
    const download = new URL(req.url).searchParams.get("download") === "1";
    // Dateinamen entstehen serverseitig aus festen Bausteinen; trotzdem hier noch einmal auf sichere Zeichen begrenzt
    const name = file.document.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(file.body as BodyInit, {
      headers: {
        "Content-Type": file.document.contentType || "application/pdf",
        "Content-Length": String(file.body.length),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    if (e instanceof DocumentIntegrityError) return new Response(e.message, { status: 409 });
    if (e instanceof DomainError) return new Response(e.message, { status: 503 });
    console.error("Dokument konnte nicht geladen werden:", (e as Error).name);
    return new Response("Dokument derzeit nicht verfügbar", { status: 502 });
  }
}
