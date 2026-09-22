-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "type" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledByName" TEXT,
    "cancellationReason" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityDeposit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "contractId" TEXT,
    "expectedAmountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'EXPECTED',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityDepositEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "depositId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "reason" TEXT,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledByName" TEXT,
    "cancellationReason" TEXT,

    CONSTRAINT "SecurityDepositEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "bookingId" TEXT,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "depositId" TEXT,
    "amountCents" INTEGER,
    "details" JSONB,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_tenantId_invoiceId_status_idx" ON "Payment"("tenantId", "invoiceId", "status");

-- CreateIndex
CREATE INDEX "Payment_tenantId_bookingId_idx" ON "Payment"("tenantId", "bookingId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_paidAt_idx" ON "Payment"("tenantId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_idempotencyKey_key" ON "Payment"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityDeposit_bookingId_key" ON "SecurityDeposit"("bookingId");

-- CreateIndex
CREATE INDEX "SecurityDeposit_tenantId_status_idx" ON "SecurityDeposit"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SecurityDepositEvent_tenantId_depositId_status_idx" ON "SecurityDepositEvent"("tenantId", "depositId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityDepositEvent_tenantId_idempotencyKey_key" ON "SecurityDepositEvent"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_bookingId_idx" ON "AuditLog"("tenantId", "bookingId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityDeposit" ADD CONSTRAINT "SecurityDeposit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityDeposit" ADD CONSTRAINT "SecurityDeposit_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityDeposit" ADD CONSTRAINT "SecurityDeposit_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "SecurityDepositEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "SecurityDepositEvent_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "SecurityDeposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Integrität: Wertelisten, positive Beträge, Mandantenbindung, Unveränderlichkeit bestätigter Geldbewegungen.
-- Storno = Statuswechsel CONFIRMED -> CANCELLED mit Grund; die Zeile bleibt. Kein DELETE (außer Testbereinigung).
-- ============================================================================

ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_amount" CHECK ("amountCents" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_type" CHECK ("type" IN ('INVOICE_PAYMENT', 'OTHER_PAYMENT'));
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_method" CHECK ("method" IN ('CASH', 'CARD', 'BANK_TRANSFER', 'OTHER'));
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_status" CHECK ("status" IN ('CONFIRMED', 'CANCELLED'));
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_invoice_required" CHECK ("type" <> 'INVOICE_PAYMENT' OR "invoiceId" IS NOT NULL);
ALTER TABLE "Payment" ADD CONSTRAINT "rb_payment_cancel_fields" CHECK ("status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(trim("cancellationReason")) >= 3));

ALTER TABLE "SecurityDeposit" ADD CONSTRAINT "rb_deposit_amount" CHECK ("expectedAmountCents" >= 0);
ALTER TABLE "SecurityDeposit" ADD CONSTRAINT "rb_deposit_status" CHECK ("status" IN ('EXPECTED', 'RECEIVED', 'PARTIALLY_RELEASED', 'RELEASED', 'RETAINED'));

ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_amount" CHECK ("amountCents" > 0);
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_type" CHECK ("type" IN ('RECEIVED', 'RELEASED', 'RETAINED'));
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_method" CHECK ("method" IS NULL OR "method" IN ('CASH', 'CARD', 'BANK_TRANSFER', 'OTHER'));
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_status" CHECK ("status" IN ('CONFIRMED', 'CANCELLED'));
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_reason" CHECK ("type" <> 'RETAINED' OR ("reason" IS NOT NULL AND length(trim("reason")) >= 3));
ALTER TABLE "SecurityDepositEvent" ADD CONSTRAINT "rb_deposit_event_cancel_fields" CHECK ("status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(trim("cancellationReason")) >= 3));

-- Zahlung: Mandant von Buchung und Rechnung muss passen, Rechnung muss abgeschlossen sein und zur Buchung gehören
CREATE OR REPLACE FUNCTION rb_check_payment() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  i_tenant text;
  i_booking text;
  i_status text;
BEGIN
  SELECT "tenantId" INTO b_tenant FROM "Booking" WHERE "id" = NEW."bookingId";
  IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Zahlung und Buchung gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId", "status" INTO i_tenant, i_booking, i_status FROM "Invoice" WHERE "id" = NEW."invoiceId";
    IF i_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Zahlung und Rechnung gehören zu verschiedenen Mandanten';
    END IF;
    IF i_booking IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rechnung gehört nicht zu dieser Buchung';
    END IF;
    IF TG_OP = 'INSERT' AND i_status <> 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zahlungen nur auf abgeschlossene Rechnungen';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_payment_check BEFORE INSERT OR UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION rb_check_payment();

-- Zahlung: bestätigt = unveränderlich, einzig erlaubter Übergang ist das Storno mit Grund; storniert = endgültig
CREATE OR REPLACE FUNCTION rb_guard_payment() RETURNS trigger AS $$
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
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" <> OLD."bookingId" OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
     OR NEW."type" <> OLD."type" OR NEW."method" <> OLD."method" OR NEW."amountCents" <> OLD."amountCents" OR NEW."currency" <> OLD."currency"
     OR NEW."paidAt" <> OLD."paidAt" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine bestätigte Zahlung kann nicht geändert werden, nur storniert';
  END IF;
  IF NEW."status" = 'CONFIRMED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancellationReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Stornofelder nur beim Storno';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_payment_guard BEFORE UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION rb_guard_payment();

-- Kaution: Mandant von Buchung und Vertrag muss passen; vereinbarter Betrag und Zuordnung sind fest
CREATE OR REPLACE FUNCTION rb_check_deposit() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  c_tenant text;
  c_booking text;
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
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" <> OLD."bookingId" OR NEW."expectedAmountCents" <> OLD."expectedAmountCents"
       OR (OLD."contractId" IS NOT NULL AND NEW."contractId" IS DISTINCT FROM OLD."contractId") THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Vereinbarte Kaution und Zuordnung sind fest';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_deposit_check BEFORE INSERT OR UPDATE ON "SecurityDeposit" FOR EACH ROW EXECUTE FUNCTION rb_check_deposit();

CREATE OR REPLACE FUNCTION rb_guard_deposit_delete() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Kautionen werden nicht gelöscht';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_deposit_guard BEFORE DELETE ON "SecurityDeposit" FOR EACH ROW EXECUTE FUNCTION rb_guard_deposit_delete();

-- Kautionsbewegung: Mandant passt zur Kaution; nach jeder Änderung gilt freigegeben + einbehalten <= erhalten
-- und erhalten <= vereinbart (jeweils nur bestätigte Bewegungen)
CREATE OR REPLACE FUNCTION rb_check_deposit_event() RETURNS trigger AS $$
DECLARE
  d_tenant text;
  d_expected integer;
  received bigint;
  settled bigint;
BEGIN
  SELECT "tenantId", "expectedAmountCents" INTO d_tenant, d_expected FROM "SecurityDeposit" WHERE "id" = NEW."depositId";
  IF d_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Kautionsbewegung und Kaution gehören zu verschiedenen Mandanten';
  END IF;
  SELECT COALESCE(SUM(CASE WHEN "type" = 'RECEIVED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" IN ('RELEASED', 'RETAINED') THEN "amountCents" ELSE 0 END), 0)
    INTO received, settled
    FROM "SecurityDepositEvent" WHERE "depositId" = NEW."depositId" AND "status" = 'CONFIRMED' AND "id" <> NEW."id";
  IF NEW."status" = 'CONFIRMED' THEN
    IF NEW."type" = 'RECEIVED' THEN received := received + NEW."amountCents"; ELSE settled := settled + NEW."amountCents"; END IF;
  END IF;
  IF settled > received THEN
    RAISE EXCEPTION 'RB_DOMAIN: Freigabe und Einbehalt dürfen die erhaltene Kaution nicht übersteigen';
  END IF;
  IF received > d_expected THEN
    RAISE EXCEPTION 'RB_DOMAIN: Mehr Kaution erhalten als vereinbart';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_deposit_event_check BEFORE INSERT OR UPDATE ON "SecurityDepositEvent" FOR EACH ROW EXECUTE FUNCTION rb_check_deposit_event();

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
     OR NEW."note" IS DISTINCT FROM OLD."note" OR NEW."occurredAt" <> OLD."occurredAt" OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine bestätigte Kautionsbewegung kann nicht geändert werden, nur storniert';
  END IF;
  IF NEW."status" = 'CONFIRMED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancellationReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Stornofelder nur beim Storno';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_deposit_event_guard BEFORE UPDATE OR DELETE ON "SecurityDepositEvent" FOR EACH ROW EXECUTE FUNCTION rb_guard_deposit_event();

-- Protokoll: nur anfügen
CREATE OR REPLACE FUNCTION rb_guard_audit() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Das Protokoll wird nur angefügt';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_audit_guard BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION rb_guard_audit();
