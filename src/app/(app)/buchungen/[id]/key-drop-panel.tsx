// Befehl 20.6: Bereich „Kontaktlose Rückgabe“ auf der Buchung. Server-Komponente; Aktionen nur für Inhaber/Disposition.
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { Card, Chip } from "@/components/ui";
import { KEY_DROP_LEGAL_HINT, MAIL_CHANNELS, type MailChannel } from "@/lib/constants";
import { keyDropForBooking, keyDropSettingsOf, keyDropStatusLabel, nextBookingOfVehicle } from "@/lib/key-drop";
import { isValidEmail } from "@/lib/mail";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { toDateTimeInputValue } from "@/lib/time";
import { KeyDropAuthorizeForm, KeyDropCancelForm, KeyDropRevokeButton, KeyDropSendButton } from "./key-drop-forms";

type Props = { tenantId: string; booking: { id: string; status: string; endAt: Date; vehicleId: string }; role: string; supportMode: boolean; returnStarted: boolean };

export async function KeyDropPanel({ tenantId, booking, role, supportMode, returnStarted }: Props) {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { keyDropEnabled: true, keyDropSettings: true } });
  const { keyDrop: kd, mails } = await keyDropForBooking(tenantId, booking.id);
  if (!kd && (!tenant.keyDropEnabled || booking.status !== "ACTIVE")) return null;
  const canManage = role !== "YARD" && !supportMode;
  const settings = keyDropSettingsOf(kd?.settingsSnapshot ?? tenant.keyDropSettings);
  const activeLink = kd?.accesses.find((a) => !a.revokedAt && a.expiresAt > new Date()) ?? null;
  const linkMails = mails.filter((m) => m.template === "KEY_DROP_LINK");
  const lastLink = linkMails[0] ?? null;
  const senderIds = [...new Set(mails.map((m) => m.createdById).filter((x): x is string => !!x))];
  const senders = new Map((await db.user.findMany({ where: { tenantId, id: { in: senderIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const next = kd && kd.status !== "INSPECTED" ? await nextBookingOfVehicle(tenantId, booking.vehicleId, booking.id) : null;
  const tone = !kd ? "grey" : kd.status === "CUSTOMER_CONFIRMED" ? "amber" : kd.status === "INSPECTED" ? "good" : "info";

  return (
    <Card title="Kontaktlose Rückgabe" right={<Chip tone={tone}>{kd ? keyDropStatusLabel(kd.status) : "Nicht vereinbart"}</Chip>}>
      <div className="p-4 flex flex-col gap-3 text-sm">
        {!kd && (
          <>
            <p className="text-ink-2">Nicht vereinbart. Die Rückgabe läuft persönlich über „Rückgabe starten“.</p>
            {canManage && !returnStarted && <KeyDropAuthorizeForm bookingId={booking.id} defaults={{ expectedReturnAt: toDateTimeInputValue(booking.endAt), instructions: settings.defaultInstructions ?? "", label: settings.label }} />}
            {canManage && <p className="text-xs text-ink-3">{KEY_DROP_LEGAL_HINT}</p>}
          </>
        )}

        {kd && (
          <dl className="grid grid-cols-[minmax(120px,38%)_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-ink-3">Vereinbart</dt><dd>{fmtDateTime(kd.agreedAt)} · {kd.agreedByName}</dd>
            <dt className="text-ink-3">Rückgabeort</dt><dd className="break-words">{kd.location}</dd>
            <dt className="text-ink-3">Erwartet</dt><dd>{fmtDateTime(kd.expectedReturnAt)}</dd>
            {kd.instructions && <><dt className="text-ink-3">Anweisung</dt><dd className="break-words whitespace-pre-line">{kd.instructions}</dd></>}
            {kd.internalNote && role !== "YARD" && <><dt className="text-ink-3">Interne Notiz</dt><dd className="break-words">{kd.internalNote}</dd></>}
            <dt className="text-ink-3">Empfänger</dt><dd className="break-all">{kd.recipientName}{kd.recipientEmail ? ` · ${kd.recipientEmail}` : ""}</dd>
            {lastLink && <><dt className="text-ink-3">Rückgabe-Mail</dt><dd>{lastLink.status === "SENT" ? "gesendet" : lastLink.status === "FAILED" ? "fehlgeschlagen" : "nicht bestätigt"} {fmtDateTime(lastLink.sentAt ?? lastLink.createdAt)}{lastLink.createdById ? ` · ${senders.get(lastLink.createdById) ?? ""}` : ""}{lastLink.channel ? ` · ${MAIL_CHANNELS[lastLink.channel as MailChannel] ?? lastLink.channel}` : ""}{lastLink.status === "FAILED" && lastLink.error ? ` – ${lastLink.error}` : ""}</dd></>}
            {kd.status === "AUTHORIZED" && <><dt className="text-ink-3">Link</dt><dd>{activeLink ? `gültig bis ${fmtDateTime(activeLink.expiresAt)}${activeLink.lastUsedAt ? ` · zuletzt geöffnet ${fmtDateTime(activeLink.lastUsedAt)}` : " · noch nicht geöffnet"}` : "kein gültiger Link"}</dd></>}
            {kd.customerDropOffAt && <><dt className="text-ink-3">Abgabe laut Kunde</dt><dd className="font-medium">{fmtDateTime(kd.customerDropOffAt)}{kd.customerMileage != null ? ` · ${fmtInt(kd.customerMileage)} km` : ""}</dd></>}
            {kd.confirmedAt && <><dt className="text-ink-3">Gemeldet</dt><dd>{fmtDateTime(kd.confirmedAt)} · {kd.customerSignerName}</dd></>}
            {kd.inspectedAt && <><dt className="text-ink-3">Kontrolliert</dt><dd>{fmtDateTime(kd.inspectedAt)} · {kd.inspectedByName}</dd></>}
          </dl>
        )}

        {kd?.status === "AUTHORIZED" && canManage && !kd.inspection && (
          <div className="flex flex-col gap-3 border-t border-line pt-3">
            {isValidEmail(kd.recipientEmail) ? (
              <KeyDropSendButton bookingId={booking.id} keyDropId={kd.id} nonce={randomUUID()} recipientName={kd.recipientName} recipientEmail={kd.recipientEmail!} resend={kd.accesses.length > 0} />
            ) : (
              <p className="rounded-md bg-bad-soft text-bad px-3 py-2">Im Mietvertrag ist keine gültige E-Mail-Adresse des Mieters hinterlegt. Die Rückgabe-Mail kann nicht versendet werden.</p>
            )}
            {activeLink && <KeyDropRevokeButton bookingId={booking.id} keyDropId={kd.id} />}
            <KeyDropCancelForm bookingId={booking.id} keyDropId={kd.id} />
          </div>
        )}
        {kd?.status === "AUTHORIZED" && !canManage && <p className="text-xs text-ink-3">Rückgabe-Mail und Vereinbarung verwaltet die Disposition.</p>}

        {kd?.status === "CUSTOMER_CONFIRMED" && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <p className="rounded-md bg-amber-soft text-amber px-3 py-2 font-medium">Rückgabe gemeldet – Fahrzeugkontrolle ausstehend. Fahrzeug, Kaution, Rechnung und Zusatzkosten bleiben unverändert, bis die Kontrolle abgeschlossen ist.</p>
            {!supportMode && <div><Link href={`/buchungen/${booking.id}/rueckgabe`} className="btn btn-primary">{kd.inspection ? "Kontrolle fortsetzen" : "Schlüsselbox-Rückgabe prüfen"}</Link></div>}
          </div>
        )}
        {next && <p role="alert" className="rounded-md bg-bad-soft text-bad px-3 py-2">Achtung: Das Fahrzeug ist ab {fmtDateTime(next.startAt)} für Buchung <Link href={`/buchungen/${next.id}`} className="underline">{next.number}</Link> eingeplant. Die Rückgabeprüfung steht noch aus.</p>}
      </div>
    </Card>
  );
}
