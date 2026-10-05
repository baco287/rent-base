// Befehl 29: Unfallersatz ist ein freischaltbares Modul (Control Center, standardmäßig gesperrt). Das Layout schützt alle
// Seiten serverseitig (requireFeature); jede Server Action des Moduls prüft zusätzlich selbst. Ohne Freischaltung: zurück
// zur Startseite mit Hinweis.
import { requireFeature } from "@/lib/auth";

export default async function FeatureLayout({ children }: { children: React.ReactNode }) {
  await requireFeature("ACCIDENT_REPLACEMENT");
  return children;
}
