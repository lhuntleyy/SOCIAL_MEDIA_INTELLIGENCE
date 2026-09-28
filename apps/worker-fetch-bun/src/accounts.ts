// Kredensial akun provider: didekripsi di memori SAAT fetch (SECURITY §4) — tidak di-cache, tidak di-log.
// AAD dibentuk dari identitas yang diproses (id credential + tenant akun), bukan kolom `aad` di DB (SEC-04).
import type { ConnectorError as CE, DecryptedCredential } from "@smip/connector-sdk";
import { ConnectorError } from "@smip/connector-sdk";
import { credentialAad, type KmsAdapter, open } from "@smip/crypto";
import { type Db, withSystem } from "@smip/db";
import { sql } from "drizzle-orm";

export interface AccountMaterial {
  credential: DecryptedCredential;
  config: Record<string, unknown>;
}
export type AccountLoader = (accountId: string, connectorId: string) => Promise<AccountMaterial>;

export function dbAccountLoader(db: Db, kms: KmsAdapter): AccountLoader {
  return async (accountId, connectorId) => {
    const [row] = (await withSystem(db, (tx) =>
      tx.execute(sql`
        select pa.status, pa.tenant_id, c.id as credential_id, c.kind, c.ciphertext, c.iv, c.wrapped_dek, c.kek_id, c.aad,
               (select config from connectors where id = ${connectorId}) as config
        from provider_accounts pa join credentials c on c.id = pa.credential_id
        where pa.id = ${accountId}`),
    )) as unknown as {
      status: string;
      tenant_id: string | null;
      credential_id: string;
      kind: DecryptedCredential["kind"];
      ciphertext: Uint8Array;
      iv: Uint8Array;
      wrapped_dek: Uint8Array | null;
      kek_id: string;
      aad: string;
      config: Record<string, unknown> | null;
    }[];
    const fail = (code: CE["code"], m: string) => new ConnectorError(code, m, { scope: "account" });
    if (!row) throw fail("AUTH_INVALID", "akun provider tidak ditemukan");
    if (row.status === "revoked" || !row.wrapped_dek) throw fail("AUTH_INVALID", "credential dicabut (crypto-shredded)");
    const secret = await open<Record<string, string>>(
      kms,
      {
        ciphertext: new Uint8Array(row.ciphertext),
        iv: new Uint8Array(row.iv),
        wrapped_dek: new Uint8Array(row.wrapped_dek),
        kek_id: row.kek_id,
        aad: row.aad,
      },
      credentialAad(row.credential_id, row.tenant_id),
    ).catch(() => {
      throw fail("AUTH_INVALID", "credential tidak dapat didekripsi");
    });
    return { credential: { kind: row.kind, secret }, config: row.config ?? {} };
  };
}
