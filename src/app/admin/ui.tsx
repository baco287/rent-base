import Link from "next/link";
import type { ReactNode } from "react";
import { Chip } from "@/components/ui";
import { PLANS, PLATFORM_ROLES, SUBSCRIPTION_STATUS, TENANT_STATUS, type PlanKey, type PlatformRole, type SubscriptionStatus, type TenantStatus } from "@/lib/constants";
import { fmtEur } from "@/lib/format";

type Sp = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** Rückmeldungen über die URL (?fehler=rechte, ?ok=…) – Aktionen mit Zustand nutzen stattdessen FormError. */
export function Notice({ sp }: { sp: Sp }) {
  const fehler = str(sp.fehler);
  const ok = str(sp.ok);
  if (!fehler && !ok) return null;
  return (
    <div className="flex flex-col gap-2">
      {fehler === "rechte" && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">Diese Aktion ist für Ihre interne Rolle nicht freigegeben.</p>}
      {fehler && fehler !== "rechte" && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">{fehler}</p>}
      {ok && <p className="text-good bg-good-soft rounded-md px-3 py-2 text-sm">{ok}</p>}
    </div>
  );
}

export function TenantStatusChip({ status }: { status: string }) {
  const tone = status === "ACTIVE" ? "good" : status === "SUSPENDED" ? "bad" : "amber";
  return <Chip tone={tone}>{TENANT_STATUS[status as TenantStatus] ?? status}</Chip>;
}

export function SubscriptionStatusChip({ status }: { status: string | null | undefined }) {
  if (!status) return <Chip tone="grey">Kein Tarif</Chip>;
  const tone = status === "ACTIVE" ? "good" : status === "TRIAL" ? "info" : status === "PAST_DUE" ? "bad" : status === "CANCELLED" ? "amber" : "grey";
  return <Chip tone={tone}>{SUBSCRIPTION_STATUS[status as SubscriptionStatus] ?? status}</Chip>;
}

export function PlanChip({ plan }: { plan: string | null | undefined }) {
  if (!plan) return <span className="text-ink-3">–</span>;
  return <Chip tone={plan === "INTERNAL" ? "grey" : "info"}>{PLANS[plan as PlanKey] ?? plan}</Chip>;
}

export function PlatformRoleChip({ role }: { role: string }) {
  if (role === "NONE") return null;
  return <Chip tone={role === "SUPER_ADMIN" ? "bad" : role === "READ_ONLY_ADMIN" ? "grey" : "amber"}>{PLATFORM_ROLES[role as PlatformRole] ?? role}</Chip>;
}

export function eur(cents: number | null | undefined): string {
  return cents == null ? "–" : fmtEur(cents / 100);
}

/** Definitionsliste für Stammdaten-Karten. */
export function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[160px_1fr] gap-y-1.5 gap-x-3 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="label-xs self-center">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? <span className="text-ink-3">–</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Seitenweise Navigation; `href(p)` liefert die Adresse einer Seite (Filter bleiben erhalten). */
export function Pagination({ page, total, pageSize, href }: { page: number; total: number; pageSize: number; href: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const window = Array.from({ length: pages }, (_, i) => i + 1).filter((p) => p === 1 || p === pages || Math.abs(p - page) <= 2);
  return (
    <div className="flex gap-1.5 items-center text-sm flex-wrap">
      {window.map((p, i) => (
        <span key={p} className="contents">
          {i > 0 && window[i - 1] !== p - 1 && <span className="text-ink-3 px-1">…</span>}
          <Link href={href(p)} className={`px-2.5 py-1 rounded-md tnum ${p === page ? "bg-brand text-white" : "hover:bg-surface-2"}`} aria-current={p === page ? "page" : undefined}>{p}</Link>
        </span>
      ))}
      <span className="text-ink-3 ml-2">{total} Einträge</span>
    </div>
  );
}

/** Adresse mit übernommenen Filtern (leere Werte werden weggelassen). */
export function withParams(base: string, params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== 0) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

/** Sprungleiste zu den Abschnitten einer Detailseite. */
export function SectionNav({ sections }: { sections: [string, string][] }) {
  return (
    <nav className="flex flex-wrap gap-1.5 text-[13px]" aria-label="Abschnitte">
      {sections.map(([id, label]) => (
        <a key={id} href={`#${id}`} className="px-2.5 py-1 rounded-md bg-panel-2 hover:bg-line-soft">{label}</a>
      ))}
    </nav>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium text-left ${className}`}>{children}</th>;
}
export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-ink-3">{children}</td>
    </tr>
  );
}
