-- Phase 13: Flotten-, Wartungs- und Fahrzeugaktenmanagement (additiv: fünf neue Tabellen, keine Änderung bestehender Daten)

-- CreateTable
CREATE TABLE "MaintenancePlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "intervalMonths" INTEGER,
    "intervalKilometers" INTEGER,
    "nextDueDate" TIMESTAMP(3),
    "nextDueMileage" INTEGER,
    "warningDaysBefore" INTEGER NOT NULL DEFAULT 30,
    "warningKilometersBefore" INTEGER NOT NULL DEFAULT 1000,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastMaintenanceId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "planId" TEXT,
    "damageCaseId" TEXT,
    "maintenanceNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "workshopName" TEXT,
    "workshopContact" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "scheduledEndAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "mileageAtService" INTEGER,
    "estimatedCostCents" INTEGER,
    "actualCostCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "workDone" TEXT,
    "nextDueDate" TIMESTAMP(3),
    "nextDueMileage" INTEGER,
    "internalNote" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "completedById" TEXT,
    "completedByName" TEXT,

    CONSTRAINT "MaintenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "maintenanceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "maintenanceId" TEXT,
    "type" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "documentDate" TIMESTAMP(3),
    "description" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archivedByName" TEXT,
    "archiveReason" TEXT,

    CONSTRAINT "VehicleDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceDocumentLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "maintenanceId" TEXT NOT NULL,
    "damageCaseDocumentId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceDocumentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaintenancePlan_tenantId_vehicleId_idx" ON "MaintenancePlan"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "MaintenancePlan_tenantId_isActive_idx" ON "MaintenancePlan"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_tenantId_vehicleId_idx" ON "MaintenanceRecord"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_tenantId_status_idx" ON "MaintenanceRecord"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_tenantId_scheduledAt_idx" ON "MaintenanceRecord"("tenantId", "scheduledAt");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_tenantId_damageCaseId_idx" ON "MaintenanceRecord"("tenantId", "damageCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRecord_tenantId_maintenanceNumber_key" ON "MaintenanceRecord"("tenantId", "maintenanceNumber");

-- CreateIndex
CREATE INDEX "MaintenanceEvent_tenantId_maintenanceId_createdAt_idx" ON "MaintenanceEvent"("tenantId", "maintenanceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleDocument_storageKey_key" ON "VehicleDocument"("storageKey");

-- CreateIndex
CREATE INDEX "VehicleDocument_tenantId_vehicleId_idx" ON "VehicleDocument"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "VehicleDocument_tenantId_maintenanceId_idx" ON "VehicleDocument"("tenantId", "maintenanceId");

-- CreateIndex
CREATE INDEX "MaintenanceDocumentLink_tenantId_maintenanceId_idx" ON "MaintenanceDocumentLink"("tenantId", "maintenanceId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceDocumentLink_maintenanceId_damageCaseDocumentId_key" ON "MaintenanceDocumentLink"("maintenanceId", "damageCaseDocumentId");

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_lastMaintenanceId_fkey" FOREIGN KEY ("lastMaintenanceId") REFERENCES "MaintenanceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MaintenancePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_damageCaseId_fkey" FOREIGN KEY ("damageCaseId") REFERENCES "DamageCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceEvent" ADD CONSTRAINT "MaintenanceEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceEvent" ADD CONSTRAINT "MaintenanceEvent_maintenanceId_fkey" FOREIGN KEY ("maintenanceId") REFERENCES "MaintenanceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleDocument" ADD CONSTRAINT "VehicleDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleDocument" ADD CONSTRAINT "VehicleDocument_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleDocument" ADD CONSTRAINT "VehicleDocument_maintenanceId_fkey" FOREIGN KEY ("maintenanceId") REFERENCES "MaintenanceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceDocumentLink" ADD CONSTRAINT "MaintenanceDocumentLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceDocumentLink" ADD CONSTRAINT "MaintenanceDocumentLink_maintenanceId_fkey" FOREIGN KEY ("maintenanceId") REFERENCES "MaintenanceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceDocumentLink" ADD CONSTRAINT "MaintenanceDocumentLink_damageCaseDocumentId_fkey" FOREIGN KEY ("damageCaseDocumentId") REFERENCES "DamageCaseDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Integrität Phase 13: Wartungspläne, Wartungsvorgänge, Fahrzeugdokumente, Dokumentverknüpfungen
-- ============================================================================

ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "rb_maintenance_plan_type" CHECK ("type" IN ('INSPECTION', 'OIL_SERVICE', 'HU_AU', 'TIRES', 'BRAKES', 'REPAIR', 'DAMAGE_REPAIR', 'AIR_CONDITIONING', 'OTHER'));
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "rb_maintenance_plan_intervals" CHECK (("intervalMonths" IS NULL OR "intervalMonths" > 0) AND ("intervalKilometers" IS NULL OR "intervalKilometers" > 0) AND ("nextDueMileage" IS NULL OR "nextDueMileage" >= 0) AND "warningDaysBefore" >= 0 AND "warningKilometersBefore" >= 0);

ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "rb_maintenance_type" CHECK ("type" IN ('INSPECTION', 'OIL_SERVICE', 'HU_AU', 'TIRES', 'BRAKES', 'REPAIR', 'DAMAGE_REPAIR', 'AIR_CONDITIONING', 'OTHER'));
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "rb_maintenance_status" CHECK ("status" IN ('PLANNED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'));
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "rb_maintenance_priority" CHECK ("priority" IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL'));
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "rb_maintenance_amounts" CHECK (("estimatedCostCents" IS NULL OR "estimatedCostCents" >= 0) AND ("actualCostCents" IS NULL OR "actualCostCents" >= 0) AND ("mileageAtService" IS NULL OR "mileageAtService" >= 0) AND ("nextDueMileage" IS NULL OR "nextDueMileage" >= 0) AND "currency" = 'EUR');
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "rb_maintenance_completed" CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL));
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "rb_maintenance_cancelled" CHECK ("status" <> 'CANCELLED' OR ("cancelReason" IS NOT NULL AND length(trim("cancelReason")) >= 3));
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "rb_maintenance_schedule" CHECK ("scheduledEndAt" IS NULL OR "scheduledAt" IS NULL OR "scheduledEndAt" >= "scheduledAt");

ALTER TABLE "MaintenanceEvent" ADD CONSTRAINT "rb_maintenance_event_type" CHECK ("type" IN ('CREATED', 'UPDATED', 'SCHEDULED', 'STARTED', 'COMPLETED', 'CANCELLED', 'COST_CHANGED', 'DOCUMENT_ADDED', 'DOCUMENT_LINKED', 'DOCUMENT_ARCHIVED', 'DAMAGE_LINKED', 'NOTE_ADDED', 'VEHICLE_BLOCKED', 'VEHICLE_RELEASED', 'MILEAGE'));

ALTER TABLE "VehicleDocument" ADD CONSTRAINT "rb_vehicle_document_type" CHECK ("type" IN ('REGISTRATION', 'INSURANCE', 'HU_REPORT', 'INSPECTION_REPORT', 'WORKSHOP_INVOICE', 'ESTIMATE', 'REPAIR_REPORT', 'TIRE_DOCUMENT', 'OTHER'));
ALTER TABLE "VehicleDocument" ADD CONSTRAINT "rb_vehicle_document_archive" CHECK (("archivedAt" IS NULL) = ("archiveReason" IS NULL) AND ("archiveReason" IS NULL OR length(trim("archiveReason")) >= 3));

-- Wartungsplan: Fahrzeug und letzter Vorgang gehören zum Mandanten und zum Fahrzeug; Zuordnung fest
CREATE OR REPLACE FUNCTION rb_check_maintenance_plan() RETURNS trigger AS $$
DECLARE
  v_tenant text;
  m_tenant text;
  m_vehicle text;
BEGIN
  SELECT "tenantId" INTO v_tenant FROM "Vehicle" WHERE "id" = NEW."vehicleId";
  IF v_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Wartungsplan und Fahrzeug gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."lastMaintenanceId" IS NOT NULL THEN
    SELECT "tenantId", "vehicleId" INTO m_tenant, m_vehicle FROM "MaintenanceRecord" WHERE "id" = NEW."lastMaintenanceId";
    IF m_tenant IS DISTINCT FROM NEW."tenantId" OR m_vehicle IS DISTINCT FROM NEW."vehicleId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Der letzte Wartungsvorgang gehört nicht zu diesem Fahrzeug';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() AND (NEW."tenantId" <> OLD."tenantId" OR NEW."vehicleId" <> OLD."vehicleId") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Die Zuordnung eines Wartungsplans ist fest';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_maintenance_plan_check BEFORE INSERT OR UPDATE ON "MaintenancePlan" FOR EACH ROW EXECUTE FUNCTION rb_check_maintenance_plan();

-- Wartungsvorgang: Mandant von Fahrzeug, Plan und Schadenakte; Schadenakte am selben Fahrzeug; abgeschlossene/abgebrochene
-- Vorgänge behalten ihre Kerndaten; nie löschen
CREATE OR REPLACE FUNCTION rb_check_maintenance_record() RETURNS trigger AS $$
DECLARE
  v_tenant text;
  p_tenant text;
  p_vehicle text;
  d_tenant text;
  d_vehicle text;
  o jsonb;
  n jsonb;
BEGIN
  SELECT "tenantId" INTO v_tenant FROM "Vehicle" WHERE "id" = NEW."vehicleId";
  IF v_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Wartungsvorgang und Fahrzeug gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."planId" IS NOT NULL THEN
    SELECT "tenantId", "vehicleId" INTO p_tenant, p_vehicle FROM "MaintenancePlan" WHERE "id" = NEW."planId";
    IF p_tenant IS DISTINCT FROM NEW."tenantId" OR p_vehicle IS DISTINCT FROM NEW."vehicleId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Der Wartungsplan gehört nicht zu diesem Fahrzeug';
    END IF;
  END IF;
  IF NEW."damageCaseId" IS NOT NULL THEN
    SELECT "tenantId", "vehicleId" INTO d_tenant, d_vehicle FROM "DamageCase" WHERE "id" = NEW."damageCaseId";
    IF d_tenant IS DISTINCT FROM NEW."tenantId" OR d_vehicle IS DISTINCT FROM NEW."vehicleId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Schadenakte gehört nicht zu diesem Fahrzeug';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() THEN
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."vehicleId" <> OLD."vehicleId" OR NEW."maintenanceNumber" <> OLD."maintenanceNumber" OR NEW."createdAt" <> OLD."createdAt" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Nummer und Zuordnung eines Wartungsvorgangs sind fest';
    END IF;
    IF OLD."status" IN ('COMPLETED', 'CANCELLED') THEN
      -- Nachträglich nur Notizen und Verknüpfungen: Abschlussdaten, Kosten, Kilometer und Status bleiben
      o := to_jsonb(OLD) - 'internalNote' - 'updatedAt' - 'damageCaseId' - 'description';
      n := to_jsonb(NEW) - 'internalNote' - 'updatedAt' - 'damageCaseId' - 'description';
      IF o <> n THEN
        RAISE EXCEPTION 'RB_IMMUTABLE: Der Wartungsvorgang % ist abgeschlossen; Abschlussdaten, Kosten und Status sind fest', OLD."maintenanceNumber";
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_maintenance_record_check BEFORE INSERT OR UPDATE ON "MaintenanceRecord" FOR EACH ROW EXECUTE FUNCTION rb_check_maintenance_record();

CREATE OR REPLACE FUNCTION rb_guard_maintenance_delete() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Wartungsvorgänge werden nicht gelöscht, nur abgebrochen';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_maintenance_record_guard BEFORE DELETE ON "MaintenanceRecord" FOR EACH ROW EXECUTE FUNCTION rb_guard_maintenance_delete();

-- Historie: Mandant passt, nur anfügen
CREATE OR REPLACE FUNCTION rb_check_maintenance_ref() RETURNS trigger AS $$
DECLARE
  m_tenant text;
BEGIN
  SELECT "tenantId" INTO m_tenant FROM "MaintenanceRecord" WHERE "id" = NEW."maintenanceId";
  IF m_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Eintrag und Wartungsvorgang gehören zu verschiedenen Mandanten';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_maintenance_event_check BEFORE INSERT ON "MaintenanceEvent" FOR EACH ROW EXECUTE FUNCTION rb_check_maintenance_ref();
CREATE TRIGGER rb_maintenance_event_guard BEFORE UPDATE OR DELETE ON "MaintenanceEvent" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();

-- Fahrzeugdokument: Mandant von Fahrzeug und Vorgang, Vorgang am selben Fahrzeug; nie löschen; nur Archivfelder änderbar
CREATE OR REPLACE FUNCTION rb_check_vehicle_document() RETURNS trigger AS $$
DECLARE
  v_tenant text;
  m_tenant text;
  m_vehicle text;
  o jsonb;
  n jsonb;
BEGIN
  SELECT "tenantId" INTO v_tenant FROM "Vehicle" WHERE "id" = NEW."vehicleId";
  IF v_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Dokument und Fahrzeug gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."maintenanceId" IS NOT NULL THEN
    SELECT "tenantId", "vehicleId" INTO m_tenant, m_vehicle FROM "MaintenanceRecord" WHERE "id" = NEW."maintenanceId";
    IF m_tenant IS DISTINCT FROM NEW."tenantId" OR m_vehicle IS DISTINCT FROM NEW."vehicleId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Der Wartungsvorgang gehört nicht zu diesem Fahrzeug';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() THEN
    o := to_jsonb(OLD) - 'archivedAt' - 'archivedById' - 'archivedByName' - 'archiveReason' - 'description' - 'documentDate' - 'type';
    n := to_jsonb(NEW) - 'archivedAt' - 'archivedById' - 'archivedByName' - 'archiveReason' - 'description' - 'documentDate' - 'type';
    IF o <> n THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Datei, Prüfsumme und Zuordnung eines Fahrzeugdokuments sind fest';
    END IF;
    IF OLD."archivedAt" IS NOT NULL AND NEW."archivedAt" IS NULL THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine Archivierung wird nicht zurückgenommen';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_vehicle_document_check BEFORE INSERT OR UPDATE ON "VehicleDocument" FOR EACH ROW EXECUTE FUNCTION rb_check_vehicle_document();

CREATE OR REPLACE FUNCTION rb_guard_vehicle_document_delete() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Fahrzeugdokumente werden nicht gelöscht, nur archiviert';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_vehicle_document_guard BEFORE DELETE ON "VehicleDocument" FOR EACH ROW EXECUTE FUNCTION rb_guard_vehicle_document_delete();

-- Dokumentverknüpfung: Schadendokument und Wartungsvorgang desselben Mandanten und Fahrzeugs
CREATE OR REPLACE FUNCTION rb_check_maintenance_document_link() RETURNS trigger AS $$
DECLARE
  m_tenant text;
  m_vehicle text;
  d_tenant text;
  d_vehicle text;
BEGIN
  SELECT "tenantId", "vehicleId" INTO m_tenant, m_vehicle FROM "MaintenanceRecord" WHERE "id" = NEW."maintenanceId";
  SELECT d."tenantId", c."vehicleId" INTO d_tenant, d_vehicle FROM "DamageCaseDocument" d JOIN "DamageCase" c ON c."id" = d."caseId" WHERE d."id" = NEW."damageCaseDocumentId";
  IF m_tenant IS DISTINCT FROM NEW."tenantId" OR d_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Dokumentverknüpfung über Mandantengrenzen';
  END IF;
  IF m_vehicle IS DISTINCT FROM d_vehicle THEN
    RAISE EXCEPTION 'RB_DOMAIN: Das Schadendokument gehört zu einem anderen Fahrzeug';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_maintenance_document_link_check BEFORE INSERT ON "MaintenanceDocumentLink" FOR EACH ROW EXECUTE FUNCTION rb_check_maintenance_document_link();
CREATE TRIGGER rb_maintenance_document_link_guard BEFORE UPDATE ON "MaintenanceDocumentLink" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();
