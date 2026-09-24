
-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "requiredLicenseClass" TEXT;

-- AlterTable
ALTER TABLE "VehicleGroup" ADD COLUMN     "requiredLicenseClass" TEXT;

-- CreateTable
CREATE TABLE "DriverVerification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "contractDriverId" TEXT NOT NULL,
    "customerId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededById" TEXT,
    "driverRole" TEXT NOT NULL,
    "driverFirstNameSnapshot" TEXT NOT NULL,
    "driverLastNameSnapshot" TEXT NOT NULL,
    "driverBirthDateSnapshot" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "identityDocumentType" TEXT,
    "identityOriginalSeen" BOOLEAN NOT NULL DEFAULT false,
    "identityNameMatched" BOOLEAN,
    "identityBirthDateMatched" BOOLEAN,
    "identityCheckedAt" TIMESTAMP(3),
    "identityCheckedById" TEXT,
    "identityCheckedByName" TEXT,
    "licenseOriginalSeen" BOOLEAN NOT NULL DEFAULT false,
    "licenseDocumentValid" BOOLEAN,
    "licenseNameMatched" BOOLEAN,
    "licenseNumberSnapshot" TEXT,
    "licenseCountrySnapshot" TEXT,
    "licenseIssuedAtSnapshot" TIMESTAMP(3),
    "licenseValidUntilSnapshot" TIMESTAMP(3),
    "licenseClassesSnapshot" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredLicenseClassSnapshot" TEXT,
    "licenseClassSatisfied" BOOLEAN,
    "internationalPermitPresented" BOOLEAN NOT NULL DEFAULT false,
    "translationPresented" BOOLEAN NOT NULL DEFAULT false,
    "manualReviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "manualReviewConfirmed" BOOLEAN,
    "deviatesFromCustomer" BOOLEAN NOT NULL DEFAULT false,
    "deviationConfirmed" BOOLEAN,
    "licenseCheckedAt" TIMESTAMP(3),
    "licenseCheckedById" TEXT,
    "licenseCheckedByName" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "verifiedByName" TEXT,
    "blockedReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "contentHash" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverDocumentCopy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "contractDriverId" TEXT NOT NULL,
    "documentKind" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'FRONT',
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "markedAsCopy" BOOLEAN NOT NULL DEFAULT true,
    "purposeSnapshot" TEXT NOT NULL,
    "consentRequired" BOOLEAN NOT NULL DEFAULT false,
    "consentGiven" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "consentRecordedById" TEXT,
    "consentRecordedByName" TEXT,
    "retentionUntil" TIMESTAMP(3),
    "deletionStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "deletedByName" TEXT,
    "deletionReason" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverDocumentCopy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverVerification_tenantId_handoverId_idx" ON "DriverVerification"("tenantId", "handoverId");

-- CreateIndex
CREATE INDEX "DriverVerification_tenantId_customerId_verifiedAt_idx" ON "DriverVerification"("tenantId", "customerId", "verifiedAt");

-- CreateIndex
CREATE INDEX "DriverVerification_tenantId_bookingId_idx" ON "DriverVerification"("tenantId", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverVerification_tenantId_handoverId_contractDriverId_ver_key" ON "DriverVerification"("tenantId", "handoverId", "contractDriverId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DriverDocumentCopy_storageKey_key" ON "DriverDocumentCopy"("storageKey");

-- CreateIndex
CREATE INDEX "DriverDocumentCopy_tenantId_handoverId_idx" ON "DriverDocumentCopy"("tenantId", "handoverId");

-- CreateIndex
CREATE INDEX "DriverDocumentCopy_tenantId_verificationId_idx" ON "DriverDocumentCopy"("tenantId", "verificationId");

-- CreateIndex
CREATE INDEX "DriverDocumentCopy_tenantId_deletionStatus_retentionUntil_idx" ON "DriverDocumentCopy"("tenantId", "deletionStatus", "retentionUntil");

-- AddForeignKey
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_contractDriverId_fkey" FOREIGN KEY ("contractDriverId") REFERENCES "ContractDriver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "DriverDocumentCopy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "DriverDocumentCopy_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "DriverDocumentCopy_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "DriverDocumentCopy_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "DriverVerification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "DriverDocumentCopy_contractDriverId_fkey" FOREIGN KEY ("contractDriverId") REFERENCES "ContractDriver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Phase 19.5: Regeln in der Datenbank. Prüfvermerke sind nach CONFIRMED unveränderlich und werden nie gelöscht;
-- Dokumentkopien werden nur als gelöscht markiert (Datei entfernt), die Zeile bleibt als Nachweis.
-- ---------------------------------------------------------------------------
ALTER TABLE "DriverVerification" ADD CONSTRAINT "rb_driver_verification_status" CHECK ("status" IN ('IN_PROGRESS', 'CONFIRMED', 'BLOCKED'));
ALTER TABLE "DriverVerification" ADD CONSTRAINT "rb_driver_verification_role" CHECK ("driverRole" IN ('PRIMARY_DRIVER', 'ADDITIONAL_DRIVER'));
ALTER TABLE "DriverVerification" ADD CONSTRAINT "rb_driver_verification_identity_type" CHECK ("identityDocumentType" IS NULL OR "identityDocumentType" IN ('PERSONALAUSWEIS', 'REISEPASS', 'SONSTIGER_AMTLICHER_LICHTBILDAUSWEIS'));
ALTER TABLE "DriverVerification" ADD CONSTRAINT "rb_driver_verification_confirmed" CHECK ("status" <> 'CONFIRMED' OR ("verifiedAt" IS NOT NULL AND "verifiedById" IS NOT NULL AND "contentHash" IS NOT NULL AND "identityOriginalSeen" AND "licenseOriginalSeen" AND "identityNameMatched" AND "identityBirthDateMatched" AND "licenseNameMatched" AND "licenseDocumentValid" AND "licenseClassSatisfied" AND cardinality("licenseClassesSnapshot") > 0 AND "requiredLicenseClassSnapshot" IS NOT NULL));
ALTER TABLE "DriverVerification" ADD CONSTRAINT "rb_driver_verification_version" CHECK ("version" >= 1);

CREATE OR REPLACE FUNCTION rb_guard_driver_verification() RETURNS trigger AS $$
DECLARE
  o jsonb; n jsonb;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Prüfvermerke werden nicht gelöscht';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."handoverId" <> OLD."handoverId" OR NEW."contractDriverId" <> OLD."contractDriverId" OR NEW."bookingId" <> OLD."bookingId" OR NEW."contractId" <> OLD."contractId" OR NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Zuordnung eines Prüfvermerks ist fest';
  END IF;
  IF OLD."status" = 'CONFIRMED' THEN
    o := to_jsonb(OLD) - 'supersededById' - 'updatedAt';
    n := to_jsonb(NEW) - 'supersededById' - 'updatedAt';
    IF o <> n THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Ein bestätigter Prüfvermerk wird nicht geändert; Korrektur nur als neue Fassung';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_driver_verification_guard BEFORE UPDATE OR DELETE ON "DriverVerification" FOR EACH ROW EXECUTE FUNCTION rb_guard_driver_verification();

-- Neue Prüfvermerke nur zu Entwürfen: nach dem Abschluss der Übergabe entstehen keine Vermerke mehr
CREATE OR REPLACE FUNCTION rb_check_driver_verification() RETURNS trigger AS $$
DECLARE
  st text; hb text; ht text; dc text; dt text;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  SELECT "status", "bookingId", "tenantId" INTO st, hb, ht FROM "Handover" WHERE "id" = NEW."handoverId";
  IF st IS NULL OR ht <> NEW."tenantId" OR hb <> NEW."bookingId" THEN
    RAISE EXCEPTION 'RB_TENANT: Prüfvermerk gehört nicht zu diesem Protokoll oder Mandanten';
  END IF;
  IF TG_OP = 'INSERT' AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Zu einem abgeschlossenen Protokoll entstehen keine Prüfvermerke';
  END IF;
  SELECT "contractId", "tenantId" INTO dc, dt FROM "ContractDriver" WHERE "id" = NEW."contractDriverId";
  IF dc IS NULL OR dt <> NEW."tenantId" OR dc <> NEW."contractId" THEN
    RAISE EXCEPTION 'RB_DOMAIN: Der Fahrer gehört nicht zu diesem Vertrag';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_driver_verification_check BEFORE INSERT OR UPDATE ON "DriverVerification" FOR EACH ROW EXECUTE FUNCTION rb_check_driver_verification();

ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "rb_driver_copy_kind" CHECK ("documentKind" IN ('IDENTITY', 'LICENSE'));
ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "rb_driver_copy_side" CHECK ("side" IN ('FRONT', 'BACK'));
ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "rb_driver_copy_deletion" CHECK ("deletionStatus" IN ('ACTIVE', 'DELETED') AND ("deletionStatus" <> 'DELETED' OR ("deletedAt" IS NOT NULL AND "deletionReason" IS NOT NULL)));
-- Personalausweiskopie nur mit dokumentierter Zustimmung des Ausweisinhabers (§ 20 Abs. 2 PAuswG)
ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "rb_driver_copy_consent" CHECK (NOT "consentRequired" OR ("consentGiven" AND "consentAt" IS NOT NULL AND "consentRecordedById" IS NOT NULL));
ALTER TABLE "DriverDocumentCopy" ADD CONSTRAINT "rb_driver_copy_marked" CHECK ("markedAsCopy");

CREATE OR REPLACE FUNCTION rb_guard_driver_copy() RETURNS trigger AS $$
DECLARE
  o jsonb; n jsonb;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Dokumentkopien werden nur als gelöscht markiert, die Zeile bleibt als Nachweis';
  END IF;
  o := to_jsonb(OLD) - 'deletionStatus' - 'deletedAt' - 'deletedById' - 'deletedByName' - 'deletionReason' - 'retentionUntil';
  n := to_jsonb(NEW) - 'deletionStatus' - 'deletedAt' - 'deletedById' - 'deletedByName' - 'deletionReason' - 'retentionUntil';
  IF o <> n THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: An einer Dokumentkopie ändern sich nur Löschung und Aufbewahrung';
  END IF;
  IF OLD."deletionStatus" = 'DELETED' AND NEW."deletionStatus" <> 'DELETED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine gelöschte Dokumentkopie wird nicht wiederhergestellt';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_driver_copy_guard BEFORE UPDATE OR DELETE ON "DriverDocumentCopy" FOR EACH ROW EXECUTE FUNCTION rb_guard_driver_copy();
