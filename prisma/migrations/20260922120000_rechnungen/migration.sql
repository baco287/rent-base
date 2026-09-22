-- Rechnungsmodul (Phase 8). Alles additiv und rückwärtsverträglich.

-- AlterTable: Rechnungsdaten des Mandanten (Steuerkonfiguration bleibt bewusst leer, bis der Inhaber sie setzt)
ALTER TABLE "Tenant" ADD COLUMN     "legalForm" TEXT,
ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'DE',
ADD COLUMN     "vatId" TEXT,
ADD COLUMN     "taxNumber" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "iban" TEXT,
ADD COLUMN     "bic" TEXT,
ADD COLUMN     "invoiceFooter" TEXT,
ADD COLUMN     "paymentTermDays" INTEGER,
ADD COLUMN     "defaultTaxRate" DECIMAL(65,30),
ADD COLUMN     "pricesIncludeTax" BOOLEAN,
ADD COLUMN     "taxNote" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "invoiceId" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN     "invoiceId" TEXT;

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "customerId" TEXT,
    "contractId" TEXT,
    "returnHandoverId" TEXT,
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "issueDate" TIMESTAMP(3),
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
    "notes" TEXT,
    "changeLog" JSONB NOT NULL DEFAULT '[]',
    "contentHash" TEXT,
    "sourceHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
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

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_number_key" ON "Invoice"("tenantId", "number");
CREATE INDEX "Invoice_tenantId_bookingId_idx" ON "Invoice"("tenantId", "bookingId");
CREATE INDEX "Invoice_tenantId_status_idx" ON "Invoice"("tenantId", "status");
CREATE INDEX "InvoiceItem_tenantId_invoiceId_idx" ON "InvoiceItem"("tenantId", "invoiceId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_returnHandoverId_fkey" FOREIGN KEY ("returnHandoverId") REFERENCES "Handover"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_extraChargeId_fkey" FOREIGN KEY ("extraChargeId") REFERENCES "ExtraCharge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Von Hand ergänzt: fachliche Regeln in der Datenbank
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_status" CHECK ("status" IN ('DRAFT', 'FINALIZED', 'CANCELLED', 'CREDITED'));
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_number_when_final" CHECK ("status" = 'DRAFT' OR "number" IS NOT NULL);
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "rb_invoice_item_amounts" CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "netAmount" >= 0 AND "taxAmount" >= 0 AND "taxRate" >= 0 AND "taxRate" <= 100 AND "grossAmount" = "netAmount" + "taxAmount");
-- Je Buchung höchstens eine finalisierte Rechnung (Storno und Gutschrift kommen später als eigene Belege)
CREATE UNIQUE INDEX "rb_invoice_one_final_per_booking" ON "Invoice" ("tenantId", "bookingId") WHERE "status" = 'FINALIZED';
-- Ein Dokument je Rechnung und Version
DROP INDEX IF EXISTS "rb_document_one_per_version";
CREATE UNIQUE INDEX "rb_document_one_per_version" ON "Document" ("tenantId", "type", COALESCE("contractId", ''), COALESCE("handoverId", ''), COALESCE("invoiceId", ''), "version");

-- Von Hand ergänzt: finalisierte Rechnungen sind unveränderlich, ihre Positionen ebenso
CREATE OR REPLACE FUNCTION rb_guard_invoice() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Rechnung % kann nicht gelöscht werden', OLD."number";
    END IF;
    RAISE EXCEPTION 'RB_IMMUTABLE: Rechnung % ist abgeschlossen und kann nicht geändert werden', OLD."number";
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invoice_guard BEFORE UPDATE OR DELETE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION rb_guard_invoice();

CREATE OR REPLACE FUNCTION rb_guard_invoice_item() RETURNS trigger AS $$
DECLARE
  iid text;
  st text;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN iid := NEW."invoiceId"; ELSE iid := OLD."invoiceId"; END IF;
  SELECT "status" INTO st FROM "Invoice" WHERE "id" = iid;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Positionen einer abgeschlossenen Rechnung sind gesperrt';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invoice_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceItem" FOR EACH ROW EXECUTE FUNCTION rb_guard_invoice_item();
