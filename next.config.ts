import type { NextConfig } from "next";

// Sicherheitskopfzeilen (Phase 19), additiv und ohne Content-Security-Policy für Skripte: eine vollständige CSP braucht
// eine Inventur aller Inline-Skripte/Styles von Next und wird deshalb nicht blind live geschaltet. frame-ancestors
// allein ist gefahrlos und verhindert das Einbetten der Anwendung in fremde Seiten.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "geolocation=(), microphone=(), payment=(), usb=()" },
  // HSTS wirkt nur über HTTPS (Produktion hinter TLS); Browser ignorieren die Kopfzeile über HTTP.
  ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" }] : []),
];

// Versionswechsel bei Deploys (docs/deployment.md): Mit deploymentId erkennt der Browser eine veraltete Seite und lädt
// nach der Aktion neu, statt Programmteile der alten Version anzufordern. Die Aktion selbst wird vorher noch ausgeführt.
// Der feste NEXT_SERVER_ACTIONS_ENCRYPTION_KEY hält die Action-IDs über Deploys stabil; fehlt er, nur ein Hinweis im Build-Log.
const deploymentId = process.env.NEXT_DEPLOYMENT_ID || process.env.SOURCE_COMMIT || undefined;
if (process.argv.includes("build") && !process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY) {
  console.warn("[Build] NEXT_SERVER_ACTIONS_ENCRYPTION_KEY ist nicht gesetzt: Server-Action-IDs ändern sich mit jedem Build, offene Formulare scheitern nach einem Deploy beim nächsten Speichern (docs/deployment.md).");
}

const nextConfig: NextConfig = {
  // Schlanker Produktions-Build für das Docker-Image (siehe Dockerfile)
  output: "standalone",
  deploymentId,
  // Diese Pakete laden zur Laufzeit eigene Dateien (Schriftdaten, native Bibliotheken) und bleiben deshalb ungebündelt
  serverExternalPackages: ["pdfkit", "sharp", "nodemailer"],
  // Schriften für die PDF-Erzeugung gehören in den Standalone-Build
  outputFileTracingIncludes: { "/**": ["./assets/fonts/**", "./node_modules/pdfkit/js/data/**"] },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
