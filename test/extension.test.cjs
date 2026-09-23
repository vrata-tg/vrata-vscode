const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

test("native commands, masked input, silent discovery and secret events", async (t) => {
  const commands = new Map();
  const executed = [];
  let utilitySettingAvailable = false;
  const values = new Map();
  const errors = [],
    notices = [],
    requests = [];
  let input,
    inputOptions,
    inputCount = 0,
    manageCount = 0,
    provider,
    secretListener;
  const disposable = { dispose() {} };
  const context = {
    subscriptions: [],
    globalState: { get: () => true },
    secrets: {
      get: async (key) => values.get(key),
      store: async (key, value) => {
        values.set(key, value);
        secretListener({ key });
      },
      delete: async (key) => {
        values.delete(key);
        secretListener({ key });
      },
      onDidChange: (listener) => {
        secretListener = listener;
        return disposable;
      },
    },
  };
  const vscode = {
    workspace: {
      getConfiguration: () => ({
        inspect: () => utilitySettingAvailable
          ? { defaultValue: "default" }
          : { key: "chat.byokUtilityModelDefault", defaultValue: undefined },
      }),
    },
    EventEmitter: class {
      events = new EventEmitter();
      event = (listener) => {
        this.events.on("change", listener);
        return disposable;
      };
      fire() {
        this.events.emit("change");
      }
      dispose() {
        this.events.removeAllListeners();
      }
    },
    StatusBarAlignment: { Right: 1 },
    ProgressLocation: { Notification: 1 },
    window: {
      createStatusBarItem: () => ({ ...disposable, show() {} }),
      showQuickPick: async () => {
        manageCount++;
        return undefined;
      },
      showInputBox: async (options) => {
        inputCount++;
        inputOptions = options;
        return input;
      },
      withProgress: async (_options, action) => action(),
      showInformationMessage: async (message) => {
        notices.push(message);
      },
      showErrorMessage: async (message) => {
        errors.push(message);
      },
      showWarningMessage: async () => "Удалить локальный ключ",
    },
    commands: {
      registerCommand: (id, action) => {
        commands.set(id, action);
        return disposable;
      },
      executeCommand: async (id, ...args) => {
        executed.push([id, ...args]);
        return commands.get(id)?.(...args);
      },
    },
    lm: {
      registerLanguageModelChatProvider: (vendor, value) => {
        assert.equal(vendor, "vrata");
        provider = value;
        return disposable;
      },
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
    return options.headers.Authorization === "Bearer invalid"
      ? new Response('{"error":{"message":"private data"}}', { status: 401 })
      : new Response('{"data":[]}');
  };
  t.after(() => {
    global.fetch = originalFetch;
    context.subscriptions.forEach((item) => item.dispose());
  });
  await extension.activate(context);
  await commands.get("vrata.utilitySettings")();
  assert.equal(executed.some(([id]) => id === "workbench.action.openSettings"), false,
    "older editors must not open a setting they do not support");
  assert.ok(notices.some((message) => message.includes("недоступна")));
  utilitySettingAvailable = true;
  await commands.get("vrata.utilitySettings")();
  assert.ok(executed.some(([id, setting]) =>
    id === "workbench.action.openSettings" && setting === "chat.byokUtilityModelDefault"));
  for (const silent of [true, true, false]) {
    assert.deepEqual(
      await provider.provideLanguageModelChatInformation({ silent }, {}),
      [],
    );
  }
  assert.equal(inputCount, 0);
  assert.equal(
    manageCount,
    1,
    "explicit Add Models must open provider management",
  );
  assert.equal(requests.length, 0);
  input = "  arbitrary-format  ";
  await commands.get("vrata.setApiKey")();
  assert.equal(inputOptions.password, true);
  assert.equal(inputOptions.value, undefined);
  assert.ok(inputOptions.validateInput(" "));
  assert.equal(inputOptions.validateInput("x"), undefined);
  assert.equal(values.get("vrata.apiKey"), "arbitrary-format");
  input = undefined;
  await commands.get("vrata.setApiKey")();
  assert.equal(values.get("vrata.apiKey"), "arbitrary-format");
  assert.equal(requests.length, 1);
  input = "invalid";
  await commands.get("vrata.setApiKey")();
  assert.equal(values.get("vrata.apiKey"), "arbitrary-format");
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes("private data"));
  let changes = 0;
  provider.onDidChangeLanguageModelChatInformation(() => changes++);
  input = "replacement";
  await commands.get("vrata.setApiKey")();
  assert.equal(
    changes,
    1,
    "self secret event must not invalidate the new account twice",
  );
  await commands.get("vrata.removeApiKey")();
  assert.equal(values.size, 0);
  const requestCount = requests.length;
  await provider.provideLanguageModelChatInformation({ silent: true }, {});
  assert.equal(requests.length, requestCount);
  assert.equal(changes, 2);
  assert.ok(
    requests.every(
      ({ url, options }) =>
        url === "https://api.vrata.tg/v1/models" && options.method === "GET",
    ),
  );
  assert.ok(
    !JSON.stringify([...errors, ...notices]).includes("arbitrary-format"),
  );
});
