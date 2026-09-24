// Kennzeichnet ein aufgenommenes Dokumentfoto serverseitig und dauerhaft als Kopie (§ 20 Abs. 2 PAuswG: die
// Ablichtung muss eindeutig und dauerhaft als Kopie erkennbar sein). Es wird nur das gestempelte Bild gespeichert;
// eine unmarkierte Fassung wird nicht zusätzlich aufbewahrt. EXIF-Metadaten werden beim Neucodieren verworfen.
import { createHash } from "node:crypto";

export type StampedImage = { bytes: Buffer; checksum: string; width: number | null; height: number | null };

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Diagonales, halbtransparentes Band mit wiederholtem Schriftzug quer über das gesamte Bild. */
function bannerSvg(width: number, height: number, label: string): string {
  const text = escapeXml(label);
  const diag = Math.ceil(Math.sqrt(width * width + height * height));
  const fontSize = Math.max(16, Math.round(Math.min(width, height) / 14));
  const bandHeight = fontSize * 2.4;
  const rows = Math.max(3, Math.ceil(diag / (bandHeight * 2)));
  let bands = "";
  for (let i = 0; i < rows; i++) {
    const y = i * bandHeight * 2;
    bands += `<rect x="-${diag}" y="${y}" width="${diag * 2}" height="${bandHeight}" fill="rgba(180,0,0,0.55)" />`;
    bands += `<text x="0" y="${y + bandHeight * 0.68}" font-family="sans-serif" font-weight="bold" font-size="${fontSize}" fill="#ffffff" letter-spacing="1">`;
    // Text mehrfach nebeneinander, damit das Band über die ganze Diagonale lesbar ist
    for (let x = -diag; x < diag; x += text.length * fontSize * 0.62 + fontSize * 4) bands += `<tspan x="${x}">${text}</tspan>`;
    bands += `</text>`;
  }
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><g transform="rotate(-28 ${width / 2} ${height / 2})">${bands}</g></svg>`;
}

/**
 * Stempelt ein Bild dauerhaft als Kopie: diagonales Band mit Text quer über das ganze Bild, neu als JPEG codiert
 * (verwirft EXIF). Wirft, wenn das Bild nicht lesbar ist – dann wird nichts unmarkiert gespeichert.
 */
export async function stampAsCopy(bytes: Uint8Array, label: string): Promise<StampedImage> {
  const sharp = (await import("sharp")).default;
  // EXIF-Ausrichtung anwenden und auf die Zielgröße bringen, bevor der Rahmen passgenau erzeugt wird
  const resized = await sharp(bytes).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).toBuffer();
  const meta = await sharp(resized).metadata();
  const width = meta.width ?? 1600;
  const height = meta.height ?? 1200;
  const overlay = Buffer.from(bannerSvg(width, height, label));
  const out = await sharp(resized).composite([{ input: overlay, top: 0, left: 0 }]).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  return { bytes: out, checksum: createHash("sha256").update(out).digest("hex"), width, height };
}
