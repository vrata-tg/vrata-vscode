const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatError } = require("../dist/diagnostics");

test("diagnostics retain long SDK details and nested causes without truncating or leaking keys", () => {
  const failure = new Error("request failed", {
    cause: Object.assign(new Error("provider error"), {
      body: "x".repeat(11_000) + " synthetic-key final upstream reason",
      attempts: Array.from({ length: 105 }, (_, index) => ({
        index,
        message: "attempt synthetic-key",
      })),
    }),
  });
  const logged = formatError(failure, "synthetic-key");
  assert.match(logged, /provider error/);
  assert.ok(logged.includes("x".repeat(11_000)));
  assert.match(logged, /\[REDACTED\] final upstream reason/);
  assert.match(logged, /index: 104/);
  assert.doesNotMatch(logged, /synthetic-key|more characters|more items/);
});

test("diagnostics redact JSON-escaped credentials in SDK messages and nested body strings", () => {
  for (const key of ['synthetic"key', "synthetic\\key", 'synthetic"\\key']) {
    const payload = {
      message: `upstream failure ${key}`,
      code: "provider_error",
    };
    const serialized = JSON.stringify(payload);
    const error = new Error("service_error", {
      cause: Object.assign(new Error(`502 ${serialized}`), {
        error: payload,
        body: serialized,
      }),
    });
    const logged = formatError(error, key);
    assert.match(logged, /provider_error/);
    assert.match(logged, /502/);
    assert.ok(logged.split("upstream failure [REDACTED]").length >= 4);
    assert.doesNotMatch(logged, /synthetic/);
  }
});
