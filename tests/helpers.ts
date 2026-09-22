// Gemeinsame Helfer für die Integrationstests gegen die lokale Entwicklungsdatenbank.
import { db } from "../src/lib/db";

export type World = { tenantId: string; userId: string; groupId: string; vehicleId: string; customerId: string; bookingId: string; actor: { id: string; name: string } };

const DAY = 24 * 3600_000;

/** Ein vollständiger Mandant mit Mitarbeiter, Gruppe, Fahrzeug, vollständigem Kunden und reservierter Buchung über 6 Tage. */
export async function createWorld(label: string, opts: { customer?: Record<string, unknown>; startInDays?: number } = {}): Promise<World> {
  const run = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tenant = await db.tenant.create({ data: { name: `Test ${run}`, slug: `test-${run}`, street: "Hafenstr. 1", zip: "28195", city: "Bremen", rentalTermsVersion: "2026-09", rentalTermsText: "§1 Das Fahrzeug ist pfleglich zu behandeln." } });
  const user = await db.user.create({ data: { tenantId: tenant.id, email: `u-${run}@example.test`, name: "Test Mitarbeiter", passwordHash: "x", role: "YARD" } });
  const group = await db.vehicleGroup.create({ data: { tenantId: tenant.id, name: "Transporter", bodyType: "TRANSPORTER", dailyRate: 89 } });
  const vehicle = await db.vehicle.create({ data: { tenantId: tenant.id, plate: `HB-T ${run.slice(-5)}`, make: "VW", model: "Crafter", groupId: group.id, fuel: "DIESEL", mileage: 50_000, dailyRate: 89, workWeekRate: 420, weeklyRate: 540, kmIncludedPerDay: 200, extraKmRate: 0.25, deposit: 500, tankCapacityLiters: 75 } });
  const customer = await db.customer.create({
    data: {
      tenantId: tenant.id, number: "K-00001", firstName: "Erika", lastName: "Muster", street: "Weg 1", zip: "28195", city: "Bremen", country: "DE", phone: "0421 12345", email: "erika@example.test",
      birthDate: new Date("1985-03-12"), idType: "PERSONALAUSWEIS", idNumber: "L01X00T47", idValidUntil: new Date("2031-01-01"),
      licenseNumber: "B072RRE2I55", licenseClass: "B", licenseIssuedAt: new Date("2005-06-01"), licenseValidUntil: new Date("2033-06-01"), discountPercent: 10,
      ...(opts.customer ?? {}),
    },
  });
  const start = new Date(Date.now() + (opts.startInDays ?? 1) * DAY);
  const booking = await db.booking.create({ data: { tenantId: tenant.id, number: `T-${run}`, vehicleId: vehicle.id, customerId: customer.id, startAt: start, endAt: new Date(start.getTime() + 6 * DAY), dailyRate: 89, workWeekRate: 420, weeklyRate: 540, deposit: 500 } });
  return { tenantId: tenant.id, userId: user.id, groupId: group.id, vehicleId: vehicle.id, customerId: customer.id, bookingId: booking.id, actor: { id: user.id, name: user.name } };
}

/** Entfernt einen Testmandanten vollständig. Endgültiges Löschen braucht die ausdrückliche Freigabe in der Transaktion. */
export async function purgeTenants(tenantIds: string[]) {
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL rentbase.allow_purge = 'on'`);
      for (const t of tenantIds) {
        const w = { where: { tenantId: t } };
        await tx.emailLog.deleteMany(w);
        await tx.auditLog.deleteMany(w);
        await tx.payment.deleteMany(w);
        await tx.securityDepositEvent.deleteMany(w);
        await tx.securityDeposit.deleteMany(w);
        await tx.vehicleEvent.deleteMany(w);
        await tx.extraCharge.deleteMany(w);
        await tx.document.deleteMany(w);
        await tx.invoiceItem.deleteMany(w);
        await tx.invoice.deleteMany(w);
        await tx.signature.deleteMany(w);
        await tx.photo.deleteMany(w);
        await tx.handoverChecklistItem.deleteMany(w);
        await tx.handoverDamage.deleteMany(w);
        await tx.damage.deleteMany(w);
        await tx.handover.deleteMany(w);
        await tx.contractDriver.deleteMany(w);
        await tx.rentalContract.deleteMany(w);
        await tx.checklistTemplate.deleteMany(w);
        await tx.booking.deleteMany(w);
        await tx.customer.deleteMany(w);
        await tx.vehicle.deleteMany(w);
        await tx.vehicleGroup.deleteMany(w);
        await tx.vehicleSketch.deleteMany(w);
        await tx.session.deleteMany({ where: { user: { tenantId: t } } });
        await tx.user.deleteMany(w);
        await tx.tenant.deleteMany({ where: { id: t } });
      }
    },
    { timeout: 60_000, maxWait: 20_000 },
  );
}

/** PNG-Data-URL für Unterschriften im Test. Der Server prüft Kennung und Größe, nicht den Bildinhalt. */
export function fakeSignaturePng(seed = 1): string {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(1500, seed % 251);
  return `data:image/png;base64,${Buffer.concat([head, body]).toString("base64")}`;
}
