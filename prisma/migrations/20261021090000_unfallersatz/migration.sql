-- Befehl 29: Unfallersatz V1. Rein additiv: neue Spalten mit sicherem Default, eine gelockerte Pflichtspalte (Booking.endAt,
-- RentalContract.endAt) mit CHECK, neue Tabellen, erweiterte Wertelisten, Prüf- und Schutzfunktionen. Bestehende Zeilen
-- bleiben unverändert und gültig: jede vorhandene Buchung ist eine Standardmiete (rentalType STANDARD) mit gesetztem Ende.
--
-- Fachlich: Eine Unfallersatzmiete ist eine normale Buchung (rentalType ACCIDENT_REPLACEMENT) mit Vertrag, Übergabe,
-- Rückgabe, Rechnung und Zahlungen – plus genau einer Fallakte (AccidentReplacementCase). Nur solche Buchungen dürfen ein
-- offenes Mietende (endAt NULL) haben; sie belegen das Fahrzeug bis zur tatsächlichen Rückgabe. Versicherungskürzungen
-- (InvoiceAdjustment) sind reine Dokumentation und ändern weder Rechnung noch Forderung noch Zahlungsstand.

-- ---------------------------------------------------------------------------
-- 1) Buchung und Vertrag: Mietart, offenes Mietende nur bei Unfallersatz
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "rentalType" TEXT NOT NULL DEFAULT 'STANDARD',
ALTER COLUMN "endAt" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RentalContract" ALTER COLUMN "endAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AccidentReplacementCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "idempotencyKey" TEXT NOT NULL,
    "damagedPlate" TEXT NOT NULL,
    "damagedMake" TEXT NOT NULL,
    "damagedModel" TEXT NOT NULL,
    "damagedDrivable" BOOLEAN NOT NULL,
    "damagedFirstRegistration" TIMESTAMP(3),
    "damagedVehicleClass" TEXT,
    "damagedLocation" TEXT,
    "damageKind" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "accidentAt" TIMESTAMP(3),
    "accidentPlace" TEXT,
    "opponentPlate" TEXT,
    "opponentName" TEXT,
    "policeFileNumber" TEXT,
    "accidentNote" TEXT,
    "insurerName" TEXT,
    "insurerClaimNumber" TEXT,
    "insurerContactName" TEXT,
    "insurerPhone" TEXT,
    "insurerEmail" TEXT,
    "insurerStreet" TEXT,
    "insurerZip" TEXT,
    "insurerCity" TEXT,
    "liabilityStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "liabilityQuotaPercent" INTEGER,
    "liabilityNote" TEXT,
    "workshopName" TEXT,
    "workshopContactName" TEXT,
    "workshopPhone" TEXT,
    "workshopEmail" TEXT,
    "repairStartAt" TIMESTAMP(3),
    "repairEndAt" TIMESTAMP(3),
    "lawyerFirm" TEXT,
    "lawyerContactName" TEXT,
    "lawyerPhone" TEXT,
    "lawyerEmail" TEXT,
    "internalNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedByName" TEXT,
    "closeReason" TEXT,
    "closeWarnings" JSONB,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccidentReplacementCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccidentReplacementTariffItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "perDay" BOOLEAN NOT NULL DEFAULT false,
    "unitPriceCents" INTEGER NOT NULL,
    "quantityHundredths" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccidentReplacementTariffItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccidentReplacementCaseEvent" (
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

    CONSTRAINT "AccidentReplacementCaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccidentReplacementCaseDocument" (
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
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archivedByName" TEXT,
    "archiveReason" TEXT,

    CONSTRAINT "AccidentReplacementCaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseFollowUp" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assigneeUserId" TEXT,
    "assigneeName" TEXT,
    "note" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "doneByName" TEXT,
    "doneNote" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessPartner" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "street" TEXT,
    "zip" TEXT,
    "city" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceAdjustment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'INSURER_REDUCTION',
    "reasonKind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "documentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledByName" TEXT,
    "cancellationReason" TEXT,

    CONSTRAINT "InvoiceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccidentReplacementCase_bookingId_key" ON "AccidentReplacementCase"("bookingId");

-- CreateIndex
CREATE INDEX "AccidentReplacementCase_tenantId_status_idx" ON "AccidentReplacementCase"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AccidentReplacementCase_tenantId_liabilityStatus_idx" ON "AccidentReplacementCase"("tenantId", "liabilityStatus");

-- CreateIndex
CREATE UNIQUE INDEX "AccidentReplacementCase_tenantId_caseNumber_key" ON "AccidentReplacementCase"("tenantId", "caseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AccidentReplacementCase_tenantId_idempotencyKey_key" ON "AccidentReplacementCase"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AccidentReplacementTariffItem_tenantId_caseId_idx" ON "AccidentReplacementTariffItem"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "AccidentReplacementCaseEvent_tenantId_caseId_createdAt_idx" ON "AccidentReplacementCaseEvent"("tenantId", "caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccidentReplacementCaseDocument_storageKey_key" ON "AccidentReplacementCaseDocument"("storageKey");

-- CreateIndex
CREATE INDEX "AccidentReplacementCaseDocument_tenantId_caseId_idx" ON "AccidentReplacementCaseDocument"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "CaseFollowUp_tenantId_caseId_status_idx" ON "CaseFollowUp"("tenantId", "caseId", "status");

-- CreateIndex
CREATE INDEX "CaseFollowUp_tenantId_status_dueAt_idx" ON "CaseFollowUp"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "BusinessPartner_tenantId_kind_idx" ON "BusinessPartner"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPartner_tenantId_kind_nameKey_key" ON "BusinessPartner"("tenantId", "kind", "nameKey");

-- CreateIndex
CREATE INDEX "InvoiceAdjustment_tenantId_invoiceId_status_idx" ON "InvoiceAdjustment"("tenantId", "invoiceId", "status");

-- AddForeignKey
ALTER TABLE "AccidentReplacementCase" ADD CONSTRAINT "AccidentReplacementCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccidentReplacementCase" ADD CONSTRAINT "AccidentReplacementCase_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccidentReplacementTariffItem" ADD CONSTRAINT "AccidentReplacementTariffItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccidentReplacementTariffItem" ADD CONSTRAINT "AccidentReplacementTariffItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AccidentReplacementCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccidentReplacementCaseEvent" ADD CONSTRAINT "AccidentReplacementCaseEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccidentReplacementCaseEvent" ADD CONSTRAINT "AccidentReplacementCaseEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AccidentReplacementCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccidentReplacementCaseDocument" ADD CONSTRAINT "AccidentReplacementCaseDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccidentReplacementCaseDocument" ADD CONSTRAINT "AccidentReplacementCaseDocument_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AccidentReplacementCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFollowUp" ADD CONSTRAINT "CaseFollowUp_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFollowUp" ADD CONSTRAINT "CaseFollowUp_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AccidentReplacementCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessPartner" ADD CONSTRAINT "BusinessPartner_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "InvoiceAdjustment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "InvoiceAdjustment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "InvoiceAdjustment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "AccidentReplacementCaseDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- 2) Wertelisten und fachliche Regeln (CHECK)
-- ---------------------------------------------------------------------------
ALTER TABLE "Booking" ADD CONSTRAINT "rb_booking_rental_type" CHECK ("rentalType" IN ('STANDARD', 'ACCIDENT_REPLACEMENT'));
-- Standardmieten tragen immer ein Ende; nur Unfallersatz darf offen sein
ALTER TABLE "Booking" ADD CONSTRAINT "rb_booking_open_end" CHECK ("endAt" IS NOT NULL OR "rentalType" = 'ACCIDENT_REPLACEMENT');

-- Rechnungsart Unfallersatz (mehrere je Buchung möglich: Versicherung und Mieter, Zwischen- und Schlussrechnung)
ALTER TABLE "Invoice" DROP CONSTRAINT "rb_invoice_kind";
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_kind" CHECK ("kind" IN ('RENTAL', 'DAMAGE', 'AUTHORITY_FEE', 'DUNNING_FEE', 'GENERAL', 'CANCELLATION_FEE', 'ACCIDENT_REPLACEMENT'));
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_accident_refs" CHECK ("kind" <> 'ACCIDENT_REPLACEMENT' OR "bookingId" IS NOT NULL);

ALTER TABLE "AccidentReplacementCase" ADD CONSTRAINT "rb_accident_case_status" CHECK ("status" IN ('OPEN', 'CLOSED'));
ALTER TABLE "AccidentReplacementCase" ADD CONSTRAINT "rb_accident_case_damage_kind" CHECK ("damageKind" IN ('REPAIR', 'TOTAL_LOSS', 'UNKNOWN'));
ALTER TABLE "AccidentReplacementCase" ADD CONSTRAINT "rb_accident_case_liability" CHECK ("liabilityStatus" IN ('UNKNOWN', 'REPORTED', 'UNCLEAR', 'CONFIRMED', 'QUOTA'));
-- Haftungsquote nur bei Status QUOTA, dann Pflicht und 0–100
ALTER TABLE "AccidentReplacementCase" ADD CONSTRAINT "rb_accident_case_quota" CHECK (("liabilityStatus" = 'QUOTA') = ("liabilityQuotaPercent" IS NOT NULL) AND ("liabilityQuotaPercent" IS NULL OR ("liabilityQuotaPercent" >= 0 AND "liabilityQuotaPercent" <= 100)));
ALTER TABLE "AccidentReplacementCase" ADD CONSTRAINT "rb_accident_case_plate" CHECK (length(btrim("damagedPlate")) >= 1);
ALTER TABLE "AccidentReplacementCase" ADD CONSTRAINT "rb_accident_case_closed" CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL) AND ("closedAt" IS NULL OR ("closeReason" IS NOT NULL AND length(btrim("closeReason")) >= 3)));
ALTER TABLE "AccidentReplacementCase" ADD CONSTRAINT "rb_accident_case_repair_period" CHECK ("repairStartAt" IS NULL OR "repairEndAt" IS NULL OR "repairEndAt" >= "repairStartAt");

ALTER TABLE "AccidentReplacementTariffItem" ADD CONSTRAINT "rb_accident_tariff_kind" CHECK ("kind" IN ('LIABILITY_REDUCTION', 'DELIVERY', 'PICKUP', 'ADDITIONAL_DRIVER', 'WINTER_TIRES', 'OTHER'));
ALTER TABLE "AccidentReplacementTariffItem" ADD CONSTRAINT "rb_accident_tariff_amounts" CHECK ("unitPriceCents" >= 0 AND "quantityHundredths" > 0 AND length(btrim("label")) >= 1);

ALTER TABLE "AccidentReplacementCaseEvent" ADD CONSTRAINT "rb_accident_case_event_type" CHECK ("type" IN (
  'CREATED', 'DAMAGED_VEHICLE_CHANGED', 'ACCIDENT_CHANGED', 'INSURER_CHANGED', 'LIABILITY_CHANGED', 'WORKSHOP_CHANGED', 'LAWYER_CHANGED',
  'TARIFF_CHANGED', 'PLANNED_END_CHANGED', 'VEHICLE_PICKED_UP', 'VEHICLE_RETURNED', 'DOCUMENT_ADDED', 'DOCUMENT_ARCHIVED', 'NOTE_ADDED',
  'INVOICE_CREATED', 'ADJUSTMENT_RECORDED', 'ADJUSTMENT_CANCELLED', 'FOLLOW_UP_CREATED', 'FOLLOW_UP_DONE', 'FOLLOW_UP_CANCELLED', 'CLOSED', 'REOPENED'));

ALTER TABLE "AccidentReplacementCaseDocument" ADD CONSTRAINT "rb_accident_document_type" CHECK ("type" IN ('ASSIGNMENT', 'INSURER_LETTER', 'OTHER'));
ALTER TABLE "AccidentReplacementCaseDocument" ADD CONSTRAINT "rb_accident_document_archive" CHECK (("archivedAt" IS NULL) = ("archiveReason" IS NULL) AND ("archiveReason" IS NULL OR length(btrim("archiveReason")) >= 3));

ALTER TABLE "CaseFollowUp" ADD CONSTRAINT "rb_follow_up_status" CHECK ("status" IN ('OPEN', 'DONE', 'CANCELLED'));
ALTER TABLE "CaseFollowUp" ADD CONSTRAINT "rb_follow_up_title" CHECK (length(btrim("title")) >= 1);
ALTER TABLE "CaseFollowUp" ADD CONSTRAINT "rb_follow_up_done" CHECK (("status" <> 'OPEN') = ("doneAt" IS NOT NULL));

ALTER TABLE "BusinessPartner" ADD CONSTRAINT "rb_business_partner_kind" CHECK ("kind" IN ('INSURER', 'WORKSHOP', 'LAWYER'));

ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "rb_invoice_adjustment_type" CHECK ("type" IN ('INSURER_REDUCTION'));
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "rb_invoice_adjustment_reason" CHECK ("reasonKind" IN ('TARIFF', 'DURATION', 'ANCILLARY', 'VEHICLE_CLASS', 'LIABILITY_QUOTA', 'OTHER'));
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "rb_invoice_adjustment_amount" CHECK ("amountCents" > 0);
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "rb_invoice_adjustment_status" CHECK ("status" IN ('CONFIRMED', 'CANCELLED'));
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "rb_invoice_adjustment_cancel_fields" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL) AND ("cancelledAt" IS NULL OR ("cancellationReason" IS NOT NULL AND length(btrim("cancellationReason")) >= 3)));

-- ---------------------------------------------------------------------------
-- 3) Vertrag: offenes Ende nur zu einer Unfallersatz-Buchung (der Vertrag kennt die Mietart nur über die Buchung)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rb_check_contract_period() RETURNS trigger AS $$
DECLARE
  b_type text;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF NEW."endAt" IS NULL THEN
    SELECT "rentalType" INTO b_type FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_type IS DISTINCT FROM 'ACCIDENT_REPLACEMENT' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Ein offenes Mietende gibt es nur bei einer Unfallersatzmiete';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_contract_period_check BEFORE INSERT OR UPDATE ON "RentalContract" FOR EACH ROW EXECUTE FUNCTION rb_check_contract_period();

-- Die Mietart einer Buchung ist ab der Anlage fest (eine Standardmiete wird nicht nachträglich zum Unfallersatz und umgekehrt)
CREATE OR REPLACE FUNCTION rb_guard_booking_rental_type() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF NEW."rentalType" <> OLD."rentalType" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Die Mietart einer Buchung ist fest';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_booking_rental_type_guard BEFORE UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION rb_guard_booking_rental_type();

-- ---------------------------------------------------------------------------
-- 4) Fallakte: Mandant der Buchung passt, Buchung ist Unfallersatz; Nummer und Zuordnung fest; nie löschen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rb_check_accident_case() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  b_type text;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  SELECT "tenantId", "rentalType" INTO b_tenant, b_type FROM "Booking" WHERE "id" = NEW."bookingId";
  IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Fallakte und Buchung gehören zu verschiedenen Mandanten';
  END IF;
  IF b_type IS DISTINCT FROM 'ACCIDENT_REPLACEMENT' THEN
    RAISE EXCEPTION 'RB_DOMAIN: Eine Unfallersatz-Fallakte gehört zu einer Unfallersatz-Buchung';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" <> OLD."bookingId" OR NEW."caseNumber" <> OLD."caseNumber" OR NEW."createdAt" <> OLD."createdAt" OR NEW."idempotencyKey" <> OLD."idempotencyKey" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Nummer und Zuordnung einer Unfallersatz-Fallakte sind fest';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_accident_case_check BEFORE INSERT OR UPDATE ON "AccidentReplacementCase" FOR EACH ROW EXECUTE FUNCTION rb_check_accident_case();

CREATE OR REPLACE FUNCTION rb_guard_accident_case_delete() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Unfallersatz-Fallakten werden nicht gelöscht, nur geschlossen';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_accident_case_guard BEFORE DELETE ON "AccidentReplacementCase" FOR EACH ROW EXECUTE FUNCTION rb_guard_accident_case_delete();

-- Verlauf, Tarif, Dokumente, Wiedervorlagen: Mandant passt zur Fallakte
CREATE OR REPLACE FUNCTION rb_check_accident_case_ref() RETURNS trigger AS $$
DECLARE
  c_tenant text;
BEGIN
  SELECT "tenantId" INTO c_tenant FROM "AccidentReplacementCase" WHERE "id" = NEW."caseId";
  IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Eintrag und Unfallersatz-Fallakte gehören zu verschiedenen Mandanten';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_accident_case_event_check BEFORE INSERT ON "AccidentReplacementCaseEvent" FOR EACH ROW EXECUTE FUNCTION rb_check_accident_case_ref();
CREATE TRIGGER rb_accident_case_event_guard BEFORE UPDATE OR DELETE ON "AccidentReplacementCaseEvent" FOR EACH ROW EXECUTE FUNCTION rb_guard_append_only();
CREATE TRIGGER rb_accident_tariff_check BEFORE INSERT OR UPDATE ON "AccidentReplacementTariffItem" FOR EACH ROW EXECUTE FUNCTION rb_check_accident_case_ref();
CREATE TRIGGER rb_follow_up_check BEFORE INSERT OR UPDATE ON "CaseFollowUp" FOR EACH ROW EXECUTE FUNCTION rb_check_accident_case_ref();

-- Tarifpositionen: nur solange die Akte offen ist änderbar (Rechnungen tragen ihre eigenen Positionen)
CREATE OR REPLACE FUNCTION rb_guard_accident_tariff() RETURNS trigger AS $$
DECLARE
  c_status text;
  cid text;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."tenantId" <> OLD."tenantId" OR NEW."caseId" <> OLD."caseId") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Zuordnung einer Tarifposition ist fest';
  END IF;
  IF TG_OP = 'DELETE' THEN cid := OLD."caseId"; ELSE cid := NEW."caseId"; END IF;
  SELECT "status" INTO c_status FROM "AccidentReplacementCase" WHERE "id" = cid;
  IF c_status = 'CLOSED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Der Tarif einer geschlossenen Fallakte wird nicht mehr geändert';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_accident_tariff_guard BEFORE INSERT OR UPDATE OR DELETE ON "AccidentReplacementTariffItem" FOR EACH ROW EXECUTE FUNCTION rb_guard_accident_tariff();

-- Dokumente: Datei, Prüfsumme und Zuordnung fest; nur Archivierung (einmalig, mit Grund), Notiz und Typ änderbar; nie löschen
CREATE OR REPLACE FUNCTION rb_check_accident_document() RETURNS trigger AS $$
DECLARE
  c_tenant text;
  o jsonb;
  n jsonb;
BEGIN
  SELECT "tenantId" INTO c_tenant FROM "AccidentReplacementCase" WHERE "id" = NEW."caseId";
  IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Dokument und Unfallersatz-Fallakte gehören zu verschiedenen Mandanten';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() THEN
    o := to_jsonb(OLD) - 'archivedAt' - 'archivedById' - 'archivedByName' - 'archiveReason' - 'note' - 'type';
    n := to_jsonb(NEW) - 'archivedAt' - 'archivedById' - 'archivedByName' - 'archiveReason' - 'note' - 'type';
    IF o <> n THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Datei, Prüfsumme und Zuordnung eines Falldokuments sind fest';
    END IF;
    IF OLD."archivedAt" IS NOT NULL AND (NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt" OR NEW."archiveReason" IS DISTINCT FROM OLD."archiveReason" OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."archivedById" IS DISTINCT FROM OLD."archivedById" OR NEW."archivedByName" IS DISTINCT FROM OLD."archivedByName") THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine Archivierung wird nicht zurückgenommen oder geändert';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_accident_document_check BEFORE INSERT OR UPDATE ON "AccidentReplacementCaseDocument" FOR EACH ROW EXECUTE FUNCTION rb_check_accident_document();
CREATE OR REPLACE FUNCTION rb_guard_accident_document_delete() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Falldokumente werden nicht gelöscht, nur archiviert';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_accident_document_guard BEFORE DELETE ON "AccidentReplacementCaseDocument" FOR EACH ROW EXECUTE FUNCTION rb_guard_accident_document_delete();

-- Wiedervorlagen: erledigt oder verworfen ist endgültig; nie löschen
CREATE OR REPLACE FUNCTION rb_guard_follow_up() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Wiedervorlagen werden nicht gelöscht, nur erledigt oder verworfen';
  END IF;
  IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - 'updatedAt') <> (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine erledigte oder verworfene Wiedervorlage wird nicht mehr geändert';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."caseId" <> OLD."caseId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Zuordnung einer Wiedervorlage ist fest';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_follow_up_guard BEFORE UPDATE OR DELETE ON "CaseFollowUp" FOR EACH ROW EXECUTE FUNCTION rb_guard_follow_up();

-- ---------------------------------------------------------------------------
-- 5) Kürzungen: nur zu abgeschlossenen Rechnungen, höchstens der aktuelle Rechnungsbetrag, Mandant passt (Rechnung,
--    Dokument); nach der Erfassung nur noch Storno mit Grund; nie löschen. Rechnung, Zahlungen und Forderung bleiben unberührt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rb_check_invoice_adjustment() RETURNS trigger AS $$
DECLARE
  i record;
  d_tenant text;
  d_booking text;
  gross bigint;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  SELECT "tenantId", "status", "documentType", "currentVersionId", "number", "bookingId" INTO i FROM "Invoice" WHERE "id" = NEW."invoiceId";
  IF i."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Kürzung und Rechnung gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."documentId" IS NOT NULL THEN
    SELECT d."tenantId", c."bookingId" INTO d_tenant, d_booking FROM "AccidentReplacementCaseDocument" d JOIN "AccidentReplacementCase" c ON c."id" = d."caseId" WHERE d."id" = NEW."documentId";
    IF d_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Kürzung und Dokument gehören zu verschiedenen Mandanten';
    END IF;
    IF d_booking IS DISTINCT FROM i."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Das Dokument gehört nicht zur Fallakte dieser Rechnung';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF i."status" <> 'FINALIZED' OR i."documentType" <> 'INVOICE' OR i."currentVersionId" IS NULL THEN
      RAISE EXCEPTION 'RB_DOMAIN: Kürzungen werden nur zu abgeschlossenen Rechnungen dokumentiert';
    END IF;
    SELECT round("grossTotal" * 100)::bigint INTO gross FROM "InvoiceVersion" WHERE "id" = i."currentVersionId";
    IF NEW."amountCents" > gross THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Kürzung (% Cent) übersteigt den Rechnungsbetrag der Rechnung % (% Cent)', NEW."amountCents", i."number", gross;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invoice_adjustment_check BEFORE INSERT OR UPDATE ON "InvoiceAdjustment" FOR EACH ROW EXECUTE FUNCTION rb_check_invoice_adjustment();

CREATE OR REPLACE FUNCTION rb_guard_invoice_adjustment() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Kürzungen werden nicht gelöscht, nur storniert';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine stornierte Kürzung wird nicht mehr geändert';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'cancelledAt' - 'cancelledById' - 'cancelledByName' - 'cancellationReason')
     <> (to_jsonb(OLD) - 'status' - 'cancelledAt' - 'cancelledById' - 'cancelledByName' - 'cancellationReason') THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine dokumentierte Kürzung wird nicht geändert, nur storniert';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invoice_adjustment_guard BEFORE UPDATE OR DELETE ON "InvoiceAdjustment" FOR EACH ROW EXECUTE FUNCTION rb_guard_invoice_adjustment();
