// Liefert ein Fahrzeugdokument aus dem privaten Speicher – nur mit Sitzung desselben Mandanten, keine öffentliche Adresse.
// Archivierte Dokumente bleiben abrufbar (Nachvollziehbarkeit), werden in der Oberfläche aber als archiviert geführt.
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { assertKeyBelongsToTenant, getStorage } from "@/lib/storage";

export async function GET(req: Request, ctx: RouteContext<"/api/vehicle-documents/[id]">) {
  const session = await getSession();
  if (!session) return new Response("Nicht angemeldet", { status: 401 });
  const { id } = await ctx.params;
  const doc = await db.vehicleDocument.findFirst({ where: { id, tenantId: session.tenant.id }, select: { storageKey: true, fileName: true, contentType: true } });
  if (!doc) return new Response("Nicht gefunden", { status: 404 });
  try {
    assertKeyBelongsToTenant(doc.storageKey, session.tenant.id);
    const object = await getStorage().get(doc.storageKey);
    if (!object) return new Response("Nicht gefunden", { status: 404 });
    const safeName = doc.fileName.replace(/[^\w.\- ]/g, "_");
    const download = new URL(req.url).searchParams.get("download") === "1";
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": doc.contentType, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"` },
    });
  } catch (e) {
    console.error("Fahrzeugdokument konnte nicht geladen werden:", (e as Error).name);
    return new Response("Dokument derzeit nicht verfügbar", { status: 502 });
  }
}
