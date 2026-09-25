// Befehl 20, item 53/54/55: Fortschritt wird aus echten Daten berechnet, nie aus einem blind gesetzten
// "stepCompleted=true". Unterscheidet BLOCKER (verhindert "Bereit für erste Vermietung") von EMPFEHLUNG
// (Hinweis, blockiert nichts). Nutzt ausschließlich bestehende Fachlogik, keine eigene Einstellungslogik.
import { db } from "@/lib/db";
import { invoiceSettingsMissing } from "@/lib/invoices";
import { termsOverview } from "@/lib/rental-terms";
import { requiredLicenseClassFor } from "@/lib/driver-verification";
import { mailStatusOf } from "@/lib/tenant-mail";
import { SMTP_STATUS } from "@/lib/constants";

export type SetupCheckItem = { key: string; label: string; done: boolean; blocker: boolean; href: string; hint?: string };

export async function computeSetupCheck(tenantId: string) {
  const [tenant, terms, groupCount, vehicles, groups, mail] = await Promise.all([
    db.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    termsOverview(tenantId),
    db.vehicleGroup.count({ where: { tenantId } }),
    db.vehicle.findMany({ where: { tenantId }, select: { status: true, requiredLicenseClass: true, groupId: true } }),
    db.vehicleGroup.findMany({ where: { tenantId }, select: { id: true, bodyType: true, requiredLicenseClass: true } }),
    mailStatusOf(tenantId),
  ]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const bookableVehicle = vehicles.some((v) => v.status === "AVAILABLE");
  const allClassesConfigured = vehicles.length > 0 && vehicles.every((v) => requiredLicenseClassFor(v, (v.groupId ? groupById.get(v.groupId) : null) ?? null) != null);

  const items: SetupCheckItem[] = [
    { key: "unternehmen", label: "Unternehmensdaten", done: Boolean(tenant.street && tenant.zip && tenant.city && tenant.phone), blocker: false, href: "/einstellungen" },
    { key: "rechnung", label: "Rechnungs- und Steuerdaten", done: invoiceSettingsMissing(tenant).length === 0, blocker: true, href: "/einstellungen", hint: invoiceSettingsMissing(tenant).join("; ") },
    { key: "nummernkreise", label: "Nummernkreise", done: true, blocker: false, href: "/einstellungen/nummernkreise", hint: "Startwerte sind bereits vergeben (RE/GS/ST/AZ), bei Bedarf anpassen." },
    { key: "geschaeftsregeln", label: "Geschäftsregeln", done: true, blocker: false, href: "/einstellungen/geschaeftsregeln", hint: "Standardwerte sind bereits gesetzt, bei Bedarf anpassen." },
    { key: "mietbedingungen", label: "Mietbedingungen veröffentlicht", done: Boolean(terms.active), blocker: false, href: "/einstellungen/mietbedingungen", hint: terms.active ? undefined : "Ohne veröffentlichte Fassung nutzen neue Verträge vorerst keinen Bedingungstext." },
    { key: "gruppen", label: "Mindestens eine Fahrzeuggruppe", done: groupCount > 0, blocker: true, href: "/fahrzeuge/gruppen" },
    { key: "fahrzeug", label: "Mindestens ein buchbares Fahrzeug", done: bookableVehicle, blocker: true, href: "/fahrzeuge/neu" },
    // Befehl 20.5: starke Empfehlung, kein Blocker – der RentBase-Versand bleibt ein bewusster, zulässiger Rückfall
    { key: "email", label: `E-Mail-Versand: ${SMTP_STATUS[mail.status]}${mail.mode === "TENANT_SMTP" && mail.status === "VERIFIED" ? " (aktiv)" : ""}`, done: mail.mode === "TENANT_SMTP" && mail.status === "VERIFIED", blocker: false, href: "/einstellungen/e-mail", hint: "Eigener E-Mail-Versand empfohlen, damit Kunden Nachrichten direkt von Ihrer Firmenadresse erhalten." },
    { key: "logo", label: "Logo für Dokumente und E-Mails", done: Boolean(tenant.logoStorageKey), blocker: false, href: "/einstellungen", hint: "Optional – erscheint auf neuen Verträgen, Rechnungen und in geschäftlichen E-Mails." },
    { key: "fuehrerscheinklasse", label: "Erforderliche Führerscheinklasse konfiguriert", done: allClassesConfigured, blocker: vehicles.length > 0, href: "/fahrzeuge/gruppen", hint: "Ohne Angabe blockiert die Fahrerprüfung bei der Übergabe bewusst, statt zu raten." },
  ];

  return { items, blockers: items.filter((i) => i.blocker && !i.done), recommendations: items.filter((i) => !i.blocker && !i.done) };
}
