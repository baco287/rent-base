-- AlterTable
ALTER TABLE "RentalContract" ADD COLUMN     "individualAgreements" TEXT,
ADD COLUMN     "rentalTermsVersionId" TEXT,
ADD COLUMN     "termsAcknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "termsAcknowledgedById" TEXT,
ADD COLUMN     "termsAcknowledgedByName" TEXT,
ADD COLUMN     "termsAcknowledgedHash" TEXT,
ADD COLUMN     "termsFormat" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "businessRules" JSONB,
ADD COLUMN     "privacyNoticeReference" TEXT,
ADD COLUMN     "rentalTermsSequence" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "businessRules" JSONB;

-- AlterTable
ALTER TABLE "VehicleGroup" ADD COLUMN     "businessRules" JSONB;

-- CreateTable
CREATE TABLE "RentalTermsVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3),
    "content" TEXT NOT NULL,
    "contentFormat" TEXT NOT NULL DEFAULT 'MARKDOWN',
    "changeNote" TEXT,
    "checksum" TEXT,
    "sourceVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdByName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedByName" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archivedByName" TEXT,

    CONSTRAINT "RentalTermsVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RentalTermsVersion_tenantId_status_idx" ON "RentalTermsVersion"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RentalTermsVersion_tenantId_versionNumber_key" ON "RentalTermsVersion"("tenantId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RentalTermsVersion_tenantId_label_key" ON "RentalTermsVersion"("tenantId", "label");

-- CreateIndex
CREATE INDEX "RentalContract_tenantId_rentalTermsVersionId_idx" ON "RentalContract"("tenantId", "rentalTermsVersionId");

-- AddForeignKey
ALTER TABLE "RentalContract" ADD CONSTRAINT "RentalContract_rentalTermsVersionId_fkey" FOREIGN KEY ("rentalTermsVersionId") REFERENCES "RentalTermsVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalTermsVersion" ADD CONSTRAINT "RentalTermsVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrität Phase 15: Mietbedingungen-Fassungen, Geschäftsregeln, Vertragsbindung
-- ---------------------------------------------------------------------------

-- Fassungen: Status, Pflichtfelder je Status
ALTER TABLE "RentalTermsVersion" ADD CONSTRAINT "rb_terms_status" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'));
ALTER TABLE "RentalTermsVersion" ADD CONSTRAINT "rb_terms_format" CHECK ("contentFormat" IN ('MARKDOWN'));
ALTER TABLE "RentalTermsVersion" ADD CONSTRAINT "rb_terms_version_positive" CHECK ("versionNumber" > 0);
ALTER TABLE "RentalTermsVersion" ADD CONSTRAINT "rb_terms_label" CHECK (length(btrim("label")) BETWEEN 1 AND 40);
ALTER TABLE "RentalTermsVersion" ADD CONSTRAINT "rb_terms_published_fields" CHECK ("status" = 'DRAFT' OR ("publishedAt" IS NOT NULL AND "checksum" IS NOT NULL AND length("checksum") = 64));
ALTER TABLE "RentalTermsVersion" ADD CONSTRAINT "rb_terms_archived_fields" CHECK ("status" <> 'ARCHIVED' OR "archivedAt" IS NOT NULL);

-- Veröffentlichte und archivierte Fassungen sind unveränderlich; erlaubt ist nur PUBLISHED -> ARCHIVED mit Archivfeldern.
CREATE OR REPLACE FUNCTION rb_guard_terms_version() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Veröffentlichte oder archivierte Mietbedingungen (Fassung %) werden nicht gelöscht', OLD."label";
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."versionNumber" <> OLD."versionNumber" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Mandant und Versionsnummer einer Fassung sind fest';
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN
    IF (to_jsonb(NEW) - 'updatedAt') <> (to_jsonb(OLD) - 'updatedAt') THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Die archivierte Fassung % ist unveränderlich', OLD."label";
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PUBLISHED' THEN
    IF NEW."status" = 'ARCHIVED' AND NEW."archivedAt" IS NOT NULL
       AND (to_jsonb(NEW) - 'status' - 'updatedAt' - 'archivedAt' - 'archivedById' - 'archivedByName') = (to_jsonb(OLD) - 'status' - 'updatedAt' - 'archivedAt' - 'archivedById' - 'archivedByName') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'RB_IMMUTABLE: Die veröffentlichte Fassung % ist unveränderlich; Änderungen erzeugen eine neue Fassung', OLD."label";
  END IF;
  -- DRAFT: Veröffentlichung braucht Prüfsumme und Zeitpunkt; Archivieren aus dem Entwurf heraus gibt es nicht (Entwürfe werden gelöscht)
  IF NEW."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'RB_DOMAIN: Ein Entwurf wird nicht archiviert, sondern verworfen';
  END IF;
  IF NEW."status" = 'PUBLISHED' AND (NEW."checksum" IS NULL OR NEW."publishedAt" IS NULL) THEN
    RAISE EXCEPTION 'RB_DOMAIN: Eine Veröffentlichung braucht Prüfsumme und Zeitpunkt';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_terms_version_guard BEFORE UPDATE OR DELETE ON "RentalTermsVersion" FOR EACH ROW EXECUTE FUNCTION rb_guard_terms_version();

-- Geschäftsregeln (JSON): Geldwerte nie negativ, Aufzählungswerte gültig, Mindestalter plausibel
CREATE OR REPLACE FUNCTION rb_business_rules_valid(rules jsonb) RETURNS boolean AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF rules IS NULL OR rules = 'null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(rules) <> 'object' THEN RETURN false; END IF;
  FOR k, v IN SELECT * FROM jsonb_each(rules) LOOP
    IF v = 'null'::jsonb THEN CONTINUE; END IF;
    IF k LIKE '%Cents' THEN
      IF jsonb_typeof(v) <> 'number' OR (v::text)::numeric < 0 THEN RETURN false; END IF;
    ELSIF k = 'minimumDriverAge' THEN
      IF jsonb_typeof(v) <> 'number' OR (v::text)::numeric < 16 OR (v::text)::numeric > 99 THEN RETURN false; END IF;
    ELSIF k = 'minimumLicenseHoldingMonths' THEN
      IF jsonb_typeof(v) <> 'number' OR (v::text)::numeric < 0 OR (v::text)::numeric > 600 THEN RETURN false; END IF;
    ELSIF k = 'fuelMinimumEighths' THEN
      IF jsonb_typeof(v) <> 'number' OR (v::text)::numeric < 0 OR (v::text)::numeric > 8 THEN RETURN false; END IF;
    ELSIF k = 'batteryMinimumPercent' THEN
      IF jsonb_typeof(v) <> 'number' OR (v::text)::numeric < 0 OR (v::text)::numeric > 100 THEN RETURN false; END IF;
    ELSIF k = 'kmPolicy' THEN
      IF v NOT IN ('"UNLIMITED"', '"FREE_KILOMETERS"', '"INDIVIDUAL"') THEN RETURN false; END IF;
    ELSIF k = 'fuelRule' THEN
      IF v NOT IN ('"FULL_TO_FULL"', '"SAME_LEVEL"', '"MINIMUM_LEVEL"', '"INCLUDED"', '"OTHER"') THEN RETURN false; END IF;
    ELSIF k = 'petsPolicy' THEN
      IF v NOT IN ('"ALLOWED"', '"NOT_ALLOWED"', '"BY_APPROVAL"') THEN RETURN false; END IF;
    ELSIF k = 'lateReturnRule' THEN
      IF v NOT IN ('"MANUAL"', '"ADDITIONAL_RENTAL_TIME"', '"CONFIGURED_FEE"', '"INDIVIDUAL"') THEN RETURN false; END IF;
    ELSIF k = 'outOfHoursReturn' THEN
      IF v NOT IN ('"ALLOWED"', '"NOT_ALLOWED"', '"BY_AGREEMENT"') THEN RETURN false; END IF;
    ELSIF k = 'additionalDriverFeeType' THEN
      IF v NOT IN ('"FREE"', '"FLAT"', '"PER_DAY"') THEN RETURN false; END IF;
    ELSIF k IN ('additionalDriversAllowed', 'abroadAllowed', 'smokingAllowed', 'authorityHandlingFeeEnabled', 'trailerAllowed', 'towingAllowed', 'commercialPassengerTransportAllowed') THEN
      IF jsonb_typeof(v) <> 'boolean' THEN RETURN false; END IF;
    ELSIF k = 'abroadCountries' THEN
      IF jsonb_typeof(v) <> 'array' THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE "Tenant" ADD CONSTRAINT "rb_tenant_rules_valid" CHECK (rb_business_rules_valid("businessRules"));
ALTER TABLE "VehicleGroup" ADD CONSTRAINT "rb_group_rules_valid" CHECK (rb_business_rules_valid("businessRules"));
ALTER TABLE "Vehicle" ADD CONSTRAINT "rb_vehicle_rules_valid" CHECK (rb_business_rules_valid("businessRules"));

-- Vertrag: Format der Bedingungen
ALTER TABLE "RentalContract" ADD CONSTRAINT "rb_contract_terms_format" CHECK ("termsFormat" IS NULL OR "termsFormat" IN ('MARKDOWN', 'PLAIN'));

-- Vertrag ↔ Fassung: gleicher Mandant, bei Auswahl veröffentlicht; beim Abschluss (sobald der Mandant veröffentlichte
-- Bedingungen hat) sind Fassung, Kenntnisnahme und die eingefrorene Prüfsumme der Fassung Pflicht.
CREATE OR REPLACE FUNCTION rb_check_contract_terms() RETURNS trigger AS $$
DECLARE
  v_tenant text;
  v_status text;
  v_checksum text;
  has_published boolean;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF NEW."rentalTermsVersionId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."rentalTermsVersionId" IS DISTINCT FROM OLD."rentalTermsVersionId") THEN
    SELECT "tenantId", "status", "checksum" INTO v_tenant, v_status, v_checksum FROM "RentalTermsVersion" WHERE "id" = NEW."rentalTermsVersionId";
    IF v_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Mietbedingungen und Vertrag gehören zu verschiedenen Mandanten';
    END IF;
    IF v_status <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Nur veröffentlichte Mietbedingungen können einem Vertrag zugeordnet werden';
    END IF;
    IF NEW."termsHash" IS DISTINCT FROM v_checksum THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die eingefrorene Prüfsumme der Mietbedingungen passt nicht zur Fassung';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" = 'SIGNED' AND OLD."status" = 'DRAFT' THEN
    SELECT EXISTS (SELECT 1 FROM "RentalTermsVersion" t WHERE t."tenantId" = NEW."tenantId" AND t."status" IN ('PUBLISHED', 'ARCHIVED')) INTO has_published;
    IF has_published THEN
      IF NEW."rentalTermsVersionId" IS NULL OR NEW."termsHash" IS NULL OR NEW."termsText" IS NULL THEN
        RAISE EXCEPTION 'RB_DOMAIN: Ein Mietvertrag braucht eine veröffentlichte Mietbedingungen-Fassung';
      END IF;
      SELECT "status", "checksum" INTO v_status, v_checksum FROM "RentalTermsVersion" WHERE "id" = NEW."rentalTermsVersionId";
      IF v_status <> 'PUBLISHED' THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die gewählte Mietbedingungen-Fassung ist nicht mehr veröffentlicht';
      END IF;
      IF NEW."termsHash" IS DISTINCT FROM v_checksum THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die eingefrorene Prüfsumme der Mietbedingungen passt nicht zur Fassung';
      END IF;
      IF NEW."termsAcknowledgedAt" IS NULL OR NEW."termsAcknowledgedHash" IS DISTINCT FROM (NEW."rentalTermsVersionId" || ':' || NEW."termsHash") THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die Kenntnisnahme der Mietbedingungen fehlt oder bezieht sich auf eine andere Fassung';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_contract_terms_check BEFORE INSERT OR UPDATE ON "RentalContract" FOR EACH ROW EXECUTE FUNCTION rb_check_contract_terms();
