-- Behörden-Automatik Stufe 1: Behörden-Adressbuch, hochgeladene Schreiben mit erkannten Vorschlägen, Fristen-Erinnerung,
-- Bearbeitungsentgelt als eigene Rechnungsart (AUTHORITY_FEE). Rein additiv: keine bestehende Zeile wird geändert.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "authorityCaseId" TEXT;
-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "authorityReminderDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "authorityReminderEmail" TEXT;
-- CreateTable
CREATE TABLE "AuthorityContact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "department" TEXT,
    "address" TEXT,
    "email" TEXT,
    "portalUrl" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuthorityContact_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AuthorityUpload" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "textLength" INTEGER NOT NULL DEFAULT 0,
    "suggestion" JSONB,
    "caseId" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthorityUpload_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "AuthorityContact_tenantId_nameKey_key" ON "AuthorityContact"("tenantId", "nameKey");
-- CreateIndex
CREATE UNIQUE INDEX "AuthorityUpload_storageKey_key" ON "AuthorityUpload"("storageKey");
-- CreateIndex
CREATE INDEX "AuthorityUpload_tenantId_createdAt_idx" ON "AuthorityUpload"("tenantId", "createdAt");
-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_authorityCaseId_fkey" FOREIGN KEY ("authorityCaseId") REFERENCES "AuthorityCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AuthorityContact" ADD CONSTRAINT "AuthorityContact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AuthorityUpload" ADD CONSTRAINT "AuthorityUpload_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AuthorityUpload" ADD CONSTRAINT "AuthorityUpload_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AuthorityCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Regeln
-- ---------------------------------------------------------------------------

ALTER TABLE "Tenant" ADD CONSTRAINT "rb_tenant_authority_reminder" CHECK ("authorityReminderDays" BETWEEN 0 AND 30);
ALTER TABLE "AuthorityContact" ADD CONSTRAINT "rb_authority_contact_name" CHECK (length(trim("name")) >= 2 AND length("nameKey") >= 2);
ALTER TABLE "AuthorityContact" ADD CONSTRAINT "rb_authority_contact_portal" CHECK ("portalUrl" IS NULL OR "portalUrl" LIKE 'https://%');
ALTER TABLE "AuthorityUpload" ADD CONSTRAINT "rb_authority_upload_used" CHECK ("caseId" IS NULL OR "usedAt" IS NOT NULL);

-- Hochgeladenes Schreiben: Vorgang (falls gesetzt) im selben Mandanten; eine Zuordnung ist endgültig
CREATE OR REPLACE FUNCTION rb_check_authority_upload() RETURNS trigger AS $$
DECLARE
  c_tenant text;
BEGIN
  IF NEW."caseId" IS NOT NULL THEN
    SELECT "tenantId" INTO c_tenant FROM "AuthorityCase" WHERE "id" = NEW."caseId";
    IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Schreiben und Behördenvorgang gehören zu verschiedenen Mandanten';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- NULL nur durch das Löschen des Vorgangs (Bereinigung von Testmandanten, ON DELETE SET NULL)
    IF OLD."caseId" IS NOT NULL AND NEW."caseId" IS NOT NULL AND NEW."caseId" <> OLD."caseId" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Das Schreiben ist bereits einem Vorgang zugeordnet';
    END IF;
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."storageKey" <> OLD."storageKey" OR NEW."checksum" <> OLD."checksum" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Datei und Mandant eines hochgeladenen Schreibens sind unveränderlich';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_authority_upload_check BEFORE INSERT OR UPDATE ON "AuthorityUpload" FOR EACH ROW EXECUTE FUNCTION rb_check_authority_upload();

-- Neue Rechnungsart: Bearbeitungsentgelt zu einem Behördenvorgang (nur mit Vorgangsbezug, höchstens eine offene/abgeschlossene Rechnung je Vorgang)
ALTER TABLE "Invoice" DROP CONSTRAINT "rb_invoice_kind";
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_kind" CHECK ("kind" IN ('RENTAL', 'DAMAGE', 'AUTHORITY_FEE'));
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_authority_refs" CHECK (("kind" = 'AUTHORITY_FEE') = ("authorityCaseId" IS NOT NULL));
CREATE UNIQUE INDEX "rb_invoice_one_per_authority_case" ON "Invoice" ("tenantId", "authorityCaseId") WHERE "authorityCaseId" IS NOT NULL AND "status" IN ('DRAFT', 'FINALIZED') AND "documentType" = 'INVOICE';

CREATE OR REPLACE FUNCTION rb_check_invoice_authority_case() RETURNS trigger AS $$
DECLARE
  c_tenant text;
  c_booking text;
BEGIN
  IF NEW."authorityCaseId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId" INTO c_tenant, c_booking FROM "AuthorityCase" WHERE "id" = NEW."authorityCaseId";
    IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Rechnung und Behördenvorgang gehören zu verschiedenen Mandanten';
    END IF;
    IF TG_OP = 'INSERT' AND NEW."documentType" = 'INVOICE' AND c_booking IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Das Bearbeitungsentgelt muss zur Vermietung des Behördenvorgangs gehören';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."authorityCaseId" IS DISTINCT FROM OLD."authorityCaseId" AND OLD."authorityCaseId" IS NOT NULL THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Der Vorgangsbezug einer Rechnung ist unveränderlich';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invoice_authority_case_check BEFORE INSERT OR UPDATE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION rb_check_invoice_authority_case();

-- Historie des Vorgangs kennt das Ereignis „Bearbeitungsentgelt berechnet“
ALTER TABLE "AuthorityCaseEvent" DROP CONSTRAINT "rb_authority_event_type";
ALTER TABLE "AuthorityCaseEvent" ADD CONSTRAINT "rb_authority_event_type" CHECK ("type" IN ('CREATED', 'UPDATED', 'DOCUMENT_ADDED', 'DOCUMENT_ARCHIVED', 'VEHICLE_MATCHED', 'RENTAL_MATCHED', 'DRIVER_SELECTED', 'DRIVER_CHANGED', 'RESPONSE_CREATED', 'RESPONSE_APPROVED', 'RESPONSE_SUBMITTED', 'SUBMISSION_FAILED', 'RECEIPT_ADDED', 'CLOSED', 'REOPENED', 'CANCELLED', 'NOTE_ADDED', 'STATUS_CHANGED', 'FEE_INVOICE_CREATED'));
