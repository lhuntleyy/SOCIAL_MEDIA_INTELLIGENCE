// I-03 `/topics/preview` (API_SPEC §4): kandidat dari data yang SUDAH terindeks (posts, 7 hari) — tidak memanggil
// provider. ClickHouse hanya menyaring kasar via leaf set penutup (recall); presisi & estimasi = matcher lokal di API.
import type { ClickHouseClient } from "@clickhouse/client";

export interface PreviewCandidate {
  platform: string;
  post_id: string;
  text: string;
  lang: string;
  hashtags: string[];
  published_at: string;
}

export interface PreviewQuery {
  platforms: string[];
  /** Nilai leaf (term/frasa ter-normalisasi) — dicari case-insensitive di teks. */
  needles: string[];
  /** Hashtag tanpa '#', lowercase. */
  hashtags: string[];
  days?: number;
  sampleLimit?: number;
}

/** Jumlah kandidat per platform + sampel terbaru untuk dievaluasi matcher. */
export async function previewCandidates(
  ch: ClickHouseClient,
  q: PreviewQuery,
): Promise<{ counts: Record<string, number>; sample: PreviewCandidate[] }> {
  const params = {
    platforms: q.platforms,
    needles: q.needles.slice(0, 250), // batas multiSearchAny = 255 needle
    tags: q.hashtags,
    days: q.days ?? 7,
    limit: q.sampleLimit ?? 2000,
  };
  const where = `published_at >= now64(3) - toIntervalDay({days:UInt32}) AND platform IN {platforms:Array(String)}
    AND (multiSearchAnyCaseInsensitiveUTF8(text, {needles:Array(String)}) OR hasAny(hashtags, {tags:Array(String)}))`;
  const [counts, sample] = await Promise.all([
    ch
      .query({
        query: `SELECT platform, uniqExact(post_id) AS n FROM posts WHERE ${where} GROUP BY platform`,
        query_params: params,
        format: "JSONEachRow",
      })
      .then((r) => r.json<{ platform: string; n: string }>()),
    ch
      .query({
        // alias berbeda dari nama kolom: ClickHouse me-resolve alias SELECT di WHERE (alias = kolom → ILLEGAL_AGGREGATION)
        query: `SELECT platform, post_id, x_text AS text, x_lang AS lang, x_tags AS hashtags, x_pub AS published_at FROM (
                  SELECT platform, post_id, argMax(text, version) AS x_text, argMax(lang, version) AS x_lang,
                         argMax(hashtags, version) AS x_tags, max(published_at) AS x_pub
                  FROM posts WHERE ${where} GROUP BY platform, post_id)
                ORDER BY x_pub DESC LIMIT {limit:UInt32}`,
        query_params: params,
        format: "JSONEachRow",
      })
      .then((r) => r.json<PreviewCandidate>()),
  ]);
  return { counts: Object.fromEntries(counts.map((c) => [c.platform, Number(c.n)])), sample };
}
