import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { ROLES, type Role } from "@/lib/constants";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { toggleUserActiveAction } from "./actions";
import { NewUserForm, TenantForm, TermsForm } from "./forms";

export const metadata = { title: "Einstellungen" };

export default async function SettingsPage({ searchParams }: PageProps<"/einstellungen">) {
  const { tenant, user: me } = await requireSession();
  const sp = await searchParams;
  const isOwner = me.role === "OWNER";
  const users = await db.user.findMany({ where: { tenantId: tenant.id }, orderBy: [{ active: "desc" }, { name: "asc" }] });

  return (
    <>
      <PageHeader title="Einstellungen" sub={tenant.name} />
      <Content>
        {sp.fehler === "selbst" && <Chip tone="bad">Das eigene Konto kann nicht deaktiviert werden.</Chip>}
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

          {isOwner && (
            <Card title="Mietbedingungen für Verträge" className="xl:row-start-2">
              <TermsForm version={tenant.rentalTermsVersion} text={tenant.rentalTermsText} />
            </Card>
          )}

          <div className="flex flex-col gap-4">
            <Card title="Mitarbeiter" right={<Chip>{users.filter((u) => u.active).length} aktiv</Chip>}>
              <ul className="divide-y divide-line-soft">
                {users.map((u) => {
                  const toggle = toggleUserActiveAction.bind(null, u.id);
                  return (
                    <li key={u.id} className="px-4 py-2.5 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{u.name}{u.id === me.id ? " (du)" : ""}</div>
                        <div className="text-xs text-ink-3">{u.email}</div>
                      </div>
                      <Chip tone={u.role === "OWNER" ? "info" : "grey"}>{ROLES[u.role as Role] ?? u.role}</Chip>
                      {!u.active && <Chip tone="bad">Deaktiviert</Chip>}
                      {isOwner && u.id !== me.id && (
                        <form action={toggle}><button className="btn !py-1">{u.active ? "Deaktivieren" : "Aktivieren"}</button></form>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
            {isOwner && (
              <Card title="Mitarbeiter anlegen">
                <NewUserForm />
              </Card>
            )}
          </div>
        </div>
      </Content>
    </>
  );
}
