-- I-15: ledger idempotensi consumer yang mengubah counter (pipeline −1+N, sink −1). Ditulis dalam transaksi yang
-- sama dengan efeknya → pesan yang terkirim ulang SETELAH commit (ack BullMQ gagal) tidak menggandakan efek.
-- Retensi 14 hari (job retention, H-04) — jauh melebihi umur retry queue.
CREATE TABLE processed_messages (
  key text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processed_messages_at_idx ON processed_messages (processed_at);
GRANT SELECT, INSERT, DELETE ON processed_messages TO smip_system;
