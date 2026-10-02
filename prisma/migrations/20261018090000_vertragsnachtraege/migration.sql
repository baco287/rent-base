-- Befehl 25: Vertragsnachträge. Ein unterschriebener Mietvertrag bleibt unverändert; jede spätere Vereinbarung ist ein
-- eigener, versiegelter Nachtrag (ContractAmendment). Rein additiv: neue Tabelle, neue optionale Bezüge, nachgezogene
-- Prüfregeln. Bestehende Verträge, Buchungen, Fahrer, Kautionen, Rechnungen und Dokumente werden nicht verändert.

CREATE TABLE "ContractAmendment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "number" TEXT,
    "sequenceNo" INTEGER,
    "newEndAt" TIMESTAMP(3),
    "priceDeltaCents" INTEGER,
    "priceProposalCents" INTEGER,
    "priceReason" TEXT,
    "newKmIncludedPerDay" INTEGER,
    "newExtraKmRate" DECIMAL(65,30),
    "newDepositCents" INTEGER,
    "newReturnLocation" TEXT,
    "agreementText" TEXT,
    "snapshot" JSONB,
    "contentHash" TEXT,
    "signedAt" TIMESTAMP(3),
    "signedById" TEXT,
    "signedByName" TEXT,
    "settlementInvoiceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "discardedAt" TIMESTAMP(3),
    CONSTRAINT "ContractAmendment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContractAmendment_tenantId_number_key" ON "ContractAmendment"("tenantId", "number");
CREATE UNIQUE INDEX "ContractAmendment_tenantId_idempotencyKey_key" ON "ContractAmendment"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "ContractAmendment_tenantId_contractId_sequenceNo_key" ON "ContractAmendment"("tenantId", "contractId", "sequenceNo");
CREATE UNIQUE INDEX "ContractAmendment_settlementInvoiceId_key" ON "ContractAmendment"("settlementInvoiceId");
CREATE INDEX "ContractAmendment_tenantId_bookingId_idx" ON "ContractAmendment"("tenantId", "bookingId");
CREATE INDEX "ContractAmendment_tenantId_contractId_status_idx" ON "ContractAmendment"("tenantId", "contractId", "status");
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "ContractAmendment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "ContractAmendment_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "ContractAmendment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "ContractAmendment_settlementInvoiceId_fkey" FOREIGN KEY ("settlementInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_status" CHECK ("status" IN ('DRAFT', 'SIGNED', 'DISCARDED'));
-- Nummer, Reihenfolge, Snapshot, Prüfsumme und Zeitpunkt gibt es genau ab der Unterschrift
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_sealed" CHECK (("status" = 'SIGNED') = ("number" IS NOT NULL AND "sequenceNo" IS NOT NULL AND "snapshot" IS NOT NULL AND "contentHash" IS NOT NULL AND "signedAt" IS NOT NULL));
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_values" CHECK (("newKmIncludedPerDay" IS NULL OR "newKmIncludedPerDay" >= 0) AND ("newExtraKmRate" IS NULL OR "newExtraKmRate" >= 0) AND ("newDepositCents" IS NULL OR "newDepositCents" >= 0) AND ("sequenceNo" IS NULL OR "sequenceNo" >= 1));

-- Fahrer: Aufnahme oder Herausnahme durch einen Nachtrag (historische Zeilen bleiben, nichts wird gelöscht)
ALTER TABLE "ContractDriver" ADD COLUMN "addedByAmendmentId" TEXT;
ALTER TABLE "ContractDriver" ADD COLUMN "removedByAmendmentId" TEXT;
ALTER TABLE "ContractDriver" ADD CONSTRAINT "ContractDriver_addedByAmendmentId_fkey" FOREIGN KEY ("addedByAmendmentId") REFERENCES "ContractAmendment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContractDriver" ADD CONSTRAINT "ContractDriver_removedByAmendmentId_fkey" FOREIGN KEY ("removedByAmendmentId") REFERENCES "ContractAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContractDriver" ADD CONSTRAINT "rb_contract_driver_amendment" CHECK ("addedByAmendmentId" IS NULL OR "removedByAmendmentId" IS NULL OR "addedByAmendmentId" <> "removedByAmendmentId");
CREATE INDEX "ContractDriver_tenantId_addedByAmendmentId_idx" ON "ContractDriver"("tenantId", "addedByAmendmentId");

-- Unterschriften, Dokumente, Versandprotokoll und Rechnungspositionen: Bezug auf den Nachtrag
ALTER TABLE "Signature" ADD COLUMN "amendmentId" TEXT;
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "ContractAmendment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Signature_tenantId_amendmentId_idx" ON "Signature"("tenantId", "amendmentId");
ALTER TABLE "Signature" DROP CONSTRAINT "Signature_has_parent";
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_has_parent" CHECK ((("handoverId" IS NOT NULL)::int + ("contractId" IS NOT NULL)::int + ("keyDropId" IS NOT NULL)::int + ("amendmentId" IS NOT NULL)::int) = 1 OR rb_purge_allowed());

ALTER TABLE "Document" ADD COLUMN "amendmentId" TEXT;
ALTER TABLE "Document" ADD CONSTRAINT "Document_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "ContractAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Document_tenantId_amendmentId_idx" ON "Document"("tenantId", "amendmentId");
DROP INDEX IF EXISTS "rb_document_one_per_version";
CREATE UNIQUE INDEX "rb_document_one_per_version" ON "Document" ("tenantId", "type", COALESCE("contractId", ''), COALESCE("handoverId", ''), COALESCE("invoiceId", ''), COALESCE("invoiceVersionId", ''), COALESCE("payoutId", ''), COALESCE("dunningNoticeId", ''), COALESCE("amendmentId", ''), "version");

ALTER TABLE "EmailLog" ADD COLUMN "amendmentId" TEXT;
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "ContractAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EmailLog_tenantId_amendmentId_idx" ON "EmailLog"("tenantId", "amendmentId");

ALTER TABLE "InvoiceVersionItem" ADD COLUMN "amendmentId" TEXT;
ALTER TABLE "InvoiceVersionItem" ADD CONSTRAINT "InvoiceVersionItem_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "ContractAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "InvoiceVersionItem_tenantId_amendmentId_idx" ON "InvoiceVersionItem"("tenantId", "amendmentId");

-- Fahrerprüfung: Kontext ist entweder die Übergabe (Entwurf) oder ein Nachtrag (Entwurf) – dieselbe Prüfung, kein zweiter Weg
ALTER TABLE "DriverVerification" ALTER COLUMN "handoverId" DROP NOT NULL;
ALTER TABLE "DriverVerification" ADD COLUMN "amendmentId" TEXT;
ALTER TABLE "DriverVerification" ADD CONSTRAINT "DriverVerification_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "ContractAmendment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DriverVerification" ADD CONSTRAINT "rb_driver_verification_context" CHECK ((("handoverId" IS NOT NULL)::int + ("amendmentId" IS NOT NULL)::int) = 1);
CREATE UNIQUE INDEX "DriverVerification_amendment_driver_version_key" ON "DriverVerification"("tenantId", "amendmentId", "contractDriverId", "version") WHERE "amendmentId" IS NOT NULL;
CREATE INDEX "DriverVerification_tenantId_amendmentId_idx" ON "DriverVerification"("tenantId", "amendmentId");

-- ---------------------------------------------------------------------------
-- Nachtrag: Bezüge prüfen (Mandant, Vertrag unterschrieben, Buchung des Vertrags)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rb_check_amendment() RETURNS trigger AS $$
DECLARE
  c_tenant text; c_booking text; c_status text; i_tenant text;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  SELECT "tenantId", "bookingId", "status" INTO c_tenant, c_booking, c_status FROM "RentalContract" WHERE "id" = NEW."contractId";
  IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Nachtrag und Vertrag gehören zu verschiedenen Mandanten'; END IF;
  IF c_booking IS DISTINCT FROM NEW."bookingId" THEN RAISE EXCEPTION 'RB_DOMAIN: Der Nachtrag gehört nicht zur Buchung des Vertrags'; END IF;
  IF TG_OP = 'INSERT' AND c_status <> 'SIGNED' THEN RAISE EXCEPTION 'RB_DOMAIN: Nachträge gibt es nur zu unterschriebenen Mietverträgen'; END IF;
  IF NEW."settlementInvoiceId" IS NOT NULL THEN
    SELECT "tenantId" INTO i_tenant FROM "Invoice" WHERE "id" = NEW."settlementInvoiceId";
    IF i_tenant IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Abrechnungsbeleg gehört zu einem anderen Mandanten'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_check_amendment" BEFORE INSERT OR UPDATE ON "ContractAmendment" FOR EACH ROW EXECUTE FUNCTION rb_check_amendment();

-- Unveränderlich nach Unterschrift (nur der Abrechnungsbezug darf einmalig gesetzt werden); verworfen bleibt verworfen; nie löschen außer Entwurf
CREATE OR REPLACE FUNCTION rb_guard_amendment() RETURNS trigger AS $$
DECLARE
  o jsonb; n jsonb;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Ein unterschriebener oder verworfener Nachtrag wird nicht gelöscht'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'SIGNED' THEN
    o := to_jsonb(OLD) - 'settlementInvoiceId' - 'updatedAt';
    n := to_jsonb(NEW) - 'settlementInvoiceId' - 'updatedAt';
    IF o <> n THEN RAISE EXCEPTION 'RB_IMMUTABLE: Ein unterschriebener Nachtrag bleibt unverändert; Korrektur nur durch einen neuen Nachtrag'; END IF;
    IF OLD."settlementInvoiceId" IS NOT NULL AND NEW."settlementInvoiceId" IS DISTINCT FROM OLD."settlementInvoiceId" THEN RAISE EXCEPTION 'RB_IMMUTABLE: Der Abrechnungsbezug eines Nachtrags ist fest'; END IF;
  ELSIF OLD."status" = 'DISCARDED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Ein verworfener Nachtrag wird nicht mehr geändert';
  END IF;
  IF OLD."tenantId" <> NEW."tenantId" OR OLD."contractId" <> NEW."contractId" OR OLD."bookingId" <> NEW."bookingId" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Zuordnung eines Nachtrags ist fest';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_guard_amendment" BEFORE UPDATE OR DELETE ON "ContractAmendment" FOR EACH ROW EXECUTE FUNCTION rb_guard_amendment();

-- ---------------------------------------------------------------------------
-- Fahrer eines unterschriebenen Vertrags: Änderungen nur über einen Nachtrag im Entwurf
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rb_amendment_is_draft_of(aid text, cid text) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "ContractAmendment" WHERE "id" = aid AND "contractId" = cid AND "status" = 'DRAFT');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION rb_guard_contract_child() RETURNS trigger AS $$
DECLARE
  cid text;
  st text;
  o jsonb; n jsonb;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN cid := NEW."contractId"; ELSE cid := OLD."contractId"; END IF;
  SELECT "status" INTO st FROM "RentalContract" WHERE "id" = cid;
  IF st IS NULL OR st = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Befehl 25: unterschriebener Vertrag – Aufnahme/Herausnahme nur durch einen Nachtrag im Entwurf
  IF TG_OP = 'INSERT' THEN
    IF NEW."addedByAmendmentId" IS NULL OR NOT rb_amendment_is_draft_of(NEW."addedByAmendmentId", cid) THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Fahrerdaten eines unterschriebenen Vertrags sind gesperrt; Zusatzfahrer nur über einen Nachtrag';
    END IF;
    IF NEW."removedByAmendmentId" IS NOT NULL THEN RAISE EXCEPTION 'RB_DOMAIN: Ein neu aufgenommener Fahrer kann nicht zugleich herausgenommen werden'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."addedByAmendmentId" IS NULL OR NOT rb_amendment_is_draft_of(OLD."addedByAmendmentId", cid) THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Fahrerdaten eines unterschriebenen Vertrags sind gesperrt';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: nur die Herausnahme durch einen Nachtrag im Entwurf darf gesetzt oder (solange Entwurf) zurückgenommen werden
  o := to_jsonb(OLD) - 'removedByAmendmentId';
  n := to_jsonb(NEW) - 'removedByAmendmentId';
  IF o <> n THEN RAISE EXCEPTION 'RB_IMMUTABLE: Fahrerdaten eines unterschriebenen Vertrags sind gesperrt'; END IF;
  IF NEW."removedByAmendmentId" IS DISTINCT FROM OLD."removedByAmendmentId" THEN
    IF OLD."removedByAmendmentId" IS NOT NULL AND NOT rb_amendment_is_draft_of(OLD."removedByAmendmentId", cid) THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Die Herausnahme durch einen unterschriebenen Nachtrag ist fest';
    END IF;
    IF NEW."removedByAmendmentId" IS NOT NULL AND NOT rb_amendment_is_draft_of(NEW."removedByAmendmentId", cid) THEN
      RAISE EXCEPTION 'RB_DOMAIN: Herausnahme nur durch einen Nachtrag im Entwurf';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Unterschrift: Nachtrag als weiteres Elternobjekt (nur im Entwurf anleg- und löschbar)
CREATE OR REPLACE FUNCTION rb_guard_signature() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Unterschriften können nicht geändert werden';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."handoverId" IS NOT NULL THEN
      SELECT "status" INTO st FROM "Handover" WHERE "id" = NEW."handoverId";
      IF st = 'FINALIZED' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Protokoll ist bereits finalisiert'; END IF;
    END IF;
    IF NEW."contractId" IS NOT NULL THEN
      SELECT "status" INTO st FROM "RentalContract" WHERE "id" = NEW."contractId";
      IF st <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Vertrag ist bereits unterschrieben'; END IF;
    END IF;
    IF NEW."amendmentId" IS NOT NULL THEN
      SELECT "status" INTO st FROM "ContractAmendment" WHERE "id" = NEW."amendmentId";
      IF st <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Nachtrag ist bereits unterschrieben oder verworfen'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."handoverId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "Handover" WHERE "id" = OLD."handoverId";
    IF st = 'FINALIZED' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines finalisierten Protokolls'; END IF;
  END IF;
  IF OLD."contractId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "RentalContract" WHERE "id" = OLD."contractId";
    IF st <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines unterschriebenen Vertrags'; END IF;
  END IF;
  IF OLD."amendmentId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "ContractAmendment" WHERE "id" = OLD."amendmentId";
    IF st <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines unterschriebenen Nachtrags'; END IF;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

-- Fahrerprüfung: Kontext Übergabe (Entwurf) oder Nachtrag (Entwurf); Fahrer muss zum Vertrag des Kontexts gehören
CREATE OR REPLACE FUNCTION rb_check_driver_verification() RETURNS trigger AS $$
DECLARE
  st text; hb text; ht text; hc text; dc text; dt text;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF NEW."handoverId" IS NOT NULL THEN
    SELECT "status", "bookingId", "tenantId" INTO st, hb, ht FROM "Handover" WHERE "id" = NEW."handoverId";
    IF st IS NULL OR ht <> NEW."tenantId" OR hb <> NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_TENANT: Prüfvermerk gehört nicht zu diesem Protokoll oder Mandanten';
    END IF;
    IF TG_OP = 'INSERT' AND st <> 'DRAFT' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Zu einem abgeschlossenen Protokoll entstehen keine Prüfvermerke';
    END IF;
  ELSE
    SELECT "status", "bookingId", "tenantId", "contractId" INTO st, hb, ht, hc FROM "ContractAmendment" WHERE "id" = NEW."amendmentId";
    IF st IS NULL OR ht <> NEW."tenantId" OR hb <> NEW."bookingId" OR hc <> NEW."contractId" THEN
      RAISE EXCEPTION 'RB_TENANT: Prüfvermerk gehört nicht zu diesem Nachtrag oder Mandanten';
    END IF;
    IF TG_OP = 'INSERT' AND st <> 'DRAFT' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Zu einem unterschriebenen oder verworfenen Nachtrag entstehen keine Prüfvermerke';
    END IF;
  END IF;
  SELECT "contractId", "tenantId" INTO dc, dt FROM "ContractDriver" WHERE "id" = NEW."contractDriverId";
  IF dc IS NULL OR dt <> NEW."tenantId" OR dc <> NEW."contractId" THEN
    RAISE EXCEPTION 'RB_DOMAIN: Der Fahrer gehört nicht zu diesem Vertrag';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rb_guard_driver_verification() RETURNS trigger AS $$
DECLARE
  o jsonb; n jsonb;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Prüfvermerke werden nicht gelöscht';
  END IF;
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."handoverId" IS DISTINCT FROM OLD."handoverId" OR NEW."amendmentId" IS DISTINCT FROM OLD."amendmentId" OR NEW."contractDriverId" <> OLD."contractDriverId" OR NEW."bookingId" <> OLD."bookingId" OR NEW."contractId" <> OLD."contractId" OR NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Zuordnung eines Prüfvermerks ist fest';
  END IF;
  IF OLD."status" = 'CONFIRMED' THEN
    o := to_jsonb(OLD) - 'supersededById' - 'updatedAt';
    n := to_jsonb(NEW) - 'supersededById' - 'updatedAt';
    IF o <> n THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Ein bestätigter Prüfvermerk wird nicht geändert; Korrektur nur als neue Fassung';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Kaution: die vereinbarte Höhe ändert sich nur auf den Wert eines unterschriebenen Nachtrags derselben Buchung
CREATE OR REPLACE FUNCTION rb_check_deposit() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  c_tenant text;
  c_booking text;
BEGIN
  SELECT "tenantId" INTO b_tenant FROM "Booking" WHERE "id" = NEW."bookingId";
  IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Kaution und Buchung gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."contractId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId" INTO c_tenant, c_booking FROM "RentalContract" WHERE "id" = NEW."contractId";
    IF c_tenant IS DISTINCT FROM NEW."tenantId" OR c_booking IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_TENANT: Kaution und Vertrag passen nicht zusammen';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT rb_purge_allowed() THEN
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" <> OLD."bookingId"
       OR (OLD."contractId" IS NOT NULL AND NEW."contractId" IS DISTINCT FROM OLD."contractId") THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Vereinbarte Kaution und Zuordnung sind fest';
    END IF;
    IF NEW."expectedAmountCents" <> OLD."expectedAmountCents" AND NOT EXISTS (
      SELECT 1 FROM "ContractAmendment" a WHERE a."tenantId" = NEW."tenantId" AND a."bookingId" = NEW."bookingId" AND a."status" = 'SIGNED' AND a."newDepositCents" = NEW."expectedAmountCents"
    ) THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Die vereinbarte Kaution ändert sich nur durch einen unterschriebenen Nachtrag';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
