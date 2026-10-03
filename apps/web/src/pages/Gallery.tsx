// U-04 Galeri: post bermedia (foto/video) untuk topik & filter yang dipakai — klik → detail post + tautan asli. Gambar dimuat
// langsung dari CDN platform dengan referrerPolicy no-referrer; URL CDN yang kedaluwarsa jatuh ke kartu teks.
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Filters, fmtN, SENT_COLOR, SENT_LABEL } from "../analytics";
import { api } from "../api";
import { Button, Empty, fmtTime, Modal, PLATFORM_LABEL } from "../ui";

interface Item {
  platform: string;
  post_id: string;
  published_at: string;
  sentiment: string;
  engagement: number | null;
  author_handle: string;
  text: string;
  url: string | null;
  media: { type: string; url: string; thumb: string | null }[];
}
const PAGE = 48;

/** Gambar tampilan: thumbnail bila ada, selain itu URL gambar (video tanpa thumbnail → null). */
const coverOf = (i: Item) => {
  const m = i.media[0];
  if (!m) return null;
  return m.thumb ?? (m.type === "video" ? null : m.url);
};

function Cover({ src, alt, className }: { src: string | null; alt: string; className: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <div className={`${className} flex items-center justify-center bg-zinc-100 p-3 text-center text-xs text-zinc-500`}>
        {alt || "media"}
      </div>
    );
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className={`${className} object-cover`}
    />
  );
}

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs ${on ? "bg-brand-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
    >
      {children}
    </button>
  );
}

export default function Gallery({ f }: { f: Filters }) {
  const [type, setType] = useState<"" | "image" | "video">("");
  const [sort, setSort] = useState<"engagement" | "latest">("engagement");
  const [sent, setSent] = useState("");
  const [open, setOpen] = useState<Item | null>(null);
  const qs = `${f.qs}&sort=${sort}${type ? `&media_type=${type}` : ""}${sent ? `&sentiment=${sent}` : ""}`;
  const q = useInfiniteQuery({
    queryKey: ["gallery", qs],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<{ items: Item[]; has_more: boolean }>(`/analytics/gallery?${qs}&limit=${PAGE}&offset=${pageParam}`),
    getNextPageParam: (last, all) => (last.has_more ? all.length * PAGE : undefined),
    enabled: !!f.topic,
    placeholderData: keepPreviousData,
    refetchInterval: f.refresh.ms || false,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip on={type === ""} onClick={() => setType("")}>
          Semua media
        </Chip>
        <Chip on={type === "image"} onClick={() => setType("image")}>
          Foto
        </Chip>
        <Chip on={type === "video"} onClick={() => setType("video")}>
          Video
        </Chip>
        <span className="mx-1 h-4 w-px bg-zinc-200" />
        {["", "negative", "neutral", "positive"].map((s) => (
          <Chip key={s} on={sent === s} onClick={() => setSent(s)}>
            {s ? SENT_LABEL[s] : "Semua sentimen"}
          </Chip>
        ))}
        <span className="mx-1 h-4 w-px bg-zinc-200" />
        <Chip on={sort === "engagement"} onClick={() => setSort("engagement")}>
          Engagement tertinggi
        </Chip>
        <Chip on={sort === "latest"} onClick={() => setSort("latest")}>
          Terbaru
        </Chip>
      </div>
      {q.error && <p className="text-sm text-red-600">{(q.error as Error).message}</p>}
      {q.isLoading && <Empty>Memuat…</Empty>}
      {q.data && !items.length && <Empty>Belum ada post bermedia untuk filter ini.</Empty>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {items.map((i) => (
          <button
            type="button"
            key={`${i.platform}:${i.post_id}`}
            onClick={() => setOpen(i)}
            className="group overflow-hidden rounded-lg border border-zinc-200 text-left transition hover:shadow-md"
          >
            <div className="relative">
              <Cover src={coverOf(i)} alt={i.text.slice(0, 80)} className="aspect-square w-full" />
              {i.media[0]?.type === "video" && (
                <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 text-xs text-white">▶ video</span>
              )}
              <span
                className="absolute left-1.5 top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white"
                style={{ background: SENT_COLOR[i.sentiment] ?? "#a1a1aa" }}
                title={SENT_LABEL[i.sentiment]}
              />
            </div>
            <div className="p-2 text-xs">
              <div className="truncate font-medium text-zinc-700">@{i.author_handle}</div>
              <div className="flex justify-between text-zinc-500">
                <span>{PLATFORM_LABEL[i.platform] ?? i.platform}</span>
                <span>{i.engagement !== null ? `${fmtN(i.engagement)} eng.` : ""}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
      {q.hasNextPage && (
        <div className="mt-4 text-center">
          <Button variant="ghost" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? "Memuat…" : "Muat lebih banyak"}
          </Button>
        </div>
      )}
      {open && (
        <Modal title={`@${open.author_handle} · ${PLATFORM_LABEL[open.platform] ?? open.platform}`} onClose={() => setOpen(null)}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              {open.media.map((m) => (
                <Cover key={m.url} src={m.thumb ?? (m.type === "video" ? null : m.url)} alt="" className="max-h-96 w-full rounded-lg" />
              ))}
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span>{fmtTime(`${open.published_at.replace(" ", "T")}Z`)}</span>
                <span className="rounded-full px-2 py-0.5 text-white" style={{ background: SENT_COLOR[open.sentiment] ?? "#a1a1aa" }}>
                  {SENT_LABEL[open.sentiment] ?? open.sentiment}
                </span>
                {open.engagement !== null && <span>{fmtN(open.engagement)} engagement</span>}
              </div>
              <p className="whitespace-pre-wrap text-zinc-700">{open.text}</p>
              {open.url && (
                <a href={open.url} target="_blank" rel="noopener noreferrer" className="inline-block text-brand-600 hover:underline">
                  Buka post asli ↗
                </a>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
