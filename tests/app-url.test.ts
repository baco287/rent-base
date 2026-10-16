// Links in E-Mails (Einladung, Passwort-Reset, Rückgabe) dürfen nur aus der geprüften APP_URL entstehen,
// nie aus Host- oder X-Forwarded-Host-Headern der Anfrage (Host-Header-Injection bei Reset-Links).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AppUrlError, DEV_APP_URL, appBaseUrl, appUrlStatus } from "../src/lib/app-url";
import { DomainError } from "../src/lib/integrity";

const prod = (APP_URL?: string) => ({ NODE_ENV: "production", ...(APP_URL === undefined ? {} : { APP_URL }) }) as NodeJS.ProcessEnv;
const dev = (APP_URL?: string) => ({ NODE_ENV: "development", ...(APP_URL === undefined ? {} : { APP_URL }) }) as NodeJS.ProcessEnv;

test("APP_URL: gültige Adresse wird auf den Ursprung normalisiert", () => {
  assert.equal(appBaseUrl(prod("https://app.rent-base.de")), "https://app.rent-base.de");
  assert.equal(appBaseUrl(prod("https://app.rent-base.de/")), "https://app.rent-base.de");
  assert.equal(appBaseUrl(prod("  https://APP.rent-base.de:8443  ")), "https://app.rent-base.de:8443");
});

test("APP_URL: in Produktion Pflicht, nur https, ohne Pfad, Parameter, Anker oder Zugangsdaten", () => {
  const rejects = (value: string | undefined, pattern: RegExp) => assert.throws(() => appBaseUrl(prod(value)), (e: unknown) => e instanceof AppUrlError && e instanceof DomainError && pattern.test((e as Error).message));
  rejects(undefined, /nicht gesetzt/);
  rejects("", /nicht gesetzt/);
  rejects("app.rent-base.de", /keine gültige Adresse/);
  rejects("http://app.rent-base.de", /https:\/\//);
  rejects("javascript:alert(1)", /https:\/\//);
  rejects("https://app.rent-base.de/pfad", /ohne Pfad/);
  rejects("https://app.rent-base.de/?x=1", /ohne Pfad/);
  rejects("https://app.rent-base.de/#a", /ohne Pfad/);
  rejects("https://nutzer:geheim@app.rent-base.de", /Zugangsdaten/);
});

test("APP_URL: lokal ohne Wert gilt localhost, http ist lokal erlaubt", () => {
  assert.equal(appBaseUrl(dev()), DEV_APP_URL);
  assert.equal(appBaseUrl(dev("http://localhost:3001")), "http://localhost:3001");
  assert.throws(() => appBaseUrl(dev("ftp://localhost")), AppUrlError);
});

test("Status für die Systemseite verrät den Wert nicht", () => {
  assert.deepEqual(appUrlStatus(prod("https://app.rent-base.de")), { ok: true, message: "gültig" });
  const bad = appUrlStatus(prod("http://geheim.example"));
  assert.equal(bad.ok, false);
  assert.ok(!bad.message.includes("geheim.example"));
  assert.equal(appUrlStatus(prod()).ok, false);
});

test("kein Code baut Links aus Host- oder X-Forwarded-Host-Headern", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(path.join(__dirname, "..", "src"));
  // Nur Header-Zugriffe im Code, nicht Erwähnungen in Kommentaren
  const offenders = files.filter((f) => /["'`]x-forwarded-host["'`]|\.get\(\s*["'`]host["'`]\s*\)/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});
