"""Kredensial akun provider: didekripsi di memori SAAT fetch — tidak di-cache, tidak di-log (cermin worker-fetch-bun/accounts.ts)."""
from __future__ import annotations

import asyncio

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
            # unwrap Vault transit = HTTP sinkron → jalankan di thread agar event loop worker tidak terblok (review 2026-09-30)
            secret = await asyncio.to_thread(
                open_sealed, kms, Sealed(bytes(ct), bytes(iv), bytes(wrapped), kek_id), credential_aad(cred_id, tenant_id)
            )
        except Exception:
            raise ConnectorError("AUTH_INVALID", "credential tidak dapat didekripsi", scope="account") from None
        return AccountMaterial(Credential(kind, secret), config or {})

    return load


ProbeTargets = Callable[[str], Awaitable[tuple[str, list[str]] | None]]
AuditWriter = Callable[[str, str, dict[str, Any]], Awaitable[None]]


def db_probe_targets(database_url: str) -> ProbeTargets:
    """(connector key, ≤ 5 akun aktif yang boleh memakai connector) — sama dgn ops.ts worker Bun."""
    import psycopg

    async def load(connector_id: str) -> tuple[str, list[str]] | None:
        async with await psycopg.AsyncConnection.connect(database_url) as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL ROLE smip_system")
                cur = await conn.execute("select key, provider_id from connectors where id = %s", (connector_id,))
                c = await cur.fetchone()
                if c is None:
                    return None
                cur = await conn.execute(
                    """select id::text from provider_accounts where provider_id = %s and status = 'active'
                         and (allowed_connector_ids is null or %s::uuid = any(allowed_connector_ids))
                       order by tenant_id nulls first, created_at limit 5""",
                    (c[1], connector_id),
                )
                return c[0], [r[0] for r in await cur.fetchall()]

    return load


def db_audit(database_url: str) -> AuditWriter:
    import json
    import uuid

    import psycopg

    async def write(action: str, target_id: str, after: dict[str, Any]) -> None:
        async with await psycopg.AsyncConnection.connect(database_url) as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL ROLE smip_system")
                await conn.execute(
                    """insert into audit_logs (id, tenant_id, actor_type, actor_id, action, target_type, target_id, after)
                       values (%s, null, 'system', null, %s, 'connector', %s, %s::jsonb)""",
                    (str(uuid.uuid4()), action, target_id, json.dumps(after)),
                )

    return write
