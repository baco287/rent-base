// Klartext direkt nach dem Abschluss von Übergabe oder Rückgabe: Was ist mit Dokumenten und E-Mail passiert?
// Gelesen wird der tatsächliche Stand aus Archiv und Versandprotokoll, nichts wird angenommen.
import { db } from "@/lib/db";

export async function FollowUpNotice({ tenantId, bookingId, handoverId, kind = "PICKUP" }: { tenantId: string; bookingId: string; handoverId: string; kind?: "PICKUP" | "RETURN" }) {
  const wanted = kind === "PICKUP" ? ["RENTAL_CONTRACT", "PICKUP_PROTOCOL"] : ["RETURN_PROTOCOL"];
  const [docs, mail] = await Promise.all([
    db.document.findMany({ where: { tenantId, bookingId, type: { in: wanted } }, select: { type: true } }),
    db.emailLog.findFirst({ where: { tenantId, bookingId, handoverId }, orderBy: { createdAt: "desc" }, select: { status: true, recipient: true, error: true } }),
  ]);
  const types = new Set(docs.map((d) => d.type));
  const docsOk = wanted.every((t) => types.has(t));
  const what = kind === "PICKUP" ? "Übergabe" : "Rückgabe";
  const which = kind === "PICKUP" ? "Mietvertrag und Übergabeprotokoll" : "Das Rückgabeprotokoll";

  if (!docsOk) {
    return <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">{what} abgeschlossen – Dokumenterzeugung fehlgeschlagen. Das Fahrzeug gilt als {kind === "PICKUP" ? "übergeben" : "zurückgegeben"}. Die PDFs lassen sich unten jederzeit nachträglich erzeugen, danach können die Unterlagen versendet werden.</p>;
  }
  if (mail?.status === "SENT") {
    return <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">{which} wurde{kind === "PICKUP" ? "n" : ""} an {mail.recipient} versendet.</p>;
  }
  return (
    <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">
      {what} abgeschlossen. E-Mail konnte nicht versendet werden{mail?.error ? `: ${mail.error.replace(/\.+$/, "")}` : ""}. Die Dokumente sind archiviert und können unten erneut gesendet oder heruntergeladen werden.
    </p>
  );
}
