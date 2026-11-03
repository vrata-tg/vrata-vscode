const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { withModelRetries } = require("../dist/request-retry");
const { streamChat } = require("../dist/transport");
const { streamMessages } = require("../dist/messages-transport");
const { streamResponses } = require("../dist/responses-transport");

const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const event = (type, value = {}) =>
  `event: ${type}\n${data({ type, ...value })}`;
const safeMessage = "The upstream model service failed. Please retry.";
// Exact post-commit envelopes from router/translate_stream.go emitError.
const families = [
  {
    name: "chat",
    stream: streamChat,
    partial: data({ choices: [{ delta: { content: "partial" } }] }),
    hidden: data({ choices: [{ delta: { reasoning_content: "hidden" } }] }),
    tool: (id, args) =>
      data({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id, function: { name: "run", arguments: args } },
              ],
            },
          },
        ],
      }),
    error: data({ error: { type: "api_error", message: safeMessage } }),
    done:
      data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n",
    malformed: data({ choices: "invalid" }),
    limited: data({ choices: [{ delta: {}, finish_reason: "length" }] }),
  },
  {
    name: "messages",
    stream: streamMessages,
    hidden: event("message_start", { message: {} }),
    partial:
      event("message_start", { message: {} }) +
      event("content_block_start", {
        index: 0,
        content_block: { type: "text" },
      }) +
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      }),
    tool: (id, args) =>
      event("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id, name: "run" },
      }) +
      event("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: args },
      }),
    error: event("error", {
      error: { type: "api_error", message: safeMessage },
    }),
    done:
      event("content_block_stop", { index: 0 }) +
      event("message_delta", { delta: { stop_reason: "tool_use" } }) +
      event("message_stop"),
    malformed:
      event("message_start", { message: {} }) +
      event("content_block_delta", { index: 999, delta: {} }),
    limited:
      event("message_start", { message: {} }) +
      event("message_delta", { delta: { stop_reason: "max_tokens" } }) +
      event("message_stop"),
  },
  {
    name: "responses",
    stream: streamResponses,
    hidden: data({ type: "response.created", response: {} }),
    partial: data({ type: "response.output_text.delta", delta: "partial" }),
    tool: (id, args) =>
      data({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id,
          call_id: id,
          name: "run",
          arguments: args,
        },
      }),
    error: event("error", {
      code: "server_error",
      message: safeMessage,
      param: null,
    }),
    done: data({ type: "response.completed", response: {} }),
    malformed: data({ type: "response.output_text.delta", delta: null }),
    limited: data({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    }),
  },
];

for (const [name, chunk] of [
  ["null choice in SDK normalizer", { choices: [null] }],
  [
    "null tool fragment in consumer",
    { choices: [{ delta: { tool_calls: [null] } }] },
  ],
]) {
  test(`Chat malformed ${name} is terminal before publication`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let posts = 0;
    t.mock.method(global, "fetch", async () => {
      posts++;
      return new Response(data(chunk));
    });
    const parts = [];
    const outcome = withModelRetries(
      new AbortController().signal,
      (signal, publish) =>
        streamChat(
          "https://fixture.invalid",
          "synthetic",
          {},
          signal,
          (part) => {
            publish();
            parts.push(part);
          },
        ),
    ).then(
      () => undefined,
      (error) => error,
    );
    await new Promise(setImmediate);
    for (let retry = 0; retry < 20; retry++) {
      t.mock.timers.tick(15_000);
      await new Promise(setImmediate);
    }
    const error = await outcome;
    assert.equal(error.code, "invalid_stream");
    assert.ok(error.cause instanceof TypeError);
    assert.equal(posts, 1);
    assert.deepEqual(parts, []);
  });
}

test("oversized HTTP Retry-After exhausts the shared deadline without another POST", async (t) => {
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  let posts = 0;
  t.mock.method(global, "fetch", async () => {
    posts++;
    return new Response('{"error":{"message":"temporary"}}', {
      status: 429,
      headers: { "retry-after": "2592000" },
    });
  });
  await assert.rejects(
    withModelRetries(
      new AbortController().signal,
      (signal) =>
        streamChat(
          "https://fixture.invalid",
          "synthetic",
          {},
          signal,
          () => {},
        ),
      80,
    ),
    { code: "timeout" },
  );
  assert.equal(posts, 1);
});

for (const family of families) {
  test(`${family.name}: pinned SDK connection errors remain retryable`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let posts = 0;
    t.mock.method(global, "fetch", async () => {
      if (++posts === 1)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connection reset"), {
            code: "ECONNRESET",
          }),
        });
      return new Response(
        family.hidden + family.tool("successful", "{}") + family.done,
      );
    });
    const result = withModelRetries(new AbortController().signal, (signal) =>
      family.stream(
        "https://fixture.invalid",
        "synthetic",
        {},
        signal,
        () => {},
      ),
    );
    await new Promise(setImmediate);
    t.mock.timers.tick(1000);
    await result;
    assert.equal(posts, 2);
  });
  test(`${family.name}: pinned SDK retains Retry-After seconds and HTTP dates`, async (t) => {
    for (const header of [
      "25",
      new Date(Date.now() + 60_000).toUTCString(),
      "invalid",
    ]) {
      t.mock.method(
        global,
        "fetch",
        async () =>
          new Response('{"error":{"message":"temporary"}}', {
            status: 429,
            headers: { "retry-after": header },
          }),
      );
      await assert.rejects(
        family.stream(
          "https://fixture.invalid",
          "synthetic",
          {},
          new AbortController().signal,
          () => {},
        ),
        (error) => {
          assert.equal(error.code, "rate_limit");
          if (header === "25") assert.equal(error.retryAfterMs, 25_000);
          else if (header === "invalid")
            assert.equal(error.retryAfterMs, undefined);
          else
            assert.ok(
              error.retryAfterMs > 55_000 && error.retryAfterMs <= 60_000,
            );
          return true;
        },
      );
      t.mock.restoreAll();
    }
  });
  for (const failure of ["SSE", "EOF"]) {
    test(`${family.name}: ${failure} before output retries through pinned SDK, discarding abandoned tool fragments`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.method(Math, "random", () => 1);
      let calls = 0;
      t.mock.method(global, "fetch", async () => {
        calls++;
        return new Response(
          family.hidden +
            (calls === 1
              ? family.tool("abandoned", "{") +
                (failure === "SSE" ? family.error : "")
              : family.tool("successful", "{}") + family.done),
        );
      });
      const parts = [];
      const result = withModelRetries(
        new AbortController().signal,
        (signal, publish) =>
          family.stream(
            "https://fixture.invalid",
            "synthetic",
            { model: "fixture", messages: [], input: [], max_tokens: 10 },
            signal,
            (part) => {
              publish();
              parts.push(part);
            },
          ),
      );
      // Attach rejection immediately so failures do not become unhandled.
      const settled = result.then(
        () => undefined,
        (error) => error,
      );
      await new Promise(setImmediate);
      assert.equal(calls, 1);
      assert.deepEqual(parts, []);
      t.mock.timers.tick(1000);
      assert.equal(await settled, undefined);
      assert.equal(calls, 2);
      assert.deepEqual(parts, [{ id: "successful", name: "run", input: {} }]);
    });

    test(`${family.name}: ${failure} after text never retries or duplicates parts`, async (t) => {
      let calls = 0;
      t.mock.method(global, "fetch", async () => {
        calls++;
        return new Response(
          family.partial + (failure === "SSE" ? family.error : ""),
        );
      });
      const parts = [];
      await assert.rejects(
        withModelRetries(new AbortController().signal, (signal, publish) =>
          family.stream(
            "https://fixture.invalid",
            "synthetic",
            {},
            signal,
            (part) => {
              publish();
              parts.push(part);
            },
          ),
        ),
        { code: failure === "SSE" ? "stream_error" : "incomplete_stream" },
      );
      assert.equal(calls, 1);
      assert.deepEqual(parts, [{ text: "partial" }]);
    });
  }

  test(`${family.name}: malformed events, invalid tool JSON and output limits do not retry`, async (t) => {
    for (const payload of [
      family.malformed,
      family.hidden + family.tool("invalid", "{") + family.done,
      family.limited,
    ]) {
      let calls = 0;
      t.mock.method(global, "fetch", async () => {
        calls++;
        return new Response(payload);
      });
      await assert.rejects(
        withModelRetries(new AbortController().signal, (signal) =>
          family.stream(
            "https://fixture.invalid",
            "synthetic",
            {},
            signal,
            () => {
              assert.fail("invalid answer must not publish");
            },
          ),
        ),
      );
      assert.equal(calls, 1);
      t.mock.restoreAll();
    }
  });
}

// Real sockets run after mocked-timer cases: Undici schedules its own timers.
test("actual loopback socket reset after headers retries before output", async (t) => {
  let posts = 0,
    firstResponse,
    receivedHeaders;
  const headers = new Promise((resolve) => {
    receivedHeaders = resolve;
  });
  const fixture = http.createServer((_request, response) => {
    posts++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (posts === 1) {
      firstResponse = response;
      response.write(": keepalive\n\n");
    } else
      response.end(
        data({
          choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }],
        }) + "data: [DONE]\n\n",
      );
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    fixture.closeAllConnections();
    fixture.close();
  });
  const fetch = global.fetch;
  t.mock.method(global, "fetch", async (...args) => {
    const response = await fetch(...args);
    if (posts === 1) receivedHeaders(response.status);
    return response;
  });
  const parts = [];
  const failures = [];
  const result = withModelRetries(
    new AbortController().signal,
    (signal, publish) =>
      streamChat(
        `http://127.0.0.1:${fixture.address().port}`,
        "synthetic",
        {},
        signal,
        (part) => {
          publish();
          parts.push(part);
        },
      ).catch((error) => {
        failures.push(error);
        throw error;
      }),
  );
  assert.equal(await headers, 200);
  firstResponse.destroy();
  await result;
  assert.equal(posts, 2);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "network");
  assert.equal(failures[0].status, 200);
  assert.ok(failures[0].cause instanceof TypeError);
  assert.equal(failures[0].cause.cause.code, "UND_ERR_SOCKET");
  assert.deepEqual(parts, [{ text: "recovered" }]);
});
