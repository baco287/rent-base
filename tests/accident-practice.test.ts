// Praxistest-Korrekturrunde vor Phase G: Unfallersatz im Dispo-Kalender (Kennzeichnung, Weg in die Fallakte), auf „Heute“
// (offene Fälle, Handlungsbedarf aus der Fallakten-Ableitung, Hof ohne Finanzdaten) und die Kaution des Mieters in der Fallakte
// (bestehende Kautionslogik, strikt getrennt von der Versicherungsrechnung; nächste Schritte und Abschlusswarnung).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import { closeCase, closeWarnings, createAccidentCase, createFollowUp, depositSignals, nextSteps, type CreateAccidentCaseInput } from "../src/lib/accident-replacement";
import { caseFileHeader, caseFileOverview, caseFileRental } from "../src/lib/accident-case-file";
import { accidentBarTime, accidentBarTitle, isAccidentRental } from "../src/lib/accident-dispo";
import { loadDashboard } from "../src/lib/dashboard";
import { createAccidentInvoiceDraft, finalizeInvoice } from "../src/lib/invoices";
import { invoicePaymentSummary } from "../src/lib/payments";
import { applyDepositOffset, depositOffsetOptions } from "../src/lib/deposit-offset";
import { depositView, recordDepositReceived, settleDeposit } from "../src/lib/deposits";
import { createPayout } from "../src/lib/payouts";
import { finalizeContract, getContractContentHash, saveConditions, saveContractSignature } from "../src/lib/contracts";
import { finalizeHandover, startHandover, updateHandoverDraft } from "../src/lib/handovers";
import { fmtDateTime } from "../src/lib/format";
import { getStorage } from "../src/lib/storage";
import { REQUIRED_PHOTO_CATEGORIES } from "../src/lib/constants";
import { createWorld, fakeSignaturePng, purgeTenants, verifyAllDriversForPickup, type World } from "./helpers";
import { answerAll, photo, sign } from "./rental-flow";

const tenants: string[] = [];
let dir = "";
const ready = (async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rb-ue-k-"));
  getStorage({ NODE_ENV: "test", LOCAL_STORAGE_DIR: dir } as unknown as NodeJS.ProcessEnv);
})();
after(async () => {
  await purgeTenants(tenants);
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const HOUR = 3600_000, DAY = 24 * HOUR;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
let seq = 0;
const nonce = () => `ue-k-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const src = (p: string) => readFile(path.join(process.cwd(), p), "utf8");
/** Beträge enthalten ein geschütztes Leerzeichen (fmtCents) */
const sp = (s: string) => s.replace(/ /g, " ");
const newVehicle = async (w: World) => (await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UK ${nonce().slice(-4).toUpperCase()}`, make: "VW", model: "Polo", groupId: w.groupId, fuel: "BENZIN", mileage: 1000, dailyRate: 40, requiredLicenseClass: "B" } })).id;

type AWorld = World & { v2: string };
async function world(label: string): Promise<AWorld> {
  await ready;
  const w = await createWorld(label);
  tenants.push(w.tenantId);
  await db.tenant.update({ where: { id: w.tenantId }, data: { defaultTaxRate: 19, pricesIncludeTax: true, taxNumber: "60/123/45678", paymentTermDays: 14, legalForm: "GmbH" } });
  await db.tenantFeatureFlag.create({ data: { tenantId: w.tenantId, key: "ACCIDENT_REPLACEMENT", enabled: true } });
  const v2 = await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UK ${Math.random().toString(36).slice(2, 6).toUpperCase()}`, make: "VW", model: "Golf", groupId: w.groupId, fuel: "BENZIN", mileage: 30_000, dailyRate: 59, kmIncludedPerDay: 100, extraKmRate: 0.2, tankCapacityLiters: 50, requiredLicenseClass: "B" } });
  return { ...w, v2: v2.id };
}
function caseInput(w: AWorld, over: Partial<CreateAccidentCaseInput> = {}): CreateAccidentCaseInput {
  return {
    nonce: nonce(), customerId: w.customerId, vehicleId: w.v2, startAt: plus(new Date(), HOUR), plannedEndAt: null, dailyRateCents: 7_900, depositCents: 0, kmIncludedPerDay: 200, extraKmRateCents: 25,
    damaged: { plate: "hb-ab 123", make: "Opel", model: "Astra", drivable: false, damageKind: "REPAIR" },
    accident: { accidentAt: plus(new Date(), -2 * DAY), place: "Bremen" },
    insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: "SN-2026-4711", contactName: null, phone: null, email: null, street: "Merkweg 1", zip: "28195", city: "Bremen" },
    liability: { status: "CONFIRMED" },
    tariff: [{ kind: "LIABILITY_REDUCTION", perDay: true, unitPriceCents: 1_500 }],
    ...over,
  };
}
/** Fall anlegen, Vertrag (offenes Ende, Kaution laut Konditionen), Unterschrift, Übergabe vor pickupAgo. */
async function runningCase(w: AWorld, pickupAgo: number, over: Partial<CreateAccidentCaseInput> = {}, deposit = 0) {
  const res = await createAccidentCase(w.tenantId, w.actor, caseInput(w, over));
  const c = await db.rentalContract.findFirstOrThrow({ where: { tenantId: w.tenantId, bookingId: res.bookingId } });
  const bk = await db.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
  await saveConditions(w.tenantId, c.id, { startAt: bk.startAt, endAt: null, deposit, kmIncludedPerDay: 200, extraKmRate: 0.25, deductible: 500, fuelPolicy: "FULL_TO_FULL", fuelPolicyNote: null, fuelPricePerLiter: 1.8, agreedTotal: null, agreedTotalNote: null, pickupLocation: "Hof", returnLocation: null }, w.actor);
  await saveContractSignature(w.tenantId, w.actor, c.id, { role: "RENTER", signerName: "Erika Muster", imageDataUrl: fakeSignaturePng(), seenHash: await getContractContentHash(w.tenantId, c.id) });
  await finalizeContract(w.tenantId, c.id);
  const ww = { ...w, bookingId: res.bookingId, vehicleId: bk.vehicleId };
  const p = await startHandover(w.tenantId, res.bookingId, "PICKUP", w.actor);
  await updateHandoverDraft(w.tenantId, p.id, { mileage: 30_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, p.id, cat);
  await answerAll(ww, p.id);
  await sign(ww, p.id);
  await verifyAllDriversForPickup(w.tenantId, w.actor, p.id, c.id);
  await finalizeHandover(w.tenantId, p.id, w.actor);
  await db.booking.update({ where: { id: res.bookingId }, data: { actualPickupAt: new Date(Date.now() - pickupAgo) } });
  return { ...res, caseId: res.case.id };
}
async function returnCase(w: AWorld, bookingId: string) {
  const bk = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { vehicleId: true } });
  const ww = { ...w, bookingId, vehicleId: bk.vehicleId };
  const r = await startHandover(w.tenantId, bookingId, "RETURN", w.actor);
  await updateHandoverDraft(w.tenantId, r.id, { mileage: 30_100, fuelLevelEighths: 8 });
  for (const cat of REQUIRED_PHOTO_CATEGORIES) await photo(ww, r.id, cat);
  await answerAll(ww, r.id);
  await sign(ww, r.id);
  await finalizeHandover(w.tenantId, r.id, w.actor);
}
async function insurerInvoice(w: AWorld, caseId: string) {
  const { invoice } = await createAccidentInvoiceDraft(w.tenantId, w.actor, { caseId, recipientRole: "INSURER", nonce: nonce() });
  await finalizeInvoice(w.tenantId, invoice.id, w.actor);
  return invoice.id;
}
const accidentTasks = (d: Awaited<ReturnType<typeof loadDashboard>>) => d.tasks.filter((t) => t.area === "ACCIDENT");

// ---------------------------------------------------------------------------
// Dispo (1–6)
// ---------------------------------------------------------------------------

test("Dispo 1–6: Standardbalken unverändert; Unfallersatz textlich gekennzeichnet; offenes und geplantes Ende; Weg in die Fallakte; Mandantengrenze", async () => {
  const start = new Date("2026-10-05T10:15:00Z"), windowStart = new Date("2026-10-05T00:00:00+02:00");
  // 1: Standardbuchungen werden nicht als Unfallersatz erkannt; ihr Balken-Code ist unverändert (gleiche Ausdrücke wie vorher)
  assert.equal(isAccidentRental({ rentalType: "STANDARD" }), false);
  assert.equal(isAccidentRental({ rentalType: null }), false);
  assert.equal(isAccidentRental({ rentalType: "ACCIDENT_REPLACEMENT" }), true);
  const page = await src("src/app/(app)/dispo/page.tsx");
  assert.ok(page.includes("title={ue ? accidentBarTitle(b, b.accidentCase?.caseNumber ?? null, customerName(b.customer), overdue) : `${b.number} · ${customerName(b.customer)} · ${fmtTime(b.startAt)} bis ${endText}${overdue ? ` · Rückgabe überfällig (geplant ${fmtDateTime(b.endAt)})` : \"\"}`}"), "Standard-Tooltip unverändert");
  assert.ok(page.includes(": ue ? accidentBarTime(b, from) : b.endAt ? fmtTime(b.startAt) : `${fmtTime(b.startAt)} · Mietende offen`}"), "Standard-Zeitangabe unverändert");
  assert.ok(page.includes(`\${cls}\${ue ? " @container" : ""}`), "nur Unfallersatz-Balken bekommen die Container-Abfrage");
  // 2: Kennzeichnung immer als Text – breit „Unfallersatz“, schmal „UE“ (nicht nur Farbe)
  assert.match(page, /\{ue && <b className="font-semibold"><span className="@\[18rem\]:hidden">UE<span className="sr-only"> \(Unfallersatz\)<\/span><\/span><span className="hidden @\[18rem\]:inline">Unfallersatz<\/span>/);
  assert.match(page, /<b className="font-semibold text-ink">UE<\/b> = Unfallersatz/);
  assert.match(accidentBarTitle({ number: "2026-0042", startAt: start, endAt: null }, "UE-2026-000001", "Sezer Karakus", false), /^Unfallersatz UE-2026-000001 · 2026-0042 · Sezer Karakus · ab .* · Mietende offen$/);
  // 3: offenes Mietende
  assert.equal(accidentBarTime({ startAt: start, endAt: null }, windowStart), `ab ${new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(start)} · Mietende offen`);
  // Beginn vor dem sichtbaren Fenster: mit Datum
  assert.match(accidentBarTime({ startAt: plus(windowStart, -3 * DAY), endAt: null }, windowStart), /^ab \d{2}\.\d{2}\.\d{4} · Mietende offen$/);
  // 4: bekanntes geplantes Ende
  const end = new Date("2026-10-09T08:00:00Z");
  assert.ok(accidentBarTime({ startAt: start, endAt: end }, windowStart).endsWith(`geplant bis ${fmtDateTime(end)}`));
  assert.ok(accidentBarTitle({ number: "2026-0042", startAt: start, endAt: end }, "UE-2026-000001", "X", true).endsWith(`geplantes Mietende überschritten ${fmtDateTime(end)}`));
  // 5: Fallakte über „Unfallersatz im Zeitraum“ (nur mit Modul; Balken führt weiter zur Buchung)
  assert.match(page, /accidentCase: \{ select: \{ id: true, caseNumber: true \} \}/);
  assert.match(page, /isFeatureEnabled\(tenant\.id, "ACCIDENT_REPLACEMENT"\)/);
  assert.match(page, /\{accidentOn && accidentRows\.length > 0 && \(/);
  assert.match(page, /href=\{`\/unfallersatz\/\$\{b\.accidentCase!\.id\}`\} className="btn btn-primary !py-1\.5 text-xs">Unfallersatzfall öffnen<\/Link>/);
  assert.match(page, /<Link\s+href=\{`\/buchungen\/\$\{b\.id\}`\}\s+title=\{ue \?/);
  // keine Versicherungs- oder Finanzdaten im Dispo
  assert.doesNotMatch(page, /insurer|claimNumber|grossTotal|amountCents/);
  // 6: Mandantengrenze – die Abfrage bleibt auf den Mandanten beschränkt (der Fall hängt an der Buchung des Mandanten)
  assert.match(page, /where: \{ tenantId: tenant\.id, \.\.\.occupyingWhere\(from, to, new Date\(\)\) \}/);
  const w = await world("uk-dispo");
  const other = await world("uk-dispo-x");
  const r = await createAccidentCase(w.tenantId, w.actor, caseInput(w));
  const own = await db.booking.findMany({ where: { tenantId: w.tenantId, rentalType: "ACCIDENT_REPLACEMENT" }, include: { accidentCase: { select: { id: true, caseNumber: true } } } });
  const foreign = await db.booking.findMany({ where: { tenantId: other.tenantId, rentalType: "ACCIDENT_REPLACEMENT" }, include: { accidentCase: { select: { id: true, caseNumber: true } } } });
  assert.equal(own.length, 1); assert.equal(own[0].accidentCase?.id, r.case.id);
  assert.equal(foreign.length, 0);
});

// ---------------------------------------------------------------------------
// Heute (7–13)
// ---------------------------------------------------------------------------

test("Heute 7–12: offene Fälle (nicht Buchungen), geschlossene zählen nicht; laufende Miete; Rückgabe ohne Schlussrechnung und fällige Wiedervorlage als Handlungsbedarf; normal laufend ohne Warnung", async () => {
  const w = await world("uk-heute");
  // Modul aus: kein Unfallersatz-Bereich
  const off = await world("uk-heute-off");
  await createAccidentCase(off.tenantId, off.actor, caseInput(off));
  await db.tenantFeatureFlag.update({ where: { tenantId_key: { tenantId: off.tenantId, key: "ACCIDENT_REPLACEMENT" } }, data: { enabled: false } });
  const dOff = await loadDashboard(off.tenantId);
  assert.equal(dOff.accident, null);
  assert.equal(accidentTasks(dOff).length, 0);

  // 0 Fälle
  let d = await loadDashboard(w.tenantId);
  assert.deepEqual({ open: d.accident!.open, running: d.accident!.running, toInvoice: d.accident!.toInvoice, followUpsDue: d.accident!.followUpsDue }, { open: 0, running: 0, toInvoice: 0, followUpsDue: 0 });

  // 9/12: laufende Miete, vollständige Versicherungsangaben, Haftung bestätigt → gezählt, aber keine Aufmerksamkeit
  const running = await runningCase(w, 2 * DAY);
  d = await loadDashboard(w.tenantId);
  assert.equal(d.accident!.open, 1);
  assert.equal(d.accident!.running, 1);
  assert.equal(d.accident!.singleCaseId, running.caseId);
  assert.equal(accidentTasks(d).length, 0, "normal laufender Fall ohne Handlungsbedarf erzeugt keinen Eintrag");
  assert.ok(!d.tasks.some((t) => t.key === `return-overdue-${running.bookingId}`), "offenes Ende ist nie überfällig");

  // 7/10: zweiter Fall zurückgegeben, noch nicht abgerechnet → Handlungsbedarf „Abzurechnen“ mit Link in die Abrechnung
  const ret = await runningCase(w, 3 * DAY, { vehicleId: await newVehicle(w) });
  await returnCase(w, ret.bookingId);
  // 8: dritter Fall geschlossen → zählt nicht
  const closed = await createAccidentCase(w.tenantId, w.actor, caseInput(w, { vehicleId: (await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UK ${nonce().slice(-4).toUpperCase()}`, make: "VW", model: "Polo", groupId: w.groupId, fuel: "BENZIN", mileage: 1000, dailyRate: 40, requiredLicenseClass: "B" } })).id }));
  await closeCase(w.tenantId, closed.case.id, w.actor, { reason: "Kunde hat abgesagt", acknowledgeWarnings: true });
  d = await loadDashboard(w.tenantId);
  assert.equal(d.accident!.open, 2, "geschlossene Fälle zählen nicht");
  assert.equal(d.accident!.running, 1);
  assert.equal(d.accident!.toInvoice, 1);
  assert.equal(d.accident!.singleCaseId, null);
  const retTask = accidentTasks(d).find((t) => t.key === `accident-case-${ret.caseId}`)!;
  assert.ok(retTask, "Rückgabe ohne Rechnung erscheint");
  assert.equal(retTask.group, "NOTE");
  assert.equal(retTask.status, "Abzurechnen");
  assert.equal(retTask.href, `/unfallersatz/${ret.caseId}?tab=abrechnung`);
  assert.match(retTask.detail, /zurückgegeben, noch nicht abgerechnet/);
  assert.ok(!accidentTasks(d).some((t) => t.key.includes(closed.case.id)));

  // 10 (Schluss): nach Schlussrechnung an die Versicherung → „Rechnung offen“ statt „Abzurechnen“
  await insurerInvoice(w, ret.caseId);
  d = await loadDashboard(w.tenantId);
  assert.equal(d.accident!.toInvoice, 0);
  assert.equal(d.accident!.invoicesOpen, 1);
  assert.equal(accidentTasks(d).find((t) => t.key === `accident-case-${ret.caseId}`)!.status, "Rechnung offen");

  // 11: fällige Wiedervorlage (heute) und überfällige erscheinen nach Fälligkeit; spätere nur im Zeitraum
  const fu = await createFollowUp(w.tenantId, running.caseId, w.actor, { title: "Versicherung anrufen", dueAt: new Date() });
  const late = await createFollowUp(w.tenantId, running.caseId, w.actor, { title: "Gutachten nachfragen", dueAt: plus(new Date(), 3 * DAY) });
  const old = await createFollowUp(w.tenantId, running.caseId, w.actor, { title: "Mietdauer klären", dueAt: plus(new Date(), -2 * DAY) });
  d = await loadDashboard(w.tenantId);
  assert.equal(d.accident!.followUpsDue, 2);
  assert.equal(d.tasks.find((t) => t.key === `accident-followup-${fu.id}`)?.group, "TODAY");
  assert.equal(d.tasks.find((t) => t.key === `accident-followup-${old.id}`)?.group, "OVERDUE");
  assert.ok(!d.tasks.some((t) => t.key === `accident-followup-${late.id}`), "spätere Wiedervorlage nicht im Zeitraum „heute“");
  const d7 = await loadDashboard(w.tenantId, { horizon: "7" });
  assert.equal(d7.tasks.find((t) => t.key === `accident-followup-${late.id}`)?.group, "SOON");
  // 12: der laufende Fall selbst bleibt ohne eigenen Warn-Eintrag (nur seine Wiedervorlagen)
  assert.ok(!d.tasks.some((t) => t.key === `accident-case-${running.caseId}`));
  // Wiedervorlagen geschlossener Fälle erscheinen nicht
  await createFollowUp(w.tenantId, closed.case.id, w.actor, { title: "nach Abschluss", dueAt: new Date() }).catch(() => undefined);
  d = await loadDashboard(w.tenantId);
  assert.ok(!d.tasks.some((t) => t.area === "ACCIDENT" && t.href.includes(closed.case.id)));
});

test("Heute 5/13: Schadennummer fehlt, Haftung ungeklärt als Handlungsbedarf; Hof ohne Versicherungs-, Finanz- und Wiedervorlagendaten (auch nicht in den Forderungen)", async () => {
  const w = await world("uk-heute-hof");
  const r = await runningCase(w, DAY, { insurer: { name: "MERKVERSICHERUNG-AG", claimNumber: null, contactName: null, phone: null, email: null, street: "Merkweg 1", zip: "28195", city: "Bremen" }, liability: { status: "UNCLEAR" } });
  await createFollowUp(w.tenantId, r.caseId, w.actor, { title: "Schadennummer erfragen", dueAt: new Date() });
  const ret = await runningCase(w, 3 * DAY, { vehicleId: (await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UK ${nonce().slice(-4).toUpperCase()}`, make: "VW", model: "Polo", groupId: w.groupId, fuel: "BENZIN", mileage: 1000, dailyRate: 40, requiredLicenseClass: "B" } })).id });
  await returnCase(w, ret.bookingId);
  const invId = await insurerInvoice(w, ret.caseId);
  const full = await loadDashboard(w.tenantId);
  const t = accidentTasks(full).find((x) => x.key === `accident-case-${r.caseId}`)!;
  assert.equal(t.status, "Schadennummer fehlt");
  assert.match(t.detail, /Schadennummer der Versicherung fehlt/);
  assert.match(t.detail, /Haftung: /);
  assert.equal(t.href, `/unfallersatz/${r.caseId}?tab=schadenfall`);
  assert.ok(full.receivables.openCents > 0, "Disposition: Unfallersatz-Forderung in den Kennzahlen");

  const yard = await loadDashboard(w.tenantId, { hideAccidentBilling: true });
  assert.equal(yard.accident!.open, 2);
  assert.equal(yard.accident!.running, 1);
  assert.equal(yard.accident!.toInvoice, null);
  assert.equal(yard.accident!.invoicesOpen, null);
  assert.equal(yard.accident!.followUpsDue, null);
  assert.equal(accidentTasks(yard).length, 0, "keine Versicherungs-, Abrechnungs- oder Wiedervorlageneinträge für den Hof");
  assert.equal(yard.receivables.openCents, 0, "Forderungs-Kennzahlen ohne Unfallersatz-Beträge");
  assert.ok(!yard.tasks.some((x) => x.href.includes(invId)));
  assert.doesNotMatch(JSON.stringify(yard.accident), /MERKVERSICHERUNG|SN-2026|Schadennummer|Haftung/);
  // die Seite übergibt die Hof-Sicht weiterhin
  assert.match(await src("src/app/(app)/heute/page.tsx"), /loadDashboard\(tenant\.id, \{ horizon, hideAccidentBilling: user\.role === "YARD" \}\)/);
});

// ---------------------------------------------------------------------------
// Kaution (14–27)
// ---------------------------------------------------------------------------

test("Kaution 14–25: Betrag und Eingang in der Fallakte; nach Rückgabe „Kaution prüfen“; Freigabe/Teil-Einbehalt/Auszahlung über die bestehende Kautionslogik; Versicherungsrechnung bleibt getrennt und offen; Abschlusswarnung und erledigter Schritt", async () => {
  const w = await world("uk-kaution");
  // 15: Kaution 0 → kein Kautionsbereich, keine Schritte
  const zero = await runningCase(w, DAY);
  const hz = (await caseFileHeader(w.tenantId, zero.caseId, "FULL"))!;
  assert.equal((await caseFileRental(w.tenantId, hz, "FULL")).deposit, null);
  await returnCase(w, zero.bookingId);
  const hz2 = (await caseFileHeader(w.tenantId, zero.caseId, "FULL"))!;
  assert.ok(!(await caseFileOverview(w.tenantId, hz2, "FULL")).steps.some((s) => s.code.startsWith("DEPOSIT")));
  assert.ok(!(await closeWarnings(w.tenantId, zero.caseId)).some((x) => x.code.startsWith("DEPOSIT")));

  // 14/16: Kaution 500 € laut Vertrag – vor Eingang „noch nicht erhalten“, nach Eingang erhalten
  const vehicle2 = (await db.vehicle.create({ data: { tenantId: w.tenantId, plate: `HB-UK ${nonce().slice(-4).toUpperCase()}`, make: "VW", model: "Polo", groupId: w.groupId, fuel: "BENZIN", mileage: 1000, dailyRate: 40, requiredLicenseClass: "B" } })).id;
  const r = await runningCase(w, 2 * DAY + HOUR, { vehicleId: vehicle2, depositCents: 50_000 }, 500);
  let h = (await caseFileHeader(w.tenantId, r.caseId, "FULL"))!;
  assert.notEqual((await caseFileRental(w.tenantId, h, "FULL")).deposit, null, "Kautionsbereich bei vereinbarter Kaution");
  assert.equal((await caseFileRental(w.tenantId, h, "OPERATIONAL")).deposit, null, "Hof: kein Kautionsbereich in der Fallakte");
  let v = await depositView(w.tenantId, r.bookingId);
  assert.equal(v.expectedCents, 50_000); assert.equal(v.receivedCents, 0); assert.equal(v.status, "EXPECTED");
  await recordDepositReceived(w.tenantId, w.actor, { bookingId: r.bookingId, amount: "500,00", method: "CASH", occurredAt: new Date() });
  v = await depositView(w.tenantId, r.bookingId);
  assert.equal(v.receivedCents, 50_000); assert.equal(v.status, "RECEIVED");
  // während der Miete: kein Kautionsschritt (normal gehalten)
  assert.ok(!(await caseFileOverview(w.tenantId, h, "FULL")).steps.some((s) => s.code.startsWith("DEPOSIT")));

  // Rückgabe und Versicherungsrechnung (3 Miettage × (79 + 15) = 282 €)
  await returnCase(w, r.bookingId);
  const invId = await insurerInvoice(w, r.caseId);
  const before = await invoicePaymentSummary(w.tenantId, invId);
  assert.equal(before.openCents, 28_200);

  // 17: offene Kautionsentscheidung erkannt (nächste Schritte, Abschlusswarnung)
  h = (await caseFileHeader(w.tenantId, r.caseId, "FULL"))!;
  let steps = (await caseFileOverview(w.tenantId, h, "FULL")).steps;
  const depStep = steps.find((s) => s.code === "DEPOSIT_OPEN")!;
  assert.equal(sp(depStep.text), "Kaution prüfen: 500,00 € erhalten, noch nicht freigegeben oder einbehalten.");
  assert.equal(depStep.href, `/unfallersatz/${r.caseId}?tab=miete#kaution`);
  // 24: offene Kaution → Abschlusswarnung (kein hartes Verbot)
  const cw = await closeWarnings(w.tenantId, r.caseId);
  assert.ok(cw.some((x) => x.code === "DEPOSIT_OPEN" && x.text === "Kaution noch offen – Freigabe oder Einbehalt prüfen."));

  // 22: Versicherungsrechnung wird nicht mit der Kaution verrechnet (nicht angeboten, serverseitig abgelehnt)
  const opts = await depositOffsetOptions(w.tenantId, r.bookingId);
  assert.ok(!opts.invoices.some((i) => i.id === invId));
  await assert.rejects(() => applyDepositOffset(w.tenantId, w.actor, { bookingId: r.bookingId, invoiceId: invId, amount: "282,00", occurredAt: new Date() } as never), /Versicherung bzw\. einen anderen Empfänger|nicht verrechnet|keine offene Forderung/);

  // 18/19: Teilweiser Einbehalt über die bestehende Logik (Freigabe 300 €, Einbehalt 200 € mit Grund) – wie bei Standardmieten
  await assert.rejects(() => settleDeposit(w.tenantId, w.actor, { bookingId: r.bookingId, releaseAmount: "300", occurredAt: new Date() }), /Grund/);
  await settleDeposit(w.tenantId, w.actor, { bookingId: r.bookingId, releaseAmount: "300,00", method: "BANK_TRANSFER", reason: "Tankfüllung fehlte", occurredAt: new Date() });
  v = await depositView(w.tenantId, r.bookingId);
  assert.deepEqual({ released: v.releasedCents, retained: v.retainedCents, remaining: v.remainingCents, payout: v.payoutRemainingCents, status: v.status }, { released: 30_000, retained: 20_000, remaining: 0, payout: 30_000, status: "PARTIALLY_RELEASED" });
  // 23: die Versicherungsrechnung bleibt unverändert offen (keine Verrechnung, kein „durch Kaution bezahlt“)
  const afterRelease = await invoicePaymentSummary(w.tenantId, invId);
  assert.deepEqual({ open: afterRelease.openCents, paid: afterRelease.paidCents, status: afterRelease.status }, { open: before.openCents, paid: before.paidCents, status: before.status });
  assert.equal(await db.payment.count({ where: { invoiceId: invId } }), 0);

  // 13: nach der Freigabe „Kautionsauszahlung offen“ statt „Kaution prüfen“
  steps = (await caseFileOverview(w.tenantId, h, "FULL")).steps;
  assert.ok(!steps.some((s) => s.code === "DEPOSIT_OPEN"));
  assert.equal(sp(steps.find((s) => s.code === "DEPOSIT_PAYOUT_OPEN")!.text), "Kautionsauszahlung offen: 300,00 € freigegeben, noch nicht ausgezahlt.");
  assert.ok((await closeWarnings(w.tenantId, r.caseId)).some((x) => x.code === "DEPOSIT_PAYOUT_OPEN"));

  // 21: offene Auszahlung in der bestehenden Heute-Kennzahl (keine eigene Unfallersatz-Kautionskennzahl)
  let d = await loadDashboard(w.tenantId);
  assert.equal(d.counts.depositPayoutsOpen, 1);
  assert.equal(d.counts.depositPayoutsOpenCents, 30_000);
  assert.ok(d.tasks.some((t) => t.key === `deposit-payout-${r.bookingId}`));
  assert.ok(!accidentTasks(d).some((t) => /Kaution/.test(t.detail)), "keine doppelte Kautionsaufgabe im Bereich Unfallersatz");

  // 20/25: Auszahlung über die bestehende Auszahlungslogik → Kaution erledigt, kein Schritt, keine Warnung
  await createPayout(w.tenantId, w.actor, { sourceType: "SECURITY_DEPOSIT_REFUND", bookingId: r.bookingId }, { amount: "300,00", method: "CASH", executedAt: new Date(), receiptConfirmed: true }, { complete: true, confirmed: true });
  v = await depositView(w.tenantId, r.bookingId);
  assert.deepEqual({ paid: v.completedPayoutCents, open: v.payoutRemainingCents }, { paid: 30_000, open: 0 });
  steps = (await caseFileOverview(w.tenantId, h, "FULL")).steps;
  assert.ok(!steps.some((s) => s.code.startsWith("DEPOSIT")), "erledigte Kaution: kein Hinweis mehr");
  assert.ok(!(await closeWarnings(w.tenantId, r.caseId)).some((x) => x.code.startsWith("DEPOSIT")));
  d = await loadDashboard(w.tenantId);
  assert.equal(d.counts.depositPayoutsOpen, 0);
  // Versicherungsrechnung weiterhin offen
  assert.equal((await invoicePaymentSummary(w.tenantId, invId)).openCents, 28_200);
});

test("Kaution: reine Ableitung – während der Miete kein Schritt, nach Rückgabe/Storno offen, Auszahlung offen unabhängig vom Status; geschlossener Fall nur „abgeschlossen“", () => {
  const dep = (o: Partial<{ expectedCents: number; receivedCents: number; remainingCents: number; payoutRemainingCents: number }>) => ({ expectedCents: 50_000, receivedCents: 50_000, remainingCents: 50_000, payoutRemainingCents: 0, ...o });
  assert.deepEqual(depositSignals(dep({}), "ACTIVE"), []);
  assert.deepEqual(depositSignals(null, "RETURNED"), []);
  assert.deepEqual(depositSignals(dep({}), "RETURNED").map((s) => s.code), ["DEPOSIT_OPEN"]);
  assert.deepEqual(depositSignals(dep({}), "CANCELLED").map((s) => s.code), ["DEPOSIT_OPEN"]);
  assert.deepEqual(depositSignals(dep({ remainingCents: 0, payoutRemainingCents: 10_000 }), "RETURNED").map((s) => s.code), ["DEPOSIT_PAYOUT_OPEN"]);
  assert.deepEqual(depositSignals(dep({ remainingCents: 0, payoutRemainingCents: 0 }), "RETURNED"), []);
  assert.deepEqual(depositSignals(dep({ expectedCents: 0, receivedCents: 0, remainingCents: 0 }), "RETURNED"), []);
  const fin = { invoices: [], drafts: 0, active: 1, billedUntil: null, finalBilled: true, grossCents: 0, paidCents: 0, openCents: 0, reducedCents: 0, remainderCents: 0, doubleClaimCents: 0, doubleClaimHint: null, economicOpenCents: 0, orphanRemainderCents: 0, remainderExcessCents: 0, unresolvedReductionCents: 0, creditCents: 0, refundOpenCents: 0, feesOpenCents: 0, overbilledDays: 0, gaps: [], pickupAt: null, unbilledChargeCount: 0 } as never;
  const c = { id: "c1", status: "CLOSED", bookingId: "b1", insurerName: "X", insurerClaimNumber: "1", liabilityStatus: "CONFIRMED" };
  assert.deepEqual(nextSteps(c as never, { status: "RETURNED", endAt: null, contract: null, handovers: [], depositState: dep({}) }, fin, []).map((s) => s.code), ["CLOSED"]);
});

test("Kaution 15/16/26/27: Fallakte nutzt den bestehenden Kautionsbereich (Rollen, Aktionen) – Versicherungsrechnungen dort nicht sichtbar; Standardkaution unverändert", async () => {
  const tabs = await src("src/app/(app)/unfallersatz/[id]/case-tabs.tsx");
  assert.match(tabs, /\{full && r\.deposit && \(/, "nur Vollsicht und nur bei relevanter Kaution");
  assert.match(tabs, /<DepositPanel tenantId=\{tenantId\} bookingId=\{b\.id\} role=\{role\} charges=\{r\.deposit\.charges\} accident=\{\{ caseClosed: h\.status === "CLOSED" \}\} \/>/);
  assert.match(tabs, /<section id="kaution" aria-label="Kaution"/);
  const panel = await src("src/app/(app)/buchungen/[id]/finanzen/panels.tsx");
  // bestehende Rollenlogik unverändert: Entscheidungen nur ohne Hofrolle; Aktionen der Buchung (requireRole serverseitig)
  assert.match(panel, /const canDecide = role !== "YARD";/);
  assert.match(panel, /settleDepositAction\.bind\(null, bookingId\)/);
  // nur Rechnungen an den Mieter „zur Einordnung“ (Standardmieten: alle), Hof ohne Unfallersatz-Abrechnung
  assert.match(panel, /\.filter\(\(i\) => recipientRoleOf\(i\.currentVersion\?\.customerSnapshot as \{ recipientRole\?: string \} \| null\) === "RENTER"\)/);
  assert.match(panel, /\.\.\.\(role === "YARD" \? \{ NOT: ACCIDENT_BILLING_WHERE \} : \{\}\)/);
  // geschlossener Fall: keine Verrechnung mit Unfallersatz-Rechnungen angeboten (serverseitig ohnehin gesperrt)
  assert.match(panel, /offset0 && accident\?\.caseClosed \? \{ \.\.\.offset0, invoices: offset0\.invoices\.filter\(\(i\) => i\.kind !== "ACCIDENT_REPLACEMENT"\) \} : offset0/);
  // Standardtexte des Kautionsbereichs unverändert (z. B. Einordnung ohne Verrechnung)
  assert.match(panel, /<p className="text-xs text-ink-3">Rent-Base verrechnet die Kaution nie automatisch mit Zusatzkosten, Rechnungen oder Schadenabrechnungen./);
  assert.doesNotMatch(panel, /^s*undefineds*$/m);
  // Standard-Buchungsseite ruft den Bereich wie bisher (ohne Unfallersatz-Option)
  assert.match(await src("src/app/(app)/buchungen/[id]/page.tsx"), /<DepositPanel tenantId=\{tenant\.id\} bookingId=\{b\.id\} role=\{user\.role\} charges=\{returnDone \? \{ count: charges\.length, total: chargesTotal \} : null\} \/>/);
  const actions = await src("src/app/(app)/buchungen/[id]/finanzen/actions.ts");
  assert.match(actions, /export async function settleDepositAction[\s\S]{0,400}requireRole\("DISPO"\)/);
});
