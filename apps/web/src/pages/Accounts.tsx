// Menu Akun: pantau akun tertentu (pejabat, media, influencer) — satu "pantauan" berisi beberapa akun lintas platform.
// Disimpan sebagai topik kind=account (query `@username` per platform, operation user_timeline) sehingga semua analitik
// (sentimen, emosi, isu, kontributor, laporan) langsung berlaku. Platform yang ditawarkan = yang mendukung user_timeline.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, apiFull } from "../api";
import { OfficePicker, useNeedsOffice } from "../office";
import type { TopicDetail, TopicSummary } from "../types";
import { Badge, Button, Card, Empty, ErrorText, Input, PLATFORM_LABEL, Select } from "../ui";
import { useRole } from "./Topics";

interface Platform {
  code: string;
  name: string;
  operations_available?: string[];
}
interface Row {
  platform: string;
  handle: string;
}

const statusTone = (s: string) => (s === "active" ? "green" : s === "paused" ? "amber" : "zinc");
const handlesOf = (t: TopicDetail) =>
  t.queries.map((q) => ({ platform: q.platforms?.[0] ?? "", handle: q.query_text.replace(/^@/, "") })).filter((r) => r.platform);

export function AccountList() {
  if (useNeedsOffice()) return <OfficePicker to="/accounts" />;
  return <AccountListInner />;
}

function AccountListInner() {
  const canWrite = useRole("analyst");
  const [search, setSearch] = useState("");
  const q = useQuery({
    queryKey: ["topics", "account", search],
    queryFn: () => api<TopicSummary[]>(`/topics?kind=account&limit=50${search ? `&search=${encodeURIComponent(search)}` : ""}`),
  });
  return (
    <Card
      title="Pantau akun"
      right={
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">{q.data?.length ?? 0} pantauan</span>
          {canWrite && (
            <Link to="/accounts/new" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
              + Pantau akun
            </Link>
          )}
        </div>
      }
    >
      <p className="mb-3 text-sm text-zinc-600">
        Semua post terbaru dari akun yang dipantau diambil otomatis lalu dianalisis (sentimen, emosi, isu, engagement) — lihat hasilnya di
        Dashboard / Percakapan / Laporan dengan memilih pantauan ini.
      </p>
      <Input placeholder="Cari pantauan…" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-3" />
      <ErrorText error={q.error} />
      {q.data && !q.data.length && <Empty>Belum ada akun yang dipantau.</Empty>}
      <ul className="divide-y divide-zinc-100">
        {q.data?.map((t) => (
          <li key={t.id}>
            <Link to={`/topics/${t.id}`} className="flex items-center justify-between gap-3 py-3 hover:bg-zinc-50">
              <div className="min-w-0">
                <div className="truncate font-medium">👤 {t.name}</div>
                <div className="truncate text-xs text-zinc-500">{t.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(" · ")}</div>
              </div>
              <Badge tone={statusTone(t.status)}>{t.status}</Badge>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function AccountForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const platforms = useQuery({ queryKey: ["platforms"], queryFn: () => api<Platform[]>("/platforms"), staleTime: 600_000 });
  const existing = useQuery({ queryKey: ["topic", id], queryFn: () => api<TopicDetail>(`/topics/${id}`), enabled: !!id });
  const usable = (platforms.data ?? []).filter((p) => p.operations_available?.includes("user_timeline"));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rows, setRows] = useState<Row[]>([{ platform: "", handle: "" }]);
  useEffect(() => {
    if (!existing.data) return;
    setName(existing.data.name);
    setDescription(existing.data.description ?? "");
    setRows(handlesOf(existing.data));
  }, [existing.data]);
  const first = usable[0]?.code ?? "";
  const clean = rows
    .map((r) => ({
      platform: r.platform || first,
      handle: r.handle
        .trim()
        .replace(/^@/, "")
        .replace(/^https?:\/\/\S+\/@?/, ""),
    }))
    .filter((r) => r.handle);
  const invalid = clean.filter((r) => !/^[A-Za-z0-9._]{1,64}$/.test(r.handle));
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        kind: "account",
        name: name.trim(),
        description: description.trim() || null,
        platforms: [...new Set(clean.map((r) => r.platform))].map((code) => ({ code })),
        queries: clean.map((r, i) => ({ kind: i === 0 ? "main" : "sub", query_text: `@${r.handle}`, platforms: [r.platform] })),
      };
      if (!id) return (await api<{ id: string }>("/topics", { method: "POST", json: body })).id;
      const { kind: _k, ...patch } = body;
      await apiFull(`/topics/${id}`, { method: "PATCH", json: patch, headers: { "if-match": String(existing.data?.version ?? "") } });
      return id;
    },
    onSuccess: (tid) => {
      void qc.invalidateQueries({ queryKey: ["topics"] });
      void qc.invalidateQueries({ queryKey: ["topic", tid] });
      nav(`/topics/${tid}`);
    },
  });
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <Card title={id ? "Ubah pantauan akun" : "Pantau akun baru"}>
      <div className="space-y-4">
        <div className="text-sm">
          <label htmlFor="acc-name" className="mb-1 block font-medium">
            Nama pantauan
          </label>
          <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. Akun Pejabat Daerah" />
        </div>
        <div className="text-sm">
          <label htmlFor="acc-desc" className="mb-1 block font-medium">
            Deskripsi (opsional)
          </label>
          <Input id="acc-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <div className="mb-1 text-sm font-medium">Akun yang dipantau</div>
          <p className="mb-2 text-xs text-zinc-500">
            Isi username (tanpa @) atau tempel link profil. Platform yang tersedia:{" "}
            {usable.map((p) => PLATFORM_LABEL[p.code] ?? p.name).join(", ") || "—"}.
          </p>
          <div className="space-y-2">
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: baris form tanpa id stabil
              <div key={i} className="flex gap-2">
                <Select value={r.platform || first} onChange={(e) => set(i, { platform: e.target.value })} className="w-40">
                  {usable.map((p) => (
                    <option key={p.code} value={p.code}>
                      {PLATFORM_LABEL[p.code] ?? p.name}
                    </option>
                  ))}
                </Select>
                <Input value={r.handle} onChange={(e) => set(i, { handle: e.target.value })} placeholder="username" className="flex-1" />
                <Button variant="ghost" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))} disabled={rows.length === 1}>
                  Hapus
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            onClick={() => setRows((rs) => [...rs, { platform: rs.at(-1)?.platform ?? "", handle: "" }])}
            className="mt-2"
          >
            + Tambah akun
          </Button>
          {invalid.length > 0 && (
            <p className="mt-1 text-xs text-red-600">Username tidak valid: {invalid.map((r) => r.handle).join(", ")}</p>
          )}
        </div>
        <ErrorText error={save.error ?? platforms.error} />
        <div className="flex gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending || name.trim().length < 2 || !clean.length || invalid.length > 0}>
            {save.isPending ? "Menyimpan…" : "Simpan"}
          </Button>
          <Button variant="ghost" onClick={() => nav(id ? `/topics/${id}` : "/accounts")}>
            Batal
          </Button>
        </div>
        {!id && <p className="text-xs text-zinc-500">Setelah disimpan, post 7 hari terakhir akun-akun ini langsung diambil.</p>}
      </div>
    </Card>
  );
}
