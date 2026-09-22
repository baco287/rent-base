// Liefert ein Dokument der Schadenakte aus dem privaten Speicher. Nur angemeldete Benutzer desselben Mandanten;
// keine öffentliche und keine weitergebbare Adresse. Dokumente werden nicht gelöscht (Akte ist nur anfügend).
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { assertKeyBelongsToTenant, getStorage } from "@/lib/storage";

export async function GET(_req: Request, ctx: RouteContext<"/api/damage-documents/[id]">) {
  const session = await getSession();
  if (!session) return new Response("Nicht angemeldet", { status: 401 });
  const { id } = await ctx.params;

  const doc = await db.damageCaseDocument.findFirst({ where: { id, tenantId: session.tenant.id }, select: { storageKey: true, fileName: true, contentType: true } });
  if (!doc) return new Response("Nicht gefunden", { status: 404 });
  try {
    assertKeyBelongsToTenant(doc.storageKey, session.tenant.id);
    const object = await getStorage().get(doc.storageKey);
    if (!object) return new Response("Nicht gefunden", { status: 404 });
    const safeName = doc.fileName.replace(/[^\w.\- ]/g, "_");
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": doc.contentType, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="${safeName}"` },
    });
  } catch (e) {
    console.error("Schadendokument konnte nicht geladen werden:", (e as Error).name);
    return new Response("Dokument derzeit nicht verfügbar", { status: 502 });
  }
}
