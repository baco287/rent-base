// Gemeinsame Vertragsdarstellung (ViewModel).
// Die Zusammenfassung im Assistenten, die Vertragsansicht und später das PDF werden alle aus dieser einen
// Struktur erzeugt. Sie entsteht ausschließlich aus den Daten des Vertrags (Snapshots), nie aus Live-Stammdaten.
// So kann die Oberfläche nie etwas anderes zeigen als das Dokument.

import { logoRefFromSnapshot, logoRefOf, type LogoRef } from "@/lib/branding-ref";
import type { Prisma } from "@prisma/client";
import { ADDITIONAL_DRIVER_FEE_TYPES, COUNTRIES, CUSTOMER_TYPES, DRIVER_MODES, FUELS, FUEL_POLICIES, ID_TYPES, KM_POLICIES, LATE_RETURN_RULES, OUT_OF_HOURS_RETURN, PETS_POLICIES, driveClassOf } from "@/lib/constants";
import { readContractRules, type ContractRules } from "@/lib/business-rules";
import type { ContractPriceSnapshot, CustomerSnapshot, VehicleSnapshot } from "@/lib/contracts";
import { parseTerms, type TermsBlock } from "@/lib/terms-markdown";
import { APP_TIME_ZONE } from "@/lib/time";

export type DocRow = { label: string; value: string; missing?: boolean };
export type DocSection = { key: string; title: string; rows: DocRow[] };
export type DocPriceLine = { text: string; amount: string };

export type LandlordInfo = { name: string; address: string; contact: string; email: string | null; logo?: LogoRef | null };

/** Vermieterdaten für Dokumente. Beim Abschluss wird diese Struktur im Vertrag eingefroren (landlordSnapshot). */
export function landlordFromTenant(t: TenantLike): LandlordInfo {
  return {
    name: t.name,
    address: [t.street, [t.zip, t.city].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    contact: [t.phone, t.email, t.website?.replace(/^https?:\/\//i, "")].filter(Boolean).join(" · "),
    email: t.email,
    // Befehl 20.5: nur beim Einfrieren (Vertragsabschluss) mit Logo-Feldern aufgerufen; Rückfall ohne Snapshot bleibt ohne Logo
    logo: logoRefOf(t),
  };
}

/** Eingefrorene Vermieterdaten des Vertrags; nur bei älteren Verträgen ohne Kopie greifen die aktuellen Stammdaten. */
export function landlordOf(snapshot: unknown, tenant: TenantLike): LandlordInfo {
  const s = snapshot as Partial<LandlordInfo> | null;
  if (s && typeof s === "object" && typeof s.name === "string") return { name: s.name, address: String(s.address ?? ""), contact: String(s.contact ?? ""), email: typeof s.email === "string" ? s.email : null, logo: logoRefFromSnapshot(s) };
  return landlordFromTenant(tenant);
}

export type ContractDocument = {
  title: string;
  number: string;
  status: string;
  landlord: LandlordInfo;
  /** E-Mail-Adresse des Mieters aus der Vertragskopie; an sie gehen die Unterlagen. */
  renterEmail: string | null;
  renterName: string;
  vehicleTitle: string;
  plate: string;
  startAt: string;
  createdAt: string;
  signedAt: string | null;
  contentHash: string | null;
  sections: DocSection[];
  additionalDrivers: DocSection[];
  price: { days: number; lines: DocPriceLine[]; subtotal: string; discount: DocPriceLine | null; calculated: string; agreed: DocPriceLine | null; extras: DocPriceLine[]; total: string; deposit: string };
  /** Geschäftsregeln des Vertrags (eingefroren) – konkrete Werte, keine Rechtsaussagen */
  rules: DocSection | null;
  /** Individuelle Vereinbarungen, Teil des unterschriebenen Inhalts */
  individualAgreements: string | null;
  /** Mietbedingungen: Fassung, Text; blocks nur bei Markdown (versionierte Fassung), legacy = unversionierter Altbestand */
  terms: { version: string | null; text: string | null; format: "MARKDOWN" | "PLAIN" | null; blocks: TermsBlock[] | null; legacy: boolean; title: string; acknowledgedAt: string | null };
  signatures: { id: string; role: string; roleLabel: string; signerName: string; signedAt: string; imageUrl: string }[];
};

/** Name laut Auftrag: die Dokumentdaten des Mietvertrags. HTML-Ansicht und PDF lesen ausschließlich diese Struktur. */
export type ContractDocumentData = ContractDocument;

const eur = (v: unknown) => Number(v ?? 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const date = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }) : "");
const dateTime = (v: unknown) => (v ? new Date(String(v)).toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const label = <T extends Record<string, string>>(map: T, key: unknown) => (typeof key === "string" && key in map ? map[key as keyof T] : key ? String(key) : "");
const row = (l: string, v: unknown, required = false): DocRow => {
  const value = v === null || v === undefined ? "" : String(v).trim();
  return { label: l, value: value || "–", missing: required && !value };
};
const cents = (c: number | null | undefined) => (c == null ? null : (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" }));
const countryList = (codes: string[]) => codes.map((c) => COUNTRIES[c as keyof typeof COUNTRIES] ?? c).join(", ");

/** Geschäftsregeln als Vertragsabschnitt: nur konkrete, eingefrorene Werte. Herkunft steht nicht im Dokument. */
export function rulesSection(rules: ContractRules | null, contract: { kmIncludedPerDay: number; extraKmRate: unknown; fuelPolicy: string; fuelPolicyNote: string | null; deductible: unknown }, fuel: string | null | undefined, additionalDrivers: number, days: number): DocSection | null {
  if (!rules) return null;
  const v = rules.values;
  const cls = driveClassOf(fuel ?? "DIESEL");
  const km = v.kmPolicy === "UNLIMITED" ? "Unbegrenzte Kilometer" : v.kmPolicy === "INDIVIDUAL" ? `Individuell: ${v.kmPolicyNote ?? ""}`.trim() : `${contract.kmIncludedPerDay.toLocaleString("de-DE")} km je Tag (gesamt ${(contract.kmIncludedPerDay * days).toLocaleString("de-DE")} km), Mehrkilometer ${eur(contract.extraKmRate)} je km`;
  const fuelRule = (() => {
    const base = label(FUEL_POLICIES, contract.fuelPolicy);
    if (contract.fuelPolicy === "OTHER") return `${base}: ${contract.fuelPolicyNote ?? ""}`;
    if (contract.fuelPolicy === "MINIMUM_LEVEL") {
      const parts = [cls !== "ELECTRIC" && v.fuelMinimumEighths != null ? `Tank mindestens ${v.fuelMinimumEighths}/8` : null, cls !== "COMBUSTION" && v.batteryMinimumPercent != null ? `Batterie mindestens ${v.batteryMinimumPercent} %` : null].filter(Boolean);
      return `${base}: ${parts.join(", ")}`;
    }
    return base;
  })();
  const fee = v.additionalDriverFeeType === "FREE" ? "kostenlos" : `${cents(v.additionalDriverFeeCents)} ${v.additionalDriverFeeType === "PER_DAY" ? "je Zusatzfahrer und Miettag" : "je Zusatzfahrer"}`;
  const rows: DocRow[] = [
    row("Kilometerregel", km),
    row(cls === "ELECTRIC" ? "Laderegel" : cls === "PHEV" ? "Tank- und Laderegel" : "Tankregelung", fuelRule),
    row("Selbstbeteiligung", eur(contract.deductible)),
    row("Auslandsfahrten", v.abroadAllowed ? `Genehmigt für: ${countryList(v.abroadCountries)}` : "Nicht gestattet"),
    row("Rauchen im Fahrzeug", v.smokingAllowed ? "Gestattet" : "Nicht gestattet"),
    row("Tiere im Fahrzeug", label(PETS_POLICIES, v.petsPolicy)),
    row("Zusatzfahrer", v.additionalDriversAllowed ? `${additionalDrivers} eingetragen, ${fee}` : "Nicht vorgesehen"),
    row("Mindestalter Fahrer", `${v.minimumDriverAge} Jahre${v.minimumLicenseHoldingMonths > 0 ? `, Führerschein seit mindestens ${v.minimumLicenseHoldingMonths} Monaten` : ""}`),
    row("Verspätete Rückgabe", v.lateReturnRule === "CONFIGURED_FEE" && v.lateReturnFeeCents != null ? `${label(LATE_RETURN_RULES, v.lateReturnRule)}: Richtwert ${cents(v.lateReturnFeeCents)}` : label(LATE_RETURN_RULES, v.lateReturnRule)),
    row("Rückgabe außerhalb der Öffnungszeiten", `${label(OUT_OF_HOURS_RETURN, v.outOfHoursReturn)}${v.outOfHoursInstructions ? `: ${v.outOfHoursInstructions}` : ""}`),
  ];
  const cleaning = [["Außergewöhnliche Verschmutzung", v.cleaningHeavySoilingCents], ["Rauchen", v.cleaningSmokingCents], ["Tierhaare", v.cleaningPetHairCents], ["Sonderreinigung", v.cleaningSpecialCents]].filter(([, c]) => c != null).map(([l, c]) => `${l} ${cents(c as number)}`);
  if (cleaning.length) rows.push(row("Richtwerte Reinigung (keine automatische Berechnung)", cleaning.join(" · ")));
  if (v.keysAccessoriesNote) rows.push(row("Schlüssel und Zubehör", v.keysAccessoriesNote));
  if (v.authorityHandlingFeeEnabled) rows.push(row("Bearbeitungsentgelt Behördenanfragen", `${cents(v.authorityHandlingFeeCents)} (nur nach gesonderter Berechnung)`));
  const special = [v.trailerAllowed ? "Anhängerbetrieb gestattet" : "Kein Anhängerbetrieb", v.towingAllowed ? "Abschleppen gestattet" : "Kein Abschleppen", v.commercialPassengerTransportAllowed ? "Gewerbliche Personenbeförderung gestattet" : "Keine gewerbliche Personenbeförderung", v.specialUseNote].filter(Boolean);
  rows.push(row("Sondernutzung", special.join(" · ")));
  void ADDITIONAL_DRIVER_FEE_TYPES; void KM_POLICIES;
  return { key: "rules", title: "Geschäftsregeln dieses Vertrags", rows };
}

type ContractWithDrivers = Prisma.RentalContractGetPayload<{ include: { drivers: true } }>;
export type TenantLike = { name: string; street: string | null; zip: string | null; city: string | null; phone: string | null; email: string | null; website?: string | null; logoStorageKey?: string | null; logoChecksum?: string | null };
type SignatureLike = { id: string; role: string; signerName: string; signedAt: Date };

function driverSection(key: string, title: string, d: ContractWithDrivers["drivers"][number]): DocSection {
  return {
    key,
    title,
    rows: [
      row("Name", `${d.firstName} ${d.lastName}`, true),
      row("Geburtsdatum", date(d.birthDate), true),
      row("Adresse", `${d.street}, ${d.zip} ${d.city}${d.country && d.country !== "DE" ? `, ${label(COUNTRIES, d.country)}` : ""}`, true),
      row("Führerscheinnummer", d.licenseNumber, true),
      row("Klasse", d.licenseClass, true),
      row("Ausgestellt am", date(d.licenseIssuedAt), true),
      row("Gültig bis", date(d.licenseValidUntil), true),
      row("Ausstellungsland", label(COUNTRIES, d.licenseCountry), true),
    ],
  };
}

export function buildContractDocument(contract: ContractWithDrivers, tenant: TenantLike, signatures: SignatureLike[]): ContractDocument {
  const c = contract.customerSnapshot as CustomerSnapshot;
  const v = contract.vehicleSnapshot as VehicleSnapshot;
  const p = contract.priceSnapshot as unknown as ContractPriceSnapshot;
  const primary = contract.drivers.find((d) => d.role === "PRIMARY_DRIVER");
  const additional = contract.drivers.filter((d) => d.role === "ADDITIONAL_DRIVER");
  const days = p?.days ?? 0;
  const rules = readContractRules(contract.conditions);
  const termsFormat = contract.termsText ? ((contract.termsFormat === "MARKDOWN" ? "MARKDOWN" : "PLAIN") as "MARKDOWN" | "PLAIN") : null;

  const sections: DocSection[] = [
    {
      key: "renter",
      title: "Mieter",
      rows: [
        row("Kundennummer", c.number),
        row("Kundenart", label(CUSTOMER_TYPES, c.type)),
        ...(c.type === "COMPANY" ? [row("Firma", c.companyName, true)] : []),
        row("Name", `${c.firstName ?? ""} ${c.lastName ?? ""}`, true),
        row("Geburtsdatum", date(c.birthDate), true),
        row("Straße und Hausnummer", c.street, true),
        row("PLZ und Ort", `${c.zip ?? ""} ${c.city ?? ""}`, true),
        row("Land", label(COUNTRIES, c.country), true),
        row("Telefon", c.phone),
        row("E-Mail", c.email),
        row("Ausweis", [label(ID_TYPES, c.idType), c.idNumber].filter(Boolean).join(" "), true),
        row("Ausweis gültig bis", date(c.idValidUntil)),
      ],
    },
    primary
      ? driverSection("driver", contract.driverMode === "RENTER" ? "Fahrer (Mieter fährt selbst)" : "Fahrer (abweichend vom Mieter)", primary)
      : { key: "driver", title: `Fahrer (${label(DRIVER_MODES, contract.driverMode)})`, rows: [{ label: "Fahrer", value: "noch nicht vollständig erfasst", missing: true }] },
    {
      key: "vehicle",
      title: "Fahrzeug",
      rows: [
        row("Kennzeichen", v.plate, true),
        row("Fahrzeug", `${v.make} ${v.model}`, true),
        row("Fahrzeuggruppe", v.groupName),
        row("Antrieb", label(FUELS, v.fuel)),
        row("Fahrgestellnummer", v.vin),
        row("Kilometerstand bei Vertragserstellung", `${Number(v.mileageAtContract ?? 0).toLocaleString("de-DE")} km`),
      ],
    },
    {
      key: "period",
      title: "Mietzeitraum",
      rows: [
        row("Mietbeginn", dateTime(contract.startAt), true),
        row("Geplante Rückgabe", dateTime(contract.endAt), true),
        row("Mietdauer", `${days} ${days === 1 ? "Tag" : "Tage"}`),
        row("Abholort", contract.pickupLocation),
        row("Rückgabeort", contract.returnLocation ?? contract.pickupLocation),
      ],
    },
    {
      key: "conditions",
      title: "Konditionen",
      rows: [
        row("Kaution", eur(contract.deposit)),
        row("Freikilometer", `${contract.kmIncludedPerDay.toLocaleString("de-DE")} km je Tag, gesamt ${(contract.kmIncludedPerDay * days).toLocaleString("de-DE")} km`),
        row("Mehrkilometer", `${eur(contract.extraKmRate)} je km`),
        row("Selbstbeteiligung", eur(contract.deductible)),
        row("Tankregelung", contract.fuelPolicy === "OTHER" ? `${label(FUEL_POLICIES, contract.fuelPolicy)}: ${contract.fuelPolicyNote ?? ""}` : label(FUEL_POLICIES, contract.fuelPolicy)),
        ...(contract.fuelPricePerLiter ? [row("Preis je fehlendem Liter", eur(contract.fuelPricePerLiter))] : []),
      ],
    },
  ];

  return {
    title: "Mietvertrag",
    number: contract.number,
    status: contract.status,
    landlord: landlordOf(contract.landlordSnapshot, tenant),
    renterEmail: typeof c.email === "string" && c.email.trim() ? c.email.trim() : null,
    renterName: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
    vehicleTitle: `${v.make} ${v.model}`.trim(),
    plate: String(v.plate ?? ""),
    startAt: dateTime(contract.startAt),
    createdAt: dateTime(contract.createdAt),
    signedAt: contract.signedAt ? dateTime(contract.signedAt) : null,
    contentHash: contract.contentHash,
    sections,
    additionalDrivers: additional.map((d, i) => driverSection(`additional-${d.id}`, `Zusatzfahrer ${i + 1}`, d)),
    price: {
      days,
      lines: (p?.lines ?? []).map((l) => ({ text: `${l.quantity} × ${l.label} zu ${eur(l.unitPrice)}`, amount: eur(l.amount) })),
      subtotal: eur(p?.subtotal),
      discount: p && p.discountPercent > 0 ? { text: `Rabatt ${p.discountPercent} %`, amount: `−${eur(p.discountAmount)}` } : null,
      calculated: eur(p?.total),
      agreed: p?.agreedTotal != null ? { text: `Abweichend vereinbart${p.agreedTotalNote ? `: ${p.agreedTotalNote}` : ""}`, amount: eur(p.agreedTotal) } : null,
      extras: (p?.extras ?? []).map((e) => ({ text: `${e.quantity} × ${e.label} zu ${eur(e.unitPrice)}`, amount: eur(e.amount) })),
      total: eur(contract.totalAmount),
      deposit: eur(contract.deposit),
    },
    rules: rulesSection(rules, contract, v.fuel, additional.length, days),
    individualAgreements: contract.individualAgreements?.trim() || null,
    terms: {
      version: contract.termsVersion,
      text: contract.termsText,
      format: termsFormat,
      blocks: termsFormat === "MARKDOWN" && contract.termsText ? parseTerms(contract.termsText) : null,
      legacy: !contract.rentalTermsVersionId && !!contract.termsText,
      title: contract.rentalTermsVersionId ? `Allgemeine Mietbedingungen – Version ${contract.termsVersion}` : contract.termsVersion ? `Mietbedingungen (Fassung ${contract.termsVersion})` : "Mietbedingungen",
      acknowledgedAt: contract.termsAcknowledgedAt ? dateTime(contract.termsAcknowledgedAt) : null,
    },
    signatures: signatures.map((s) => ({ id: s.id, role: s.role, roleLabel: s.role === "RENTER" ? "Mieter" : "Vermieter", signerName: s.signerName, signedAt: dateTime(s.signedAt), imageUrl: `/api/signatures/${s.id}` })),
  };
}
