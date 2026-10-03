import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { safeText, toCsv, toXlsx } from "../src/exports/files";

/** Pembaca ZIP minimal (local header berurutan) — memverifikasi CRC & isi tiap entry. */
function unzip(buf: Uint8Array) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Record<string, string> = {};
  let p = 0;
  while (v.getUint32(p, true) === 0x04034b50) {
    const crc = v.getUint32(p + 14, true);
    const size = v.getUint32(p + 18, true);
    const n = v.getUint16(p + 26, true);
    const name = new TextDecoder().decode(buf.subarray(p + 30, p + 30 + n));
    const data = new Uint8Array(inflateRawSync(buf.subarray(p + 30 + n, p + 30 + n + size)));
    expect(Bun.hash.crc32(data) >>> 0).toBe(crc);
    out[name] = new TextDecoder().decode(data);
    p += 30 + n + size;
  }
  expect(v.getUint32(buf.length - 22, true)).toBe(0x06054b50);
  return out;
}

describe("export files (O-06)", () => {
  test("CSV: BOM, kutip, angka, kosong, formula injection dinetralkan", () => {
    const s = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      toCsv(
        ["a", "b", "c"],
        [
          ["x,y", 3, null],
          ["=1+1", '"q"', "-2"],
        ],
      ),
    );
    expect(s).toBe('﻿a,b,c\r\n"x,y",3,\r\n\'=1+1,"""q""",\'-2\r\n');
    expect(safeText("@x")).toBe("'@x");
    expect(safeText("ok")).toBe("ok");
  });
  test("XLSX: ZIP sah (CRC), bagian wajib ada, sel inline ter-escape, angka numerik, karakter kontrol dibuang", () => {
    const f = unzip(
      toXlsx(
        "Topik: A/B",
        ["Teks", "Suka"],
        [
          ["<b>&\u0001", 5],
          [null, null],
        ],
      ),
    );
    expect(Object.keys(f).sort()).toEqual(
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        "xl/workbook.xml",
        "xl/worksheets/sheet1.xml",
      ].sort(),
    );
    const sheet = f["xl/worksheets/sheet1.xml"]!;
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">&lt;b&gt;&amp;</t></is></c><c r="B2"><v>5</v></c>');
    expect(sheet).toContain('<row r="3"></row>');
    expect(sheet).toContain('<dimension ref="A1:B3"/>');
    expect(f["xl/workbook.xml"]).toContain('<sheet name="Topik  A B"');
  });
});
