-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "birthPlace" TEXT,
ADD COLUMN     "idIssuedAt" TIMESTAMP(3),
ADD COLUMN     "idIssuedBy" TEXT,
ADD COLUMN     "idNumber" TEXT,
ADD COLUMN     "idType" TEXT,
ADD COLUMN     "idValidUntil" TIMESTAMP(3),
ADD COLUMN     "licenseIssuedBy" TEXT,
ADD COLUMN     "nationality" TEXT;

