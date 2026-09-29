-- Befehl 22: Rückführung einer Kautionsverrechnung aus Kundenguthaben (nach Gutschrift oder Storno). Additiv, kein Backfill.
--
-- Modell: Die ursprüngliche Verrechnung (Payment DEPOSIT_OFFSET + Kautionsbewegung OFFSET) bleibt unverändert bestehen.
-- Eine Rückführung ist eine eigene Gegenbewegung an der Kaution (Typ OFFSET_RETURN) mit Verweis auf die Rechnung und die
-- konkrete Verrechnungszahlung. Sie
--   - macht den Betrag an der Kaution wieder verfügbar (netto verrechnet = OFFSET − OFFSET_RETURN),
--   - verbraucht Kundenguthaben der Rechnung wie eine Auszahlung (verfügbar = Guthaben − ausgezahlt − zurückgeführt),
--   - ist kein Geldeingang, kein Umsatz und keine Zahlung (Payments bleiben unverändert).
-- Grenzen (App und Datenbank): nie mehr als das noch verfügbare Kundenguthaben der Rechnung und nie mehr als der noch nicht
-- zurückgeführte Teil der konkreten Verrechnung; eine Verrechnung mit Rückführungen kann nicht storniert werden.

ALTER TABLE "SecurityDepositEvent" ADD COLUMN "invoiceId" TEXT;
ALTER TABLE "SecurityDepositEvent" ADD COLUMN "returnsPaymentId" TEXT;
-- Cascade greift nur beim Löschen ganzer Mandanten (Purge); bestätigte Bewegungen löscht der Trigger sonst nie
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "SecurityDepositEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "SecurityDepositEvent_returnsPaymentId_fkey" FOREIGN KEY ("returnsPaymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SecurityDepositEvent_tenantId_invoiceId_status_idx" ON "SecurityDepositEvent"("tenantId", "invoiceId", "status");
CREATE INDEX "SecurityDepositEvent_returnsPaymentId_idx" ON "SecurityDepositEvent"("returnsPaymentId");

ALTER TABLE "SecurityDepositEvent" DROP CONSTRAINT "rb_deposit_event_type";
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_type" CHECK ("type" IN ('RECEIVED', 'RELEASED', 'RETAINED', 'OFFSET', 'OFFSET_RETURN'));
-- Rückführung: immer mit Rechnung und Verrechnungszahlung, ohne Zahlungsart; die Verweise gibt es nur bei Rückführungen
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_offset_return" CHECK (
  ("type" = 'OFFSET_RETURN') = ("returnsPaymentId" IS NOT NULL)
  AND ("type" = 'OFFSET_RETURN') = ("invoiceId" IS NOT NULL)
  AND ("type" <> 'OFFSET_RETURN' OR "method" IS NULL)
);

-- Verfügbarer Auszahlungsrest einer Rechnung (Kundenguthaben): bestätigte Zahlungen − wirksame Forderung − abgeschlossene
-- Auszahlungen (ohne except_id) − bestätigte Rückführungen zur Kaution. Beide verbrauchen dasselbe Guthaben.
CREATE OR REPLACE FUNCTION rb_invoice_refund_remaining(inv_id text, except_id text) RETURNS bigint AS $$
DECLARE
  gross bigint;
  credited bigint;
  paid bigint;
  paid_out bigint;
  returned bigint;
BEGIN
  SELECT COALESCE(ROUND(v."grossTotal" * 100), 0)::bigint INTO gross FROM "Invoice" i LEFT JOIN "InvoiceVersion" v ON v."id" = i."currentVersionId" WHERE i."id" = inv_id;
  SELECT COALESCE(SUM(ROUND(cv."grossTotal" * 100)), 0)::bigint INTO credited FROM "Invoice" c JOIN "InvoiceVersion" cv ON cv."id" = c."currentVersionId" WHERE c."originalInvoiceId" = inv_id AND c."status" = 'FINALIZED';
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid FROM "Payment" WHERE "invoiceId" = inv_id AND "status" = 'CONFIRMED';
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid_out FROM "Payout" WHERE "invoiceId" = inv_id AND "status" = 'COMPLETED' AND "id" IS DISTINCT FROM except_id;
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO returned FROM "SecurityDepositEvent" WHERE "invoiceId" = inv_id AND "type" = 'OFFSET_RETURN' AND "status" = 'CONFIRMED';
  RETURN GREATEST(0, paid - GREATEST(0, gross - credited)) - paid_out - returned;
END $$ LANGUAGE plpgsql STABLE;

-- Auszahlbarer Kautionsrest: verrechnet zählt netto (Verrechnungen − Rückführungen).
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
         COALESCE(SUM(CASE WHEN "type" = 'OFFSET' THEN "amountCents" WHEN "type" = 'OFFSET_RETURN' THEN -"amountCents" ELSE 0 END), 0)
    INTO received, released, retained, offset_c
    FROM "SecurityDepositEvent" WHERE "depositId" = dep_id AND "status" = 'CONFIRMED';
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid_out FROM "Payout" WHERE "securityDepositId" = dep_id AND "status" = 'COMPLETED' AND "id" IS DISTINCT FROM except_id;
  RETURN LEAST(released, received - retained - offset_c) - paid_out;
END $$ LANGUAGE plpgsql STABLE;

-- Kautionsbewegung prüfen (Neufassung, um OFFSET_RETURN erweitert).
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
  returned_for_payment bigint;
  credit_left bigint;
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
  -- Eine Verrechnung mit bestätigten Rückführungen wird nicht storniert (sonst würde netto negativ verrechnet)
  IF NEW."type" = 'OFFSET' AND TG_OP = 'UPDATE' AND NEW."status" = 'CANCELLED' AND OLD."status" = 'CONFIRMED' AND NOT rb_purge_allowed() THEN
    IF EXISTS (SELECT 1 FROM "SecurityDepositEvent" WHERE "returnsPaymentId" = NEW."paymentId" AND "type" = 'OFFSET_RETURN' AND "status" = 'CONFIRMED') THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zu dieser Kautionsverrechnung gibt es Rückführungen zur Kaution. Bitte zuerst die Rückführungen stornieren';
    END IF;
  END IF;
  IF NEW."type" = 'OFFSET_RETURN' AND TG_OP = 'INSERT' AND NOT rb_purge_allowed() THEN
    SELECT "tenantId", "bookingId", "invoiceId", "type", "status", "amountCents" INTO p FROM "Payment" WHERE "id" = NEW."returnsPaymentId";
    IF p IS NULL OR p."tenantId" IS DISTINCT FROM NEW."tenantId" OR p."bookingId" IS DISTINCT FROM d_booking OR p."invoiceId" IS DISTINCT FROM NEW."invoiceId" OR p."type" <> 'DEPOSIT_OFFSET' OR p."status" <> 'CONFIRMED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine Rückführung braucht eine bestätigte Kautionsverrechnung derselben Buchung und Rechnung';
    END IF;
    SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO returned_for_payment FROM "SecurityDepositEvent" WHERE "returnsPaymentId" = NEW."returnsPaymentId" AND "type" = 'OFFSET_RETURN' AND "status" = 'CONFIRMED';
    IF returned_for_payment + NEW."amountCents" > p."amountCents" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rückführung übersteigt den noch nicht zurückgeführten Teil der Kautionsverrechnung';
    END IF;
    credit_left := rb_invoice_refund_remaining(NEW."invoiceId", NULL);
    IF NEW."amountCents" > credit_left THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rückführung übersteigt das noch verfügbare Kundenguthaben der Rechnung';
    END IF;
  END IF;
  SELECT COALESCE(SUM(CASE WHEN "type" = 'RECEIVED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RELEASED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RETAINED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'OFFSET' THEN "amountCents" WHEN "type" = 'OFFSET_RETURN' THEN -"amountCents" ELSE 0 END), 0)
    INTO received, released, retained, offset_c
    FROM "SecurityDepositEvent" WHERE "depositId" = NEW."depositId" AND "status" = 'CONFIRMED' AND "id" <> NEW."id";
  IF NEW."status" = 'CONFIRMED' THEN
    IF NEW."type" = 'RECEIVED' THEN received := received + NEW."amountCents";
    ELSIF NEW."type" = 'RELEASED' THEN released := released + NEW."amountCents";
    ELSIF NEW."type" = 'OFFSET' THEN offset_c := offset_c + NEW."amountCents";
    ELSIF NEW."type" = 'OFFSET_RETURN' THEN offset_c := offset_c - NEW."amountCents";
    ELSE retained := retained + NEW."amountCents"; END IF;
  END IF;
  IF offset_c < 0 THEN
    RAISE EXCEPTION 'RB_DOMAIN: Es kann nicht mehr zur Kaution zurückgeführt werden, als verrechnet wurde';
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

-- Kautionsbewegung unveränderlich (Neufassung: auch die Verweise auf Zahlung, Rechnung und Verrechnung sind fest)
CREATE OR REPLACE FUNCTION rb_guard_deposit_event() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Kautionsbewegungen werden nicht gelöscht, nur storniert';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine stornierte Kautionsbewegung kann nicht mehr geändert werden';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."depositId" <> OLD."depositId" OR NEW."type" <> OLD."type" OR NEW."amountCents" <> OLD."amountCents"
     OR NEW."method" IS DISTINCT FROM OLD."method" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."note" IS DISTINCT FROM OLD."note" OR NEW."occurredAt" <> OLD."occurredAt" OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId" OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" OR NEW."returnsPaymentId" IS DISTINCT FROM OLD."returnsPaymentId" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine bestätigte Kautionsbewegung kann nicht geändert werden, nur storniert';
  END IF;
  IF NEW."status" = 'CONFIRMED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancellationReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Stornofelder nur beim Storno';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Zahlung (Neufassung der Fassung aus den Mietzahlungen): das Storno einer Zahlung darf Guthaben, das bereits ausgezahlt
-- ODER zur Kaution zurückgeführt wurde, nicht ungedeckt lassen.
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
    remaining := rb_invoice_refund_remaining(NEW."invoiceId", NULL) - NEW."amountCents";
    IF remaining < 0 AND (
      (SELECT COALESCE(SUM("amountCents"), 0) FROM "Payout" WHERE "invoiceId" = NEW."invoiceId" AND "status" = 'COMPLETED')
      + (SELECT COALESCE(SUM("amountCents"), 0) FROM "SecurityDepositEvent" WHERE "invoiceId" = NEW."invoiceId" AND "type" = 'OFFSET_RETURN' AND "status" = 'CONFIRMED')
    ) > 0 THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zu dieser Rechnung wurde Kundenguthaben bereits ausgezahlt oder zur Kaution zurückgeführt; das Storno der Zahlung würde mehr verbrauchen als Guthaben besteht. Bitte zuerst Auszahlung bzw. Rückführung stornieren';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
