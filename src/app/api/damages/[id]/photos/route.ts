// Befehl 27: Foto zu einem manuell erfassten Schaden (ohne Übergabe-/Rückgabeprotokoll). Gleiche Regeln wie Protokoll- und
// Schadenaktenfotos: Sitzung und Mandant geprüft (Supportmodus nur lesend), Bildtyp am Inhalt erkannt, Größe begrenzt,
// Prüfsumme gebildet, privater Speicher. Alle Rollen dürfen Fotos zum Schaden ergänzen (auch Hof).
import { apiSession } from "@/lib/auth";
import { registerDamagePhoto } from "@/lib/damages";
import { db } from "@/lib/db";
import { DomainError, sha256 } from "@/lib/integrity";
import { MAX_PHOTO_BYTES, buildStorageKey, getStorage, sniffImageType } from "@/lib/storage";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, ctx: RouteContext<"/api/damages/[id]/photos">) {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const tenantId = session.tenant.id;
  const damage = await db.damage.findFirst({ where: { id, tenantId }, select: { id: true, bookingId: true } });
  if (!damage) return json(404, { error: "Schaden nicht gefunden." });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { error: "Es wurde keine Datei übertragen." });
  if (file.size <= 0) return json(400, { error: "Die Datei ist leer." });
  if (file.size > MAX_PHOTO_BYTES) return json(413, { error: "Das Foto ist zu groß (maximal 8 MB)." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) return json(415, { error: "Bitte ein Foto im Format JPEG, PNG oder WebP hochladen." });

  let storageKey = "";
  try {
    const storage = getStorage();
    storageKey = buildStorageKey({ tenantId, area: "photos", bookingId: damage.bookingId ?? undefined, contentType });
    await storage.put(storageKey, bytes, contentType);
    try {
      const photo = await registerDamagePhoto(tenantId, { id: session.user.id, name: session.user.name }, damage.id, { storageKey, contentType, sizeBytes: bytes.length, checksum: sha256(bytes) });
      return json(201, { id: photo.id });
    } catch (e) {
      await storage.remove(storageKey).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    console.error("Schadenfoto-Upload fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Das Foto konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
