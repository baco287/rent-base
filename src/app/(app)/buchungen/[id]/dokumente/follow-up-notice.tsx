// Klartext direkt nach dem Abschluss der Übergabe: Was ist mit Dokumenten und E-Mail passiert?
// Gelesen wird der tatsächliche Stand aus Archiv und Versandprotokoll, nichts wird angenommen.
import { db } from "@/lib/db";

export async function FollowUpNotice({ tenantId, bookingId, handoverId }: { tenantId: string; bookingId: string; handoverId: string }) {
  const [docs, mail] = await Promise.all([
    db.document.findMany({ where: { tenantId, bookingId, type: { in: ["RENTAL_CONTRACT", "PICKUP_PROTOCOL"] } }, select: { type: true } }),
    db.emailLog.findFirst({ where: { tenantId, bookingId, handoverId }, orderBy: { createdAt: "desc" }, select: { status: true, recipient: true, error: true } }),
  ]);
  const types = new Set(docs.map((d) => d.type));
  const docsOk = types.has("RENTAL_CONTRACT") && types.has("PICKUP_PROTOCOL");

  if (!docsOk) {
    return <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">Übergabe abgeschlossen – Dokumenterzeugung fehlgeschlagen. Das Fahrzeug gilt als übergeben. Die PDFs lassen sich unten jederzeit nachträglich erzeugen, danach können die Unterlagen versendet werden.</p>;
  }
  if (mail?.status === "SENT") {
    return <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">Mietvertrag und Übergabeprotokoll wurden an {mail.recipient} versendet.</p>;
  }
  return (
    <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">
      Übergabe abgeschlossen. E-Mail konnte nicht versendet werden{mail?.error ? `: ${mail.error.replace(/\.+$/, "")}` : ""}. Die Dokumente sind archiviert und können unten erneut gesendet oder heruntergeladen werden.
    </p>
  );
}
