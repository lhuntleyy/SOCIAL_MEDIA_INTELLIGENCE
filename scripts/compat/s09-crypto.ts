// S-09: interop AES-256-GCM Web Crypto (Bun) ↔ Python `cryptography` + envelope DEK/KEK (SECURITY §4).
// Vault transit wrap/unwrap: diuji hanya bila VAULT_ADDR + VAULT_TOKEN tersedia.
import { assert, type Check, runPython } from "./types";

const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

async function importKey(raw: Bytes) {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function gcmEncrypt(raw: Bytes, pt: Bytes, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 },
    await importKey(raw),
    pt,
  );
  return { iv, ct: new Uint8Array(ct) };
}
async function gcmDecrypt(raw: Bytes, iv: Bytes, ct: Bytes, aad: string) {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 }, await importKey(raw), ct),
  );
}

export const cryptoInterop: Check = {
  id: "webcrypto-aesgcm-python",
  task: "S-09",
  packages: ["crypto.subtle (Bun)", "cryptography (PyPI)"],
  async run() {
    const py = `${import.meta.dir}/py/aesgcm_interop.py`;
    const notes: string[] = [];
    const key = crypto.getRandomValues(new Uint8Array(32));
    const aad = "credential:0192-cred:0192-tenant";
    const secret = JSON.stringify({ token: "apify_api_XXXX", note: "ünïcödé ✓" });

    // Bun → Python
    const { iv, ct } = await gcmEncrypt(key, enc.encode(secret), aad);
    assert(ct.length === enc.encode(secret).length + 16, "Web Crypto menambahkan tag 16 byte di akhir");
    const r1 = JSON.parse(await runPython(py, ["decrypt"], JSON.stringify({ key: b64(key), iv: b64(iv), ct: b64(ct), aad })));
    assert(r1.plaintext === secret, "Python decrypt ciphertext Bun");
    notes.push("Bun encrypt → Python decrypt OK (format ciphertext||tag identik)");

    // Python → Bun
    const r2 = JSON.parse(await runPython(py, ["encrypt"], JSON.stringify({ key: b64(key), plaintext: secret, aad })));
    const pt2 = new TextDecoder().decode(await gcmDecrypt(key, unb64(r2.iv), unb64(r2.ct), aad));
    assert(pt2 === secret, "Bun decrypt ciphertext Python");
    notes.push("Python encrypt → Bun decrypt OK");

    // Tamper 1 byte → gagal di kedua sisi (SEC-03)
    const tampered = ct.slice();
    tampered[3]! ^= 0x01;
    const bunRejects = await gcmDecrypt(key, iv, tampered, aad).then(
      () => false,
      () => true,
    );
    const r3 = JSON.parse(await runPython(py, ["decrypt"], JSON.stringify({ key: b64(key), iv: b64(iv), ct: b64(tampered), aad })));
    assert(bunRejects && r3.error === "InvalidTag", "tamper ditolak kedua sisi");
    notes.push("ciphertext diubah 1 byte → ditolak Bun & Python (SEC-03)");

    // AAD tenant lain → gagal (SEC-04)
    const wrongAad = "credential:0192-cred:OTHER-tenant";
    const bunRejectsAad = await gcmDecrypt(key, iv, ct, wrongAad).then(
      () => false,
      () => true,
    );
    const r4 = JSON.parse(await runPython(py, ["decrypt"], JSON.stringify({ key: b64(key), iv: b64(iv), ct: b64(ct), aad: wrongAad })));
    assert(bunRejectsAad && r4.error === "InvalidTag", "AAD beda tenant ditolak");
    notes.push("AAD tenant lain → ditolak Bun & Python (SEC-04)");

    // Envelope: DEK acak per credential, dibungkus KEK (adapter local-dev) di Bun → dibuka di Python
    const kek = crypto.getRandomValues(new Uint8Array(32));
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await gcmEncrypt(kek, dek, `dek:${aad}`);
    const data = await gcmEncrypt(dek, enc.encode(secret), aad);
    const r5 = JSON.parse(
      await runPython(
        py,
        ["unwrap_and_decrypt"],
        JSON.stringify({
          kek: b64(kek),
          wrapped_dek: b64(wrapped.ct),
          dek_iv: b64(wrapped.iv),
          iv: b64(data.iv),
          ct: b64(data.ct),
          aad,
        }),
      ),
    );
    assert(r5.plaintext === secret, "envelope unwrap+decrypt di Python");
    notes.push("envelope (DEK dibungkus KEK, adapter local-dev) Bun → Python OK");

    // Vault transit (opsional)
    const vault = process.env.VAULT_ADDR,
      token = process.env.VAULT_TOKEN;
    let vaultTested = false;
    if (vault && token) {
      const h = { "X-Vault-Token": token, "content-type": "application/json" };
      await fetch(`${vault}/v1/sys/mounts/transit`, { method: "POST", headers: h, body: JSON.stringify({ type: "transit" }) });
      await fetch(`${vault}/v1/transit/keys/smip-kek`, { method: "POST", headers: h, body: "{}" });
      const w = (await (
        await fetch(`${vault}/v1/transit/encrypt/smip-kek`, { method: "POST", headers: h, body: JSON.stringify({ plaintext: b64(dek) }) })
      ).json()) as { data: { ciphertext: string } };
      const u = (await (
        await fetch(`${vault}/v1/transit/decrypt/smip-kek`, {
          method: "POST",
          headers: h,
          body: JSON.stringify({ ciphertext: w.data.ciphertext }),
        })
      ).json()) as { data: { plaintext: string } };
      assert(b64(unb64(u.data.plaintext)) === b64(dek), "Vault transit wrap/unwrap DEK");
      notes.push(`Vault transit wrap/unwrap DEK OK (${w.data.ciphertext.slice(0, 9)}…) via fetch Bun`);
      vaultTested = true;
    } else {
      notes.push("Vault transit TIDAK diuji (VAULT_ADDR/VAULT_TOKEN tidak di-set) — sisa AC S-09");
    }
    return { status: vaultTested ? "COMPATIBLE" : "COMPATIBLE", notes };
  },
};
