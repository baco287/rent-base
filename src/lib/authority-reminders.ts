// Tägliche Fristen-Erinnerung für Behördenvorgänge: eine E-Mail je Empfänger und Tag mit allen offenen Vorgängen, deren
// Antwortfrist überschritten ist, heute endet oder innerhalb der eingestellten Tage endet. Idempotent über das
// E-Mail-Protokoll (ein Schlüssel je Mandant, Tag und Empfänger) – auch bei mehrfachem Aufruf oder Neustart nur einmal.
// Die Erinnerung ändert nichts am Vorgang.

import { db } from "@/lib/db";
import { AUTHORITY_OPEN_STATUS, offenseText } from "@/lib/authority";
import { deadlineInfo } from "@/lib/authority-matching";
import { AUTHORITY_CASE_STATUS, type AuthorityCaseStatus } from "@/lib/constants";
import { claimEmail, markEmailFailed, markEmailSent } from "@/lib/email-log";
import { getMailTransport, isValidEmail, safeMailError, type MailTransport } from "@/lib/mail";
import { APP_TIME_ZONE, toDateInputValue, zonedDayStartPlus, zonedParts } from "@/lib/time";

export const AUTHORITY_REMINDER_TEMPLATE = "AUTHORITY_DEADLINES";
/** frühestens ab dieser Stunde (Europe/Berlin) wird die Tageserinnerung versendet */
export const REMINDER_HOUR = 7;

const appUrl = () => (process.env.APP_URL?.trim() || "https://app.rent-base.de").replace(/\/+$/, "");
const fmtDate = (d: Date) => d.toLocaleDateString("de-DE", { timeZone: APP_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" });

export type DigestRow = { id: string; caseNumber: string; authorityName: string; authorityReference: string; plate: string; deadline: Date; level: "OVERDUE" | "DUE" | "SOON"; text: string; status: string; offense: string };

/** Offene Vorgänge mit Frist bis einschließlich heute + `days` (Berliner Kalendertage). */
export async function deadlineDigest(tenantId: string, days: number, now = new Date()): Promise<DigestRow[]> {
  const until = zonedDayStartPlus(now, days + 1);
  const rows = await db.authorityCase.findMany({
    where: { tenantId, status: { in: AUTHORITY_OPEN_STATUS }, responseDeadline: { lt: until } },
    orderBy: [{ responseDeadline: "asc" }, { caseNumber: "asc" }],
    take: 100,
    select: { id: true, caseNumber: true, authorityName: true, authorityReference: true, licensePlateSnapshot: true, responseDeadline: true, status: true, offenseAt: true, offenseTimeKnown: true },
  });
  return rows.map((r) => {
    const dl = deadlineInfo(r.responseDeadline, now);
    const level = dl.level === "OVERDUE" ? "OVERDUE" : dl.level === "DUE" ? "DUE" : "SOON";
    return { id: r.id, caseNumber: r.caseNumber, authorityName: r.authorityName, authorityReference: r.authorityReference, plate: r.licensePlateSnapshot, deadline: r.responseDeadline!, level, text: dl.text, status: AUTHORITY_CASE_STATUS[r.status as AuthorityCaseStatus] ?? r.status, offense: offenseText(r.offenseAt, r.offenseTimeKnown) };
  });
}

/** Empfänger: eingestellte Adresse, sonst alle aktiven Inhaber und Disponenten. */
export async function reminderRecipients(tenantId: string): Promise<string[]> {
  const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { authorityReminderEmail: true } });
  if (t.authorityReminderEmail && isValidEmail(t.authorityReminderEmail)) return [t.authorityReminderEmail.trim().toLowerCase()];
  const users = await db.user.findMany({ where: { tenantId, active: true, role: { in: ["OWNER", "DISPO"] } }, select: { email: true } });
  return [...new Set(users.map((u) => u.email.trim().toLowerCase()).filter((e) => isValidEmail(e)))];
}

export function composeDigest(tenantName: string, rows: DigestRow[], day: string) {
  const overdue = rows.filter((r) => r.level === "OVERDUE").length;
  const today = rows.filter((r) => r.level === "DUE").length;
  const subject = `Behördenfristen ${day}: ${[overdue ? `${overdue} überfällig` : null, today ? `${today} heute` : null, `${rows.length} offen`].filter(Boolean).join(", ")}`;
  const lines = rows.map((r) => `• ${r.caseNumber} · ${r.plate} · ${r.authorityName} (Az. ${r.authorityReference}) – Frist ${fmtDate(r.deadline)}, ${r.text} – ${r.status}\n  ${appUrl()}/behoerden/${r.id}`);
  const text = [`Guten Morgen,`, ``, `für ${tenantName} stehen folgende Antworten an Behörden an:`, ``, ...lines, ``, `Alle Vorgänge: ${appUrl()}/behoerden?filter=ueberfaellig`, ``, `Diese Erinnerung versendet Rent-Base einmal täglich. Einstellen oder abschalten unter ${appUrl()}/behoerden/einstellungen.`].join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const color = (l: DigestRow["level"]) => (l === "OVERDUE" ? "#b42318" : l === "DUE" ? "#b54708" : "#344054");
  const html = `<p>Guten Morgen,</p><p>für ${esc(tenantName)} stehen folgende Antworten an Behörden an:</p><ul>${rows.map((r) => `<li style="margin-bottom:6px"><a href="${appUrl()}/behoerden/${r.id}">${esc(r.caseNumber)}</a> · ${esc(r.plate)} · ${esc(r.authorityName)} (Az. ${esc(r.authorityReference)})<br><span style="color:${color(r.level)}">Frist ${fmtDate(r.deadline)}, ${esc(r.text)}</span> – ${esc(r.status)}</li>`).join("")}</ul><p style="color:#667085;font-size:12px">Diese Erinnerung versendet Rent-Base einmal täglich. <a href="${appUrl()}/behoerden/einstellungen">Einstellungen</a></p>`;
  return { subject, text, html };
}

export type ReminderOutcome = { tenantId: string; recipient: string | null; status: "SENT" | "FAILED" | "ALREADY" | "NOTHING_DUE" | "NO_RECIPIENT"; count: number };

/** Versendet die Tageserinnerung für einen Mandanten (oder alle mit aktivierter Erinnerung). */
export async function sendAuthorityReminders(opts: { now?: Date; transport?: MailTransport; tenantId?: string } = {}): Promise<ReminderOutcome[]> {
  const now = opts.now ?? new Date();
  const day = toDateInputValue(now);
  const tenants = await db.tenant.findMany({ where: { authorityReminderDays: { gt: 0 }, status: { not: "SUSPENDED" }, ...(opts.tenantId ? { id: opts.tenantId } : {}) }, select: { id: true, name: true, authorityReminderDays: true, email: true } });
  const out: ReminderOutcome[] = [];
  for (const t of tenants) {
    const rows = await deadlineDigest(t.id, t.authorityReminderDays, now);
    if (rows.length === 0) { out.push({ tenantId: t.id, recipient: null, status: "NOTHING_DUE", count: 0 }); continue; }
    const recipients = await reminderRecipients(t.id);
    if (recipients.length === 0) { out.push({ tenantId: t.id, recipient: null, status: "NO_RECIPIENT", count: rows.length }); continue; }
    const { subject, text, html } = composeDigest(t.name, rows, fmtDate(now));
    for (const to of recipients) {
      const { log, created } = await claimEmail({ tenantId: t.id, recipient: to, subject, template: AUTHORITY_REMINDER_TEMPLATE, trigger: "AUTO", idempotencyKey: `${AUTHORITY_REMINDER_TEMPLATE}:${day}:${to}` });
      if (!created) { out.push({ tenantId: t.id, recipient: to, status: "ALREADY", count: rows.length }); continue; }
      try {
        const transport = opts.transport ?? getMailTransport();
        const res = await transport.send({ to, subject, text, html, fromName: `Rent-Base · ${t.name}`, replyTo: t.email, attachments: [] });
        await markEmailSent(t.id, log.id, res.messageId);
        out.push({ tenantId: t.id, recipient: to, status: "SENT", count: rows.length });
      } catch (e) {
        await markEmailFailed(t.id, log.id, safeMailError(e));
        out.push({ tenantId: t.id, recipient: to, status: "FAILED", count: rows.length });
      }
    }
  }
  return out;
}

/** Hintergrundlauf im Serverprozess (siehe instrumentation.ts): prüft stündlich, sendet ab 7 Uhr einmal pro Tag. */
export function startAuthorityReminderScheduler(intervalMs = 30 * 60_000) {
  const g = globalThis as { __rbAuthorityReminder?: NodeJS.Timeout };
  if (g.__rbAuthorityReminder) return;
  const tick = async () => {
    try {
      if (zonedParts(new Date()).hour < REMINDER_HOUR) return;
      const res = await sendAuthorityReminders();
      const sent = res.filter((r) => r.status === "SENT").length, failed = res.filter((r) => r.status === "FAILED").length;
      if (sent || failed) console.log(`Behördenfristen-Erinnerung: ${sent} gesendet, ${failed} fehlgeschlagen`);
    } catch (e) {
      console.error("Behördenfristen-Erinnerung fehlgeschlagen:", (e as Error).name);
    }
  };
  g.__rbAuthorityReminder = setInterval(tick, intervalMs);
  g.__rbAuthorityReminder.unref?.();
  setTimeout(tick, 60_000).unref?.();
}
