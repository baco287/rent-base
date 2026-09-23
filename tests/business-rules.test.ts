// Geschäftsregeln und Mietbedingungs-Parser (Phase 15) – reine Funktionen: Prioritätskette, Herkunft, Prüfung,
// Vertragsanpassung, Übernahme neuer Standardwerte, Zusatzfahrerpreis, kalendergenaues Mindestalter (Schaltjahr),
// Markdown-Teilmenge (Überschriften, Listen, fett, kein HTML), Versionsbezeichnungen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BUSINESS_RULES, RuleError, additionalDriverFee, adoptDefaults, ageAt, applyContractOverrides, contractRuleIssues, initialContractRules, monthsSince, resolveRules, ruleConsistencyIssues, rulesFingerprint, sanitizeRules } from "../src/lib/business-rules";
import { proposeLabel } from "../src/lib/rental-terms";
import { TERMS_STRUCTURE_TEMPLATE, parseTerms, termsPlainText, validateTermsSource } from "../src/lib/terms-markdown";

const T = (iso: string) => new Date(iso);

test("Priorität: Systemvorgabe → Mandant → Gruppe → Fahrzeug, der konkreteste Wert gewinnt und kennt seine Herkunft", () => {
  const r0 = resolveRules(null, null, null);
  assert.deepEqual(r0.values, DEFAULT_BUSINESS_RULES);
  assert.equal(r0.sources.deductibleCents, "DEFAULT");
  const tenant = { deductibleCents: 100000, abroadAllowed: true, abroadCountries: ["AT", "NL"], smokingAllowed: false, additionalDriverFeeType: "FLAT", additionalDriverFeeCents: 1500, minimumDriverAge: 21 };
  const r1 = resolveRules(tenant, { name: "Transporter", businessRules: { deductibleCents: 150000, petsPolicy: "NOT_ALLOWED", minimumDriverAge: 25 } }, { plate: "HB-X 1", businessRules: { abroadAllowed: false, abroadCountries: [] } });
  assert.equal(r1.values.deductibleCents, 150000);
  assert.equal(r1.sources.deductibleCents, "GROUP");
  assert.equal(r1.values.petsPolicy, "NOT_ALLOWED");
  assert.equal(r1.sources.petsPolicy, "GROUP");
  assert.equal(r1.values.abroadAllowed, false);
  assert.equal(r1.sources.abroadAllowed, "VEHICLE");
  assert.equal(r1.values.minimumDriverAge, 21, "Mindestalter ist nicht je Gruppe überschreibbar");
  assert.equal(r1.sources.minimumDriverAge, "TENANT");
  assert.equal(r1.values.additionalDriverFeeCents, 1500);
  assert.equal(r1.values.kmPolicy, "FREE_KILOMETERS");
  assert.equal(r1.sources.kmPolicy, "DEFAULT");
  assert.equal(r1.groupName, "Transporter");
  // Fingerabdruck reagiert auf jede Wertänderung
  assert.notEqual(rulesFingerprint(r0.values), rulesFingerprint(r1.values));
  assert.equal(rulesFingerprint(r1.values), rulesFingerprint(resolveRules(tenant, { name: "Transporter", businessRules: { deductibleCents: 150000, petsPolicy: "NOT_ALLOWED" } }, { plate: "HB-X 1", businessRules: { abroadAllowed: false, abroadCountries: [] } }).values));
});

test("Prüfung: keine negativen Geldwerte, gültige Aufzählungen, bekannte Länder, Widersprüche werden benannt", () => {
  assert.throws(() => sanitizeRules({ deductibleCents: -1 }), RuleError);
  assert.throws(() => sanitizeRules({ additionalDriverFeeCents: 10.5 }), RuleError);
  assert.throws(() => sanitizeRules({ kmPolicy: "GRATIS" }), RuleError);
  assert.throws(() => sanitizeRules({ abroadCountries: ["XX"] }), RuleError);
  assert.throws(() => sanitizeRules({ minimumDriverAge: 12 }), RuleError);
  assert.throws(() => sanitizeRules({ fuelMinimumEighths: 9 }), RuleError);
  assert.deepEqual(sanitizeRules({ abroadCountries: ["NL", "AT", "NL"], unknownKey: 1 }), { abroadCountries: ["AT", "NL"] });
  const issues = ruleConsistencyIssues({ ...DEFAULT_BUSINESS_RULES, additionalDriverFeeType: "FLAT", additionalDriverFeeCents: 0, abroadAllowed: true, abroadCountries: [], fuelRule: "MINIMUM_LEVEL", lateReturnRule: "CONFIGURED_FEE", authorityHandlingFeeEnabled: true });
  assert.equal(issues.length, 5);
  assert.equal(ruleConsistencyIssues(DEFAULT_BUSINESS_RULES).length, 0);
});

test("Vertragsanpassung: nur erlaubte Schlüssel, Herkunft „Individuell angepasst“ bei Abweichung, Standardübernahme lässt Anpassungen stehen", () => {
  const resolved = resolveRules({ smokingAllowed: false, petsPolicy: "NOT_ALLOWED", deductibleCents: 50000 }, null, null);
  const initial = initialContractRules(resolved, T("2026-09-23T10:00:00Z"));
  assert.equal(initial.defaultsFingerprint, rulesFingerprint(resolved.values));
  const { rules, changes } = applyContractOverrides(initial, resolved, { smokingAllowed: true, petsPolicy: "NOT_ALLOWED", minimumDriverAge: 30 } as never);
  assert.equal(rules.values.smokingAllowed, true);
  assert.equal(rules.sources.smokingAllowed, "CONTRACT");
  assert.equal(rules.sources.petsPolicy, "TENANT", "gleicher Wert wie Vorgabe bleibt Vorgabe");
  assert.equal(rules.values.minimumDriverAge, 18, "Mindestalter ist im Vertrag nicht änderbar");
  assert.deepEqual(changes.map((c) => c.key), ["smokingAllowed"]);
  // neue Vorgaben
  const newer = resolveRules({ smokingAllowed: false, petsPolicy: "ALLOWED", deductibleCents: 80000 }, null, null);
  assert.notEqual(rules.defaultsFingerprint, rulesFingerprint(newer.values), "neuere Standardwerte erkannt");
  const adopted = adoptDefaults(rules, newer, T("2026-09-24T10:00:00Z"));
  assert.equal(adopted.values.smokingAllowed, true, "individuelle Anpassung bleibt");
  assert.equal(adopted.values.petsPolicy, "ALLOWED", "nicht angepasster Wert folgt der neuen Vorgabe");
  assert.equal(adopted.values.deductibleCents, 80000);
  assert.equal(adopted.defaultsFingerprint, rulesFingerprint(newer.values));
});

test("Grenzen im Vertrag: Ausland nur aus der Freigabeliste, Mindestfüllstand passend zum Antrieb, Zusatzfahrer nur wenn erlaubt", () => {
  const resolved = resolveRules({ abroadAllowed: true, abroadCountries: ["AT", "CH"] }, null, null);
  const base = initialContractRules(resolved);
  const abroad = applyContractOverrides(base, resolved, { abroadAllowed: true, abroadCountries: ["AT", "PL"] }).rules;
  const issues = contractRuleIssues(abroad, resolved, { driveClass: "COMBUSTION", additionalDrivers: 0 });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /Polen ist nicht in der Freigabeliste/);
  const noAbroad = resolveRules({ abroadAllowed: false }, null, null);
  assert.match(contractRuleIssues(applyContractOverrides(initialContractRules(noAbroad), noAbroad, { abroadAllowed: true, abroadCountries: [] }).rules, noAbroad, { driveClass: "COMBUSTION", additionalDrivers: 0 })[0], /nicht vorgesehen/);
  const ev = applyContractOverrides(base, resolved, { fuelRule: "MINIMUM_LEVEL", fuelMinimumEighths: 4, batteryMinimumPercent: null }).rules;
  assert.match(contractRuleIssues(ev, resolved, { driveClass: "ELECTRIC", additionalDrivers: 0 }).join(" "), /Mindestladestand.*Elektrofahrzeug hat keinen Tank|keinen Tank/);
  assert.equal(contractRuleIssues(ev, resolved, { driveClass: "COMBUSTION", additionalDrivers: 0 }).length, 0);
  const phev = applyContractOverrides(base, resolved, { fuelRule: "MINIMUM_LEVEL", fuelMinimumEighths: 4, batteryMinimumPercent: 50 }).rules;
  assert.equal(contractRuleIssues(phev, resolved, { driveClass: "PHEV", additionalDrivers: 0 }).length, 0);
  const noAdd = resolveRules({ additionalDriversAllowed: false }, null, null);
  assert.match(contractRuleIssues(initialContractRules(noAdd), noAdd, { driveClass: "COMBUSTION", additionalDrivers: 1 })[0], /keine Zusatzfahrer/);
  assert.match(contractRuleIssues(applyContractOverrides(base, resolved, { kmPolicy: "INDIVIDUAL" }).rules, resolved, { driveClass: "COMBUSTION", additionalDrivers: 0 })[0], /Kilometerregel beschreiben/);
});

test("Zusatzfahrer-Preis: kostenlos, pauschal, je Tag – eigene Position, nie im Basispreis", () => {
  assert.equal(additionalDriverFee({ additionalDriverFeeType: "FREE", additionalDriverFeeCents: 0 }, 2, 6), null);
  assert.equal(additionalDriverFee({ additionalDriverFeeType: "FLAT", additionalDriverFeeCents: 1500 }, 0, 6), null);
  assert.deepEqual(additionalDriverFee({ additionalDriverFeeType: "FLAT", additionalDriverFeeCents: 1500 }, 2, 6), { quantity: 2, unitCents: 1500, amountCents: 3000, label: "Zusatzfahrer (pauschal)" });
  assert.deepEqual(additionalDriverFee({ additionalDriverFeeType: "PER_DAY", additionalDriverFeeCents: 500 }, 2, 6), { quantity: 12, unitCents: 500, amountCents: 6000, label: "Zusatzfahrer (2 × 6 Tage)" });
});

test("Mindestalter kalendergenau (Europe/Berlin): exakt 18, 17 Jahre 364 Tage, Geburtstag am Mietbeginn, 29. Februar, Führerscheinmonate", () => {
  const birth = T("2008-03-15T00:00:00Z");
  assert.equal(ageAt(birth, T("2026-03-15T00:00:00Z")), 18, "am 18. Geburtstag ab 00:00 Uhr Berlin (01:00 MEZ)");
  assert.equal(ageAt(birth, T("2026-03-14T22:59:00Z")), 17, "23:59 Berlin am Vortag: noch 17");
  assert.equal(ageAt(birth, T("2026-03-14T23:00:00Z")), 18, "00:00 Berlin am Geburtstag: 18");
  assert.equal(ageAt(birth, T("2026-03-14T12:00:00Z")), 17, "17 Jahre 364 Tage");
  // Schaltjahr: geboren 29.02.2008 → 2026 kein Schaltjahr → 18 ab 1. März (§ 188 Abs. 3 BGB)
  const leap = T("2008-02-29T00:00:00Z");
  assert.equal(ageAt(leap, T("2026-02-28T12:00:00Z")), 17);
  assert.equal(ageAt(leap, T("2026-03-01T12:00:00Z")), 18);
  assert.equal(ageAt(leap, T("2028-02-29T12:00:00Z")), 20, "im Schaltjahr am 29. Februar selbst");
  assert.equal(ageAt(leap, T("2028-02-28T12:00:00Z")), 19);
  assert.equal(monthsSince(T("2026-01-31T00:00:00Z"), T("2026-02-28T12:00:00Z")), 0);
  assert.equal(monthsSince(T("2026-01-31T00:00:00Z"), T("2026-03-31T12:00:00Z")), 2);
  assert.equal(monthsSince(T("2024-06-01T00:00:00Z"), T("2026-06-01T12:00:00Z")), 24);
});

test("Markdown-Teilmenge: Überschriften, Absätze, Listen, fett; kein HTML; deterministisch", () => {
  const src = "# Titel\n\nErster **fetter** Absatz\nmit Umbruch.\n\n- Punkt eins\n- Punkt **zwei**\n\n1. Erstens\n2. Zweitens\n\n## Abschnitt\nText direkt darunter.";
  const blocks = parseTerms(src);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "list", "list", "heading", "paragraph"]);
  assert.deepEqual(blocks[1], { type: "paragraph", runs: [{ text: "Erster ", bold: false }, { text: "fetter", bold: true }, { text: " Absatz mit Umbruch.", bold: false }] });
  assert.equal((blocks[2] as { ordered: boolean }).ordered, false);
  assert.equal((blocks[3] as { ordered: boolean }).ordered, true);
  assert.deepEqual(parseTerms(src), blocks, "gleiche Eingabe, gleiche Blöcke");
  assert.equal(parseTerms("Text mit ** unpaarig").length, 1);
  assert.equal((parseTerms("Text mit ** unpaarig")[0] as { runs: { text: string }[] }).runs.map((r) => r.text).join(""), "Text mit ** unpaarig");
  assert.match(termsPlainText(blocks), /• Punkt eins/);
  assert.match(validateTermsSource("<script>alert(1)</script> Bedingungen hier lang genug") ?? "", /HTML/);
  assert.equal(validateTermsSource("Das Fahrzeug ist pfleglich zu behandeln."), null);
  assert.ok(parseTerms(TERMS_STRUCTURE_TEMPLATE).filter((b) => b.type === "heading").length >= 20);
});

test("Versionsbezeichnungen: 1.0 zuerst, Nebenversion + 1 aus der Quelle, keine Wiederverwendung", () => {
  assert.equal(proposeLabel([], null), "1.0");
  assert.equal(proposeLabel(["1.0"], "1.0"), "1.1");
  assert.equal(proposeLabel(["1.0", "1.1", "1.2"], "1.0"), "1.3", "belegte Labels werden übersprungen");
  assert.equal(proposeLabel(["2.0", "1.9"], null), "2.1");
  assert.equal(proposeLabel(["Herbst"], null), "1.0");
});
