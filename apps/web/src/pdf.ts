/**
 * Elemen laporan → PDF A4 berhalaman. Dirender sekali ke canvas (html-to-image: browser sendiri yang menggambar, termasuk warna
 * oklch Tailwind & canvas ECharts), lalu dipotong per halaman di batas elemen `[data-pdf-break]` / baris tabel terdekat agar
 * teks tidak terbelah. Dimuat dinamis → bundle awal tetap kecil.
 */
export async function exportPdf(el: HTMLElement, fileName: string) {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);
  const scale = 2;
  const canvas = await toCanvas(el, { pixelRatio: scale, backgroundColor: "#ffffff", cacheBust: true });
  const top0 = el.getBoundingClientRect().top;
  const breaks = [...el.querySelectorAll<HTMLElement>("[data-pdf-break], tr, h2")]
    .map((b) => Math.round((b.getBoundingClientRect().top - top0) * scale))
    .filter((y) => y > 0)
    .sort((a, b) => a - b);
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const margin = 10;
  const pageW = 210 - margin * 2;
  const pageH = 297 - margin * 2;
  const pxPerMm = canvas.width / pageW;
  const pagePx = Math.floor(pageH * pxPerMm);
  let y = 0;
  let page = 0;
  while (y < canvas.height - 2) {
    const limit = y + pagePx;
    // titik potong: batas elemen terakhir yang masih muat (minimal 40% halaman agar tak banyak halaman kosong)
    const cut = limit >= canvas.height ? canvas.height : (breaks.filter((b) => b > y + pagePx * 0.4 && b <= limit).pop() ?? limit);
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = cut - y;
    slice.getContext("2d")!.drawImage(canvas, 0, y, canvas.width, cut - y, 0, 0, canvas.width, cut - y);
    if (page++) pdf.addPage();
    pdf.addImage(slice.toDataURL("image/jpeg", 0.85), "JPEG", margin, margin, pageW, (cut - y) / pxPerMm);
    pdf.setFontSize(8);
    pdf.setTextColor(150);
    pdf.text(`${page}`, 210 - margin, 297 - 4, { align: "right" });
    y = cut;
  }
  pdf.save(fileName);
}
