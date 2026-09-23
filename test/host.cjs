// Run with --extensionTestsPath after building. No gateway requests are made.
const assert = require("node:assert/strict");
const vscode = require("vscode");
const http = require("node:http");
exports.run = async () => {
  let wire;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    wire = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"content":"fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.VRATA_SPIKE_ENDPOINT = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  process.env.VRATA_SPIKE_KEY = "offline-test";
  try {
    const extension = vscode.extensions.getExtension(
      "vrata.vrata-provider-spike",
    );
    assert.ok(extension);
    await extension.activate();
    const models = await vscode.lm.selectChatModels({ vendor: "vrata" });
    assert.equal(models.length, 2);
    console.log(
      JSON.stringify(
        models.map((m) => ({
          id: m.id,
          maxInputTokens: m.maxInputTokens,
          capabilities: m.capabilities,
        })),
      ),
    );
    assert.ok(
      models.every(
        (m) => m.capabilities.supportsToolCalling && m.maxInputTokens === 60000,
      ),
    );
    const { toMessages } = require("../dist/extension");
    const T = vscode.LanguageModelTextPart;
    const C = vscode.LanguageModelToolCallPart;
    const R = vscode.LanguageModelToolResultPart;
    const M = vscode.LanguageModelChatMessage;
    assert.deepEqual(
      toMessages([
        M.User("read"),
        M.Assistant([
          new T("checking"),
          new C("a", "read_file", { path: "sum.js" }),
          new C("b", "run", { cmd: "test" }),
        ]),
        M.User([
          new R("a", [new T("file")]),
          new R("b", [new T("passed")]),
          new T("continue"),
        ]),
      ]),
      [
        { role: "user", content: "read" },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [
            {
              id: "a",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"sum.js"}' },
            },
            {
              id: "b",
              type: "function",
              function: { name: "run", arguments: '{"cmd":"test"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "file" },
        { role: "tool", tool_call_id: "b", content: "passed" },
        { role: "user", content: "continue" },
      ],
    );
    assert.throws(
      () =>
        toMessages([
          M.User([
            new vscode.LanguageModelDataPart(new Uint8Array([1]), "image/png"),
          ]),
        ]),
      /text and tool/,
    );
    const response = await models[0].sendRequest([M.User("offline")], {
      tools: [{ name: "no_args", description: "No arguments" }],
      toolMode: vscode.LanguageModelChatToolMode.Required,
    });
    let output = "";
    for await (const part of response.text) output += part;
    assert.equal(output, "fixture");
    assert.equal(wire.tool_choice, "required");
    assert.deepEqual(wire.tools[0].function.parameters, {
      type: "object",
      properties: {},
    });
    assert.equal(wire.n, undefined);
    const session = await vscode.authentication.getSession(
      "github",
      ["user:email"],
      { createIfNone: false },
    );
    assert.equal(
      session,
      undefined,
      "Run host smoke in a clean signed-out profile",
    );
    console.log(
      JSON.stringify({
        stable_api: true,
        vscode: vscode.version,
        models: models.length,
        tool_history: true,
        github_session: false,
        no_arg_tool: true,
      }),
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
};
