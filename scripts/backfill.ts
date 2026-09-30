// Operator: ambil ulang data topik untuk N hari terakhir (= POST /topics/{id}/backfill, lewat TopicService yang sama).
//   bun --env-file=infra/compose/.env.dev scripts/backfill.ts "<nama topik>" [hari=7] [platform,platform,…]
// Tanpa daftar platform → semua platform aktif topik. Run masuk antrean prioritas rendah (maks. 31 hari).
import { createDb } from "@smip/db";
import postgres from "postgres";
import { TopicService } from "../apps/api/src/topics/service";

const [name, daysArg, platformsArg] = process.argv.slice(2);
if (!name) throw new Error('pakai: scripts/backfill.ts "<nama topik>" [hari] [platform,…]');
const days = Number(daysArg ?? 7);
if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error("hari harus 1–31");

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const { db, close } = createDb(process.env.DATABASE_URL!, { max: 4 });
try {
  const [t] = await sql`select id, tenant_id, author_user_id from topics where name = ${name} and deleted_at is null`;
  if (!t) throw new Error(`topik "${name}" tidak ditemukan`);
  const platforms = platformsArg
    ? platformsArg.split(",").map((p) => p.trim())
    : (await sql`select platform_code from topic_platforms where topic_id = ${t.id} and enabled`).map((r) => r.platform_code as string);
  const to = new Date(Date.now() - 60_000);
  const from = new Date(to.getTime() - days * 86_400_000);
  const r = await new TopicService(db).backfill({ userId: t.author_user_id, tenantId: t.tenant_id, requestId: "ops-backfill" }, t.id, {
    from: from.toISOString(),
    to: to.toISOString(),
    platforms,
  });
  console.log(`${name}: ${r.runs_created} run backfill (${days} hari, ${platforms.join(", ")})`);
} finally {
  await sql.end();
  await close();
}
