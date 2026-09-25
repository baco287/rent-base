import Link from "next/link";
import { lookupResetToken } from "@/lib/password-reset";
import { ResetPasswordForm } from "./reset-form";

export const metadata = { title: "Neues Passwort" };
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({ params }: PageProps<"/passwort-vergessen/[token]">) {
  const { token } = await params;
  const lookup = await lookupResetToken(token);

  if (!lookup.valid) {
    return (
      <>
        <h1 className="text-2xl font-semibold mb-1">{lookup.expired ? "Dieser Link ist abgelaufen" : "Dieser Link ist nicht mehr gültig"}</h1>
        <p className="text-ink-2">Bitte fordern Sie <Link href="/passwort-vergessen" className="text-brand underline">einen neuen Link</Link> an.</p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold mb-1">Neues Passwort festlegen</h1>
      <ResetPasswordForm token={token} />
    </>
  );
}
