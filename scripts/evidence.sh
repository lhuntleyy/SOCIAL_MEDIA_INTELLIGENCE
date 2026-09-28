#!/usr/bin/env bash
# Rekam bukti task (kebijakan Fase 0/1 sebelum CI ada, TASK.md): scripts/evidence.sh <TASK-ID> <perintah...>
# Menulis docs/evidence/<TASK-ID>/<nama>.log berisi tanggal, versi tool, perintah, output, exit code.
set -uo pipefail
id="$1"; shift
dir="$(cd "$(dirname "$0")/.." && pwd)/docs/evidence/$id"; mkdir -p "$dir"
name="$(echo "$*" | tr -cs 'a-zA-Z0-9' '-' | sed 's/^-//; s/-$//' | cut -c1-60)"
log="$dir/$name.log"
{
  echo "# $id — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# bun $(bun --version 2>/dev/null) | node $(node --version 2>/dev/null) | $(uname -sm)"
  echo "\$ $*"
  "$@" 2>&1
  code=$?
  echo "# exit $code"
} > "$log"
tail -1 "$log"; echo "→ $log"
grep -q "# exit 0" "$log"
