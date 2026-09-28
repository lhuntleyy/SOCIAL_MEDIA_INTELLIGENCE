// TOTP RFC 6238 (HMAC-SHA1, 6 digit, periode 30 s) di atas Web Crypto — tanpa dependency tambahan (Golden Rule 8).
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("base32 tidak valid");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Verifikasi kode dengan toleransi ±`window` langkah (jam tidak sinkron). Perbandingan waktu-konstan. */
export async function verifyTotp(secretB32: string, code: string, nowMs = Date.now(), window = 1): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretB32);
  const step = Math.floor(nowMs / 1000 / 30);
  let ok = false;
  for (let w = -window; w <= window; w++) {
    const expected = await hotp(secret, step + w);
    let diff = 0;
    for (let i = 0; i < 6; i++) diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
    ok = ok || diff === 0;
  }
  return ok;
}

export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function otpauthUri(secretB32: string, account: string, issuer = "SMIP"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
