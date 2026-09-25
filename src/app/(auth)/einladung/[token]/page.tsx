import { lookupInvitation } from "@/lib/invitations";
import { ROLES, type Role } from "@/lib/constants";
import { AcceptInvitationForm } from "./accept-form";

export const metadata = { title: "Einladung annehmen" };
export const dynamic = "force-dynamic";

export default async function AcceptInvitationPage({ params }: PageProps<"/einladung/[token]">) {
  const { token } = await params;
  const lookup = await lookupInvitation(token);

  if (!lookup) {
    return (
      <>
        <h1 className="text-2xl font-semibold mb-1">Einladung nicht gefunden</h1>
        <p className="text-ink-2">Dieser Link ist nicht gültig. Bitte wenden Sie sich an die Person, die Sie eingeladen hat.</p>
      </>
    );
  }
  if ("expired" in lookup) {
    return (
      <>
        <h1 className="text-2xl font-semibold mb-1">Diese Einladung ist abgelaufen</h1>
        <p className="text-ink-2">Bitte bitten Sie um eine erneute Einladung.</p>
      </>
    );
  }

  const roleLabel = ROLES[lookup.invitation.role as Role] ?? lookup.invitation.role;
  return (
    <>
      <h1 className="text-2xl font-semibold mb-1">Willkommen bei RentBase</h1>
      <p className="text-ink-2 mb-5">
        Sie richten Ihr Konto für <span className="font-medium">{lookup.tenantName}</span> ein ({roleLabel}, {lookup.invitation.email}).
      </p>
      <AcceptInvitationForm token={token} />
    </>
  );
}
