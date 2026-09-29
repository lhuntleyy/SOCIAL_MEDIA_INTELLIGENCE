"""Kredensial akun provider: didekripsi di memori SAAT fetch — tidak di-cache, tidak di-log (cermin worker-fetch-bun/accounts.ts)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from .connector import Credential
from .crypto import Kms, Sealed, credential_aad, open_sealed
from .errors import ConnectorError


@dataclass
class AccountMaterial:
    credential: Credential
    config: dict[str, Any]


AccountLoader = Callable[[str, str], Awaitable[AccountMaterial]]


def db_account_loader(database_url: str, kms: Kms) -> AccountLoader:
    import psycopg

    async def load(account_id: str, connector_id: str) -> AccountMaterial:
        async with await psycopg.AsyncConnection.connect(database_url) as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL ROLE smip_system")
                cur = await conn.execute(
                    """select pa.status, pa.tenant_id::text, c.id::text, c.kind::text, c.ciphertext, c.iv, c.wrapped_dek, c.kek_id,
                              (select config from connectors where id = %s)
                       from provider_accounts pa join credentials c on c.id = pa.credential_id where pa.id = %s""",
                    (connector_id, account_id),
                )
                row = await cur.fetchone()
        if row is None:
            raise ConnectorError("AUTH_INVALID", "akun provider tidak ditemukan", scope="account")
        status, tenant_id, cred_id, kind, ct, iv, wrapped, kek_id, config = row
        if status == "revoked" or wrapped is None:
            raise ConnectorError("AUTH_INVALID", "credential dicabut (crypto-shredded)", scope="account")
        try:
            secret = open_sealed(kms, Sealed(bytes(ct), bytes(iv), bytes(wrapped), kek_id), credential_aad(cred_id, tenant_id))
        except Exception:
            raise ConnectorError("AUTH_INVALID", "credential tidak dapat didekripsi", scope="account") from None
        return AccountMaterial(Credential(kind, secret), config or {})

    return load
