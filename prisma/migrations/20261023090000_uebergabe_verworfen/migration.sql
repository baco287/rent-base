-- Übergabe-Entwurf beim Storno als verworfen kennzeichnen statt löschen (Storno nach Fahrerprüfung).
-- Prüfvermerke und Dokumentkopien verweisen mit RESTRICT auf den Entwurf und werden nie gelöscht; bisher scheiterte
-- deshalb jedes Storno nach einer Fahrerprüfung. Nur Ergänzungen und Verschärfungen: zwei Spalten, zwei CHECK-Regeln,
-- drei Schutzfunktionen um den Status DISCARDED erweitert. Keine Datenänderung; Bestandszeilen erfüllen alle Regeln
-- (der Code schrieb bisher nur DRAFT und FINALIZED, beide Spalten sind neu und leer).

ALTER TABLE "Handover" ADD COLUMN "discardedAt" TIMESTAMP(3);
ALTER TABLE "Handover" ADD COLUMN "discardReason" TEXT;

ALTER TABLE "Handover" ADD CONSTRAINT "rb_handover_status" CHECK ("status" IN ('DRAFT', 'FINALIZED', 'DISCARDED'));
-- Verworfen genau dann, wenn Zeitpunkt und Grund gesetzt sind; nur Übergaben (Prüfvermerke gibt es nur dort); nie zugleich versiegelt
ALTER TABLE "Handover" ADD CONSTRAINT "rb_handover_discarded" CHECK (
  (("status" = 'DISCARDED') = ("discardedAt" IS NOT NULL))
  AND (("status" = 'DISCARDED') = ("discardReason" IS NOT NULL))
  AND ("discardReason" IS NULL OR length(btrim("discardReason")) >= 3)
  AND ("status" <> 'DISCARDED' OR ("type" = 'PICKUP' AND "finalizedAt" IS NULL AND "contentHash" IS NULL))
);

-- Protokoll: FINALIZED wie bisher gesperrt; DISCARDED weder änderbar noch löschbar; beim Verwerfen ändern sich nur Status,
-- Zeitpunkt und Grund (der Inhalt bleibt, wie er beim Storno war)
CREATE OR REPLACE FUNCTION rb_guard_handover() RETURNS trigger AS $$
DECLARE
  o jsonb; n jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'FINALIZED' AND NOT rb_purge_allowed() THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: finalisiertes Protokoll % kann nicht gelöscht werden', OLD."number";
    END IF;
    IF OLD."status" = 'DISCARDED' AND NOT rb_purge_allowed() THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: verworfenes Protokoll % kann nicht gelöscht werden', OLD."number";
    END IF;
    RETURN OLD;
  END IF;
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF OLD."status" = 'FINALIZED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: finalisiertes Protokoll % kann nicht geändert werden', OLD."number";
  END IF;
  IF OLD."status" = 'DISCARDED' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: verworfenes Protokoll % kann nicht geändert werden', OLD."number";
  END IF;
  IF NEW."status" = 'DISCARDED' THEN
    o := to_jsonb(OLD) - 'status' - 'discardedAt' - 'discardReason' - 'updatedAt';
    n := to_jsonb(NEW) - 'status' - 'discardedAt' - 'discardReason' - 'updatedAt';
    IF o <> n THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Beim Verwerfen bleibt der Inhalt des Protokolls % unverändert', OLD."number";
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Bestandteile (Schadenkopien, Checkliste, Fotos, Zusatzkosten): wie bisher frei im Entwurf, gesperrt nach FINALIZED,
-- zusätzlich gesperrt nach DISCARDED
CREATE OR REPLACE FUNCTION rb_guard_handover_child() RETURNS trigger AS $$
DECLARE
  hid text;
  st text;
BEGIN
  IF rb_purge_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN hid := NEW."handoverId"; ELSE hid := OLD."handoverId"; END IF;
  IF hid IS NOT NULL THEN
    SELECT "status" INTO st FROM "Handover" WHERE "id" = hid;
    IF st = 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: % gehört zu einem finalisierten Protokoll und ist gesperrt', TG_TABLE_NAME;
    END IF;
    IF st = 'DISCARDED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: % gehört zu einem verworfenen Protokoll und ist gesperrt', TG_TABLE_NAME;
    END IF;
  END IF;
  -- Umhängen an ein anderes, bereits finalisiertes oder verworfenes Protokoll ebenfalls verhindern
  IF TG_OP = 'UPDATE' AND NEW."handoverId" IS DISTINCT FROM OLD."handoverId" AND NEW."handoverId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "Handover" WHERE "id" = NEW."handoverId";
    IF st = 'FINALIZED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Ziel-Protokoll ist finalisiert';
    END IF;
    IF st = 'DISCARDED' THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: Ziel-Protokoll ist verworfen';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$ LANGUAGE plpgsql;

-- Unterschriften: aktuelle Fassung (20261020090000_storno_mietaenderungen) unverändert übernommen, im Protokollzweig
-- zusätzlich DISCARDED gesperrt
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
      IF st = 'DISCARDED' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Protokoll ist verworfen'; END IF;
    END IF;
    IF NEW."contractId" IS NOT NULL THEN
      SELECT "status" INTO st FROM "RentalContract" WHERE "id" = NEW."contractId";
      IF st <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Vertrag ist bereits unterschrieben'; END IF;
    END IF;
    IF NEW."amendmentId" IS NOT NULL THEN
      SELECT "status" INTO st FROM "ContractAmendment" WHERE "id" = NEW."amendmentId";
      -- Befehl 28: auch eine vereinbarte Änderung (AGREED) wird nachträglich unterschrieben
      IF st NOT IN ('DRAFT', 'AGREED') THEN RAISE EXCEPTION 'RB_IMMUTABLE: Nachtrag ist bereits unterschrieben oder verworfen'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."handoverId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "Handover" WHERE "id" = OLD."handoverId";
    IF st = 'FINALIZED' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines finalisierten Protokolls'; END IF;
    IF st = 'DISCARDED' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines verworfenen Protokolls'; END IF;
  END IF;
  IF OLD."contractId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "RentalContract" WHERE "id" = OLD."contractId";
    IF st <> 'DRAFT' THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines unterschriebenen Vertrags'; END IF;
  END IF;
  IF OLD."amendmentId" IS NOT NULL THEN
    SELECT "status" INTO st FROM "ContractAmendment" WHERE "id" = OLD."amendmentId";
    IF st NOT IN ('DRAFT', 'AGREED') THEN RAISE EXCEPTION 'RB_IMMUTABLE: Unterschrift eines unterschriebenen Nachtrags'; END IF;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
