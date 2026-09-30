import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { Badge, Button, Card, ErrorText, PLATFORM_LABEL, Switch, Tabs } from "../ui";
import AiSettings from "./AdminLlm";

interface Connector {
  id: string;
  key: string;
  platform: string;
  enabled: boolean;
  provider: { key: string; kind: string; enabled: boolean };
  capabilities: { operation: string; status: string }[];
  health: { account_label: string | null; state: string; circuit: string }[];
}
interface Account {
  id: string;
  provider_id: string;
  provider_key: string;
  label: string;
  status: string;
  display_hint: string | null;
  cooldown_until: string | null;
  attention_reason: string | null;
  tenant_id: string | null;
}
interface PlatformSetting {
  code: string;
  max_items_per_run: number | null;
}
interface Quota {
  id: string;
  scope_type: string;
  scope_id: string | null;
  period: string;
  unit: string;
  limit_value: number;
  enabled: boolean;
  used: number | null;
}
interface Usage {
  connector: string;
  attempts: number;
  successes: number;
  cost_units: number;
}

const KIND: Record<string, { label: string; tone: "blue" | "zinc" | "red" }> = {
  official: { label: "resmi", tone: "blue" },
  third_party: { label: "pihak ketiga", tone: "zinc" },
  unofficial: { label: "tidak resmi", tone: "red" },
};
const PROVIDER_NAME: Record<string, string> = {
  apify: "Apify",
  "youtube-data": "YouTube Data API",
  youtube_data_api: "YouTube Data API",
  fake: "Uji (data palsu)",
};
const ACCOUNT_STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "zinc" }> = {
  active: { label: "aktif", tone: "green" },
  needs_attention: { label: "butuh perhatian", tone: "red" },
  cooling_down: { label: "jeda sementara", tone: "amber" },
  disabled: { label: "nonaktif", tone: "zinc" },
  revoked: { label: "dicabut", tone: "zinc" },
};
const REASON: Record<string, string> = {
  FORBIDDEN: "provider menolak akses (HTTP 403) — cek saldo/batas pemakaian & izin di dashboard provider",
  AUTH_INVALID: "token/API key tidak valid atau kedaluwarsa — ganti credential",
  CHALLENGE_REQUIRED: "platform meminta verifikasi akun — selesaikan manual",
  BLOCKED: "akun diblokir provider",
};
/** "apify.x.kaito" → "Apify · kaito" */
const sourceName = (c: Connector) => {
  const rest = c.key.split(".").slice(2).join(".");
  const p = PROVIDER_NAME[c.provider.key] ?? c.provider.key;
  return rest ? `${p} · ${rest}` : p;
};
function health(c: Connector, blocked: boolean) {
  if (blocked) return { dot: "bg-red-500", text: "akun provider butuh perhatian" };
  if (!c.health.length) return { dot: "bg-zinc-300", text: "belum dicek" };
  if (c.health.some((h) => h.circuit !== "closed")) return { dot: "bg-red-500", text: "gangguan" };
  return { dot: "bg-emerald-500", text: "sehat" };
}

/**
 * Batas biaya bulanan (USD, hard) untuk provider atau satu sumber — tercapai → sumber itu dilewati (router pindah ke cadangan)
 * sampai bulan berikutnya. Kosong = tanpa batas (kuota dinonaktifkan, bukan dihapus).
 */
function Budget({
  scope,
  id,
  quotas,
  label = "Batas biaya/bulan",
}: {
  scope: "provider" | "connector";
  id: string;
  quotas: Quota[] | undefined;
  label?: string;
}) {
  const qc = useQueryClient();
  const q = quotas?.find((x) => x.scope_type === scope && x.scope_id === id && x.period === "month" && x.unit === "cost_units");
  const [v, setV] = useState<string | null>(null);
  const cur = v ?? (q?.enabled ? String(q.limit_value) : "");
  const n = cur.trim() === "" ? null : Number(cur.replace(",", "."));
  const valid = n === null || (Number.isFinite(n) && n >= 0 && n <= 100_000);
  const save = useMutation({
    mutationFn: async () => {
      if (n === null) {
        if (q) await api(`/admin/quotas/${q.id}`, { method: "PATCH", json: { enabled: false } });
        return;
      }
      if (q) await api(`/admin/quotas/${q.id}`, { method: "PATCH", json: { limit_value: n, hard: true, enabled: true } });
      else
        await api("/admin/quotas", {
          method: "POST",
          json: { scope_type: scope, scope_id: id, period: "month", unit: "cost_units", limit_value: n, hard: true, enabled: true },
        });
    },
    onSuccess: () => {
      setV(null);
      void qc.invalidateQueries({ queryKey: ["admin-quotas"] });
    },
  });
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs text-zinc-600">
      <span title="Batas biaya bulanan (USD). Tercapai → sumber dilewati sampai bulan berikutnya. Kosong = tanpa batas.">{label}</span>
      <span className="text-zinc-400">$</span>
      <input
        inputMode="decimal"
        placeholder="tanpa batas"
        value={cur}
        onChange={(e) => setV(e.target.value.replace(/[^0-9.,]/g, ""))}
        className="w-24 rounded-md border border-zinc-300 px-2 py-0.5"
      />
      {q?.enabled && q.used !== null && <span className="text-zinc-400">terpakai ${q.used.toFixed(2)}</span>}
      {v !== null && (
        <Button variant="ghost" onClick={() => save.mutate()} disabled={!valid || save.isPending}>
          Simpan
        </Button>
      )}
      {!valid && <span className="text-red-600">angka tidak valid</span>}
      {save.error && <span className="text-red-600">{(save.error as Error).message}</span>}
    </span>
  );
}

/** Batas post per pengambilan (per run) untuk satu platform — kosong = bawaan sistem (300). */
function MaxItems({ code, value }: { code: string; value: number | null | undefined }) {
  const qc = useQueryClient();
  const [v, setV] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (n: number | null) => api(`/admin/platforms/${code}`, { method: "PATCH", json: { max_items_per_run: n } }),
    onSuccess: () => {
      setV(null);
      void qc.invalidateQueries({ queryKey: ["admin-platforms"] });
    },
  });
  const cur = v ?? (value ? String(value) : "");
  const n = cur.trim() === "" ? null : Number(cur);
  const valid = n === null || (Number.isInteger(n) && n >= 1 && n <= 1000);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2 text-xs text-zinc-600">
      <label
        htmlFor={`max-${code}`}
        title="Batas jumlah post yang diambil setiap kali sistem menarik data platform ini (per topik per jadwal)."
      >
        Maks. post per pengambilan
      </label>
      <input
        id={`max-${code}`}
        inputMode="numeric"
        placeholder="300 (bawaan)"
        value={cur}
        onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ""))}
        className="w-28 rounded-md border border-zinc-300 px-2 py-1"
      />
      {v !== null && (
        <Button variant="ghost" onClick={() => save.mutate(n)} disabled={!valid || save.isPending}>
          Simpan
        </Button>
      )}
      {!valid && <span className="text-red-600">1–1000</span>}
      <ErrorText error={save.error} />
    </div>
  );
}

function Sources() {
  const qc = useQueryClient();
  const [showTest, setShowTest] = useState(false);
  const q = useQuery({ queryKey: ["admin-connectors"], queryFn: () => api<Connector[]>("/admin/connectors") });
  const month = new Date();
  const from = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)).toISOString();
  const usage = useQuery({
    queryKey: ["admin-usage", from],
    queryFn: () => api<Usage[]>(`/admin/usage?group_by=connector&from=${from}&to=${new Date(Date.now() + 60_000).toISOString()}`),
  });
  const platformSettings = useQuery({
    queryKey: ["admin-platforms"],
    queryFn: () => api<PlatformSetting[]>("/admin/platforms"),
  });
  const quotas = useQuery({ queryKey: ["admin-quotas"], queryFn: () => api<Quota[]>("/admin/quotas") });
  const accounts = useQuery({ queryKey: ["admin-accounts"], queryFn: () => api<Account[]>("/admin/accounts") });
  const reactivate = useMutation({
    mutationFn: (a: Account) => api(`/admin/accounts/${a.id}`, { method: "PATCH", json: { status: "active" } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-accounts"] });
      void qc.invalidateQueries({ queryKey: ["admin-connectors"] });
    },
  });
  const toggle = useMutation({
    mutationFn: (c: Connector) => api(`/admin/connectors/${c.id}`, { method: "PATCH", json: { enabled: !c.enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-connectors"] }),
  });
  const probe = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => api(`/admin/connectors/${id}/health-check`, { method: "POST" }))),
    onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ["admin-connectors"] }), 8000),
  });
  const list = (q.data ?? []).filter((c) => showTest || c.provider.key !== "fake");
  const u = new Map((usage.data ?? []).map((x) => [x.connector, x]));
  const spend = (usage.data ?? []).filter((x) => x.connector.startsWith("apify.")).reduce((a, x) => a + x.cost_units, 0);
  const accs = (accounts.data ?? []).filter((a) => showTest || a.provider_key !== "fake");
  // provider tanpa satu pun akun aktif → semua connector-nya tidak bisa dipakai router
  const usable = (provider: string) => {
    const mine = (accounts.data ?? []).filter((a) => a.provider_key === provider && a.status !== "revoked");
    return !accounts.data || !mine.length || mine.some((a) => a.status === "active");
  };
  const platforms = Object.keys(PLATFORM_LABEL).filter((p) => list.some((c) => c.platform === p));
  return (
    <div className="space-y-4">
      <Card
        title="Sumber data per platform"
        right={
          <Button variant="ghost" onClick={() => probe.mutate(list.filter((c) => c.enabled).map((c) => c.id))} disabled={probe.isPending}>
            {probe.isSuccess ? "Dicek — hasil muncul sebentar lagi" : "Cek semua yang aktif"}
          </Button>
        }
      >
        <p className="text-sm text-zinc-600">
          Sistem memilih sumber otomatis & pindah ke sumber lain bila satu gangguan. Matikan sumber yang tidak ingin dipakai.
          {spend > 0 && (
            <>
              {" "}
              Biaya Apify bulan ini: <b>${spend.toFixed(2)}</b>.
            </>
          )}
        </p>
        <ErrorText error={q.error ?? toggle.error ?? probe.error} />
      </Card>
      <Card title="Akun provider">
        <p className="mb-2 text-sm text-zinc-600">
          Akun berstatus <b>butuh perhatian</b> tidak dipakai sama sekali — semua sumber dari provider itu berhenti mengambil data. Perbaiki
          penyebabnya di dashboard provider, lalu aktifkan lagi.
        </p>
        <ul className="divide-y divide-zinc-100">
          {accs.map((a) => {
            const st = ACCOUNT_STATUS[a.status] ?? { label: a.status, tone: "zinc" as const };
            const reason = a.attention_reason ? (REASON[a.attention_reason] ?? a.attention_reason) : null;
            return (
              <li key={a.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{PROVIDER_NAME[a.provider_key] ?? a.provider_key}</span>
                    <span className="text-zinc-500">{a.label}</span>
                    {a.display_hint && <span className="text-xs text-zinc-400">{a.display_hint}</span>}
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </div>
                  {(reason || a.cooldown_until) && (
                    <div className="text-xs text-zinc-500">
                      {reason}
                      {a.cooldown_until && ` · sampai ${new Date(a.cooldown_until).toLocaleString("id-ID")}`}
                    </div>
                  )}
                </div>
                {["needs_attention", "cooling_down"].includes(a.status) && (
                  <Button onClick={() => reactivate.mutate(a)} disabled={reactivate.isPending}>
                    Aktifkan lagi
                  </Button>
                )}
              </li>
            );
          })}
          {!accs.length && <li className="py-2 text-sm text-zinc-500">Belum ada akun.</li>}
        </ul>
        <div className="mt-3 space-y-1 border-t border-zinc-100 pt-2">
          {[...new Map(accs.map((a) => [a.provider_id, a.provider_key])).entries()].map(([pid, key]) => (
            <div key={pid}>
              <Budget scope="provider" id={pid} quotas={quotas.data} label={`Batas biaya ${PROVIDER_NAME[key] ?? key}/bulan`} />
            </div>
          ))}
        </div>
        <ErrorText error={accounts.error ?? reactivate.error} />
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {platforms.map((p) => {
          const rows = list.filter((c) => c.platform === p).sort((a, b) => Number(b.enabled) - Number(a.enabled));
          const on = rows.filter((c) => c.enabled).length;
          return (
            <Card
              key={p}
              title={PLATFORM_LABEL[p]!}
              right={<Badge tone={on ? "green" : "red"}>{on ? `${on} sumber aktif` : "tidak ada sumber aktif"}</Badge>}
            >
              <ul className="divide-y divide-zinc-100">
                {rows.map((c) => {
                  const h = health(c, !usable(c.provider.key));
                  const us = u.get(c.key);
                  const verified = c.capabilities.some((k) => k.status === "verified");
                  return (
                    <li key={c.id} className="flex items-center gap-3 py-2">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.enabled ? h.dot : "bg-zinc-200"}`} title={h.text} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm">
                          <span className={c.enabled ? "font-medium" : "text-zinc-400"}>{sourceName(c)}</span>
                          <Badge tone={KIND[c.provider.kind]?.tone ?? "zinc"}>{KIND[c.provider.kind]?.label ?? c.provider.kind}</Badge>
                        </div>
                        <div className="text-xs text-zinc-500">
                          {c.enabled ? h.text : "nonaktif"}
                          {!verified && " · belum terverifikasi"}
                          {us &&
                            us.attempts > 0 &&
                            ` · bulan ini ${us.attempts} run, ${Math.round((us.successes / us.attempts) * 100)}% sukses`}
                          {us && us.cost_units > 0 && `, $${us.cost_units.toFixed(3)}`}
                        </div>
                        {c.enabled && c.provider.kind !== "official" && <Budget scope="connector" id={c.id} quotas={quotas.data} />}
                      </div>
                      <Switch on={c.enabled} onChange={() => toggle.mutate(c)} disabled={toggle.isPending} />
                    </li>
                  );
                })}
              </ul>
              <MaxItems code={p} value={platformSettings.data?.find((x) => x.code === p)?.max_items_per_run} />
            </Card>
          );
        })}
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-500">
        <input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} /> tampilkan sumber uji (data palsu)
      </label>
    </div>
  );
}

type Tab = "sources" | "ai";
export default function Settings() {
  const [sp, setSp] = useSearchParams();
  const tab: Tab = sp.get("tab") === "ai" ? "ai" : "sources";
  return (
    <div className="space-y-4">
      <Tabs
        tabs={[
          { id: "sources", label: "Sumber data" },
          { id: "ai", label: "AI" },
        ]}
        value={tab}
        onChange={(v) => setSp({ tab: v }, { replace: true })}
      />
      {tab === "sources" ? <Sources /> : <AiSettings />}
    </div>
  );
}
