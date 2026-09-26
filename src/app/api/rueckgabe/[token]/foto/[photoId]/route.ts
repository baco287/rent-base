// Befehl 20.6: eigenes Kundenfoto anzeigen oder vor der Meldung wieder entfernen – nur über den persönlichen Link.
import { DomainError, isImmutableError } from "@/lib/integrity";
import { deleteKeyDropPhoto, readKeyDropPhoto } from "@/lib/key-drop";
import { consume } from "@/lib/rate-limit";

const ipOf = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unbekannt";

export async function GET(req: Request, ctx: RouteContext<"/api/rueckgabe/[token]/foto/[photoId]">) {
  const { token, photoId } = await ctx.params;
  if (!consume(`keydrop-view:${ipOf(req)}`, { limit: 120, windowMs: 10 * 60_000 }).allowed) return new Response("Zu viele Anfragen", { status: 429 });
  const file = await readKeyDropPhoto(token, photoId).catch(() => null);
  if (!file) return new Response("Nicht gefunden", { status: 404 });
  return new Response(file.body as BodyInit, { headers: { "Content-Type": file.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/rueckgabe/[token]/foto/[photoId]">) {
  const { token, photoId } = await ctx.params;
  if (!consume(`keydrop-photo:${ipOf(req)}`, { limit: 40, windowMs: 10 * 60_000 }).allowed) return Response.json({ error: "Zu viele Anfragen." }, { status: 429 });
  try {
    await deleteKeyDropPhoto(token, photoId);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof DomainError) return Response.json({ error: e.message }, { status: 422 });
    if (isImmutableError(e)) return Response.json({ error: "Die Rückgabe ist bereits gemeldet." }, { status: 409 });
    throw e;
  }
}
