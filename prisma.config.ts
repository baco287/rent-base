import { defineConfig, env } from "prisma/config";

// .env nur laden, wenn vorhanden (lokal). Auf dem Server kommen die Variablen aus Coolify.
try {
  process.loadEnvFile();
} catch {
  // keine .env-Datei, das ist auf dem Server der Normalfall
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  engine: "classic",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
