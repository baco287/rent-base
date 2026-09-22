-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "invoiceVersionId" TEXT;

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN     "invoiceVersionId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "currentVersionId" TEXT,
ADD COLUMN     "exportBatchId" TEXT,
ADD COLUMN     "exportedAt" TIMESTAMP(3),
ALTER COLUMN "servicePeriodStart" DROP NOT NULL,
ALTER COLUMN "servicePeriodEnd" DROP NOT NULL,
ALTER COLUMN "pricesIncludeTax" DROP NOT NULL,
ALTER COLUMN "customerSnapshot" DROP NOT NULL,
ALTER COLUMN "companySnapshot" DROP NOT NULL;

-- CreateTable
CREATE TABLE "InvoiceVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "supersedesVersionId" TEXT,
    "reason" TEXT,
    "issueDate" TIMESTAMP(3),
    "correctionDate" TIMESTAMP(3),
    "servicePeriodStart" TIMESTAMP(3) NOT NULL,
    "servicePeriodEnd" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "pricesIncludeTax" BOOLEAN NOT NULL,
    "customerSnapshot" JSONB NOT NULL,
    "companySnapshot" JSONB NOT NULL,
    "netTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "grossTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "paymentTermDays" INTEGER,
    "paymentDueDate" TIMESTAMP(3),
    "customerNote" TEXT,
    "taxNote" TEXT,
    "contentHash" TEXT,
    "diffFromPrevious" JSONB,
    "deliveredAt" TIMESTAMP(3),
    "deliveredById" TEXT,
    "deliveredByName" TEXT,
    "deliveredNote" TEXT,
    "exportedAt" TIMESTAMP(3),
    "exportBatchId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finalizedAt" TIMESTAMP(3),
    "finalizedById" TEXT,
    "finalizedByName" TEXT,

    CONSTRAINT "InvoiceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceVersionItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "netAmount" DECIMAL(65,30) NOT NULL,
    "taxRate" DECIMAL(65,30) NOT NULL,
    "taxAmount" DECIMAL(65,30) NOT NULL,
    "grossAmount" DECIMAL(65,30) NOT NULL,
    "source" TEXT NOT NULL,
    "extraChargeId" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceVersionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceVersion_tenantId_invoiceId_status_idx" ON "InvoiceVersion"("tenantId", "invoiceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceVersion_invoiceId_versionNo_key" ON "InvoiceVersion"("invoiceId", "versionNo");

-- CreateIndex
CREATE INDEX "InvoiceVersionItem_tenantId_versionId_idx" ON "InvoiceVersionItem"("tenantId", "versionId");

-- CreateIndex
CREATE INDEX "EmailLog_tenantId_invoiceVersionId_idx" ON "EmailLog"("tenantId", "invoiceVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_currentVersionId_key" ON "Invoice"("currentVersionId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_invoiceVersionId_fkey" FOREIGN KEY ("invoiceVersionId") REFERENCES "InvoiceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_invoiceVersionId_fkey" FOREIGN KEY ("invoiceVersionId") REFERENCES "InvoiceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "InvoiceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "InvoiceVersion_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersionItem" ADD CONSTRAINT "InvoiceVersionItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVersionItem" ADD CONSTRAINT "InvoiceVersionItem_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "InvoiceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Phase 10: Rechnungsfassungen. Die unveränderliche Wahrheit liegt auf InvoiceVersion/InvoiceVersionItem.
-- Invoice (logische Rechnung) darf nach dem Abschluss nur noch Zeiger, Notiz, Protokoll und Exportmarke ändern.
-- ============================================================================

ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "rb_invoice_version_kind" CHECK ("kind" IN ('ORIGINAL', 'REVISION', 'CORRECTION'));
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "rb_invoice_version_status" CHECK ("status" IN ('DRAFT', 'FINALIZED'));
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "rb_invoice_version_no" CHECK ("versionNo" >= 1);
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "rb_invoice_version_sealed" CHECK ("status" <> 'FINALIZED' OR ("contentHash" IS NOT NULL AND "finalizedAt" IS NOT NULL));
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "rb_invoice_version_reason" CHECK ("status" <> 'FINALIZED' OR "kind" <> 'CORRECTION' OR ("reason" IS NOT NULL AND length(trim("reason")) >= 3));
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "rb_invoice_version_delivered" CHECK (("deliveredAt" IS NULL) = ("deliveredById" IS NULL));
ALTER TABLE "InvoiceVersionItem" ADD CONSTRAINT "rb_invoice_version_item_amounts" CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "netAmount" >= 0 AND "taxAmount" >= 0 AND "taxRate" >= 0 AND "taxRate" <= 100 AND "grossAmount" = "netAmount" + "taxAmount");

-- Ein Dokument je Fassung (Rechnungsfassung zählt jetzt mit)
DROP INDEX IF EXISTS "rb_document_one_per_version";
CREATE UNIQUE INDEX "rb_document_one_per_version" ON "Document" ("tenantId", "type", COALESCE("contractId", ''), COALESCE("handoverId", ''), COALESCE("invoiceId", ''), COALESCE("invoiceVersionId", ''), "version");

-- Fassung: Mandant passt zur Rechnung; keine neue Fassung unter einer exportierten Rechnung; Draft nur als höchste Nummer
CREATE OR REPLACE FUNCTION rb_check_invoice_version() RETURNS trigger AS $$
DECLARE
  i_tenant text;
  i_exported timestamp;
  max_no integer;
BEGIN
  SELECT "tenantId", "exportedAt" INTO i_tenant, i_exported FROM "Invoice" WHERE "id" = NEW."invoiceId";
  IF i_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Rechnungsfassung und Rechnung gehören zu verschiedenen Mandanten';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF i_exported IS NOT NULL AND NOT rb_purge_allowed() THEN
      RAISE EXCEPTION 'RB_DOMAIN: Diese Rechnung wurde bereits buchhalterisch exportiert. Eine Änderung unter derselben Rechnungsnummer ist nicht mehr möglich';
    END IF;
    SELECT COALESCE(MAX("versionNo"), 0) INTO max_no FROM "InvoiceVersion" WHERE "invoiceId" = NEW."invoiceId";
    IF NEW."versionNo" <> max_no + 1 THEN
      RAISE EXCEPTION 'RB_DOMAIN: Fassungsnummern sind lückenlos und fortlaufend (erwartet %)', max_no + 1;
    END IF;
  END IF;
  IF NEW."supersedesVersionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "InvoiceVersion" p WHERE p."id" = NEW."supersedesVersionId" AND p."invoiceId" = NEW."invoiceId" AND p."versionNo" < NEW."versionNo") THEN
    RAISE EXCEPTION 'RB_DOMAIN: Die Vorfassung gehört nicht zu dieser Rechnung';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invoice_version_check BEFORE INSERT OR UPDATE ON "InvoiceVersion" FOR EACH ROW EXECUTE FUNCTION rb_check_invoice_version();

-- Fassung: abgeschlossen = unveränderlich und unlöschbar. Erlaubt bleibt nur das einmalige Setzen der Übergabe-
-- und Exportmarken (nie zurücksetzen). Verglichen wird der ganze Datensatz ohne diese Felder.
CREATE OR REPLACE FUNCTION rb_guard_invoice_version() RETURNS trigger AS $$
DECLARE
  o jsonb;
  n jsonb;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Abgeschlossene Rechnungsfassungen werden nicht gelöscht';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."invoiceId" <> OLD."invoiceId" OR NEW."versionNo" <> OLD."versionNo" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Zuordnung einer Rechnungsfassung ist fest';
    END IF;
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD) - 'deliveredAt' - 'deliveredById' - 'deliveredByName' - 'deliveredNote' - 'exportedAt' - 'exportBatchId' - 'updatedAt';
  n := to_jsonb(NEW) - 'deliveredAt' - 'deliveredById' - 'deliveredByName' - 'deliveredNote' - 'exportedAt' - 'exportBatchId' - 'updatedAt';
  IF o <> n THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Rechnungsfassung % ist abgeschlossen und kann nicht geändert werden', OLD."versionNo";
  END IF;
  IF OLD."deliveredAt" IS NOT NULL AND (NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt" OR NEW."deliveredById" IS DISTINCT FROM OLD."deliveredById" OR NEW."deliveredNote" IS DISTINCT FROM OLD."deliveredNote") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Die Übergabemarkierung wird nicht verändert oder entfernt';
  END IF;
  IF OLD."exportedAt" IS NOT NULL AND (NEW."exportedAt" IS DISTINCT FROM OLD."exportedAt" OR NEW."exportBatchId" IS DISTINCT FROM OLD."exportBatchId") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Die Exportmarke wird nicht verändert oder entfernt';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invoice_version_guard BEFORE UPDATE OR DELETE ON "InvoiceVersion" FOR EACH ROW EXECUTE FUNCTION rb_guard_invoice_version();

-- Positionen: nur solange die Fassung Entwurf ist; Mandant passt zur Fassung
CREATE OR REPLACE FUNCTION rb_guard_invoice_version_item() RETURNS trigger AS $$
DECLARE
  vid text;
  st text;
  v_tenant text;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN vid := OLD."versionId"; ELSE vid := NEW."versionId"; END IF;
  SELECT "status", "tenantId" INTO st, v_tenant FROM "InvoiceVersion" WHERE "id" = vid;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Positionen einer abgeschlossenen Rechnungsfassung sind gesperrt';
  END IF;
  IF TG_OP <> 'DELETE' AND v_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Position und Rechnungsfassung gehören zu verschiedenen Mandanten';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invoice_version_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceVersionItem" FOR EACH ROW EXECUTE FUNCTION rb_guard_invoice_version_item();

-- Logische Rechnung: nach dem Abschluss nur noch currentVersionId (vorwärts, auf eigene abgeschlossene Fassung),
-- changeLog, notes, Exportmarke (einmalig) und updatedAt. Altbestandsspalten und Nummer sind fest.
CREATE OR REPLACE FUNCTION rb_guard_invoice() RETURNS trigger AS $$
DECLARE
  o jsonb;
  n jsonb;
  v_invoice text;
  v_status text;
  v_no integer;
  old_no integer;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW."status" = 'FINALIZED' AND NEW."number" IS NULL THEN
      RAISE EXCEPTION 'RB_DOMAIN: Abschluss ohne Rechnungsnummer';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Rechnung % kann nicht gelöscht werden', OLD."number";
  END IF;
  o := to_jsonb(OLD) - 'currentVersionId' - 'changeLog' - 'notes' - 'exportedAt' - 'exportBatchId' - 'updatedAt';
  n := to_jsonb(NEW) - 'currentVersionId' - 'changeLog' - 'notes' - 'exportedAt' - 'exportBatchId' - 'updatedAt';
  IF o <> n THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Rechnung % ist abgeschlossen; nur Fassungszeiger, Notiz, Protokoll und Exportmarke sind änderbar', OLD."number";
  END IF;
  IF NEW."currentVersionId" IS DISTINCT FROM OLD."currentVersionId" THEN
    IF NEW."currentVersionId" IS NULL THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine abgeschlossene Rechnung behält immer eine aktuelle Fassung';
    END IF;
    SELECT "invoiceId", "status", "versionNo" INTO v_invoice, v_status, v_no FROM "InvoiceVersion" WHERE "id" = NEW."currentVersionId";
    IF v_invoice IS DISTINCT FROM NEW."id" OR v_status <> 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die aktuelle Fassung muss eine abgeschlossene Fassung dieser Rechnung sein';
    END IF;
    IF OLD."currentVersionId" IS NOT NULL THEN
      SELECT "versionNo" INTO old_no FROM "InvoiceVersion" WHERE "id" = OLD."currentVersionId";
      IF v_no <= old_no THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die aktuelle Fassung kann nur auf eine neuere Fassung wechseln';
      END IF;
    END IF;
  END IF;
  IF OLD."exportedAt" IS NOT NULL AND (NEW."exportedAt" IS DISTINCT FROM OLD."exportedAt" OR NEW."exportBatchId" IS DISTINCT FROM OLD."exportBatchId") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Die Exportmarke wird nicht verändert oder entfernt';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Dokument und E-Mail-Protokoll: Fassung gehört zum selben Mandanten und zur selben Rechnung
CREATE OR REPLACE FUNCTION rb_check_invoice_version_ref() RETURNS trigger AS $$
DECLARE
  v_tenant text;
  v_invoice text;
BEGIN
  IF NEW."invoiceVersionId" IS NULL THEN RETURN NEW; END IF;
  SELECT "tenantId", "invoiceId" INTO v_tenant, v_invoice FROM "InvoiceVersion" WHERE "id" = NEW."invoiceVersionId";
  IF v_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Rechnungsfassung gehört zu einem anderen Mandanten';
  END IF;
  IF NEW."invoiceId" IS NOT NULL AND v_invoice IS DISTINCT FROM NEW."invoiceId" THEN
    RAISE EXCEPTION 'RB_DOMAIN: Rechnungsfassung gehört zu einer anderen Rechnung';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_document_version_check BEFORE INSERT OR UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION rb_check_invoice_version_ref();
CREATE TRIGGER rb_email_log_version_check BEFORE INSERT OR UPDATE ON "EmailLog" FOR EACH ROW EXECUTE FUNCTION rb_check_invoice_version_ref();

-- ============================================================================
-- Backfill: jede bestehende Rechnung wird zu Fassung 1 (kind ORIGINAL). Deterministische IDs (<id>_v1) machen die
-- Herkunft rückwärts nachvollziehbar. Idempotent: bereits übernommene Zeilen werden übersprungen. Altbestand bleibt.
-- Der Block zwischen den Markern wird vom Migrationstest unverändert erneut ausgeführt.
-- ============================================================================
-- BACKFILL START
INSERT INTO "InvoiceVersion" ("id", "tenantId", "invoiceId", "versionNo", "kind", "status", "issueDate", "servicePeriodStart", "servicePeriodEnd", "currency", "pricesIncludeTax", "customerSnapshot", "companySnapshot", "netTotal", "taxTotal", "grossTotal", "paymentTermDays", "paymentDueDate", "customerNote", "taxNote", "contentHash", "createdById", "createdAt", "updatedAt", "finalizedAt")
SELECT i."id" || '_v1', i."tenantId", i."id", 1, 'ORIGINAL', 'DRAFT', i."issueDate", i."servicePeriodStart", i."servicePeriodEnd", i."currency", i."pricesIncludeTax", i."customerSnapshot", i."companySnapshot", i."netTotal", i."taxTotal", i."grossTotal", i."paymentTermDays", i."paymentDueDate", i."customerNote", i."taxNote", i."contentHash", i."createdById", i."createdAt", now(), i."finalizedAt"
FROM "Invoice" i
WHERE i."servicePeriodStart" IS NOT NULL AND i."customerSnapshot" IS NOT NULL AND i."companySnapshot" IS NOT NULL AND i."pricesIncludeTax" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "InvoiceVersion" v WHERE v."invoiceId" = i."id");

INSERT INTO "InvoiceVersionItem" ("id", "tenantId", "versionId", "sortOrder", "description", "quantity", "unit", "unitPrice", "netAmount", "taxRate", "taxAmount", "grossAmount", "source", "extraChargeId", "reference", "createdAt")
SELECT it."id" || '_v1', it."tenantId", it."invoiceId" || '_v1', it."sortOrder", it."description", it."quantity", it."unit", it."unitPrice", it."netAmount", it."taxRate", it."taxAmount", it."grossAmount", it."source", it."extraChargeId", it."reference", it."createdAt"
FROM "InvoiceItem" it
JOIN "InvoiceVersion" v ON v."id" = it."invoiceId" || '_v1' AND v."status" = 'DRAFT'
WHERE NOT EXISTS (SELECT 1 FROM "InvoiceVersionItem" x WHERE x."id" = it."id" || '_v1');

UPDATE "InvoiceVersion" v SET "status" = 'FINALIZED'
FROM "Invoice" i
WHERE v."id" = i."id" || '_v1' AND v."status" = 'DRAFT' AND i."status" = 'FINALIZED' AND v."contentHash" IS NOT NULL AND v."finalizedAt" IS NOT NULL;

UPDATE "Invoice" i SET "currentVersionId" = i."id" || '_v1'
WHERE i."status" = 'FINALIZED' AND i."currentVersionId" IS NULL
  AND EXISTS (SELECT 1 FROM "InvoiceVersion" v WHERE v."id" = i."id" || '_v1' AND v."status" = 'FINALIZED');

-- Dokumente sind nur anfügbar; die Verknüpfung zur Fassung wird einmalig mit Freigabe nachgetragen (Inhalt und Datei bleiben unverändert)
SET rentbase.allow_purge = 'on';
UPDATE "Document" d SET "invoiceVersionId" = d."invoiceId" || '_v1'
WHERE d."invoiceId" IS NOT NULL AND d."invoiceVersionId" IS NULL
  AND EXISTS (SELECT 1 FROM "InvoiceVersion" v WHERE v."id" = d."invoiceId" || '_v1');
RESET rentbase.allow_purge;

UPDATE "EmailLog" e SET "invoiceVersionId" = e."invoiceId" || '_v1'
WHERE e."invoiceId" IS NOT NULL AND e."invoiceVersionId" IS NULL
  AND EXISTS (SELECT 1 FROM "InvoiceVersion" v WHERE v."id" = e."invoiceId" || '_v1');
-- BACKFILL END
