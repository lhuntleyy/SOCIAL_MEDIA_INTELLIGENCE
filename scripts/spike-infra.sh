#!/usr/bin/env bash
# Infra lokal untuk spike Fase 0 TANPA Docker (host dev tanpa Docker).
# Binary diunduh ke $SPIKE_HOME (default ~/.local/smip-spike), bukan ke repo.
#   scripts/spike-infra.sh start|stop|status
# Port: redis-queue 6390 (noeviction+AOF), redis-cache 6391 (volatile-ttl),
#       ClickHouse HTTP 8123, Postgres 5433, S3 (versitygw) 9100, Vault dev 8200 (token smip-dev).
set -euo pipefail
SPIKE_HOME="${SPIKE_HOME:-$HOME/.local/smip-spike}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# Bun isolated linker menaruh paket transitif di node_modules/.bun/… → cari, jangan hardcode path.
PGBIN="${PGBIN:-$(find "$REPO/node_modules" -path "*@embedded-postgres/linux-x64/native/bin" -not -path "*/.old_modules*" -type d 2>/dev/null | head -1)}"
[ -n "$PGBIN" ] || { echo "binary Postgres tidak ditemukan — jalankan 'bun install' (dev dependency embedded-postgres)"; exit 1; }
RUN="$SPIKE_HOME/run"; mkdir -p "$RUN"

start() {
  mkdir -p "$SPIKE_HOME"/{redis-q,redis-c,ch-data,s3data}
  "$SPIKE_HOME/redis-server" --port 6390 --dir "$SPIKE_HOME/redis-q" --appendonly yes --appendfsync everysec \
    --maxmemory-policy noeviction --daemonize yes --pidfile "$RUN/redis-q.pid" --logfile "$RUN/redis-q.log"
  "$SPIKE_HOME/redis-server" --port 6391 --dir "$SPIKE_HOME/redis-c" --maxmemory 64mb \
    --maxmemory-policy volatile-ttl --daemonize yes --pidfile "$RUN/redis-c.pid" --logfile "$RUN/redis-c.log"

  (cd "$SPIKE_HOME/ch-data" && exec nohup "$SPIKE_HOME/clickhouse" server -- \
      --http_port=8123 --tcp_port=9010 --mysql_port=0 --postgresql_port=0 --interserver_http_port=0 \
      --max_server_memory_usage=900000000 --mark_cache_size=67108864 \
      </dev/null > "$RUN/ch.log" 2>&1) & echo $! > "$RUN/ch.pid"

  if [ ! -f "$SPIKE_HOME/pg/PG_VERSION" ]; then
    "$PGBIN/initdb" -D "$SPIKE_HOME/pg" -U postgres --auth=trust -E UTF8 >/dev/null
  fi
  "$PGBIN/pg_ctl" -D "$SPIKE_HOME/pg" -o "-p 5433 -k $RUN" -l "$RUN/pg.log" start </dev/null >/dev/null 2>&1

  nohup "$SPIKE_HOME/vgw/usr/bin/versitygw" --access smipspike --secret smipspike-secret-123 \
    --port 127.0.0.1:9100 posix "$SPIKE_HOME/s3data" > "$RUN/s3.log" 2>&1 & echo $! > "$RUN/s3.pid"

  if [ -x "$SPIKE_HOME/vault" ]; then   # opsional, dev mode (in-memory) — HANYA untuk spike S-09
    nohup "$SPIKE_HOME/vault" server -dev -dev-root-token-id=smip-dev -dev-listen-address=127.0.0.1:8200 \
      > "$RUN/vault.log" 2>&1 & echo $! > "$RUN/vault.pid"
  fi

  for i in $(seq 1 60); do
    if curl -sf http://127.0.0.1:8123/ping >/dev/null; then break; fi; sleep 1
  done
  status
}

stop() {
  "$SPIKE_HOME/redis-cli" -p 6390 shutdown nosave 2>/dev/null || true
  "$SPIKE_HOME/redis-cli" -p 6391 shutdown nosave 2>/dev/null || true
  "$PGBIN/pg_ctl" -D "$SPIKE_HOME/pg" stop -m fast >/dev/null 2>&1 || true
  for p in ch s3 vault; do [ -f "$RUN/$p.pid" ] && kill "$(cat "$RUN/$p.pid")" 2>/dev/null || true; done
  echo stopped
}

status() {
  printf 'redis-queue  '; "$SPIKE_HOME/redis-cli" -p 6390 ping 2>/dev/null || echo down
  printf 'redis-cache  '; "$SPIKE_HOME/redis-cli" -p 6391 ping 2>/dev/null || echo down
  printf 'clickhouse   '; curl -sf http://127.0.0.1:8123/ping || echo down
  printf 'postgres     '; (exec 3<>/dev/tcp/127.0.0.1/5433) 2>/dev/null && echo ok || echo down
  printf 'vault (dev)  '; curl -sf http://127.0.0.1:8200/v1/sys/health >/dev/null && echo ok || echo "down (opsional)"
  printf 's3           '; c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9100/ || true); [ "$c" = "000" ] && echo down || echo "$c (403 = hidup, butuh auth)"
}

"${1:-status}"
