-- Befehl 28: Storno, Erstattung und Mietänderungen im Realbetrieb. Rein additiv bzw. erweiternd: neue, leere Spalten,
-- erweiterte Wertelisten und Prüffunktionen. Bestehende Zeilen bleiben gültig und werden nicht verändert.

-- ---------------------------------------------------------------------------
-- 1) Buchung: Storno-Abschluss (einmaliger Schlüssel gegen Doppelklick/zwei Tabs, eingefrorene Storno-Abrechnung)
-- ---------------------------------------------------------------------------
ALTER TABLE "Booking" ADD COLUMN "cancellationKey" TEXT;
ALTER TABLE "Booking" ADD COLUMN "cancellationSnapshot" JSONB;
ALTER TABLE "Booking" ADD COLUMN "cancellationHash" TEXT;
CREATE UNIQUE INDEX "Booking_tenantId_cancellationKey_key" ON "Booking"("tenantId", "cancellationKey");
ALTER TABLE "Booking" ADD CONSTRAINT "rb_booking_cancellation_snapshot" CHECK (("cancellationSnapshot" IS NULL AND "cancellationHash" IS NULL AND "cancellationKey" IS NULL) OR "status" = 'CANCELLED');

-- Ein Storno ist endgültig: Status, Grund, Zeitpunkt, Benutzer und Abrechnung bleiben unverändert
CREATE OR REPLACE FUNCTION rb_guard_booking_cancellation() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF OLD."status" = 'CANCELLED' AND (NEW."status" <> 'CANCELLED'
     OR NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" OR NEW."cancellationReason" IS DISTINCT FROM OLD."cancellationReason"
     OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById" OR NEW."cancelledByName" IS DISTINCT FROM OLD."cancelledByName"
     OR (OLD."cancellationSnapshot" IS NOT NULL AND (NEW."cancellationSnapshot" IS DISTINCT FROM OLD."cancellationSnapshot" OR NEW."cancellationHash" IS DISTINCT FROM OLD."cancellationHash" OR NEW."cancellationKey" IS DISTINCT FROM OLD."cancellationKey"))) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Ein Buchungsstorno ist endgültig; Status, Grund und Storno-Abrechnung bleiben unverändert';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_guard_booking_cancellation" BEFORE UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION rb_guard_booking_cancellation();

-- ---------------------------------------------------------------------------
-- 2) Stornogebühr als eigene Rechnungsart (kind CANCELLATION_FEE); Steuer je Storno bewusst gewählt:
--    TAXABLE_SUPPLY (steuerpflichtiges Entgelt) oder NON_TAXABLE_FEE (nicht steuerbar, ohne Umsatzsteuer)
-- ---------------------------------------------------------------------------
ALTER TABLE "Invoice" DROP CONSTRAINT "rb_invoice_kind";
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_kind" CHECK ("kind" IN ('RENTAL', 'DAMAGE', 'AUTHORITY_FEE', 'DUNNING_FEE', 'GENERAL', 'CANCELLATION_FEE'));
ALTER TABLE "Invoice" DROP CONSTRAINT "rb_invoice_tax_treatment";
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_tax_treatment" CHECK ("taxTreatment" IS NULL OR "taxTreatment" IN ('NON_TAXABLE_DAMAGE_COMPENSATION', 'TAXABLE_SUPPLY', 'NON_TAXABLE_FEE'));
ALTER TABLE "InvoiceVersion" DROP CONSTRAINT "rb_invoice_version_tax_treatment";
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "rb_invoice_version_tax_treatment" CHECK ("taxTreatment" IS NULL OR "taxTreatment" IN ('NON_TAXABLE_DAMAGE_COMPENSATION', 'TAXABLE_SUPPLY', 'NON_TAXABLE_FEE'));
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_cancellation_fee" CHECK ("kind" <> 'CANCELLATION_FEE' OR ("bookingId" IS NOT NULL AND "taxTreatment" IS NOT NULL AND "taxTreatment" IN ('TAXABLE_SUPPLY', 'NON_TAXABLE_FEE')));
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_non_taxable_fee_kind" CHECK ("taxTreatment" IS DISTINCT FROM 'NON_TAXABLE_FEE' OR "kind" = 'CANCELLATION_FEE');
CREATE UNIQUE INDEX "rb_invoice_one_cancellation_fee" ON "Invoice"("bookingId") WHERE "kind" = 'CANCELLATION_FEE' AND "documentType" = 'INVOICE';

-- Eine Stornogebühr gibt es nur zu einer stornierten Buchung
CREATE OR REPLACE FUNCTION rb_check_cancellation_fee() RETURNS trigger AS $$
DECLARE
  b_status text;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF NEW."kind" = 'CANCELLATION_FEE' AND NEW."documentType" = 'INVOICE' THEN
    SELECT "status" INTO b_status FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_status IS DISTINCT FROM 'CANCELLED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine Stornogebühr gibt es nur zu einer stornierten Buchung';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_check_cancellation_fee" BEFORE INSERT ON "Invoice" FOR EACH ROW EXECUTE FUNCTION rb_check_cancellation_fee();

-- ---------------------------------------------------------------------------
-- 3) Auszahlung: neue Quelle „Mietvorauszahlung einer stornierten Buchung“ (keine Hilfsrechnung nötig)
-- ---------------------------------------------------------------------------
ALTER TABLE "Payout" DROP CONSTRAINT "rb_payout_source_type";
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_source_type" CHECK ("sourceType" IN ('INVOICE_REFUND', 'SECURITY_DEPOSIT_REFUND', 'RENTAL_PREPAYMENT_REFUND'));
ALTER TABLE "Payout" DROP CONSTRAINT "rb_payout_one_source";
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_one_source" CHECK (
  ("sourceType" = 'INVOICE_REFUND' AND "invoiceId" IS NOT NULL AND "securityDepositId" IS NULL)
  OR ("sourceType" = 'SECURITY_DEPOSIT_REFUND' AND "securityDepositId" IS NOT NULL AND "invoiceId" IS NULL)
  OR ("sourceType" = 'RENTAL_PREPAYMENT_REFUND' AND "bookingId" IS NOT NULL AND "invoiceId" IS NULL AND "securityDepositId" IS NULL)
);

-- Noch zu erstatten = bestätigte, keiner Rechnung zugeordnete Mietzahlungen der Buchung − abgeschlossene Erstattungen dieser Art
CREATE OR REPLACE FUNCTION rb_prepayment_refund_remaining(b_id text, except_id text) RETURNS bigint AS $$
DECLARE
  paid bigint;
  paid_out bigint;
BEGIN
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid FROM "Payment" WHERE "bookingId" = b_id AND "type" = 'RENTAL_PAYMENT' AND "invoiceId" IS NULL AND "status" = 'CONFIRMED';
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid_out FROM "Payout" WHERE "bookingId" = b_id AND "sourceType" = 'RENTAL_PREPAYMENT_REFUND' AND "status" = 'COMPLETED' AND "id" IS DISTINCT FROM except_id;
  RETURN paid - paid_out;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION rb_check_payout() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  b_customer text;
  i record;
  d record;
  c_tenant text;
  remaining bigint;
  b_status text;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF NEW."bookingId" IS NULL THEN
    -- Befehl 23.1: Erstattung zu einer freien Rechnung ohne Buchungsbezug (Kautionsrückzahlungen haben immer eine Buchung)
    IF NEW."sourceType" <> 'INVOICE_REFUND' OR NEW."invoiceId" IS NULL THEN
      RAISE EXCEPTION 'RB_DOMAIN: Ohne Buchungsbezug gibt es nur Erstattungen zu einer Rechnung';
    END IF;
  ELSE
    SELECT "tenantId", "customerId" INTO b_tenant, b_customer FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Auszahlung und Buchung gehören zu verschiedenen Mandanten';
    END IF;
  END IF;
  IF NEW."customerId" IS NOT NULL THEN
    SELECT "tenantId" INTO c_tenant FROM "Customer" WHERE "id" = NEW."customerId";
    IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Auszahlung und Kunde gehören zu verschiedenen Mandanten';
    END IF;
  END IF;
  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId", "status", "documentType", "number" INTO i FROM "Invoice" WHERE "id" = NEW."invoiceId";
    IF i."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Auszahlung und Rechnung gehören zu verschiedenen Mandanten';
    END IF;
    IF i."bookingId" IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rechnung gehört nicht zu dieser Buchung';
    END IF;
    IF i."status" <> 'FINALIZED' OR i."documentType" <> 'INVOICE' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Erstattungen gibt es nur zu abgeschlossenen Rechnungen, nicht zu Entwürfen, Gutschriften oder Stornobelegen';
    END IF;
  END IF;
  -- Befehl 28: Erstattung einer Mietvorauszahlung nur zu einer stornierten Buchung (die Zahlungen hängen an der Buchung)
  IF NEW."sourceType" = 'RENTAL_PREPAYMENT_REFUND' AND TG_OP = 'INSERT' THEN
    SELECT "status" INTO b_status FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_status IS DISTINCT FROM 'CANCELLED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Mietvorauszahlungen werden nur zu einer stornierten Buchung erstattet';
    END IF;
  END IF;
  IF NEW."securityDepositId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId" INTO d FROM "SecurityDeposit" WHERE "id" = NEW."securityDepositId";
    IF d."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Auszahlung und Kaution gehören zu verschiedenen Mandanten';
    END IF;
    IF d."bookingId" IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Kaution gehört nicht zu dieser Buchung';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId" OR NEW."sourceType" <> OLD."sourceType"
       OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" OR NEW."securityDepositId" IS DISTINCT FROM OLD."securityDepositId" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Quelle und Zuordnung einer Auszahlung sind ab der Anlage fest';
    END IF;
    IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine stornierte Auszahlung wird nicht wiederbelebt';
    END IF;
    IF OLD."status" = 'COMPLETED' AND NEW."status" = 'DRAFT' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine abgeschlossene Auszahlung wird nicht zum Entwurf';
    END IF;
  END IF;
  IF NEW."status" = 'COMPLETED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'COMPLETED') THEN
    IF NEW."executedAt" > now() + interval '1 day' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Der Auszahlungszeitpunkt einer abgeschlossenen Auszahlung liegt nicht in der Zukunft';
    END IF;
    IF NEW."invoiceId" IS NOT NULL THEN
      PERFORM 1 FROM "Invoice" WHERE "id" = NEW."invoiceId" FOR UPDATE;
      remaining := rb_invoice_refund_remaining(NEW."invoiceId", NEW."id");
      IF remaining <= 0 THEN
        RAISE EXCEPTION 'RB_DOMAIN: Zur Rechnung % gibt es kein auszahlbares Kundenguthaben', i."number";
      END IF;
      IF NEW."amountCents" > remaining THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die Auszahlung (% Cent) übersteigt das noch auszuzahlende Kundenguthaben der Rechnung % (% Cent)', NEW."amountCents", i."number", remaining;
      END IF;
    ELSIF NEW."sourceType" = 'RENTAL_PREPAYMENT_REFUND' THEN
      PERFORM 1 FROM "Booking" WHERE "id" = NEW."bookingId" FOR UPDATE;
      remaining := rb_prepayment_refund_remaining(NEW."bookingId", NEW."id");
      IF remaining <= 0 THEN
        RAISE EXCEPTION 'RB_DOMAIN: Aus den Mietvorauszahlungen dieser Buchung ist nichts mehr zu erstatten';
      END IF;
      IF NEW."amountCents" > remaining THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die Auszahlung (% Cent) übersteigt die noch zu erstattende Mietvorauszahlung (% Cent)', NEW."amountCents", remaining;
      END IF;
    ELSE
      PERFORM 1 FROM "SecurityDeposit" WHERE "id" = NEW."securityDepositId" FOR UPDATE;
      remaining := rb_deposit_payout_remaining(NEW."securityDepositId", NEW."id");
      IF remaining <= 0 THEN
        RAISE EXCEPTION 'RB_DOMAIN: Von dieser Kaution ist nichts mehr auszuzahlen';
      END IF;
      IF NEW."amountCents" > remaining THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die Auszahlung (% Cent) übersteigt den auszahlbaren Kautionsrest (% Cent)', NEW."amountCents", remaining;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 4) Zahlungen: Zuordnung der Mietvorauszahlung zur Stornogebühr-Rechnung; keine Doppelnutzung
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rb_check_payment() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  i_tenant text;
  i_booking text;
  i_status text;
  i_type text;
  i_kind text;
  b_status text;
BEGIN
  IF NEW."bookingId" IS NULL THEN
    -- Befehl 23.1: Zahlung zu einer freien Rechnung ohne Buchungsbezug – nur als Rechnungszahlung zu genau einer Rechnung
    IF NEW."invoiceId" IS NULL OR NEW."type" <> 'INVOICE_PAYMENT' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Ohne Buchungsbezug gibt es nur Zahlungen zu einer Rechnung';
    END IF;
  ELSE
    SELECT "tenantId" INTO b_tenant FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Zahlung und Buchung gehören zu verschiedenen Mandanten';
    END IF;
  END IF;
  IF NEW."type" = 'RENTAL_PAYMENT' AND TG_OP = 'INSERT' THEN
    IF NEW."invoiceId" IS NOT NULL THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine Mietzahlung wird ohne Rechnung erfasst und erst beim Rechnungsabschluss zugeordnet';
    END IF;
    IF EXISTS (SELECT 1 FROM "Invoice" WHERE "bookingId" = NEW."bookingId" AND "kind" = 'RENTAL' AND "documentType" = 'INVOICE' AND "status" = 'FINALIZED') THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zu dieser Buchung gibt es eine abgeschlossene Mietrechnung; Zahlungen werden zur Rechnung erfasst';
    END IF;
    -- Befehl 28: zu einer stornierten Buchung wird keine neue Mietzahlung erfasst
    SELECT "status" INTO b_status FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_status = 'CANCELLED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Buchung ist storniert; neue Mietzahlungen werden nicht erfasst';
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
    -- Befehl 28: oder – bei einer stornierten Buchung – der abgeschlossenen Stornogebühr-Rechnung derselben Buchung
    IF NEW."type" = 'RENTAL_PAYMENT' AND (i_status <> 'FINALIZED' OR i_type <> 'INVOICE' OR i_kind NOT IN ('RENTAL', 'CANCELLATION_FEE')) THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine Mietzahlung wird nur der abgeschlossenen Mietrechnung (bzw. Stornogebühr-Rechnung) ihrer Buchung zugeordnet';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

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
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR (NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" AND NOT linking)
     OR NEW."type" <> OLD."type" OR NEW."method" <> OLD."method" OR NEW."amountCents" <> OLD."amountCents" OR NEW."currency" <> OLD."currency"
     OR NEW."paidAt" <> OLD."paidAt" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine bestätigte Zahlung kann nicht geändert werden, nur storniert';
  END IF;
  IF NEW."status" = 'CONFIRMED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancellationReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Stornofelder nur beim Storno';
  END IF;
  -- Befehl 28: Mietvorauszahlungen einer stornierten Buchung, die schon (teilweise) erstattet wurden, werden keiner
  -- Rechnung mehr zugeordnet und nicht storniert, wenn die Erstattung dadurch ungedeckt würde
  IF linking AND EXISTS (SELECT 1 FROM "Payout" WHERE "bookingId" = NEW."bookingId" AND "sourceType" = 'RENTAL_PREPAYMENT_REFUND' AND "status" = 'COMPLETED') THEN
    RAISE EXCEPTION 'RB_DOMAIN: Zu den Mietvorauszahlungen dieser Buchung wurde bereits eine Erstattung ausgezahlt; sie werden keiner Rechnung mehr zugeordnet';
  END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" = 'CONFIRMED' AND OLD."type" = 'RENTAL_PAYMENT' AND OLD."invoiceId" IS NULL AND OLD."bookingId" IS NOT NULL THEN
    IF rb_prepayment_refund_remaining(OLD."bookingId", NULL) - NEW."amountCents" < 0 THEN
      RAISE EXCEPTION 'RB_DOMAIN: Aus den Mietvorauszahlungen dieser Buchung wurde bereits erstattet; das Storno der Zahlung würde die Erstattung ungedeckt lassen. Bitte zuerst die Auszahlung stornieren';
    END IF;
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

-- ---------------------------------------------------------------------------
-- 5) Nachtrag: vereinbart – Unterschrift ausstehend (AGREED), neuer Mietbeginn, Zurücknahme mit Grund
-- ---------------------------------------------------------------------------
ALTER TABLE "ContractAmendment" ADD COLUMN "newStartAt" TIMESTAMP(3);
ALTER TABLE "ContractAmendment" ADD COLUMN "discardReason" TEXT;
ALTER TABLE "ContractAmendment" ADD COLUMN "agreedAt" TIMESTAMP(3);
ALTER TABLE "ContractAmendment" ADD COLUMN "agreedById" TEXT;
ALTER TABLE "ContractAmendment" ADD COLUMN "agreedByName" TEXT;
ALTER TABLE "ContractAmendment" ADD COLUMN "agreedChannel" TEXT;
ALTER TABLE "ContractAmendment" ADD COLUMN "agreedNote" TEXT;
ALTER TABLE "ContractAmendment" DROP CONSTRAINT "rb_amendment_status";
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_status" CHECK ("status" IN ('DRAFT', 'AGREED', 'SIGNED', 'DISCARDED'));
-- vereinbart nur mit Vereinbarungsangaben und nur für eine Änderung des Mietzeitraums (operative Reservierung)
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_agreed" CHECK ("status" <> 'AGREED' OR ("agreedAt" IS NOT NULL AND "agreedChannel" IS NOT NULL AND ("newEndAt" IS NOT NULL OR "newStartAt" IS NOT NULL)));
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_agreed_fields" CHECK (("agreedAt" IS NULL) = ("agreedChannel" IS NULL) AND ("agreedChannel" IS NULL OR "agreedChannel" IN ('PHONE', 'EMAIL', 'IN_PERSON', 'OTHER')));
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_discard_reason" CHECK ("discardReason" IS NULL OR "status" = 'DISCARDED');
-- höchstens eine vereinbarte, noch nicht unterschriebene Änderung je Vertrag (parallele Vereinbarungen: nur eine gewinnt)
CREATE UNIQUE INDEX "rb_amendment_one_agreed" ON "ContractAmendment"("contractId") WHERE "status" = 'AGREED';
CREATE INDEX "ContractAmendment_tenantId_status_newEndAt_idx" ON "ContractAmendment"("tenantId", "status", "newEndAt");

CREATE OR REPLACE FUNCTION rb_guard_amendment() RETURNS trigger AS $$
DECLARE
  o jsonb; n jsonb;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Ein unterschriebener oder verworfener Nachtrag wird nicht gelöscht'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'SIGNED' THEN
    o := to_jsonb(OLD) - 'settlementInvoiceId' - 'updatedAt';
    n := to_jsonb(NEW) - 'settlementInvoiceId' - 'updatedAt';
    IF o <> n THEN RAISE EXCEPTION 'RB_IMMUTABLE: Ein unterschriebener Nachtrag bleibt unverändert; Korrektur nur durch einen neuen Nachtrag'; END IF;
    IF OLD."settlementInvoiceId" IS NOT NULL AND NEW."settlementInvoiceId" IS DISTINCT FROM OLD."settlementInvoiceId" THEN RAISE EXCEPTION 'RB_IMMUTABLE: Der Abrechnungsbezug eines Nachtrags ist fest'; END IF;
  ELSIF OLD."status" = 'DISCARDED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Ein verworfener Nachtrag wird nicht mehr geändert';
  ELSIF OLD."status" = 'AGREED' THEN
    -- Befehl 28: vereinbarter Inhalt ist fest. Erlaubt sind nur Unterschrift (→ SIGNED, Versiegelungsfelder) oder Zurücknahme mit Grund (→ DISCARDED)
    IF NEW."status" NOT IN ('AGREED', 'SIGNED', 'DISCARDED') THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine vereinbarte Vertragsänderung wird unterschrieben oder zurückgenommen, nicht wieder zum Entwurf';
    END IF;
    o := to_jsonb(OLD) - 'status' - 'updatedAt' - 'number' - 'sequenceNo' - 'snapshot' - 'contentHash' - 'signedAt' - 'signedById' - 'signedByName' - 'discardedAt' - 'discardReason';
    n := to_jsonb(NEW) - 'status' - 'updatedAt' - 'number' - 'sequenceNo' - 'snapshot' - 'contentHash' - 'signedAt' - 'signedById' - 'signedByName' - 'discardedAt' - 'discardReason';
    IF o <> n THEN RAISE EXCEPTION 'RB_IMMUTABLE: Der Inhalt einer vereinbarten Vertragsänderung ist fest; bei anderer Vereinbarung zurücknehmen und neu erfassen'; END IF;
    IF NEW."status" = 'DISCARDED' AND (NEW."discardReason" IS NULL OR length(btrim(NEW."discardReason")) < 3) THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine vereinbarte Vertragsänderung wird nur mit Grund zurückgenommen';
    END IF;
    IF NEW."status" <> 'DISCARDED' AND (NEW."discardedAt" IS NOT NULL OR NEW."discardReason" IS NOT NULL) THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zurücknahmefelder nur beim Zurücknehmen';
    END IF;
  END IF;
  IF OLD."tenantId" <> NEW."tenantId" OR OLD."contractId" <> NEW."contractId" OR OLD."bookingId" <> NEW."bookingId" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Zuordnung eines Nachtrags ist fest';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rb_guard_signature() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Unterschriften können nicht geändert werden';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."handoverId" IS NOT NULL THEN
      SELECT "status" INTO st FROM "Handover" WHERE "id" = NEW."handoverId";
      IF st = 'FINALIZED' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Protokoll ist bereits finalisiert'; END IF;
    END IF;
    IF NEW."contractId" IS NOT NULL THEN
      SELECT "status" INTO st FROM "RentalContract" WHERE "id" = NEW."contractId";
      IF st <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Vertrag ist bereits unterschrieben'; END IF;
    END IF;
    IF NEW."amendmentId" IS NOT NULL THEN
      SELECT "status" INTO st FROM "ContractAmendment" WHERE "id" = NEW."amendmentId";
      -- Befehl 28: auch eine vereinbarte Änderung (AGREED) wird nachträglich unterschrieben
      IF st NOT IN ('DRAFT', 'AGREED') THEN RAISE EXCEPTION 'RB_IMMUTABLE: Nachtrag ist bereits unterschrieben oder verworfen'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."handoverId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "Handover" WHERE "id" = OLD."handoverId";
    IF st = 'FINALIZED' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines finalisierten Protokolls'; END IF;
  END IF;
  IF OLD."contractId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "RentalContract" WHERE "id" = OLD."contractId";
    IF st <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines unterschriebenen Vertrags'; END IF;
  END IF;
  IF OLD."amendmentId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "ContractAmendment" WHERE "id" = OLD."amendmentId";
    IF st NOT IN ('DRAFT', 'AGREED') THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines unterschriebenen Nachtrags'; END IF;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 6) Dokumentarchiv: eine Stornobestätigung je Buchung (Eindeutigkeit berücksichtigt jetzt auch den Buchungsbezug)
-- ---------------------------------------------------------------------------
DROP INDEX "rb_document_one_per_version";
CREATE UNIQUE INDEX "rb_document_one_per_version" ON "Document" ("tenantId", "type", COALESCE("bookingId", ''), COALESCE("contractId", ''), COALESCE("handoverId", ''), COALESCE("invoiceId", ''), COALESCE("invoiceVersionId", ''), COALESCE("payoutId", ''), COALESCE("dunningNoticeId", ''), COALESCE("amendmentId", ''), "version");
