"""S-09/I-16: credential yang disegel @smip/crypto (Bun) dibuka Python; AAD tenant lain & tamper ditolak (SEC-03/04)."""
import base64
import json
import os
import shutil
import subprocess

import pytest

from smip_fetch.crypto import CryptoError, LocalDevKms, Sealed, credential_aad, open_sealed

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUN = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
KEK = base64.b64encode(bytes(range(32))).decode()
SCRIPT = """
import { LocalDevKms, seal, credentialAad } from "@smip/crypto";
const kms = new LocalDevKms({ v1: process.env.KEK });
const s = await seal(kms, credentialAad("0192f000-0000-7000-8000-0000000000aa", "0192f000-0000-7000-8000-000000000001"), { token: "rahasia-bun" });
console.log(JSON.stringify({ ct: Buffer.from(s.ciphertext).toString("base64"), iv: Buffer.from(s.iv).toString("base64"),
  w: Buffer.from(s.wrapped_dek).toString("base64"), kek: s.kek_id }));
"""


@pytest.fixture(scope="module")
def sealed():
    if not os.path.exists(BUN):
        pytest.skip("bun tidak tersedia")
    out = subprocess.run([BUN, "-e", SCRIPT], cwd=ROOT, env={**os.environ, "KEK": KEK}, capture_output=True, text=True, check=True)
    j = json.loads(out.stdout.strip().splitlines()[-1])
    return Sealed(base64.b64decode(j["ct"]), base64.b64decode(j["iv"]), base64.b64decode(j["w"]), j["kek"])


def test_open_bun_sealed(sealed):
    kms = LocalDevKms({"v1": KEK})
    aad = credential_aad("0192f000-0000-7000-8000-0000000000aa", "0192f000-0000-7000-8000-000000000001")
    assert open_sealed(kms, sealed, aad) == {"token": "rahasia-bun"}


def test_wrong_tenant_rejected(sealed):
    kms = LocalDevKms({"v1": KEK})
    with pytest.raises(CryptoError):
        open_sealed(kms, sealed, credential_aad("0192f000-0000-7000-8000-0000000000aa", "0192f000-0000-7000-8000-000000000002"))


def test_tamper_rejected(sealed):
    kms = LocalDevKms({"v1": KEK})
    bad = Sealed(bytes([sealed.ciphertext[0] ^ 1]) + sealed.ciphertext[1:], sealed.iv, sealed.wrapped_dek, sealed.kek_id)
    aad = credential_aad("0192f000-0000-7000-8000-0000000000aa", "0192f000-0000-7000-8000-000000000001")
    with pytest.raises(CryptoError):
        open_sealed(kms, bad, aad)
