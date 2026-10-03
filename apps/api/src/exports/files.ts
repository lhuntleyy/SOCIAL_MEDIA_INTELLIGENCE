// O-06: penulis file export tanpa dependency (compat Bun, ADR-001): CSV (UTF-8 + BOM, aman formula injection) dan XLSX minimal
// (SpreadsheetML: inline string, baris judul tebal, kolom dibekukan) dalam ZIP deflate. CRC32 via Bun.hash.crc32.
import { deflateRawSync } from "node:zlib";

export type Cell = string | number | null | undefined;

/** Sel yang diawali = + - @ (atau tab/CR) bisa dieksekusi sebagai formula oleh spreadsheet → diberi awalan ' (OWASP CSV injection). */
export const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export function toCsv(header: string[], rows: Cell[][]): Uint8Array<ArrayBuffer> {
  const esc = (v: Cell) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(v);
    const s = safeText(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header, ...rows].map((r) => r.map(esc).join(","));
  return new TextEncoder().encode(`﻿${lines.join("\r\n")}\r\n`);
}

const xmlEsc = (s: string) =>
  s
    // karakter kontrol tidak sah di XML 1.0 dibuang
    // biome-ignore lint/suspicious/noControlCharactersInRegex: memang menyaring karakter kontrol
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function sheetXml(header: string[], rows: Cell[][], widths: number[]): string {
  const cell = (v: Cell, ref: string, style = 0) => {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${v}</v></c>`;
    // Excel: maks 32.767 karakter per sel
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlEsc(String(v).slice(0, 32_000))}</t></is></c>`;
  };
  const out: string[] = [];
  out.push(`<row r="1">${header.map((h, i) => cell(h, `${colName(i)}1`, 1)).join("")}</row>`);
  rows.forEach((r, ri) => {
    out.push(`<row r="${ri + 2}">${r.map((v, i) => cell(v, `${colName(i)}${ri + 2}`)).join("")}</row>`);
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const last = `${colName(header.length - 1)}${rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${out.join("")}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}
function zip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const comp = new Uint8Array(deflateRawSync(e.data));
    const crc = Bun.hash.crc32(e.data) >>> 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 nama file
    lh.setUint16(8, 8, true); // deflate
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 8, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    parts.push(new Uint8Array(lh.buffer), name, comp);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const buf = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) {
    buf.set(a, p);
    p += a.length;
  }
  return buf;
}

export function toXlsx(sheetName: string, header: string[], rows: Cell[][], widths: number[] = []): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const w = header.map((_, i) => widths[i] ?? 16);
  const name = xmlEsc(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Data");
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${colName(header.length - 1)}$${rows.length + 1}</definedName></definedNames></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    [
      "xl/styles.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    ],
    ["xl/worksheets/sheet1.xml", sheetXml(header, rows, w)],
  ];
  return zip(files.map(([n, d]) => ({ name: n, data: enc.encode(d) })));
}
