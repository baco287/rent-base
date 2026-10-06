-- Befehl 29: Miettarife 2.0. Rein additiv: neue Tabellen (Tarif, unveränderliche Revisionen, Preisstufen je Fahrzeuggruppe,
-- Fahrzeugabweichungen), neue optionale Spalten an Buchung und Fahrzeuggruppe, Invarianten und Schutzfunktionen.
-- Bestehende Buchungen, Verträge, Nachträge, Rechnungen und Zahlungen werden NICHT verändert oder neu bewertet: Buchungen ohne
-- Tarif rechnen weiter aus ihren eingefrorenen Altfeldern. Die bisherigen Gruppen-/Fahrzeugpreise werden je Mandant als Tarif
-- „Standard“ (Revision 1) übernommen – exakt, abweichende Fahrzeuge als Fahrzeugabweichung.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "agreedPriceCents" INTEGER,
ADD COLUMN     "depositOverrideReason" TEXT,
ADD COLUMN     "kmOverrideReason" TEXT,
ADD COLUMN     "kmPolicy" TEXT,
ADD COLUMN     "overrideInfo" JSONB,
ADD COLUMN     "priceOverrideReason" TEXT,
ADD COLUMN     "ratePlanId" TEXT,
ADD COLUMN     "ratePlanRevisionId" TEXT,
ADD COLUMN     "regularPriceCents" INTEGER,
ADD COLUMN     "tariffSnapshot" JSONB;

-- AlterTable
ALTER TABLE "VehicleGroup" ADD COLUMN     "defaultRatePlanId" TEXT;

-- CreateTable
CREATE TABLE "RatePlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "currentRevisionId" TEXT,
    "createKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdByName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "updatedByName" TEXT,

    CONSTRAINT "RatePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatePlanRevision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ratePlanId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kmPolicy" TEXT NOT NULL,
    "kmIncludedPerDay" INTEGER,
    "extraKmRateCents" INTEGER,
    "depositCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdByName" TEXT,

    CONSTRAINT "RatePlanRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatePlanGroupPrice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "depositCents" INTEGER,
    "kmPolicy" TEXT,
    "kmIncludedPerDay" INTEGER,
    "extraKmRateCents" INTEGER,

    CONSTRAINT "RatePlanGroupPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatePlanPriceTier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "groupPriceId" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "label" TEXT,

    CONSTRAINT "RatePlanPriceTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleRateOverride" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "ratePlanId" TEXT NOT NULL,
    "depositCents" INTEGER,
    "kmPolicy" TEXT,
    "kmIncludedPerDay" INTEGER,
    "extraKmRateCents" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "updatedByName" TEXT,

    CONSTRAINT "VehicleRateOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleRateOverrideTier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "overrideId" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "priceCents" INTEGER,

    CONSTRAINT "VehicleRateOverrideTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RatePlan_currentRevisionId_key" ON "RatePlan"("currentRevisionId");

-- CreateIndex
CREATE INDEX "RatePlan_tenantId_active_sortOrder_idx" ON "RatePlan"("tenantId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlan_tenantId_createKey_key" ON "RatePlan"("tenantId", "createKey");

-- CreateIndex
CREATE INDEX "RatePlanRevision_tenantId_idx" ON "RatePlanRevision"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlanRevision_ratePlanId_revision_key" ON "RatePlanRevision"("ratePlanId", "revision");

-- CreateIndex
CREATE INDEX "RatePlanGroupPrice_tenantId_groupId_idx" ON "RatePlanGroupPrice"("tenantId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlanGroupPrice_revisionId_groupId_key" ON "RatePlanGroupPrice"("revisionId", "groupId");

-- CreateIndex
CREATE INDEX "RatePlanPriceTier_tenantId_idx" ON "RatePlanPriceTier"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlanPriceTier_groupPriceId_durationDays_key" ON "RatePlanPriceTier"("groupPriceId", "durationDays");

-- CreateIndex
CREATE INDEX "VehicleRateOverride_tenantId_ratePlanId_idx" ON "VehicleRateOverride"("tenantId", "ratePlanId");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleRateOverride_vehicleId_ratePlanId_key" ON "VehicleRateOverride"("vehicleId", "ratePlanId");

-- CreateIndex
CREATE INDEX "VehicleRateOverrideTier_tenantId_idx" ON "VehicleRateOverrideTier"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleRateOverrideTier_overrideId_durationDays_key" ON "VehicleRateOverrideTier"("overrideId", "durationDays");

-- CreateIndex
CREATE INDEX "Booking_ratePlanId_idx" ON "Booking"("ratePlanId");

-- AddForeignKey
ALTER TABLE "VehicleGroup" ADD CONSTRAINT "VehicleGroup_defaultRatePlanId_fkey" FOREIGN KEY ("defaultRatePlanId") REFERENCES "RatePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "RatePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_ratePlanRevisionId_fkey" FOREIGN KEY ("ratePlanRevisionId") REFERENCES "RatePlanRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlan" ADD CONSTRAINT "RatePlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlan" ADD CONSTRAINT "RatePlan_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "RatePlanRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlanRevision" ADD CONSTRAINT "RatePlanRevision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlanRevision" ADD CONSTRAINT "RatePlanRevision_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "RatePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlanGroupPrice" ADD CONSTRAINT "RatePlanGroupPrice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlanGroupPrice" ADD CONSTRAINT "RatePlanGroupPrice_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "RatePlanRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlanGroupPrice" ADD CONSTRAINT "RatePlanGroupPrice_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VehicleGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlanPriceTier" ADD CONSTRAINT "RatePlanPriceTier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlanPriceTier" ADD CONSTRAINT "RatePlanPriceTier_groupPriceId_fkey" FOREIGN KEY ("groupPriceId") REFERENCES "RatePlanGroupPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleRateOverride" ADD CONSTRAINT "VehicleRateOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleRateOverride" ADD CONSTRAINT "VehicleRateOverride_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleRateOverride" ADD CONSTRAINT "VehicleRateOverride_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "RatePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleRateOverrideTier" ADD CONSTRAINT "VehicleRateOverrideTier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleRateOverrideTier" ADD CONSTRAINT "VehicleRateOverrideTier_overrideId_fkey" FOREIGN KEY ("overrideId") REFERENCES "VehicleRateOverride"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Befehl 29: Invarianten der Miettarife (Datenbank als letzte Schranke)
-- ===========================================================================

-- Tarif: Name je Mandant eindeutig (ohne Groß-/Kleinschreibung und Randleerzeichen), Code je Mandant eindeutig
ALTER TABLE "RatePlan" ADD CONSTRAINT "rb_rateplan_name" CHECK (length(btrim("name")) BETWEEN 1 AND 60);
ALTER TABLE "RatePlan" ADD CONSTRAINT "rb_rateplan_code" CHECK ("code" IS NULL OR length(btrim("code")) BETWEEN 1 AND 30);
ALTER TABLE "RatePlan" ADD CONSTRAINT "rb_rateplan_description" CHECK ("description" IS NULL OR length("description") <= 500);
ALTER TABLE "RatePlan" ADD CONSTRAINT "rb_rateplan_active_revision" CHECK (NOT "active" OR "currentRevisionId" IS NOT NULL);
CREATE UNIQUE INDEX "rb_rateplan_name_unique" ON "RatePlan" ("tenantId", lower(btrim("name")));
CREATE UNIQUE INDEX "rb_rateplan_code_unique" ON "RatePlan" ("tenantId", lower(btrim("code"))) WHERE "code" IS NOT NULL;

-- Revision: Kilometerregel widerspruchsfrei (Freikilometer mit Werten, Unbegrenzt ohne), Beträge nie negativ
ALTER TABLE "RatePlanRevision" ADD CONSTRAINT "rb_rateplan_revision_km" CHECK (
  ("kmPolicy" = 'FREE_KILOMETERS' AND "kmIncludedPerDay" IS NOT NULL AND "kmIncludedPerDay" >= 0 AND "extraKmRateCents" IS NOT NULL AND "extraKmRateCents" >= 0)
  OR ("kmPolicy" = 'UNLIMITED' AND "kmIncludedPerDay" IS NULL AND "extraKmRateCents" IS NULL));
ALTER TABLE "RatePlanRevision" ADD CONSTRAINT "rb_rateplan_revision_values" CHECK ("revision" >= 1 AND "depositCents" >= 0);

-- Gruppenpreis und Fahrzeugabweichung: optionale Abweichungen, gleiche Regeln
ALTER TABLE "RatePlanGroupPrice" ADD CONSTRAINT "rb_rateplan_group_km" CHECK (
  ("kmPolicy" IS NULL AND "kmIncludedPerDay" IS NULL AND "extraKmRateCents" IS NULL)
  OR ("kmPolicy" = 'FREE_KILOMETERS' AND "kmIncludedPerDay" IS NOT NULL AND "kmIncludedPerDay" >= 0 AND "extraKmRateCents" IS NOT NULL AND "extraKmRateCents" >= 0)
  OR ("kmPolicy" = 'UNLIMITED' AND "kmIncludedPerDay" IS NULL AND "extraKmRateCents" IS NULL));
ALTER TABLE "RatePlanGroupPrice" ADD CONSTRAINT "rb_rateplan_group_deposit" CHECK ("depositCents" IS NULL OR "depositCents" >= 0);
ALTER TABLE "VehicleRateOverride" ADD CONSTRAINT "rb_vehicle_rate_km" CHECK (
  ("kmPolicy" IS NULL AND "kmIncludedPerDay" IS NULL AND "extraKmRateCents" IS NULL)
  OR ("kmPolicy" = 'FREE_KILOMETERS' AND "kmIncludedPerDay" IS NOT NULL AND "kmIncludedPerDay" >= 0 AND "extraKmRateCents" IS NOT NULL AND "extraKmRateCents" >= 0)
  OR ("kmPolicy" = 'UNLIMITED' AND "kmIncludedPerDay" IS NULL AND "extraKmRateCents" IS NULL));
ALTER TABLE "VehicleRateOverride" ADD CONSTRAINT "rb_vehicle_rate_deposit" CHECK ("depositCents" IS NULL OR "depositCents" >= 0);
ALTER TABLE "VehicleRateOverride" ADD CONSTRAINT "rb_vehicle_rate_note" CHECK ("note" IS NULL OR length("note") <= 300);

-- Preisstufen: ganze Tage 1..3650, Cent >= 0 (Fahrzeugstufe NULL = für dieses Fahrzeug nicht angeboten)
ALTER TABLE "RatePlanPriceTier" ADD CONSTRAINT "rb_rateplan_tier" CHECK ("durationDays" BETWEEN 1 AND 3650 AND "priceCents" >= 0 AND ("label" IS NULL OR length("label") <= 40));
ALTER TABLE "VehicleRateOverrideTier" ADD CONSTRAINT "rb_vehicle_rate_tier" CHECK ("durationDays" BETWEEN 1 AND 3650 AND ("priceCents" IS NULL OR "priceCents" >= 0));

-- Buchung: Tarif, Revision und Snapshot nur gemeinsam; Sonderpreis >= 0 (0 € zulässig) nur mit Grund; Abweichungsgründe nie leer;
-- Tarife gelten für Standardmieten (Unfallersatz rechnet weiter über seine Fallakte)
ALTER TABLE "Booking" ADD CONSTRAINT "rb_booking_tariff" CHECK (
  ("ratePlanId" IS NULL AND "ratePlanRevisionId" IS NULL AND "tariffSnapshot" IS NULL)
  OR ("ratePlanId" IS NOT NULL AND "ratePlanRevisionId" IS NOT NULL AND "tariffSnapshot" IS NOT NULL AND "rentalType" = 'STANDARD'));
ALTER TABLE "Booking" ADD CONSTRAINT "rb_booking_agreed_price" CHECK (
  ("agreedPriceCents" IS NULL AND "priceOverrideReason" IS NULL)
  OR ("agreedPriceCents" >= 0 AND "priceOverrideReason" IS NOT NULL AND length(btrim("priceOverrideReason")) >= 3));
ALTER TABLE "Booking" ADD CONSTRAINT "rb_booking_tariff_values" CHECK (
  ("regularPriceCents" IS NULL OR "regularPriceCents" >= 0)
  AND ("kmPolicy" IS NULL OR "kmPolicy" IN ('FREE_KILOMETERS', 'UNLIMITED'))
  AND ("kmOverrideReason" IS NULL OR length(btrim("kmOverrideReason")) >= 3)
  AND ("depositOverrideReason" IS NULL OR length(btrim("depositOverrideReason")) >= 3));

-- ---------------------------------------------------------------------------
-- Mandantentrennung und Zugehörigkeit (alle Verweise müssen zum selben Mandanten gehören)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rb_check_rateplan_refs() RETURNS trigger AS $$
DECLARE t text; p text;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'RatePlan' THEN
    IF TG_OP = 'UPDATE' AND NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN RAISE EXCEPTION 'RB_IMMUTABLE: Der Mandant eines Tarifs ist fest'; END IF;
    IF NEW."currentRevisionId" IS NOT NULL THEN
      SELECT "tenantId", "ratePlanId" INTO t, p FROM "RatePlanRevision" WHERE "id" = NEW."currentRevisionId";
      IF t IS DISTINCT FROM NEW."tenantId" OR p IS DISTINCT FROM NEW."id" THEN RAISE EXCEPTION 'RB_TENANT: Die aktuelle Revision gehört nicht zu diesem Tarif'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'RatePlanRevision' THEN
    SELECT "tenantId" INTO t FROM "RatePlan" WHERE "id" = NEW."ratePlanId";
    IF t IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Revision und Tarif gehören zu verschiedenen Mandanten'; END IF;
  ELSIF TG_TABLE_NAME = 'RatePlanGroupPrice' THEN
    SELECT "tenantId" INTO t FROM "RatePlanRevision" WHERE "id" = NEW."revisionId";
    IF t IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Gruppenpreis und Revision gehören zu verschiedenen Mandanten'; END IF;
    SELECT "tenantId" INTO t FROM "VehicleGroup" WHERE "id" = NEW."groupId";
    IF t IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Die Fahrzeuggruppe gehört zu einem anderen Mandanten'; END IF;
  ELSIF TG_TABLE_NAME = 'RatePlanPriceTier' THEN
    SELECT "tenantId" INTO t FROM "RatePlanGroupPrice" WHERE "id" = NEW."groupPriceId";
    IF t IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Preisstufe und Gruppenpreis gehören zu verschiedenen Mandanten'; END IF;
  ELSIF TG_TABLE_NAME = 'VehicleRateOverride' THEN
    IF TG_OP = 'UPDATE' AND (NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."vehicleId" IS DISTINCT FROM OLD."vehicleId" OR NEW."ratePlanId" IS DISTINCT FROM OLD."ratePlanId") THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Mandant, Fahrzeug und Tarif einer Fahrzeugabweichung sind fest';
    END IF;
    SELECT "tenantId" INTO t FROM "Vehicle" WHERE "id" = NEW."vehicleId";
    IF t IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Das Fahrzeug gehört zu einem anderen Mandanten'; END IF;
    SELECT "tenantId" INTO t FROM "RatePlan" WHERE "id" = NEW."ratePlanId";
    IF t IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Der Tarif gehört zu einem anderen Mandanten'; END IF;
  ELSIF TG_TABLE_NAME = 'VehicleRateOverrideTier' THEN
    SELECT "tenantId" INTO t FROM "VehicleRateOverride" WHERE "id" = NEW."overrideId";
    IF t IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Fahrzeugstufe und Fahrzeugabweichung gehören zu verschiedenen Mandanten'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_check_rateplan_refs" BEFORE INSERT OR UPDATE ON "RatePlan" FOR EACH ROW EXECUTE FUNCTION rb_check_rateplan_refs();
CREATE TRIGGER "rb_check_rateplan_refs" BEFORE INSERT ON "RatePlanRevision" FOR EACH ROW EXECUTE FUNCTION rb_check_rateplan_refs();
CREATE TRIGGER "rb_check_rateplan_refs" BEFORE INSERT ON "RatePlanGroupPrice" FOR EACH ROW EXECUTE FUNCTION rb_check_rateplan_refs();
CREATE TRIGGER "rb_check_rateplan_refs" BEFORE INSERT ON "RatePlanPriceTier" FOR EACH ROW EXECUTE FUNCTION rb_check_rateplan_refs();
CREATE TRIGGER "rb_check_rateplan_refs" BEFORE INSERT OR UPDATE ON "VehicleRateOverride" FOR EACH ROW EXECUTE FUNCTION rb_check_rateplan_refs();
CREATE TRIGGER "rb_check_rateplan_refs" BEFORE INSERT OR UPDATE ON "VehicleRateOverrideTier" FOR EACH ROW EXECUTE FUNCTION rb_check_rateplan_refs();

-- Revisionen, Gruppenpreise und Preisstufen sind unveränderlich (Historie); Tarife werden nie hart gelöscht
CREATE OR REPLACE FUNCTION rb_guard_rateplan_history() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'RatePlan' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Tarife werden nicht gelöscht, sondern deaktiviert';
  END IF;
  RAISE EXCEPTION 'RB_IMMUTABLE: Tarifrevisionen sind unveränderlich; eine Änderung erzeugt eine neue Revision';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_guard_rateplan_history" BEFORE DELETE ON "RatePlan" FOR EACH ROW EXECUTE FUNCTION rb_guard_rateplan_history();
CREATE TRIGGER "rb_guard_rateplan_history" BEFORE UPDATE OR DELETE ON "RatePlanRevision" FOR EACH ROW EXECUTE FUNCTION rb_guard_rateplan_history();
CREATE TRIGGER "rb_guard_rateplan_history" BEFORE UPDATE OR DELETE ON "RatePlanGroupPrice" FOR EACH ROW EXECUTE FUNCTION rb_guard_rateplan_history();
CREATE TRIGGER "rb_guard_rateplan_history" BEFORE UPDATE OR DELETE ON "RatePlanPriceTier" FOR EACH ROW EXECUTE FUNCTION rb_guard_rateplan_history();

-- Jeder Gruppenpreis hat mindestens eine Preisstufe (geprüft am Ende der Transaktion)
CREATE OR REPLACE FUNCTION rb_check_rateplan_group_tiers() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM "RatePlanGroupPrice" g WHERE g."id" = NEW."id") AND NOT EXISTS (SELECT 1 FROM "RatePlanPriceTier" t WHERE t."groupPriceId" = NEW."id") THEN
    RAISE EXCEPTION 'RB_DOMAIN: Jede Fahrzeuggruppe eines Tarifs braucht mindestens eine Preisstufe';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "rb_check_rateplan_group_tiers" AFTER INSERT ON "RatePlanGroupPrice" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rb_check_rateplan_group_tiers();

-- Standardtarif einer Gruppe: gleicher Mandant, aktiv und der Gruppe in der aktuellen Revision zugeordnet
CREATE OR REPLACE FUNCTION rb_check_group_default_rateplan() RETURNS trigger AS $$
DECLARE t text; act boolean; rev text;
BEGIN
  IF rb_purge_allowed() OR NEW."defaultRatePlanId" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW."defaultRatePlanId" IS NOT DISTINCT FROM OLD."defaultRatePlanId" THEN RETURN NEW; END IF;
  SELECT "tenantId", "active", "currentRevisionId" INTO t, act, rev FROM "RatePlan" WHERE "id" = NEW."defaultRatePlanId";
  IF t IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Der Standardtarif gehört zu einem anderen Mandanten'; END IF;
  IF NOT act THEN RAISE EXCEPTION 'RB_DOMAIN: Ein deaktivierter Tarif kann nicht Standardtarif sein'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "RatePlanGroupPrice" WHERE "revisionId" = rev AND "groupId" = NEW."id") THEN
    RAISE EXCEPTION 'RB_DOMAIN: Der Standardtarif ist dieser Fahrzeuggruppe nicht zugeordnet';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_check_group_default_rateplan" BEFORE INSERT OR UPDATE ON "VehicleGroup" FOR EACH ROW EXECUTE FUNCTION rb_check_group_default_rateplan();

-- Ein Tarif, der Standard einer Gruppe ist, bleibt aktiv und dieser Gruppe zugeordnet (vorher Standard aufheben)
CREATE OR REPLACE FUNCTION rb_check_rateplan_defaults() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF (NOT NEW."active" AND OLD."active") AND EXISTS (SELECT 1 FROM "VehicleGroup" WHERE "defaultRatePlanId" = NEW."id") THEN
    RAISE EXCEPTION 'RB_DOMAIN: Der Tarif ist Standardtarif einer Fahrzeuggruppe; bitte zuerst den Standard ändern';
  END IF;
  IF NEW."currentRevisionId" IS DISTINCT FROM OLD."currentRevisionId" AND EXISTS (
    SELECT 1 FROM "VehicleGroup" vg WHERE vg."defaultRatePlanId" = NEW."id"
      AND NOT EXISTS (SELECT 1 FROM "RatePlanGroupPrice" gp WHERE gp."revisionId" = NEW."currentRevisionId" AND gp."groupId" = vg."id")) THEN
    RAISE EXCEPTION 'RB_DOMAIN: Eine Fahrzeuggruppe mit diesem Standardtarif ist in der neuen Revision nicht mehr zugeordnet';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_check_rateplan_defaults" BEFORE UPDATE ON "RatePlan" FOR EACH ROW EXECUTE FUNCTION rb_check_rateplan_defaults();

-- Buchung: Tarif und Revision gehören zum Mandanten der Buchung, die Revision zum Tarif
CREATE OR REPLACE FUNCTION rb_check_booking_tariff() RETURNS trigger AS $$
DECLARE t text; p text;
BEGIN
  IF rb_purge_allowed() OR NEW."ratePlanId" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW."ratePlanId" IS NOT DISTINCT FROM OLD."ratePlanId" AND NEW."ratePlanRevisionId" IS NOT DISTINCT FROM OLD."ratePlanRevisionId" THEN RETURN NEW; END IF;
  SELECT "tenantId" INTO t FROM "RatePlan" WHERE "id" = NEW."ratePlanId";
  IF t IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Der Tarif gehört zu einem anderen Mandanten'; END IF;
  SELECT "tenantId", "ratePlanId" INTO t, p FROM "RatePlanRevision" WHERE "id" = NEW."ratePlanRevisionId";
  IF t IS DISTINCT FROM NEW."tenantId" OR p IS DISTINCT FROM NEW."ratePlanId" THEN RAISE EXCEPTION 'RB_TENANT: Die Tarifrevision gehört nicht zu diesem Tarif'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_check_booking_tariff" BEFORE INSERT OR UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION rb_check_booking_tariff();

-- ===========================================================================
-- Übernahme der bisherigen Preise: je Mandant mit Fahrzeuggruppen ein Tarif „Standard“ (Revision 1). Exakt die bisherigen
-- Werte (Cent = Euro × 100, kaufmännisch – Altwerte sind zweistellig). Fahrzeuge, deren Preise, Kaution oder Kilometer von
-- ihrer Gruppe abweichen, bekommen eine Fahrzeugabweichung. Bestehende Buchungen, Verträge, Rechnungen bleiben unverändert.
-- ===========================================================================
DO $$
DECLARE
  ten record; grp record; veh record; first_grp record;
  plan_id text; rev_id text; gp_id text; ov_id text;
  t_km_policy text; t_dep integer;
  g_km_policy text; g_dep integer; g_km integer; g_extra integer;
  v_km_policy text; v_dep integer; v_km integer; v_extra integer;
  d integer; gc integer; vc integer; need boolean;
  tier_days integer[] := ARRAY[1, 5, 7, 30];
  tier_labels text[] := ARRAY['Tag', 'Woche (5 Tage)', 'Kalenderwoche (7 Tage)', 'Monat (30 Tage)'];
BEGIN
  -- nur Mandanten mit Fahrzeuggruppen und noch ohne Tarif (eine wiederholte Ausführung legt nichts doppelt an)
  FOR ten IN SELECT t.* FROM "Tenant" t WHERE EXISTS (SELECT 1 FROM "VehicleGroup" g WHERE g."tenantId" = t."id") AND NOT EXISTS (SELECT 1 FROM "RatePlan" rp WHERE rp."tenantId" = t."id") ORDER BY t."id" LOOP
    plan_id := 'rp' || substr(md5(ten."id" || ':standard'), 1, 23);
    rev_id := 'rr' || substr(md5(ten."id" || ':standard:1'), 1, 23);
    -- Kaution des Mandanten (Geschäftsregel), sonst 0
    t_dep := COALESCE(NULLIF(ten."businessRules"->>'depositCents', '')::integer, 0);
    -- Kilometerregel: nur „unbegrenzt“ wird übernommen; geerbtes „individuell“ war im Vertragsentwurf stets Freikilometer
    SELECT g.* INTO first_grp FROM "VehicleGroup" g WHERE g."tenantId" = ten."id" ORDER BY g."sortOrder", g."name", g."id" LIMIT 1;
    t_km_policy := CASE WHEN COALESCE(first_grp."businessRules"->>'kmPolicy', ten."businessRules"->>'kmPolicy') = 'UNLIMITED' THEN 'UNLIMITED' ELSE 'FREE_KILOMETERS' END;

    INSERT INTO "RatePlan" ("id", "tenantId", "name", "description", "active", "sortOrder", "createdByName", "updatedAt", "updatedByName")
    VALUES (plan_id, ten."id", 'Standard', 'Aus den bisherigen Fahrzeugpreisen übernommen (Befehl 29).', false, 0, 'Migration Befehl 29', CURRENT_TIMESTAMP, 'Migration Befehl 29');
    INSERT INTO "RatePlanRevision" ("id", "tenantId", "ratePlanId", "revision", "kmPolicy", "kmIncludedPerDay", "extraKmRateCents", "depositCents", "note", "createdByName")
    VALUES (rev_id, ten."id", plan_id, 1, t_km_policy,
      CASE WHEN t_km_policy = 'FREE_KILOMETERS' THEN first_grp."kmIncludedPerDay" END,
      CASE WHEN t_km_policy = 'FREE_KILOMETERS' THEN round(first_grp."extraKmRate" * 100)::integer END,
      CASE WHEN round(first_grp."deposit" * 100) > 0 THEN round(first_grp."deposit" * 100)::integer ELSE t_dep END,
      'Übernahme der bisherigen Preise', 'Migration Befehl 29');

    FOR grp IN SELECT g.* FROM "VehicleGroup" g WHERE g."tenantId" = ten."id" ORDER BY g."sortOrder", g."name", g."id" LOOP
      gp_id := 'rg' || substr(md5(rev_id || ':' || grp."id"), 1, 23);
      g_km_policy := CASE WHEN COALESCE(grp."businessRules"->>'kmPolicy', ten."businessRules"->>'kmPolicy') = 'UNLIMITED' THEN 'UNLIMITED' ELSE 'FREE_KILOMETERS' END;
      g_dep := CASE WHEN round(grp."deposit" * 100) > 0 THEN round(grp."deposit" * 100)::integer ELSE t_dep END;
      g_km := grp."kmIncludedPerDay";
      g_extra := round(grp."extraKmRate" * 100)::integer;
      INSERT INTO "RatePlanGroupPrice" ("id", "tenantId", "revisionId", "groupId", "depositCents", "kmPolicy", "kmIncludedPerDay", "extraKmRateCents")
      SELECT gp_id, ten."id", rev_id, grp."id",
        NULLIF(g_dep, r."depositCents"),
        CASE WHEN g_km_policy IS DISTINCT FROM r."kmPolicy" OR (g_km_policy = 'FREE_KILOMETERS' AND (g_km IS DISTINCT FROM r."kmIncludedPerDay" OR g_extra IS DISTINCT FROM r."extraKmRateCents")) THEN g_km_policy END,
        CASE WHEN g_km_policy = 'FREE_KILOMETERS' AND (g_km_policy IS DISTINCT FROM r."kmPolicy" OR g_km IS DISTINCT FROM r."kmIncludedPerDay" OR g_extra IS DISTINCT FROM r."extraKmRateCents") THEN g_km END,
        CASE WHEN g_km_policy = 'FREE_KILOMETERS' AND (g_km_policy IS DISTINCT FROM r."kmPolicy" OR g_km IS DISTINCT FROM r."kmIncludedPerDay" OR g_extra IS DISTINCT FROM r."extraKmRateCents") THEN g_extra END
      FROM "RatePlanRevision" r WHERE r."id" = rev_id;
      -- Preisstufen wie bisher: Tag immer, 5/7/30 Tage nur mit Preis > 0
      FOR i IN 1..4 LOOP
        d := tier_days[i];
        gc := CASE d WHEN 1 THEN round(grp."dailyRate" * 100) WHEN 5 THEN round(COALESCE(grp."workWeekRate", 0) * 100) WHEN 7 THEN round(COALESCE(grp."weeklyRate", 0) * 100) ELSE round(COALESCE(grp."monthlyRate", 0) * 100) END;
        IF d = 1 OR gc > 0 THEN
          INSERT INTO "RatePlanPriceTier" ("id", "tenantId", "groupPriceId", "durationDays", "priceCents", "label")
          VALUES ('rt' || substr(md5(gp_id || ':' || d), 1, 23), ten."id", gp_id, d, GREATEST(gc, 0), tier_labels[i]);
        END IF;
      END LOOP;

      -- Fahrzeuge der Gruppe: abweichende Werte als Fahrzeugabweichung festhalten (nichts geht verloren)
      FOR veh IN SELECT v.* FROM "Vehicle" v WHERE v."groupId" = grp."id" ORDER BY v."id" LOOP
        ov_id := 'rv' || substr(md5(plan_id || ':' || veh."id"), 1, 23);
        need := false;
        v_km_policy := CASE WHEN COALESCE(veh."businessRules"->>'kmPolicy', grp."businessRules"->>'kmPolicy', ten."businessRules"->>'kmPolicy') = 'UNLIMITED' THEN 'UNLIMITED' ELSE 'FREE_KILOMETERS' END;
        v_dep := CASE WHEN round(veh."deposit" * 100) > 0 THEN round(veh."deposit" * 100)::integer ELSE g_dep END;
        v_km := veh."kmIncludedPerDay";
        v_extra := round(veh."extraKmRate" * 100)::integer;
        FOR i IN 1..4 LOOP
          d := tier_days[i];
          gc := CASE d WHEN 1 THEN round(grp."dailyRate" * 100) WHEN 5 THEN round(COALESCE(grp."workWeekRate", 0) * 100) WHEN 7 THEN round(COALESCE(grp."weeklyRate", 0) * 100) ELSE round(COALESCE(grp."monthlyRate", 0) * 100) END;
          vc := CASE d WHEN 1 THEN round(veh."dailyRate" * 100) WHEN 5 THEN round(COALESCE(veh."workWeekRate", 0) * 100) WHEN 7 THEN round(COALESCE(veh."weeklyRate", 0) * 100) ELSE round(COALESCE(veh."monthlyRate", 0) * 100) END;
          IF (d = 1 AND vc IS DISTINCT FROM gc) OR (d > 1 AND GREATEST(vc, 0) IS DISTINCT FROM GREATEST(gc, 0)) THEN need := true; END IF;
        END LOOP;
        IF v_dep IS DISTINCT FROM g_dep OR v_km_policy IS DISTINCT FROM g_km_policy OR (v_km_policy = 'FREE_KILOMETERS' AND (v_km IS DISTINCT FROM g_km OR v_extra IS DISTINCT FROM g_extra)) THEN need := true; END IF;
        IF need THEN
          INSERT INTO "VehicleRateOverride" ("id", "tenantId", "vehicleId", "ratePlanId", "depositCents", "kmPolicy", "kmIncludedPerDay", "extraKmRateCents", "note", "updatedAt", "updatedByName")
          VALUES (ov_id, ten."id", veh."id", plan_id,
            NULLIF(v_dep, g_dep),
            CASE WHEN v_km_policy IS DISTINCT FROM g_km_policy OR (v_km_policy = 'FREE_KILOMETERS' AND (v_km IS DISTINCT FROM g_km OR v_extra IS DISTINCT FROM g_extra)) THEN v_km_policy END,
            CASE WHEN v_km_policy = 'FREE_KILOMETERS' AND (v_km_policy IS DISTINCT FROM g_km_policy OR v_km IS DISTINCT FROM g_km OR v_extra IS DISTINCT FROM g_extra) THEN v_km END,
            CASE WHEN v_km_policy = 'FREE_KILOMETERS' AND (v_km_policy IS DISTINCT FROM g_km_policy OR v_km IS DISTINCT FROM g_km OR v_extra IS DISTINCT FROM g_extra) THEN v_extra END,
            'Übernommen aus den bisherigen Fahrzeugpreisen', CURRENT_TIMESTAMP, 'Migration Befehl 29');
          FOR i IN 1..4 LOOP
            d := tier_days[i];
            gc := CASE d WHEN 1 THEN round(grp."dailyRate" * 100) WHEN 5 THEN round(COALESCE(grp."workWeekRate", 0) * 100) WHEN 7 THEN round(COALESCE(grp."weeklyRate", 0) * 100) ELSE round(COALESCE(grp."monthlyRate", 0) * 100) END;
            vc := CASE d WHEN 1 THEN round(veh."dailyRate" * 100) WHEN 5 THEN round(COALESCE(veh."workWeekRate", 0) * 100) WHEN 7 THEN round(COALESCE(veh."weeklyRate", 0) * 100) ELSE round(COALESCE(veh."monthlyRate", 0) * 100) END;
            IF d = 1 AND vc IS DISTINCT FROM gc THEN
              INSERT INTO "VehicleRateOverrideTier" ("id", "tenantId", "overrideId", "durationDays", "priceCents") VALUES ('ro' || substr(md5(ov_id || ':' || d), 1, 23), ten."id", ov_id, d, GREATEST(vc, 0));
            ELSIF d > 1 AND GREATEST(vc, 0) IS DISTINCT FROM GREATEST(gc, 0) THEN
              -- Fahrzeug ohne diese Stufe (0/leer) bei vorhandener Gruppenstufe: NULL = nicht angeboten
              INSERT INTO "VehicleRateOverrideTier" ("id", "tenantId", "overrideId", "durationDays", "priceCents") VALUES ('ro' || substr(md5(ov_id || ':' || d), 1, 23), ten."id", ov_id, d, CASE WHEN vc > 0 THEN vc END);
            END IF;
          END LOOP;
        END IF;
      END LOOP;
    END LOOP;

    UPDATE "RatePlan" SET "currentRevisionId" = rev_id, "active" = true WHERE "id" = plan_id;
    UPDATE "VehicleGroup" SET "defaultRatePlanId" = plan_id WHERE "tenantId" = ten."id";
  END LOOP;
END $$;
