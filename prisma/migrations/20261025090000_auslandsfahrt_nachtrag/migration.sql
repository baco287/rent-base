-- Auslandsfahrt per Nachtrag (Stufe 2): eigene Änderungsart – Genehmigung erteilen, ändern oder entziehen, genehmigte Länder und
-- der neue GESAMT-Aufpreis (einmalig). Rein additiv: neue Spalten und Prüfregeln, keine Datenänderung. Bestehende Nachträge bleiben
-- ohne Auslandsänderung (NULL/leer) und erfüllen alle Regeln. Der Unveränderlichkeits-Trigger rb_guard_amendment vergleicht die
-- ganze Zeile (to_jsonb) – die neuen Spalten sind nach der Unterschrift ohne Anpassung geschützt.

ALTER TABLE "ContractAmendment" ADD COLUMN "newAbroadAllowed" BOOLEAN;
ALTER TABLE "ContractAmendment" ADD COLUMN "newAbroadCountries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ContractAmendment" ADD COLUMN "newAbroadSurchargeCents" INTEGER;
ALTER TABLE "ContractAmendment" ADD COLUMN "abroadSurchargeDeltaCents" INTEGER;
ALTER TABLE "ContractAmendment" ADD COLUMN "abroadReason" TEXT;

-- Keine Auslandsänderung: alles leer. Mit Auslandsänderung: neuer Gesamt-Aufpreis 0 € bis 100.000 €, vom Server berechneter
-- Unterschied gesetzt; gestattet = 1 bis 20 Länder; Entzug = keine Länder und Aufpreis 0; Grund (falls angegeben) 3–300 Zeichen
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_abroad" CHECK (
  ("newAbroadAllowed" IS NULL AND "newAbroadSurchargeCents" IS NULL AND "abroadSurchargeDeltaCents" IS NULL
     AND "abroadReason" IS NULL AND cardinality("newAbroadCountries") = 0)
  OR ("newAbroadAllowed" IS NOT NULL
      AND "newAbroadSurchargeCents" IS NOT NULL AND "newAbroadSurchargeCents" BETWEEN 0 AND 10000000
      AND "abroadSurchargeDeltaCents" IS NOT NULL
      AND array_position("newAbroadCountries", NULL) IS NULL
      AND (("newAbroadAllowed" AND cardinality("newAbroadCountries") BETWEEN 1 AND 20)
           OR (NOT "newAbroadAllowed" AND cardinality("newAbroadCountries") = 0 AND "newAbroadSurchargeCents" = 0))
      AND ("abroadReason" IS NULL OR length(btrim("abroadReason")) BETWEEN 3 AND 300)));

-- Getrennte Beträge: eine Änderung des Auslandsfahrt-Aufpreises nicht zusammen mit einer allgemeinen Preisänderung (ein
-- Abrechnungsbezug je Nachtrag; Nutzerentscheid „zwei Nachträge“)
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_abroad_separate" CHECK (COALESCE("abroadSurchargeDeltaCents", 0) = 0 OR "priceDeltaCents" IS NULL);

-- „Vorab vereinbart“ (Befehl 28) gilt nur für Zeiträume – keine Auslandsänderung in diesem Status
ALTER TABLE "ContractAmendment" ADD CONSTRAINT "rb_amendment_abroad_not_agreed" CHECK ("status" <> 'AGREED' OR "newAbroadAllowed" IS NULL);
