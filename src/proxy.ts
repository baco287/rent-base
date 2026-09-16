import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";

// Schneller Vorab-Check: ohne Sitzungs-Cookie direkt zum Login.
// Die echte Prüfung (Sitzung gültig, Rolle) passiert in den Seiten über requireSession().
const PUBLIC_PATHS = ["/login", "/setup"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (!hasCookie && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname !== "/" ? `?weiter=${encodeURIComponent(pathname)}` : "";
    return NextResponse.redirect(url);
  }
  if (hasCookie && isPublic) {
    return NextResponse.redirect(new URL("/heute", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Alles außer statische Dateien und Next-Interna
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)"],
};
