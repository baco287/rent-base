-- Auslandsfahrt bei der Buchungsanlage: Genehmigung, Länder und EINMALIGER Aufpreis. Rein additiv: neue Spalten, Prüfregeln und
-- ein Schutz-Trigger – kein UPDATE/INSERT/DELETE. Bestehende Buchungen bleiben NULL bzw. ohne Länder: für sie bestimmt wie bisher
-- der Mietvertrag (Schritt 4) die Auslandsfahrt. Bestehende Verträge, Vertragsentwürfe, Rechnungen und Storno-Abrechnungen bleiben
-- unverändert.

ALTER TABLE "Booking" ADD COLUMN "abroadAllowed" BOOLEAN;
ALTER TABLE "Booking" ADD COLUMN "abroadCountries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Booking" ADD COLUMN "abroadSurchargeCents" INTEGER;

-- Aufpreis nur bei gestatteter Auslandsfahrt, nie negativ (0 € zulässig), Obergrenze 100.000 € (wie Kaution/Selbstbeteiligung);
-- gestattet = mindestens ein Land; nur Standardmieten (Unfallersatz: das offene Mietende kennt keine Zusatzposten)
ALTER TABLE "Booking" ADD CONSTRAINT "rb_booking_abroad" CHECK (
  ("abroadAllowed" IS NOT TRUE AND "abroadSurchargeCents" IS NULL AND cardinality("abroadCountries") = 0)
  OR ("abroadAllowed" = TRUE AND "rentalType" = 'STANDARD'
      AND "abroadSurchargeCents" IS NOT NULL AND "abroadSurchargeCents" BETWEEN 0 AND 10000000
      AND cardinality("abroadCountries") BETWEEN 1 AND 20 AND array_position("abroadCountries", NULL) IS NULL));

-- Sicherheitsnetz: Nach der Unterschrift bzw. bei abgeschlossener/stornierter Buchung gilt der Vertrag – Änderung nur per
-- Nachtrag. Der Vertrag wird dabei geteilt gesperrt (FOR SHARE), damit ein gleichzeitig laufender Vertragsabschluss abgewartet
-- und nicht übersehen wird.
CREATE OR REPLACE FUNCTION rb_guard_booking_abroad() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF NEW."abroadAllowed" IS DISTINCT FROM OLD."abroadAllowed" OR NEW."abroadCountries" IS DISTINCT FROM OLD."abroadCountries"
     OR NEW."abroadSurchargeCents" IS DISTINCT FROM OLD."abroadSurchargeCents" THEN
    IF OLD."status" IN ('RETURNED', 'CANCELLED') THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Die Auslandsfahrt einer abgeschlossenen oder stornierten Buchung ist festgeschrieben';
    END IF;
    SELECT c."status" INTO st FROM "RentalContract" c WHERE c."bookingId" = NEW."id" FOR SHARE;
    IF st IS NOT NULL AND st <> 'DRAFT' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Die Auslandsfahrt ist mit dem Mietvertrag festgeschrieben; Änderungen nur per Nachtrag';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_guard_booking_abroad" BEFORE UPDATE OF "abroadAllowed", "abroadCountries", "abroadSurchargeCents" ON "Booking"
  FOR EACH ROW EXECUTE FUNCTION rb_guard_booking_abroad();
