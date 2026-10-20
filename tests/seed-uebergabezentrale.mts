// Befehl 29.7: lokale Sichtprüfung der Übergabe- und Rückgabezentrale mit den längsten Beschriftungen (langer Firmenname,
// langes Fahrzeugmodell, alle Status, Nachtragshinweise, Schlüsselbox, Unfallersatz mit offenem und überschrittenem Mietende,
// Entwürfe, Altfall). Nur lokale Entwicklungsdatenbank, nur Testdaten (direkt angelegt, ohne Geschäftslogik).
// Aufruf: npx tsx tests/seed-uebergabezentrale.mts   ·   Aufräumen: npx tsx tests/purge-test-tenants.mts
// Prüfen bei den Auftragsbreiten 390, 820, 1280, 1440 und 1920 px: /uebergaben und /rueckgaben (alle Filter, mehrere Einträge,
// Überfällige, Entwürfe, Abgeschlossene, Unfallersatz mit offenem Mietende, leere Zustände) – in der Browser-Konsole muss
// `document.documentElement.scrollWidth <= innerWidth` true ergeben (kein horizontales Scrollen), bei 390 px auch mit einer
// 80 Zeichen langen Suche ohne Leerzeichen. Unter xl (390/820 px) Karten, ab xl (1280/1440/1920 px) Tabelle; bei 1280 px
// mit ausgeklappter Seitenleiste die Hinweisspalte (Entwurf + Nachtrag) prüfen.
// Mobile Navigation: bei 390 px das Menü als Drawer über den Menü-Knopf der Kopfleiste öffnen – „Übergaben“ und „Rückgaben“
// mit Zähler unter „Vermietung“, aktiver Eintrag markiert, Drawer schließt beim Seitenwechsel; bei 820 px die Icon-Leiste
// (5 Einträge in „Vermietung“, Tooltip mit Zählertext, aktiver Eintrag markiert).
// Dazu (Prüfbefund UI-1): suchen, dann „Suche löschen“ → Suchfeld leer; bei „Anstehend“ einen Zeitraum anwenden, dann auf
// „Abgeschlossen“ wechseln → beide Datumsfelder leer.
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { berlinDay, createWorld } from "./helpers";

// Prüfbefund R3: legt einen Inhaber mit bekanntem Passwort an – nie gegen eine nicht-lokale Datenbank (wie seed-miettarife-praxis.mts)
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Nur gegen eine lokale Datenbank.");
const w = await createWorld("ui-zentrale", { startInDays: 30 });
await db.tenant.update({ where: { id: w.tenantId }, data: { name: "Test Zentrale Sicht", city: "Bremen" } });
const stamp = Date.now().toString(36);
const owner = await db.user.create({ data: { tenantId: w.tenantId, email: `ui-zentrale-${stamp}@example.test`, name: "Inhaber Sicht", passwordHash: await hashPassword("vermieter-test-1"), role: "OWNER" } });
const firm = await db.customer.create({ data: { tenantId: w.tenantId, number: "K-00002", type: "COMPANY", companyName: "Norddeutsche Spedition und Logistik Gesellschaft mit beschränkter Haftung & Co. KG", firstName: "Hans-Joachim", lastName: "Mustermann-Lüdenscheid", phone: "0421 777888" } });

let n = 0;
const vehicle = (model = "Crafter 35 Kastenwagen Hochdach lang Plus") => db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-ZS ${100 + n++}`, make: "Volkswagen Nutzfahrzeuge", model, groupId: w.groupId, dailyRate: 89, deposit: 0, requiredLicenseClass: "B" } });
const booking = async (number: string, data: { status?: string; rentalType?: string; startAt: Date; endAt: Date | null; customerId?: string }) => {
  const v = await vehicle();
  const status = data.status ?? "RESERVED";
  return db.booking.create({ data: { tenantId: w.tenantId, number, vehicleId: v.id, customerId: data.customerId ?? firm.id, status, rentalType: data.rentalType ?? "STANDARD", startAt: data.startAt, endAt: data.endAt, actualPickupAt: status === "ACTIVE" ? data.startAt : null, dailyRate: 89, deposit: 0 } });
};
const contract = (b: { id: string; customerId: string; vehicleId: string; startAt: Date; endAt: Date | null }) => db.rentalContract.create({ data: { tenantId: w.tenantId, bookingId: b.id, number: `MV-ZS-${stamp}-${n++}`, status: "SIGNED", customerId: b.customerId, vehicleId: b.vehicleId, customerSnapshot: {}, vehicleSnapshot: {}, priceSnapshot: {}, startAt: b.startAt, endAt: b.endAt, signedAt: new Date() } });
const agreed = async (b: Awaited<ReturnType<typeof booking>>, change: { newEndAt?: Date; newStartAt?: Date }) => {
  const c = await contract(b);
  await db.contractAmendment.create({ data: { tenantId: w.tenantId, contractId: c.id, bookingId: b.id, idempotencyKey: `zs-${stamp}-${n++}`, status: "AGREED", agreedAt: new Date(), agreedChannel: "PHONE", newEndAt: change.newEndAt ?? null, newStartAt: change.newStartAt ?? null } });
};
const handover = (b: { id: string; vehicleId: string }, type: "PICKUP" | "RETURN", status: "DRAFT" | "FINALIZED") =>
  db.handover.create({ data: { tenantId: w.tenantId, bookingId: b.id, vehicleId: b.vehicleId, type, status, number: `${type === "PICKUP" ? "UP" : "RP"}-ZS-${stamp}-${n++}`, employeeName: "Maximilian Hofmitarbeiter-Langname", driveType: "DIESEL", wizardStep: 4, finalizedAt: status === "FINALIZED" ? new Date() : null } });

// Übergaben: heute (verstrichen und später), überfällig, anstehend, Entwurf, neuer Beginn vereinbart
await booking(`ZS-${stamp}-H1`, { startAt: berlinDay(0, 7, 30), endAt: berlinDay(3, 9, 0) });
const pickDraft = await booking(`ZS-${stamp}-H2`, { startAt: berlinDay(0, 21, 45), endAt: berlinDay(4, 9, 0) });
await contract(pickDraft);
await handover(pickDraft, "PICKUP", "DRAFT");
await booking(`ZS-${stamp}-U1`, { startAt: berlinDay(-1, 23, 59), endAt: berlinDay(2, 9, 0) });
await booking(`ZS-${stamp}-U2`, { startAt: berlinDay(-40, 10, 0), endAt: berlinDay(-38, 10, 0) });
await agreed(await booking(`ZS-${stamp}-U3`, { startAt: berlinDay(-2, 10, 0), endAt: berlinDay(5, 10, 0) }), { newStartAt: berlinDay(2, 10, 0) });
for (let i = 1; i <= 6; i++) await booking(`ZS-${stamp}-A${i}`, { startAt: berlinDay(i, 8 + i, 15), endAt: berlinDay(i + 3, 9, 0) });

// Rückgaben: heute, überfällig, Verlängerung/Verkürzung vereinbart, Schlüsselbox, Unfallersatz, Entwurf, Altfall, abgeschlossen
const active = (number: string, endAt: Date | null, rentalType = "STANDARD") => booking(number, { status: "ACTIVE", rentalType, startAt: berlinDay(-5, 9, 0), endAt });
const r1 = await active(`ZS-${stamp}-R1`, berlinDay(0, 8, 0));
await contract(r1);
await handover(r1, "PICKUP", "FINALIZED");
await handover(r1, "RETURN", "DRAFT");
await active(`ZS-${stamp}-R2`, berlinDay(-3, 10, 0));
await agreed(await active(`ZS-${stamp}-R3`, berlinDay(-1, 10, 0)), { newEndAt: berlinDay(0, 18, 0) });
await agreed(await active(`ZS-${stamp}-R4`, berlinDay(0, 20, 0)), { newEndAt: berlinDay(-1, 12, 0) });
const kd = await active(`ZS-${stamp}-R5`, berlinDay(2, 12, 0));
await db.keyDropReturn.create({ data: { tenantId: w.tenantId, bookingId: kd.id, status: "CUSTOMER_CONFIRMED", agreedById: owner.id, agreedByName: owner.name, location: "Schlüsselbox Hof Nord", expectedReturnAt: berlinDay(2, 12, 0), settingsSnapshot: {}, recipientName: "Hans-Joachim Mustermann-Lüdenscheid", customerDropOffAt: berlinDay(0, 6, 40) } });
const kdA = await active(`ZS-${stamp}-R6`, berlinDay(1, 12, 0));
await db.keyDropReturn.create({ data: { tenantId: w.tenantId, bookingId: kdA.id, status: "AUTHORIZED", agreedById: owner.id, agreedByName: owner.name, location: "Schlüsselbox Hof Nord", expectedReturnAt: berlinDay(1, 12, 0), settingsSnapshot: {}, recipientName: "Hans-Joachim Mustermann-Lüdenscheid" } });
await active(`ZS-${stamp}-R7`, null, "ACCIDENT_REPLACEMENT");
await active(`ZS-${stamp}-R8`, berlinDay(-2, 10, 0), "ACCIDENT_REPLACEMENT");
await active(`ZS-${stamp}-R9`, berlinDay(0, 15, 0), "ACCIDENT_REPLACEMENT");
await active(`ZS-${stamp}-R10`, berlinDay(3, 9, 0));
const done = await booking(`ZS-${stamp}-R11`, { status: "RETURNED", startAt: berlinDay(-6, 9, 0), endAt: berlinDay(-1, 9, 0) });
await db.booking.update({ where: { id: done.id }, data: { actualPickupAt: berlinDay(-6, 9, 5), actualReturnAt: berlinDay(-1, 8, 50) } });
await handover(done, "PICKUP", "FINALIZED");
await handover(done, "RETURN", "FINALIZED");

console.log(`Login: ${owner.email} / vermieter-test-1`);
console.log("Seiten: /uebergaben, /uebergaben?filter=ueberfaellig, /uebergaben?filter=anstehend, /uebergaben?filter=in_bearbeitung,");
console.log("        /rueckgaben, /rueckgaben?filter=ueberfaellig, /rueckgaben?filter=offenes_ende, /rueckgaben?filter=abgeschlossen");
await db.$disconnect();
