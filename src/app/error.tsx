"use client";

// Fehler außerhalb der Vermieter-Oberfläche: Anmeldung, Control Center, kontaktlose Rückgabe.
// Auf der Rückgabeseite des Mieters gibt es keinen Link zur Startseite, die wäre für ihn nur der Login.
import { usePathname } from "next/navigation";
import { ErrorView } from "@/components/error-view";

export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const pathname = usePathname() ?? "";
  const homeHref = pathname.startsWith("/rueckgabe") ? null : pathname.startsWith("/admin") ? "/admin" : "/";
  return (
    <main className="flex-1 bg-bg">
      <ErrorView error={error} retry={retry} homeHref={homeHref} />
    </main>
  );
}
