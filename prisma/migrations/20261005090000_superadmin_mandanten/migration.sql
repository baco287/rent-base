-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedById" TEXT,
ADD COLUMN     "suspendedByName" TEXT,
ADD COLUMN     "suspendedReason" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "platformRole" TEXT NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedById" TEXT,
    "invitedByName" TEXT,
    "acceptedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "superAdminId" TEXT NOT NULL,
    "superAdminName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_status_idx" ON "Invitation"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "SupportSession_tenantId_startedAt_idx" ON "SupportSession"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "SupportSession_superAdminId_idx" ON "SupportSession"("superAdminId");

-- CreateIndex
CREATE INDEX "User_platformRole_idx" ON "User"("platformRole");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Befehl 20: Wertebereiche, Race-sichere Einladungen, Unveränderlichkeit, Schutz vor Hard-Delete und
-- unautorisierter Plattformrollen-Änderung. Folgt demselben Muster wie die übrigen rb_check_*/rb_guard_*
-- Regeln dieses Projekts (RB_IMMUTABLE-Fehler, rb_purge_allowed() für Testbereinigung).
-- ============================================================================

ALTER TABLE "Tenant" ADD CONSTRAINT "rb_tenant_status" CHECK ("status" IN ('PENDING_SETUP', 'ACTIVE', 'SUSPENDED'));
ALTER TABLE "User" ADD CONSTRAINT "rb_user_platform_role" CHECK ("platformRole" IN ('NONE', 'SUPER_ADMIN'));
ALTER TABLE "Invitation" ADD CONSTRAINT "rb_invitation_status" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'));
ALTER TABLE "Invitation" ADD CONSTRAINT "rb_invitation_role" CHECK ("role" IN ('OWNER', 'DISPO', 'YARD'));

-- Höchstens eine offene Einladung je Mandant und E-Mail-Adresse gleichzeitig; verhindert doppelte parallele
-- Einladungen (Doppelklick, zwei Anfragen) ohne Anwendungscode-Race.
CREATE UNIQUE INDEX "rb_invitation_one_pending" ON "Invitation" ("tenantId", "email") WHERE "status" = 'PENDING';

-- Tenant/User: kein Hard-Delete außerhalb der ausdrücklich freigegebenen Testbereinigung (item 84: Super-Admin
-- darf produktive Mandanten nicht endgültig löschen; dasselbe gilt für Benutzer – nur Deaktivierung).
CREATE OR REPLACE FUNCTION rb_guard_no_delete() RETURNS trigger AS $$
BEGIN
  IF NOT rb_purge_allowed() THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: % kann nicht endgültig gelöscht werden, nur deaktiviert/gesperrt', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_tenant_no_delete BEFORE DELETE ON "Tenant" FOR EACH ROW EXECUTE FUNCTION rb_guard_no_delete();
CREATE TRIGGER rb_user_no_delete BEFORE DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION rb_guard_no_delete();

-- Plattformrolle darf nur durch einen ausdrücklich freigegebenen Plattformvorgang geändert werden
-- (SET LOCAL rentbase.allow_platform_role_change = 'on'), nie beiläufig durch eine normale Mandanten-Aktion.
CREATE OR REPLACE FUNCTION rb_guard_platform_role() RETURNS trigger AS $$
BEGIN
  IF NEW."platformRole" IS DISTINCT FROM OLD."platformRole"
     AND coalesce(current_setting('rentbase.allow_platform_role_change', true), '') <> 'on' THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Die Plattformrolle kann nicht durch eine normale Aktion geändert werden';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_user_platform_role_guard BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION rb_guard_platform_role();

-- Einladung: nach Annahme/Widerruf/Ablauf unveränderlich (neue Fassung wäre eine neue Einladung, kein Zurückdrehen).
CREATE OR REPLACE FUNCTION rb_guard_invitation() RETURNS trigger AS $$
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('ACCEPTED', 'REVOKED') THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Diese Einladung ist bereits % und kann nicht mehr geändert werden', OLD."status";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_invitation_guard BEFORE UPDATE ON "Invitation" FOR EACH ROW EXECUTE FUNCTION rb_guard_invitation();

-- Passwort-Reset-Token: nach Verwendung unveränderlich (single-use, auch an der Datenbank vorbei).
CREATE OR REPLACE FUNCTION rb_guard_password_reset_token() RETURNS trigger AS $$
BEGIN
  IF NOT rb_purge_allowed() AND OLD."usedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'RB_IMMUTABLE: Dieser Passwort-Reset-Token wurde bereits verwendet';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_password_reset_token_guard BEFORE UPDATE ON "PasswordResetToken" FOR EACH ROW EXECUTE FUNCTION rb_guard_password_reset_token();

-- Letzter aktiver OWNER eines Mandanten darf nicht deaktiviert oder herabgestuft werden (item 28), auch nicht
-- an der Anwendungslogik vorbei. Serverseitig zusätzlich in lib/tenant-users.ts geprüft (klare Fehlermeldung
-- vor dem Datenbankzugriff); dieser Trigger ist das letzte Netz.
CREATE OR REPLACE FUNCTION rb_guard_last_owner() RETURNS trigger AS $$
DECLARE
  other_owners integer;
BEGIN
  IF rb_purge_allowed() THEN RETURN NEW; END IF;
  IF OLD."role" = 'OWNER' AND OLD."active" = true AND (NEW."role" <> 'OWNER' OR NEW."active" = false) THEN
    SELECT count(*) INTO other_owners FROM "User" WHERE "tenantId" = OLD."tenantId" AND "role" = 'OWNER' AND "active" = true AND "id" <> OLD."id";
    IF other_owners = 0 THEN
      RAISE EXCEPTION 'RB_IMMUTABLE: der letzte aktive Inhaber eines Mandanten kann nicht deaktiviert oder herabgestuft werden';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rb_user_last_owner_guard BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION rb_guard_last_owner();

