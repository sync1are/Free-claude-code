# Free Claude Code

Run **Claude Code on free AI providers** — NVIDIA NIM, Groq, Ollama (local), OpenRouter — with one command and a built-in Anthropic ⇄ OpenAI translation proxy.

```powershell
npm install -g huzea
max launch claude --nvidia "nvapi-xxxxxxxx"   # first time: key remembered
max launch claude --nvidia                    # after that
max launch claude --ollama                    # fully free & local, no key
```

Full documentation: [`max/README.md`](./max/README.md)

## What's inside

```
max/
├── src/cli.ts        the "max" command, launch orchestration
├── src/proxy.ts      Anthropic ⇄ OpenAI translation server
├── src/providers.ts  providers + live model auto-discovery
├── src/keyring.ts    Windows Credential Manager key storage
├── test/             31-assertion integration suite + live Ollama e2e
└── README.md         full docs
```

Published on npm as **[huzea](https://www.npmjs.com/package/huzea)** (the command stays `max`). MIT licensed.
