-- Befehl 27: Korrekturrunde nach dem Produkt-Audit. Rein additiv: neue, leere Spalten, ein CHECK auf eine bisher nur
-- im Formular nicht pflegbare Spalte, eine erweiterte Prüffunktion. Keine bestehenden Daten werden verändert.

-- 1) Kaution: Die vereinbarte Höhe darf nie unter die bestätigt erhaltene Kaution sinken. Das ist dieselbe Regel, die
--    rb_check_deposit_event bei jeder Kautionsbewegung prüft ("Mehr Kaution erhalten als vereinbart"); bisher konnte ein
--    unterschriebener Nachtrag sie verletzen und danach jede weitere Bewegung blockieren. Rest der Funktion unverändert
--    gegenüber 20261018090000_vertragsnachtraege.
CREATE OR REPLACE FUNCTION rb_check_deposit() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  c_tenant text;
  c_booking text;
  received bigint;
BEGIN
  SELECT "tenantId" INTO b_tenant FROM "Booking" WHERE "id" = NEW."bookingId";
  IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Kaution und Buchung gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."contractId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId" INTO c_tenant, c_booking FROM "RentalContract" WHERE "id" = NEW."contractId";
    IF c_tenant IS DISTINCT FROM NEW."tenantId" OR c_booking IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_TENANT: Kaution und Vertrag passen nicht zusammen';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() THEN
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" <> OLD."bookingId"
       OR (OLD."contractId" IS NOT NULL AND NEW."contractId" IS DISTINCT FROM OLD."contractId") THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Vereinbarte Kaution und Zuordnung sind fest';
    END IF;
    IF NEW."expectedAmountCents" <> OLD."expectedAmountCents" THEN
      IF NOT EXISTS (
        SELECT 1 FROM "ContractAmendment" a WHERE a."tenantId" = NEW."tenantId" AND a."bookingId" = NEW."bookingId" AND a."status" = 'SIGNED' AND a."newDepositCents" = NEW."expectedAmountCents"
      ) THEN
        RAISE EXCEPTION 'RB_IMMUTABLE: Die vereinbarte Kaution ändert sich nur durch einen unterschriebenen Nachtrag';
      END IF;
      SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO received FROM "SecurityDepositEvent"
        WHERE "depositId" = NEW."id" AND "type" = 'RECEIVED' AND "status" = 'CONFIRMED';
      IF received > NEW."expectedAmountCents" THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die vereinbarte Kaution kann nicht unter die bereits erhaltene Kaution (% Cent) gesenkt werden', received;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 2) Buchungsstorno: Grund und Zeitpunkt werden dauerhaft an der Buchung festgehalten (zusätzlich zum Audit-Eintrag).
--    Ältere Stornos bleiben ohne Angaben – es werden keine historischen Gründe erfunden.
ALTER TABLE "Booking" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "cancellationReason" TEXT;
ALTER TABLE "Booking" ADD COLUMN "cancelledById" TEXT;
ALTER TABLE "Booking" ADD COLUMN "cancelledByName" TEXT;
ALTER TABLE "Booking" ADD CONSTRAINT "rb_booking_cancellation" CHECK ("cancellationReason" IS NULL OR ("status" = 'CANCELLED' AND length(btrim("cancellationReason")) > 0));

-- 3) Schaden außerhalb eines Protokolls: interne Notiz bei der Erfassung (Beschreibung bleibt der Schadentext)
ALTER TABLE "Damage" ADD COLUMN "note" TEXT;

-- 4) Nachtrag: Kilometerregel (z. B. Freikilometer → Unbegrenzt) als Teil der Kilometervereinbarung
ALTER TABLE "ContractAmendment" ADD COLUMN "newKmPolicy" TEXT;
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_km_policy" CHECK ("newKmPolicy" IS NULL OR "newKmPolicy" IN ('UNLIMITED', 'FREE_KILOMETERS'));

-- 5) Tankgröße: jetzt im Fahrzeugformular pflegbar; Plausibilitätsgrenze in der Datenbank (leer bleibt erlaubt)
ALTER TABLE "Vehicle" ADD CONSTRAINT "rb_vehicle_tank_capacity" CHECK ("tankCapacityLiters" IS NULL OR ("tankCapacityLiters" >= 1 AND "tankCapacityLiters" <= 1000));
