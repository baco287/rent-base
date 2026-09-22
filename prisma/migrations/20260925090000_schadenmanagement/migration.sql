-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "damageCaseId" TEXT,
ADD COLUMN     "damageId" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'RENTAL',
ADD COLUMN     "taxTreatment" TEXT;

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "damageCaseId" TEXT;

-- CreateTable
CREATE TABLE "DamageCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "damageId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "bookingId" TEXT,
    "returnHandoverId" TEXT,
    "caseNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "liabilityStatus" TEXT NOT NULL DEFAULT 'UNASSESSED',
    "liabilityNote" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "reportedById" TEXT,
    "reportedByName" TEXT,
    "description" TEXT NOT NULL,
    "internalNote" TEXT,
    "estimatedCostCents" INTEGER,
    "actualCostCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "repairProviderName" TEXT,
    "repairAppointmentAt" TIMESTAMP(3),
    "repairCompletedAt" TIMESTAMP(3),
    "customerChargeCents" INTEGER,
    "customerChargeBasis" TEXT,
    "customerChargeTaxTreatment" TEXT,
    "customerChargeAt" TIMESTAMP(3),
    "customerChargeByName" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedByName" TEXT,
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DamageCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DamageCaseEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "reason" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DamageCaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DamageCaseDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
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

    CONSTRAINT "DamageCaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DamageCase_damageId_key" ON "DamageCase"("damageId");

-- CreateIndex
CREATE INDEX "DamageCase_tenantId_status_idx" ON "DamageCase"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DamageCase_tenantId_liabilityStatus_idx" ON "DamageCase"("tenantId", "liabilityStatus");

-- CreateIndex
CREATE INDEX "DamageCase_tenantId_vehicleId_idx" ON "DamageCase"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "DamageCase_tenantId_bookingId_idx" ON "DamageCase"("tenantId", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "DamageCase_tenantId_caseNumber_key" ON "DamageCase"("tenantId", "caseNumber");

-- CreateIndex
CREATE INDEX "DamageCaseEvent_tenantId_caseId_createdAt_idx" ON "DamageCaseEvent"("tenantId", "caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DamageCaseDocument_storageKey_key" ON "DamageCaseDocument"("storageKey");

-- CreateIndex
CREATE INDEX "DamageCaseDocument_tenantId_caseId_idx" ON "DamageCaseDocument"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_kind_idx" ON "Invoice"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "Photo_tenantId_damageCaseId_idx" ON "Photo"("tenantId", "damageCaseId");

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_damageCaseId_fkey" FOREIGN KEY ("damageCaseId") REFERENCES "DamageCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_damageCaseId_fkey" FOREIGN KEY ("damageCaseId") REFERENCES "DamageCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageCase" ADD CONSTRAINT "DamageCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageCase" ADD CONSTRAINT "DamageCase_damageId_fkey" FOREIGN KEY ("damageId") REFERENCES "Damage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageCase" ADD CONSTRAINT "DamageCase_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageCase" ADD CONSTRAINT "DamageCase_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageCase" ADD CONSTRAINT "DamageCase_returnHandoverId_fkey" FOREIGN KEY ("returnHandoverId") REFERENCES "Handover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageCaseEvent" ADD CONSTRAINT "DamageCaseEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageCaseEvent" ADD CONSTRAINT "DamageCaseEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DamageCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageCaseDocument" ADD CONSTRAINT "DamageCaseDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageCaseDocument" ADD CONSTRAINT "DamageCaseDocument_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DamageCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Phase 12: Schadenmanagement. Integrität für Rechnungsarten, Schadenakten, Historie und Dokumente.
-- Rechnungen: höchstens eine abgeschlossene Mietrechnung (RENTAL) je Buchung; je Schadenakte höchstens eine
-- Schadenabrechnung (DAMAGE) im Entwurf oder abgeschlossen. Der alte Index "eine abgeschlossene Rechnung je Buchung"
-- wird durch die neue fachliche Regel ersetzt, nicht einfach entfernt.
-- ============================================================================

ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_kind" CHECK ("kind" IN ('RENTAL', 'DAMAGE'));
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_damage_refs" CHECK (("kind" = 'DAMAGE') = ("damageCaseId" IS NOT NULL));
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_tax_treatment" CHECK ("taxTreatment" IS NULL OR "taxTreatment" IN ('NON_TAXABLE_DAMAGES', 'TAXABLE_SERVICE'));
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_damage_tax" CHECK ("kind" <> 'DAMAGE' OR "taxTreatment" IS NOT NULL);
DROP INDEX IF EXISTS "rb_invoice_one_final_per_booking";
CREATE UNIQUE INDEX "rb_invoice_one_final_rental_per_booking" ON "Invoice" ("tenantId", "bookingId") WHERE "status" = 'FINALIZED' AND "kind" = 'RENTAL';
CREATE UNIQUE INDEX "rb_invoice_one_per_damage_case" ON "Invoice" ("tenantId", "damageCaseId") WHERE "damageCaseId" IS NOT NULL AND "status" IN ('DRAFT', 'FINALIZED');

ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_status" CHECK ("status" IN ('OPEN', 'UNDER_REVIEW', 'REPAIR_PLANNED', 'IN_REPAIR', 'REPAIRED', 'CLOSED'));
ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_priority" CHECK ("priority" IN ('LOW', 'NORMAL', 'HIGH'));
ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_liability" CHECK ("liabilityStatus" IN ('UNASSESSED', 'UNCLEAR', 'CUSTOMER_RESPONSIBILITY_CONFIRMED', 'NOT_CUSTOMER_RESPONSIBILITY', 'THIRD_PARTY', 'INTERNAL'));
ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_liability_note" CHECK ("liabilityStatus" <> 'CUSTOMER_RESPONSIBILITY_CONFIRMED' OR ("liabilityNote" IS NOT NULL AND length(trim("liabilityNote")) >= 3));
ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_costs" CHECK (("estimatedCostCents" IS NULL OR "estimatedCostCents" >= 0) AND ("actualCostCents" IS NULL OR "actualCostCents" >= 0) AND ("customerChargeCents" IS NULL OR "customerChargeCents" > 0));
ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_currency" CHECK ("currency" = 'EUR');
ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_closed" CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL) AND ("closedAt" IS NULL OR ("closeReason" IS NOT NULL AND length(trim("closeReason")) >= 3)));
ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_charge" CHECK (("customerChargeCents" IS NULL) = ("customerChargeBasis" IS NULL) AND ("customerChargeCents" IS NULL) = ("customerChargeTaxTreatment" IS NULL) AND ("customerChargeCents" IS NULL OR "liabilityStatus" = 'CUSTOMER_RESPONSIBILITY_CONFIRMED'));
ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_charge_tax" CHECK ("customerChargeTaxTreatment" IS NULL OR "customerChargeTaxTreatment" IN ('NON_TAXABLE_DAMAGES', 'TAXABLE_SERVICE'));
ALTER TABLE "DamageCaseEvent" ADD CONSTRAINT "rb_damage_case_event_type" CHECK ("type" IN ('CREATED', 'STATUS_CHANGED', 'LIABILITY_CHANGED', 'COST_CHANGED', 'REPAIR_CHANGED', 'PHOTO_ADDED', 'DOCUMENT_ADDED', 'NOTE_ADDED', 'VEHICLE_BLOCKED', 'VEHICLE_RELEASED', 'CUSTOMER_CHARGE_CREATED', 'INVOICE_CREATED', 'CLOSED', 'REOPENED'));
ALTER TABLE "DamageCaseDocument" ADD CONSTRAINT "rb_damage_case_document_type" CHECK ("type" IN ('ESTIMATE', 'REPAIR_INVOICE', 'OTHER'));

-- Schadenakte: Mandant von Schaden, Fahrzeug, Buchung, Rückgabe muss passen; Schaden gehört zum Fahrzeug; Zuordnung fest
CREATE OR REPLACE FUNCTION rb_check_damage_case() RETURNS trigger AS $$
DECLARE
  d_tenant text;
  d_vehicle text;
  v_tenant text;
  b_tenant text;
  h_tenant text;
  h_booking text;
BEGIN
  SELECT "tenantId", "vehicleId" INTO d_tenant, d_vehicle FROM "Damage" WHERE "id" = NEW."damageId";
  IF d_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Schadenakte und Schaden gehören zu verschiedenen Mandanten';
  END IF;
  IF d_vehicle IS DISTINCT FROM NEW."vehicleId" THEN
    RAISE EXCEPTION 'RB_DOMAIN: Der Schaden gehört nicht zu diesem Fahrzeug';
  END IF;
  SELECT "tenantId" INTO v_tenant FROM "Vehicle" WHERE "id" = NEW."vehicleId";
  IF v_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Schadenakte und Fahrzeug gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."bookingId" IS NOT NULL THEN
    SELECT "tenantId" INTO b_tenant FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Schadenakte und Buchung gehören zu verschiedenen Mandanten';
    END IF;
  END IF;
  IF NEW."returnHandoverId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId" INTO h_tenant, h_booking FROM "Handover" WHERE "id" = NEW."returnHandoverId";
    IF h_tenant IS DISTINCT FROM NEW."tenantId" OR h_booking IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_TENANT: Rückgabeprotokoll passt nicht zu Mandant oder Buchung der Schadenakte';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() THEN
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."damageId" <> OLD."damageId" OR NEW."vehicleId" <> OLD."vehicleId" OR NEW."caseNumber" <> OLD."caseNumber" OR NEW."createdAt" <> OLD."createdAt" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Nummer und Zuordnung einer Schadenakte sind fest';
    END IF;
    -- Kundenbelastung ist einmalig: gesetzte Werte werden nicht geändert (Korrektur läuft über die Rechnungsfassungen)
    IF OLD."customerChargeCents" IS NOT NULL AND (NEW."customerChargeCents" IS DISTINCT FROM OLD."customerChargeCents" OR NEW."customerChargeBasis" IS DISTINCT FROM OLD."customerChargeBasis" OR NEW."customerChargeTaxTreatment" IS DISTINCT FROM OLD."customerChargeTaxTreatment" OR NEW."customerChargeAt" IS DISTINCT FROM OLD."customerChargeAt") THEN
      IF NEW."customerChargeCents" IS NOT NULL THEN
        RAISE EXCEPTION 'RB_IMMUTABLE: Die Kundenbelastung ist festgelegt; Änderungen laufen über die Schadenabrechnung';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_damage_case_check BEFORE INSERT OR UPDATE ON "DamageCase" FOR EACH ROW EXECUTE FUNCTION rb_check_damage_case();

CREATE OR REPLACE FUNCTION rb_guard_damage_case_delete() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Schadenakten werden nicht gelöscht, nur geschlossen';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_damage_case_guard BEFORE DELETE ON "DamageCase" FOR EACH ROW EXECUTE FUNCTION rb_guard_damage_case_delete();

-- Historie und Dokumente: Mandant passt zur Akte, nur anfügen
CREATE OR REPLACE FUNCTION rb_check_damage_case_ref() RETURNS trigger AS $$
DECLARE
  c_tenant text;
BEGIN
  SELECT "tenantId" INTO c_tenant FROM "DamageCase" WHERE "id" = NEW."caseId";
  IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Eintrag und Schadenakte gehören zu verschiedenen Mandanten';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_damage_case_event_check BEFORE INSERT ON "DamageCaseEvent" FOR EACH ROW EXECUTE FUNCTION rb_check_damage_case_ref();
CREATE TRIGGER rb_damage_case_event_guard BEFORE UPDATE OR DELETE ON "DamageCaseEvent" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();
CREATE TRIGGER rb_damage_case_document_check BEFORE INSERT ON "DamageCaseDocument" FOR EACH ROW EXECUTE FUNCTION rb_check_damage_case_ref();
CREATE TRIGGER rb_damage_case_document_guard BEFORE UPDATE OR DELETE ON "DamageCaseDocument" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();

-- Fotos zur Akte: Mandant passt
CREATE OR REPLACE FUNCTION rb_check_photo_damage_case() RETURNS trigger AS $$
DECLARE
  c_tenant text;
BEGIN
  IF NEW."damageCaseId" IS NULL THEN RETURN NEW; END IF;
  SELECT "tenantId" INTO c_tenant FROM "DamageCase" WHERE "id" = NEW."damageCaseId";
  IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Foto und Schadenakte gehören zu verschiedenen Mandanten';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_photo_damage_case_check BEFORE INSERT OR UPDATE ON "Photo" FOR EACH ROW EXECUTE FUNCTION rb_check_photo_damage_case();

-- Schadenabrechnung: Schadenakte gehört zum selben Mandanten und zur selben Buchung
CREATE OR REPLACE FUNCTION rb_check_invoice_damage_case() RETURNS trigger AS $$
DECLARE
  c_tenant text;
  c_booking text;
BEGIN
  IF NEW."damageCaseId" IS NULL THEN RETURN NEW; END IF;
  SELECT "tenantId", "bookingId" INTO c_tenant, c_booking FROM "DamageCase" WHERE "id" = NEW."damageCaseId";
  IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Rechnung und Schadenakte gehören zu verschiedenen Mandanten';
  END IF;
  IF c_booking IS DISTINCT FROM NEW."bookingId" THEN
    RAISE EXCEPTION 'RB_DOMAIN: Die Schadenakte gehört zu einer anderen Buchung';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invoice_damage_case_check BEFORE INSERT OR UPDATE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION rb_check_invoice_damage_case();
