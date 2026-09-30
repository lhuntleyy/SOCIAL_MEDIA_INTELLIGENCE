// A-06 reprocess/relabel (AI_SPEC §9): match yang sudah tercatat diberi label model baru TANPA dobel hitung —
// salinan persis baris +1 terakhir dengan sign −1, lalu +1 berisi sentimen/emosi/model_version baru (pola override/refresh).
// Match yang model_version-nya sudah sama dilewati (idempoten); pesan diulang → ledger processed_messages.
import { HUMAN_MODEL_VERSION, sinkInsertSettings } from "@smip/analytics";
import type { SinkAnalyticsPayload } from "@smip/contracts";
import { claimMessage, withSystem } from "@smip/db";
import { chTime, type SinkDeps, type SinkResult } from "./sink";

type EventRow = Record<string, unknown> & { platform: string; post_id: string; model_version: string };

export async function handleRelabelSink(d: SinkDeps, m: SinkAnalyticsPayload): Promise<SinkResult> {
  const now = d.now?.() ?? new Date();
  const nowCh = chTime(now.toISOString());
  const res: SinkResult = { posts: 0, events: 0, skippedByGuard: 0, finalized: null, duplicateMessage: false };
  if (!m.tenant_id || !m.topic_id || !m.matches.length) return res;
  const current = await d.ch
    .query({
      query: `SELECT * FROM topic_match_events
              WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND post_id IN {ids:Array(String)} AND sign = 1
              ORDER BY event_at DESC LIMIT 1 BY tenant_id, topic_id, platform, post_id`,
      query_params: { t: m.tenant_id, topic: m.topic_id, ids: [...new Set(m.matches.map((x) => x.post_id))] },
      format: "JSONEachRow",
    })
    .then((r) => r.json<EventRow>());
  const byKey = new Map(current.map((c) => [`${c.platform}|${c.post_id}`, c]));
  const rows: Record<string, unknown>[] = [];
  for (const x of m.matches) {
    const cur = byKey.get(`${x.platform}|${x.post_id}`);
    // label manusia (A-05) selalu menang: reprocess model tidak menimpanya
    if (!cur || cur.model_version === x.model_version || cur.model_version === HUMAN_MODEL_VERSION) {
      res.skippedByGuard++;
      continue;
    }
    rows.push({ ...cur, sign: -1, event_at: nowCh });
    rows.push({
      ...cur,
      sentiment: x.sentiment,
      sentiment_score: x.sentiment_score,
      emotion: x.emotion,
      emotion_score: x.emotion_score,
      model_version: x.model_version,
      sign: 1,
      event_at: nowCh,
    });
  }
  if (rows.length)
    await d.ch.insert({
      table: "topic_match_events",
      format: "JSONEachRow",
      values: rows,
      clickhouse_settings: sinkInsertSettings(`${m.batch_id}.relabel`),
    });
  res.events = rows.length / 2;
  // tulis dulu, baru catat ledger: gagal di tengah → diulang; guard model_version + dedup token mencegah dobel
  res.duplicateMessage = !(await withSystem(d.db, (tx) => claimMessage(tx, `sink.${m.batch_id}`)));
  d.logger?.info("sink relabel", { batch_id: m.batch_id, relabeled: res.events, skipped: res.skippedByGuard });
  return res;
}
