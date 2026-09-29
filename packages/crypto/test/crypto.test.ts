import { describe, expect, test } from "bun:test";
import { CryptoError, createKms, credentialAad, displayHint, fingerprint, LocalDevKms, open, rewrap, seal, VaultTransitKms } from "../src";

const b64 = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const SECRET = { token: "apify_api_AbCdEf1234567890", note: "ünïcödé ✓" };
const A = credentialAad("0192-cred-1", "0192-tenant-a");
const B = credentialAad("0192-cred-1", "0192-tenant-b");

describe("envelope (local-dev KMS)", () => {
  const kms = new LocalDevKms({ v1: b64() });

  test("seal → open roundtrip; DEK unik per seal", async () => {
    const s1 = await seal(kms, A, SECRET);
    const s2 = await seal(kms, A, SECRET);
    expect(await open<typeof SECRET>(kms, s1, A)).toEqual(SECRET);
    expect(Buffer.from(s1.wrapped_dek).equals(Buffer.from(s2.wrapped_dek))).toBe(false);
    expect(Buffer.from(s1.ciphertext).toString()).not.toContain("apify_api");
    expect(s1.iv.byteLength).toBe(12);
  });

  test("SEC-03: ciphertext diubah 1 byte → gagal", async () => {
    const s = await seal(kms, A, SECRET);
    s.ciphertext[0]! ^= 1;
    await expect(open(kms, s, A)).rejects.toBeInstanceOf(CryptoError);
  });

  test("SEC-03: wrapped_dek diubah → gagal", async () => {
    const s = await seal(kms, A, SECRET);
    s.wrapped_dek[20]! ^= 1;
    await expect(open(kms, s, A)).rejects.toBeInstanceOf(CryptoError);
  });

  test("SEC-04: baris credential dibuka dengan AAD tenant lain → gagal", async () => {
    const s = await seal(kms, A, SECRET);
    await expect(open(kms, s, B)).rejects.toBeInstanceOf(CryptoError);
  });

  test("rotasi KEK: rewrap mengganti wrapped_dek & kek_id, ciphertext tetap, tetap terbuka", async () => {
    const k1 = b64();
    const k2 = b64();
    const old = new LocalDevKms({ v1: k1 });
    const s = await seal(old, A, SECRET);
    const rotated = new LocalDevKms({ v1: k1, v2: k2 });
    const r = await rewrap(rotated, s);
    expect(r.kek_id).toBe("local:v2");
    expect(Buffer.from(r.ciphertext).equals(Buffer.from(s.ciphertext))).toBe(true);
    expect(await open<typeof SECRET>(rotated, r, A)).toEqual(SECRET);
    // KEK lama dicabut → baris yang belum di-rewrap tidak bisa dibuka; yang sudah di-rewrap tetap bisa
    const v2only = new LocalDevKms({ v2: k2 });
    await expect(open(v2only, s, A)).rejects.toBeInstanceOf(CryptoError);
    expect(await open<typeof SECRET>(v2only, r, A)).toEqual(SECRET);
  });

  test("createKms: local-dev ditolak di produksi; adapter tak dikenal ditolak", () => {
    expect(() => createKms({ NODE_ENV: "production", KMS_ADAPTER: "local-dev", KMS_LOCAL_DEV_KEK_B64: b64() })).toThrow(/produksi/);
    expect(() => createKms({ NODE_ENV: "development", KMS_ADAPTER: "aws-kms" })).toThrow(/belum diimplementasikan/);
  });

  test("fingerprint deterministik & tidak tergantung urutan key; display hint", async () => {
    const pepper = crypto.getRandomValues(new Uint8Array(32));
    const f1 = await fingerprint({ a: 1, token: "x" }, pepper);
    const f2 = await fingerprint({ token: "x", a: 1 }, pepper);
    expect(Buffer.from(f1).equals(Buffer.from(f2))).toBe(true);
    expect(displayHint("tapi_live_9f2c")).toBe("••••9f2c");
  });
});

// Integrasi Vault: jalan bila Vault dev hidup (scripts/spike-infra.sh start → 127.0.0.1:8200, token smip-dev).
// default: Vault compose; override VAULT_ADDR (spike: http://127.0.0.1:8200)
const VAULT = process.env.VAULT_ADDR ?? "http://127.0.0.1:58200";
const vaultUp = await fetch(`${VAULT}/v1/sys/health`).then(
  (r) => r.ok,
  () => false,
);

describe.skipIf(!vaultUp)("envelope (vault-transit, integrasi)", () => {
  const token = process.env.VAULT_TOKEN ?? "smip-dev";
  const key = `smip-test-${Date.now()}`;
  const h = { "X-Vault-Token": token, "content-type": "application/json" };

  test("seal/open, tamper, rotasi kunci transit + rewrap", async () => {
    await fetch(`${VAULT}/v1/sys/mounts/transit`, { method: "POST", headers: h, body: JSON.stringify({ type: "transit" }) });
    await fetch(`${VAULT}/v1/transit/keys/${key}`, { method: "POST", headers: h, body: "{}" });
    const kms = new VaultTransitKms({ addr: VAULT, token, key });
    const s = await seal(kms, A, SECRET);
    expect(s.kek_id).toBe(`vault:${key}:v1`);
    expect(await open<typeof SECRET>(kms, s, A)).toEqual(SECRET);
    await expect(open(kms, s, B)).rejects.toBeInstanceOf(CryptoError); // AAD data tetap mengikat tenant
    await fetch(`${VAULT}/v1/transit/keys/${key}/rotate`, { method: "POST", headers: h });
    const r = await rewrap(kms, s);
    expect(r.kek_id).toBe(`vault:${key}:v2`);
    expect(await open<typeof SECRET>(kms, r, A)).toEqual(SECRET);
    const bad = { ...s, wrapped_dek: new TextEncoder().encode("vault:v1:AAAA") as Uint8Array<ArrayBuffer> };
    await expect(open(kms, bad, A)).rejects.toBeInstanceOf(CryptoError);
  });
});
