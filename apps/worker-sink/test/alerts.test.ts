import { describe, expect, test } from "bun:test";
import { type AggQuery, checkRule, type RuleRow } from "../src/alerts";

const rule = (type: string, params: Record<string, number> = {}): RuleRow => ({
  id: "r",
  tenant_id: "00000000-0000-7000-8000-000000000001",
  tenant_name: "Kantor A",
  topic_id: "00000000-0000-7000-8000-000000000002",
  topic_name: "BPIP",
  type,
  params,
  channels: [],
});
const now = new Date("2026-10-04T05:00:00Z");
const stub = (rows: unknown[]): AggQuery & { calls: Record<string, unknown>[] } => {
  const calls: Record<string, unknown>[] = [];
  const f = (async (_q: string, p: Record<string, unknown>) => {
    calls.push(p);
    return rows;
  }) as AggQuery & { calls: Record<string, unknown>[] };
  f.calls = calls;
  return f;
};

describe("evaluator alert (O-05)", () => {
  test("negative_ratio: di atas ambang & cukup post → terpicu; di bawah min_posts → tidak", async () => {
    const f = await checkRule(stub([{ n: "100", neg: "62" }]), rule("negative_ratio", { threshold_pct: 60 }), now);
    expect(f).toMatchObject({ title: "Sentimen negatif 62% (3 jam terakhir)", metrics: { posts: 100, negative: 62 } });
    expect(await checkRule(stub([{ n: "10", neg: "9" }]), rule("negative_ratio"), now)).toBeNull();
    expect(await checkRule(stub([{ n: "100", neg: "40" }]), rule("negative_ratio"), now)).toBeNull();
  });
  test("volume_spike: dibanding rata-rata window yang sama 7 hari", async () => {
    // 1 jam: histori 7 hari 1.680 post → rata-rata 10/jam; sekarang 45 → 4,5×
    const q = stub([{ cur: "45", hist: "1680" }]);
    const f = await checkRule(q, rule("volume_spike"), now);
    expect(f).toMatchObject({ title: "Lonjakan percakapan 4.5× (1 jam terakhir)", metrics: { baseline: 10 } });
    expect(q.calls[0]).toMatchObject({ from: "2026-10-04 04:00:00.000", hf: "2026-09-27 04:00:00.000" });
    expect(await checkRule(stub([{ cur: "25", hist: "1680" }]), rule("volume_spike"), now)).toBeNull(); // < min_posts 30
    expect(await checkRule(stub([{ cur: "35", hist: "2016" }]), rule("volume_spike"), now)).toBeNull(); // rata-rata 12 → butuh ≥ 36
  });
  test("new_issue: isu baru (tanpa riwayat 7 hari) → judul isu teratas", async () => {
    const f = await checkRule(stub([{ issue: "pemotongan tukin", n: "14" }]), rule("new_issue"), now);
    expect(f?.title).toBe("Isu baru muncul: pemotongan tukin");
    expect(await checkRule(stub([]), rule("new_issue"), now)).toBeNull();
    expect(await checkRule(stub([]), rule("unknown"), now)).toBeNull();
  });
});
