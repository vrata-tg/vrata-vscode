const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Extension must not touch staging in the normal user scenario: only the
// explicit vrata.debugStaging command may reach the staging origin.
test("normal user scenario never contacts staging", async (t) => {
  const requests = [];
  const executed = [];
  const commands = new Map();
  const disposable = { dispose() {} };
  const values = new Map();
  const globalValues = new Map([["welcomeShown", true]]);
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
      openExternal: async () => true,
    },
    LanguageModelChatMessageRole: { Assistant: 2 },
    LanguageModelTextPart: class {
      constructor(value) {
        this.value = value;
      }
    },
    LanguageModelToolCallPart: class {},
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
      createStatusBarItem: () => ({
        ...disposable,
        show() {},
        hide() {},
      }),
      registerTreeDataProvider: () => disposable,
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      withProgress: async (_o, action) => action(),
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
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
    extensions: { getExtension: () => undefined },
    lm: {
      registerLanguageModelChatProvider: () => disposable,
    },
  };
  const originalLoad = Module._load;
  Module._load = function (id, ...args) {
    return id === "vscode" ? vscode : originalLoad.call(this, id, ...args);
  };
  const extension = require("../dist/extension");
  Module._load = originalLoad;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/v1/account"))
      return new Response(
        JSON.stringify({
          checked_at: "2026-10-10T00:00:00Z",
          balance: {
            currency: "RUB",
            unit: "coin_atoms",
            paid_available: "1000000",
            promo_available: "0",
            reserved: "0",
            spendable: "1000000",
          },
          quota: {
            currency: "RUB",
            unit: "coin_atoms",
            limit: null,
            remaining: null,
          },
        }),
      );
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "gpt-5.6-terra",
            gateway_metadata: {
              name: "gpt-5.6-terra",
              family: "gpt",
              protocol: "openai",
              max_input_tokens: 120000,
              max_output_tokens: 8000,
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

  // Full silent user flow: key insert, discovery, response, refreshes.
  vscode.window.showInputBox = async () => "user-key";
  await commands.get("vrata.setApiKey")();
  await new Promise(setImmediate);
  const treeProvider = context.subscriptions.find(
    (item) => typeof item.getChildren === "function",
  );
  assert.ok(treeProvider, "panel tree provider must be registered");
  const items = await treeProvider.getChildren();
  assert.ok(
    !items.some((item) =>
      /Модель|Reasoning|Обновить|Данные от/.test(item.label),
    ),
  );
  assert.ok(!items.some((item) => /лимит ключа/i.test(item.label)));
  await commands.get("vrata.refreshModels")();

  assert.ok(
    requests.every((request) =>
      request.url.startsWith("https://api.vrata.tg/"),
    ),
    "every request targets the production origin",
  );
  assert.ok(
    !requests.some((request) => request.url.includes("staging")),
    "no staging traffic outside vrata.debugStaging",
  );
});
