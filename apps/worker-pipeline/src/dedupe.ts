// Dedupe Redis-cache (DATA_MODEL §7): `seen:{platform}:{post_id}` (konten) & `seenm:{tenant}:{topic}:{platform}:{post_id}`
// (match per topik), TTL 14 hari. SET NX dengan PEMILIK (= run.attempt): pesan yang di-retry setelah crash menganggap
// kunci miliknya sendiri sebagai baru → match tidak hilang. Guard kedua ada di ClickHouse (sink, P-09).
export interface RedisLike {
  send(command: string, args: string[]): Promise<unknown>;
}

const CLAIM = `
local out = {}
for i, k in ipairs(KEYS) do
  local v = redis.call('GET', k)
  if not v then
    redis.call('SET', k, ARGV[1], 'EX', ARGV[2])
    out[i] = 1
  elseif v == ARGV[1] then
    out[i] = 1
  else
    out[i] = 0
  end
end
return out
`;
export const DEDUPE_TTL_SEC = 14 * 86_400;

export class Deduper {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = "",
  ) {}

  /** true = baru (atau milik pemilik yang sama); false = sudah diklaim pemilik lain. */
  async claim(keys: string[], owner: string): Promise<boolean[]> {
    if (!keys.length) return [];
    const out: boolean[] = [];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500).map((k) => this.prefix + k);
      const r = (await this.redis.send("EVAL", [CLAIM, String(chunk.length), ...chunk, owner, String(DEDUPE_TTL_SEC)])) as number[];
      out.push(...r.map((x) => Number(x) === 1));
    }
    return out;
  }
}

export const seenKey = (platform: string, postId: string) => `seen:${platform}:${postId}`;
export const seenMatchKey = (tenant: string, topic: string, platform: string, postId: string) =>
  `seenm:${tenant}:${topic}:${platform}:${postId}`;
