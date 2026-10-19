const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("activity bar view, saved settings and reasoning payload", async (t) => {
  const commands = new Map();
  const executed = [];
  const requests = [];
  const notices = [];
  const errors = [];
  const loggedErrors = [];
  const disposable = { dispose() {} };
  const values = new Map();
  const globalValues = new Map([["welcomeShown", true]]);
  const treeProviders = [];

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
      static joinPath(base, ...parts) {
        return { toString: () => [base.toString(), ...parts].join("/") };
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
        error(error) {
          loggedErrors.push(error);
        },
        show() {},
      }),
      createStatusBarItem: () => ({
        ...disposable,
        show() {},
        hide() {},
      }),
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
      showErrorMessage: async (message) => {
        errors.push(message);
      },
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
      getCommands: async () => [],
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

  assert.equal(treeProviders.length, 1);

  vscode.window.showInputBox = async () => "synthetic-panel-key";
  await commands.get("vrata.setApiKey")();

  const treeProvider = treeProviders[0];
  await new Promise(setImmediate);
  let items = await treeProvider.getChildren();
  assert.ok(
    !items.some((item) => item.label.startsWith("Подключение:")),
    JSON.stringify(items.map((item) => item.label)),
  );
  assert.ok(
    items.some((item) => item.label.includes("371,92")),
    "panel shows the spendable balance",
  );
  const balanceItem = items.find((item) => item.contextValue === "balance");
  assert.equal(
    balanceItem.command.command,
    "vrata.getApiKey",
    "clicking the balance opens the bot",
  );
  await commands.get(balanceItem.command.command)();
  assert.ok(
    executed.some(
      ([id, url]) => id === "openExternal" && url === "https://vrata.tg/bot",
    ),
    "balance action opens the official bot URL",
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
    items.some(
      (item) =>
        item.command &&
        item.command.command === "vrata.openModelPicker" &&
        item.label === "Выбрать модель в чате",
    ),
    "connected panel offers a direct model-selection action",
  );
  assert.ok(
    !items.some(
      (item) => item.command && item.command.command === "vrata.openAgentChat",
    ),
    "no custom chat-participant action: the standard chat agent is used",
  );

  notices.length = 0;
  quickPickQueue.push((items) =>
    items.find((item) => item.label === "claude-haiku-4-5"),
  );
  await commands.get("vrata.selectModel")();
  assert.equal(globalValues.get("vrata.panelModel"), "claude-haiku-4-5");
  assert.equal(notices.length, 0, "model choice shows no notification");
  items = await treeProvider.getChildren();
  assert.ok(!items.some((item) => item.label.startsWith("Модель:")));

  quickPickQueue.push((items) => items.find((item) => item.label === "High"));
  await commands.get("vrata.selectReasoning")();
  assert.equal(globalValues.get("vrata.panelReasoning"), "high");
  items = await treeProvider.getChildren();
  assert.ok(!items.some((item) => item.label.startsWith("Reasoning:")));
  const models = await provider.provideLanguageModelChatInformation(
    { silent: true },
    {},
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["glm-5.3-flash", "claude-haiku-4-5"],
  );
  assert.deepEqual(
    models.map((model) => model.category),
    [
      { label: "Врата AI", order: 0 },
      { label: "Врата AI", order: 0 },
    ],
    "Vrata models use the chat picker category instead of Other Models",
  );
  vscode.version = "1.138.0";
  const currentModels = await provider.provideLanguageModelChatInformation(
    { silent: true },
    {},
  );
  assert.equal(currentModels[0].category, "Врата AI");
  assert.ok(!models.some((model) => /авто/i.test(model.name)));
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

  await provider.provideLanguageModelChatResponse(
    models[1],
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
    "selected catalog model is used directly",
  );
  assert.equal(routedBody.reasoning_effort, "high");

  quickPickQueue.push((pickerItems) =>
    pickerItems.find((item) => item.label === "glm-5.3-flash"),
  );
  await commands.get("vrata.selectModel")();
  const refreshed = await provider.provideLanguageModelChatInformation(
    { silent: true },
    {},
  );
  assert.deepEqual(
    refreshed.map((model) => model.id),
    ["glm-5.3-flash", "claude-haiku-4-5"],
  );

  const restored = await treeProvider.getChildren();
  assert.ok(
    !restored.some((item) =>
      /^(Модель:|Reasoning:|Данные от:|Обновить$)/.test(item.label),
    ),
  );

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
  quickPickQueue.push((pickerItems) =>
    pickerItems.find((item) => item.label === "По умолчанию сервера"),
  );
  await commands.get("vrata.selectReasoning")();
  assert.equal(globalValues.get("vrata.panelReasoning"), undefined);

  notices.length = 0;
  quickPickQueue.push((pickerItems) =>
    pickerItems.find((item) => item.label === "glm-5.3-flash"),
  );
  await commands.get("vrata.selectModel")();
  assert.equal(globalValues.get("vrata.panelModel"), "glm-5.3-flash");
  assert.equal(notices.length, 0, "model choice shows no notification");

  executed.length = 0;
  await commands.get("vrata.openChat")();
  const chatOpen = executed.find(([id]) => id === "workbench.action.chat.open");
  assert.ok(chatOpen, "open-chat action opens the built-in chat");
  assert.equal(
    chatOpen.length,
    1,
    "chat opens with no text injected into the input",
  );

  quickPickQueue.push((pickerItems) =>
    pickerItems.find((item) => item.label === "claude-haiku-4-5"),
  );
  await commands.get("vrata.selectModel")();
  executed.length = 0;
  await commands.get("vrata.openModelPicker")();
  assert.deepEqual(executed, [
    [
      "workbench.action.chat.open",
      { modelSelector: { vendor: "vrata", id: "claude-haiku-4-5" } },
    ],
    ["workbench.action.chat.openModelPicker"],
  ]);

  vscode.commands.getCommands = async () => [
    "workbench.action.chat.newLocalChat",
  ];
  executed.length = 0;
  await commands.get("vrata.openModelPicker")();
  assert.deepEqual(executed, [
    ["workbench.action.chat.newLocalChat"],
    [
      "workbench.action.chat.open",
      { modelSelector: { vendor: "vrata", id: "claude-haiku-4-5" } },
    ],
    ["workbench.action.chat.openModelPicker"],
  ]);
  const failure = new Error("private editor failure synthetic-panel-key");
  vscode.commands.executeCommand = async () => {
    throw failure;
  };
  vscode.commands.getCommands = async () => {
    throw failure;
  };
  vscode.window.showQuickPick = async () => {
    throw failure;
  };
  for (const id of [
    "openChat",
    "openModelPicker",
    "selectModel",
    "selectReasoning",
  ]) {
    const before = loggedErrors.length;
    await commands.get(`vrata.${id}`)();
    assert.equal(loggedErrors.length, before + 1);
    assert.match(loggedErrors.at(-1), /private editor failure/);
    assert.doesNotMatch(loggedErrors.at(-1), /synthetic-panel-key/);
    assert.doesNotMatch(
      errors.at(-1),
      /private editor failure|synthetic-panel-key/,
    );
  }
});
