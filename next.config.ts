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

const nextConfig: NextConfig = {
  // Schlanker Produktions-Build für das Docker-Image (siehe Dockerfile)
  output: "standalone",
  // Diese Pakete laden zur Laufzeit eigene Dateien (Schriftdaten, native Bibliotheken) und bleiben deshalb ungebündelt
  serverExternalPackages: ["pdfkit", "sharp", "nodemailer"],
  // Schriften für die PDF-Erzeugung gehören in den Standalone-Build
  outputFileTracingIncludes: { "/**": ["./assets/fonts/**", "./node_modules/pdfkit/js/data/**"] },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
