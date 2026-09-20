import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Schlanker Produktions-Build für das Docker-Image (siehe Dockerfile)
  output: "standalone",
  // Diese Pakete laden zur Laufzeit eigene Dateien (Schriftdaten, native Bibliotheken) und bleiben deshalb ungebündelt
  serverExternalPackages: ["pdfkit", "sharp", "nodemailer"],
  // Schriften für die PDF-Erzeugung gehören in den Standalone-Build
  outputFileTracingIncludes: { "/**": ["./assets/fonts/**", "./node_modules/pdfkit/js/data/**"] },
};

export default nextConfig;
