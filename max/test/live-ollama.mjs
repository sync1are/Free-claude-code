// Live e2e against real Ollama: requires models pulled + server running.

import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const DIST = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "dist", "max.js");

// find a model
const list = spawnSync("ollama", ["list"], { encoding: "utf8", shell: true });
const model = (list.stdout ?? "")
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.trim().split(/\s{2,}/)[0])
  .filter(Boolean)[0];

if (!model) {
  console.log("no ollama models — skipping live test");
  process.exit(0);
}
console.log(`live model: ${model}`);

const proxy = spawn(process.execPath, [DIST, "proxy", "--target", "http://127.0.0.1:11434/v1", "--key", "local", "--verbose"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let port = null;
proxy.stdout.on("data", (d) => {
  const m = d.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (m) port = Number(m[1]);
});
proxy.stderr.on("data", (d) => process.stdout.write(`[px] ${d}`));
await new Promise((r) => {
  const t = setInterval(() => {
    if (port) { clearInterval(t); r(); }
  }, 100);
  setTimeout(() => { clearInterval(t); r(); }, 10_000);
});
if (!port) { console.error("proxy failed to start"); process.exit(1); }

const base = `http://127.0.0.1:${port}`;

const call = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    max_tokens: 300,
    system: "You are helpful.",
    messages: [{ role: "user", content: "What is 17*23? Answer with just the number." }],
  }),
});
const j = await call.json();
console.log("\nNON-STREAM RESPONSE:");
console.log(JSON.stringify({ stop_reason: j.stop_reason, content: j.content?.map((b) => b.type), text: j.content?.[0]?.text?.slice(0, 80), usage: j.usage }, null, 2));

// streaming + tool
const stream = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    max_tokens: 400,
    stream: true,
    messages: [{ role: "user", content: "Use the get_weather tool for Tokyo. Then answer in one short sentence." }],
    tools: [{ name: "get_weather", description: "Get current weather for a city", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
  }),
});
const text = await stream.text();
const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
const data = [...text.matchAll(/^data: (.+)$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
const deltas = data.filter((b) => b.type === "content_block_delta");
const toolDelta = deltas.find((d) => d.delta?.type === "input_json_delta");
const textOut = deltas.filter((d) => d.delta?.type === "text_delta").map((d) => d.delta.text).join("");
const stop = data.find((d) => d.type === "message_delta")?.delta?.stop_reason;
console.log("STREAM RESPONSE:");
console.log(JSON.stringify({ events: [...new Set(events)], toolArgs: toolDelta?.delta?.partial_json, text: textOut.slice(0, 120), stop_reason: stop }, null, 2));

let ok = true;
if (j.stop_reason !== "end_turn") { ok = false; }
if (stop !== "tool_use") { console.log("note: no tool_use (model answered in text instead) - not fatal"); }
proxy.kill();
console.log(ok ? "\nLIVE OK" : "\nLIVE FAIL");
process.exit(ok ? 0 : 1);
