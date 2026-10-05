// Befehl 29 Phase F: Liefert ein Dokument eines Unfallersatzfalls (Abtretung, Versichererschreiben, Sonstiges) aus dem privaten
// Speicher – nur für Inhaber und Disposition desselben Mandanten mit freigeschaltetem Modul, nie über eine öffentliche oder
// weitergebbare Adresse. Im Supportmodus gesperrt (personenbezogene Inhalte). Vor der Auslieferung wird die Prüfsumme geprüft;
// archivierte Dokumente bleiben abrufbar (Nachvollziehbarkeit).
import { db } from "@/lib/db";
import { apiSession, featureForApi } from "@/lib/auth";
import { roleAllows } from "@/lib/constants";
import { sha256 } from "@/lib/integrity";
import { assertKeyBelongsToTenant, getStorage } from "@/lib/storage";

export async function GET(req: Request, ctx: RouteContext<"/api/accident-documents/[id]">) {
  const session = await apiSession("read", "ACCIDENT_DOCUMENT");
  if (session instanceof Response) return session;
  const featureBlocked = await featureForApi(session, "ACCIDENT_REPLACEMENT", "read");
  if (featureBlocked) return featureBlocked;
  if (!roleAllows(session.user.role, ["DISPO"])) return new Response("Keine Berechtigung", { status: 403 });
  const { id } = await ctx.params;
  const doc = await db.accidentReplacementCaseDocument.findFirst({ where: { id, tenantId: session.tenant.id }, select: { storageKey: true, fileName: true, contentType: true, checksum: true } });
  if (!doc) return new Response("Nicht gefunden", { status: 404 });
  try {
    assertKeyBelongsToTenant(doc.storageKey, session.tenant.id);
    const object = await getStorage().get(doc.storageKey);
    if (!object) return new Response("Nicht gefunden", { status: 404 });
    if (sha256(object.body) !== doc.checksum) {
      console.error("Unfallersatz-Dokument weicht von der Prüfsumme ab");
      return new Response("Das Dokument konnte nicht unverändert gelesen werden", { status: 409 });
    }
    const safeName = doc.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
    const download = new URL(req.url).searchParams.get("download") === "1";
    return new Response(object.body as BodyInit, {
      headers: {
        "Content-Type": doc.contentType,
        "Content-Length": String(object.body.length),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    console.error("Unfallersatz-Dokument konnte nicht geladen werden", { fehler: (e as Error).name });
    return new Response("Dokument derzeit nicht verfügbar", { status: 502 });
  }
}
