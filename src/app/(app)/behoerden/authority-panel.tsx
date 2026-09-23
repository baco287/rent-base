// Behördenvorgänge als Karte in Fahrzeugakte, Buchung und Kundenakte. Ohne Personendaten; in der Kundenakte nur
// Vorgänge, in denen die Person bewusst als Fahrer bestimmt wurde (neutral „Behördenvorgang“, keine Wertung).
import Link from "next/link";
import { Card, Chip, Plate } from "@/components/ui";
import { casesForBooking, casesForCustomer, casesForVehicle } from "@/lib/authority";
import { fmtDate } from "@/lib/format";
import { AuthorityStatusChip, AuthorityTypeChip, DeadlineChip } from "./chips";

type Scope = { vehicleId: string } | { bookingId: string } | { customerId: string };

export async function AuthorityCasesPanel({ tenantId, scope, canManage, title = "Behördenvorgänge" }: { tenantId: string; scope: Scope; canManage: boolean; title?: string }) {
  const rows = "vehicleId" in scope ? await casesForVehicle(tenantId, scope.vehicleId) : "bookingId" in scope ? await casesForBooking(tenantId, scope.bookingId) : await casesForCustomer(tenantId, scope.customerId);
  if (rows.length === 0 && "customerId" in scope) return null;
  return (
    <Card title={title} right={<div className="flex items-center gap-2"><Chip>{rows.length}</Chip>{canManage && "vehicleId" in scope && <Link href={`/behoerden/neu?fahrzeug=${scope.vehicleId}`} className="text-xs underline">Schreiben erfassen</Link>}</div>}>
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-ink-3">{"bookingId" in scope ? "Zu dieser Vermietung liegt kein Behördenvorgang vor." : "Keine Behördenvorgänge."}</p>
      ) : (
        <ul className="divide-y divide-line-soft text-sm">
          {rows.map((c) => (
            <li key={c.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link href={`/behoerden/${c.id}`} className="font-mono tnum font-medium hover:underline">{c.caseNumber}</Link>
              <AuthorityTypeChip type={c.type} />
              {"customerId" in scope && <Plate>{c.licensePlateSnapshot}</Plate>}
              <span className="text-ink-2">{c.authorityName} · Az. {c.authorityReference}</span>
              <span className="text-xs text-ink-3">Tatzeit {c.offenseText}</span>
              {"vehicleId" in scope && c.booking && <Link href={`/buchungen/${c.booking.id}`} className="text-xs underline">Buchung {c.booking.number}</Link>}
              <AuthorityStatusChip status={c.status} />
              {c.responseDeadline && c.status !== "CLOSED" && c.status !== "CANCELLED" && c.status !== "SUBMITTED" && <DeadlineChip level={c.deadline.level} text={`${c.deadline.text} · bis ${fmtDate(c.responseDeadline)}`} />}
            </li>
          ))}
        </ul>
      )}
      {"customerId" in scope && <p className="px-4 pb-3 text-xs text-ink-3">Angezeigt werden nur Vorgänge, in denen diese Person bewusst als Fahrer bestimmt wurde – nicht jede Buchung mit einem Behördenschreiben.</p>}
    </Card>
  );
}
