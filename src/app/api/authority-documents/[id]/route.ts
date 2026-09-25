// Liefert ein Dokument eines Behördenvorgangs (Schreiben, Nachweis, erzeugte Antwort-PDF) aus dem privaten Speicher –
// nur mit Sitzung desselben Mandanten, keine öffentliche Adresse. Bei Antwort-PDFs wird die Prüfsumme vor der Auslieferung
// geprüft; archivierte Dokumente bleiben abrufbar (Nachvollziehbarkeit).
import { db } from "@/lib/db";
import { apiSession } from "@/lib/auth";
import { sha256 } from "@/lib/integrity";
import { assertKeyBelongsToTenant, getStorage } from "@/lib/storage";

export async function GET(req: Request, ctx: RouteContext<"/api/authority-documents/[id]">) {
  const session = await apiSession("read", "AUTHORITY_DOCUMENT");
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const doc = await db.authorityCaseDocument.findFirst({ where: { id, tenantId: session.tenant.id }, select: { storageKey: true, fileName: true, contentType: true, checksum: true, type: true } });
  if (!doc) return new Response("Nicht gefunden", { status: 404 });
  try {
    assertKeyBelongsToTenant(doc.storageKey, session.tenant.id);
    const object = await getStorage().get(doc.storageKey);
    if (!object) return new Response("Nicht gefunden", { status: 404 });
    if (doc.type === "RESPONSE_PDF" && sha256(object.body) !== doc.checksum) {
      console.error("Antwort-PDF weicht von der Prüfsumme ab:", id);
      return new Response("Das Dokument konnte nicht unverändert gelesen werden", { status: 409 });
    }
    const safeName = doc.fileName.replace(/[^\w.\- ]/g, "_");
    const download = new URL(req.url).searchParams.get("download") === "1";
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": doc.contentType, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"` },
    });
  } catch (e) {
    console.error("Behördendokument konnte nicht geladen werden:", (e as Error).name);
    return new Response("Dokument derzeit nicht verfügbar", { status: 502 });
  }
}
