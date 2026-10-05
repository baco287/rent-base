// Befehl 29: Migrationstest auf einer Datenbank mit vorhandenen Daten (nur lokal, nie gegen Produktion).
// Schritt "copy": kopiert alle Zeilen einer Quell-DB (nur lesend) in eine Ziel-DB auf demselben Migrationsstand –
//   Trigger und Fremdschlüssel sind dabei per session_replication_role = replica ausgesetzt (reine Kopie, kein Fachvorgang).
// Schritt "fingerprint": Zeilenzahl und Prüfsumme je Tabelle, nur über die Spalten, die vor Befehl 29 existierten.
// Aufruf: npx tsx tests/migration-copy-check.mts copy <QUELL_URL> <ZIEL_URL>
//         npx tsx tests/migration-copy-check.mts fingerprint <URL> <AUSGABE.json>
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const [mode, a, b] = process.argv.slice(2);
const forbidden = /rent-base\.de|coolify|prod/i;
for (const u of [a, b]) if (u && forbidden.test(u)) throw new Error("Nur lokale Datenbanken.");
// Beide Datenbank-URLs (Quelle und – beim Kopieren – das Schreibziel) müssen auf localhost zeigen
const isLocalDb = (u: string | undefined) => Boolean(u) && /^postgres(ql)?:\/\/[^@/]*@(localhost|127\.0\.0\.1)[:/]/.test(u!);
for (const u of mode === "copy" ? [a, b] : [a]) if (!isLocalDb(u)) throw new Error("Nur lokale Datenbanken.");

const client = (url: string) => new PrismaClient({ datasourceUrl: url });

async function tables(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`);
  return rows.map((r) => r.table_name);
}

// Spalten, die Befehl 29 hinzufügt – für den Vorher/Nachher-Vergleich ausgeklammert
const NEW_COLUMNS: Record<string, string[]> = { Booking: ["rentalType"] };

if (mode === "copy") {
  const src = client(a), dst = client(b);
  const list = await tables(src);
  await dst.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    for (const t of list) {
      const rows = await src.$queryRawUnsafe<{ j: unknown }[]>(`SELECT COALESCE(json_agg(t), '[]'::json) AS j FROM "${t}" t`);
      const json = JSON.stringify(rows[0].j);
      if (json === "[]") continue;
      // Systemzeilen aus den Migrationen (z. B. Standard-Fahrzeugskizzen) bestehen in beiden Datenbanken; der Fingerprint prüft Gleichheit
      await tx.$executeRawUnsafe(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json) ON CONFLICT DO NOTHING`, json);
    }
  }, { timeout: 600_000, maxWait: 60_000 });
  const counts: Record<string, number> = {};
  for (const t of list) counts[t] = Number((await dst.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${t}"`))[0].n);
  console.log(JSON.stringify(counts));
  await src.$disconnect(); await dst.$disconnect();
} else if (mode === "fingerprint") {
  const db = client(a);
  const out: Record<string, { rows: number; md5: string }> = {};
  for (const t of await tables(db)) {
    const strip = (NEW_COLUMNS[t] ?? []).map((c) => ` - '${c}'`).join("");
    const r = await db.$queryRawUnsafe<{ n: bigint; h: string | null }[]>(`SELECT count(*)::bigint AS n, md5(string_agg((to_jsonb(t)${strip})::text, '|' ORDER BY (to_jsonb(t)->>'id'))) AS h FROM "${t}" t`);
    out[t] = { rows: Number(r[0].n), md5: r[0].h ?? "" };
  }
  writeFileSync(b, JSON.stringify(out, null, 1));
  console.log(`${Object.keys(out).length} Tabellen, ${Object.values(out).reduce((s, x) => s + x.rows, 0)} Zeilen`);
  await db.$disconnect();
} else {
  console.error("Aufruf: copy <QUELL_URL> <ZIEL_URL> | fingerprint <URL> <AUSGABE.json>");
  process.exit(1);
}
