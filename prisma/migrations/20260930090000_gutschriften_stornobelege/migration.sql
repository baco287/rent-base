-- Phase 17: Gutschriften, Stornobelege und Kundenguthaben.
-- Rein additiv: neue Spalten (mit Standardwerten), neue Indizes, neue Prüfungen. Bestehende Rechnungen, Fassungen,
-- Positionen, Zahlungen, Dokumente und Prüfsummen werden nicht verändert; keine Rechnung erhält einen künstlichen Status.
--
-- Fachliche Grundregeln (auch im Code, hier als letzte Sicherung):
-- - Ein Gegenbeleg (Gutschrift, Stornobeleg) ist ein eigener Invoice-Datensatz mit documentType CREDIT_NOTE bzw. CANCELLATION,
--   eigener Nummer, positiven Beträgen und Bezug auf genau eine abgeschlossene Originalrechnung (nie auf einen Gegenbeleg).
-- - Das Original wird nie verändert: keine negativen Positionen, keine Nummernänderung, kein Fassungswechsel nach einem Gegenbeleg.
-- - Nie mehr gutschreiben als offen: Summe der abgeschlossenen Gegenbelege ≤ Betrag der aktuellen Originalfassung, je Originalposition
--   und je Steuersatz; nach vollständiger Neutralisierung (Storno oder Gutschriften in voller Höhe) kein weiterer Gegenbeleg.
-- - Ein Stornobeleg neutralisiert genau den verbleibenden Betrag; höchstens ein abgeschlossener Storno je Rechnung.
-- - Zahlungen werden durch Gegenbelege nie verändert; Zahlungen gibt es nur zu Rechnungen, nie zu Gegenbelegen.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "documentType" TEXT NOT NULL DEFAULT 'INVOICE',
ADD COLUMN     "originalInvoiceId" TEXT,
ADD COLUMN     "originalSnapshot" JSONB,
ADD COLUMN     "originalVersionId" TEXT;

-- AlterTable
ALTER TABLE "InvoiceVersionItem" ADD COLUMN     "sourceInvoiceVersionItemId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "numberRanges" JSONB;

-- CreateIndex
CREATE INDEX "Invoice_tenantId_originalInvoiceId_idx" ON "Invoice"("tenantId", "originalInvoiceId");

-- CreateIndex
CREATE INDEX "InvoiceVersionItem_sourceInvoiceVersionItemId_idx" ON "InvoiceVersionItem"("sourceInvoiceVersionItemId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "Invoice"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_originalVersionId_fkey" FOREIGN KEY ("originalVersionId") REFERENCES "InvoiceVersion"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "InvoiceVersionItem" ADD CONSTRAINT "InvoiceVersionItem_sourceInvoiceVersionItemId_fkey" FOREIGN KEY ("sourceInvoiceVersionItemId") REFERENCES "InvoiceVersionItem"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- Integrität
-- ============================================================================

-- Belegart und Originalbezug: Rechnung ohne Bezug, Gegenbeleg immer mit Original, Bezugsfassung und Snapshot; kein Selbstbezug
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_document_type" CHECK ("documentType" IN ('INVOICE', 'CREDIT_NOTE', 'CANCELLATION'));
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_counter_refs" CHECK (
  ("documentType" = 'INVOICE' AND "originalInvoiceId" IS NULL AND "originalVersionId" IS NULL AND "originalSnapshot" IS NULL)
  OR ("documentType" <> 'INVOICE' AND "originalInvoiceId" IS NOT NULL AND "originalVersionId" IS NOT NULL AND "originalSnapshot" IS NOT NULL)
);
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_no_self_reference" CHECK ("originalInvoiceId" IS NULL OR "originalInvoiceId" <> "id");
-- Belegnummern der Gegenbelege: PREFIX-JJJJ-NNNNNN (bestehende Rechnungsnummern bleiben ungeprüft, sie ändern sich nicht)
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_counter_number" CHECK ("documentType" = 'INVOICE' OR "number" IS NULL OR "number" ~ '^[A-Z]{1,6}-[0-9]{4}-[0-9]{6}$');

-- Eindeutigkeiten der Rechnungen gelten nur für Rechnungen, nicht für ihre Gegenbelege
DROP INDEX IF EXISTS "rb_invoice_one_final_rental_per_booking";
CREATE UNIQUE INDEX "rb_invoice_one_final_rental_per_booking" ON "Invoice" ("tenantId", "bookingId") WHERE "status" = 'FINALIZED' AND "kind" = 'RENTAL' AND "documentType" = 'INVOICE';
DROP INDEX IF EXISTS "rb_invoice_one_per_damage_case";
CREATE UNIQUE INDEX "rb_invoice_one_per_damage_case" ON "Invoice" ("tenantId", "damageCaseId") WHERE "damageCaseId" IS NOT NULL AND "status" IN ('DRAFT', 'FINALIZED') AND "documentType" = 'INVOICE';
-- je Original höchstens ein abgeschlossener Stornobeleg (die Regel „ein offener Gegenbeleg-Entwurf je Rechnung“ gilt im Code
-- unter der Zeilensperre des Originals; ohne eindeutigen Index, damit parallele Abschlüsse gegen den Trigger geprüft werden können)
CREATE UNIQUE INDEX "rb_invoice_one_cancellation" ON "Invoice" ("tenantId", "originalInvoiceId") WHERE "documentType" = 'CANCELLATION' AND "status" = 'FINALIZED';

-- Nummernkreise des Mandanten: nur die drei bekannten Kreise, Präfix 1–6 Großbuchstaben, alle drei wirksamen Präfixe verschieden
CREATE OR REPLACE FUNCTION rb_number_ranges_valid(r jsonb) RETURNS boolean AS $$
DECLARE
  k text;
  p_inv text;
  p_cn text;
  p_st text;
BEGIN
  IF r IS NULL OR r = 'null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(r) <> 'object' THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_object_keys(r) LOOP
    IF k NOT IN ('invoice', 'creditNote', 'cancellation') THEN RETURN false; END IF;
    IF jsonb_typeof(r->k) <> 'object' OR jsonb_typeof(r->k->'prefix') <> 'string' THEN RETURN false; END IF;
    IF (r->k->>'prefix') !~ '^[A-Z]{1,6}$' THEN RETURN false; END IF;
  END LOOP;
  p_inv := COALESCE(r->'invoice'->>'prefix', 'RE');
  p_cn := COALESCE(r->'creditNote'->>'prefix', 'GS');
  p_st := COALESCE(r->'cancellation'->>'prefix', 'ST');
  RETURN p_inv <> p_cn AND p_inv <> p_st AND p_cn <> p_st;
END $$ LANGUAGE plpgsql IMMUTABLE;
ALTER TABLE "Tenant" ADD CONSTRAINT "rb_tenant_number_ranges" CHECK (rb_number_ranges_valid("numberRanges"));

-- Gegenbeleg: Original im selben Mandanten, selbst eine abgeschlossene Rechnung (nie ein Gegenbeleg), gleiche Buchung und Art;
-- Bezugsfassung gehört zum Original und ist abgeschlossen; Belegart und Bezug sind ab der Anlage fest.
-- Beim Abschluss (Sperre auf dem Original): Bezugsfassung ist die aktuelle Fassung, kein Storno vorhanden, Rest > 0,
-- eigener Betrag ≤ Rest (Storno: = Rest), je Originalposition und je Steuersatz keine Überschreitung.
CREATE OR REPLACE FUNCTION rb_check_counter_document() RETURNS trigger AS $$
DECLARE
  o record;
  ov record;
  v record;
  credited bigint;
  remaining bigint;
  bad record;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF NEW."documentType" = 'INVOICE' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND (NEW."documentType" <> OLD."documentType" OR NEW."originalInvoiceId" IS DISTINCT FROM OLD."originalInvoiceId" OR NEW."originalVersionId" IS DISTINCT FROM OLD."originalVersionId" OR NEW."originalSnapshot" IS DISTINCT FROM OLD."originalSnapshot") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Belegart und Originalbezug eines Gegenbelegs sind fest';
  END IF;
  SELECT "id", "tenantId", "documentType", "status", "number", "bookingId", "kind", "currentVersionId" INTO o FROM "Invoice" WHERE "id" = NEW."originalInvoiceId";
  IF o."id" IS NULL THEN
    RAISE EXCEPTION 'RB_DOMAIN: Die Originalrechnung wurde nicht gefunden';
  END IF;
  IF o."tenantId" <> NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Gegenbeleg und Originalrechnung gehören zu verschiedenen Mandanten';
  END IF;
  IF o."documentType" <> 'INVOICE' THEN
    RAISE EXCEPTION 'RB_DOMAIN: Ein Gegenbeleg bezieht sich immer auf eine Rechnung, nie auf eine Gutschrift oder einen Stornobeleg';
  END IF;
  IF o."status" <> 'FINALIZED' OR o."number" IS NULL OR o."currentVersionId" IS NULL THEN
    RAISE EXCEPTION 'RB_DOMAIN: Gutschriften und Stornobelege gibt es nur zu abgeschlossenen Rechnungen';
  END IF;
  IF o."bookingId" <> NEW."bookingId" OR o."kind" <> NEW."kind" THEN
    RAISE EXCEPTION 'RB_DOMAIN: Ein Gegenbeleg übernimmt Buchung und Rechnungsart der Originalrechnung';
  END IF;
  SELECT "invoiceId", "status" INTO ov FROM "InvoiceVersion" WHERE "id" = NEW."originalVersionId";
  IF ov."invoiceId" IS DISTINCT FROM o."id" OR ov."status" <> 'FINALIZED' THEN
    RAISE EXCEPTION 'RB_DOMAIN: Die Bezugsfassung gehört nicht zur Originalrechnung oder ist nicht abgeschlossen';
  END IF;
  IF NEW."status" = 'FINALIZED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'FINALIZED') THEN
    PERFORM 1 FROM "Invoice" WHERE "id" = o."id" FOR UPDATE;
    IF o."currentVersionId" IS DISTINCT FROM NEW."originalVersionId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rechnung % hat inzwischen eine neuere Fassung; der Entwurf beruht auf einer ersetzten Fassung', o."number";
    END IF;
    IF NEW."number" IS NULL THEN
      RAISE EXCEPTION 'RB_DOMAIN: Abschluss ohne Belegnummer';
    END IF;
    SELECT "invoiceId", "status", ROUND("grossTotal" * 100)::bigint AS gross INTO v FROM "InvoiceVersion" WHERE "id" = NEW."currentVersionId";
    IF v."invoiceId" IS DISTINCT FROM NEW."id" OR v."status" <> 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Ein Gegenbeleg wird mit seiner abgeschlossenen Fassung abgeschlossen';
    END IF;
    IF EXISTS (SELECT 1 FROM "Invoice" c WHERE c."originalInvoiceId" = o."id" AND c."status" = 'FINALIZED' AND c."documentType" = 'CANCELLATION' AND c."id" <> NEW."id") THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rechnung % ist bereits storniert; weitere Gutschriften oder Stornobelege sind nicht möglich', o."number";
    END IF;
    SELECT COALESCE(SUM(ROUND(cv."grossTotal" * 100)), 0)::bigint INTO credited
      FROM "Invoice" c JOIN "InvoiceVersion" cv ON cv."id" = c."currentVersionId"
      WHERE c."originalInvoiceId" = o."id" AND c."status" = 'FINALIZED' AND c."id" <> NEW."id";
    SELECT ROUND("grossTotal" * 100)::bigint INTO remaining FROM "InvoiceVersion" WHERE "id" = o."currentVersionId";
    remaining := remaining - credited;
    IF remaining <= 0 THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rechnung % ist bereits vollständig gutgeschrieben; weitere Gutschriften oder Stornobelege sind nicht möglich', o."number";
    END IF;
    IF v.gross <= 0 THEN
      RAISE EXCEPTION 'RB_DOMAIN: Ein Gegenbeleg über 0,00 wird nicht abgeschlossen';
    END IF;
    IF v.gross > remaining THEN
      RAISE EXCEPTION 'RB_DOMAIN: Der Beleg übersteigt den noch nicht gutgeschriebenen Betrag der Rechnung % (Rest % Cent, Beleg % Cent)', o."number", remaining, v.gross;
    END IF;
    IF NEW."documentType" = 'CANCELLATION' AND v.gross <> remaining THEN
      RAISE EXCEPTION 'RB_DOMAIN: Ein Stornobeleg neutralisiert genau den verbleibenden Betrag der Rechnung % (% Cent)', o."number", remaining;
    END IF;
    FOR bad IN
      SELECT s."id" AS sid
      FROM "InvoiceVersionItem" i JOIN "InvoiceVersionItem" s ON s."id" = i."sourceInvoiceVersionItemId"
      WHERE i."versionId" = NEW."currentVersionId"
         OR i."versionId" IN (SELECT c."currentVersionId" FROM "Invoice" c WHERE c."originalInvoiceId" = o."id" AND c."status" = 'FINALIZED' AND c."id" <> NEW."id")
      GROUP BY s."id", s."grossAmount", s."netAmount", s."taxAmount"
      HAVING SUM(ROUND(i."grossAmount" * 100)) > ROUND(s."grossAmount" * 100) OR SUM(ROUND(i."netAmount" * 100)) > ROUND(s."netAmount" * 100) OR SUM(ROUND(i."taxAmount" * 100)) > ROUND(s."taxAmount" * 100)
    LOOP
      RAISE EXCEPTION 'RB_DOMAIN: Eine Position der Rechnung % würde über ihren Betrag hinaus gutgeschrieben', o."number";
    END LOOP;
    FOR bad IN
      WITH orig AS (
        SELECT "taxRate", SUM(ROUND("netAmount" * 100)) AS n, SUM(ROUND("taxAmount" * 100)) AS t, SUM(ROUND("grossAmount" * 100)) AS g
        FROM "InvoiceVersionItem" WHERE "versionId" = o."currentVersionId" GROUP BY "taxRate"
      ), cred AS (
        SELECT "taxRate", SUM(ROUND("netAmount" * 100)) AS n, SUM(ROUND("taxAmount" * 100)) AS t, SUM(ROUND("grossAmount" * 100)) AS g
        FROM "InvoiceVersionItem"
        WHERE "versionId" = NEW."currentVersionId"
           OR "versionId" IN (SELECT c."currentVersionId" FROM "Invoice" c WHERE c."originalInvoiceId" = o."id" AND c."status" = 'FINALIZED' AND c."id" <> NEW."id")
        GROUP BY "taxRate"
      )
      SELECT cred."taxRate" AS rate FROM cred LEFT JOIN orig ON orig."taxRate" = cred."taxRate"
      WHERE orig."taxRate" IS NULL OR cred.n > orig.n OR cred.t > orig.t OR cred.g > orig.g
    LOOP
      RAISE EXCEPTION 'RB_DOMAIN: Je Steuersatz darf nicht mehr gutgeschrieben werden, als die Rechnung % enthält (Steuersatz % %%)', o."number", bad.rate;
    END LOOP;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rb_invoice_counter_check ON "Invoice";
CREATE TRIGGER rb_invoice_counter_check BEFORE INSERT OR UPDATE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION rb_check_counter_document();

-- Logische Rechnung (Neufassung der Sperre aus Phase 10): zusätzlich
-- - die Belegart ist ab der Anlage fest,
-- - ein abgeschlossener Gegenbeleg erhält nie eine weitere Fassung,
-- - eine Rechnung mit abgeschlossenem Gegenbeleg wechselt ihre Fassung nicht mehr (keine Berichtigung nach Gutschrift/Storno).
CREATE OR REPLACE FUNCTION rb_guard_invoice() RETURNS trigger AS $$
DECLARE
  o jsonb;
  n jsonb;
  v_invoice text;
  v_status text;
  v_no integer;
  old_no integer;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW."documentType" <> OLD."documentType" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Die Belegart ist ab der Anlage fest';
    END IF;
    IF NEW."status" = 'FINALIZED' AND NEW."number" IS NULL THEN
      RAISE EXCEPTION 'RB_DOMAIN: Abschluss ohne Rechnungsnummer';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Rechnung % kann nicht gelöscht werden', OLD."number";
  END IF;
  o := to_jsonb(OLD) - 'currentVersionId' - 'changeLog' - 'notes' - 'exportedAt' - 'exportBatchId' - 'updatedAt';
  n := to_jsonb(NEW) - 'currentVersionId' - 'changeLog' - 'notes' - 'exportedAt' - 'exportBatchId' - 'updatedAt';
  IF o <> n THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Rechnung % ist abgeschlossen; nur Fassungszeiger, Notiz, Protokoll und Exportmarke sind änderbar', OLD."number";
  END IF;
  IF NEW."currentVersionId" IS DISTINCT FROM OLD."currentVersionId" THEN
    IF NEW."currentVersionId" IS NULL THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine abgeschlossene Rechnung behält immer eine aktuelle Fassung';
    END IF;
    IF OLD."documentType" <> 'INVOICE' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Der Beleg % ist abgeschlossen; Gutschriften und Stornobelege erhalten keine weitere Fassung', OLD."number";
    END IF;
    IF EXISTS (SELECT 1 FROM "Invoice" c WHERE c."originalInvoiceId" = OLD."id" AND c."status" = 'FINALIZED') THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zur Rechnung % gibt es bereits eine Gutschrift oder einen Stornobeleg; sie wird nicht mehr berichtigt', OLD."number";
    END IF;
    SELECT "invoiceId", "status", "versionNo" INTO v_invoice, v_status, v_no FROM "InvoiceVersion" WHERE "id" = NEW."currentVersionId";
    IF v_invoice IS DISTINCT FROM NEW."id" OR v_status <> 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die aktuelle Fassung muss eine abgeschlossene Fassung dieser Rechnung sein';
    END IF;
    IF OLD."currentVersionId" IS NOT NULL THEN
      SELECT "versionNo" INTO old_no FROM "InvoiceVersion" WHERE "id" = OLD."currentVersionId";
      IF v_no <= old_no THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die aktuelle Fassung kann nur auf eine neuere Fassung wechseln';
      END IF;
    END IF;
  END IF;
  IF OLD."exportedAt" IS NOT NULL AND (NEW."exportedAt" IS DISTINCT FROM OLD."exportedAt" OR NEW."exportBatchId" IS DISTINCT FROM OLD."exportBatchId") THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Die Exportmarke wird nicht verändert oder entfernt';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Fassung (Neufassung der Prüfung aus Phase 10): Gegenbelege haben genau eine Fassung; eine Rechnung mit abgeschlossenem
-- Gegenbeleg bekommt keinen Entwurf einer weiteren Fassung mehr.
CREATE OR REPLACE FUNCTION rb_check_invoice_version() RETURNS trigger AS $$
DECLARE
  i_tenant text;
  i_exported timestamp;
  i_type text;
  i_number text;
  max_no integer;
BEGIN
  SELECT "tenantId", "exportedAt", "documentType", "number" INTO i_tenant, i_exported, i_type, i_number FROM "Invoice" WHERE "id" = NEW."invoiceId";
  IF i_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Rechnungsfassung und Rechnung gehören zu verschiedenen Mandanten';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF i_exported IS NOT NULL AND NOT rb_purge_allowed() THEN
      RAISE EXCEPTION 'RB_DOMAIN: Diese Rechnung wurde bereits buchhalterisch exportiert. Eine Änderung unter derselben Rechnungsnummer ist nicht mehr möglich';
    END IF;
    SELECT COALESCE(MAX("versionNo"), 0) INTO max_no FROM "InvoiceVersion" WHERE "invoiceId" = NEW."invoiceId";
    IF NEW."versionNo" <> max_no + 1 THEN
      RAISE EXCEPTION 'RB_DOMAIN: Fassungsnummern sind lückenlos und fortlaufend (erwartet %)', max_no + 1;
    END IF;
    IF NEW."versionNo" > 1 AND i_type <> 'INVOICE' AND NOT rb_purge_allowed() THEN
      RAISE EXCEPTION 'RB_DOMAIN: Gutschriften und Stornobelege haben genau eine Fassung; Korrekturen laufen über einen weiteren Beleg';
    END IF;
    IF NEW."versionNo" > 1 AND NOT rb_purge_allowed() AND EXISTS (SELECT 1 FROM "Invoice" c WHERE c."originalInvoiceId" = NEW."invoiceId" AND c."status" = 'FINALIZED') THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zur Rechnung % gibt es bereits eine Gutschrift oder einen Stornobeleg; sie wird nicht mehr berichtigt', i_number;
    END IF;
  END IF;
  IF NEW."supersedesVersionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "InvoiceVersion" p WHERE p."id" = NEW."supersedesVersionId" AND p."invoiceId" = NEW."invoiceId" AND p."versionNo" < NEW."versionNo") THEN
    RAISE EXCEPTION 'RB_DOMAIN: Die Vorfassung gehört nicht zu dieser Rechnung';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Positionen (Neufassung der Sperre aus Phase 10): der Bezug auf eine Originalposition ist nur in Gegenbelegen erlaubt und
-- zeigt auf eine Position der Bezugsfassung des Originals (gleicher Mandant).
CREATE OR REPLACE FUNCTION rb_guard_invoice_version_item() RETURNS trigger AS $$
DECLARE
  vid text;
  st text;
  v_tenant text;
  v_invoice text;
  i_type text;
  i_original_version text;
  s_version text;
  s_tenant text;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN vid := OLD."versionId"; ELSE vid := NEW."versionId"; END IF;
  SELECT "status", "tenantId", "invoiceId" INTO st, v_tenant, v_invoice FROM "InvoiceVersion" WHERE "id" = vid;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Positionen einer abgeschlossenen Rechnungsfassung sind gesperrt';
  END IF;
  IF TG_OP <> 'DELETE' AND v_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Position und Rechnungsfassung gehören zu verschiedenen Mandanten';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."sourceInvoiceVersionItemId" IS NOT NULL THEN
    SELECT "documentType", "originalVersionId" INTO i_type, i_original_version FROM "Invoice" WHERE "id" = v_invoice;
    IF i_type IS NULL OR i_type = 'INVOICE' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Nur Positionen einer Gutschrift oder eines Stornobelegs beziehen sich auf eine Originalposition';
    END IF;
    SELECT "versionId", "tenantId" INTO s_version, s_tenant FROM "InvoiceVersionItem" WHERE "id" = NEW."sourceInvoiceVersionItemId";
    IF s_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Die Originalposition gehört zu einem anderen Mandanten';
    END IF;
    IF s_version IS DISTINCT FROM i_original_version THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Originalposition gehört nicht zur Bezugsfassung der Originalrechnung';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;

-- Zahlung (Neufassung der Prüfung aus Phase 9): Zahlungen gibt es nur zu Rechnungen, nie zu Gutschriften oder Stornobelegen
CREATE OR REPLACE FUNCTION rb_check_payment() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  i_tenant text;
  i_booking text;
  i_status text;
  i_type text;
BEGIN
  SELECT "tenantId" INTO b_tenant FROM "Booking" WHERE "id" = NEW."bookingId";
  IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'RB_TENANT: Zahlung und Buchung gehören zu verschiedenen Mandanten';
  END IF;
  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId", "status", "documentType" INTO i_tenant, i_booking, i_status, i_type FROM "Invoice" WHERE "id" = NEW."invoiceId";
    IF i_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Zahlung und Rechnung gehören zu verschiedenen Mandanten';
    END IF;
    IF i_booking IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rechnung gehört nicht zu dieser Buchung';
    END IF;
    IF TG_OP = 'INSERT' AND i_status <> 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zahlungen nur auf abgeschlossene Rechnungen';
    END IF;
    IF TG_OP = 'INSERT' AND i_type <> 'INVOICE' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zahlungen werden nur zu Rechnungen erfasst, nicht zu Gutschriften oder Stornobelegen';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
