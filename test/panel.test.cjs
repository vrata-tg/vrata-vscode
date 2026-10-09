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
    !items.some(
      (item) =>
        item.command && item.command.command === "vrata.openCopilotChat",
    ),
    "panel no longer offers the Copilot Chat action",
  );
  assert.ok(
    !items.some(
      (item) => item.command && item.command.command === "vrata.openAgentChat",
    ),
    "no custom chat-participant action: the standard chat agent is used",
  );

  // 3. Model choice persists in globalState and shows in the panel — silently.
  notices.length = 0;
  quickPickQueue.push((items) =>
    items.find((item) => item.label === "claude-haiku-4-5"),
  );
  await commands.get("vrata.selectModel")();
  assert.equal(globalValues.get("vrata.panelModel"), "claude-haiku-4-5");
  assert.equal(notices.length, 0, "model choice shows no notification");
  items = await treeProvider.getChildren();
  assert.ok(
    items.some((item) => item.label === "Модель: claude-haiku-4-5"),
    JSON.stringify(items.map((item) => item.label)),
  );

  // 4. Reasoning level persists and reaches the chat_completions payload.
  //    The picker offers the full gateway set plus the server default.
  quickPickQueue.push((items) => items.find((item) => item.label === "High"));
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
    ["glm-5.3-flash", "claude-haiku-4-5", "vrata-auto"],
  );
  // The routed entry advertises the panel's current target and reasoning.
  const routedEntry = models.find((model) => model.id === "vrata-auto");
  assert.ok(routedEntry, "the stable routed entry is exposed to the chat");
  assert.match(routedEntry.detail, /→ claude-haiku-4-5/);
  assert.match(routedEntry.detail, /reasoning high/);
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

  // 5a. The routed chat entry sends the PANEL's model to the gateway,
  //     never the synthetic vrata-auto id, and keeps the stored reasoning.
  await provider.provideLanguageModelChatResponse(
    routedEntry,
    [{ role: 1, content: [new vscode.LanguageModelTextPart("hello")] }],
    {},
    { report: (part) => parts.push(part) },
    {
      isCancellationRequested: false,
      onCancellationRequested: () => disposable,
    },
  );
  const routedBody = JSON.parse(
    requests.findLast((request) => request.options.method === "POST").options
      .body,
  );
  assert.equal(
    routedBody.model,
    "claude-haiku-4-5",
    "routed entry sends the panel's chosen model",
  );
  assert.equal(routedBody.reasoning_effort, "high");

  // 5b. Changing the panel model re-points the routed entry, including the
  //     provider's advertised detail line.
  quickPickQueue.push((pickerItems) =>
    pickerItems.find((item) => item.label === "glm-5.3-flash"),
  );
  await commands.get("vrata.selectModel")();
  const refreshed = await provider.provideLanguageModelChatInformation(
    { silent: true },
    {},
  );
  assert.match(
    refreshed.find((model) => model.id === "vrata-auto").detail,
    /→ glm-5\.3-flash/,
    "routed entry follows the panel choice",
  );

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

  // 7. Restoring settings: a fresh panel reads the same globalState values
  //    (the panel model is glm-5.3-flash since step 5b).
  const restored = await treeProvider.getChildren();
  assert.ok(restored.some((item) => item.label === "Модель: glm-5.3-flash"));
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

  // 9. Every provider request is logged with model, transport and effort —
  //    the observable trace for standard-agent chat requests.
  await provider.provideLanguageModelChatResponse(
    models[0],
    [{ role: 1, content: [new vscode.LanguageModelTextPart("hello")] }],
    {},
    { report: () => {} },
    {
      isCancellationRequested: false,
      onCancellationRequested: () => disposable,
    },
  );

  // 10. Full reasoning set: none, xhigh and max persist and ride the payload.
  for (const [label, effort] of [
    ["None", "none"],
    ["Extra High", "xhigh"],
    ["Max", "max"],
  ]) {
    quickPickQueue.push((pickerItems) =>
      pickerItems.find((item) => item.label === label),
    );
    await commands.get("vrata.selectReasoning")();
    assert.equal(
      globalValues.get("vrata.panelReasoning"),
      effort,
      `reasoning ${label} persists`,
    );
  }
  await provider.provideLanguageModelChatResponse(
    models[0],
    [{ role: 1, content: [new vscode.LanguageModelTextPart("hello")] }],
    {},
    { report: () => {} },
    {
      isCancellationRequested: false,
      onCancellationRequested: () => disposable,
    },
  );
  assert.equal(
    JSON.parse(
      requests.findLast((request) => request.options.method === "POST").options
        .body,
    ).reasoning_effort,
    "max",
    "the last picked level reaches the payload",
  );
  // Back to the server default: the stored level clears.
  quickPickQueue.push((pickerItems) =>
    pickerItems.find((item) => item.label === "По умолчанию сервера"),
  );
  await commands.get("vrata.selectReasoning")();
  assert.equal(globalValues.get("vrata.panelReasoning"), undefined);

  // 11. Picking a model stays silent: the panel row already shows the choice.
  notices.length = 0;
  quickPickQueue.push((pickerItems) =>
    pickerItems.find((item) => item.label === "glm-5.3-flash"),
  );
  await commands.get("vrata.selectModel")();
  assert.equal(globalValues.get("vrata.panelModel"), "glm-5.3-flash");
  assert.equal(notices.length, 0, "model choice shows no notification");
});
