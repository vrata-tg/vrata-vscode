const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { streamChat } = require("../dist/transport");
const { streamMessages } = require("../dist/messages-transport");
const { streamResponses } = require("../dist/responses-transport");
const userAgent = `vrata-vscode/${require("../package.json").version}`;
const request = { model: "fixture", messages: [], input: [], max_tokens: 10 };

async function server(t, handler) {
  const value = http.createServer(handler);
  await new Promise((resolve) => value.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    value.closeAllConnections();
    value.close();
  });
  return `http://127.0.0.1:${value.address().port}`;
}

for (const [path, stream] of [
  ["/v1/chat/completions", streamChat],
  ["/v1/messages", streamMessages],
  ["/v1/responses", streamResponses],
]) {
  test(`${path}: SDK uses gateway identity and never retries or follows redirects`, async (t) => {
    let calls = 0;
    let status, retryAfter;
    const origin = await server(t, (req, res) => {
      calls++;
      assert.equal(req.url, path);
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer synthetic-key");
      assert.equal(req.headers["x-api-key"], undefined);
      assert.equal(req.headers["user-agent"], userAgent);
      res.writeHead(status, {
        "x-request-id": "fixture-request",
        ...(retryAfter ? { "retry-after": "0" } : {}),
        ...(status === 307 ? { location: "/must-not-follow" } : {}),
      });
      res.end(
        status === 502
          ? "private server response synthetic-key"
          : '{"error":{"message":"private server response synthetic-key"}}',
      );
    });
    for (const [code, expected, retry] of [
      [401, "invalid_key"],
      [402, "insufficient_balance"],
      [403, "model_unavailable"],
      [404, "model_unavailable"],
      [413, "request_too_large"],
      [429, "key_limit"],
      [429, "rate_limit", true],
      [500, "service_error"],
      [502, "service_error"],
      [307, "network"],
    ]) {
      status = code;
      retryAfter = retry;
      const previous = calls;
      await assert.rejects(
        stream(
          origin,
          "synthetic-key",
          request,
          new AbortController().signal,
          () => {},
        ),
        (error) => {
          assert.equal(error.code, expected);
          if (status !== 307) {
            assert.equal(error.status, status);
            assert.equal(error.requestId, "fixture-request");
          }
          assert.equal(error.cause, undefined);
          assert.doesNotMatch(error.stack, /private|synthetic-key/);
          return true;
        },
      );
      assert.equal(calls, previous + 1);
    }
    const controller = new AbortController();
    controller.abort();
    const previous = calls;
    await assert.rejects(
      stream(origin, "synthetic-key", request, controller.signal, () => {}),
      { name: "AbortError" },
    );
    assert.equal(calls, previous);
  });

  test(`${path}: deadline covers stalled response headers and body`, async (t) => {
    let calls = 0;
    let headers = false;
    const origin = await server(t, (_req, res) => {
      calls++;
      if (headers) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": keepalive\n\n");
      }
    });
    for (headers of [false, true]) {
      const parts = [];
      await assert.rejects(
        stream(
          origin,
          "synthetic-key",
          request,
          new AbortController().signal,
          (part) => parts.push(part),
          100,
        ),
        { code: "timeout" },
      );
      assert.deepEqual(parts, []);
    }
    assert.equal(calls, 2);
  });
}

test("SDK logging stays disabled even when environment requests debug logs", async (t) => {
  const names = ["OPENAI_LOG", "ANTHROPIC_LOG"];
  for (const name of names) {
    const previous = process.env[name];
    process.env[name] = "debug";
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const logs = [];
  for (const name of ["debug", "info", "log", "warn", "error"]) {
    const previous = console[name];
    console[name] = (...args) => logs.push(args);
    t.after(() => {
      console[name] = previous;
    });
  }
  const origin = await server(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("event: message_start\ndata: {private malformed payload}\n\n");
  });
  for (const stream of [streamChat, streamMessages, streamResponses]) {
    await assert.rejects(
      stream(
        origin,
        "synthetic-key",
        request,
        new AbortController().signal,
        () => {},
      ),
      { code: "invalid_stream" },
    );
  }
  assert.deepEqual(logs, []);
});
