// Mietbedingungen in der Oberfläche: aus der Markdown-Struktur (versionierte Fassung) oder als vorformatierter Altbestand.
// Kein HTML aus dem Text – Blöcke werden ausschließlich aus dem Parser gerendert.
import type { TermsBlock, TextRun } from "@/lib/terms-markdown";

function Runs({ runs }: { runs: TextRun[] }) {
  return <>{runs.map((r, i) => (r.bold ? <strong key={i}>{r.text}</strong> : <span key={i}>{r.text}</span>))}</>;
}

export function TermsBlocksView({ blocks, compact = false }: { blocks: TermsBlock[]; compact?: boolean }) {
  const size = compact ? "text-[13px]" : "text-sm";
  return (
    <div className={`flex flex-col gap-2 ${size} text-ink leading-relaxed`}>
      {blocks.map((b, i) => {
        if (b.type === "heading") {
          if (b.level === 1) return <h3 key={i} className="font-display text-base font-semibold mt-2">{b.text}</h3>;
          if (b.level === 2) return <h4 key={i} className="font-semibold mt-2">{b.text}</h4>;
          return <h5 key={i} className="font-medium mt-1">{b.text}</h5>;
        }
        if (b.type === "paragraph") return <p key={i}><Runs runs={b.runs} /></p>;
        return b.ordered ? (
          <ol key={i} className="list-decimal pl-6 flex flex-col gap-0.5">{b.items.map((it, j) => <li key={j}><Runs runs={it} /></li>)}</ol>
        ) : (
          <ul key={i} className="list-disc pl-6 flex flex-col gap-0.5">{b.items.map((it, j) => <li key={j}><Runs runs={it} /></li>)}</ul>
        );
      })}
    </div>
  );
}

/** Anzeige eines Vertragsbedingungstextes: Markdown-Fassung oder Altbestand als Fließtext. */
export function ContractTermsText({ blocks, text, compact = false }: { blocks: TermsBlock[] | null; text: string | null; compact?: boolean }) {
  if (blocks) return <TermsBlocksView blocks={blocks} compact={compact} />;
  if (!text) return null;
  return <p className={`whitespace-pre-wrap text-ink-2 ${compact ? "text-[13px]" : "text-sm"}`}>{text}</p>;
}
