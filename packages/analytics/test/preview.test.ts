// I-03 integrasi: previewCandidates (API /topics/preview) terhadap ClickHouse compose.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { chUp, previewCandidates } from "../src";

const CH_URL = process.env.TEST_CLICKHOUSE_URL ?? "http://smip:smip_dev@127.0.0.1:58123";
const DB = `smip_prev_${Date.now()}`;
const chUpNow = await fetch(`${new URL(CH_URL).origin}/ping`).then(
  (r) => r.ok,
  () => false,
);

const iso = (hAgo: number) => new Date(Date.now() - hAgo * 3_600_000).toISOString().replace("T", " ").replace("Z", "");
const post = (id: string, platform: string, text: string, hAgo: number, hashtags: string[] = [], version = 1) => ({
  platform,
  post_id: id,
  content_type: "post",
  text,
  lang: "id",
  published_at: iso(hAgo),
  author_id: "a",
  author_handle: "a",
  hashtags,
  mentions: [],
  media: "[]",
  matched: 0,
  source_connector: "fake.x",
  raw_ref: "",
  ingested_at: iso(0),
  version,
});

describe.skipIf(!chUpNow)("previewCandidates (ClickHouse)", () => {
  let admin: ClickHouseClient;
  let ch: ClickHouseClient;
  beforeAll(async () => {
    admin = createClient({ url: CH_URL });
    await admin.command({ query: `CREATE DATABASE ${DB}` });
    ch = createClient({ url: CH_URL, database: DB });
    await chUp(ch);
    await ch.insert({
      table: "posts",
      format: "JSONEachRow",
      values: [
        post("1", "x", "Koperasi Merah Putih diresmikan", 2),
        post("1", "x", "Koperasi Merah Putih diresmikan (edit)", 2, [], 2), // versi ganda post sama → dihitung sekali
        post("2", "x", "KOPDES jalan", 30),
        post("3", "x", "tidak relevan", 3),
        post("4", "x", "koperasi merah putih lama", 24 * 9), // di luar 7 hari
        post("5", "instagram", "rapat desa", 5, ["kdmp"]),
        post("6", "tiktok", "kopdes", 5), // platform tidak diminta
      ],
    });
  });
  afterAll(async () => {
    await ch?.close();
    await admin?.command({ query: `DROP DATABASE IF EXISTS ${DB}` });
    await admin?.close();
  });

  test("kandidat 7 hari per platform: teks case-insensitive + hashtag; sampel terbaru dulu, unik per post", async () => {
    const r = await previewCandidates(ch, {
      platforms: ["x", "instagram"],
      needles: ["koperasi merah putih", "kopdes"],
      hashtags: ["kdmp"],
    });
    expect(r.counts).toEqual({ x: 2, instagram: 1 });
    expect(r.sample.map((s) => `${s.platform}:${s.post_id}`)).toEqual(["x:1", "instagram:5", "x:2"]);
    expect(r.sample[1]!.hashtags).toEqual(["kdmp"]);
  });
});
