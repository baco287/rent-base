import "server-only";
import { headers } from "next/headers";

/** Basis-Adresse des aktuellen Requests (für Links in E-Mails, z. B. Einladung, Passwort-Reset). Kein fest hinterlegter Domainname. */
export async function requestBaseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (process.env.NODE_ENV === "production" ? "https" : "http");
  return `${proto}://${host}`;
}
