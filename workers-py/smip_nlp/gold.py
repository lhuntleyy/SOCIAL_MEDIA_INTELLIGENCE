"""Gold set S-20/S-22 (AI_SPEC §6.1): sampel stratified → lembar anotasi → gabung ≥ 2 anotator (kappa, adjudikasi) →
split dev/test beku → evaluasi prediksi model/LLM. Teks SELALU dipseudonimkan; tanpa handle/ID author.

  python -m smip_nlp.gold sample   --n 2000 --out data/gold/sample.jsonl        (ClickHouse via env CLICKHOUSE_*)
  python -m smip_nlp.gold sheet    data/gold/sample.jsonl data/gold/annotator_A.csv
  python -m smip_nlp.gold merge    data/gold/annotator_A.csv data/gold/annotator_B.csv [--adjudicated data/gold/adj.csv] --out data/gold/gold.jsonl
  python -m smip_nlp.gold evaluate data/gold/gold.jsonl preds.jsonl --task sentiment --split test --out docs/evidence/S-20/<model>.json
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .metrics import accuracy, cohen_kappa, confusion, coverage_curve, ece, macro_f1, per_class
from .preprocess import pseudonymize

SENTIMENT = ["negative", "neutral", "positive"]
EMOTION = ["anger", "anticipation", "disgust", "trust", "joy", "sadness", "surprise", "fear", "unknown"]
LABELS = {"sentiment": SENTIMENT, "emotion": EMOTION}
SKIP = "skip"  # anotator boleh menandai item tak layak (spam, bukan bahasa target, kosong)


def split_of(item_id: str, dev_pct: int = 50) -> str:
    """Split deterministik & beku: item yang sama selalu di split yang sama (test tidak pernah dipakai tuning)."""
    return "dev" if int(hashlib.sha1(item_id.encode()).hexdigest()[:8], 16) % 100 < dev_pct else "test"


def _ch_query(sql: str) -> list[dict[str, Any]]:
    import httpx

    url = os.environ["CLICKHOUSE_URL"]
    r = httpx.post(
        url,
        params={"database": os.environ.get("CLICKHOUSE_DB", "default"), "default_format": "JSONEachRow"},
        auth=(os.environ.get("CLICKHOUSE_USER", "default"), os.environ.get("CLICKHOUSE_PASSWORD", "")),
        content=sql,
        timeout=60,
    )
    r.raise_for_status()
    return [json.loads(l) for l in r.text.splitlines() if l]


def sample(n: int, min_per_platform: int = 50) -> list[dict[str, Any]]:
    """Stratified per platform (proporsional, minimal `min_per_platform`), acak deterministik (cityHash64), hanya post match."""
    counts = {r["platform"]: int(r["c"]) for r in _ch_query("SELECT platform, count() AS c FROM posts FINAL WHERE matched = 1 AND length(text) > 0 GROUP BY platform")}
    total = sum(counts.values()) or 1
    out: list[dict[str, Any]] = []
    for pl, c in counts.items():
        k = min(c, max(min_per_platform, round(n * c / total)))
        rows = _ch_query(
            f"SELECT platform, post_id, text, lang FROM posts FINAL WHERE matched = 1 AND length(text) > 0 "
            f"AND platform = '{pl.replace(chr(39), '')}' ORDER BY cityHash64(post_id) LIMIT {int(k)}"
        )
        for r in rows:
            out.append({"id": f"{r['platform']}:{r['post_id']}", "platform": r["platform"], "lang": r["lang"], "text": pseudonymize(r["text"])})
    return out


def write_sheet(items: list[dict[str, Any]], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "platform", "text", "sentiment", "emotion", "note"])
        for it in items:
            w.writerow([it["id"], it["platform"], it["text"], "", "", ""])


def read_sheet(path: Path) -> dict[str, dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as f:
        return {r["id"]: {k: (v or "").strip().lower() for k, v in r.items()} | {"text": r["text"]} for r in csv.DictReader(f)}


def merge(sheets: list[dict[str, dict[str, str]]], adjudicated: dict[str, dict[str, str]] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Gabung anotator: sepakat → label; beda → butuh adjudikasi (atau dibuang dari gold). Laporan kappa per task."""
    adj = adjudicated or {}
    ids = sorted(set.intersection(*(set(s) for s in sheets)))
    report: dict[str, Any] = {"items": len(ids), "annotators": len(sheets), "tasks": {}}
    gold: dict[str, dict[str, Any]] = {i: {"id": i, "platform": sheets[0][i]["platform"], "text": sheets[0][i]["text"], "split": split_of(i)} for i in ids}
    for task, labels in LABELS.items():
        pairs = [(sheets[0][i].get(task, ""), sheets[1][i].get(task, "")) for i in ids]
        valid = [(a, b) for a, b in pairs if a in labels and b in labels]
        disagree = []
        for i in ids:
            vals = [s[i].get(task, "") for s in sheets]
            if all(v in labels for v in vals) and len(set(vals)) == 1:
                gold[i][task] = vals[0]
            elif adj.get(i, {}).get(task) in labels:
                gold[i][task] = adj[i][task]
            elif all(v in labels for v in vals):
                disagree.append(i)
        report["tasks"][task] = {
            "labeled_by_all": len(valid),
            "cohen_kappa": round(cohen_kappa([a for a, _ in valid], [b for _, b in valid]), 4) if valid else None,
            "disagreements_unresolved": len(disagree),
            "distribution": dict(Counter(g[task] for g in gold.values() if task in g)),
        }
        report["tasks"][task]["unresolved_ids"] = disagree[:200]
    items = [g for g in gold.values() if any(t in g for t in LABELS)]
    report["splits"] = dict(Counter(g["split"] for g in items))
    return items, report


def evaluate(gold: list[dict[str, Any]], preds: dict[str, dict[str, Any]], task: str, split: str | None) -> dict[str, Any]:
    labels = LABELS[task]
    rows = [g for g in gold if task in g and (split is None or g["split"] == split)]
    missing = [g["id"] for g in rows if g["id"] not in preds]
    rows = [g for g in rows if g["id"] in preds]
    y = [g[task] for g in rows]
    p = [preds[g["id"]]["label"] for g in rows]
    conf = [float(preds[g["id"]].get("confidence", 1.0)) for g in rows]
    ok = [a == b for a, b in zip(y, p, strict=True)]
    return {
        "task": task,
        "split": split or "all",
        "n": len(rows),
        "missing_predictions": len(missing),
        "macro_f1": round(macro_f1(y, p, labels), 4),
        "accuracy": round(accuracy(y, p), 4),
        "per_class": {k: {"precision": round(v.precision, 4), "recall": round(v.recall, 4), "f1": round(v.f1, 4), "support": v.support} for k, v in per_class(y, p, labels).items()},
        "confusion": {"labels": labels, "matrix": confusion(y, p, labels)},
        "ece": round(ece(conf, ok), 4),
        "coverage_curve": coverage_curve(conf, ok, [0.5, 0.6, 0.7, 0.8, 0.9]),
    }


def _jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="smip_nlp.gold")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--n", type=int, default=2000)
    s.add_argument("--out", type=Path, required=True)
    sh = sub.add_parser("sheet")
    sh.add_argument("sample", type=Path)
    sh.add_argument("out", type=Path)
    m = sub.add_parser("merge")
    m.add_argument("sheets", type=Path, nargs="+")
    m.add_argument("--adjudicated", type=Path)
    m.add_argument("--out", type=Path, required=True)
    e = sub.add_parser("evaluate")
    e.add_argument("gold", type=Path)
    e.add_argument("preds", type=Path)
    e.add_argument("--task", choices=list(LABELS), default="sentiment")
    e.add_argument("--split", choices=["dev", "test"], default="test")
    e.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    if a.cmd == "sample":
        items = sample(a.n)
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text("".join(json.dumps(i, ensure_ascii=False) + "\n" for i in items), encoding="utf-8")
        print(json.dumps({"items": len(items), "by_platform": dict(Counter(i["platform"] for i in items))}))
    elif a.cmd == "sheet":
        write_sheet(_jsonl(a.sample), a.out)
    elif a.cmd == "merge":
        if len(a.sheets) < 2:
            print("gold set wajib ≥ 2 anotator (AI_SPEC §6.1)", file=sys.stderr)
            return 2
        items, report = merge([read_sheet(p) for p in a.sheets], read_sheet(a.adjudicated) if a.adjudicated else None)
        a.out.write_text("".join(json.dumps(i, ensure_ascii=False) + "\n" for i in items), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        preds = {p["id"]: p for p in _jsonl(a.preds)}
        rep = evaluate(_jsonl(a.gold), preds, a.task, a.split)
        txt = json.dumps(rep, ensure_ascii=False, indent=2)
        if a.out:
            a.out.parent.mkdir(parents=True, exist_ok=True)
            a.out.write_text(txt, encoding="utf-8")
        print(txt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
