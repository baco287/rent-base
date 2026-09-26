// Befehl 20.6: öffentliche Seite der kontaktlosen Rückgabe (persönlicher Link aus der Rückgabe-Mail). Mobile-first.
// Zeigt ausschließlich, was der Kunde für die Rückgabe braucht – keine internen Notizen, Kaution, Rechnungen, Schäden,
// Dokumentkopien oder andere Buchungen.
import { headers } from "next/headers";
import type { Metadata } from "next";
import { publicKeyDropView } from "@/lib/key-drop";
import { consume } from "@/lib/rate-limit";
import { KEY_DROP_CONFIRMATION_TEXT, KEY_DROP_NOT_INSPECTION_TEXT } from "@/lib/constants";
import { toDateTimeInputValue } from "@/lib/time";
import { KeyDropCustomerForm } from "./customer-form";

export const metadata: Metadata = { title: "Kontaktlose Rückgabe", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="flex-1 bg-bg px-4 py-6 flex justify-center"><div className="w-full max-w-lg flex flex-col gap-4">{children}</div></main>;
}

export default async function KeyDropPage({ params }: PageProps<"/rueckgabe/[token]">) {
  const { token } = await params;
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unbekannt";
  if (!consume(`keydrop-view:${ip}`, { limit: 120, windowMs: 10 * 60_000 }).allowed) {
    return <Shell><div className="card p-5 text-sm">Zu viele Aufrufe. Bitte in einigen Minuten erneut versuchen.</div></Shell>;
  }
  const v = await publicKeyDropView(token);
  if (!v) {
    return (
      <Shell>
        <div className="card p-5 flex flex-col gap-2">
          <h1 className="text-lg font-semibold">Link nicht gültig</h1>
          <p className="text-sm text-ink-2">Dieser Rückgabelink ist abgelaufen, wurde ersetzt oder ist nicht mehr gültig. Bitte verwenden Sie den Link aus der neuesten E-Mail oder wenden Sie sich an Ihren Vermieter.</p>
        </div>
      </Shell>
    );
  }
  return (
    <Shell>
      <header className="card p-4 flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {v.hasLogo && <img src={`/api/rueckgabe/${token}/logo`} alt={v.landlordName} className="max-h-12 max-w-[140px] object-contain" />}
        <div className="min-w-0">
          <div className="font-semibold break-words">{v.landlordName}</div>
          <div className="text-xs text-ink-3">Kontaktlose Rückgabe ({v.label})</div>
        </div>
      </header>

      <section className="card p-4 flex flex-col gap-2 text-sm">
        <h1 className="text-lg font-semibold">Hallo {v.renterName},</h1>
        <dl className="grid grid-cols-[minmax(110px,40%)_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-ink-3">Fahrzeug</dt><dd className="font-medium break-words">{v.vehicleTitle}</dd>
          <dt className="text-ink-3">Kennzeichen</dt><dd className="font-mono">{v.plate}</dd>
          <dt className="text-ink-3">Buchung</dt><dd className="font-mono">{v.bookingNumber}</dd>
          <dt className="text-ink-3">Rückgabeort</dt><dd className="break-words">{v.location}</dd>
          <dt className="text-ink-3">Voraussichtlich</dt><dd>{v.expectedAt}</dd>
        </dl>
        {(v.instructions || v.parkingNote || v.keyNote) && (
          <div className="rounded-md bg-info-soft text-info px-3 py-2 flex flex-col gap-1">
            {v.instructions && <p className="whitespace-pre-line">{v.instructions}</p>}
            {v.parkingNote && <p className="whitespace-pre-line"><b>Abstellen:</b> {v.parkingNote}</p>}
            {v.keyNote && <p className="whitespace-pre-line"><b>Schlüssel:</b> {v.keyNote}</p>}
          </div>
        )}
      </section>

      {v.confirmed ? (
        <section className="card p-4 flex flex-col gap-2 text-sm">
          <h2 className="font-semibold">Rückgabe gemeldet</h2>
          <p>Ihre Rückgabemeldung ist am {v.confirmed.at} eingegangen (Abgabe {v.confirmed.dropOffAt}{v.confirmed.mileage != null ? `, ${v.confirmed.mileage.toLocaleString("de-DE")} km` : ""}).</p>
          <p className="rounded-md bg-amber-soft text-amber px-3 py-2">Die Fahrzeugkontrolle durch {v.landlordName} steht noch aus. Ihre Angaben können nicht mehr geändert werden.</p>
        </section>
      ) : (
        <>
          <p className="text-sm text-ink-2 px-1">Bitte füllen Sie das Formular erst aus, wenn Sie das Fahrzeug tatsächlich abgestellt haben. Die Fahrzeugkontrolle durch {v.landlordName} erfolgt anschließend separat.</p>
          <KeyDropCustomerForm token={token} v={{ energy: v.energy, location: v.location, requestedPhotos: v.requestedPhotos, photos: v.photos, now: toDateTimeInputValue(new Date()), confirmationText: KEY_DROP_CONFIRMATION_TEXT, notInspectionText: KEY_DROP_NOT_INSPECTION_TEXT, renterName: v.renterName }} />
        </>
      )}
      <p className="text-center text-xs text-ink-3">Versendet mit RentBase im Auftrag von {v.landlordName}.</p>
    </Shell>
  );
}
