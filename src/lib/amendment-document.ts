// Befehl 25: Daten eines Nachtrags für PDF und Mail – ausschließlich aus dem bei der Unterschrift eingefrorenen Snapshot.
// Spätere Änderungen an Kunde, Firma, Fahrzeug oder weiteren Nachträgen verändern ein Nachtrags-PDF nie.

import { db } from "@/lib/db";
import type { LogoRef } from "@/lib/branding-ref";
import type { AmendmentSnapshot } from "@/lib/amendments";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { DomainError } from "@/lib/integrity";
import { fmtCents } from "@/lib/money";

export type AmendmentDocumentData = {
  title: string;
  number: string;
  sequenceNo: number;
  signedAt: string;
  company: { fullName: string; addressLines: string[]; contact: string; taxLine: string | null; footer: string | null };
  customer: { name: string; number: string | null; addressLines: string[] };
  vehicle: string;
  contract: { number: string; signedAt: string | null; startAt: string };
  bookingNumber: string;
  priorAmendments: { number: string; date: string }[];
  /** GEÄNDERTE VEREINBARUNGEN: je Änderung alt/neu, beim Preis zusätzlich die Änderung */
  changes: { label: string; before: string; after: string; note: string | null }[];
  /** Stand nach diesem Nachtrag (nur die geänderten Kerndaten, zur Orientierung) */
  after: { endAt: string; total: string; km: string; deposit: string; returnLocation: string; drivers: string[] };
  signatures: { id: string; role: string; roleLabel: string; signerName: string; signedAt: string; imageUrl: string }[];
  closing: string;
  contentHash: string;
};

const CLOSING = "Alle übrigen Vereinbarungen des Mietvertrags und früherer Nachträge bleiben unverändert bestehen.";

export function buildAmendmentDocument(s: AmendmentSnapshot, hash: string, signatures: { id: string; role: string; signerName: string; signedAt: Date }[]): AmendmentDocumentData {
  const c = s.company;
  const cust = s.customer;
  const name = cust.companyName?.trim() ? `${cust.companyName.trim()}${cust.firstName || cust.lastName ? ` (${[cust.firstName, cust.lastName].filter(Boolean).join(" ")})` : ""}` : [cust.firstName, cust.lastName].filter(Boolean).join(" ") || "Mieter";
  const d = (iso: string | null) => (iso ? fmtDateTime(new Date(iso)) : "–");
  return {
    title: "Nachtrag zum Mietvertrag",
    number: s.number,
    sequenceNo: s.sequenceNo,
    signedAt: d(s.signedAt),
    company: {
      fullName: [c.name, c.legalForm].filter(Boolean).join(" "),
      addressLines: [c.street, [c.zip, c.city].filter(Boolean).join(" "), c.country && c.country !== "DE" ? c.country : null].filter((x): x is string => !!x),
      contact: [c.phone, c.email, c.website?.replace(/^https?:\/\//i, "")].filter(Boolean).join(" · "),
      taxLine: [c.vatId ? `USt-IdNr. ${c.vatId}` : null, c.taxNumber ? `Steuernummer ${c.taxNumber}` : null].filter(Boolean).join(" · ") || null,
      footer: c.invoiceFooter ?? null,
    },
    customer: { name, number: cust.number ?? null, addressLines: [cust.street, [cust.zip, cust.city].filter(Boolean).join(" "), cust.country && cust.country !== "DE" ? cust.country : null].filter((x): x is string => !!x) },
    vehicle: [[s.vehicle.make, s.vehicle.model].filter(Boolean).join(" "), s.vehicle.plate ? `(${s.vehicle.plate})` : null].filter(Boolean).join(" ") || "–",
    contract: { number: s.contract.number, signedAt: s.contract.signedAt ? fmtDate(new Date(s.contract.signedAt)) : null, startAt: d(s.contract.startAt) },
    bookingNumber: s.bookingNumber,
    priorAmendments: s.priorAmendments.map((p) => ({ number: p.number, date: p.signedAt ? fmtDate(new Date(p.signedAt)) : "–" })),
    changes: s.changes.map((ch) => ({ label: ch.label, before: ch.before, after: ch.after, note: ch.note ?? null })),
    after: {
      endAt: s.after.endAt ? d(s.after.endAt) : "offen (bis zur Rückgabe)",
      // Befehl 29 Phase E: offenes Mietende (Unfallersatz) – kein Gesamtpreis, nie „0,00 €“
      total: s.after.endAt ? fmtCents(s.after.totalCents) : "nach tatsächlicher Mietdauer (Tarif laut Mietvertrag)",
      km: s.after.kmPolicy === "UNLIMITED" ? "Unbegrenzte Kilometer" : `${s.after.kmIncludedPerDay.toLocaleString("de-DE")} km je Tag · Mehrkilometer ${s.after.extraKmRate.toLocaleString("de-DE", { minimumFractionDigits: 2 })} € je km`,
      deposit: fmtCents(s.after.depositCents),
      returnLocation: s.after.returnLocation ?? "wie Abholort",
      drivers: s.after.drivers.map((x) => `${x.name}${x.role === "PRIMARY_DRIVER" ? " (Hauptfahrer)" : ""}`),
    },
    signatures: signatures.map((x) => ({ id: x.id, role: x.role, roleLabel: x.role === "RENTER" ? "Mieter" : "Vermieter", signerName: x.signerName, signedAt: fmtDateTime(x.signedAt), imageUrl: `/api/signatures/${x.id}` })),
    closing: CLOSING,
    contentHash: hash,
  };
}

export async function loadAmendmentDocumentData(tenantId: string, amendmentId: string): Promise<{ bookingId: string; contractId: string; contentHash: string; doc: AmendmentDocumentData; logoRef: LogoRef | null; recipientEmail: string | null; signatureImages: Map<string, Uint8Array>; snapshot: AmendmentSnapshot }> {
  const a = await db.contractAmendment.findFirst({ where: { id: amendmentId, tenantId } });
  if (!a) throw new DomainError("Nachtrag nicht gefunden.");
  if (a.status !== "SIGNED" || !a.contentHash || !a.snapshot || !a.number) throw new DomainError("Ein Nachtrags-PDF gibt es erst, wenn der Nachtrag unterschrieben und wirksam ist.");
  const s = a.snapshot as unknown as AmendmentSnapshot;
  // nur Unterschriften zu genau dem versiegelten Inhalt (eine je Rolle, Mieter zuerst)
  const rows = await db.signature.findMany({ where: { tenantId, amendmentId: a.id, contentHash: a.contentHash }, orderBy: { signedAt: "asc" }, select: { id: true, role: true, signerName: true, signedAt: true, imageData: true } });
  const byRole = new Map(rows.map((r) => [r.role, r]));
  const signatures = ["RENTER", "EMPLOYEE"].flatMap((r) => (byRole.has(r) ? [byRole.get(r)!] : []));
  return {
    bookingId: a.bookingId,
    contractId: a.contractId,
    contentHash: a.contentHash,
    doc: buildAmendmentDocument(s, a.contentHash, signatures),
    logoRef: s.company.logo ?? null,
    recipientEmail: s.customer.email?.trim() || null,
    signatureImages: new Map(signatures.flatMap((x) => (x.imageData ? [[x.id, x.imageData] as const] : []))),
    snapshot: s,
  };
}
