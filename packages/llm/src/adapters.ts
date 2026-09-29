// Adapter LLM per PROTOKOL API (bukan per vendor): gemini · openai_compatible (OpenAI, OpenRouter, vLLM, Ollama, custom) ·
// anthropic. Dipakai panel admin untuk daftar model & tes; worker-ai (Python) punya adapter setara (workers-py/smip_nlp/llm.py).
// Semua HTTP lewat HttpClient connector-sdk (SSRF guard, timeout). API key hanya di header, tidak pernah di URL/log.
// Paket bersama: panel admin (apps/api) & worker-ai (apps/worker-ai).
import { ConnectorError, HttpClient, type RequestOptions } from "@smip/connector-sdk";

export type LlmKind = "gemini" | "openai_compatible" | "anthropic";
export interface LlmProviderRef {
  kind: LlmKind;
  base_url: string | null;
}
export interface ModelInfo {
  model_id: string;
  display_name: string | null;
  input_token_limit: number | null;
  output_token_limit: number | null;
}
export interface JsonCall {
  system: string;
  user: string;
  /** JSON Schema (subset: object/string/number/boolean/enum/required). */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}
export interface JsonResult {
  json: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  model: string;
}

export const DEFAULT_BASE: Record<LlmKind, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai_compatible: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

const base = (p: LlmProviderRef) => (p.base_url ?? DEFAULT_BASE[p.kind]).replace(/\/+$/, "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function call(http: HttpClient, url: string, init: RequestOptions): Promise<Record<string, unknown>> {
  const res = await http.request(url, { ...init, throwOnStatus: false, timeoutMs: init.timeoutMs ?? 30_000 });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (body.error ?? {}) as { message?: string; status?: string; type?: string; details?: { reason?: string }[] };
    // Gemini: key salah = HTTP 400 INVALID_ARGUMENT (reason API_KEY_INVALID), bukan 401 — terlihat saat uji live 2026-09-29
    const badKey =
      res.status === 401 ||
      res.status === 403 ||
      (err.details ?? []).some((d) => /API_KEY_INVALID|API_KEY_EXPIRED/.test(d.reason ?? "")) ||
      /api key not valid|invalid api key|invalid x-api-key|incorrect api key/i.test(err.message ?? "");
    const code = res.status === 429 ? "RATE_LIMITED" : badKey ? "AUTH_INVALID" : res.status >= 500 ? "UPSTREAM_5XX" : "INVALID_QUERY";
    // pesan provider dipotong & tanpa header — tidak memuat API key
    throw new ConnectorError(
      code,
      `HTTP ${res.status}${err.status ? ` ${err.status}` : err.type ? ` ${err.type}` : ""}: ${String(err.message ?? "").slice(0, 200)}`,
      {
        httpStatus: res.status,
      },
    );
  }
  return body;
}

/** JSON Schema → responseSchema Gemini (tipe OpenAPI huruf besar). */
function geminiSchema(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof s.type === "string") out.type = s.type.toUpperCase();
  if (s.enum) out.enum = s.enum;
  if (s.properties)
    out.properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, Record<string, unknown>>).map(([k, v]) => [k, geminiSchema(v)]),
    );
  if (s.required) out.required = s.required;
  if (s.items) out.items = geminiSchema(s.items as Record<string, unknown>);
  return out;
}

export async function listModels(p: LlmProviderRef, apiKey: string, http = new HttpClient()): Promise<ModelInfo[]> {
  if (p.kind === "gemini") {
    const b = await call(http, `${base(p)}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey } });
    return ((b.models as Record<string, unknown>[]) ?? [])
      .filter((m) => ((m.supportedGenerationMethods as string[]) ?? []).includes("generateContent"))
      .map((m) => ({
        model_id: String(m.name).replace(/^models\//, ""),
        display_name: (m.displayName as string) ?? null,
        input_token_limit: num(m.inputTokenLimit),
        output_token_limit: num(m.outputTokenLimit),
      }));
  }
  if (p.kind === "anthropic") {
    const b = await call(http, `${base(p)}/models?limit=1000`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
    return ((b.data as Record<string, unknown>[]) ?? []).map((m) => ({
      model_id: String(m.id),
      display_name: (m.display_name as string) ?? null,
      input_token_limit: num(m.max_input_tokens),
      output_token_limit: num(m.max_tokens),
    }));
  }
  const b = await call(http, `${base(p)}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  return ((b.data as Record<string, unknown>[]) ?? []).map((m) => ({
    model_id: String(m.id),
    display_name: (m.name as string) ?? null,
    input_token_limit: num(m.context_length),
    output_token_limit: num((m.top_provider as Record<string, unknown> | undefined)?.max_completion_tokens),
  }));
}

export async function generateJson(
  p: LlmProviderRef,
  apiKey: string,
  model: string,
  c: JsonCall,
  http = new HttpClient(),
): Promise<JsonResult> {
  const t0 = performance.now();
  if (p.kind === "gemini") {
    const b = await call(http, `${base(p)}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: c.system }] },
        contents: [{ role: "user", parts: [{ text: c.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: geminiSchema(c.schema),
          maxOutputTokens: c.maxOutputTokens,
        },
      }),
    });
    const cand = ((b.candidates as Record<string, unknown>[]) ?? [])[0];
    const text = (((cand?.content as Record<string, unknown>)?.parts as { text?: string }[]) ?? []).map((x) => x.text ?? "").join("");
    if (!text) throw new ConnectorError("PARSE_ERROR", `respons kosong (finishReason ${String(cand?.finishReason ?? "?")})`);
    const u = (b.usageMetadata ?? {}) as Record<string, unknown>;
    return {
      json: JSON.parse(text),
      inputTokens: num(u.promptTokenCount),
      outputTokens: num(u.candidatesTokenCount),
      latencyMs: Math.round(performance.now() - t0),
      model: String(b.modelVersion ?? model),
    };
  }
  if (p.kind === "anthropic") {
    // structured output lewat tool dengan input_schema + tool_choice paksa (didukung luas)
    const b = await call(http, `${base(p)}/messages`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: c.maxOutputTokens,
        system: c.system,
        messages: [{ role: "user", content: c.user }],
        tools: [{ name: "result", description: "Kembalikan hasil klasifikasi", input_schema: c.schema }],
        tool_choice: { type: "tool", name: "result" },
      }),
    });
    if (b.stop_reason === "refusal") throw new ConnectorError("FORBIDDEN", "model menolak (refusal)");
    const tool = ((b.content as Record<string, unknown>[]) ?? []).find((x) => x.type === "tool_use");
    if (!tool) throw new ConnectorError("PARSE_ERROR", "tanpa tool_use di respons");
    const u = (b.usage ?? {}) as Record<string, unknown>;
    return {
      json: tool.input,
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      latencyMs: Math.round(performance.now() - t0),
      model: String(b.model ?? model),
    };
  }
  const b = await call(http, `${base(p)}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: c.maxOutputTokens,
      messages: [
        { role: "system", content: c.system },
        { role: "user", content: c.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema: { ...c.schema, additionalProperties: false } },
      },
    }),
  });
  const msg = (((b.choices as Record<string, unknown>[]) ?? [])[0]?.message ?? {}) as { content?: string; refusal?: string };
  if (msg.refusal) throw new ConnectorError("FORBIDDEN", "model menolak (refusal)");
  if (!msg.content) throw new ConnectorError("PARSE_ERROR", "respons kosong");
  const u = (b.usage ?? {}) as Record<string, unknown>;
  return {
    json: JSON.parse(msg.content),
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    latencyMs: Math.round(performance.now() - t0),
    model: String(b.model ?? model),
  };
}

/** Skema & prompt uji sentiment (AI_SPEC §4.5, ringkas) — dipakai tombol "Tes" di panel. */
export const SENTIMENT_SCHEMA = {
  type: "object",
  properties: { label: { type: "string", enum: ["negative", "neutral", "positive"] }, confidence: { type: "number" } },
  required: ["label", "confidence"],
};
export const SENTIMENT_SYSTEM =
  "Kamu mengklasifikasikan sentiment post media sosial berbahasa Indonesia (bisa campur Inggris, slang, sarkasme) terhadap topik yang diberikan. Label: negative, neutral, positive. Sarkasme dinilai berdasarkan maksud, bukan kata literal. Berita/informasi tanpa opini = neutral. Keluarkan JSON sesuai schema.";
