// Formularauswertung der Fahrerprüfung „in einem Vorgang“ (Befehl 21). Gemeinsam für Übergabe und Nachtrag (Befehl 25):
// dieselben Felder, dieselbe Validierung, dieselbe Serverlogik (verifyDriverInOneStep) – keine zweite Fahrerprüfung.
import { z } from "zod";
import type { OneStepCheckInput } from "@/lib/driver-verification";
import { parseLocalDateTime } from "@/lib/time";

const flag = () => z.preprocess((v) => v === "1" || v === "on" || v === true, z.boolean()).optional();

export const oneStepSchema = z.object({
  documentType: z.enum(["PERSONALAUSWEIS", "REISEPASS", "SONSTIGER_AMTLICHER_LICHTBILDAUSWEIS"], { message: "Bitte die Dokumentart wählen." }),
  licenseNumber: z.string().trim().min(1, "Bitte die Führerscheinnummer eingeben."),
  licenseCountry: z.string().trim().min(2, "Bitte das Ausstellungsland wählen."),
  licenseIssuedAt: z.string().optional(),
  licenseValidUntil: z.string().optional(),
  internationalPermitPresented: flag(),
  translationPresented: flag(),
  manualReviewConfirmed: flag(),
  deviationConfirmed: flag(),
  notes: z.string().trim().max(1000).optional(),
});

export function parseOneStepCheck(formData: FormData): { ok: true; input: OneStepCheckInput } | { ok: false; error: string } {
  const parsed = oneStepSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const classes = formData.getAll("licenseClasses").map(String);
  if (classes.length === 0) return { ok: false, error: "Bitte mindestens eine Fahrerlaubnisklasse auswählen." };
  const d = parsed.data;
  return {
    ok: true,
    input: {
      documentType: d.documentType, licenseNumber: d.licenseNumber, licenseCountry: d.licenseCountry,
      licenseIssuedAt: d.licenseIssuedAt ? parseLocalDateTime(`${d.licenseIssuedAt}T00:00`) : null,
      licenseValidUntil: d.licenseValidUntil ? parseLocalDateTime(`${d.licenseValidUntil}T00:00`) : null,
      licenseClasses: classes, internationalPermitPresented: !!d.internationalPermitPresented, translationPresented: !!d.translationPresented,
      manualReviewConfirmed: !!d.manualReviewConfirmed, deviationConfirmed: !!d.deviationConfirmed, notes: d.notes || null,
    },
  };
}
