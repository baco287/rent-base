"use client";

// Fehler innerhalb der Vermieter-Oberfläche: Navigation und Kopfzeile bleiben sichtbar.
import { ErrorView } from "@/components/error-view";

export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorView error={error} retry={retry} homeHref="/heute" />;
}
