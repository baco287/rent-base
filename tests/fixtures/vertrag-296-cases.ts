// Befehl 29.6: feste Render-Aufrufe der gemeinsam genutzten Bausteine (ohne die neuen optionalen Props) und Beispiel-Dokumente.
// Grundlage für den Markup-Vergleich in tests/contract-wizard-296.test.ts (Fixture: vertrag-296-markup.json).
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContractDocument } from "../../src/lib/contract-view";
import { parseTerms } from "../../src/lib/terms-markdown";
import { Field } from "../../src/components/ui";
import { ContractTermsText } from "../../src/components/terms-view";
import { CustomerFields, emptyCustomer } from "../../src/app/(app)/kunden/customer-fields";
import { ContractDocumentView, DriverFields, emptyDriver } from "../../src/app/(app)/buchungen/[id]/vertrag/contract-parts";
import { FinalizeForm, InlineForm, SignatureForm, StepForm, WizardProgress } from "../../src/app/(app)/buchungen/[id]/vertrag/wizard-ui";

const noop = async () => undefined;
const r = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const filledCustomer = {
  ...emptyCustomer, firstName: "Erika", lastName: "Muster", email: "erika@example.test", phone: "0421 12345", street: "Weg 1", zip: "28195", city: "Bremen",
  birthDate: "1985-03-12", idNumber: "L01X00T47", idValidUntil: "2031-01-01", licenseNumber: "B072RRE2I55", licenseIssuedAt: "2005-06-01", licenseValidUntil: "2033-06-01", legacyNumber: "ALT-7",
};
const company = { ...filledCustomer, type: "COMPANY", companyName: "Hansa Logistik GmbH & Co. KG", blocked: true, blockReason: "Schaden offen", discountPercent: "10", notes: "Notiz" };
const filledDriver = { ...emptyDriver, customerId: "c1", firstName: "Max", lastName: "Beispiel", birthDate: "1990-04-02", street: "Weg 2", zip: "28195", city: "Bremen", licenseNumber: "B99", licenseIssuedAt: "2010-01-01", licenseValidUntil: "2034-01-01", licenseIssuedBy: "Stadt Bremen" };
const TERMS_MD = "# Allgemeine Mietbedingungen\n\n## § 1 Mietgegenstand\n\nDas Fahrzeug wird **pfleglich** behandelt.\n\n### Verlängerung\n\n- Rückgabe pünktlich\n- Tank voll\n\n1. erstens\n2. zweitens";

const baseDoc: ContractDocument = {
  title: "Mietvertrag", number: "MV-2026-0001", status: "DRAFT",
  landlord: { name: "JetRent", address: "Hafenstr. 1, 28195 Bremen", contact: "0421 555 0", email: null },
  renterEmail: "erika@example.test", renterName: "Erika Muster", vehicleTitle: "VW Crafter", plate: "HB-T 1", startAt: "17.10.2026, 09:00", createdAt: "16.10.2026, 10:00", signedAt: null, contentHash: null,
  sections: [
    { key: "renter", title: "Mieter", rows: [{ label: "Name", value: "Erika Muster" }, { label: "Geburtsdatum", value: "–", missing: true }] },
    { key: "conditions", title: "Konditionen", rows: [{ label: "Kaution", value: "500,00 €" }, { label: "Selbstbeteiligung", value: "1.000,00 €" }] },
  ],
  additionalDrivers: [],
  price: { days: 7, openEnd: false, durationText: "Mietdauer 7 Tage", lines: [{ text: "1 × Kalenderwoche zu 540,00 €", amount: "540,00 €" }], subtotalLabel: "Zwischensumme", subtotal: "540,00 €", discount: { text: "Rabatt 10 %", amount: "−54,00 €" }, calculated: "486,00 €", agreed: null, extras: [{ text: "1 × Zusatzfahrer (pauschal) zu 15,00 €", amount: "15,00 €" }], total: "501,00 €", totalNote: null, deposit: "500,00 €" },
  rules: { key: "rules", title: "Geschäftsregeln dieses Vertrags", rows: [{ label: "Kilometerregel", value: "200 km je Tag" }] },
  individualAgreements: null,
  terms: { version: "2026-10", text: TERMS_MD, format: "MARKDOWN", blocks: parseTerms(TERMS_MD), legacy: false, title: "Allgemeine Mietbedingungen – Version 2026-10", acknowledgedAt: null },
  signatures: [],
};
export const sampleDocs: Record<string, ContractDocument> = {
  standard: baseDoc,
  agreed: { ...baseDoc, price: { ...baseDoc.price, discount: null, agreed: { text: "Abweichend vereinbart: Sonderpreis Stammkunde", amount: "450,00 €" }, total: "465,00 €", deposit: "keine" }, individualAgreements: "Kindersitz inklusive" },
  accident: {
    ...baseDoc,
    price: { days: 0, openEnd: true, durationText: "Mietende offen – Abrechnung nach tatsächlichen Miettagen", lines: [{ text: "Mietpreis je Miettag (Tagessatz)", amount: "79,00 €" }, { text: "Haftungsreduzierung je Miettag", amount: "15,00 €" }], subtotalLabel: "Summe je Miettag", subtotal: "94,00 €", discount: null, calculated: "nach tatsächlicher Mietdauer", agreed: null, extras: [{ text: "Zustellung (einmalig)", amount: "40,00 €" }], total: "nach tatsächlicher Mietdauer", totalNote: "Gesamtmietpreis = tatsächliche Miettage × 94,00 € + 40,00 € einmalig.", deposit: "keine" },
    terms: { version: null, text: null, format: null, blocks: null, legacy: false, title: "Mietbedingungen", acknowledgedAt: null },
  },
};

export const markupCases: Record<string, () => string> = {
  "CustomerFields:standard": () => r(h(CustomerFields, { values: emptyCustomer })),
  "CustomerFields:firma": () => r(h(CustomerFields, { values: company })),
  "CustomerFields:buchung-c_-compact": () => r(h(CustomerFields, { values: filledCustomer, prefix: "c_", compact: true })),
  "CustomerFields:vertrag-compact": () => r(h(CustomerFields, { values: filledCustomer, compact: true })),
  "CustomerFields:firma-compact": () => r(h(CustomerFields, { values: company, compact: true })),
  "CustomerFields:disabled": () => r(h(CustomerFields, { values: filledCustomer, prefix: "c_", compact: true, disabled: true })),
  "DriverFields:a_": () => r(h(DriverFields, { values: emptyDriver, prefix: "a_" })),
  "DriverFields:d_": () => r(h(DriverFields, { values: filledDriver, prefix: "d_" })),
  "DriverFields:ohne-praefix": () => r(h(DriverFields, { values: filledDriver })),
  "Field:einfach": () => r(h(Field, { label: "Abholort", htmlFor: "pickupLocation", children: h("input", { id: "pickupLocation", name: "pickupLocation", className: "input" }) })),
  "Field:hinweis-voll": () => r(h(Field, { label: "Notiz", htmlFor: "n", hint: "Erscheint nicht im Vertrag", full: true, children: h("textarea", { id: "n", name: "n", className: "input" }) })),
  "ContractTermsText:markdown": () => r(h(ContractTermsText, { blocks: parseTerms(TERMS_MD), text: TERMS_MD })),
  "ContractTermsText:markdown-compact": () => r(h(ContractTermsText, { blocks: parseTerms(TERMS_MD), text: TERMS_MD, compact: true })),
  "ContractTermsText:altbestand": () => r(h(ContractTermsText, { blocks: null, text: "§1 Das Fahrzeug ist pfleglich zu behandeln.", compact: true })),
  "StepForm:schritt-2": () => r(h(StepForm, { action: noop, step: 2, children: h("input", { name: "x" }) })),
  "StepForm:schritt-1": () => r(h(StepForm, { action: noop, step: 1, children: h("input", { name: "x" }) })),
  "StepForm:weiter-ohne-next": () => r(h(StepForm, { action: noop, step: 3, nextLabel: "Weiter", hideNext: true, children: h("span", null, "x") })),
  "FinalizeForm:gesperrt": () => r(h(FinalizeForm, { action: noop, disabled: true, reason: "Es fehlt noch die Unterschrift des Mieters." })),
  "FinalizeForm:frei": () => r(h(FinalizeForm, { action: noop, disabled: false })),
  "FinalizeForm:uebergabe": () => r(h(FinalizeForm, { action: noop, disabled: false, label: "Übergabe abschließen", pendingLabel: "Wird abgeschlossen…" })),
  "WizardProgress:vertrag": () => r(h(WizardProgress, { bookingId: "b1", current: 3, reached: 5 })),
  "WizardProgress:uebergabe": () => r(h(WizardProgress, { bookingId: "b1", current: 2, reached: 2, steps: ["A", "B", "C"], basePath: "/buchungen/b1/uebergabe" })),
  "InlineForm:zusatzfahrer": () => r(h(InlineForm, { action: noop, submitLabel: "Zusatzfahrer hinzufügen", children: h("input", { name: "a_firstName" }) })),
  "SignatureForm:mieter": () => r(h(SignatureForm, { action: noop, role: "RENTER", defaultName: "Erika Muster", seenHash: "abc" })),
  "ContractDocumentView:standard": () => r(h(ContractDocumentView, { doc: sampleDocs.standard })),
  "ContractDocumentView:abweichend": () => r(h(ContractDocumentView, { doc: sampleDocs.agreed, showSignatures: false })),
  "ContractDocumentView:unfallersatz": () => r(h(ContractDocumentView, { doc: sampleDocs.accident, showSignatures: false })),
};
