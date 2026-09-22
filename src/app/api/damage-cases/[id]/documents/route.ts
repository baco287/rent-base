// Dokument-Upload zur Schadenakte: Kostenvoranschlag, Werkstattrechnung oder Sonstiges als PDF oder Bild.
// Typ wird am Dateiinhalt erkannt, keine Texterkennung, keine automatische Kostenübernahme – Beträge trägt der Mitarbeiter ein.
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { DomainError, isImmutableError, sha256 } from "@/lib/integrity";
import { registerCaseDocument } from "@/lib/damage-cases";
import { MAX_DOCUMENT_BYTES, buildStorageKey, getStorage, sniffDocumentType } from "@/lib/storage";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, ctx: RouteContext<"/api/damage-cases/[id]/documents">) {
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
  const type = String(form.get("type") ?? "OTHER");
  const note = form.get("note") ? String(form.get("note")).slice(0, 300) : null;
  if (!["ESTIMATE", "REPAIR_INVOICE", "OTHER"].includes(type)) return json(400, { error: "Unbekannter Dokumenttyp." });
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
    storageKey = buildStorageKey({ tenantId, area: "documents", bookingId: dc.bookingId ?? undefined, contentType });
    await storage.put(storageKey, bytes, contentType);
    try {
      const doc = await registerCaseDocument(tenantId, dc.id, { id: session.user.id, name: session.user.name }, { type, fileName, storageKey, contentType, sizeBytes: bytes.length, checksum: sha256(bytes), note });
      return json(201, { id: doc.id });
    } catch (e) {
      await storage.remove(storageKey).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    if (isImmutableError(e)) return json(409, { error: "Die Schadenakte kann nicht mehr geändert werden." });
    console.error("Schadendokument-Upload fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Das Dokument konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
