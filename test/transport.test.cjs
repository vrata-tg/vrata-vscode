const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { streamChat } = require("../dist/transport");
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  return `http://127.0.0.1:${s.address().port}/v1/chat/completions`;
}
const request = {
  model: "fixture",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 32,
};
test("streams split UTF-8 text and interleaved tool arguments exactly once", async (t) => {
  const url = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { choices: [{ delta: { content: "Привет" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "a",
                  function: { name: "read", arguments: '{"p":' },
                },
                {
                  index: 1,
                  id: "b",
                  function: { name: "run", arguments: '{"cmd":"test"}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"sum.js"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];
    const bytes = Buffer.from(
      events.map((e) => "data: " + JSON.stringify(e) + "\r\n\r\n").join("") +
        "data: [DONE]\r\n\r\n",
    );
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end();
  });
  const parts = [];
  await streamChat(url, "test", request, new AbortController().signal, (p) =>
    parts.push(p),
  );
  assert.deepEqual(parts, [
    { text: "Привет" },
    { id: "a", name: "read", input: { p: "sum.js" } },
    { id: "b", name: "run", input: { cmd: "test" } },
  ]);
});
test("Chat Completions carries tool results through two iterations", async (t) => {
  const bodies = [];
  const url = await server(t, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    const round = bodies.length;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event =
      round < 3
        ? {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${round}`,
                      function: {
                        name: "read",
                        arguments: `{"round":${round}}`,
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }
        : { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] };
    res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  const messages = [{ role: "user", content: "start" }];
  for (let round = 1; round <= 3; round++) {
    const parts = [];
    await streamChat(
      url,
      "test",
      { model: "fixture", messages, max_tokens: 32 },
      new AbortController().signal,
      (part) => parts.push(part),
    );
    if (round < 3) {
      const call = parts[0];
      assert.deepEqual(call.input, { round });
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input),
            },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `result-${round}`,
      });
    } else assert.deepEqual(parts, [{ text: "done" }]);
  }
  assert.equal(bodies[1].messages.at(-1).tool_call_id, "call-1");
  assert.equal(bodies[2].messages.at(-1).tool_call_id, "call-2");
});
test("Chat Completions accepts an empty completed answer", async (t) => {
  const url = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  const parts = [];
  await streamChat(url, "test", request, new AbortController().signal, (part) =>
    parts.push(part),
  );
  assert.deepEqual(parts, []);
});
test("does not retry HTTP failure or expose an upstream body", async (t) => {
  let calls = 0;
  const url = await server(t, (req, res) => {
    calls++;
    res.writeHead(502);
    res.end("private upstream content");
  });
  await assert.rejects(
    streamChat(url, "test", request, new AbortController().signal, () => {}),
    { code: "service_error", status: 502 },
  );
  assert.equal(calls, 1);
});
test("does not replay a paid POST through a redirect", async (t) => {
  let calls = 0;
  const url = await server(t, (req, res) => {
    calls++;
    res.writeHead(307, { Location: "/redirected" });
    res.end();
  });
  await assert.rejects(
    streamChat(url, "test", request, new AbortController().signal, () => {}),
    { code: "network" },
  );
  assert.equal(calls, 1);
});
test("rejects a truncated stream and never emits an incomplete tool", async (t) => {
  const url = await server(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"run","arguments":"{"}}]}}]}\n\n',
    );
  });
  const parts = [];
  await assert.rejects(
    streamChat(url, "test", request, new AbortController().signal, (p) =>
      parts.push(p),
    ),
    { code: "invalid_stream" },
  );
  assert.deepEqual(parts, []);
});
test("cancellation closes the HTTP request without retry", async (t) => {
  let calls = 0,
    closed;
  const disconnected = new Promise((resolve) => (closed = resolve));
  const url = await server(t, (req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
    res.on("close", closed);
  });
  const controller = new AbortController();
  await assert.rejects(
    streamChat(url, "test", request, controller.signal, () =>
      controller.abort(),
    ),
    { name: "AbortError" },
  );
  await disconnected;
  assert.equal(calls, 1);
});
test("malformed JSON is classified without exposing the payload", async (t) => {
  const url = await server(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: {private payload}\n\n");
  });
  await assert.rejects(
    streamChat(url, "test", request, new AbortController().signal, () => {}),
    (error) => {
      assert.equal(error.code, "invalid_stream");
      assert.ok(!error.stack.includes("private payload"));
      return true;
    },
  );
});

test("stream error objects do not leak into the exception cause", async (t) => {
  const upstream = {
    message: "new upstream failure",
    code: "NEW_CODE",
    detail: { stage: "routing" },
  };
  const url = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ error: upstream })}\n\n`);
  });
  await assert.rejects(
    streamChat(url, "test", request, new AbortController().signal, () => {}),
    (error) => {
      assert.equal(error.code, "stream_error");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("stream cleanup errors do not expose raw failures", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const primary = new Error("read failure");
  const cleanup = new Error("cancel failure");
  for (const [readFailure, cancelFailure] of [
    [undefined, cleanup],
    [primary, cleanup],
    [primary, primary],
  ]) {
    let released = false;
    global.fetch = async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        pipeThrough: () => ({
          getReader: () => ({
            read: async () => {
              if (readFailure) throw readFailure;
              return {
                done: false,
                value:
                  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\ndata: [DONE]\n',
              };
            },
            cancel: async () => {
              throw cancelFailure;
            },
            releaseLock: () => {
              released = true;
            },
          }),
        }),
      },
    });
    await assert.rejects(
      streamChat(
        "http://fixture",
        "test",
        request,
        new AbortController().signal,
        () => {},
      ),
      (error) => {
        assert.equal(error.code, readFailure ? "network" : "invalid_stream");
        assert.ok(!error.stack.includes("cancel failure"));
        return true;
      },
    );
    assert.equal(released, true);
  }
});
