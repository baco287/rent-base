import { Chip } from "@/components/ui";
import { TERMS_STATUS, type TermsStatus } from "@/lib/constants";

export function TermsStatusChip({ status, active, pending }: { status: string; active?: boolean; pending?: boolean }) {
  const tone = status === "PUBLISHED" ? (active ? "good" : pending ? "amber" : "info") : status === "DRAFT" ? "amber" : "grey";
  return <Chip tone={tone}>{TERMS_STATUS[status as TermsStatus] ?? status}{active ? " · aktiv" : pending ? " · gilt später" : ""}</Chip>;
}
