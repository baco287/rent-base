-- Mietzahlungen schon bei Buchung / Mietvertrag (vor der Rechnung).
-- Kein neues Modell: Payment bekommt den Typ RENTAL_PAYMENT. Eine solche Zahlung hängt zunächst nur an der Buchung
-- (invoiceId leer). Beim Abschluss der Mietrechnung wird sie einmalig mit dieser Rechnung verknüpft; ab dann zählen
-- Rechnungssaldo, Erstattung und Gutschrift sie wie jede Rechnungszahlung. Kaution (SecurityDeposit) bleibt unberührt.
-- Keine Datenänderung: bestehende Zahlungen behalten Typ und Zuordnung.

ALTER TABLE "Payment" DROP CONSTRAINT "rb_payment_type";
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_type" CHECK ("type" IN ('INVOICE_PAYMENT', 'OTHER_PAYMENT', 'RENTAL_PAYMENT'));

-- Zahlung: Mandant von Buchung und Rechnung muss passen, Rechnung muss abgeschlossen sein und zur Buchung gehören.
-- Neu für RENTAL_PAYMENT: wird ohne Rechnung angelegt, nur solange es keine abgeschlossene Mietrechnung gibt;
-- verknüpft werden darf sie nur mit der abgeschlossenen Mietrechnung (kind RENTAL, documentType INVOICE) derselben Buchung.
CREATE OR REPLACE FUNCTION rb_check_payment() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  i_tenant text;
  i_booking text;
  i_status text;
  i_type text;
  i_kind text;
BEGIN
  SELECT "tenantId" INTO b_tenant FROM "Booking" WHERE "id" = NEW."bookingId";
  IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Zahlung und Buchung gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."type" = 'RENTAL_PAYMENT' AND TG_OP = 'INSERT' THEN
    IF NEW."invoiceId" IS NOT NULL THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine Mietzahlung wird ohne Rechnung erfasst und erst beim Rechnungsabschluss zugeordnet';
    END IF;
    IF EXISTS (SELECT 1 FROM "Invoice" WHERE "bookingId" = NEW."bookingId" AND "kind" = 'RENTAL' AND "documentType" = 'INVOICE' AND "status" = 'FINALIZED') THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zu dieser Buchung gibt es eine abgeschlossene Mietrechnung; Zahlungen werden zur Rechnung erfasst';
    END IF;
  END IF;
  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId", "status", "documentType", "kind" INTO i_tenant, i_booking, i_status, i_type, i_kind FROM "Invoice" WHERE "id" = NEW."invoiceId";
    IF i_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Zahlung und Rechnung gehören zu verschiedenen Mandanten';
    END IF;
    IF i_booking IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rechnung gehört nicht zu dieser Buchung';
    END IF;
    IF TG_OP = 'INSERT' AND i_status <> 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zahlungen nur auf abgeschlossene Rechnungen';
    END IF;
    IF TG_OP = 'INSERT' AND i_type <> 'INVOICE' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zahlungen werden nur zu Rechnungen erfasst, nicht zu Gutschriften oder Stornobelegen';
    END IF;
    IF NEW."type" = 'RENTAL_PAYMENT' AND (i_status <> 'FINALIZED' OR i_type <> 'INVOICE' OR i_kind <> 'RENTAL') THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine Mietzahlung wird nur der abgeschlossenen Mietrechnung ihrer Buchung zugeordnet';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Zahlung: bestätigt = unveränderlich, einzig erlaubte Übergänge sind das Storno mit Grund und (nur RENTAL_PAYMENT)
-- die einmalige Zuordnung zur Mietrechnung (invoiceId leer → gesetzt, sonst nichts); storniert = endgültig.
CREATE OR REPLACE FUNCTION rb_guard_payment() RETURNS trigger AS $$
DECLARE
  remaining bigint;
  linking boolean;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Zahlungen werden nicht gelöscht, nur storniert';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine stornierte Zahlung kann nicht mehr geändert werden';
  END IF;
  linking := OLD."type" = 'RENTAL_PAYMENT' AND OLD."invoiceId" IS NULL AND NEW."invoiceId" IS NOT NULL
             AND NEW."status" = 'CONFIRMED' AND OLD."status" = 'CONFIRMED';
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" <> OLD."bookingId"
     OR (NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" AND NOT linking)
     OR NEW."type" <> OLD."type" OR NEW."method" <> OLD."method" OR NEW."amountCents" <> OLD."amountCents" OR NEW."currency" <> OLD."currency"
     OR NEW."paidAt" <> OLD."paidAt" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine bestätigte Zahlung kann nicht geändert werden, nur storniert';
  END IF;
  IF NEW."status" = 'CONFIRMED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancellationReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Stornofelder nur beim Storno';
  END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" = 'CONFIRMED' AND NEW."invoiceId" IS NOT NULL THEN
    -- Guthaben nach dem Storno dieser Zahlung darf die bereits abgeschlossenen Erstattungen nicht unterschreiten
    remaining := rb_invoice_refund_remaining(NEW."invoiceId", NULL) - NEW."amountCents";
    IF remaining < 0 AND (SELECT COALESCE(SUM("amountCents"), 0) FROM "Payout" WHERE "invoiceId" = NEW."invoiceId" AND "status" = 'COMPLETED') > 0 THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zu dieser Rechnung wurden bereits Erstattungen ausgezahlt; das Storno der Zahlung würde mehr Erstattung als Guthaben ergeben. Bitte zuerst die Auszahlung stornieren';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
