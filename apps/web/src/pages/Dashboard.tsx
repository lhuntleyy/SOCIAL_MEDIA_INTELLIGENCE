import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import type { TopicSummary } from "../types";
import { Badge, Card, Empty, ErrorText, fmtTime, PLATFORM_LABEL } from "../ui";

const SENT_COLOR: Record<string, string> = { negative: "#dc2626", neutral: "#a1a1aa", positive: "#16a34a" };
const SENT_LABEL: Record<string, string> = { negative: "Negatif", neutral: "Netral", positive: "Positif" };
const EMO_LABEL: Record<string, string> = {
  anger: "Marah",
  anticipation: "Antisipasi",
  disgust: "Jijik",
  trust: "Percaya",
  joy: "Senang",
  sadness: "Sedih",
  surprise: "Terkejut",
  fear: "Takut",
  unknown: "Tidak jelas",
};
const RANGES = [
  { id: "24h", label: "24 jam", ms: 86_400_000 },
  { id: "7d", label: "7 hari", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 hari", ms: 30 * 86_400_000 },
];
const REFRESH = [
  { id: "off", label: "Off", ms: 0 },
  { id: "5m", label: "5m", ms: 300_000 },
  { id: "15m", label: "15m", ms: 900_000 },
  { id: "30m", label: "30m", ms: 1_800_000 },
  { id: "1h", label: "1j", ms: 3_600_000 },
];

interface Series {
  granularity: string;
  buckets: string[];
  series: { key: string; values: number[] }[];
}
interface Summary {
  current: { posts: number; engagement: number; negative: number; positive: number; authors: number };
  delta_pct: { posts: number | null; engagement: number | null; authors: number | null };
}
interface Post {
  platform: string;
  post_id: string;
  published_at: string;
  sentiment: string;
  sentiment_score: number;
  emotion: string;
  engagement: number | null;
  author_handle: string;
  text: string | null;
  url: string | null;
}

/** Filter di URL (shareable, UI_SPEC §2): ?topic=&range=&refresh= */
function useFilters(topics: TopicSummary[] | undefined) {
  const [sp, setSp] = useSearchParams();
  const topic = sp.get("topic") ?? topics?.[0]?.id ?? "";
  const range = RANGES.find((r) => r.id === sp.get("range")) ?? RANGES[1]!;
  const refresh = REFRESH.find((r) => r.id === sp.get("refresh")) ?? REFRESH[2]!;
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    n.set(k, v);
    setSp(n, { replace: true });
  };
  // jangkar waktu dibulatkan ke 5 menit → query key stabil antar render, bergeser sendiri tiap 5 menit
  const to = new Date(Math.ceil(Date.now() / 300_000) * 300_000);
  const from = new Date(to.getTime() - range.ms);
  return { topic, range, refresh, set, qs: `topic_id=${topic}&from=${from.toISOString()}&to=${to.toISOString()}` };
}

function useA<T>(path: string, qs: string, topic: string, refreshMs: number) {
  return useQuery({
    queryKey: [path, qs],
    queryFn: () => api<T>(`${path}${path.includes("?") ? "&" : "?"}${qs}`),
    enabled: !!topic,
    refetchInterval: refreshMs || false,
  });
}

const Kpi = ({ label, value, delta }: { label: string; value: number | string; delta?: number | null }) => (
  <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
    <div className="text-xs uppercase text-zinc-500">{label}</div>
    <div className="mt-1 flex items-baseline gap-2">
      <span className="text-3xl font-bold tabular-nums">{typeof value === "number" ? value.toLocaleString("id-ID") : value}</span>
      {delta !== undefined && delta !== null && (
        <span className={`text-xs font-medium ${delta >= 0 ? "text-emerald-600" : "text-red-600"}`}>
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}%
        </span>
      )}
    </div>
  </div>
);

export default function Dashboard() {
  const topics = useQuery({ queryKey: ["topics", ""], queryFn: () => api<TopicSummary[]>("/topics?limit=50") });
  const f = useFilters(topics.data);
  const ms = f.refresh.ms;
  const sum = useA<Summary>("/analytics/summary", f.qs, f.topic, ms);
  const prop = useA<{ total: number; items: { sentiment: string; count: number; pct: number }[]; model_versions: string[] }>(
    "/analytics/sentiment/proportion",
    f.qs,
    f.topic,
    ms,
  );
  const tl = useA<Series>("/analytics/sentiment/timeline", f.qs, f.topic, ms);
  const expo = useA<Series>("/analytics/exposure", f.qs, f.topic, ms);
  const emo = useA<{ items: { emotion: string; count: number }[] }>("/analytics/emotion/proportion", f.qs, f.topic, ms);
  const tags = useA<{ items: { hashtag: string; count: number }[] }>("/analytics/hashtags?limit=30", f.qs, f.topic, ms);
  const acc = useA<{ items: { platform: string; handle: string; value: number; followers: number | null }[] }>(
    "/analytics/accounts/top?limit=8",
    f.qs,
    f.topic,
    ms,
  );
  const geo = useA<{ coverage_pct: number; items: { code: string; name: string; count: number }[] }>(
    "/analytics/locations",
    f.qs,
    f.topic,
    ms,
  );
  const posts = useA<Post[]>("/posts?limit=15", f.qs, f.topic, ms);

  const s = sum.data?.current;
  const x = (b: string[]) => b.map((v) => (v.length > 10 ? `${v.slice(5, 10)} ${v.slice(11, 13)}:00` : v.slice(5)));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
        <select
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
          value={f.topic}
          onChange={(e) => f.set("topic", e.target.value)}
        >
          {topics.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-lg border border-zinc-300">
          {RANGES.map((r) => (
            <button
              type="button"
              key={r.id}
              onClick={() => f.set("range", r.id)}
              className={`px-3 py-1.5 text-sm ${r.id === f.range.id ? "bg-brand-600 text-white" : "bg-white hover:bg-zinc-50"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm text-zinc-600">
          ⏱ Auto-refresh
          <select
            className="rounded-lg border border-zinc-300 px-2 py-1 text-sm"
            value={f.refresh.id}
            onChange={(e) => f.set("refresh", e.target.value)}
          >
            {REFRESH.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText error={topics.error ?? sum.error} />
      {!topics.data?.length && !topics.isLoading && <Empty>Belum ada topik — buat topik dulu.</Empty>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Total post" value={s?.posts ?? 0} delta={sum.data?.delta_pct.posts} />
        <Kpi label="Engagement" value={s?.engagement ?? 0} delta={sum.data?.delta_pct.engagement} />
        <Kpi label="Akun unik" value={s?.authors ?? 0} delta={sum.data?.delta_pct.authors} />
        <Kpi label="Negatif" value={s?.posts ? `${Math.round((s.negative / s.posts) * 100)}%` : "—"} />
        <Kpi label="Positif" value={s?.posts ? `${Math.round((s.positive / s.posts) * 100)}%` : "—"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="Proporsi sentimen"
          right={
            prop.data?.model_versions[0] && (
              <span className="max-w-[55%] truncate text-[10px] text-zinc-400">{prop.data.model_versions.join(", ")}</span>
            )
          }
        >
          {prop.data?.total ? (
            <ReactECharts
              style={{ height: 260 }}
              option={{
                tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
                legend: { bottom: 0 },
                series: [
                  {
                    type: "pie",
                    radius: ["45%", "72%"],
                    data: prop.data.items.map((i) => ({
                      name: SENT_LABEL[i.sentiment],
                      value: i.count,
                      itemStyle: { color: SENT_COLOR[i.sentiment] },
                    })),
                  },
                ],
              }}
            />
          ) : (
            <Empty>Belum ada data.</Empty>
          )}
        </Card>
        <div className="lg:col-span-2">
          <Card title="Sentimen dari waktu ke waktu">
            {tl.data?.buckets.length ? (
              <ReactECharts
                style={{ height: 260 }}
                option={{
                  tooltip: { trigger: "axis" },
                  legend: { bottom: 0 },
                  grid: { left: 40, right: 16, top: 16, bottom: 48 },
                  xAxis: { type: "category", data: x(tl.data.buckets) },
                  yAxis: { type: "value" },
                  series: tl.data.series.map((sr) => ({
                    name: SENT_LABEL[sr.key],
                    type: "bar",
                    stack: "s",
                    data: sr.values,
                    itemStyle: { color: SENT_COLOR[sr.key] },
                  })),
                }}
              />
            ) : (
              <Empty>Belum ada data.</Empty>
            )}
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Emosi (persepsi)">
          {emo.data?.items.length ? (
            <ReactECharts
              style={{ height: 280 }}
              option={{
                tooltip: {},
                radar: {
                  indicator: ["anger", "anticipation", "disgust", "trust", "joy", "sadness", "surprise", "fear"].map((k) => ({
                    name: EMO_LABEL[k],
                    max: Math.max(1, ...emo.data!.items.filter((i) => i.emotion !== "unknown").map((i) => i.count)),
                  })),
                },
                series: [
                  {
                    type: "radar",
                    areaStyle: { color: "rgba(220,38,38,0.25)" },
                    lineStyle: { color: "#b91c1c" },
                    data: [
                      {
                        name: "Emosi",
                        value: ["anger", "anticipation", "disgust", "trust", "joy", "sadness", "surprise", "fear"].map(
                          (k) => emo.data!.items.find((i) => i.emotion === k)?.count ?? 0,
                        ),
                      },
                    ],
                  },
                ],
              }}
            />
          ) : (
            <Empty>Belum ada data.</Empty>
          )}
          {emo.data && (
            <p className="text-center text-xs text-zinc-500">
              Tidak jelas: {emo.data.items.find((i) => i.emotion === "unknown")?.count ?? 0} post
            </p>
          )}
        </Card>
        <Card title="Exposure per platform">
          {expo.data?.buckets.length ? (
            <ReactECharts
              style={{ height: 280 }}
              option={{
                tooltip: { trigger: "axis" },
                legend: { bottom: 0 },
                grid: { left: 40, right: 16, top: 16, bottom: 48 },
                xAxis: { type: "category", data: x(expo.data.buckets) },
                yAxis: { type: "value" },
                series: expo.data.series.map((sr) => ({
                  name: PLATFORM_LABEL[sr.key] ?? sr.key,
                  type: "line",
                  smooth: true,
                  areaStyle: {},
                  stack: "e",
                  data: sr.values,
                })),
                color: ["#b91c1c", "#52525b", "#f87171", "#a1a1aa"],
              }}
            />
          ) : (
            <Empty>Belum ada data.</Empty>
          )}
        </Card>
        <Card title="Hashtag teratas">
          {tags.data?.items.length ? (
            <ReactECharts
              style={{ height: 280 }}
              option={{
                tooltip: {},
                series: [
                  {
                    type: "treemap",
                    roam: false,
                    nodeClick: false,
                    breadcrumb: { show: false },
                    data: tags.data.items.map((t, i) => ({
                      name: `#${t.hashtag}`,
                      value: t.count,
                      itemStyle: { color: i % 2 ? "#f87171" : "#b91c1c" },
                    })),
                  },
                ],
              }}
            />
          ) : (
            <Empty>Belum ada hashtag.</Empty>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Akun paling aktif">
          {acc.data?.items.length ? (
            <ul className="divide-y divide-zinc-100 text-sm">
              {acc.data.items.map((a) => (
                <li key={`${a.platform}${a.handle}`} className="flex justify-between py-1.5">
                  <span className="truncate">
                    @{a.handle} <span className="text-xs text-zinc-400">{PLATFORM_LABEL[a.platform] ?? a.platform}</span>
                  </span>
                  <span className="tabular-nums text-zinc-600">{a.value} post</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Belum ada data.</Empty>
          )}
        </Card>
        <Card title="Lokasi (provinsi)" right={geo.data && <span className="text-xs text-zinc-500">cakupan {geo.data.coverage_pct}%</span>}>
          {geo.data?.items.length ? (
            <ReactECharts
              style={{ height: 240 }}
              option={{
                tooltip: {},
                grid: { left: 110, right: 16, top: 8, bottom: 16 },
                xAxis: { type: "value" },
                yAxis: { type: "category", inverse: true, data: geo.data.items.slice(0, 8).map((g) => g.name) },
                series: [{ type: "bar", data: geo.data.items.slice(0, 8).map((g) => g.count), itemStyle: { color: "#b91c1c" } }],
              }}
            />
          ) : (
            <Empty>Lokasi belum terdeteksi.</Empty>
          )}
        </Card>
        <Card title="Post terbaru">
          <ul className="max-h-[260px] space-y-2 overflow-y-auto pr-1">
            {posts.data?.map((p) => (
              <li key={p.post_id} className="rounded-lg border border-zinc-100 p-2">
                <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-700">@{p.author_handle}</span>
                  <span>{fmtTime(`${p.published_at.replace(" ", "T")}Z`)}</span>
                  <Badge tone={p.sentiment === "negative" ? "red" : p.sentiment === "positive" ? "green" : "zinc"}>
                    {SENT_LABEL[p.sentiment]}
                  </Badge>
                  {p.emotion !== "unknown" && <Badge tone="amber">{EMO_LABEL[p.emotion]}</Badge>}
                </div>
                <p className="line-clamp-3 text-sm">{p.text}</p>
                {p.url && !p.url.includes("example.invalid") && (
                  <a href={p.url} target="_blank" rel="noreferrer noopener" className="text-xs text-brand-600 hover:underline">
                    buka post ↗
                  </a>
                )}
              </li>
            ))}
            {posts.data && !posts.data.length && <Empty>Belum ada post.</Empty>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
