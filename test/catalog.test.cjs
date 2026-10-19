const { test } = require("node:test");
const assert = require("node:assert/strict");
const { projectCatalog } = require("../dist/catalog");

function entry(id, metadata = {}) {
  return {
    id,
    gateway_metadata: {
      name: id,
      family: id.split("-")[0],
      protocol: "openai",
      max_input_tokens: 120_000,
      max_output_tokens: 8_000,
      supports_tools: true,
      supports_images: true,
      verified_transport: "chat_completions",
      ...metadata,
    },
  };
}

test("projects verified OpenAI and Anthropic public IDs without inventing capabilities", () => {
  const result = projectCatalog([
    entry("gpt-5.6-terra"),
    entry("claude-sonnet-5", {
      max_input_tokens: 100_000,
      max_output_tokens: 4_096,
      supports_images: null,
    }),
  ]);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["gpt-5.6-terra", "claude-sonnet-5"],
  );
  assert.deepEqual(
    result.models.map((model) => [model.maxInputTokens, model.maxOutputTokens]),
    [
      [120_000, 8_000],
      [100_000, 4_096],
    ],
  );
  assert.deepEqual(result.models[0].capabilities, {
    toolCalling: true,
    imageInput: true,
  });
  assert.deepEqual(result.unavailable, []);
});

test("only explicitly confirmed image support reaches the VS Code capability", () => {
  const result = projectCatalog([
    entry("vision", { supports_images: true }),
    entry("unknown", { supports_images: null }),
    entry("gpt-6.1-sol", { supports_images: null }),
    entry("disabled", { supports_images: false }),
  ]);
  assert.deepEqual(
    result.models.map((model) => [model.id, model.capabilities.imageInput]),
    [
      ["vision", true],
      ["unknown", false],
      ["gpt-6.1-sol", true],
      ["disabled", false],
    ],
  );
  assert.equal(
    projectCatalog([entry("gpt-6.1-sol", { supports_images: false })]).models[0]
      .capabilities.imageInput,
    false,
  );
});

test("does not expose models with incomplete limits, tools or transport", () => {
  const result = projectCatalog([
    entry("missing-output", { max_output_tokens: null }),
    entry("missing-tools", { supports_tools: null }),
    entry("missing-family", { family: null }),
    entry("wrong-protocol", { protocol: "anthropic" }),
    entry("unverified-transport", { verified_transport: null }),
    entry("available"),
    entry("available"),
  ]);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["available"],
  );
  assert.equal(result.unavailable.length, 5);
  assert.match(result.unavailable[0], /пределы/);
  assert.match(result.unavailable[1], /инструментов/);
  assert.match(result.unavailable[2], /семейство/);
  assert.match(result.unavailable[3], /транспорт/);
  assert.match(result.unavailable[4], /транспорт/);
  assert.deepEqual(projectCatalog([]).models, []);
});

test("accepts the verified OpenAI Responses transport", () => {
  const result = projectCatalog([
    entry("responses-model", { verified_transport: "responses" }),
    entry("unknown-protocol", {
      protocol: "unknown",
      verified_transport: "responses",
    }),
  ]);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["responses-model"],
  );
  assert.equal(result.transports["responses-model"], "responses");
  assert.equal(result.unavailable.length, 1);
  assert.match(result.unavailable[0], /транспорт/);
});

test("prefers direct Messages when both protocol views expose a model", () => {
  const result = projectCatalog([
    entry("claude-fable-5"),
    entry("claude-fable-5", {
      protocol: "anthropic",
      verified_transport: "messages",
    }),
  ]);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["claude-fable-5"],
  );
  assert.equal(result.transports["claude-fable-5"], "messages");
  assert.deepEqual(result.unavailable, []);
  assert.equal(
    projectCatalog([entry("claude-fable-5")]).transports["claude-fable-5"],
    "chat_completions",
  );
});

test("replaces duplicate IDs in place and preserves transport priority in either order", () => {
  const chat = entry("shared");
  const responses = entry("shared", {
    verified_transport: "responses",
    name: "Responses model",
  });
  const messages = entry("shared", {
    protocol: "anthropic",
    verified_transport: "messages",
    name: "Messages model",
  });
  for (const preferred of [responses, messages]) {
    for (const pair of [
      [chat, preferred],
      [preferred, chat],
    ]) {
      const result = projectCatalog([pair[0], entry("other"), pair[1]]);
      assert.deepEqual(
        result.models.map((model) => model.id),
        ["shared", "other"],
      );
      assert.equal(result.models[0].name, preferred.gateway_metadata.name);
      assert.equal(
        result.transports.shared,
        preferred.gateway_metadata.verified_transport,
      );
    }
  }
  for (const pair of [
    [responses, messages],
    [messages, responses],
  ]) {
    const result = projectCatalog(pair);
    assert.equal(result.transports.shared, "messages");
    assert.equal(result.models[0].name, "Messages model");
  }
});
