import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";

// Schneller Vorab-Check: ohne Sitzungs-Cookie direkt zum Login.
// Die echte Prüfung (Sitzung gültig, Rolle) passiert in den Seiten über requireSession().
//
// Zwei verschiedene Arten "öffentlicher" Seiten (Befehl 20):
// - AUTH_ENTRY_PATHS: Login und Ersteinrichtung. Wer hier bereits angemeldet ankommt, wird nach /heute geleitet
//   (sonst endlose Zirkel zwischen Login und Startseite bei abgelaufenem Cookie).
// - ALWAYS_PUBLIC_PATHS: Einladung annehmen, Passwort-Reset, Sperrseite, Healthcheck. Diese müssen auch ganz
//   ohne Sitzungs-Cookie erreichbar sein (neuer, noch nie angemeldeter Benutzer) – aber NIE automatisch
//   weggeleitet werden, nur weil zufällig noch irgendein anderes Konto in diesem Browser angemeldet ist.
const AUTH_ENTRY_PATHS = ["/login", "/setup"];
// Befehl 20.6: /rueckgabe/<token> und /api/rueckgabe/<token>/… – Berechtigung ist allein der persönliche Rückgabelink
const ALWAYS_PUBLIC_PATHS = ["/einladung", "/passwort-vergessen", "/gesperrt", "/api/health", "/rueckgabe", "/api/rueckgabe"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const isAuthEntry = AUTH_ENTRY_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const isAlwaysPublic = ALWAYS_PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (!hasCookie && !isAuthEntry && !isAlwaysPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname !== "/" ? `?weiter=${encodeURIComponent(pathname)}` : "";
    return NextResponse.redirect(url);
  }
  if (hasCookie && isAuthEntry) {
    // Die Seite hat festgestellt, dass die Sitzung nicht mehr gilt: Cookie entfernen und den Login zeigen.
    // Ohne diesen Zweig würden sich Login und Startseite mit einem abgelaufenen Cookie endlos gegenseitig aufrufen.
    if (request.nextUrl.searchParams.has("abgelaufen")) {
      const res = NextResponse.next();
      res.cookies.delete(SESSION_COOKIE);
      return res;
    }
    return NextResponse.redirect(new URL("/heute", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Alles außer statische Dateien und Next-Interna
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)"],
};
