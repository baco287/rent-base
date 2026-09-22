-- AlterTable: Zusatzkosten mit Herkunft (Vorschlag bestätigt oder manuell), interner Notiz und Bezug zum Protokollschaden
ALTER TABLE "ExtraCharge" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "internalNote" TEXT,
ADD COLUMN     "handoverDamageId" TEXT;

-- AlterTable: bei der Rückgabe ausdrücklich angegebener Literpreis
ALTER TABLE "Handover" ADD COLUMN     "fuelPricePerLiter" DECIMAL(65,30);

-- AlterTable: Schadenabrechnung intern prüfen (keine Haftungsfeststellung)
ALTER TABLE "Damage" ADD COLUMN     "settlementReview" BOOLEAN NOT NULL DEFAULT false;

-- Von Hand ergänzt: Zusatzkosten nie negativ, Menge positiv
ALTER TABLE "ExtraCharge" ADD CONSTRAINT "rb_extracharge_amounts" CHECK ("amount" >= 0 AND "unitPrice" >= 0 AND "quantity" > 0);
