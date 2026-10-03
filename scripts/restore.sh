#!/usr/bin/env bash
# H-06 restore: scripts/restore.sh <dir-backup> --pg-db <nama> --ch-db <nama> [--env infra/compose/.env.dev]
# Memulihkan ke database BARU (tidak menimpa yang sedang dipakai): Postgres pg_restore → db baru; ClickHouse: migrasi skema →
# insert tabel dasar (materialized view membangun ulang agregat & topic_matches) → bandingkan jumlah baris dengan manifest.
# Untuk pemulihan produksi: arahkan DATABASE_URL/CLICKHOUSE_DB layanan ke database hasil restore lalu restart (RUNBOOK §8).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=${1:?pakai: restore.sh <dir> --pg-db <nama> --ch-db <nama>}; shift
ENV_FILE=infra/compose/.env.dev; PG_TARGET=""; CH_TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE=$2; shift 2 ;;
    --pg-db) PG_TARGET=$2; shift 2 ;;
    --ch-db) CH_TARGET=$2; shift 2 ;;
    *) echo "argumen tidak dikenal: $1" >&2; exit 2 ;;
  esac
done
[[ "$PG_TARGET" =~ ^[a-z][a-z0-9_]{2,40}$ && "$CH_TARGET" =~ ^[a-z][a-z0-9_]{2,40}$ ]] || { echo "nama database tidak valid" >&2; exit 2; }
set -a; . "$ENV_FILE"; set +a
[ "$PG_TARGET" != "$(echo "$DATABASE_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')" ] || { echo "menolak menimpa database aktif" >&2; exit 2; }
[ "$CH_TARGET" != "$CLICKHOUSE_DB" ] || { echo "menolak menimpa database ClickHouse aktif" >&2; exit 2; }
( cd "$DIR" && sha256sum -c --quiet SHA256SUMS ) || { echo "checksum backup tidak cocok" >&2; exit 1; }
PG_CONTAINER=${PG_CONTAINER:-smip-dev-postgres-1}
PGUSER=$(echo "$DATABASE_URL" | sed -E 's#^[a-z]+://([^:@]+).*#\1#')
DOCKER="docker"; docker ps >/dev/null 2>&1 || DOCKER="sg docker -c docker"
t0=$(date +%s)
$DOCKER exec "$PG_CONTAINER" createdb -U "$PGUSER" "$PG_TARGET"
$DOCKER exec -i "$PG_CONTAINER" pg_restore -U "$PGUSER" -d "$PG_TARGET" --no-owner --role="$PGUSER" --exit-on-error < "$DIR/postgres.dump"
t1=$(date +%s)
export PATH="$HOME/.bun/bin:$PATH"
CLICKHOUSE_DB=$CH_TARGET bun scripts/ch-migrate.ts up >/dev/null
CH="$CLICKHOUSE_URL/?database=$CH_TARGET"
for f in "$DIR"/ch-*.native.gz; do
  t=$(basename "$f" .native.gz); t=${t#ch-}
  [ "$t" = smip_schema_migrations ] && continue
  gunzip -c "$f" | curl -sfS "$CH&query=INSERT%20INTO%20$t%20FORMAT%20Native" --user "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --data-binary @-
done
t2=$(date +%s)
# verifikasi: jumlah baris tabel dasar = manifest
fail=0
for t in $(python3 -c "import json,sys;print(' '.join(json.load(open('$DIR/manifest.json'))['clickhouse']))"); do
  [ "$t" = smip_schema_migrations ] && continue
  want=$(python3 -c "import json;print(json.load(open('$DIR/manifest.json'))['clickhouse']['$t'])")
  got=$(curl -sfS "$CH" --user "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --data-binary "SELECT count() FROM $t FORMAT TSV")
  [ "$want" = "$got" ] || { echo "SELISIH $t: backup $want, restore $got"; fail=1; }
done
echo "{\"postgres_restore_sec\":$((t1 - t0)),\"clickhouse_restore_sec\":$((t2 - t1)),\"total_sec\":$((t2 - t0)),\"rows_match\":$([ $fail = 0 ] && echo true || echo false)}"
exit $fail
