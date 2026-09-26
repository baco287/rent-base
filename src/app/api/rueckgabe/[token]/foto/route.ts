// Befehl 20.6: Kundenfoto zur kontaktlosen Rückgabe hochladen. Keine Sitzung – nur der persönliche Link berechtigt,
// und nur für genau diese Rückgabe, solange sie nicht gemeldet ist. Rate-Limit je Adresse.
import { DomainError } from "@/lib/integrity";
import { uploadKeyDropPhoto } from "@/lib/key-drop";
import { consume } from "@/lib/rate-limit";
import { MAX_PHOTO_BYTES } from "@/lib/storage";

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

export async function POST(req: Request, ctx: RouteContext<"/api/rueckgabe/[token]/foto">) {
  const { token } = await ctx.params;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unbekannt";
  if (!consume(`keydrop-photo:${ip}`, { limit: 40, windowMs: 10 * 60_000 }).allowed) return json(429, { error: "Zu viele Uploads. Bitte kurz warten." });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Das Foto konnte nicht gelesen werden." });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { error: "Es wurde kein Foto übertragen." });
  if (file.size > MAX_PHOTO_BYTES) return json(413, { error: "Das Foto ist zu groß." });
  try {
    const photo = await uploadKeyDropPhoto(token, String(form.get("category") ?? ""), new Uint8Array(await file.arrayBuffer()));
    return json(201, { id: photo.id, category: photo.category });
  } catch (e) {
    if (e instanceof DomainError) return json(422, { error: e.message });
    console.error("Kundenfoto kontaktlose Rückgabe fehlgeschlagen:", (e as Error).name);
    return json(502, { error: "Das Foto konnte nicht gespeichert werden. Bitte erneut versuchen." });
  }
}
