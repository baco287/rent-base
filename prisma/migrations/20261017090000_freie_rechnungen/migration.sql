-- Befehl 23.1: Freie Rechnungen (Rechnungsart GENERAL) mit optionalem Buchungsbezug. Rein additiv bzw. lockernd:
-- Der Buchungsbezug wird für Rechnung, Zahlung, Dokument, Auszahlung und Mahnschreiben optional (DROP NOT NULL), damit eine
-- freie Rechnung ohne Dummy-Buchung existieren kann. Bestehende Zeilen behalten ihren Bezug unverändert. Die Prüfregeln
-- werden so nachgezogen, dass ohne Buchung nur Rechnungszahlungen/-erstattungen zu genau einer Rechnung möglich sind;
-- Kautionsverrechnungen bleiben an die Buchung gebunden (rb_check_deposit_event vergleicht Buchungen null-sicher).

ALTER TABLE "Invoice" ALTER COLUMN "bookingId" DROP NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "bookingId" DROP NOT NULL;
ALTER TABLE "Document" ALTER COLUMN "bookingId" DROP NOT NULL;
ALTER TABLE "Payout" ALTER COLUMN "bookingId" DROP NOT NULL;
ALTER TABLE "DunningNotice" ALTER COLUMN "bookingId" DROP NOT NULL;

ALTER TABLE "Invoice" DROP CONSTRAINT "rb_invoice_kind";
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_kind" CHECK ("kind" IN ('RENTAL', 'DAMAGE', 'AUTHORITY_FEE', 'DUNNING_FEE', 'GENERAL'));
-- Ohne Buchung nur freie Rechnungen (und deren Gegenbelege/Mahngebühren), immer mit Kunde als Rechnungsempfänger
ALTER TABLE "Invoice" ADD CONSTRAINT "rb_invoice_booking_or_customer" CHECK ("bookingId" IS NOT NULL OR ("customerId" IS NOT NULL AND "kind" IN ('GENERAL', 'DUNNING_FEE')));

-- Mandantentrennung für die Bezüge einer neuen Rechnung (Buchung, Kunde); freie Rechnung: Buchung gehört zum Kunden
CREATE OR REPLACE FUNCTION rb_check_invoice_refs() RETURNS trigger AS $$
DECLARE
  b_tenant text; b_customer text; c_tenant text;
BEGIN
  IF NEW."bookingId" IS NOT NULL THEN
    SELECT "tenantId", "customerId" INTO b_tenant, b_customer FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Rechnung und Buchung gehören zu verschiedenen Mandanten'; END IF;
  END IF;
  IF NEW."customerId" IS NOT NULL THEN
    SELECT "tenantId" INTO c_tenant FROM "Customer" WHERE "id" = NEW."customerId";
    IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'RB_TENANT: Rechnung und Kunde gehören zu verschiedenen Mandanten'; END IF;
  END IF;
  IF NEW."kind" = 'GENERAL' AND NEW."documentType" = 'INVOICE' AND NEW."bookingId" IS NOT NULL AND b_customer IS DISTINCT FROM NEW."customerId" THEN
    RAISE EXCEPTION 'RB_DOMAIN: Die Buchung gehört nicht zu diesem Rechnungsempfänger';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "rb_check_invoice_refs" BEFORE INSERT ON "Invoice" FOR EACH ROW EXECUTE FUNCTION rb_check_invoice_refs();

-- Zahlung: ohne Buchung nur als Rechnungszahlung (sonst unverändert)
CREATE OR REPLACE FUNCTION rb_check_payment() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  i_tenant text;
  i_booking text;
  i_status text;
  i_type text;
  i_kind text;
BEGIN
  IF NEW."bookingId" IS NULL THEN
    -- Befehl 23.1: Zahlung zu einer freien Rechnung ohne Buchungsbezug – nur als Rechnungszahlung zu genau einer Rechnung
    IF NEW."invoiceId" IS NULL OR NEW."type" <> 'INVOICE_PAYMENT' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Ohne Buchungsbezug gibt es nur Zahlungen zu einer Rechnung';
    END IF;
  ELSE
    SELECT "tenantId" INTO b_tenant FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Zahlung und Buchung gehören zu verschiedenen Mandanten';
    END IF;
  END IF;
  IF NEW."type" = 'RENTAL_PAYMENT' AND TG_OP = 'INSERT' THEN
    IF NEW."invoiceId" IS NOT NULL THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine Mietzahlung wird ohne Rechnung erfasst und erst beim Rechnungsabschluss zugeordnet';
    END IF;
    IF EXISTS (SELECT 1 FROM "Invoice" WHERE "bookingId" = NEW."bookingId" AND "kind" = 'RENTAL' AND "documentType" = 'INVOICE' AND "status" = 'FINALIZED') THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zu dieser Buchung gibt es eine abgeschlossene Mietrechnung; Zahlungen werden zur Rechnung erfasst';
    END IF;
  END IF;
  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId", "status", "documentType", "kind" INTO i_tenant, i_booking, i_status, i_type, i_kind FROM "Invoice" WHERE "id" = NEW."invoiceId";
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
    IF NEW."type" = 'RENTAL_PAYMENT' AND (i_status <> 'FINALIZED' OR i_type <> 'INVOICE' OR i_kind <> 'RENTAL') THEN
      RAISE EXCEPTION 'RB_DOMAIN: Eine Mietzahlung wird nur der abgeschlossenen Mietrechnung ihrer Buchung zugeordnet';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Zahlung unveränderlich: Buchungsbezug null-sicher vergleichen
CREATE OR REPLACE FUNCTION rb_guard_payment() RETURNS trigger AS $$
DECLARE
  remaining bigint;
  linking boolean;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Zahlungen werden nicht gelöscht, nur storniert';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine stornierte Zahlung kann nicht mehr geändert werden';
  END IF;
  linking := OLD."type" = 'RENTAL_PAYMENT' AND OLD."invoiceId" IS NULL AND NEW."invoiceId" IS NOT NULL
             AND NEW."status" = 'CONFIRMED' AND OLD."status" = 'CONFIRMED';
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR (NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" AND NOT linking)
     OR NEW."type" <> OLD."type" OR NEW."method" <> OLD."method" OR NEW."amountCents" <> OLD."amountCents" OR NEW."currency" <> OLD."currency"
     OR NEW."paidAt" <> OLD."paidAt" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Eine bestätigte Zahlung kann nicht geändert werden, nur storniert';
  END IF;
  IF NEW."status" = 'CONFIRMED' AND (NEW."cancelledAt" IS NOT NULL OR NEW."cancellationReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Stornofelder nur beim Storno';
  END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" = 'CONFIRMED' AND NEW."invoiceId" IS NOT NULL THEN
    remaining := rb_invoice_refund_remaining(NEW."invoiceId", NULL) - NEW."amountCents";
    IF remaining < 0 AND (
      (SELECT COALESCE(SUM("amountCents"), 0) FROM "Payout" WHERE "invoiceId" = NEW."invoiceId" AND "status" = 'COMPLETED')
      + (SELECT COALESCE(SUM("amountCents"), 0) FROM "SecurityDepositEvent" WHERE "invoiceId" = NEW."invoiceId" AND "type" = 'OFFSET_RETURN' AND "status" = 'CONFIRMED')
    ) > 0 THEN
      RAISE EXCEPTION 'RB_DOMAIN: Zu dieser Rechnung wurde Kundenguthaben bereits ausgezahlt oder zur Kaution zurückgeführt; das Storno der Zahlung würde mehr verbrauchen als Guthaben besteht. Bitte zuerst Auszahlung bzw. Rückführung stornieren';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Auszahlung: ohne Buchung nur als Erstattung zu einer Rechnung; Bezug null-sicher unveränderlich
CREATE OR REPLACE FUNCTION rb_check_payout() RETURNS trigger AS $$
DECLARE
  b_tenant text;
  b_customer text;
  i record;
  d record;
  c_tenant text;
  remaining bigint;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF NEW."bookingId" IS NULL THEN
    -- Befehl 23.1: Erstattung zu einer freien Rechnung ohne Buchungsbezug (Kautionsrückzahlungen haben immer eine Buchung)
    IF NEW."sourceType" <> 'INVOICE_REFUND' OR NEW."invoiceId" IS NULL THEN
      RAISE EXCEPTION 'RB_DOMAIN: Ohne Buchungsbezug gibt es nur Erstattungen zu einer Rechnung';
    END IF;
  ELSE
    SELECT "tenantId", "customerId" INTO b_tenant, b_customer FROM "Booking" WHERE "id" = NEW."bookingId";
    IF b_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Auszahlung und Buchung gehören zu verschiedenen Mandanten';
    END IF;
  END IF;
  IF NEW."customerId" IS NOT NULL THEN
    SELECT "tenantId" INTO c_tenant FROM "Customer" WHERE "id" = NEW."customerId";
    IF c_tenant IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Auszahlung und Kunde gehören zu verschiedenen Mandanten';
    END IF;
  END IF;
  IF NEW."invoiceId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId", "status", "documentType", "number" INTO i FROM "Invoice" WHERE "id" = NEW."invoiceId";
    IF i."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Auszahlung und Rechnung gehören zu verschiedenen Mandanten';
    END IF;
    IF i."bookingId" IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Rechnung gehört nicht zu dieser Buchung';
    END IF;
    IF i."status" <> 'FINALIZED' OR i."documentType" <> 'INVOICE' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Erstattungen gibt es nur zu abgeschlossenen Rechnungen, nicht zu Entwürfen, Gutschriften oder Stornobelegen';
    END IF;
  END IF;
  IF NEW."securityDepositId" IS NOT NULL THEN
    SELECT "tenantId", "bookingId" INTO d FROM "SecurityDeposit" WHERE "id" = NEW."securityDepositId";
    IF d."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
      RAISE EXCEPTION 'RB_TENANT: Auszahlung und Kaution gehören zu verschiedenen Mandanten';
    END IF;
    IF d."bookingId" IS DISTINCT FROM NEW."bookingId" THEN
      RAISE EXCEPTION 'RB_DOMAIN: Die Kaution gehört nicht zu dieser Buchung';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."tenantId" <> OLD."tenantId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId" OR NEW."sourceType" <> OLD."sourceType"
       OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" OR NEW."securityDepositId" IS DISTINCT FROM OLD."securityDepositId" THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Quelle und Zuordnung einer Auszahlung sind ab der Anlage fest';
    END IF;
    IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine stornierte Auszahlung wird nicht wiederbelebt';
    END IF;
    IF OLD."status" = 'COMPLETED' AND NEW."status" = 'DRAFT' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Eine abgeschlossene Auszahlung wird nicht zum Entwurf';
    END IF;
  END IF;
  IF NEW."status" = 'COMPLETED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'COMPLETED') THEN
    IF NEW."executedAt" > now() + interval '1 day' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Der Auszahlungszeitpunkt einer abgeschlossenen Auszahlung liegt nicht in der Zukunft';
    END IF;
    IF NEW."invoiceId" IS NOT NULL THEN
      PERFORM 1 FROM "Invoice" WHERE "id" = NEW."invoiceId" FOR UPDATE;
      remaining := rb_invoice_refund_remaining(NEW."invoiceId", NEW."id");
      IF remaining <= 0 THEN
        RAISE EXCEPTION 'RB_DOMAIN: Zur Rechnung % gibt es kein auszahlbares Kundenguthaben', i."number";
      END IF;
      IF NEW."amountCents" > remaining THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die Auszahlung (% Cent) übersteigt das noch auszuzahlende Kundenguthaben der Rechnung % (% Cent)', NEW."amountCents", i."number", remaining;
      END IF;
    ELSE
      PERFORM 1 FROM "SecurityDeposit" WHERE "id" = NEW."securityDepositId" FOR UPDATE;
      remaining := rb_deposit_payout_remaining(NEW."securityDepositId", NEW."id");
      IF remaining <= 0 THEN
        RAISE EXCEPTION 'RB_DOMAIN: Von dieser Kaution ist nichts mehr auszuzahlen';
      END IF;
      IF NEW."amountCents" > remaining THEN
        RAISE EXCEPTION 'RB_DOMAIN: Die Auszahlung (% Cent) übersteigt den auszahlbaren Kautionsrest (% Cent)', NEW."amountCents", remaining;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Gegenbeleg: Buchungsbezug des Originals null-sicher vergleichen
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
  IF o."bookingId" IS DISTINCT FROM NEW."bookingId" OR o."kind" <> NEW."kind" THEN
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
