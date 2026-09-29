// I-22 unit: dedup planner (pure) — ADR-009 + amandemen (kelas interval, BYO privat).
import { describe, expect, test } from "bun:test";
import { type PlanMember, planStreamGroups } from "../src";

let n = 0;
const m = (tenant: string, terms: string[] | null, intervalSec = 900, o: Partial<PlanMember> = {}): PlanMember => ({
  planId: `p${++n}`,
  tenantId: tenant,
  topicQueryId: `q${n}`,
  platform: "x",
  operation: "search_keyword",
  intervalSec,
  highWatermark: null,
  terms,
  byo: false,
  ...o,
});
const shape = (ss: ReturnType<typeof planStreamGroups>) =>
  ss.map((s) => ({
    cls: s.intervalClass,
    vis: s.visibilityTenantId,
    terms: s.terms,
    members: s.members.map((x) => x.topicQueryId).sort(),
  }));

describe("planStreamGroups", () => {
  test("ARCHITECTURE §12: topik beririsan lintas tenant → satu stream shared; topik tanpa irisan tetap plan", () => {
    n = 0;
    const out = planStreamGroups([m("t1", ["banjir", "bencana"]), m("t2", ["bencana", "gempa"]), m("t1", ["pemilu"])]);
    expect(shape(out)).toEqual([{ cls: 900, vis: null, terms: ["banjir", "bencana", "gempa"], members: ["q1", "q2"] }]);
  });

  test("kelas interval: topik 1 jam yang term-nya tercakup stream 5 m MENUMPANG (tidak fetch sendiri); yang tidak → stream kelasnya", () => {
    n = 0;
    const out = planStreamGroups([
      m("t1", ["banjir", "bencana"], 300),
      m("t2", ["bencana", "gempa"], 300),
      m("t3", ["gempa"], 3600), // ⊆ stream 5m → menumpang
      m("t4", ["longsor", "gempa"], 3600), // tidak ⊆ → grup 1 jam
      m("t5", ["longsor"], 3600),
    ]);
    expect(shape(out)).toEqual([
      { cls: 300, vis: null, terms: ["banjir", "bencana", "gempa"], members: ["q1", "q2", "q3"] },
      { cls: 3600, vis: null, terms: ["gempa", "longsor"], members: ["q4", "q5"] },
    ]);
  });

  test("R-15: tenant BYO tidak digabung lintas tenant — stream privat hanya berisi query tenant itu", () => {
    n = 0;
    const out = planStreamGroups([
      m("t1", ["banjir"], 900),
      m("t2", ["banjir"], 900, { byo: true }),
      m("t2", ["banjir", "rob"], 900, { byo: true }),
      m("t3", ["banjir", "jakarta"], 900),
    ]);
    expect(shape(out)).toEqual([
      { cls: 900, vis: null, terms: ["banjir", "jakarta"], members: ["q1", "q4"] },
      { cls: 900, vis: "t2", terms: ["banjir", "rob"], members: ["q2", "q3"] },
    ]);
  });

  test("platform/operation berbeda tidak digabung; query tanpa set penutup (murni NOT) tetap plan; kunci stabil", () => {
    n = 0;
    const a = [m("t1", ["banjir"]), m("t2", ["banjir"], 900, { platform: "tiktok" }), m("t3", null), m("t4", ["banjir"])];
    const out = planStreamGroups(a);
    expect(shape(out)).toEqual([{ cls: 900, vis: null, terms: ["banjir"], members: ["q1", "q4"] }]);
    expect(planStreamGroups(a)[0]!.key).toBe(out[0]!.key);
  });
});
