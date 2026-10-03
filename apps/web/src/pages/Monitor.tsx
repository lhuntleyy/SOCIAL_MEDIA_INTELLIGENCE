// O-04 Pengaturan → Monitor (owner platform): kesehatan pengambilan per platform, kegagalan terbaru, antrean gagal (DLQ) dengan
// kirim ulang / buang, pemakaian & perkiraan biaya per kantor, dan audit log. Semua dari Admin API I-21 (operator saja).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, ErrorText, fmtTime, PLATFORM_LABEL, Select } from "../ui";

interface PlatformRow {
  platform: string;
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  running: number;
  items_new: number;
  last_success_at: string | null;
}
interface Failure {
  id: string;
  scheduled_for: string;
  kind: string;
  platform: string;
  error_code: string | null;
  error_message: string | null;
  connector: string | null;
  topic_name: string | null;
  tenant_name: string | null;
}
interface MonitorResp {
  hours: number;
  by_platform: PlatformRow[];
  failures: Failure[];
  dlq: Record<string, number>;
}
interface DlqEntry {
  job_id: string;
  last_error: string;
  attempts: number;
  poison: boolean;
  failed_at: string;
}
interface TenantUsage {
  tenant_id: string;
  tenant_name: string | null;
  requests: number;
  results: number;
  cost_units: number;
}
interface Audit {
  id: string;
  tenant_name: string | null;
  actor_type: string;
  actor_name: string | null;
  action: string;
  target_type: string;
  at: string;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function Health() {
  const [hours, setHours] = useState(24);
  const q = useQuery({
    queryKey: ["crawl-monitor", hours],
    queryFn: () => api<MonitorResp>(`/admin/crawl-monitor?hours=${hours}`),
    refetchInterval: 60_000,
  });
  return (
    <>
      <Card
        title="Kesehatan pengambilan data"
        right={
          <Select value={String(hours)} onChange={(e) => setHours(Number(e.target.value))} className="py-1 text-sm">
            <option value="24">24 jam terakhir</option>
            <option value="72">3 hari terakhir</option>
            <option value="168">7 hari terakhir</option>
          </Select>
        }
      >
        <ErrorText error={q.error} />
        {q.data && !q.data.by_platform.length && <Empty>Belum ada pengambilan pada rentang ini.</Empty>}
        {!!q.data?.by_platform.length && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="py-2">Platform</th>
                  <th>Berhasil</th>
                  <th>Pengambilan</th>
                  <th>Gagal</th>
                  <th>Sebagian</th>
                  <th>Dilewati</th>
                  <th>Berjalan</th>
                  <th>Post baru</th>
                  <th>Terakhir berhasil</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {q.data.by_platform.map((p) => {
                  const ok = pct(p.succeeded + p.partial, p.total - p.skipped - p.running);
                  return (
                    <tr key={p.platform}>
                      <td className="py-2 font-medium">{PLATFORM_LABEL[p.platform] ?? p.platform}</td>
                      <td>
                        <Badge tone={ok >= 90 ? "green" : ok >= 60 ? "amber" : "red"}>{ok}%</Badge>
                      </td>
                      <td>{p.total}</td>
                      <td className={p.failed ? "text-red-600" : ""}>{p.failed}</td>
                      <td>{p.partial}</td>
                      <td>{p.skipped}</td>
                      <td>{p.running}</td>
                      <td>{p.items_new.toLocaleString("id-ID")}</td>
                      <td className="text-xs text-zinc-500">{fmtTime(p.last_success_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-zinc-500">
          "Dilewati" = tidak ada sumber yang sanggup / kuota habis (tanpa biaya). Persentase berhasil dihitung dari pengambilan yang sudah
          selesai.
        </p>
      </Card>
      <Card title="Kegagalan terbaru">
        {q.data && !q.data.failures.length && <Empty>Tidak ada kegagalan. 👍</Empty>}
        <ul className="divide-y divide-zinc-100">
          {q.data?.failures.map((f) => (
            <li key={f.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="red">{f.error_code ?? "gagal"}</Badge>
                <span className="font-medium">{PLATFORM_LABEL[f.platform] ?? f.platform}</span>
                <span className="text-xs text-zinc-500">
                  {fmtTime(f.scheduled_for)} · {f.kind}
                  {f.topic_name ? ` · ${f.topic_name}` : " · stream bersama"}
                  {f.tenant_name ? ` (${f.tenant_name})` : ""}
                  {f.connector ? ` · ${f.connector}` : ""}
                </span>
              </div>
              {f.error_message && <div className="mt-0.5 truncate text-xs text-zinc-500">{f.error_message}</div>}
            </li>
          ))}
        </ul>
      </Card>
      <DlqCard counts={q.data?.dlq ?? {}} />
    </>
  );
}

function DlqCard({ counts }: { counts: Record<string, number> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["dlq", open],
    queryFn: () => api<DlqEntry[]>(`/admin/dlq/${open}`),
    enabled: !!open,
  });
  const act = useMutation({
    mutationFn: ({ id, a }: { id: string; a: "redrive" | "discard" }) =>
      a === "redrive"
        ? api(`/admin/dlq/${open}/${encodeURIComponent(id)}/redrive`, { method: "POST" })
        : api(`/admin/dlq/${open}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dlq"] });
      void qc.invalidateQueries({ queryKey: ["crawl-monitor"] });
    },
  });
  const queues = Object.entries(counts);
  return (
    <Card title="Antrean gagal (DLQ)">
      {!queues.length && <Empty>Kosong — tidak ada job yang gagal permanen.</Empty>}
      <div className="flex flex-wrap gap-2">
        {queues.map(([q, n]) => (
          <button
            type="button"
            key={q}
            onClick={() => setOpen(open === q ? null : q)}
            className={`rounded-full px-3 py-1 text-xs ${open === q ? "bg-brand-600 text-white" : "bg-zinc-100 text-zinc-700"}`}
          >
            {q} · {n}
            {n >= 100 ? "+" : ""}
          </button>
        ))}
      </div>
      <ErrorText error={list.error ?? act.error} />
      {open && (
        <ul className="mt-3 divide-y divide-zinc-100">
          {list.data?.map((j) => (
            <li key={j.job_id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-zinc-500">
                  {fmtTime(j.failed_at)} · {j.attempts}× percobaan{j.poison ? " · data rusak" : ""}
                </div>
                <div className="truncate">{j.last_error}</div>
              </div>
              {!j.poison && (
                <Button variant="ghost" className="py-1 text-xs" onClick={() => act.mutate({ id: j.job_id, a: "redrive" })}>
                  Kirim ulang
                </Button>
              )}
              <button
                type="button"
                className="text-xs text-zinc-400 hover:text-red-600"
                onClick={() => confirm("Buang job ini?") && act.mutate({ id: j.job_id, a: "discard" })}
              >
                buang
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function OfficeUsage() {
  const [days, setDays] = useState(30);
  const to = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString();
  const from = new Date(Date.parse(to) - days * 86_400_000).toISOString();
  const q = useQuery({
    queryKey: ["usage-tenant", days],
    queryFn: () => api<TenantUsage[]>(`/admin/usage?group_by=tenant&from=${from}&to=${to}`),
  });
  const total = (q.data ?? []).reduce((a, r) => a + r.cost_units, 0);
  return (
    <Card
      title="Pemakaian per kantor"
      right={
        <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="py-1 text-sm">
          <option value="1">24 jam</option>
          <option value="7">7 hari</option>
          <option value="30">30 hari</option>
        </Select>
      }
    >
      <ErrorText error={q.error} />
      {q.data && !q.data.length && <Empty>Belum ada pemakaian.</Empty>}
      <ul className="divide-y divide-zinc-100">
        {q.data?.map((r) => (
          <li key={r.tenant_id} className="flex items-center gap-3 py-2 text-sm">
            <span className="flex-1 font-medium">{r.tenant_name ?? r.tenant_id}</span>
            <span className="text-xs text-zinc-500">
              {Math.round(r.requests).toLocaleString("id-ID")} request · {Math.round(r.results).toLocaleString("id-ID")} hasil
            </span>
            <span className="w-24 text-right">${r.cost_units.toFixed(2)}</span>
          </li>
        ))}
      </ul>
      {!!q.data?.length && (
        <p className="mt-2 text-xs text-zinc-500">
          Total ± ${total.toFixed(2)} (perkiraan dari laporan provider; tagihan resmi bisa sedikit berbeda — cek di dashboard provider).
          Biaya pengambilan bersama dibagi rata ke kantor yang memakainya.
        </p>
      )}
    </Card>
  );
}

const AUDIT_TYPES = ["", "topic", "tenant", "user", "platform", "connector", "provider_account", "alert", "job"];
function AuditLog() {
  const [type, setType] = useState("");
  const [hideViews, setHideViews] = useState(true);
  const q = useQuery({
    queryKey: ["audit", type, hideViews],
    queryFn: () =>
      api<Audit[]>(
        `/admin/audit-logs?limit=100${type ? `&target_type=${type}` : ""}${hideViews ? "&exclude_action=operator.impersonate" : ""}`,
      ),
  });
  return (
    <Card
      title="Audit log"
      right={
        <span className="flex items-center gap-3 text-xs text-zinc-600">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={hideViews} onChange={(e) => setHideViews(e.target.checked)} />
            sembunyikan akses lihat kantor
          </label>
          <Select value={type} onChange={(e) => setType(e.target.value)} className="py-1 text-sm">
            {AUDIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t || "Semua jenis"}
              </option>
            ))}
          </Select>
        </span>
      }
    >
      <ErrorText error={q.error} />
      {q.data && !q.data.length && <Empty>Belum ada catatan.</Empty>}
      <ul className="divide-y divide-zinc-100">
        {q.data?.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
            <span className="w-36 text-xs text-zinc-500">{fmtTime(a.at)}</span>
            <code className="rounded bg-zinc-100 px-1.5 text-xs">{a.action}</code>
            <span className="text-zinc-600">
              {a.actor_name ?? (a.actor_type === "system" ? "sistem" : a.actor_type)}
              {a.tenant_name ? ` · ${a.tenant_name}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function Monitor() {
  return (
    <div className="space-y-4">
      <Health />
      <OfficeUsage />
      <AuditLog />
    </div>
  );
}
