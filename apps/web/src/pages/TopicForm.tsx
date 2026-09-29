import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { type ApiError, api } from "../api";
import type { TopicDetail } from "../types";
import { Badge, Button, Card, ErrorText, Input, PLATFORM_LABEL } from "../ui";

interface Platform {
  code: string;
  name: string;
  min_interval_sec: number;
}
interface QueryRow {
  id?: string;
  kind: "main" | "sub";
  label: string;
  query_text: string;
  keywords: string[];
  languages: string[];
  enabled: boolean;
}

const LANGS = [
  { v: "id", l: "🇮🇩 Indonesia" },
  { v: "en", l: "🇬🇧 English" },
  { v: "ms", l: "🇲🇾 Malaysia" },
];
const emptyQuery = (kind: "main" | "sub"): QueryRow => ({
  kind,
  label: "",
  query_text: "",
  keywords: [],
  languages: ["id"],
  enabled: true,
});

function QueryEditor({ q, onChange, onRemove }: { q: QueryRow; onChange: (q: QueryRow) => void; onRemove?: () => void }) {
  const [kw, setKw] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; msg: string } | null>(null);
  // validasi live (debounce 500 ms) — posisi error dari parser server
  useEffect(() => {
    if (!q.query_text.trim() && !q.keywords.length) return setCheck(null);
    const t = setTimeout(() => {
      api<{ normalized: string; positive_terms: string[] }>("/topics/validate-query", {
        method: "POST",
        json: { query_text: q.query_text || null, keywords: q.keywords, languages: q.languages },
      })
        .then((r) => setCheck({ ok: true, msg: `Dicari: ${r.positive_terms.join(", ")}` }))
        .catch((e: ApiError) => setCheck({ ok: false, msg: [e.message, ...(e.details ?? []).map((d) => d.issue)].join(" — ") }));
    }, 500);
    return () => clearTimeout(t);
  }, [q.query_text, q.keywords, q.languages]);
  return (
    <div className={`space-y-2 rounded-xl border p-3 ${q.kind === "main" ? "border-zinc-300" : "border-brand-100 bg-brand-50/40"}`}>
      <div className="flex items-center gap-2">
        <Badge tone={q.kind === "main" ? "blue" : "red"}>{q.kind === "main" ? "Query utama" : "Sub query"}</Badge>
        {q.kind === "sub" && (
          <Input
            className="max-w-xs"
            placeholder="Label sub query (mis. Kades)"
            value={q.label}
            onChange={(e) => onChange({ ...q, label: e.target.value })}
          />
        )}
        <label className="ml-auto flex items-center gap-1 text-xs">
          <input type="checkbox" checked={q.enabled} onChange={(e) => onChange({ ...q, enabled: e.target.checked })} /> aktif
        </label>
        {onRemove && (
          <Button variant="ghost" onClick={onRemove}>
            Hapus
          </Button>
        )}
      </div>
      <textarea
        className="w-full rounded-lg border border-zinc-300 p-2 font-mono text-sm outline-none focus:border-brand-500"
        rows={2}
        placeholder={'Boolean query, mis: "koperasi merah putih" OR kopdes AND NOT hoaks'}
        value={q.query_text}
        onChange={(e) => onChange({ ...q, query_text: e.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Keyword tambahan (Enter)"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && kw.trim()) {
              e.preventDefault();
              onChange({ ...q, keywords: [...new Set([...q.keywords, kw.trim()])] });
              setKw("");
            }
          }}
        />
        {q.keywords.map((k) => (
          <button
            type="button"
            key={k}
            className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs hover:bg-red-100"
            onClick={() => onChange({ ...q, keywords: q.keywords.filter((x) => x !== k) })}
          >
            {k} ✕
          </button>
        ))}
        <span className="ml-auto flex gap-3 text-xs">
          {LANGS.map((l) => (
            <label key={l.v} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={q.languages.includes(l.v)}
                onChange={(e) =>
                  onChange({ ...q, languages: e.target.checked ? [...q.languages, l.v] : q.languages.filter((x) => x !== l.v) })
                }
              />
              {l.l}
            </label>
          ))}
        </span>
      </div>
      {check && <p className={`text-xs ${check.ok ? "text-emerald-700" : "text-red-600"}`}>{check.msg}</p>}
    </div>
  );
}

/** U-02: buat / ubah topik (tab General + Query Lists) dengan estimasi biaya sebelum simpan (FR-T05). */
export default function TopicForm() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const platforms = useQuery({ queryKey: ["platforms"], queryFn: () => api<Platform[]>("/platforms") });
  const existing = useQuery({
    queryKey: ["topic", id],
    queryFn: () => api<TopicDetail & { version: number }>(`/topics/${id}`),
    enabled: editing,
  });
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [filterAds, setFilterAds] = useState(true);
  // interval crawl TIDAK diatur di UI (sistem yang menentukan); interval topik lama tetap dipertahankan saat diubah
  const [sel, setSel] = useState<Record<string, number | null>>({ x: null });
  const [queries, setQueries] = useState<QueryRow[]>([emptyQuery("main")]);

  useEffect(() => {
    const t = existing.data;
    if (!t) return;
    setName(t.name);
    setDesc(t.description ?? "");
    setFilterAds(t.filter_ads);
    setSel(Object.fromEntries(t.platforms.filter((p) => p.enabled).map((p) => [p.code, p.interval_sec])));
    setQueries(
      t.queries.map((q) => ({
        id: q.id,
        kind: q.kind,
        label: q.label ?? "",
        query_text: q.query_text ?? "",
        keywords: q.keywords ?? [],
        languages: q.languages ?? ["id"],
        enabled: q.enabled,
      })),
    );
  }, [existing.data]);

  const body = () => ({
    name,
    description: desc || null,
    filter_ads: filterAds,
    language_hints: ["id"],
    platforms: Object.entries(sel).map(([code, interval_sec]) => (interval_sec ? { code, interval_sec } : { code })),
    queries: queries.map((q) => ({
      ...(q.id ? { id: q.id } : {}),
      kind: q.kind,
      label: q.kind === "sub" ? q.label || null : null,
      query_text: q.query_text || null,
      keywords: q.keywords,
      languages: q.languages.length ? q.languages : null,
      enabled: q.enabled,
    })),
  });
  const save = useMutation({
    mutationFn: () =>
      editing
        ? api<{ id: string }>(`/topics/${id}`, {
            method: "PATCH",
            json: body(),
            headers: { "if-match": String(existing.data?.version ?? "") },
          })
        : api<{ id: string }>("/topics", { method: "POST", json: body() }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["topics"] });
      void qc.invalidateQueries({ queryKey: ["topic", r.id] });
      nav(`/topics/${r.id}`);
    },
  });
  const valid =
    name.trim().length >= 2 &&
    Object.keys(sel).length > 0 &&
    queries.some((q) => q.kind === "main" && (q.query_text.trim() || q.keywords.length));

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title={editing ? "Ubah topik" : "Topik baru"}>
          <div className="space-y-3">
            <Input placeholder="Nama topik (mis. PERMASALAHAN KDMP)" value={name} onChange={(e) => setName(e.target.value)} />
            <textarea
              className="w-full rounded-lg border border-zinc-300 p-2 text-sm"
              rows={2}
              placeholder="Deskripsi"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500">Platform</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {platforms.data?.map((p) => (
                  <div key={p.code} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2">
                    <label className="flex flex-1 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={p.code in sel}
                        onChange={(e) => {
                          const n = { ...sel };
                          if (e.target.checked) n[p.code] = existing.data?.platforms.find((x) => x.code === p.code)?.interval_sec ?? null;
                          else delete n[p.code];
                          setSel(n);
                        }}
                      />
                      {PLATFORM_LABEL[p.code] ?? p.name}
                    </label>
                  </div>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={filterAds} onChange={(e) => setFilterAds(e.target.checked)} /> Saring iklan
            </label>
          </div>
        </Card>
        <Card
          title="Query"
          right={
            <Button variant="ghost" onClick={() => setQueries([...queries, emptyQuery("sub")])}>
              + Sub query
            </Button>
          }
        >
          <div className="space-y-3">
            {queries.map((q, k) => (
              <QueryEditor
                key={q.id ?? `new-${k}`}
                q={q}
                onChange={(n) => setQueries(queries.map((x, j) => (j === k ? n : x)))}
                onRemove={q.kind === "sub" ? () => setQueries(queries.filter((_, j) => j !== k)) : undefined}
              />
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Sintaks: <code>"frasa"</code>, <code>OR</code>, <code>AND</code>, <code>NOT</code>, kurung. Keyword tambahan di-OR-kan ke query.
          </p>
        </Card>
      </div>
      <div className="space-y-4">
        <Card title={editing ? "Simpan perubahan" : "Buat topik"}>
          <p className="text-sm text-zinc-600">
            {editing
              ? "Platform yang baru dicentang langsung diambil datanya 7 hari ke belakang."
              : "Setelah disimpan, data 7 hari terakhir langsung diambil otomatis — lalu terus diperbarui. Pilih rentang waktu di dashboard."}
          </p>
          <Button className="mt-3 w-full py-2" onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {save.isPending ? "Menyimpan…" : editing ? "Simpan perubahan" : "Buat topik"}
          </Button>
          <ErrorText error={save.error} />
          <Button variant="ghost" className="mt-2 w-full" onClick={() => nav(-1)}>
            Batal
          </Button>
        </Card>
      </div>
    </div>
  );
}
