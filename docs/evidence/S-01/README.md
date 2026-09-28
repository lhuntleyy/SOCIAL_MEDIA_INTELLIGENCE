# S-01 — Pin versi Bun + scaffold compat-check

- `.bun-version` = `1.4.2` (dipasang dari https://bun.sh/install ke `~/.bun`, 2026-09-28)
- `package.json` workspace + script `bun run compat` → `scripts/compat-check.ts` (14 check, S-02..S-09)
- `bunfig.toml`: `registry = "https://registry.npmjs.org/"` — **catatan**: host ini punya `~/.npmrc` mirror (`https://mirrors.tencentyun.com/npm`) yang dibaca Bun tanpa path `/npm` → semua paket 404. Registry proyek di-set eksplisit.
- `tsconfig.json` strict; `tsc -p .` (TypeScript 7.0.2) lulus untuk semua script spike.
- Infra lokal tanpa Docker: `scripts/spike-infra.sh` (Redis ×2, ClickHouse, Postgres 16 embedded, S3 versitygw, Vault dev).
- Output run terakhir: [../compat/run.log](../compat/run.log), laporan: [../compat/results.md](../compat/results.md).
- AC "dipakai CI" menyusul di F-12 (belum ada repo git/CI).
