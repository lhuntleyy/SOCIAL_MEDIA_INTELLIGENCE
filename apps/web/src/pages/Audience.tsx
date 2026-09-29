import ReactECharts from "echarts-for-react";
import { BarList, type Filters, fmtN, Panel, PieChart, Treemap, useA, useDrill } from "../analytics";
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
        <Panel title="Psikografi (gender & usia)">
          <p className="text-sm text-zinc-600">
            Segera hadir: estimasi <b>gender</b> dan <b>rentang usia</b> audiens — hanya ditampilkan sebagai agregat (persentase + cakupan),
            tidak pernah per akun.
          </p>
        </Panel>
      </div>
    </>
  );
}

export default function Audience() {
  return <AnalyticsPage title="Audiens">{(f) => <Body f={f} />}</AnalyticsPage>;
}
