export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="font-display text-3xl font-bold tracking-tight text-brand">Rent-Base</div>
          <div className="text-ink-3 text-sm">Vermietungssoftware</div>
        </div>
        <div className="card p-6 shadow-[0_8px_24px_-12px_rgba(20,30,50,.18)]">{children}</div>
      </div>
    </main>
  );
}
