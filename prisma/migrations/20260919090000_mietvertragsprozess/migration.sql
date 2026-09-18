-- AlterTable
ALTER TABLE "ContractDriver" ALTER COLUMN "role" SET DEFAULT 'ADDITIONAL_DRIVER';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'DE',
ADD COLUMN     "number" TEXT;

-- AlterTable
ALTER TABLE "RentalContract" ADD COLUMN     "agreedTotal" DECIMAL(65,30),
ADD COLUMN     "agreedTotalNote" TEXT,
ADD COLUMN     "driverMode" TEXT NOT NULL DEFAULT 'RENTER',
ADD COLUMN     "fuelPolicyNote" TEXT,
ADD COLUMN     "internalNote" TEXT,
ADD COLUMN     "pickupLocation" TEXT,
ADD COLUMN     "returnLocation" TEXT,
ADD COLUMN     "termsText" TEXT,
ADD COLUMN     "wizardStep" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "fuelPolicy" SET DEFAULT 'FULL_TO_FULL';

-- AlterTable
ALTER TABLE "Signature" ADD COLUMN     "imageChecksum" TEXT,
ADD COLUMN     "imageData" BYTEA;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "rentalTermsText" TEXT,
ADD COLUMN     "rentalTermsVersion" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_number_key" ON "Customer"("tenantId", "number");


-- Datenübernahme (von Hand ergänzt)
-- Kundennummern für bestehende Kunden: fortlaufend je Mandant in Anlagereihenfolge
UPDATE "Customer" c SET "number" = 'K-' || lpad(n.rn::text, 5, '0')
FROM (SELECT "id", row_number() OVER (PARTITION BY "tenantId" ORDER BY "createdAt", "id") AS rn FROM "Customer") n
WHERE n."id" = c."id" AND c."number" IS NULL;

-- Rollenbezeichnungen der Fahrer vereinheitlichen. Betrifft nur Testdaten aus Phase 2;
-- die Freigabe ist nötig, weil Fahrer unterschriebener Verträge sonst gesperrt sind.
SELECT set_config('rentbase.allow_purge', 'on', false);
UPDATE "ContractDriver" SET "role" = 'PRIMARY_DRIVER' WHERE "role" = 'MAIN';
UPDATE "ContractDriver" SET "role" = 'ADDITIONAL_DRIVER' WHERE "role" = 'ADDITIONAL';
SELECT set_config('rentbase.allow_purge', '', false);
