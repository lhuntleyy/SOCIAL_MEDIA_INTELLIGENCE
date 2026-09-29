import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import type { TopicDetail, TopicSummary } from "../types";
import { Badge, Button, Card, Empty, ErrorText, Input, PLATFORM_LABEL } from "../ui";

const statusTone = (s: string) =>
  s === "active" || s === "succeeded" ? "green" : s === "failed" ? "red" : s === "paused" || s === "partial" ? "amber" : "zinc";

const RANK: Record<string, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };
/** Peran minimum di kantor aktif (administrator platform selalu lolos). */
export function useRole(min: "analyst" | "admin") {
  const { me } = useAuth();
  return !!me && (me.user.is_platform_operator || (RANK[me.current_tenant.role] ?? 0) >= RANK[min]!);
}

export function TopicList() {
  const canWrite = useRole("analyst");
  const [search, setSearch] = useState("");
  const q = useQuery({
    queryKey: ["topics", search],
    queryFn: () => api<TopicSummary[]>(`/topics?limit=50${search ? `&search=${encodeURIComponent(search)}` : ""}`),
  });
  return (
    <Card
      title="Topik"
      right={
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">{q.data?.length ?? 0} topik</span>
          {canWrite && (
            <Link to="/topics/new" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
              + Buat topik
            </Link>
          )}
        </div>
      }
    >
      <Input placeholder="Cari topik…" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-3" />
      <ErrorText error={q.error} />
      {q.data && !q.data.length && <Empty>Belum ada topik.</Empty>}
      <ul className="divide-y divide-zinc-100">
        {q.data?.map((t) => (
          <li key={t.id}>
            <Link to={`/topics/${t.id}`} className="flex items-center justify-between gap-3 py-3 hover:bg-zinc-50">
              <div className="min-w-0">
                <div className="truncate font-medium">{t.name}</div>
                <div className="truncate text-xs text-zinc-500">
                  {t.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(" · ") || "tanpa platform"}
                </div>
              </div>
              <Badge tone={statusTone(t.status)}>{t.status}</Badge>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function TopicPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const canWrite = useRole("analyst");
  const canAdmin = useRole("admin");
  const t = useQuery({ queryKey: ["topic", id], queryFn: () => api<TopicDetail>(`/topics/${id}`) });
  const status = useMutation({
    mutationFn: (to: "pause" | "resume" | "archive") =>
      to === "archive"
        ? api(`/topics/${id}`, { method: "DELETE", headers: { "if-match": String(t.data?.version ?? "") } })
        : api(`/topics/${id}/${to}`, { method: "POST", headers: { "if-match": String(t.data?.version ?? "") } }),
    onSuccess: (_r, to) => {
      void qc.invalidateQueries({ queryKey: ["topics"] });
      if (to === "archive") nav("/topics");
      else void qc.invalidateQueries({ queryKey: ["topic", id] });
    },
  });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="space-y-4">
        <ErrorText error={t.error} />
        {t.data && (
          <Card title={t.data.name} right={<Badge tone={statusTone(t.data.status)}>{t.data.status}</Badge>}>
            {t.data.description && <p className="mb-3 text-sm text-zinc-600">{t.data.description}</p>}
            <div className="mb-3 flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => nav(`/?topic=${id}`)}>
                Lihat dashboard
              </Button>
              {canWrite && (
                <>
                  <Button onClick={() => nav(`/topics/${id}/edit`)}>Ubah</Button>
                  {t.data.status === "active" ? (
                    <Button variant="ghost" onClick={() => status.mutate("pause")}>
                      Jeda
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => status.mutate("resume")}>
                      Lanjutkan
                    </Button>
                  )}
                  {canAdmin && (
                    <Button
                      variant="danger"
                      onClick={() => confirm(`Arsipkan topik "${t.data?.name}"? Crawling berhenti.`) && status.mutate("archive")}
                    >
                      Arsipkan
                    </Button>
                  )}
                </>
              )}
            </div>
            <ErrorText error={status.error} />
            <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500">Platform</h3>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {t.data.platforms
                .filter((p) => p.enabled)
                .map((p) => (
                  <Badge key={p.code}>{PLATFORM_LABEL[p.code] ?? p.code}</Badge>
                ))}
            </div>
            <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500">Query</h3>
            <ul className="space-y-2">
              {t.data.queries.map((q) => (
                <li key={q.id} className={`rounded-lg p-2 font-mono text-xs ${q.kind === "main" ? "bg-zinc-100" : "bg-brand-50"}`}>
                  {q.label && <div className="mb-1 font-sans font-semibold">{q.label}</div>}
                  {q.query_text}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
