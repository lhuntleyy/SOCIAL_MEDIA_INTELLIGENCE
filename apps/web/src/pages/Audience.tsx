import ReactECharts from "echarts-for-react";
import { BarList, type Filters, fmtN, Panel, PieChart, SENT_COLOR, SENT_LABEL, Treemap, useA, useDrill } from "../analytics";
import { Empty } from "../ui";
import { AnalyticsPage, type Geo } from "./Dashboard";

const DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

function Heatmap({ f }: { f: Filters }) {
  const q = useA<{ timezone: string; cells: { day: number; hour: number; count: number }[] }>(f, "/analytics/activity");
  if (!q.data?.cells.length) return <Empty>Belum ada data.</Empty>;
  const max = Math.max(...q.data.cells.map((c) => c.count));
  return (
    <ReactECharts
      style={{ height: 280 }}
      option={{
        tooltip: { formatter: (p: { value: number[] }) => `${DAYS[p.value[1]!]} ${p.value[0]}:00 — ${fmtN(p.value[2]!)} post` },
        grid: { left: 60, right: 16, top: 8, bottom: 60 },
        xAxis: { type: "category", data: Array.from({ length: 24 }, (_, h) => `${h}`), splitArea: { show: true } },
        yAxis: { type: "category", data: DAYS, inverse: true, splitArea: { show: true } },
        visualMap: {
          min: 0,
          max,
          calculable: true,
          orient: "horizontal",
          left: "center",
          bottom: 0,
          inRange: { color: ["#eff6ff", "#1d4ed8"] },
        },
        series: [{ type: "heatmap", data: q.data.cells.map((c) => [c.hour, c.day - 1, c.count]) }],
      }}
    />
  );
}

function Body({ f }: { f: Filters }) {
  const drill = useDrill();
  const geo = useA<Geo>(f, "/analytics/locations");
  const year = useA<{ unknown: number; items: { year: number; count: number }[] }>(f, "/analytics/accounts/created-year");
  const tags = useA<{ items: { hashtag: string; count: number }[] }>(f, "/analytics/hashtags?limit=30");
  const geoItems = geo.data?.items.map((g) => ({ key: g.code, name: g.name, value: g.count }));
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel
            title="Lokasi (provinsi)"
            info="Dari lokasi profil / teks post. Yang tidak terdeteksi tidak dihitung — lihat cakupan."
            right={geo.data && <span className="text-xs text-zinc-500">terdeteksi {geo.data.coverage_pct}% post</span>}
          >
            <BarList
              items={geoItems?.slice(0, 15)}
              color="#16a34a"
              onPick={(k, n) => drill({ title: `Lokasi ${n}`, params: { region: k } })}
            />
          </Panel>
        </div>
        <Panel title="10 provinsi teratas">
          <PieChart donut items={geoItems?.slice(0, 10)} onPick={(k, n) => drill({ title: `Lokasi ${n}`, params: { region: k } })} />
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Kecenderungan waktu aktif" info="Jumlah post per hari & jam (WIB).">
          <Heatmap f={f} />
        </Panel>
        <Panel
          title="Tahun akun dibuat"
          info={`Hanya platform yang memberi tanggal pembuatan akun. Tidak diketahui: ${year.data?.unknown ?? 0} akun.`}
        >
          {year.data?.items.length ? (
            <ReactECharts
              style={{ height: 280 }}
              option={{
                tooltip: { trigger: "axis" },
                grid: { left: 40, right: 16, top: 16, bottom: 40 },
                xAxis: { type: "category", data: year.data.items.map((i) => i.year), axisLabel: { rotate: 45 } },
                yAxis: { type: "value" },
                series: [{ type: "bar", data: year.data.items.map((i) => i.count), itemStyle: { color: "#60a5fa" } }],
              }}
            />
          ) : (
            <Empty>Belum ada data.</Empty>
          )}
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Hashtag">
            <Treemap
              items={tags.data?.items.map((t) => ({ key: t.hashtag, name: `#${t.hashtag}`, value: t.count }))}
              onPick={(k) => drill({ title: `#${k}`, params: { hashtag: k } })}
            />
          </Panel>
        </div>
        <Panel title="Komposisi gender">
          <GenderPie f={f} />
        </Panel>
      </div>
      <Psychography f={f} />
    </>
  );
}

export default function Audience() {
  return <AnalyticsPage title="Audiens">{(f) => <Body f={f} />}</AnalyticsPage>;
}

// ---------------------------------------------------------------- Psikografi (A-08/A-09, D-04, U-06)
interface PsyGroup {
  total: number;
  unknown: number;
  coverage_pct: number;
  items: { key: string; count: number; pct: number; sentiment: Record<string, number> }[];
}
interface Psy {
  gender: PsyGroup;
  age: PsyGroup;
}
const GENDER_LABEL: Record<string, string> = { male: "Laki-laki", female: "Perempuan" };
const GENDER_COLOR: Record<string, string> = { male: "#2563eb", female: "#db2777" };
const AGE_ORDER = ["18_21", "22_30", "31_45", "46_55", "above_55"];
const AGE_LABEL: Record<string, string> = { "18_21": "18–21", "22_30": "22–30", "31_45": "31–45", "46_55": "46–55", above_55: "> 55" };

const Coverage = ({ g }: { g: PsyGroup | undefined }) =>
  g ? (
    <span className="text-xs text-zinc-500" title="Porsi post dari akun yang gender/usianya bisa diperkirakan dengan yakin">
      terdeteksi {g.coverage_pct}% · tidak diketahui {fmtN(g.unknown)} post
    </span>
  ) : null;

function GenderPie({ f }: { f: Filters }) {
  const q = useA<Psy>(f, "/analytics/psychography");
  const g = q.data?.gender;
  return (
    <>
      <PieChart
        donut
        height={240}
        items={g?.items.map((i) => ({ key: i.key, name: GENDER_LABEL[i.key] ?? i.key, value: i.count, color: GENDER_COLOR[i.key] }))}
      />
      <div className="text-center">
        <Coverage g={g} />
      </div>
    </>
  );
}

function SentimentBars({ g, order, label }: { g: PsyGroup | undefined; order: string[]; label: (k: string) => string }) {
  const items = order.map((k) => g?.items.find((i) => i.key === k)).filter((i): i is PsyGroup["items"][number] => !!i);
  if (!items.length) return <Empty>Belum cukup data terdeteksi.</Empty>;
  return (
    <ReactECharts
      style={{ height: Math.max(180, items.length * 44 + 60) }}
      option={{
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => `${v}%` },
        legend: { bottom: 0 },
        grid: { left: 90, right: 24, top: 8, bottom: 40 },
        xAxis: { type: "value", max: 100, axisLabel: { formatter: "{value}%" } },
        yAxis: { type: "category", inverse: true, data: items.map((i) => label(i.key)) },
        series: (["negative", "neutral", "positive"] as const).map((s) => ({
          name: SENT_LABEL[s],
          type: "bar",
          stack: "s",
          itemStyle: { color: SENT_COLOR[s] },
          data: items.map((i) => (i.count ? Math.round(((i.sentiment[s] ?? 0) / i.count) * 1000) / 10 : 0)),
        })),
      }}
    />
  );
}

/** Hanya agregat: tidak ada label gender/usia per akun atau per post di mana pun (SEC-09, ADR-007). */
function Psychography({ f }: { f: Filters }) {
  const q = useA<Psy>(f, "/analytics/psychography");
  const d = q.data;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="Rentang usia"
          info="Perkiraan dari nama/username/umur akun; hanya akun yang cukup yakin. Di bawah 18 tahun tidak pernah ditandai per akun."
          right={<Coverage g={d?.age} />}
        >
          <BarList
            color="#7c3aed"
            items={AGE_ORDER.map((k) => d?.age.items.find((i) => i.key === k))
              .filter((i): i is PsyGroup["items"][number] => !!i)
              .map((i) => ({ key: i.key, name: AGE_LABEL[i.key] ?? i.key, value: i.count }))}
          />
        </Panel>
        <Panel title="Sentimen per gender" info="Persentase sentimen post dari masing-masing kelompok.">
          <SentimentBars g={d?.gender} order={["male", "female"]} label={(k) => GENDER_LABEL[k] ?? k} />
        </Panel>
        <Panel title="Sentimen per usia">
          <SentimentBars g={d?.age} order={AGE_ORDER} label={(k) => AGE_LABEL[k] ?? k} />
        </Panel>
      </div>
      <p className="text-xs text-zinc-500">
        Psikografi = <b>perkiraan</b> dari nama tampilan, username, dan umur akun (bukan data resmi), hanya ditampilkan sebagai agregat.
        Akun organisasi/media dan akun yang meragukan masuk “tidak diketahui”.
      </p>
    </>
  );
}
