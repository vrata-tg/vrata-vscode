const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeReasoning, resolveReasoning } = require("../dist/reasoning");
test("reasoning levels normalize strictly", () => {
  assert.equal(normalizeReasoning("none"), "none");
  assert.equal(normalizeReasoning("low"), "low");
  assert.equal(normalizeReasoning("medium"), "medium");
  assert.equal(normalizeReasoning("high"), "high");
  assert.equal(normalizeReasoning("xhigh"), "xhigh");
  assert.equal(normalizeReasoning("max"), "max");
  assert.equal(normalizeReasoning("ultra"), undefined);
  assert.equal(normalizeReasoning(""), undefined);
  assert.equal(normalizeReasoning(null), undefined);
  assert.equal(normalizeReasoning(2), undefined);
});

test("stored level applies; explicit modelOptions override wins", () => {
  assert.equal(resolveReasoning(undefined, "high"), "high");
  assert.equal(resolveReasoning({}, "high"), "high");
  assert.equal(
    resolveReasoning({ modelOptions: { reasoningEffort: "low" } }, "high"),
    "low",
  );
  assert.equal(
    resolveReasoning({ modelOptions: { reasoningEffort: "ultra" } }, "high"),
    "high",
  );
  assert.equal(resolveReasoning({ modelOptions: {} }, undefined), undefined);
});
