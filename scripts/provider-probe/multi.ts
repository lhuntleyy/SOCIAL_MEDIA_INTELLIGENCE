// Uji kontrak kecil lintas platform untuk provider cadangan berbasis Apify (S-10..S-17).
//   set -a; . ~/.config/smip/secrets.env; set +a; bun scripts/provider-probe/multi.ts [actor ...]
// Hanya statistik & nama field yang disimpan (bukan konten/akun individu — UU PDP).
import { mkdir } from "node:fs/promises";
import { accountUsage, type ProbeResult, runActor } from "./apify-run";

const PHRASE = "koperasi merah putih";
const TERMS = ["koperasi", "merah", "putih", "kopdes", "kdmp"];

interface Candidate {
  platform: string;
  actor: string;
  input: Record<string, unknown>;
  max: number;
  memoryMb?: number;
}

export const CANDIDATES: Candidate[] = [
  {
    platform: "x",
    actor: "xquik/x-tweet-scraper",
    input: { searchTerms: [PHRASE], maxItems: 20, queryType: "Latest" },
    max: 0.03,
    memoryMb: 1024,
  },
  // actor penerbit apidojo TIDAK dipakai (keputusan pemilik 2026-09-29: batas run bulanan plan FREE)
  {
    platform: "x",
    actor: "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest",
    input: { twitterContent: PHRASE, maxItems: 20, queryType: "Latest" },
    max: 0.03,
    memoryMb: 1024,
  },
  // actor ini memaksa memori 4 GB → 4 event start ($0,08) sebelum item pertama
  {
    platform: "threads",
    actor: "futurizerush/meta-threads-scraper",
    input: { mode: "search", keywords: [PHRASE], max_posts: 10, search_filter: "recent" },
    max: 0.12,
  },
  {
    platform: "tiktok",
    actor: "clockworks/free-tiktok-scraper",
    input: { searchQueries: [PHRASE], searchSection: "/video", resultsPerPage: 10, videoSearchSorting: "LATEST" },
    max: 0.06,
    memoryMb: 1024,
  },
  {
    platform: "facebook",
    actor: "scrapeforge/facebook-search-posts",
    input: { query: PHRASE, max_results: 10, recent_posts: true },
    max: 0.05,
    memoryMb: 1024,
  },
  {
    platform: "facebook",
    actor: "scraper_one/facebook-posts-search",
    input: { query: PHRASE, resultsCount: 10, searchType: "latest" },
    max: 0.06,
    memoryMb: 1024,
  },
  {
    platform: "youtube",
    actor: "streamers/youtube-scraper",
    input: { searchQueries: [PHRASE], maxResults: 10, maxResultsShorts: 0, maxResultStreams: 0, sortingOrder: "date" },
    max: 0.06,
    memoryMb: 1024,
  },
];

const TEXT = [
  "text",
  "text_content",
  "full_text",
  "fullText",
  "caption",
  "message",
  "post_text",
  "postText",
  "content",
  "title",
  "description",
  "desc",
];
const TIME = [
  "uploadedAt",
  "createdAt",
  "created_at",
  "publishedAt",
  "published_at",
  "timestamp",
  "time",
  "date",
  "createTime",
  "createTimeISO",
  "taken_at",
  "postedAt",
  "creation_time",
  "uploadDate",
  "date_posted",
];
const ID = ["id", "id_str", "postId", "post_id", "shortCode", "code", "pk", "videoId", "aweme_id"];
const LIKES = ["likeCount", "likes", "like_count", "favorite_count", "diggCount", "reactions_count", "reactionsCount", "reaction_count"];
const AUTHOR = ["author", "user", "username", "authorMeta", "channelName", "owner", "ownerUsername", "author_name", "channel"];

const has = (o: Record<string, unknown>, k: string) => o[k] !== undefined && o[k] !== null && o[k] !== "";
const first = (items: Record<string, unknown>[], keys: string[]) => keys.find((k) => items.some((i) => has(i, k))) ?? null;
const textOf = (o: Record<string, unknown>) => {
  for (const k of TEXT) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).text === "string")
      return String((v as Record<string, unknown>).text);
  }
  return "";
};

function analyze(c: Candidate, r: ProbeResult) {
  const items = r.items.filter((i) => !("error" in i) && !("_blockReason" in i));
  const timeField = first(items, TIME);
  const samples = timeField ? items.slice(0, 3).map((i) => String(i[timeField])) : [];
  const relevant = items.filter((i) => TERMS.some((t) => textOf(i).toLowerCase().includes(t))).length;
  const tsValues = timeField
    ? items
        .map((i) =>
          Date.parse(
            typeof i[timeField] === "number"
              ? new Date(Number(i[timeField]) * (Number(i[timeField]) < 1e12 ? 1000 : 1)).toISOString()
              : String(i[timeField]),
          ),
        )
        .filter((x) => !Number.isNaN(x))
    : [];
  return {
    platform: c.platform,
    actor: c.actor,
    status: r.status,
    duration_s: +(r.durationMs / 1000).toFixed(1),
    cost_usd: r.usageTotalUsd,
    charged_events: r.chargedEvents,
    items: items.length,
    errors: r.items.length - items.length,
    error_sample: r.items
      .filter((i) => "error" in i || "_blockReason" in i)
      .slice(0, 1)
      .map((i) => String(i.error ?? i._blockReason).slice(0, 120)),
    relevant_text_items: relevant,
    text_field: first(items, TEXT),
    time_field: timeField,
    time_samples: samples,
    newest: tsValues.length ? new Date(Math.max(...tsValues)).toISOString() : null,
    oldest: tsValues.length ? new Date(Math.min(...tsValues)).toISOString() : null,
    id_field: first(items, ID),
    likes_field: first(items, LIKES),
    author_field: first(items, AUTHOR),
    fields: [...new Set(items.flatMap((i) => Object.keys(i)))].sort(),
  };
}

if (import.meta.main) {
  const only = process.argv.slice(2);
  const dir = `${import.meta.dir}/../../docs/evidence/S-11-S-17`;
  const file = `${dir}/apify-contract.json`;
  const prev = (await Bun.file(file)
    .json()
    .catch(() => ({ results: [] }))) as { results: { actor: string }[] };
  const results: Record<string, unknown>[] = prev.results.filter((r) => only.length && !only.includes(r.actor));
  const before = await accountUsage();
  console.log(`Apify usage sebelum: $${before.monthlyUsageUsd.toFixed(3)} / $${before.maxMonthlyUsageUsd}`);
  for (const c of CANDIDATES.filter((x) => !only.length || only.includes(x.actor))) {
    try {
      const r = await runActor({ actor: c.actor, input: c.input, maxTotalChargeUsd: c.max, timeoutSecs: 300, memoryMb: c.memoryMb });
      const a = analyze(c, r);
      results.push(a);
      const { fields, ...short } = a;
      console.log(JSON.stringify({ ...short, n_fields: fields.length }));
    } catch (e) {
      results.push({ platform: c.platform, actor: c.actor, error: (e as Error).message.slice(0, 300) });
      console.log(c.actor, "ERROR", (e as Error).message.slice(0, 300));
    }
  }
  const after = await accountUsage();
  console.log(
    `Apify usage sesudah: $${after.monthlyUsageUsd.toFixed(3)} (probe ≈ $${(after.monthlyUsageUsd - before.monthlyUsageUsd).toFixed(3)})`,
  );
  await mkdir(dir, { recursive: true });
  await Bun.write(
    file,
    JSON.stringify({ date: new Date().toISOString(), phrase: PHRASE, usage_before: before, usage_after: after, results }, null, 2),
  );
}
