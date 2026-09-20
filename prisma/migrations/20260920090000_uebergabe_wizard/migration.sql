-- AlterTable
ALTER TABLE "Handover" ADD COLUMN     "wizardStep" INTEGER NOT NULL DEFAULT 1;
-- Von Hand ergänzt: Systemskizzen Version 2 mit Innenraum-Ansicht.
-- Version 1 bleibt als Zeile erhalten (alte Protokolle verweisen darauf) und wird nur deaktiviert.
UPDATE "VehicleSketch" SET "active" = false WHERE "tenantId" IS NULL AND "version" = 1;
INSERT INTO "VehicleSketch" ("id", "tenantId", "code", "name", "bodyType", "version", "assetPath", "assetHash", "views", "active")
VALUES
  ('sys_sketch_pkw_v2', NULL, 'GENERIC_PKW', 'Allgemeiner PKW', 'PKW', 2, '/sketches/generic-pkw-v2.svg', '5da621a0bf53b0ff09458a36e29eb93e7710ba9a046927a63fd1b796da14a239',
   '[{"key":"FRONT","label":"Vorne","box":[40,280,320,270]},{"key":"REAR","label":"Hinten","box":[380,280,320,270]},{"key":"LEFT","label":"Links (Fahrerseite)","box":[10,20,490,230]},{"key":"RIGHT","label":"Rechts (Beifahrerseite)","box":[510,20,490,230]},{"key":"TOP","label":"Dach","box":[720,280,260,270]},{"key":"INTERIOR","label":"Innenraum","box":[40,575,560,250]}]'::jsonb, true),
  ('sys_sketch_transporter_v2', NULL, 'GENERIC_TRANSPORTER', 'Allgemeiner Transporter', 'TRANSPORTER', 2, '/sketches/generic-transporter-v2.svg', '0c170347ef74246b5f4cf1b73e5b5b243d398a074f2da600f65f2360fabcbdeb',
   '[{"key":"FRONT","label":"Vorne","box":[40,280,320,270]},{"key":"REAR","label":"Hinten","box":[380,280,320,270]},{"key":"LEFT","label":"Links (Fahrerseite)","box":[10,20,490,230]},{"key":"RIGHT","label":"Rechts (Beifahrerseite)","box":[510,20,490,230]},{"key":"TOP","label":"Dach","box":[720,280,260,270]},{"key":"INTERIOR","label":"Innenraum","box":[40,575,560,250]}]'::jsonb, true);
