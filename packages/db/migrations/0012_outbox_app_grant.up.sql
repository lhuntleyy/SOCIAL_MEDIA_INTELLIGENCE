-- I-03: API (smip_app) menulis perubahan config + baris outbox dalam SATU transaksi (ARCHITECTURE §9).
-- Hanya INSERT: membaca/menandai published tetap milik publisher (smip_system).
GRANT INSERT ON outbox TO smip_app;
GRANT USAGE ON SEQUENCE outbox_id_seq TO smip_app;
