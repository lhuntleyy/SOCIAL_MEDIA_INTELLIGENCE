// STUB AI — HANYA dev/test (DEPLOYMENT: profil ci/dev). Menggantikan worker-ai Python (Fase 3) supaya alur
// ai.enrich → sink.analytics bisa diuji end-to-end. Label SENGAJA netral/unknown dengan model_version "stub-0"
// (bukan tebakan) agar data dev tidak tertukar dengan inferensi nyata; dilarang jalan di produksi.
import type { AiEnrichPayload, PostRecord, SinkAnalyticsPayload } from "@smip/contracts";

export const STUB_MODEL_VERSION = "stub-0";

export function stubEnrich(ai: AiEnrichPayload, posts: PostRecord[]): SinkAnalyticsPayload {
  const byId = new Map(posts.map((p) => [`${p.platform}|${p.platform_post_id}`, p]));
  return {
    batch_id: ai.batch_id,
    crawl_run_id: ai.crawl_run_id,
    tenant_id: ai.tenant_id,
    topic_id: ai.topic_id,
    posts_ref: ai.items_ref!,
    matches: ai.items.map((i) => {
      const p = byId.get(`${i.platform}|${i.post_id}`);
      return {
        platform: i.platform,
        post_id: i.post_id,
        topic_query_id: i.match.topic_query_id,
        sentiment: "neutral" as const,
        sentiment_score: 0,
        emotion: "unknown" as const,
        emotion_score: 0,
        author_gender: "unknown" as const,
        author_gender_conf: 0,
        author_age_range: "unknown" as const,
        author_age_conf: 0,
        author_followers: p?.author.followers ?? null,
        model_version: STUB_MODEL_VERSION,
        issues: [],
        hashtags: p?.hashtags ?? [],
        parent_author_id: p?.parent?.author?.platform_user_id ?? null,
        geo_region_code: p?.geo_region_code ?? null,
        media: (p?.media ?? []).map((m) => ({ type: m.type, url: m.url, thumb: m.thumb ?? null })),
        engagement: 0,
        engagement_known: false, // sink menghitung dari metrik post
      };
    }),
    run_update: null,
  };
}
