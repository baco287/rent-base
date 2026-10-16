-- Befehl 29.5: Selbstbeteiligung an Miettarife koppeln. Rein additiv: neue, leere Spalten und Prüfregeln. Keine Übernahme und
-- keine Änderung bestehender Zeilen – Tarifrevisionen sind ohnehin unveränderlich (Trigger rb_guard_rateplan_history), Verträge
-- behalten ihre Selbstbeteiligung. Bestehende Revisionen haben damit keine Tarifvorgabe; für sie gilt wie bisher die
-- Selbstbeteiligung aus den Geschäftsregeln (Mandant → Fahrzeuggruppe → Fahrzeug). Bestehende Buchungen bleiben bei null:
-- ihr Vertrag bestimmt die Selbstbeteiligung wie bisher.

ALTER TABLE "RatePlanRevision" ADD COLUMN "deductibleCents" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "deductibleCents" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "deductibleOverrideReason" TEXT;

-- Tarif: Betrag nie negativ, Plausibilitätsgrenze 100.000 € (wie die Kaution); null = keine Tarifvorgabe
ALTER TABLE "RatePlanRevision" ADD CONSTRAINT "rb_rateplan_revision_deductible" CHECK ("deductibleCents" IS NULL OR "deductibleCents" BETWEEN 0 AND 10000000);

-- Buchung: Selbstbeteiligung nur bei Tarifbuchungen, nie negativ (0 € zulässig); eine Abweichung vom Tarif nur mit Wert und Grund
ALTER TABLE "Booking" ADD CONSTRAINT "rb_booking_deductible" CHECK (
  ("deductibleCents" IS NULL OR ("deductibleCents" BETWEEN 0 AND 10000000 AND "ratePlanId" IS NOT NULL))
  AND ("deductibleOverrideReason" IS NULL OR ("deductibleCents" IS NOT NULL AND length(btrim("deductibleOverrideReason")) BETWEEN 3 AND 300)));
