-- Befehl 20.6 (Ergänzung): maßgebliches Mietende bei kontaktloser Rückgabe mit Pflichtgrund korrigierbar.
-- Rein additiv; die Kundenangabe (KeyDropReturn.customerDropOffAt, Handover.customerDropOffAt) bleibt unverändert.

ALTER TABLE "Handover" ADD COLUMN     "returnTimeOverrideAt" TIMESTAMP(3),
ADD COLUMN     "returnTimeOverrideById" TEXT,
ADD COLUMN     "returnTimeOverrideByName" TEXT,
ADD COLUMN     "returnTimeOverrideReason" TEXT;

-- Nur bei kontaktloser Rückgabe und nie ohne Begründung
ALTER TABLE "Handover" ADD CONSTRAINT "rb_handover_return_time_override" CHECK ("returnTimeOverrideAt" IS NULL OR ("returnMode" = 'KEY_DROP' AND "returnTimeOverrideReason" IS NOT NULL AND length(trim("returnTimeOverrideReason")) >= 10));
