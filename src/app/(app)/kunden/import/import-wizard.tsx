"use client";

// Import-Assistent: Datei hochladen (Parsing serverseitig) → Spalten zuordnen → Prüflauf mit Fehlern/Dubletten →
// Bestätigen. Die eigentliche Validierung und Anlage passiert immer serverseitig (siehe /api/kunden/import/*);
// hier wird nur der Ablauf gesteuert und angezeigt.
import { useState } from "react";
import Link from "next/link";
import { Card, Chip } from "@/components/ui";

type ImportFieldKey = string;
type Field = { key: ImportFieldKey; label: string; required?: boolean };
type RowResult = {
  row: number;
  ok: boolean;
  errors: string[];
  duplicateOf?: { id: string; number: string | null; name: string } | null;
  preview?: { name: string; companyName: string | null; email: string | null; legacyNumber: string | null };
};

type Step = "upload" | "mapping" | "preview" | "done";

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export function ImportWizard() {
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fields, setFields] = useState<Field[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});

  const [results, setResults] = useState<RowResult[]>([]);
  const [included, setIncluded] = useState<boolean[]>([]);

  const [createdCount, setCreatedCount] = useState(0);

  function reset() {
    setStep("upload"); setError(null); setFields([]); setHeaders([]); setRows([]); setMapping({}); setResults([]); setIncluded([]); setCreatedCount(0);
  }

  async function onFile(file: File) {
    setBusy(true); setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch("/api/kunden/import/parse", { method: "POST", body });
      const j = await readJson(res);
      if (!res.ok) throw new Error((j.error as string) ?? "Die Datei konnte nicht gelesen werden.");
      setFields(j.fields as Field[]);
      setHeaders(j.headers as string[]);
      setRows(j.rows as string[][]);
      setMapping(j.suggestedMapping as Record<string, number>);
      setStep("mapping");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function rawRowsForMapping(): Record<string, string>[] {
    return rows.map((row) => {
      const raw: Record<string, string> = {};
      for (const f of fields) {
        const idx = mapping[f.key];
        if (idx != null && row[idx] != null) raw[f.key] = row[idx];
      }
      return raw;
    });
  }

  async function runValidation() {
    if (mapping.firstName == null || mapping.lastName == null) { setError("Bitte mindestens Vorname und Nachname einer Spalte zuordnen."); return; }
    setBusy(true); setError(null);
    try {
      const raw = rawRowsForMapping();
      const res = await fetch("/api/kunden/import/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: raw.map((r) => ({ raw: r })) }) });
      const j = await readJson(res);
      if (!res.ok) throw new Error((j.error as string) ?? "Der Prüflauf ist fehlgeschlagen.");
      const rr = j.results as RowResult[];
      setResults(rr);
      setIncluded(rr.map((r) => r.ok && !r.duplicateOf));
      setStep("preview");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    setBusy(true); setError(null);
    try {
      const raw = rawRowsForMapping();
      const payload = raw
        .map((r, i) => ({ raw: r, force: !!results[i]?.duplicateOf, include: included[i] }))
        .filter((r) => r.include)
        .map(({ raw: r, force: f }) => ({ raw: r, force: f }));
      const res = await fetch("/api/kunden/import/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: payload }) });
      const j = await readJson(res);
      if (!res.ok) throw new Error((j.error as string) ?? "Der Import ist fehlgeschlagen.");
      setCreatedCount(j.created as number);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const toInclude = included.filter(Boolean).length;
  const errorCount = results.filter((r) => !r.ok).length;
  const dupCount = results.filter((r) => r.ok && r.duplicateOf).length;

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="text-bad bg-bad-soft rounded-md px-3.5 py-2.5 text-sm">{error}</p>}

      {step === "upload" && (
        <Card title="1 · Datei hochladen">
          <div className="p-4 flex flex-col gap-3">
            <p className="text-sm text-ink-2 max-w-[70ch]">CSV- oder Excel-Datei (.csv, .xlsx) mit den Kundendaten aus der Alt-Software. Die Kopfzeile wird automatisch erkannt; die Spaltenzuordnung erfolgt im nächsten Schritt.</p>
            <input type="file" accept=".csv,.txt,.xlsx,.xls" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} className="input" />
            {busy && <p className="text-sm text-ink-3">Wird gelesen…</p>}
          </div>
        </Card>
      )}

      {step === "mapping" && (
        <Card title="2 · Spalten zuordnen" right={<Chip>{rows.length} Zeilen</Chip>}>
          <div className="p-4 flex flex-col gap-3">
            <p className="text-sm text-ink-2">Ordne jeder RentBase-Spalte die passende Spalte aus deiner Datei zu. Pflichtfelder sind markiert.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="text-left">
                    <th className="label-xs px-3 py-2 border-b border-line">RentBase-Feld</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Spalte in der Datei</th>
                    <th className="label-xs px-3 py-2 border-b border-line">Beispiel</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f) => {
                    const idx = mapping[f.key];
                    const sample = idx != null ? rows.slice(0, 3).map((r) => r[idx]).filter(Boolean).join(" · ") : "";
                    return (
                      <tr key={f.key} className="border-b border-line-soft last:border-0">
                        <td className="px-3 py-2 font-medium">{f.label}{f.required && <span className="text-bad"> *</span>}</td>
                        <td className="px-3 py-2">
                          <select className="input !min-h-[34px]" value={idx ?? ""} onChange={(e) => setMapping((m) => { const v = e.target.value; const next = { ...m }; if (v === "") delete next[f.key]; else next[f.key] = Number(v); return next; })}>
                            <option value="">— nicht zuordnen —</option>
                            {headers.map((h, i) => <option key={i} value={i}>{h || `Spalte ${i + 1}`}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-ink-3 text-xs max-w-[24ch] truncate">{sample}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={reset} className="btn" disabled={busy}>Andere Datei</button>
              <button type="button" onClick={runValidation} className="btn btn-primary" disabled={busy}>{busy ? "Wird geprüft…" : "Weiter zur Prüfung"}</button>
            </div>
          </div>
        </Card>
      )}

      {step === "preview" && (
        <Card title="3 · Prüfung" right={<Chip tone={errorCount ? "amber" : "good"}>{toInclude} von {results.length} werden angelegt</Chip>}>
          <div className="p-4 flex flex-col gap-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <Chip tone="good">{results.filter((r) => r.ok && !r.duplicateOf).length} in Ordnung</Chip>
              {dupCount > 0 && <Chip tone="amber">{dupCount} mögliche Dubletten</Chip>}
              {errorCount > 0 && <Chip tone="bad">{errorCount} mit Fehlern</Chip>}
            </div>
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left sticky top-0 bg-panel">
                    <th className="label-xs px-2 py-2 border-b border-line">Übernehmen</th>
                    <th className="label-xs px-2 py-2 border-b border-line">Zeile</th>
                    <th className="label-xs px-2 py-2 border-b border-line">Name</th>
                    <th className="label-xs px-2 py-2 border-b border-line">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} className="border-b border-line-soft last:border-0">
                      <td className="px-2 py-1.5"><input type="checkbox" checked={included[i] ?? false} disabled={!r.ok} onChange={(e) => setIncluded((arr) => arr.map((v, j) => (j === i ? e.target.checked : v)))} className="size-4" /></td>
                      <td className="px-2 py-1.5 font-mono tnum text-ink-3">{r.row}</td>
                      <td className="px-2 py-1.5">{r.preview?.companyName || r.preview?.name || "–"}</td>
                      <td className="px-2 py-1.5">
                        {!r.ok ? <span className="text-bad text-xs">{r.errors.join("; ")}</span>
                          : r.duplicateOf ? <span className="text-amber text-xs">Möglich bereits vorhanden: {r.duplicateOf.name}{r.duplicateOf.number ? ` (${r.duplicateOf.number})` : ""} – Häkchen setzen, um trotzdem anzulegen.</span>
                          : <span className="text-good text-xs">In Ordnung</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep("mapping")} className="btn" disabled={busy}>Zurück zur Zuordnung</button>
              <button type="button" onClick={runCommit} className="btn btn-primary" disabled={busy || toInclude === 0}>{busy ? "Wird importiert…" : `${toInclude} Kunden importieren`}</button>
            </div>
          </div>
        </Card>
      )}

      {step === "done" && (
        <Card title="Import abgeschlossen">
          <div className="p-4 flex flex-col gap-3">
            <p className="text-good font-medium">{createdCount} Kunde{createdCount === 1 ? "" : "n"} angelegt.</p>
            <div className="flex gap-2">
              <Link href="/kunden" className="btn btn-primary">Zur Kundenliste</Link>
              <button type="button" onClick={reset} className="btn">Weitere Datei importieren</button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
