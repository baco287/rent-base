import { requireSession } from "@/lib/auth";
import { ROLES, type Role } from "@/lib/constants";
import { Sidebar } from "@/components/sidebar";
import { logoutAction } from "@/app/(auth)/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, tenant } = await requireSession();

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-[220px_1fr] min-h-screen">
      <Sidebar
        tenantName={tenant.name}
        tenantCity={tenant.city}
        userName={user.name}
        userRole={ROLES[user.role as Role] ?? user.role}
        logoutAction={logoutAction}
      />
      <main className="min-w-0 flex flex-col">{children}</main>
    </div>
  );
}
