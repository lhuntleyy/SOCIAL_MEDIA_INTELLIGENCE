// Penyimpanan batch item & payload mentah (QUEUE_SPEC §2: item besar lewat `items_ref`, bukan payload queue).
// Format: JSONL gzip. Referensi: `s3://<bucket>/<key>` (S3) atau `mem://<key>` (test).
// S3 memakai Bun.S3Client bawaan (tanpa dependensi npm; dites terhadap versitygw compose).

export interface BlobStore {
  putJsonl(key: string, rows: unknown[]): Promise<string>;
  getJsonl<T = unknown>(ref: string): Promise<T[]>;
  delete(ref: string): Promise<void>;
}

const encode = (rows: unknown[]) =>
  Bun.gzipSync(new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")));
const decode = <T>(buf: Uint8Array): T[] =>
  new TextDecoder()
    .decode(Bun.gunzipSync(new Uint8Array(buf)))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

/** Kunci aman: tanpa `..`, tanpa awalan `/`, hanya karakter umum. */
function safeKey(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/.test(key) || key.includes("..")) throw new Error(`kunci blob tidak valid: ${key}`);
  return key;
}

export interface S3Options {
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

export class S3BlobStore implements BlobStore {
  private readonly client: Bun.S3Client;
  constructor(private readonly o: S3Options) {
    this.client = new Bun.S3Client({ ...o, region: o.region ?? "us-east-1" });
  }
  private keyOf(ref: string): string {
    const prefix = `s3://${this.o.bucket}/`;
    if (!ref.startsWith(prefix)) throw new Error(`ref bukan milik bucket ${this.o.bucket}`);
    return safeKey(ref.slice(prefix.length));
  }
  async putJsonl(key: string, rows: unknown[]): Promise<string> {
    await this.client.write(safeKey(key), encode(rows), { type: "application/gzip" });
    return `s3://${this.o.bucket}/${key}`;
  }
  async getJsonl<T = unknown>(ref: string): Promise<T[]> {
    return decode<T>(new Uint8Array(await this.client.file(this.keyOf(ref)).arrayBuffer()));
  }
  async delete(ref: string): Promise<void> {
    await this.client.delete(this.keyOf(ref));
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async putJsonl(key: string, rows: unknown[]): Promise<string> {
    this.blobs.set(safeKey(key), encode(rows));
    return `mem://${key}`;
  }
  async getJsonl<T = unknown>(ref: string): Promise<T[]> {
    const b = this.blobs.get(ref.replace(/^mem:\/\//, ""));
    if (!b) throw new Error(`blob tidak ada: ${ref}`);
    return decode<T>(b);
  }
  async delete(ref: string): Promise<void> {
    this.blobs.delete(ref.replace(/^mem:\/\//, ""));
  }
}
