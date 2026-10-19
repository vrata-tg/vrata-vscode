const assert = require("node:assert/strict");
const http = require("node:http");
const vscode = require("vscode");

exports.run = async (extensionPath) => {
  const { streamChat } = require(`${extensionPath}/dist/transport`);
  const { toResponsePart } = require(`${extensionPath}/dist/response-part`);
  const usage = {
    prompt_tokens: 60,
    completion_tokens: 12,
    total_tokens: 72,
    prompt_tokens_details: { cached_tokens: 30 },
  };
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-host-key");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    assert.equal(JSON.parse(raw).stream_options.include_usage, true);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\n' +
        `data: ${JSON.stringify({ choices: [], usage })}\n\n` +
        "data: [DONE]\n\n",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registration = vscode.lm.registerLanguageModelChatProvider(
    "vrata-usage-test",
    {
      provideLanguageModelChatInformation: async () => [
        {
          id: "usage-fixture",
          name: "Usage fixture",
          family: "fixture",
          version: "1",
          maxInputTokens: 1000,
          maxOutputTokens: 100,
          capabilities: {},
        },
      ],
      provideTokenCount: async () => 1,
      provideLanguageModelChatResponse: async (
        _model,
        _messages,
        _options,
        progress,
      ) => {
        await streamChat(
          `http://127.0.0.1:${server.address().port}/chat`,
          "synthetic-host-key",
          {},
          new AbortController().signal,
          (part) => {
            const converted = toResponsePart(part);
            if (converted) progress.report(converted);
          },
        );
      },
    },
  );
  try {
    const [model] = await vscode.lm.selectChatModels({
      vendor: "vrata-usage-test",
    });
    assert.ok(model);
    const response = await model.sendRequest([
      vscode.LanguageModelChatMessage.User("fixture"),
    ]);
    const parts = [];
    for await (const part of response.stream) parts.push(part);
    assert.equal(parts[0].value, "ready");
    const [major, minor] = vscode.version.split(".").map(Number);
    const supportsUsage = major > 1 || (major === 1 && minor >= 106);
    if (supportsUsage) {
      assert.equal(parts.length, 2);
      assert.ok(parts[1] instanceof vscode.LanguageModelDataPart);
      assert.equal(parts[1].mimeType, "usage");
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(parts[1].data)),
        usage,
      );
    } else assert.equal(parts.length, 1);
    return supportsUsage;
  } finally {
    registration.dispose();
    server.closeAllConnections();
    server.close();
  }
};
