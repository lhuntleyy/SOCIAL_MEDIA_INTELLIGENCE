// Rate limit login per IP + lockout bertahap per akun (SECURITY §2). Disimpan di Redis-cache.
// Kunci akun memakai hash email — tidak ada email mentah (PII) di key Redis.
export const LOGIN_POLICY = {
  ipMaxPerWindow: 50,
  ipWindowSec: 900,
  accountFreeFailures: 5, // setelah 5 gagal: kunci 60 s, lalu berlipat ganda
  lockBaseSec: 60,
  lockMaxSec: 3600,
  failureTtlSec: 86_400,
};

async function sha(s: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.toLowerCase())))
    .toString("hex")
    .slice(0, 32);
}

export class LoginLimiter {
  constructor(private readonly redis: Bun.RedisClient) {}

  /** Kembalikan detik tunggu bila diblok, 0 bila boleh mencoba. */
  async check(ip: string, email: string): Promise<number> {
    const ipKey = `auth:ip:${ip}`;
    const n = await this.redis.incr(ipKey);
    if (n === 1) await this.redis.expire(ipKey, LOGIN_POLICY.ipWindowSec);
    if (n > LOGIN_POLICY.ipMaxPerWindow) return Math.max(1, await this.redis.ttl(ipKey));
    const lockTtl = await this.redis.ttl(`auth:lock:${await sha(email)}`);
    return lockTtl > 0 ? lockTtl : 0;
  }

  async failure(email: string): Promise<void> {
    const h = await sha(email);
    const fails = await this.redis.incr(`auth:fail:${h}`);
    await this.redis.expire(`auth:fail:${h}`, LOGIN_POLICY.failureTtlSec);
    if (fails >= LOGIN_POLICY.accountFreeFailures) {
      const lock = Math.min(LOGIN_POLICY.lockMaxSec, LOGIN_POLICY.lockBaseSec * 2 ** (fails - LOGIN_POLICY.accountFreeFailures));
      await this.redis.send("SET", [`auth:lock:${h}`, "1", "EX", String(lock)]);
    }
  }

  async success(email: string): Promise<void> {
    const h = await sha(email);
    await this.redis.del(`auth:fail:${h}`);
    await this.redis.del(`auth:lock:${h}`);
  }
}
