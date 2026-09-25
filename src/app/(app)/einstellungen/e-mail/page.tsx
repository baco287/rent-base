import Link from "next/link";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { SMTP_ERROR_CODES, SMTP_MODES, SMTP_STATUS, SMTP_SECURITY, type SmtpStatus } from "@/lib/constants";
import { getMailSettingsView } from "@/lib/tenant-mail";
import { fmtDateTime } from "@/lib/format";
import { DisableButton, EnableButton, SendTestMailButton, SmtpSettingsForm, TestConnectionButton } from "./forms";

export const metadata = { title: "E-Mail-Versand" };

const statusTone: Record<SmtpStatus, "good" | "amber" | "bad" | "grey"> = { NOT_CONFIGURED: "grey", CONFIGURED: "amber", VERIFIED: "good", ERROR: "bad" };

/**
 * Befehl 20.5: E-Mail-Versand des Mandanten. Inhaber verwaltet, Disposition sieht nur den Zustand,
 * Hofmitarbeiter (und der Supportmodus, der als Hofmitarbeiter erscheint) nicht.
 * Das gespeicherte Passwort wird nie geladen – die Seite erhält nur „gespeichert ja/nein“.
 */
export default async function MailSettingsPage() {
  const { tenant, user, supportSession } = await requireSession();
  if (user.role === "YARD" || supportSession) redirect("/einstellungen");
  const isOwner = user.role === "OWNER";
  const v = await getMailSettingsView(tenant.id);
  const tenantSmtp = v.mode === "TENANT_SMTP";
  const stopped = tenantSmtp && v.status !== "VERIFIED";

  return (
    <>
      <PageHeader title="E-Mail-Versand" sub={tenant.name}>
        <Link href="/einstellungen" className="btn">Einstellungen</Link>
      </PageHeader>
      <Content>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <Card title="Aktueller Versandweg" right={<Chip tone={tenantSmtp ? (stopped ? "bad" : "good") : "info"}>{SMTP_MODES[v.mode]}</Chip>}>
            <div className="p-5 flex flex-col gap-3 text-sm">
              {tenantSmtp ? (
                stopped ? (
                  <p className="rounded-md bg-bad-soft text-bad px-3 py-2">Der eigene E-Mail-Versand ist aktiv, aber nicht erfolgreich geprüft. Geschäftliche E-Mails werden nicht versendet, bis „Verbindung testen“ wieder erfolgreich ist. Es wird nicht automatisch auf RentBase umgeschaltet.</p>
                ) : (
                  <p>Geschäftliche E-Mails an Ihre Kunden werden über Ihren eigenen SMTP-Server versendet, Absender: <span className="font-medium break-all">{v.fromName} &lt;{v.fromEmail}&gt;</span>.</p>
                )
              ) : (
                <>
                  <p>Geschäftliche E-Mails werden derzeit über den RentBase-Versanddienst versendet. Absendername ist Ihr Firmenname, Antworten gehen an Ihre Firmen-E-Mail.</p>
                  <p className="rounded-md bg-amber-soft text-amber px-3 py-2">Empfohlen: Eigener E-Mail-Versand, damit Kunden Nachrichten direkt von Ihrer Firmenadresse erhalten.</p>
                </>
              )}
              <p className="text-xs text-ink-3">Einladungen und Passwort-Zurücksetzen verschickt immer RentBase selbst – unabhängig von dieser Einstellung, damit der Zugang zu RentBase nie von Ihrem Mailserver abhängt.</p>
            </div>
          </Card>

          <Card title="Status" right={<Chip tone={statusTone[v.status]}>{SMTP_STATUS[v.status]}</Chip>}>
            <dl className="p-5 grid grid-cols-[130px_1fr] gap-y-1.5 text-sm">
              <dt className="label-xs self-center">Absender</dt><dd className="break-all">{v.fromEmail ? `${v.fromName ?? ""} <${v.fromEmail}>` : "–"}</dd>
              {isOwner && <><dt className="label-xs self-center">Server</dt><dd className="break-all">{v.host ? `${v.host}:${v.port} · ${v.security ? SMTP_SECURITY[v.security] : ""}` : "–"}</dd></>}
              <dt className="label-xs self-center">Zuletzt geprüft</dt><dd>{v.verifiedAt ? `${fmtDateTime(v.verifiedAt)}${v.verifiedByName ? ` · ${v.verifiedByName}` : ""}` : "–"}</dd>
              {v.lastErrorCode && <><dt className="label-xs self-center">Letzter Fehler</dt><dd className="text-bad">{SMTP_ERROR_CODES[v.lastErrorCode]}{v.lastErrorAt ? ` · ${fmtDateTime(v.lastErrorAt)}` : ""}</dd></>}
            </dl>
          </Card>

          {isOwner && (
            <Card title="SMTP-Zugang" className="xl:col-span-2">
              {!v.keyConfigured && <p className="mx-5 mt-5 rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">Der eigene E-Mail-Versand ist auf diesem Server noch nicht freigeschaltet: Für die verschlüsselte Speicherung von Zugangsdaten fehlt der Server-Schlüssel. Bitte wenden Sie sich an RentBase. Bis dahin werden geschäftliche E-Mails über den RentBase-Versanddienst versendet.</p>}
              <SmtpSettingsForm disabled={!v.keyConfigured} v={{ host: v.host ?? "", port: v.port ?? 587, security: v.security ?? "STARTTLS", username: v.username ?? "", hasPassword: v.hasPassword, fromName: v.fromName ?? tenant.name, fromEmail: v.fromEmail ?? "", replyTo: v.replyTo ?? "" }} />
              {v.status !== "NOT_CONFIGURED" && (
                <div className="border-t border-line p-5 flex flex-col gap-4">
                  <p className="text-sm text-ink-2">1. Verbindung testen (Server, Verschlüsselung, Anmeldung – es wird nichts versendet). 2. Testmail an sich selbst senden. 3. Eigenen Versand aktivieren.</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
                    <TestConnectionButton disabled={!v.keyConfigured} />
                    <SendTestMailButton disabled={v.status !== "VERIFIED"} nonce={randomUUID()} recipient={user.email} />
                    {tenantSmtp ? <DisableButton /> : <EnableButton disabled={v.status !== "VERIFIED"} />}
                  </div>
                  {v.status !== "VERIFIED" && <p className="text-xs text-ink-3">Testmail und Aktivierung sind erst nach einem erfolgreichen Verbindungstest möglich. Jede Änderung an Server, Port, Verschlüsselung, Benutzer, Passwort oder Absenderadresse verlangt einen neuen Test.</p>}
                </div>
              )}
            </Card>
          )}
        </div>
      </Content>
    </>
  );
}
