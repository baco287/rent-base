// Prüft den echten SMTP-Treiber gegen einen lokalen Testserver auf 127.0.0.1. Es verlässt nichts den Rechner.
// Der Testserver verwendet ein selbst signiertes Zertifikat; nur in diesem Testprozess wird es akzeptiert.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";
import { getMailTransport, safeMailError } from "../src/lib/mail";
import { sha256 } from "../src/lib/integrity";

const received: ParsedMail[] = [];
let server: SMTPServer;
let port = 0;

before(async () => {
  server = new SMTPServer({
    authOptional: false,
    onAuth(auth, _session, cb) {
      if (auth.username === "postfach" && auth.password === "richtig") return cb(null, { user: "postfach" });
      return cb(Object.assign(new Error("Invalid login"), { responseCode: 535 }));
    },
    onData(stream, _session, cb) {
      simpleParser(stream).then((mail) => { received.push(mail); cb(); }, cb);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const env = (over: Record<string, string> = {}) => ({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_USER: "postfach", SMTP_PASSWORD: "richtig", SMTP_FROM_EMAIL: "unterlagen@rent-base.example", SMTP_FROM_NAME: "Rent-Base", ...over }) as unknown as NodeJS.ProcessEnv;
const message = () => ({
  to: "erika@example.test",
  subject: "Ihre Mietunterlagen – MV-2026-0001",
  text: "Guten Tag Erika Muster,\nanbei Ihre Unterlagen.",
  html: "<p>Guten Tag Erika Muster,</p>",
  fromName: "JetRent Autovermietung",
  replyTo: "info@jetrent.example",
  attachments: [
    { filename: "Mietvertrag_MV-2026-0001.pdf", content: new TextEncoder().encode("%PDF-1.7 vertrag"), contentType: "application/pdf" },
    { filename: "Uebergabe_MV-2026-0001_HB-RT-200.pdf", content: new TextEncoder().encode("%PDF-1.7 uebergabe"), contentType: "application/pdf" },
  ],
});

test("SMTP: Anmeldung, verschlüsselte Verbindung, Absender, Antwortadresse und beide Anhänge kommen unverändert an", async () => {
  const m = message();
  const res = await getMailTransport(env()).send(m);
  assert.ok(res.messageId);
  assert.equal(received.length, 1);
  const mail = received[0];
  assert.equal(mail.subject, m.subject);
  assert.equal(mail.from?.value[0].address, "unterlagen@rent-base.example");
  assert.equal(mail.from?.value[0].name, "JetRent Autovermietung", "Absendername ist die Vermietung");
  assert.equal(mail.replyTo?.value[0].address, "info@jetrent.example");
  assert.deepEqual(mail.attachments.map((a) => [a.filename, a.contentType, sha256(a.content)]), m.attachments.map((a) => [a.filename, "application/pdf", sha256(a.content)]));
  assert.ok(mail.text?.includes("Guten Tag Erika Muster"));
});

test("SMTP: falsches Passwort und nicht erreichbarer Server ergeben kurze Meldungen ohne Zugangsdaten", async () => {
  const wrong = await getMailTransport(env({ SMTP_PASSWORD: "falsch-und-geheim" })).send(message()).then(() => null, (e) => e);
  assert.ok(wrong);
  assert.equal(safeMailError(wrong), "SMTP-Anmeldung wurde abgelehnt");
  const down = await getMailTransport(env({ SMTP_PORT: "1" })).send(message()).then(() => null, (e) => e);
  assert.ok(down);
  assert.equal(safeMailError(down), "SMTP-Verbindung fehlgeschlagen");
  for (const e of [wrong, down]) assert.ok(!safeMailError(e).includes("geheim") && !safeMailError(e).includes("postfach"));
  assert.equal(received.length, 1, "bei Fehlern kommt nichts an");
});
