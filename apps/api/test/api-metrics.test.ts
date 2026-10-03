// O-07: metrik HTTP API memakai POLA route (bukan path berisi id) → kardinalitas rendah.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Registry } from "@smip/observability";
import { TopicService } from "../src/topics/service";
import { type ApiHarness, apiHarness, infraUp, tid } from "./helpers";

const up = await infraUp();

describe.skipIf(!up)("O-07 metrik HTTP", () => {
  let h: ApiHarness;
  const reg = new Registry();
  let token = "";
  beforeAll(async () => {
    h = await apiHarness("metrics", undefined, (db) => ({ metrics: reg, topics: new TopicService(db) }));
    await h.sql`insert into tenants (id, slug, name) values (${tid(1)}, 'a', 'A')`;
    token = await h.token({ sub: tid(11), tid: tid(1), role: "viewer" });
  });
  afterAll(async () => h?.close());

  test("route = pola terdaftar, status & durasi tercatat; tanpa id di label", async () => {
    await h.call("GET", "/topics", { token });
    await h.call("GET", `/topics/${tid(77)}`, { token });
    await h.call("GET", `/topics/${tid(78)}`, { token });
    await h.call("GET", "/tidak-ada", { token });
    const out = reg.render();
    expect(out).toContain('smip_http_requests_total{route="/v1/topics",method="GET",status="200"} 1');
    expect(out).toContain('smip_http_requests_total{route="/v1/topics/:id",method="GET",status="404"} 2');
    expect(out).not.toContain(tid(77));
    expect(out).toMatch(/smip_http_request_duration_seconds_count\{route="\/v1\/topics\/:id"\} 2/);
  });
});
