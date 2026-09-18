import Link from "next/link";
import type { ReactNode } from "react";
import { BOOKING_STAGES, BOOKING_STATUS, VEHICLE_STATUS, type BookingStage, type BookingStatus, type VehicleStatus } from "@/lib/constants";

export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 md:px-6 py-3 border-b border-line-soft bg-panel">
      <h1 className="text-[22px] font-semibold">{title}</h1>
      {sub && <span className="text-ink-3 text-[13px]">{sub}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

export function Content({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`p-5 md:p-6 flex flex-col gap-4 ${className}`}>{children}</div>;
}

export function Card({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="flex items-center gap-2.5 px-3.5 py-3 border-b border-line-soft">
          <h2 className="text-base font-semibold">{title}</h2>
          <span className="flex-1" />
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

type Tone = "good" | "amber" | "bad" | "info" | "grey";
const toneClass: Record<Tone, string> = {
  good: "bg-good-soft text-good",
  amber: "bg-amber-soft text-amber",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
  grey: "bg-panel-2 text-ink-2",
};

export function Chip({ tone = "grey", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip ${toneClass[tone]}`}>{children}</span>;
}

export function Plate({ children }: { children: string }) {
  return <span className="plate">{children}</span>;
}

export function VehicleStatusChip({ status }: { status: string }) {
  const tone: Record<VehicleStatus, Tone> = { AVAILABLE: "good", WORKSHOP: "grey", BLOCKED: "bad", INACTIVE: "grey" };
  const s = status as VehicleStatus;
  return <Chip tone={tone[s] ?? "grey"}>{VEHICLE_STATUS[s] ?? status}</Chip>;
}

export function BookingStatusChip({ status }: { status: string }) {
  const tone: Record<BookingStatus, Tone> = { RESERVED: "info", ACTIVE: "amber", RETURNED: "good", CANCELLED: "grey" };
  const s = status as BookingStatus;
  return <Chip tone={tone[s] ?? "grey"}>{BOOKING_STATUS[s] ?? status}</Chip>;
}

/** Stand im Ablauf: Vertrag fehlt, Vertrag in Arbeit, bereit zur Übergabe, unterwegs, zurück, storniert. */
export function BookingStageChip({ stage }: { stage: BookingStage }) {
  const tone: Record<BookingStage, Tone> = { NEEDS_CONTRACT: "info", CONTRACT_DRAFT: "amber", READY_FOR_PICKUP: "good", ACTIVE: "amber", RETURNED: "grey", CANCELLED: "grey" };
  return <Chip tone={tone[stage]}>{BOOKING_STAGES[stage]}</Chip>;
}

export function Empty({ children, action }: { children: ReactNode; action?: { href: string; label: string } }) {
  return (
    <div className="p-10 text-center text-ink-3 flex flex-col items-center gap-3">
      <p>{children}</p>
      {action && (
        <Link href={action.href} className="btn btn-primary">
          {action.label}
        </Link>
      )}
    </div>
  );
}

export function Field({ label, htmlFor, children, hint, full }: { label: string; htmlFor?: string; children: ReactNode; hint?: string; full?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 ${full ? "md:col-span-2" : ""}`}>
      <label htmlFor={htmlFor} className="label-xs">{label}</label>
      {children}
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </div>
  );
}

export function FormError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="md:col-span-2 text-bad bg-bad-soft rounded-md px-3 py-2 text-sm">
      {error}
    </p>
  );
}

export function KPI({ label, value, detail, hot }: { label: string; value: ReactNode; detail?: ReactNode; hot?: boolean }) {
  return (
    <div className={`rounded-lg px-3.5 py-3 flex flex-col gap-0.5 ${hot ? "bg-amber-soft" : "bg-panel-2"}`}>
      <span className="label-xs">{label}</span>
      <span className={`font-display text-3xl font-semibold leading-tight tnum ${hot ? "text-amber" : ""}`}>{value}</span>
      {detail && <span className="text-xs text-ink-2">{detail}</span>}
    </div>
  );
}
