-- Befehl 23: Mahnwesen und Forderungsmanagement. Rein additiv: neue Tabelle DunningNotice, neue Spalten mit Standardwerten,
-- erweiterte Prüfregel der Rechnungsarten (DUNNING_FEE). Bestehende Rechnungen, Zahlungen, Kautionsbewegungen, Gegenbelege
-- und Dokumente werden nicht verändert; für Bestandsdaten entstehen keine Mahnungen.

-- Einstellungen des Vermieters (Mahnfristen, Mahngebühren). Zahlungserinnerung immer ohne Gebühr. Keine Verzugszinsen.
ALTER TABLE "Tenant" ADD COLUMN "dunningReminderDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "Tenant" ADD COLUMN "dunningFirstDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "Tenant" ADD COLUMN "dunningSecondDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "Tenant" ADD COLUMN "dunningFeesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN "dunningFirstFeeCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tenant" ADD COLUMN "dunningSecondFeeCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tenant" ADD CONSTRAINT "rb_tenant_dunning_days" CHECK ("dunningReminderDays" BETWEEN 1 AND 60 AND "dunningFirstDays" BETWEEN 1 AND 60 AND "dunningSecondDays" BETWEEN 1 AND 60);
ALTER TABLE "Tenant" ADD CONSTRAINT "rb_tenant_dunning_fees" CHECK ("dunningFirstFeeCents" BETWEEN 0 AND 10000 AND "dunningSecondFeeCents" BETWEEN 0 AND 10000);

-- Mahngebühr als eigene Nebenrechnung (wie das Bearbeitungsentgelt): echte Forderung mit eigener Nummer, Originalrechnung unberührt
ALTER TABLE "Invoice" DROP CONSTRAINT "rb_invoice_kind";
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_kind" CHECK ("kind" IN ('RENTAL', 'DAMAGE', 'AUTHORITY_FEE', 'DUNNING_FEE'));

-- Mahnschreiben: Zahlungserinnerung (1), 1. Mahnung (2), 2. Mahnung (3). Unveränderlicher Snapshot ab Erstellung.
CREATE TABLE "DunningNotice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "customerId" TEXT,
    "level" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "deadlineDays" INTEGER NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "principalOpenCents" INTEGER NOT NULL,
    "priorFeesOpenCents" INTEGER NOT NULL DEFAULT 0,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "feeInvoiceId" TEXT,
    "recipientName" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "snapshot" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "deliveredById" TEXT,
    "deliveredByName" TEXT,
    "deliveredNote" TEXT,
    CONSTRAINT "DunningNotice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DunningNotice_tenantId_number_key" ON "DunningNotice"("tenantId", "number");
CREATE UNIQUE INDEX "DunningNotice_tenantId_invoiceId_level_key" ON "DunningNotice"("tenantId", "invoiceId", "level");
CREATE UNIQUE INDEX "DunningNotice_tenantId_idempotencyKey_key" ON "DunningNotice"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "DunningNotice_feeInvoiceId_key" ON "DunningNotice"("feeInvoiceId");
CREATE INDEX "DunningNotice_tenantId_issuedAt_idx" ON "DunningNotice"("tenantId", "issuedAt");
CREATE INDEX "DunningNotice_tenantId_bookingId_idx" ON "DunningNotice"("tenantId", "bookingId");
ALTER TABLE "DunningNotice" ADD CONSTRAINT "DunningNotice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DunningNotice" ADD CONSTRAINT "DunningNotice_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DunningNotice" ADD CONSTRAINT "DunningNotice_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DunningNotice" ADD CONSTRAINT "DunningNotice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DunningNotice" ADD CONSTRAINT "DunningNotice_feeInvoiceId_fkey" FOREIGN KEY ("feeInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DunningNotice" ADD CONSTRAINT "rb_dunning_level" CHECK ("level" BETWEEN 1 AND 3);
ALTER TABLE "DunningNotice" ADD CONSTRAINT "rb_dunning_amounts" CHECK ("principalOpenCents" >= 0 AND "priorFeesOpenCents" >= 0 AND "feeCents" >= 0 AND "totalCents" > 0 AND "totalCents" = "principalOpenCents" + "priorFeesOpenCents" + "feeCents");
ALTER TABLE "DunningNotice" ADD CONSTRAINT "rb_dunning_fee_ref" CHECK ((("feeCents" > 0) = ("feeInvoiceId" IS NOT NULL)) AND ("level" > 1 OR "feeCents" = 0));
ALTER TABLE "DunningNotice" ADD CONSTRAINT "rb_dunning_deadline" CHECK ("deadlineDays" BETWEEN 1 AND 60 AND "deadlineAt" > "issuedAt");

-- Archiv und Versandprotokoll: Bezug auf das Mahnschreiben
ALTER TABLE "Document" ADD COLUMN "dunningNoticeId" TEXT;
ALTER TABLE "Document" ADD CONSTRAINT "Document_dunningNoticeId_fkey" FOREIGN KEY ("dunningNoticeId") REFERENCES "DunningNotice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Document_tenantId_dunningNoticeId_idx" ON "Document"("tenantId", "dunningNoticeId");
-- Eine Archivfassung je Bezug und Version (wie bei Auszahlungen um den neuen Bezug erweitert; bestehende Zeilen haben ihn nicht)
DROP INDEX IF EXISTS "rb_document_one_per_version";
CREATE UNIQUE INDEX "rb_document_one_per_version" ON "Document" ("tenantId", "type", COALESCE("contractId", ''), COALESCE("handoverId", ''), COALESCE("invoiceId", ''), COALESCE("invoiceVersionId", ''), COALESCE("payoutId", ''), COALESCE("dunningNoticeId", ''), "version");
ALTER TABLE "EmailLog" ADD COLUMN "dunningNoticeId" TEXT;
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_dunningNoticeId_fkey" FOREIGN KEY ("dunningNoticeId") REFERENCES "DunningNotice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EmailLog_tenantId_dunningNoticeId_idx" ON "EmailLog"("tenantId", "dunningNoticeId");

-- Zweite Sicherung in der Datenbank: Mandant, Beleg, Buchung, Reihenfolge der Stufen, Gebührenrechnung
CREATE OR REPLACE FUNCTION rb_check_dunning_notice() RETURNS trigger AS $$
DECLARE
  i_tenant text; i_booking text; i_status text; i_type text; i_kind text;
  f_tenant text; f_booking text; f_status text; f_type text; f_kind text; f_gross bigint;
BEGIN
  SELECT "tenantId", "bookingId", "status", "documentType", "kind" INTO i_tenant, i_booking, i_status, i_type, i_kind FROM "Invoice" WHERE "id" = NEW."invoiceId";
  IF i_tenant IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Mahnschreiben und Rechnung gehören zu verschiedenen Mandanten'; END IF;
  IF i_booking IS DISTINCT FROM NEW."bookingId" THEN RAISE EXCEPTION 'RB_DOMAIN: Die Rechnung gehört nicht zu dieser Buchung'; END IF;
  IF i_status <> 'FINALIZED' OR i_type <> 'INVOICE' OR i_kind = 'DUNNING_FEE' THEN
    RAISE EXCEPTION 'RB_DOMAIN: Gemahnt werden nur abgeschlossene Rechnungen (keine Entwürfe, Gegenbelege oder Mahngebühren)';
  END IF;
  IF NEW."customerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Customer" WHERE "id" = NEW."customerId" AND "tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'RB_TENANT: Kunde gehört zu einem anderen Mandanten';
  END IF;
  IF NEW."level" > 1 AND NOT EXISTS (SELECT 1 FROM "DunningNotice" WHERE "tenantId" = NEW."tenantId" AND "invoiceId" = NEW."invoiceId" AND "level" = NEW."level" - 1) THEN
    RAISE EXCEPTION 'RB_DOMAIN: Mahnstufen werden nicht übersprungen';
  END IF;
  IF NEW."feeInvoiceId" IS NOT NULL THEN
    SELECT i."tenantId", i."bookingId", i."status", i."documentType", i."kind", round(v."grossTotal" * 100)::bigint
      INTO f_tenant, f_booking, f_status, f_type, f_kind, f_gross
      FROM "Invoice" i LEFT JOIN "InvoiceVersion" v ON v."id" = i."currentVersionId" WHERE i."id" = NEW."feeInvoiceId";
    IF f_tenant IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Mahngebühr gehört zu einem anderen Mandanten'; END IF;
    IF f_booking IS DISTINCT FROM NEW."bookingId" OR f_kind <> 'DUNNING_FEE' OR f_type <> 'INVOICE' OR f_status <> 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Mahngebühr muss eine abgeschlossene Gebührenrechnung derselben Buchung sein';
    END IF;
    IF f_gross IS DISTINCT FROM NEW."feeCents" THEN RAISE EXCEPTION 'RB_DOMAIN: Gebührenrechnung und Mahngebühr stimmen nicht überein'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_check_dunning_notice" BEFORE INSERT ON "DunningNotice" FOR EACH ROW EXECUTE FUNCTION rb_check_dunning_notice();

-- Unveränderlich: nur die einmalige Markierung "per Post/persönlich übermittelt" ist erlaubt. Kein Löschen.
CREATE OR REPLACE FUNCTION rb_guard_dunning_notice() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Ein Mahnschreiben wird nicht gelöscht'; END IF;
  IF (NEW."id", NEW."tenantId", NEW."invoiceId", NEW."bookingId", NEW."level", NEW."number", NEW."issuedAt", NEW."deadlineDays", NEW."deadlineAt",
      NEW."principalOpenCents", NEW."priorFeesOpenCents", NEW."feeCents", NEW."totalCents", NEW."feeInvoiceId", NEW."recipientName", NEW."recipientEmail",
      NEW."snapshot"::text, NEW."contentHash", NEW."idempotencyKey", NEW."createdById", NEW."createdByName", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."tenantId", OLD."invoiceId", OLD."bookingId", OLD."level", OLD."number", OLD."issuedAt", OLD."deadlineDays", OLD."deadlineAt",
      OLD."principalOpenCents", OLD."priorFeesOpenCents", OLD."feeCents", OLD."totalCents", OLD."feeInvoiceId", OLD."recipientName", OLD."recipientEmail",
      OLD."snapshot"::text, OLD."contentHash", OLD."idempotencyKey", OLD."createdById", OLD."createdByName", OLD."createdAt") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Ein Mahnschreiben bleibt unverändert';
  END IF;
  IF NEW."customerId" IS DISTINCT FROM OLD."customerId" AND NOT (NEW."customerId" IS NULL) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Ein Mahnschreiben bleibt unverändert';
  END IF;
  IF OLD."deliveredAt" IS NOT NULL AND (NEW."deliveredAt", NEW."deliveredById", NEW."deliveredByName", NEW."deliveredNote") IS DISTINCT FROM (OLD."deliveredAt", OLD."deliveredById", OLD."deliveredByName", OLD."deliveredNote") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Die Übermittlung eines Mahnschreibens ist bereits dokumentiert';
  END IF;
  IF OLD."deliveredAt" IS NULL AND NEW."deliveredAt" IS NULL AND (NEW."deliveredById", NEW."deliveredByName", NEW."deliveredNote") IS DISTINCT FROM (OLD."deliveredById", OLD."deliveredByName", OLD."deliveredNote") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Ein Mahnschreiben bleibt unverändert';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_guard_dunning_notice" BEFORE UPDATE OR DELETE ON "DunningNotice" FOR EACH ROW EXECUTE FUNCTION rb_guard_dunning_notice();
