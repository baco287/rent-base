-- AlterTable: Vermieterdaten werden beim Vertragsabschluss mit eingefroren (nur neue Spalte, bestehende Verträge bleiben unberührt)
ALTER TABLE "RentalContract" ADD COLUMN     "landlordSnapshot" JSONB;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "sourceHash" TEXT;

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN     "handoverId" TEXT,
ADD COLUMN     "trigger" TEXT NOT NULL DEFAULT 'AUTO',
ADD COLUMN     "attemptNo" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "createdById" TEXT;

-- CreateIndex
CREATE INDEX "EmailLog_tenantId_bookingId_createdAt_idx" ON "EmailLog"("tenantId", "bookingId", "createdAt");

-- Von Hand ergänzt: zweite Sicherung gegen doppelt erzeugte Dokumente.
-- Je Vertrag bzw. Protokoll, Dokumenttyp und Version gibt es höchstens eine Zeile, auch bei gleichzeitigen Anfragen.
CREATE UNIQUE INDEX "rb_document_one_per_version" ON "Document" ("tenantId", "type", COALESCE("contractId", ''), COALESCE("handoverId", ''), "version");

-- Von Hand ergänzt: EmailLog-Status nur mit bekannten Werten
ALTER TABLE "EmailLog" ADD CONSTRAINT "rb_emaillog_status" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED'));
