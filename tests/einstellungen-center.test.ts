// Befehl 29.3.1: Einstellungscenter – Kategorienavigation je Rolle, aktive Markierung, keine funktionslosen Links,
// erhaltene Deep Links und unveränderte serverseitige Prüfungen. Reine Prüfung von Konfiguration und Quelltext.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { activeSettings, settingsHrefs, settingsNav } from "../src/lib/settings-nav";

const root = path.join(process.cwd(), "src/app/(app)");
const pageFor = (href: string) => path.join(root, ...href.split("/").filter(Boolean), "page.tsx");
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const labels = (g: ReturnType<typeof settingsNav>) => g.flatMap((x) => x.items.map((i) => i.label));

test("Navigation je Rolle: Inhaber und Disponent sehen alle Kategorien, Hof und Supportmodus keinen E-Mail-Versand", () => {
  const all = ["Unternehmen", "Mitarbeiter & Berechtigungen", "Verträge & Dokumente", "Miettarife", "Rechnungen & Belege", "E-Mail & Versand"];
  assert.deepEqual(labels(settingsNav({ role: "OWNER", supportSession: false, smtpFeature: true })), all);
  assert.deepEqual(labels(settingsNav({ role: "DISPO", supportSession: false, smtpFeature: true })), all);
  const yard = settingsNav({ role: "YARD", supportSession: false, smtpFeature: true });
  assert.deepEqual(labels(yard), all.slice(0, 5));
  assert.ok(!yard.some((g) => g.key === "kommunikation"), "leere Gruppe entfällt ganz");
  assert.deepEqual(labels(settingsNav({ role: "OWNER", supportSession: true, smtpFeature: true })), all.slice(0, 5), "Supportmodus: E-Mail-Seite leitet um, also kein Eintrag");
  assert.deepEqual(labels(settingsNav({ role: "OWNER", supportSession: false, smtpFeature: false })), all.slice(0, 5), "Modul nicht freigeschaltet");
  assert.deepEqual(settingsNav({ role: "OWNER", supportSession: false, smtpFeature: true }).map((g) => g.label), ["Allgemein", "Vermietung", "Finanzen", "Kommunikation"]);
});

test("keine funktionslosen Links: jedes Ziel der Navigation ist eine vorhandene Seite", () => {
  const hrefs = settingsHrefs(settingsNav({ role: "OWNER", supportSession: false, smtpFeature: true }));
  assert.ok(hrefs.length >= 9, hrefs.join(","));
  for (const h of hrefs) assert.ok(existsSync(pageFor(h)), `${h}: Seite fehlt`);
});

test("bestehende Routen und Deep Links bleiben erhalten (keine Umbenennung)", () => {
  for (const h of ["/einstellungen", "/einstellungen/mietbedingungen", "/einstellungen/mietbedingungen/[id]", "/einstellungen/geschaeftsregeln", "/einstellungen/tarife", "/einstellungen/tarife/neu", "/einstellungen/tarife/[id]", "/einstellungen/nummernkreise", "/einstellungen/e-mail"]) {
    assert.ok(existsSync(pageFor(h)), `${h} besteht`);
  }
  // interne Links, die die Rechnungsdaten meinen, zeigen auf die neue Kategorie
  assert.match(read("src/app/(app)/einrichtung/setup-check.ts"), /key: "rechnung"[^}]*href: "\/einstellungen\/rechnungen"/);
  assert.match(read("src/app/(app)/buchungen/[id]/rechnung/page.tsx"), /href="\/einstellungen\/rechnungen"/);
});

test("aktive Kategorie und Unterpunkt: längster passender Pfad", () => {
  const g = settingsNav({ role: "OWNER", supportSession: false, smtpFeature: true });
  const at = (p: string) => { const a = activeSettings(p, g); return `${a.item?.label ?? "–"} / ${a.child ?? "–"}`; };
  assert.equal(at("/einstellungen"), "Unternehmen / –");
  assert.equal(at("/einstellungen/mitarbeiter"), "Mitarbeiter & Berechtigungen / –");
  assert.equal(at("/einstellungen/vertraege"), "Verträge & Dokumente / –");
  assert.equal(at("/einstellungen/mietbedingungen/abc"), "Verträge & Dokumente / /einstellungen/mietbedingungen");
  assert.equal(at("/einstellungen/geschaeftsregeln"), "Verträge & Dokumente / /einstellungen/geschaeftsregeln");
  assert.equal(at("/einstellungen/tarife/neu"), "Miettarife / –");
  assert.equal(at("/einstellungen/rechnungen"), "Rechnungen & Belege / /einstellungen/rechnungen");
  assert.equal(at("/einstellungen/nummernkreise"), "Rechnungen & Belege / /einstellungen/nummernkreise");
  assert.equal(at("/einstellungen/e-mail"), "E-Mail & Versand / –");
  assert.equal(at("/einstellungen-x"), "– / –", "kein Präfix-Fehltreffer");
});

test("serverseitige Prüfung auf jeder Einstellungsseite; das Layout ersetzt keine Prüfung", () => {
  const dir = path.join(root, "einstellungen");
  const pages: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === "page.tsx") pages.push(p); } };
  walk(dir);
  assert.ok(pages.length >= 12, String(pages.length));
  for (const p of pages) assert.match(readFileSync(p, "utf8"), /require(Session|Role)\(/, `${path.relative(process.cwd(), p)}: Sitzung/Rolle geprüft`);
  assert.match(read("src/app/(app)/einstellungen/layout.tsx"), /requireSession\(\)/);
  // Bearbeiten nur Inhaber außerhalb des Supportmodus (Darstellung); die Actions prüfen zusätzlich requireRole("OWNER")
  for (const f of ["page.tsx", "mitarbeiter/page.tsx", "rechnungen/page.tsx"]) assert.match(read(`src/app/(app)/einstellungen/${f}`), /role === "OWNER" && !supportSession/, f);
});

test("Speicherlogik unverändert: alle Einstellungs-Actions verlangen den Inhaber, Formulare senden per POST", () => {
  const actions = read("src/app/(app)/einstellungen/actions.ts");
  const fns = [...actions.matchAll(/export async function (\w+)[\s\S]*?\n}/g)];
  assert.equal(fns.length, 7);
  for (const m of fns) assert.match(m[0], /requireRole\("OWNER"\)/, `${m[1]}: nur Inhaber`);
  assert.match(read("src/app/(app)/einstellungen/geschaeftsregeln/actions.ts"), /export async function updateDunningSettingsAction[\s\S]*?requireRole\("OWNER"\)/, "Mahnwesen weiterhin nur Inhaber");
  // Formulare mit action={formAction} (kein GET-Absenden vor der Hydrierung)
  const forms = read("src/app/(app)/einstellungen/forms.tsx");
  assert.equal([...forms.matchAll(/<form /g)].length, [...forms.matchAll(/<form ref=\{ref\} action=\{formAction\}/g)].length);
  // Rechnungen & Belege nutzt dieselben Formulare und Actions wie bisher (keine zweite Speicherlogik)
  const inv = read("src/app/(app)/einstellungen/rechnungen/page.tsx");
  assert.match(inv, /InvoiceSettingsForm/);
  assert.match(inv, /DunningSettingsForm action=\{updateDunningSettingsAction\}/);
  assert.ok(!/db\.(tenant|user)\.(update|create|delete)/.test(inv + read("src/app/(app)/einstellungen/vertraege/page.tsx") + read("src/app/(app)/einstellungen/mitarbeiter/page.tsx")), "neue Seiten schreiben nicht");
  // Mahnwesen-Formular steht nur noch unter „Rechnungen & Belege“
  assert.ok(!/DunningSettingsForm/.test(read("src/app/(app)/einstellungen/geschaeftsregeln/page.tsx")));
});

test("Hinweis auf ungespeicherte Änderungen: Formular-Fußleiste mit Verwerfen und Warnung beim Verlassen", () => {
  const f = read("src/app/(app)/einstellungen/form-footer.tsx");
  assert.match(f, /addEventListener\("beforeunload"/);
  assert.match(f, /addEventListener\("reset"/, "Zurücksetzen (Verwerfen oder nach der Server Action) beendet den Hinweis");
  assert.match(f, /Ungespeicherte Änderungen/);
  for (const n of ["TenantForm", "InvoiceSettingsForm", "InviteUserForm"]) assert.match(read("src/app/(app)/einstellungen/forms.tsx"), new RegExp(`export function ${n}[\\s\\S]*?useDirtyForm\\(\\)[\\s\\S]*?<FormFooter`), n);
  assert.match(read("src/app/(app)/einstellungen/geschaeftsregeln/rules-forms.tsx"), /export function DunningSettingsForm[\s\S]*?useDirtyForm\(\)[\s\S]*?<FormFooter/);
});
