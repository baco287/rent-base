import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { SetupForm } from "./setup-form";

export const metadata = { title: "Einrichtung" };

export default async function SetupPage() {
  const tenants = await db.tenant.count();
  if (tenants > 0) redirect("/login");

  return (
    <>
      <h1 className="text-2xl font-semibold mb-1">Ersteinrichtung</h1>
      <p className="text-ink-2 mb-5">
        Lege deine Vermietung und dein Inhaber-Konto an. Weitere Mitarbeiter kommen später über die Einstellungen dazu.
      </p>
      <SetupForm />
    </>
  );
}
