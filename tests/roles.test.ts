// Rollenmatrix: dieselbe Funktion, die requireRole in jeder Server Action und geschützten Seite als Erstes aufruft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { roleAllows } from "../src/lib/constants";

const ROLES = ["OWNER", "DISPO", "YARD"] as const;
const matrix: [string, readonly string[], Record<(typeof ROLES)[number], boolean>][] = [
  ["Buchung erstellen/ändern/stornieren", ["DISPO"], { OWNER: true, DISPO: true, YARD: false }],
  ["Mietvertrag erstellen/bearbeiten/finalisieren, Konditionen", ["DISPO"], { OWNER: true, DISPO: true, YARD: false }],
  ["Fahrzeuge und Gruppen pflegen", ["DISPO"], { OWNER: true, DISPO: true, YARD: false }],
  ["Übergabe, Rückgabe, Schäden, Fotos, Checkliste, Unterschrift, Zusatzkosten", ["DISPO", "YARD"], { OWNER: true, DISPO: true, YARD: true }],
  ["Kunden anlegen und ergänzen", ["DISPO", "YARD"], { OWNER: true, DISPO: true, YARD: true }],
  ["Dokumente erzeugen, ansehen, E-Mail erneut senden", ["DISPO", "YARD"], { OWNER: true, DISPO: true, YARD: true }],
  ["Einstellungen, Benutzer, Löschen", ["OWNER"], { OWNER: true, DISPO: false, YARD: false }],
];

test("Rollenmatrix: Inhaber alles, Disponent disponiert, Hofmitarbeiter führt Übergabe und Rückgabe durch", () => {
  for (const [what, allowed, expected] of matrix) for (const role of ROLES) assert.equal(roleAllows(role, allowed), expected[role], `${role}: ${what}`);
  assert.equal(roleAllows("GAST", ["DISPO", "YARD"]), false);
  assert.equal(roleAllows("", ["DISPO"]), false);
});

/** Jede Server Action und jede geschützte Seite muss die Rollenprüfung enthalten, nicht nur die Oberfläche. */
test("Jede Server-Action-Datei und jede Prozessseite prüft die Rolle serverseitig", () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/actions\.ts$/.test(f) || /\/(vertrag|uebergabe|rueckgabe|rechnung|neu)\/page\.tsx$/.test(p.split(path.sep).join("/"))) files.push(p); } };
  walk(path.join(process.cwd(), "src", "app", "(app)"));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(/requireRole\(/.test(src), `${path.relative(process.cwd(), f)} ohne requireRole`);
    const exportedActions = (src.match(/export async function \w+/g) ?? []).length;
    if (/^"use server";/.test(src)) assert.ok((src.match(/requireRole\(/g) ?? []).length >= 1 && exportedActions > 0, `${path.relative(process.cwd(), f)}: Aktionen ohne Rollenprüfung`);
  }
  // Vertragsaktionen: nur DISPO (und damit OWNER)
  const contractActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/vertrag/actions.ts"), "utf8");
  assert.ok(!/requireRole\("DISPO", "YARD"\)/.test(contractActions), "Vertragsaktionen dürfen YARD nicht zulassen");
  const bookingActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/actions.ts"), "utf8");
  assert.ok(!/"YARD"/.test(bookingActions), "Buchungsaktionen dürfen YARD nicht zulassen");
  // Rechnungen: anlegen, bearbeiten, abschließen und versenden nur DISPO (und OWNER); PDF erzeugen und laden auch YARD
  const invoiceActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rechnung/actions.ts"), "utf8");
  assert.ok(!/"YARD"/.test(invoiceActions), "Rechnungsaktionen dürfen YARD nicht zulassen");
  for (const fn of ["startInvoiceEditAction", "finalizeInvoiceAction", "markDeliveredAction", "saveInvoiceDraftAction", "discardInvoiceDraftAction"]) assert.ok(new RegExp(`export async function ${fn}`).test(invoiceActions), `${fn} vorhanden`);
  // Gutschriften und Stornobelege: anlegen, speichern, abschließen, verwerfen nur DISPO (und OWNER); Nummernkreise nur OWNER
  const counterActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/rechnung/counter-actions.ts"), "utf8");
  assert.ok(!/"YARD"/.test(counterActions), "Gegenbeleg-Aktionen dürfen YARD nicht zulassen");
  for (const fn of ["createCreditNoteAction", "createCancellationAction", "saveCounterDraftAction", "finalizeCounterAction", "discardCounterAction"]) assert.ok(new RegExp(`export async function ${fn}`).test(counterActions), `${fn} vorhanden`);
  assert.match(counterActions, /const \{ tenant, user \} = await requireRole\("DISPO"\);\n  const invoice = await db\.invoice\.findFirst\(\{ where: \{ id: invoiceId, bookingId, tenantId: tenant\.id/, "Gegenbeleg-Kontext: nur DISPO und eigener Mandant");
  // Auszahlungen (Phase 18): Entwurf, Abschluss, Storno, PDF, E-Mail nur DISPO (und OWNER); YARD sieht nur; Upload nur DISPO
  const payoutActions = readFileSync(path.join(process.cwd(), "src/app/(app)/auszahlungen/actions.ts"), "utf8");
  assert.ok(!/"YARD"/.test(payoutActions), "Auszahlungsaktionen dürfen YARD nicht zulassen");
  for (const fn of ["previewPayoutAction", "createPayoutAction", "updatePayoutDraftAction", "completePayoutAction", "cancelPayoutAction", "generatePayoutPdfAction", "sendPayoutReceiptAction"]) {
    assert.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`).exec(payoutActions)?.[0] ?? "", /requireRole\("DISPO"\)/, `${fn}: nur Inhaber und Disponent`);
  }
  const payoutUpload = readFileSync(path.join(process.cwd(), "src/app/api/payouts/[id]/documents/route.ts"), "utf8");
  assert.match(payoutUpload, /roleAllows\(session\.user\.role, \["DISPO"\]\)/, "Nachweis-Upload nur DISPO");
  const rangesActions = readFileSync(path.join(process.cwd(), "src/app/(app)/einstellungen/nummernkreise/actions.ts"), "utf8");
  assert.match(rangesActions, /export async function updateNumberRangesAction[\s\S]*?requireRole\("OWNER"\)/, "Nummernkreise nur Inhaber");
  const docActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/dokumente/actions.ts"), "utf8");
  assert.match(docActions, /export async function resendInvoiceAction[\s\S]*?requireRole\("DISPO"\)/, "Rechnungsversand nur DISPO");
  // Zahlungen und Kaution: Zahlung erfassen/stornieren, Kaution freigeben/einbehalten/korrigieren nur DISPO (und OWNER);
  // Kaution als erhalten dokumentieren auch YARD (operativ bei der Übergabe)
  const money = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/finanzen/actions.ts"), "utf8");
  const bodyOf = (name: string) => new RegExp(`export async function ${name}[\\s\\S]*?\\n}`).exec(money)?.[0] ?? "";
  for (const fn of ["recordPaymentAction", "cancelPaymentAction", "settleDepositAction", "cancelDepositEventAction", "previewPaymentAction", "previewDepositSettleAction"]) {
    assert.match(bodyOf(fn), /requireRole\("DISPO"\)/, `${fn}: nur Inhaber und Disponent`);
  }
  assert.match(bodyOf("recordDepositReceivedAction"), /requireRole\("DISPO", "YARD"\)/, "Kaution erhalten: auch Hofmitarbeiter");
  // Schadenakten: Haftung, Kosten, Reparatur, Sperren/Freigeben, Kundenbelastung, Schließen nur DISPO (und OWNER) über ctx(caseId)
  // ohne Rollenliste; Eröffnen und operative Notizen auch YARD.
  const cases = readFileSync(path.join(process.cwd(), "src/app/(app)/schaeden/[id]/actions.ts"), "utf8");
  const caseBody = (name: string) => new RegExp(`export async function ${name}[\\s\\S]*?\\n}`).exec(cases)?.[0] ?? "";
  for (const fn of ["changeStatusAction", "setPriorityAction", "setLiabilityAction", "setCostsAction", "setRepairAction", "setInternalNoteAction", "closeCaseAction", "reopenCaseAction", "blockVehicleAction", "releaseVehicleAction", "chargeCustomerAction"]) {
    assert.match(caseBody(fn), /await ctx\(caseId\)/, `${fn}: nur Inhaber und Disponent`);
    assert.ok(!/"YARD"/.test(caseBody(fn)), `${fn}: YARD nicht zugelassen`);
  }
  assert.match(caseBody("addNoteAction"), /ctx\(caseId, "DISPO", "YARD"\)/, "Notiz: auch Hofmitarbeiter");
  assert.match(caseBody("openDamageCaseAction"), /requireRole\("DISPO", "YARD"\)/, "Akte eröffnen: auch Hofmitarbeiter");
  assert.match(cases, /const \{ tenant, user \} = roles\.length \? await requireRole\(\.\.\.roles\) : await requireRole\("DISPO"\);/, "ctx ohne Rollen = nur DISPO");
  // Wartung: Pläne, Anlage, Bearbeiten, Kosten, Abschluss, Abbruch, Sperren/Freigeben, Schadenakte, Kostenübernahme, Archivieren nur DISPO (und OWNER);
  // Kilometer, Notiz und „In Arbeit“ auch YARD.
  const maint = readFileSync(path.join(process.cwd(), "src/app/(app)/fahrzeuge/wartung/actions.ts"), "utf8");
  const maintBody = (name: string) => new RegExp(`export async function ${name}[\\s\\S]*?\\n}`).exec(maint)?.[0] ?? "";
  for (const fn of ["createPlanAction", "updatePlanAction", "setPlanActiveAction", "createMaintenanceAction", "archiveDocumentAction"]) assert.match(maintBody(fn), /requireRole\("DISPO"\)/, `${fn}: nur Inhaber und Disponent`);
  for (const fn of ["updateMaintenanceAction", "setCostsAction", "completeMaintenanceAction", "cancelMaintenanceAction", "blockVehicleAction", "releaseVehicleAction", "linkDamageCaseAction", "adoptCostsAction", "linkDamageDocumentAction"]) {
    assert.match(maintBody(fn), /await ctx\(maintenanceId\)/, `${fn}: nur Inhaber und Disponent`);
    assert.ok(!/"YARD"/.test(maintBody(fn)), `${fn}: YARD nicht zugelassen`);
  }
  for (const fn of ["documentMileageAction", "addNoteAction"]) assert.match(maintBody(fn), /ctx\(maintenanceId, "DISPO", "YARD"\)/, `${fn}: auch Hofmitarbeiter`);
  assert.match(maintBody("changeStatusAction"), /p\.data\.to === "IN_PROGRESS" \? await ctx\(maintenanceId, "DISPO", "YARD"\) : await ctx\(maintenanceId\)/, "Status: nur „In Arbeit“ für den Hof");
  assert.match(maint, /const \{ tenant, user \} = roles\.length \? await requireRole\(\.\.\.roles\) : await requireRole\("DISPO"\);/, "Wartung: ctx ohne Rollen = nur DISPO");
  // Behördenvorgänge: alle Vorgangsschritte (Erfassen, Zuordnen, Fahrerbestimmung, Antwort vorbereiten/freigeben/übermitteln, Nachweise,
  // Abschluss, Dokumente) nur DISPO (und OWNER); YARD sieht nur. Auch der Dokument-Upload verlangt DISPO.
  const auth = readFileSync(path.join(process.cwd(), "src/app/(app)/behoerden/actions.ts"), "utf8");
  assert.ok(!/"YARD"/.test(auth), "Behördenaktionen dürfen YARD nicht zulassen");
  const authActions = auth.match(/export async function (\w+)/g)!.map((m) => m.replace("export async function ", ""));
  assert.ok(authActions.length >= 14);
  const authBody = (name: string) => new RegExp(`export async function ${name}[\\s\\S]*?\\n}`).exec(auth)?.[0] ?? "";
  for (const fn of authActions) assert.ok(/await ctx\(caseId\)/.test(authBody(fn)) || /requireRole\("DISPO"\)/.test(authBody(fn)), `${fn}: nur Inhaber und Disponent`);
  for (const fn of ["setDriverAction", "approveResponseAction", "submitResponseAction", "closeCaseAction", "reopenCaseAction"]) assert.match(authBody(fn), /await ctx\(caseId\)/, `${fn}: Fahrerfreigabe, Antwortfreigabe, Übermittlung, Abschluss nur Disposition`);
  assert.match(auth, /const \{ tenant, user \} = await requireRole\("DISPO"\);\n  const c = await db\.authorityCase\.findFirst/, "ctx: nur DISPO und eigener Mandant");
  const upload = readFileSync(path.join(process.cwd(), "src/app/api/authority-cases/[id]/documents/route.ts"), "utf8");
  assert.match(upload, /roleAllows\(session\.user\.role, \["DISPO"\]\)/, "Upload zu Behördenvorgängen nur DISPO");
});
