// F-06: envelope encryption credential (SECURITY §4, DATA_MODEL §4.4). Interop Bun↔Python dibuktikan di S-09.
//   KEK (di KMS, tidak pernah keluar) ──wrap──► DEK acak 256-bit per credential
//   DEK ──AES-256-GCM(iv 96-bit, AAD = "credential:{id}:{tenant}")──► ciphertext (‖ tag 16 byte)
type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

// ---------- KMS adapter ----------
export interface KmsAdapter {
  readonly kind: "local-dev" | "vault-transit";
  /** Bungkus DEK. `context` diikat sebagai AAD (local-dev) / dicatat (vault). */
  wrap(dek: Bytes, context: string): Promise<{ wrapped: Bytes; kekId: string }>;
  unwrap(wrapped: Bytes, kekId: string, context: string): Promise<Bytes>;
  /** Bungkus ulang ke versi KEK terbaru tanpa membuka ciphertext data (RUNBOOK §9). */
  rewrap(wrapped: Bytes, kekId: string, context: string): Promise<{ wrapped: Bytes; kekId: string }>;
}

async function aesKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new CryptoError("kunci AES harus 32 byte");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function gcmEncrypt(key: Bytes, plaintext: Bytes, aad: string): Promise<{ iv: Bytes; ct: Bytes }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 },
    await aesKey(key),
    plaintext,
  );
  return { iv, ct: new Uint8Array(ct) };
}
async function gcmDecrypt(key: Bytes, iv: Bytes, ct: Bytes, aad: string): Promise<Bytes> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 }, await aesKey(key), ct),
    );
  } catch {
    // Jangan bocorkan detail (oracle); cukup "gagal autentikasi".
    throw new CryptoError("dekripsi gagal: autentikasi GCM tidak valid (data/AAD/kunci salah)");
  }
}

/** Adapter dev: KEK dari env (base64 32 byte). DILARANG di produksi (dicek packages/config & createKms). */
export class LocalDevKms implements KmsAdapter {
  readonly kind = "local-dev";
  private readonly keks: Map<string, Bytes>;
  private readonly current: string;
  /** `keks`: versi → base64 KEK. Versi terakhir = aktif. */
  constructor(keks: Record<string, string>) {
    const entries = Object.entries(keks);
    if (!entries.length) throw new CryptoError("minimal satu KEK");
    this.keks = new Map(entries.map(([v, b64]) => [v, new Uint8Array(Buffer.from(b64, "base64"))]));
    this.current = entries[entries.length - 1]![0];
  }
  private kek(kekId: string): Bytes {
    const k = this.keks.get(kekId.replace(/^local:/, ""));
    if (!k) throw new CryptoError(`KEK ${kekId} tidak dikenal`);
    return k;
  }
  async wrap(dek: Bytes, context: string) {
    const { iv, ct } = await gcmEncrypt(this.kek(this.current), dek, `dek:${context}`);
    const wrapped = new Uint8Array(12 + ct.byteLength);
    wrapped.set(iv, 0);
    wrapped.set(ct, 12);
    return { wrapped, kekId: `local:${this.current}` };
  }
  async unwrap(wrapped: Bytes, kekId: string, context: string) {
    return gcmDecrypt(this.kek(kekId), wrapped.slice(0, 12), wrapped.slice(12), `dek:${context}`);
  }
  async rewrap(wrapped: Bytes, kekId: string, context: string) {
    const dek = await this.unwrap(wrapped, kekId, context);
    try {
      return await this.wrap(dek, context);
    } finally {
      dek.fill(0);
    }
  }
}

/** Vault Transit (SECURITY §4). Kunci transit tidak pernah keluar dari Vault. */
export class VaultTransitKms implements KmsAdapter {
  readonly kind = "vault-transit";
  constructor(private readonly opts: { addr: string; token: string; key: string; mount?: string; fetch?: typeof fetch }) {}
  private async call<T>(op: "encrypt" | "decrypt" | "rewrap", body: Record<string, unknown>): Promise<T> {
    const f = this.opts.fetch ?? fetch;
    const url = `${this.opts.addr.replace(/\/$/, "")}/v1/${this.opts.mount ?? "transit"}/${op}/${encodeURIComponent(this.opts.key)}`;
    const res = await f(url, {
      method: "POST",
      headers: { "X-Vault-Token": this.opts.token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new CryptoError(`vault transit ${op} gagal: HTTP ${res.status}`); // tanpa body (bisa memuat detail sensitif)
    return ((await res.json()) as { data: T }).data;
  }
  private kekIdOf(ciphertext: string): string {
    const v = /^vault:v(\d+):/.exec(ciphertext)?.[1];
    if (!v) throw new CryptoError("format ciphertext vault tidak dikenal");
    return `vault:${this.opts.key}:v${v}`;
  }
  async wrap(dek: Bytes, _context: string) {
    const d = await this.call<{ ciphertext: string }>("encrypt", { plaintext: Buffer.from(dek).toString("base64") });
    return { wrapped: enc.encode(d.ciphertext) as Bytes, kekId: this.kekIdOf(d.ciphertext) };
  }
  async unwrap(wrapped: Bytes, _kekId: string, _context: string) {
    const d = await this.call<{ plaintext: string }>("decrypt", { ciphertext: dec.decode(wrapped) });
    return new Uint8Array(Buffer.from(d.plaintext, "base64"));
  }
  async rewrap(wrapped: Bytes, _kekId: string, _context: string) {
    const d = await this.call<{ ciphertext: string }>("rewrap", { ciphertext: dec.decode(wrapped) });
    return { wrapped: enc.encode(d.ciphertext) as Bytes, kekId: this.kekIdOf(d.ciphertext) };
  }
}

export function createKms(cfg: {
  NODE_ENV: string;
  KMS_ADAPTER?: string;
  KMS_KEY_ID?: string;
  VAULT_ADDR?: string;
  VAULT_TOKEN?: string;
  KMS_LOCAL_DEV_KEK_B64?: string;
}): KmsAdapter {
  switch (cfg.KMS_ADAPTER) {
    case "local-dev":
      if (cfg.NODE_ENV === "production") throw new CryptoError("KMS local-dev dilarang di produksi");
      return new LocalDevKms({ v1: cfg.KMS_LOCAL_DEV_KEK_B64 ?? "" });
    case "vault-transit":
      if (!cfg.VAULT_ADDR || !cfg.VAULT_TOKEN || !cfg.KMS_KEY_ID) throw new CryptoError("VAULT_ADDR, VAULT_TOKEN, KMS_KEY_ID wajib");
      return new VaultTransitKms({ addr: cfg.VAULT_ADDR, token: cfg.VAULT_TOKEN, key: cfg.KMS_KEY_ID });
    default:
      throw new CryptoError(`KMS adapter "${cfg.KMS_ADAPTER}" belum diimplementasikan (aws-kms/gcp-kms: saat deploy cloud)`);
  }
}

// ---------- envelope credential ----------
/** Baris `credentials` (DATA_MODEL §4.4) — bytea disimpan apa adanya. */
export interface SealedSecret {
  ciphertext: Bytes;
  iv: Bytes;
  wrapped_dek: Bytes;
  kek_id: string;
  aad: string;
}

export function credentialAad(credentialId: string, tenantId: string | null): string {
  return `credential:${credentialId}:${tenantId ?? "operator"}`;
}

export async function seal(kms: KmsAdapter, aad: string, secret: unknown): Promise<SealedSecret> {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  try {
    const { iv, ct } = await gcmEncrypt(dek, enc.encode(JSON.stringify(secret)), aad);
    const { wrapped, kekId } = await kms.wrap(dek, aad);
    return { ciphertext: ct, iv, wrapped_dek: wrapped, kek_id: kekId, aad };
  } finally {
    dek.fill(0);
  }
}

/**
 * Buka secret. `expectedAad` WAJIB dari identitas yang sedang diproses (id credential + tenant pemanggil),
 * BUKAN dari kolom `aad` di DB — kalau baris tenant lain disalin ke sini, dekripsi gagal (SEC-04).
 */
export async function open<T = unknown>(kms: KmsAdapter, sealed: SealedSecret, expectedAad: string): Promise<T> {
  const dek = await kms.unwrap(sealed.wrapped_dek, sealed.kek_id, expectedAad);
  try {
    return JSON.parse(dec.decode(await gcmDecrypt(dek, sealed.iv, sealed.ciphertext, expectedAad))) as T;
  } finally {
    dek.fill(0);
  }
}

/** Rotasi KEK: hanya `wrapped_dek`/`kek_id` berubah; ciphertext tidak disentuh. */
export async function rewrap(kms: KmsAdapter, sealed: SealedSecret): Promise<SealedSecret> {
  const { wrapped, kekId } = await kms.rewrap(sealed.wrapped_dek, sealed.kek_id, sealed.aad);
  return { ...sealed, wrapped_dek: wrapped, kek_id: kekId };
}

/** Deteksi duplikat credential tanpa dekripsi: HMAC-SHA256(secret kanonik, pepper). */
export async function fingerprint(secret: unknown, pepper: Bytes): Promise<Bytes> {
  const canon = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canon(x)]),
        )
      : v;
  const key = await crypto.subtle.importKey("raw", pepper, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(JSON.stringify(canon(secret)))));
}

/** `display_hint` untuk UI: hanya 4 karakter terakhir. */
export function displayHint(secretValue: string): string {
  return `••••${secretValue.slice(-4)}`;
}
