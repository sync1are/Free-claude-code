// max — launch Claude Code on free providers.
//
//   max launch claude --nvidia "nvapi-..."
//   max launch claude --groq --model openai/gpt-oss-120b
//   max launch claude --ollama
//
// Keys are stored in Windows Credential Manager; models are live-fetched
// from each provider and cached; everything rides on a tiny built-in
// Anthropic<->OpenAI translation proxy.

import * as fs from "node:fs";
import path from "node:path";
import { bold, cyan, dim, green, magenta, red, yellow } from "./colors";
import {
  configDir,
  loadConfig,
  setProviderPrefs,
} from "./config";
import { ensureClaudeInstalled, spawnClaude } from "./claude";
import { getSecret, keyringFileForDisplay, removeSecret, setSecret } from "./keyring";
import { ask, confirm } from "./prompts";
import {
  BUNDLED_AS_OF,
  getModels,
  pickTiers,
  PROVIDERS,
  ProviderDef,
  resolveProvider,
  tierMarks,
  type TierPick,
} from "./providers";
import { startProxy, type ProxyOptions } from "./proxy";

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string };
const VERSION = pkg.version;

const CONTAINER_BIN = "max";

// ---------------- usage ----------------

function usage(exit = 0): never {
  console.log(
    `
${bold(`max ${VERSION}`)} — run ${cyan("Claude Code")} on free providers (NVIDIA NIM, Groq, Ollama, OpenRouter)

${bold("USAGE")}
  ${CONTAINER_BIN} launch claude ${cyan("<provider>")} ${dim("[API_KEY]")} ${dim("[flags]")} ${magenta("--")} ${dim("[-- claude args...]")}
  ${CONTAINER_BIN} key ${cyan("set|get|clear")} ${cyan("<provider>")} ${dim("[API_KEY]")}
  ${CONTAINER_BIN} models ${dim("[provider] [--refresh]")}
  ${CONTAINER_BIN} providers
  ${CONTAINER_BIN} set ${cyan("<provider>")} ${dim("[--model M] [--opus M] [--haiku M]")}   ${dim("save default models")}
  ${CONTAINER_BIN} doctor
  ${CONTAINER_BIN} proxy ${cyan("--target")} ${dim("https://…/v1")} ${cyan("--key")} ${dim("kk")}

${bold("PROVIDERS")}
  ${PROVIDERS.map((p) => `- ${cyan(p.id.padEnd(12))} ${dim(p.aliases.join(", "))}`).join("\n  ")}

${bold("LAUNCH FLAGS")}
  --model M        primary model id (overrides auto-pick)
                   shorthand: --<org>/<model-id> or just --<model-id>, matched
                   against the live catalog (e.g. --nvidia/nemotron-3.5-bolt-e4b)
  --opus M         strong model id
  --haiku M        fast/background model id
  --key KEY        API key (same as the positional argument)
  --cwd DIR        folder to start Claude Code in
  --save/--no-save ${dim("store the API key after prompting (default: save)")}
  --dry-run        print the setup without launching anything
  --verbose        show proxy activity
  --refresh-models Ignores cache; refetch live model lists

${bold("EXAMPLES")}
  ${CONTAINER_BIN} launch claude --nvidia "nvapi-xxxxxxxx"     ${dim("# first time with key")}
  ${CONTAINER_BIN} launch claude --nvidia                      ${dim("# after that: key remembered")}
  ${CONTAINER_BIN} launch claude --groq --model openai/gpt-oss-120b
  ${CONTAINER_BIN} launch claude --nvidia-nim --nvidia/nemotron-3.5-bolt-e4b   ${dim("# model shorthand")}
  ${CONTAINER_BIN} launch claude --ollama                      ${dim("# fully free & local")}
  ${CONTAINER_BIN} launch claude --nvidia -- -p "explain this repo"   ${dim("# pass args to claude")}

${dim(`models auto-fetched from each provider (24h cache). bundled snapshot: ${BUNDLED_AS_OF}`)}
`.trim(),
  );
  return process.exit(exit);
}

// ---------------- small utils ----------------

function maskSecret(s: string): string {
  if (!s) return "(empty)";
  return s.length <= 10 ? `${s.slice(0, 3)}…${s.slice(-2)}` : `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function dbg(...args: unknown[]): void {
  if (process.env.MAX_DEBUG) console.error(dim(`[debug] ${args.map(String).join(" ")}`));
}

/** stored secret or null; prints origin */
function storedSecret(p: ProviderDef): string | null {
  const info = getSecret(p.id);
  if (!info) return null;
  return info.secret;
}

async function resolveKey(
  p: ProviderDef,
  opts: { inline?: string; save?: boolean; printOrigin?: boolean },
): Promise<string> {
  if (opts.inline) return opts.inline;
  const stored = storedSecret(p);
  if (stored) {
    if (opts.printOrigin !== false) {
      console.log(`  ${green("key")} ${dim(`${maskSecret(stored)} (remembered)`)}`);
    }
    return stored;
  }
  console.log(`  ${yellow(`No ${p.name} API key stored.`)}`);
  if (p.keyUrl) console.log(`  ${dim(`Get a free one here: ${p.keyUrl}`)}`);
  const secret = await ask(`  Paste ${p.name} API key (${p.keyHint ?? "api key"}): `, { mask: true });
  if (!secret) {
    console.error("  " + red("no key entered — aborting"));
    process.exit(1);
  }
  const shouldSave = opts.save !== false ? await confirm("    Remember this key on this machine?", true) : false;
  if (shouldSave) {
    const backend = setSecret(p.id, secret);
    console.log(`    ${green(`key saved (${backend === "vault" ? "Windows Credential Manager" : keyringFileForDisplay()})`)}`);
  }
  return secret;
}

// ---------------- launch ----------------

interface LaunchSpec {
  provider?: ProviderDef;
  app?: string;
  key?: string;
  model?: string;
  opus?: string;
  haiku?: string;
  cwd?: string;
  save?: boolean;
  dryRun: boolean;
  verbose: boolean;
  refresh: boolean;
  claudeArgs: string[];
  /** tokens like --org/model-id that we resolve against the live catalog later */
  deferredFlags: string[];
}

function parseLaunch(tokens: string[]): LaunchSpec {
  const spec: LaunchSpec = { dryRun: false, verbose: false, refresh: false, claudeArgs: [], deferredFlags: [] };
  const rest: string[] = [];
  let i = 0;
  const boolFlags = new Set(["--dry-run", "--verbose", "--save", "--no-save", "--refresh-models", "--refresh"]);

  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--") {
      rest.push(...tokens.slice(i + 1));
      break;
    }
    if (boolFlags.has(t)) {
      if (t === "--no-save") spec.save = false;
      else if (t === "--save") spec.save = true;
      else if (t === "--dry-run") spec.dryRun = true;
      else if (t === "--verbose") spec.verbose = true;
      else spec.refresh = true;
      i++;
      continue;
    }
    if (t.startsWith("--")) {
      // --model=<id>, --key=<k>, … equals syntax
      const eq = t.indexOf("=");
      if (eq > 2) {
        const key = t.slice(2, eq).toLowerCase();
        const val = t.slice(eq + 1);
        if (["model", "opus", "haiku", "key", "cwd"].includes(key)) {
          if (key === "opus") spec.opus = val;
          else if (key === "haiku") spec.haiku = val;
          else if (key === "key") spec.key = val;
          else if (key === "cwd") spec.cwd = val;
          else spec.model = val;
          i++;
          continue;
        }
      }
      const key = t.slice(2).toLowerCase();
      const alias = resolveProvider(key);
      if (alias) {
        spec.provider = alias;
        i++;
        continue;
      }
      const needsValue = ["model", "opus", "haiku", "key", "cwd"].includes(key);
      if (needsValue) {
        const val = tokens[i + 1];
        if (val === undefined || val.startsWith("--")) {
          console.error(`${red(`missing value for ${t}`)}`);
          process.exit(2);
        }
        if (key === "opus") spec.opus = val;
        else if (key === "haiku") spec.haiku = val;
        else if (key === "key") spec.key = val;
        else if (key === "cwd") spec.cwd = val;
        else if (key === "model") spec.model = val;
        i += 2;
        continue;
      }
      // Unknown flag — could be a model id shorthand like --nvidia/nemotron-3.5-….
      // Keep it and resolve against the live catalog after models are fetched;
      // anything that matches no model is forwarded to Claude Code (which also
      // keeps bare `--`-swallowed PowerShell passthrough working).
      spec.deferredFlags.push(t);
      i++;
      continue;
    }
    if (t.startsWith("-")) {
      // single-dash Claude flags (e.g. -p) — passthrough with the remainder
      rest.push(t, ...tokens.slice(i + 1));
      break;
    }
    // positional tokens
    if (!spec.app) {
      spec.app = t;
      i++;
      continue;
    }
    const asProvider = resolveProvider(t);
    if (!spec.provider && asProvider) {
      spec.provider = asProvider;
      i++;
      continue;
    }
    if (!spec.key) {
      spec.key = t;
      i++;
      continue;
    }
    rest.push(t, ...tokens.slice(i + 1));
    break;
  }

  if (rest.length) {
    spec.claudeArgs = rest;
  }
  return spec;
}

/**
 * Resolve a model shorthand against the provider's model list.
 *   "nvidia/nemotron-3.5-bolt-e4b"   exact match
 *   "nemotron-3.5-bolt-e4b"          suffix match (org omitted)
 * Anything model-shaped (org/id) is accepted even if absent from the list so
 * users can pick rotated models the catalog doesn't advertise.
 */
export function matchModelToken(
  models: string[],
  name: string,
): { id: string; inList: boolean } | { ambiguous: string[] } | null {
  const n = name.toLowerCase();
  const exact = models.filter((m) => m.toLowerCase() === n);
  if (exact.length) return { id: exact[0], inList: true };
  const bySuffix = models.filter((m) => m.toLowerCase().endsWith("/" + n));
  if (bySuffix.length === 1) return { id: bySuffix[0], inList: true };
  const fuzzy = models.filter((m) => m.toLowerCase().includes(n));
  if (fuzzy.length === 1) return { id: fuzzy[0], inList: true };
  if (fuzzy.length > 1) return { ambiguous: fuzzy.slice(0, 8) };
  if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(name)) return { id: name, inList: false };
  return null;
}

async function cmdLaunch(tokens: string[]): Promise<void> {
  const spec = parseLaunch(tokens);

  if (!spec.app || !(spec.app === "claude" || spec.app === "cc")) {
    console.error(red("usage: max launch claude <provider> [API_KEY] [flags]"));
    process.exit(2);
  }
  if (!spec.provider) {
    console.error(red("no provider given."));
    console.error(yellow(`  e.g.  max launch claude --nvidia | --groq | --ollama | --openrouter`));
    process.exit(2);
  }
  const p = spec.provider;

  console.log(`\n${bold(`⚡ max ${VERSION}`)} ${dim("→")} ${cyan(p.name)}`);

  // ---- key ----
  let key = "";
  if (p.requiresKey) {
    if (spec.dryRun && !spec.key && !storedSecret(p)) {
      console.log(`  ${yellow("key")} ${dim("none stored yet (dry run — would prompt interactively)")}`);
    } else {
      key = await resolveKey(p, { inline: spec.key, save: spec.save });
    }
  } else {
    console.log(`  ${green("key")} ${dim("not needed (local)")}`);
  }

  // ---- models (live discovery) ----
  console.log(`  ${dim("fetching available models…")}`);
  let models: ModelListResult["models"];
  try {
    const r = await getModels(p, { key: key || undefined, refresh: spec.refresh });
    models = r.models;
    const srcNote =
      r.source === "live"
        ? green("live")
        : r.source === "cache"
          ? dim("cached")
          : yellow(`bundled snapshot ${BUNDLED_AS_OF}`);
    console.log(`  ${green("models")} ${dim(`${models.length} available (${srcNote}${r.error ? `, ${r.error}` : ""})`)}`);
  } catch (err: any) {
    console.error(`  ${red(err.message ?? String(err))}`);
    console.error(`  ${dim(`max could not discover models for ${p.name}.`)}`);
    if (p.id === "ollama") {
      console.error(`  ${dim("start Ollama ( launches at login on Windows) and pull a model, e.g.:")}`);
      console.error(`  ${dim("    ollama pull qwen3-coder:30b")}`);
    }
    process.exit(1);
  }

  // model shorthands like --nvidia/nemotron-3.5-bolt-e4b or --kimi-k3
  for (const deferred of spec.deferredFlags) {
    const name = deferred.replace(/^--/, "");
    const res = matchModelToken(models, name);
    if (res && "ambiguous" in res) {
      console.error(`  ${red(`${deferred} matches several models — be more specific:`)}`);
      for (const m of res.ambiguous) console.error(`    ${m}`);
      process.exit(2);
    }
    if (res && res.id) {
      if (!spec.model) {
        spec.model = res.id;
        console.log(`  ${green("model")} ${dim(`${res.id} (from ${deferred})`)}`);
      } else {
        console.log(`  ${yellow("note")} ${dim(`${deferred} ignored — a model was already chosen`)}`);
      }
      if (!res.inList) {
        console.log(`  ${yellow("note")} ${dim(`${res.id} is not in ${p.name}'s current catalog — using it anyway`)}`);
      }
    } else {
      // not a model → forward to Claude Code like before
      spec.claudeArgs.push(deferred);
    }
  }

  const picks = pickTiers(p, models);
  const cfgPrefs = loadConfig().prefs[p.id] ?? {};
  const tier = {
    model: spec.model ?? cfgPrefs.model ?? picks.model,
    opus: spec.opus ?? cfgPrefs.opus ?? picks.opus,
    haiku: spec.haiku ?? cfgPrefs.haiku ?? picks.haiku,
  };
  for (const [name, value] of Object.entries(tier)) {
    if (!value) {
      console.error(`  ${red(`no ${name} model could be chosen`)} — pass ${bold(`--${name} M`)} explicitly`);
      process.exit(1);
    }
  }
  console.log(
    `  ${green("tiers")} ${dim(`sonnet=${tier.model} | opus=${tier.opus} | haiku=${tier.haiku}`)}`,
  );

  // ---- claude ----
  const claudeInfo = ensureClaudeInstalled({ dryRun: spec.dryRun });
  if (claudeInfo) {
    console.log(`  ${green("claude")} ${dim(`v${claudeInfo.version}${claudeInfo.installedNow ? " (installed just now)" : ""}`)}`);
  } else {
    console.log(`  ${yellow("claude")} ${dim("not installed (skipped because --dry-run)")}`);
  }

  if (spec.dryRun) {
    console.log(`\n${bold("dry run — env that would be set:")}`);
    const { overrides } = buildEnv(tier, { url: "http://127.0.0.1:PORT", key: key || "x" });
    for (const [k, v] of Object.entries(overrides)) console.log(`   ${cyan(k.padEnd(40))} ${dim(String(v))}`);
    console.log(`\n${dim(`claude would run with args: ${(spec.claudeArgs.length ? spec.claudeArgs : ["—"]).join(" ")}`)}`);
    console.log(`\nRun without ${bold("--dry-run")} to launch.`);
    return;
  }

  // ---- proxy ----
  const proxyOpts: ProxyOptions = {
    label: p.name,
    targetBaseUrl: p.baseUrl,
    apiKey: key,
    reasoningEffort: p.reasoningEffort,
    chatTemplateThinking: p.chatTemplateThinking,
    verbose: spec.verbose,
  };
  const proxy = await startProxy(proxyOpts);
  console.log(`  ${green("proxy")} ${dim(`${proxy.url}   (Anthropic ⇄ OpenAI bridge, local only)`)}`);

  const { env } = buildEnv(tier, { url: proxy.url, key: key || "max" });
  const banner = [
    "",
    `${bold("  Claude Code is starting…")}`,
    `  ${dim("exit with Ctrl+C or /exit. Provider requests stay on your machine —")} ${dim("the proxy runs at 127.0.0.1 only.")}`,
    "",
  ];
  console.log(banner.join("\n"));

  const code = await spawnClaude({
    claudeArgs: spec.claudeArgs,
    env,
    cwd: spec.cwd,
  });
  proxy.close();
  process.exit(code);
}

interface ModelListResult {
  models: string[];
  source: string;
  error?: string;
}

function buildEnv(
  tier: { model: string; opus: string; haiku: string },
  proxy: { url: string; key: string },
): { env: NodeJS.ProcessEnv; overrides: Record<string, string> } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.ANTHROPIC_BEDROCK_BASE_URL;

  const overrides: Record<string, string> = {
    ANTHROPIC_BASE_URL: proxy.url,
    ANTHROPIC_AUTH_TOKEN: proxy.key || "max",
    ANTHROPIC_MODEL: tier.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: tier.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: tier.opus,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: tier.haiku,
    ANTHROPIC_SMALL_FAST_MODEL: tier.haiku,
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  Object.assign(env, overrides);
  return { env, overrides };
}

// ---------------- key command ----------------

interface KeySpec {
  provider?: ProviderDef;
  key?: string;
}

function parseKey(tokens: string[], wantsValue: boolean): KeySpec {
  const spec: KeySpec = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const p = resolveProvider(t);
      if (p) {
        spec.provider = p;
        continue;
      }
      console.error(red(`unknown flag ${t}`));
      process.exit(2);
    }
    const asProvider = resolveProvider(t);
    if (!spec.provider && asProvider) {
      spec.provider = asProvider;
      continue;
    }
    if (wantsValue && !spec.key) {
      spec.key = t;
      continue;
    }
    console.error(red(`unexpected token “${t}”`));
    process.exit(2);
  }
  return spec;
}

async function cmdKey(tokens: string[]): Promise<void> {
  const action = tokens.shift();
  if (!action) {
    console.error(`usage: max key ${cyan("set|get|clear")} <provider> [API_KEY]`);
    process.exit(2);
  }
  const spec = parseKey(tokens, action === "set");
  if (!spec.provider) {
    console.error(red(`missing provider — e.g. max key ${action} --nvidia`));
    process.exit(2);
  }
  const p = spec.provider;
  if (action === "set") {
    let secret = spec.key;
    if (!secret) secret = await ask(`Paste ${p.name} API key (${p.keyHint ?? "api key"}): `, { mask: true });
    if (!secret) {
      console.error(red("empty key — not stored"));
      process.exit(1);
    }
    const backend = setSecret(p.id, secret);
    console.log(green(`✓ ${p.name} key stored (${backend === "vault" ? "Windows Credential Manager" : keyringFileForDisplay()})`));
    console.log(`  next time: ${cyan(`${CONTAINER_BIN} launch claude --${p.aliases[0] ?? p.id} — the key is remembered`)}`);
    return;
  }
  if (action === "get") {
    const s = storedSecret(p);
    if (!s) {
      console.log(`no ${p.name} key stored`);
      process.exit(1);
    }
    console.log(`${p.name} key: ${maskSecret(s)}`);
    return;
  }
  if (action === "clear") {
    removeSecret(p.id);
    console.log(green(`✓ ${p.name} key removed`));
    return;
  }
  console.error(red(`unknown key action "${action}" (use set|get|clear)`));
  process.exit(2);
}

// ---------------- models command ----------------

async function cmdModels(tokens: string[]): Promise<void> {
  let refresh = false;
  let provider: ProviderDef | undefined;
  for (const t of tokens) {
    if (t === "--refresh") refresh = true;
    else if (t.startsWith("--")) {
      const p = resolveProvider(t);
      if (p) provider = p;
      else {
        console.error(red(`unknown flag ${t}`));
        process.exit(2);
      }
    } else if (!provider && resolveProvider(t)) provider = resolveProvider(t)!;
    else {
      console.error(red(`unexpected token “${t}”`));
      process.exit(2);
    }
  }

  const list = provider ? [provider] : PROVIDERS;
  for (const p of list) {
    console.log(`\n${bold(p.name)} ${dim(`(${p.id})`)}`);
    let res: Awaited<ReturnType<typeof getModels>>;
    let key: string | undefined;
    if (p.requiresKey) key = storedSecret(p) ?? undefined;
    try {
      res = await getModels(p, { key, refresh });
    } catch (err: any) {
      console.log(`  ${red("unavailable")}: ${err?.message ?? err}`);
      if (p.id === "ollama") console.log(`  ${dim("is Ollama running? try:  ollama serve  then retry")}`);
      continue;
    }
    const src =
      res.source === "live"
        ? green("live")
        : res.source === "cache"
          ? dim("cached")
          : yellow(`bundled ${BUNDLED_AS_OF}`);
    console.log(`  ${dim(`${res.models.length} models, source: ${src}${res.error ? `, fallback (${res.error})` : ""}`)}`);
    const marks = tierMarks(p, res.models);
    for (const m of res.models) {
      const t = (marks[m] ?? []).map((x) => x[0]).join("");
      console.log(`  ${t.padEnd(4)} ${m}`);
    }
    console.log(dim(`  [h]aiku [s]onnet [o]pus = Claude Code tier auto-picks; override at launch with --model/--opus/--haiku`));
  }
}

// ---------------- providers / set / doctor / proxy ----------------

async function cmdProviders(): Promise<void> {
  console.log(bold("providers available in max:\n"));
  for (const p of PROVIDERS) {
    console.log(`  ${cyan(p.id.padEnd(12))} ${bold(p.name.padEnd(16))} ${dim(`alias: ${p.aliases.join(", ")}`)}`);
    console.log(`  ${"".padEnd(13)} ${dim(p.baseUrl)}`);
    if (p.requiresKey) {
      console.log(`  ${"".padEnd(13)} ${dim(`key: ${p.keyUrl ?? "(required)"}`)}`);
    }
    if (p.note) console.log(`  ${"".padEnd(13)} ${dim(p.note)}`);
    console.log("");
  }
}

async function cmdSet(tokens: string[]): Promise<void> {
  let provider: ProviderDef | undefined;
  const patch: { model?: string; opus?: string; haiku?: string } = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--model")) patch.model = tokens[++i];
    else if (t.startsWith("--opus")) patch.opus = tokens[++i];
    else if (t.startsWith("--haiku")) patch.haiku = tokens[++i];
    else {
      const p = resolveProvider(t);
      if (!provider && p) provider = p;
      else {
        console.error(red(`unexpected token “${t}”`));
        process.exit(2);
      }
    }
  }
  if (!provider || (!patch.model && !patch.opus && !patch.haiku)) {
    console.error(`usage: max set ${cyan("<provider>")} ${dim("[--model M] [--opus M] [--haiku M]")}   ${dim("(writes ~/.max/config.json)")}`);
    process.exit(2);
  }
  setProviderPrefs(provider.id, patch);
  console.log(green(`✓ ${provider.name} defaults saved:`));
  console.log(dim(JSON.stringify(loadConfig().prefs[provider.id], null, 2)));
}

async function cmdDoctor(): Promise<void> {
  const { hasCommand } = await import("./claude");
  const { claudeVersion } = await import("./claude");
  console.log(`\n${bold("max doctor")}\n`);

  const nodeOk = Number(process.versions.node.split(".")[0]) >= 20;
  console.log(` node   ${nodeOk ? green(process.versions.node) : red(`${process.versions.node} (need >=20)`)}`);
  console.log(` npm    ${hasCommand("npm") ? green("found") : red("missing")}`);
  const cv = claudeVersion();
  console.log(` claude ${cv ? green(`v${cv}`) : yellow("not installed (max will auto-install it on first launch)")}`);

  // ollama
  const hasOllama = hasCommand("ollama");
  if (hasOllama) {
    let reachable = false;
    try {
      await fetch("http://127.0.0.1:11434/api/version", { signal: AbortSignal.timeout(1500) });
      reachable = true;
    } catch {}
    console.log(` ollama ${hasOllama ? green("installed") : dim("?")} · server ${reachable ? green("running") : yellow("not reachable (" + "start the Ollama app or `ollama serve`" + ")")}`);
  } else {
    console.log(` ollama ${dim("not installed (optional, only needed for --ollama)")}`);
  }

  // keys
  console.log("");
  for (const p of PROVIDERS) {
    if (!p.requiresKey) {
      console.log(` key × ${cyan(p.id.padEnd(12))} ${dim("not required")}`);
      continue;
    }
    const s = storedSecret(p);
    console.log(` key    ${cyan(p.id.padEnd(12))} ${s ? green(maskSecret(s) + " (remembered)") : yellow("not set")}`);
  }

  // cache
  const cachePath = path.join(configDir(), "models-cache.json");
  let cache: Record<string, { fetchedAt: number; live: boolean; models: string[] }> = {};
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {}
  console.log("");
  for (const [id, v] of Object.entries(cache)) {
    const age = Math.round((Date.now() - v.fetchedAt) / 1000);
    console.log(` models ${cyan(id.padEnd(12))} ${dim(`${v.models.length} models, ${age < 60 ? `${age}s` : `${Math.round(age / 60)}min`} ago, ${v.live ? "live" : "bundled"}`)}`);
  }
  console.log(`\n config ${dim(configDir())}`);
  console.log("");
}

async function cmdProxy(tokens: string[]): Promise<void> {
  let target = "";
  let key = "";
  let verbose = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--target") target = tokens[++i] ?? "";
    else if (t === "--key") key = tokens[++i] ?? "";
    else if (t === "--verbose") verbose = true;
    else {
      console.error(red(`unknown token ${t}`));
      process.exit(2);
    }
  }
  if (!target) {
    console.error(`usage: max proxy ${cyan("--target")} ${dim("https://api.groq.com/openai/v1")} --key <k> ${dim("[--verbose]")}`);
    process.exit(2);
  }
  const handle = await startProxy({
    label: "manual",
    targetBaseUrl: target,
    apiKey: key,
    verbose,
    onActivity: ({ path, status, ms }) =>
      console.error(dim(`${path} → ${status} (${ms}ms)`)),
  });
  console.log(green(`✓ max proxy listening on ${handle.url}`));
  console.log(dim(`point Claude Code at it:  ANTHROPIC_BASE_URL=${handle.url} ANTHROPIC_AUTH_TOKEN=${key ? "k" : "k"} claude`));
  console.log(dim("Press Ctrl+C to stop."));
  process.on("SIGINT", () => {
    handle.close();
    process.exit(0);
  });
}

// ---------------- main dispatch ----------------

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd) usage(0);

  switch (cmd) {
    case "launch":
    case "l":
      return await cmdLaunch(rest);
    case "key":
    case "keys":
      return await cmdKey(rest);
    case "models":
    case "list":
      return await cmdModels(rest);
    case "providers":
    case "ps":
      return await cmdProviders();
    case "set":
      return await cmdSet(rest);
    case "doctor":
    case "dr":
      return await cmdDoctor();
    case "proxy":
      return await cmdProxy(rest);
    case "help":
    case "--help":
    case "-h":
      usage(0);
    case "--version":
    case "-v":
    case "version":
      console.log(VERSION);
      return;
    default:
      console.error(`${red(`unknown command “${cmd}”`)}\n`);
      usage(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(red(`max: ${err?.message ?? err}`));
    process.exit(1);
  });
}
