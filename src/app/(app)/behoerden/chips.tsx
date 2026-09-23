import { Chip } from "@/components/ui";
import { AUTHORITY_CASE_STATUS, AUTHORITY_CASE_TYPES, AUTHORITY_RESPONSE_STATUS, DRIVER_DETERMINATION, RENTAL_MATCH, VEHICLE_MATCH, type AuthorityCaseStatus, type AuthorityCaseType, type DriverDetermination } from "@/lib/constants";

type Tone = "good" | "amber" | "bad" | "info" | "grey";

export function AuthorityStatusChip({ status }: { status: string }) {
  const tone: Record<AuthorityCaseStatus, Tone> = { RECEIVED: "info", ASSIGNMENT_REQUIRED: "amber", REVIEW_REQUIRED: "amber", RESPONSE_PREPARED: "info", READY_TO_SEND: "info", SUBMITTED: "good", CLOSED: "grey", CANCELLED: "grey" };
  const s = status as AuthorityCaseStatus;
  return <Chip tone={tone[s] ?? "grey"}>{AUTHORITY_CASE_STATUS[s] ?? status}</Chip>;
}

export function AuthorityTypeChip({ type }: { type: string }) {
  return <Chip tone={type === "DRIVER_IDENTIFICATION" || type === "AUTHORITY_REQUEST" ? "info" : "grey"}>{AUTHORITY_CASE_TYPES[type as AuthorityCaseType] ?? type}</Chip>;
}

/** Frist immer mit Text: „noch 3 Tage“, „heute fällig“, „seit 2 Tagen überfällig“ – nie erfunden. */
export function DeadlineChip({ level, text }: { level: "NONE" | "OK" | "SOON" | "DUE" | "OVERDUE"; text: string }) {
  const tone: Record<typeof level, Tone> = { OK: "good", SOON: "amber", DUE: "bad", OVERDUE: "bad", NONE: "grey" };
  return <Chip tone={tone[level]}>{level === "OVERDUE" ? "Überfällig · " : level === "DUE" ? "Fällig · " : ""}{text}</Chip>;
}

export function VehicleMatchChip({ status }: { status: string }) {
  const tone: Record<keyof typeof VEHICLE_MATCH, Tone> = { UNMATCHED: "grey", EXACT_MATCH: "good", NO_MATCH: "bad", AMBIGUOUS: "amber", MANUALLY_ASSIGNED: "info" };
  const s = status as keyof typeof VEHICLE_MATCH;
  return <Chip tone={tone[s] ?? "grey"}>{VEHICLE_MATCH[s] ?? status}</Chip>;
}

export function RentalMatchChip({ status, dayOnly }: { status: string; dayOnly?: boolean }) {
  const tone: Record<keyof typeof RENTAL_MATCH, Tone> = { UNMATCHED: "grey", ACTUAL_PERIOD: "good", PLANNED_PERIOD: "amber", AMBIGUOUS: "amber", NONE: "bad", MANUALLY_ASSIGNED: "info" };
  const s = status as keyof typeof RENTAL_MATCH;
  return <Chip tone={tone[s] ?? "grey"}>{RENTAL_MATCH[s] ?? status}{dayOnly && (s === "ACTUAL_PERIOD" || s === "PLANNED_PERIOD") ? " (nur tagesgenau)" : ""}</Chip>;
}

export function DriverChip({ status }: { status: string }) {
  const tone: Record<DriverDetermination, Tone> = { UNDETERMINED: "grey", CONTRACT_DRIVER_SELECTED: "info", OTHER_DRIVER_ENTERED: "info", NOT_IDENTIFIABLE: "amber", NO_DRIVER_INFORMATION: "amber" };
  const s = status as DriverDetermination;
  return <Chip tone={tone[s] ?? "grey"}>{DRIVER_DETERMINATION[s] ?? status}</Chip>;
}

export function ResponseStatusChip({ status }: { status: string }) {
  const tone: Record<keyof typeof AUTHORITY_RESPONSE_STATUS, Tone> = { DRAFT: "grey", APPROVED: "info", SUBMITTED: "good", FAILED: "bad", SUPERSEDED: "grey" };
  const s = status as keyof typeof AUTHORITY_RESPONSE_STATUS;
  return <Chip tone={tone[s] ?? "grey"}>{AUTHORITY_RESPONSE_STATUS[s] ?? status}</Chip>;
}
