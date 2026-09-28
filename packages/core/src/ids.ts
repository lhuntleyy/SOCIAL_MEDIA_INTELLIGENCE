// Tipe ID bertanda (branded) — mencegah TenantId tertukar dengan TopicId di compile time (SECURITY §3).
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type TopicId = Brand<string, "TopicId">;
export type TopicQueryId = Brand<string, "TopicQueryId">;
export type CrawlRunId = Brand<string, "CrawlRunId">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function brandUuid<B extends string>(kind: B) {
  return (v: string): Brand<string, B> => {
    if (!isUuid(v)) throw new TypeError(`${kind} bukan UUID valid: ${JSON.stringify(v)}`);
    return v.toLowerCase() as Brand<string, B>;
  };
}

export const TenantId = brandUuid("TenantId");
export const UserId = brandUuid("UserId");
export const TopicId = brandUuid("TopicId");
export const TopicQueryId = brandUuid("TopicQueryId");
export const CrawlRunId = brandUuid("CrawlRunId");
