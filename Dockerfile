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
# DATABASE_URL wird beim Build nicht gebraucht, Prisma liest nur das Schema.
RUN npx prisma generate && npm run build

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
ENTRYPOINT ["./docker-entrypoint.sh"]
