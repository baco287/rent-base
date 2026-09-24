
-- CreateIndex
CREATE INDEX "AuthorityCase_tenantId_driverCustomerId_idx" ON "AuthorityCase"("tenantId", "driverCustomerId");

-- CreateIndex
CREATE INDEX "Booking_tenantId_customerId_startAt_idx" ON "Booking"("tenantId", "customerId", "startAt");

-- CreateIndex
CREATE INDEX "ContractDriver_tenantId_customerId_idx" ON "ContractDriver"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_email_idx" ON "Customer"("tenantId", "email");

-- CreateIndex
CREATE INDEX "EmailLog_tenantId_payoutId_idx" ON "EmailLog"("tenantId", "payoutId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_customerId_idx" ON "Invoice"("tenantId", "customerId");

