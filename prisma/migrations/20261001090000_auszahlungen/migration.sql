-- Phase 18: Auszahlungen, Erstattungen und Kautionsrückzahlung.
-- Rein additiv: neue Tabelle Payout, Verweise auf Auszahlungen an Document und EmailLog, Nummernkreis „Auszahlungen“.
-- Bestehende Zahlungen, Kautionsbewegungen, Rechnungen, Gegenbelege, Dokumente und Prüfsummen werden nicht verändert;
-- es werden keine historischen Auszahlungen erfunden (alte RELEASED-Bewegungen bleiben Entscheidungen, keine Geldflüsse).
--
-- Grundregeln (auch im Code, hier als letzte Sicherung):
-- - Forderung (Invoice), Zahlung (Payment, Geld rein), Guthaben/Freigabe (abgeleitet bzw. RELEASED) und Auszahlung (Payout, Geld raus)
--   bleiben getrennt. Nur COMPLETED zählt als tatsächlich ausgezahlt.
-- - Genau eine Quelle je Auszahlung (Rechnung oder Kaution), gleicher Mandant, gleiche Buchung; Quelle nach Anlage fest.
-- - Nie mehr auszahlen als verfügbar: Rechnung → Zahlungen − wirksame Forderung − bereits ausgezahlt; Kaution → freigegeben
--   (höchstens erhalten − einbehalten) − bereits ausgezahlt. Geprüft unter Zeilensperre der Quelle.
-- - COMPLETED ist unveränderlich; Korrektur nur als Storno (Status CANCELLED mit Grund) und neue Auszahlung. Kein Löschen.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "payoutId" TEXT;

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN     "payoutId" TEXT;

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT,
    "sourceType" TEXT NOT NULL,
    "invoiceId" TEXT,
    "securityDepositId" TEXT,
    "bookingId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "method" TEXT NOT NULL,
    "methodDescription" TEXT,
    "executedAt" TIMESTAMP(3),
    "plannedAt" TIMESTAMP(3),
    "recipientName" TEXT NOT NULL,
    "recipientDeviates" BOOLEAN NOT NULL DEFAULT false,
    "recipientReason" TEXT,
    "iban" TEXT,
    "ibanMasked" TEXT,
    "reference" TEXT,
    "receiptConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "historicalEntry" BOOLEAN NOT NULL DEFAULT false,
    "customerNote" TEXT,
    "internalNote" TEXT,
    "sourceSnapshot" JSONB,
    "contentHash" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completedByName" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledByName" TEXT,
    "cancellationReason" TEXT,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payout_tenantId_status_idx" ON "Payout"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Payout_tenantId_invoiceId_status_idx" ON "Payout"("tenantId", "invoiceId", "status");

-- CreateIndex
CREATE INDEX "Payout_tenantId_securityDepositId_status_idx" ON "Payout"("tenantId", "securityDepositId", "status");

-- CreateIndex
CREATE INDEX "Payout_tenantId_customerId_idx" ON "Payout"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "Payout_tenantId_bookingId_idx" ON "Payout"("tenantId", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_tenantId_number_key" ON "Payout"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_tenantId_idempotencyKey_key" ON "Payout"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Document_tenantId_payoutId_idx" ON "Document"("tenantId", "payoutId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_securityDepositId_fkey" FOREIGN KEY ("securityDepositId") REFERENCES "SecurityDeposit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Integrität
-- ============================================================================

ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_source_type" CHECK ("sourceType" IN ('INVOICE_REFUND', 'SECURITY_DEPOSIT_REFUND'));
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_one_source" CHECK (
  ("sourceType" = 'INVOICE_REFUND' AND "invoiceId" IS NOT NULL AND "securityDepositId" IS NULL)
  OR ("sourceType" = 'SECURITY_DEPOSIT_REFUND' AND "securityDepositId" IS NOT NULL AND "invoiceId" IS NULL)
);
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_status" CHECK ("status" IN ('DRAFT', 'COMPLETED', 'CANCELLED'));
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_method" CHECK ("method" IN ('BANK_TRANSFER', 'CASH', 'CARD', 'OTHER'));
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_number_format" CHECK ("number" IS NULL OR "number" ~ '^[A-Z]{1,6}-[0-9]{4}-[0-9]{6}$');
-- Abschluss nur mit Nummer, tatsächlichem Zeitpunkt, Abschlussmarke, Prüfsumme und Empfänger
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_completed_fields" CHECK ("status" = 'DRAFT' OR ("number" IS NOT NULL AND "executedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "contentHash" IS NOT NULL AND length(trim("recipientName")) > 0));
-- Überweisung braucht IBAN (verschleiert für Anzeige), Sonstige eine Beschreibung des Weges
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_method_fields" CHECK ("status" = 'DRAFT' OR (("method" <> 'BANK_TRANSFER' OR ("iban" IS NOT NULL AND "ibanMasked" IS NOT NULL)) AND ("method" <> 'OTHER' OR length(trim(coalesce("methodDescription", ''))) >= 3)));
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_recipient_reason" CHECK (NOT "recipientDeviates" OR length(trim(coalesce("recipientReason", ''))) >= 3);
ALTER TABLE "Payout" ADD CONSTRAINT "rb_payout_cancel_fields" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND length(trim(coalesce("cancellationReason", ''))) >= 3));

-- Dokumente: eine Archivfassung je Beleg, jetzt auch je Auszahlung
DROP INDEX IF EXISTS "rb_document_one_per_version";
CREATE UNIQUE INDEX "rb_document_one_per_version" ON "Document" ("tenantId", "type", COALESCE("contractId", ''), COALESCE("handoverId", ''), COALESCE("invoiceId", ''), COALESCE("invoiceVersionId", ''), COALESCE("payoutId", ''), "version");

-- Nummernkreise: zusätzlich „payout“ (Standard AZ); alle vier wirksamen Präfixe verschieden
CREATE OR REPLACE FUNCTION rb_number_ranges_valid(r jsonb) RETURNS boolean AS $$
DECLARE
  k text;
  p_inv text;
  p_cn text;
  p_st text;
  p_po text;
BEGIN
  IF r IS NULL OR r = 'null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(r) <> 'object' THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_object_keys(r) LOOP
    IF k NOT IN ('invoice', 'creditNote', 'cancellation', 'payout') THEN RETURN false; END IF;
    IF jsonb_typeof(r->k) <> 'object' OR jsonb_typeof(r->k->'prefix') <> 'string' THEN RETURN false; END IF;
    IF (r->k->>'prefix') !~ '^[A-Z]{1,6}$' THEN RETURN false; END IF;
  END LOOP;
  p_inv := COALESCE(r->'invoice'->>'prefix', 'RE');
  p_cn := COALESCE(r->'creditNote'->>'prefix', 'GS');
  p_st := COALESCE(r->'cancellation'->>'prefix', 'ST');
  p_po := COALESCE(r->'payout'->>'prefix', 'AZ');
  RETURN p_inv <> p_cn AND p_inv <> p_st AND p_cn <> p_st AND p_po <> p_inv AND p_po <> p_cn AND p_po <> p_st;
END $$ LANGUAGE plpgsql IMMUTABLE;

-- Verfügbarer Auszahlungsrest einer Rechnung: bestätigte Zahlungen − wirksame Forderung (aktuelle Fassung − abgeschlossene
-- Gegenbelege) − abgeschlossene Auszahlungen (ohne except_id). Nie negativ.
CREATE OR REPLACE FUNCTION rb_invoice_refund_remaining(inv_id text, except_id text) RETURNS bigint AS $$
DECLARE
  gross bigint;
  credited bigint;
  paid bigint;
  paid_out bigint;
BEGIN
  SELECT COALESCE(ROUND(v."grossTotal" * 100), 0)::bigint INTO gross FROM "Invoice" i LEFT JOIN "InvoiceVersion" v ON v."id" = i."currentVersionId" WHERE i."id" = inv_id;
  SELECT COALESCE(SUM(ROUND(cv."grossTotal" * 100)), 0)::bigint INTO credited FROM "Invoice" c JOIN "InvoiceVersion" cv ON cv."id" = c."currentVersionId" WHERE c."originalInvoiceId" = inv_id AND c."status" = 'FINALIZED';
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid FROM "Payment" WHERE "invoiceId" = inv_id AND "status" = 'CONFIRMED';
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid_out FROM "Payout" WHERE "invoiceId" = inv_id AND "status" = 'COMPLETED' AND "id" IS DISTINCT FROM except_id;
  RETURN GREATEST(0, paid - GREATEST(0, gross - credited)) - paid_out;
END $$ LANGUAGE plpgsql STABLE;

-- Verfügbarer Auszahlungsrest einer Kaution: freigegeben, höchstens erhalten − einbehalten, abzüglich abgeschlossener Auszahlungen.
CREATE OR REPLACE FUNCTION rb_deposit_payout_remaining(dep_id text, except_id text) RETURNS bigint AS $$
DECLARE
  received bigint;
  released bigint;
  retained bigint;
  paid_out bigint;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN "type" = 'RECEIVED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RELEASED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RETAINED' THEN "amountCents" ELSE 0 END), 0)
    INTO received, released, retained
    FROM "SecurityDepositEvent" WHERE "depositId" = dep_id AND "status" = 'CONFIRMED';
  SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid_out FROM "Payout" WHERE "securityDepositId" = dep_id AND "status" = 'COMPLETED' AND "id" IS DISTINCT FROM except_id;
  RETURN LEAST(released, received - retained) - paid_out;
END $$ LANGUAGE plpgsql STABLE;

-- Auszahlung: Mandant und Buchung passen zu Rechnung/Kaution/Kunde; Quelle nur zu abgeschlossenen Rechnungen (keine Gegenbelege);
-- Quelle, Belegart und Buchung sind ab der Anlage fest; beim Abschluss Sperre auf der Quelle und Prüfung des Rests.
CREATE OR REPLACE FUNCTION rb_check_payout() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  b_customer text;
  i record;
  d record;
  c_tenant text;
  remaining bigint;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  SELECT "tenantId", "customerId" INTO b_tenant, b_customer FROM "Booking" WHERE "id" = NEW."bookingId";
  IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Auszahlung und Buchung gehören zu verschiedenen Mandanten';
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
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" <> OLD."bookingId" OR NEW."sourceType" <> OLD."sourceType"
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
DROP TRIGGER IF EXISTS rb_payout_check ON "Payout";
CREATE TRIGGER rb_payout_check BEFORE INSERT OR UPDATE ON "Payout" FOR EACH ROW EXECUTE FUNCTION rb_check_payout();

-- Auszahlung: abgeschlossen = unveränderlich; einzig erlaubter Übergang ist das Storno mit Grund (Status CANCELLED, Stornofelder
-- einmalig). Storniert = endgültig. Gelöscht werden nur Entwürfe.
CREATE OR REPLACE FUNCTION rb_guard_payout() RETURNS trigger AS $$
DECLARE
  o jsonb;
  n jsonb;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Abgeschlossene oder stornierte Auszahlungen werden nicht gelöscht';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine stornierte Auszahlung kann nicht mehr geändert werden';
  END IF;
  IF OLD."status" = 'COMPLETED' THEN
    o := to_jsonb(OLD) - 'status' - 'cancelledAt' - 'cancelledById' - 'cancelledByName' - 'cancellationReason' - 'updatedAt';
    n := to_jsonb(NEW) - 'status' - 'cancelledAt' - 'cancelledById' - 'cancelledByName' - 'cancellationReason' - 'updatedAt';
    IF o <> n THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Auszahlung % ist abgeschlossen; Betrag, Weg, Empfänger, Datum, Referenz und Beleg sind fest. Korrektur nur über Storno und neue Auszahlung', OLD."number";
    END IF;
    IF NEW."status" <> 'CANCELLED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Auszahlung % ist abgeschlossen; nur ein Storno mit Grund ist möglich', OLD."number";
    END IF;
  END IF;
  IF NEW."status" <> 'CANCELLED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancellationReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Stornofelder nur beim Storno';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rb_payout_guard ON "Payout";
CREATE TRIGGER rb_payout_guard BEFORE UPDATE OR DELETE ON "Payout" FOR EACH ROW EXECUTE FUNCTION rb_guard_payout();

-- Kautionsbewegung (Neufassung der Prüfung aus Phase 9): zusätzlich dürfen bereits abgeschlossene Auszahlungen nie über den
-- auszahlbaren Rest hinausgehen (z. B. Storno einer Freigabe oder eines Eingangs nach erfolgter Auszahlung).
CREATE OR REPLACE FUNCTION rb_check_deposit_event() RETURNS trigger AS $$
DECLARE
  d_tenant text;
  d_expected integer;
  received bigint;
  released bigint;
  retained bigint;
  paid_out bigint;
BEGIN
  SELECT "tenantId", "expectedAmountCents" INTO d_tenant, d_expected FROM "SecurityDeposit" WHERE "id" = NEW."depositId";
  IF d_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Kautionsbewegung und Kaution gehören zu verschiedenen Mandanten';
  END IF;
  SELECT COALESCE(SUM(CASE WHEN "type" = 'RECEIVED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RELEASED' THEN "amountCents" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "type" = 'RETAINED' THEN "amountCents" ELSE 0 END), 0)
    INTO received, released, retained
    FROM "SecurityDepositEvent" WHERE "depositId" = NEW."depositId" AND "status" = 'CONFIRMED' AND "id" <> NEW."id";
  IF NEW."status" = 'CONFIRMED' THEN
    IF NEW."type" = 'RECEIVED' THEN received := received + NEW."amountCents";
    ELSIF NEW."type" = 'RELEASED' THEN released := released + NEW."amountCents";
    ELSE retained := retained + NEW."amountCents"; END IF;
  END IF;
  IF released + retained > received THEN
    RAISE EXCEPTION 'RB_DOMAIN: Freigabe und Einbehalt dürfen die erhaltene Kaution nicht übersteigen';
  END IF;
  IF received > d_expected THEN
    RAISE EXCEPTION 'RB_DOMAIN: Mehr Kaution erhalten als vereinbart';
  END IF;
  IF NOT rb_purge_allowed() THEN
    SELECT COALESCE(SUM("amountCents"), 0)::bigint INTO paid_out FROM "Payout" WHERE "securityDepositId" = NEW."depositId" AND "status" = 'COMPLETED';
    IF paid_out > LEAST(released, received - retained) THEN
      RAISE EXCEPTION 'RB_DOMAIN: Von dieser Kaution wurden bereits % Cent ausgezahlt; die Bewegung würde den auszahlbaren Betrag darunter senken. Bitte zuerst die Auszahlung stornieren', paid_out;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Zahlung (Neufassung der Sperre aus Phase 9): das Storno einer Zahlung darf bereits abgeschlossene Erstattungen nicht über das
-- verbleibende Kundenguthaben heben.
CREATE OR REPLACE FUNCTION rb_guard_payment() RETURNS trigger AS $$
DECLARE
  remaining bigint;
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
  IF NEW."status" = 'CANCELLED' AND OLD."status" = 'CONFIRMED' AND NEW."invoiceId" IS NOT NULL THEN
    -- Guthaben nach dem Storno dieser Zahlung darf die bereits abgeschlossenen Erstattungen nicht unterschreiten
    remaining := rb_invoice_refund_remaining(NEW."invoiceId", NULL) - NEW."amountCents";
    IF remaining < 0 AND (SELECT COALESCE(SUM("amountCents"), 0) FROM "Payout" WHERE "invoiceId" = NEW."invoiceId" AND "status" = 'COMPLETED') > 0 THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zu dieser Rechnung wurden bereits Erstattungen ausgezahlt; das Storno der Zahlung würde mehr Erstattung als Guthaben ergeben. Bitte zuerst die Auszahlung stornieren';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
