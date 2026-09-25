// Logo des eigenen Mandanten (Befehl 20.5): anzeigen (alle Mitarbeiter), hochladen/ersetzen/entfernen (nur Inhaber).
// Der Mandant kommt ausschließlich aus der Sitzung; es wird kein Speicher-Schlüssel und keine Mandanten-ID angenommen.
// Im Supportmodus: nur lesen (apiSession("write") lehnt ab).
import { apiSession } from "@/lib/auth";
import { LOGO_MAX_BYTES } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { currentLogo, removeTenantLogo, uploadTenantLogo } from "@/lib/branding";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET() {
  const session = await apiSession("read");
  if (session instanceof Response) return session;
  const logo = await currentLogo(session.tenant.id);
  if (!logo) return new Response("Kein Logo", { status: 404 });
  return new Response(logo as BodyInit, { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" } });
}

export async function POST(req: Request) {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  if (session.user.role !== "OWNER") return json(403, { error: "Das Logo verwaltet der Inhaber." });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { error: "Es wurde keine Datei übertragen." });
  if (file.size > LOGO_MAX_BYTES) return json(413, { error: `Das Logo ist zu groß (höchstens ${Math.round(LOGO_MAX_BYTES / 1024 / 1024)} MB).` });
  try {
    await uploadTenantLogo(session.tenant.id, { id: session.user.id, name: session.user.name }, new Uint8Array(await file.arrayBuffer()));
    return json(201, { ok: true });
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    console.error("Logo konnte nicht gespeichert werden:", (e as Error).name);
    return json(502, { error: "Das Logo konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}

export async function DELETE() {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  if (session.user.role !== "OWNER") return json(403, { error: "Das Logo verwaltet der Inhaber." });
  await removeTenantLogo(session.tenant.id, { id: session.user.id, name: session.user.name });
  return json(200, { ok: true });
}
