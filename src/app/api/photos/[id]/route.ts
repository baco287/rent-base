// Liefert ein Foto aus dem privaten Speicher. Nur für angemeldete Benutzer desselben Mandanten.
// Die Datei wird über den App-Server gereicht: es gibt keine öffentliche und keine weitergebbare Adresse.
import { db } from "@/lib/db";
import { apiSession } from "@/lib/auth";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { removePhoto } from "@/lib/handovers";
import { assertKeyBelongsToTenant, getStorage } from "@/lib/storage";

export async function GET(_req: Request, ctx: RouteContext<"/api/photos/[id]">) {
  const session = await apiSession("read");
  if (session instanceof Response) return session;
  const { id } = await ctx.params;

  const photo = await db.photo.findFirst({ where: { id, tenantId: session.tenant.id }, select: { storageKey: true } });
  if (!photo) return new Response("Nicht gefunden", { status: 404 });
  try {
    assertKeyBelongsToTenant(photo.storageKey, session.tenant.id);
    const object = await getStorage().get(photo.storageKey);
    if (!object) return new Response("Nicht gefunden", { status: 404 });
    return new Response(object.body as BodyInit, {
      headers: { "Content-Type": object.contentType, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
    });
  } catch (e) {
    console.error("Foto konnte nicht geladen werden:", (e as Error).name);
    return new Response("Foto derzeit nicht verfügbar", { status: 502 });
  }
}

/** Löscht ein Foto aus einem Protokollentwurf. Finalisierte Protokolle bleiben unangetastet. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/photos/[id]">) {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  try {
    const key = await removePhoto(session.tenant.id, id);
    await getStorage().remove(key).catch(() => {});
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof DomainError) return Response.json({ error: e.message }, { status: 422 });
    if (isImmutableError(e)) return Response.json({ error: "Das Protokoll ist finalisiert. Fotos können nicht mehr gelöscht werden." }, { status: 409 });
    throw e;
  }
}
