import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { Chip, Content } from "@/components/ui";
import { DUNNING_HELP } from "@/lib/constants";
import { dunningSettingsOf } from "@/lib/dunning";
import { invoiceSettingsMissing } from "@/lib/invoices";
import { numberRangesOf } from "@/lib/number-ranges";
import { InvoiceSettingsForm } from "../forms";
import { updateDunningSettingsAction } from "../geschaeftsregeln/actions";
import { DunningSettingsForm } from "../geschaeftsregeln/rules-forms";
import { SettingsHeader, SettingsSection } from "../settings-ui";

export const metadata = { title: "Rechnungen & Belege" };

const eur = (c: number | null) => (c == null ? "–" : (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" }));

/**
 * Befehl 29.3.1: Kategorie „Rechnungen & Belege“ – Rechnungsdaten und Steuer (bisher auf der Einstellungsseite),
 * Mahnwesen (bisher bei den Geschäftsregeln) und die Nummernkreise im Überblick. Gleiche Formulare, gleiche Server
 * Actions (requireRole("OWNER")); Rechnungslogik und Nummernkreise unverändert.
 */
export default async function InvoiceSettingsPage() {
  const { tenant, user, supportSession } = await requireSession();
  const canEdit = user.role === "OWNER" && !supportSession;
  const missing = invoiceSettingsMissing(tenant);
  const dunning = dunningSettingsOf(tenant);
  const ranges = numberRangesOf(tenant.numberRanges);

  return (
    <>
      <SettingsHeader title="Rechnungen & Belege" sub="Angaben auf Rechnungen, Mahnfristen und Belegnummern. Abgeschlossene Rechnungen behalten ihre eingefrorenen Firmen- und Steuerdaten." />
      <Content className="max-w-[1120px]">
        <div>
          <SettingsSection
            id="rechnungsdaten"
            title="Rechnungsdaten und Steuer"
            description={canEdit ? "Rechtsform, Steuer, Bankverbindung und Fußtext. Ohne Steuersatz und Brutto/Netto-Angabe sind Rechnungen gesperrt." : "Ändern kann diese Angaben nur der Inhaber."}
          >
            {canEdit ? (
              <div className="card">
                <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
                  {missing.length > 0 ? <Chip tone="amber">unvollständig</Chip> : <Chip tone="good">vollständig</Chip>}
                </div>
                {missing.length > 0 && <p className="mx-5 mt-3 rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">Bevor Rechnungen erstellt werden können, fehlt noch: {missing.join("; ")}.</p>}
                <InvoiceSettingsForm t={{ legalForm: tenant.legalForm, country: tenant.country, vatId: tenant.vatId, taxNumber: tenant.taxNumber, bankName: tenant.bankName, iban: tenant.iban, bic: tenant.bic, invoiceFooter: tenant.invoiceFooter, paymentTermDays: tenant.paymentTermDays, defaultTaxRate: tenant.defaultTaxRate == null ? null : String(tenant.defaultTaxRate).replace(".", ","), pricesIncludeTax: tenant.pricesIncludeTax, taxNote: tenant.taxNote }} />
              </div>
            ) : (
              <div className="card p-5 text-sm text-ink-2">Rechnungsdaten und Steuer pflegt der Inhaber.</div>
            )}
          </SettingsSection>

          <SettingsSection id="mahnwesen" title="Mahnwesen" description="Zahlungsziel neuer Rechnungen, Fristen und Gebühren für Zahlungserinnerung und Mahnungen.">
            {canEdit ? (
              <div className="card">
                <div className="flex flex-wrap items-center gap-2 px-5 pt-4"><Chip>{dunning.feesEnabled ? "mit Gebühren" : "ohne Gebühren"}</Chip></div>
                <DunningSettingsForm action={updateDunningSettingsAction} v={dunning} help={{ fees: DUNNING_HELP.FEES, noAutomation: DUNNING_HELP.NO_AUTOMATION, noInterest: DUNNING_HELP.NO_INTEREST }} />
              </div>
            ) : (
              <div className="card p-5 text-sm">
                <p>Zahlungsziel {dunning.paymentTermDays == null ? "keins" : `${dunning.paymentTermDays} Tage`} · Fristen {dunning.reminderDays} / {dunning.firstDays} / {dunning.secondDays} Tage · {dunning.feesEnabled ? `Gebühren ${eur(dunning.firstFeeCents)} / ${eur(dunning.secondFeeCents)}` : "keine Mahngebühren"}</p>
                <p className="mt-2 text-xs text-ink-3">Ändern kann diese Werte nur der Inhaber.</p>
              </div>
            )}
          </SettingsSection>

          <SettingsSection id="nummernkreise" title="Nummernkreise" description="Belegnummern für Rechnungen, Gutschriften, Stornobelege und Auszahlungen.">
            <div className="card p-5 flex flex-col gap-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <Chip>Rechnungen <span className="font-mono">{ranges.invoice.prefix}</span></Chip>
                <Chip>Gutschriften <span className="font-mono">{ranges.creditNote.prefix}</span></Chip>
                <Chip>Stornobelege <span className="font-mono">{ranges.cancellation.prefix}</span></Chip>
                <Chip>Auszahlungen <span className="font-mono">{ranges.payout.prefix}</span></Chip>
              </div>
              <p className="text-ink-2">Jeder Kreis zählt für sich (<span className="font-mono">{ranges.invoice.prefix}-JJJJ-NNNNNN</span>); Nummern werden beim Abschluss vergeben und nie wiederverwendet.</p>
              <div><Link href="/einstellungen/nummernkreise" className="btn">{canEdit ? "Nummernkreise verwalten" : "Nummernkreise ansehen"}</Link></div>
            </div>
          </SettingsSection>
        </div>
      </Content>
    </>
  );
}
