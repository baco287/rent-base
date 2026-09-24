// Globale Suche (Phase 19): eine Eingabe, alle Vorgangsarten des Mandanten. Nur Lesen, nur innerhalb des Mandanten,
// nur Felder, die die jeweilige Rolle ohnehin sehen darf. Kein externer Suchdienst: Postgres über Prisma, Vergleiche
// case-insensitiv, Kennzeichen und Telefonnummern normalisiert (nur Buchstaben/Ziffern). Rangfolge deterministisch:
// exakte Belegnummer > exaktes Kennzeichen/Kundennummer > exakter Name > Wortanfang > Teiltreffer > jüngstes Datum.
// Suchbegriffe werden nicht protokolliert (keine Personendaten im Audit oder in Logs).

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { AUTHORITY_CASE_STATUS, BOOKING_STATUS, CONTRACT_STATUS, DAMAGE_CASE_STATUS, INVOICE_DOCUMENT_TYPES, MAINTENANCE_STATUS, PAYOUT_STATUS, VEHICLE_STATUS, type AuthorityCaseStatus, type BookingStatus, type DamageCaseStatus, type InvoiceDocumentTypeKey, type MaintenanceStatus, type PayoutStatus, type VehicleStatus } from "@/lib/constants";
import { customerName } from "@/lib/format";
import { plateKey } from "@/lib/authority-matching";

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;
export const searchQuerySchema = z.string().trim().min(SEARCH_MIN, `Bitte mindestens ${SEARCH_MIN} Zeichen eingeben.`).max(SEARCH_MAX, `Höchstens ${SEARCH_MAX} Zeichen.`);

export const SEARCH_TYPES = {
  customer: "Kunden",
  booking: "Buchungen",
  vehicle: "Fahrzeuge",
  contract: "Mietverträge",
  invoice: "Rechnungen & Belege",
  payout: "Auszahlungen",
  damage: "Schadenakten",
  maintenance: "Wartung",
  authority: "Behördenvorgänge",
} as const;
export type SearchType = keyof typeof SEARCH_TYPES;
export const SEARCH_TYPE_ORDER: SearchType[] = ["customer", "booking", "vehicle", "contract", "invoice", "payout", "damage", "maintenance", "authority"];

export type SearchTone = "good" | "amber" | "bad" | "info" | "grey";
export type SearchHit = { type: SearchType; id: string; href: string; label: string; context: string; status: { text: string; tone: SearchTone } | null; date: string | null; score: number };
export type SearchGroup = { type: SearchType; label: string; hits: SearchHit[]; more: boolean; moreHref: string | null };
export type SearchResult = { q: string; groups: SearchGroup[]; total: number };

const ci = (v: string): Prisma.StringFilter => ({ contains: v, mode: "insensitive" });
const ciN = (v: string): Prisma.StringNullableFilter => ({ contains: v, mode: "insensitive" });

type Keys = { q: string; lower: string; plate: string; digits: string };
function keysOf(q: string): Keys {
  return { q, lower: q.toLowerCase(), plate: plateKey(q), digits: q.replace(/\D/g, "") };
}

/** Prozentzeichen sind in LIKE-Vergleichen Platzhalter und werden aus dem Suchbegriff entfernt (kein „alles finden“). */
export function cleanQuery(q: string): string {
  return q.replace(/%/g, "").trim();
}

/** Rang eines Treffers. exact: Belegnummern; keys: Kennzeichen/Kundennummer; names: Namen; texts: sonstige Felder. */
function scoreOf(k: Keys, f: { exact?: (string | null | undefined)[]; keys?: (string | null | undefined)[]; names?: (string | null | undefined)[]; texts?: (string | null | undefined)[] }): number {
  const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();
  if ((f.exact ?? []).some((s) => s && lc(s) === k.lower)) return 100;
  if ((f.keys ?? []).some((s) => s && (lc(s) === k.lower || (k.plate.length >= 3 && plateKey(s) === k.plate)))) return 90;
  if ((f.names ?? []).some((s) => s && lc(s) === k.lower)) return 80;
  const all = [...(f.exact ?? []), ...(f.keys ?? []), ...(f.names ?? []), ...(f.texts ?? [])];
  if (all.some((s) => s && (lc(s).startsWith(k.lower) || lc(s).split(/\s+/).some((w) => w.startsWith(k.lower))))) return 60;
  if (all.some((s) => s && (lc(s).includes(k.lower) || (k.plate.length >= 3 && plateKey(s).includes(k.plate)) || (k.digits.length >= 4 && s.replace(/\D/g, "").includes(k.digits))))) return 40;
  return 20;
}

const byRank = (a: SearchHit, b: SearchHit) => b.score - a.score || (b.date ?? "").localeCompare(a.date ?? "") || a.label.localeCompare(b.label, "de");
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Fahrzeugliste: IDs, deren Kennzeichen den Suchbegriff ohne Leerzeichen/Bindestriche enthält. */
export function vehicleIdsByPlate(tenantId: string, q: string) {
  return vehicleIdsByPlateKey(tenantId, plateKey(cleanQuery(q)));
}

/** Fahrzeug-IDs, deren Kennzeichen normalisiert (nur Buchstaben/Ziffern) den Suchschlüssel enthält. Parametrisiert, keine Interpolation. */
async function vehicleIdsByPlateKey(tenantId: string, key: string): Promise<string[]> {
  if (key.length < 2) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Vehicle" WHERE "tenantId" = ${tenantId} AND regexp_replace(upper(plate), '[^A-Z0-9ÄÖÜ]', '', 'g') LIKE ${"%" + key + "%"} LIMIT 50`;
  return rows.map((r) => r.id);
}

/** Kunden-IDs, deren Telefonnummer (nur Ziffern) die gesuchten Ziffern enthält. */
async function customerIdsByPhoneDigits(tenantId: string, digits: string): Promise<string[]> {
  if (digits.length < 4) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Customer" WHERE "tenantId" = ${tenantId} AND phone IS NOT NULL AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${"%" + digits + "%"} LIMIT 50`;
  return rows.map((r) => r.id);
}

const customerNameWhere = (q: string): Prisma.CustomerWhereInput => ({ OR: [{ lastName: ci(q) }, { firstName: ci(q) }, { companyName: ciN(q) }, { number: ciN(q) }] });

/** Kundenliste: dieselbe Suchlogik wie die globale Suche (Nummer, Name, Firma, E-Mail, Telefon normalisiert). */
export async function customerSearchWhere(tenantId: string, rawQ: string): Promise<Prisma.CustomerWhereInput> {
  const q = cleanQuery(rawQ);
  if (!q) return { tenantId };
  const k = keysOf(q);
  const phoneIds = await customerIdsByPhoneDigits(tenantId, k.digits);
  const words = q.split(/\s+/).filter(Boolean);
  const or: Prisma.CustomerWhereInput[] = [{ lastName: ci(q) }, { firstName: ci(q) }, { companyName: ciN(q) }, { number: ciN(q) }, { email: ciN(q) }, { phone: ciN(q) }];
  // „Erika Muster“ / „Muster Erika“: beide Wörter je in Vor- oder Nachname
  if (words.length === 2) or.push({ AND: [{ OR: [{ firstName: ci(words[0]) }, { lastName: ci(words[0]) }] }, { OR: [{ firstName: ci(words[1]) }, { lastName: ci(words[1]) }] }] });
  if (phoneIds.length) or.push({ id: { in: phoneIds } });
  return { tenantId, OR: or };
}

/** Buchungsliste: Nummer, Kunde (Name/Nummer), Kennzeichen, Fahrzeug, Vertragsnummer. */
export async function bookingSearchWhere(tenantId: string, rawQ: string): Promise<Prisma.BookingWhereInput> {
  const q = cleanQuery(rawQ);
  if (!q) return { tenantId };
  const k = keysOf(q);
  const plateIds = await vehicleIdsByPlateKey(tenantId, k.plate);
  const or: Prisma.BookingWhereInput[] = [{ number: ci(q) }, { customer: customerNameWhere(q) }, { vehicle: { OR: [{ plate: ci(q) }, { make: ci(q) }, { model: ci(q) }] } }, { contract: { number: ci(q) } }];
  if (plateIds.length) or.push({ vehicleId: { in: plateIds } });
  return { tenantId, OR: or };
}

const takeN = (n: number) => n + 1;

export type SearchOptions = { perType?: number; types?: SearchType[] };

/** Alle Vorgangsarten parallel, je Art höchstens perType Treffer (Rang sortiert). Rollen: FIN nur für Inhaber und Disposition. */
export async function globalSearch(tenantId: string, role: string, rawQ: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const q0 = searchQuerySchema.parse(rawQ);
  const q = cleanQuery(q0);
  if (q.length < SEARCH_MIN) return { q: q0, groups: [], total: 0 };
  const k = keysOf(q);
  const n = Math.min(50, Math.max(1, opts.perType ?? 6));
  const fetchN = takeN(n * 3);
  const types = opts.types ?? SEARCH_TYPE_ORDER;
  const canSeeVin = role === "OWNER" || role === "DISPO";
  const enc = encodeURIComponent(q);

  const [plateIds, phoneIds, driverIds] = await Promise.all([
    vehicleIdsByPlateKey(tenantId, k.plate),
    customerIdsByPhoneDigits(tenantId, k.digits),
    // Kunden, die als Fahrer in Behördenvorgängen stehen könnten (nur echte Referenz driverCustomerId, nie aus Kennzeichen oder Zeitraum abgeleitet)
    types.includes("authority") ? db.customer.findMany({ where: { tenantId, ...customerNameWhere(q) }, take: 50, select: { id: true } }).then((r) => r.map((x) => x.id)) : Promise.resolve([] as string[]),
  ]);
  const plateOr = plateIds.length ? [{ vehicleId: { in: plateIds } }] : [];
  const customerOr = (): Prisma.CustomerWhereInput => ({ OR: [...(customerNameWhere(q).OR as Prisma.CustomerWhereInput[]), { email: ciN(q) }, { phone: ciN(q) }, ...(phoneIds.length ? [{ id: { in: phoneIds } }] : [])] });

  const want = (t: SearchType) => types.includes(t);
  const [customers, bookings, vehicles, contracts, invoices, payouts, damages, maintenance, authority] = await Promise.all([
    want("customer") ? db.customer.findMany({ where: { tenantId, ...customerOr() }, take: fetchN, orderBy: { updatedAt: "desc" }, select: { id: true, number: true, type: true, firstName: true, lastName: true, companyName: true, email: true, phone: true, city: true, blocked: true, updatedAt: true } }) : [],
    want("booking") ? db.booking.findMany({ where: { tenantId, OR: [{ number: ci(q) }, { customer: customerNameWhere(q) }, { vehicle: { OR: [{ plate: ci(q) }, { make: ci(q) }, { model: ci(q) }] } }, ...plateOr] }, take: fetchN, orderBy: { startAt: "desc" }, select: { id: true, number: true, status: true, startAt: true, endAt: true, customer: { select: { type: true, firstName: true, lastName: true, companyName: true, number: true } }, vehicle: { select: { plate: true, make: true, model: true } } } }) : [],
    want("vehicle") ? db.vehicle.findMany({ where: { tenantId, OR: [{ plate: ci(q) }, { make: ci(q) }, { model: ci(q) }, ...(canSeeVin ? [{ vin: ciN(q) }] : []), ...(plateIds.length ? [{ id: { in: plateIds } }] : [])] }, take: fetchN, orderBy: { plate: "asc" }, select: { id: true, plate: true, make: true, model: true, vin: true, status: true, updatedAt: true } }) : [],
    want("contract") ? db.rentalContract.findMany({ where: { tenantId, OR: [{ number: ci(q) }, { booking: { OR: [{ number: ci(q) }, { customer: customerNameWhere(q) }, { vehicle: { plate: ci(q) } }, ...plateOr] } }] }, take: fetchN, orderBy: { createdAt: "desc" }, select: { id: true, number: true, status: true, bookingId: true, createdAt: true, signedAt: true, booking: { select: { number: true, customer: { select: { type: true, firstName: true, lastName: true, companyName: true } }, vehicle: { select: { plate: true } } } } } }) : [],
    want("invoice") ? db.invoice.findMany({ where: { tenantId, status: { in: ["DRAFT", "FINALIZED"] }, OR: [{ number: ciN(q) }, { booking: { OR: [{ number: ci(q) }, { customer: customerNameWhere(q) }] } }, { customer: customerNameWhere(q) }] }, take: fetchN, orderBy: [{ finalizedAt: "desc" }, { createdAt: "desc" }], select: { id: true, number: true, status: true, documentType: true, kind: true, bookingId: true, finalizedAt: true, createdAt: true, booking: { select: { number: true, customer: { select: { type: true, firstName: true, lastName: true, companyName: true } } } } } }) : [],
    want("payout") ? db.payout.findMany({ where: { tenantId, OR: [{ number: ciN(q) }, { reference: ciN(q) }, { recipientName: ci(q) }, { invoice: { number: ciN(q) } }, { booking: { number: ci(q) } }, { customer: customerNameWhere(q) }] }, take: fetchN, orderBy: { createdAt: "desc" }, select: { id: true, number: true, status: true, sourceType: true, amountCents: true, executedAt: true, createdAt: true, reference: true, booking: { select: { number: true } }, invoice: { select: { number: true } }, customer: { select: { type: true, firstName: true, lastName: true, companyName: true } } } }) : [],
    want("damage") ? db.damageCase.findMany({ where: { tenantId, OR: [{ caseNumber: ci(q) }, { vehicle: { plate: ci(q) } }, ...plateOr, { booking: { OR: [{ number: ci(q) }, { customer: customerNameWhere(q) }] } }] }, take: fetchN, orderBy: { createdAt: "desc" }, select: { id: true, caseNumber: true, status: true, liabilityStatus: true, description: true, createdAt: true, vehicle: { select: { plate: true } }, booking: { select: { number: true, customer: { select: { type: true, firstName: true, lastName: true, companyName: true } } } } } }) : [],
    want("maintenance") ? db.maintenanceRecord.findMany({ where: { tenantId, OR: [{ maintenanceNumber: ci(q) }, { title: ci(q) }, { workshopName: ciN(q) }, { vehicle: { plate: ci(q) } }, ...plateOr] }, take: fetchN, orderBy: { createdAt: "desc" }, select: { id: true, maintenanceNumber: true, title: true, status: true, workshopName: true, scheduledAt: true, createdAt: true, vehicle: { select: { plate: true } } } }) : [],
    want("authority") ? db.authorityCase.findMany({ where: { tenantId, OR: [{ caseNumber: ci(q) }, { authorityReference: ci(q) }, { authorityName: ci(q) }, { licensePlateSnapshot: ci(q) }, ...(k.plate.length >= 3 ? [{ licensePlateNormalized: { contains: k.plate } }] : []), ...(driverIds.length ? [{ driverCustomerId: { in: driverIds } }] : [])] }, take: fetchN, orderBy: { createdAt: "desc" }, select: { id: true, caseNumber: true, status: true, type: true, authorityName: true, authorityReference: true, licensePlateSnapshot: true, responseDeadline: true, createdAt: true, driverCustomerId: true } }) : [],
  ]);
  // Behördenvorgänge kennen den Fahrer nur als Referenz (driverCustomerId, keine Relation): Namen der Treffer nachladen
  const driverNames = new Map<string, string>();
  const driverRefs = [...new Set(authority.map((a) => a.driverCustomerId).filter((x): x is string => !!x))];
  if (driverRefs.length) for (const c of await db.customer.findMany({ where: { tenantId, id: { in: driverRefs } }, select: { id: true, type: true, firstName: true, lastName: true, companyName: true } })) driverNames.set(c.id, customerName(c));

  const groups: SearchGroup[] = [];
  const push = (type: SearchType, hits: SearchHit[], moreHref: string | null) => {
    if (hits.length === 0) return;
    const sorted = hits.sort(byRank);
    groups.push({ type, label: SEARCH_TYPES[type], hits: sorted.slice(0, n), more: sorted.length > n, moreHref });
  };

  push("customer", customers.map((c) => ({ type: "customer", id: c.id, href: `/kunden/${c.id}`, label: customerName(c), context: [c.number, c.type === "COMPANY" && c.companyName ? `${c.firstName} ${c.lastName}`.trim() : null, c.city, c.email, c.phone].filter(Boolean).join(" · "), status: c.blocked ? { text: "Gesperrt", tone: "bad" } : null, date: iso(c.updatedAt), score: scoreOf(k, { keys: [c.number], names: [customerName(c), `${c.firstName} ${c.lastName}`, c.lastName, c.firstName, c.companyName, c.email], texts: [c.phone] }) })), `/kunden?q=${enc}`);
  push("booking", bookings.map((b) => ({ type: "booking", id: b.id, href: `/buchungen/${b.id}`, label: `Buchung ${b.number}`, context: `${customerName(b.customer)} · ${b.vehicle.plate} · ${b.vehicle.make} ${b.vehicle.model} · ${dateRange(b.startAt, b.endAt)}`, status: { text: BOOKING_STATUS[b.status as BookingStatus] ?? b.status, tone: b.status === "ACTIVE" ? "amber" : b.status === "RESERVED" ? "info" : b.status === "RETURNED" ? "good" : "grey" }, date: iso(b.startAt), score: scoreOf(k, { exact: [b.number], keys: [b.vehicle.plate, b.customer.number], names: [customerName(b.customer)], texts: [b.customer.firstName, b.customer.lastName, b.vehicle.make, b.vehicle.model] }) })), `/buchungen?filter=alle&q=${enc}`);
  push("vehicle", vehicles.map((v) => ({ type: "vehicle", id: v.id, href: `/fahrzeuge/${v.id}`, label: v.plate, context: [`${v.make} ${v.model}`, canSeeVin && v.vin && v.vin.toLowerCase().includes(k.lower) ? `FIN ${v.vin}` : null].filter(Boolean).join(" · "), status: { text: VEHICLE_STATUS[v.status as VehicleStatus] ?? v.status, tone: v.status === "AVAILABLE" ? "good" : v.status === "BLOCKED" ? "bad" : "grey" }, date: iso(v.updatedAt), score: scoreOf(k, { keys: [v.plate], names: [`${v.make} ${v.model}`], texts: [v.make, v.model, canSeeVin ? v.vin : null] }) })), `/fahrzeuge?q=${enc}`);
  push("contract", contracts.map((c) => ({ type: "contract", id: c.id, href: `/buchungen/${c.bookingId}/vertrag`, label: `Mietvertrag ${c.number}`, context: `${customerName(c.booking.customer)} · ${c.booking.vehicle.plate} · Buchung ${c.booking.number}`, status: { text: CONTRACT_STATUS[c.status as keyof typeof CONTRACT_STATUS] ?? c.status, tone: c.status === "SIGNED" ? "good" : c.status === "DRAFT" ? "amber" : "grey" }, date: iso(c.signedAt ?? c.createdAt), score: scoreOf(k, { exact: [c.number, c.booking.number], keys: [c.booking.vehicle.plate], names: [customerName(c.booking.customer)] }) })), null);
  push("invoice", invoices.map((i) => ({ type: "invoice", id: i.id, href: `/buchungen/${i.bookingId}/rechnung?nr=${i.id}`, label: `${INVOICE_DOCUMENT_TYPES[i.documentType as InvoiceDocumentTypeKey] ?? i.documentType} ${i.number ?? "(Entwurf)"}`, context: `${customerName(i.booking.customer)} · Buchung ${i.booking.number}${i.kind === "DAMAGE" ? " · Schaden" : ""}`, status: i.status === "DRAFT" ? { text: "Entwurf", tone: "amber" } : { text: "Abgeschlossen", tone: "good" }, date: iso(i.finalizedAt ?? i.createdAt), score: scoreOf(k, { exact: [i.number, i.booking.number], names: [customerName(i.booking.customer)] }) })), `/rechnungen?beleg=alle&filter=alle`);
  push("payout", payouts.map((p) => ({ type: "payout", id: p.id, href: `/auszahlungen/${p.id}`, label: `Auszahlung ${p.number ?? "(Entwurf)"}`, context: [p.customer ? customerName(p.customer) : null, p.invoice?.number ? `Rechnung ${p.invoice.number}` : null, `Buchung ${p.booking.number}`, p.reference].filter(Boolean).join(" · "), status: { text: PAYOUT_STATUS[p.status as PayoutStatus] ?? p.status, tone: p.status === "COMPLETED" ? "good" : p.status === "DRAFT" ? "amber" : "bad" }, date: iso(p.executedAt ?? p.createdAt), score: scoreOf(k, { exact: [p.number, p.invoice?.number, p.booking.number], names: [p.customer ? customerName(p.customer) : null], texts: [p.reference] }) })), `/auszahlungen?filter=alle&q=${enc}`);
  push("damage", damages.map((d) => ({ type: "damage", id: d.id, href: `/schaeden/${d.id}`, label: `Schadenakte ${d.caseNumber}`, context: [d.vehicle.plate, d.description, d.booking ? `Buchung ${d.booking.number} · ${customerName(d.booking.customer)}` : null].filter(Boolean).join(" · "), status: { text: DAMAGE_CASE_STATUS[d.status as DamageCaseStatus] ?? d.status, tone: d.status === "CLOSED" ? "grey" : d.status === "REPAIRED" ? "good" : "amber" }, date: iso(d.createdAt), score: scoreOf(k, { exact: [d.caseNumber, d.booking?.number], keys: [d.vehicle.plate], names: [d.booking ? customerName(d.booking.customer) : null], texts: [d.description] }) })), `/schaeden?filter=alle&q=${enc}`);
  push("maintenance", maintenance.map((m) => ({ type: "maintenance", id: m.id, href: `/fahrzeuge/wartung/${m.id}`, label: `${m.maintenanceNumber} · ${m.title}`, context: [m.vehicle.plate, m.workshopName].filter(Boolean).join(" · "), status: { text: MAINTENANCE_STATUS[m.status as MaintenanceStatus] ?? m.status, tone: m.status === "COMPLETED" ? "good" : m.status === "CANCELLED" ? "grey" : "amber" }, date: iso(m.scheduledAt ?? m.createdAt), score: scoreOf(k, { exact: [m.maintenanceNumber], keys: [m.vehicle.plate], names: [m.title], texts: [m.workshopName] }) })), `/fahrzeuge/wartung?filter=alle&q=${enc}`);
  push("authority", authority.map((a) => ({ type: "authority", id: a.id, href: `/behoerden/${a.id}`, label: `${a.caseNumber} · ${a.authorityName}`, context: [`Az. ${a.authorityReference}`, a.licensePlateSnapshot, a.driverCustomerId && driverNames.get(a.driverCustomerId) ? `Fahrer ${driverNames.get(a.driverCustomerId)}` : null].filter(Boolean).join(" · "), status: { text: AUTHORITY_CASE_STATUS[a.status as AuthorityCaseStatus] ?? a.status, tone: a.status === "CLOSED" || a.status === "SUBMITTED" ? "good" : a.status === "CANCELLED" ? "grey" : "amber" }, date: iso(a.responseDeadline ?? a.createdAt), score: scoreOf(k, { exact: [a.caseNumber, a.authorityReference], keys: [a.licensePlateSnapshot], names: [a.authorityName, a.driverCustomerId ? driverNames.get(a.driverCustomerId) ?? null : null] }) })), `/behoerden?filter=alle&q=${enc}`);

  // Gruppen: die mit dem besten Treffer zuerst, bei Gleichstand in fester Reihenfolge
  const best = (g: SearchGroup) => g.hits[0]?.score ?? 0;
  groups.sort((a, b) => best(b) - best(a) || SEARCH_TYPE_ORDER.indexOf(a.type) - SEARCH_TYPE_ORDER.indexOf(b.type));
  return { q, groups, total: groups.reduce((s, g) => s + g.hits.length, 0) };
}

const dFmt = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" });
function dateRange(a: Date, b: Date) {
  return `${dFmt.format(a)} – ${dFmt.format(b)}`;
}
