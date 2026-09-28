import { describe, expect, test } from "bun:test";
import { MemoryBlobStore, S3BlobStore } from "../src";

const S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:57070",
  accessKeyId: "smip_dev",
  secretAccessKey: "smip_dev_secret_123",
  bucket: "smip-raw",
};
const s3Up = await fetch(S3.endpoint).then(
  () => true,
  () => false,
);

describe("blob store", () => {
  test("memory: roundtrip JSONL gzip; kunci berbahaya ditolak", async () => {
    const m = new MemoryBlobStore();
    const ref = await m.putJsonl("batches/r1/1.jsonl.gz", [{ a: 1 }, { b: "x\ny" }]);
    expect(await m.getJsonl(ref)).toEqual([{ a: 1 }, { b: "x\ny" }]);
    expect(await m.getJsonl(await m.putJsonl("kosong.jsonl.gz", []))).toEqual([]);
    await expect(m.putJsonl("../etc/passwd", [])).rejects.toThrow("tidak valid");
    await expect(m.putJsonl("/abs", [])).rejects.toThrow("tidak valid");
  });

  test.skipIf(!s3Up)("S3 (versitygw compose): roundtrip + ref bucket lain ditolak", async () => {
    const s = new S3BlobStore(S3);
    const key = `test/${Date.now()}.jsonl.gz`;
    const ref = await s.putJsonl(key, [{ id: 1 }, { id: 2 }]);
    expect(ref).toBe(`s3://smip-raw/${key}`);
    expect(await s.getJsonl<{ id: number }>(ref)).toEqual([{ id: 1 }, { id: 2 }]);
    await expect(s.getJsonl("s3://bucket-lain/x")).rejects.toThrow("bukan milik");
    await s.delete(ref);
  });
});
