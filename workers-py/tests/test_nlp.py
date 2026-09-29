"""S-20 tooling: preprocessing AI_SPEC §2, metrik §6.2, gold set (kappa, adjudikasi, split beku, evaluasi)."""
import csv

import pytest

from smip_nlp.gold import evaluate, merge, read_sheet, split_of
from smip_nlp.metrics import cohen_kappa, coverage_curve, ece, macro_f1
from smip_nlp.preprocess import is_short, preprocess, pseudonymize


def test_pseudonymize_and_preprocess():
    t = "Cek​ https://t.co/abc @budi_01 no 0812345678 tahun 2026 #DemoDPR mantap 😡"
    assert pseudonymize(t) == "Cek <url> <user> no <num> tahun 2026 #DemoDPR mantap 😡"
    out, tags = preprocess(t, {"gk": "tidak"})
    assert out == "Cek <url> <user> no <num> tahun 2026 demo dpr mantap 😡" and tags == ["DemoDPR"]
    assert preprocess("gk suka", {"gk": "tidak"})[0] == "tidak suka"
    assert "email@x.com" in pseudonymize("email@x.com")  # bukan mention
    assert is_short("<user> ok") and not is_short("ini sangat buruk sekali")


def test_metrics_known_values():
    gold = ["negative", "negative", "neutral", "positive", "positive", "positive"]
    pred = ["negative", "neutral", "neutral", "positive", "positive", "negative"]
    # per kelas F1: neg 0.5, neu 0.6667, pos 0.8 → macro 0.6556
    assert macro_f1(gold, pred, ["negative", "neutral", "positive"]) == pytest.approx(0.65556, abs=1e-4)
    assert cohen_kappa(["a", "a", "b", "b"], ["a", "a", "b", "b"]) == 1.0
    assert cohen_kappa(["a", "b", "a", "b"], ["b", "a", "b", "a"]) == pytest.approx(-1.0)
    assert ece([1.0, 1.0], [True, True]) == 0.0
    assert ece([0.9, 0.9], [False, False]) == pytest.approx(0.9)
    c = coverage_curve([0.95, 0.4], [True, False], [0.5])[0]
    assert c == {"tau": 0.5, "coverage": 0.5, "accuracy": 1.0, "to_llm_pct": 0.5}


def _sheet(path, rows):
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "platform", "text", "sentiment", "emotion", "note"])
        w.writerows(rows)
    return read_sheet(path)


def test_merge_kappa_adjudication_and_frozen_split(tmp_path):
    a = _sheet(tmp_path / "a.csv", [["x:1", "x", "t1", "negative", "anger", ""], ["x:2", "x", "t2", "positive", "joy", ""], ["x:3", "x", "t3", "neutral", "unknown", ""]])
    b = _sheet(tmp_path / "b.csv", [["x:1", "x", "t1", "Negative", "anger", ""], ["x:2", "x", "t2", "neutral", "joy", ""], ["x:3", "x", "t3", "skip", "", ""]])
    adj = _sheet(tmp_path / "adj.csv", [["x:2", "x", "t2", "positive", "", ""]])
    items, rep = merge([a, b])
    by = {i["id"]: i for i in items}
    assert by["x:1"]["sentiment"] == "negative" and "sentiment" not in by["x:2"]  # beda tanpa adjudikasi → keluar gold
    assert rep["tasks"]["sentiment"]["disagreements_unresolved"] == 1 and rep["tasks"]["sentiment"]["labeled_by_all"] == 2
    items2, _ = merge([a, b], adj)
    assert {i["id"]: i for i in items2}["x:2"]["sentiment"] == "positive"
    assert split_of("x:1") == split_of("x:1") and {split_of(f"x:{i}") for i in range(200)} == {"dev", "test"}


def test_evaluate_report():
    gold = [{"id": f"x:{i}", "sentiment": s, "split": "test"} for i, s in enumerate(["negative", "neutral", "positive", "positive"])]
    preds = {"x:0": {"label": "negative", "confidence": 0.9}, "x:1": {"label": "positive", "confidence": 0.55}, "x:2": {"label": "positive", "confidence": 0.8}}
    r = evaluate(gold, preds, "sentiment", "test")
    assert r["n"] == 3 and r["missing_predictions"] == 1 and r["accuracy"] == pytest.approx(0.6667, abs=1e-4)
    assert r["confusion"]["matrix"][1][2] == 1  # neutral diprediksi positive
