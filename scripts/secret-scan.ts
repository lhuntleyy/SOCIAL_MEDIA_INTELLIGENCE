// H-03 pemindai secret (tanpa dependency): file yang dilacak git (bawaan) atau seluruh riwayat (`--history`). Keluar 1 bila ada
// temuan. Dipakai CI (`bun run check`) untuk file sekarang. Nilai yang cocok TIDAK dicetak utuh (hanya 6 karakter awal).
const PATTERNS: [string, RegExp][] = [
  ["Apify token", /apify_api_[A-Za-z0-9]{20,}/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ["Private key", /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ["URL berkredensial", /\bhttps?:\/\/[^\s/:@"']+:[^\s/@"']{12,}@(?!127\.0\.0\.1|localhost|postgres|redis|clickhouse)[^\s"']+/],
];
// contoh/fixture sengaja palsu
const ALLOW = [/LocalDevKms|PRIVATE KEY-----"\s*\+|contoh|example|fake|dummy|xxxx|\*\*\*/i];
// nilai palsu yang sengaja dipakai tes redaksi (sha256 dari nilai, bukan nilainya)
const ALLOW_HASHES = new Set(["92586ac1dd437d62b4c1d41dde0a425ddd216b496e8b5779c3f12da11ec01a38"]);
const sha = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex");
const history = process.argv.includes("--history");
const run = (cmd: string[]) => new Response(Bun.spawn(cmd, { stdout: "pipe" }).stdout).text();
const findings: string[] = [];
const scan = (where: string, text: string) => {
  text.split("\n").forEach((line, i) => {
    if (line.length > 5000) return;
    for (const [name, re] of PATTERNS) {
      const m = re.exec(line);
      if (!m || ALLOW.some((a) => a.test(line)) || ALLOW_HASHES.has(sha(m[0]))) continue;
      findings.push(`${where}:${i + 1}  ${name}  ${m[0].slice(0, 6)}…`);
    }
  });
};
if (history) {
  scan("riwayat-git", await run(["git", "log", "-p", "--all", "--no-color", "-U0"]));
} else {
  for (const f of (await run(["git", "ls-files"])).split("\n").filter(Boolean)) {
    if (/\.(png|jpe?g|gif|webp|pdf|gz|lockb|ico|woff2?)$/i.test(f)) continue;
    const file = Bun.file(f);
    if (!(await file.exists()) || file.size > 2_000_000) continue;
    scan(f, await file.text());
  }
}
if (findings.length) {
  console.error(`secret-scan: ${findings.length} temuan\n${findings.join("\n")}`);
  process.exit(1);
}
console.log(`secret-scan: bersih (${history ? "seluruh riwayat git" : "file dilacak"})`);
