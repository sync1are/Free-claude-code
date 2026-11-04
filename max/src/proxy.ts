// max translation proxy
//
// Claude Code speaks the Anthropic Messages API. NVIDIA NIM / Groq / Ollama /
// OpenRouter speak the OpenAI Chat Completions API. This little local server
// sits in between:
//
//   claude  --Anthropic-->  proxy  --OpenAI-->  provider
//   claude  <--Anthropic--  proxy  <--OpenAI--  provider
//
// It handles: system messages, images, tool definitions, tool_use /
// tool_result blocks, tool-call streaming (OpenAI index-based deltas ->
// Anthropic content blocks), thinking/reasoning deltas (including `ull
// tags from Ollama-style models), usage mapping, count_tokens, and
// passthrough for /v1/models and /v1/chat/completions.

import http from "node:http";
import crypto from "node:crypto";

export interface ProxyOptions {
  label: string;
  /** OpenAI-compatible base, e.g. https://api.groq.com/openai/v1 */
  targetBaseUrl: string;
  apiKey: string;
  reasoningEffort?: boolean;
  chatTemplateThinking?: boolean;
  verbose?: boolean;
  /**
   * Fallback ladders per requested model id. When a provider answers
   * 4xx "model unavailable / end of life", the proxy retries the next entry.
   */
  modelFallbacks?: Record<string, string[]>;
  /** called each time a model id is rejected as retired/EOL/unknown upstream */
  onDeadModel?: (model: string) => void;
  onActivity?: (info: { path: string; status: number; ms: number }) => void;
}

export interface ProxyHandle {
  port: number;
  url: string;
  close(): void;
}

// ---------------- helpers ----------------

const UA = "max-proxy/0.1";

function joinUrl(base: string, p: string): string {
  return base.replace(/\/+$/, "") + p;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function jsonWrite(res: http.ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function anthropicErrorTypeFor(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 503 || status === 529) return "overloaded_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "api_error";
}

function sendAnthropicError(res: http.ServerResponse, status: number, message: string): void {
  jsonWrite(res, status >= 400 ? status : 500, {
    type: "error",
    error: { type: anthropicErrorTypeFor(status), message: `max proxy: ${message}` },
  });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj ?? "").length / 4);
}

/** Did the provider reject the model itself (as opposed to the request or key)? */
function isModelUnavailable(up: Response, body: string): boolean {
  if (up.status === 404 || up.status === 410) return true;
  return /end of life|no longer available|model(\s|_|-|)*(not|no longer).{0,20}(available|exist|supported)|unsupported model|invalid model|unknown model|model_not_found|deprecat/i.test(
    body,
  );
}

function stripSchemaExtras(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const clone = JSON.parse(JSON.stringify(schema));
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return void node.forEach(walk);
    delete node.$schema;
    delete node.format;
    for (const v of Object.values(node)) walk(v);
  };
  walk(clone);
  return clone;
}

function dataUrl(block: any): string {
  const media = block?.source?.media_type ?? "image/png";
  const data = block?.source?.data ?? "";
  return `data:${media};base64,${data}`;
}

function blocksOf(content: unknown): any[] {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

// ---------------- Anthropic -> OpenAI ----------------

function mapToolChoice(tc: any): unknown {
  if (tc === "auto" || tc === "none") return tc;
  if (tc === "any") return "required";
  if (tc && typeof tc === "object" && tc.type === "tool" && tc.name)
    return { type: "function", function: { name: tc.name } };
  return "auto";
}

function toolResultText(block: any): string {
  const parts = blocksOf(block.content);
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === "text") out.push(String(p.text ?? ""));
    else if (p.type === "image") out.push("[image omitted in tool result]");
    else if (p.type === "document") out.push("[document omitted]");
    else out.push("");
  }
  const joined = out.join("\n\n");
  return joined.length ? joined : "(empty tool result)";
}

export function anthropicToOpenai(ant: any, opts: ProxyOptions): any {
  const out: any = {
    model: ant.model,
    stream: !!ant.stream,
    max_tokens: typeof ant.max_tokens === "number" ? ant.max_tokens : 8192,
  };
  if (typeof ant.temperature === "number") out.temperature = ant.temperature;
  if (typeof ant.top_p === "number") out.top_p = ant.top_p;
  if (Array.isArray(ant.stop_sequences) && ant.stop_sequences.length) out.stop = ant.stop_sequences;
  if (ant.tool_choice !== undefined) out.tool_choice = mapToolChoice(ant.tool_choice);

  if (ant.thinking && typeof ant.thinking === "object") {
    const budget = ant.thinking.budget_tokens ?? 4000;
    if (ant.thinking.type === "enabled") {
      if (opts.reasoningEffort) {
        out.reasoning_effort = budget > 16_000 ? "high" : budget > 4_000 ? "medium" : "low";
      } else if (opts.chatTemplateThinking) {
        out.chat_template_kwargs = { thinking: true };
      }
    }
  }

  // tools
  if (Array.isArray(ant.tools) && ant.tools.length > 0) {
    out.tools = ant.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: stripSchemaExtras(t.input_schema ?? { type: "object", properties: {} }),
      },
    }));
  }

  const messages: any[] = [];

  // system -> system message(s)
  const sys = blocksOf(ant.system);
  if (sys.length) {
    const text = sys
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("\n\n");
    if (text.trim()) messages.push({ role: "system", content: text });
  }

  for (const m of ant.messages ?? []) {
    if (m.role === "user") emitUser(m, messages);
    else if (m.role === "assistant") emitAssistant(m, messages);
  }

  out.messages = messages;
  return out;
}

function emitUser(m: any, messages: any[]): void {
  const src = blocksOf(m.content);
  const texts: string[] = [];
  const images: any[] = [];

  for (const b of src) {
    switch (b.type) {
      case "text":
        if (b.text != null && b.text !== "") texts.push(String(b.text));
        break;
      case "image":
        images.push({ type: "image_url", image_url: { url: dataUrl(b) } });
        break;
      case "document":
        texts.push("[document omitted]");
        break;
      case "tool_result":
        // OpenAI wants role:"tool" messages following the assistant tool_calls
        messages.push({
          role: "tool",
          tool_call_id: String(b.tool_use_id ?? ""),
          content: toolResultText(b),
        });
        break;
      default:
        break;
    }
  }

  if (texts.length || images.length) {
    let content: unknown;
    if (images.length) {
      const parts: any[] = [];
      if (texts.length) parts.push({ type: "text", text: texts.join("\n\n") });
      parts.push(...images);
      content = parts;
    } else {
      content = texts.join("\n\n");
    }
    if (content === "") content = "(empty message)";
    messages.push({ role: "user", content });
  }
}

function emitAssistant(m: any, messages: any[]): void {
  const texts: string[] = [];
  const toolCalls: any[] = [];

  for (const b of blocksOf(m.content)) {
    switch (b.type) {
      case "text":
        if (b.text) texts.push(String(b.text));
        break;
      case "tool_use":
        toolCalls.push({
          id: String(b.id ?? `call_${crypto.randomBytes(6).toString("hex")}`),
          type: "function",
          function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) },
        });
        break;
      case "thinking":
      case "redacted_thinking":
      case "server_tool_use":
      case "web_search_tool_result":
      default:
        break;
    }
  }

  if (!texts.length && !toolCalls.length) return; // skip empty assistant turns

  const msg: any = { role: "assistant", content: texts.join("\n\n") };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  messages.push(msg);
}

// ---------------- OpenAI -> Anthropic ----------------

function mapFinish(finish: unknown, content: any[]): string {
  if (finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  if (finish === "stop" || finish === null || finish === undefined) {
    return content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn";
  }
  return "end_turn";
}

export function openaiToAnthropic(j: any, fallbackModel: string): any {
  const choice = j?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: any[] = [];

  const thinking = typeof msg.reasoning === "string" ? msg.reasoning : typeof msg.reasoning_content === "string" ? msg.reasoning_content : null;
  if (thinking && thinking.trim()) content.push({ type: "thinking", thinking });

  if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content });
  else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p?.type === "text" && p.text) content.push({ type: "text", text: p.text });
    }
  }

  for (const tc of msg.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = tc?.function?.arguments
        ? JSON.parse(tc.function.arguments)
        : {};
    } catch {
      input = { _raw_arguments: tc?.function?.arguments ?? "" };
    }
    content.push({
      type: "tool_use",
      id: tc?.id ?? `toolu_${crypto.randomBytes(8).toString("hex")}`,
      name: tc?.function?.name ?? "",
      input,
    });
  }

  const usage = j?.usage ?? {};
  return {
    id: j?.id ?? `msg_max_${crypto.randomBytes(8).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: j?.model ?? fallbackModel,
    content,
    stop_reason: mapFinish(choice.finish_reason, content),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

// ---------------- streaming translator ----------------

interface ToolBlockState {
  anthropicIndex: number;
  argsSoFar: string;
  name: string;
  id: string;
}

// Model text sometimes contains <aghantha>...</aghantha> blocks (Ollama-style
// reasoning models). Route those into Anthropic thinking deltas.
const THINK_TAG_OPEN = "<aghantha>"; // eslint-disable-line no-restricted-syntax
const THINK_TAG_CLOSE = "</aghantha>"; // eslint-disable-line no-restricted-syntax

function stripThinkTagResidue(s: string): string {
  return s.replace(/(<\/?aghantha>|<aghantha|<\/aghantha)/g, "");
}

class StreamState {
  private res: http.ServerResponse;
  private model: string;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private thinkIndex: number | null = null;
  private thinkingTag: "none" | "open" = "none"; // inside <aghantha> region
  private tools = new Map<string | number, ToolBlockState>();
  private finishReason: unknown = null;
  private usage: any = null;
  private started = false;
  private inTokens: number;

  constructor(res: http.ServerResponse, model: string, inTokens: number) {
    this.res = res;
    this.model = model;
    this.inTokens = inTokens;
  }

  begin(): void {
    this.started = true;
    emit(this.res, "message_start", {
      type: "message_start",
      message: {
        id: `msg_max_${crypto.randomBytes(8).toString("hex")}`,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inTokens, output_tokens: 0 },
      },
    });
    emit(this.res, "ping", { type: "ping" });
  }

  private emitStart(index: number, block: Record<string, unknown>): void {
    emit(this.res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: block,
    });
  }

  private stopBlock(index: number | null): void {
    if (index === null) return;
    emit(this.res, "content_block_stop", { type: "content_block_stop", index });
  }

  private openText(): number {
    if (this.textIndex !== null) return this.textIndex;
    // opening text while thinking is open closes the thinking block
    if (this.thinkIndex !== null) {
      this.stopBlock(this.thinkIndex);
      this.thinkIndex = null;
      this.thinkingTag = "none";
    }
    this.textIndex = this.nextIndex++;
    this.emitStart(this.textIndex, { type: "text", text: "" });
    return this.textIndex;
  }

  private openThinking(): number {
    if (this.thinkIndex !== null) return this.thinkIndex;
    if (this.textIndex !== null) {
      this.stopBlock(this.textIndex);
      this.textIndex = null;
    }
    this.thinkIndex = this.nextIndex++;
    this.emitStart(this.thinkIndex, { type: "thinking", thinking: "" });
    return this.thinkIndex;
  }

  private openTool(id: string, name: string): number {
    const closeOld = [
      ...(this.textIndex !== null ? [this.textIndex] : []),
      ...(this.thinkIndex !== null ? [this.thinkIndex] : []),
      ...[...this.tools.values()].map((t) => t.anthropicIndex),
    ];
    closeOld.forEach((i) => this.stopBlock(i));
    this.textIndex = null;
    this.thinkIndex = null;
    this.thinkingTag = "none";
    const idx = this.nextIndex++;
    this.emitStart(idx, { type: "tool_use", id, name, input: {} });
    return idx;
  }

  private emitText(text: string): void {
    if (!text) return;
    const idx = this.openText();
    emit(this.res, "content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "text_delta", text },
    });
  }

  private emitThinking(text: string): void {
    if (!text) return;
    const idx = this.openThinking();
    emit(this.res, "content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "thinking_delta", thinking: text },
    });
  }

  /** Handle a chunk of model text, routing <aghantha> regions to thinking. */
  private feedText(text: string): void {
    let s = text;
    while (s.length) {
      if (this.tagModeOpen()) {
        const close = s.indexOf(THINK_TAG_CLOSE);
        if (close < 0) {
          this.emitThinking(stripThinkTagResidue(s));
          return;
        }
        this.emitThinking(s.slice(0, close));
        this.stopBlock(this.thinkIndex);
        this.thinkIndex = null;
        this.thinkingTag = "none";
        s = s.slice(close + THINK_TAG_CLOSE.length);
      } else {
        const open = s.indexOf(THINK_TAG_OPEN);
        if (open < 0) {
          this.emitText(stripThinkTagResidue(s));
          return;
        }
        if (open > 0) this.emitText(s.slice(0, open));
        s = s.slice(open + THINK_TAG_OPEN.length);
        this.thinkingTag = "open";
      }
    }
  }

  private tagModeOpen(): boolean {
    return this.thinkingTag === "open";
  }

  consumeOpenAiChunk(chunk: any): void {
    if (chunk?.usage) this.usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};

    const reason = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : null;
    if (reason) this.emitThinking(reason);

    if (typeof delta.content === "string" && delta.content.length) this.feedText(delta.content);

    for (const tc of delta.tool_calls ?? []) {
      const key = tc.index ?? tc.id ?? 0;
      if (!this.tools.has(key)) {
        const id = tc.id ?? `toolu_${crypto.randomBytes(6).toString("hex")}`;
        const anthropicIndex = this.openTool(id, tc.function?.name ?? "");
        this.tools.set(key, { anthropicIndex, argsSoFar: "", name: tc.function?.name ?? "", id });
      }
      const st = this.tools.get(key)!;
      const piece = tc.function?.arguments ?? "";
      if (piece) {
        st.argsSoFar += piece;
        emit(this.res, "content_block_delta", {
          type: "content_block_delta",
          index: st.anthropicIndex,
          delta: { type: "input_json_delta", partial_json: piece },
        });
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  finish(): void {
    const toolUsed = this.tools.size > 0;
    this.stopBlock(this.thinkIndex);
    this.thinkIndex = null;
    this.stopBlock(this.textIndex);
    this.textIndex = null;
    for (const t of this.tools.values()) this.stopBlock(t.anthropicIndex);
    this.tools.clear();

    const stopReason = toolUsed ? "tool_use" : mapFinish(this.finishReason, []);
    const outputTokens = this.usage?.completion_tokens ?? 0;
    emit(this.res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: this.usage?.prompt_tokens ?? this.inTokens,
        output_tokens: outputTokens,
      },
    });
    emit(this.res, "message_stop", { type: "message_stop" });
  }
}

function emit(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Translate an OpenAI SSE stream into an Anthropic SSE stream. */
async function translateStreamToAnthropic(
  upstream: Response,
  res: http.ServerResponse,
  model: string,
  inTokens: number,
): Promise<void> {
  const st = new StreamState(res, model, inTokens);
  st.begin();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            st.consumeOpenAiChunk(JSON.parse(payload));
          } catch {
            // ignore malformed lines
          }
        }
      }
    }
    buf += dec.decode();
    if (buf.includes("data:")) {
      for (const line of buf.split("\n")) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          st.consumeOpenAiChunk(JSON.parse(payload));
        } catch {
          /* ignore */
        }
      }
    } else if (buf.trim()) {
      // non-SSE trailing JSON (shouldn't happen) — best effort
      try {
        st.consumeOpenAiChunk(JSON.parse(buf));
      } catch {
        /* ignore */
      }
    }
  } finally {
    st.finish();
  }
}

/** Provider sent full JSON although we asked for a stream — synthesize SSE. */
async function synthesizeStreamFromObject(
  j: any,
  res: http.ServerResponse,
  model: string,
  inTokens: number,
): Promise<void> {
  const st = new StreamState(res, model, inTokens);
  st.begin();
  const ant = openaiToAnthropic(j, model);
  for (const block of ant.content) {
    if (block.type === "thinking") {
      st.consumeOpenAiChunk({ choices: [{ delta: { reasoning_content: block.thinking } }] });
    } else if (block.type === "text") {
      st.consumeOpenAiChunk({ choices: [{ delta: { content: block.text } }] });
    } else if (block.type === "tool_use") {
      st.consumeOpenAiChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: block.id,
                  function: { name: block.name, arguments: JSON.stringify(block.input) },
                },
              ],
            },
          },
        ],
      });
    }
  }
  st.consumeOpenAiChunk({
    choices: [{ delta: {}, finish_reason: ant.stop_reason === "tool_use" ? "tool_calls" : ant.stop_reason === "max_tokens" ? "length" : "stop" }],
    usage: { completion_tokens: ant.usage.output_tokens, prompt_tokens: ant.usage.input_tokens },
  });
  st.finish();
}

/** We did NOT ask for a stream but provider streamed anyway — collect to one OpenAI object. */
async function collectStreamToOpenAi(upstream: Response): Promise<any> {
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let reasoning = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let finish: unknown = null;
  let usage: any = null;
  let model: string | undefined;

  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (j.usage) usage = j.usage;
        if (j.model) model = j.model;
        const c = j.choices?.[0];
        if (!c) continue;
        if (typeof c.delta?.content === "string") text += c.delta.content;
        const r = typeof c.delta?.reasoning_content === "string" ? c.delta.reasoning_content : typeof c.delta?.reasoning === "string" ? c.delta.reasoning : null;
        if (r) reasoning += r;
        for (const tc of c.delta?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = toolCalls.get(i) ?? { id: tc.id ?? "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolCalls.set(i, cur);
        }
        if (c.finish_reason) finish = c.finish_reason;
      } catch {
        /* ignore */
      }
    }
  }

  const message: any = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } }));
    message.content = text || null;
  }
  return {
    model,
    choices: [{ message, finish_reason: finish }],
    usage,
  };
}

// ---------------- server ----------------

function upstreamHeaders(o: ProxyOptions): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": UA,
  };
  if (o.apiKey) h.authorization = `Bearer ${o.apiKey}`;
  return h;
}

export function startProxy(o: ProxyOptions): Promise<ProxyHandle> {
  const server = http.createServer((req, res) => {
    const started = Date.now();
    route(req, res, o)
      .catch((err: any) => {
        try {
          sendAnthropicError(res, 500, err?.message ?? String(err));
        } catch {
          /* response already gone */
        }
      })
      .finally(() => {
        o.onActivity?.({ path: req.url ?? "", status: res.statusCode, ms: Date.now() - started });
      });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, o: ProxyOptions): Promise<void> {
  const u = req.url ?? "";
  const path = u.split("?")[0];
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "POST" && (path === "/v1/messages" || path === "/1/messages")) {
    await handleMessages(req, res, o);
    return;
  }
  if (method === "POST" && path === "/v1/messages/count_tokens") {
    await handleCountTokens(req, res);
    return;
  }
  if (method === "GET" && path === "/v1/models") {
    await forwardModels(res, o);
    return;
  }
  if (method === "POST" && path === "/v1/chat/completions") {
    await passthrough(req, res, o, "/chat/completions");
    return;
  }

  jsonWrite(res, 404, { error: { type: "not_found", message: `max proxy: unknown path ${path}` } });
}

async function forwardModels(res: http.ServerResponse, o: ProxyOptions): Promise<void> {
  const url = joinUrl(o.targetBaseUrl, "/models");
  try {
    const r = await fetch(url, { headers: upstreamHeaders(o), signal: AbortSignal.timeout(20_000) });
    const body = await r.text();
    if (!res.headersSent) res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(body);
  } catch (e: any) {
    sendAnthropicError(res, 502, `cannot reach ${hostOf(o.targetBaseUrl)} — ${e?.message ?? e}`);
  }
}

async function passthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  o: ProxyOptions,
  suffix: string,
): Promise<void> {
  const raw = await readBody(req);
  const url = joinUrl(o.targetBaseUrl, suffix);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders(o),
      body: raw.length ? new Uint8Array(raw) : undefined,
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.headersSent) {
      res.writeHead(r.status, {
        "content-type": r.headers.get("content-type") ?? "application/json",
      });
    }
    if (r.body) {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } else {
      res.end(await r.text());
    }
  } catch (e: any) {
    sendAnthropicError(res, 502, `cannot reach ${hostOf(o.targetBaseUrl)} — ${e?.message ?? e}`);
  }
}

async function handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const n = estimateTokens({ system: body.system, messages: body.messages, tools: undefined });
    jsonWrite(res, 200, { input_tokens: Math.max(1, n) });
  } catch (e: any) {
    sendAnthropicError(res, 400, `bad count_tokens request — ${e?.message ?? e}`);
  }
}

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse, o: ProxyOptions): Promise<void> {
  let ant: any;
  try {
    ant = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (e: any) {
    return sendAnthropicError(res, 400, `bad request JSON — ${e?.message ?? e}`);
  }
  if (!ant?.model) return sendAnthropicError(res, 400, "missing request.model");

  const oaReq = anthropicToOpenai(ant, o);
  const url = joinUrl(o.targetBaseUrl, "/chat/completions");
  const ac = new AbortController();
  let clientGone = false;
  req.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      ac.abort();
    }
  });

  if (o.verbose) {
    process.stderr.write(
      `max proxy -> ${o.targetBaseUrl} model=${oaReq.model} stream=${String(oaReq.stream)} tools=${oaReq.tools?.length ?? 0} msgs=${oaReq.messages?.length ?? 0}\n`,
    );
  }

  // Model ladder: if the requested model was deprecated/EOL'd/renamed upstream,
  // transparently retry with the next-best ranked candidate for the same tier.
  const ladder = [
    ant.model,
    ...(o.modelFallbacks?.[ant.model]?.filter((m) => m && m !== ant.model) ?? []),
  ];
  let up: Response | null = null;
  let usedModel = ant.model;
  let lastBody = "";
  for (let attempt = 0; attempt < ladder.length; attempt++) {
    usedModel = ladder[attempt];
    try {
      up = await fetch(url, {
        method: "POST",
        headers: upstreamHeaders(o),
        body: JSON.stringify({ ...oaReq, model: usedModel }),
        signal: ac.signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") return; // client hung up
      return sendAnthropicError(res, 502, `cannot reach ${hostOf(o.targetBaseUrl)} — ${e?.message ?? e}`);
    }
    if (up.ok) break;
    lastBody = await up.text().catch(() => "");
    if (isModelUnavailable(up, lastBody)) {
      o.onDeadModel?.(usedModel);
      if (attempt < ladder.length - 1) {
        if (o.verbose) {
          process.stderr.write(
            `max proxy: model ${usedModel} is unavailable upstream (HTTP ${up.status}) — retrying with ${ladder[attempt + 1]}\n`,
          );
        }
        up = null;
        continue;
      }
    }
    break;
  }
  if (!up) {
    return sendAnthropicError(res, 502, `no candidate model was accepted by ${hostOf(o.targetBaseUrl)}`);
  }

  if (!up.ok) {
    if (clientGone) return;
    let msg: string | undefined;
    try {
      const j = JSON.parse(lastBody);
      msg = j?.error?.message ?? j?.message ?? j?.detail ?? j?.error ?? undefined;
    } catch {
      msg = lastBody.slice(0, 300) || undefined;
    }
    const status = up.status;
    const hint =
      status === 401 || status === 403
        ? " (check your API key: max key set, or provide it inline)"
        : status === 429
          ? " (free tier rate limit — slow down or switch model/providers)"
          : "";
    sendAnthropicError(res, status, `${msg ?? up.statusText}${hint}`);
    return;
  }

  const ct = up.headers.get("content-type") ?? "";
  const inTokens = estimateTokens({ system: ant.system, messages: ant.messages });

  if (oaReq.stream) {
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
    }
    if (ct.includes("event-stream")) {
      await translateStreamToAnthropic(up, res, usedModel, inTokens);
    } else {
      try {
        const j = await up.json();
        await synthesizeStreamFromObject(j, res, usedModel, inTokens);
      } catch (e: any) {
        o.verbose && process.stderr.write(`max proxy: upstream stream body unparsable — ${e?.message ?? e}\n`);
      }
    }
    try {
      res.end();
    } catch {
      /* already gone */
    }
    return;
  }

  // non-streaming
  let j: any;
  if (ct.includes("event-stream")) {
    j = await collectStreamToOpenAi(up);
  } else {
    j = await up.json();
  }
  const antOut = openaiToAnthropic(j, usedModel);
  jsonWrite(res, 200, antOut);
}
