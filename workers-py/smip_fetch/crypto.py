"""Envelope encryption credential (SECURITY §4) — cermin packages/crypto/src/index.ts; interop dibuktikan S-09.

  DEK ──AES-256-GCM(iv 96-bit, AAD = "credential:{id}:{tenant|operator}")──► ciphertext‖tag
  KEK (KMS) membungkus DEK: local-dev = AES-GCM iv‖ct dgn AAD "dek:{aad}"; vault-transit = "vault:vN:…".
"""
from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class CryptoError(Exception):
    pass


def credential_aad(credential_id: str, tenant_id: str | None) -> str:
    return f"credential:{credential_id}:{tenant_id or 'operator'}"


def _gcm_decrypt(key: bytes, iv: bytes, ct: bytes, aad: str) -> bytes:
    if len(key) != 32:
        raise CryptoError("kunci AES harus 32 byte")
    try:
        return AESGCM(key).decrypt(iv, ct, aad.encode())
    except Exception:  # jangan bocorkan detail (oracle)
        raise CryptoError("dekripsi gagal: autentikasi GCM tidak valid (data/AAD/kunci salah)") from None


class Kms(Protocol):
    kind: str

    def unwrap(self, wrapped: bytes, kek_id: str, context: str) -> bytes: ...


class LocalDevKms:
    """KEK dari env (base64 32 byte). DILARANG di produksi."""

    kind = "local-dev"

    def __init__(self, keks: dict[str, str]) -> None:
        if not keks:
            raise CryptoError("minimal satu KEK")
        self._keks = {v: base64.b64decode(b) for v, b in keks.items()}

    def unwrap(self, wrapped: bytes, kek_id: str, context: str) -> bytes:
        kek = self._keks.get(kek_id.removeprefix("local:"))
        if kek is None:
            raise CryptoError(f"KEK {kek_id} tidak dikenal")
        return _gcm_decrypt(kek, wrapped[:12], wrapped[12:], f"dek:{context}")


class VaultTransitKms:
    kind = "vault-transit"

    def __init__(self, addr: str, token: str, key: str, mount: str = "transit") -> None:
        self._url = f"{addr.rstrip('/')}/v1/{mount}/decrypt/{key}"
        self._token = token

    def unwrap(self, wrapped: bytes, kek_id: str, context: str) -> bytes:
        r = httpx.post(self._url, headers={"X-Vault-Token": self._token}, json={"ciphertext": wrapped.decode()}, timeout=10)
        if r.status_code != 200:
            raise CryptoError(f"vault transit decrypt gagal: HTTP {r.status_code}")  # tanpa body
        return base64.b64decode(r.json()["data"]["plaintext"])


def create_kms(env: dict[str, str] | None = None) -> Kms:
    e = env if env is not None else dict(os.environ)
    adapter = e.get("KMS_ADAPTER")
    if adapter == "local-dev":
        if e.get("NODE_ENV") == "production":
            raise CryptoError("KMS local-dev dilarang di produksi")
        return LocalDevKms({"v1": e.get("KMS_LOCAL_DEV_KEK_B64", "")})
    if adapter == "vault-transit":
        if not (e.get("VAULT_ADDR") and e.get("VAULT_TOKEN") and e.get("KMS_KEY_ID")):
            raise CryptoError("VAULT_ADDR, VAULT_TOKEN, KMS_KEY_ID wajib")
        return VaultTransitKms(e["VAULT_ADDR"], e["VAULT_TOKEN"], e["KMS_KEY_ID"])
    raise CryptoError(f'KMS adapter "{adapter}" belum diimplementasikan')


@dataclass
class Sealed:
    ciphertext: bytes
    iv: bytes
    wrapped_dek: bytes
    kek_id: str


def open_sealed(kms: Kms, s: Sealed, expected_aad: str) -> Any:
    """`expected_aad` WAJIB dari identitas yang diproses (bukan kolom `aad` DB) — baris tenant lain gagal dibuka (SEC-04)."""
    dek = bytearray(kms.unwrap(s.wrapped_dek, s.kek_id, expected_aad))
    try:
        return json.loads(_gcm_decrypt(bytes(dek), s.iv, s.ciphertext, expected_aad))
    finally:
        for i in range(len(dek)):
            dek[i] = 0
