// Befehl 25: Vertragsnachträge und Änderungen während laufender Miete. Der unterschriebene Vertrag bleibt unverändert;
// jede Änderung ist ein eigener, versiegelter Nachtrag; der wirksame Vertragsstand wird zentral abgeleitet.
process.env.MAIL_DEV_OUTBOX = "";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { AMENDMENT_CHANGE_KINDS, roleAllows } from "../src/lib/constants";
import {
  addAmendmentDriver, amendmentAllowed, applyAmendments, createAmendmentDraft, describeChanges, discardAmendment, dropAmendmentDriver, effectiveContractState, effectiveDepositCents, effectiveStateForBooking,
  effectiveTotalCents, extensionPriceProposal, getAmendmentContentHash, getAmendmentState, listAmendments, pendingSettlements, removeAmendmentSignature, saveAmendmentSignature, setAmendmentDriverRemoval, signAmendment, updateAmendmentDraft,
} from "../src/lib/amendments";
import { buildAmendmentDocument, loadAmendmentDocumentData } from "../src/lib/amendment-document";
import { composeAmendmentMail, sendAmendment } from "../src/lib/amendment-mail";
import { ensureContractDraft, finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { depositView, recordDepositReceived, securityDepositFinancials } from "../src/lib/deposits";
import { ensureAmendmentDocument, listBookingDocuments } from "../src/lib/documents";
import { driverVerificationOverview, requiredDriversFor, verifyDriverInOneStep } from "../src/lib/driver-verification";
import { finalizeHandover, getHandoverContentHash, saveHandoverSignature, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { contentHash } from "../src/lib/integrity";
import { fmtCents } from "../src/lib/money";
import { createAmendmentSettlementDraft, ensureInvoiceDraft, finalizeInvoice, getInvoiceState } from "../src/lib/invoices";
import type { MailMessage, MailTransport } from "../src/lib/mail";
import { renderAmendmentPdf } from "../src/lib/pdf/amendment-pdf";
import { rentalPaymentSummary } from "../src/lib/rental-payments";
import { getReturnComparison } from "../src/lib/returns";
import { getStorage, type StorageDriver } from "../src/lib/storage";
import { createWorld, fakeSignaturePng, purgeTenants, type World } from "./helpers";
import { pickedUpWorld, returnedWorld } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
let storage: StorageDriver;
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-amend-"));
  storage = getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

class FakeTransport implements MailTransport {
  readonly name = "fake";
  sent: MailMessage[] = [];
  async send(m: MailMessage) { this.sent.push(m); return { messageId: `<fake-${this.sent.length}@test>` }; }
}

const DAY = 86_400_000;
const nonce = (s: string) => `${s}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const DRIVER = { customerId: null, firstName: "Max", lastName: "Beifahrer", birthDate: new Date("1990-05-05"), street: "Weg 2", zip: "28195", city: "Bremen", country: "DE", licenseNumber: "Z999", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2032-01-01"), licenseCountry: "DE", licenseIssuedBy: null };
const CHECK = { documentType: "PERSONALAUSWEIS", licenseNumber: "Z999", licenseCountry: "DE", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2032-01-01"), licenseClasses: ["B"], internationalPermitPresented: false, translationPresented: false, manualReviewConfirmed: false, deviationConfirmed: false, notes: null };

/** Unterschriebener Vertrag, Buchung RESERVED (vor der Übergabe) – 6 Tage, 200 km/Tag, 0,25 €/km, Kaution 500. */
async function signedWorld(label: string): Promise<World & { contractId: string }> {
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });
  const c = await ensureContractDraft(w.tenantId, w.bookingId, w.actor);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: bk.endAt, deposit: 500, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 1000, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: "Hof" });
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  return { ...w, contractId: c.id };
}

async function draft(w: World, label: string) {
  return (await createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: nonce(label) })).amendment;
}
async function renterSign(w: World, amendmentId: string) {
  return saveAmendmentSignature(w.tenantId, w.actor, amendmentId, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(2), seenHash: await getAmendmentContentHash(w.tenantId, amendmentId) });
}
async function signed(w: World, amendmentId: string) {
  await renterSign(w, amendmentId);
  return (await signAmendment(w.tenantId, w.actor, amendmentId)).amendment;
}
const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

// ---------------------------------------------------------------------------
// Ableitung ohne Datenbank
// ---------------------------------------------------------------------------

test("applyAmendments: Vertrag + Nachträge in Reihenfolge, Entwürfe und verworfene wirken nicht", () => {
  const end = new Date("2026-10-10T10:00:00Z");
  const c = { id: "c", number: "MV-1", bookingId: "b", startAt: new Date("2026-10-04T10:00:00Z"), endAt: end, totalAmount: "534.00", kmIncludedPerDay: 200, extraKmRate: "0.25", deposit: "500.00", returnLocation: null, pickupLocation: "Hof" } as unknown as Parameters<typeof applyAmendments>[0];
  const base = { id: "", tenantId: "t", contractId: "c", bookingId: "b", number: null, sequenceNo: null, newEndAt: null, priceDeltaCents: null, priceProposalCents: null, priceReason: null, newKmIncludedPerDay: null, newExtraKmRate: null, newDepositCents: null, newReturnLocation: null, agreementText: null, snapshot: null, contentHash: null, signedAt: null, signedById: null, signedByName: null, settlementInvoiceId: null, idempotencyKey: "", createdById: null, createdByName: null, createdAt: new Date(), updatedAt: new Date(), discardedAt: null };
  const a1 = { ...base, id: "a1", status: "SIGNED", number: "NT-2026-000001", sequenceNo: 1, newEndAt: plusDays(end, 2), priceDeltaCents: 17800, newDepositCents: 70000 };
  const a2 = { ...base, id: "a2", status: "SIGNED", number: "NT-2026-000002", sequenceNo: 2, priceDeltaCents: -5000, newKmIncludedPerDay: 300, newReturnLocation: "Flughafen", agreementText: "Winterreifen inklusive" };
  const draftRow = { ...base, id: "a3", status: "DRAFT", newEndAt: plusDays(end, 10), priceDeltaCents: 99900 };
  const discarded = { ...base, id: "a4", status: "DISCARDED", newDepositCents: 0 };
  const drivers = [
    { id: "d1", role: "PRIMARY_DRIVER", firstName: "Erika", lastName: "Muster", birthDate: new Date("1985-03-12"), licenseNumber: "B1", licenseClass: "B", licenseCountry: "DE", licenseValidUntil: null, customerId: null, addedByAmendmentId: null, removedByAmendmentId: null },
    { id: "d2", role: "ADDITIONAL_DRIVER", firstName: "Alt", lastName: "Fahrer", birthDate: new Date("1980-01-01"), licenseNumber: "B2", licenseClass: "B", licenseCountry: "DE", licenseValidUntil: null, customerId: null, addedByAmendmentId: null, removedByAmendmentId: "a2" },
    { id: "d3", role: "ADDITIONAL_DRIVER", firstName: "Neu", lastName: "Fahrer", birthDate: new Date("1990-01-01"), licenseNumber: "B3", licenseClass: "B", licenseCountry: "DE", licenseValidUntil: null, customerId: null, addedByAmendmentId: "a1", removedByAmendmentId: null },
    { id: "d4", role: "ADDITIONAL_DRIVER", firstName: "Entwurf", lastName: "Fahrer", birthDate: new Date("1991-01-01"), licenseNumber: "B4", licenseClass: "B", licenseCountry: "DE", licenseValidUntil: null, customerId: null, addedByAmendmentId: "a3", removedByAmendmentId: null },
  ] as unknown as Parameters<typeof applyAmendments>[1];
  // bewusst in falscher Reihenfolge übergeben: sortiert wird nach sequenceNo
  const st = applyAmendments(c, drivers, [a2, draftRow, a1, discarded] as unknown as Parameters<typeof applyAmendments>[2]);
  assert.equal(st.endAt.getTime(), plusDays(end, 2).getTime());
  assert.equal(st.totalCents, 53400 + 17800 - 5000);
  assert.equal(st.kmIncludedPerDay, 300);
  assert.equal(st.extraKmRate, 0.25);
  assert.equal(st.depositCents, 70000);
  assert.equal(st.returnLocation, "Flughafen");
  assert.deepEqual(st.changedBy, { endAt: "NT-2026-000001", total: "NT-2026-000002", km: "NT-2026-000002", deposit: "NT-2026-000001", returnLocation: "NT-2026-000002" });
  assert.deepEqual(st.drivers.map((d) => d.id), ["d1", "d3"], "herausgenommener und Entwurfs-Fahrer zählen nicht");
  assert.deepEqual(st.agreements, [{ number: "NT-2026-000002", text: "Winterreifen inklusive" }]);
  assert.equal(st.original.totalCents, 53400);
  assert.equal(effectiveDepositCents("500.00", [a2, a1]), 70000);
  assert.equal(effectiveTotalCents("534.00", [a2, a1]), 66200);
});

test("extensionPriceProposal: Preisvorschlag aus der eingefrorenen Preislogik des Vertrags (neu − bisher)", () => {
  const start = new Date("2026-10-04T10:00:00Z");
  const contract = { startAt: start, discountPercent: 10, priceSnapshot: { rates: { dailyRate: 89, workWeekRate: 420, weeklyRate: 540, monthlyRate: null } } } as unknown as Parameters<typeof extensionPriceProposal>[0];
  const p = extensionPriceProposal(contract, plusDays(start, 6), plusDays(start, 8));
  assert.ok(p != null && p > 0, "Verlängerung kostet mehr");
  assert.equal(extensionPriceProposal(contract, plusDays(start, 6), plusDays(start, 6)), 0);
  assert.equal(extensionPriceProposal({ ...contract, priceSnapshot: null } as unknown as Parameters<typeof extensionPriceProposal>[0], plusDays(start, 6), plusDays(start, 8)), null, "ohne Preisdaten kein Vorschlag");
});

test("Rollen: Nachträge nur Inhaber und Disposition, nie Hofmitarbeiter", () => {
  assert.equal(roleAllows("OWNER", ["DISPO"]), true);
  assert.equal(roleAllows("DISPO", ["DISPO"]), true);
  assert.equal(roleAllows("YARD", ["DISPO"]), false);
  assert.ok(Object.keys(AMENDMENT_CHANGE_KINDS).length === 8);
});

// ---------------------------------------------------------------------------
// Entwurf
// ---------------------------------------------------------------------------

test("Nachtrag nur zu unterschriebenem Vertrag und laufender Miete; Entwurf hat keine Wirkung; ein offener Entwurf je Vertrag", async () => {
  await ready;
  const fresh = await createWorld("amend-nocontract");
  tenants.push(fresh.tenantId);
  await assert.rejects(() => createAmendmentDraft(fresh.tenantId, fresh.actor, { bookingId: fresh.bookingId, nonce: nonce("x") }), /unterschriebenen Mietvertrag/);
  assert.equal(amendmentAllowed({ status: "RETURNED" }, { status: "SIGNED" }).ok, false);
  assert.equal(amendmentAllowed({ status: "CANCELLED" }, { status: "SIGNED" }).ok, false);
  assert.equal(amendmentAllowed({ status: "ACTIVE" }, { status: "SIGNED" }).ok, true);

  const w = await signedWorld("amend-draft");
  const before = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  const n = nonce("create");
  const r1 = await createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: n });
  const r2 = await createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: n });
  assert.equal(r1.created, true); assert.equal(r2.created, false); assert.equal(r1.amendment.id, r2.amendment.id, "gleicher nonce = derselbe Entwurf");
  const r3 = await createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: nonce("other") });
  assert.equal(r3.amendment.id, r1.amendment.id, "zweiter Klick öffnet den offenen Entwurf, legt keinen zweiten an");
  assert.equal(r1.amendment.status, "DRAFT"); assert.equal(r1.amendment.number, null);

  await updateAmendmentDraft(w.tenantId, w.actor, r1.amendment.id, { newEndAt: plusDays(before.endAt, 3), newDepositCents: 80000, newKmIncludedPerDay: 300 });
  const st = await effectiveContractState(w.tenantId, w.contractId);
  assert.equal(st.endAt.getTime(), before.endAt.getTime(), "Entwurf ändert den wirksamen Stand nicht");
  assert.equal(st.depositCents, 50000); assert.equal(st.kmIncludedPerDay, 200);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(bk.endAt.getTime(), before.endAt.getTime(), "Buchung unverändert");
  assert.equal((await depositView(w.tenantId, w.bookingId)).expectedCents, 50000);
  const contract = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal((await rentalPaymentSummary(w.tenantId, w.bookingId)).grossCents, Math.round(Number(contract.totalAmount) * 100));
  assert.equal(contract.endAt.getTime(), before.endAt.getTime(), "Vertragszeile unverändert");

  // verwerfen: keine Wirkung, keine Nummer, kein zweiter Vorgang nötig
  const d = await discardAmendment(w.tenantId, w.actor, r1.amendment.id);
  assert.equal(d.status, "DISCARDED"); assert.equal(d.number, null);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, r1.amendment.id, { newDepositCents: 1 }), /verworfen/);
  await assert.rejects(() => signAmendment(w.tenantId, w.actor, r1.amendment.id), /verworfen/);
  assert.equal((await effectiveContractState(w.tenantId, w.contractId)).amendments.length, 0);
  const audits = await db.auditLog.findMany({ where: { tenantId: w.tenantId, action: { in: ["AMENDMENT_CREATED", "AMENDMENT_DISCARDED"] } } });
  assert.deepEqual(audits.map((a) => a.action).sort(), ["AMENDMENT_CREATED", "AMENDMENT_DISCARDED"]);
});

test("Validierung: Rückgabe nach Beginn, Preis ≠ 0 und Gesamtpreis ≥ 0, Kaution ≥ 0, Textlängen, HTML entfernt", async () => {
  await ready;
  const w = await signedWorld("amend-valid");
  const c = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const a = await draft(w, "v");
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: new Date(c.startAt.getTime() - DAY) }), /nach dem Mietbeginn/);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: c.endAt }), /entspricht der bisher/);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: 0 }), /ungleich 0,00/);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: -999_999 }), /negativ/);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: -1 }), /nicht negativ/);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 50000 }), /entspricht der bisherigen/);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newReturnLocation: "x".repeat(201) }), /zu lang/);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { agreementText: "y".repeat(2001) }), /zu lang/);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newKmIncludedPerDay: -5 }), /ganze Zahl/);
  const row = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { agreementText: "<b>Winterreifen</b> <script>alert(1)</script>inklusive", newReturnLocation: " Flughafen <i>HAM</i> " });
  assert.equal(row.agreementText, "Winterreifen alert(1)inklusive".replace("alert(1)inklusive", "alert(1)inklusive"));
  assert.ok(!row.agreementText!.includes("<"), "kein HTML");
  assert.equal(row.newReturnLocation, "Flughafen HAM");
  // Freitext allein genügt für die Unterschrift, umgeht aber keine Fahrerprüfung (siehe Fahrertest)
  const st = await getAmendmentState(w.tenantId, a.id);
  assert.equal(st.issues.filter((i) => i.severity === "error").length, 0);
  assert.deepEqual(st.changes.map((x) => x.kind), ["RETURN_LOCATION", "AGREEMENT"]);
  await discardAmendment(w.tenantId, w.actor, a.id);
});

test("ohne Änderung keine Unterschrift; Unterschrift bindet an den Inhalt; Änderung danach entfernt sie", async () => {
  await ready;
  const w = await signedWorld("amend-sig");
  const a = await draft(w, "s");
  assert.ok((await getAmendmentState(w.tenantId, a.id)).issues.some((i) => i.code === "NO_CHANGES"));
  await assert.rejects(() => signAmendment(w.tenantId, w.actor, a.id), /keine Änderung/);
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 60000 });
  const h1 = await getAmendmentContentHash(w.tenantId, a.id);
  await assert.rejects(() => saveAmendmentSignature(w.tenantId, w.actor, a.id, { role: "RENTER", signerName: "Erika", imageDataUrl: fakeSignaturePng(), seenHash: "0".repeat(64) }), /seit der Anzeige geändert/);
  await assert.rejects(() => saveAmendmentSignature(w.tenantId, w.actor, a.id, { role: "RENTER", signerName: "Erika", imageDataUrl: "data:image/png;base64,AAAA", seenHash: h1 }), /ungültig|leer/);
  await assert.rejects(() => saveAmendmentSignature(w.tenantId, w.actor, a.id, { role: "RENTER", signerName: "  ", imageDataUrl: fakeSignaturePng(), seenHash: h1 }), /Namen/);
  await renterSign(w, a.id);
  assert.equal(await db.signature.count({ where: { tenantId: w.tenantId, amendmentId: a.id } }), 1);
  // ohne Unterschrift kein Wirksamwerden
  await removeAmendmentSignature(w.tenantId, a.id, "RENTER");
  await assert.rejects(() => signAmendment(w.tenantId, w.actor, a.id), /Unterschrift des Mieters fehlt/);
  await renterSign(w, a.id);
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 65000 });
  assert.equal(await db.signature.count({ where: { tenantId: w.tenantId, amendmentId: a.id } }), 0, "Änderung nach Unterschrift entfernt die Unterschrift");
  assert.notEqual(await getAmendmentContentHash(w.tenantId, a.id), h1);
  await discardAmendment(w.tenantId, w.actor, a.id);
});

// ---------------------------------------------------------------------------
// Wirksamwerden: Nummer, Snapshot, Materialisierung, Unveränderlichkeit
// ---------------------------------------------------------------------------

test("Verlängerung: Nummer NT-JJJJ-NNNNNN, Buchung übernimmt neues Ende, Original bleibt, Snapshot/Hash versiegelt, idempotent", async () => {
  await ready;
  const w = await signedWorld("amend-extend");
  const c0 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const a = await draft(w, "e");
  const newEnd = plusDays(c0.endAt, 2);
  const row = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: newEnd });
  assert.ok(row.priceProposalCents != null && row.priceProposalCents > 0, "Preisvorschlag aus der Preislogik");
  // Vorschlag übernehmen: keine Begründung nötig
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: row.priceProposalCents });
  const stBefore = await getAmendmentState(w.tenantId, a.id);
  assert.equal(stBefore.issues.filter((i) => i.severity === "error").length, 0, JSON.stringify(stBefore.issues));
  const price = stBefore.changes.find((x) => x.kind === "PRICE")!;
  assert.match(price.note ?? "", /Änderung \+/, "alt / Änderung / neu");

  await renterSign(w, a.id);
  const [s1, s2] = await Promise.all([signAmendment(w.tenantId, w.actor, a.id), signAmendment(w.tenantId, w.actor, a.id)]);
  assert.equal([s1, s2].filter((x) => x.created).length, 1, "Doppelklick: genau ein Wirksamwerden");
  const signedRow = await db.contractAmendment.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(signedRow.status, "SIGNED");
  assert.match(signedRow.number!, /^NT-\d{4}-\d{6}$/);
  assert.equal(signedRow.sequenceNo, 1);
  assert.ok(signedRow.snapshot && signedRow.contentHash && signedRow.signedAt);
  assert.equal(signedRow.contentHash, (await getAmendmentState(w.tenantId, a.id)).hash);
  assert.equal(await db.contractAmendment.count({ where: { tenantId: w.tenantId, number: signedRow.number } }), 1);
  // erneuter Aufruf: unverändert, keine zweite Nummer, kein zweiter Audit
  const again = await signAmendment(w.tenantId, w.actor, a.id);
  assert.equal(again.created, false); assert.equal(again.amendment.number, signedRow.number);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "AMENDMENT_SIGNED" } }), 1);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "AMENDMENT_PERIOD_CHANGED" } }), 1);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "AMENDMENT_PRICE_CHANGED" } }), 1);

  // Materialisierung und Original
  const bk = await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } });
  assert.equal(bk.endAt.getTime(), newEnd.getTime(), "Buchung (Disposition, Verfügbarkeit, Rückgabe) trägt das neue Ende");
  const c1 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal(c1.endAt.getTime(), c0.endAt.getTime(), "Originalvertrag unverändert");
  assert.equal(c1.contentHash, c0.contentHash);
  assert.equal(String(c1.totalAmount), String(c0.totalAmount));
  const st = await effectiveContractState(w.tenantId, w.contractId);
  assert.equal(st.endAt.getTime(), newEnd.getTime());
  assert.equal(st.totalCents, Math.round(Number(c0.totalAmount) * 100) + row.priceProposalCents!);
  assert.equal(st.changedBy.endAt, signedRow.number);
  assert.equal((await rentalPaymentSummary(w.tenantId, w.bookingId)).grossCents, st.totalCents, "Mietzahlung erwartet den wirksamen Gesamtpreis");
  const snap = signedRow.snapshot as { before: { endAt: string; totalCents: number }; after: { endAt: string; totalCents: number }; changes: unknown[]; signatures: unknown[] };
  assert.equal(new Date(snap.before.endAt).getTime(), c0.endAt.getTime());
  assert.equal(new Date(snap.after.endAt).getTime(), newEnd.getTime());
  assert.equal(snap.signatures.length, 1);

  // versiegelt: Datenbank blockt Änderung und Löschen, Fachlogik ebenso
  await assert.rejects(() => db.contractAmendment.update({ where: { id: a.id }, data: { priceDeltaCents: 1 } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.contractAmendment.update({ where: { id: a.id }, data: { snapshot: {} } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.contractAmendment.delete({ where: { id: a.id } }), /RB_IMMUTABLE/);
  await assert.rejects(() => updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 1 }), /unterschrieben und wirksam/);
  await assert.rejects(() => discardAmendment(w.tenantId, w.actor, a.id), /unterschrieben/);
  await assert.rejects(() => db.signature.deleteMany({ where: { tenantId: w.tenantId, amendmentId: a.id } }), /RB_IMMUTABLE/);
  await assert.rejects(() => db.signature.create({ data: { tenantId: w.tenantId, amendmentId: a.id, role: "EMPLOYEE", signerName: "x", storageKey: `tenants/${w.tenantId}/signatures/x.png`, imageData: Buffer.alloc(900, 1), imageChecksum: "a".repeat(64), contentHash: signedRow.contentHash! } }), /RB_IMMUTABLE|RB_DOMAIN/);

  // zweiter Nachtrag: sequenceNo 2, Preis kumuliert, Verkürzung senkt den Preis nicht automatisch
  const b = await draft(w, "e2");
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { newEndAt: plusDays(c0.endAt, 1) });
  const sb = await getAmendmentState(w.tenantId, b.id);
  assert.equal(sb.issues.filter((i) => i.severity === "error").length, 0);
  assert.ok(sb.changes.find((x) => x.kind === "PERIOD")!.note!.includes("verkürzte"));
  assert.equal(sb.changes.some((x) => x.kind === "PRICE"), false, "ohne ausdrückliche Preisvereinbarung keine Preisänderung");
  const b2 = await signed(w, b.id);
  assert.equal(b2.sequenceNo, 2);
  assert.ok(b2.number! > signedRow.number!, "laufende Nummer");
  const st2 = await effectiveContractState(w.tenantId, w.contractId);
  assert.equal(st2.endAt.getTime(), plusDays(c0.endAt, 1).getTime());
  assert.equal(st2.totalCents, st.totalCents, "Preis unverändert trotz Verkürzung");
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).endAt.getTime(), plusDays(c0.endAt, 1).getTime());
  const list = await listAmendments(w.tenantId, w.bookingId);
  assert.deepEqual(list.map((x) => x.sequenceNo), [1, 2]);
});

test("manuelle Preisänderung braucht Begründung; Abweichung vom Vorschlag ebenso; mit Begründung wirksam", async () => {
  await ready;
  const w = await signedWorld("amend-price");
  const a = await draft(w, "p");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: -3000 });
  let st = await getAmendmentState(w.tenantId, a.id);
  assert.ok(st.issues.some((i) => i.code === "PRICE_REASON"));
  await renterSign(w, a.id);
  await assert.rejects(() => signAmendment(w.tenantId, w.actor, a.id), /begründen/);
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceReason: "Kulanz wegen defekter Klimaanlage" });
  st = await getAmendmentState(w.tenantId, a.id);
  assert.equal(st.issues.filter((i) => i.severity === "error").length, 0);
  const row = await signed(w, a.id);
  assert.equal(row.priceDeltaCents, -3000);
  const c0 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  assert.equal((await effectiveContractState(w.tenantId, w.contractId)).totalCents, Math.round(Number(c0.totalAmount) * 100) - 3000);
  // Abweichung vom Vorschlag: Begründung Pflicht
  const c = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const b = await draft(w, "p2");
  const r = await updateAmendmentDraft(w.tenantId, w.actor, b.id, { newEndAt: plusDays(c.endAt, 1) });
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { priceDeltaCents: r.priceProposalCents! + 1000 });
  assert.ok((await getAmendmentState(w.tenantId, b.id)).issues.some((i) => i.code === "PRICE_REASON"));
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { priceReason: "Wochenendzuschlag vereinbart" });
  assert.equal((await getAmendmentState(w.tenantId, b.id)).issues.filter((i) => i.severity === "error").length, 0);
  await discardAmendment(w.tenantId, w.actor, b.id);
});

test("Verfügbarkeit: Konflikt mit Folgebuchung wird angezeigt und beim Unterschreiben erneut geprüft (Race)", async () => {
  await ready;
  const w = await signedWorld("amend-conflict");
  const c = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const a = await draft(w, "c");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusDays(c.endAt, 3) });
  await renterSign(w, a.id);
  // zwischen Vorschau und Unterschrift entsteht eine Folgebuchung auf demselben Fahrzeug
  const other = await db.booking.create({ data: { tenantId: w.tenantId, number: "T-FOLGE", vehicleId: w.vehicleId, customerId: w.customerId, startAt: plusDays(c.endAt, 1), endAt: plusDays(c.endAt, 5), dailyRate: 89, deposit: 0 } });
  const st = await getAmendmentState(w.tenantId, a.id);
  const conflict = st.issues.find((i) => i.code === "CONFLICT");
  assert.ok(conflict && conflict.message.includes("T-FOLGE"), "Konfliktmeldung nennt die Buchung");
  await assert.rejects(() => signAmendment(w.tenantId, w.actor, a.id), /T-FOLGE/);
  assert.equal((await db.contractAmendment.findUniqueOrThrow({ where: { id: a.id } })).status, "DRAFT");
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).endAt.getTime(), c.endAt.getTime(), "nichts materialisiert");
  // stornierte Folgebuchung blockiert nicht mehr
  await db.booking.update({ where: { id: other.id }, data: { status: "CANCELLED" } });
  await signAmendment(w.tenantId, w.actor, a.id);
  // Fahrzeug nicht vermietbar → Verlängerung blockiert
  const b = await draft(w, "c2");
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { newEndAt: plusDays(c.endAt, 4) });
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { status: "WORKSHOP" } });
  assert.ok((await getAmendmentState(w.tenantId, b.id)).issues.some((i) => i.code === "VEHICLE_STATUS"));
  await renterSign(w, b.id);
  await assert.rejects(() => signAmendment(w.tenantId, w.actor, b.id), /Werkstatt|Status|nicht vermiet/i);
  await db.vehicle.update({ where: { id: w.vehicleId }, data: { status: "AVAILABLE" } });
  await discardAmendment(w.tenantId, w.actor, b.id);
});

test("Kilometer und Rückgabeort: neue Gesamtkondition, Rückgabe rechnet mit dem wirksamen Stand", async () => {
  await ready;
  const w = await pickedUpWorld("amend-km");
  tenants.push(w.tenantId);
  const a = await draft(w, "k");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newKmIncludedPerDay: 400, newExtraKmRate: 0.3, newReturnLocation: "Flughafen Bremen" });
  const st = await getAmendmentState(w.tenantId, a.id);
  const km = st.changes.find((x) => x.kind === "KM")!;
  assert.match(km.before, /200 km\/Tag/); assert.match(km.after, /400 km\/Tag/); assert.match(km.note ?? "", /gesamte Mietdauer/);
  await signed(w, a.id);
  const eff = await effectiveContractState(w.tenantId, w.contractId);
  assert.equal(eff.kmIncludedPerDay, 400); assert.equal(eff.extraKmRate, 0.3); assert.equal(eff.returnLocation, "Flughafen Bremen");
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: { in: ["AMENDMENT_KM_CHANGED", "AMENDMENT_RETURN_LOCATION_CHANGED"] } } }), 2);
  // Rückgabe: 2.000 km gefahren, 6 Tage × 400 = 2.400 frei → keine Mehrkilometer (mit 200/Tag wären es 800 km)
  const r = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 47_210, fuelLevelEighths: 7 });
  const cmp = await getReturnComparison(w.tenantId, r.id);
  assert.equal(cmp.contract.kmIncludedPerDay, 400);
  assert.equal(cmp.contract.includedKm, 2400);
  assert.equal(cmp.contract.extraKmRate, 0.3);
  assert.deepEqual(cmp.contract.amendmentNumbers.length, 1);
  assert.equal(cmp.proposals.some((p) => p.key === "EXTRA_MILEAGE"), false, "keine Mehrkilometer mit der neuen Vereinbarung");
  // nach begonnener Rückgabe keine Mietdauer-/Kilometeränderung mehr
  const b = await draft(w, "k2");
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { newKmIncludedPerDay: 100 });
  assert.ok((await getAmendmentState(w.tenantId, b.id)).issues.some((i) => i.code === "RETURN_STARTED"));
  await discardAmendment(w.tenantId, w.actor, b.id);
});

test("Kaution: vereinbart ≠ erhalten; Erhöhung ohne Bewegung, Reduzierung ohne Auszahlung; Kautionszeile folgt dem Nachtrag", async () => {
  await ready;
  const w = await pickedUpWorld("amend-deposit");
  tenants.push(w.tenantId);
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: w.bookingId, amount: "500", method: "CASH", occurredAt: new Date() });
  const dep0 = await db.securityDeposit.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId: w.bookingId } });
  assert.equal(dep0.expectedAmountCents, 50000);
  // direkte Änderung der vereinbarten Kaution bleibt verboten (Datenbank)
  await assert.rejects(() => db.securityDeposit.update({ where: { id: dep0.id }, data: { expectedAmountCents: 70000 } }), /RB_IMMUTABLE|RB_DOMAIN/);
  const a = await draft(w, "d");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 70000 });
  await signed(w, a.id);
  const view = await depositView(w.tenantId, w.bookingId);
  assert.equal(view.expectedCents, 70000, "vereinbart neu");
  assert.equal(view.receivedCents, 50000, "erhalten unverändert – keine automatische Bewegung");
  assert.equal(await db.securityDepositEvent.count({ where: { tenantId: w.tenantId, depositId: dep0.id } }), 1);
  assert.equal(await db.payout.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: w.bookingId } })).deposit.toString(), "700");
  const fin = await securityDepositFinancials(w.tenantId, w.bookingId);
  assert.equal(fin.expectedCents, 70000);
  // Reduzierung: vereinbart 300, erhalten bleibt 500, nichts wird ausgezahlt
  const b = await draft(w, "d2");
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { newDepositCents: 30000 });
  const sb = await getAmendmentState(w.tenantId, b.id);
  assert.match(sb.changes.find((x) => x.kind === "DEPOSIT")!.note ?? "", /keine automatische Auszahlung/);
  await signed(w, b.id);
  const v2 = await depositView(w.tenantId, w.bookingId);
  assert.equal(v2.expectedCents, 30000); assert.equal(v2.receivedCents, 50000);
  assert.equal(await db.payout.count({ where: { tenantId: w.tenantId } }), 0);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "AMENDMENT_DEPOSIT_CHANGED" } }), 2);
  // ohne Kautionszeile: Anzeige und Anlage nehmen den wirksamen Stand
  const w2 = await signedWorld("amend-deposit-nodep");
  const a2 = await draft(w2, "d3");
  await updateAmendmentDraft(w2.tenantId, w2.actor, a2.id, { newDepositCents: 90000 });
  await signed(w2, a2.id);
  assert.equal((await depositView(w2.tenantId, w2.bookingId)).expectedCents, 90000);
  await recordDepositReceived(w2.tenantId, w2.actor, { bookingId: w2.bookingId, amount: "900", method: "CASH", occurredAt: new Date() });
  assert.equal((await db.securityDeposit.findFirstOrThrow({ where: { tenantId: w2.tenantId, bookingId: w2.bookingId } })).expectedAmountCents, 90000);
});

test("Zusatzfahrer: Aufnahme nur mit bestehender Fahrerprüfung (kein Umweg), Herausnahme behält Historie, Hauptfahrer bleibt", async () => {
  await ready;
  const w = await signedWorld("amend-driver");
  const a = await draft(w, "f");
  const d = await addAmendmentDriver(w.tenantId, w.actor, a.id, DRIVER);
  assert.equal(d.addedByAmendmentId, a.id);
  assert.equal((await requiredDriversFor(w.tenantId, w.contractId)).length, 1, "Entwurfsfahrer zählt noch nicht");
  await assert.rejects(() => addAmendmentDriver(w.tenantId, w.actor, a.id, DRIVER), /bereits als Fahrer/);
  // ohne Nachtrag: direkte Fahreraufnahme am unterschriebenen Vertrag bleibt verboten
  await assert.rejects(() => db.contractDriver.create({ data: { tenantId: w.tenantId, contractId: w.contractId, role: "ADDITIONAL_DRIVER", firstName: "X", lastName: "Y", birthDate: new Date("1990-01-01"), street: "a", zip: "1", city: "b", country: "DE", licenseNumber: "1", licenseClass: "B", licenseIssuedAt: new Date("2010-01-01"), licenseValidUntil: new Date("2030-01-01"), licenseCountry: "DE" } }), /RB_IMMUTABLE/);
  let st = await getAmendmentState(w.tenantId, a.id);
  assert.ok(st.issues.some((i) => i.code === "DRIVER_NOT_VERIFIED" && /noch nicht geprüft/.test(i.message)), "Prüfung offen blockiert");
  // Freitext „Fahrer geprüft“ umgeht nichts
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { agreementText: "Fahrer Max Beifahrer wurde geprüft." });
  await renterSign(w, a.id);
  await assert.rejects(() => signAmendment(w.tenantId, w.actor, a.id), /noch nicht geprüft/);
  // dieselbe Fahrerprüfung wie bei der Übergabe, Kontext Nachtrag
  const overview = await driverVerificationOverview(w.tenantId, { amendmentId: a.id });
  assert.deepEqual(overview.map((o) => o.driver.contractDriverId), [d.id], "nur der neu aufgenommene Fahrer ist zu prüfen");
  const res = await verifyDriverInOneStep(w.tenantId, w.actor, { amendmentId: a.id }, d.id, CHECK);
  assert.equal(res.confirmed, true, res.blockers.join(","));
  assert.equal(res.row.amendmentId, a.id); assert.equal(res.row.handoverId, null);
  st = await getAmendmentState(w.tenantId, a.id);
  assert.equal(st.issues.filter((i) => i.severity === "error").length, 0, JSON.stringify(st.issues));
  await assert.rejects(() => dropAmendmentDriver(w.tenantId, a.id, d.id), /Prüfung begonnen/);
  const row = await signed(w, a.id);
  const eff = await effectiveContractState(w.tenantId, w.contractId);
  assert.deepEqual(eff.drivers.map((x) => `${x.firstName} ${x.lastName}`), ["Erika Muster", "Max Beifahrer"]);
  assert.equal(eff.drivers[1].addedBy, a.id);
  assert.equal((await requiredDriversFor(w.tenantId, w.contractId)).length, 2, "Übergabe muss den neuen Fahrer prüfen");
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "AMENDMENT_DRIVER_ADDED" } }), 1);
  assert.match((row.snapshot as { changes: { kind: string }[] }).changes.map((c) => c.kind).join(","), /DRIVER_ADDED/);
  // Herausnahme per zweitem Nachtrag; Hauptfahrer nicht
  const b = await draft(w, "f2");
  const primary = eff.drivers.find((x) => x.role === "PRIMARY_DRIVER")!;
  await assert.rejects(() => setAmendmentDriverRemoval(w.tenantId, b.id, primary.id, true), /Hauptfahrer/);
  await setAmendmentDriverRemoval(w.tenantId, b.id, d.id, true);
  assert.equal((await effectiveContractState(w.tenantId, w.contractId)).drivers.length, 2, "Entwurf wirkt nicht");
  await setAmendmentDriverRemoval(w.tenantId, b.id, d.id, false);
  await setAmendmentDriverRemoval(w.tenantId, b.id, d.id, true);
  await signed(w, b.id);
  const eff2 = await effectiveContractState(w.tenantId, w.contractId);
  assert.deepEqual(eff2.drivers.map((x) => x.firstName), ["Erika"]);
  assert.equal(await db.contractDriver.count({ where: { tenantId: w.tenantId, contractId: w.contractId } }), 2, "Zeile bleibt (Historie)");
  assert.equal((await db.contractDriver.findUniqueOrThrow({ where: { id: d.id } })).removedByAmendmentId, b.id);
  assert.equal((await requiredDriversFor(w.tenantId, w.contractId)).length, 1);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "AMENDMENT_DRIVER_REMOVED" } }), 1);
  // verworfener Entwurf mit Fahrer ohne Prüfung: Fahrer verschwindet, nichts wirkt
  const c3 = await draft(w, "f3");
  const d3 = await addAmendmentDriver(w.tenantId, w.actor, c3.id, { ...DRIVER, firstName: "Kurz", lastName: "Gast", licenseNumber: "K1" });
  await discardAmendment(w.tenantId, w.actor, c3.id);
  assert.equal(await db.contractDriver.count({ where: { id: d3.id } }), 0);
  assert.equal((await effectiveContractState(w.tenantId, w.contractId)).drivers.length, 1);
});

// ---------------------------------------------------------------------------
// Abrechnung
// ---------------------------------------------------------------------------

test("Rechnung: Verlängerung als eigene Position, Minderung mindert den Mietpreis, Summe = wirksamer Preis, kein Doppelansatz", async () => {
  await ready;
  const w = await pickedUpWorld("amend-invoice");
  tenants.push(w.tenantId);
  const c0 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const a = await draft(w, "i");
  const r = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusDays(c0.endAt, 2) });
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: r.priceProposalCents });
  const na = await signed(w, a.id);
  const b = await draft(w, "i2");
  await updateAmendmentDraft(w.tenantId, w.actor, b.id, { priceDeltaCents: -4000, priceReason: "Kulanz" });
  const nb = await signed(w, b.id);
  // Rückgabe abschließen (ohne Zusatzkosten), Rechnung erstellen
  const ret = await startHandover(w.tenantId, w.bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, ret.id, { mileage: 45_500, fuelLevelEighths: 7 });
  const { REQUIRED_PHOTO_CATEGORIES } = await import("../src/lib/constants");
  const { registerPhoto, answerChecklist } = await import("../src/lib/handovers");
  const { buildStorageKey } = await import("../src/lib/storage");
  const { sha256 } = await import("../src/lib/integrity");
  for (const cat of REQUIRED_PHOTO_CATEGORIES) { const key = buildStorageKey({ tenantId: w.tenantId, area: "photos", bookingId: w.bookingId, contentType: "image/jpeg" }); await registerPhoto(w.tenantId, w.actor, { handoverId: ret.id, storageKey: key, category: cat, contentType: "image/jpeg", sizeBytes: 250_000, checksum: sha256(key) }); }
  const items = await db.handoverChecklistItem.findMany({ where: { tenantId: w.tenantId, handoverId: ret.id } });
  await answerChecklist(w.tenantId, ret.id, items.map((i) => ({ itemId: i.id, result: i.answerType === "TEXT" ? (i.itemKey === "keys" || i.itemKey === "keys_returned" ? "2" : "") : i.itemKey === "unusually_dirty" ? "NO" : i.answerType === "YES_NO" ? "YES" : "OK" })));
  await saveHandoverSignature(w.tenantId, w.actor, ret.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getHandoverContentHash(w.tenantId, ret.id), ipAddress: null, userAgent: "test" });
  await finalizeHandover(w.tenantId, ret.id, w.actor);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const state = await getInvoiceState(w.tenantId, inv.id);
  const lines = state.draft!.items;
  const rental = lines.find((i) => i.source === "RENTAL")!;
  const ext = lines.find((i) => i.source === "AMENDMENT")!;
  assert.ok(ext, "Verlängerung als eigene Position");
  assert.equal(ext.amendmentId, na.id);
  assert.match(ext.description, /Verlängerung der Mietdauer bis .* \(2 Tage\), laut Nachtrag NT-/);
  assert.equal(Math.round(Number(ext.grossAmount) * 100), r.priceProposalCents);
  assert.equal(Math.round(Number(rental.grossAmount) * 100), Math.round(Number(c0.totalAmount) * 100) - 4000, "Minderung im Mietpreis, keine negative Position");
  assert.match(rental.description, /Preisminderung/);
  assert.equal(lines.filter((i) => i.amendmentId === nb.id).length, 0, "Minderung ist keine eigene Position");
  const total = lines.reduce((s, i) => s + Math.round(Number(i.grossAmount) * 100), 0);
  assert.equal(total, (await effectiveContractState(w.tenantId, w.contractId)).totalCents, "Rechnungssumme = wirksamer Gesamtpreis");
  assert.equal(lines.filter((i) => i.source === "AMENDMENT").length, 1, "kein Doppelansatz");
  // nach Rückgabe keine Nachträge mehr; nichts offen zur Abrechnung
  await assert.rejects(() => createAmendmentDraft(w.tenantId, w.actor, { bookingId: w.bookingId, nonce: nonce("late") }), /Miete ist beendet/);
  await finalizeInvoice(w.tenantId, inv.id, w.actor);
  assert.equal((await pendingSettlements(w.tenantId, w.bookingId)).length, 0, "alles in der Rechnung enthalten");
  await assert.rejects(() => createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: na.id, nonce: nonce("s") }), /bereits in einer abgeschlossenen Rechnung/);
});

test("Absicherung: Preiserhöhung nach abgeschlossener Mietrechnung → eigene Rechnung, abgeschlossene bleibt; Minderung → Gutschrift-Weg", async () => {
  await ready;
  const w = await returnedWorld("amend-settle");
  tenants.push(w.tenantId);
  const inv = await ensureInvoiceDraft(w.tenantId, w.bookingId, w.actor);
  const fin = await finalizeInvoice(w.tenantId, inv.id, w.actor);
  // Nachtrag nach Rückgabe ist fachlich gesperrt; für die Absicherung wird ein wirksamer Nachtrag mit Preisänderung direkt angelegt
  const base = { tenantId: w.tenantId, contractId: w.contractId, bookingId: w.bookingId, status: "SIGNED", snapshot: { v: 1, before: { endAt: new Date().toISOString() } }, contentHash: contentHash({ x: 1 }), signedAt: new Date(), createdById: w.actor.id, createdByName: w.actor.name };
  const up = await db.contractAmendment.create({ data: { ...base, number: "NT-2026-900001", sequenceNo: 1, priceDeltaCents: 5000, priceReason: "Nachträglich vereinbarter Zuschlag", idempotencyKey: nonce("up") } });
  const down = await db.contractAmendment.create({ data: { ...base, number: "NT-2026-900002", sequenceNo: 2, priceDeltaCents: -2000, priceReason: "Kulanz", idempotencyKey: nonce("down") } });
  const pend = await pendingSettlements(w.tenantId, w.bookingId);
  assert.deepEqual(pend.map((p) => p.deltaCents), [5000, -2000]);
  assert.equal(pend[0].invoiceId, inv.id);
  assert.ok(pend[0].invoiceNumber, "Nummer der abgeschlossenen Mietrechnung");
  void fin;
  const n = nonce("settle");
  const s1 = await createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: up.id, nonce: n });
  const s2 = await createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: up.id, nonce: nonce("settle2") });
  assert.equal(s1.created, true); assert.equal(s2.created, false); assert.equal(s1.invoice.id, s2.invoice.id, "genau ein Abrechnungsbeleg je Nachtrag");
  assert.equal(s1.invoice.kind, "GENERAL"); assert.equal(s1.invoice.status, "DRAFT"); assert.equal(s1.invoice.bookingId, w.bookingId);
  const st = await getInvoiceState(w.tenantId, s1.invoice.id);
  assert.equal(st.draft!.items.length, 1);
  assert.equal(st.draft!.items[0].amendmentId, up.id);
  assert.equal(Math.round(Number(st.draft!.grossTotal) * 100), 5000);
  assert.equal((await db.contractAmendment.findUniqueOrThrow({ where: { id: up.id } })).settlementInvoiceId, s1.invoice.id);
  await assert.rejects(() => db.contractAmendment.update({ where: { id: up.id }, data: { settlementInvoiceId: inv.id } }), /RB_IMMUTABLE/, "Abrechnungsbezug einmalig");
  const orig = await getInvoiceState(w.tenantId, inv.id);
  assert.equal(orig.invoice.status, "FINALIZED");
  assert.equal(orig.current!.items.some((i) => i.amendmentId), false, "abgeschlossene Rechnung unverändert");
  assert.deepEqual((await pendingSettlements(w.tenantId, w.bookingId)).map((p) => p.deltaCents), [-2000], "Erhöhung ist zugeordnet, Minderung bleibt offen");
  await assert.rejects(() => createAmendmentSettlementDraft(w.tenantId, w.actor, { amendmentId: down.id, nonce: nonce("neg") }), /Gutschrift/);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "AMENDMENT_SETTLEMENT_CREATED" } }), 1);
});

// ---------------------------------------------------------------------------
// Dokument, Mail, Mandantentrennung
// ---------------------------------------------------------------------------

test("PDF: „Nachtrag zum Mietvertrag“ mit alt/neu, Schlusssatz, Unterschrift; Archiv einmalig; aus Snapshot", async () => {
  await ready;
  const w = await signedWorld("amend-pdf");
  const c0 = await db.rentalContract.findUniqueOrThrow({ where: { id: w.contractId } });
  const a = await draft(w, "pdf");
  const r = await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newEndAt: plusDays(c0.endAt, 1), newDepositCents: 60000, agreementText: "Dachbox inklusive" });
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { priceDeltaCents: r.priceProposalCents });
  await assert.rejects(() => ensureAmendmentDocument(w.tenantId, a.id, w.actor.id, { storage }), /erst, wenn der Nachtrag unterschrieben/);
  const row = await signed(w, a.id);
  const data = await loadAmendmentDocumentData(w.tenantId, a.id);
  assert.equal(data.doc.title, "Nachtrag zum Mietvertrag");
  assert.equal(data.doc.number, row.number);
  assert.equal(data.doc.contract.number, c0.number);
  assert.deepEqual(data.doc.changes.map((c) => c.label), ["Mietdauer / geplante Rückgabe", "Mietpreis", "Vereinbarte Kaution", "Sonstige Vereinbarung"]);
  assert.match(data.doc.changes[1].note ?? "", /Änderung \+/);
  assert.match(data.doc.closing, /übrigen Vereinbarungen .* unverändert/);
  assert.equal(data.doc.signatures.length, 1); assert.equal(data.doc.signatures[0].roleLabel, "Mieter");
  assert.equal(data.signatureImages.size, 1);
  const pdf = await renderAmendmentPdf(data.doc, data.signatureImages, null);
  assert.ok(pdf.bytes.length > 2000 && pdf.bytes.subarray(0, 4).toString() === "%PDF");
  const d1 = await ensureAmendmentDocument(w.tenantId, a.id, w.actor.id, { storage });
  const d2 = await ensureAmendmentDocument(w.tenantId, a.id, w.actor.id, { storage });
  assert.equal(d1.created, true); assert.equal(d2.created, false); assert.equal(d1.document.id, d2.document.id);
  assert.equal(d1.document.type, "CONTRACT_AMENDMENT"); assert.equal(d1.document.amendmentId, a.id); assert.equal(d1.document.sourceHash, row.contentHash);
  assert.match(d1.document.fileName, /^Nachtrag_NT-\d{4}-\d{6}\.pdf$/);
  assert.equal((await listBookingDocuments(w.tenantId, w.bookingId)).filter((d) => d.type === "CONTRACT_AMENDMENT").length, 1);
  // Snapshot ist die Quelle: spätere Kundenänderung ändert das Dokument nicht
  await db.customer.update({ where: { id: w.customerId }, data: { lastName: "Geändert" } });
  assert.equal((await loadAmendmentDocumentData(w.tenantId, a.id)).doc.customer.name, "Erika Muster");
  const built = buildAmendmentDocument(data.snapshot, row.contentHash!, []);
  assert.equal(built.signatures.length, 0);
});

test("Mail: nur bewusst (nonce), mit PDF, Protokoll und Audit; derselbe nonce sendet nicht zweimal; nichts automatisch", async () => {
  await ready;
  const w = await signedWorld("amend-mail");
  const a = await draft(w, "m");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newReturnLocation: "Bahnhof" });
  await assert.rejects(() => sendAmendment(w.tenantId, w.actor, a.id, { nonce: nonce("early"), transport: new FakeTransport(), storage }), /unterschriebener/);
  const row = await signed(w, a.id);
  assert.equal(await db.emailLog.count({ where: { tenantId: w.tenantId, amendmentId: a.id } }), 0, "Unterschrift versendet nichts");
  const t = new FakeTransport();
  const n = nonce("send");
  const s1 = await sendAmendment(w.tenantId, w.actor, a.id, { nonce: n, transport: t, storage });
  const s2 = await sendAmendment(w.tenantId, w.actor, a.id, { nonce: n, transport: t, storage });
  assert.equal(s1.status, "SENT"); assert.equal(s2.status, "DUPLICATE"); assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].to, "erika@example.test");
  assert.match(t.sent[0].subject, new RegExp(`Nachtrag ${row.number} zum Mietvertrag`));
  assert.equal(t.sent[0].attachments?.length, 1);
  assert.match(t.sent[0].attachments![0].filename, /^Nachtrag_NT-/);
  const log = await db.emailLog.findFirstOrThrow({ where: { tenantId: w.tenantId, amendmentId: a.id } });
  assert.equal(log.status, "SENT"); assert.equal(log.template, "CONTRACT_AMENDMENT"); assert.equal(log.trigger, "MANUAL"); assert.equal(log.bookingId, w.bookingId);
  assert.equal(await db.auditLog.count({ where: { tenantId: w.tenantId, action: "AMENDMENT_SENT" } }), 1);
  const s3 = await sendAmendment(w.tenantId, w.actor, a.id, { nonce: nonce("resend"), transport: t, storage });
  assert.equal(s3.status, "SENT"); assert.equal(s3.resend, true); assert.equal(t.sent.length, 2);
  assert.equal(await db.document.count({ where: { tenantId: w.tenantId, amendmentId: a.id } }), 1, "dasselbe PDF");
  const mail = composeAmendmentMail({ number: "NT-2026-000001", contractNumber: "MV-1", bookingNumber: "2026-0001", changes: ["Rückgabeort"], recipientName: "Erika Muster", landlordName: "Test GmbH", landlordContact: "" });
  assert.match(mail.text, /Rückgabeort/); assert.ok(!/<script/.test(mail.html));
});

test("Mandantentrennung: fremder Mandant sieht und ändert nichts; Fahrer anderer Mandanten nicht zuordenbar", async () => {
  await ready;
  const w = await signedWorld("amend-tenant-a");
  const other = await signedWorld("amend-tenant-b");
  const a = await draft(w, "t");
  await updateAmendmentDraft(w.tenantId, w.actor, a.id, { newDepositCents: 60000 });
  await assert.rejects(() => getAmendmentState(other.tenantId, a.id), /nicht gefunden/);
  await assert.rejects(() => updateAmendmentDraft(other.tenantId, other.actor, a.id, { newDepositCents: 1 }), /nicht gefunden/);
  await assert.rejects(() => signAmendment(other.tenantId, other.actor, a.id), /nicht gefunden/);
  await assert.rejects(() => discardAmendment(other.tenantId, other.actor, a.id), /nicht gefunden/);
  await assert.rejects(() => getAmendmentContentHash(other.tenantId, a.id), /nicht gefunden/);
  await assert.rejects(() => createAmendmentDraft(other.tenantId, other.actor, { bookingId: w.bookingId, nonce: nonce("x") }), /nicht gefunden/);
  assert.equal((await listAmendments(other.tenantId, w.bookingId)).length, 0);
  assert.equal(await effectiveStateForBooking(other.tenantId, w.bookingId), null);
  await assert.rejects(() => effectiveContractState(other.tenantId, w.contractId), /nicht gefunden/);
  // Datenbank: Nachtrag zu fremdem Vertrag unmöglich
  await assert.rejects(() => db.contractAmendment.create({ data: { tenantId: other.tenantId, contractId: w.contractId, bookingId: w.bookingId, idempotencyKey: nonce("cross") } }), /RB_DOMAIN|RB_IMMUTABLE|Mandant/);
  await assert.rejects(() => db.contractAmendment.create({ data: { tenantId: w.tenantId, contractId: w.contractId, bookingId: other.bookingId, idempotencyKey: nonce("cross2") } }), /RB_DOMAIN|Buchung/);
  await discardAmendment(w.tenantId, w.actor, a.id);
});

test("describeChanges: Darstellung alt/neu für alle Änderungsarten", () => {
  const eff = { startAt: new Date("2026-10-04T10:00:00Z"), endAt: new Date("2026-10-10T10:00:00Z"), totalCents: 53400, kmIncludedPerDay: 200, extraKmRate: 0.25, depositCents: 50000, returnLocation: null, pickupLocation: "Hof" } as unknown as Parameters<typeof describeChanges>[1];
  const a = { id: "a", newEndAt: new Date("2026-10-12T10:00:00Z"), priceDeltaCents: 17800, priceReason: null, newKmIncludedPerDay: 300, newExtraKmRate: null, newDepositCents: 60000, newReturnLocation: "Flughafen", agreementText: "Dachbox" } as unknown as Parameters<typeof describeChanges>[0];
  const ch = describeChanges(a, eff, [] as unknown as Parameters<typeof describeChanges>[2]);
  assert.deepEqual(ch.map((c) => c.kind), ["PERIOD", "PRICE", "KM", "DEPOSIT", "RETURN_LOCATION", "AGREEMENT"]);
  assert.equal(ch[1].before, fmtCents(53400)); assert.equal(ch[1].after, fmtCents(71200)); assert.ok(ch[1].note!.includes(`+${fmtCents(17800)}`), ch[1].note!);
  assert.match(ch[0].note!, /2 Tage/);
  assert.equal(ch[4].before, "Hof");
});
