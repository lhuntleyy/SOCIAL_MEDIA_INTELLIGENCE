import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, ErrorText, fmtTime, Input } from "../ui";

type Kind = "gemini" | "openai_compatible" | "anthropic";
interface Key {
  id: string;
  label: string;
  display_hint: string | null;
  status: string;
  cooldown_until: string | null;
  last_error_code: string | null;
  last_used_at: string | null;
  requests_total: number;
}
interface Provider {
  id: string;
  key: string;
  name: string;
  kind: Kind;
  base_url: string | null;
  enabled: boolean;
  models: number;
  models_fetched_at: string | null;
  keys: Key[];
}
interface Task {
  task: string;
  provider_id: string | null;
  model_id: string | null;
  fallback_provider_id?: string | null;
  fallback_model_id?: string | null;
  enabled: boolean;
  params: { batch_size?: number; max_output_tokens?: number; max_rpm?: number };
}
interface Model {
  model_id: string;
  display_name: string | null;
  input_token_limit: number | null;
}

/** Preset provider — base_url standar; "Custom" = endpoint OpenAI-compatible sendiri (vLLM, Ollama, server internal). */
const PRESETS: { id: string; name: string; kind: Kind; base_url: string | null; hint: string }[] = [
  { id: "gemini", name: "Google Gemini", kind: "gemini", base_url: null, hint: "API key dari Google AI Studio" },
  { id: "openai", name: "OpenAI (ChatGPT)", kind: "openai_compatible", base_url: "https://api.openai.com/v1", hint: "API key sk-…" },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai_compatible",
    base_url: "https://openrouter.ai/api/v1",
    hint: "Satu key untuk banyak model",
  },
  { id: "claude", name: "Anthropic Claude", kind: "anthropic", base_url: null, hint: "API key sk-ant-…" },
  { id: "custom", name: "Custom (OpenAI-compatible)", kind: "openai_compatible", base_url: "https://", hint: "URL harus https & publik" },
];
const TASK_LABEL: Record<string, string> = {
  default: "Default (semua tugas)",
  sentiment: "Sentimen",
  emotion: "Emosi (8 Plutchik)",
  keyphrase: "Isu / keyphrase",
  summary: "Ringkasan (Resume)",
};
const keyTone = (k: Key) =>
  k.status === "invalid"
    ? "red"
    : k.status === "disabled"
      ? "zinc"
      : k.cooldown_until && new Date(k.cooldown_until) > new Date()
        ? "amber"
        : "green";

function useModels(pid: string | null) {
  return useQuery({ queryKey: ["llm-models", pid], queryFn: () => api<Model[]>(`/admin/llm/providers/${pid}/models`), enabled: !!pid });
}

function AddProvider({ onDone }: { onDone: () => void }) {
  const [preset, setPreset] = useState(PRESETS[0]!);
  const [name, setName] = useState(PRESETS[0]!.name);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const m = useMutation({
    mutationFn: () =>
      api("/admin/llm/providers", {
        method: "POST",
        json: {
          key: `${preset.id}${Date.now().toString(36).slice(-4)}`,
          name,
          kind: preset.kind,
          base_url: preset.kind === "openai_compatible" ? baseUrl || preset.base_url : null,
          ...(apiKey ? { api_key: apiKey, key_label: "key-1" } : {}),
        },
      }),
    onSuccess: () => {
      setApiKey("");
      onDone();
    },
  });
  return (
    <Card title="Tambah provider LLM">
      <div className="grid gap-3 md:grid-cols-4">
        <select
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          value={preset.id}
          onChange={(e) => {
            const p = PRESETS.find((x) => x.id === e.target.value)!;
            setPreset(p);
            setName(p.name);
            setBaseUrl(p.base_url ?? "");
          }}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Input placeholder="Nama" value={name} onChange={(e) => setName(e.target.value)} />
        {preset.kind === "openai_compatible" ? (
          <Input placeholder="Base URL" value={baseUrl || preset.base_url || ""} onChange={(e) => setBaseUrl(e.target.value)} />
        ) : (
          <div className="self-center text-xs text-zinc-500">{preset.hint}</div>
        )}
        <Input
          type="password"
          autoComplete="off"
          placeholder="API key (opsional, bisa ditambah nanti)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => m.mutate()} disabled={m.isPending || !name}>
          Simpan provider
        </Button>
        <ErrorText error={m.error} />
      </div>
    </Card>
  );
}

function ProviderCard({ p, refresh }: { p: Provider; refresh: () => void }) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const inv = { onSuccess: refresh };
  const addKey = useMutation({
    mutationFn: () => api(`/admin/llm/providers/${p.id}/keys`, { method: "POST", json: { label, api_key: key } }),
    onSuccess: () => {
      setKey("");
      setLabel("");
      refresh();
    },
  });
  const models = useMutation({
    mutationFn: () => api<{ count: number }>(`/admin/llm/providers/${p.id}/models/refresh`, { method: "POST" }),
    ...inv,
  });
  const toggle = useMutation({
    mutationFn: () => api(`/admin/llm/providers/${p.id}`, { method: "PATCH", json: { enabled: !p.enabled } }),
    ...inv,
  });
  const del = useMutation({ mutationFn: () => api(`/admin/llm/providers/${p.id}`, { method: "DELETE" }), ...inv });
  const keyOp = useMutation({
    mutationFn: (x: { id: string; op: "enable" | "disable" | "revoke" }) =>
      x.op === "revoke"
        ? api(`/admin/llm/keys/${x.id}`, { method: "DELETE" })
        : api(`/admin/llm/keys/${x.id}`, { method: "PATCH", json: { status: x.op === "enable" ? "active" : "disabled" } }),
    ...inv,
  });
  return (
    <Card
      title={p.name}
      right={
        <div className="flex items-center gap-2">
          <Badge tone="blue">{p.kind}</Badge>
          <Badge tone={p.enabled ? "green" : "zinc"}>{p.enabled ? "aktif" : "nonaktif"}</Badge>
        </div>
      }
    >
      {p.base_url && <p className="mb-2 font-mono text-xs text-zinc-500">{p.base_url}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-600">
          {p.models} model{p.models_fetched_at ? ` · diperbarui ${fmtTime(p.models_fetched_at)}` : ""}
        </span>
        <Button variant="ghost" onClick={() => models.mutate()} disabled={models.isPending}>
          {models.isPending ? "Mengambil…" : "Refresh model"}
        </Button>
        <Button variant="ghost" onClick={() => toggle.mutate()}>
          {p.enabled ? "Nonaktifkan" : "Aktifkan"}
        </Button>
        <Button variant="danger" onClick={() => confirm(`Hapus provider ${p.name}? Semua API key-nya dicabut.`) && del.mutate()}>
          Hapus
        </Button>
      </div>
      <ErrorText error={models.error ?? toggle.error ?? del.error ?? keyOp.error} />
      <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500">API key (dipakai bergiliran; 429 → jeda otomatis)</h3>
      {p.keys.length ? (
        <table className="mb-3 w-full text-sm">
          <tbody className="divide-y divide-zinc-100">
            {p.keys.map((k) => (
              <tr key={k.id}>
                <td className="py-1.5">{k.label}</td>
                <td className="font-mono text-xs text-zinc-500">{k.display_hint}</td>
                <td>
                  <Badge tone={keyTone(k)}>{keyTone(k) === "amber" ? "jeda" : k.status}</Badge>
                  {k.last_error_code && <span className="ml-1 text-xs text-red-600">{k.last_error_code}</span>}
                </td>
                <td className="text-xs text-zinc-500">{k.requests_total} req</td>
                <td className="space-x-1 text-right whitespace-nowrap">
                  {k.status === "active" ? (
                    <Button variant="ghost" onClick={() => keyOp.mutate({ id: k.id, op: "disable" })}>
                      Matikan
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => keyOp.mutate({ id: k.id, op: "enable" })}>
                      Aktifkan
                    </Button>
                  )}
                  <Button variant="danger" onClick={() => confirm("Cabut key ini permanen?") && keyOp.mutate({ id: k.id, op: "revoke" })}>
                    Cabut
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Belum ada API key.</Empty>
      )}
      <div className="grid gap-2 md:grid-cols-[1fr_2fr_auto]">
        <Input placeholder="Label (mis. gratis-2)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Input type="password" autoComplete="off" placeholder="API key baru" value={key} onChange={(e) => setKey(e.target.value)} />
        <Button onClick={() => addKey.mutate()} disabled={!label || key.length < 8 || addKey.isPending}>
          Tambah key
        </Button>
      </div>
      <ErrorText error={addKey.error} />
    </Card>
  );
}

function ModelSelect({ pid, value, onChange }: { pid: string | null; value: string | null; onChange: (v: string | null) => void }) {
  const m = useModels(pid);
  return (
    <select
      className="w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={!pid}
    >
      <option value="">— pilih model —</option>
      {m.data?.map((x) => (
        <option key={x.model_id} value={x.model_id}>
          {x.display_name ? `${x.display_name} (${x.model_id})` : x.model_id}
        </option>
      ))}
    </select>
  );
}

function TaskRow({ t, providers, onSaved }: { t: Task; providers: Provider[]; onSaved: () => void }) {
  const [v, setV] = useState(t);
  useEffect(() => setV(t), [t]);
  const save = useMutation({
    mutationFn: () =>
      api(`/admin/llm/tasks/${t.task}`, {
        method: "PUT",
        json: {
          provider_id: v.provider_id,
          model_id: v.model_id,
          fallback_provider_id: v.fallback_provider_id ?? null,
          fallback_model_id: v.fallback_model_id ?? null,
          enabled: v.enabled,
          params: v.params?.batch_size ? { batch_size: v.params.batch_size } : {},
        },
      }),
    onSuccess: onSaved,
  });
  const psel = (val: string | null | undefined, set: (x: string | null) => void) => (
    <select
      className="w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
      value={val ?? ""}
      onChange={(e) => set(e.target.value || null)}
    >
      <option value="">—</option>
      {providers.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
  return (
    <tr className="align-top">
      <td className="py-2 pr-2 font-medium">{TASK_LABEL[t.task] ?? t.task}</td>
      <td className="pr-2">{psel(v.provider_id, (x) => setV({ ...v, provider_id: x, model_id: null }))}</td>
      <td className="pr-2">
        <ModelSelect pid={v.provider_id} value={v.model_id} onChange={(x) => setV({ ...v, model_id: x })} />
      </td>
      <td className="pr-2">{psel(v.fallback_provider_id, (x) => setV({ ...v, fallback_provider_id: x, fallback_model_id: null }))}</td>
      <td className="pr-2">
        <ModelSelect
          pid={v.fallback_provider_id ?? null}
          value={v.fallback_model_id ?? null}
          onChange={(x) => setV({ ...v, fallback_model_id: x })}
        />
      </td>
      <td className="pr-2 text-center">
        <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} />
      </td>
      <td className="text-right">
        <Button onClick={() => save.mutate()} disabled={save.isPending || (v.enabled && (!v.provider_id || !v.model_id))}>
          Simpan
        </Button>
        <ErrorText error={save.error} />
      </td>
    </tr>
  );
}

function TestPanel({ providers }: { providers: Provider[] }) {
  const [pid, setPid] = useState<string | null>(providers[0]?.id ?? null);
  const [model, setModel] = useState<string | null>(null);
  const [text, setText] = useState("hebat banget, 3 bulan gaji pengurus belum cair 👏");
  const t = useMutation({
    mutationFn: () =>
      api<{
        ok: boolean;
        result?: unknown;
        latency_ms?: number;
        input_tokens?: number;
        output_tokens?: number;
        error?: { code: string; message: string };
      }>("/admin/llm/test", { method: "POST", json: { provider_id: pid, model_id: model, text } }),
  });
  return (
    <Card title="Tes model (klasifikasi sentimen contoh)">
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_2fr_auto]">
        <select
          className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
          value={pid ?? ""}
          onChange={(e) => {
            setPid(e.target.value || null);
            setModel(null);
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <ModelSelect pid={pid} value={model} onChange={setModel} />
        <Input value={text} onChange={(e) => setText(e.target.value)} />
        <Button onClick={() => t.mutate()} disabled={!pid || !model || t.isPending}>
          {t.isPending ? "…" : "Tes"}
        </Button>
      </div>
      <ErrorText error={t.error} />
      {t.data && (
        <pre className={`mt-3 overflow-x-auto rounded-lg p-3 text-xs ${t.data.ok ? "bg-emerald-50" : "bg-red-50"}`}>
          {JSON.stringify(t.data, null, 2)}
        </pre>
      )}
    </Card>
  );
}

export default function AdminLlm() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-llm"], queryFn: () => api<{ providers: Provider[]; tasks: Task[] }>("/admin/llm") });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin-llm"] });
    void qc.invalidateQueries({ queryKey: ["llm-models"] });
  };
  const providers = q.data?.providers ?? [];
  return (
    <div className="space-y-4">
      <ErrorText error={q.error} />
      <Card title="Model per tugas AI">
        {providers.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="py-2">Tugas</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Cadangan</th>
                  <th>Model cadangan</th>
                  <th>Aktif</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {q.data?.tasks.map((t) => (
                  <TaskRow key={t.task} t={t} providers={providers} onSaved={refresh} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Tambahkan provider LLM dulu.</Empty>
        )}
      </Card>
      {providers.length > 0 && <TestPanel providers={providers} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {providers.map((p) => (
          <ProviderCard key={p.id} p={p} refresh={refresh} />
        ))}
      </div>
      <AddProvider onDone={refresh} />
    </div>
  );
}
