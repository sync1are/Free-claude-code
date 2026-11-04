// Provider registry with LIVE model discovery.
//
// Model catalogs at these providers churn constantly (models get deprecated,
// renamed, moved to paid tiers), so max does not trust bundled lists when it
// can help it:
//
//   1. It FETCHES the live model list from the provider's /models endpoint
//   2. Auto-picks the best sonnet / opus / haiku tier models via scoring rules
//   3. Caches the result for 24h in ~/.max/models-cache.json
//   4. Falls back to a bundled snapshot (dated) when fetch fails

import fs from "node:fs";
import path from "node:path";
import { configDir, readJsonCache, writeJsonCache } from "./config";

export const BUNDLED_AS_OF = "2026-11-04";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type TierName = "model" | "opus" | "haiku";

export interface TierPick {
  model: string;
  opus: string;
  haiku: string;
}

export interface TierPatterns {
  /** primary / sonnet-tier: balanced, good at coding + tool calling */
  model: string[];
  /** opus-tier: the strongest models available */
  opus: string[];
  /** haiku-tier: small + fast, used for Claude Code's background tasks */
  haiku: string[];
}

export interface ProviderDef {
  id: string;
  name: string;
  aliases: string[];
  /** OpenAI-compatible base URL (Claude Code itself never talks here) */
  baseUrl: string;
  requiresKey: boolean;
  keyHint?: string;
  keyUrl?: string;
  /** translate Anthropic thinking budget -> OpenAI reasoning_effort */
  reasoningEffort?: boolean;
  /** NVIDIA NIM-style chat templates: thinking on/off flag */
  chatTemplateThinking?: boolean;
  /** bundled */

  models: string[];
  tierPatterns: TierPatterns;
  note?: string;

  fetchModels(apiKey?: string): Promise<string[]>;
}

// ---------- live fetchers ----------

/** Model families that are not chat/chat-tools completions models. */
const NON_CHAT_RE = /whisper|guard|safety|orpheus|embed|moderation|prompt-guard|lyria|tts|imagen|video|diffusion|moderator|shield|gliner|riva|usdcode|pii|safeguard/i;

function chatOnly(ids: string[]): string[] {
  return ids.filter((id) => !NON_CHAT_RE.test(id));
}

async function fetchJsonList(baseUrl: string, apiKey?: string, extra?: Record<string, string>): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  const res = await fetch(url, {
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      accept: "application/json",
      "user-agent": "max-cli/0.1",
      ...extra,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`GET /models -> HTTP ${res.status}`);
  }
  const j = (await res.json()) as any;
  const arr = j?.data ?? j?.models ?? [];
  if (!Array.isArray(arr)) throw new Error('unexpected /models response (missing "data")');
  return arr.map((m: any) => (typeof m === "string" ? m : m.id)).filter((x: unknown): x is string => typeof x === "string");
}

function normalizeOllamaHost(): string {
  let host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  return host.replace(/\/+$/, "");
}

function openrouterIsFree(m: any): boolean {
  const p = m?.pricing;
  if (p && (p.prompt === "0" || p.prompt === 0) && (p.completion === "0" || p.completion === 0)) return true;
  return typeof m?.id === "string" && m.id.endsWith(":free");
}

// ---------- the registry ----------

export const PROVIDERS: ProviderDef[] = [
  {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    aliases: ["nvidia", "nim"],
    baseUrl: "https://integrate.api.nvidia.com/v1",
    requiresKey: true,
    keyHint: "nvapi-…",
    keyUrl: "https://build.nvidia.com (NVIDIA NIM catalog -> Get API Key)",
    chatTemplateThinking: true,
    models: [
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-nano-30b-a3b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-bolt-e4b",
      "moonshotai/kimi-k3",
      "moonshotai/kimi-k2-thinking",
      "moonshotai/kimi-k2-instruct",
      "deepseek-ai/deepseek-v4-flash",
      "deepseek-ai/deepseek-v4-pro",
      "qwen/qwen3-next-80b-a3b-instruct",
      "qwen/qwen3-next-80b-a3b-thinking",
      "qwen/qwq-32b",
      "qwen/qwen2.5-coder-32b-instruct",
      "meta/llama-3.3-70b-instruct",
      "meta/llama-3.1-8b-instruct",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "z-ai/glm-5.3",
      "z-ai/glm-5.3-flash",
      "z-ai/glm-5.2",
      "z-ai/glm4.7",
      "minimaxai/minimax-m2.7",
      "minimaxai/minimax-m2.5",
      "mistralai/mistral-nemotron",
      "microsoft/phi-4-mini-instruct",
      "microsoft/phi-4-mini-flash-reasoning",
      "stepfun-ai/step-3.5-flash",
    ],    tierPatterns: {
      model: [
        "nemotron-3-ultra",
        "nemotron-3-super-120b",
        "nemotron-3\\.5-lightning",
        "kimi-k3",
        "deepseek-v4-flash",
        "gpt-oss-120b",
        "nemotron-super-49b",
      ],
      opus: [
        "kimi-k3",
        "nemotron-3-ultra",
        "deepseek-v4-pro",
        "nemotron-3-super-120b",
        "minimax-m2\\.7",
        "kimi-k2-thinking",
        "glm-5\\.3$",
      ],
      haiku: [
        "nemotron-3\\.5-bolt",
        "nemotron-3-nano",
        "phi-4-mini-instruct",
        "gpt-oss-20b",
        "mini-flash-reasoning",
        "8b-instruct",
      ],
    },
    fetchModels: async (key) => {
      // Primary: NVIDIA's own docs catalog — curated, current, undeprecated.
      try {
        const res = await fetch("https://docs.api.nvidia.com/nim/reference/llm-apis", {
          headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          const html = await res.text();
          // docs tables render links as [org / model](...) — the link text is unambiguous
          const ids = new Set<string>();
          const re = /\[([a-z0-9][a-z0-9_\- ]*) \/ ([a-z0-9][a-z0-9._\-]*)\]/gi;
          let m: RegExpExecArray | null;
          while ((m = re.exec(html)) !== null) {
            const org = m[1].trim().toLowerCase().replace(/\s+/g, "");
            const model = m[2].trim().toLowerCase();
            ids.add(`${org}/${model}`);
          }
          if (ids.size >= 5) {
            return chatOnly([...ids]).sort();
          }
        }
      } catch {
        /* fall through */
      }
      // Secondary: public keyless catalog (may include some legacy entries)
      const ids = await fetchJsonList("https://integrate.api.nvidia.com/v1");
      return chatOnly(ids);
    },
    note: "Free credits on build.nvidia.com; model list rotates often. Catalog auto-fetches keyless.",
  },
  {
    id: "groq",
    name: "Groq",
    aliases: ["groq"],
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    keyHint: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    reasoningEffort: true,
    models: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b",
    ],
    tierPatterns: {
      model: ["gpt-oss-120b", "qwen3\\.8-27b", "gpt-oss-20b"],
      opus: ["gpt-oss-120b", "qwen3\\.8-27b", "gpt-oss-20b"],
      haiku: ["gpt-oss-20b", "qwen3\\.8-27b", "gpt-oss-120b"],
    },
    fetchModels: async (key) => {
      if (!key) throw new Error("Groq /models requires an API key");
      const url = "https://api.groq.com/openai/v1/models";
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": "max-cli/0.1" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GET /models -> HTTP ${res.status}`);
      const j = (await res.json()) as any;
      const arr = j?.data ?? [];
      if (!Array.isArray(arr)) throw new Error('unexpected /models response (missing "data")');
      // drop anything the provider already flags as retired, plus families we
      // know are shut down (enterprise-only llama, compound, old kimi/qwen3.6)
      const deadLabel = (m: any) =>
        m?.active === false || m?.deprecated === true || typeof m?.status === "string" && /deprecat/i.test(m.status);
      const groqDeadRe = /(^|\/)(llama-3\.1-8b-instant|llama-3\.3-70b-versatile|groq\/compound|qwen\/qwen3\.6-27b|moonshotai\/kimi-k2-instruct)/i;
      const ids = arr
        .filter((m: any) => !deadLabel(m))
        .map((m: any) => (typeof m === "string" ? m : m.id))
        .filter((x: unknown): x is string => typeof x === "string")
        .filter((id: string) => !groqDeadRe.test(id));
      return chatOnly(ids);
    },
    note: "Free dev plan runs gpt-oss + qwen3.8 families; llama & compound were retired Aug-Sep 2026.",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    aliases: ["ollama", "local"],
    baseUrl: "http://127.0.0.1:11434/v1",
    requiresKey: false,
    models: [],
    tierPatterns: { model: [], opus: [], haiku: [] },
    fetchModels: async () => {
      const host = normalizeOllamaHost();
      let ids: string[];
      try {
        ids = await fetchJsonList(`${host}/v1`);
      } catch {
        // fall back to the native API (always exists)
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(4_000) });
        if (!res.ok) throw new Error(`Ollama at ${host} not reachable (HTTP ${res.status})`);
        const j = (await res.json()) as any;
        ids = (j?.models ?? []).map((m: any) => m.name).filter(Boolean);
      }
      if (!ids.length) throw new Error(`Ollama is running but no models are pulled yet — try: ollama pull qwen3-coder:30b`);
      return ids;
    },
    note: "Zero cost, fully local. Make sure Ollama is running and a model is pulled.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    aliases: ["openrouter", "router"],
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    keyHint: "sk-or-…",
    keyUrl: "https://openrouter.ai/keys",
    reasoningEffort: true,
    models: [
      "deepseek/deepseek-chat-v3.1:free",
      "deepseek/deepseek-r1-0528:free",
      "z-ai/glm-4.6:free",
      "qwen/qwen3-coder:free",
      "moonshotai/kimi-k2:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "openai/gpt-oss-120b:free",
      "mistralai/mistral-small-3.2-24b-instruct:free",
      "google/gemma-3-27b-it:free",
      "qwen/qwen3-235b-a22b:free",
    ],
    tierPatterns: {
      model: [
        "qwen3-coder:free",
        "deepseek-chat:free",
        "glm-4\\.6:free",
        "gpt-oss-120b:free",
        "kimi-k2:free",
        "nemotron-3-ultra:*free",
        "deepseek.*:free",
        "coder:free",
        "(gemma-4-31|gemma-..-27)\\d?b.*it:free",
        "gemini.*flash.*:free",
        "ultra.*:free",
        "31b.*:free",
      ],
      opus: [
        "kimi-k2:free",
        "deepseek-r1.*:free",
        "glm-4\\.6:free",
        "qwen3-235b",
        "gpt-oss-120b:free",
        "ultra.*:free",
        "rail:free", // catchall never matches; keeps fallback = largest context (first entry)
      ],
      haiku: [
        "flash.*:free",
        "nano.*:free",
        "mini.*:free",
        "air:free",
        "8b.*:free",
        "gpt-oss-20b:free",
        "3b.*:free",
      ],
    },
    fetchModels: async () => {
      const url = "https://openrouter.ai/api/v1/models";
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`GET /models -> HTTP ${res.status}`);
      const j = (await res.json()) as any;
      const arr = j?.data ?? [];
      if (!Array.isArray(arr)) throw new Error("unexpected openrouter response");
      const free = arr
        .filter(openrouterIsFree)
        .filter((m: any) => {
          const modality: string = m?.architecture?.modality ?? "text->text";
          return modality.includes("text");
        })
        .filter((m: any) => !NON_CHAT_RE.test(m.id ?? ""));
      // strongest-first: prefer the largest context window
      free.sort((a: any, b: any) => (b?.context_length ?? 0) - (a?.context_length ?? 0) || String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
      return free.map((m: any) => m.id as string);
    },
    note: "Public model list is fetched without a key; ':free' models cost nothing.",
  },
];

export function resolveProvider(idOrAlias?: string): ProviderDef | undefined {
  if (!idOrAlias) return undefined;
  const key = idOrAlias.toLowerCase().replace(/^--/, "");
  return PROVIDERS.find(
    (p) => p.id === key || p.aliases.includes(key),
  );
}

export function resolveProviderByFlag(idOrAlias: string): ProviderDef | undefined {
  return resolveProvider(idOrAlias);
}

// ---------- tier picking ----------

function scoreCandidate(candidate: string, patterns: string[]): number {
  let score = 0;
  patterns.forEach((p, i) => {
    if (new RegExp(p, "i").test(candidate)) score += patterns.length - i;
  });
  return score;
}

export function pickTier(
  provider: ProviderDef,
  models: string[],
  tier: TierName,
): string | null {
  const patterns = provider.tierPatterns[tier] ?? [];
  let best: string | null = null;
  let bestScore = -1;
  for (const m of models) {
    const s = patterns.length ? scoreCandidate(m, patterns) : 0;
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  if (best === null && models.length > 0) best = models[0];
  return best;
}

export function pickTiers(provider: ProviderDef, models: string[]): TierPick {
  if (provider.id === "ollama") {
    // Local: users pull what they want; use the first model for every tier
    // unless they override with --model/--opus/--haiku.
    const m = models[0] ?? "";
    return { model: m, opus: m, haiku: m };
  }
  return {
    model: pickTier(provider, models, "model") ?? "",
    opus: pickTier(provider, models, "opus") ?? "",
    haiku: pickTier(provider, models, "haiku") ?? "",
  };
}

/**
 * Top-n ranked candidates for a tier (best first). Used as the retry ladder
 * when the provider retires/EOLs the primary pick mid-flight.
 */
export function pickTierCandidates(
  provider: ProviderDef,
  models: string[],
  tier: TierName,
  n = 4,
): string[] {
  const patterns = provider.tierPatterns[tier] ?? [];
  if (!patterns.length) return models.slice(0, n);
  const scored = models
    .map((m) => ({ m, s: scoreCandidate(m, patterns) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map((x) => x.m);
}

// ---------- cache ----------

interface ModelsCache {
  [providerId: string]: {
    fetchedAt: number;
    live: boolean;
    models: string[];
  };
}

function cacheFile(): string {
  return path.join(configDir(), "models-cache.json");
}

function readCache(): ModelsCache {
  return readJsonCache<ModelsCache>(cacheFile()) ?? {};
}

function writeCache(cache: ModelsCache): void {
  writeJsonCache(cacheFile(), cache);
}

export type ModelSource = "live" | "cache" | "bundled" | "error";

export interface ModelsResult {
  models: string[];
  source: ModelSource;
  fetchedAt?: number;
  error?: string;
}

// ---------- dead-model memory ----------
// When a provider answers "model reached its end of life", max remembers so it
// stops picking that model in future launches. Entries expire after 14 days
// (providers occasionally restore rotated models).

const DEAD_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function deadFile(): string {
  return path.join(configDir(), "dead-models.json");
}

function readDead(): Record<string, Record<string, number>> {
  return readJsonCache<Record<string, Record<string, number>>>(deadFile()) ?? {};
}

export function recordDeadModel(providerId: string, model: string): void {
  if (!model) return;
  const dead = readDead();
  dead[providerId] = { ...(dead[providerId] ?? {}), [model]: Date.now() };
  writeJsonCache(deadFile(), dead);
}

function dropDeadModels(provider: ProviderDef, models: string[]): string[] {
  const dead = readDead()[provider.id] ?? {};
  const now = Date.now();
  const kept = models.filter((m) => {
    const t = dead[m];
    return !(typeof t === "number" && now - t < DEAD_TTL_MS);
  });
  // never drop everything — an all-dead catalog is worse than a dead pick
  return kept.length ? kept : models;
}

/**
 * Fetch the provider's live model list (with 24h cache + bundled fallback),
 * then filter out models we've observed being retired upstream.
 */
export async function getModels(
  provider: ProviderDef,
  opts: { key?: string; refresh?: boolean } = {},
): Promise<ModelsResult> {
  const raw = await getModelsUncached(provider, opts);
  return { ...raw, models: dropDeadModels(provider, raw.models) };
}

async function getModelsUncached(
  provider: ProviderDef,
  opts: { key?: string; refresh?: boolean } = {},
): Promise<ModelsResult> {
  if (opts.refresh) {
    try {
      const live = await provider.fetchModels(opts.key);
      const cache = readCache();
      cache[provider.id] = { fetchedAt: Date.now(), live: true, models: live };
      writeCache(cache);
      return { models: live, source: "live", fetchedAt: Date.now() };
    } catch (err: any) {
      return { models: bundledFor(provider), source: "bundled", error: err?.message ?? String(err) };
    }
  }

  const cache = readCache();
  const entry = cache[provider.id];
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS && entry.models.length) {
    return { models: entry.models, source: entry.live ? "cache" : "bundled", fetchedAt: entry.fetchedAt };
  }

  try {
    const live = await provider.fetchModels(opts.key);
    const fresh = readCache();
    fresh[provider.id] = { fetchedAt: Date.now(), live: true, models: live };
    writeCache(fresh);
    return { models: live, source: "live", fetchedAt: Date.now() };
  } catch (err: any) {
    if (entry && entry.models.length) {
      return {
        models: entry.models,
        source: entry.live ? "cache" : "bundled",
        fetchedAt: entry.fetchedAt,
        error: err?.message ?? String(err),
      };
    }
    const bundled = bundledFor(provider);
    if (bundled.length) return { models: bundled, source: "bundled", error: err?.message ?? String(err) };
    throw new Error(err?.message ?? String(err));
  }
}

function bundledFor(provider: ProviderDef): string[] {
  return provider.models.slice();
}

/** `max models` display helper: mark which models got picked for which tier. */
export function tierMarks(provider: ProviderDef, models: string[]): Record<string, string[]> {
  const pick = pickTiers(provider, models);
  const marks: Record<string, string[]> = {};
  const add = (id: string, tier: string) => {
    if (!id) return;
    (marks[id] ??= []).push(tier);
  };
  add(pick.haiku, "haiku");
  add(pick.model, "sonnet");
  add(pick.opus, "opus");
  if (provider.id === "ollama" && pick.model) {
    marks[pick.model] = ["sonnet", "opus", "haiku"];
  }
  return marks;
}

export function bundledModelsTool(): string {
  // expose for doctor/debug
  return PROVIDERS.map((p) => `${p.id} (${p.models.length} bundled)`).join(", ");
}

export function isBundledFileMissing(p: ProviderDef): boolean {
  return p.models.length === 0 && fs.existsSync(path.join(configDir(), "models-cache.json")) === false;
}
