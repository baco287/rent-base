// Kleiner Layout-Helfer über pdfkit: DIN A4, Kopf- und Fußzeile auf jeder Seite, Abschnitte, Wertepaare,
// Tabellen mit Seitenumbruch, Bilder ohne Verzerrung. Alles, was gezeichnet wird, landet zusätzlich in einem
// Prüfprotokoll (trace). Damit können Tests ohne PDF-Parser feststellen, ob Text abgeschnitten, eine Unterschrift
// verzerrt oder ein Schadenmarker außerhalb der Skizze gelandet wäre.

import path from "node:path";
import PDFDocument from "pdfkit";

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");
const FONT_REGULAR = path.join(FONT_DIR, "IBMPlexSans-Regular.woff");
const FONT_BOLD = path.join(FONT_DIR, "IBMPlexSans-SemiBold.woff");

export const COLORS = { ink: "#1a2230", ink2: "#4a5568", ink3: "#7a8494", line: "#d5dae2", soft: "#f1f3f6", brand: "#16325c", bad: "#b23a32", good: "#2f7d4f", warn: "#8a5a00", existing: "#4a5568" };

export type PdfTrace = {
  pages: number;
  texts: string[];
  /** Jede platzierte Textbox. overflow = true hieße: passt nicht in den vorgesehenen Bereich. */
  boxes: { page: number; x: number; y: number; w: number; h: number; overflow: boolean }[];
  images: { kind: "signature" | "photo" | "logo"; naturalW: number; naturalH: number; w: number; h: number }[];
  markers: { index: number; marker: string; symbol: string; view: string; cx: number; cy: number; r: number; frame: { x: number; y: number; w: number; h: number } }[];
  notes: string[];
};

export type PdfMeta = {
  title: string; // z. B. "Mietvertrag"
  number: string;
  /** logo: Bilddaten des eingefrorenen Logo-Verweises (Befehl 20.5); ohne Logo exakt der bisherige Briefkopf */
  landlord: { name: string; address: string; contact: string; logoImage?: Uint8Array | null };
  /** Unten links, zwei Zeilen: Bezeichnung und Wert, z. B. die Prüfsumme des versiegelten Inhalts */
  footerNote?: { label: string; value: string };
  /** Unten rechts unter der Seitenzahl, z. B. „Mietbedingungen Version 1.2“ */
  footerLine?: string;
};

export type Column = { header: string; width: number; align?: "left" | "right"; bold?: boolean };
export type Cell = string | { text: string; color?: string; bold?: boolean };

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { left: 48, right: 48, top: 92, bottom: 58 };
const LOGO_BOX = { w: 110, h: 40 };

export class Pdf {
  readonly doc: PDFKit.PDFDocument;
  readonly trace: PdfTrace = { pages: 0, texts: [], boxes: [], images: [], markers: [], notes: [] };
  readonly left = MARGIN.left;
  readonly width = PAGE.width - MARGIN.left - MARGIN.right;
  private chunks: Buffer[] = [];
  private done: Promise<Buffer>;
  private pageIndex = 0;

  constructor(private meta: PdfMeta) {
    this.doc = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN.top, bottom: MARGIN.bottom, left: MARGIN.left, right: MARGIN.right },
      font: FONT_REGULAR,
      bufferPages: true,
      info: { Title: `${meta.title} ${meta.number}`, Author: meta.landlord.name, Subject: meta.title, Creator: "Rent-Base", Producer: "Rent-Base" },
    });
    this.doc.registerFont("regular", FONT_REGULAR);
    this.doc.registerFont("bold", FONT_BOLD);
    this.doc.on("pageAdded", () => { this.pageIndex += 1; });
    this.done = new Promise<Buffer>((resolve, reject) => {
      this.doc.on("data", (c: Buffer) => this.chunks.push(c));
      this.doc.on("end", () => resolve(Buffer.concat(this.chunks)));
      this.doc.on("error", reject);
    });
    this.doc.font("regular").fontSize(9.5).fillColor(COLORS.ink);
  }

  get y() { return this.doc.y; }
  set y(v: number) { this.doc.y = v; }
  get bottom() { return PAGE.height - MARGIN.bottom; }
  get remaining() { return this.bottom - this.doc.y; }

  /** Beginnt eine neue Seite, wenn die angegebene Höhe nicht mehr passt. */
  ensureSpace(height: number) {
    if (this.doc.y + height > this.bottom + 0.5) this.newPage();
  }

  newPage() {
    this.doc.addPage();
    this.doc.x = this.left;
    this.doc.y = MARGIN.top;
  }

  gap(h = 8) { this.doc.y += h; }

  private style(opts: { size?: number; bold?: boolean; color?: string }) {
    this.doc.font(opts.bold ? "bold" : "regular").fontSize(opts.size ?? 9.5).fillColor(opts.color ?? COLORS.ink);
  }

  /** Höhe eines Textes bei gegebener Breite und Schrift. */
  measure(text: string, width: number, opts: { size?: number; bold?: boolean } = {}) {
    this.style(opts);
    return this.doc.heightOfString(text || " ", { width });
  }

  /** Text an fester Stelle. Die Höhe ergibt sich aus dem Umbruch, abgeschnitten wird nie. */
  textAt(text: string, x: number, y: number, width: number, opts: { size?: number; bold?: boolean; color?: string; align?: "left" | "right" | "center" } = {}) {
    const value = text ?? "";
    this.style(opts);
    const h = this.doc.heightOfString(value || " ", { width });
    this.trace.texts.push(value);
    this.trace.boxes.push({ page: this.pageIndex, x, y, w: width, h, overflow: x < this.left - 0.5 || x + width > this.left + this.width + 0.5 || y + h > this.bottom + 1 });
    this.doc.text(value, x, y, { width, align: opts.align ?? "left" });
    return h;
  }

  /** Fließtext über die volle Breite; lange Texte brechen von selbst auf Folgeseiten um. */
  paragraph(text: string, opts: { size?: number; bold?: boolean; color?: string; gapAfter?: number } = {}) {
    this.style(opts);
    this.trace.texts.push(text);
    const lineH = this.doc.currentLineHeight(true);
    if (this.doc.y + lineH > this.bottom) this.newPage();
    this.style(opts);
    this.doc.text(text, this.left, this.doc.y, { width: this.width, align: "left" });
    this.doc.y += opts.gapAfter ?? 4;
  }

  /** Fließtext aus Läufen (normal/fett) in einer Zeile fortlaufend gesetzt; bricht von selbst um. */
  richParagraph(runs: { text: string; bold: boolean }[], opts: { size?: number; color?: string; gapAfter?: number; indent?: number; bullet?: string } = {}) {
    const size = opts.size ?? 9.5;
    const indent = opts.indent ?? 0;
    const text = runs.map((r) => r.text).join("");
    this.trace.texts.push(text);
    this.style({ size });
    const lineH = this.doc.currentLineHeight(true);
    if (this.doc.y + lineH > this.bottom) this.newPage();
    const y = this.doc.y;
    if (opts.bullet) { this.style({ size, color: opts.color }); this.doc.text(opts.bullet, this.left + Math.max(0, indent - 14), y, { width: 14, lineBreak: false }); }
    const x = this.left + indent;
    const width = this.width - indent;
    this.doc.x = x;
    this.doc.y = y;
    const parts = runs.filter((r) => r.text.length > 0);
    if (parts.length === 0) { this.doc.text(" ", x, y, { width }); this.doc.y += opts.gapAfter ?? 4; return; }
    parts.forEach((r, i) => {
      this.style({ size, bold: r.bold, color: opts.color });
      this.doc.text(r.text, i === 0 ? x : undefined, i === 0 ? y : undefined, { width, continued: i < parts.length - 1, align: "left" });
    });
    this.doc.x = this.left;
    this.doc.y += opts.gapAfter ?? 4;
  }

  documentTitle(title: string, lines: string[]) {
    this.textAt(title, this.left, this.doc.y, this.width, { size: 18, bold: true, color: COLORS.brand });
    this.doc.y += 2;
    for (const l of lines) { this.textAt(l, this.left, this.doc.y, this.width, { size: 9.5, color: COLORS.ink2 }); }
    this.gap(10);
  }

  sectionTitle(title: string, keepWithNext = 46) {
    this.ensureSpace(22 + keepWithNext);
    this.gap(6);
    const y = this.doc.y;
    this.textAt(title.toUpperCase(), this.left, y, this.width, { size: 9, bold: true, color: COLORS.brand });
    const lineY = this.doc.y + 2;
    this.doc.moveTo(this.left, lineY).lineTo(this.left + this.width, lineY).lineWidth(0.8).strokeColor(COLORS.brand).stroke();
    this.doc.y = lineY + 6;
  }

  /** Nutzbare Höhe einer Seite zwischen Kopf- und Fußzeile. */
  get pageBodyHeight() { return this.bottom - MARGIN.top; }

  /** Beschriftung und danach der Wert als Fließtext, der von selbst auf Folgeseiten umbricht. */
  flowingValue(label: string, value: string, opts: { bold?: boolean; color?: string } = {}) {
    this.ensureSpace(24);
    this.textAt(label, this.left, this.doc.y, this.width, { size: 8.5, color: COLORS.ink3 });
    this.paragraph(value, { size: 9.5, bold: opts.bold, color: opts.color, gapAfter: 5 });
  }

  /** Wertepaare in ein oder zwei Spalten. Jede Zeile wird so hoch wie ihr längster Inhalt. */
  keyValues(rows: { label: string; value: string }[], columns: 1 | 2 = 2) {
    const colGap = 18;
    const colW = columns === 2 ? (this.width - colGap) / 2 : this.width;
    const labelW = columns === 2 ? 92 : 130;
    const valueW = colW - labelW - 6;
    // Lange Werte bekommen eine eigene Zeile über die volle Breite, statt in einer schmalen Spalte zu stehen
    const groups: { label: string; value: string }[][] = [];
    let open: { label: string; value: string }[] = [];
    for (const r of rows) {
      if (columns === 2 && r.value.length > 70) { if (open.length) groups.push(open); groups.push([r]); open = []; continue; }
      open.push(r);
      if (open.length === columns) { groups.push(open); open = []; }
    }
    if (open.length) groups.push(open);
    for (const group of groups) {
      if (columns === 2 && group.length === 1 && group[0].value.length > 70) {
        const r = group[0];
        const wideW = this.width - labelW - 6;
        const rowH = Math.max(this.measure(r.label, labelW, { size: 8.5 }), this.measure(r.value, wideW, { size: 9.5 })) + 4;
        if (rowH > this.pageBodyHeight) { this.flowingValue(r.label, r.value); continue; }
        this.ensureSpace(rowH);
        const y = this.doc.y;
        this.textAt(r.label, this.left, y + 0.6, labelW, { size: 8.5, color: COLORS.ink3 });
        this.textAt(r.value, this.left + labelW + 6, y, wideW, { size: 9.5 });
        this.doc.y = y + rowH;
        continue;
      }
      const heights = group.map((r) => Math.max(this.measure(r.label, labelW, { size: 8.5 }), this.measure(r.value, valueW, { size: 9.5 })));
      const rowH = Math.max(...heights) + 4;
      if (rowH > this.pageBodyHeight) { for (const r of group) this.flowingValue(r.label, r.value); continue; }
      this.ensureSpace(rowH);
      const y = this.doc.y;
      group.forEach((r, c) => {
        const x = this.left + c * (colW + colGap);
        this.textAt(r.label, x, y + 0.6, labelW, { size: 8.5, color: COLORS.ink3 });
        this.textAt(r.value, x + labelW + 6, y, valueW, { size: 9.5 });
      });
      this.doc.y = y + rowH;
    }
  }

  /** Tabelle mit Kopfzeile. Bricht zeilenweise um und wiederholt den Kopf auf der neuen Seite. */
  table(columns: Column[], rows: Cell[][], opts: { zebra?: boolean } = {}) {
    const pad = 4;
    const total = columns.reduce((s, c) => s + c.width, 0);
    const scale = this.width / total;
    const widths = columns.map((c) => c.width * scale);
    const drawHeader = () => {
      const h = Math.max(...columns.map((c, i) => this.measure(c.header, widths[i] - pad * 2, { size: 8, bold: true }))) + pad * 2;
      this.ensureSpace(h + 18);
      const y = this.doc.y;
      this.doc.rect(this.left, y, this.width, h).fill(COLORS.soft);
      let x = this.left;
      columns.forEach((c, i) => { this.textAt(c.header, x + pad, y + pad, widths[i] - pad * 2, { size: 8, bold: true, color: COLORS.ink2, align: c.align }); x += widths[i]; });
      this.doc.y = y + h;
    };
    drawHeader();
    rows.forEach((row, ri) => {
      const cells = row.map((c) => (typeof c === "string" ? { text: c } : c));
      const h = Math.max(...cells.map((c, i) => this.measure(c.text, widths[i] - pad * 2, { size: 9, bold: c.bold ?? columns[i].bold }))) + pad * 2;
      if (h > this.pageBodyHeight) {
        // Eine Zeile, die länger als eine Seite ist: Zellen untereinander als Fließtext, damit nichts abgeschnitten wird
        this.ensureSpace(40);
        cells.forEach((c, i) => { if (c.text) this.flowingValue(columns[i].header || "", c.text, { bold: c.bold ?? columns[i].bold, color: c.color }); });
        this.doc.moveTo(this.left, this.doc.y).lineTo(this.left + this.width, this.doc.y).lineWidth(0.4).strokeColor(COLORS.line).stroke();
        this.doc.y += 2;
        return;
      }
      if (this.doc.y + h > this.bottom) { this.newPage(); drawHeader(); }
      const y = this.doc.y;
      if (opts.zebra && ri % 2 === 1) this.doc.rect(this.left, y, this.width, h).fill("#fafbfc");
      let x = this.left;
      cells.forEach((c, i) => { this.textAt(c.text, x + pad, y + pad, widths[i] - pad * 2, { size: 9, bold: c.bold ?? columns[i].bold, color: c.color, align: columns[i].align }); x += widths[i]; });
      this.doc.moveTo(this.left, y + h).lineTo(this.left + this.width, y + h).lineWidth(0.4).strokeColor(COLORS.line).stroke();
      this.doc.y = y + h;
    });
    this.gap(6);
  }

  /** Bild in einen Rahmen einpassen, Seitenverhältnis bleibt immer erhalten. */
  imageFit(kind: "signature" | "photo", bytes: Uint8Array, x: number, y: number, boxW: number, boxH: number) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img = (this.doc as any).openImage(Buffer.from(bytes)) as { width: number; height: number };
    const s = Math.min(boxW / img.width, boxH / img.height);
    const w = img.width * s;
    const h = img.height * s;
    this.doc.image(img as unknown as string, x + (boxW - w) / 2, y + (boxH - h) / 2, { width: w, height: h });
    this.trace.images.push({ kind, naturalW: img.width, naturalH: img.height, w, h });
    return { w, h };
  }

  note(text: string) { this.trace.notes.push(text); }

  private logoCache: { img: { width: number; height: number }; w: number; h: number } | null | undefined;
  /** Logo einmal öffnen; ein nicht lesbares Logo verhindert das Dokument nie (dann ohne Logo). */
  private headerLogo() {
    if (this.logoCache !== undefined) return this.logoCache;
    this.logoCache = null;
    const bytes = this.meta.landlord.logoImage;
    if (!bytes || bytes.length === 0) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const img = (this.doc as any).openImage(Buffer.from(bytes)) as { width: number; height: number };
      const s = Math.min(LOGO_BOX.w / img.width, LOGO_BOX.h / img.height);
      this.logoCache = { img, w: img.width * s, h: img.height * s };
    } catch {
      this.trace.notes.push("Logo nicht lesbar – Briefkopf ohne Logo");
    }
    return this.logoCache;
  }

  /** Kopf- und Fußzeilen auf allen Seiten ergänzen und das PDF abschließen. */
  async finish(): Promise<{ bytes: Buffer; trace: PdfTrace }> {
    const range = this.doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      this.doc.switchToPage(range.start + i);
      this.pageIndex = i;
      // Außerhalb des Satzspiegels zeichnen, ohne dass pdfkit eine neue Seite beginnt
      const m = this.doc.page.margins;
      const saved = { top: m.top, bottom: m.bottom };
      m.top = 0;
      m.bottom = 0;
      const right = this.left + this.width;
      // Logo links im Kopf (höchstens 110 × 40 pt, Seitenverhältnis bleibt), Name und Anschrift rücken daneben
      const logo = this.headerLogo();
      const textX = logo ? this.left + LOGO_BOX.w + 12 : this.left;
      const textW = (w: number) => (logo ? w - LOGO_BOX.w - 12 : w);
      if (logo) {
        this.doc.image(logo.img as unknown as string, this.left, 28 + (LOGO_BOX.h - logo.h) / 2, { width: logo.w, height: logo.h });
        if (i === 0) this.trace.images.push({ kind: "logo", naturalW: logo.img.width, naturalH: logo.img.height, w: logo.w, h: logo.h });
      }
      this.style({ size: 11, bold: true, color: COLORS.brand });
      this.doc.text(this.meta.landlord.name, textX, 34, { width: textW(this.width * 0.6), lineBreak: false, ellipsis: true });
      this.style({ size: 7.5, color: COLORS.ink3 });
      this.doc.text([this.meta.landlord.address, this.meta.landlord.contact].filter(Boolean).join("  ·  "), textX, 50, { width: textW(this.width * 0.68), height: 20, ellipsis: true });
      this.style({ size: 9, bold: true, color: COLORS.ink });
      this.doc.text(this.meta.title, right - 200, 34, { width: 200, align: "right", lineBreak: false });
      this.style({ size: 8.5, color: COLORS.ink2 });
      this.doc.text(this.meta.number, right - 200, 47, { width: 200, align: "right", lineBreak: false });
      this.doc.moveTo(this.left, 74).lineTo(right, 74).lineWidth(0.8).strokeColor(COLORS.line).stroke();

      const fy = PAGE.height - 44;
      this.doc.moveTo(this.left, fy - 6).lineTo(right, fy - 6).lineWidth(0.5).strokeColor(COLORS.line).stroke();
      this.style({ size: 7, color: COLORS.ink3 });
      if (this.meta.footerNote) {
        this.doc.text(this.meta.footerNote.label, this.left, fy, { width: this.width - 100, lineBreak: false });
        this.doc.text(this.meta.footerNote.value, this.left, fy + 9.5, { width: this.width - 100, lineBreak: false });
      }
      this.style({ size: 8, color: COLORS.ink2 });
      this.doc.text(`Seite ${i + 1} von ${range.count}`, right - 90, fy, { width: 90, align: "right", lineBreak: false });
      if (this.meta.footerLine) { this.style({ size: 7, color: COLORS.ink3 }); this.doc.text(this.meta.footerLine, right - 220, fy + 9.5, { width: 220, align: "right", lineBreak: false, ellipsis: true }); }
      m.top = saved.top;
      m.bottom = saved.bottom;
    }
    this.trace.pages = range.count;
    this.doc.end();
    return { bytes: await this.done, trace: this.trace };
  }
}
