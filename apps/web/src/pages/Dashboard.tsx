import { Link } from "react-router";
import {
  BarList,
  DrillProvider,
  EMO_COLOR,
  EMO_LABEL,
  EMOTIONS,
  FeedColumn,
  FilterBar,
  type Filters,
  fmtN,
  Panel,
  PieChart,
  PLATFORM_COLOR,
  platformName,
  SENT_COLOR,
  SENT_LABEL,
  type Series,
  Stat,
  TimeChart,
  Treemap,
  useA,
  useDrill,
  useFilterSearch,
  useFilters,
} from "../analytics";
import { OfficePicker, useNeedsOffice } from "../office";
import { Empty, ErrorText } from "../ui";

interface Summary {
  current: { posts: number; engagement: number; negative: number; positive: number; authors: number };
  delta_pct: { posts: number | null; engagement: number | null; authors: number | null };
}
export interface Prop<K extends string> {
  total: number;
  items: ({ [k in K]: string } & { count: number; pct: number })[];
}
export interface Breakdown {
  items: { platform: string; content_type: string; count: number; engagement: number }[];
}
export interface Accounts {
  items: { platform: string; author_id: string; handle: string; value: number; followers: number | null }[];
}
export interface Geo {
  coverage_pct: number;
  items: { code: string; name: string; count: number }[];
}

const Delta = ({ v }: { v: number | null | undefined }) =>
  v === null || v === undefined ? null : (
    <span className={v >= 0 ? "text-emerald-600" : "text-red-600"}>
      {v >= 0 ? "▲" : "▼"} {Math.abs(v)}% vs periode sebelumnya
    </span>
  );

/** Wrapper halaman analitik: filter + penyedia drill-down. */
export function AnalyticsPage({ title, children }: { title: string; children: (f: Filters) => React.ReactNode }) {
  if (useNeedsOffice()) return <OfficePicker to={location.pathname} />;
  return <AnalyticsInner title={title}>{children}</AnalyticsInner>;
}

function AnalyticsInner({ title, children }: { title: string; children: (f: Filters) => React.ReactNode }) {
  const f = useFilters();
  return (
    <DrillProvider f={f}>
      <div className="space-y-4">
        <FilterBar f={f} title={title} />
        <ErrorText error={f.topics.error} />
        {f.list && !f.list.length ? (
          <Empty>
            Belum ada topik —{" "}
            <Link to="/topics/new" className="text-brand-600 underline">
              buat topik dulu
            </Link>
            .
          </Empty>
        ) : (
          f.topic && children(f)
        )}
      </div>
    </DrillProvider>
  );
}

export function perPlatform(b: Breakdown | undefined, types: string[]) {
  const m = new Map<string, number>();
  for (const i of b?.items ?? []) if (types.includes(i.content_type)) m.set(i.platform, (m.get(i.platform) ?? 0) + i.count);
  return [...m].sort((a, c) => c[1] - a[1]);
}

function Body({ f }: { f: Filters }) {
  const drill = useDrill();
  const search = useFilterSearch();
  const sum = useA<Summary>(f, "/analytics/summary");
  const prop = useA<Prop<"sentiment"> & { model_versions: string[] }>(f, "/analytics/sentiment/proportion");
  const tl = useA<Series>(f, "/analytics/sentiment/timeline");
  const expo = useA<Series>(f, "/analytics/exposure");
  const eng = useA<Series>(f, "/analytics/exposure?mode=engagement");
  const emo = useA<Prop<"emotion">>(f, "/analytics/emotion/proportion");
  const emoTl = useA<Series>(f, "/analytics/emotion/timeline");
  const tags = useA<{ items: { hashtag: string; count: number }[] }>(f, "/analytics/hashtags?limit=25");
  const acc = useA<Accounts>(f, "/analytics/accounts/top?limit=10");
  const geo = useA<Geo>(f, "/analytics/locations");
  const br = useA<Breakdown>(f, "/analytics/platforms");
  const s = sum.data?.current;
  const pct = (n: number | undefined) => (s?.posts ? `${Math.round(((n ?? 0) / s.posts) * 100)}%` : "—");
  const posts = perPlatform(br.data, ["post"]);
  const replies = perPlatform(br.data, ["reply", "comment"]);
  const reposts = perPlatform(br.data, ["repost", "quote"]);
  return (
    <>
      <ErrorText error={sum.error} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat
          label="Total post"
          value={fmtN(s?.posts ?? 0)}
          sub={<Delta v={sum.data?.delta_pct.posts} />}
          onClick={() => drill({ title: "Semua post" })}
        />
        <Stat
          label="Engagement"
          value={fmtN(s?.engagement ?? 0)}
          sub={<Delta v={sum.data?.delta_pct.engagement} />}
          onClick={() => drill({ title: "Engagement tertinggi", sort: "engagement" })}
        />
        <Stat label="Akun unik" value={fmtN(s?.authors ?? 0)} sub={<Delta v={sum.data?.delta_pct.authors} />} />
        <Stat
          label="Negatif"
          value={<span className="text-red-700">{pct(s?.negative)}</span>}
          sub={<span className="text-zinc-500">{fmtN(s?.negative ?? 0)} post</span>}
          onClick={() => drill({ title: "Sentimen negatif", params: { sentiment: "negative" } })}
        />
        <Stat
          label="Positif"
          value={<span className="text-blue-700">{pct(s?.positive)}</span>}
          sub={<span className="text-zinc-500">{fmtN(s?.positive ?? 0)} post</span>}
          onClick={() => drill({ title: "Sentimen positif", params: { sentiment: "positive" } })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Exposure" info="Jumlah post yang cocok dengan topik per platform. Klik titik untuk melihat post-nya.">
            <TimeChart
              s={expo.data}
              color={(k) => PLATFORM_COLOR[k]}
              label={platformName}
              onPick={(k, r, b) =>
                drill({ title: `${platformName(k)} · ${b}`, params: { platforms: k }, ...r, asFilter: { platform: k, ...r } })
              }
            />
          </Panel>
        </div>
        <Panel title="Proporsi sentimen" info={`Label oleh model: ${prop.data?.model_versions.join(", ") || "—"}`}>
          <PieChart
            items={prop.data?.items.map((i) => ({
              key: i.sentiment,
              name: SENT_LABEL[i.sentiment]!,
              value: i.count,
              color: SENT_COLOR[i.sentiment],
            }))}
            onPick={(k, n) => drill({ title: `Sentimen ${n.toLowerCase()}`, params: { sentiment: k } })}
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Riwayat engagement" info="Total like + komentar + share (+ view bila tersedia) per platform.">
            <TimeChart
              s={eng.data}
              color={(k) => PLATFORM_COLOR[k]}
              label={platformName}
              onPick={(k, r, b) =>
                drill({
                  title: `Engagement ${platformName(k)} · ${b}`,
                  params: { platforms: k },
                  ...r,
                  sort: "engagement",
                  asFilter: { platform: k, ...r },
                })
              }
            />
          </Panel>
        </div>
        <Panel title="Total per platform" info="Post asli, balasan/komentar, dan repost/quote. Klik untuk melihat post.">
          {posts.length + replies.length + reposts.length ? (
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              {[
                { t: "Post", rows: posts, ct: "post" },
                { t: "Balasan", rows: replies, ct: "replies" },
                { t: "Repost", rows: reposts, ct: "reposts" },
              ].map((col) => (
                <div key={col.t}>
                  <div className="mb-1 text-xs font-semibold uppercase text-zinc-500">{col.t}</div>
                  {col.rows.map(([p, n]) => (
                    <button
                      type="button"
                      key={p}
                      className="mb-1 block w-full rounded-lg border border-zinc-100 py-1.5 hover:border-brand-500"
                      onClick={() =>
                        drill({
                          title: `${col.t} · ${platformName(p)}`,
                          params: { platforms: p, content_type: col.ct },
                          asFilter: { platform: p },
                        })
                      }
                    >
                      <div className="text-lg font-bold tabular-nums">{fmtN(n)}</div>
                      <div className="text-xs text-zinc-500">{platformName(p)}</div>
                    </button>
                  ))}
                  {!col.rows.length && <div className="text-xs text-zinc-400">—</div>}
                </div>
              ))}
            </div>
          ) : (
            <Empty>Belum ada data.</Empty>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Sentimen dari waktu ke waktu">
            <TimeChart
              s={tl.data}
              kind="line"
              stack={false}
              color={(k) => SENT_COLOR[k]}
              label={(k) => SENT_LABEL[k] ?? k}
              onPick={(k, r, b) => drill({ title: `${SENT_LABEL[k]} · ${b}`, params: { sentiment: k }, ...r, asFilter: r })}
            />
          </Panel>
        </div>
        <Panel
          title="Emosi"
          info={`8 emosi Plutchik. Tidak jelas: ${emo.data?.items.find((i) => i.emotion === "unknown")?.count ?? 0} post.`}
        >
          <BarList
            items={EMOTIONS.map((k) => ({
              key: k,
              name: EMO_LABEL[k]!,
              value: emo.data?.items.find((i) => i.emotion === k)?.count ?? 0,
              color: EMO_COLOR[k],
            })).filter((i) => i.value)}
            onPick={(k, n) => drill({ title: `Emosi ${n.toLowerCase()}`, params: { emotion: k } })}
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Perception stream" info="Jumlah post per emosi dari waktu ke waktu.">
            <TimeChart
              s={emoTl.data}
              color={(k) => EMO_COLOR[k]}
              label={(k) => EMO_LABEL[k] ?? k}
              onPick={(k, r, b) => drill({ title: `${EMO_LABEL[k]} · ${b}`, params: { emotion: k }, ...r, asFilter: r })}
            />
          </Panel>
        </div>
        <Panel title="Hashtag">
          <Treemap
            items={tags.data?.items.map((t) => ({ key: t.hashtag, name: `#${t.hashtag}`, value: t.count }))}
            onPick={(k) => drill({ title: `#${k}`, params: { hashtag: k } })}
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="Lokasi (provinsi)"
          right={geo.data && <span className="text-xs text-zinc-500">terdeteksi {geo.data.coverage_pct}%</span>}
        >
          <BarList
            items={geo.data?.items.slice(0, 10).map((g) => ({ key: g.code, name: g.name, value: g.count }))}
            color="#16a34a"
            onPick={(k, n) => drill({ title: `Lokasi ${n}`, params: { region: k } })}
          />
        </Panel>
        <Panel
          title="Akun paling aktif"
          right={
            <Link to={`/contributors${search}`} className="text-xs text-brand-600 hover:underline">
              semua ›
            </Link>
          }
        >
          <BarList
            items={acc.data?.items.map((a) => ({ key: a.author_id, name: `@${a.handle}`, value: a.value }))}
            onPick={(k, n) => drill({ title: `Post ${n}`, params: { author_id: k } })}
          />
        </Panel>
        <FeedColumn f={f} title="Post terbaru" color="#3f3f46" />
      </div>
    </>
  );
}

export default function Dashboard() {
  return <AnalyticsPage title="Dashboard">{(f) => <Body f={f} />}</AnalyticsPage>;
}
