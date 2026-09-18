// Entfernt liegen gebliebene Testmandanten (slug beginnt mit "test-") aus der lokalen Entwicklungsdatenbank.
// Aufruf: npx tsx tests/purge-test-tenants.mts
import { db } from "../src/lib/db";
import { purgeTenants } from "./helpers";

const tenants = await db.tenant.findMany({ where: { slug: { startsWith: "test-" } }, select: { id: true } });
await purgeTenants(tenants.map((t) => t.id));
console.log(`${tenants.length} Testmandanten entfernt, verbleibend: ${await db.tenant.count()}`);
await db.$disconnect();
