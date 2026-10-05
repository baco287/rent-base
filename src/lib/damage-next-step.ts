// Vermieter-Oberfläche (Vorschlag 4): „Nächster Schritt“ einer Schadenakte für die Übersicht. Reine Ableitung aus den
// Feldern, die die Liste ohnehin lädt – keine zusätzliche Abfrage, keine Entscheidung. Die Aktion führt immer nur zum
// passenden Abschnitt der Akte; Haftung, Belastung und Abschluss bleiben ausdrückliche Entscheidungen dort.
// Abhängigkeitsfrei, damit in node:test prüfbar.

export type NextStepInput = {
  id: string;
  caseNumber: string;
  status: string; // DamageCaseStatus
  liabilityStatus: string; // LiabilityStatus
  reportedAt: Date;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  customerChargeCents: number | null;
  vehicle: { plate: string; status: string };
  damage: { description: string };
  invoice: { status: string } | null;
  payment: { status: string } | null;
};

export type CaseNextStep = {
  /** 1 = am dringendsten */
  rank: number;
  /** Text auf der Schaltfläche */
  action: string;
  /** Satzteil für den Hinweis „… wartet seit N Tagen auf …“ */
  waitingFor: string;
  href: string;
};

const LIABILITY_OPEN = new Set(["UNASSESSED", "UNCLEAR"]);

/** Nächster sinnvoller Schritt einer Akte oder null (geschlossen bzw. nichts offen außer Weiterverfolgung). */
export function nextCaseStep(c: NextStepInput): CaseNextStep | null {
  if (c.status === "CLOSED") return null;
  const href = (anchor: string) => `/schaeden/${c.id}#${anchor}`;
  if (LIABILITY_OPEN.has(c.liabilityStatus)) return { rank: 1, action: "Haftung bewerten", waitingFor: "die Haftungsentscheidung", href: href("haftung") };
  if (c.liabilityStatus === "CUSTOMER_RESPONSIBILITY_CONFIRMED") {
    if (!c.invoice && c.customerChargeCents == null) return { rank: 2, action: "Kunde belasten", waitingFor: "die Kundenbelastung", href: href("belastung") };
    if (c.invoice?.status === "DRAFT") return { rank: 2, action: "Abrechnung abschließen", waitingFor: "den Abschluss der Schadenabrechnung", href: href("belastung") };
    if (c.payment && (c.payment.status === "OPEN" || c.payment.status === "PARTIAL")) return { rank: 4, action: "Zahlung prüfen", waitingFor: "den Zahlungseingang", href: href("belastung") };
  }
  if (c.status === "REPAIRED") {
    if (c.vehicle.status === "BLOCKED") return { rank: 3, action: "Fahrzeug freigeben", waitingFor: "die Freigabe des Fahrzeugs", href: href("fahrzeug") };
    return { rank: 5, action: "Akte schließen", waitingFor: "den Abschluss", href: href("abschluss") };
  }
  if ((c.status === "OPEN" || c.status === "UNDER_REVIEW") && c.estimatedCostCents == null && c.actualCostCents == null) return { rank: 6, action: "Kosten erfassen", waitingFor: "eine Kostenschätzung", href: href("kosten") };
  if (c.status === "REPAIR_PLANNED" || c.status === "IN_REPAIR") return { rank: 7, action: "Reparatur verfolgen", waitingFor: "den Reparaturfortschritt", href: href("reparatur") };
  return { rank: 8, action: "Akte prüfen", waitingFor: "eine Entscheidung zum weiteren Vorgehen", href: `/schaeden/${c.id}` };
}

/** Dringendste Akte: niedrigster Rang, bei Gleichstand die älteste. Nur Ränge bis 6 gelten als „wartet auf Entscheidung“. */
export function mostUrgentCase<T extends NextStepInput>(cases: readonly T[]): { item: T; step: CaseNextStep } | null {
  let best: { item: T; step: CaseNextStep } | null = null;
  for (const item of cases) {
    const step = nextCaseStep(item);
    if (!step || step.rank > 6) continue;
    if (!best || step.rank < best.step.rank || (step.rank === best.step.rank && item.reportedAt < best.item.reportedAt)) best = { item, step };
  }
  return best;
}
