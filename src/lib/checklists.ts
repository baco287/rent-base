// Checklisten-Vorlagen je Mandant, optional je Fahrzeuggruppe, versioniert.
// Ein Protokoll kopiert die Fragen beim Start (siehe handovers.ts). Änderungen an der Vorlage
// erzeugen eine neue Version und wirken nur auf künftige Protokolle.

import type { Prisma } from "@prisma/client";
import { driveClassOf, type ChecklistAnswerType, type DriveClass, type HandoverType } from "@/lib/constants";
import { DomainError } from "@/lib/integrity";

type Tx = Prisma.TransactionClient;

/** appliesTo leer/fehlend = gilt für alle Antriebe; sonst nur für die genannten Antriebsklassen (COMBUSTION, ELECTRIC, PHEV). */
export type ChecklistItemDef = { key: string; label: string; answerType: ChecklistAnswerType; required: boolean; appliesTo?: DriveClass[] };

const CHARGING = ["ELECTRIC", "PHEV"] as DriveClass[];

/** Punkte, die zum Antrieb des Fahrzeugs passen. Wird beim Kopieren in ein Protokoll angewendet; bestehende Protokolle bleiben unberührt. */
export function itemsForDrive(items: ChecklistItemDef[], driveType: string): ChecklistItemDef[] {
  const cls = driveClassOf(driveType);
  return items.filter((i) => !i.appliesTo || i.appliesTo.length === 0 || i.appliesTo.includes(cls));
}

/** Standard, solange ein Mandant keine eigene Vorlage hat. */
export const DEFAULT_CHECKLIST: ChecklistItemDef[] = [
  { key: "documents", label: "Fahrzeugschein und Bordmappe vorhanden", answerType: "YES_NO", required: true },
  { key: "warning_triangle", label: "Warndreieck, Warnweste, Verbandkasten vorhanden", answerType: "YES_NO", required: true },
  { key: "keys", label: "Anzahl übergebener Schlüssel", answerType: "TEXT", required: true },
  { key: "tires", label: "Reifen und Felgen", answerType: "OK_NOT_OK", required: true },
  { key: "lights", label: "Beleuchtung funktioniert", answerType: "OK_NOT_OK", required: true },
  { key: "interior_clean", label: "Innenraum sauber", answerType: "OK_NOT_OK", required: true },
  { key: "exterior_clean", label: "Außen sauber", answerType: "OK_NOT_OK", required: true },
  { key: "warning_lights", label: "Keine Warnleuchten im Display", answerType: "OK_NOT_OK", required: true },
  { key: "charging_cable", label: "Ladekabel und Ladezubehör übergeben", answerType: "YES_NO", required: true, appliesTo: CHARGING },
  { key: "remarks", label: "Bemerkungen", answerType: "TEXT", required: false },
];

/** Standard für die Rückgabe. Zusammen mit der Übergabe-Checkliste erkennt der Mitarbeiter fehlende Gegenstände. */
export const DEFAULT_RETURN_CHECKLIST: ChecklistItemDef[] = [
  { key: "keys_returned", label: "Anzahl zurückgegebener Schlüssel", answerType: "TEXT", required: true },
  { key: "documents", label: "Fahrzeugschein und Bordmappe vorhanden", answerType: "YES_NO", required: true },
  { key: "warning_triangle", label: "Warndreieck vorhanden", answerType: "YES_NO", required: true },
  { key: "safety_vest", label: "Warnweste vorhanden", answerType: "YES_NO", required: true },
  { key: "first_aid", label: "Verbandkasten vorhanden", answerType: "YES_NO", required: true },
  { key: "charging_cable", label: "Ladekabel und Ladezubehör zurück", answerType: "YES_NO", required: true, appliesTo: CHARGING },
  { key: "interior_checked", label: "Innenraum geprüft, keine Auffälligkeiten", answerType: "YES_NO", required: true },
  { key: "exterior_checked", label: "Fahrzeug außen geprüft, keine Auffälligkeiten", answerType: "YES_NO", required: true },
  { key: "tires", label: "Reifen geprüft, in Ordnung", answerType: "YES_NO", required: true },
  { key: "lights", label: "Beleuchtung geprüft, in Ordnung", answerType: "YES_NO", required: true },
  { key: "unusually_dirty", label: "Fahrzeug ungewöhnlich verschmutzt", answerType: "YES_NO", required: true },
  { key: "remarks", label: "Bemerkungen", answerType: "TEXT", required: false },
];

function parseItems(raw: Prisma.JsonValue): ChecklistItemDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return [];
    const o = r as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.label !== "string") return [];
    const appliesTo = Array.isArray(o.appliesTo) ? (o.appliesTo.filter((x) => x === "COMBUSTION" || x === "ELECTRIC" || x === "PHEV") as DriveClass[]) : undefined;
    return [{ key: o.key, label: o.label, answerType: (o.answerType as ChecklistAnswerType) ?? "OK_NOT_OK", required: o.required !== false, ...(appliesTo && appliesTo.length > 0 ? { appliesTo } : {}) }];
  });
}

/** Gültige Vorlage: zuerst die der Fahrzeuggruppe, dann die allgemeine des Mandanten, sonst der Standard. */
export async function resolveChecklist(tx: Tx, tenantId: string, groupId: string | null, type: HandoverType) {
  const candidates = await tx.checklistTemplate.findMany({
    where: { tenantId, active: true, handoverType: { in: [type, "BOTH"] }, OR: [{ groupId: groupId ?? undefined }, { groupId: null }] },
    orderBy: [{ version: "desc" }],
  });
  const chosen = (groupId ? candidates.find((c) => c.groupId === groupId) : undefined) ?? candidates.find((c) => c.groupId === null);
  if (!chosen) return { templateId: null as string | null, version: null as number | null, items: type === "RETURN" ? DEFAULT_RETURN_CHECKLIST : DEFAULT_CHECKLIST };
  return { templateId: chosen.id, version: chosen.version, items: parseItems(chosen.items) };
}

/** Neue Fassung einer Vorlage. Die vorherige bleibt als Zeile bestehen und wird nur deaktiviert. */
export async function publishChecklistVersion(
  tx: Tx,
  tenantId: string,
  input: { name: string; groupId?: string | null; handoverType?: HandoverType | "BOTH"; items: ChecklistItemDef[] },
) {
  if (input.items.length === 0) throw new DomainError("Eine Checkliste braucht mindestens einen Punkt.");
  const keys = new Set(input.items.map((i) => i.key));
  if (keys.size !== input.items.length) throw new DomainError("Jeder Checklistenpunkt braucht einen eindeutigen Schlüssel.");
  if (input.groupId) {
    const ok = await tx.vehicleGroup.count({ where: { id: input.groupId, tenantId } });
    if (ok !== 1) throw new DomainError("Die Fahrzeuggruppe gehört nicht zu diesem Mandanten.");
  }
  const last = await tx.checklistTemplate.findFirst({ where: { tenantId, name: input.name }, orderBy: { version: "desc" } });
  if (last) await tx.checklistTemplate.update({ where: { id: last.id }, data: { active: false } });
  return tx.checklistTemplate.create({
    data: {
      tenantId,
      groupId: input.groupId ?? null,
      handoverType: input.handoverType ?? "BOTH",
      name: input.name,
      version: (last?.version ?? 0) + 1,
      items: input.items,
      active: true,
    },
  });
}
