// Fahrzeugskizze im PDF: Die SVG-Datei der im Protokoll festgehaltenen Skizzenfassung wird serverseitig gelesen
// und als Vektorgrafik gezeichnet. Kein Browser, kein Screenshot. Unterstützt wird der Umfang, den Skizzen
// verwenden: Gruppen mit translate/scale/matrix, path, rect, circle, ellipse, line, polyline, polygon, Strichmuster.
// Schadenmarker entstehen aus denselben normalisierten Koordinaten (0 bis 1) wie in der Oberfläche.

import { COLORS, type Pdf } from "@/lib/pdf/layout";
import type { DamageSymbol, DocDamage, SketchView } from "@/lib/handover-view";

type Matrix = [number, number, number, number, number, number];
export type SketchShape =
  | { type: "path"; d: string }
  | { type: "rect"; x: number; y: number; w: number; h: number; r: number }
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number }
  | { type: "poly"; points: number[]; closed: boolean };
export type SketchElement = { shape: SketchShape; matrix: Matrix; dash: number[] | null; strokeWidth: number; stroke: string };
export type SketchModel = { elements: SketchElement[]; skipped: string[] };

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (a: Matrix, b: Matrix): Matrix => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const nums = (s: string | undefined) => (s ?? "").split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
const num = (s: string | undefined, fallback = 0) => { const n = Number(s); return Number.isFinite(n) ? n : fallback; };

function parseTransform(value: string | undefined): Matrix {
  let m = IDENTITY;
  for (const t of (value ?? "").matchAll(/(translate|scale|matrix)\s*\(([^)]*)\)/g)) {
    const a = nums(t[2]);
    if (t[1] === "translate") m = mul(m, [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]);
    else if (t[1] === "scale") m = mul(m, [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]);
    else if (a.length === 6) m = mul(m, a as Matrix);
  }
  return m;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;

/** Liest eine Skizzendatei in ein einfaches Zeichenmodell. Unbekannte Elemente werden übersprungen und vermerkt. */
export function parseSketchSvg(svg: string): SketchModel {
  const elements: SketchElement[] = [];
  const skipped: string[] = [];
  const clean = svg.replace(/<!--[\s\S]*?-->/g, "");
  type Ctx = { matrix: Matrix; dash: number[] | null; strokeWidth: number; stroke: string };
  const stack: Ctx[] = [{ matrix: IDENTITY, dash: null, strokeWidth: 3, stroke: COLORS.ink }];
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [, closing, name, rest, selfClosing] = m;
    const top = stack[stack.length - 1];
    if (closing) { if ((name === "g" || name === "svg") && stack.length > 1) stack.pop(); continue; }
    const a = attrs(rest);
    const ctx: Ctx = {
      matrix: mul(top.matrix, parseTransform(a.transform)),
      dash: a["stroke-dasharray"] ? (a["stroke-dasharray"] === "none" ? null : nums(a["stroke-dasharray"])) : top.dash,
      strokeWidth: a["stroke-width"] ? num(a["stroke-width"], top.strokeWidth) : top.strokeWidth,
      stroke: a.stroke && SAFE_COLOR.test(a.stroke) ? a.stroke : top.stroke,
    };
    if (name === "svg" || name === "g") { if (!selfClosing) stack.push(ctx); continue; }
    let shape: SketchShape | null = null;
    if (name === "path" && a.d) shape = { type: "path", d: a.d };
    else if (name === "rect") shape = { type: "rect", x: num(a.x), y: num(a.y), w: num(a.width), h: num(a.height), r: num(a.rx ?? a.ry) };
    else if (name === "circle") shape = { type: "circle", cx: num(a.cx), cy: num(a.cy), r: num(a.r) };
    else if (name === "ellipse") shape = { type: "ellipse", cx: num(a.cx), cy: num(a.cy), rx: num(a.rx), ry: num(a.ry) };
    else if (name === "line") shape = { type: "line", x1: num(a.x1), y1: num(a.y1), x2: num(a.x2), y2: num(a.y2) };
    else if ((name === "polyline" || name === "polygon") && a.points) shape = { type: "poly", points: nums(a.points), closed: name === "polygon" };
    if (shape) elements.push({ shape, ...ctx });
    else if (!["title", "desc", "defs", "style"].includes(name)) skipped.push(name);
  }
  return { elements, skipped };
}

export type Frame = { x: number; y: number; w: number; h: number };

/** Zeichnet eine Ansicht der Skizze in den Rahmen und setzt die Schadenmarker darauf. */
export function drawSketchView(pdf: Pdf, model: SketchModel, view: SketchView, frame: Frame, damages: DocDamage[]) {
  const doc = pdf.doc;
  const [bx, by, bw, bh] = view.box;
  const s = Math.min(frame.w / bw, frame.h / bh);
  const w = bw * s;
  const h = bh * s;
  const x0 = frame.x + (frame.w - w) / 2;
  const y0 = frame.y + (frame.h - h) / 2;

  doc.save();
  doc.rect(x0, y0, w, h).clip();
  doc.translate(x0 - bx * s, y0 - by * s).scale(s);
  for (const el of model.elements) {
    doc.save();
    doc.transform(...el.matrix);
    const sh = el.shape;
    if (sh.type === "path") doc.path(sh.d);
    else if (sh.type === "rect") { if (sh.r > 0) doc.roundedRect(sh.x, sh.y, sh.w, sh.h, sh.r); else doc.rect(sh.x, sh.y, sh.w, sh.h); }
    else if (sh.type === "circle") doc.circle(sh.cx, sh.cy, sh.r);
    else if (sh.type === "ellipse") doc.ellipse(sh.cx, sh.cy, sh.rx, sh.ry);
    else if (sh.type === "line") doc.moveTo(sh.x1, sh.y1).lineTo(sh.x2, sh.y2);
    else if (sh.type === "poly" && sh.points.length >= 4) {
      doc.moveTo(sh.points[0], sh.points[1]);
      for (let i = 2; i + 1 < sh.points.length; i += 2) doc.lineTo(sh.points[i], sh.points[i + 1]);
      if (sh.closed) doc.closePath();
    }
    if (el.dash && el.dash.length > 0) doc.dash(el.dash[0], { space: el.dash[1] ?? el.dash[0] }); else doc.undash();
    doc.lineWidth(Math.max(el.strokeWidth, 1.2 / s)).lineJoin("round").lineCap("round").strokeColor(el.stroke).stroke();
    doc.restore();
  }
  doc.restore();

  // Marker in Seitenkoordinaten, damit sie unabhängig vom Maßstab gleich groß und gut lesbar sind
  const r = 5.2;
  for (const d of damages.filter((x) => x.view === view.key)) {
    const cx = Math.min(x0 + w - r, Math.max(x0 + r, x0 + Math.min(1, Math.max(0, d.posX)) * w));
    const cy = Math.min(y0 + h - r, Math.max(y0 + r, y0 + Math.min(1, Math.max(0, d.posY)) * h));
    drawMarker(pdf, d.symbol, d.index, cx, cy, r);
    pdf.trace.markers.push({ index: d.index, marker: d.marker, symbol: d.symbol, view: view.key, cx, cy, r, frame: { x: x0, y: y0, w, h } });
  }
  return { x: x0, y: y0, w, h };
}

/**
 * Kreis = vor der Miete dokumentiert, Raute = bei Übergabe dokumentierter Vorschaden, Dreieck = bei Rückgabe festgestellt.
 * Form und Farbe unterscheiden sich, damit die Einstufung auch im Schwarz-Weiß-Druck erkennbar bleibt.
 */
export function drawMarker(pdf: Pdf, symbol: DamageSymbol, index: number | null, cx: number, cy: number, r: number) {
  const doc = pdf.doc;
  doc.save();
  doc.undash();
  if (symbol === "triangle") {
    const k = r * 1.45;
    doc.moveTo(cx, cy - k).lineTo(cx + k * 0.95, cy + k * 0.75).lineTo(cx - k * 0.95, cy + k * 0.75).closePath();
    doc.lineWidth(0.8).fillAndStroke(COLORS.warn, "#ffffff");
  } else if (symbol === "diamond") {
    const k = r * 1.25;
    doc.moveTo(cx, cy - k).lineTo(cx + k, cy).lineTo(cx, cy + k).lineTo(cx - k, cy).closePath();
    doc.lineWidth(0.8).fillAndStroke(COLORS.bad, "#ffffff");
  } else {
    doc.circle(cx, cy, r).lineWidth(0.8).fillAndStroke(COLORS.existing, "#ffffff");
  }
  if (index != null) {
    doc.font("bold").fontSize(6.2).fillColor("#ffffff");
    const label = String(index);
    const tw = doc.widthOfString(label);
    doc.text(label, cx - tw / 2, cy - doc.currentLineHeight() / 2 + (symbol === "triangle" ? 1.4 : 0.2), { lineBreak: false });
  }
  doc.restore();
}
