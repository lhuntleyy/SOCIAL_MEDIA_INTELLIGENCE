// Compat paket frontend Laporan → PDF (Golden Rule 8): html-to-image (DOM → PNG, dirender browser sendiri — aman untuk warna
// oklch Tailwind v4 yang tidak didukung html2canvas) + jspdf (PNG → PDF A4). Diuji: (1) jspdf di runtime Bun menghasilkan PDF
// valid dengan gambar; (2) keduanya ter-bundle `vite build` via `bun --bun`. Perilaku DOM html-to-image diuji di browser (UI).
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, type Check } from "./types";

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const webPdfCheck: Check = {
  id: "web-pdf",
  task: "U-07",
  packages: ["jspdf", "html-to-image"],
  async run() {
    const root = `${import.meta.dir}/../..`;
    const { jsPDF } = await import(`${root}/apps/web/node_modules/jspdf/dist/jspdf.node.min.js`);
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    doc.addImage(PNG_1PX, "PNG", 10, 10, 20, 20);
    doc.addPage();
    doc.text("SMIP", 10, 10);
    const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
    assert(new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-", "output diawali %PDF-");
    assert(doc.getNumberOfPages() === 2, "2 halaman");

    const dir = await mkdtemp(join(tmpdir(), "smip-webpdf-"));
    try {
      await writeFile(
        join(dir, "index.html"),
        `<!doctype html><html><body><div id="r">x</div><script type="module" src="/main.js"></script></body></html>`,
      );
      await writeFile(
        join(dir, "main.js"),
        `import { toPng } from "${root}/apps/web/node_modules/html-to-image/es/index.js";\nimport { jsPDF } from "${root}/apps/web/node_modules/jspdf/dist/jspdf.es.min.js";\nwindow.go = async () => new jsPDF().addImage(await toPng(document.getElementById("r")), "PNG", 0, 0, 10, 10);\n`,
      );
      await writeFile(join(dir, "vite.config.mjs"), `export default { logLevel: "error" };\n`);
      const proc = Bun.spawn([process.execPath, "--bun", `${root}/node_modules/vite/bin/vite.js`, "build"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      assert(code === 0, `vite build exit ${code}: ${(err || out).slice(-300)}`);
      const assets = await readdir(join(dir, "dist", "assets"));
      assert(
        assets.some((a) => a.endsWith(".js")),
        "bundle js ada",
      );
      return {
        status: "COMPATIBLE",
        notes: [
          `jspdf (runtime Bun): PDF 2 halaman + gambar PNG valid (${bytes.length} byte)`,
          `html-to-image + jspdf ter-bundle vite build (bun --bun): ${assets.length} asset. DOM → PNG diuji di browser (halaman Laporan)`,
        ],
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
