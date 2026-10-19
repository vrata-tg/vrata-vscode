const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  streamMessages,
  toAnthropicMessages,
} = require("../dist/messages-transport");
const userAgent = `vrata-vscode/${require("../package.json").version}`;

async function server(t, handler) {
  const service = http.createServer(handler);
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    service.closeAllConnections();
    service.close();
  });
  return `http://127.0.0.1:${service.address().port}`;
}
function sse(type, fields = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}
function tool(index, id, name, json) {
  return (
    sse("content_block_start", {
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    }) +
    sse("content_block_delta", {
      index,
      delta: { type: "input_json_delta", partial_json: json },
    }) +
    sse("content_block_stop", { index })
  );
}

test("Messages runs two tool iterations, merges results and handles split SSE", async (t) => {
  const bodies = [];
  const url = await server(t, async (req, res) => {
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.headers.authorization, "Bearer test");
    assert.equal(req.headers["user-agent"], userAgent);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    const iteration = bodies.length;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const output =
      iteration === 1
        ? sse("message_start", { message: {} }) +
          tool(0, "one", "read", '{"path":"a"}') +
          tool(1, "two", "read", '{"path":"b"}') +
          sse("message_delta", { delta: { stop_reason: "tool_use" } }) +
          sse("message_stop")
        : iteration === 2
          ? sse("message_start", { message: {} }) +
            tool(0, "three", "run", '{"command":"ok"}') +
            sse("message_delta", { delta: { stop_reason: "tool_use" } }) +
            sse("message_stop")
          : sse("message_start", { message: {} }) +
            sse("content_block_start", {
              index: 0,
              content_block: { type: "text", text: "" },
            }) +
            sse("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: "Готово" },
            }) +
            sse("content_block_stop", { index: 0 }) +
            sse("message_delta", { delta: { stop_reason: "end_turn" } }) +
            sse("message_stop");
    for (const byte of Buffer.from(output)) res.write(Buffer.from([byte]));
    res.end();
  });
  let messages = [{ role: "user", content: "Start" }];
  for (let iteration = 0; iteration < 3; iteration++) {
    const parts = [];
    await streamMessages(
      url,
      "test",
      {
        model: "claude-fable-5",
        messages: toAnthropicMessages(messages),
        max_tokens: 128,
      },
      new AbortController().signal,
      (part) => parts.push(part),
    );
    if (iteration < 2) {
      assert.equal(parts.length, iteration === 0 ? 2 : 1);
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: parts.map((part) => ({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        })),
      });
      for (const part of parts)
        messages.push({
          role: "tool",
          tool_call_id: part.id,
          content: `result ${part.id}`,
        });
    } else assert.deepEqual(parts, [{ text: "Готово" }]);
  }
  assert.equal(bodies.length, 3);
  assert.deepEqual(
    bodies[1].messages.at(-1).content.map((part) => part.tool_use_id),
    ["one", "two"],
  );
  assert.equal(bodies[2].messages.at(-1).content[0].tool_use_id, "three");
});

test("Messages rejects malformed and incomplete tool streams without reporting tools", async (t) => {
  const url = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse("message_start", { message: {} }) +
        tool(0, "one", "read", "{") +
        sse("message_delta", { delta: { stop_reason: "tool_use" } }) +
        sse("message_stop"),
    );
  });
  const parts = [];
  await assert.rejects(
    streamMessages(
      url,
      "test",
      { model: "fixture", messages: [], max_tokens: 1 },
      new AbortController().signal,
      (part) => parts.push(part),
    ),
    { code: "invalid_stream" },
  );
  assert.deepEqual(parts, []);
});

test("Messages cancellation closes the stream", async (t) => {
  let close;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const url = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      sse("message_start", { message: {} }) +
        sse("content_block_start", {
          index: 0,
          content_block: { type: "text" },
        }) +
        sse("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "x" },
        }),
    );
    res.on("close", close);
  });
  const controller = new AbortController();
  await assert.rejects(
    streamMessages(
      url,
      "test",
      { model: "fixture", messages: [], max_tokens: 1 },
      controller.signal,
      () => controller.abort(),
    ),
    { name: "AbortError" },
  );
  await closed;
});

test("parallel Messages requests keep tool calls isolated", async (t) => {
  const url = await server(t, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const model = JSON.parse(raw).model;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    setTimeout(
      () =>
        res.end(
          sse("message_start", { message: {} }) +
            tool(0, `call-${model}`, "run", JSON.stringify({ model })) +
            sse("message_delta", { delta: { stop_reason: "tool_use" } }) +
            sse("message_stop"),
        ),
      model === "a" ? 10 : 1,
    );
  });
  const run = async (model) => {
    const parts = [];
    await streamMessages(
      url,
      "test",
      { model, messages: [], max_tokens: 1 },
      new AbortController().signal,
      (part) => parts.push(part),
    );
    return parts;
  };
  const [a, b] = await Promise.all([run("a"), run("b")]);
  assert.deepEqual(a, [{ id: "call-a", name: "run", input: { model: "a" } }]);
  assert.deepEqual(b, [{ id: "call-b", name: "run", input: { model: "b" } }]);
});

test("Messages times out a stalled stream without retry", async (t) => {
  let requests = 0;
  const url = await server(t, (_req, res) => {
    requests++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse("message_start", { message: {} }));
  });
  await assert.rejects(
    streamMessages(
      url,
      "test",
      { model: "fixture", messages: [], max_tokens: 1 },
      new AbortController().signal,
      () => {},
      150,
    ),
    { code: "timeout" },
  );
  assert.equal(requests, 1);
});

test("Messages handles an empty final answer and classifies mid-stream errors", async (t) => {
  let calls = 0;
  const url = await server(t, (_req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      calls === 1
        ? sse("message_start", { message: {} }) +
            sse("message_delta", { delta: { stop_reason: "end_turn" } }) +
            sse("message_stop")
        : sse("message_start", { message: {} }) +
            sse("error", { error: { message: "private response" } }),
    );
  });
  const parts = [];
  await streamMessages(
    url,
    "test",
    { model: "fixture", messages: [], max_tokens: 1 },
    new AbortController().signal,
    (part) => parts.push(part),
  );
  assert.deepEqual(parts, []);
  await assert.rejects(
    streamMessages(
      url,
      "test",
      { model: "fixture", messages: [], max_tokens: 1 },
      new AbortController().signal,
      () => {},
    ),
    (error) =>
      error.code === "stream_error" &&
      !error.stack.includes("private response"),
  );
});
