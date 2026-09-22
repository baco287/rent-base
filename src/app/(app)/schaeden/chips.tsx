import { Chip } from "@/components/ui";
import { DAMAGE_CASE_STATUS, LIABILITY_STATUS, type DamageCaseStatus, type LiabilityStatus } from "@/lib/constants";

type Tone = "good" | "amber" | "bad" | "info" | "grey";

export function CaseStatusChip({ status }: { status: string }) {
  const tone: Record<DamageCaseStatus, Tone> = { OPEN: "amber", UNDER_REVIEW: "info", REPAIR_PLANNED: "info", IN_REPAIR: "amber", REPAIRED: "good", CLOSED: "grey" };
  const s = status as DamageCaseStatus;
  return <Chip tone={tone[s] ?? "grey"}>{DAMAGE_CASE_STATUS[s] ?? status}</Chip>;
}

export function LiabilityChip({ status }: { status: string }) {
  const tone: Record<LiabilityStatus, Tone> = { UNASSESSED: "amber", UNCLEAR: "amber", CUSTOMER_RESPONSIBILITY_CONFIRMED: "bad", NOT_CUSTOMER_RESPONSIBILITY: "good", THIRD_PARTY: "info", INTERNAL: "grey" };
  const s = status as LiabilityStatus;
  return <Chip tone={tone[s] ?? "grey"}>{LIABILITY_STATUS[s] ?? status}</Chip>;
}
