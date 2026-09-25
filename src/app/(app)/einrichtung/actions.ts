"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/integrity";
import { computeSetupCheck } from "./setup-check";

/** Schließt die Einrichtung ab (PENDING_SETUP → ACTIVE), nur wenn keine Blocker mehr offen sind (item 54). */
export async function completeOnboardingAction() {
  const { tenant } = await requireRole("OWNER");
  const check = await computeSetupCheck(tenant.id);
  if (check.blockers.length > 0) throw new DomainError("Es sind noch Pflichtpunkte offen.");
  if (tenant.status === "PENDING_SETUP") await db.tenant.update({ where: { id: tenant.id }, data: { status: "ACTIVE" } });
  revalidatePath("/", "layout");
}
