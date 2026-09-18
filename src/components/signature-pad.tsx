"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Unterschriftsfläche für Finger, Stift und Maus (Pointer Events).
 * Das Ergebnis steht als PNG-Data-URL in einem versteckten Feld und geht mit dem Formular an den Server.
 * Es wird nichts im Browser gespeichert.
 */
export function SignaturePad({ name, label, onChange }: { name: string; label: string; onChange?: (hasInk: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const strokes = useRef(0);
  // Die Bilddaten liegen im Zustand. Ein verstecktes Feld verliert einen direkt gesetzten Wert beim Neuzeichnen.
  const [dataUrl, setDataUrl] = useState("");
  const hasInk = dataUrl !== "";

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f1a2e";
  }, []);

  useEffect(() => {
    setup();
  }, [setup]);

  function clear() {
    setup();
    strokes.current = 0;
    setDataUrl("");
    onChange?.(false);
  }

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    e.preventDefault();
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    // Stiftdruck berücksichtigen, wenn das Gerät ihn liefert
    const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
    ctx.lineWidth = 1.4 + pressure * 2.2;
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    strokes.current += 1;
  }

  function up(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    // Erst ab einer echten Linie gilt das Feld als unterschrieben
    if (strokes.current > 8) {
      setDataUrl(e.currentTarget.toDataURL("image/png"));
      if (!hasInk) onChange?.(true);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="label-xs">{label}</span>
        <button type="button" onClick={clear} className="btn !py-1 !px-2.5 text-xs">{hasInk ? "Löschen und neu unterschreiben" : "Löschen"}</button>
      </div>
      <canvas
        ref={canvasRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label={label}
        className="w-full h-44 md:h-52 rounded-md border-2 border-dashed border-line bg-white cursor-crosshair select-none"
        style={{ touchAction: "none" }}
      />
      <input type="hidden" name={name} value={dataUrl} readOnly />
      <span className="text-xs text-ink-3">{hasInk ? "Unterschrift erfasst." : "Bitte hier mit Finger, Stift oder Maus unterschreiben."}</span>
    </div>
  );
}
