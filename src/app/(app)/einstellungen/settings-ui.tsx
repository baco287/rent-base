// Befehl 29.3.1: Bausteine der Einstellungsseiten – Seitenkopf in der Inhaltsspalte (statt der vollbreiten Kopfleiste)
// und Abschnitte mit Beschreibung links und Formular rechts. Reine Darstellung, keine Logik.
import type { ReactNode } from "react";

/** Kopf einer Einstellungsseite: Titel, kurze Beschreibung, optionale Aktionen (gleiche Props wie PageHeader). */
export function SettingsHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-5 md:px-6 pt-5 md:pt-6 flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[24px] font-semibold">{title}</h1>
        {sub && <div className="mt-1 max-w-[720px] text-[13.5px] text-ink-2">{sub}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** Abschnitt: links Titel und Hinweis, rechts der Inhalt (ab 1280 px nebeneinander, darunter untereinander). */
export function SettingsSection({ title, description, children, id }: { title: string; description?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="grid grid-cols-1 xl:grid-cols-[220px_minmax(0,1fr)] gap-x-8 gap-y-3 py-6 border-t border-line-soft first:border-t-0 first:pt-2 scroll-mt-4">
      <div>
        <h2 className="font-sans text-[14.5px] font-semibold">{title}</h2>
        {description && <div className="mt-1 text-[12.5px] text-ink-3">{description}</div>}
      </div>
      <div className="min-w-0 flex flex-col gap-4">{children}</div>
    </section>
  );
}
