import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { LoginForm } from "./login-form";

export const metadata = { title: "Anmelden" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const tenants = await db.tenant.count();
  if (tenants === 0) redirect("/setup");

  const params = await searchParams;
  const weiter = typeof params.weiter === "string" ? params.weiter : undefined;

  return (
    <>
      <h1 className="text-2xl font-semibold mb-1">Anmelden</h1>
      <p className="text-ink-2 mb-5">Mit deinem Benutzerkonto der Vermietung.</p>
      <LoginForm weiter={weiter} />
    </>
  );
}
