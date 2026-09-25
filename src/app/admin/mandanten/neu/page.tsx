import { requirePlatform } from "@/lib/platform-auth";
import { Card, Content, PageHeader } from "@/components/ui";
import { CreateTenantForm } from "./form";

export const metadata = { title: "Neue Autovermietung" };
export const dynamic = "force-dynamic";

export default async function NewTenantPage() {
  await requirePlatform();
  return (
    <>
      <PageHeader title="Neue Autovermietung" sub="Legt den Mandanten an und lädt den ersten Inhaber ein" />
      <Content className="max-w-xl">
        <Card>
          <div className="p-5">
            <CreateTenantForm />
          </div>
        </Card>
      </Content>
    </>
  );
}
