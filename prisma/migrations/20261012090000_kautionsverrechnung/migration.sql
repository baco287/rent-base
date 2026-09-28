-- Befehl 20.7 (7): Kautionsverrechnung. Eine Verrechnung ist EIN Vorgang aus zwei Zeilen:
--   Payment (type/method DEPOSIT_OFFSET, zur Rechnung)  +  SecurityDepositEvent (type OFFSET, paymentId).
-- Kein neues Geld: die Zahlung dokumentiert nur, dass bereits vereinnahmte Kaution die Forderung deckt.
-- Additiv: bestehende Zahlungen, Kautionsbewegungen und Auszahlungen bleiben unverändert.

-- Zahlung: neue Art und neue "Zahlungsart", bewusst außerhalb der normalen Auswahl (CASH/CARD/BANK_TRANSFER/OTHER)
ALTER TABLE "Payment" DROP CONSTRAINT "rb_payment_type";
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_type" CHECK ("type" IN ('INVOICE_PAYMENT', 'OTHER_PAYMENT', 'RENTAL_PAYMENT', 'DEPOSIT_OFFSET'));
ALTER TABLE "Payment" DROP CONSTRAINT "rb_payment_method";
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_method" CHECK ("method" IN ('CASH', 'CARD', 'BANK_TRANSFER', 'OTHER', 'DEPOSIT_OFFSET'));
-- Art und Zahlungsart einer Verrechnung gehören zusammen; eine Verrechnung hat immer eine Rechnung
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_offset_pair" CHECK (("type" = 'DEPOSIT_OFFSET') = ("method" = 'DEPOSIT_OFFSET'));
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_offset_invoice" CHECK ("type" <> 'DEPOSIT_OFFSET' OR "invoiceId" IS NOT NULL);

-- Kautionsbewegung: neuer Typ OFFSET mit Verweis auf die Zahlung
ALTER TABLE "SecurityDepositEvent" ADD COLUMN "paymentId" TEXT;
CREATE UNIQUE INDEX "SecurityDepositEvent_paymentId_key" ON "SecurityDepositEvent"("paymentId");
-- Cascade greift nur beim Löschen ganzer Mandanten (Purge); bestätigte Zahlungen löscht der Trigger sonst nie
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "SecurityDepositEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityDepositEvent" DROP CONSTRAINT "rb_deposit_event_type";
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_type" CHECK ("type" IN ('RECEIVED', 'RELEASED', 'RETAINED', 'OFFSET'));
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_offset_payment" CHECK (("type" = 'OFFSET') = ("paymentId" IS NOT NULL));
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_offset_method" CHECK ("type" <> 'OFFSET' OR "method" IS NULL);

-- Kautionsbewegung prüfen (Neufassung der Prüfung aus Phase 18, um OFFSET erweitert): freigegeben + einbehalten +
-- verrechnet <= erhalten; erhalten <= vereinbart; abgeschlossene Auszahlungen bleiben gedeckt (verrechnete Kaution ist
-- verbraucht); eine Verrechnung verweist auf eine bestätigte Verrechnungszahlung desselben Mandanten und derselben Buchung.
CREATE OR REPLACE FUNCTION rb_check_deposit_event() RETURNS trigger AS $$
DECLARE
  d_tenant text;
  d_booking text;
  d_expected integer;
  received bigint;
  released bigint;
  retained bigint;
  offset_c bigint;
  paid_out bigint;
  p record;
BEGIN
  SELECT "tenantId", "bookingId", "expectedAmountCents" INTO d_tenant, d_booking, d_expected FROM "SecurityDeposit" WHERE "id" = NEW."depositId";
  IF d_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Kautionsbewegung und Kaution gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."type" = 'OFFSET' AND TG_OP = 'INSERT' THEN
    SELECT "tenantId", "bookingId", "type", "status" INTO p FROM "Payment" WHERE "id" = NEW."paymentId";
    IF p IS NULL OR p."tenantId" IS DISTINCT FROM NEW."tenantId" OR p."bookingId" IS DISTINCT FROM d_booking OR p."type" <> 'DEPOSIT_OFFSET' OR p."status" <> 'CONFIRMED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine Kautionsverrechnung braucht eine bestätigte Verrechnungszahlung derselben Buchung';
    END IF;
  END IF;
  SELECT COALESCE(SUM(CASE WHEN "type" = 'RECEIVED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RELEASED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RETAINED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'OFFSET' THEN "amountCents" ELSE 0 END), 0)
    INTO received, released, retained, offset_c
    FROM "SecurityDepositEvent" WHERE "depositId" = NEW."depositId" AND "status" = 'CONFIRMED' AND "id" <> NEW."id";
  IF NEW."status" = 'CONFIRMED' THEN
    IF NEW."type" = 'RECEIVED' THEN received := received + NEW."amountCents";
    ELSIF NEW."type" = 'RELEASED' THEN released := released + NEW."amountCents";
    ELSIF NEW."type" = 'OFFSET' THEN offset_c := offset_c + NEW."amountCents";
    ELSE retained := retained + NEW."amountCents"; END IF;
  END IF;
  IF released + retained + offset_c > received THEN
    RAISE EXCEPTION 'RB_DOMAIN: Freigabe, Einbehalt und Verrechnung dürfen die erhaltene Kaution nicht übersteigen';
  END IF;
  IF received > d_expected THEN
    RAISE EXCEPTION 'RB_DOMAIN: Mehr Kaution erhalten als vereinbart';
  END IF;
  IF NOT rb_purge_allowed() THEN
    SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid_out FROM "Payout" WHERE "securityDepositId" = NEW."depositId" AND "status" = 'COMPLETED';
    IF paid_out > LEAST(released, received - retained - offset_c) THEN
      RAISE EXCEPTION 'RB_DOMAIN: Von dieser Kaution wurden bereits % Cent ausgezahlt; die Bewegung würde den auszahlbaren Betrag darunter senken. Bitte zuerst die Auszahlung stornieren', paid_out;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Auszahlbarer Kautionsrest: freigegeben, höchstens erhalten − einbehalten − verrechnet, abzüglich abgeschlossener Auszahlungen.
-- Verrechnete Kaution ist verbraucht und kann nicht zusätzlich ausgezahlt werden (keine Doppelnutzung).
CREATE OR REPLACE FUNCTION rb_deposit_payout_remaining(dep_id text, except_id text) RETURNS bigint AS $$
DECLARE
  received bigint;
  released bigint;
  retained bigint;
  offset_c bigint;
  paid_out bigint;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN "type" = 'RECEIVED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RELEASED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RETAINED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'OFFSET' THEN "amountCents" ELSE 0 END), 0)
    INTO received, released, retained, offset_c
    FROM "SecurityDepositEvent" WHERE "depositId" = dep_id AND "status" = 'CONFIRMED';
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid_out FROM "Payout" WHERE "securityDepositId" = dep_id AND "status" = 'COMPLETED' AND "id" IS DISTINCT FROM except_id;
  RETURN LEAST(released, received - retained - offset_c) - paid_out;
END $$ LANGUAGE plpgsql STABLE;
