const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Panel behaviors: view registration, model/reasoning persistence, reasoning
// effort reaching the chat_completions payload, and the Copilot fallback.
test("activity bar view, saved settings and reasoning payload", async (t) => {
  const commands = new Map();
  const executed = [];
  const requests = [];
  const notices = [];
  const disposable = { dispose() {} };
  const values = new Map();
  const globalValues = new Map([["welcomeShown", true]]);
  const treeProviders = [];
  let copilotInstalled = false;
  const quickPickQueue = [];
  const chatParticipants = [];
  const context = {
    extension: { packageJSON: { version: "0.1.7" } },
    subscriptions: [],
    globalState: {
      get: (key) => globalValues.get(key),
      update: async (key, value) => {
        globalValues.set(key, value);
      },
    },
    secrets: {
      get: async (key) => values.get(key),
      store: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
      onDidChange: () => disposable,
    },
  };
  const vscode = {
    version: "1.104.0",
    env: {
      clipboard: { writeText: async () => {} },
      openExternal: async (uri) => {
        executed.push(["openExternal", uri.toString()]);
        return true;
      },
    },
    LanguageModelChatMessageRole: { Assistant: 2 },
    LanguageModelTextPart: class {
      constructor(value) {
        this.value = value;
      }
    },
    LanguageModelToolCallPart: class {
      constructor(callId, name, input) {
        Object.assign(this, { callId, name, input });
      }
    },
    LanguageModelToolResultPart: class {},
    LanguageModelChatMessage: {
      User: (content, name) => ({ role: 1, content, name }),
      Assistant: (content, name) => ({ role: 2, content, name }),
    },
    CancellationError: class extends Error {},
    ChatResponseProgressPart: class {
      constructor(value) {
        this.value = value;
      }
    },
    EventEmitter: class {
      listeners = [];
      event = (listener) => {
        this.listeners.push(listener);
        return disposable;
      };
      fire() {
        for (const listener of this.listeners) listener();
      }
      dispose() {}
    },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    StatusBarAlignment: { Right: 1 },
    ProgressLocation: { Notification: 1 },
    Uri: class {
      static parse(value) {
        return { toString: () => value };
      }
    },
    workspace: {
      getConfiguration: () => ({
        inspect: () => ({ defaultValue: undefined }),
      }),
    },
    window: {
      createOutputChannel: () => ({
        ...disposable,
        info() {},
        error() {},
        show() {},
      }),
      createStatusBarItem: () => ({ ...disposable, show() {} }),
      registerTreeDataProvider: (viewId, treeProvider) => {
        assert.equal(viewId, "vrata.panel");
        treeProviders.push(treeProvider);
        return disposable;
      },
      showQuickPick: async (items) => {
        const choice = quickPickQueue.shift();
        if (typeof choice === "function") return choice(items);
        return items.find((item) => item.label === choice) ?? undefined;
      },
      showInputBox: async () => undefined,
      withProgress: async (_o, action) => action(),
      showInformationMessage: async (message) => {
        notices.push(message);
        return undefined;
      },
      showErrorMessage: async () => undefined,
      showWarningMessage: async (_m, _o, action) => action,
    },
    commands: {
      registerCommand: (id, action) => {
        commands.set(id, action);
        return disposable;
      },
      executeCommand: async (id, ...args) => {
        executed.push([id, ...args]);
      },
    },
    extensions: {
      getExtension: (id) => (copilotInstalled ? { id } : undefined),
    },
    lm: {
      registerLanguageModelChatProvider: (vendor, value) => {
        assert.equal(vendor, "vrata");
        provider = value;
        return disposable;
      },
    },
    chat: {
      createChatParticipant: (id, handler) => {
        assert.equal(id, "vrata.agent");
        chatParticipants.push({ id, handler });
        return disposable;
      },
    },
  };
  let provider;
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    return id === "vscode" ? vscode : originalLoad.call(this, id, ...args);
  };
  const extension = require("../dist/extension");
  Module._load = originalLoad;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (options.method === "POST" && url.endsWith("/v1/chat/completions"))
      return new Response(
        'data: {"choices":[{"delta":{"content":"ready"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
      );
    if (url.endsWith("/v1/account"))
      return new Response(
        JSON.stringify({
          checked_at: "2026-10-10T00:00:00Z",
          balance: {
            currency: "RUB",
            unit: "coin_atoms",
            paid_available: "371922897",
            promo_available: "0",
            reserved: "3005077",
            spendable: "371922897",
          },
          quota: {
            currency: "RUB",
            unit: "coin_atoms",
            limit: "25000000",
            remaining: "24605830",
          },
        }),
      );
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "glm-5.3-flash",
            gateway_metadata: {
              name: "glm-5.3-flash",
              family: "glm",
              protocol: "openai",
              max_input_tokens: 200000,
              max_output_tokens: 64000,
              supports_tools: true,
              verified_transport: "chat_completions",
            },
          },
          {
            id: "claude-haiku-4-5",
            gateway_metadata: {
              name: "claude-haiku-4-5",
              family: "claude",
              protocol: "openai",
              max_input_tokens: 200000,
              max_output_tokens: 64000,
              supports_tools: true,
              verified_transport: "chat_completions",
            },
          },
        ],
      }),
    );
  };
  t.after(() => {
    global.fetch = originalFetch;
    context.subscriptions.forEach((item) => item.dispose());
  });

  await extension.activate(context);
  await new Promise(setImmediate);

  // 1. Activity Bar view is registered exactly once.
  assert.equal(treeProviders.length, 1);

  // Connect with a synthetic key (no real credentials).
  vscode.window.showInputBox = async () => "synthetic-panel-key";
  await commands.get("vrata.setApiKey")();

  const treeProvider = treeProviders[0];
  // 2. Panel shows connection state and balance rows once account loads.
  await new Promise(setImmediate);
  let items = await treeProvider.getChildren();
  assert.ok(
    items.some((item) => item.label.startsWith("Подключение: подключено")),
    JSON.stringify(items.map((item) => item.label)),
  );
  assert.ok(
    items.some((item) => item.label.includes("371,92")),
    "panel shows the spendable balance",
  );
  assert.ok(
    items.some((item) => item.label.includes("24,6")),
    "panel shows the remaining key quota",
  );
  assert.ok(
    items.some(
      (item) =>
        item.command && item.command.command === "vrata.openCopilotChat",
    ),
    "panel offers the Copilot Chat action",
  );
  assert.ok(
    items.some(
      (item) => item.command && item.command.command === "vrata.openAgentChat",
    ),
    "panel offers the built-in agent action",
  );
  assert.equal(chatParticipants.length, 1, "built-in @vrata agent registered");

  // 3. Model choice persists in globalState and shows in the panel.
  quickPickQueue.push((items) =>
    items.find((item) => item.label === "claude-haiku-4-5"),
  );
  await commands.get("vrata.selectModel")();
  assert.equal(globalValues.get("vrata.panelModel"), "claude-haiku-4-5");
  items = await treeProvider.getChildren();
  assert.ok(
    items.some((item) => item.label === "Модель: claude-haiku-4-5"),
    JSON.stringify(items.map((item) => item.label)),
  );

  // 4. Reasoning level persists and reaches the chat_completions payload.
  quickPickQueue.push((items) => items.find((item) => item.label === "high"));
  await commands.get("vrata.selectReasoning")();
  assert.equal(globalValues.get("vrata.panelReasoning"), "high");
  items = await treeProvider.getChildren();
  assert.ok(
    items.some((item) => item.label === "Reasoning: high"),
    JSON.stringify(items.map((item) => item.label)),
  );
  const models = await provider.provideLanguageModelChatInformation(
    { silent: true },
    {},
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["glm-5.3-flash", "claude-haiku-4-5"],
  );
  const parts = [];
  await provider.provideLanguageModelChatResponse(
    models[0],
    [{ role: 1, content: [new vscode.LanguageModelTextPart("hello")] }],
    {},
    { report: (part) => parts.push(part) },
    {
      isCancellationRequested: false,
      onCancellationRequested: () => disposable,
    },
  );
  const body = JSON.parse(
    requests.findLast((request) => request.options.method === "POST").options
      .body,
  );
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.model, "glm-5.3-flash");

  // 5. An explicit modelOptions override wins over the stored level.
  await provider.provideLanguageModelChatResponse(
    models[0],
    [{ role: 1, content: [new vscode.LanguageModelTextPart("hello")] }],
    { modelOptions: { reasoningEffort: "low" } },
    { report: (part) => parts.push(part) },
    {
      isCancellationRequested: false,
      onCancellationRequested: () => disposable,
    },
  );
  const overrideBody = JSON.parse(
    requests.findLast((request) => request.options.method === "POST").options
      .body,
  );
  assert.equal(overrideBody.reasoning_effort, "low");

  // 6. Without Copilot the command falls back to the Marketplace offer.
  const answer = await commands.get("vrata.openCopilotChat")();
  assert.equal(answer, undefined);
  assert.ok(
    notices.some((message) => message.includes("Copilot Chat не установлено")),
    JSON.stringify(notices),
  );
  copilotInstalled = true;
  await commands.get("vrata.openCopilotChat")();
  assert.ok(
    executed.some(([id]) => id === "workbench.action.chat.open"),
    "available Copilot Chat opens the chat view",
  );

  // 7. Restoring settings: a fresh panel reads the same globalState values.
  const restored = await treeProvider.getChildren();
  assert.ok(restored.some((item) => item.label === "Модель: claude-haiku-4-5"));
  assert.ok(restored.some((item) => item.label === "Reasoning: high"));

  // 8. The account row shows the server update time, device timezone, minute precision.
  const checkedRow = restored.find((item) =>
    item.label.startsWith("Данные от"),
  );
  assert.ok(checkedRow, "panel shows the checked-at row");
  assert.match(
    checkedRow.label,
    /Данные от: (сегодня|\d{2}\.\d{2}) \d{2}:\d{2} \(\d+ мин назад\)/,
    checkedRow.label,
  );

  // 9. The built-in @vrata agent: model from the panel, reasoning in modelOptions,
  //    tool loop through vscode.lm.invokeTool.
  const agent = chatParticipants[0];
  const agentSend = [];
  const agentRequests = [];
  const agentModel = {
    id: "glm-5.3-flash",
    sendRequest: async (_messages, options, _token) => {
      agentSend.push(options);
      agentRequests.push(
        requests.findLast((request) => request.options.method === "POST"),
      );
      return {
        stream: (async function* () {
          if (agentSend.length === 1)
            yield new vscode.LanguageModelToolCallPart(
              "call-1",
              "copilot_searchWorkspaceSymbols",
              { query: "files" },
            );
          yield new vscode.LanguageModelTextPart("done");
        })(),
      };
    },
  };
  vscode.lm.selectChatModels = async (selector) =>
    selector?.id === "glm-5.3-flash" || selector?.id === "claude-haiku-4-5"
      ? [{ ...agentModel, id: selector.id }]
      : [];
  const toolInputs = [];
  vscode.lm.invokeTool = async (name, options) => {
    toolInputs.push({ name, input: options.input });
    return {
      content: [new vscode.LanguageModelTextPart("tool ok")],
    };
  };
  const pushed = [];
  const chatToken = {
    isCancellationRequested: false,
    throwIfCancellationRequested: () => {},
    onCancellationRequested: () => disposable,
  };
  await agent.handler(
    {
      prompt: "list files",
      tools: [{ name: "copilot_searchWorkspaceSymbols" }],
      toolMode: 0,
      toolInvocationToken: {},
    },
    { history: [] },
    {
      markdown: (value) => pushed.push(String(value)),
      push: async () => {},
    },
    chatToken,
  );
  assert.equal(agentSend.length, 2, "agent issues both loop requests");
  assert.equal(
    agentSend[0].modelOptions.reasoningEffort,
    "high",
    "agent forwards the stored reasoning level in modelOptions",
  );
  assert.equal(
    JSON.parse(agentRequests[0].options.body).model,
    "glm-5.3-flash",
    "provider request used the panel-selected model",
  );
  assert.deepEqual(
    toolInputs.map((tool) => tool.name),
    ["copilot_searchWorkspaceSymbols"],
    "agent invokes editor tools (built-in + Copilot tools alike)",
  );
});
