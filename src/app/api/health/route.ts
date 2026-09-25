// Öffentlicher, minimaler Healthcheck (Befehl 20, item 80). Keine Secrets, keine internen Konfigurationswerte –
// nur ob die App läuft und die Datenbank erreichbar ist.
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", db: "ok" });
  } catch {
    return Response.json({ status: "ok", db: "error" }, { status: 503 });
  }
}
