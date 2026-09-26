// Befehl 20.6: Logo des Vermieters auf der Kundenseite – nur mit gültigem Rückgabelink, nur das Logo dieses Vermieters.
import { currentLogo } from "@/lib/branding";
import { resolveKeyDropToken } from "@/lib/key-drop";

export async function GET(_req: Request, ctx: RouteContext<"/api/rueckgabe/[token]/logo">) {
  const { token } = await ctx.params;
  const r = await resolveKeyDropToken(token);
  if (!r) return new Response("Nicht gefunden", { status: 404 });
  const logo = await currentLogo(r.kd.tenantId);
  if (!logo) return new Response("Nicht gefunden", { status: 404 });
  return new Response(logo as BodyInit, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
}
