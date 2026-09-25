// Dokumentkopie zu einer Fahrerprüfung hochladen (Phase 19.5). Getrennt vom Prüfvermerk selbst: eine Kopie ist
// optional und ersetzt nie die dokumentierte Originalprüfung. Personalausweiskopien brauchen die ausdrückliche,
// dokumentierte Zustimmung des Ausweisinhabers (§ 20 Abs. 2 PAuswG); ohne Zustimmung wird nichts gespeichert.
// Das Bild wird serverseitig dauerhaft als Kopie gekennzeichnet (Prägung), eine unmarkierte Fassung bleibt nicht bestehen.
import { db } from "@/lib/db";
import { apiSession } from "@/lib/auth";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { recordDriverDocumentCopy } from "@/lib/driver-verification";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request, ctx: RouteContext<"/api/handovers/[id]/driver-documents">) {
  const session = await apiSession("write");
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const tenantId = session.tenant.id;

  const handover = await db.handover.findFirst({ where: { id, tenantId }, select: { id: true, bookingId: true, status: true, type: true } });
  if (!handover) return json(404, { error: "Protokoll nicht gefunden." });
  if (handover.type !== "PICKUP") return json(409, { error: "Dokumentkopien gehören zur Übergabe." });
  if (handover.status !== "DRAFT") return json(409, { error: "Das Protokoll ist finalisiert. Es können keine Dokumentkopien mehr hinzugefügt werden." });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  const verificationId = String(form.get("verificationId") ?? "");
  const contractDriverId = String(form.get("contractDriverId") ?? "");
  const documentKind = String(form.get("documentKind") ?? "");
  const side = String(form.get("side") ?? "FRONT");
  const consentGiven = form.get("consentGiven") === "1" || form.get("consentGiven") === "true";
  if (!(file instanceof File)) return json(400, { error: "Es wurde keine Datei übertragen." });
  if (!verificationId || !contractDriverId) return json(400, { error: "Prüfvermerk oder Fahrer fehlt." });
  if (documentKind !== "IDENTITY" && documentKind !== "LICENSE") return json(400, { error: "Unbekannte Dokumentart." });
  if (side !== "FRONT" && side !== "BACK") return json(400, { error: "Unbekannte Seite." });

  const verification = await db.driverVerification.findFirst({ where: { id: verificationId, tenantId, handoverId: handover.id, contractDriverId } });
  if (!verification) return json(404, { error: "Prüfvermerk nicht gefunden." });

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const copy = await recordDriverDocumentCopy(tenantId, { id: session.user.id, name: session.user.name }, {
      bookingId: handover.bookingId, handoverId: handover.id, verificationId, contractDriverId,
      documentKind, side, bytes, consent: documentKind === "IDENTITY" ? { given: consentGiven } : undefined,
    });
    return json(201, { id: copy.id, documentKind: copy.documentKind, side: copy.side });
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    if (isImmutableError(e)) return json(409, { error: "Das Protokoll ist finalisiert." });
    console.error("Dokumentkopie fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Die Dokumentkopie konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
