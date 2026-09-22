// Foto-Upload zur Schadenakte (Detail-, Werkstatt- oder Nach-Reparatur-Aufnahme). Gleiche Regeln wie Protokollfotos:
// Sitzung und Mandant geprüft, Bildtyp am Inhalt erkannt, Größe begrenzt, Prüfsumme gebildet, privater Speicher.
// Alle Rollen dürfen Fotos ergänzen (auch Hof); Protokollfotos bleiben unberührt.
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { DomainError, isImmutableError, sha256 } from "@/lib/integrity";
import { registerCasePhoto } from "@/lib/damage-cases";
import { MAX_PHOTO_BYTES, buildStorageKey, getStorage, sniffImageType } from "@/lib/storage";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, ctx: RouteContext<"/api/damage-cases/[id]/photos">) {
  const session = await getSession();
  if (!session) return json(401, { error: "Nicht angemeldet." });
  const { id } = await ctx.params;
  const tenantId = session.tenant.id;

  const dc = await db.damageCase.findFirst({ where: { id, tenantId }, select: { id: true, bookingId: true, status: true } });
  if (!dc) return json(404, { error: "Schadenakte nicht gefunden." });
  if (dc.status === "CLOSED") return json(409, { error: "Die Schadenakte ist geschlossen. Bitte zuerst wieder öffnen." });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  const caption = form.get("caption") ? String(form.get("caption")).slice(0, 120) : null;
  if (!(file instanceof File)) return json(400, { error: "Es wurde keine Datei übertragen." });
  if (file.size <= 0) return json(400, { error: "Die Datei ist leer." });
  if (file.size > MAX_PHOTO_BYTES) return json(413, { error: "Das Foto ist zu groß (maximal 8 MB)." });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) return json(415, { error: "Bitte ein Foto im Format JPEG, PNG oder WebP hochladen." });

  let storageKey = "";
  try {
    const storage = getStorage();
    storageKey = buildStorageKey({ tenantId, area: "photos", bookingId: dc.bookingId ?? undefined, contentType });
    await storage.put(storageKey, bytes, contentType);
    try {
      const photo = await registerCasePhoto(tenantId, dc.id, { id: session.user.id, name: session.user.name }, { storageKey, contentType, sizeBytes: bytes.length, checksum: sha256(bytes), caption });
      return json(201, { id: photo.id });
    } catch (e) {
      await storage.remove(storageKey).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    if (isImmutableError(e)) return json(409, { error: "Die Schadenakte kann nicht mehr geändert werden." });
    console.error("Schadenfoto-Upload fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Das Foto konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
