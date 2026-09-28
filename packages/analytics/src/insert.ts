// Setting insert WAJIB untuk worker-sink ke topic_match_events / posts (F-05, bukti di test/migrate.test.ts):
// - insert_deduplication_token = batch_id → batch terkirim ulang (P-03) tidak menggandakan baris sumber
// - deduplicate_blocks_in_dependent_materialized_views = 1 → dedup JUGA berlaku di tabel target MV;
//   tanpa ini sumber ter-dedup tetapi MV tetap menerima blok → AGREGAT DOBEL (ditemukan 2026-09-28).
//   Setting ini hanya efektif bila tabel target MV punya non_replicated_deduplication_window > 0 (migrasi 0001/0002).
// - async_insert = 0 → perilaku tidak bergantung default versi server (26.10 default async_insert=1).
export function sinkInsertSettings(batchId: string) {
  return {
    insert_deduplication_token: batchId,
    deduplicate_blocks_in_dependent_materialized_views: 1,
    async_insert: 0,
  } as const;
}
