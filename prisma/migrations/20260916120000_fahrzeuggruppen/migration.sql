-- CreateTable
CREATE TABLE "VehicleGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "dailyRate" DECIMAL NOT NULL DEFAULT 0,
    "weeklyRate" DECIMAL,
    "monthlyRate" DECIMAL,
    "kmIncludedPerDay" INTEGER NOT NULL DEFAULT 200,
    "extraKmRate" DECIMAL NOT NULL DEFAULT 0.25,
    "deposit" DECIMAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VehicleGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Datenmigration: bestehende Kategorien werden zu Gruppen je Mandant
INSERT INTO "VehicleGroup" ("id", "tenantId", "name", "sortOrder", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), "tenantId", CASE "category" WHEN 'TRANSPORTER' THEN 'Transporter' WHEN 'KOMPAKT' THEN 'Kompaktklasse' WHEN 'KOMBI' THEN 'Kombi' WHEN 'LIMOUSINE' THEN 'Limousine' WHEN 'SUV' THEN 'SUV' WHEN 'KLEINBUS' THEN 'Kleinbus' ELSE 'Sonstige' END, CASE "category" WHEN 'TRANSPORTER' THEN 10 WHEN 'KLEINBUS' THEN 20 WHEN 'KOMBI' THEN 30 WHEN 'KOMPAKT' THEN 40 WHEN 'LIMOUSINE' THEN 50 WHEN 'SUV' THEN 60 ELSE 90 END, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "tenantId", "category" FROM "Vehicle");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Vehicle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "groupId" TEXT,
    "fuel" TEXT NOT NULL DEFAULT 'DIESEL',
    "year" INTEGER,
    "vin" TEXT,
    "color" TEXT,
    "mileage" INTEGER NOT NULL DEFAULT 0,
    "huDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "dailyRate" DECIMAL NOT NULL DEFAULT 0,
    "weeklyRate" DECIMAL,
    "monthlyRate" DECIMAL,
    "kmIncludedPerDay" INTEGER NOT NULL DEFAULT 200,
    "extraKmRate" DECIMAL NOT NULL DEFAULT 0.25,
    "deposit" DECIMAL NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Vehicle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Vehicle_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VehicleGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Vehicle" ("color", "createdAt", "dailyRate", "deposit", "extraKmRate", "fuel", "huDate", "id", "kmIncludedPerDay", "make", "mileage", "model", "monthlyRate", "notes", "plate", "status", "tenantId", "updatedAt", "vin", "weeklyRate", "year", "groupId")
SELECT v."color", v."createdAt", v."dailyRate", v."deposit", v."extraKmRate", v."fuel", v."huDate", v."id", v."kmIncludedPerDay", v."make", v."mileage", v."model", v."monthlyRate", v."notes", v."plate", v."status", v."tenantId", v."updatedAt", v."vin", v."weeklyRate", v."year",
  (SELECT g."id" FROM "VehicleGroup" g WHERE g."tenantId" = v."tenantId" AND g."name" = CASE v."category" WHEN 'TRANSPORTER' THEN 'Transporter' WHEN 'KOMPAKT' THEN 'Kompaktklasse' WHEN 'KOMBI' THEN 'Kombi' WHEN 'LIMOUSINE' THEN 'Limousine' WHEN 'SUV' THEN 'SUV' WHEN 'KLEINBUS' THEN 'Kleinbus' ELSE 'Sonstige' END)
FROM "Vehicle" v;
DROP TABLE "Vehicle";
ALTER TABLE "new_Vehicle" RENAME TO "Vehicle";
CREATE INDEX "Vehicle_tenantId_groupId_idx" ON "Vehicle"("tenantId", "groupId");
CREATE INDEX "Vehicle_tenantId_status_idx" ON "Vehicle"("tenantId", "status");
CREATE UNIQUE INDEX "Vehicle_tenantId_plate_key" ON "Vehicle"("tenantId", "plate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "VehicleGroup_tenantId_sortOrder_idx" ON "VehicleGroup"("tenantId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleGroup_tenantId_name_key" ON "VehicleGroup"("tenantId", "name");

