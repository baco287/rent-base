// Dokument-Upload zu einem Behördenvorgang (Schreiben, Nachweis, Schriftwechsel …): PDF oder Bild, Typ am Dateiinhalt
// erkannt, Größe begrenzt, Prüfsumme, privater Speicher. OWNER und DISPO; Hofmitarbeiter sehen Vorgänge nur.
// Es findet keine Texterkennung statt – die Daten des Schreibens werden manuell erfasst.
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { AUTHORITY_DOCUMENT_TYPES, roleAllows } from "@/lib/constants";
import { DomainError, isImmutableError, sha256 } from "@/lib/integrity";
import { registerAuthorityDocument } from "@/lib/authority";
import { MAX_DOCUMENT_BYTES, buildStorageKey, getStorage, sniffDocumentType } from "@/lib/storage";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, ctx: RouteContext<"/api/authority-cases/[id]/documents">) {
  const session = await getSession();
  if (!session) return json(401, { error: "Nicht angemeldet." });
  if (!roleAllows(session.user.role, ["DISPO"])) return json(403, { error: "Dokumente zu Behördenvorgängen fügt die Disposition hinzu." });
  const { id } = await ctx.params;
  const tenantId = session.tenant.id;
  const c = await db.authorityCase.findFirst({ where: { id, tenantId }, select: { id: true, status: true } });
  if (!c) return json(404, { error: "Behördenvorgang nicht gefunden." });
  if (c.status === "CANCELLED") return json(409, { error: "Der Vorgang ist storniert." });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  const type = String(form.get("type") ?? "INCOMING_NOTICE");
  const note = form.get("description") ? String(form.get("description")).slice(0, 300) : null;
  if (!(type in AUTHORITY_DOCUMENT_TYPES) || type === "RESPONSE_PDF") return json(400, { error: "Unbekannter Dokumenttyp." });
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
      const doc = await registerAuthorityDocument(tenantId, c.id, { id: session.user.id, name: session.user.name }, { type, fileName, storageKey, contentType, sizeBytes: bytes.length, checksum: sha256(bytes), note });
      return json(201, { id: doc.id });
    } catch (e) {
      await storage.remove(storageKey).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    if (isImmutableError(e)) return json(409, { error: "Der Vorgang kann nicht mehr geändert werden." });
    console.error("Behördendokument-Upload fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Das Dokument konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
