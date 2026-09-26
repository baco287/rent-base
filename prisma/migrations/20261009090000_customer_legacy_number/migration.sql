-- Kundennummer aus der Alt-Software (Datenübernahme), nur Referenz, keine eigene Eindeutigkeit
ALTER TABLE "Customer" ADD COLUMN "legacyNumber" TEXT;

CREATE INDEX "Customer_tenantId_legacyNumber_idx" ON "Customer"("tenantId", "legacyNumber");
