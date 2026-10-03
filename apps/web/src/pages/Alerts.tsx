// O-05 Alert: riwayat alert (tandai dibaca / selesai), aturan per topik, saluran notifikasi kantor (Telegram/webhook).
// Hanya angka agregat di pesan — tidak ada data per akun. Secret (token bot, kunci webhook) write-only.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import type { TopicSummary } from "../types";
import { Badge, Button, Card, Empty, ErrorText, fmtTime, Input, Select } from "../ui";

type RuleType = "negative_ratio" | "volume_spike" | "new_issue";
interface Rule {
  id: string;
  topic_id: string;
  topic_name: string;
  type: RuleType;
  params: Record<string, number>;
  channels: string[];
  cooldown_sec: number;
  enabled: boolean;
  last_fired_at: string | null;
}
interface Channel {
  id: string;
  kind: "telegram" | "webhook" | "email";
  name: string;
  config: { chat_id?: string; url?: string };
  has_secret: boolean;
  enabled: boolean;
}
interface AlertEvent {
  id: string;
  type: RuleType;
  topic_id: string;
  topic_name: string;
  fired_at: string;
  status: "open" | "acked" | "resolved";
  acked_by_name: string | null;
  payload: { title?: string; message?: string; deliveries?: { channel_id: string; kind: string; status: string; error?: string }[] };
}

export const RULE_LABEL: Record<RuleType, string> = {
  negative_ratio: "Sentimen negatif tinggi",
  volume_spike: "Lonjakan percakapan",
  new_issue: "Isu baru muncul",
};
/** Field parameter per jenis + bawaan (selaras validasi API). */
const FIELDS: Record<RuleType, { key: string; label: string; def: number; min: number; max: number; step?: number }[]> = {
  negative_ratio: [
    { key: "threshold_pct", label: "Ambang negatif (%)", def: 50, min: 5, max: 100 },
    { key: "window_hours", label: "Dalam … jam terakhir", def: 3, min: 1, max: 72 },
    { key: "min_posts", label: "Minimal jumlah post", def: 20, min: 1, max: 100000 },
  ],
  volume_spike: [
    { key: "factor", label: "Lonjakan (× dari biasanya)", def: 3, min: 1.5, max: 50, step: 0.5 },
    { key: "window_hours", label: "Dalam … jam terakhir", def: 1, min: 1, max: 72 },
    { key: "min_posts", label: "Minimal jumlah post", def: 30, min: 1, max: 100000 },
  ],
  new_issue: [
    { key: "min_mentions", label: "Minimal disebut", def: 10, min: 2, max: 100000 },
    { key: "window_hours", label: "Dalam … jam terakhir", def: 6, min: 1, max: 72 },
  ],
};
const COOLDOWN = [
  { v: 3600, label: "1 jam" },
  { v: 10800, label: "3 jam" },
  { v: 21600, label: "6 jam" },
  { v: 86400, label: "24 jam" },
];
const describe = (r: Pick<Rule, "type" | "params">) => {
  const p = r.params;
  if (r.type === "negative_ratio") return `≥ ${p.threshold_pct}% negatif dalam ${p.window_hours} jam (min. ${p.min_posts} post)`;
  if (r.type === "volume_spike") return `≥ ${p.factor}× dari biasanya dalam ${p.window_hours} jam (min. ${p.min_posts} post)`;
  return `isu baru ≥ ${p.min_mentions} sebutan dalam ${p.window_hours} jam`;
};

function useRole() {
  const { me } = useAuth();
  const role = me?.current_tenant.role ?? "";
  const op = !!me?.user.is_platform_operator;
  return { canEdit: op || ["owner", "admin", "analyst"].includes(role), isAdmin: op || ["owner", "admin"].includes(role) };
}

/** Jumlah alert terbuka (badge menu). */
export function useOpenAlerts(enabled: boolean) {
  return useQuery({
    queryKey: ["alert-events", "open-count"],
    queryFn: () => api<{ open: number }>("/alert-events?status=open&limit=1"),
    enabled,
    refetchInterval: 300_000,
  });
}

function Events() {
  const qc = useQueryClient();
  const { canEdit } = useRole();
  const [status, setStatus] = useState<"" | "open" | "acked" | "resolved">("");
  const q = useQuery({
    queryKey: ["alert-events", status],
    queryFn: () => api<{ items: AlertEvent[]; open: number }>(`/alert-events?limit=100${status ? `&status=${status}` : ""}`),
    refetchInterval: 60_000,
  });
  const act = useMutation({
    mutationFn: ({ id, a }: { id: string; a: "ack" | "resolve" }) => api(`/alert-events/${id}/${a}`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["alert-events"] }),
  });
  return (
    <Card title={`Riwayat alert${q.data?.open ? ` · ${q.data.open} belum dibaca` : ""}`}>
      <div className="mb-3 flex gap-2">
        {(["", "open", "acked", "resolved"] as const).map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs ${status === s ? "bg-brand-600 text-white" : "bg-zinc-100 text-zinc-600"}`}
          >
            {s === "" ? "Semua" : s === "open" ? "Baru" : s === "acked" ? "Dibaca" : "Selesai"}
          </button>
        ))}
      </div>
      <ErrorText error={q.error ?? act.error} />
      {q.data && !q.data.items.length && <Empty>Belum ada alert. Buat aturan di bawah — alert dicek otomatis tiap 5 menit.</Empty>}
      <ul className="divide-y divide-zinc-100">
        {q.data?.items.map((e) => (
          <li key={e.id} className="flex flex-wrap items-start gap-3 py-3">
            <span className="text-lg">{e.status === "open" ? "🔴" : e.status === "acked" ? "🟡" : "✅"}</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{e.payload.title ?? RULE_LABEL[e.type]}</div>
              <div className="text-sm text-zinc-600">{e.payload.message}</div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
                <span>
                  {e.topic_name} · {fmtTime(e.fired_at)}
                </span>
                {e.acked_by_name && <span>· dibaca {e.acked_by_name}</span>}
                {e.payload.deliveries?.map((d) => (
                  <Badge key={d.channel_id} tone={d.status === "sent" ? "green" : d.status === "failed" ? "red" : "zinc"}>
                    {d.kind} {d.status === "sent" ? "terkirim" : d.status === "failed" ? "gagal" : "dilewati"}
                  </Badge>
                ))}
              </div>
            </div>
            <a className="text-xs text-brand-600 hover:underline" href={`/?topic=${e.topic_id}`}>
              Lihat dashboard
            </a>
            {canEdit && e.status === "open" && (
              <Button variant="ghost" className="py-1 text-xs" onClick={() => act.mutate({ id: e.id, a: "ack" })}>
                Tandai dibaca
              </Button>
            )}
            {canEdit && e.status !== "resolved" && (
              <Button variant="ghost" className="py-1 text-xs" onClick={() => act.mutate({ id: e.id, a: "resolve" })}>
                Selesai
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RuleForm({ channels, onDone }: { channels: Channel[]; onDone: () => void }) {
  const qc = useQueryClient();
  const topics = useQuery({ queryKey: ["topics", "all"], queryFn: () => api<TopicSummary[]>("/topics?limit=100") });
  const list = topics.data?.filter((t) => t.status !== "archived") ?? [];
  const [topic, setTopic] = useState("");
  const [type, setType] = useState<RuleType>("negative_ratio");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [cooldown, setCooldown] = useState(10800);
  const [chs, setChs] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: () =>
      api("/alert-rules", {
        method: "POST",
        json: {
          topic_id: topic || list[0]?.id,
          type,
          params: Object.fromEntries(FIELDS[type].map((f) => [f.key, Number(vals[f.key] ?? f.def)])),
          channels: chs,
          cooldown_sec: cooldown,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["alert-rules"] });
      onDone();
    },
  });
  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <div className="grid gap-2 md:grid-cols-2">
        <label className="text-sm" htmlFor="rule-topic">
          Topik
          <Select id="rule-topic" value={topic || list[0]?.id || ""} onChange={(e) => setTopic(e.target.value)} className="mt-1 w-full">
            {list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm" htmlFor="rule-type">
          Jenis alert
          <Select
            id="rule-type"
            value={type}
            onChange={(e) => {
              setType(e.target.value as RuleType);
              setVals({});
            }}
            className="mt-1 w-full"
          >
            {(Object.keys(RULE_LABEL) as RuleType[]).map((k) => (
              <option key={k} value={k}>
                {RULE_LABEL[k]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {FIELDS[type].map((f) => (
          <label key={f.key} className="text-sm" htmlFor={`rule-${f.key}`}>
            {f.label}
            <Input
              id={`rule-${f.key}`}
              type="number"
              min={f.min}
              max={f.max}
              step={f.step ?? 1}
              value={vals[f.key] ?? String(f.def)}
              onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
              className="mt-1"
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2" htmlFor="rule-cooldown">
          Jangan ulangi selama
          <Select id="rule-cooldown" value={String(cooldown)} onChange={(e) => setCooldown(Number(e.target.value))} className="py-1">
            {COOLDOWN.map((c) => (
              <option key={c.v} value={c.v}>
                {c.label}
              </option>
            ))}
          </Select>
        </label>
        {channels.length ? (
          <span className="flex flex-wrap items-center gap-2">
            Kirim ke:
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={chs.includes(c.id)}
                  onChange={(e) => setChs(e.target.checked ? [...chs, c.id] : chs.filter((x) => x !== c.id))}
                />
                {c.name}
              </label>
            ))}
          </span>
        ) : (
          <span className="text-xs text-zinc-500">Belum ada saluran — alert tetap tampil di halaman ini.</span>
        )}
      </div>
      <ErrorText error={save.error} />
      <div className="flex gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !list.length}>
          Simpan aturan
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Batal
        </Button>
      </div>
    </div>
  );
}

function Rules({ channels }: { channels: Channel[] }) {
  const qc = useQueryClient();
  const { canEdit } = useRole();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ["alert-rules"], queryFn: () => api<Rule[]>("/alert-rules") });
  const patch = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api(`/alert-rules/${id}`, { method: "PATCH", json: { enabled } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["alert-rules"] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/alert-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["alert-rules"] }),
  });
  const chName = (id: string) => channels.find((c) => c.id === id)?.name;
  return (
    <Card title="Aturan alert">
      <ErrorText error={q.error ?? patch.error ?? del.error} />
      {q.data && !q.data.length && !adding && <Empty>Belum ada aturan.</Empty>}
      <ul className="divide-y divide-zinc-100">
        {q.data?.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {RULE_LABEL[r.type]} · {r.topic_name}
                {!r.enabled && (
                  <span className="ml-2">
                    <Badge tone="zinc">nonaktif</Badge>
                  </span>
                )}
              </div>
              <div className="text-xs text-zinc-500">
                {describe(r)} · jeda {COOLDOWN.find((c) => c.v === r.cooldown_sec)?.label ?? `${Math.round(r.cooldown_sec / 3600)} jam`}
                {r.channels.length ? ` · ke ${r.channels.map(chName).filter(Boolean).join(", ")}` : " · hanya di aplikasi"}
                {r.last_fired_at ? ` · terakhir ${fmtTime(r.last_fired_at)}` : ""}
              </div>
            </div>
            {canEdit && (
              <>
                <Button variant="ghost" className="py-1 text-xs" onClick={() => patch.mutate({ id: r.id, enabled: !r.enabled })}>
                  {r.enabled ? "Nonaktifkan" : "Aktifkan"}
                </Button>
                <button
                  type="button"
                  className="text-xs text-zinc-400 hover:text-red-600"
                  onClick={() => confirm("Hapus aturan ini?") && del.mutate(r.id)}
                >
                  hapus
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit &&
        (adding ? (
          <RuleForm channels={channels} onDone={() => setAdding(false)} />
        ) : (
          <Button className="mt-3" onClick={() => setAdding(true)}>
            + Tambah aturan
          </Button>
        ))}
    </Card>
  );
}

function Channels({ channels }: { channels: Channel[] }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"telegram" | "webhook">("telegram");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["notification-channels"] });
  const add = useMutation({
    mutationFn: () =>
      api("/notification-channels", {
        method: "POST",
        json: {
          kind,
          name: name.trim(),
          config: kind === "telegram" ? { chat_id: target.trim() } : { url: target.trim() },
          ...(secret ? { secret: secret.trim() } : {}),
        },
      }),
    onSuccess: () => {
      setName("");
      setTarget("");
      setSecret("");
      refresh();
    },
  });
  const test = useMutation({
    mutationFn: (id: string) => api<{ status: string; error?: string }>(`/notification-channels/${id}/test`, { method: "POST" }),
    onSuccess: (r) => setMsg(r.status === "sent" ? "Pesan uji terkirim ✔" : `Gagal: ${r.error ?? r.status}`),
    onError: (e) => setMsg((e as Error).message),
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/notification-channels/${id}`, { method: "DELETE" }), onSuccess: refresh });
  return (
    <Card title="Saluran notifikasi">
      <ul className="mb-3 divide-y divide-zinc-100">
        {channels.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {c.kind === "telegram" ? "✈️" : "🔗"} {c.name}
              </div>
              <div className="truncate text-xs text-zinc-500">
                {c.kind === "telegram" ? `chat ${c.config.chat_id}` : c.config.url}
                {c.has_secret ? " · secret tersimpan" : ""}
              </div>
            </div>
            <Button variant="ghost" className="py-1 text-xs" onClick={() => test.mutate(c.id)} disabled={test.isPending}>
              Kirim uji
            </Button>
            <button
              type="button"
              className="text-xs text-zinc-400 hover:text-red-600"
              onClick={() => confirm(`Hapus saluran ${c.name}?`) && del.mutate(c.id)}
            >
              hapus
            </button>
          </li>
        ))}
      </ul>
      {msg && <p className="mb-2 text-sm text-zinc-600">{msg}</p>}
      <div className="grid gap-2 md:grid-cols-4">
        <Select value={kind} onChange={(e) => setKind(e.target.value as "telegram" | "webhook")}>
          <option value="telegram">Telegram</option>
          <option value="webhook">Webhook</option>
        </Select>
        <Input placeholder="Nama (mis. Grup Humas)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          placeholder={kind === "telegram" ? "Chat ID (mis. -1001234567890)" : "https://…"}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <Input
          type="password"
          autoComplete="off"
          placeholder={kind === "telegram" ? "Token bot (dari @BotFather)" : "Kunci tanda tangan (opsional)"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {kind === "telegram"
          ? "Buat bot lewat @BotFather, masukkan bot ke grup, lalu isi Chat ID grup. Token disimpan terenkripsi dan tidak pernah ditampilkan lagi."
          : "Alert dikirim sebagai POST JSON. Bila kunci diisi, header X-SMIP-Signature = sha256 HMAC(timestamp.body)."}
      </p>
      <ErrorText error={add.error ?? del.error} />
      <Button className="mt-2" onClick={() => add.mutate()} disabled={add.isPending || name.trim().length < 1 || !target.trim()}>
        Tambah saluran
      </Button>
    </Card>
  );
}

export default function Alerts() {
  const { isAdmin } = useRole();
  const channels = useQuery({ queryKey: ["notification-channels"], queryFn: () => api<Channel[]>("/notification-channels") });
  const list = channels.data ?? [];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold uppercase tracking-wide text-zinc-700">Alert</h1>
      <Events />
      <Rules channels={list} />
      {isAdmin && <Channels channels={list} />}
    </div>
  );
}
