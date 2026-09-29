"""Metrik evaluasi AI_SPEC §6.2 — tanpa dependensi (dipakai CI `pytest -m eval` & laporan S-20/S-22)."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass


@dataclass
class ClassReport:
    precision: float
    recall: float
    f1: float
    support: int


def confusion(gold: list[str], pred: list[str], labels: list[str]) -> list[list[int]]:
    idx = {l: i for i, l in enumerate(labels)}
    m = [[0] * len(labels) for _ in labels]
    for g, p in zip(gold, pred, strict=True):
        m[idx[g]][idx[p]] += 1
    return m


def per_class(gold: list[str], pred: list[str], labels: list[str]) -> dict[str, ClassReport]:
    out = {}
    for l in labels:
        tp = sum(1 for g, p in zip(gold, pred, strict=True) if g == l and p == l)
        fp = sum(1 for g, p in zip(gold, pred, strict=True) if g != l and p == l)
        fn = sum(1 for g, p in zip(gold, pred, strict=True) if g == l and p != l)
        pr = tp / (tp + fp) if tp + fp else 0.0
        rc = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * pr * rc / (pr + rc) if pr + rc else 0.0
        out[l] = ClassReport(pr, rc, f1, tp + fn)
    return out


def macro_f1(gold: list[str], pred: list[str], labels: list[str]) -> float:
    rep = per_class(gold, pred, labels)
    present = [l for l in labels if rep[l].support > 0]
    return sum(rep[l].f1 for l in present) / len(present) if present else 0.0


def accuracy(gold: list[str], pred: list[str]) -> float:
    return sum(1 for g, p in zip(gold, pred, strict=True) if g == p) / len(gold) if gold else 0.0


def cohen_kappa(a: list[str], b: list[str]) -> float:
    """Kesepakatan 2 anotator (AI_SPEC §6.1)."""
    n = len(a)
    if n == 0:
        return 0.0
    po = sum(1 for x, y in zip(a, b, strict=True) if x == y) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def ece(confidences: list[float], correct: list[bool], bins: int = 10) -> float:
    """Expected calibration error (kalibrasi skor, AI_SPEC §4.4)."""
    n = len(confidences)
    if n == 0:
        return 0.0
    total = 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        idx = [i for i, c in enumerate(confidences) if (lo < c <= hi) or (b == 0 and c == 0)]
        if not idx:
            continue
        acc = sum(correct[i] for i in idx) / len(idx)
        conf = sum(confidences[i] for i in idx) / len(idx)
        total += len(idx) / n * abs(acc - conf)
    return total


def coverage_curve(confidences: list[float], correct: list[bool], thresholds: list[float]) -> list[dict[str, float]]:
    """Akurasi vs coverage per τ — dasar memilih τ fallback LLM sesuai budget (AI_SPEC §4.4)."""
    rows = []
    for t in thresholds:
        keep = [i for i, c in enumerate(confidences) if c >= t]
        rows.append(
            {
                "tau": t,
                "coverage": len(keep) / len(confidences) if confidences else 0.0,
                "accuracy": sum(correct[i] for i in keep) / len(keep) if keep else 0.0,
                "to_llm_pct": 1 - (len(keep) / len(confidences) if confidences else 0.0),
            }
        )
    return rows
