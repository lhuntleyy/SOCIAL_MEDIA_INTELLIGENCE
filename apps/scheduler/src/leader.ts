// Leader election scheduler (ARCHITECTURE §5: 2 replika, 1 aktif): `lock:scheduler:leader` SET NX PX + perpanjang
// hanya oleh pemilik (compare-and-extend Lua). Leader yang macet > ttl otomatis digantikan replika lain.
export interface RedisLike {
  send(command: string, args: string[]): Promise<unknown>;
}

const EXTEND = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export class LeaderLock {
  readonly owner = Bun.randomUUIDv7();
  private held = false;
  constructor(
    private readonly redis: RedisLike,
    private readonly opts: { key?: string; ttlMs?: number } = {},
  ) {}
  private get key() {
    return this.opts.key ?? "lock:scheduler:leader";
  }
  private get ttl() {
    return String(this.opts.ttlMs ?? 30_000);
  }
  get isLeader() {
    return this.held;
  }

  /** Dipanggil tiap tick: pemilik memperpanjang, non-pemilik mencoba mengambil. true = boleh bekerja tick ini. */
  async ensure(): Promise<boolean> {
    if (this.held) {
      this.held = Number(await this.redis.send("EVAL", [EXTEND, "1", this.key, this.owner, this.ttl])) === 1;
      if (this.held) return true;
    }
    this.held = (await this.redis.send("SET", [this.key, this.owner, "NX", "PX", this.ttl])) === "OK";
    return this.held;
  }

  async release(): Promise<void> {
    if (this.held) await this.redis.send("EVAL", [RELEASE, "1", this.key, this.owner]);
    this.held = false;
  }
}
