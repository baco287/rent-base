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
  // Befehl 23.1: freie Rechnungen ohne Buchung – Buchungsbezug nur, wenn vorhanden; Rolle und Mandant bleiben Pflicht
  assert.match(counterActions, /const \{ tenant, user \} = await requireRole\("DISPO"\);\n  const invoice = await db\.invoice\.findFirst\(\{ where: \{ id: invoiceId, \.\.\.\(bookingId \? \{ bookingId \} : \{\}\), tenantId: tenant\.id/, "Gegenbeleg-Kontext: nur DISPO und eigener Mandant");
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
  for (const fn of authActions) assert.ok(/await ctx\(caseId\)/.test(authBody(fn)) || /requireRole\("(DISPO|OWNER)"\)/.test(authBody(fn)), `${fn}: nur Inhaber und Disponent`);
  // Behörden-Automatik: Schnellweg und Bearbeitungsentgelt nur über ctx (Disposition, eigener Mandant); Erinnerung nur Inhaber
  for (const fn of ["quickRespondAction", "createFeeInvoiceAction"]) assert.match(authBody(fn), /await ctx\(caseId\)/, `${fn}: nur Disposition`);
  for (const fn of ["saveReminderSettingsAction", "sendReminderNowAction"]) assert.match(authBody(fn), /requireRole\("OWNER"\)/, `${fn}: nur Inhaber`);
  assert.match(readFileSync(path.join(process.cwd(), "src/app/api/authority-uploads/route.ts"), "utf8"), /roleAllows\(session\.user\.role, \["DISPO"\]\)/, "Posteingang-Upload nur Disposition");
  for (const fn of ["setDriverAction", "approveResponseAction", "submitResponseAction", "closeCaseAction", "reopenCaseAction"]) assert.match(authBody(fn), /await ctx\(caseId\)/, `${fn}: Fahrerfreigabe, Antwortfreigabe, Übermittlung, Abschluss nur Disposition`);
  assert.match(auth, /const \{ tenant, user \} = await requireRole\("DISPO"\);\r?\n  await requireFeature\("AUTHORITIES"\);\r?\n  const c = await db\.authorityCase\.findFirst/, "ctx: nur DISPO, freigeschaltetes Modul und eigener Mandant");
  const upload = readFileSync(path.join(process.cwd(), "src/app/api/authority-cases/[id]/documents/route.ts"), "utf8");
  assert.match(upload, /roleAllows\(session\.user\.role, \["DISPO"\]\)/, "Upload zu Behördenvorgängen nur DISPO");
});

/** Phase 19: Suche, Kundenakte, Dashboard – Sitzung und Rolle serverseitig, Sicherheitskopfzeilen, Anmeldebremse, keine öffentlichen Dokumentadressen. */
test("Phase 19: Suche nur mit Sitzung und Rolle, Kopfzeilen additiv, Anmeldebremse, Dokumentzugriff nur über geschützte Adressen", () => {
  const searchActions = readFileSync(path.join(process.cwd(), "src/app/(app)/suche/actions.ts"), "utf8");
  assert.match(searchActions, /export async function globalSearchAction[\s\S]*?requireRole\("DISPO", "YARD"\)/, "Suche: alle Mitarbeiterrollen, aber nur mit Sitzung");
  assert.match(searchActions, /searchQuerySchema\.safeParse/, "Suche: Eingabe mit zod begrenzt");
  assert.match(searchActions, /consume\(`search:\$\{user\.id\}`/, "Suche: Lastbremse je Benutzer");
  assert.ok(!/recordAudit/.test(searchActions), "Suche: keine Protokollierung des Suchbegriffs");
  const search = readFileSync(path.join(process.cwd(), "src/lib/search.ts"), "utf8");
  assert.ok(!/\$queryRawUnsafe|\$executeRawUnsafe/.test(search), "Suche: kein ungeschütztes Roh-SQL");
  assert.ok((search.match(/where: \{ tenantId/g) ?? []).length >= 9, "Suche: jede Abfrage mandantengebunden");
  assert.match(search, /canSeeVin = role === "OWNER" \|\| role === "DISPO"/, "FIN nur Inhaber und Disposition");
  assert.ok(!/iban(?!Masked)/i.test(search.replace(/\/\/.*$/gm, "")), "Suche: keine IBAN als Suchfeld oder Treffer");
  const config = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  for (const h of ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "frame-ancestors 'none'", "Strict-Transport-Security"]) assert.ok(config.includes(h), `Kopfzeile ${h}`);
  assert.ok(!/script-src|default-src/.test(config), "keine blinde CSP für Skripte");
  const login = readFileSync(path.join(process.cwd(), "src/app/(auth)/actions.ts"), "utf8");
  assert.match(login, /export async function loginAction[\s\S]*?consume\(accountKey, LOGIN_LIMIT_PER_ACCOUNT\)[\s\S]*?consume\(addressKey, LOGIN_LIMIT_PER_ADDRESS\)[\s\S]*?verifyPassword/, "Anmeldebremse vor der Passwortprüfung");
  assert.match(login, /hashKeyPart\(email\)/, "Anmeldebremse: E-Mail nur gehasht im Speicher");
  const customerFile = readFileSync(path.join(process.cwd(), "src/lib/customer-file.ts"), "utf8");
  assert.ok(!/https?:\/\//.test(customerFile), "Kundenakte: keine öffentlichen Dokumentadressen");
  assert.match(customerFile, /canAuthority = role !== "YARD"/, "Kundenakte: Behördendokumente nicht für Hofmitarbeiter");
  assert.match(customerFile, /driverCustomerId: customerId/, "Kundenakte: Behördenvorgänge nur über echte Fahrerreferenz");
  for (const route of ["documents", "authority-documents", "damage-documents", "vehicle-documents", "photos", "signatures"]) {
    const src = readFileSync(path.join(process.cwd(), `src/app/api/${route}/[id]/route.ts`), "utf8");
    assert.match(src, /apiSession\("(read|write)"/, `${route}: Sitzung`);
    assert.match(src, /session\.tenant\.id/, `${route}: Mandant`);
  }
});

/** Befehl 20: API-Routen laufen nicht über requireRole() – jede geht über apiSession() (Supportmodus read-only, sensible Dokumente gesperrt, gesperrter Mandant). */
test("Befehl 20: jede API-Route mit Sitzung nutzt apiSession, Schreibrouten als write, sensible Dokumente gesperrt", () => {
  const apiRoot = path.join(process.cwd(), "src/app/api");
  const routes = (readdirSync(apiRoot, { recursive: true }) as string[]).filter((f) => f.endsWith("route.ts") && !f.startsWith("health"));
  assert.ok(routes.length >= 15, "alle API-Routen gefunden");
  for (const route of routes) {
    const src = readFileSync(path.join(apiRoot, route), "utf8");
    assert.ok(!/getSession\(/.test(src), `${route}: kein direktes getSession() (umgeht Supportmodus)`);
    for (const m of src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)[\s\S]*?apiSession\("(read|write)"/g)) {
      assert.equal(m[2], m[1] === "GET" ? "read" : "write", `${route} ${m[1]}: passender Modus`);
    }
  }
  for (const [route, kind] of [["driver-documents", "DRIVER_DOCUMENT_COPY"], ["authority-documents", "AUTHORITY_DOCUMENT"], ["damage-documents", "DAMAGE_DOCUMENT"]]) {
    assert.match(readFileSync(path.join(apiRoot, route, "[id]", "route.ts"), "utf8"), new RegExp(`apiSession\\("read", "${kind}"\\)`), `${route}: im Supportmodus gesperrt`);
  }
});

/** Phase 19.5: Fahreridentifikation und Führerscheinprüfung – Rollen, Kundenstammdaten-Übernahme nur Disposition/Inhaber, Dokumentrouten mandanten-/rollengesichert, keine sensiblen Daten in Suche oder Audit. */
test("Phase 19.5: Fahrerprüfung nur mit Sitzung und Rolle, Kundendaten-Übernahme nur Disposition/Inhaber, Dokumentkopien mandantengesichert", () => {
  const driverActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/uebergabe/driver-actions.ts"), "utf8");
  assert.ok(!/"OWNER"\)/.test(driverActions.replace(/requireRole\("DISPO"\)/g, "")), "keine Aktion ist auf OWNER allein beschränkt (Inhaber darf ohnehin alles)");
  for (const fn of ["startDriverVerificationAction", "saveIdentityCheckAction", "saveLicenseCheckAction", "confirmDriverVerificationAction"]) {
    assert.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`).exec(driverActions)?.[0] ?? "", /requireRole\("DISPO", "YARD"\)/, `${fn}: Übergabe führen Inhaber, Disposition und Hofmitarbeiter gemeinsam durch`);
  }
  const updateFn = new RegExp(`export async function updateCustomerLicenseAction[\\s\\S]*?\\n}`).exec(driverActions)?.[0] ?? "";
  assert.match(updateFn, /requireRole\("DISPO"\)/, "Kundenstammdaten-Übernahme nur Inhaber und Disposition");
  assert.ok(!/"YARD"/.test(updateFn), "Kundenstammdaten-Übernahme nicht für YARD");

  for (const route of ["handovers/[id]/driver-documents", "driver-documents/[id]"]) {
    const src = readFileSync(path.join(process.cwd(), `src/app/api/${route}/route.ts`), "utf8");
    assert.match(src, /apiSession\("(read|write)"/, `${route}: Sitzung`);
    assert.match(src, /session\.tenant\.id/, `${route}: Mandant`);
  }

  const driverLib = readFileSync(path.join(process.cwd(), "src/lib/driver-verification.ts"), "utf8");
  assert.ok(!/https?:\/\//.test(driverLib), "Fahrerprüfung: keine öffentlichen Dokumentadressen");
  assert.match(driverLib, /consentRequired = input\.documentKind === "IDENTITY"/, "Personalausweiskopie: Zustimmung ist Pflicht, Führerscheinkopie nicht");
  assert.match(driverLib, /if \(consentRequired && !input\.consent\?\.given\) throw new DomainError/, "ohne Zustimmung keine Speicherung");
  assert.ok((driverLib.match(/where: \{ id: [^,]+, tenantId/g) ?? []).length >= 5 || (driverLib.match(/tenantId,/g) ?? []).length >= 10, "Fahrerprüfung: Abfragen mandantengebunden");

  const search = readFileSync(path.join(process.cwd(), "src/lib/search.ts"), "utf8");
  assert.ok(!/driverVerification|DriverVerification|licenseNumberSnapshot/.test(search), "globale Suche indexiert keine Fahrerprüfungsdaten (Ausweis-/Führerscheinnummern)");

  const pdfLib = readFileSync(path.join(process.cwd(), "src/lib/pdf/handover-pdf.ts"), "utf8");
  assert.ok(!/licenseNumberSnapshot|identityDocumentNumber/.test(pdfLib), "PDF enthält keine vollständige Ausweis- oder Führerscheinnummer");
});

/** Control Center: jede Plattform-Aktion prüft requirePlatform(<Berechtigung>) serverseitig; freischaltbare Module prüfen requireFeature/featureForApi. */
test("Control Center: Plattform-Aktionen prüfen requirePlatform mit Berechtigung, Feature-Module prüfen requireFeature serverseitig", () => {
  const admin = readFileSync(path.join(process.cwd(), "src/app/admin/actions.ts"), "utf8");
  const actions = (admin.match(/export async function (\w+)/g) ?? []).map((m) => m.replace("export async function ", ""));
  assert.ok(actions.length >= 12, `Plattform-Aktionen gefunden: ${actions.length}`);
  const body = (name: string) => new RegExp(`export async function ${name}[\\s\\S]*?\\n}`).exec(admin)?.[0] ?? "";
  for (const fn of actions) assert.match(body(fn), /await requirePlatform\(/, `${fn}: ohne requirePlatform`);
  assert.ok(!/requireRole\(/.test(admin), "Plattform-Aktionen nutzen nie die Mandantenrolle");
  const expected: [string, string][] = [
    ["createTenantAction", "TENANT_CREATE"], ["suspendTenantAction", "TENANT_SUSPEND"], ["reactivateTenantAction", "TENANT_SUSPEND"],
    ["startSupportSessionAction", "SUPPORT_SESSION"], ["toggleUserActiveAction", "USER_MANAGE"], ["resendInvitationPlatformAction", "USER_MANAGE"],
    ["resendOwnerInvitationAction", "USER_MANAGE"], ["revokeOwnerInvitationAction", "USER_MANAGE"],
    ["setPlatformRoleAction", "PLATFORM_ROLE_MANAGE"], ["setFeatureAction", "FEATURE_MANAGE"], ["saveSubscriptionAction", "BILLING_MANAGE"],
  ];
  for (const [fn, perm] of expected) assert.match(body(fn), new RegExp(`requirePlatform\\("${perm}"\\)`), `${fn}: braucht ${perm}`);
  // kritische Aktionen verlangen eine ausdrückliche Bestätigung im Formular
  assert.match(admin, /const suspendSchema = z\.object\(\{[^\n]*confirm: z\.literal\("SPERREN"/, "Sperrung: Tippbestätigung");
  assert.match(admin, /const startSupportSchema = z\.object\(\{[^\n]*confirm: z\.literal\("on"/, "Supportmodus: Bestätigung");
  assert.match(admin, /const roleSchema = z\.object\(\{[\s\S]*?confirm: z\.literal\("on"/, "Rollenvergabe: Bestätigung");
  assert.match(body("toggleUserActiveAction"), /formData\.get\("confirm"\) !== "on"/, "Benutzersperre: Bestätigung");
  // Jede /admin-Seite ruft requirePlatform auf
  const pages: string[] = [];
  const walkAdmin = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walkAdmin(p); else if (/page\.tsx$/.test(f)) pages.push(p); } };
  walkAdmin(path.join(process.cwd(), "src", "app", "admin"));
  assert.ok(pages.length >= 10, `Control-Center-Seiten: ${pages.length}`);
  for (const p of pages) assert.match(readFileSync(p, "utf8"), /await requirePlatform\(/, `${path.relative(process.cwd(), p)} ohne requirePlatform`);
  // Plattform-Auth kennt nur die Matrix, nie einzelne Rollennamen; Supportmodus über die Matrix
  const platformAuth = readFileSync(path.join(process.cwd(), "src/lib/platform-auth.ts"), "utf8");
  assert.match(platformAuth, /isInternalRole\(session\.user\.platformRole\)/);
  assert.match(platformAuth, /platformAllows\(session\.user\.platformRole, permission\)/);
  assert.match(readFileSync(path.join(process.cwd(), "src/lib/auth.ts"), "utf8"), /platformAllows\(user\.platformRole, "SUPPORT_SESSION"\)/, "Supportmodus nur für Rollen mit SUPPORT_SESSION");
  // Feature-Gating: Modul-Layouts und alle Aktionen der freischaltbaren Module
  const gated: [string, string][] = [
    ["src/app/(app)/behoerden", "AUTHORITIES"], ["src/app/(app)/schaeden", "DAMAGE_CASES"], ["src/app/(app)/fahrzeuge/wartung", "MAINTENANCE"],
    ["src/app/(app)/auszahlungen", "PAYOUTS"], ["src/app/(app)/einstellungen/e-mail", "TENANT_SMTP"], ["src/app/(app)/kunden/import", "CUSTOMER_IMPORT"],
    ["src/app/(app)/unfallersatz", "ACCIDENT_REPLACEMENT"],
  ];
  for (const [dir, key] of gated) assert.match(readFileSync(path.join(process.cwd(), dir, "layout.tsx"), "utf8"), new RegExp(`requireFeature\\("${key}"\\)`), `${dir}: Layout ohne requireFeature`);
  for (const [file, key] of [["src/app/(app)/behoerden/actions.ts", "AUTHORITIES"], ["src/app/(app)/schaeden/[id]/actions.ts", "DAMAGE_CASES"], ["src/app/(app)/fahrzeuge/wartung/actions.ts", "MAINTENANCE"], ["src/app/(app)/auszahlungen/actions.ts", "PAYOUTS"], ["src/app/(app)/einstellungen/e-mail/actions.ts", "TENANT_SMTP"], ["src/app/(app)/buchungen/[id]/key-drop-actions.ts", "KEY_DROP"], ["src/app/(app)/unfallersatz/neu/actions.ts", "ACCIDENT_REPLACEMENT"], ["src/app/(app)/unfallersatz/[id]/actions.ts", "ACCIDENT_REPLACEMENT"]] as const) {
    const src = readFileSync(path.join(process.cwd(), file), "utf8");
    const roleCalls = (src.match(/^[ \t]+.*await requireRole\(/gm) ?? []).length; // Zeilen, nicht Aufrufe (ctx mit Ternär zählt einmal)
    const featureCalls = (src.match(new RegExp(`await requireFeature\\("${key}"\\)`, "g")) ?? []).length;
    assert.equal(featureCalls, roleCalls, `${file}: jede Rollenprüfung wird von requireFeature("${key}") begleitet`);
  }
  for (const [file, key] of [["src/app/api/authority-uploads/route.ts", "AUTHORITIES"], ["src/app/api/damage-cases/[id]/documents/route.ts", "DAMAGE_CASES"], ["src/app/api/maintenance/[id]/documents/route.ts", "MAINTENANCE"], ["src/app/api/payouts/[id]/documents/route.ts", "PAYOUTS"], ["src/app/api/kunden/import/commit/route.ts", "CUSTOMER_IMPORT"], ["src/app/api/accident-cases/[id]/documents/route.ts", "ACCIDENT_REPLACEMENT"]] as const) {
    assert.match(readFileSync(path.join(process.cwd(), file), "utf8"), new RegExp(`featureForApi\\(session, "${key}"\\)`), `${file}: API-Route ohne Feature-Prüfung`);
  }
});

/** Befehl 29 Phase C: Unfallersatz-Wizard – Anlage nur OWNER/DISPO mit freigeschaltetem Modul, jede Aktion serverseitig; Standardbuchung unberührt. */
test("Phase C: Unfallersatz-Anlage nur Inhaber und Disposition mit Freischaltung, jede Aktion serverseitig, keine technischen Fehler an den Benutzer", () => {
  const actions = readFileSync(path.join(process.cwd(), "src/app/(app)/unfallersatz/neu/actions.ts"), "utf8");
  assert.match(actions, /^"use server";/);
  assert.ok(!/"YARD"/.test(actions), "Unfallersatz-Aktionen dürfen YARD nicht zulassen");
  const names = (actions.match(/export async function (\w+)/g) ?? []).map((m) => m.replace("export async function ", ""));
  assert.deepEqual(names.sort(), ["accidentAvailabilityAction", "createAccidentCaseAction"]);
  for (const fn of names) {
    const body = new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`).exec(actions)?.[0] ?? "";
    // Rolle und Freischaltung sind die ersten beiden Anweisungen – vor jedem Lesen der Eingaben
    assert.match(body, /\{\r?\n  const \{ tenant(, user)? \} = await requireRole\("DISPO"\);\r?\n  await requireFeature\("ACCIDENT_REPLACEMENT"\);/, `${fn}: zuerst Rolle (OWNER/DISPO) und Freischaltung`);
  }
  // verbindliche Prüfung auf dem Server; Mandant aus der Sitzung, nie aus dem Formular
  assert.match(actions, /parseAccidentWizard\(data\)/);
  assert.match(actions, /createAccidentCase\(tenant\.id, /);
  assert.ok(!/formData\.get\("tenantId"\)|data\.tenantId/.test(actions), "Mandant nie aus dem Formular");
  assert.match(actions, /where: \{ tenantId: tenant\.id, status: \{ not: "INACTIVE" \} \}/, "Verfügbarkeit nur eigene Fahrzeuge");
  // unbekannte Fehler: allgemeine Meldung, im Log nur die Fehlerart (keine Eingaben, keine Meldung)
  assert.match(actions, /if \(e instanceof DomainError\) return \{ error: e\.message/);
  assert.match(actions, /return \{ error: "Der Unfallersatzfall konnte nicht angelegt werden\. Bitte erneut versuchen\.", step: 6 \}/);
  assert.match(actions, /console\.error\("\[unfallersatz\] Anlage fehlgeschlagen", \{ fehler: e instanceof Error \? e\.name : "unbekannt" \}\)/);
  // Seite: nur OWNER/DISPO; Modul-Layout prüft die Freischaltung; Fachlogik prüft sie zusätzlich in der Transaktion
  // jede Seite des Moduls prüft die Freischaltung auch selbst (eine Teil-Navigation kann das Layout überspringen)
  const uePages: string[] = [];
  const walkUe = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walkUe(p); else if (f === "page.tsx") uePages.push(p); } };
  walkUe(path.join(process.cwd(), "src", "app", "(app)", "unfallersatz"));
  assert.ok(uePages.length >= 1);
  for (const p of uePages) assert.match(readFileSync(p, "utf8"), /await requireFeature\("ACCIDENT_REPLACEMENT"\)/, `${path.relative(process.cwd(), p)}: ohne requireFeature`);
  assert.match(readFileSync(path.join(process.cwd(), "src/app/(app)/unfallersatz/neu/page.tsx"), "utf8"), /const \{ tenant \} = await requireRole\("DISPO"\);\r?\n  await requireFeature\("ACCIDENT_REPLACEMENT"\);/);
  assert.match(readFileSync(path.join(process.cwd(), "src/lib/accident-replacement.ts"), "utf8"), /await assertFeature\(tenantId, "ACCIDENT_REPLACEMENT", tx\)/);
  // Formular: POST über die Server-Aktion (auch vor dem Laden des Skripts nie als GET mit Daten in der Adresse)
  assert.match(readFileSync(path.join(process.cwd(), "src/app/(app)/unfallersatz/neu/wizard.tsx"), "utf8"), /<form ref=\{formRef\} action=\{formAction\}/);
  // Standardbuchung: Formular und Anlage ohne Unfallersatz-Bezug; Mietart-Auswahl nur bei Freischaltung
  const bookingActions = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/actions.ts"), "utf8");
  const createBody = /export async function createBookingAction[\s\S]*?\n}/.exec(bookingActions)?.[0] ?? "";
  assert.ok(createBody.length > 500 && !/ACCIDENT|accident|Unfallersatz|rentalType/.test(createBody), "Standardbuchung: Anlage unverändert, Mietart bleibt Standard");
  assert.ok(!/ACCIDENT|accident|Unfallersatz/.test(readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/booking-form.tsx"), "utf8")));
  const newBooking = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/neu/page.tsx"), "utf8");
  assert.match(newBooking, /const accidentEnabled = await isFeatureEnabled\(tenant\.id, "ACCIDENT_REPLACEMENT"\);/);
  assert.match(newBooking, /\{accidentEnabled && <RentalTypeSwitch current="STANDARD"/);
});

/** Befehl 29 Phase D: Fallakte – Verwaltung nur OWNER/DISPO mit Freischaltung, Hof bekommt serverseitig nur die operative Sicht. */
test("Phase D: Fallakten-Aktionen nur Inhaber und Disposition, Hofsicht serverseitig reduziert, Adressbuch nur bewusst", () => {
  const actions = readFileSync(path.join(process.cwd(), "src/app/(app)/unfallersatz/[id]/actions.ts"), "utf8");
  assert.match(actions, /^"use server";/);
  assert.ok(!/"YARD"/.test(actions), "Fallakten-Aktionen dürfen YARD nicht zulassen");
  // ctx: zuerst Rolle (OWNER/DISPO) und Freischaltung, dann der Fall des eigenen Mandanten
  assert.match(actions, /async function ctx\(caseId: string\) \{\r?\n  const \{ tenant, user \} = await requireRole\("DISPO"\);\r?\n  await requireFeature\("ACCIDENT_REPLACEMENT"\);\r?\n  const c = await db\.accidentReplacementCase\.findFirst\(\{ where: \{ id: caseId, tenantId: tenant\.id \}/);
  const names = (actions.match(/export async function (\w+)/g) ?? []).map((m) => m.replace("export async function ", ""));
  assert.ok(names.length >= 13, `Fallakten-Aktionen: ${names.length}`);
  for (const fn of names) {
    const body = new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`).exec(actions)?.[0] ?? "";
    assert.match(body, /\{\r?\n  const x = await ctx\(caseId\);\r?\n  if \(!x\) return/, `${fn}: zuerst ctx (Rolle, Freischaltung, Mandant)`);
  }
  // Wiedervorlage gehört zum Fall der Akte (nicht nur zum Mandanten)
  assert.match(actions, /completeFollowUp\(x\.tenantId, followUpId, x\.actor, .*\{ caseId: x\.c\.id \}\)/);
  assert.match(actions, /cancelFollowUp\(x\.tenantId, followUpId, x\.actor, .*\{ caseId: x\.c\.id \}\)/);
  // Seite: Freischaltung, Sicht nach Rolle, fremder/fehlender Fall = 404; kaufmännische Bereiche nur in der Vollsicht
  const page = readFileSync(path.join(process.cwd(), "src/app/(app)/unfallersatz/[id]/page.tsx"), "utf8");
  assert.match(page, /const \{ tenant, user \} = await requireFeature\("ACCIDENT_REPLACEMENT"\);/);
  assert.match(page, /const access = caseFileAccess\(user\.role\);/);
  assert.match(page, /if \(!h\) notFound\(\);/);
  assert.match(page, /tab === "schadenfall" && full &&/);
  assert.match(page, /tab === "abrechnung" && full &&/);
  const lib = readFileSync(path.join(process.cwd(), "src/lib/accident-case-file.ts"), "utf8");
  assert.match(lib, /caseFileAccess = \(role: string\): CaseFileAccess => \(roleAllows\(role, \["DISPO"\]\) \? "FULL" : "OPERATIONAL"\)/, "Vollsicht nur OWNER/DISPO; Supportmodus läuft als YARD");
  assert.match(lib, /const full = access === "FULL"\r?\n    \? await db\.accidentReplacementCase\.findUniqueOrThrow/, "Versicherungsangaben nur in der Vollsicht abfragen");
  // Adressbuch lernt beim Bearbeiten nur auf ausdrücklichen Wunsch und nur die bearbeitete Art
  const ar = readFileSync(path.join(process.cwd(), "src/lib/accident-replacement.ts"), "utf8");
  const learnCalls = ar.match(/await learnPartners\(tx, tenantId, [^)]*\)/g) ?? [];
  assert.deepEqual(learnCalls.sort(), [
    'await learnPartners(tx, tenantId, ["INSURER", "WORKSHOP", "LAWYER"], created)',
    'await learnPartners(tx, tenantId, ["INSURER"], row)',
    'await learnPartners(tx, tenantId, ["LAWYER"], row)',
    'await learnPartners(tx, tenantId, ["WORKSHOP"], row)',
    // reine Adressbuch-Übernahme ohne Änderung am Fall (ebenfalls nur auf Wunsch)
    'await learnPartners(tx, tenantId, ["INSURER"], c)',
    'await learnPartners(tx, tenantId, ["WORKSHOP"], c)',
    'await learnPartners(tx, tenantId, ["LAWYER"], c)',
  ].sort());
  for (const kind of ["INSURER", "WORKSHOP", "LAWYER"]) assert.ok(ar.includes(`.addressBook) { await learnPartners(tx, tenantId, ["${kind}"], c);`), `${kind}: Übernahme ohne Änderung nur auf Wunsch`);
  assert.match(ar, /if \(input\.addressBook\) await learnPartners\(tx, tenantId, \["INSURER"\], row\)/);
  assert.match(ar, /if \(opts\.addressBook\) await learnPartners\(tx, tenantId, \["WORKSHOP"\], row\)/);
  assert.match(ar, /if \(opts\.addressBook\) await learnPartners\(tx, tenantId, \["LAWYER"\], row\)/);
  // Buchungsseite: Unfallersatz ohne Sackgassen (Mietrechnung, Nachtrag-Verlängerung) und mit Link zur Fallakte; Phase E: der
  // Vertragsassistent ist für Unfallersatz freigegeben, nur ein geschlossener Fall sperrt ihn
  const booking = readFileSync(path.join(process.cwd(), "src/app/(app)/buchungen/[id]/page.tsx"), "utf8");
  assert.match(booking, /\{caseHref && <Link href=\{caseHref\} className="btn btn-primary">Unfallersatzfall öffnen<\/Link>\}/);
  assert.match(booking, /returnDone && !invoice && user\.role !== "YARD" && !accident && <Link href=\{`\/buchungen\/\$\{b\.id\}\/rechnung`\}/);
  assert.match(booking, /!agreed && !accident && <form action=\{createAmendmentAction/);
  assert.match(booking, /stage === "CONTRACT_DRAFT" && user\.role !== "YARD" && !caseLocked && <Link/);
  assert.ok(!booking.includes("Vertragsabschluss für Unfallersatz folgt"), "kein Hinweis „folgt“ mehr");
});
