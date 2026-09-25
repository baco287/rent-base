import { RequestResetForm } from "./request-form";

export const metadata = { title: "Passwort vergessen" };

export default function RequestResetPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold mb-1">Passwort vergessen</h1>
      <p className="text-ink-2 mb-5">Geben Sie Ihre E-Mail-Adresse ein. Wenn ein Konto besteht, erhalten Sie einen Link zum Zurücksetzen.</p>
      <RequestResetForm />
    </>
  );
}
