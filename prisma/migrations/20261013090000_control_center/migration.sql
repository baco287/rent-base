-- Control Center: interne Rollen, Feature-Freischaltungen je Mandant, interne Tarif-/Abo-Verwaltung, Audit-Indizes.
-- Rein additiv: keine bestehende Zeile wird geändert oder gelöscht. Bestandsmandanten ohne Feature-Zeile und ohne
-- Abo-Zeile verhalten sich exakt wie vor dieser Migration (Standard = freigeschaltet, Limits = unbegrenzt).

-- Interne Rollen (Zielbild: SUPER_ADMIN, SUPPORT_ADMIN, BILLING_ADMIN, READ_ONLY_ADMIN). Bestehende Werte NONE/SUPER_ADMIN bleiben gültig.
ALTER TABLE "User" DROP CONSTRAINT "rb_user_platform_role";
ALTER TABLE "User" ADD CONSTRAINT "rb_user_platform_role" CHECK ("platformRole" IN ('NONE', 'SUPER_ADMIN', 'SUPPORT_ADMIN', 'BILLING_ADMIN', 'READ_ONLY_ADMIN'));

-- Feature-Freischaltung je Mandant
CREATE TABLE "TenantFeatureFlag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "updatedByName" TEXT,

    CONSTRAINT "TenantFeatureFlag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantFeatureFlag_tenantId_key_key" ON "TenantFeatureFlag"("tenantId", "key");
ALTER TABLE "TenantFeatureFlag" ADD CONSTRAINT "TenantFeatureFlag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Interne Tarif-/Abo-Verwaltung
CREATE TABLE "TenantSubscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trialEndsAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "monthlyPriceCents" INTEGER,
    "maxUsers" INTEGER,
    "maxVehicles" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "updatedByName" TEXT,

    CONSTRAINT "TenantSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TenantSubscription_tenantId_key" ON "TenantSubscription"("tenantId");
CREATE INDEX "TenantSubscription_status_idx" ON "TenantSubscription"("status");
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fachliche Regeln auch an der Anwendung vorbei
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "rb_subscription_plan" CHECK ("plan" IN ('TRIAL', 'STARTER', 'BUSINESS', 'ENTERPRISE', 'INTERNAL'));
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "rb_subscription_status" CHECK ("status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'ENDED'));
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "rb_subscription_limits" CHECK (
  ("monthlyPriceCents" IS NULL OR "monthlyPriceCents" >= 0)
  AND ("maxUsers" IS NULL OR "maxUsers" >= 1)
  AND ("maxVehicles" IS NULL OR "maxVehicles" >= 1)
);

-- Mandantenübergreifendes Audit-Log (Control Center: neueste Plattform-Aktionen, Filter nach Aktion)
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
