// Befehl 28: Stornobestätigung einer Buchung – ausschließlich aus der beim Storno eingefrorenen Abrechnung
// (Booking.cancellationSnapshot, Prüfsumme cancellationHash). Kein Rechnungs-Stornobeleg: die Bestätigung dokumentiert den
// Storno der Buchung und fasst die finanziellen Folgen zusammen; Rechnungen, Gutschriften und Auszahlungsbelege bleiben eigene Belege.

import { db } from "@/lib/db";
import type { LogoRef } from "@/lib/branding-ref";
import type { CancellationSnapshot } from "@/lib/cancellation";
import { fmtDateTime } from "@/lib/format";
import { DomainError } from "@/lib/integrity";
import { fmtCents } from "@/lib/money";

export type CancellationDocumentData = {
  title: string;
  bookingNumber: string;
  cancelledAt: string;
  company: { fullName: string; addressLines: string[]; contact: string; taxLine: string | null; footer: string | null };
  customer: { name: string; number: string | null; addressLines: string[] };
  vehicle: string;
  period: string;
  contract: string | null;
  reason: string;
  cancelledByName: string;
  /** finanzielle Zusammenfassung (Zeilen: Bezeichnung / Betrag bzw. Text) */
  finances: { label: string; value: string; bold?: boolean }[];
  deposit: { label: string; value: string }[];
  notes: string[];
  contentHash: string;
};

export function buildCancellationDocument(s: CancellationSnapshot, hash: string): CancellationDocumentData {
  const c = s.company;
  const f = s.finances;
  const finances: CancellationDocumentData["finances"] = [
    // Befehl 29 Phase E: Unfallersatz – abgerechnet wird nach tatsächlicher Mietdauer ab Übergabe; vor der Übergabe gibt es keinen Mietpreis
    f.agreedSource === "ACCIDENT"
      ? { label: "Mietpreis", value: "kein Mietpreis im Voraus (Unfallersatz, Abrechnung nach tatsächlicher Mietdauer ab Übergabe; nicht übergeben)" }
      : { label: f.agreedSource === "CONTRACT" ? "Vereinbarter Mietpreis (laut Mietvertrag)" : "Voraussichtlicher Mietpreis (ohne Vertrag)", value: fmtCents(f.agreedCents) },
    { label: "Geleistete Mietvorauszahlung", value: fmtCents(f.prepaidCents) },
  ];
  if (f.fee) {
    finances.push({ label: `Stornogebühr${f.fee.invoiceNumber ? ` (Rechnung ${f.fee.invoiceNumber})` : ""}`, value: fmtCents(f.fee.grossCents) });
    finances.push({ label: "Steuerliche Behandlung der Stornogebühr", value: f.fee.taxTreatmentLabel });
  } else finances.push({ label: "Stornogebühr", value: "keine" });
  if (f.stillOwedCents > 0) finances.push({ label: "Noch zu zahlen (Stornogebühr abzüglich Vorauszahlung)", value: fmtCents(f.stillOwedCents), bold: true });
  if (f.refund.mode === "PAYOUT") finances.push({ label: `Erstattet${f.refund.payoutNumber ? ` (Auszahlung ${f.refund.payoutNumber}${f.refund.methodLabel ? `, ${f.refund.methodLabel}` : ""})` : ""}`, value: fmtCents(f.refund.amountCents), bold: true });
  if (f.refund.remainingCreditCents > 0) finances.push({ label: "Als Guthaben zu Ihren Gunsten vermerkt", value: fmtCents(f.refund.remainingCreditCents), bold: true });
  if (f.refund.mode === "NONE" && f.stillOwedCents === 0 && f.creditCents === 0) finances.push({ label: "Erstattung", value: "keine (keine Vorauszahlung)" });
  const deposit: CancellationDocumentData["deposit"] = [];
  if (f.deposit && f.deposit.receivedCents > 0) {
    deposit.push({ label: "Erhaltene Kaution", value: fmtCents(f.deposit.receivedCents) });
    if (f.deposit.earlierReleasedCents > 0) deposit.push({ label: "Bereits zuvor freigegeben", value: fmtCents(f.deposit.earlierReleasedCents) });
    if (f.deposit.retainedCents > 0) deposit.push({ label: "Zuvor einbehalten", value: fmtCents(f.deposit.retainedCents) });
    if (f.deposit.mode === "RELEASE") deposit.push({ label: "Beim Storno freigegeben", value: fmtCents(f.deposit.releasedCents) });
    if (f.deposit.payoutCents > 0) deposit.push({ label: `Zurückgezahlt${f.deposit.payoutNumber ? ` (Auszahlung ${f.deposit.payoutNumber})` : ""}`, value: fmtCents(f.deposit.payoutCents) });
    if (f.deposit.mode === "RELEASE" && f.deposit.payoutCents < f.deposit.releasedCents) deposit.push({ label: "Freigegeben, Rückzahlung folgt", value: fmtCents(f.deposit.releasedCents - f.deposit.payoutCents) });
    if (f.deposit.mode === "KEEP") deposit.push({ label: "Vorerst verwahrt (Entscheidung folgt gesondert)", value: fmtCents(f.deposit.keptCents) });
  }
  const notes = [
    "Die Buchung ist storniert. Das Fahrzeug ist für den genannten Zeitraum nicht mehr für Sie reserviert.",
    ...(s.contract?.signed ? [`Der unterschriebene Mietvertrag ${s.contract.number} bleibt unverändert archiviert.`] : []),
    "Rechnungen, Zahlungs- und Auszahlungsbelege bleiben als eigene Belege unverändert bestehen; diese Bestätigung ersetzt sie nicht.",
    ...(s.keptDocuments.length ? [`Bestehende Belege zu dieser Buchung: ${s.keptDocuments.join(", ")}.`] : []),
  ];
  return {
    title: "Stornobestätigung",
    bookingNumber: s.bookingNumber,
    cancelledAt: fmtDateTime(new Date(s.cancelledAt)),
    company: {
      fullName: [c.name, c.legalForm].filter(Boolean).join(" "),
      addressLines: [c.street, [c.zip, c.city].filter(Boolean).join(" "), c.country && c.country !== "DE" ? c.country : null].filter((x): x is string => !!x),
      contact: [c.phone, c.email, c.website?.replace(/^https?:\/\//i, "")].filter(Boolean).join(" · "),
      taxLine: [c.vatId ? `USt-IdNr. ${c.vatId}` : null, c.taxNumber ? `Steuernummer ${c.taxNumber}` : null].filter(Boolean).join(" · ") || null,
      footer: c.invoiceFooter ?? null,
    },
    customer: { name: s.customer.name, number: s.customer.number, addressLines: s.customer.addressLines },
    vehicle: `${s.vehicle.label}${s.vehicle.plate ? ` (${s.vehicle.plate})` : ""}`,
    period: `${fmtDateTime(new Date(s.period.startAt))} bis ${s.period.endAt ? fmtDateTime(new Date(s.period.endAt)) : "offen (bis zur Rückgabe)"}`,
    contract: s.contract ? `${s.contract.number}${s.contract.signed ? " (unterschrieben, unverändert archiviert)" : ""}` : null,
    reason: s.reason,
    cancelledByName: s.cancelledByName,
    finances,
    deposit,
    notes,
    contentHash: hash,
  };
}

export async function loadCancellationDocumentData(tenantId: string, bookingId: string): Promise<{ bookingId: string; contentHash: string; doc: CancellationDocumentData; logoRef: LogoRef | null; recipientEmail: string | null; snapshot: CancellationSnapshot }> {
  const b = await db.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true, status: true, cancellationSnapshot: true, cancellationHash: true } });
  if (!b) throw new DomainError("Buchung nicht gefunden.");
  if (b.status !== "CANCELLED" || !b.cancellationSnapshot || !b.cancellationHash) throw new DomainError("Eine Stornobestätigung gibt es nur zu einer mit dem Storno-Assistenten stornierten Buchung.");
  const s = b.cancellationSnapshot as unknown as CancellationSnapshot;
  return { bookingId: b.id, contentHash: b.cancellationHash, doc: buildCancellationDocument(s, b.cancellationHash), logoRef: s.company.logo ?? null, recipientEmail: s.customer.email, snapshot: s };
}
