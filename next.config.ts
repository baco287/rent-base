import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Schlanker Produktions-Build für das Docker-Image (siehe Dockerfile)
  output: "standalone",
};

export default nextConfig;
