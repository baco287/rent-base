"use client";

// Letzte Rückfallebene, wenn selbst das Root-Layout scheitert. Ersetzt das Layout komplett,
// deshalb eigenes <html>/<body> und eigener Import der Stile (Schriften aus dem Layout fehlen hier).
import "./globals.css";
import { ErrorView } from "@/components/error-view";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="de">
      <body className="min-h-full bg-bg">
        <title>Fehler · Rent-Base</title>
        <ErrorView error={error} retry={retry} homeHref="/" />
      </body>
    </html>
  );
}
