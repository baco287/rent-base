import { getSession } from "@/lib/auth";
import { logoutAction } from "@/app/(auth)/actions";

export const metadata = { title: "Mandant gesperrt" };
export const dynamic = "force-dynamic";

/**
 * Befehl 20, item 11: ein gesperrter Mandant führt zu keiner produktiven Nutzung mehr – auch nicht mit einer
 * bereits bestehenden Sitzung. Diese Seite nutzt bewusst getSession() statt requireSession(), sonst gäbe es
 * eine Umleitungsschleife (requireSession leitet SUSPENDED-Mandanten genau hierher).
 */
export default async function LockedPage() {
  const session = await getSession();
  if (!session) return null; // requireSession() an anderer Stelle übernimmt die Anmeldeprüfung

  return (
    <>
      <h1 className="text-2xl font-semibold mb-1">Mandant gesperrt</h1>
      <p className="text-ink-2 mb-4">
        {session.tenant.name} ist derzeit gesperrt. Eine Anmeldung ist möglich, eine produktive Nutzung von RentBase nicht.
        {session.tenant.suspendedReason ? " Grund: " + session.tenant.suspendedReason : ""}
      </p>
      <p className="text-ink-3 text-sm mb-5">Bitte wenden Sie sich an RentBase, um die Sperrung zu klären.</p>
      <form action={logoutAction}>
        <button type="submit" className="btn">Abmelden</button>
      </form>
    </>
  );
}
