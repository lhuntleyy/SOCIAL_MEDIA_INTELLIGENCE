// A-05 koreksi sentimen manual (AI_SPEC §8, P-06): salinan persis baris +1 terakhir dengan sign −1, lalu +1 berlabel baru
// (model_version `human`) → semua agregat (sum(sign)) terkoreksi tanpa UPDATE. Label manusia selalu menang: relabel/reprocess
// model melewati baris `human` (worker-sink relabel.ts).
import type { ClickHouseClient } from "@clickhouse/client";
import { sinkInsertSettings } from "./insert";

export const HUMAN_MODEL_VERSION = "human";
export type SentimentLabel = "negative" | "neutral" | "positive";

type EventRow = Record<string, unknown> & { sentiment: SentimentLabel; model_version: string };

const chNow = (d: Date) => d.toISOString().replace("T", " ").slice(0, 23);

/**
 * Ubah label sentimen satu match. `null` = match tidak ditemukan untuk tenant/topik ini; label sama → tidak menulis apa pun.
 * `batchId` dipakai sebagai dedup token ClickHouse (permintaan diulang dengan id sama tidak menggandakan pasangan).
 */
export async function overrideSentiment(
  ch: ClickHouseClient,
  o: { tenantId: string; topicId: string; platform: string; postId: string; label: SentimentLabel; batchId: string; now?: Date },
): Promise<{ previous: SentimentLabel; previousModelVersion: string; changed: boolean } | null> {
  const [cur] = await ch
    .query({
      query: `SELECT * FROM topic_match_events
              WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND platform = {p:String} AND post_id = {id:String} AND sign = 1
              ORDER BY event_at DESC LIMIT 1`,
      query_params: { t: o.tenantId, topic: o.topicId, p: o.platform, id: o.postId },
      format: "JSONEachRow",
    })
    .then((r) => r.json<EventRow>());
  if (!cur) return null;
  const previous = { previous: cur.sentiment, previousModelVersion: cur.model_version };
  if (cur.sentiment === o.label && cur.model_version === HUMAN_MODEL_VERSION) return { ...previous, changed: false };
  const at = chNow(o.now ?? new Date());
  await ch.insert({
    table: "topic_match_events",
    format: "JSONEachRow",
    values: [
      { ...cur, sign: -1, event_at: at },
      { ...cur, sentiment: o.label, sentiment_score: 1, model_version: HUMAN_MODEL_VERSION, sign: 1, event_at: at },
    ],
    clickhouse_settings: sinkInsertSettings(`override.${o.batchId}`),
  });
  return { ...previous, changed: true };
}
