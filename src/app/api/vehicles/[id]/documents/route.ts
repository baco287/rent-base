// Allgemeines Fahrzeugdokument (Zulassung, Versicherung, HU-Bericht …) ohne Wartungsvorgang. Nur Inhaber und Disponent
// (sensible Unterlagen); PDF oder Bild, Typ am Inhalt erkannt, privater Speicher.
import { db } from "@/lib/db";
import { apiSession } from "@/lib/auth";
import { VEHICLE_DOCUMENT_TYPES, roleAllows } from "@/lib/constants";
import { DomainError, sha256 } from "@/lib/integrity";
import { registerVehicleDocument } from "@/lib/maintenance";
import { MAX_DOCUMENT_BYTES, buildStorageKey, getStorage, sniffDocumentType } from "@/lib/storage";
import { parseLocalDateTime } from "@/lib/time";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, ctx: RouteContext<"/api/vehicles/[id]/documents">) {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const tenantId = session.tenant.id;
  const vehicle = await db.vehicle.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!vehicle) return json(404, { error: "Fahrzeug nicht gefunden." });
  if (!roleAllows(session.user.role, ["DISPO"])) return json(403, { error: "Allgemeine Fahrzeugdokumente laden Inhaber und Disposition hoch." });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  const type = String(form.get("type") ?? "OTHER");
  const description = form.get("description") ? String(form.get("description")).slice(0, 300) : null;
  const documentDate = form.get("documentDate") ? parseLocalDateTime(`${String(form.get("documentDate"))}T12:00`) : null;
  if (!(type in VEHICLE_DOCUMENT_TYPES)) return json(400, { error: "Unbekannter Dokumenttyp." });
  if (!(file instanceof File)) return json(400, { error: "Es wurde keine Datei übertragen." });
  if (file.size <= 0) return json(400, { error: "Die Datei ist leer." });
  if (file.size > MAX_DOCUMENT_BYTES) return json(413, { error: "Das Dokument ist zu groß (maximal 8 MB)." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffDocumentType(bytes);
  if (!contentType) return json(415, { error: "Bitte ein PDF oder ein Bild (JPEG, PNG, WebP) hochladen." });
  const fileName = (file.name || "dokument").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);

  let storageKey = "";
  try {
    const storage = getStorage();
    storageKey = buildStorageKey({ tenantId, area: "documents", contentType });
    await storage.put(storageKey, bytes, contentType);
    try {
      const doc = await registerVehicleDocument(tenantId, { id: session.user.id, name: session.user.name }, { vehicleId: vehicle.id, type, fileName, storageKey, contentType, sizeBytes: bytes.length, checksum: sha256(bytes), documentDate, description });
      return json(201, { id: doc.id });
    } catch (e) {
      await storage.remove(storageKey).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    console.error("Fahrzeugdokument-Upload fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Das Dokument konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
