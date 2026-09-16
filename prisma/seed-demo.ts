// Beispieldaten für die lokale Entwicklung. Hängt Fahrzeuge, Kunden und Buchungen an den ersten Mandanten.
// Aufruf: npm run seed:demo   (nur lokal, nie auf dem Live-Server)
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function at(dayOffset: number, hour: number) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

async function main() {
  const tenant = await db.tenant.findFirst({ orderBy: { createdAt: "asc" } });
  if (!tenant) throw new Error("Kein Mandant vorhanden. Erst die Ersteinrichtung im Browser abschließen.");
  const existing = await db.vehicle.count({ where: { tenantId: tenant.id } });
  if (existing > 0) {
    console.log("Mandant hat schon Fahrzeuge, Beispieldaten werden nicht erneut angelegt.");
    return;
  }
  const t = tenant.id;

  const vehicles = await Promise.all([
    db.vehicle.create({ data: { tenantId: t, plate: "H-MB 2041", make: "VW", model: "T6.1 Transporter Kasten", category: "TRANSPORTER", fuel: "DIESEL", year: 2022, mileage: 61230, huDate: new Date("2027-03-31"), dailyRate: 89, weeklyRate: 490, deposit: 500 } }),
    db.vehicle.create({ data: { tenantId: t, plate: "H-MB 887", make: "Mercedes", model: "Sprinter 316 CDI", category: "TRANSPORTER", fuel: "DIESEL", year: 2020, mileage: 142870, huDate: at(9, 0), dailyRate: 109, weeklyRate: 590, deposit: 750 } }),
    db.vehicle.create({ data: { tenantId: t, plate: "H-MB 3310", make: "VW", model: "Crafter L3H2", category: "TRANSPORTER", fuel: "DIESEL", year: 2023, mileage: 38410, huDate: new Date("2027-05-31"), dailyRate: 119, weeklyRate: 640, deposit: 750 } }),
    db.vehicle.create({ data: { tenantId: t, plate: "H-MB 1188", make: "VW", model: "Golf 8 1.5 TSI", category: "KOMPAKT", fuel: "BENZIN", year: 2023, mileage: 27905, huDate: new Date("2027-11-30"), dailyRate: 49, weeklyRate: 260, deposit: 300 } }),
    db.vehicle.create({ data: { tenantId: t, plate: "H-MB 1190", make: "VW", model: "Polo 1.0 TSI", category: "KOMPAKT", fuel: "BENZIN", year: 2021, mileage: 54120, huDate: new Date("2027-02-28"), dailyRate: 39, weeklyRate: 210, deposit: 300 } }),
    db.vehicle.create({ data: { tenantId: t, plate: "H-MB 4507", make: "Skoda", model: "Octavia Combi", category: "KOMBI", fuel: "DIESEL", year: 2022, mileage: 71640, huDate: new Date("2027-06-30"), dailyRate: 59, weeklyRate: 320, deposit: 300 } }),
    db.vehicle.create({ data: { tenantId: t, plate: "H-MB 720", make: "Ford", model: "Transit Custom", category: "TRANSPORTER", fuel: "DIESEL", year: 2019, mileage: 168300, huDate: new Date("2027-01-31"), dailyRate: 89, weeklyRate: 490, deposit: 500, status: "WORKSHOP", notes: "Kupplung, Werkstatt Meyer" } }),
    db.vehicle.create({ data: { tenantId: t, plate: "H-MB 918", make: "VW", model: "Caddy Maxi", category: "KOMBI", fuel: "DIESEL", year: 2021, mileage: 88200, huDate: new Date("2027-04-30"), dailyRate: 55, weeklyRate: 300, deposit: 300 } }),
  ]);
  const [t6, sprinter, crafter, golf, polo, octavia, , caddy] = vehicles;

  const customers = await Promise.all([
    db.customer.create({ data: { tenantId: t, type: "COMPANY", companyName: "Dachdecker Wille GmbH", firstName: "Tobias", lastName: "Wille", phone: "0511 440912", email: "buero@wille-dach.example", street: "Deisterstraße 12", zip: "30449", city: "Hannover", licenseNumber: "B072RRE2I55", licenseClass: "B", licenseIssuedAt: new Date("2009-04-12"), licenseValidUntil: new Date("2034-04-11"), discountPercent: 10 } }),
    db.customer.create({ data: { tenantId: t, type: "PRIVATE", firstName: "Emre", lastName: "Öztürk", phone: "0176 22814055", street: "Limmerstraße 45", zip: "30451", city: "Hannover", birthDate: new Date("1988-07-03"), licenseClass: "B" } }),
    db.customer.create({ data: { tenantId: t, type: "PRIVATE", firstName: "Lena", lastName: "Hartmann", phone: "0170 5512998", city: "Garbsen", birthDate: new Date("2003-02-17"), licenseNumber: "L118KJD9Q33", licenseClass: "B", licenseIssuedAt: new Date("2024-05-02"), licenseValidUntil: new Date("2039-05-01") } }),
    db.customer.create({ data: { tenantId: t, type: "PRIVATE", firstName: "Marco", lastName: "Steiner", phone: "0152 98773120", city: "Laatzen", licenseNumber: "S331PPA1X09", licenseClass: "B", licenseIssuedAt: new Date("2012-09-20"), licenseValidUntil: new Date("2027-09-19") } }),
    db.customer.create({ data: { tenantId: t, type: "PRIVATE", firstName: "Kevin", lastName: "Baumgart", phone: "0163 40127710", city: "Hannover", licenseNumber: "B909ZZT4M21", licenseClass: "B", licenseValidUntil: new Date("2025-11-30"), blocked: true, blockReason: "Schaden nicht bezahlt" } }),
    db.customer.create({ data: { tenantId: t, type: "COMPANY", companyName: "Nowak Umzüge", firstName: "Piotr", lastName: "Nowak", phone: "0511 27330", email: "info@nowak-umzuege.example", street: "Vahrenwalder Str. 200", zip: "30165", city: "Hannover", licenseNumber: "N554QWE7B18", licenseClass: "B", licenseIssuedAt: new Date("2001-03-15"), licenseValidUntil: new Date("2031-03-14") } }),
  ]);
  const [wille, oeztuerk, hartmann, steiner, , nowak] = customers;

  const b = async (n: number, vehicleId: string, customerId: string, startAt: Date, endAt: Date, status: string, dailyRate: number, deposit: number) =>
    db.booking.create({ data: { tenantId: t, number: `${startAt.getFullYear()}-${String(n).padStart(4, "0")}`, vehicleId, customerId, startAt, endAt, status, dailyRate, deposit } });

  await b(1, sprinter.id, wille.id, at(-6, 7), at(0, 10), "ACTIVE", 109, 750);
  await b(2, polo.id, steiner.id, at(-4, 10), at(-2, 18), "ACTIVE", 39, 300); // überfällig
  await b(3, octavia.id, wille.id, at(-1, 8), at(4, 17), "ACTIVE", 59, 300);
  await b(4, t6.id, oeztuerk.id, at(0, 9), at(3, 9), "RESERVED", 89, 500);
  await b(5, golf.id, hartmann.id, at(1, 11), at(2, 11), "RESERVED", 49, 300);
  await b(6, crafter.id, nowak.id, at(0, 14), at(5, 12), "RESERVED", 119, 750);
  await b(7, t6.id, hartmann.id, at(5, 9), at(7, 9), "RESERVED", 89, 500);
  await b(8, caddy.id, wille.id, at(2, 8), at(3, 18), "RESERVED", 55, 300);
  await b(9, crafter.id, nowak.id, at(7, 8), at(12, 17), "RESERVED", 119, 750);
  await b(10, golf.id, oeztuerk.id, at(-20, 9), at(-18, 9), "RETURNED", 49, 300);

  console.log(`Beispieldaten angelegt für ${tenant.name}: ${vehicles.length} Fahrzeuge, ${customers.length} Kunden, 10 Buchungen.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
