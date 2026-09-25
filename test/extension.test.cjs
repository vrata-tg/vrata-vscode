const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

test("native commands, masked input, silent discovery and secret events", async (t) => {
  const commands = new Map();
  const logLines = [];
  const infoLines = [],
    errorLines = [];
  let logShown = 0;
  let dismissStartupError;
  let holdStartupError = true;
  let statusShown = false;
  const executed = [];
  let utilitySettingAvailable = false;
  const values = new Map();
  const errors = [],
    notices = [],
    requests = [];
  let readFailure = new Error("keyring startup failure", {
    cause: new Error("native keyring cause"),
  });
  let storeFailure, deleteFailure, fetchFailure, contextFailure, infoFailure;
  let holdNotifications = false;
  const dismissNotifications = [];
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
      get: async (key) => {
        if (readFailure) throw readFailure;
        return values.get(key);
      },
      store: async (key, value) => {
        if (storeFailure) throw storeFailure;
        values.set(key, value);
        secretListener({ key });
      },
      delete: async (key) => {
        if (deleteFailure) throw deleteFailure;
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
    LanguageModelToolResultPart: class {
      constructor(callId, content) {
        Object.assign(this, { callId, content });
      }
    },
    workspace: {
      getConfiguration: () => ({
        inspect: () =>
          utilitySettingAvailable
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
      createOutputChannel: (name, options) => {
        assert.equal(name, "Врата AI");
        assert.deepEqual(options, { log: true });
        return {
          ...disposable,
          info: (line) => {
            infoLines.push(line);
            logLines.push(line);
          },
          error: (line) => {
            errorLines.push(line);
            logLines.push(line);
          },
          show: () => logShown++,
        };
      },
      createStatusBarItem: () => ({
        ...disposable,
        show() {
          statusShown = true;
        },
      }),
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
        if (infoFailure) throw infoFailure;
        if (holdNotifications)
          await new Promise((resolve) => dismissNotifications.push(resolve));
      },
      showErrorMessage: async (message, action) => {
        errors.push(message);
        if (holdStartupError)
          await new Promise((resolve) => {
            dismissStartupError = resolve;
          });
        if (action !== undefined) assert.equal(action, "Открыть журнал");
        return action;
      },
      showWarningMessage: async (_message, _options, action) => action,
    },
    commands: {
      registerCommand: (id, action) => {
        commands.set(id, action);
        return disposable;
      },
      executeCommand: async (id, ...args) => {
        executed.push([id, ...args]);
        if (id === "setContext" && contextFailure) throw contextFailure;
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
    if (fetchFailure) throw fetchFailure;
    return options.headers.Authorization === "Bearer invalid"
      ? new Response('{"error":{"message":"private data"}}', { status: 401 })
      : new Response(
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
    dismissStartupError?.();
    dismissNotifications.forEach((resolve) => resolve());
    global.fetch = originalFetch;
    context.subscriptions.forEach((item) => item.dispose());
  });
  let activated = false;
  const activation = extension.activate(context).then(() => {
    activated = true;
  });
  await new Promise(setImmediate);
  assert.equal(
    activated,
    true,
    "activation must finish while the keyring error notification is open",
  );
  assert.ok(provider, "provider must be available before dismissing the error");
  assert.equal(statusShown, true);
  assert.equal(logShown, 0);
  holdStartupError = false;
  dismissStartupError();
  await activation;
  await new Promise(setImmediate);
  assert.equal(logShown, 1, "Open log action still works after activation");
  assert.match(errorLines.join("\n"), /keyring startup failure/);
  assert.match(logLines.join("\n"), /native keyring cause/);
  assert.match(logLines.join("\n"), /at TestContext/);
  readFailure = undefined;
  errors.length = 0;
  logLines.length = 0;
  logShown = 0;
  await commands.get("vrata.utilitySettings")();
  assert.equal(
    executed.some(([id]) => id === "workbench.action.openSettings"),
    false,
    "older editors must not open a setting they do not support",
  );
  assert.ok(notices.some((message) => message.includes("недоступна")));
  utilitySettingAvailable = true;
  await commands.get("vrata.utilitySettings")();
  assert.ok(
    executed.some(
      ([id, setting]) =>
        id === "workbench.action.openSettings" &&
        setting === "chat.byokUtilityModelDefault",
    ),
  );
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
  const discoveryTasks = [];
  provider.onDidChangeLanguageModelChatInformation(() => {
    discoveryTasks.push(
      provider.provideLanguageModelChatInformation({ silent: true }, {}),
    );
  });
  input = "  arbitrary-format  ";
  holdNotifications = true;
  let firstFinished = false;
  const firstInsertion = commands
    .get("vrata.setApiKey")()
    .then(() => {
      firstFinished = true;
    });
  await new Promise(setImmediate);
  const firstInputCount = inputCount;
  input = undefined;
  await commands.get("vrata.setApiKey")();
  assert.equal(
    inputCount,
    firstInputCount + 1,
    "replacement input must open while the success notification remains visible",
  );
  assert.equal(
    firstFinished,
    true,
    "saving the key must not wait for notification dismissal",
  );
  holdNotifications = false;
  dismissNotifications.forEach((resolve) => resolve());
  await firstInsertion;
  await Promise.all(discoveryTasks);
  const discovered = await Promise.all([
    provider.provideLanguageModelChatInformation({ silent: true }, {}),
    provider.provideLanguageModelChatInformation({ silent: true }, {}),
  ]);
  assert.deepEqual(
    discovered.map((models) => models.map((model) => model.id)),
    [["gpt-5.6-terra"], ["gpt-5.6-terra"]],
  );
  assert.equal(discovered[0][0].maxInputTokens, 120000);
  assert.equal(discovered[0][0].capabilities.imageInput, false);
  assert.equal(
    requests.length,
    1,
    "discovery must reuse the catalog returned by key validation",
  );
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
  assert.match(errors[0], /HTTP 401/);
  assert.equal(logShown, 1);
  await commands.get("vrata.showLogs")();
  assert.equal(logShown, 2);
  assert.ok(logLines.some((line) => line.includes("HTTP 401")));
  let changes = 0;
  provider.onDidChangeLanguageModelChatInformation(() => changes++);
  input = "replacement";
  await commands.get("vrata.setApiKey")();
  assert.equal(
    changes,
    1,
    "self secret event must not invalidate the new account twice",
  );
  const beforeRefresh = requests.length;
  await commands.get("vrata.refreshModels")();
  assert.equal(requests.length, beforeRefresh + 1);
  assert.equal(changes, 2);
  await commands.get("vrata.removeApiKey")();
  assert.equal(values.size, 0);
  const requestCount = requests.length;
  await provider.provideLanguageModelChatInformation({ silent: true }, {});
  assert.equal(requests.length, requestCount);
  assert.equal(changes, 3);
  assert.ok(
    !JSON.stringify([...errors, ...notices, ...logLines]).includes(
      "arbitrary-format",
    ),
  );
  const assertLogged = (pattern) =>
    assert.match(errorLines.join("\n"), pattern);
  input = "synthetic-new-key";
  storeFailure = new Error(`storage refused ${input}`, {
    cause: Object.assign(new Error("native storage failure"), {
      code: "UNKNOWN_STORAGE_CODE",
    }),
  });
  await commands.get("vrata.setApiKey")();
  assertLogged(/storage refused \[REDACTED\]/);
  assertLogged(/native storage failure/);
  assertLogged(/UNKNOWN_STORAGE_CODE/);
  assertLogged(/at TestContext/);
  assert.ok(!logLines.join("\n").includes(input));
  storeFailure = undefined;
  fetchFailure = new TypeError("catalog fetch failed", {
    cause: new AggregateError(
      [
        Object.assign(new Error(`proxy rejected ${input}`), {
          code: "NEW_TRANSPORT_CODE",
          stage: "handshake",
        }),
      ],
      "connection attempts",
    ),
  });
  await commands.get("vrata.setApiKey")();
  assertLogged(/catalog fetch failed/);
  assertLogged(/NEW_TRANSPORT_CODE/);
  assertLogged(/handshake/);
  assertLogged(/connection attempts/);
  assert.equal(
    errorLines.filter((line) => line.includes("catalog fetch failed")).length,
    1,
  );
  assert.doesNotMatch(
    infoLines.join("\n"),
    /catalog fetch failed|NEW_TRANSPORT_CODE/,
  );
  fetchFailure = undefined;
  contextFailure = new Error("setContext editor failure");
  infoFailure = new Error("saved notification failed");
  await commands.get("vrata.setApiKey")();
  await new Promise(setImmediate);
  assertLogged(/setContext editor failure/);
  assertLogged(/saved notification failed/);
  infoFailure = undefined;
  contextFailure = undefined;

  deleteFailure = new Error(`delete refused ${input}`, {
    cause: new Error("delete cause"),
  });
  await commands.get("vrata.removeApiKey")();
  assertLogged(/delete refused \[REDACTED\]/);
  assertLogged(/delete cause/);
  deleteFailure = undefined;

  readFailure = new Error("secret event read failure", {
    cause: new Error("read cause"),
  });
  secretListener({ key: "vrata.apiKey" });
  await new Promise(setImmediate);
  assertLogged(/secret event read failure/);
  assertLogged(/read cause/);
  readFailure = undefined;

  // Errors before the HTTP request (including a disconnected session) must be logged too.
  const credentials = context.subscriptions.find(
    (item) => typeof item.loadCatalog === "function",
  );
  const loadCatalog = credentials.loadCatalog;
  credentials.loadCatalog = async () => {
    throw new Error("catalog preparation failed");
  };
  assert.deepEqual(
    (
      await provider.provideLanguageModelChatInformation({ silent: true }, {})
    ).map((model) => model.id),
    ["gpt-5.6-terra"],
  );
  assertLogged(/catalog preparation failed/);
  credentials.loadCatalog = loadCatalog;

  fetchFailure = new Error(`stream failed ${input}`, {
    cause: new Error("stream socket cause"),
  });
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => disposable,
  };
  await assert.rejects(
    provider.provideLanguageModelChatResponse(
      discovered[0][0],
      [],
      {},
      { report() {} },
      token,
    ),
    /Не удалось получить ответ/,
  );
  assert.equal(JSON.parse(requests.at(-1).options.body).model, "gpt-5.6-terra");
  assertLogged(/stream failed \[REDACTED\]/);
  assertLogged(/stream socket cause/);
  fetchFailure = undefined;
  await commands.get("vrata.removeApiKey")();
  await assert.rejects(
    provider.provideLanguageModelChatResponse(
      { id: "fixture", maxOutputTokens: 10 },
      [],
      {},
      { report() {} },
      token,
    ),
  );
  assertLogged(/Врата AI не подключены/);

  // Non-Error exceptions from editor commands are also useful diagnostics.
  vscode.workspace.getConfiguration = () => {
    throw { operation: "read editor config", code: 735 };
  };
  await commands.get("vrata.utilitySettings")();
  assertLogged(/read editor config/);
  assertLogged(/735/);
  assert.ok(!JSON.stringify([...errors, ...logLines]).includes(input));

  const cyclicInput = {};
  cyclicInput.self = cyclicInput;
  await assert.rejects(
    provider.provideTokenCount(
      {},
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        content: [
          new vscode.LanguageModelToolCallPart("call", "run", cyclicInput),
        ],
      },
    ),
    TypeError,
  );
  assertLogged(/circular/);
  const message = {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    content: [
      new vscode.LanguageModelToolCallPart("call", "run", { path: "тест.js" }),
    ],
  };
  assert.ok(
    (await provider.provideTokenCount({}, message)) >
      (await provider.provideTokenCount({}, "run")),
  );

  vscode.window.showErrorMessage = async () => {
    throw new Error("notification failed");
  };
  await commands.get("vrata.utilitySettings")();
  assertLogged(/notification failed/);

  const activationFailure = new Error("provider registration failed", {
    cause: new Error("activation cause"),
  });
  vscode.lm.registerLanguageModelChatProvider = () => {
    throw activationFailure;
  };
  await assert.rejects(
    extension.activate(context),
    (error) => error === activationFailure,
  );
  assertLogged(/provider registration failed/);
  assertLogged(/activation cause/);
});
