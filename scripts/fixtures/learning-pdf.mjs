import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

// Synthetic documents only. No downloaded/private samples or model output.
// Minimal PDF writer also gives browser/API tests the exact expected original bytes.
export function syntheticLearningPdf({ pages = 3, password, javascript = false, xfa = false, oversizedImage = false, nameLength = 0, brokenFilter = false, undefinedFontFunction = false } = {}) {
  const objects = [];
  const add = (content) => { objects.push(Buffer.isBuffer(content) ? content : Buffer.from(content)); return objects.length; };
  const padding = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
  const md5 = (data) => createHash("md5").update(data).digest();
  const padded = (value) => Buffer.concat([Buffer.from(value), padding]).subarray(0, 32);
  const rc4 = (key, bytes) => {
    const s = Array.from({ length: 256 }, (_, i) => i); let j = 0;
    for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
    let i = 0; j = 0; return Buffer.from(bytes.map((byte) => { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; return byte ^ s[(s[i] + s[j]) & 255]; }));
  };
  const id = md5(Buffer.from("SYNTHETIC LEARNING PDF FIXTURE ONLY"));
  const owner = rc4(md5(padded("synthetic-owner")).subarray(0, 5), padded(password ?? ""));
  const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
  const key = md5(Buffer.concat([padded(password ?? ""), owner, permissions, id])).subarray(0, 5);
  const stream = (data, dict = "") => {
    const number = objects.length + 1;
    let bytes = Buffer.from(data);
    if (password !== undefined) {
      const suffix = Buffer.from([number & 255, (number >> 8) & 255, (number >> 16) & 255, 0, 0]);
      bytes = rc4(md5(Buffer.concat([key, suffix])).subarray(0, 10), bytes);
    }
    return add(Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${dict} >>\nstream\n`), bytes, Buffer.from("\nendstream")]));
  };
  add("catalog placeholder"); add("pages placeholder");
  let font;
  if (undefinedFontFunction) {
    // Make a reproducible damaged-hint fixture from PDF.js's bundled SIL-OFL font.
    // No private document/font is embedded. Outlines and character mappings are intact.
    const require = createRequire(import.meta.url);
    const ttf = readFileSync(join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts/LiberationSans-Regular.ttf"));
    const entries = Array.from({ length: ttf.readUInt16BE(4) }, (_, i) => {
      const at = 12 + i * 16;
      return { at, tag: ttf.toString("ascii", at, at + 4), offset: ttf.readUInt32BE(at + 8), length: ttf.readUInt32BE(at + 12) };
    });
    for (const [tag, program] of [["fpgm", [0]], ["prep", [0xb0, 3, 0x2b]]]) {
      const table = entries.find((entry) => entry.tag === tag);
      if (!table || table.length < program.length) throw new Error("Synthetic font table unavailable");
      ttf.fill(0, table.offset, table.offset + table.length);
      Buffer.from(program).copy(ttf, table.offset); table.length = program.length;
      ttf.writeUInt32BE(table.length, table.at + 12);
    }
    const head = entries.find((entry) => entry.tag === "head");
    ttf.writeUInt32BE(0, head.offset + 8);
    const checksum = (bytes) => { let sum = 0; for (let i = 0; i < bytes.length; i += 4) {
      const word = Buffer.alloc(4); bytes.copy(word, 0, i, Math.min(i + 4, bytes.length)); sum = (sum + word.readUInt32BE(0)) >>> 0;
    } return sum; };
    for (const table of entries) ttf.writeUInt32BE(checksum(ttf.subarray(table.offset, table.offset + table.length)), table.at + 4);
    ttf.writeUInt32BE((0xb1b0afba - checksum(ttf)) >>> 0, head.offset + 8);
    const fontFile = stream(ttf, `/Length1 ${ttf.length}`);
    const descriptor = add(`<< /Type /FontDescriptor /FontName /SyntheticHintFont /Flags 32 /FontBBox [-600 -400 2200 2200] /ItalicAngle 0 /Ascent 900 /Descent -220 /CapHeight 700 /StemV 80 /FontFile2 ${fontFile} 0 R >>`);
    font = add(`<< /Type /Font /Subtype /TrueType /BaseFont /SyntheticHintFont /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(556).join(" ")}] /FontDescriptor ${descriptor} 0 R >>`);
  } else font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  // An image-only page: viewing this must never be counted as OCR recognition.
  const pixels = Buffer.alloc(300 * 400 * 3, 250);
  for (let y = 25; y < 375; y++) for (let x = 20; x < 280; x++) {
    if (y < 65 || (y > 100 && y % 34 < 6 && x < 240 - (Math.floor(y / 34) % 3) * 25)) {
      const offset = (y * 300 + x) * 3; pixels[offset] = 40; pixels[offset + 1] = y < 65 ? 85 : 40; pixels[offset + 2] = y < 65 ? 120 : 40;
    }
  }
  const scan = stream(deflateSync(pixels), `/Type /XObject /Subtype /Image /Width ${oversizedImage ? 100000 : 300} /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`);
  const appearance = stream("1 0 0 rg 0 0 150 50 re f 0 0 0 rg BT /F1 10 Tf 8 25 Td (SYNTHETIC ANNOTATION) Tj ET", `/Type /XObject /Subtype /Form /BBox [0 0 150 50] /Resources << /Font << /F1 ${font} 0 R >> >>`);
  const annotation = add(`<< /Type /Annot /Subtype /Stamp /Rect [40 220 190 270] /F 4 /AP << /N ${appearance} 0 R >> >>`);
  const pageIds = [];
  for (let number = 1; number <= pages; number++) {
    const content = number === 3 ? "q 540 0 0 720 30 35 cm /Scan Do Q"
      : `BT /F1 24 Tf 40 735 Td (SYNTHETIC LOCAL PDF - PAGE ${number}) Tj 0 -42 Td /F1 14 Tf (Printed label: ${number + 9}. NOT OCR output.) Tj ET\n0.1 0.35 0.25 RG 2 w 40 350 510 250 re S 40 475 m 550 475 l S 295 350 m 295 600 l S\nBT /F1 18 Tf 60 540 Td (Vector page ${number}) Tj 0 -130 Td (Original bytes retained) Tj ET`;
    const contentId = stream(content, brokenFilter ? "/Filter /SYNTHETIC_UNKNOWN_FILTER" : "");
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] ${number === 2 ? "/Rotate 90 /CropBox [10 20 590 780]" : ""}
      /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Scan ${scan} 0 R >> >> /Contents ${contentId} 0 R ${number === 1 ? `/Annots [${annotation} 0 R]` : ""} >>`));
  }
  const action = javascript ? add("<< /S /JavaScript /JS (globalThis.SYNTHETIC_PDF_SCRIPT_EXECUTED=true;app.alert\(1\);) >>") : null;
  const xfaStream = xfa ? stream("<xdp:xdp xmlns:xdp='http://ns.adobe.com/xdp/'></xdp:xdp>") : null;
  objects[0] = Buffer.from(`<< /Type /Catalog /Pages 2 0 R ${nameLength ? `/${"N".repeat(nameLength)} 1` : ""} ${action ? `/OpenAction ${action} 0 R` : ""} ${xfa ? `/AcroForm << /Fields [] /XFA ${xfaStream} 0 R >>` : ""} >>`);
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages} /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] >>`);
  const encryption = password !== undefined ? add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${rc4(key, padding).toString("hex")}> /P -4 >>`) : null;
  const chunks = [Buffer.from("%PDF-1.7\n%SYNTHETIC-TEST-ONLY\n")]; const offsets = [0]; let size = chunks[0].length;
  for (let i = 0; i < objects.length; i++) { offsets.push(size); const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from("\nendobj\n")]); chunks.push(chunk); size += chunk.length; }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryption ? `/Encrypt ${encryption} 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]` : ""} >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
