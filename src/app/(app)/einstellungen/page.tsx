import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { ROLES, INVITATION_STATUS, type Role, type InvitationStatus } from "@/lib/constants";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { resendInvitationAction, revokeInvitationAction, toggleUserActiveAction } from "./actions";
import Link from "next/link";
import { InvoiceSettingsForm, InviteUserForm, TenantForm } from "./forms";
import { RoleSelect } from "./role-select";
import { invoiceSettingsMissing } from "@/lib/invoices";
import { termsOverview } from "@/lib/rental-terms";
import { listInvitations } from "@/lib/invitations";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { numberRangesOf } from "@/lib/number-ranges";

export const metadata = { title: "Einstellungen" };

export default async function SettingsPage({ searchParams }: PageProps<"/einstellungen">) {
  const { tenant, user: me } = await requireSession();
  const sp = await searchParams;
  const isOwner = me.role === "OWNER";
  const users = await db.user.findMany({ where: { tenantId: tenant.id }, orderBy: [{ active: "desc" }, { name: "asc" }] });
  const invitations = (await listInvitations(tenant.id)).filter((i) => i.status === "PENDING");
  const terms = await termsOverview(tenant.id);
  const ranges = numberRangesOf(tenant.numberRanges);

  return (
    <>
      <PageHeader title="Einstellungen" sub={tenant.name} />
      <Content>
        {sp.fehler === "selbst" && <Chip tone="bad">Das eigene Konto kann nicht deaktiviert werden.</Chip>}
        {typeof sp.fehler === "string" && sp.fehler !== "selbst" && <Chip tone="bad">{decodeURIComponent(sp.fehler)}</Chip>}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <Card title="Firmendaten">
            {isOwner ? (
              <TenantForm t={tenant} />
            ) : (
              <dl className="p-5 grid grid-cols-[120px_1fr] gap-y-1.5 text-sm">
                <dt className="label-xs self-center">Firma</dt><dd>{tenant.name}</dd>
                <dt className="label-xs self-center">Adresse</dt><dd>{[tenant.street, [tenant.zip, tenant.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "–"}</dd>
                <dt className="label-xs self-center">Telefon</dt><dd>{tenant.phone || "–"}</dd>
                <dt className="label-xs self-center">E-Mail</dt><dd>{tenant.email || "–"}</dd>
              </dl>
            )}
          </Card>

          <Card title="Mietbedingungen für Verträge" className="xl:row-start-2" right={terms.active ? <Chip tone="good">Version {terms.active.label} aktiv</Chip> : <Chip tone="amber">nicht veröffentlicht</Chip>}>
            <div className="p-5 flex flex-col gap-3 text-sm">
              {terms.active ? (
                <p>Aktive Mietbedingungen: <span className="font-medium">Version {terms.active.label}</span>{terms.active.effectiveFrom ? `, gültig seit ${fmtDate(terms.active.effectiveFrom)}` : terms.active.publishedAt ? `, veröffentlicht am ${fmtDate(terms.active.publishedAt)}` : ""}. Neue Mietverträge frieren genau diese Fassung ein; ältere Verträge behalten ihre damalige Fassung.</p>
              ) : (
                <p className="rounded-md bg-amber-soft text-amber px-3 py-2">Noch keine Mietbedingungen veröffentlicht. {terms.legacy.text ? "Neue Verträge nutzen bis dahin den bisherigen, unversionierten Text." : "Neue Verträge enthalten bis dahin keinen Bedingungstext."}{isOwner ? " Legen Sie unter „Mietbedingungen“ einen Entwurf an und veröffentlichen Sie ihn bewusst." : ""}</p>
              )}
              {terms.draft && <p className="text-ink-2">Offener Entwurf: Version {terms.draft.label} (noch nicht veröffentlicht).</p>}
              <div className="flex flex-wrap gap-2">
                <Link href="/einstellungen/mietbedingungen" className="btn btn-primary">Mietbedingungen und Fassungen</Link>
                <Link href="/einstellungen/geschaeftsregeln" className="btn">Geschäftsregeln</Link>
              </div>
              <p className="text-xs text-ink-3">Mietbedingungen sind der juristische Text (versioniert, unveränderlich nach Veröffentlichung). Geschäftsregeln sind operative Standardwerte wie Kaution, Kilometer, Tanken, Ausland – sie ersetzen den Text nicht.</p>
            </div>
          </Card>

          <Card title="Nummernkreise der Belege" right={<Chip>{ranges.invoice.prefix} · {ranges.creditNote.prefix} · {ranges.cancellation.prefix} · {ranges.payout.prefix}</Chip>}>
            <div className="p-5 flex flex-col gap-3 text-sm">
              <p>Rechnungen <span className="font-mono">{ranges.invoice.prefix}-JJJJ-NNNNNN</span>, Gutschriften <span className="font-mono">{ranges.creditNote.prefix}-JJJJ-NNNNNN</span>, Stornobelege <span className="font-mono">{ranges.cancellation.prefix}-JJJJ-NNNNNN</span>, Auszahlungen <span className="font-mono">{ranges.payout.prefix}-JJJJ-NNNNNN</span>. Jeder Kreis zählt für sich; Nummern werden beim Abschluss vergeben und nie wiederverwendet.</p>
              <div><Link href="/einstellungen/nummernkreise" className="btn">{isOwner ? "Nummernkreise verwalten" : "Nummernkreise ansehen"}</Link></div>
            </div>
          </Card>

          {isOwner && (
            <Card title="Rechnungsdaten und Steuer" className="xl:row-start-3 xl:col-span-2" right={invoiceSettingsMissing(tenant).length > 0 ? <Chip tone="amber">unvollständig</Chip> : <Chip tone="good">vollständig</Chip>}>
              {invoiceSettingsMissing(tenant).length > 0 && (
                <p className="mx-5 mt-4 rounded-md bg-amber-soft text-amber px-3 py-2 text-sm">Bevor Rechnungen erstellt werden können, fehlt noch: {invoiceSettingsMissing(tenant).join("; ")}.</p>
              )}
              <InvoiceSettingsForm t={{ legalForm: tenant.legalForm, country: tenant.country, vatId: tenant.vatId, taxNumber: tenant.taxNumber, bankName: tenant.bankName, iban: tenant.iban, bic: tenant.bic, invoiceFooter: tenant.invoiceFooter, paymentTermDays: tenant.paymentTermDays, defaultTaxRate: tenant.defaultTaxRate == null ? null : String(tenant.defaultTaxRate).replace(".", ","), pricesIncludeTax: tenant.pricesIncludeTax, taxNote: tenant.taxNote }} />
            </Card>
          )}

          <div className="flex flex-col gap-4">
            <Card title="Mitarbeiter" right={<Chip>{users.filter((u) => u.active).length} aktiv</Chip>}>
              <ul className="divide-y divide-line-soft">
                {users.map((u) => {
                  const toggle = toggleUserActiveAction.bind(null, u.id);
                  return (
                    <li key={u.id} className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{u.name}{u.id === me.id ? " (du)" : ""}</div>
                        <div className="text-xs text-ink-3">{u.email}{u.lastLoginAt ? ` · zuletzt angemeldet ${fmtDateTime(u.lastLoginAt)}` : " · noch nie angemeldet"}</div>
                      </div>
                      {isOwner && u.id !== me.id ? (
                        <RoleSelect userId={u.id} currentRole={u.role} />
                      ) : (
                        <Chip tone={u.role === "OWNER" ? "info" : "grey"}>{ROLES[u.role as Role] ?? u.role}</Chip>
                      )}
                      {!u.active && <Chip tone="bad">Deaktiviert</Chip>}
                      {isOwner && u.id !== me.id && (
                        <form action={toggle}><button className="btn !py-1">{u.active ? "Deaktivieren" : "Aktivieren"}</button></form>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
            {isOwner && invitations.length > 0 && (
              <Card title="Offene Einladungen">
                <ul className="divide-y divide-line-soft">
                  {invitations.map((inv) => {
                    const resend = resendInvitationAction.bind(null, inv.id);
                    const revoke = revokeInvitationAction.bind(null, inv.id);
                    return (
                      <li key={inv.id} className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium">{inv.email}</div>
                          <div className="text-xs text-ink-3">{ROLES[inv.role as Role] ?? inv.role} · {INVITATION_STATUS[inv.status as InvitationStatus] ?? inv.status} · gültig bis {fmtDateTime(inv.expiresAt)}</div>
                        </div>
                        <form action={resend}><button className="btn !py-1">Erneut senden</button></form>
                        <form action={revoke}><button className="btn !py-1">Widerrufen</button></form>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
            {isOwner && (
              <Card title="Mitarbeiter einladen">
                <InviteUserForm />
              </Card>
            )}
          </div>
        </div>
      </Content>
    </>
  );
}
