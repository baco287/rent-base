-- Befehl 20.5: mandanteneigener E-Mail-Versand (SMTP), Versandkanal im E-Mail-Protokoll, Logo und Website je Mandant.
-- Rein additiv: keine bestehende Zeile wird geändert. Kein Mandant bekommt eine SMTP-Konfiguration; ohne Zeile in
-- "TenantMailSettings" gilt wie bisher der RentBase-Versand (mode PLATFORM). Bestehende E-Mail-Protokolle behalten
-- category/channel = NULL (vor der Trennung lief jeder Versand über den Plattform-SMTP).

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "logoChecksum" TEXT,
ADD COLUMN     "logoStorageKey" TEXT,
ADD COLUMN     "logoUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN     "category" TEXT,
ADD COLUMN     "channel" TEXT,
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "fromAddress" TEXT;

-- CreateTable
CREATE TABLE "TenantMailSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'PLATFORM',
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "host" TEXT,
    "port" INTEGER,
    "security" TEXT,
    "username" TEXT,
    "passwordCiphertext" TEXT,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "replyTo" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "verifiedByName" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "updatedByName" TEXT,

    CONSTRAINT "TenantMailSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantMailSettings_tenantId_key" ON "TenantMailSettings"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantMailSettings" ADD CONSTRAINT "TenantMailSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Erlaubte Werte
ALTER TABLE "TenantMailSettings" ADD CONSTRAINT "rb_mail_settings_mode" CHECK ("mode" IN ('PLATFORM', 'TENANT_SMTP'));
ALTER TABLE "TenantMailSettings" ADD CONSTRAINT "rb_mail_settings_status" CHECK ("status" IN ('NOT_CONFIGURED', 'CONFIGURED', 'VERIFIED', 'ERROR'));
ALTER TABLE "TenantMailSettings" ADD CONSTRAINT "rb_mail_settings_security" CHECK ("security" IS NULL OR "security" IN ('STARTTLS', 'SSL_TLS'));
ALTER TABLE "TenantMailSettings" ADD CONSTRAINT "rb_mail_settings_port" CHECK ("port" IS NULL OR "port" IN (25, 465, 587, 2525));
-- Passwort ausschließlich verschlüsselt (Format v1.<keyId>.<iv>.<tag>.<ciphertext>) – ein versehentlicher Klartext scheitert an der Datenbank
ALTER TABLE "TenantMailSettings" ADD CONSTRAINT "rb_mail_settings_secret_encrypted" CHECK ("passwordCiphertext" IS NULL OR "passwordCiphertext" ~ '^v1\.[0-9a-f]{12}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$');
-- Eigener Versand nur mit vollständigen Verbindungsdaten
ALTER TABLE "TenantMailSettings" ADD CONSTRAINT "rb_mail_settings_tenant_smtp_complete" CHECK ("mode" <> 'TENANT_SMTP' OR ("host" IS NOT NULL AND "port" IS NOT NULL AND "security" IS NOT NULL AND "username" IS NOT NULL AND "passwordCiphertext" IS NOT NULL AND "fromEmail" IS NOT NULL));
ALTER TABLE "EmailLog" ADD CONSTRAINT "rb_email_log_category" CHECK ("category" IS NULL OR "category" IN ('PLATFORM_SYSTEM', 'TENANT_BUSINESS'));
ALTER TABLE "EmailLog" ADD CONSTRAINT "rb_email_log_channel" CHECK ("channel" IS NULL OR "channel" IN ('PLATFORM_SMTP', 'TENANT_SMTP'));

-- Geprüft-Status hängt an genau den Verbindungsdaten, mit denen getestet wurde:
-- * jede Änderung an Server, Port, Verschlüsselung, Benutzer, Passwort oder Absenderadresse setzt VERIFIED zurück
-- * VERIFIED entsteht nie beim Anlegen, nur durch einen Test auf gespeicherten Daten
-- * Umschalten auf TENANT_SMTP nur aus VERIFIED heraus
CREATE OR REPLACE FUNCTION rb_guard_mail_settings() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'VERIFIED' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Der E-Mail-Versand gilt erst nach einem erfolgreichen Test als geprüft';
    END IF;
    IF NEW."mode" = 'TENANT_SMTP' THEN
      RAISE EXCEPTION 'RB_DOMAIN: Der eigene E-Mail-Versand kann erst nach einem erfolgreichen Test aktiviert werden';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."host" IS DISTINCT FROM OLD."host" OR NEW."port" IS DISTINCT FROM OLD."port" OR NEW."security" IS DISTINCT FROM OLD."security"
     OR NEW."username" IS DISTINCT FROM OLD."username" OR NEW."passwordCiphertext" IS DISTINCT FROM OLD."passwordCiphertext"
     OR NEW."fromEmail" IS DISTINCT FROM OLD."fromEmail" THEN
    IF NEW."status" = 'VERIFIED' THEN
      NEW."status" := 'CONFIGURED';
    END IF;
    NEW."verifiedAt" := NULL;
    NEW."verifiedById" := NULL;
    NEW."verifiedByName" := NULL;
  END IF;
  IF NEW."mode" = 'TENANT_SMTP' AND OLD."mode" <> 'TENANT_SMTP' AND NEW."status" <> 'VERIFIED' THEN
    RAISE EXCEPTION 'RB_DOMAIN: Der eigene E-Mail-Versand kann erst nach einem erfolgreichen Test aktiviert werden';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_mail_settings_guard BEFORE INSERT OR UPDATE ON "TenantMailSettings" FOR EACH ROW EXECUTE FUNCTION rb_guard_mail_settings();
