// Operator: parse ulang semua topic_queries dengan parser terkini (mis. setelah ADR-008 amandemen 2026-10-01: operator
// `or/and/not` huruf kecil). Hanya baris yang AST-nya berubah yang diperbarui (+ ast_hash, topics.version, outbox topic.updated).
//   bun --env-file=infra/compose/.env.dev scripts/reparse-queries.ts [--dry]
import { astHash, compileQuery } from "@smip/query";
import postgres from "postgres";

const dry = process.argv.includes("--dry");
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
try {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE smip_system`;
    const rows = await tx`select q.id, q.topic_id, t.name, q.query_text, q.ast_hash, q.keywords, q.languages, q.media_tags, q.not_media_tags
      from topic_queries q join topics t on t.id = q.topic_id where t.deleted_at is null`;
    const topics = new Set<string>();
    for (const r of rows) {
      const c = compileQuery({
        query_text: r.query_text,
        keywords: r.keywords,
        languages: r.languages,
        media_tags: r.media_tags,
        not_media_tags: r.not_media_tags,
      });
      // ast_hash = AST kanonis (urutan key jsonb tidak memengaruhi) → hanya query yang maknanya berubah
      const hash = Buffer.from(await astHash(c));
      if (r.ast_hash && hash.equals(r.ast_hash as Buffer)) continue;
      console.log(`${r.name}: ${r.query_text}`);
      await tx`update topic_queries set query_ast = ${tx.json(c.ast as never)}, ast_hash = ${hash}, updated_at = now()
        where id = ${r.id}`;
      topics.add(r.topic_id as string);
    }
    for (const id of topics) {
      await tx`update topics set version = version + 1, updated_at = now() where id = ${id}`;
      await tx`insert into outbox (aggregate, aggregate_id, event_type, payload) values ('topic', ${id}, 'topic.updated', ${tx.json({ reparse: true })})`;
    }
    console.log(`${topics.size} topik diperbarui${dry ? " (--dry: rollback)" : ""}`);
    if (dry) throw new Error("--dry");
  });
} catch (e) {
  if (!(e instanceof Error && e.message === "--dry")) throw e;
} finally {
  await sql.end();
}
