// Control Center: Feature-Freischaltung. Das Layout schützt alle Seiten dieses Moduls serverseitig (requireFeature);
// die Server Actions des Moduls prüfen zusätzlich selbst. Ohne Freischaltung: zurück zur Startseite mit Hinweis.
import { requireFeature } from "@/lib/auth";

export default async function FeatureLayout({ children }: { children: React.ReactNode }) {
  await requireFeature("CUSTOMER_IMPORT");
  return children;
}
