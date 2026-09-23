-- Steuersemantik der Schadenabrechnung: die steuerliche Behandlung wird je Fassung versiegelt (InvoiceVersion.taxTreatment)
-- und semantisch benannt. Echter Schadensersatz ist "nicht steuerbar" – kein Steuersatz von 0 %, kein Umsatzsteuerausweis.
-- Additiv; bestehende Werte werden nur umbenannt (NON_TAXABLE_DAMAGES → NON_TAXABLE_DAMAGE_COMPENSATION, TAXABLE_SERVICE → TAXABLE_SUPPLY).

ALTER TABLE "InvoiceVersion" ADD COLUMN "taxTreatment" TEXT;

SET rentbase.allow_purge = 'on';
UPDATE "Invoice" SET "taxTreatment" = CASE "taxTreatment" WHEN 'NON_TAXABLE_DAMAGES' THEN 'NON_TAXABLE_DAMAGE_COMPENSATION' WHEN 'TAXABLE_SERVICE' THEN 'TAXABLE_SUPPLY' ELSE "taxTreatment" END
  WHERE "taxTreatment" IN ('NON_TAXABLE_DAMAGES', 'TAXABLE_SERVICE');
UPDATE "DamageCase" SET "customerChargeTaxTreatment" = CASE "customerChargeTaxTreatment" WHEN 'NON_TAXABLE_DAMAGES' THEN 'NON_TAXABLE_DAMAGE_COMPENSATION' WHEN 'TAXABLE_SERVICE' THEN 'TAXABLE_SUPPLY' ELSE "customerChargeTaxTreatment" END
  WHERE "customerChargeTaxTreatment" IN ('NON_TAXABLE_DAMAGES', 'TAXABLE_SERVICE');
-- Bestehende Fassungen von Schadenabrechnungen übernehmen die bei Anlage gewählte Behandlung der Rechnung
UPDATE "InvoiceVersion" v SET "taxTreatment" = i."taxTreatment" FROM "Invoice" i
  WHERE v."invoiceId" = i."id" AND i."kind" = 'DAMAGE' AND v."taxTreatment" IS NULL AND i."taxTreatment" IS NOT NULL;
RESET rentbase.allow_purge;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "rb_invoice_tax_treatment";
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_tax_treatment" CHECK ("taxTreatment" IS NULL OR "taxTreatment" IN ('NON_TAXABLE_DAMAGE_COMPENSATION', 'TAXABLE_SUPPLY'));
ALTER TABLE "DamageCase" DROP CONSTRAINT IF EXISTS "rb_damage_case_charge_tax";
ALTER TABLE "DamageCase" ADD CONSTRAINT "rb_damage_case_charge_tax" CHECK ("customerChargeTaxTreatment" IS NULL OR "customerChargeTaxTreatment" IN ('NON_TAXABLE_DAMAGE_COMPENSATION', 'TAXABLE_SUPPLY'));
ALTER TABLE "InvoiceVersion" ADD CONSTRAINT "rb_invoice_version_tax_treatment" CHECK ("taxTreatment" IS NULL OR "taxTreatment" IN ('NON_TAXABLE_DAMAGE_COMPENSATION', 'TAXABLE_SUPPLY'));
