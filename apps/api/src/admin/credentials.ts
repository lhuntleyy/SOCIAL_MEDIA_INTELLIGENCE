// Penyegelan credential bersama (Admin API provider I-21 & pengaturan LLM): envelope encryption + fingerprint HMAC
// untuk deteksi duplikat per pemilik (tanpa oracle lintas tenant). Secret tidak pernah dikembalikan/di-log (SEC-02).
import { credentialAad, displayHint, fingerprint, type KmsAdapter, open, seal } from "@smip/crypto";
import type { Tx } from "@smip/db";
import { sql } from "drizzle-orm";
import { ApiError } from "../errors";

export interface SealDeps {
  kms: KmsAdapter;
  fingerprintPepper: Uint8Array<ArrayBuffer>;
}

export async function sealCredential(d: SealDeps, tx: Tx, tenantId: string | null, kind: string, secret: Record<string, string>) {
  const id = Bun.randomUUIDv7();
  const s = await seal(d.kms, credentialAad(id, tenantId), secret);
  const fp = await fingerprint(secret, d.fingerprintPepper);
  const [dup] = (await tx.execute(
    sql`select 1 from credentials where fingerprint = ${Buffer.from(fp)} and wrapped_dek is not null
      and tenant_id is not distinct from ${tenantId} limit 1`,
  )) as unknown as unknown[];
  if (dup) throw new ApiError("CONFLICT", "Credential yang sama sudah terdaftar");
  await tx.execute(sql`insert into credentials (id, tenant_id, kind, ciphertext, iv, wrapped_dek, kek_id, aad, fingerprint, created_by)
    values (${id}, ${tenantId}, ${kind}::e_cred_kind, ${Buffer.from(s.ciphertext)}, ${Buffer.from(s.iv)}, ${Buffer.from(s.wrapped_dek)},
            ${s.kek_id}, ${s.aad}, ${Buffer.from(fp)}, null)`);
  const first = Object.values(secret)[0] ?? "";
  return { id, hint: first.length >= 8 ? displayHint(first) : "••••" };
}

/** Buka credential (di memori, sesaat) — AAD dari identitas yang diproses, bukan kolom `aad` (SEC-04). */
export async function openCredential(d: Pick<SealDeps, "kms">, tx: Tx, credentialId: string): Promise<Record<string, string>> {
  const [c] = (await tx.execute(
    sql`select id, tenant_id, ciphertext, iv, wrapped_dek, kek_id, aad from credentials where id = ${credentialId}`,
  )) as unknown as {
    id: string;
    tenant_id: string | null;
    ciphertext: Uint8Array;
    iv: Uint8Array;
    wrapped_dek: Uint8Array | null;
    kek_id: string;
    aad: string;
  }[];
  if (!c?.wrapped_dek) throw new ApiError("CONFLICT", "Credential sudah dicabut");
  return open<Record<string, string>>(
    d.kms,
    {
      ciphertext: new Uint8Array(c.ciphertext),
      iv: new Uint8Array(c.iv),
      wrapped_dek: new Uint8Array(c.wrapped_dek),
      kek_id: c.kek_id,
      aad: c.aad,
    },
    credentialAad(c.id, c.tenant_id),
  );
}
