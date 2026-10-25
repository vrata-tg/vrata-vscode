const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { formatError } = require("../dist/diagnostics");
const { requestError } = require("../dist/request-errors");
const {
  streamResponses,
  toResponsesInput,
} = require("../dist/responses-transport");
const userAgent = `vrata-vscode/${require("../package.json").version}`;

async function server(t, handler) {
  const value = http.createServer(handler);
  await new Promise((resolve) => value.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    value.closeAllConnections();
    value.close();
  });
  return `http://127.0.0.1:${value.address().port}`;
}

test("converts chat history, images and tool results to Responses input items", () => {
  assert.deepEqual(
    toResponsesInput([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "reading",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "contents" },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AA==" },
          },
        ],
      },
    ]),
    [
      { role: "user", content: [{ type: "input_text", text: "start" }] },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "reading" }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "read",
        arguments: '{"path":"a"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "contents",
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "inspect" },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      },
    ],
  );
});

test("streams Responses text and validated function calls", async (t) => {
  let received;
  const url = await server(t, async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic");
    assert.equal(req.headers["user-agent"], userAgent);
    let body = "";
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "x-request-id": "response-request-id",
    });
    const events = [
      {
        type: "response.output_text.delta",
        delta: "ready",
      },
      {
        type: "response.refusal.delta",
        delta: "blocked",
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "item-1",
          type: "function_call",
          call_id: "call-1",
          name: "read",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item-1",
        delta: '{"path":"fixture.js"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "item-1",
        arguments: '{"path":"fixture.js"}',
      },
      { type: "response.completed", response: { status: "completed" } },
    ];
    res.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });
  const parts = [];
  const requestId = await streamResponses(
    url,
    "synthetic",
    { model: "fixture", input: [], max_output_tokens: 32 },
    new AbortController().signal,
    (part) => parts.push(part),
  );
  assert.equal(received.stream, true);
  assert.deepEqual(parts, [
    { text: "ready" },
    { text: "blocked" },
    { id: "call-1", name: "read", input: { path: "fixture.js" } },
  ]);
  assert.equal(requestId, "response-request-id");
});

test("rejects incomplete Responses streams without reporting tools", async (t) => {
  const url = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item_id: "item-1",
        item: {
          id: "item-1",
          type: "function_call",
          call_id: "call-1",
          name: "run",
          arguments: "{}",
        },
      })}\n\n`,
    );
  });
  const parts = [];
  await assert.rejects(
    streamResponses(
      url,
      "synthetic",
      { model: "fixture", input: [], max_output_tokens: 32 },
      new AbortController().signal,
      (part) => parts.push(part),
    ),
    { code: "invalid_stream" },
  );
  assert.deepEqual(parts, []);
});

test("maps HTTP failures without exposing response bodies", async (t) => {
  const url = await server(t, (_req, res) => {
    res.writeHead(429, { "Retry-After": "20" });
    res.end("private gateway detail");
  });
  await assert.rejects(
    streamResponses(
      url,
      "synthetic",
      { model: "fixture", input: [], max_output_tokens: 32 },
      new AbortController().signal,
      () => {},
    ),
    { code: "rate_limit", status: 429 },
  );
});

test("Responses terminal failures retain the event and reason in redacted diagnostics", async (t) => {
  let event;
  const url = await server(t, (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "x-request-id": "response-failure-id",
    });
    res.end(`data: ${JSON.stringify(event)}\n\n`);
  });
  for (event of [
    {
      type: "error",
      code: "server_error",
      message: "upstream failed synthetic",
      param: null,
    },
    {
      type: "response.failed",
      response: {
        id: "upstream-response-id",
        status: "failed",
        error: { code: "server_error", message: "upstream failed synthetic" },
      },
    },
    {
      type: "response.incomplete",
      response: {
        id: "upstream-response-id",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    },
  ]) {
    const parts = [];
    await assert.rejects(
      streamResponses(
        url,
        "synthetic",
        { model: "fixture", input: [] },
        new AbortController().signal,
        (part) => parts.push(part),
      ),
      (error) => {
        assert.equal(error.code, "stream_error");
        assert.equal(error.requestId, "response-failure-id");
        assert.deepEqual(error.cause, event);
        const logged = formatError(error, "synthetic");
        assert.ok(logged.includes(event.type));
        assert.match(logged, /response-failure-id/);
        if (event.type === "response.incomplete") {
          assert.match(logged, /max_output_tokens/);
        } else {
          assert.match(logged, /upstream failed \[REDACTED\]/);
          assert.match(logged, /server_error/);
        }
        assert.doesNotMatch(logged, /synthetic/);
        assert.doesNotMatch(
          requestError(error).message,
          /upstream failed|synthetic|max_output_tokens/,
        );
        return true;
      },
    );
    assert.deepEqual(parts, []);
  }
});
