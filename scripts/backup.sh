#!/usr/bin/env bash
# H-06 backup (DEPLOYMENT §backup): Postgres (pg_dump custom format, di dalam container) + ClickHouse (tabel DASAR saja dalam
# format Native — tabel agregat & topic_matches dibangun ulang oleh materialized view saat restore, jadi tidak dobel).
# Tidak menyimpan secret: KEK KMS / .env / secrets.env WAJIB dibackup terpisah (tanpa itu credential di backup tak bisa dibuka).
#   pakai: scripts/backup.sh [--env infra/compose/.env.dev] [--keep 7]      tujuan: $SMIP_BACKUP_DIR (bawaan ~/smip-backups)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=infra/compose/.env.dev
KEEP=7
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE=$2; shift 2 ;;
    --keep) KEEP=$2; shift 2 ;;
    *) echo "argumen tidak dikenal: $1" >&2; exit 2 ;;
  esac
done
set -a; . "$ENV_FILE"; set +a
PG_CONTAINER=${PG_CONTAINER:-smip-dev-postgres-1}
ROOT=${SMIP_BACKUP_DIR:-$HOME/smip-backups}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$ROOT/$STAMP"
mkdir -p "$OUT"
chmod 700 "$ROOT" "$OUT"
PGDB=$(echo "$DATABASE_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')
PGUSER=$(echo "$DATABASE_URL" | sed -E 's#^[a-z]+://([^:@]+).*#\1#')
DOCKER="docker"; docker ps >/dev/null 2>&1 || DOCKER="sg docker -c docker"
t0=$(date +%s)
# --- Postgres ---
$DOCKER exec "$PG_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" -Fc -Z 6 > "$OUT/postgres.dump"
$DOCKER exec "$PG_CONTAINER" pg_dumpall -U "$PGUSER" --globals-only --no-role-passwords > "$OUT/postgres-globals.sql"
PG_ROWS=$($DOCKER exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -Atc "select coalesce(sum(n_live_tup),0) from pg_stat_user_tables")
# --- ClickHouse: tabel dasar = bukan target materialized view, bukan view ---
CH="$CLICKHOUSE_URL/?database=$CLICKHOUSE_DB"
chq() { curl -sfS "$CH" --user "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --data-binary "$1"; }
TABLES=$(chq "SELECT name FROM system.tables WHERE database = currentDatabase() AND engine LIKE '%MergeTree'
  AND name NOT IN (SELECT extract(create_table_query, 'TO [a-zA-Z0-9_]+\\.([a-zA-Z0-9_]+)') FROM system.tables
                   WHERE database = currentDatabase() AND engine = 'MaterializedView') ORDER BY name FORMAT TSV")
MANIFEST="{\"created_at\":\"$STAMP\",\"postgres\":{\"database\":\"$PGDB\",\"live_rows\":$PG_ROWS},\"clickhouse\":{"
first=1
for t in $TABLES; do
  n=$(chq "SELECT count() FROM $t FORMAT TSV")
  curl -sfS "$CH" --user "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --data-binary "SELECT * FROM $t FORMAT Native" | gzip -6 > "$OUT/ch-$t.native.gz"
  [ $first = 1 ] || MANIFEST="$MANIFEST,"
  MANIFEST="$MANIFEST\"$t\":$n"; first=0
done
MIG=$(chq "SELECT max(version) FROM smip_schema_migrations FORMAT TSV" || echo 0)
t1=$(date +%s)
echo "$MANIFEST},\"clickhouse_schema_version\":$MIG,\"duration_sec\":$((t1 - t0))}" > "$OUT/manifest.json"
chmod 600 "$OUT"/*
( cd "$OUT" && sha256sum -- * > SHA256SUMS )
# salinan di luar server (opsional): SMIP_BACKUP_REMOTE = remote rclone (mis. gdrive-smip:smip-backups) yang dihubungkan PEMILIK
# sendiri (`rclone config`, OAuth Google — password tidak pernah lewat sini). Isi backup = data klien → DIENKRIPSI dulu (gpg AES256,
# passphrase di ~/.config/smip/backup.pass, chmod 600 — simpan juga di tempat aman lain; tanpa itu backup tak bisa dibuka).
if [ -n "${SMIP_BACKUP_REMOTE:-}" ]; then
  PASS=${SMIP_BACKUP_PASSFILE:-$HOME/.config/smip/backup.pass}
  if ! command -v rclone >/dev/null; then
    echo "PERINGATAN: rclone belum terpasang — salinan luar server dilewati"
  elif ! rclone listremotes | grep -qx "${SMIP_BACKUP_REMOTE%%:*}:"; then
    echo "PERINGATAN: remote rclone ${SMIP_BACKUP_REMOTE%%:*} belum dihubungkan — salinan luar server dilewati"
  elif [ ! -s "$PASS" ]; then
    echo "PERINGATAN: passphrase $PASS tidak ada — salinan luar server dilewati (tidak mengunggah tanpa enkripsi)"
  else
    ENC="$ROOT/smip-$STAMP.tar.gpg"
    tar -C "$ROOT" -cf - "$STAMP" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$PASS" \
      --symmetric --cipher-algo AES256 -o "$ENC"
    rclone copy "$ENC" "$SMIP_BACKUP_REMOTE" --quiet
    rclone delete "$SMIP_BACKUP_REMOTE" --min-age "${SMIP_BACKUP_REMOTE_DAYS:-30}d" --quiet || true
    rm -f "$ENC"
    echo "salinan terenkripsi diunggah ke $SMIP_BACKUP_REMOTE"
  fi
fi
# rotasi: simpan KEEP backup terbaru
ls -1d "$ROOT"/*/ 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf
echo "backup selesai: $OUT ($(du -sh "$OUT" | cut -f1), $((t1 - t0)) dtk)"
