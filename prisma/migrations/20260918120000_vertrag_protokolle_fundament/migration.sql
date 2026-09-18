-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "actualPickupAt" TIMESTAMP(3),
ADD COLUMN     "actualReturnAt" TIMESTAMP(3),
ADD COLUMN     "monthlyRate" DECIMAL(65,30),
ADD COLUMN     "weeklyRate" DECIMAL(65,30),
ADD COLUMN     "workWeekRate" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "tankCapacityLiters" INTEGER;

-- AlterTable
ALTER TABLE "VehicleGroup" ADD COLUMN     "bodyType" TEXT NOT NULL DEFAULT 'PKW',
ADD COLUMN     "sketchId" TEXT;

-- CreateTable
CREATE TABLE "VehicleSketch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bodyType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "assetPath" TEXT NOT NULL,
    "assetHash" TEXT NOT NULL,
    "views" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleSketch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalContract" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "customerId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "customerSnapshot" JSONB NOT NULL,
    "vehicleSnapshot" JSONB NOT NULL,
    "priceSnapshot" JSONB NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "discountPercent" INTEGER NOT NULL DEFAULT 0,
    "deposit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "kmIncludedPerDay" INTEGER NOT NULL DEFAULT 0,
    "extraKmRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "deductible" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "fuelPolicy" TEXT NOT NULL DEFAULT 'SAME_LEVEL',
    "fuelPricePerLiter" DECIMAL(65,30),
    "conditions" JSONB,
    "termsVersion" TEXT,
    "termsHash" TEXT,
    "contentHash" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "signedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "RentalContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractDriver" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "customerId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'ADDITIONAL',
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "birthDate" TIMESTAMP(3) NOT NULL,
    "street" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'DE',
    "licenseNumber" TEXT NOT NULL,
    "licenseClass" TEXT NOT NULL,
    "licenseIssuedAt" TIMESTAMP(3) NOT NULL,
    "licenseValidUntil" TIMESTAMP(3),
    "licenseCountry" TEXT NOT NULL DEFAULT 'DE',
    "licenseIssuedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractDriver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handover" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "contractId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "number" TEXT NOT NULL,
    "employeeId" TEXT,
    "employeeName" TEXT NOT NULL,
    "mileage" INTEGER,
    "fuelLevelEighths" INTEGER,
    "batteryPercent" INTEGER,
    "driveType" TEXT NOT NULL,
    "accessories" JSONB,
    "notes" TEXT,
    "sketchId" TEXT,
    "sketchVersion" INTEGER,
    "sketchAssetHash" TEXT,
    "correctsId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Handover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Damage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "view" TEXT NOT NULL,
    "posX" DOUBLE PRECISION NOT NULL,
    "posY" DOUBLE PRECISION NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "size" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'MINOR',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discoveredInHandoverId" TEXT,
    "bookingId" TEXT,
    "reportedById" TEXT,
    "repairedAt" TIMESTAMP(3),
    "repairNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Damage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoverDamage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "damageId" TEXT,
    "marker" TEXT NOT NULL,
    "view" TEXT NOT NULL,
    "posX" DOUBLE PRECISION NOT NULL,
    "posY" DOUBLE PRECISION NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "size" TEXT,
    "severity" TEXT NOT NULL,
    "photoRefs" JSONB NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandoverDamage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "groupId" TEXT,
    "handoverType" TEXT NOT NULL DEFAULT 'BOTH',
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoverChecklistItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "itemKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "answerType" TEXT NOT NULL DEFAULT 'OK_NOT_OK',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "result" TEXT,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HandoverChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "handoverId" TEXT,
    "damageId" TEXT,
    "handoverDamageId" TEXT,
    "storageKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "takenAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signature" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "handoverId" TEXT,
    "contractId" TEXT,
    "role" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdById" TEXT,

    CONSTRAINT "Signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "contractId" TEXT,
    "handoverId" TEXT,
    "type" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/pdf',
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtraCharge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "handoverId" TEXT,
    "damageId" TEXT,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "formula" TEXT NOT NULL,
    "calculation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "ExtraCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mileage" INTEGER,
    "bookingId" TEXT,
    "damageId" TEXT,
    "handoverId" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehicleSketch_tenantId_bodyType_active_idx" ON "VehicleSketch"("tenantId", "bodyType", "active");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleSketch_tenantId_code_version_key" ON "VehicleSketch"("tenantId", "code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "RentalContract_bookingId_key" ON "RentalContract"("bookingId");

-- CreateIndex
CREATE INDEX "RentalContract_tenantId_status_idx" ON "RentalContract"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RentalContract_tenantId_number_key" ON "RentalContract"("tenantId", "number");

-- CreateIndex
CREATE INDEX "ContractDriver_tenantId_contractId_idx" ON "ContractDriver"("tenantId", "contractId");

-- CreateIndex
CREATE INDEX "Handover_tenantId_bookingId_type_idx" ON "Handover"("tenantId", "bookingId", "type");

-- CreateIndex
CREATE INDEX "Handover_tenantId_vehicleId_finalizedAt_idx" ON "Handover"("tenantId", "vehicleId", "finalizedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Handover_tenantId_number_key" ON "Handover"("tenantId", "number");

-- CreateIndex
CREATE INDEX "Damage_tenantId_vehicleId_status_idx" ON "Damage"("tenantId", "vehicleId", "status");

-- CreateIndex
CREATE INDEX "HandoverDamage_tenantId_handoverId_idx" ON "HandoverDamage"("tenantId", "handoverId");

-- CreateIndex
CREATE INDEX "ChecklistTemplate_tenantId_active_idx" ON "ChecklistTemplate"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistTemplate_tenantId_name_version_key" ON "ChecklistTemplate"("tenantId", "name", "version");

-- CreateIndex
CREATE INDEX "HandoverChecklistItem_tenantId_handoverId_idx" ON "HandoverChecklistItem"("tenantId", "handoverId");

-- CreateIndex
CREATE UNIQUE INDEX "Photo_storageKey_key" ON "Photo"("storageKey");

-- CreateIndex
CREATE INDEX "Photo_tenantId_handoverId_idx" ON "Photo"("tenantId", "handoverId");

-- CreateIndex
CREATE INDEX "Photo_tenantId_damageId_idx" ON "Photo"("tenantId", "damageId");

-- CreateIndex
CREATE UNIQUE INDEX "Signature_storageKey_key" ON "Signature"("storageKey");

-- CreateIndex
CREATE INDEX "Signature_tenantId_handoverId_idx" ON "Signature"("tenantId", "handoverId");

-- CreateIndex
CREATE INDEX "Signature_tenantId_contractId_idx" ON "Signature"("tenantId", "contractId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");

-- CreateIndex
CREATE INDEX "Document_tenantId_bookingId_type_idx" ON "Document"("tenantId", "bookingId", "type");

-- CreateIndex
CREATE INDEX "ExtraCharge_tenantId_bookingId_idx" ON "ExtraCharge"("tenantId", "bookingId");

-- CreateIndex
CREATE INDEX "EmailLog_tenantId_status_idx" ON "EmailLog"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailLog_tenantId_idempotencyKey_key" ON "EmailLog"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "VehicleEvent_tenantId_vehicleId_occurredAt_idx" ON "VehicleEvent"("tenantId", "vehicleId", "occurredAt");

-- AddForeignKey
ALTER TABLE "VehicleGroup" ADD CONSTRAINT "VehicleGroup_sketchId_fkey" FOREIGN KEY ("sketchId") REFERENCES "VehicleSketch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleSketch" ADD CONSTRAINT "VehicleSketch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalContract" ADD CONSTRAINT "RentalContract_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalContract" ADD CONSTRAINT "RentalContract_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalContract" ADD CONSTRAINT "RentalContract_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalContract" ADD CONSTRAINT "RentalContract_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDriver" ADD CONSTRAINT "ContractDriver_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDriver" ADD CONSTRAINT "ContractDriver_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDriver" ADD CONSTRAINT "ContractDriver_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_sketchId_fkey" FOREIGN KEY ("sketchId") REFERENCES "VehicleSketch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_correctsId_fkey" FOREIGN KEY ("correctsId") REFERENCES "Handover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_discoveredInHandoverId_fkey" FOREIGN KEY ("discoveredInHandoverId") REFERENCES "Handover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoverDamage" ADD CONSTRAINT "HandoverDamage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoverDamage" ADD CONSTRAINT "HandoverDamage_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoverDamage" ADD CONSTRAINT "HandoverDamage_damageId_fkey" FOREIGN KEY ("damageId") REFERENCES "Damage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistTemplate" ADD CONSTRAINT "ChecklistTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistTemplate" ADD CONSTRAINT "ChecklistTemplate_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VehicleGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoverChecklistItem" ADD CONSTRAINT "HandoverChecklistItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoverChecklistItem" ADD CONSTRAINT "HandoverChecklistItem_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoverChecklistItem" ADD CONSTRAINT "HandoverChecklistItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_damageId_fkey" FOREIGN KEY ("damageId") REFERENCES "Damage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_handoverDamageId_fkey" FOREIGN KEY ("handoverDamageId") REFERENCES "HandoverDamage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraCharge" ADD CONSTRAINT "ExtraCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraCharge" ADD CONSTRAINT "ExtraCharge_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraCharge" ADD CONSTRAINT "ExtraCharge_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraCharge" ADD CONSTRAINT "ExtraCharge_damageId_fkey" FOREIGN KEY ("damageId") REFERENCES "Damage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleEvent" ADD CONSTRAINT "VehicleEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleEvent" ADD CONSTRAINT "VehicleEvent_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleEvent" ADD CONSTRAINT "VehicleEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleEvent" ADD CONSTRAINT "VehicleEvent_damageId_fkey" FOREIGN KEY ("damageId") REFERENCES "Damage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleEvent" ADD CONSTRAINT "VehicleEvent_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "Handover"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- Rent-Base Integritätsschutz (von Hand ergänzt, nicht von Prisma erzeugt)
-- Zweite Verteidigungslinie neben den Prüfungen im Anwendungscode:
-- finalisierte Verträge, Protokolle und deren Bestandteile lassen sich auch per direktem
-- Datenbankzugriff nicht still ändern. Fehlertexte beginnen mit RB_IMMUTABLE.
-- Endgültiges Löschen (z. B. Mandant kündigt, DSGVO) ist nur möglich, wenn die Transaktion
-- vorher ausdrücklich  SET LOCAL rentbase.allow_purge = 'on'  setzt.
-- ============================================================================

CREATE OR REPLACE FUNCTION rb_purge_allowed() RETURNS boolean AS $$
  SELECT coalesce(current_setting('rentbase.allow_purge', true), '') = 'on';
$$ LANGUAGE sql STABLE;

-- Wertebereiche: Positionen normalisiert, Füllstände plausibel
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_pos_range" CHECK ("posX" >= 0 AND "posX" <= 1 AND "posY" >= 0 AND "posY" <= 1);
ALTER TABLE "HandoverDamage" ADD CONSTRAINT "HandoverDamage_pos_range" CHECK ("posX" >= 0 AND "posX" <= 1 AND "posY" >= 0 AND "posY" <= 1);
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_levels_range" CHECK (
  ("fuelLevelEighths" IS NULL OR ("fuelLevelEighths" >= 0 AND "fuelLevelEighths" <= 8)) AND
  ("batteryPercent" IS NULL OR ("batteryPercent" >= 0 AND "batteryPercent" <= 100)) AND
  ("mileage" IS NULL OR "mileage" >= 0)
);
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_has_parent" CHECK (("handoverId" IS NOT NULL) <> ("contractId" IS NOT NULL) OR rb_purge_allowed());

-- Protokoll: nach FINALIZED keine Änderung, kein Löschen
CREATE OR REPLACE FUNCTION rb_guard_handover() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'FINALIZED' AND NOT rb_purge_allowed() THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: finalisiertes Protokoll % kann nicht gelöscht werden', OLD."number";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'FINALIZED' AND NOT rb_purge_allowed() THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: finalisiertes Protokoll % kann nicht geändert werden', OLD."number";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_handover_guard BEFORE UPDATE OR DELETE ON "Handover" FOR EACH ROW EXECUTE FUNCTION rb_guard_handover();

-- Bestandteile eines Protokolls: solange das Protokoll Entwurf ist frei, danach gesperrt
CREATE OR REPLACE FUNCTION rb_guard_handover_child() RETURNS trigger AS $$
DECLARE
  hid text;
  st text;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN hid := NEW."handoverId"; ELSE hid := OLD."handoverId"; END IF;
  IF hid IS NOT NULL THEN
    SELECT "status" INTO st FROM "Handover" WHERE "id" = hid;
    IF st = 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: % gehört zu einem finalisierten Protokoll und ist gesperrt', TG_TABLE_NAME;
    END IF;
  END IF;
  -- Umhängen an ein anderes, bereits finalisiertes Protokoll ebenfalls verhindern
  IF TG_OP = 'UPDATE' AND NEW."handoverId" IS DISTINCT FROM OLD."handoverId" AND NEW."handoverId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "Handover" WHERE "id" = NEW."handoverId";
    IF st = 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Ziel-Protokoll ist finalisiert';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_handover_damage_guard BEFORE INSERT OR UPDATE OR DELETE ON "HandoverDamage" FOR EACH ROW EXECUTE FUNCTION rb_guard_handover_child();
CREATE TRIGGER rb_handover_checklist_guard BEFORE INSERT OR UPDATE OR DELETE ON "HandoverChecklistItem" FOR EACH ROW EXECUTE FUNCTION rb_guard_handover_child();
CREATE TRIGGER rb_photo_guard BEFORE INSERT OR UPDATE OR DELETE ON "Photo" FOR EACH ROW EXECUTE FUNCTION rb_guard_handover_child();
CREATE TRIGGER rb_extra_charge_guard BEFORE INSERT OR UPDATE OR DELETE ON "ExtraCharge" FOR EACH ROW EXECUTE FUNCTION rb_guard_handover_child();

-- Vertrag: nach SIGNED nur noch der Wechsel auf CANCELLED erlaubt, sonst nichts
CREATE OR REPLACE FUNCTION rb_guard_contract() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Vertrag % ist unterschrieben und kann nicht gelöscht werden', OLD."number";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: stornierter Vertrag % kann nicht geändert werden', OLD."number";
  END IF;
  IF OLD."status" = 'SIGNED' THEN
    IF NEW."status" = 'CANCELLED'
       AND (to_jsonb(NEW) - 'status' - 'updatedAt' - 'cancelledAt') = (to_jsonb(OLD) - 'status' - 'updatedAt' - 'cancelledAt') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'RB_IMMUTABLE: unterschriebener Vertrag % kann nicht geändert werden', OLD."number";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_contract_guard BEFORE UPDATE OR DELETE ON "RentalContract" FOR EACH ROW EXECUTE FUNCTION rb_guard_contract();

-- Fahrer am Vertrag: gesperrt, sobald der Vertrag nicht mehr Entwurf ist
CREATE OR REPLACE FUNCTION rb_guard_contract_child() RETURNS trigger AS $$
DECLARE
  cid text;
  st text;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN cid := NEW."contractId"; ELSE cid := OLD."contractId"; END IF;
  SELECT "status" INTO st FROM "RentalContract" WHERE "id" = cid;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Fahrerdaten eines unterschriebenen Vertrags sind gesperrt';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_contract_driver_guard BEFORE INSERT OR UPDATE OR DELETE ON "ContractDriver" FOR EACH ROW EXECUTE FUNCTION rb_guard_contract_child();

-- Unterschrift: nur solange das Elternobjekt Entwurf ist anlegbar, danach nie änderbar
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
    RETURN NEW;
  END IF;
  -- DELETE: nur solange das Elternobjekt noch Entwurf ist
  IF OLD."handoverId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "Handover" WHERE "id" = OLD."handoverId";
    IF st = 'FINALIZED' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines finalisierten Protokolls'; END IF;
  END IF;
  IF OLD."contractId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "RentalContract" WHERE "id" = OLD."contractId";
    IF st <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines unterschriebenen Vertrags'; END IF;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON "Signature" FOR EACH ROW EXECUTE FUNCTION rb_guard_signature();

-- Nur-Anfügen-Tabellen: Dokumente, Fahrzeughistorie, Skizzen. Schadenakte: nie löschen.
CREATE OR REPLACE FUNCTION rb_guard_append_only() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: % ist unveränderlich (%)', TG_TABLE_NAME, TG_OP;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_document_guard BEFORE UPDATE OR DELETE ON "Document" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();
CREATE TRIGGER rb_vehicle_event_guard BEFORE UPDATE OR DELETE ON "VehicleEvent" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();
CREATE TRIGGER rb_damage_delete_guard BEFORE DELETE ON "Damage" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();

-- Skizzen: Inhalt einer Version ist fest, nur "active" darf umgeschaltet werden
CREATE OR REPLACE FUNCTION rb_guard_sketch() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Skizzenversionen werden nicht gelöscht, nur deaktiviert';
  END IF;
  IF (to_jsonb(NEW) - 'active') <> (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Skizzenversion % v% ist fest; bitte eine neue Version anlegen', OLD."code", OLD."version";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_sketch_guard BEFORE UPDATE OR DELETE ON "VehicleSketch" FOR EACH ROW EXECUTE FUNCTION rb_guard_sketch();

-- Systemskizzen (Fallback). tenantId NULL = für alle Mandanten sichtbar.
INSERT INTO "VehicleSketch" ("id", "tenantId", "code", "name", "bodyType", "version", "assetPath", "assetHash", "views", "active")
VALUES
  ('sys_sketch_pkw_v1', NULL, 'GENERIC_PKW', 'Allgemeiner PKW', 'PKW', 1, '/sketches/generic-pkw-v1.svg', 'd4e79513469a9e111185075ff3f7825ff7d5beba0a8389f461e45a5229c1e6de',
   '[{"key":"LEFT","label":"Fahrerseite","box":[10,20,490,230]},{"key":"RIGHT","label":"Beifahrerseite","box":[510,20,490,230]},{"key":"FRONT","label":"Front","box":[40,280,320,270]},{"key":"REAR","label":"Heck","box":[380,280,320,270]},{"key":"TOP","label":"Dach","box":[720,280,260,270]}]'::jsonb, true),
  ('sys_sketch_transporter_v1', NULL, 'GENERIC_TRANSPORTER', 'Allgemeiner Transporter', 'TRANSPORTER', 1, '/sketches/generic-transporter-v1.svg', '124179ad1a90e18d8389cbace24eeb13428e57e6742fd66de94cd4569608a93f',
   '[{"key":"LEFT","label":"Fahrerseite","box":[10,20,490,230]},{"key":"RIGHT","label":"Beifahrerseite","box":[510,20,490,230]},{"key":"FRONT","label":"Front","box":[40,280,320,270]},{"key":"REAR","label":"Heck","box":[380,280,320,270]},{"key":"TOP","label":"Dach","box":[720,280,260,270]}]'::jsonb, true);

-- Bestehende Gruppen: Transporter-Gruppen erkennen, damit der richtige Fallback greift
UPDATE "VehicleGroup" SET "bodyType" = 'TRANSPORTER'
WHERE lower("name") LIKE '%transporter%' OR lower("name") LIKE '%sprinter%' OR lower("name") LIKE '%kasten%' OR lower("name") LIKE '%lkw%';
