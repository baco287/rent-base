-- Befehl 20.9 (End-to-End-Verbesserungen Runde 3): additiv, kein Backfill, keine Datenänderung.
--
-- 1. Fahrerprüfung: Prüfart. FULL = vollständige Original-Prüfung (bisheriges Verfahren), REPEAT = dokumentierte
--    Wiederholungs-/Sichtprüfung eines bereits vollständig geprüften Fahrers. Eine Wiederholungsprüfung verweist immer auf
--    den Prüfvermerk, dessen gespeicherte Daten als unverändert bestätigt wurden. Alte Vermerke bleiben unverändert (FULL).
ALTER TABLE "DriverVerification" ADD COLUMN "checkKind" TEXT NOT NULL DEFAULT 'FULL';
ALTER TABLE "DriverVerification" ADD COLUMN "basedOnVerificationId" TEXT;
ALTER TABLE "DriverVerification" ADD CONSTRAINT "rb_driver_verification_kind"
  CHECK ("checkKind" IN ('FULL', 'REPEAT') AND ("checkKind" <> 'REPEAT' OR "basedOnVerificationId" IS NOT NULL));
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_basedOnVerificationId_fkey"
  FOREIGN KEY ("basedOnVerificationId") REFERENCES "DriverVerification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "DriverVerification_tenantId_basedOnVerificationId_idx" ON "DriverVerification"("tenantId", "basedOnVerificationId");

-- 2. Rückgabe: bewusst verworfene Kostenvorschläge („Nicht berechnen“). Nur Dokumentation der Entscheidung; es entsteht
--    keine Position und keine Forderung. Nicht Teil des versiegelten Inhalts.
ALTER TABLE "Handover" ADD COLUMN "dismissedProposals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
