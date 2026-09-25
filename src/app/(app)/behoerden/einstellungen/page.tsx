import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { listContacts } from "@/lib/authority-contacts";
import { deadlineDigest, reminderRecipients } from "@/lib/authority-reminders";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { deleteContactAction, saveReminderSettingsAction, sendReminderNowAction, updateContactAction } from "../actions";
import { ContactEditForm, ReminderSettingsForm, SimpleButton } from "../authority-forms";

export const metadata = { title: "Behörden – Einstellungen" };

/** Behörden-Adressbuch (lernt aus erfassten Vorgängen) und tägliche Fristen-Erinnerung. */
export default async function AuthoritySettingsPage() {
  const { tenant, user } = await requireRole("DISPO");
  const isOwner = user.role === "OWNER";
  const [contacts, t, recipients] = await Promise.all([
    listContacts(tenant.id),
    db.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { authorityReminderDays: true, authorityReminderEmail: true } }),
    reminderRecipients(tenant.id),
  ]);
  const due = t.authorityReminderDays > 0 ? await deadlineDigest(tenant.id, t.authorityReminderDays) : [];

  return (
    <>
      <PageHeader title="Behörden – Einstellungen" sub="Adressbuch und Fristen-Erinnerung">
        <Link href="/behoerden" className="btn">Übersicht</Link>
      </PageHeader>
      <Content>
        <Card title="Fristen-Erinnerung per E-Mail" right={<Chip tone={t.authorityReminderDays > 0 ? "good" : "grey"}>{t.authorityReminderDays > 0 ? "aktiv" : "aus"}</Chip>}>
          <div className="p-4 flex flex-col gap-4 text-sm">
            <p className="text-ink-2">Jeden Morgen ab 7 Uhr schickt Rent-Base eine Übersicht aller offenen Behördenvorgänge, deren Antwortfrist überschritten ist, heute endet oder bald endet – höchstens eine E-Mail pro Tag und Empfänger. Am Vorgang ändert die Erinnerung nichts.</p>
            <ReminderSettingsForm action={saveReminderSettingsAction} days={t.authorityReminderDays} email={t.authorityReminderEmail ?? ""} canEdit={isOwner} fallback="alle aktiven Inhaber und Disponenten" />
            <div className="text-xs text-ink-3">Empfänger zurzeit: {recipients.length ? recipients.join(", ") : "keiner mit gültiger E-Mail-Adresse"}{!isOwner && " · Ändern kann der Inhaber."}</div>
            {t.authorityReminderDays > 0 && (
              <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-3">
                <span>{due.length === 0 ? "Heute stünde nichts in der Erinnerung." : `Heute in der Erinnerung: ${due.length} ${due.length === 1 ? "Vorgang" : "Vorgänge"} (${due.filter((d) => d.level === "OVERDUE").length} überfällig).`}</span>
                {isOwner && due.length > 0 && <SimpleButton action={sendReminderNowAction} label="Heutige Erinnerung jetzt senden" pendingLabel="Wird gesendet…" />}
              </div>
            )}
          </div>
        </Card>

        <Card title="Behörden-Adressbuch" right={<Chip>{contacts.length}</Chip>}>
          <div className="p-4 flex flex-col gap-3 text-sm">
            <p className="text-ink-2">Das Adressbuch füllt sich von selbst: Beim Anlegen oder Ändern eines Vorgangs merkt sich Rent-Base Name, Anschrift, E-Mail und Portal der Behörde. Beim nächsten Schreiben derselben Behörde werden diese Angaben vorgeschlagen – auch beim Hochladen eines PDFs. Löschen oder Ändern wirkt nur auf künftige Vorschläge, nie auf bestehende Vorgänge.</p>
            {contacts.length === 0 ? <p className="text-ink-3">Noch keine Behörde gespeichert – der erste erfasste Vorgang legt den Eintrag an.</p> : (
              <ul className="divide-y divide-line-soft">
                {contacts.map((c) => (
                  <li key={c.id} className="py-3">
                    <ContactEditForm save={updateContactAction.bind(null, c.id)} remove={deleteContactAction.bind(null, c.id)} contact={{ id: c.id, name: c.name, department: c.department ?? "", address: c.address ?? "", email: c.email ?? "", portalUrl: c.portalUrl ?? "", useCount: c.useCount }} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </Content>
    </>
  );
}
