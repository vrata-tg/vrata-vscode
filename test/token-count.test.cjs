const { test } = require("node:test");
const assert = require("node:assert/strict");
const { estimateTokens } = require("../dist/token-count");

test("local estimate counts tokens rather than UTF-8 bytes", () => {
  for (const text of [
    "hello world",
    "function f(x) { return x?.a ?? 0; }",
    "Привет, мир!",
    '{"ключ":"значение","items":[1,2,3]}',
  ]) {
    const count = estimateTokens(text);
    assert.ok(Number.isInteger(count) && count > 0);
    assert.ok(count < Buffer.byteLength(text, "utf8") / 2);
  }
  assert.ok(estimateTokens("Привет") > estimateTokens("Privet"));
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
    estimateTokens([...base, call, result]) <
      Buffer.byteLength(JSON.stringify([...base, call, result]), "utf8"),
  );
});

test("context boundary uses token units and rounds partial tokens up", () => {
  const prompt = "test".repeat(100);
  assert.equal(estimateTokens(prompt), 100);
  assert.equal(estimateTokens(prompt) <= 100, true);
  assert.equal(estimateTokens(`${prompt}a`) <= 100, false);
});

test("long text and structured messages fit their token budget", () => {
  for (const text of [
    "hello world ".repeat(10_000),
    "Привет, мир! ".repeat(10_000),
    'const value = { path: "src/test.ts", ok: true };\n'.repeat(3_000),
  ]) {
    const budget = 100_000;
    assert.ok(Buffer.byteLength(text, "utf8") > budget);
    assert.ok(estimateTokens(text) < budget);
    assert.ok(estimateTokens([{ role: "user", content: text }]) < budget);
  }
});
