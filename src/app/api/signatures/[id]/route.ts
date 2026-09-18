// Liefert das Bild einer Unterschrift. Nur für angemeldete Benutzer desselben Mandanten, nie öffentlich,
// nie im Browser-Cache. Solange der Object Storage nicht angebunden ist, liegen die Bilddaten in der Datenbank.
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function GET(_req: Request, ctx: RouteContext<"/api/signatures/[id]">) {
  const session = await getSession();
  if (!session) return new Response("Nicht angemeldet", { status: 401 });
  const { id } = await ctx.params;

  const signature = await db.signature.findFirst({ where: { id, tenantId: session.tenant.id }, select: { imageData: true } });
  if (!signature?.imageData) return new Response("Nicht gefunden", { status: 404 });

  return new Response(new Uint8Array(signature.imageData), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
