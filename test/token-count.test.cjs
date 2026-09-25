const { test } = require("node:test");
const assert = require("node:assert/strict");
const { estimateTokens } = require("../dist/token-count");

test("local estimate covers ASCII, code, Cyrillic and JSON bytes", () => {
  for (const text of [
    "hello world",
    "function f(x) { return x?.a ?? 0; }",
    "Привет, мир!",
    '{"ключ":"значение","items":[1,2,3]}',
  ]) {
    assert.ok(estimateTokens(text) >= Buffer.byteLength(text, "utf8"));
  }
  assert.ok(estimateTokens("Привет") > "Привет".length);
  assert.equal(estimateTokens(""), 1);
  assert.ok(estimateTokens([]) >= 16);
});

test("tool arguments and results increase the structured message estimate", () => {
  const base = [{ role: "user", content: "Запусти тест" }];
  const call = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "run_test", arguments: '{"path":"src/тест.js"}' },
      },
    ],
  };
  const result = {
    role: "tool",
    tool_call_id: "call-1",
    content: "PASS: 3 tests",
  };
  assert.ok(estimateTokens([...base, call]) > estimateTokens(base));
  assert.ok(
    estimateTokens([...base, call, result]) > estimateTokens([...base, call]),
  );
  assert.ok(
    estimateTokens([...base, call, result]) >=
      Buffer.byteLength(JSON.stringify([...base, call, result]), "utf8"),
  );
});

test("context boundary is predictable with the conservative estimate", () => {
  const prompt = "a".repeat(100);
  assert.equal(estimateTokens(prompt), 100);
  assert.equal(estimateTokens(prompt) <= 100, true);
  assert.equal(estimateTokens(`${prompt}a`) <= 100, false);
});
