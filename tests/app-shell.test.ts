// Befehl 29.2: App-Shell & Navigation – zentrale Navigationskonfiguration (gleiche Routen wie vorher, nur gruppiert),
// Ausblenden gesperrter Module, aktive Markierung, Schnellaktionen je Rolle/Supportmodus, Datum/KW in Berlin und
// die Verdrahtung im Layout (eine Seitenleiste, Suche und Schnellaktionen nur in der Kopfleiste, keine Doppelungen).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  NAV_GROUPS, NAV_ITEMS, NAV_SYSTEM, activeNavHref, initialsOf, isoWeekBerlin, quickActionsFor, todayLabelBerlin, visibleNavGroups, visibleSystemItems,
} from "../src/lib/navigation";
import { FEATURES, FEATURE_KEYS } from "../src/lib/constants";

const src = (p: string) => readFile(path.join(process.cwd(), p), "utf8");

// Stand vor Befehl 29.2 (sidebar.tsx, NAV): genau diese 13 Routen – keine entfernt, keine neu, keine verändert
const BEFORE = ["/heute", "/dispo", "/fahrzeuge", "/fahrzeuge/wartung", "/kunden", "/buchungen", "/unfallersatz", "/rechnungen", "/forderungen", "/auszahlungen", "/schaeden", "/behoerden", "/einstellungen"];

test("Navigation: dieselben 13 Routen wie vorher, jede genau einmal, in Gruppen", () => {
  const hrefs = NAV_ITEMS.map((i) => i.href);
  assert.deepEqual([...hrefs].sort(), [...BEFORE].sort());
  assert.equal(new Set(hrefs).size, hrefs.length, "kein Menüpunkt doppelt");
  assert.deepEqual(NAV_GROUPS.map((g) => g.label), [null, "Vermietung", "Flotte", "Finanzen", "Fälle"]);
  assert.deepEqual(NAV_GROUPS.find((g) => g.key === "vermietung")!.items.map((i) => i.href), ["/buchungen", "/dispo", "/kunden"]);
  assert.deepEqual(NAV_GROUPS.find((g) => g.key === "flotte")!.items.map((i) => i.href), ["/fahrzeuge", "/fahrzeuge/wartung"]);
  assert.deepEqual(NAV_GROUPS.find((g) => g.key === "finanzen")!.items.map((i) => i.href), ["/rechnungen", "/forderungen", "/auszahlungen"]);
  assert.deepEqual(NAV_GROUPS.find((g) => g.key === "faelle")!.items.map((i) => i.href), ["/schaeden", "/unfallersatz", "/behoerden"]);
  assert.deepEqual(NAV_SYSTEM.map((i) => i.href), ["/einstellungen"]);
  // Bezeichnungen wie bisher
  const label = Object.fromEntries(NAV_ITEMS.map((i) => [i.href, i.label]));
  assert.deepEqual(label, { "/heute": "Heute", "/dispo": "Dispo-Kalender", "/fahrzeuge": "Fahrzeuge", "/fahrzeuge/wartung": "Wartung", "/kunden": "Kunden", "/buchungen": "Buchungen", "/unfallersatz": "Unfallersatz", "/rechnungen": "Rechnungen", "/forderungen": "Forderungen", "/auszahlungen": "Auszahlungen", "/schaeden": "Schäden", "/behoerden": "Behörden", "/einstellungen": "Einstellungen" });
  // Jedes Symbol nur einmal (vorher dreimal dasselbe Euro-Zeichen)
  assert.equal(new Set(NAV_ITEMS.map((i) => i.icon)).size, NAV_ITEMS.length);
});

test("Navigation: jeder Feature-Pfad (Control Center) ist ein Menüpunkt; gesperrte Module verschwinden, leere Gruppen ganz", () => {
  const hrefs = new Set(NAV_ITEMS.map((i) => i.href));
  for (const k of FEATURE_KEYS) for (const p of FEATURES[k].nav) assert.ok(hrefs.has(p), `${k}: ${p} muss ein Menüpunkt sein`);
  const g = visibleNavGroups(["/unfallersatz", "/behoerden"]);
  const visible = g.flatMap((x) => x.items.map((i) => i.href));
  assert.ok(!visible.includes("/unfallersatz") && !visible.includes("/behoerden") && visible.includes("/schaeden"));
  const noCases = visibleNavGroups(["/schaeden", "/unfallersatz", "/behoerden"]);
  assert.ok(!noCases.some((x) => x.key === "faelle"), "Gruppe „Fälle“ ohne Einträge entfällt samt Überschrift");
  assert.deepEqual(visibleSystemItems([]).map((i) => i.href), ["/einstellungen"]);
  assert.equal(visibleNavGroups().flatMap((x) => x.items).length, NAV_ITEMS.length - NAV_SYSTEM.length);
});

test("Navigation: aktiver Menüpunkt = längster passender Pfad (wie bisher), ohne Treffer keiner", () => {
  const all = NAV_ITEMS;
  assert.equal(activeNavHref("/heute", all), "/heute");
  assert.equal(activeNavHref("/fahrzeuge/wartung", all), "/fahrzeuge/wartung");
  assert.equal(activeNavHref("/fahrzeuge/wartung/abc", all), "/fahrzeuge/wartung");
  assert.equal(activeNavHref("/fahrzeuge/gruppen", all), "/fahrzeuge");
  assert.equal(activeNavHref("/fahrzeuge/abc", all), "/fahrzeuge");
  assert.equal(activeNavHref("/einstellungen/tarife/neu", all), "/einstellungen");
  assert.equal(activeNavHref("/buchungen/abc/rechnung", all), "/buchungen");
  assert.equal(activeNavHref("/behoerden/einstellungen", all), "/behoerden");
  assert.equal(activeNavHref("/suche", all), null);
  assert.equal(activeNavHref("/einrichtung", all), null);
  assert.equal(activeNavHref("/fahrzeugexport", all), null, "nur ganze Pfadsegmente zählen");
  // Wartung gesperrt: wie bisher greift dann der kürzere Eintrag
  assert.equal(activeNavHref("/fahrzeuge/wartung", all.filter((i) => i.href !== "/fahrzeuge/wartung")), "/fahrzeuge");
});

test("Schnellaktionen: gleiche Regeln wie vorher – Buchung nur mit Anlegerecht, Kunde für alle Rollen, Supportmodus keine", async () => {
  assert.deepEqual(quickActionsFor("OWNER", false), { booking: true, customer: true });
  assert.deepEqual(quickActionsFor("DISPO", false), { booking: true, customer: true });
  assert.deepEqual(quickActionsFor("YARD", false), { booking: false, customer: true });
  assert.deepEqual(quickActionsFor("OWNER", true), { booking: false, customer: false });
  assert.deepEqual(quickActionsFor("YARD", true), { booking: false, customer: false });
  // … passend zu den serverseitigen Prüfungen der Zielseiten
  assert.match(await src("src/app/(app)/buchungen/neu/page.tsx"), /requireRole\("DISPO"\)/);
  assert.match(await src("src/app/(app)/kunden/neu/page.tsx"), /requireRole\("DISPO", ?"YARD"\)/);
});

test("Kopfleiste: Datum und Kalenderwoche nach Berliner Datum (nicht Serverzeit)", () => {
  assert.equal(todayLabelBerlin(new Date("2026-10-07T10:00:00Z")), "Mittwoch, 7. Oktober");
  assert.equal(isoWeekBerlin(new Date("2026-10-07T10:00:00Z")), 41);
  // Sonntag 4.10. 22:30 UTC = Montag 5.10. 00:30 in Berlin → schon KW 41
  assert.equal(isoWeekBerlin(new Date("2026-10-04T22:30:00Z")), 41);
  assert.equal(todayLabelBerlin(new Date("2026-10-04T22:30:00Z")), "Montag, 5. Oktober");
  assert.equal(isoWeekBerlin(new Date("2026-01-01T12:00:00Z")), 1);
  assert.equal(isoWeekBerlin(new Date("2027-01-01T12:00:00Z")), 53);
  assert.equal(isoWeekBerlin(new Date("2026-12-31T23:30:00Z")), 53, "Silvester 23:30 UTC ist in Berlin schon der 1.1.2027 (KW 53)");
  assert.equal(isoWeekBerlin(new Date("2027-01-04T12:00:00Z")), 1);
});

test("Kontobereich: Initialen", () => {
  assert.equal(initialsOf("Sezer Karakuş"), "SK");
  assert.equal(initialsOf("  anna   maria müller "), "AM");
  assert.equal(initialsOf("Disponent"), "D");
  assert.equal(initialsOf(""), "?");
});

test("Verdrahtung: eine Seitenleiste, Suche und Schnellaktionen nur in der Kopfleiste, Rollenregeln aus quickActionsFor", async () => {
  const layout = await src("src/app/(app)/layout.tsx");
  assert.match(layout, /quickActionsFor\(user\.role, !!supportSession\)/);
  assert.match(layout, /hiddenNavPaths\(await tenantFeatures\(tenant\.id\)\)/);
  assert.match(layout, /navBadges\(tenant\.id, hiddenPaths\)/);
  assert.ok(!layout.includes("@/components/sidebar"), "alte Seitenleiste nicht mehr eingebunden");
  const shell = await src("src/components/app-shell.tsx");
  assert.equal(shell.match(/useGlobalSearchShortcut\(/g)?.length, 1, "Strg+K genau einmal (sonst zwei Suchdialoge)");
  assert.equal(shell.match(/<SearchDialog /g)?.length, 1);
  assert.equal(shell.match(/<AppSidebar/g)?.length, 1, "ein einziges <aside> für alle Breiten");
  const sidebar = await src("src/components/app-sidebar.tsx");
  assert.ok(!sidebar.includes("/buchungen/neu") && !sidebar.includes("/kunden/neu") && !sidebar.includes("SearchDialog"), "Seitenleiste ohne Schnellaktionen und ohne Suche");
  assert.match(sidebar, /aria-current=\{on \? "page" : undefined\}/);
  const header = await src("src/components/app-header.tsx");
  assert.match(header, /\{quick\.booking && <Link href="\/buchungen\/neu"/);
  assert.match(header, /\{quick\.customer && <Link href="\/kunden\/neu"/);
  // Doppelungen in den Seitenköpfen entfernt (gleiche Ziele stehen jetzt in der Kopfleiste)
  const heute = await src("src/app/(app)/heute/page.tsx");
  assert.ok(!heute.includes('href="/buchungen/neu"') && !heute.includes('href="/kunden/neu"') && !heute.includes("OpenSearchButton"));
  assert.ok(!(await src("src/app/(app)/buchungen/page.tsx")).match(/PageHeader[\s\S]{0,900}href="\/buchungen\/neu" className="btn btn-primary">\+ Neue Buchung/));
  assert.ok(!(await src("src/app/(app)/dispo/page.tsx")).includes('<Link href="/buchungen/neu" className="btn btn-primary">+ Neue Buchung</Link>'));
  assert.ok(!(await src("src/app/(app)/kunden/page.tsx")).includes('<Link href="/kunden/neu" className="btn btn-primary">+ Kunde</Link>'));
});
