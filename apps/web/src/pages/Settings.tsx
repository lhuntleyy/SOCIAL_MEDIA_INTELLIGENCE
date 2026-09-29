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
const PROVIDER_NAME: Record<string, string> = { apify: "Apify", "youtube-data": "YouTube Data API", fake: "Uji (data palsu)" };
/** "apify.x.kaito" → "Apify · kaito" */
const sourceName = (c: Connector) => {
  const rest = c.key.split(".").slice(2).join(".");
  const p = PROVIDER_NAME[c.provider.key] ?? c.provider.key;
  return rest ? `${p} · ${rest}` : p;
};
function health(c: Connector) {
  if (!c.health.length) return { dot: "bg-zinc-300", text: "belum dicek" };
  if (c.health.some((h) => h.circuit !== "closed")) return { dot: "bg-red-500", text: "gangguan" };
  return { dot: "bg-emerald-500", text: "sehat" };
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
                  const h = health(c);
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
                      </div>
                      <Switch on={c.enabled} onChange={() => toggle.mutate(c)} disabled={toggle.isPending} />
                    </li>
                  );
                })}
              </ul>
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
