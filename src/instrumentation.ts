// Läuft einmal beim Start des Servers. Die Anwendungszeitzone gilt auch für alles, was ohne explizite
// Zeitzone formatiert oder geparst wird (Sicherheitsnetz; die eigentliche Regel steht in lib/time.ts).
export async function register() {
  if (!process.env.TZ) process.env.TZ = "Europe/Berlin";
}
