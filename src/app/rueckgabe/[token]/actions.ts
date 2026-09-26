"use server";

// Befehl 20.6: öffentliche Rückgabemeldung des Kunden. Keine Sitzung – Berechtigung ist ausschließlich der persönliche,
// gehashte, widerrufbare und befristete Link (lib/key-drop.ts). Rate-Limit je Adresse; keine internen Daten in Antworten.

import { headers } from "next/headers";
import { DomainError, isImmutableError } from "@/lib/integrity";
import { confirmKeyDrop, runKeyDropConfirmationFollowUp } from "@/lib/key-drop";
import { consume } from "@/lib/rate-limit";
import { parseLocalDateTime } from "@/lib/time";

export type CustomerState = { error?: string; ok?: boolean } | undefined;

const num = (v: FormDataEntryValue | null) => { const s = String(v ?? "").replace(/\./g, "").replace(",", ".").trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? Math.round(n) : NaN; };

export async function confirmKeyDropAction(token: string, _prev: CustomerState, fd: FormData): Promise<CustomerState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unbekannt";
  if (!consume(`keydrop-confirm:${ip}`, { limit: 20, windowMs: 10 * 60_000 }).allowed) return { error: "Zu viele Versuche. Bitte in einigen Minuten erneut versuchen." };
  const mileage = num(fd.get("mileage"));
  const fuel = num(fd.get("fuelEighths"));
  const battery = num(fd.get("batteryPercent"));
  if ([mileage, fuel, battery].some((x) => Number.isNaN(x))) return { error: "Bitte nur Zahlen für Kilometer, Tank und Batterie angeben." };
  const newDamages = fd.get("newDamages");
  try {
    const kd = await confirmKeyDrop(token, {
      dropOffAt: parseLocalDateTime(String(fd.get("dropOffAt") ?? "")),
      mileage, fuelEighths: fuel, batteryPercent: battery,
      locationConfirmed: fd.get("locationConfirmed") === "yes",
      locationNote: String(fd.get("locationNote") ?? ""),
      newDamages: newDamages === "yes" ? true : newDamages === "no" ? false : null,
      damageNote: String(fd.get("damageNote") ?? ""),
      remark: String(fd.get("remark") ?? ""),
      signerName: String(fd.get("signerName") ?? ""),
      signatureDataUrl: String(fd.get("signature") ?? ""),
      accepted: fd.get("accepted") === "on",
    }, { ip, userAgent: h.get("user-agent") });
    // Bestätigungs-PDF und Eingangsbestätigung; ein Fehler dort macht die Meldung nie ungültig
    await runKeyDropConfirmationFollowUp(kd.tenantId, kd.id).catch(() => {});
    return { ok: true };
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    if (isImmutableError(e)) return { error: "Diese Rückgabe wurde bereits gemeldet." };
    console.error("Kontaktlose Rückgabe: Meldung fehlgeschlagen:", (e as Error).name);
    return { error: "Die Meldung konnte nicht gespeichert werden. Bitte erneut versuchen oder den Vermieter kontaktieren." };
  }
}
