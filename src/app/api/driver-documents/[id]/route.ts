// Liefert oder löscht eine Fahrer-Dokumentkopie aus dem privaten Speicher (Phase 19.5). Nur für angemeldete
// Mitarbeiter desselben Mandanten; keine öffentliche, keine weitergebbare Adresse. Löschen entfernt die Datei
// und markiert die Zeile als gelöscht (Nachweis bleibt bestehen); der zugehörige Prüfvermerk bleibt unberührt.
import { getSession } from "@/lib/auth";
import { DomainError } from "@/lib/integrity";
import { deleteDriverDocumentCopy, readDriverDocumentCopy } from "@/lib/driver-verification";

export async function GET(_req: Request, ctx: RouteContext<"/api/driver-documents/[id]">) {
  const session = await getSession();
  if (!session) return new Response("Nicht angemeldet", { status: 401 });
  const { id } = await ctx.params;
  try {
    const file = await readDriverDocumentCopy(session.tenant.id, id);
    if (!file) return new Response("Nicht gefunden", { status: 404 });
    return new Response(file.body as BodyInit, {
      headers: { "Content-Type": file.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
    });
  } catch (e) {
    console.error("Dokumentkopie konnte nicht geladen werden:", (e as Error).name);
    return new Response("Derzeit nicht verfügbar", { status: 502 });
  }
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/driver-documents/[id]">) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Nicht angemeldet." }, { status: 401 });
  const { id } = await ctx.params;
  let reason = "Auf Wunsch entfernt";
  try {
    const body = (await req.json().catch(() => null)) as { reason?: string } | null;
    if (body?.reason) reason = body.reason.slice(0, 300);
  } catch {
    // ohne Begründung im Body: Standardtext
  }
  try {
    await deleteDriverDocumentCopy(session.tenant.id, { id: session.user.id, name: session.user.name }, id, reason);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof DomainError) return Response.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
