import { Chip } from "@/components/ui";
import { DUE_LEVELS, MAINTENANCE_STATUS, MAINTENANCE_TYPES, type DueLevel, type MaintenanceStatus, type MaintenanceType } from "@/lib/constants";

type Tone = "good" | "amber" | "bad" | "info" | "grey";

export function MaintStatusChip({ status }: { status: string }) {
  const tone: Record<MaintenanceStatus, Tone> = { PLANNED: "grey", SCHEDULED: "info", IN_PROGRESS: "amber", COMPLETED: "good", CANCELLED: "grey" };
  const s = status as MaintenanceStatus;
  return <Chip tone={tone[s] ?? "grey"}>{MAINTENANCE_STATUS[s] ?? status}</Chip>;
}

/** Warnstand immer mit Text (nicht nur Farbe): „Überfällig · seit 14 Tagen überfällig“. */
export function DueChip({ level, text }: { level: DueLevel | "NONE"; text?: string }) {
  const tone: Record<DueLevel | "NONE", Tone> = { OK: "good", SOON: "amber", DUE: "bad", OVERDUE: "bad", NONE: "grey" };
  const label = level === "NONE" ? "Keine Fälligkeit" : DUE_LEVELS[level];
  return <Chip tone={tone[level]}>{label}{text ? ` · ${text}` : ""}</Chip>;
}

export function TypeChip({ type }: { type: string }) {
  return <Chip tone={type === "HU_AU" ? "info" : type === "DAMAGE_REPAIR" ? "amber" : "grey"}>{MAINTENANCE_TYPES[type as MaintenanceType] ?? type}</Chip>;
}
