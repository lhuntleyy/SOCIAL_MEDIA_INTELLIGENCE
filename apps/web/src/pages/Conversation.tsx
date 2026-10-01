import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import {
  BarList,
  EMO_COLOR,
  EMO_LABEL,
  EMOTIONS,
  FeedColumn,
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
  TagCloud,
  TimeChart,
  Treemap,
  useA,
  useDrill,
} from "../analytics";
import { api } from "../api";
import { Badge, Empty, Tabs } from "../ui";
import { type Accounts, AnalyticsPage, type Breakdown, type Prop, perPlatform } from "./Dashboard";

type Tab = "chronology" | "issues" | "sentiment" | "emotion" | "engagement";
const TABS: { id: Tab; label: string }[] = [
  { id: "chronology", label: "Kronologi" },
  { id: "issues", label: "Isu" },
  { id: "sentiment", label: "Sentimen" },
  { id: "emotion", label: "Emosi" },
  { id: "engagement", label: "Engagement" },
];

function Chronology({ f }: { f: Filters }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <FeedColumn f={f} title="Timeline" subtitle="semua post terbaru" color="#3f3f46" />
      <FeedColumn f={f} title="Post" subtitle="post asli" color="#1e40af" params={{ content_type: "post" }} />
      <FeedColumn f={f} title="Komentar & balasan" subtitle="reply / komentar" color="#0f766e" params={{ content_type: "replies" }} />
    </div>
  );
}

interface IssueItems {
  items: { issue: string; count: number; engagement: number }[];
}

/** Isu periode lain (perbandingan): jendela [from, to] eksplisit, filter topik/platform sama. */
function useIssuesAt(f: Filters, from: Date, to: Date) {
  const qs = `topic_id=${f.topic}&from=${from.toISOString()}&to=${to.toISOString()}${f.platform ? `&platforms=${f.platform}` : ""}`;
  return useQuery({
    queryKey: ["/analytics/issues", "cmp", qs],
    queryFn: () => api<IssueItems>(`/analytics/issues?limit=100&${qs}`),
    enabled: !!f.topic,
    refetchInterval: f.refresh.ms || false,
    placeholderData: keepPreviousData,
  });
}

function Issues({ f }: { f: Filters }) {
  const drill = useDrill();
  const top = useA<IssueItems>(f, "/analytics/issues?limit=10");
  const pos = useA<IssueItems>(f, "/analytics/issues?limit=40&sentiment=positive");
  const neg = useA<IssueItems>(f, "/analytics/issues?limit=40&sentiment=negative");
  const span = f.to.getTime() - f.from.getTime();
  const now = useIssuesAt(f, f.from, f.to);
  const before = useIssuesAt(f, new Date(f.from.getTime() - span), f.from);
  const prev = new Map((before.data?.items ?? []).map((i) => [i.issue, i.count]));
  const rows = (now.data?.items ?? []).slice(0, 20).map((i) => ({ ...i, prev: prev.get(i.issue) ?? 0 }));
  const days = Math.max(1, Math.round(span / 86_400_000));
  const cloud = (d: IssueItems | undefined) => d?.items.map((i) => ({ key: i.issue, value: i.count }));
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Isu teratas" info="10 isu yang paling banyak dibicarakan. Klik untuk melihat post-nya.">
          <PieChart
            donut
            items={top.data?.items.map((i) => ({ key: i.issue, name: i.issue, value: i.count }))}
            onPick={(k) => drill({ title: `Isu: ${k}`, params: { issue: k } })}
          />
        </Panel>
        <Panel title="Perbandingan isu" info={`Periode terpilih vs ${days} hari sebelumnya (panjang sama).`}>
          {rows.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="py-1">Isu</th>
                  <th className="py-1 text-right">Sekarang</th>
                  <th className="py-1 text-right">Sebelumnya</th>
                  <th className="py-1 text-right">Perubahan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {rows.map((r) => (
                  <tr key={r.issue}>
                    <td className="py-1">
                      <button
                        type="button"
                        className="hover:underline"
                        onClick={() => drill({ title: `Isu: ${r.issue}`, params: { issue: r.issue } })}
                      >
                        {r.issue}
                      </button>
                    </td>
                    <td className="py-1 text-right tabular-nums">{fmtN(r.count)}</td>
                    <td className="py-1 text-right tabular-nums text-zinc-500">{fmtN(r.prev)}</td>
                    <td className="py-1 text-right">
                      {r.prev === 0 ? (
                        <Badge tone="blue">baru</Badge>
                      ) : (
                        <span className={r.count >= r.prev ? "text-red-700" : "text-emerald-700"}>
                          {r.count >= r.prev ? "▲" : "▼"} {Math.round(Math.abs((r.count - r.prev) / r.prev) * 100)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>{now.isLoading ? "Memuat…" : "Belum ada isu pada periode ini."}</Empty>
          )}
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Isu sentimen positif">
          <TagCloud
            items={cloud(pos.data)}
            error={pos.error}
            onPick={(k) => drill({ title: `Isu: ${k} · positif`, params: { issue: k, sentiment: "positive" } })}
          />
        </Panel>
        <Panel title="Isu sentimen negatif">
          <TagCloud
            items={cloud(neg.data)}
            error={neg.error}
            onPick={(k) => drill({ title: `Isu: ${k} · negatif`, params: { issue: k, sentiment: "negative" } })}
          />
        </Panel>
      </div>
    </>
  );
}

function SentimentSide({ f, s }: { f: Filters; s: "positive" | "negative" }) {
  const drill = useDrill();
  const iss = useA<IssueItems>(f, `/analytics/issues?limit=30&sentiment=${s}`);
  const tags = useA<{ items: { hashtag: string; count: number }[] }>(f, `/analytics/hashtags?limit=20&sentiment=${s}`);
  const acc = useA<Accounts>(f, `/analytics/accounts/top?limit=8&sentiment=${s}`);
  const label = SENT_LABEL[s]!.toLowerCase();
  return (
    <>
      <Panel title={`Isu sentimen ${label}`}>
        <TagCloud
          items={iss.data?.items.map((i) => ({ key: i.issue, value: i.count }))}
          error={iss.error}
          onPick={(k) => drill({ title: `Isu: ${k} · ${label}`, params: { issue: k, sentiment: s } })}
        />
      </Panel>
      <Panel title={`Hashtag sentimen ${label}`}>
        <Treemap
          height={240}
          items={tags.data?.items.map((t) => ({ key: t.hashtag, name: `#${t.hashtag}`, value: t.count }))}
          onPick={(k) => drill({ title: `#${k} · ${label}`, params: { hashtag: k, sentiment: s } })}
        />
      </Panel>
      <Panel title={`Akun sentimen ${label}`}>
        <BarList
          color={SENT_COLOR[s]}
          items={acc.data?.items.map((a) => ({ key: a.author_id, name: `@${a.handle}`, value: a.value }))}
          onPick={(k, n) => drill({ title: `${n} · ${label}`, params: { author_id: k, sentiment: s } })}
        />
      </Panel>
    </>
  );
}

function Sentiment({ f }: { f: Filters }) {
  const drill = useDrill();
  const tl = useA<Series>(f, "/analytics/sentiment/timeline");
  const prop = useA<Prop<"sentiment">>(f, "/analytics/sentiment/proportion");
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Timeline sentimen">
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
        <Panel title="Proporsi">
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
        {(["neutral", "negative", "positive"] as const).map((k) => (
          <FeedColumn key={k} f={f} title={SENT_LABEL[k]!} color={SENT_COLOR[k]!} params={{ sentiment: k }} />
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <SentimentSide f={f} s="positive" />
        <SentimentSide f={f} s="negative" />
      </div>
    </>
  );
}

function Emotion({ f }: { f: Filters }) {
  const drill = useDrill();
  const emo = useA<Prop<"emotion">>(f, "/analytics/emotion/proportion");
  const tl = useA<Series>(f, "/analytics/emotion/timeline");
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Emosi" info="8 emosi dasar Plutchik, dari model AI.">
          <BarList
            items={EMOTIONS.map((k) => ({
              key: k,
              name: EMO_LABEL[k]!,
              value: emo.data?.items.find((i) => i.emotion === k)?.count ?? 0,
              color: EMO_COLOR[k],
            }))}
            onPick={(k, n) => drill({ title: `Emosi ${n.toLowerCase()}`, params: { emotion: k } })}
          />
        </Panel>
        <div className="lg:col-span-2">
          <Panel title="Perception stream">
            <TimeChart
              s={tl.data}
              color={(k) => EMO_COLOR[k]}
              label={(k) => EMO_LABEL[k] ?? k}
              onPick={(k, r, b) => drill({ title: `${EMO_LABEL[k]} · ${b}`, params: { emotion: k }, ...r, asFilter: r })}
            />
          </Panel>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {EMOTIONS.map((k) => (
          <FeedColumn key={k} f={f} title={EMO_LABEL[k]!} color={EMO_COLOR[k]!} params={{ emotion: k }} />
        ))}
      </div>
    </>
  );
}

function Engagement({ f }: { f: Filters }) {
  const drill = useDrill();
  const eng = useA<Series>(f, "/analytics/exposure?mode=engagement");
  const expo = useA<Series>(f, "/analytics/exposure");
  const br = useA<Breakdown>(f, "/analytics/platforms");
  const acc = useA<Accounts>(f, "/analytics/accounts/top?limit=10&by=engagement");
  const totalEng = br.data?.items.reduce((a, i) => a + i.engagement, 0) ?? 0;
  const totalPosts = br.data?.items.reduce((a, i) => a + i.count, 0) ?? 0;
  const replies = perPlatform(br.data, ["reply", "comment"]).reduce((a, [, n]) => a + n, 0);
  const reposts = perPlatform(br.data, ["repost", "quote"]).reduce((a, [, n]) => a + n, 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Total post" value={fmtN(totalPosts)} onClick={() => drill({ title: "Semua post" })} />
        <Stat
          label="Total engagement"
          value={fmtN(totalEng)}
          onClick={() => drill({ title: "Engagement tertinggi", sort: "engagement" })}
        />
        <Stat label="Rata-rata / post" value={totalPosts ? fmtN(Math.round(totalEng / totalPosts)) : "—"} />
        <Stat
          label="Balasan & komentar"
          value={fmtN(replies)}
          onClick={() => drill({ title: "Balasan & komentar", params: { content_type: "replies" } })}
        />
        <Stat
          label="Repost & quote"
          value={fmtN(reposts)}
          onClick={() => drill({ title: "Repost & quote", params: { content_type: "reposts" } })}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Riwayat engagement">
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
        <Panel title="Tren jumlah post">
          <TimeChart
            s={expo.data}
            kind="bar"
            color={(k) => PLATFORM_COLOR[k]}
            label={platformName}
            onPick={(k, r, b) =>
              drill({ title: `${platformName(k)} · ${b}`, params: { platforms: k }, ...r, asFilter: { platform: k, ...r } })
            }
          />
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Akun dengan engagement tertinggi">
          <BarList
            items={acc.data?.items.map((a) => ({ key: a.author_id, name: `@${a.handle}`, value: a.value }))}
            onPick={(k, n) => drill({ title: `Post ${n}`, params: { author_id: k }, sort: "engagement" })}
          />
        </Panel>
        <div className="lg:col-span-2">
          <FeedColumn f={f} title="Post paling ramai" subtitle="urut engagement tertinggi" color="#b45309" sort="engagement" />
        </div>
      </div>
    </>
  );
}

export default function Conversation() {
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.find((t) => t.id === sp.get("tab"))?.id ?? "chronology") as Tab;
  return (
    <AnalyticsPage title="Percakapan">
      {(f) => (
        <>
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={(v) => {
              const n = new URLSearchParams(sp);
              n.set("tab", v);
              setSp(n, { replace: true });
            }}
          />
          {tab === "chronology" && <Chronology f={f} />}
          {tab === "issues" && <Issues f={f} />}
          {tab === "sentiment" && <Sentiment f={f} />}
          {tab === "emotion" && <Emotion f={f} />}
          {tab === "engagement" && <Engagement f={f} />}
        </>
      )}
    </AnalyticsPage>
  );
}
