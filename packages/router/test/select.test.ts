// I-07 unit + simulasi: R-01..R-05, R-13, R-15 (TESTING.md) atas snapshot buatan tangan.
import { describe, expect, test } from "bun:test";
import { type HealthState, type Policy, type Reserver, type SelectDeps, type Snapshot, select } from "../src";
import { account, connector, input, rule, snapshot, T_A, T_B } from "./fixtures";

const okReserver: Reserver = { tryReserve: async ({ account: a }) => ({ ok: true, reservationId: `res-${a.id}` }) };
const deps = (o: Partial<SelectDeps> & { healthOf?: Record<string, HealthState> } = {}): SelectDeps => ({
  health: { get: (cid, aid) => o.healthOf?.[`${cid}/${aid}`] ?? o.healthOf?.[cid] ?? { circuit: "closed", score: null } },
  reserver: okReserver,
  ...o,
});
const picked = async (s: Snapshot, i = input(), d = deps()) => {
  const { decision } = await select(s, i, d);
  return decision.kind === "selected" ? decision.connectorKey : decision.reason;
};

describe("I-07 selector", () => {
  test("R-01 priority 1 sehat selalu dipilih (1.000 percobaan)", async () => {
    const s = snapshot([connector("a"), connector("b")], [rule("a", 1, 1), rule("b", 2, 1000)]);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(await picked(s));
    expect([...seen]).toEqual(["a"]);
  });

  test("R-02 dua rule weight 70/30 dalam satu grup, 10.000 simulasi → ±3%", async () => {
    const s = snapshot([connector("a"), connector("b")], [rule("a", 1, 70), rule("b", 1, 30)]);
    let a = 0;
    for (let i = 0; i < 10_000; i++) if ((await picked(s)) === "a") a++;
    expect(Math.abs(a / 10_000 - 0.7)).toBeLessThanOrEqual(0.03);
  });

  test("R-03 rule/connector/provider/account disabled → tidak pernah dipilih (4 sub-case)", async () => {
    const base = () => [connector("a"), connector("b")];
    const rules = () => [rule("a", 1, 100), rule("b", 2, 100)];
    const cases: [string, Snapshot][] = [
      ["rule", snapshot(base(), [rule("a", 1, 100, { enabled: false }), rule("b", 2, 100)])],
      ["connector", snapshot([connector("a", { enabled: false }), connector("b")], rules())],
      ["provider", snapshot([connector("a", { providerEnabled: false }), connector("b")], rules())],
      ["account", snapshot(base(), rules(), { accounts: [account("a", { status: "disabled" }), account("b")] })],
    ];
    for (const [name, s] of cases) {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(await picked(s));
      expect({ name, seen: [...seen] }).toEqual({ name, seen: ["b"] });
    }
    const { trace } = await select(cases[0]![1], input(), deps());
    expect(trace[0]!.eliminatedBy).toBe("RULE_DISABLED");
  });

  test("R-04 capability declared & allow_unverified=false → CAPABILITY_NOT_VERIFIED; allow_unverified=true → boleh", async () => {
    const conns = [connector("a", { status: "declared" })];
    const { decision, trace } = await select(snapshot(conns, [rule("a", 1, 100)]), input(), deps());
    expect(decision).toEqual({ kind: "none_available", reason: "NO_CANDIDATE", retryAfterMs: 0 });
    expect(trace[0]!.eliminatedBy).toBe("CAPABILITY_NOT_VERIFIED");
    expect(await picked(snapshot(conns, [rule("a", 1, 100)], { allowUnverified: true }))).toBe("a");
    expect(
      (await select(snapshot([connector("a", { status: "failed" })], [rule("a", 1, 100)], { allowUnverified: true }), input(), deps()))
        .trace[0]!.eliminatedBy,
    ).toBe("CAPABILITY_FAILED");
  });

  test("R-05 interval < min_interval_sec → dieliminasi; fitur tak didukung → dieliminasi", async () => {
    const s = snapshot([connector("a", { minInterval: 600 }), connector("b")], [rule("a", 1, 100), rule("b", 2, 100)]);
    expect(await picked(s, input({ intervalSec: 300 }))).toBe("b");
    expect(await picked(s, input({ intervalSec: 900 }))).toBe("a");
    expect((await select(s, input({ intervalSec: 300 }), deps())).trace[0]!.eliminatedBy).toBe("INTERVAL_TOO_SHORT");
    const noTerm = connector("c");
    noTerm.capabilities.get("search_keyword")!.queryFeatures = ["lang_filter"];
    const r = await select(snapshot([noTerm], [rule("c", 1, 100)]), input({ requiredFeatures: ["phrase"] }), deps());
    expect(r.trace[0]!.eliminatedBy).toBe("FEATURES_UNSUPPORTED");
  });

  test("R-13 akun BYO tenant B tidak pernah dipakai untuk tenant A; R-15 stream lintas tenant hanya shared pool", async () => {
    const accounts = [account("a", { tenantId: T_B }), account("a", { tenantId: T_A }), account("a")];
    const s = snapshot([connector("a")], [rule("a", 1, 100)], { accounts });
    const used = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { decision } = await select(s, input(), deps());
      if (decision.kind === "selected") used.add(decision.accountId);
    }
    expect([...used].sort()).toEqual(["a-a", "a-a-a"]); // shared + BYO milik A
    const shared = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { decision } = await select(s, input({ sharedPoolOnly: true }), deps());
      if (decision.kind === "selected") shared.add(decision.accountId);
    }
    expect([...shared]).toEqual(["a-a"]);
    // hanya BYO tenant B tersedia → tenant A tidak dapat rute
    const onlyB = snapshot([connector("a")], [rule("a", 1, 100)], { accounts: [account("a", { tenantId: T_B })] });
    expect(await picked(onlyB)).toBe("NO_CANDIDATE");
  });

  test("weight 0 = standby: hanya dipakai bila semua rule berbobot di grup gagal reservasi", async () => {
    const s = snapshot([connector("a"), connector("b")], [rule("a", 1, 100), rule("b", 1, 0)]);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(await picked(s));
    expect([...seen]).toEqual(["a"]);
    const throttleA: Reserver = {
      tryReserve: async ({ connector: c, account: a }) =>
        c.key === "a" ? { ok: false, reason: "THROTTLED", retryAfterMs: 5000 } : { ok: true, reservationId: `res-${a.id}` },
    };
    expect(await picked(s, input(), deps({ reserver: throttleA }))).toBe("b");
  });

  test("reservasi gagal → fallback ke grup prioritas berikutnya; semua gagal → ALL_THROTTLED / QUOTA_EXHAUSTED + retryAfter minimum", async () => {
    const s = snapshot([connector("a"), connector("b")], [rule("a", 1, 100), rule("b", 2, 100)]);
    const reserver = (fail: Record<string, ["THROTTLED" | "QUOTA", number]>): Reserver => ({
      tryReserve: async ({ connector: c, account: a }) => {
        const f = fail[c.key];
        return f ? { ok: false, reason: f[0], retryAfterMs: f[1] } : { ok: true, reservationId: `res-${a.id}` };
      },
    });
    expect(await picked(s, input(), deps({ reserver: reserver({ a: ["QUOTA", 0] }) }))).toBe("b");
    expect((await select(s, input(), deps({ reserver: reserver({ a: ["THROTTLED", 9000], b: ["THROTTLED", 4000] }) }))).decision).toEqual({
      kind: "none_available",
      reason: "ALL_THROTTLED",
      retryAfterMs: 4000,
    });
    expect((await select(s, input(), deps({ reserver: reserver({ a: ["QUOTA", 0], b: ["QUOTA", 0] }) }))).decision).toMatchObject({
      reason: "QUOTA_EXHAUSTED",
    });
  });

  test("circuit open semua → ALL_UNHEALTHY; half_open hanya 1 probe; skor rendah menurunkan bobot", async () => {
    const s = snapshot([connector("a"), connector("b")], [rule("a", 1, 50), rule("b", 1, 50)]);
    expect(
      await picked(s, input(), deps({ healthOf: { "c-a": { circuit: "open", score: 0 }, "c-b": { circuit: "open", score: 0 } } })),
    ).toBe("ALL_UNHEALTHY");
    expect(await picked(s, input(), deps({ healthOf: { "c-a": { circuit: "half_open", score: 50, probeInflight: true } } }))).toBe("b");
    let a = 0;
    const d = deps({ healthOf: { "c-a": { circuit: "closed", score: 30 } } }); // faktor 0.1 → ~50:5
    for (let i = 0; i < 5000; i++) if ((await picked(s, input(), d)) === "a") a++;
    expect(a / 5000).toBeGreaterThan(0.05);
    expect(a / 5000).toBeLessThan(0.14);
  });

  test("policy tenant menang atas global; tanpa policy → NO_POLICY; policy disabled → POLICY_DISABLED", async () => {
    const tenantPolicy: Policy = {
      id: "pol-a",
      tenantId: T_A,
      platform: "x",
      operation: "search_keyword",
      strategy: "priority_weighted",
      failoverEnabled: true,
      maxAttempts: 3,
      allowUnverified: false,
      enabled: true,
      version: 1,
      rules: [rule("b", 1, 100)],
    };
    const s = snapshot([connector("a"), connector("b")], [rule("a", 1, 100)], { extra: [tenantPolicy] });
    expect(await picked(s)).toBe("b");
    expect(await picked(s, input({ tenantId: T_B }))).toBe("a");
    expect(await picked(s, input({ operation: "profile" }))).toBe("NO_POLICY");
    expect(await picked(snapshot([connector("a")], [rule("a", 1, 100)], { enabled: false }))).toBe("POLICY_DISABLED");
  });

  test("excludeConnectorIds (failover), run_kind, max_share_pct", async () => {
    const s = snapshot(
      [connector("a"), connector("b")],
      [rule("a", 1, 100, { runKinds: ["backfill"] }), rule("b", 2, 100, { maxSharePct: 20 })],
    );
    expect(await picked(s, input({ runKind: "backfill" }))).toBe("a");
    expect(await picked(s, input({ runKind: "incremental" }))).toBe("b");
    expect(await picked(s, input({ runKind: "backfill", excludeConnectorIds: ["c-a"] }))).toBe("b");
    expect(await picked(s, input({ runKind: "incremental" }), deps({ share: { sharePct: () => 25 } }))).toBe("NO_CANDIDATE");
  });

  test("strategi cost_aware memilih termurah; round_robin bergiliran", async () => {
    const conns = [connector("a", { cost: 5 }), connector("b", { cost: 0.5 })];
    expect(await picked(snapshot(conns, [rule("a", 1, 100), rule("b", 1, 1)], { strategy: "cost_aware" }))).toBe("b");
    let n = 0;
    const rr = deps({ nextCounter: async () => n++ });
    const s = snapshot([connector("a"), connector("b")], [rule("a", 1, 1), rule("b", 1, 1)], { strategy: "round_robin" });
    const seq: string[] = [];
    for (let i = 0; i < 4; i++) seq.push(await picked(s, input(), rr));
    expect(seq).toEqual(["a", "b", "a", "b"]);
  });
});
