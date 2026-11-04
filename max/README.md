# max

**`max` is a tiny CLI that launches [Claude Code](https://code.claude.com) on free AI providers** — NVIDIA NIM, Groq, Ollama (local), OpenRouter — with one command:

```
max launch claude --nvidia "nvapi-xxxxxxxx"
```

The first time you pass a key, `max` remembers it (Windows Credential Manager). After that it's just:

```
max launch claude --nvidia
```

---

## How it works

Claude Code speaks the **Anthropic** Messages API; most free providers speak the **OpenAI** Chat Completions API. `max` runs a tiny local translation proxy and launches Claude Code pointed at it:

```
┌─────────────┐  Anthropic   ┌─────────────┐   OpenAI    ┌─────────────────────┐
│ Claude Code │ ───────────▶ │  max proxy  │ ──────────▶ │ NVIDIA NIM / Groq / │
│             │ ◀─────────── │ (127.0.0.1) │ ◀────────── │ Ollama / OpenRouter │
└─────────────┘  Anthropic   └─────────────┘   OpenAI    └─────────────────────┘
```

- The proxy listens on `127.0.0.1` only — your key and traffic stay on your machine.
- It translates system messages, images, tool definitions, `tool_use`/`tool_result` blocks, streaming tool-call deltas, thinking/reasoning (thinking-tag reasoning, NVIDIA/Ollama/Groq `reasoning_content`), usage, and `count_tokens`.
- Claude Code is auto-installed via npm if it's missing.

## Install

Requires [Node.js](https://nodejs.org) >= 20.

```powershell
npm install -g huzea
```

Now `max` is on your PATH.

<details>
<summary>Install from source instead</summary>

```powershell
cd max
npm install
npm run build
npm install -g .
```

</details>

## Quick start

```powershell
# NVIDIA NIM (free credits at https://build.nvidia.com — key starts with nvapi-)
max launch claude --nvidia "nvapi-xxxxxxxx"      # first time, key is remembered
max launch claude --nvidia                       # after that

# Groq (free key at https://console.groq.com/keys — key starts with gsk_)
max launch claude --groq

# Ollama (no key, fully free & local — pull a model first: ollama pull qwen3-coder:30b)
max launch claude --ollama

# OpenRouter (free key at https://openrouter.ai/keys — uses ":free" models)
max launch claude --openrouter
```

Interactive Claude Code starts. Exit with `Ctrl+C` or `/exit`.

### Model selection

`max` auto-picks sonnet/opus/haiku tiers, but you can always choose the model yourself:

```powershell
# classic way
max launch claude --nvidia --model openai/gpt-oss-120b

# model shorthand — just put the model id after the provider, org optional
max launch claude --nvidia-nim --nvidia/nemotron-3.5-super-vl-120b-a12b
max launch claude --nvidia-nim --nemotron-3.5-super-vl-120b-a12b
max launch claude --nvidia --model=nvidia/nemotron-3.5-super-vl-120b-a12b

# extra tiers
max launch claude --groq --model openai/gpt-oss-120b --haiku openai/gpt-oss-20b --opus openai/gpt-oss-120b
```

Shorthands are matched against the provider's **live catalog**: exact id, then
`org/model-id` with the org omitted, then a unique substring match. If it's
ambiguous you get the list of candidates; a well-formed `org/model-id` is used
as-is even when it isn't in the catalog. Unknown flags that match no model are
passed through to Claude Code (e.g. `--dangerously-skip-permissions`).

### Pass Claude Code arguments through

Everything after `--` goes straight to Claude Code (this also works in PowerShell, which normally swallows `--`):

```powershell
max launch claude --groq -- -p "explain this repo"
max launch claude --nvidia -- --resume
```

## Commands

| Command | What it does |
|---|---|
| `max launch claude <provider> [KEY]` | Launch Claude Code on a provider (see flags below) |
| `max key set --<provider> [KEY]` | Store an API key (masked prompt if KEY omitted) |
| `max key get --<provider>` | Show a masked key + where it's stored |
| `max key clear --<provider>` | Delete the stored key |
| `max models [provider] [--refresh]` | Show live model lists + auto tier picks |
| `max providers` | List supported providers & key URLs |
| `max set <provider> --model M --opus M --haiku M` | Save your preferred models in `~/.max/config.json` |
| `max doctor` | Check node/npm/claude/ollama/keys/model cache |
| `max proxy --target <url> --key K` | Run the translation proxy standalone (advanced) |

### Launch flags

```
max launch claude --nvidia "nvapi-..." [--model M] [--opus M] [--haiku M]
                                        [--cwd DIR] [--save|--no-save]
                                        [--dry-run] [--verbose] [--refresh-models]
                                        [-- <claude args...>]
```

- `--model` – primary (sonnet-tier) model; also accepts shorthand `--org/model-id` flags
- `--opus` – strongest model (used for `opusplan` / plan mode)
- `--haiku` – fast model for Claude Code's background tasks
- `--save` / `--no-save` – whether to remember a freshly entered key (default: asks)
- `--dry-run` – print the env vars and exit without launching
- `--verbose` – log every proxied request to stderr
- `--refresh-models` – bypass the 24h model cache and refetch

## Model auto-discovery

Model catalogs at these providers change weekly, so `max` **fetches the live model list at launch** and auto-picks:

- **sonnet** → best balanced coding/tool-calling model
- **opus** → the strongest available model
- **haiku** → a small/fast model for background tasks

…based on per-provider scoring rules. Results are cached for 24 h in `~/.max/models-cache.json`. If a provider's `/models` endpoint fails, a dated bundled snapshot is used instead. Preview and tune with:

```powershell
max models groq            # [h]/[s]/[o] marks show the auto-picks
max launch claude --groq --model openai/gpt-oss-120b --haiku openai/gpt-oss-20b
max set nvidia-nim --model moonshotai/kimi-k3        # persist your preference
```

Overriding precedence: CLI flag > `~/.max/config.json` > auto-pick.

## API key storage

- Keys are stored in **Windows Credential Manager** (via the WinRT `PasswordVault`, no extra dependencies).
- If that's unavailable (or on macOS/Linux), `max` falls back to `~/.max/keyring.json` with a warning — delete it when you don't need it anymore.
- `max key get/clear` manage stored keys; config lives in `~/.max/`.

## Providers & where to get free keys

| Provider | Aliases | Key from | Notes |
|---|---|---|---|
| NVIDIA NIM | `--nvidia`, `--nim` | https://build.nvidia.com | Free credits, `nvapi-…` keys, huge catalog |
| Groq | `--groq` | https://console.groq.com/keys | Free developer-plan rate limits, extremely fast |
| Ollama | `--ollama` | not needed | Local; run the Ollama app (or `ollama serve`) and `ollama pull` a model |
| OpenRouter | `--openrouter` | https://openrouter.ai/keys | Serves every `:free` community model |

## Troubleshooting

- **`claude` not found / not on PATH after first install** — open a NEW terminal, run again.
- **401/403 from provider** — wrong/expired key: `max key clear --nvidia` then set it again, or pass it inline.
- **429 rate limit** — you're hitting the free tier cap; wait, pick a smaller `--model`, or switch providers.
- **"Claude Code doesn't recognize the model X"** — informational only; Claude Code assumes a 200k window and continues. Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` if you want tighter auto-compaction.
- **Ollama: "no models are pulled yet"** — `ollama pull qwen3-coder:30b` (or any instruct model), or launch with `--model <name>`.
- **Model output includes tool-call JSON as text** — that provider/model combination handles tools poorly; pick a different model with `--model`.
- **Something else?** run `max doctor`, and `max launch … --verbose` to see proxy logs.

## For developers

```powershell
npm install          # dev deps: esbuild, typescript
npm run build        # bundle -> dist/max.js
npm run typecheck    # tsc --noEmit
npm test             # mock-provider integration tests (31 assertions)
node test/live-ollama.mjs   # live e2e against a local Ollama
```

Architecture map:

```
src/
├── cli.ts        arg parsing, launch orchestration, all commands
├── proxy.ts      the Anthropic <-> OpenAI translation server
├── providers.ts  provider registry + live model discovery + tier auto-pick
├── keyring.ts    Windows Credential Manager (PasswordVault) + file fallback
├── config.ts     ~/.max/config.json + JSON cache helpers
├── prompts.ts    masked input prompts
├── claude.ts     claude detect / install / spawn
└── colors.ts     tiny ANSI helpers
```

## Publish

Already published on npm as **huzea**. To release an update:

```powershell
npm version patch    # or minor / major
npm publish
```

So anyone can `npm i -g huzea` and use `max` immediately.

## License

MIT — do whatever you want, no warranty. Free models are subject to each provider's terms and rate limits.
