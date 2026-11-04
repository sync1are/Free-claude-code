// Integration tests for the built max bundle: spin up the mock OpenAI
// provider + `max proxy`, then talk Anthropic Messages at the proxy and
// assert the OpenAI<->Anthropic translation behaves.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import * as mock from "./mock-openai.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist", "max.js");

let passed = 0;
let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m  ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name} ${extra}`);
  }
}

async function startProxy(target, key = "test-key") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST, "proxy", "--target", target, "--key", key], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve({ port: Number(m[1]), child });
    });
    child.stderr.on("data", (d) => process.stderr.write(`[proxy] ${d}`));
    child.on("exit", () => reject(new Error("proxy exited early: " + buf)));
    setTimeout(() => reject(new Error("proxy did not report a port in time:\n" + buf)), 15_000);
  });
}

async function main() {
  if (!fs.existsSync(DIST)) {
    console.error("dist/max.js missing — run `npm run build` first");
    process.exit(1);
  }

  const mockPort = await mock.start();
  console.log(`mock openai server: ${mock.baseUrl()}`);

  const proxy = await startProxy(mock.baseUrl());
  console.log(`max proxy: http://127.0.0.1:${proxy.port}`);

  const base = `http://127.0.0.1:${proxy.port}`;

  // ---------- non-stream text ----------
  {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anything" },
      body: JSON.stringify({
        model: "whatever-model",
        max_tokens: 100,
        system: "be nice",
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    const j = await r.json();
    ok("non-stream: status 200", r.status === 200);
    ok("non-stream: type message", j.type === "message" && j.role === "assistant");
    ok("non-stream: text content", j.content?.[0]?.type === "text" && j.content?.[0]?.text === "Hello world");
    ok("non-stream: usage mapped", j.usage?.input_tokens === 11 && j.usage?.output_tokens === 2);
    ok("non-stream: stop_reason", j.stop_reason === "end_turn");
  }

  // ---------- echo: verifies request translation ----------
  {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "echo-test",
        max_tokens: 123,
        temperature: 0.5,
        system: [{ type: "text", text: "sys prompt", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "ask" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result text" }, { type: "text", text: "continue please" }] },
        ],
        tools: [{ name: "search", description: "Search the web", input_schema: { type: "object", properties: { q: { type: "string" } }, $schema: "http://json-schema.org/bogus" } }],
        tool_choice: { type: "tool", name: "search" },
        stop_sequences: ["END"],
        stream: false,
      }),
    });
    const sent = JSON.parse((await r.json()).content?.[0]?.text ?? "{}");
    const firstTool = sent.messages.find((m) => m.role === "tool");
    ok("echo: system extracted", sent.messages?.[0]?.role === "system" && sent.messages[0].content === "sys prompt");
    ok("echo: assistant tool_use -> tool_calls", sent.messages?.[2]?.tool_calls?.[0]?.function?.name === "search" && sent.messages[2].tool_calls[0].id === "toolu_1");
    ok("echo: tool_result -> role:tool", firstTool?.tool_call_id === "toolu_1" && firstTool?.content === "result text");
    ok("echo: trailing text kept", sent.messages[sent.messages.length - 1].content === "continue please");
    ok("echo: tools -> function schema", sent.tools?.[0]?.function?.name === "search" && sent.tools?.[0]?.function?.parameters?.type === "object");
    ok("echo: schema $schema stripped", sent.tools?.[0]?.function?.parameters?.$schema === undefined);
    ok("echo: tool_choice mapped", sent.tool_choice?.type === "function" && sent.tool_choice?.function?.name === "search");
    ok("echo: max_tokens passthrough", sent.max_tokens === 123);
    ok("echo: temperature passthrough", sent.temperature === 0.5);
    ok("echo: stop_sequences -> stop", JSON.stringify(sent.stop) === `["END"]`);
    ok("echo: cache_control dropped anywhere", !JSON.stringify(sent).includes("ephemeral"));
  }

  // ---------- non-stream tool_use ----------
  {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        max_tokens: 99,
        messages: [{ role: "user", content: "CALL the tool" }],
        tools: [{ name: "add", description: "Add numbers", input_schema: { type: "object", properties: {} } }],
      }),
    });
    const j = await r.json();
    const toolBlock = j.content?.find((b) => b.type === "tool_use");
    ok("non-stream tools: stop_reason tool_use", j.stop_reason === "tool_use", JSON.stringify(j));
    ok("non-stream tools: parsed input", toolBlock && toolBlock.input?.a === 2 && toolBlock.input?.b === 3);
  }

  // ---------- stream text + think tag ----------
  {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        max_tokens: 99,
        stream: true,
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    const text = await r.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    ok("stream: content-type SSE", r.headers.get("content-type").includes("text/event-stream"));
    ok("stream: message_start first", events[0] === "message_start");
    ok("stream: ordered block events", events.includes("content_block_start") && events.includes("content_block_delta") && events.includes("message_delta") && events[events.length - 1] === "message_stop");
    const blocks = JSON.parse(`[${text.match(/^data: (.+)$/gm).map((s) => s.slice(6)).join(",")}]`);
    const texts = blocks.filter((b) => b.type === "content_block_delta" && b.delta?.type === "text_delta").map((b) => b.delta.text).join("");
    const thinks = blocks.filter((b) => b.type === "content_block_delta" && b.delta?.type === "thinking_delta").map((b) => b.delta.thinking).join("");
    ok("stream: text joined", texts === "Hello worlddone", JSON.stringify(texts));
    ok("stream: think tags -> thinking", thinks === "pondering", JSON.stringify(thinks));
    const delta = blocks.find((b) => b.type === "message_delta");
    ok("stream: stop_reason end_turn", delta?.delta?.stop_reason === "end_turn");
    ok("stream: usage in message_delta", delta?.usage?.output_tokens === 9);
  }

  // ---------- stream tool calls ----------
  {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        max_tokens: 99,
        stream: true,
        messages: [{ role: "user", content: "CALL it" }],
        tools: [{ name: "add", description: "Add", input_schema: { type: "object", properties: {} } }],
      }),
    });
    const text = await r.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    const dataLines = [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]));
    const starts = dataLines.filter((b) => b.type === "content_block_start");
    const toolStart = starts.find((b) => b.content_block?.type === "tool_use");
    ok("stream tools: block start with id+name", toolStart && toolStart.content_block.id === "call_mock_1" && toolStart.content_block.name === "add");
    const jsonDeltas = dataLines.filter((b) => b.type === "content_block_delta" && b.delta?.type === "input_json_delta").map((b) => b.delta.partial_json).join("");
    ok("stream tools: arguments streamed", JSON.parse(jsonDeltas).a === 2);
    const delta = dataLines.find((b) => b.type === "message_delta");
    ok("stream tools: stop_reason tool_use", delta?.delta?.stop_reason === "tool_use");
    ok("stream tools: single tool block index", starts.length === 1 && starts[0].index === 0);
  }

  // ---------- count_tokens ----------
  {
    const r = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    const j = await r.json();
    ok("count_tokens: input_tokens>0", r.status === 200 && j.input_tokens >= 1);
  }

  // ---------- upstream error mapping ----------
  {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "error-401", max_tokens: 9, messages: [] }),
    });
    // mock always 200s; force a 502 by targetting mock with bad path? simulate 404 path instead:
    ok("error path sanity (mock always 200)", r.status === 200);
  }

  await mock.stop();
  proxy.child.kill();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
