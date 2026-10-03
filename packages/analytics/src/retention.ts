// H-04 retensi ClickHouse (DATA_MODEL §9): data per-tenant mengikuti retention_days paket kantor; post global yang tidak
// pernah cocok topik dihapus setelah unmatched_posts_retention_days; post global yang tak lagi direferensikan match mana pun
// dihapus setelah global_posts_retention_days. Penghapusan = mutation ALTER TABLE … DELETE (asinkron di ClickHouse).
import type { ClickHouseClient } from "@clickhouse/client";

/** Tabel ber-tenant + kolom waktunya (agregat memakai `bucket`). */
export const TENANT_TABLES: { table: string; col: string }[] = [
  { table: "topic_match_events", col: "published_at" },
  { table: "topic_matches", col: "published_at" },
  { table: "media_items", col: "published_at" },
  { table: "agg_topic_5m", col: "bucket" },
  { table: "agg_topic_1h", col: "bucket" },
  { table: "agg_topic_1d", col: "bucket" },
  { table: "agg_topic_uniq_1h", col: "bucket" },
  { table: "agg_emotion_1h", col: "bucket" },
  { table: "agg_emotion_1d", col: "bucket" },
  { table: "agg_issue_1h", col: "bucket" },
  { table: "agg_hashtag_1h", col: "bucket" },
  { table: "agg_hashtag_1d", col: "bucket" },
  { table: "agg_geo_1d", col: "bucket" },
  { table: "agg_author_1d", col: "bucket" },
  { table: "agg_author_age_1d", col: "bucket" },
  { table: "agg_reposted_author_1d", col: "bucket" },
  { table: "agg_psycho_gender_1d", col: "bucket" },
  { table: "agg_psycho_age_1d", col: "bucket" },
];

const ts = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function existing(ch: ClickHouseClient): Promise<Set<string>> {
  const r = await ch.query({ query: "SELECT name FROM system.tables WHERE database = currentDatabase()", format: "JSONEachRow" });
  return new Set((await r.json<{ name: string }>()).map((x) => x.name));
}

async function del(ch: ClickHouseClient, table: string, where: string, params: Record<string, unknown>, sync: boolean) {
  await ch.command({
    query: `ALTER TABLE ${table} DELETE WHERE ${where}`,
    query_params: params,
    clickhouse_settings: sync ? { mutations_sync: "2" } : {},
  });
}

/** Data tenant lebih tua dari `before` (retensi paket). `before = null` → SEMUA data tenant (purge kantor). */
export async function purgeTenantData(ch: ClickHouseClient, tenantId: string, before: Date | null, o: { sync?: boolean } = {}) {
  if (!UUID.test(tenantId)) throw new Error("tenant_id tidak valid");
  const have = await existing(ch);
  const done: string[] = [];
  for (const t of TENANT_TABLES) {
    if (!have.has(t.table)) continue;
    const where = before
      ? `tenant_id = {t:UUID} AND ${t.col} < ${t.col === "bucket" ? "toDateTime({b:String})" : "parseDateTime64BestEffort({b:String}, 3)"}`
      : "tenant_id = {t:UUID}";
    await del(ch, t.table, where, { t: tenantId, b: before ? ts(before) : "" }, !!o.sync);
    done.push(t.table);
  }
  return done;
}

/** Post global: tak-match lewat `unmatchedBefore`; pernah match tapi tak lagi direferensikan & lewat `globalBefore`. */
export async function purgeGlobalPosts(ch: ClickHouseClient, b: { unmatchedBefore: Date; globalBefore: Date }, o: { sync?: boolean } = {}) {
  await del(ch, "posts", "matched = 0 AND published_at < parseDateTime64BestEffort({u:String}, 3)", { u: ts(b.unmatchedBefore) }, !!o.sync);
  await del(
    ch,
    "posts",
    "published_at < parseDateTime64BestEffort({g:String}, 3) AND (platform, post_id) NOT IN (SELECT platform, post_id FROM topic_matches)",
    { g: ts(b.globalBefore) },
    !!o.sync,
  );
}
