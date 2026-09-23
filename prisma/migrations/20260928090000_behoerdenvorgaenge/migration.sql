-- Phase 14: Bußgelder, Verkehrsverstöße und Behördenanfragen (additiv: fünf neue Tabellen, keine Änderung bestehender Daten, Start mit 0 Vorgängen)

-- CreateTable
CREATE TABLE "AuthorityCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "authorityName" TEXT NOT NULL,
    "authorityDepartment" TEXT,
    "authorityReference" TEXT NOT NULL,
    "authorityAddress" TEXT,
    "authorityEmail" TEXT,
    "authorityPortalUrl" TEXT,
    "offenseType" TEXT,
    "offenseDescription" TEXT,
    "offenseAt" TIMESTAMP(3) NOT NULL,
    "offenseTimeKnown" BOOLEAN NOT NULL DEFAULT true,
    "offenseLocation" TEXT,
    "licensePlateSnapshot" TEXT NOT NULL,
    "licensePlateNormalized" TEXT NOT NULL,
    "vehicleId" TEXT,
    "bookingId" TEXT,
    "contractId" TEXT,
    "vehicleMatch" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "rentalMatch" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "rentalMatchDayOnly" BOOLEAN NOT NULL DEFAULT false,
    "assignmentStatus" TEXT NOT NULL DEFAULT 'UNASSIGNED',
    "driverDeterminationStatus" TEXT NOT NULL DEFAULT 'UNDETERMINED',
    "driverContractDriverId" TEXT,
    "driverCustomerId" TEXT,
    "driverSnapshot" JSONB,
    "driverNote" TEXT,
    "responseDeadline" TIMESTAMP(3),
    "noticeAmountCents" INTEGER,
    "notes" TEXT,
    "internalNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedByName" TEXT,
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,

    CONSTRAINT "AuthorityCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorityCaseDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "responseId" TEXT,
    "type" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "archivedByName" TEXT,
    "archiveReason" TEXT,

    CONSTRAINT "AuthorityCaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorityResponse" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "responseType" TEXT NOT NULL,
    "submissionMethod" TEXT NOT NULL,
    "recipientSnapshot" JSONB NOT NULL,
    "authorityReference" TEXT NOT NULL,
    "senderSnapshot" JSONB NOT NULL,
    "vehicleSnapshot" JSONB NOT NULL,
    "offenseSnapshot" JSONB NOT NULL,
    "rentalSnapshot" JSONB,
    "personSnapshot" JSONB,
    "freeText" TEXT,
    "contentHash" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedById" TEXT,
    "submittedByName" TEXT,
    "submissionReference" TEXT,
    "emailLogId" TEXT,
    "pdfDocumentId" TEXT,
    "failureReason" TEXT,

    CONSTRAINT "AuthorityResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthoritySubmissionReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "documentId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthoritySubmissionReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorityCaseEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthorityCaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthorityCase_tenantId_status_idx" ON "AuthorityCase"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AuthorityCase_tenantId_vehicleId_idx" ON "AuthorityCase"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "AuthorityCase_tenantId_bookingId_idx" ON "AuthorityCase"("tenantId", "bookingId");

-- CreateIndex
CREATE INDEX "AuthorityCase_tenantId_responseDeadline_idx" ON "AuthorityCase"("tenantId", "responseDeadline");

-- CreateIndex
CREATE INDEX "AuthorityCase_tenantId_licensePlateNormalized_idx" ON "AuthorityCase"("tenantId", "licensePlateNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityCase_tenantId_caseNumber_key" ON "AuthorityCase"("tenantId", "caseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityCaseDocument_storageKey_key" ON "AuthorityCaseDocument"("storageKey");

-- CreateIndex
CREATE INDEX "AuthorityCaseDocument_tenantId_caseId_idx" ON "AuthorityCaseDocument"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "AuthorityResponse_tenantId_caseId_idx" ON "AuthorityResponse"("tenantId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityResponse_caseId_version_key" ON "AuthorityResponse"("caseId", "version");

-- CreateIndex
CREATE INDEX "AuthoritySubmissionReceipt_tenantId_caseId_idx" ON "AuthoritySubmissionReceipt"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "AuthorityCaseEvent_tenantId_caseId_createdAt_idx" ON "AuthorityCaseEvent"("tenantId", "caseId", "createdAt");

-- AddForeignKey
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "AuthorityCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "AuthorityCase_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "AuthorityCase_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "AuthorityCase_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityCaseDocument" ADD CONSTRAINT "AuthorityCaseDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityCaseDocument" ADD CONSTRAINT "AuthorityCaseDocument_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AuthorityCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityCaseDocument" ADD CONSTRAINT "AuthorityCaseDocument_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "AuthorityResponse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityResponse" ADD CONSTRAINT "AuthorityResponse_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityResponse" ADD CONSTRAINT "AuthorityResponse_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AuthorityCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthoritySubmissionReceipt" ADD CONSTRAINT "AuthoritySubmissionReceipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthoritySubmissionReceipt" ADD CONSTRAINT "AuthoritySubmissionReceipt_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AuthorityCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthoritySubmissionReceipt" ADD CONSTRAINT "AuthoritySubmissionReceipt_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "AuthorityResponse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityCaseEvent" ADD CONSTRAINT "AuthorityCaseEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityCaseEvent" ADD CONSTRAINT "AuthorityCaseEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AuthorityCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Integrität Phase 14: Behördenvorgänge, Dokumente, Antwortfassungen, Übermittlungsnachweise, Historie
-- ============================================================================

ALTER TABLE "AuthorityCase" ADD CONSTRAINT "rb_authority_type" CHECK ("type" IN ('SPEEDING', 'PARKING', 'RED_LIGHT', 'TOLL', 'TRAFFIC_VIOLATION', 'DRIVER_IDENTIFICATION', 'AUTHORITY_REQUEST', 'OTHER'));
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "rb_authority_status" CHECK ("status" IN ('RECEIVED', 'ASSIGNMENT_REQUIRED', 'REVIEW_REQUIRED', 'RESPONSE_PREPARED', 'READY_TO_SEND', 'SUBMITTED', 'CLOSED', 'CANCELLED'));
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "rb_authority_vehicle_match" CHECK ("vehicleMatch" IN ('UNMATCHED', 'EXACT_MATCH', 'NO_MATCH', 'AMBIGUOUS', 'MANUALLY_ASSIGNED'));
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "rb_authority_rental_match" CHECK ("rentalMatch" IN ('UNMATCHED', 'ACTUAL_PERIOD', 'PLANNED_PERIOD', 'AMBIGUOUS', 'NONE', 'MANUALLY_ASSIGNED'));
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "rb_authority_assignment" CHECK ("assignmentStatus" IN ('UNASSIGNED', 'VEHICLE_ONLY', 'ASSIGNED', 'NO_MATCH'));
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "rb_authority_driver" CHECK ("driverDeterminationStatus" IN ('UNDETERMINED', 'CONTRACT_DRIVER_SELECTED', 'OTHER_DRIVER_ENTERED', 'NOT_IDENTIFIABLE', 'NO_DRIVER_INFORMATION'));
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "rb_authority_amount" CHECK ("noticeAmountCents" IS NULL OR "noticeAmountCents" >= 0);
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "rb_authority_closed" CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL) AND ("closedAt" IS NULL OR ("closeReason" IS NOT NULL AND length(trim("closeReason")) >= 3)));
ALTER TABLE "AuthorityCase" ADD CONSTRAINT "rb_authority_driver_person" CHECK ("driverDeterminationStatus" NOT IN ('CONTRACT_DRIVER_SELECTED', 'OTHER_DRIVER_ENTERED') OR "driverSnapshot" IS NOT NULL);
ALTER TABLE "AuthorityCaseDocument" ADD CONSTRAINT "rb_authority_document_type" CHECK ("type" IN ('INCOMING_NOTICE', 'EVIDENCE', 'RESPONSE_DRAFT', 'RESPONSE_PDF', 'SUBMISSION_RECEIPT', 'CORRESPONDENCE', 'OTHER'));
ALTER TABLE "AuthorityCaseDocument" ADD CONSTRAINT "rb_authority_document_archive" CHECK (("archivedAt" IS NULL) = ("archiveReason" IS NULL));
ALTER TABLE "AuthorityResponse" ADD CONSTRAINT "rb_authority_response_status" CHECK ("status" IN ('DRAFT', 'APPROVED', 'SUBMITTED', 'FAILED', 'SUPERSEDED'));
ALTER TABLE "AuthorityResponse" ADD CONSTRAINT "rb_authority_response_type" CHECK ("responseType" IN ('DRIVER_IDENTIFIED', 'MULTIPLE_POSSIBLE_DRIVERS', 'DRIVER_NOT_IDENTIFIABLE', 'NO_MATCHING_RENTAL', 'VEHICLE_NOT_IN_FLEET', 'CUSTOM_RESPONSE'));
ALTER TABLE "AuthorityResponse" ADD CONSTRAINT "rb_authority_response_method" CHECK ("submissionMethod" IN ('MANUAL_PORTAL', 'POST', 'EMAIL', 'VERIFIED_API', 'OTHER'));
ALTER TABLE "AuthorityResponse" ADD CONSTRAINT "rb_authority_response_version" CHECK ("version" >= 1);
ALTER TABLE "AuthorityResponse" ADD CONSTRAINT "rb_authority_response_approved" CHECK ("status" = 'DRAFT' OR ("approvedAt" IS NOT NULL AND "contentHash" IS NOT NULL));
ALTER TABLE "AuthorityResponse" ADD CONSTRAINT "rb_authority_response_submitted" CHECK ("status" <> 'SUBMITTED' OR "submittedAt" IS NOT NULL);
ALTER TABLE "AuthorityResponse" ADD CONSTRAINT "rb_authority_response_person" CHECK ("responseType" <> 'DRIVER_IDENTIFIED' OR "personSnapshot" IS NOT NULL);
ALTER TABLE "AuthoritySubmissionReceipt" ADD CONSTRAINT "rb_authority_receipt_method" CHECK ("method" IN ('MANUAL_PORTAL', 'POST', 'EMAIL', 'VERIFIED_API', 'OTHER'));
ALTER TABLE "AuthorityCaseEvent" ADD CONSTRAINT "rb_authority_event_type" CHECK ("type" IN ('CREATED', 'UPDATED', 'DOCUMENT_ADDED', 'DOCUMENT_ARCHIVED', 'VEHICLE_MATCHED', 'RENTAL_MATCHED', 'DRIVER_SELECTED', 'DRIVER_CHANGED', 'RESPONSE_CREATED', 'RESPONSE_APPROVED', 'RESPONSE_SUBMITTED', 'SUBMISSION_FAILED', 'RECEIPT_ADDED', 'CLOSED', 'REOPENED', 'CANCELLED', 'NOTE_ADDED', 'STATUS_CHANGED'));

-- Vorgang: Fahrzeug, Buchung und Vertrag gehören zum Mandanten; Buchung zum Fahrzeug; Vertrag zur Buchung; Nummer fest; nie löschen
CREATE OR REPLACE FUNCTION rb_check_authority_case() RETURNS trigger AS $$
DECLARE
  v_tenant text;
  b_tenant text;
  b_vehicle text;
  c_tenant text;
  c_booking text;
BEGIN
  IF NEW."vehicleId" IS NOT NULL THEN
    SELECT "tenantId" INTO v_tenant FROM "Vehicle" WHERE "id" = NEW."vehicleId";
    IF v_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Behördenvorgang und Fahrzeug gehören zu verschiedenen Mandanten';
    END IF;
  END IF;
  IF NEW."bookingId" IS NOT NULL THEN
    SELECT "tenantId", "vehicleId" INTO b_tenant, b_vehicle FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Behördenvorgang und Buchung gehören zu verschiedenen Mandanten';
    END IF;
    IF NEW."vehicleId" IS NOT NULL AND b_vehicle IS DISTINCT FROM NEW."vehicleId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die zugeordnete Buchung gehört nicht zum zugeordneten Fahrzeug';
    END IF;
  END IF;
  IF NEW."contractId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId" INTO c_tenant, c_booking FROM "RentalContract" WHERE "id" = NEW."contractId";
    IF c_tenant IS DISTINCT FROM NEW."tenantId" OR c_booking IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Der Mietvertrag gehört nicht zur zugeordneten Buchung';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() AND (NEW."tenantId" <> OLD."tenantId" OR NEW."caseNumber" <> OLD."caseNumber" OR NEW."createdAt" <> OLD."createdAt") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Nummer und Mandant eines Behördenvorgangs sind fest';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_authority_case_check BEFORE INSERT OR UPDATE ON "AuthorityCase" FOR EACH ROW EXECUTE FUNCTION rb_check_authority_case();

CREATE OR REPLACE FUNCTION rb_guard_authority_case_delete() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Behördenvorgänge werden nicht gelöscht, nur abgeschlossen oder storniert';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_authority_case_guard BEFORE DELETE ON "AuthorityCase" FOR EACH ROW EXECUTE FUNCTION rb_guard_authority_case_delete();

-- Dokumente, Historie, Nachweise: Mandant passt zum Vorgang
CREATE OR REPLACE FUNCTION rb_check_authority_ref() RETURNS trigger AS $$
DECLARE
  c_tenant text;
BEGIN
  SELECT "tenantId" INTO c_tenant FROM "AuthorityCase" WHERE "id" = NEW."caseId";
  IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Eintrag und Behördenvorgang gehören zu verschiedenen Mandanten';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_authority_event_check BEFORE INSERT ON "AuthorityCaseEvent" FOR EACH ROW EXECUTE FUNCTION rb_check_authority_ref();
CREATE TRIGGER rb_authority_event_guard BEFORE UPDATE OR DELETE ON "AuthorityCaseEvent" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();
CREATE TRIGGER rb_authority_receipt_check BEFORE INSERT ON "AuthoritySubmissionReceipt" FOR EACH ROW EXECUTE FUNCTION rb_check_authority_ref();
CREATE TRIGGER rb_authority_receipt_guard BEFORE UPDATE OR DELETE ON "AuthoritySubmissionReceipt" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();

-- Dokumente: nur Archivfelder und Notiz änderbar, nie löschen
CREATE OR REPLACE FUNCTION rb_check_authority_document() RETURNS trigger AS $$
DECLARE
  c_tenant text;
  o jsonb;
  n jsonb;
BEGIN
  SELECT "tenantId" INTO c_tenant FROM "AuthorityCase" WHERE "id" = NEW."caseId";
  IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Dokument und Behördenvorgang gehören zu verschiedenen Mandanten';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() THEN
    o := to_jsonb(OLD) - 'archivedAt' - 'archivedByName' - 'archiveReason' - 'note' - 'type';
    n := to_jsonb(NEW) - 'archivedAt' - 'archivedByName' - 'archiveReason' - 'note' - 'type';
    IF o <> n THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Datei, Prüfsumme und Zuordnung eines Behördendokuments sind fest';
    END IF;
    IF OLD."archivedAt" IS NOT NULL AND NEW."archivedAt" IS NULL THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine Archivierung wird nicht zurückgenommen';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_authority_document_check BEFORE INSERT OR UPDATE ON "AuthorityCaseDocument" FOR EACH ROW EXECUTE FUNCTION rb_check_authority_document();
CREATE OR REPLACE FUNCTION rb_guard_authority_document_delete() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Behördendokumente werden nicht gelöscht, nur archiviert';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_authority_document_guard BEFORE DELETE ON "AuthorityCaseDocument" FOR EACH ROW EXECUTE FUNCTION rb_guard_authority_document_delete();

-- Antwortfassungen: Mandant passt; ab Freigabe sind alle Inhalte fest, nur Übermittlungsfelder/Status dürfen sich ändern; nie löschen (außer Entwurf)
CREATE OR REPLACE FUNCTION rb_check_authority_response() RETURNS trigger AS $$
DECLARE
  c_tenant text;
  o jsonb;
  n jsonb;
BEGIN
  SELECT "tenantId" INTO c_tenant FROM "AuthorityCase" WHERE "id" = NEW."caseId";
  IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Antwort und Behördenvorgang gehören zu verschiedenen Mandanten';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() THEN
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."caseId" <> OLD."caseId" OR NEW."version" <> OLD."version" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Zuordnung einer Antwortfassung ist fest';
    END IF;
    IF OLD."status" <> 'DRAFT' THEN
      o := to_jsonb(OLD) - 'status' - 'submittedAt' - 'submittedById' - 'submittedByName' - 'submissionReference' - 'emailLogId' - 'pdfDocumentId' - 'failureReason';
      n := to_jsonb(NEW) - 'status' - 'submittedAt' - 'submittedById' - 'submittedByName' - 'submissionReference' - 'emailLogId' - 'pdfDocumentId' - 'failureReason';
      IF o <> n THEN
        RAISE EXCEPTION 'RB_IMMUTABLE: Die freigegebene Antwortfassung % ist unveränderlich; Korrekturen erzeugen eine neue Fassung', OLD."version";
      END IF;
      IF OLD."status" = 'SUBMITTED' AND (NEW."status" <> 'SUBMITTED' OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" OR NEW."submissionReference" IS DISTINCT FROM OLD."submissionReference") THEN
        RAISE EXCEPTION 'RB_IMMUTABLE: Eine übermittelte Antwortfassung wird nicht verändert';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_authority_response_check BEFORE INSERT OR UPDATE ON "AuthorityResponse" FOR EACH ROW EXECUTE FUNCTION rb_check_authority_response();
CREATE OR REPLACE FUNCTION rb_guard_authority_response_delete() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() OR OLD."status" = 'DRAFT' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Freigegebene oder übermittelte Antwortfassungen werden nicht gelöscht';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_authority_response_guard BEFORE DELETE ON "AuthorityResponse" FOR EACH ROW EXECUTE FUNCTION rb_guard_authority_response_delete();
