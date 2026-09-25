// Posteingang: Behördenschreiben vor dem Anlegen eines Vorgangs hochladen. Die Datei wird privat gespeichert, bei PDFs mit
// Textebene werden Vorschläge für das Erfassungsformular erkannt (lokal, ohne externen Dienst). OWNER und DISPO.
import { getSession } from "@/lib/auth";
import { roleAllows } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";
import { uploadAuthorityLetter } from "@/lib/authority-intake";
import { MAX_DOCUMENT_BYTES } from "@/lib/storage";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return json(401, { error: "Nicht angemeldet." });
  if (!roleAllows(session.user.role, ["DISPO"])) return json(403, { error: "Behördenschreiben erfasst die Disposition." });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Die Datei konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { error: "Es wurde keine Datei übertragen." });
  if (file.size > MAX_DOCUMENT_BYTES) return json(413, { error: "Das Dokument ist zu groß (maximal 8 MB)." });
  try {
    const res = await uploadAuthorityLetter(session.tenant.id, { id: session.user.id, name: session.user.name }, { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name });
    return json(201, res);
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    console.error("Behördenschreiben-Upload fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Das Schreiben konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
