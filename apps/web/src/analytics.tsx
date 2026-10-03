// Kerangka halaman analitik: filter global di URL (UI_SPEC §2, shareable), hook data, dan DRILL-DOWN — setiap chart bisa
// diklik → popup berisi post di balik angka itu (+ "jadikan filter" untuk platform / rentang waktu).
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, apiFull } from "./api";
import { useAuth } from "./auth";
import type { TopicDetail, TopicSummary } from "./types";
import { Badge, Button, Card, Empty, fmtTime, Modal, PLATFORM_LABEL, Select } from "./ui";

export const SENT_COLOR: Record<string, string> = { negative: "#b91c1c", neutral: "#52525b", positive: "#1d4ed8" };
export const SENT_LABEL: Record<string, string> = { negative: "Negatif", neutral: "Netral", positive: "Positif" };
export const EMOTIONS = ["anticipation", "anger", "disgust", "trust", "joy", "fear", "surprise", "sadness"] as const;
export const EMO_LABEL: Record<string, string> = {
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
export const EMO_COLOR: Record<string, string> = {
  anticipation: "#ea7a0c",
  anger: "#e11d48",
  disgust: "#7e57c2",
  trust: "#84cc16",
  joy: "#eab308",
  fear: "#047857",
  surprise: "#0891b2",
  sadness: "#1d4ed8",
};
export const PLATFORM_COLOR: Record<string, string> = {
  x: "#1d9bf0",
  threads: "#16a34a",
  tiktok: "#27272a",
  instagram: "#c13584",
  facebook: "#1e40af",
  youtube: "#dc2626",
};
export const CT_LABEL: Record<string, string> = {
  post: "Post",
  reply: "Balasan",
  comment: "Komentar",
  repost: "Repost",
  quote: "Quote",
};

const RANGES = [
  { id: "24h", label: "24 jam", ms: 86_400_000 },
  { id: "7d", label: "7 hari", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 hari", ms: 30 * 86_400_000 },
];
// Kontrol tunggal "Update data" (keputusan pemilik 2026-10-03): kecepatan PENGAMBILAN data topik di server — tersimpan di topik,
// sama untuk semua pengguna kantor, dibatasi kecepatan tercepat paket owner per platform. Tampilan ikut memuat data baru
// otomatis; tidak ada lagi "auto-refresh" terpisah. 0 = Mati (topik dijeda → tidak ada pengambilan, tidak ada biaya).
export const SPEEDS = [
  { sec: 0, label: "Mati (jeda)" },
  { sec: 300, label: "Tiap 5 menit" },
  { sec: 900, label: "Tiap 15 menit" },
  { sec: 1800, label: "Tiap 30 menit" },
  { sec: 3600, label: "Tiap 1 jam" },
  { sec: 10_800, label: "Tiap 3 jam" },
  { sec: 21_600, label: "Tiap 6 jam" },
  { sec: 86_400, label: "Tiap 24 jam" },
];
export const fmtInterval = (sec: number) =>
  sec % 86_400 === 0 ? `${sec / 86_400} hari` : sec % 3600 === 0 ? `${sec / 3600} jam` : `${Math.round(sec / 60)} menit`;
/** Tampilan dimuat ulang tiap min(kecepatan, 5 menit) — data baru & label AI muncul tanpa menunggu satu interval penuh (gratis: baca DB). */
const VIEW_REFRESH_MAX_MS = 300_000;
const PARAM_KEYS = ["topic", "range", "from", "to", "platform"];

export interface Series {
  granularity: "1h" | "1d";
  buckets: string[];
  series: { key: string; values: number[] }[];
}
export interface Post {
  platform: string;
  post_id: string;
  published_at: string;
  sentiment: string;
  emotion: string;
  engagement: number | null;
  content_type: string;
  hashtags: string[];
  author_id: string;
  author_handle: string;
  author_name: string | null;
  author_followers: number | null;
  text: string | null;
  url: string | null;
  model_version?: string;
}

// Filter terakhir diingat (localStorage) → pindah halaman / buka ulang tetap di topik & rentang yang sama.
// URL tetap sumber utama (link bisa dibagikan); nilai tersimpan hanya mengisi yang tidak ada di URL.
const STORE_KEY = "smip.filters";
function loadStored(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function saveStored(v: Record<string, string>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* storage tidak tersedia → hanya URL */
  }
}
function effectiveParams(sp: URLSearchParams) {
  const stored = loadStored();
  const out: Record<string, string> = {};
  for (const k of PARAM_KEYS) {
    const v = sp.has(k) ? sp.get(k) : stored[k];
    if (v) out[k] = v;
  }
  return out;
}

/** Query-string filter analitik untuk link antar halaman (topik/rentang/platform ikut terbawa). */
export function useFilterSearch() {
  const [sp] = useSearchParams();
  const s = new URLSearchParams(effectiveParams(sp)).toString();
  return s ? `?${s}` : "";
}

export function useFilters() {
  const topics = useQuery({ queryKey: ["topics", "all"], queryFn: () => api<TopicSummary[]>("/topics?limit=100") });
  const [sp, setSp] = useSearchParams();
  const p = effectiveParams(sp);
  const list = topics.data?.filter((t) => t.status !== "archived");
  // topik tersimpan bisa milik kantor lain (mis. setelah "lihat data") → hanya dipakai bila ada di daftar
  const topic = (p.topic && (!list || list.some((t) => t.id === p.topic)) ? p.topic : list?.[0]?.id) ?? "";
  const platform = p.platform ?? "";
  const current = list?.find((t) => t.id === topic);
  // topik dijeda (Update data = Mati) → tidak ada data baru → tampilan juga tidak perlu dimuat ulang
  const paused = current?.status === "paused";
  const speedSec = paused ? 0 : (current?.default_interval_sec ?? 3600);
  const refresh = { ms: current && !paused ? Math.min(speedSec * 1000, VIEW_REFRESH_MAX_MS) : 0 };
  const custom = p.range === "custom" && p.from && p.to;
  const range = custom ? null : (RANGES.find((r) => r.id === p.range) ?? RANGES[1]!);
  // jangkar waktu dibulatkan ke 5 menit → query key stabil antar render, bergeser sendiri tiap 5 menit
  const to = custom ? new Date(p.to!) : new Date(Math.ceil(Date.now() / 300_000) * 300_000);
  const from = custom ? new Date(p.from!) : new Date(to.getTime() - range!.ms);
  const set = (kv: Record<string, string | null>) => {
    const n = new URLSearchParams(sp);
    n.delete("refresh"); // parameter lama — kini kecepatan "Update data" topik
    const stored: Record<string, string> = { ...p, topic };
    for (const [k, v] of Object.entries(kv)) {
      if (v === null || v === "") {
        n.delete(k);
        delete stored[k];
      } else {
        n.set(k, v);
        stored[k] = v;
      }
    }
    for (const [k, v] of Object.entries(stored)) if (!n.has(k)) n.set(k, v);
    saveStored(stored);
    setSp(n, { replace: true });
  };
  // filter dari URL (mis. link "Lihat dashboard" / link yang dibagikan) juga diingat
  const snapshot = JSON.stringify({ ...p, ...(topic ? { topic } : {}) });
  useEffect(() => {
    if (snapshot !== JSON.stringify(loadStored())) saveStored(JSON.parse(snapshot) as Record<string, string>);
  }, [snapshot]);
  const qs = `topic_id=${topic}&from=${from.toISOString()}&to=${to.toISOString()}${platform ? `&platforms=${platform}` : ""}`;
  return { topics, list, topic, current, platform, range, custom: !!custom, from, to, refresh, paused, speedSec, set, qs };
}
export type Filters = ReturnType<typeof useFilters>;

export function useA<T>(f: Filters, path: string) {
  return useQuery({
    queryKey: [path, f.qs],
    queryFn: () => api<T>(`${path}${path.includes("?") ? "&" : "?"}${f.qs}`),
    enabled: !!f.topic,
    refetchInterval: f.refresh.ms || false,
    placeholderData: keepPreviousData,
  });
}

export function FilterBar({ f, title }: { f: Filters; title: string }) {
  const platforms = useQuery({
    queryKey: ["platforms"],
    queryFn: () => api<{ code: string; name: string }[]>("/platforms"),
    staleTime: 600_000,
  });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm print:hidden">
      <h1 className="mr-2 text-xl font-bold uppercase tracking-wide text-zinc-700">{title}</h1>
      <Select value={f.topic} onChange={(e) => f.set({ topic: e.target.value })} className="py-1.5">
        {(["topic", "account"] as const).map((k) => {
          const ts = f.list?.filter((t) => (t.kind ?? "topic") === k) ?? [];
          return ts.length ? (
            <optgroup key={k} label={k === "topic" ? "Topik" : "Pantau akun"}>
              {ts.map((t) => (
                <option key={t.id} value={t.id}>
                  {k === "account" ? `👤 ${t.name}` : t.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </Select>
      <div className="flex overflow-hidden rounded-lg border border-zinc-300">
        {RANGES.map((r) => (
          <button
            type="button"
            key={r.id}
            onClick={() => f.set({ range: r.id, from: null, to: null })}
            className={`px-3 py-1.5 text-sm ${r.id === f.range?.id ? "bg-brand-600 text-white" : "bg-white hover:bg-zinc-50"}`}
          >
            {r.label}
          </button>
        ))}
      </div>
      {f.custom && (
        <span className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-2 py-1 text-xs text-brand-700">
          {fmtTime(f.from.toISOString())} – {fmtTime(f.to.toISOString())}
          <button type="button" className="font-bold" onClick={() => f.set({ range: "7d", from: null, to: null })}>
            ×
          </button>
        </span>
      )}
      <Select value={f.platform} onChange={(e) => f.set({ platform: e.target.value })} className="py-1.5">
        <option value="">Semua platform</option>
        {platforms.data?.map((p) => (
          <option key={p.code} value={p.code}>
            {PLATFORM_LABEL[p.code] ?? p.name}
          </option>
        ))}
      </Select>
      <UpdateControl key={f.topic} f={f} />
    </div>
  );
}

/**
 * "Update data": satu kontrol untuk seberapa sering data topik diambil dari media sosial (server, berbayar per provider) — tampilan
 * ikut memuat data baru otomatis. Analis ke atas bisa mengubah & "Ambil sekarang"; viewer hanya melihat.
 */
function UpdateControl({ f }: { f: Filters }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const role = me?.current_tenant.role;
  const canEdit = !!me?.user.is_platform_operator || ["owner", "admin", "analyst"].includes(role ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["topic", f.topic],
    queryFn: () => api<TopicDetail>(`/topics/${f.topic}`),
    enabled: !!f.topic,
    staleTime: 60_000,
  });
  const refreshTopics = () => {
    void qc.invalidateQueries({ queryKey: ["topics"] });
    void qc.invalidateQueries({ queryKey: ["topic", f.topic] });
  };
  const speed = useMutation({
    mutationFn: (sec: number) => api(`/topics/${f.topic}/speed`, { method: "PUT", json: { interval_sec: sec || null } }),
    onSuccess: (_, sec) => {
      setMsg(sec ? null : "Topik dijeda — tidak ada pengambilan data baru (tanpa biaya). Pilih kecepatan untuk melanjutkan.");
      refreshTopics();
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const now = useMutation({
    mutationFn: () => api<{ platforms: string[]; cooldown_until: string | null }>(`/topics/${f.topic}/fetch-now`, { method: "POST" }),
    onSuccess: (r) => {
      setMsg(
        r.platforms.length
          ? `Sedang mengambil data ${r.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(", ")} — muncul di layar ± 1–3 menit.`
          : `Data baru saja diambil. "Ambil sekarang" bisa dipakai lagi ${r.cooldown_until ? `setelah ${new Date(r.cooldown_until).toLocaleTimeString("id-ID", { timeStyle: "short" })}` : "sebentar lagi"}.`,
      );
      setTimeout(() => {
        refreshTopics();
        void qc.invalidateQueries();
      }, 90_000);
    },
    onError: (e) => setMsg((e as Error).message),
  });
  const t = f.current;
  const options = SPEEDS.some((o) => o.sec === f.speedSec)
    ? SPEEDS
    : [...SPEEDS, { sec: f.speedSec, label: `Tiap ${fmtInterval(f.speedSec)}` }];
  // platform yang lebih lambat dari pilihan topik (batas paket / batas sumber)
  const slower = f.paused ? [] : (detail.data?.platforms ?? []).filter((p) => p.enabled && p.effective_interval_sec > f.speedSec);
  const tip = [
    "Seberapa sering data topik ini diambil dari media sosial — berlaku untuk semua pengguna kantor. Tampilan ikut memuat data baru otomatis.",
    "Mati = topik dijeda: tidak ada pengambilan & tidak ada biaya; dashboard tetap menampilkan data yang sudah ada.",
    ...(slower.length
      ? [
          `Mengikuti batas paket: ${slower.map((p) => `${PLATFORM_LABEL[p.code] ?? p.code} tiap ${fmtInterval(p.effective_interval_sec)}`).join(", ")}.`,
        ]
      : []),
    ...(canEdit ? [] : ["Hanya analis/admin yang bisa mengubah."]),
  ].join("\n");
  return (
    <div className="ml-auto flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-zinc-600" title={tip}>
        <label htmlFor="smip-speed">🔄 Update data</label>
        <Select
          id="smip-speed"
          value={String(f.speedSec)}
          onChange={(e) => speed.mutate(Number(e.target.value))}
          disabled={!t || !canEdit || speed.isPending}
          className={`py-1 ${f.paused ? "border-amber-300 bg-amber-50 text-amber-800" : ""}`}
        >
          {options.map((o) => (
            <option key={o.sec} value={o.sec}>
              {o.label}
            </option>
          ))}
        </Select>
        {canEdit && t && !f.paused && (
          <Button variant="ghost" className="py-1" onClick={() => now.mutate()} disabled={now.isPending}>
            {now.isPending ? "…" : "Ambil sekarang"}
          </Button>
        )}
      </div>
      {(msg || t?.last_run_at || slower.length > 0) && (
        <p className="max-w-md text-right text-xs text-zinc-500">
          {msg ??
            [
              t?.last_run_at ? `Terakhir diambil ${agoText(t.last_run_at)}` : null,
              slower.length ? `${slower.map((p) => PLATFORM_LABEL[p.code] ?? p.code).join(", ")} mengikuti batas paket` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
        </p>
      )}
    </div>
  );
}

const agoText = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? "baru saja" : m < 60 ? `${m} menit lalu` : m < 1440 ? `${Math.round(m / 60)} jam lalu` : fmtTime(iso);
};

// ---------------------------------------------------------------- drill-down

export interface Drill {
  title: string;
  /** filter feed tambahan: sentiment, emotion, hashtag, issue, author_id, region, content_type, platforms */
  params?: Record<string, string | undefined>;
  from?: Date;
  to?: Date;
  sort?: "latest" | "engagement";
  /** bila ada → tombol "Jadikan filter" (hanya dimensi yang berlaku di semua widget: platform & waktu) */
  asFilter?: { platform?: string; from?: Date; to?: Date };
}
const DrillCtx = createContext<(d: Drill) => void>(() => {});
export const useDrill = () => useContext(DrillCtx);

export function DrillProvider({ f, children }: { f: Filters; children: ReactNode }) {
  const [d, setD] = useState<Drill | null>(null);
  return (
    <DrillCtx.Provider value={setD}>
      {children}
      {d && <PostsModal f={f} d={d} onClose={() => setD(null)} />}
    </DrillCtx.Provider>
  );
}

/** Rentang satu bucket chart (jam / hari UTC — sama dengan bucket agregat). */
export function bucketRange(bucket: string, g: "1h" | "1d") {
  const from = new Date(g === "1h" ? bucket : `${bucket}T00:00:00Z`);
  const to = new Date(from.getTime() + (g === "1h" ? 3_600_000 : 86_400_000) - 1000);
  return { from, to };
}

function feedQs(f: Filters, d: Drill, sort: string) {
  const p = new URLSearchParams({
    topic_id: f.topic,
    from: (d.from ?? f.from).toISOString(),
    to: (d.to ?? f.to).toISOString(),
    sort,
  });
  if (f.platform) p.set("platforms", f.platform);
  for (const [k, v] of Object.entries(d.params ?? {})) if (v) p.set(k, v);
  return p.toString();
}

const PAGE = 30;
function PostsModal({ f, d, onClose }: { f: Filters; d: Drill; onClose: () => void }) {
  const [sort, setSort] = useState<"latest" | "engagement">(d.sort ?? "latest");
  const qs = feedQs(f, d, sort);
  const q = useInfiniteQuery({
    queryKey: ["drill", qs],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => apiFull<Post[]>(`/posts?${qs}&limit=${PAGE}&offset=${pageParam}${pageParam ? "" : "&count=1"}`),
    getNextPageParam: (last, all) => (last.data.length === PAGE ? all.length * PAGE : undefined),
  });
  const posts = q.data?.pages.flatMap((p) => p.data) ?? [];
  const total = q.data?.pages[0]?.meta.total as number | undefined;
  const af = d.asFilter;
  return (
    <Modal
      title={`Post — ${d.title}`}
      onClose={onClose}
      right={
        <>
          <div className="flex overflow-hidden rounded-lg border border-zinc-300 text-xs">
            {(["latest", "engagement"] as const).map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => setSort(s)}
                className={`px-2.5 py-1 ${sort === s ? "bg-zinc-800 text-white" : "bg-white hover:bg-zinc-50"}`}
              >
                {s === "latest" ? "Terbaru" : "Engagement tertinggi"}
              </button>
            ))}
          </div>
          {af && (
            <Button
              onClick={() => {
                f.set({
                  ...(af.platform ? { platform: af.platform } : {}),
                  ...(af.from && af.to ? { range: "custom", from: af.from.toISOString(), to: af.to.toISOString() } : {}),
                });
                onClose();
              }}
            >
              Jadikan filter
            </Button>
          )}
        </>
      }
      footer={
        <div className="flex items-center justify-between text-sm text-zinc-500">
          <span>{total !== undefined ? `${total.toLocaleString("id-ID")} post` : "…"}</span>
          {q.hasNextPage && (
            <Button variant="ghost" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? "Memuat…" : "Muat lebih banyak"}
            </Button>
          )}
        </div>
      }
    >
      {q.error && <p className="text-sm text-red-600">{(q.error as Error).message}</p>}
      {q.isLoading && <Empty>Memuat…</Empty>}
      {!q.isLoading && !posts.length && <Empty>Tidak ada post.</Empty>}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {posts.map((p) => (
          <PostCard key={`${p.platform}${p.post_id}`} p={p} topicId={f.topic} />
        ))}
      </div>
    </Modal>
  );
}

const fmtN = (n: number) => n.toLocaleString("id-ID");

/** Label sentimen; analis ke atas bisa mengoreksinya (A-05) → agregat & chart ikut berubah. */
function SentimentLabel({ p, topicId }: { p: Post; topicId?: string }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const role = me?.current_tenant.role;
  const canEdit = !!topicId && (me?.user.is_platform_operator || ["owner", "admin", "analyst"].includes(role ?? ""));
  const human = p.model_version === "human";
  const save = useMutation({
    mutationFn: (label: string) =>
      api(`/posts/${p.platform}/${encodeURIComponent(p.post_id)}/sentiment`, { method: "PATCH", json: { topic_id: topicId, label } }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries(); // semua chart & feed memuat ulang angka terbaru
    },
  });
  const badge = (
    <span
      className="rounded px-1.5 py-0.5 font-medium text-white"
      style={{ background: SENT_COLOR[p.sentiment] }}
      title={human ? "Dikoreksi manual oleh analis" : canEdit ? "Klik untuk mengoreksi sentimen" : undefined}
    >
      {SENT_LABEL[p.sentiment]}
      {human && " ✓"}
    </span>
  );
  if (!canEdit) return badge;
  return (
    <span className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {badge}
      </button>
      {open && (
        <span className="absolute left-0 top-6 z-20 flex flex-col gap-1 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg">
          <span className="text-[10px] text-zinc-500">Ubah sentimen jadi:</span>
          {(["positive", "neutral", "negative"] as const)
            .filter((k) => k !== p.sentiment || !human)
            .map((k) => (
              <button
                type="button"
                key={k}
                disabled={save.isPending}
                onClick={() => save.mutate(k)}
                className="rounded px-2 py-1 text-left font-medium text-white"
                style={{ background: SENT_COLOR[k] }}
              >
                {SENT_LABEL[k]}
              </button>
            ))}
          {save.error && <span className="max-w-40 text-[10px] text-red-600">{(save.error as Error).message}</span>}
        </span>
      )}
    </span>
  );
}

export function PostCard({ p, compact, topicId }: { p: Post; compact?: boolean; topicId?: string }) {
  return (
    <article className="flex flex-col rounded-lg border border-zinc-200 bg-white p-3">
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
          style={{ background: PLATFORM_COLOR[p.platform] ?? "#71717a" }}
          title={PLATFORM_LABEL[p.platform] ?? p.platform}
        >
          {(PLATFORM_LABEL[p.platform] ?? p.platform).slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{p.author_name || `@${p.author_handle}`}</div>
          <div className="truncate text-xs text-zinc-500">
            @{p.author_handle} · {fmtTime(`${p.published_at.replace(" ", "T")}Z`)}
            {p.content_type !== "post" && ` · ${CT_LABEL[p.content_type] ?? p.content_type}`}
          </div>
        </div>
      </div>
      <p className={`mt-2 flex-1 whitespace-pre-line break-words text-sm ${compact ? "line-clamp-3" : "line-clamp-5"}`}>{p.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <SentimentLabel p={p} topicId={topicId} />
        {p.emotion !== "unknown" && (
          <span className="rounded px-1.5 py-0.5 font-medium text-white" style={{ background: EMO_COLOR[p.emotion] }}>
            {EMO_LABEL[p.emotion]}
          </span>
        )}
        <span className="ml-auto text-zinc-500" title="Engagement">
          {p.engagement === null ? "—" : `⚡ ${fmtN(p.engagement)}`}
        </span>
        {p.url && !p.url.includes("example.invalid") && (
          <a href={p.url} target="_blank" rel="noreferrer noopener" className="text-brand-600 hover:underline">
            buka ↗
          </a>
        )}
      </div>
    </article>
  );
}

/** Kolom feed (Kronologi / Sentimen / Emosi) — header berwarna + daftar post yang bisa digulir. */
export function FeedColumn({
  f,
  title,
  color,
  params,
  subtitle,
  sort = "latest",
}: {
  f: Filters;
  title: string;
  color: string;
  params?: Record<string, string | undefined>;
  subtitle?: string;
  sort?: "latest" | "engagement";
}) {
  const drill = useDrill();
  const qs = feedQs(f, { title, params }, sort);
  const q = useQuery({
    queryKey: ["feedcol", qs],
    queryFn: () => apiFull<Post[]>(`/posts?${qs}&limit=12&count=1`),
    enabled: !!f.topic,
    refetchInterval: f.refresh.ms || false,
  });
  const total = q.data?.meta.total as number | undefined;
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50">
      <button
        type="button"
        onClick={() => drill({ title, params, sort })}
        className="px-3 py-2 text-left text-white"
        style={{ background: color }}
        title="Lihat semua post"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-base font-bold">{title}</span>
          <span className="text-xs opacity-90">{total !== undefined ? `${fmtN(total)} post ›` : ""}</span>
        </div>
        {subtitle && <div className="text-xs opacity-90">{subtitle}</div>}
      </button>
      <div className="max-h-[560px] space-y-2 overflow-y-auto p-2">
        {q.data?.data.map((p) => (
          <PostCard key={`${p.platform}${p.post_id}`} p={p} compact topicId={f.topic} />
        ))}
        {q.data && !q.data.data.length && <Empty>Belum ada post.</Empty>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- chart (bisa diklik)

export const xLabels = (b: string[]) =>
  b.map((v) => (v.length > 10 ? `${v.slice(8, 10)}/${v.slice(5, 7)} ${v.slice(11, 13)}:00` : `${v.slice(8, 10)}/${v.slice(5, 7)}`));

type ClickP = { seriesId?: string; seriesName?: string; dataIndex: number; name: string; data?: { key?: string } };

/** Deret waktu: klik titik/batang → post pada bucket itu (+ key seri sebagai filter). */
export function TimeChart({
  s,
  kind = "area",
  stack = true,
  color,
  label,
  height = 280,
  onPick,
}: {
  s: Series | undefined;
  kind?: "area" | "line" | "bar";
  stack?: boolean;
  color?: (key: string) => string | undefined;
  label?: (key: string) => string;
  height?: number;
  onPick?: (key: string, range: { from: Date; to: Date }, bucketLabel: string) => void;
}) {
  if (!s?.buckets.length || !s.series.some((x) => x.values.some((v) => v))) return <Empty>Belum ada data.</Empty>;
  const labels = xLabels(s.buckets);
  return (
    <ReactECharts
      style={{ height, cursor: onPick ? "pointer" : undefined }}
      option={{
        tooltip: { trigger: "axis" },
        legend: s.series.length > 1 ? { top: 0, type: "scroll" } : undefined,
        grid: { left: 48, right: 16, top: s.series.length > 1 ? 36 : 16, bottom: 28 },
        xAxis: { type: "category", data: labels, boundaryGap: kind === "bar" },
        yAxis: { type: "value" },
        series: s.series.map((sr) => ({
          id: sr.key,
          name: label?.(sr.key) ?? sr.key,
          type: kind === "bar" ? "bar" : "line",
          smooth: kind !== "bar",
          symbolSize: 7,
          ...(kind === "area" ? { areaStyle: { opacity: 0.75 } } : {}),
          ...(stack ? { stack: "s" } : {}),
          data: sr.values,
          itemStyle: color?.(sr.key) ? { color: color(sr.key) } : undefined,
          lineStyle: color?.(sr.key) ? { color: color(sr.key) } : undefined,
          emphasis: { focus: "series" },
        })),
      }}
      onEvents={
        onPick
          ? {
              click: (p: ClickP) => {
                const b = s.buckets[p.dataIndex];
                if (b) onPick(p.seriesId ?? "", bucketRange(b, s.granularity), labels[p.dataIndex]!);
              },
            }
          : undefined
      }
    />
  );
}

export interface Slice {
  key: string;
  name: string;
  value: number;
  color?: string;
}

export function PieChart({
  items,
  donut,
  height = 280,
  onPick,
}: {
  items: Slice[] | undefined;
  donut?: boolean;
  height?: number;
  onPick?: (key: string, name: string) => void;
}) {
  if (!items?.length) return <Empty>Belum ada data.</Empty>;
  return (
    <ReactECharts
      style={{ height }}
      option={{
        tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
        series: [
          {
            type: "pie",
            // radius lebih kecil + label 2 baris: nama tidak terpotong ("Po…") di kartu sempit
            radius: donut ? ["36%", "60%"] : "60%",
            label: { formatter: "{b}\n{d}%", overflow: "none", lineHeight: 14 },
            data: items.map((i) => ({ name: i.name, value: i.value, key: i.key, itemStyle: i.color ? { color: i.color } : undefined })),
          },
        ],
      }}
      onEvents={onPick ? { click: (p: ClickP) => p.data?.key && onPick(p.data.key, p.name) } : undefined}
    />
  );
}

export function BarList({
  items,
  height,
  color = "#60a5fa",
  onPick,
  fmt,
}: {
  items: Slice[] | undefined;
  height?: number;
  color?: string;
  onPick?: (key: string, name: string) => void;
  fmt?: (n: number) => string;
}) {
  if (!items?.length) return <Empty>Belum ada data.</Empty>;
  const longest = Math.max(...items.map((i) => i.name.length));
  return (
    <ReactECharts
      style={{ height: height ?? Math.max(160, items.length * 30 + 30) }}
      option={{
        tooltip: { trigger: "item", formatter: (p: { name: string; value: number }) => `${p.name}: ${fmt ? fmt(p.value) : fmtN(p.value)}` },
        grid: { left: Math.min(150, longest * 7 + 16), right: 24, top: 4, bottom: 20 },
        xAxis: { type: "value", axisLabel: fmt ? { formatter: fmt } : undefined },
        yAxis: {
          type: "category",
          inverse: true,
          data: items.map((i) => i.name),
          axisLabel: { width: 140, overflow: "truncate" },
        },
        series: [
          {
            type: "bar",
            data: items.map((i) => ({ value: i.value, key: i.key, itemStyle: { color: i.color ?? color } })),
            barMaxWidth: 18,
          },
        ],
      }}
      onEvents={onPick ? { click: (p: ClickP) => p.data?.key && onPick(p.data.key, p.name) } : undefined}
    />
  );
}

const TREE_COLORS = ["#b45309", "#92400e", "#57534e", "#334155", "#1e3a8a", "#1d4ed8", "#0f766e", "#15803d", "#166534", "#3f6212"];
export function Treemap({ items, height = 300, onPick }: { items: Slice[] | undefined; height?: number; onPick?: (key: string) => void }) {
  if (!items?.length) return <Empty>Belum ada data.</Empty>;
  return (
    <ReactECharts
      style={{ height }}
      option={{
        tooltip: { formatter: "{b}: {c}" },
        series: [
          {
            type: "treemap",
            roam: false,
            nodeClick: false,
            breadcrumb: { show: false },
            label: { formatter: "{b}\n({c})", fontWeight: "bold" },
            data: items.map((t, i) => ({
              name: t.name,
              value: t.value,
              key: t.key,
              itemStyle: { color: t.color ?? TREE_COLORS[i % TREE_COLORS.length] },
            })),
          },
        ],
      }}
      onEvents={onPick ? { click: (p: ClickP) => p.data?.key && onPick(p.data.key) } : undefined}
    />
  );
}

const CLOUD_COLORS = ["#2563eb", "#0d9488", "#16a34a", "#b91c1c", "#c2410c", "#7c3aed", "#0369a1", "#4d7c0f", "#be185d", "#52525b"];
/** Word cloud ringan (CSS, tanpa paket tambahan): ukuran huruf ∝ √nilai; klik → drill-down. */
export function WordCloud({
  items,
  onPick,
  empty = "Belum ada data.",
  error,
}: {
  items: { key: string; value: number }[] | undefined;
  onPick?: (key: string) => void;
  empty?: string;
  error?: unknown;
}) {
  if (error) return <Empty>Gagal memuat: {error instanceof Error ? error.message : String(error)}</Empty>;
  if (!items) return <Empty>Memuat…</Empty>;
  if (!items.length) return <Empty>{empty}</Empty>;
  const max = Math.sqrt(Math.max(...items.map((i) => i.value), 1));
  // kata terbesar di tengah: urutan zig-zag
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const arranged: typeof sorted = [];
  for (const [i, it] of sorted.entries()) {
    if (i % 2) arranged.push(it);
    else arranged.unshift(it);
  }
  return (
    <div className="flex min-h-48 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 py-4 text-center leading-tight">
      {arranged.map((it) => (
        <button
          type="button"
          key={it.key}
          title={`${it.key}: ${fmtN(it.value)}`}
          onClick={() => onPick?.(it.key)}
          className="font-semibold hover:underline"
          style={{
            fontSize: `${Math.round(12 + (Math.sqrt(it.value) / max) * 22)}px`,
            color: CLOUD_COLORS[[...it.key].reduce((h, ch) => h + ch.charCodeAt(0), 0) % CLOUD_COLORS.length],
          }}
        >
          {it.key}
        </button>
      ))}
    </div>
  );
}

/**
 * Tag cloud isu (sederhana): pill berjenjang 4 ukuran menurut peringkat, isu terbesar paling pekat & di depan, angka di dalam pill,
 * klik → drill-down. Tanpa animasi / paket tambahan.
 */
export function TagCloud({
  items,
  onPick,
  empty = "Belum ada data.",
  error,
  max = 30,
}: {
  items: { key: string; value: number }[] | undefined;
  onPick?: (key: string) => void;
  empty?: string;
  error?: unknown;
  max?: number;
}) {
  if (error) return <Empty>Gagal memuat: {error instanceof Error ? error.message : String(error)}</Empty>;
  if (!items) return <Empty>Memuat…</Empty>;
  const top = [...items].sort((a, b) => b.value - a.value).slice(0, max);
  if (!top.length) return <Empty>{empty}</Empty>;
  const tier = (i: number) => (i < 3 ? 0 : i < 8 ? 1 : i < 16 ? 2 : 3);
  const STYLE = [
    "px-3.5 py-1.5 text-lg font-bold bg-brand-600 text-white border-brand-600",
    "px-3 py-1 text-base font-semibold bg-brand-50 text-brand-700 border-brand-100",
    "px-2.5 py-1 text-sm font-medium bg-white text-zinc-700 border-zinc-300",
    "px-2 py-0.5 text-xs bg-white text-zinc-500 border-zinc-200",
  ];
  return (
    <div className="flex min-h-48 flex-wrap content-center items-center justify-center gap-2 px-2 py-3">
      {top.map((it, i) => (
        <button
          type="button"
          key={it.key}
          onClick={() => onPick?.(it.key)}
          title={`${it.key}: ${fmtN(it.value)} — klik untuk melihat post`}
          className={`inline-flex items-center gap-1.5 rounded-full border transition hover:-translate-y-0.5 hover:shadow ${STYLE[tier(i)]}`}
        >
          {it.key}
          <span className={`rounded-full px-1.5 text-[0.7em] tabular-nums ${tier(i) === 0 ? "bg-white/20" : "bg-zinc-100 text-zinc-500"}`}>
            {fmtN(it.value)}
          </span>
        </button>
      ))}
    </div>
  );
}

export const Stat = ({ label, value, sub, onClick }: { label: string; value: ReactNode; sub?: ReactNode; onClick?: () => void }) => (
  <button
    type="button"
    disabled={!onClick}
    onClick={onClick}
    className="rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm enabled:hover:border-brand-500 enabled:hover:shadow"
  >
    <div className="text-xs uppercase text-zinc-500">{label}</div>
    <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    {sub && <div className="mt-0.5 text-xs">{sub}</div>}
  </button>
);

/** Kartu dengan tombol info kecil (definisi metrik). */
export const Panel = ({ title, info, children, right }: { title: string; info?: string; children: ReactNode; right?: ReactNode }) => (
  <Card
    title={title}
    right={
      <div className="flex items-center gap-2">
        {right}
        {info && (
          <span className="cursor-help text-xs text-zinc-400" title={info}>
            ⓘ
          </span>
        )}
      </div>
    }
  >
    {children}
  </Card>
);

export const platformName = (k: string) => PLATFORM_LABEL[k] ?? k;
export { Badge, fmtN };
