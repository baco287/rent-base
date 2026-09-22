// Klartext direkt nach dem Abschluss von Übergabe, Rückgabe oder Rechnung: Was ist mit Dokumenten und E-Mail passiert?
// Gelesen wird der tatsächliche Stand aus Archiv und Versandprotokoll, nichts wird angenommen.
import { db } from "@/lib/db";

type Props = { tenantId: string; bookingId: string; handoverId?: string; invoiceId?: string; kind?: "PICKUP" | "RETURN" | "INVOICE" };

export async function FollowUpNotice({ tenantId, bookingId, handoverId, invoiceId, kind = "PICKUP" }: Props) {
  const wanted = kind === "PICKUP" ? ["RENTAL_CONTRACT", "PICKUP_PROTOCOL"] : kind === "RETURN" ? ["RETURN_PROTOCOL"] : ["INVOICE"];
  const [docs, mail] = await Promise.all([
    db.document.findMany({ where: { tenantId, bookingId, type: { in: wanted }, ...(kind === "INVOICE" ? { invoiceId } : {}) }, select: { type: true } }),
    db.emailLog.findFirst({ where: { tenantId, bookingId, ...(kind === "INVOICE" ? { invoiceId } : { handoverId }) }, orderBy: { createdAt: "desc" }, select: { status: true, recipient: true, error: true } }),
  ]);
  const types = new Set(docs.map((d) => d.type));
  const docsOk = wanted.every((t) => types.has(t));
  const what = kind === "PICKUP" ? "Übergabe" : kind === "RETURN" ? "Rückgabe" : "Rechnung";
  const which = kind === "PICKUP" ? "Mietvertrag und Übergabeprotokoll wurden" : kind === "RETURN" ? "Das Rückgabeprotokoll wurde" : "Die Rechnung wurde";
  const consequence = kind === "PICKUP" ? "Das Fahrzeug gilt als übergeben." : kind === "RETURN" ? "Das Fahrzeug gilt als zurückgegeben." : "Die Rechnung ist abgeschlossen und ihre Nummer vergeben.";

  if (!docsOk) {
    return <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">{what} abgeschlossen – Dokumenterzeugung fehlgeschlagen. {consequence} Die PDFs lassen sich unten jederzeit nachträglich erzeugen, danach können die Unterlagen versendet werden.</p>;
  }
  if (mail?.status === "SENT") {
    return <p className="rounded-md bg-good-soft text-good px-3.5 py-2.5 font-medium">{which} an {mail.recipient} versendet.</p>;
  }
  return (
    <p role="alert" className="rounded-md bg-amber-soft text-amber px-3.5 py-2.5 font-medium">
      {what} abgeschlossen. E-Mail konnte nicht versendet werden{mail?.error ? `: ${mail.error.replace(/\.+$/, "")}` : ""}. {kind === "INVOICE" ? "Das PDF ist archiviert und kann" : "Die Dokumente sind archiviert und können"} unten erneut gesendet oder heruntergeladen werden.
    </p>
  );
}
