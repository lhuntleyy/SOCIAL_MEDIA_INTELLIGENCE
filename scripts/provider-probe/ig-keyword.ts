// S-11 uji kontrak: apakah actor IG "keyword search" benar-benar menemukan post dari CAPTION (bukan hanya hashtag)?
//   set -a; . ~/.config/smip/secrets.env; set +a; bun scripts/provider-probe/ig-keyword.ts
// Hasil → docs/evidence/S-11/ig-keyword-contract.json (+ .md). Item mentah TIDAK disimpan (data pribadi, UU PDP) —
// hanya statistik, nama field, dan contoh yang dipseudonimkan.
import { mkdir } from "node:fs/promises";
import { accountUsage, type ProbeResult, runActor } from "./apify-run";

const PHRASE = "koperasi merah putih";
const TERMS = PHRASE.split(" ");
const JOINED = TERMS.join("");

const CANDIDATES: { actor: string; input: Record<string, unknown>; max: number; memoryMb?: number }[] = [
  { actor: "crawlerbros/instagram-keyword-search-scraper", input: { keywords: [PHRASE], maxPosts: 10 }, max: 0.15, memoryMb: 1024 },
  {
    actor: "scraping_solutions/instagram-boolean-search-scraper-posts-reels",
    input: {
      searchQuery: `"${PHRASE}"`,
      resultsLimit: 10,
      contentType: "posts_and_reels",
      hashtagFeedType: "recent",
      searchCoverage: "efficient",
    },
    max: 0.1,
  },
  { actor: "viralanalyzer/instagram-keyword-search-scraper", input: { keywords: [PHRASE], maxPosts: 10 }, max: 0.05 },
];

const get = (o: Record<string, unknown>, ...paths: string[]): unknown => {
  for (const p of paths) {
    const v = p.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
const captionOf = (o: Record<string, unknown>) => String(get(o, "caption.text", "caption", "text", "description") ?? "");
const hashtagsOf = (o: Record<string, unknown>): string[] => {
  const h = get(o, "hashtags", "caption.hashtags");
  return Array.isArray(h) ? h.map((x) => String(x).replace(/^#/, "").toLowerCase()) : [];
};

function analyze(r: ProbeResult) {
  const posts = r.items.filter((i) => !("_blockReason" in i) && !("error" in i));
  const fieldCounts: Record<string, number> = {};
  for (const i of posts) for (const k of Object.keys(i)) fieldCounts[k] = (fieldCounts[k] ?? 0) + 1;
  let allTerms = 0;
  let captionOnly = 0;
  let noMention = 0;
  const times: string[] = [];
  for (const p of posts) {
    const cap = captionOf(p).toLowerCase();
    const tags = hashtagsOf(p);
    const hasAll = TERMS.every((t) => cap.includes(t));
    const tagHit = tags.some((t) => t.includes(JOINED) || TERMS.some((w) => t === w));
    if (hasAll) allTerms++;
    if (hasAll && !tagHit && !cap.includes(`#${JOINED}`)) captionOnly++;
    if (!TERMS.some((t) => cap.includes(t)) && !tagHit) noMention++;
    const ts = get(p, "publishedAt", "pub_date", "timestamp", "taken_at_date", "takenAt", "createdAt", "taken_at");
    if (ts !== undefined) times.push(String(ts));
  }
  const pick = (k: string[]) => k.find((x) => fieldCounts[x]) ?? null;
  return {
    actor: r.actor,
    status: r.status,
    duration_s: +(r.durationMs / 1000).toFixed(1),
    cost_usd: r.usageTotalUsd,
    charged_events: r.chargedEvents,
    items_returned: r.items.length,
    posts: posts.length,
    diagnostics: r.items.filter((i) => "_blockReason" in i || "error" in i).map((i) => get(i, "_blockReason", "error")),
    caption_contains_all_terms: allTerms,
    caption_only_match_no_hashtag: captionOnly,
    unrelated_posts: noMention,
    timestamp_field: pick(["publishedAt", "pub_date", "timestamp", "taken_at_date", "takenAt", "createdAt", "taken_at"]),
    timestamp_sample: times.slice(0, 2),
    id_field: pick(["shortcode", "shortCode", "code", "id", "pk", "media_id", "post_id"]),
    likes_field: pick(["likes", "likeCount", "like_count", "likesCount"]),
    comments_field: pick(["comments", "commentCount", "comment_count", "commentsCount"]),
    author_field: pick(["username", "ownerUsername", "author", "owner", "user"]),
    fields: Object.keys(fieldCounts).sort(),
  };
}

const before = await accountUsage();
console.log(`Apify usage sebelum: $${before.monthlyUsageUsd.toFixed(3)} / $${before.maxMonthlyUsageUsd}`);
// Argumen = subset actor yang dijalankan ulang; hasil actor lain dipertahankan dari file sebelumnya (hemat biaya).
const only = process.argv.slice(2);
const dir = `${import.meta.dir}/../../docs/evidence/S-11`;
const prev = (await Bun.file(`${dir}/ig-keyword-contract.json`)
  .json()
  .catch(() => ({ results: [] }))) as { results: { actor: string }[] };
const report: Record<string, unknown>[] = prev.results.filter((r) => only.length && !only.includes(r.actor));
for (const c of CANDIDATES.filter((x) => !only.length || only.includes(x.actor))) {
  try {
    const r = await runActor({ actor: c.actor, input: c.input, maxTotalChargeUsd: c.max, timeoutSecs: 300, memoryMb: c.memoryMb });
    const a = analyze(r);
    report.push(a);
    console.log(JSON.stringify({ ...a, fields: a.fields.length }, null, 1));
  } catch (e) {
    report.push({ actor: c.actor, error: (e as Error).message });
    console.log(c.actor, "ERROR", (e as Error).message);
  }
}
const after = await accountUsage();
console.log(
  `Apify usage sesudah: $${after.monthlyUsageUsd.toFixed(3)} (probe ≈ $${(after.monthlyUsageUsd - before.monthlyUsageUsd).toFixed(3)})`,
);
await mkdir(dir, { recursive: true });
await Bun.write(
  `${dir}/ig-keyword-contract.json`,
  JSON.stringify({ date: new Date().toISOString(), phrase: PHRASE, usage_before: before, usage_after: after, results: report }, null, 2),
);
