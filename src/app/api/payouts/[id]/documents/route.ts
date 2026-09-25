// Nachweis zu einer Auszahlung hochladen (Überweisungsbeleg, Terminalbeleg, unterschriebene Barauszahlungsbestätigung):
// PDF oder Bild, privat, geprüft (Typ am Inhalt, Größe, Prüfsumme), nur Inhaber und Disponent, nur eigener Mandant.
import { db } from "@/lib/db";
import { apiSession } from "@/lib/auth";
import { roleAllows } from "@/lib/constants";
import { DomainError, isImmutableError, sha256 } from "@/lib/integrity";
import { registerPayoutAttachment } from "@/lib/payouts";
import { MAX_DOCUMENT_BYTES, buildStorageKey, getStorage, sniffDocumentType } from "@/lib/storage";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, ctx: RouteContext<"/api/payouts/[id]/documents">) {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  if (!roleAllows(session.user.role, ["DISPO"])) return json(403, { error: "Keine Berechtigung." });
  const { id } = await ctx.params;
  const tenantId = session.tenant.id;
  const payout = await db.payout.findFirst({ where: { id, tenantId }, select: { id: true, bookingId: true, status: true } });
  if (!payout) return json(404, { error: "Auszahlung nicht gefunden." });
  if (payout.status === "CANCELLED") return json(409, { error: "Zu einer stornierten Auszahlung werden keine Nachweise mehr hochgeladen." });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { error: "Es wurde keine Datei übertragen." });
  if (file.size <= 0) return json(400, { error: "Die Datei ist leer." });
  if (file.size > MAX_DOCUMENT_BYTES) return json(413, { error: "Der Nachweis ist zu groß (maximal 8 MB)." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffDocumentType(bytes);
  if (!contentType) return json(415, { error: "Bitte ein PDF oder ein Bild (JPEG, PNG, WebP) hochladen." });
  const fileName = (file.name || "nachweis").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);

  let storageKey = "";
  try {
    const storage = getStorage();
    storageKey = buildStorageKey({ tenantId, area: "documents", bookingId: payout.bookingId, contentType });
    await storage.put(storageKey, bytes, contentType);
    try {
      const doc = await registerPayoutAttachment(tenantId, { id: session.user.id, name: session.user.name }, payout.id, { fileName, storageKey, contentType, sizeBytes: bytes.length, checksum: sha256(bytes) });
      return json(201, { id: doc.id });
    } catch (e) {
      await storage.remove(storageKey).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    if (isImmutableError(e)) return json(409, { error: "Die Auszahlung kann nicht mehr geändert werden." });
    console.error("Auszahlungsnachweis-Upload fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Der Nachweis konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
