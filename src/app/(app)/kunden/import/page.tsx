import { requireRole } from "@/lib/auth";
import { Content, PageHeader } from "@/components/ui";
import { ImportWizard } from "./import-wizard";

export const metadata = { title: "Kunden importieren" };

/** Massenimport von Kundenstammdaten (CSV/Excel) aus einer Alt-Software. Nur OWNER wegen der Tragweite. */
export default async function CustomerImportPage() {
  await requireRole("OWNER");
  return (
    <>
      <PageHeader title="Kunden importieren" sub="Kundenstammdaten aus einer Alt-Software übernehmen" />
      <Content>
        <ImportWizard />
      </Content>
    </>
  );
}
