// Pengaturan → Batas & jadwal (owner): SEMUA angka yang memengaruhi volume & biaya di satu tempat —
//   jadwal pengambilan + maks. post per platform, scrape awal topik, komentar, dan batas tiap sumber (config connector).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, ErrorText, Input, PLATFORM_LABEL, Select, Switch } from "../ui";

interface PlatformRow {
  code: string;
  name: string;
  enabled: boolean;
  max_items_per_run: number | null;
  crawl_interval_sec: number | null;
}
type SettingValues = Record<string, number | boolean>;
interface SettingsResp {
  values: SettingValues;
  defaults: SettingValues;
  overridden: string[];
}
interface SchemaProp {
  type?: string;
  minimum?: number | null;
  maximum?: number | null;
  description?: string | null;
}
interface ConnectorRow {
  id: string;
  key: string;
  platform: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  config_fields: (SchemaProp & { key: string })[];
}

const INTERVALS = [
  { v: 300, l: "5 menit" },
  { v: 600, l: "10 menit" },
  { v: 900, l: "15 menit" },
  { v: 1800, l: "30 menit" },
  { v: 3600, l: "1 jam" },
  { v: 7200, l: "2 jam" },
  { v: 10800, l: "3 jam" },
  { v: 21600, l: "6 jam" },
  { v: 43200, l: "12 jam" },
  { v: 86400, l: "24 jam" },
];

/** Label manusia untuk kunci config connector yang umum (lainnya memakai description schema / nama kunci). */
const CONFIG_LABEL: Record<string, string> = {
  maxTotalChargeUsd: "Batas biaya per pengambilan (USD)",
  maxHashtags: "Maks. hashtag per pengambilan",
  maxHashtagPages: "Maks. halaman per hashtag",
  maxKeywords: "Maks. keyword per pengambilan",
  maxSearchPages: "Maks. halaman pencarian per keyword",
  maxCommentPages: "Maks. halaman komentar per post",
  keywordSearch: "Pencarian keyword",
  fetchChannels: "Ambil data kanal (follower)",
  usdPerRequest: "Tarif per request (USD) — untuk catatan biaya",
  memoryMb: "Memori actor (MB)",
  waitSecs: "Tunggu hasil actor (detik)",
  pollAfterMs: "Jeda cek status (ms)",
  timeoutSecs: "Batas waktu actor (detik)",
};
const isEditable = (p: SchemaProp) => p.type === "integer" || p.type === "number" || p.type === "boolean";

function PlatformRowEdit({ p }: { p: PlatformRow }) {
  const qc = useQueryClient();
  const [max, setMax] = useState(p.max_items_per_run ? String(p.max_items_per_run) : "");
  useEffect(() => setMax(p.max_items_per_run ? String(p.max_items_per_run) : ""), [p.max_items_per_run]);
  const save = useMutation({
    mutationFn: (b: Record<string, number | null>) => api(`/admin/platforms/${p.code}`, { method: "PATCH", json: b }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-platforms"] }),
  });
  const n = max.trim() === "" ? null : Number(max);
  const validMax = n === null || (Number.isInteger(n) && n >= 1 && n <= 10_000);
  const dirtyMax = (n ?? null) !== (p.max_items_per_run ?? null);
  return (
    <tr className="align-middle">
      <td className="py-2 pr-3 font-medium">{PLATFORM_LABEL[p.code] ?? p.name}</td>
      <td className="pr-3">
        <Select
          className="py-1"
          value={p.crawl_interval_sec ?? ""}
          onChange={(e) => save.mutate({ crawl_interval_sec: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">bawaan sistem (1 jam)</option>
          {INTERVALS.map((i) => (
            <option key={i.v} value={i.v}>
              tiap {i.l}
            </option>
          ))}
        </Select>
      </td>
      <td className="pr-3">
        <div className="flex items-center gap-2">
          <input
            inputMode="numeric"
            placeholder="300 (bawaan)"
            value={max}
            onChange={(e) => setMax(e.target.value.replace(/[^0-9]/g, ""))}
            className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-sm"
          />
          {dirtyMax && (
            <Button variant="ghost" onClick={() => save.mutate({ max_items_per_run: n })} disabled={!validMax || save.isPending}>
              Simpan
            </Button>
          )}
          {!validMax && <span className="text-xs text-red-600">1–10.000</span>}
        </div>
      </td>
      <td className="text-xs text-red-600">{save.error ? (save.error as Error).message : ""}</td>
    </tr>
  );
}

function NumField({
  label,
  hint,
  value,
  def,
  min,
  max,
  onSave,
}: {
  label: string;
  hint?: string;
  value: number;
  def: number;
  min: number;
  max: number;
  onSave: (v: number | null) => void;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const n = Number(v);
  const valid = v.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
      <span className="min-w-56 flex-1">
        {label}
        {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      </span>
      <input
        inputMode="numeric"
        value={v}
        onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ""))}
        className="w-24 rounded-md border border-zinc-300 px-2 py-1"
      />
      <span className="w-28 text-xs text-zinc-400">bawaan {def}</span>
      {String(value) !== v && (
        <Button variant="ghost" onClick={() => onSave(n)} disabled={!valid}>
          Simpan
        </Button>
      )}
      {!valid && (
        <span className="text-xs text-red-600">
          {min}–{max}
        </span>
      )}
    </div>
  );
}

function GlobalSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-settings"], queryFn: () => api<SettingsResp>("/admin/settings") });
  const put = useMutation({
    mutationFn: (values: Record<string, number | boolean | null>) => api("/admin/settings", { method: "PUT", json: { values } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-settings"] }),
  });
  const v = q.data?.values;
  const d = q.data?.defaults;
  if (!v || !d) return <ErrorText error={q.error} />;
  const num = (k: string) => Number(v[k]);
  const save = (k: string) => (x: number | null) => put.mutate({ [k]: x });
  const posts = num("comments.top_posts_per_day");
  const pages = num("comments.max_pages_per_post");
  return (
    <>
      <Card title="Topik baru">
        <NumField
          label="Scrape awal saat topik dibuat (hari ke belakang)"
          hint="Topik baru / platform yang baru dicentang langsung diambil datanya sejauh ini, lalu mengikuti jadwal platform. 0 = mati."
          value={num("topics.initial_backfill_days")}
          def={Number(d["topics.initial_backfill_days"])}
          min={0}
          max={31}
          onSave={save("topics.initial_backfill_days")}
        />
      </Card>
      <Card
        title="Komentar"
        right={<Switch on={!!v["comments.enabled"]} onChange={(on) => put.mutate({ "comments.enabled": on })} disabled={put.isPending} />}
      >
        <p className="mb-2 text-sm text-zinc-600">
          Komentar diambil dari post <b>engagement tertinggi</b> tiap topik, lalu dianalisis (sentimen, emosi, isu) dan ditampilkan sebagai
          bagian topik — walau komentarnya tidak menyebut keyword. Platform yang didukung saat ini: <Badge tone="green">YouTube</Badge>{" "}
          <Badge>TikTok (setelah saldo LamaTok diisi & diverifikasi)</Badge>.
        </p>
        <NumField
          label="Post teratas per topik per platform per hari"
          value={posts}
          def={Number(d["comments.top_posts_per_day"])}
          min={0}
          max={1000}
          onSave={save("comments.top_posts_per_day")}
        />
        <NumField
          label="Halaman komentar per post"
          hint="± 50 (TikTok) / 100 (YouTube) komentar per halaman"
          value={pages}
          def={Number(d["comments.max_pages_per_post"])}
          min={1}
          max={50}
          onSave={save("comments.max_pages_per_post")}
        />
        <NumField
          label="Ambil ulang komentar post yang sama setelah (jam)"
          value={num("comments.refetch_hours")}
          def={Number(d["comments.refetch_hours"])}
          min={1}
          max={720}
          onSave={save("comments.refetch_hours")}
        />
        <NumField
          label="Hanya post ≤ N hari terakhir"
          value={num("comments.max_post_age_days")}
          def={Number(d["comments.max_post_age_days"])}
          min={1}
          max={30}
          onSave={save("comments.max_post_age_days")}
        />
        <p className="mt-2 text-xs text-zinc-500">
          Perkiraan: ± {posts * pages} request per topik per platform per hari (TikTok ± ${(posts * pages * 0.001 * 30).toFixed(2)}
          /topik/bulan; YouTube gratis, memakai kuota harian).
        </p>
      </Card>
      <ErrorText error={put.error} />
    </>
  );
}

function ConnectorLimits({ c }: { c: ConnectorRow }) {
  const qc = useQueryClient();
  const props = (c.config_fields ?? []).filter(isEditable).map((f) => [f.key, f] as const);
  const cfg = c.config ?? {};
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const next: Record<string, unknown> = { ...cfg };
      delete next.health; // dikelola terpisah oleh API
      for (const [k, raw] of Object.entries(draft)) {
        const p = c.config_fields?.find((f) => f.key === k);
        if (raw === "") delete next[k];
        else next[k] = p?.type === "boolean" ? raw === "true" : Number(raw);
      }
      return api(`/admin/connectors/${c.id}`, { method: "PATCH", json: { config: next } });
    },
    onSuccess: () => {
      setDraft({});
      void qc.invalidateQueries({ queryKey: ["admin-connectors"] });
    },
  });
  if (!props.length) return null;
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <span className="font-mono text-xs">{c.key}</span>
        <Badge tone={c.enabled ? "green" : "zinc"}>{c.enabled ? "aktif" : "nonaktif"}</Badge>
      </div>
      <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
        {props.map(([k, p]) => {
          const cur = draft[k] ?? (cfg[k] === undefined ? "" : String(cfg[k]));
          return (
            <div key={k} className="flex items-center gap-2 text-xs text-zinc-600" title={p.description ?? k}>
              <label htmlFor={`cfg-${c.id}-${k}`} className="flex-1">
                {CONFIG_LABEL[k] ?? p.description ?? k}
              </label>
              {p.type === "boolean" ? (
                <Select
                  id={`cfg-${c.id}-${k}`}
                  className="py-0.5 text-xs"
                  value={cur}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                >
                  <option value="">bawaan</option>
                  <option value="true">ya</option>
                  <option value="false">tidak</option>
                </Select>
              ) : (
                <Input
                  id={`cfg-${c.id}-${k}`}
                  className="w-28 py-1 text-xs"
                  inputMode="decimal"
                  placeholder={`bawaan${p.maximum != null ? ` (≤ ${p.maximum})` : ""}`}
                  value={cur}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value.replace(/[^0-9.]/g, "") })}
                />
              )}
            </div>
          );
        })}
      </div>
      {Object.keys(draft).length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Simpan batas {c.key}
          </Button>
          <ErrorText error={save.error} />
        </div>
      )}
    </div>
  );
}

interface RateLimit {
  id: string;
  scope_type: string;
  scope_id: string;
  algorithm: string;
  capacity: number;
  enabled: boolean;
}
interface AccountLite {
  id: string;
  provider_key: string;
  label: string;
}
/** Batas run bersamaan per akun provider (mis. Apify FREE menolak terlalu banyak run paralel → HTTP 402 memori). */
function Concurrency() {
  const qc = useQueryClient();
  const rl = useQuery({ queryKey: ["admin-rate-limits"], queryFn: () => api<RateLimit[]>("/admin/rate-limits") });
  const accs = useQuery({ queryKey: ["admin-accounts"], queryFn: () => api<AccountLite[]>("/admin/accounts") });
  const save = useMutation({
    mutationFn: (x: { id: string; capacity: number }) =>
      api(`/admin/rate-limits/${x.id}`, {
        method: "PATCH",
        json: {
          capacity: x.capacity,
          source: "internal_safety",
          source_ref: `diatur owner di Pengaturan ${new Date().toISOString().slice(0, 10)}`,
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-rate-limits"] }),
  });
  const rows = (rl.data ?? []).filter((r) => r.algorithm === "concurrency" && r.enabled);
  if (!rows.length) return null;
  return (
    <Card title="Run bersamaan per akun">
      <p className="mb-2 text-sm text-zinc-600">
        Berapa banyak pengambilan boleh berjalan sekaligus memakai satu akun provider. Lebih besar = data topik baru lebih cepat terisi,
        tapi plan Apify kecil menolak run paralel yang terlalu banyak.
      </p>
      {rows.map((r) => {
        const a = accs.data?.find((x) => x.id === r.scope_id);
        return (
          <NumField
            key={r.id}
            label={a ? `${a.provider_key} · ${a.label}` : `${r.scope_type} ${r.scope_id.slice(0, 8)}`}
            value={r.capacity}
            def={r.capacity}
            min={1}
            max={100}
            onSave={(v) => v !== null && save.mutate({ id: r.id, capacity: v })}
          />
        );
      })}
      <ErrorText error={save.error ?? rl.error} />
    </Card>
  );
}

export default function Limits() {
  const platforms = useQuery({ queryKey: ["admin-platforms"], queryFn: () => api<PlatformRow[]>("/admin/platforms") });
  const connectors = useQuery({ queryKey: ["admin-connectors"], queryFn: () => api<ConnectorRow[]>("/admin/connectors") });
  const [showAll, setShowAll] = useState(false);
  const conns = (connectors.data ?? []).filter((c) => !c.key.startsWith("fake.") && (showAll || c.enabled));
  return (
    <div className="space-y-4">
      <Card title="Jadwal & volume per platform">
        <p className="mb-2 text-sm text-zinc-600">
          <b>Jadwal pengambilan</b> = seberapa sering server menarik data baru dari media sosial (berlaku ke semua topik & menentukan
          biaya). Ini berbeda dengan <i>auto-refresh</i> di dashboard, yang hanya memuat ulang tampilan.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="py-2">Platform</th>
                <th>Jadwal pengambilan</th>
                <th>Maks. post per pengambilan</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {platforms.data
                ?.filter((p) => p.enabled)
                .map((p) => (
                  <PlatformRowEdit key={p.code} p={p} />
                ))}
            </tbody>
          </table>
        </div>
        <ErrorText error={platforms.error} />
      </Card>
      <GlobalSettings />
      <Concurrency />
      <Card
        title="Batas tiap sumber data"
        right={
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> tampilkan yang nonaktif
          </label>
        }
      >
        <p className="mb-3 text-sm text-zinc-600">
          Kosong = bawaan connector. Menaikkan batas menambah data <b>dan</b> biaya per pengambilan.
        </p>
        <div className="space-y-3">
          {conns.map((c) => (
            <ConnectorLimits key={c.id} c={c} />
          ))}
        </div>
        <ErrorText error={connectors.error} />
      </Card>
    </div>
  );
}
