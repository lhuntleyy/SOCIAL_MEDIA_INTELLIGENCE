// H-02 invarian chaos: dicetak sebagai JSON → dibandingkan sebelum/sesudah gangguan oleh run.sh.
//   dup_events      : baris topic_match_events kembar (tenant, topik, platform, post, model_version, sign) — harus TIDAK naik
//   dlq             : total job di semua DLQ — harus tidak naik
//   outbox_pending  : outbox belum terkirim (harus kembali 0)
//   runs_open       : run non-final (queued/dispatching/fetching/processing)
//   runs_failed_10m : run gagal 10 menit terakhir; runs_ok_10m : run sukses 10 menit terakhir
import { createClient } from "@clickhouse/client";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const ch = createClient({
  url: process.env.CLICKHOUSE_URL,
  database: process.env.CLICKHOUSE_DB,
  username: process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_PASSWORD,
});
const q = new Bun.RedisClient(process.env.REDIS_URL!);
const out: Record<string, number | string> = {};
try {
  const [d] = await (
    await ch.query({
      query: `SELECT count() AS n FROM (SELECT tenant_id, topic_id, platform, post_id, model_version, sign, count() AS c
              FROM topic_match_events GROUP BY ALL HAVING c > 1)`,
      format: "JSONEachRow",
    })
  ).json<{ n: string }>();
  out.dup_events = Number(d?.n ?? 0);
} catch (e) {
  out.dup_events = `clickhouse error: ${(e as Error).message.slice(0, 60)}`;
}
let dlq = 0;
for (const k of (await q.send("KEYS", ["bull:dlq.*:wait"])) as string[]) dlq += Number(await q.send("LLEN", [k]));
out.dlq = dlq;
const [r] = await sql`select
  (select count(*)::int from outbox where published_at is null) as outbox_pending,
  (select count(*)::int from crawl_runs where status in ('queued','dispatching','fetching','processing')) as runs_open,
  (select count(*)::int from crawl_runs where status = 'failed' and coalesce(finished_at, scheduled_for) > now() - interval '10 minutes') as runs_failed_10m,
  (select count(*)::int from crawl_runs where status in ('succeeded','partial') and finished_at > now() - interval '10 minutes') as runs_ok_10m`;
Object.assign(out, r);
console.log(JSON.stringify(out));
q.close();
await ch.close();
await sql.end();
