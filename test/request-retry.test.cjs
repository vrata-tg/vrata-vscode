const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withModelRetries } = require("../dist/request-retry");
const { TransportError } = require("../dist/transport");

async function flush() {
  await new Promise(setImmediate);
}

function clock(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 1);
}

test("temporary failures have at most twenty retries with capped backoff", async (t) => {
  clock(t);
  let calls = 0;
  const error = new TransportError("service_error", 503);
  const result = withModelRetries(new AbortController().signal, async () => {
    calls++;
    throw error;
  });
  const rejected = assert.rejects(result, (value) => value === error);
  await flush();
  assert.equal(calls, 1);
  for (let retry = 0; retry < 20; retry++) {
    const wait = Math.min(1000 * 2 ** retry, 15_000);
    t.mock.timers.tick(wait - 1);
    await flush();
    assert.equal(calls, retry + 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, retry + 2);
  }
  await rejected;
});

for (const code of [
  "network",
  "timeout",
  "rate_limit",
  "service_error",
  "incomplete_stream",
]) {
  test(`${code} retries before output and returns only the successful result`, async (t) => {
    clock(t);
    let calls = 0;
    const result = withModelRetries(new AbortController().signal, async () => {
      if (++calls === 1)
        throw new TransportError(code, code === "rate_limit" ? 429 : 503);
      return "successful-request";
    });
    await flush();
    t.mock.timers.tick(1000);
    assert.equal(await result, "successful-request");
    assert.equal(calls, 2);
  });
}

for (const cause of [
  { error: { code: "stream_interrupted", type: "upstream_error" } },
  { error: { code: "server_error" } },
  { error: { type: "error", error: { type: "api_error" } } },
  { type: "response.failed", response: { error: { code: "server_error" } } },
]) {
  test(`temporary structured SSE failure retries: ${JSON.stringify(cause)}`, async (t) => {
    clock(t);
    let calls = 0;
    const result = withModelRetries(new AbortController().signal, async () => {
      if (++calls === 1)
        throw new TransportError("stream_error", 200, undefined, { cause });
      return "recovered";
    });
    await flush();
    t.mock.timers.tick(1000);
    assert.equal(await result, "recovered");
    assert.equal(calls, 2);
  });
}

test("permanent, malformed and request-specific errors do not retry", async () => {
  for (const error of [
    ...[
      "invalid_key",
      "insufficient_balance",
      "model_unavailable",
      "key_limit",
      "request_too_large",
      "request_rejected",
      "invalid_stream",
    ].map((code) => new TransportError(code, 400)),
    new TransportError("stream_error", 200),
    new TransportError("stream_error", 200, undefined, {
      cause: { error: { type: "server_error", code: "invalid_request" } },
    }),
    new TransportError("stream_error", 200, undefined, {
      cause: {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      },
    }),
    new Error("unsupported local conversion"),
  ]) {
    let calls = 0;
    await assert.rejects(
      withModelRetries(new AbortController().signal, async () => {
        calls++;
        throw error;
      }),
      (value) => value === error,
    );
    assert.equal(calls, 1, error.code ?? error.message);
  }
});

test("publication closes retry, including errors thrown by the consumer", async () => {
  for (const part of [{ text: "partial" }, { id: "tool" }, { usage: {} }]) {
    let calls = 0;
    const published = [];
    const error = new TransportError("network");
    await assert.rejects(
      withModelRetries(
        new AbortController().signal,
        async (_signal, publish) => {
          calls++;
          publish();
          published.push(part);
          throw error;
        },
      ),
      (value) => value === error,
    );
    assert.equal(calls, 1);
    assert.deepEqual(published, [part]);
  }
});

test("cancellation interrupts backoff and never starts the next attempt", async (t) => {
  clock(t);
  const controller = new AbortController();
  let calls = 0;
  const result = withModelRetries(controller.signal, async () => {
    calls++;
    throw new TransportError("network");
  });
  const rejected = assert.rejects(result, { name: "AbortError" });
  await flush();
  controller.abort();
  await rejected;
  t.mock.timers.tick(60_000);
  assert.equal(calls, 1);
});

test("cancellation propagates into the active fetch and pre-cancelled requests never start", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = withModelRetries(controller.signal, async (signal) => {
    calls++;
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const rejected = assert.rejects(result, { name: "AbortError" });
  controller.abort();
  await rejected;
  await assert.rejects(
    withModelRetries(controller.signal, async () => calls++),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("one deadline bounds backoff and fetch across retries", async (t) => {
  // AbortSignal.timeout is unref'ed; a real HTTP socket normally keeps it alive.
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    withModelRetries(
      new AbortController().signal,
      async () => {
        calls++;
        throw new TransportError("network");
      },
      30,
    ),
    { code: "timeout" },
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1000);

  calls = 0;
  const retryStarted = Date.now();
  await assert.rejects(
    withModelRetries(
      new AbortController().signal,
      async (signal) => {
        if (++calls === 1) throw new TransportError("network");
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      1100,
    ),
    { code: "timeout" },
  );
  assert.equal(calls, 2);
  assert.ok(Date.now() - retryStarted < 1800);
});

test("Retry-After delays the retry without extending the deadline", async (t) => {
  clock(t);
  let calls = 0;
  const error = new TransportError("rate_limit", 429);
  error.retryAfterMs = 25_000;
  const result = withModelRetries(new AbortController().signal, async () => {
    if (++calls === 1) throw error;
    return "ok";
  });
  await flush();
  t.mock.timers.tick(24_999);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(await result, "ok");
  assert.equal(calls, 2);
});
