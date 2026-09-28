"""S-09: interop AES-256-GCM (format Web Crypto: ciphertext||tag 16 byte) + envelope DEK/KEK.

stdin JSON, stdout JSON. Semua bytes base64.
  decrypt  {key, iv, ct, aad}                  -> {plaintext}
  encrypt  {key, plaintext, aad}               -> {iv, ct}
  unwrap_and_decrypt {kek, wrapped_dek, dek_iv, iv, ct, aad} -> {plaintext}
"""
import base64
import json
import os
import sys

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

b64d = base64.b64decode


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode()


def main() -> None:
    mode = sys.argv[1]
    req = json.load(sys.stdin)
    try:
        if mode == "decrypt":
            pt = AESGCM(b64d(req["key"])).decrypt(b64d(req["iv"]), b64d(req["ct"]), req["aad"].encode())
            out = {"plaintext": pt.decode()}
        elif mode == "encrypt":
            iv = os.urandom(12)
            ct = AESGCM(b64d(req["key"])).encrypt(iv, req["plaintext"].encode(), req["aad"].encode())
            out = {"iv": b64e(iv), "ct": b64e(ct)}
        elif mode == "unwrap_and_decrypt":
            # local-dev KMS adapter: DEK dibungkus KEK dengan AES-GCM, AAD = "dek:" + aad
            dek = AESGCM(b64d(req["kek"])).decrypt(b64d(req["dek_iv"]), b64d(req["wrapped_dek"]), ("dek:" + req["aad"]).encode())
            pt = AESGCM(dek).decrypt(b64d(req["iv"]), b64d(req["ct"]), req["aad"].encode())
            out = {"plaintext": pt.decode()}
        else:
            raise SystemExit(f"mode tidak dikenal: {mode}")
    except InvalidTag:
        out = {"error": "InvalidTag"}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
