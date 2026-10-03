// O-01 (sisa) + O-02 Pengaturan → Routing (owner): urutan & bobot sumber per platform/operasi (routing policy) dan simulator
// "sumber mana yang akan dipakai untuk kantor X?" lengkap dengan alasan tiap sumber tersisih (trace router).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, ErrorText, Input, PLATFORM_LABEL, Select, Switch } from "../ui";

interface Rule {
  id?: string;
  connector_id: string;
  connector_key: string;
  priority: number;
  weight: number;
  enabled: boolean;
  max_share_pct: number | null;
}
interface Policy {
  id: string;
  tenant_id: string | null;
  platform: string;
  operation: string;
  strategy: "priority_weighted" | "round_robin" | "cost_aware";
  failover_enabled: boolean;
  max_attempts: number;
  allow_unverified: boolean;
  enabled: boolean;
  version: number;
  rules: Rule[];
}
interface Conn {
  id: string;
  key: string;
  platform: string;
  enabled: boolean;
}
interface Office {
  id: string;
  name: string;
}
interface SimResult {
  decision:
    | { kind: "selected"; connector_key: string; account_label: string | null; strategy: string }
    | { kind: "none_available"; reason: string };
  trace: { connector_key: string; priority: number; eliminated_by?: string; effective_weight?: number; eligible_accounts?: number }[];
}

export const OP_LABEL: Record<string, string> = {
  search_keyword: "Cari kata kunci",
  search_hashtag: "Cari hashtag",
  user_timeline: "Pantau akun",
  post_comments: "Komentar",
  post_detail: "Detail post",
  profile: "Profil",
};
const WHY: Record<string, string> = {
  RULE_DISABLED: "aturan dimatikan",
  CONNECTOR_DISABLED: "sumber dimatikan",
  PROVIDER_DISABLED: "provider dimatikan",
  RUN_KIND_MISMATCH: "bukan untuk jenis pengambilan ini",
  EXCLUDED: "dikecualikan (baru gagal di percobaan ini)",
  CAPABILITY_MISSING: "tidak punya kemampuan ini",
  CAPABILITY_NOT_VERIFIED: "belum diverifikasi",
  CAPABILITY_FAILED: "verifikasi gagal",
  FEATURES_UNSUPPORTED: "query tidak didukung",
  INTERVAL_TOO_SHORT: "jadwal terlalu rapat untuk sumber ini",
  SHARE_CAP: "batas porsi traffic tercapai",
  NO_ELIGIBLE_ACCOUNT: "tidak ada akun/API key yang siap (saldo habis / jeda / bermasalah)",
  STANDBY: "cadangan (dipakai bila yang utama gagal)",
  TENANT_RISK_OPT_OUT: "kantor menolak sumber berisiko",
};
const REASON: Record<string, string> = {
  NO_POLICY: "belum ada routing untuk platform/operasi ini",
  POLICY_DISABLED: "routing dimatikan",
  NO_CANDIDATE: "tidak ada sumber yang layak",
  ALL_UNHEALTHY: "semua sumber sedang tidak sehat",
};

function PolicyEditor({ p, conns }: { p: Policy; conns: Conn[] }) {
  const qc = useQueryClient();
  const [rules, setRules] = useState<Rule[]>(p.rules);
  const [enabled, setEnabled] = useState(p.enabled);
  const [failover, setFailover] = useState(p.failover_enabled);
  useEffect(() => {
    setRules(p.rules);
    setEnabled(p.enabled);
    setFailover(p.failover_enabled);
  }, [p]);
  const dirty = JSON.stringify([rules, enabled, failover]) !== JSON.stringify([p.rules, p.enabled, p.failover_enabled]);
  const save = useMutation({
    mutationFn: () =>
      api(`/admin/routing-policies/${p.id}`, {
        method: "PUT",
        headers: { "if-match": `"${p.version}"` },
        json: {
          strategy: p.strategy,
          failover_enabled: failover,
          max_attempts: p.max_attempts,
          allow_unverified: p.allow_unverified,
          enabled,
          rules: rules.map((r) => ({
            connector_id: r.connector_id,
            priority: r.priority,
            weight: r.weight,
            enabled: r.enabled,
            max_share_pct: r.max_share_pct,
          })),
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["routing-policies"] }),
  });
  const set = (i: number, patch: Partial<Rule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const available = conns.filter((c) => c.platform === p.platform && !rules.some((r) => r.connector_id === c.id));
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold">
          {PLATFORM_LABEL[p.platform] ?? p.platform} · {OP_LABEL[p.operation] ?? p.operation}
        </span>
        {p.tenant_id && <Badge tone="blue">khusus kantor</Badge>}
        <span className="ml-auto flex items-center gap-2 text-xs text-zinc-600">
          pindah ke cadangan bila gagal <Switch on={failover} onChange={setFailover} />
          aktif <Switch on={enabled} onChange={setEnabled} />
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-zinc-500">
          <tr>
            <th className="py-1">Sumber</th>
            <th title="1 = dicoba pertama; angka lebih besar = cadangan">Urutan</th>
            <th title="Pembagian traffic antar sumber dengan urutan sama">Bobot</th>
            <th>Aktif</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => {
            const c = conns.find((x) => x.id === r.connector_id);
            return (
              <tr key={r.connector_id} className="border-t border-zinc-100">
                <td className="py-1.5">
                  <code className="text-xs">{r.connector_key}</code>
                  {c && !c.enabled && (
                    <span className="ml-2">
                      <Badge tone="zinc">sumber mati</Badge>
                    </span>
                  )}
                </td>
                <td>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={r.priority}
                    onChange={(e) => set(i, { priority: Math.max(1, Number(e.target.value) || 1) })}
                    className="w-20 py-1"
                    aria-label="urutan"
                  />
                </td>
                <td>
                  <Input
                    type="number"
                    min={0}
                    max={1000}
                    value={r.weight}
                    onChange={(e) => set(i, { weight: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-24 py-1"
                    aria-label="bobot"
                  />
                </td>
                <td>
                  <Switch on={r.enabled} onChange={(on) => set(i, { enabled: on })} />
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="text-xs text-zinc-400 hover:text-red-600"
                    onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  >
                    lepas
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {available.length > 0 && (
          <Select
            value=""
            onChange={(e) => {
              const c = conns.find((x) => x.id === e.target.value);
              if (c)
                setRules([
                  ...rules,
                  {
                    connector_id: c.id,
                    connector_key: c.key,
                    priority: Math.max(1, ...rules.map((r) => r.priority)) + 1,
                    weight: 100,
                    enabled: true,
                    max_share_pct: null,
                  },
                ]);
            }}
            className="py-1 text-sm"
            aria-label="tambah sumber"
          >
            <option value="">+ tambah sumber cadangan…</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.key}
                {c.enabled ? "" : " (mati)"}
              </option>
            ))}
          </Select>
        )}
        {dirty && (
          <>
            <Button onClick={() => save.mutate()} disabled={save.isPending} className="py-1">
              Simpan
            </Button>
            <Button
              variant="ghost"
              className="py-1"
              onClick={() => {
                setRules(p.rules);
                setEnabled(p.enabled);
                setFailover(p.failover_enabled);
              }}
            >
              Batal
            </Button>
          </>
        )}
      </div>
      <ErrorText error={save.error} />
    </div>
  );
}

function Simulator({ policies, offices }: { policies: Policy[]; offices: Office[] }) {
  const pairs = [...new Map(policies.map((p) => [`${p.platform}|${p.operation}`, p])).values()];
  const [office, setOffice] = useState("");
  const [pair, setPair] = useState("");
  const [kind, setKind] = useState("incremental");
  const [iv, setIv] = useState(3600);
  const sim = useMutation({
    mutationFn: () => {
      const [platform, operation] = (pair || `${pairs[0]?.platform}|${pairs[0]?.operation}`).split("|");
      return api<SimResult>("/admin/routing-policies/simulate", {
        method: "POST",
        json: { tenant_id: office || offices[0]?.id, platform, operation, run_kind: kind, interval_sec: iv },
      });
    },
  });
  const d = sim.data?.decision;
  return (
    <Card title="Simulator: sumber mana yang akan dipakai?">
      <div className="grid gap-2 md:grid-cols-5">
        <Select value={office} onChange={(e) => setOffice(e.target.value)} aria-label="kantor">
          {offices.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
        <Select value={pair} onChange={(e) => setPair(e.target.value)} aria-label="platform">
          {pairs.map((p) => (
            <option key={`${p.platform}|${p.operation}`} value={`${p.platform}|${p.operation}`}>
              {PLATFORM_LABEL[p.platform] ?? p.platform} · {OP_LABEL[p.operation] ?? p.operation}
            </option>
          ))}
        </Select>
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="jenis">
          <option value="incremental">Pengambilan rutin</option>
          <option value="backfill">Scrape awal / isi celah</option>
          <option value="comments">Komentar</option>
        </Select>
        <Select value={String(iv)} onChange={(e) => setIv(Number(e.target.value))} aria-label="jadwal">
          {[300, 900, 1800, 3600, 10800].map((v) => (
            <option key={v} value={v}>
              jadwal {v < 3600 ? `${v / 60} menit` : `${v / 3600} jam`}
            </option>
          ))}
        </Select>
        <Button onClick={() => sim.mutate()} disabled={sim.isPending || !offices.length || !pairs.length}>
          Simulasikan
        </Button>
      </div>
      <ErrorText error={sim.error} />
      {d && (
        <div className="mt-3 space-y-2">
          {d.kind === "selected" ? (
            <p className="text-sm">
              ✅ Dipakai: <code className="font-semibold">{d.connector_key}</code>
              {d.account_label ? ` dengan akun ${d.account_label}` : ""}
            </p>
          ) : (
            <p className="text-sm text-red-700">⛔ Tidak bisa mengambil: {REASON[d.reason] ?? d.reason}</p>
          )}
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500">
              <tr>
                <th className="py-1">Sumber</th>
                <th>Urutan</th>
                <th>Hasil</th>
              </tr>
            </thead>
            <tbody>
              {sim.data?.trace.map((t) => (
                <tr key={t.connector_key} className="border-t border-zinc-100">
                  <td className="py-1">
                    <code className="text-xs">{t.connector_key}</code>
                  </td>
                  <td>{t.priority}</td>
                  <td className={t.eliminated_by ? "text-zinc-500" : "text-emerald-700"}>
                    {t.eliminated_by
                      ? `tersisih — ${WHY[t.eliminated_by] ?? t.eliminated_by}`
                      : `lolos · bobot ${t.effective_weight} · ${t.eligible_accounts} akun siap`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function Routing() {
  const policies = useQuery({ queryKey: ["routing-policies"], queryFn: () => api<Policy[]>("/admin/routing-policies") });
  const conns = useQuery({ queryKey: ["admin-connectors"], queryFn: () => api<Conn[]>("/admin/connectors") });
  const offices = useQuery({ queryKey: ["tenants"], queryFn: () => api<Office[]>("/admin/tenants") });
  const [showAll, setShowAll] = useState(false);
  const list = (policies.data ?? []).filter((p) => showAll || p.rules.some((r) => r.enabled));
  const realConns = (conns.data ?? []).filter((c) => !c.key.startsWith("fake."));
  return (
    <div className="space-y-4">
      <Simulator policies={policies.data ?? []} offices={offices.data ?? []} />
      <Card
        title="Urutan sumber per platform"
        right={
          <label className="flex items-center gap-2 text-xs text-zinc-600">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            tampilkan routing tanpa sumber aktif
          </label>
        }
      >
        <p className="mb-3 text-xs text-zinc-500">
          Sumber dengan urutan 1 dicoba pertama; bila gagal (dan "pindah ke cadangan" aktif) sistem mencoba urutan berikutnya. Sumber dengan
          urutan sama berbagi traffic sesuai bobot. Perubahan berlaku untuk pengambilan berikutnya.
        </p>
        <ErrorText error={policies.error ?? conns.error} />
        {policies.data && !list.length && <Empty>Belum ada routing.</Empty>}
        <div className="space-y-3">
          {list.map((p) => (
            <PolicyEditor key={p.id} p={p} conns={realConns} />
          ))}
        </div>
      </Card>
    </div>
  );
}
