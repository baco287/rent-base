// Reines Passwort-Hashing, bewusst ohne "server-only" oder next/headers: wird auch direkt in Tests importiert
// (lib/auth.ts selbst ist request-gebunden und lässt sich außerhalb von Next.js nicht laden).
import bcrypt from "bcryptjs";

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}
