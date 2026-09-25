// Läuft einmal beim Start des Servers. Die Anwendungszeitzone gilt auch für alles, was ohne explizite
// Zeitzone formatiert oder geparst wird (Sicherheitsnetz; die eigentliche Regel steht in lib/time.ts).
export async function register() {
  if (!process.env.TZ) process.env.TZ = "Europe/Berlin";
  // Tägliche Behördenfristen-Erinnerung: in Produktion an (AUTHORITY_REMINDERS=off schaltet ab), lokal nur mit =on
  const flag = process.env.AUTHORITY_REMINDERS?.trim().toLowerCase();
  const enabled = process.env.NODE_ENV === "production" ? flag !== "off" : flag === "on";
  if (process.env.NEXT_RUNTIME === "nodejs" && enabled) {
    const { startAuthorityReminderScheduler } = await import("@/lib/authority-reminders");
    startAuthorityReminderScheduler();
  }
}
