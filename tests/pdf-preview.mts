// Erzeugt Beispiel-PDFs zur Sichtprüfung: npx tsx tests/pdf-preview.mts [Zielordner]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderContractPdf } from "../src/lib/pdf/contract-pdf";
import { renderHandoverPdf } from "../src/lib/pdf/handover-pdf";
import { shrinkPhoto } from "../src/lib/documents";
import { contractData, handoverData, photoJpeg, signaturePng, sketchSvg } from "./pdf-fixtures";

const out = path.resolve(process.argv[2] ?? ".pdf-preview");
await mkdir(out, { recursive: true });
const sig = await signaturePng();
const signatures = new Map([["sig-renter", sig], ["sig-employee", await signaturePng(600, 300)]]);

for (const v of ["short", "long"] as const) {
  const { bytes, trace } = await renderContractPdf(contractData(v), signatures);
  await writeFile(path.join(out, `mietvertrag-${v}.pdf`), bytes);
  console.log(`mietvertrag-${v}.pdf`, `${Math.round(bytes.length / 1024)} KB`, `${trace.pages} Seiten`, `Überläufe: ${trace.boxes.filter((b) => b.overflow).length}`);
}

for (const v of ["empty", "full"] as const) {
  const data = handoverData(v);
  const photos = new Map<string, Uint8Array>();
  for (const p of [...data.photos.map((x) => ({ id: x.id, label: x.categoryLabel })), ...data.damages.flatMap((d) => d.photos.map((x) => ({ id: x.id, label: `Schaden ${d.index}` })))]) {
    const small = await shrinkPhoto(await photoJpeg(p.label));
    if (small) photos.set(p.id, small);
  }
  const { bytes, trace } = await renderHandoverPdf(data, { sketchSvg: await sketchSvg(), photos, signatures });
  await writeFile(path.join(out, `uebergabe-${v}.pdf`), bytes);
  console.log(`uebergabe-${v}.pdf`, `${Math.round(bytes.length / 1024)} KB`, `${trace.pages} Seiten`, `Überläufe: ${trace.boxes.filter((b) => b.overflow).length}`, `Marker: ${trace.markers.length}`, `Hinweise: ${trace.notes.join("; ") || "keine"}`);
}
