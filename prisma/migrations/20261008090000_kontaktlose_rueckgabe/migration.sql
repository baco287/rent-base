-- Befehl 20.6: kontaktlose Rückgabe / Schlüsselbox. Rein additiv: keine bestehende Zeile wird geändert.
-- Bestehende Mandanten: keyDropEnabled = false. Bestehende Protokolle: returnMode = NULL (vor 20.6, persönlich).

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "keyDropEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "keyDropSettings" JSONB;

-- AlterTable
ALTER TABLE "Handover" ADD COLUMN     "customerDropOffAt" TIMESTAMP(3),
ADD COLUMN     "keyDropExceptionReason" TEXT,
ADD COLUMN     "keyDropId" TEXT,
ADD COLUMN     "returnMode" TEXT;

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "keyDropId" TEXT;

-- AlterTable
ALTER TABLE "Signature" ADD COLUMN     "keyDropId" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "keyDropId" TEXT;

-- CreateTable
CREATE TABLE "KeyDropReturn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AUTHORIZED',
    "agreedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agreedById" TEXT NOT NULL,
    "agreedByName" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "instructions" TEXT,
    "expectedReturnAt" TIMESTAMP(3) NOT NULL,
    "internalNote" TEXT,
    "settingsSnapshot" JSONB NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "customerStartedAt" TIMESTAMP(3),
    "customerDropOffAt" TIMESTAMP(3),
    "customerMileage" INTEGER,
    "customerFuelEighths" INTEGER,
    "customerBatteryPercent" INTEGER,
    "customerLocationConfirmed" BOOLEAN,
    "customerLocationNote" TEXT,
    "customerNewDamages" BOOLEAN,
    "customerDamageNote" TEXT,
    "customerRemark" TEXT,
    "customerSignerName" TEXT,
    "confirmationText" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmationHash" TEXT,
    "logoRef" JSONB,
    "inspectionStartedAt" TIMESTAMP(3),
    "inspectedAt" TIMESTAMP(3),
    "inspectedById" TEXT,
    "inspectedByName" TEXT,
    "exceptionReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledByName" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyDropReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyDropAccess" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "keyDropId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdByName" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "emailLogId" TEXT,

    CONSTRAINT "KeyDropAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KeyDropReturn_tenantId_status_idx" ON "KeyDropReturn"("tenantId", "status");

-- CreateIndex
CREATE INDEX "KeyDropReturn_tenantId_bookingId_idx" ON "KeyDropReturn"("tenantId", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "KeyDropAccess_tokenHash_key" ON "KeyDropAccess"("tokenHash");

-- CreateIndex
CREATE INDEX "KeyDropAccess_tenantId_keyDropId_idx" ON "KeyDropAccess"("tenantId", "keyDropId");

-- CreateIndex
CREATE UNIQUE INDEX "Handover_keyDropId_key" ON "Handover"("keyDropId");

-- AddForeignKey
ALTER TABLE "KeyDropReturn" ADD CONSTRAINT "KeyDropReturn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyDropReturn" ADD CONSTRAINT "KeyDropReturn_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyDropAccess" ADD CONSTRAINT "KeyDropAccess_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyDropAccess" ADD CONSTRAINT "KeyDropAccess_keyDropId_fkey" FOREIGN KEY ("keyDropId") REFERENCES "KeyDropReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_keyDropId_fkey" FOREIGN KEY ("keyDropId") REFERENCES "KeyDropReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_keyDropId_fkey" FOREIGN KEY ("keyDropId") REFERENCES "KeyDropReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_keyDropId_fkey" FOREIGN KEY ("keyDropId") REFERENCES "KeyDropReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_keyDropId_fkey" FOREIGN KEY ("keyDropId") REFERENCES "KeyDropReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Erlaubte Werte
ALTER TABLE "KeyDropReturn" ADD CONSTRAINT "rb_key_drop_status" CHECK ("status" IN ('AUTHORIZED', 'CUSTOMER_CONFIRMED', 'INSPECTED', 'CANCELLED'));
ALTER TABLE "KeyDropReturn" ADD CONSTRAINT "rb_key_drop_levels" CHECK (("customerFuelEighths" IS NULL OR "customerFuelEighths" BETWEEN 0 AND 8) AND ("customerBatteryPercent" IS NULL OR "customerBatteryPercent" BETWEEN 0 AND 100) AND ("customerMileage" IS NULL OR "customerMileage" >= 0));
-- Bestätigt heißt: Zeitpunkt, Text und Prüfsumme liegen vor
ALTER TABLE "KeyDropReturn" ADD CONSTRAINT "rb_key_drop_confirmed_complete" CHECK ("confirmedAt" IS NULL OR ("customerDropOffAt" IS NOT NULL AND "confirmationText" IS NOT NULL AND "confirmationHash" IS NOT NULL));
ALTER TABLE "Handover" ADD CONSTRAINT "rb_handover_return_mode" CHECK ("returnMode" IS NULL OR ("type" = 'RETURN' AND "returnMode" IN ('IN_PERSON', 'KEY_DROP')));
ALTER TABLE "Handover" ADD CONSTRAINT "rb_handover_key_drop_mode" CHECK ("keyDropId" IS NULL OR "returnMode" = 'KEY_DROP');

-- Je Buchung höchstens eine nicht aufgehobene kontaktlose Rückgabe; je Rückgabe höchstens ein aktiver Link
CREATE UNIQUE INDEX "rb_key_drop_one_active" ON "KeyDropReturn"("bookingId") WHERE "status" <> 'CANCELLED';
CREATE UNIQUE INDEX "rb_key_drop_one_active_access" ON "KeyDropAccess"("keyDropId") WHERE "revokedAt" IS NULL;

-- Unveränderlichkeit: Kundenangaben nach der Bestätigung; Endzustände; kein Löschen (außer Test-Bereinigung)
CREATE OR REPLACE FUNCTION rb_guard_key_drop() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: kontaktlose Rückgaben werden nicht gelöscht, nur aufgehoben';
  END IF;
  IF OLD."confirmedAt" IS NOT NULL AND (
       NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt" OR NEW."customerDropOffAt" IS DISTINCT FROM OLD."customerDropOffAt"
    OR NEW."customerMileage" IS DISTINCT FROM OLD."customerMileage" OR NEW."customerFuelEighths" IS DISTINCT FROM OLD."customerFuelEighths"
    OR NEW."customerBatteryPercent" IS DISTINCT FROM OLD."customerBatteryPercent" OR NEW."customerLocationConfirmed" IS DISTINCT FROM OLD."customerLocationConfirmed"
    OR NEW."customerLocationNote" IS DISTINCT FROM OLD."customerLocationNote" OR NEW."customerNewDamages" IS DISTINCT FROM OLD."customerNewDamages"
    OR NEW."customerDamageNote" IS DISTINCT FROM OLD."customerDamageNote" OR NEW."customerRemark" IS DISTINCT FROM OLD."customerRemark"
    OR NEW."customerSignerName" IS DISTINCT FROM OLD."customerSignerName" OR NEW."confirmationText" IS DISTINCT FROM OLD."confirmationText"
    OR NEW."confirmationHash" IS DISTINCT FROM OLD."confirmationHash" OR NEW."logoRef"::text IS DISTINCT FROM OLD."logoRef"::text) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: bestätigte Kundenangaben der kontaktlosen Rückgabe können nicht geändert werden';
  END IF;
  IF OLD."status" IN ('INSPECTED', 'CANCELLED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: abgeschlossene oder aufgehobene kontaktlose Rückgabe';
  END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" <> 'AUTHORIZED' AND OLD."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'RB_DOMAIN: Nach der Rückgabemeldung des Kunden kann die kontaktlose Rückgabe nicht mehr aufgehoben werden';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_key_drop_guard BEFORE UPDATE OR DELETE ON "KeyDropReturn" FOR EACH ROW EXECUTE FUNCTION rb_guard_key_drop();

CREATE OR REPLACE FUNCTION rb_guard_key_drop_access() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Rückgabelinks werden widerrufen, nicht gelöscht';
  END IF;
  IF NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."keyDropId" IS DISTINCT FROM OLD."keyDropId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Rückgabelink kann nicht umgeschrieben werden';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: widerrufener Rückgabelink bleibt widerrufen';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_key_drop_access_guard BEFORE UPDATE OR DELETE ON "KeyDropAccess" FOR EACH ROW EXECUTE FUNCTION rb_guard_key_drop_access();

-- Kundenfotos und Kundenunterschrift: nach der Bestätigung gesperrt
CREATE OR REPLACE FUNCTION rb_guard_key_drop_child() RETURNS trigger AS $$
DECLARE
  kid text;
  conf timestamp(3);
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN kid := NEW."keyDropId"; ELSE kid := OLD."keyDropId"; END IF;
  IF kid IS NOT NULL THEN
    SELECT "confirmedAt" INTO conf FROM "KeyDropReturn" WHERE "id" = kid;
    IF conf IS NOT NULL AND (TG_OP = 'DELETE' OR TG_OP = 'INSERT' OR NEW."keyDropId" IS DISTINCT FROM OLD."keyDropId") THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: % gehört zu einer bestätigten kontaktlosen Rückgabe und ist gesperrt', TG_TABLE_NAME;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_photo_key_drop_guard BEFORE INSERT OR UPDATE OR DELETE ON "Photo" FOR EACH ROW EXECUTE FUNCTION rb_guard_key_drop_child();
CREATE TRIGGER rb_signature_key_drop_guard BEFORE INSERT OR DELETE ON "Signature" FOR EACH ROW EXECUTE FUNCTION rb_guard_key_drop_child();

-- Unterschrift gehört zu genau einem Elternobjekt: Protokoll, Vertrag oder (neu) Kundenmeldung der kontaktlosen Rückgabe
ALTER TABLE "Signature" DROP CONSTRAINT "Signature_has_parent";
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_has_parent" CHECK ((("handoverId" IS NOT NULL)::int + ("contractId" IS NOT NULL)::int + ("keyDropId" IS NOT NULL)::int) = 1 OR rb_purge_allowed());
