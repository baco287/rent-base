import { requireSession } from "@/lib/auth";
import { SMTP_STATUS } from "@/lib/constants";
import { Chip, Content } from "@/components/ui";
import { isFeatureEnabled } from "@/lib/features";
import { mailStatusOf } from "@/lib/tenant-mail";
import { TenantForm } from "./forms";
import { LogoManager } from "./logo-card";
import { SettingsHeader, SettingsSection } from "./settings-ui";

export const metadata = { title: "Einstellungen" };

/**
 * Befehl 29.3.1: Kategorie „Unternehmen“ des Einstellungscenters (bleibt unter /einstellungen, damit bestehende Links
 * funktionieren). Firmendaten und Logo; Rechnungsdaten liegen unter „Rechnungen & Belege“, Mitarbeiter unter
 * „Mitarbeiter & Berechtigungen“. Bearbeiten wie bisher nur der Inhaber.
 */
export default async function CompanySettingsPage() {
  const { tenant, user: me, supportSession } = await requireSession();
  const canEdit = me.role === "OWNER" && !supportSession;
  // Wer die Seite „E-Mail-Versand“ nicht öffnen kann (Hof, Supportmodus, Modul aus), sieht den Versandweg hier
  const mailPage = me.role !== "YARD" && !supportSession && (await isFeatureEnabled(tenant.id, "TENANT_SMTP"));
  const mail = mailPage ? null : await mailStatusOf(tenant.id);

  return (
    <>
      <SettingsHeader title="Unternehmen" sub="Firmendaten erscheinen auf neuen Verträgen, Protokollen, Rechnungen und in geschäftlichen E-Mails. Bereits erzeugte Dokumente behalten ihre damaligen Angaben." />
      <Content className="max-w-[1120px]">
        <div>
          <SettingsSection title="Firmendaten" description={canEdit ? "Name, Anschrift und Kontakt für den Briefkopf. Pflicht ist nur der Firmenname." : "Ändern kann diese Angaben nur der Inhaber."}>
            <div className="card">
              {canEdit ? (
                <TenantForm t={tenant} />
              ) : (
                <dl className="p-5 grid grid-cols-[120px_1fr] gap-y-1.5 text-sm">
                  <dt className="label-xs self-center">Firma</dt><dd>{tenant.name}</dd>
                  <dt className="label-xs self-center">Adresse</dt><dd>{[tenant.street, [tenant.zip, tenant.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "–"}</dd>
                  <dt className="label-xs self-center">Telefon</dt><dd>{tenant.phone || "–"}</dd>
                  <dt className="label-xs self-center">E-Mail</dt><dd>{tenant.email || "–"}</dd>
                  <dt className="label-xs self-center">Website</dt><dd>{tenant.website || "–"}</dd>
                </dl>
              )}
            </div>
          </SettingsSection>
          <SettingsSection title="Logo" description="Für Verträge, Protokolle, Rechnungen, Belege und geschäftliche E-Mails.">
            <div className="card">
              <LogoManager hasLogo={Boolean(tenant.logoStorageKey)} version={tenant.logoUpdatedAt?.toISOString() ?? "0"} canEdit={canEdit} />
            </div>
          </SettingsSection>
          {mail && (
            <SettingsSection title="E-Mail-Versand" description="Über welchen Weg geschäftliche E-Mails gehen.">
              <div className="card p-5 flex flex-wrap items-center gap-3 text-sm">
                <Chip tone={mail.status === "VERIFIED" ? "good" : mail.status === "ERROR" ? "bad" : mail.status === "CONFIGURED" ? "amber" : "grey"}>{SMTP_STATUS[mail.status]}</Chip>
                <span className="min-w-0 flex-1">{mail.mode === "TENANT_SMTP" ? "Geschäftliche E-Mails werden über Ihren eigenen SMTP-Server versendet." : "Geschäftliche E-Mails werden derzeit über den RentBase-Versanddienst versendet."}</span>
              </div>
            </SettingsSection>
          )}
        </div>
      </Content>
    </>
  );
}
