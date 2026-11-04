// Mock OpenAI-compatible provider for testing the max proxy translation.

import http from "node:http";

let port = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      handle(JSON.parse(body || "{}"), res);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  });
});

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(id, choiceDelta, extra = {}) {
  return { id, object: "chat.completion.chunk", choices: [{ delta: choiceDelta, ...extra }] };
}

function handle(body, res) {
  const { messages = [] } = body;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
        : "";
  const id = "chatcmpl-mock";
  const model = body.model ?? "mock-model";

  // echo mode: return the received request body as text (for inspection)
  if (model === "echo-test") {
    const payload = { role: "assistant", content: JSON.stringify(body) };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, chunk(id, payload));
      sse(res, chunk(id, {}, { finish_reason: "stop" }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, model, choices: [{ message: payload, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 7 } }));
    return;
  }

  const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (body.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    sse(res, chunk(id, { role: "assistant" }));
    if (wantsTools && /call/i.test(userText)) {
      // tool call streamed in two argument fragments + usage at the end
      sse(res, chunk(id, { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "add", arguments: '{"a": ' } }] }));
      sse(res, chunk(id, { tool_calls: [{ index: 0, function: { arguments: "2, \"b\": 3}" } }] }));
      sse(res, chunk(id, {}, { finish_reason: "tool_calls" }));
      sse(res, { id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 11, completion_tokens: 5 } });
    } else {
      sse(res, chunk(id, { content: "Hello" }));
      sse(res, chunk(id, { content: " world" }));
      // <aghantha> block mid-stream to test think tag routing
      sse(res, chunk(id, { content: "<aghantha>pondering</aghantha>done" }));
      sse(res, chunk(id, {}, { finish_reason: "stop" }));
      sse(res, { id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 11, completion_tokens: 9 } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (wantsTools && /call/i.test(userText)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        model,
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_mock_1", type: "function", function: { name: "add", arguments: `{"a": 2, "b": 3}` } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 11, completion_tokens: 5 },
      }),
    );
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id,
      model,
      choices: [{ message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 2 },
    }),
  );
}

export async function start() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  return port;
}

export function baseUrl() {
  return `http://127.0.0.1:${port}/v1`;
}

export async function stop() { 
  await new Promise((resolve) => server.close(resolve));
}
