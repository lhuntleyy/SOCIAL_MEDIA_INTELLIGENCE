import { BarList, type Filters, fmtN, Panel, platformName, type Series, TimeChart, useA, useDrill } from "../analytics";
import { type Accounts, AnalyticsPage } from "./Dashboard";

function AccountPanel({ f, title, by, info }: { f: Filters; title: string; by: string; info?: string }) {
  const drill = useDrill();
  const q = useA<Accounts>(f, `/analytics/accounts/top?limit=10&by=${by}`);
  return (
    <Panel title={title} info={info}>
      <BarList
        items={q.data?.items.map((a) => ({ key: a.author_id, name: `@${a.handle}`, value: a.value }))}
        onPick={(k, n) => drill({ title: `Post ${n}`, params: { author_id: k }, sort: by === "engagement" ? "engagement" : "latest" })}
      />
      {q.data?.items.length ? (
        <p className="mt-1 text-right text-[11px] text-zinc-400">
          {q.data.items
            .slice(0, 3)
            .map((a) => `@${a.handle} (${platformName(a.platform)}${a.followers !== null ? `, ${fmtN(a.followers)} pengikut` : ""})`)
            .join(" · ")}
        </p>
      ) : null}
    </Panel>
  );
}

function Body({ f }: { f: Filters }) {
  const drill = useDrill();
  const active = useA<Series>(f, "/analytics/accounts/active");
  const reposted = useA<{ items: { platform: string; author_id: string; handle: string | null; value: number }[] }>(
    f,
    "/analytics/accounts/reposted?limit=10",
  );
  return (
    <>
      <Panel title="Akun aktif per hari" info="Jumlah akun unik yang mem-posting / membalas / me-repost tentang topik ini.">
        <TimeChart
          s={active.data}
          kind="bar"
          label={() => "Akun aktif"}
          color={() => "#60a5fa"}
          onPick={(_k, r, b) => drill({ title: `Post ${b}`, ...r, asFilter: r })}
        />
      </Panel>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <AccountPanel f={f} title="Paling aktif (post)" by="posts" />
        <AccountPanel f={f} title="Engagement tertinggi" by="engagement" />
        <AccountPanel f={f} title="Paling banyak membalas" by="replies" />
        <AccountPanel f={f} title="Paling banyak me-repost" by="reposts" />
        <Panel title="Paling banyak di-repost" info="Akun asal yang post-nya paling sering di-repost / di-quote.">
          <BarList items={reposted.data?.items.map((a) => ({ key: a.author_id, name: `@${a.handle ?? a.author_id}`, value: a.value }))} />
        </Panel>
      </div>
    </>
  );
}

export default function Contributors() {
  return <AnalyticsPage title="Kontributor">{(f) => <Body f={f} />}</AnalyticsPage>;
}
