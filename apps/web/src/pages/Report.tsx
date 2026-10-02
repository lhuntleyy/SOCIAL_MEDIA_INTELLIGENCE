// Laporan (Resume) topik untuk periode filter: ringkasan naratif otomatis (tanpa LLM — dari angka agregat), chart utama,
// isu/hashtag/akun/lokasi teratas, post paling ramai & sorotan per sentimen. "Unduh PDF" = preview di layar dirender ke PDF A4
// langsung di browser (html-to-image + jspdf, tanpa dialog cetak); "Cetak" tetap tersedia; "Unduh CSV" = post periode ini (≤ 2.000).
import ReactECharts from "echarts-for-react";
import { useRef, useState } from "react";
import {
  EMO_COLOR,
  EMO_LABEL,
  EMOTIONS,
  type Filters,
  fmtN,
  PLATFORM_COLOR,
  type Post,
  platformName,
  SENT_COLOR,
  SENT_LABEL,
  type Series,
  useA,
  xLabels,
} from "../analytics";
import { apiFull, getViewAs } from "../api";
import { useAuth } from "../auth";
import { exportPdf } from "../pdf";
import { Button, fmtTime } from "../ui";
import { type Accounts, AnalyticsPage, type Breakdown, type Geo, type Prop, perPlatform } from "./Dashboard";

interface Summary {
  current: { posts: number; engagement: number; negative: number; positive: number; authors: number };
  delta_pct: { posts: number | null; engagement: number | null; authors: number | null };
}
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const dateId = (d: Date) => d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
const trend = (v: number | null | undefined) =>
  v === null || v === undefined
    ? ""
    : v >= 0
      ? ` (naik ${Math.abs(v)}% dari periode sebelumnya)`
      : ` (turun ${Math.abs(v)}% dari periode sebelumnya)`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="break-inside-avoid" data-pdf-break>
      <h2 className="mb-2 border-b-2 border-brand-600 pb-1 text-sm font-bold uppercase tracking-wide text-zinc-700">{title}</h2>
      {children}
    </section>
  );
}

function Chart({ option, height = 220 }: { option: object; height?: number }) {
  // animasi mati → chart langsung lengkap saat dicetak
  return <ReactECharts style={{ height }} option={{ animation: false, ...option }} />;
}

function csvCell(v: unknown) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function Body({ f }: { f: Filters }) {
  const { me } = useAuth();
  const sum = useA<Summary>(f, "/analytics/summary");
  const prop = useA<Prop<"sentiment">>(f, "/analytics/sentiment/proportion");
  const tl = useA<Series>(f, "/analytics/sentiment/timeline");
  const emo = useA<Prop<"emotion">>(f, "/analytics/emotion/proportion");
  const br = useA<Breakdown>(f, "/analytics/platforms");
  const tags = useA<{ items: { hashtag: string; count: number }[] }>(f, "/analytics/hashtags?limit=10");
  const iss = useA<{ items: { issue: string; count: number }[] }>(f, "/analytics/issues?limit=10");
  const acc = useA<Accounts>(f, "/analytics/accounts/top?limit=10&by=engagement");
  const geo = useA<Geo>(f, "/analytics/locations");
  const top = useA<Post[]>(f, "/posts?limit=10&sort=engagement");
  const neg = useA<Post[]>(f, "/posts?limit=5&sort=engagement&sentiment=negative");
  const posi = useA<Post[]>(f, "/posts?limit=5&sort=engagement&sentiment=positive");
  const neu = useA<Post[]>(f, "/posts?limit=15&sort=engagement&sentiment=neutral");
  const [csv, setCsv] = useState<"idle" | "busy">("idle");
  const [pdf, setPdf] = useState<"idle" | "busy" | "error">("idle");
  const reportRef = useRef<HTMLElement>(null);

  const topic = f.list?.find((t) => t.id === f.topic);
  const office = getViewAs()?.tenantName ?? me?.tenants.find((t) => t.id === me.current_tenant.id)?.name ?? "";
  const s = sum.data?.current;
  const total = s?.posts ?? 0;
  const platforms = perPlatform(br.data, ["post", "reply", "comment", "repost", "quote"]);
  const emoTop = [...(emo.data?.items ?? [])].filter((i) => i.emotion !== "unknown").sort((a, b) => b.count - a.count);
  const sentTop = [...(prop.data?.items ?? [])].sort((a, b) => b.count - a.count)[0];

  const narrative = total
    ? [
        `Selama periode ${dateId(f.from)} – ${dateId(f.to)}, topik "${topic?.name ?? ""}" dibicarakan dalam ${fmtN(total)} post${trend(sum.data?.delta_pct.posts)} oleh ${fmtN(s?.authors ?? 0)} akun unik, dengan total engagement ${fmtN(s?.engagement ?? 0)}.`,
        sentTop
          ? `Sentimen didominasi ${SENT_LABEL[sentTop.sentiment]?.toLowerCase()} (${sentTop.pct}%); negatif ${pct(s?.negative ?? 0, total)}% dan positif ${pct(s?.positive ?? 0, total)}%.`
          : "",
        emoTop[0]
          ? `Emosi yang paling menonjol: ${emoTop
              .slice(0, 3)
              .map((e) => `${EMO_LABEL[e.emotion]?.toLowerCase()} (${e.pct}%)`)
              .join(", ")}.`
          : "",
        platforms[0]
          ? `Percakapan paling banyak di ${platforms
              .slice(0, 3)
              .map(([p, n]) => `${platformName(p)} (${pct(n, total)}%)`)
              .join(", ")}.`
          : "",
        iss.data?.items.length
          ? `Isu yang paling banyak dibicarakan: ${iss.data.items
              .slice(0, 5)
              .map((i) => `"${i.issue}"`)
              .join(", ")}.`
          : "",
        tags.data?.items.length
          ? `Hashtag teratas: ${tags.data.items
              .slice(0, 5)
              .map((t) => `#${t.hashtag}`)
              .join(", ")}.`
          : "",
        geo.data?.items.length
          ? `Lokasi yang terdeteksi (${geo.data.coverage_pct}% post) terbanyak dari ${geo.data.items
              .slice(0, 3)
              .map((g) => g.name)
              .join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "Belum ada post pada periode ini.";

  const downloadCsv = async () => {
    setCsv("busy");
    try {
      const rows: Post[] = [];
      const base = `/posts?${f.qs}&limit=100&sort=latest`;
      for (let off = 0; off < 2000; off += 100) {
        const page = (await apiFull<Post[]>(`${base}&offset=${off}`)).data;
        rows.push(...page);
        if (page.length < 100) break;
      }
      const head = ["waktu_utc", "platform", "jenis", "akun", "nama", "sentimen", "emosi", "engagement", "hashtag", "url", "teks"];
      const lines = rows.map((p) =>
        [
          p.published_at,
          p.platform,
          p.content_type,
          p.author_handle,
          p.author_name,
          p.sentiment,
          p.emotion,
          p.engagement,
          p.hashtags.join(" "),
          p.url,
          p.text,
        ]
          .map(csvCell)
          .join(","),
      );
      const blob = new Blob([`﻿${[head.join(","), ...lines].join("\n")}`], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${fileBase}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setCsv("idle");
    }
  };

  const fileBase = `laporan-${(topic?.name ?? "topik").replace(/[^\w-]+/g, "_")}-${f.from.toISOString().slice(0, 10)}_${f.to.toISOString().slice(0, 10)}`;
  const downloadPdf = async () => {
    if (!reportRef.current) return;
    setPdf("busy");
    try {
      await exportPdf(reportRef.current, `${fileBase}.pdf`);
      setPdf("idle");
    } catch {
      setPdf("error");
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button onClick={() => void downloadPdf()} disabled={pdf === "busy"}>
          {pdf === "busy" ? "Membuat PDF…" : "Unduh PDF"}
        </Button>
        <Button variant="ghost" onClick={() => window.print()}>
          Cetak
        </Button>
        <Button variant="ghost" onClick={() => void downloadCsv()} disabled={csv === "busy"}>
          {csv === "busy" ? "Menyiapkan…" : "Unduh data post (CSV)"}
        </Button>
        <span className="self-center text-xs text-zinc-500">
          {pdf === "error"
            ? "Gagal membuat PDF — coba lagi atau gunakan Cetak."
            : "Pratinjau di bawah = isi PDF. Laporan mengikuti topik, rentang waktu & platform yang dipilih di atas."}
        </span>
      </div>
      <article
        ref={reportRef}
        className="report space-y-5 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm print:border-0 print:p-0 print:shadow-none"
      >
        <header className="flex flex-wrap items-end justify-between gap-2 border-b border-zinc-200 pb-3">
          <div>
            <div className="text-xs uppercase tracking-widest text-brand-600">Laporan monitoring media sosial</div>
            <h1 className="text-2xl font-bold">{topic?.name}</h1>
            <div className="text-sm text-zinc-600">
              {dateId(f.from)} – {dateId(f.to)}
              {f.platform ? ` · ${platformName(f.platform)}` : " · semua platform"}
            </div>
          </div>
          <div className="text-right text-xs text-zinc-500">
            {office && <div>{office}</div>}
            <div>Dibuat {fmtTime(new Date().toISOString())}</div>
          </div>
        </header>

        <Section title="Ringkasan">
          <p className="text-sm leading-relaxed text-zinc-800">{narrative}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              ["Post", fmtN(total)],
              ["Akun unik", fmtN(s?.authors ?? 0)],
              ["Engagement", fmtN(s?.engagement ?? 0)],
              ["Negatif", `${pct(s?.negative ?? 0, total)}%`],
              ["Positif", `${pct(s?.positive ?? 0, total)}%`],
            ].map(([l, v]) => (
              <div key={l} className="rounded-lg border border-zinc-200 p-2 text-center">
                <div className="text-lg font-bold tabular-nums">{v}</div>
                <div className="text-xs text-zinc-500">{l}</div>
              </div>
            ))}
          </div>
        </Section>

        <div className="grid gap-5 md:grid-cols-2 print:grid-cols-2">
          <Section title="Sentimen dari waktu ke waktu">
            {tl.data && (
              <Chart
                option={{
                  legend: { bottom: 0 },
                  grid: { left: 36, right: 8, top: 8, bottom: 40 },
                  xAxis: { type: "category", data: xLabels(tl.data.buckets) },
                  yAxis: { type: "value" },
                  series: tl.data.series.map((x) => ({
                    name: SENT_LABEL[x.key],
                    type: "line",
                    data: x.values,
                    itemStyle: { color: SENT_COLOR[x.key] },
                    lineStyle: { color: SENT_COLOR[x.key] },
                  })),
                }}
              />
            )}
          </Section>
          <Section title="Emosi">
            <Chart
              option={{
                grid: { left: 80, right: 16, top: 4, bottom: 20 },
                xAxis: { type: "value" },
                yAxis: { type: "category", inverse: true, data: EMOTIONS.map((k) => EMO_LABEL[k]) },
                series: [
                  {
                    type: "bar",
                    data: EMOTIONS.map((k) => ({
                      value: emo.data?.items.find((i) => i.emotion === k)?.count ?? 0,
                      itemStyle: { color: EMO_COLOR[k] },
                    })),
                  },
                ],
              }}
            />
          </Section>
          <Section title="Platform">
            <Chart
              option={{
                series: [
                  {
                    type: "pie",
                    radius: ["35%", "65%"],
                    label: { formatter: "{b} ({d}%)" },
                    data: platforms.map(([p, n]) => ({ name: platformName(p), value: n, itemStyle: { color: PLATFORM_COLOR[p] } })),
                  },
                ],
              }}
            />
          </Section>
          <Section title="Isu, hashtag, akun & lokasi teratas">
            <div className="grid grid-cols-4 gap-3 text-xs">
              <ol className="list-decimal space-y-0.5 pl-4">
                {iss.data?.items.map((i) => (
                  <li key={i.issue}>
                    {i.issue} <span className="text-zinc-400">{fmtN(i.count)}</span>
                  </li>
                ))}
              </ol>
              <ol className="list-decimal space-y-0.5 pl-4">
                {tags.data?.items.map((t) => (
                  <li key={t.hashtag}>
                    #{t.hashtag} <span className="text-zinc-400">{fmtN(t.count)}</span>
                  </li>
                ))}
              </ol>
              <ol className="list-decimal space-y-0.5 pl-4">
                {acc.data?.items.map((a) => (
                  <li key={`${a.platform}${a.author_id}`} className="truncate">
                    @{a.handle} <span className="text-zinc-400">{fmtN(a.value)}</span>
                  </li>
                ))}
              </ol>
              <ol className="list-decimal space-y-0.5 pl-4">
                {geo.data?.items.slice(0, 10).map((g) => (
                  <li key={g.code}>
                    {g.name} <span className="text-zinc-400">{fmtN(g.count)}</span>
                  </li>
                ))}
              </ol>
            </div>
            <p className="mt-1 text-[10px] text-zinc-400">
              Isu (jumlah post) · hashtag (jumlah post) · akun (engagement) · provinsi (jumlah post)
            </p>
          </Section>
        </div>

        {[
          { title: "Post paling ramai", rows: top.data },
          { title: "Sorotan sentimen negatif", rows: neg.data },
          { title: "Sorotan sentimen positif", rows: posi.data },
          // tanpa post yang sudah tampil di "Post paling ramai" (netral teramai biasanya sama persis)
          {
            title: "Sorotan sentimen netral",
            rows: neu.data?.filter((p) => !top.data?.some((t) => t.platform === p.platform && t.post_id === p.post_id)).slice(0, 5),
          },
        ].map((sec) => (
          <Section key={sec.title} title={sec.title}>
            {sec.rows?.length ? (
              <table className="w-full text-xs">
                <tbody className="divide-y divide-zinc-100 align-top">
                  {sec.rows.map((p) => (
                    <tr key={`${p.platform}${p.post_id}`} className="break-inside-avoid">
                      <td className="w-28 py-1.5 pr-2 text-zinc-500">
                        {platformName(p.platform)}
                        <br />
                        {fmtTime(`${p.published_at.replace(" ", "T")}Z`)}
                      </td>
                      <td className="py-1.5 pr-2">
                        <b>@{p.author_handle}</b> <span className="text-zinc-600">{(p.text ?? "").slice(0, 280)}</span>
                        {p.url && !p.url.includes("example.invalid") && <div className="truncate text-[10px] text-zinc-400">{p.url}</div>}
                      </td>
                      <td className="w-24 py-1.5 text-right">
                        <span className="font-medium" style={{ color: SENT_COLOR[p.sentiment] }}>
                          {SENT_LABEL[p.sentiment]}
                        </span>
                        <br />⚡ {p.engagement === null ? "—" : fmtN(p.engagement)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-zinc-500">Tidak ada.</p>
            )}
          </Section>
        ))}
        <footer className="border-t border-zinc-200 pt-2 text-[10px] text-zinc-400">
          Lokasi hanya dari post yang lokasinya terdeteksi. Engagement = like + komentar + share (+ view bila tersedia).
        </footer>
      </article>
    </>
  );
}

export default function Report() {
  return <AnalyticsPage title="Laporan">{(f) => <Body f={f} />}</AnalyticsPage>;
}
