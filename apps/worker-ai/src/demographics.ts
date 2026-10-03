// A-08/A-09: cache demografi per akun (ClickHouse `author_demographics`, global lintas tenant) + inferensi LLM untuk akun baru.
import type { ClickHouseClient } from "@clickhouse/client";
import type { DemoAuthor } from "@smip/llm";

export type DemoGender = "male" | "female" | "unknown";
export type DemoAge = "18_21" | "22_30" | "31_45" | "46_55" | "above_55" | "unknown";
export interface AuthorDemo {
  gender: DemoGender;
  gender_conf: number;
  age_range: DemoAge;
  age_conf: number;
}
export interface DemoRow extends AuthorDemo {
  platform: string;
  author_id: string;
  method: string;
  model_version: string;
}
export interface DemographicsStore {
  /** key = `${platform}|${author_id}` */
  get(keys: { platform: string; authorId: string }[]): Promise<Map<string, AuthorDemo>>;
  put(rows: DemoRow[], now: Date): Promise<void>;
}
export const demoKey = (platform: string, authorId: string) => `${platform}|${authorId}`;

const chTs = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "").slice(0, 23);

export function chDemographicsStore(ch: ClickHouseClient): DemographicsStore {
  return {
    async get(keys) {
      const out = new Map<string, AuthorDemo>();
      if (!keys.length) return out;
      const rows = await ch
        .query({
          query: `SELECT platform, author_id, toString(gender) AS gender, gender_conf, toString(age_range) AS age_range, age_conf
                  FROM author_demographics FINAL WHERE (platform, author_id) IN {k:Array(Tuple(String, String))}`,
          query_params: { k: keys.map((k) => [k.platform, k.authorId]) },
          format: "JSONEachRow",
        })
        .then((r) => r.json<AuthorDemo & { platform: string; author_id: string }>());
      for (const r of rows)
        out.set(demoKey(r.platform, r.author_id), {
          gender: r.gender,
          gender_conf: Number(r.gender_conf),
          age_range: r.age_range,
          age_conf: Number(r.age_conf),
        });
      return out;
    },
    async put(rows, now) {
      if (!rows.length) return;
      await ch.insert({
        table: "author_demographics",
        format: "JSONEachRow",
        values: rows.map((r) => ({ ...r, updated_at: chTs(now), version: now.getTime() })),
      });
    },
  };
}

export type { DemoAuthor };
