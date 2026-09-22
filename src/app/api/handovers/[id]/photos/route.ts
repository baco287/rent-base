// Foto-Upload zu einem Protokollentwurf. Die Datei geht über den App-Server in den privaten Speicher:
// Sitzung, Rolle und Mandant werden geprüft, der Bildtyp am Dateiinhalt erkannt (nicht am Dateinamen),
// Größe begrenzt, Prüfsumme gebildet. Gespeichert wird in der Datenbank nur der Speicherschlüssel.
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { DomainError, isImmutableError, sha256 } from "@/lib/integrity";
import { registerPhoto } from "@/lib/handovers";
import { MAX_PHOTO_BYTES, buildStorageKey, getStorage, sniffImageType } from "@/lib/storage";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, ctx: RouteContext<"/api/handovers/[id]/photos">) {
  const session = await getSession();
  if (!session) return json(401, { error: "Nicht angemeldet." });
  const { id } = await ctx.params;
  const tenantId = session.tenant.id;

  const handover = await db.handover.findFirst({ where: { id, tenantId }, select: { id: true, bookingId: true, status: true } });
  if (!handover) return json(404, { error: "Protokoll nicht gefunden." });
  if (handover.status !== "DRAFT") return json(409, { error: "Das Protokoll ist finalisiert. Es können keine Fotos mehr hinzugefügt werden." });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  const category = String(form.get("category") ?? "OTHER");
  const handoverDamageId = form.get("handoverDamageId") ? String(form.get("handoverDamageId")) : null;
  if (!(file instanceof File)) return json(400, { error: "Es wurde keine Datei übertragen." });
  if (file.size <= 0) return json(400, { error: "Die Datei ist leer." });
  if (file.size > MAX_PHOTO_BYTES) return json(413, { error: "Das Foto ist zu groß (maximal 8 MB)." });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) return json(415, { error: "Bitte ein Foto im Format JPEG, PNG oder WebP aufnehmen." });

  let storageKey = "";
  try {
    const storage = getStorage();
    storageKey = buildStorageKey({ tenantId, area: "photos", bookingId: handover.bookingId, contentType });
    await storage.put(storageKey, bytes, contentType);
    try {
      const photo = await registerPhoto(tenantId, { id: session.user.id, name: session.user.name }, { handoverId: handover.id, handoverDamageId, storageKey, category, contentType, sizeBytes: bytes.length, checksum: sha256(bytes), takenAt: new Date() });
      return json(201, { id: photo.id, category: photo.category });
    } catch (e) {
      // Eintrag gescheitert: die gerade abgelegte Datei wieder entfernen
      await storage.remove(storageKey).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    if (isImmutableError(e)) return json(409, { error: "Das Protokoll ist finalisiert." });
    console.error("Foto-Upload fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Das Foto konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
