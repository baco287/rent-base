// Befehl 20.6: Dokumentdaten der Kundenmeldung „Bestätigung kontaktlose Rückgabe“. Liest ausschließlich die versiegelten
// Kundenangaben (KeyDropReturn nach confirmedAt), die Vertragskopie und die Kundenfotos/-unterschrift dieser Meldung.
import { db } from "@/lib/db";
import { DomainError } from "@/lib/integrity";
import { landlordOf } from "@/lib/contract-view";
import { logoRefFromSnapshot } from "@/lib/branding-ref";
import { keyDropSettingsOf } from "@/lib/key-drop";
import { PHOTO_CATEGORIES, type PhotoCategory } from "@/lib/constants";
import { APP_TIME_ZONE } from "@/lib/time";

const fmt = (d: Date | null | undefined) => (d ? d.toLocaleString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");

export type KeyDropDocument = {
  landlord: { name: string; address: string; contact: string };
  bookingNumber: string;
  contractNumber: string | null;
  renterName: string;
  vehicleTitle: string;
  plate: string;
  label: string;
  agreedLocation: string;
  expectedAt: string;
  dropOffAt: string;
  confirmedAt: string;
  rows: { label: string; value: string }[];
  confirmationText: string;
  signerName: string;
  signedAt: string;
  photos: { id: string; category: string; caption: string }[];
  confirmationHash: string;
};

/** Zeilen der Kundenangaben – dieselbe Darstellung im Bestätigungs-PDF, im Rückgabeprotokoll und in der Oberfläche. */
export function keyDropCustomerRows(kd: { customerDropOffAt: Date | null; customerMileage: number | null; customerFuelEighths: number | null; customerBatteryPercent: number | null; customerLocationConfirmed: boolean | null; customerLocationNote: string | null; customerNewDamages: boolean | null; customerDamageNote: string | null; customerRemark: string | null; location: string }) {
  return [
    { label: "Abgabe laut Kunde", value: fmt(kd.customerDropOffAt) },
    { label: "Kilometerstand laut Kunde", value: kd.customerMileage != null ? `${kd.customerMileage.toLocaleString("de-DE")} km` : "–" },
    ...(kd.customerFuelEighths != null ? [{ label: "Tankstand laut Kunde", value: `${kd.customerFuelEighths}/8` }] : []),
    ...(kd.customerBatteryPercent != null ? [{ label: "Batteriestand laut Kunde", value: `${kd.customerBatteryPercent} %` }] : []),
    { label: "Abstellort", value: kd.customerLocationConfirmed ? `wie vereinbart: ${kd.location}` : `abweichend: ${kd.customerLocationNote ?? "–"}` },
    { label: "Neue Schäden bekannt", value: kd.customerNewDamages ? `Ja – ${kd.customerDamageNote ?? ""}` : kd.customerNewDamages === false ? "Nein" : "–" },
    ...(kd.customerRemark ? [{ label: "Bemerkung des Kunden", value: kd.customerRemark }] : []),
  ];
}

export async function loadKeyDropDocumentData(tenantId: string, keyDropId: string) {
  const kd = await db.keyDropReturn.findFirst({ where: { id: keyDropId, tenantId }, include: { booking: { include: { vehicle: true, contract: true } }, photos: { orderBy: { uploadedAt: "asc" } }, signatures: { orderBy: { signedAt: "asc" } } } });
  if (!kd) throw new DomainError("Kontaktlose Rückgabe nicht gefunden.");
  if (!kd.confirmedAt || !kd.confirmationHash) throw new DomainError("Die Rückgabe wurde vom Kunden noch nicht gemeldet.");
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, street: true, zip: true, city: true, phone: true, email: true } });
  const contract = kd.booking.contract;
  const landlord = landlordOf(contract?.landlordSnapshot ?? null, tenant);
  const v = (contract?.vehicleSnapshot ?? {}) as { make?: string; model?: string; plate?: string };
  const settings = keyDropSettingsOf(kd.settingsSnapshot);
  const sig = kd.signatures.find((s) => s.role === "RENTER") ?? null;
  const doc: KeyDropDocument = {
    landlord: { name: landlord.name, address: landlord.address, contact: landlord.contact },
    bookingNumber: kd.booking.number,
    contractNumber: contract?.number ?? null,
    renterName: kd.recipientName,
    vehicleTitle: `${v.make ?? kd.booking.vehicle.make} ${v.model ?? kd.booking.vehicle.model}`.trim(),
    plate: v.plate ?? kd.booking.vehicle.plate,
    label: settings.label,
    agreedLocation: kd.location,
    expectedAt: fmt(kd.expectedReturnAt),
    dropOffAt: fmt(kd.customerDropOffAt),
    confirmedAt: fmt(kd.confirmedAt),
    rows: keyDropCustomerRows(kd),
    confirmationText: kd.confirmationText ?? "",
    signerName: kd.customerSignerName ?? sig?.signerName ?? "",
    signedAt: fmt(sig?.signedAt ?? kd.confirmedAt),
    photos: kd.photos.map((p) => ({ id: p.id, category: p.category, caption: PHOTO_CATEGORIES[p.category as PhotoCategory] ?? p.category })),
    confirmationHash: kd.confirmationHash,
  };
  return {
    doc,
    bookingId: kd.bookingId,
    sourceHash: kd.confirmationHash,
    logoRef: logoRefFromSnapshot({ logo: kd.logoRef }),
    photoFiles: kd.photos.map((p) => ({ id: p.id, storageKey: p.storageKey, checksum: p.checksum, contentType: p.contentType })),
    signatureImage: sig?.imageData ?? null,
  };
}
