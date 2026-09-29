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
  TimeChart,
  Treemap,
  useA,
  useDrill,
} from "../analytics";
import { Tabs } from "../ui";
import { type Accounts, AnalyticsPage, type Breakdown, type Prop, perPlatform } from "./Dashboard";

type Tab = "chronology" | "sentiment" | "emotion" | "engagement";
const TABS: { id: Tab; label: string }[] = [
  { id: "chronology", label: "Kronologi" },
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

function SentimentSide({ f, s }: { f: Filters; s: "positive" | "negative" }) {
  const drill = useDrill();
  const tags = useA<{ items: { hashtag: string; count: number }[] }>(f, `/analytics/hashtags?limit=20&sentiment=${s}`);
  const acc = useA<Accounts>(f, `/analytics/accounts/top?limit=8&sentiment=${s}`);
  const label = SENT_LABEL[s]!.toLowerCase();
  return (
    <>
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
          {tab === "sentiment" && <Sentiment f={f} />}
          {tab === "emotion" && <Emotion f={f} />}
          {tab === "engagement" && <Engagement f={f} />}
        </>
      )}
    </AnalyticsPage>
  );
}
