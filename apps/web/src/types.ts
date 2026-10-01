export interface TopicSummary {
  id: string;
  /** topic = keyword; account = pantau akun (menu Akun) */
  kind?: "topic" | "account";
  name: string;
  description: string | null;
  status: "active" | "paused" | "archived";
  platforms: string[];
  author: { id: string; name: string } | null;
  updated_at: string;
}
export interface TopicDetail extends Omit<TopicSummary, "platforms"> {
  platforms: { code: string; interval_sec: number; effective_interval_sec: number; enabled: boolean }[];
  queries: {
    id: string;
    kind: "main" | "sub";
    label: string | null;
    query_text: string;
    platforms?: string[] | null;
    keywords: string[];
    languages: string[] | null;
    enabled: boolean;
  }[];
  language_hints: string[];
  filter_ads: boolean;
  version: number;
}
export interface Run {
  id: string;
  source: "plan" | "stream";
  platform: string;
  operation: string;
  kind: string;
  status: string;
  scheduled_for: string;
  finished_at: string | null;
  items_fetched: number;
  items_matched: number;
  items_new: number;
  error_code: string | null;
  cost_units: number | null;
}
