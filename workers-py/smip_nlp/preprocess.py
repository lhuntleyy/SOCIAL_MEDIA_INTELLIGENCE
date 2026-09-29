"""Preprocessing deterministik AI_SPEC §2 (di-unit-test). Dipakai inferensi, LLM, DAN korpus training (teks dipseudonimkan)."""
from __future__ import annotations

import re
import unicodedata

ZERO_WIDTH = re.compile("[​‌‍⁠﻿]")
URL = re.compile(r"https?://\S+|www\.\S+", re.I)
MENTION = re.compile(r"(?<![\w@])@[A-Za-z0-9_.]{1,30}")
LONG_NUM = re.compile(r"\b\d{5,}\b|\b(?!(?:19|20)\d{2}\b)\d{4}\b")  # tahun 19xx/20xx dipertahankan
HASHTAG = re.compile(r"#([\w]+)", re.UNICODE)
CAMEL = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)")
SPACES = re.compile(r"\s+")


def split_hashtag(tag: str) -> str:
    return CAMEL.sub(" ", tag).replace("_", " ").lower()


def pseudonymize(text: str) -> str:
    """URL → <url>, mention → <user>, angka panjang → <num> (bukan tahun). Minimisasi data SEBELUM teks keluar dari sistem."""
    t = unicodedata.normalize("NFKC", text)
    t = ZERO_WIDTH.sub("", t)
    t = URL.sub("<url>", t)
    t = MENTION.sub("<user>", t)
    t = LONG_NUM.sub("<num>", t)
    return SPACES.sub(" ", t).strip()


def preprocess(text: str, lexicon: dict[str, str] | None = None) -> tuple[str, list[str]]:
    """Kembalikan (teks siap model, hashtag asli). Emoji dipertahankan; tidak lowercase (tokenizer bisa case-sensitive)."""
    t = pseudonymize(text)
    tags = HASHTAG.findall(t)
    t = HASHTAG.sub(lambda m: split_hashtag(m.group(1)), t)
    if lexicon:
        t = " ".join(lexicon.get(w.lower(), w) for w in t.split(" "))
    return SPACES.sub(" ", t).strip(), tags


def is_short(text: str) -> bool:
    """< 3 token bermakna → `neutral` + flag short_text (AI_SPEC §2.7)."""
    toks = [w for w in text.split() if w not in ("<url>", "<user>", "<num>")]
    return len(toks) < 3
