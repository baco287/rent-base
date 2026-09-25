import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { Card, Chip, Content, PageHeader } from "@/components/ui";
import { computeSetupCheck } from "./setup-check";
import { CompleteOnboardingButton } from "./complete-button";

export const metadata = { title: "Einrichtung" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const { tenant } = await requireRole("OWNER");
  const check = await computeSetupCheck(tenant.id);
  const ready = check.blockers.length === 0;

  return (
    <>
      <PageHeader title="Einrichtung" sub={tenant.name} />
      <Content className="max-w-2xl">
        <p className="text-ink-2 mb-4">Richten Sie {tenant.name} ein. Jeder Punkt führt zur passenden, ganz normalen Einstellungsseite – es entsteht keine zweite Kopie Ihrer Daten.</p>
        <Card>
          <ul className="divide-y divide-line-soft">
            {check.items.map((i) => (
              <li key={i.key} className="px-4 py-3 flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full shrink-0 ${i.done ? "bg-good" : i.blocker ? "bg-bad" : "bg-amber"}`} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{i.label}</div>
                  {i.hint && !i.done && <div className="text-xs text-ink-3">{i.hint}</div>}
                </div>
                {i.done ? <Chip tone="good">erledigt</Chip> : <Chip tone={i.blocker ? "bad" : "amber"}>{i.blocker ? "erforderlich" : "empfohlen"}</Chip>}
                <Link href={i.href} className="btn !py-1">Öffnen</Link>
              </li>
            ))}
          </ul>
        </Card>

        <div className="mt-5">
          {ready ? (
            <Card>
              <div className="p-5 flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-good">Bereit für erste Vermietung</div>
                  <p className="text-sm text-ink-2">Alle erforderlichen Punkte sind erledigt. Empfohlene Punkte können Sie jederzeit später ergänzen.</p>
                </div>
                {tenant.status === "PENDING_SETUP" && <CompleteOnboardingButton />}
              </div>
            </Card>
          ) : (
            <p className="text-sm text-ink-3">Es fehlen noch {check.blockers.length} erforderliche {check.blockers.length === 1 ? "Punkt" : "Punkte"}.</p>
          )}
        </div>
      </Content>
    </>
  );
}
