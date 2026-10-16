# Rent-Base Produktions-Image. Wird von Coolify aus dem Git-Repository gebaut.
# Mehrstufig: Abhängigkeiten -> Build -> schlankes Laufzeit-Image.

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Schutz offener Formulare bei Deploys (docs/deployment.md), in Coolify als Build-Variablen setzen:
# - NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: fester Schlüssel, damit Server Actions über Deploys hinweg dieselbe ID behalten.
#   Ohne ihn erzeugt jeder Build neue IDs und jede offene Seite scheitert beim nächsten Speichern.
# - SOURCE_COMMIT: wird zur deploymentId; veraltete Seiten laden dann neu, statt mit Fehlern weiterzulaufen.
# Beide sind optional; fehlen sie, verhält sich der Build wie bisher.
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ARG SOURCE_COMMIT
# prisma.config.ts verlangt DATABASE_URL schon bei "prisma generate", der Build verbindet sich aber nie mit einer Datenbank.
# Ein Platzhalter (.invalid ist nie auflösbar) ersetzt deshalb jede echte Adresse, auch wenn Coolify sie als Build-Variable
# mitgibt. Der Build braucht so keine Produktionszugangsdaten; zur Laufzeit gilt die echte DATABASE_URL (docker-entrypoint.sh).
RUN export DATABASE_URL="postgresql://build:build@build.invalid:5432/build" && npx prisma generate && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# fontconfig + eine Schriftart: sharp/libvips braucht das, um SVG-Text zu rendern (Kennzeichnung von Dokumentkopien, Phase 19.5)
RUN apk add --no-cache openssl tzdata fontconfig ttf-dejavu && addgroup -S app && adduser -S app -G app
# Zeitangaben in Dokumenten und E-Mails in deutscher Zeit
ENV TZ=Europe/Berlin
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Prisma CLI nur für "migrate deploy" beim Start, getrennt vom App-Code.
# Schema, Migrationen und Konfiguration liegen daneben, damit alle Importe auflösbar sind.
WORKDIR /opt/prisma-cli
RUN npm install --no-audit --no-fund prisma@6.19.3 >/dev/null 2>&1
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/prisma.config.ts ./prisma.config.ts

WORKDIR /app
# Standalone-Build von Next.js plus statische Dateien
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
# Schriften für die PDF-Erzeugung
COPY --from=build --chown=app:app /app/assets ./assets
COPY --from=build --chown=app:app /app/scripts ./scripts
COPY --chown=app:app docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER app
EXPOSE 3000
# Prüft App und Datenbank über /api/health (antwortet 503, wenn die Datenbank fehlt). Alpine hat wget, kein curl.
# Coolify übernimmt diesen Healthcheck und schaltet bei einem Deploy erst auf den neuen Container um, wenn er gesund ist.
# Großzügige Startphase, weil vor dem Serverstart noch die Migrationen laufen.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
