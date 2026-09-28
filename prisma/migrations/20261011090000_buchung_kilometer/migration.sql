-- Befehl 20.7 (1): Kilometervereinbarung bereits auf der Buchung. Null = Wert des Fahrzeugs (bisheriges Verhalten),
-- kein Backfill: bestehende Buchungen und Verträge bleiben unverändert.
ALTER TABLE "Booking" ADD COLUMN "kmIncludedPerDay" INTEGER;
ALTER TABLE "Booking" ADD COLUMN "extraKmRate" DECIMAL(65,30);
