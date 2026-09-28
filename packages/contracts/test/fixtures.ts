// Fixture kontrak: valid & invalid per skema. Dipakai test TS dan Python (validasi harus sepakat).
export const VALID_ITEM = {
  schema: "canonical-item/v1",
  platform: "x",
  platform_post_id: "1830000000000000001",
  content_type: "repost",
  url: "https://x.com/infowarga_id/status/1830000000000000001",
  text: "RT Demo di depan gedung DPR hari ini #DemoDPR 😡",
  lang_hint: null,
  published_at: "2026-08-28T03:21:00.000Z",
  parent: { platform_post_id: "1829999999999999999", author: { platform_user_id: "998877", handle: "BBCIndonesia" } },
  root_post_id: null,
  author: {
    platform_user_id: "1234567",
    handle: "infowarga_id",
    display_name: "Info Warga",
    followers: 10234,
    following: null,
    verified: false,
    created_at: null,
    location_raw: "Jakarta",
    avatar_url: "https://pbs.twimg.com/a.jpg",
  },
  metrics: { likes: 120, comments: 14, shares: null, views: null, quotes: null, saves: null, captured_at: "2026-08-28T03:25:10.000Z" },
  hashtags: ["demodpr"],
  mentions: [],
  media: [{ type: "image", url: "https://pbs.twimg.com/m.jpg" }],
  geo: { lat: null, lng: null, place_name: null },
  is_ad: null,
  extra: { twitterapi_io: { conversationId: "1829999999999999999" } },
  provenance: { connector_key: "twitterapi_io.x", connector_version: "0.1.0", fetched_at: "2026-08-28T03:25:10.000Z", raw_ref: null },
};

const clone = <T>(o: T): T => structuredClone(o);
// Fixture sengaja membentuk data INVALID (tipe salah, field dihapus) → butuh tipe longgar.
// biome-ignore lint/suspicious/noExplicitAny: mutasi bebas pada fixture test
type Loose = Record<string, any>;
const withItem = (f: (o: Loose) => void) => {
  const o = clone(VALID_ITEM) as Loose;
  f(o);
  return o;
};

export const VALID_ENVELOPE = {
  v: 1,
  type: "fetch.request",
  id: "0192f0c4-8a4e-7c3b-9d2e-5b1a2f3c4d5e",
  idempotency_key: "run.0192f0c4-8a4e-7c3b-9d2e-5b1a2f3c4d5e.attempt.2",
  tenant_id: "0192ef00-0000-7000-8000-000000000001",
  created_at: "2026-09-27T10:00:00.000Z",
  trace: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
  payload: { anything: true },
};

export const VALID_SINK = {
  batch_id: "0192f0c4-8a4e-7c3b-9d2e-000000000001",
  crawl_run_id: "0192f0c4-8a4e-7c3b-9d2e-000000000002",
  tenant_id: null,
  topic_id: null,
  posts_ref: "s3://smip-raw/batches/x/posts.jsonl.gz",
  matches: [],
  run_update: {
    items_fetched: 25,
    items_matched: 0,
    items_new: 2,
    new_high_watermark: null,
    run_outcome: "partial",
    gap_window: { since: "2026-09-27T09:45:00Z", until: "2026-09-27T09:52:10Z" },
  },
};

/** [nama kasus, skema, data, harus valid?] */
export const CASES: [string, string, unknown, boolean][] = [
  ["item valid", "CanonicalItem", VALID_ITEM, true],
  ["item: metrik tak diketahui = null (bukan 0) valid", "CanonicalItem", withItem((o) => (o.metrics.likes = null)), true],
  ["item: likes negatif", "CanonicalItem", withItem((o) => (o.metrics.likes = -1)), false],
  ["item: likes pecahan", "CanonicalItem", withItem((o) => (o.metrics.likes = 1.5)), false],
  ["item: published_at tanpa zona", "CanonicalItem", withItem((o) => (o.published_at = "2026-08-28T03:21:00")), false],
  [
    "item: published_at offset +07:00 (wajib UTC Z)",
    "CanonicalItem",
    withItem((o) => (o.published_at = "2026-08-28T10:21:00+07:00")),
    false,
  ],
  ["item: published_at relatif", "CanonicalItem", withItem((o) => (o.published_at = "2 jam lalu")), false],
  ["item: field tambahan ditolak", "CanonicalItem", withItem((o) => (o.sentiment = "negative")), false],
  ["item: author tanpa handle", "CanonicalItem", withItem((o) => delete o.author.handle), false],
  ["item: platform kode registry baru valid", "CanonicalItem", withItem((o) => (o.platform = "bluesky")), true],
  ["item: platform huruf besar", "CanonicalItem", withItem((o) => (o.platform = "X")), false],
  ["item: content_type tak dikenal", "CanonicalItem", withItem((o) => (o.content_type = "story")), false],
  ["envelope valid", "Envelope", VALID_ENVELOPE, true],
  ["envelope: idempotency_key dengan ':' (BullMQ)", "Envelope", { ...VALID_ENVELOPE, idempotency_key: "run:1:attempt:1" }, false],
  ["envelope: v=2", "Envelope", { ...VALID_ENVELOPE, v: 2 }, false],
  ["envelope: traceparent rusak", "Envelope", { ...VALID_ENVELOPE, trace: { traceparent: "00-xyz" } }, false],
  ["sink: batch post tak-match (tenant null, matches kosong) valid", "SinkAnalyticsPayload", VALID_SINK, true],
  [
    "sink: run_outcome tak dikenal",
    "SinkAnalyticsPayload",
    { ...VALID_SINK, run_update: { ...VALID_SINK.run_update, run_outcome: "ok" } },
    false,
  ],
];
