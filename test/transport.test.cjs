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
test("does not retry HTTP failure or expose an upstream body", async (t) => {
  let calls = 0;
  const url = await server(t, (req, res) => {
    calls++;
    res.writeHead(502);
    res.end("private upstream content");
  });
  await assert.rejects(
    streamChat(url, "test", request, new AbortController().signal, () => {}),
    { message: "Gateway HTTP 502" },
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
    TypeError,
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
    /Incomplete gateway stream/,
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
test("malformed JSON is sanitized and incomplete tools are not executed", async (t) => {
  const url = await server(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: {private payload}\n\n");
  });
  await assert.rejects(
    streamChat(url, "test", request, new AbortController().signal, () => {}),
    { message: "Invalid JSON in gateway stream" },
  );
});
