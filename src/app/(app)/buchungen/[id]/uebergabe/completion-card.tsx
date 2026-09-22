// „Vor Abschluss prüfen“: Serverkomponente, liest ausschließlich getHandoverCompletionStatus (dieselben Regeln wie der
// Abschluss). Jeder Punkt führt zum passenden Schritt. Blocker und Hinweise sind textlich gekennzeichnet, nicht nur farblich.
import Link from "next/link";
import { Card } from "@/components/ui";
import type { CompletionStatus } from "@/lib/completion";

export function CompletionCard({ status, basePath, okText }: { status: CompletionStatus; basePath: string; okText: string }) {
  const { blockers, warnings } = status;
  const n = blockers.length;
  return (
    <Card title="Vor Abschluss prüfen" right={n > 0 ? <span className="chip bg-bad-soft text-bad">{n === 1 ? "1 Punkt offen" : `${n} Punkte offen`}</span> : <span className="chip bg-good-soft text-good">bereit</span>}>
      <div className="p-4 flex flex-col gap-3 text-sm">
        {n === 0 && warnings.length === 0 && <p className="text-good font-medium">{okText}</p>}
        {n === 0 && warnings.length > 0 && <p className="text-good font-medium">{okText} Die Hinweise unten blockieren nicht.</p>}
        {n > 0 && (
          <div role="alert" aria-label="Offene Punkte, die den Abschluss verhindern">
            <div className="font-semibold mb-1.5">{n === 1 ? "1 Punkt muss noch erledigt werden." : `${n} Punkte müssen noch erledigt werden.`}</div>
            <ul className="flex flex-col gap-1.5">
              {blockers.map((b) => (
                <li key={b.code} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-bad-soft px-3 py-2">
                  <span><span className="font-medium text-bad">Muss erledigt werden:</span> {b.message}</span>
                  <Link href={`${basePath}?schritt=${b.step}`} className="btn !py-1 !px-2.5 text-xs" aria-label={`Zu Schritt ${b.step}: ${b.stepLabel}`}>Zu Schritt {b.step}: {b.stepLabel}</Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {warnings.length > 0 && (
          <div aria-label="Hinweise, die den Abschluss nicht verhindern">
            <div className="font-semibold mb-1.5">{warnings.length === 1 ? "1 Hinweis" : `${warnings.length} Hinweise`} – der Abschluss ist trotzdem möglich.</div>
            <ul className="flex flex-col gap-1.5">
              {warnings.map((w) => (
                <li key={w.code} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-amber-soft px-3 py-2">
                  <span><span className="font-medium text-amber">Hinweis:</span> {w.message}</span>
                  {w.code !== "DEPOSIT_NOT_RECEIVED" && <Link href={`${basePath}?schritt=${w.step}`} className="btn !py-1 !px-2.5 text-xs" aria-label={`Zu Schritt ${w.step}: ${w.stepLabel}`}>Zu Schritt {w.step}: {w.stepLabel}</Link>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
