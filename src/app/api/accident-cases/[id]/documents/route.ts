// Befehl 29 Phase F: Dokument-Upload zu einem Unfallersatzfall (Abtretung/Zahlungsanweisung, Schreiben der Versicherung, Sonstiges):
// PDF oder Bild, Typ am Dateiinhalt erkannt, Größe begrenzt, Prüfsumme, privater Speicher. Nur OWNER und DISPO mit freigeschaltetem
// Modul, nur Fälle des eigenen Mandanten, nur bei offenem Fall. Keine Texterkennung, kein Versand.
import { db } from "@/lib/db";
import { apiSession, featureForApi } from "@/lib/auth";
import { ACCIDENT_CASE_DOCUMENT_TYPES, roleAllows } from "@/lib/constants";
import { DomainError, isImmutableError, sha256 } from "@/lib/integrity";
import { ACCIDENT_CASE_CLOSED_MESSAGE } from "@/lib/accident-replacement-events";
import { registerAccidentDocument, safeDocumentFileName } from "@/lib/accident-replacement";
import { MAX_DOCUMENT_BYTES, buildStorageKey, getStorage, sniffDocumentType } from "@/lib/storage";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, ctx: RouteContext<"/api/accident-cases/[id]/documents">) {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  const featureBlocked = await featureForApi(session, "ACCIDENT_REPLACEMENT");
  if (featureBlocked) return featureBlocked;
  if (!roleAllows(session.user.role, ["DISPO"])) return json(403, { error: "Dokumente zum Unfallersatzfall fügen Inhaber und Disposition hinzu." });
  const { id } = await ctx.params;
  const tenantId = session.tenant.id;
  const c = await db.accidentReplacementCase.findFirst({ where: { id, tenantId }, select: { id: true, bookingId: true, status: true } });
  if (!c) return json(404, { error: "Unfallersatzfall nicht gefunden." });
  if (c.status === "CLOSED") return json(409, { error: ACCIDENT_CASE_CLOSED_MESSAGE });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  const type = String(form.get("type") ?? "OTHER");
  const note = form.get("note") ? String(form.get("note")).slice(0, 500) : null;
  if (!(type in ACCIDENT_CASE_DOCUMENT_TYPES)) return json(400, { error: "Unbekannter Dokumenttyp." });
  if (!(file instanceof File)) return json(400, { error: "Es wurde keine Datei übertragen." });
  if (file.size <= 0) return json(400, { error: "Die Datei ist leer." });
  if (file.size > MAX_DOCUMENT_BYTES) return json(413, { error: "Das Dokument ist zu groß (maximal 8 MB)." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffDocumentType(bytes);
  if (!contentType) return json(415, { error: "Bitte ein PDF oder ein Bild (JPEG, PNG, WebP) hochladen." });
  const fileName = safeDocumentFileName(file.name || "dokument");

  let storageKey = "";
  try {
    const storage = getStorage();
    storageKey = buildStorageKey({ tenantId, area: "documents", bookingId: c.bookingId, contentType });
    await storage.put(storageKey, bytes, contentType);
    try {
      const doc = await registerAccidentDocument(tenantId, c.id, { id: session.user.id, name: session.user.name }, { type, fileName, storageKey, contentType, sizeBytes: bytes.length, checksum: sha256(bytes), note });
      return json(201, { id: doc.id });
    } catch (e) {
      await storage.remove(storageKey).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e instanceof DomainError) return json(e.message === ACCIDENT_CASE_CLOSED_MESSAGE ? 409 : 422, { error: e.message });
    if (isImmutableError(e)) return json(409, { error: "Der Fall kann nicht mehr geändert werden." });
    console.error("Unfallersatz-Dokument: Upload fehlgeschlagen", { fehler: (e as Error).name });
    return json(502, { error: "Das Dokument konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
