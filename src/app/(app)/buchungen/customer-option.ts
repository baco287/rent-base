import "server-only";
// Befehl 20.7: ein Kunde als Auswahl im Buchungsformular (Vorbelegung und Suchtreffer): eindeutig durch Nummer,
// Name/Firma und Kontaktdaten. Kein "use server"-Modul, damit auch synchrone Helfer exportiert werden können.
import { db } from "@/lib/db";
import type { CustomerOption } from "./booking-form";

export const CUSTOMER_PICKER_LIMIT = 12;

export const CUSTOMER_OPTION_SELECT = { id: true, number: true, type: true, firstName: true, lastName: true, companyName: true, city: true, email: true, phone: true, blocked: true, discountPercent: true } as const;

export function customerOptionOf(c: { id: string; number: string | null; type: string; firstName: string; lastName: string; companyName: string | null; city: string | null; email: string | null; phone: string | null; blocked: boolean; discountPercent: number }): CustomerOption {
  const person = `${c.lastName}, ${c.firstName}`.replace(/^, |, $/g, "");
  return {
    id: c.id,
    label: c.type === "COMPANY" && c.companyName ? `${c.companyName} (${c.firstName} ${c.lastName})`.trim() : person,
    number: c.number,
    context: [c.city, c.email, c.phone].filter(Boolean).join(" · "),
    blocked: c.blocked,
    discountPercent: c.discountPercent,
  };
}

/** Ein bestimmter Kunde als Auswahl (Vorbelegung aus ?kunde=… oder bestehender Buchung); mandantengebunden. */
export async function loadCustomerOption(tenantId: string, customerId: string): Promise<CustomerOption | null> {
  if (!customerId) return null;
  const c = await db.customer.findFirst({ where: { id: customerId, tenantId }, select: CUSTOMER_OPTION_SELECT });
  return c ? customerOptionOf(c) : null;
}
