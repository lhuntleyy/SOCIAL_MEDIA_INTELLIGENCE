import { useQueries, useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { Link } from "react-router";
import { api } from "../api";
import type { Run, TopicSummary } from "../types";
import { Card, Empty, ErrorText, PLATFORM_LABEL } from "../ui";
import { RunsTable } from "./Topics";

/** Ringkasan ingest (data nyata dari API). Widget analitik (sentiment/emosi/issue) menyusul D-01 + worker AI. */
export default function Dashboard() {
  const topics = useQuery({ queryKey: ["topics", ""], queryFn: () => api<TopicSummary[]>("/topics?limit=50") });
  const runs = useQueries({
    queries: (topics.data ?? []).map((t) => ({
      queryKey: ["runs", t.id],
      queryFn: () => api<Run[]>(`/topics/${t.id}/runs?limit=50`),
      refetchInterval: 60_000,
    })),
  });
  const all = runs.flatMap((r) => r.data ?? []);
  const byPlatform = new Map<string, number>();
  for (const r of all) byPlatform.set(r.platform, (byPlatform.get(r.platform) ?? 0) + r.items_matched);
  const kpi = [
    { label: "Topik aktif", value: topics.data?.filter((t) => t.status === "active").length ?? 0 },
    { label: "Run crawling", value: all.length },
    { label: "Post match", value: all.reduce((a, r) => a + r.items_matched, 0) },
    { label: "Post baru", value: all.reduce((a, r) => a + r.items_new, 0) },
  ];
  const recent = [...all].sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for)).slice(0, 10);
  return (
    <div className="space-y-4">
      <ErrorText error={topics.error} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpi.map((k) => (
          <div key={k.label} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase text-zinc-500">{k.label}</div>
            <div className="mt-1 text-3xl font-bold tabular-nums text-zinc-900">{k.value.toLocaleString("id-ID")}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Post match per platform">
          {byPlatform.size ? (
            <ReactECharts
              style={{ height: 260 }}
              option={{
                tooltip: { trigger: "item" },
                color: ["#b91c1c", "#f87171", "#52525b", "#a1a1aa", "#fca5a5", "#27272a"],
                series: [
                  {
                    type: "pie",
                    radius: ["45%", "75%"],
                    data: [...byPlatform].map(([k, v]) => ({ name: PLATFORM_LABEL[k] ?? k, value: v })),
                  },
                ],
              }}
            />
          ) : (
            <Empty>Belum ada data.</Empty>
          )}
        </Card>
        <div className="lg:col-span-2">
          <Card
            title="Run terakhir"
            right={
              <Link to="/topics" className="text-xs text-brand-600">
                semua topik →
              </Link>
            }
          >
            <RunsTable runs={recent} />
          </Card>
        </div>
      </div>
      <Card title="Analitik sentimen & emosi">
        <Empty>Widget sentimen, emosi, isu, dan hashtag aktif setelah worker AI (Fase 3) berjalan — sedang dikerjakan.</Empty>
      </Card>
    </div>
  );
}
