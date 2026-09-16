#!/bin/sh
# Startet erst die Datenbank-Migrationen, dann die App.
# Bricht ab, wenn eine Migration fehlschlägt, damit keine halbe Version läuft.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL ist nicht gesetzt." >&2
  exit 1
fi

echo "Migrationen anwenden..."
/opt/prisma-cli/node_modules/.bin/prisma migrate deploy --config ./prisma.config.ts

echo "Rent-Base startet auf Port ${PORT:-3000}"
exec node server.js
