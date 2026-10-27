const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const CHAT_EXTENSION = "GitHub.copilot-chat";
const NEW_CHAT = "workbench.action.chat.newLocalChat";
const ACTIONS = ["Открыть Copilot Chat", "Инструкция"];

function registerCommands({
  installed = {},
  choice,
  newLocalChat = false,
  warningResult = Promise.resolve(choice),
} = {}) {
  const commands = new Map();
  const events = [];
  const warnings = [];
  const executed = [];
  const vscode = {
    extensions: {
      getExtension(id) {
        events.push(["extension", id]);
        return installed[id];
      },
    },
    window: {
      showWarningMessage(...args) {
        warnings.push(args);
        events.push(["warning"]);
        return warningResult;
      },
    },
    commands: {
      getCommands: async () => (newLocalChat ? [NEW_CHAT] : []),
      executeCommand: async (...args) => {
        executed.push(args);
        events.push(["command", ...args]);
      },
    },
  };
  const panelPath = require.resolve("../dist/panel");
  const previousPanel = require.cache[panelPath];
  const originalLoad = Module._load;
  let registerPanelCommands;
  try {
    delete require.cache[panelPath];
    Module._load = function (id, ...args) {
      return id === "vscode" ? vscode : originalLoad.call(this, id, ...args);
    };
    ({ registerPanelCommands } = require(panelPath));
  } finally {
    Module._load = originalLoad;
    if (previousPanel) require.cache[panelPath] = previousPanel;
    else delete require.cache[panelPath];
  }
  registerPanelCommands(
    { modelId: "test-model" },
    () => [{ id: "test-model" }],
    (id, action) => commands.set(id, action),
  );
  return { commands, events, warnings, executed };
}

function expectedFlow(command, newLocalChat = false) {
  if (command === "vrata.openChat") return [["workbench.action.chat.open"]];
  return [
    ...(newLocalChat ? [[NEW_CHAT]] : []),
    [
      "workbench.action.chat.open",
      { modelSelector: { vendor: "vrata", id: "test-model" } },
    ],
    ["workbench.action.chat.openModelPicker"],
  ];
}

function assertAdvisory(warnings) {
  assert.equal(warnings.length, 1);
  const [, ...items] = warnings[0];
  assert.deepEqual(
    items.filter((item) => typeof item === "string"),
    ACTIONS,
  );
  assert.ok(
    items.every((item) => typeof item !== "object" || item.modal !== true),
    "the advisory must be nonmodal",
  );
}

test("registering panel commands does not check Chat or show an advisory", () => {
  const { commands, events, warnings } = registerCommands();
  assert.ok(commands.has("vrata.openChat"));
  assert.ok(commands.has("vrata.openModelPicker"));
  assert.deepEqual(events, []);
  assert.deepEqual(warnings, []);
});

for (const command of ["vrata.openChat", "vrata.openModelPicker"]) {
  test(`${command}: installed inactive Copilot Chat opens without warning`, async () => {
    const { commands, events, warnings, executed } = registerCommands({
      installed: { [CHAT_EXTENSION]: { isActive: false } },
    });

    await commands.get(command)();

    assert.deepEqual(events[0], ["extension", CHAT_EXTENSION]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(executed, expectedFlow(command));
  });

  for (const [description, installed] of [
    ["no Copilot extensions", {}],
    ["only legacy Copilot", { "GitHub.copilot": { isActive: true } }],
  ]) {
    test(`${command}: ${description} warns, dismissal continues`, async () => {
      const { commands, events, warnings, executed } = registerCommands({
        installed,
      });

      await commands.get(command)();

      assert.deepEqual(events.slice(0, 2), [
        ["extension", CHAT_EXTENSION],
        ["warning"],
      ]);
      assertAdvisory(warnings);
      assert.deepEqual(executed, expectedFlow(command));
    });
  }

  for (const [choice, helpCommand] of [
    [ACTIONS[0], ["extension.open", CHAT_EXTENSION]],
    [ACTIONS[1], ["vrata.openWalkthrough"]],
  ]) {
    test(`${command}: ${choice} opens help and continues`, async () => {
      const { commands, warnings, executed } = registerCommands({ choice });

      await commands.get(command)();

      assertAdvisory(warnings);
      assert.deepEqual(executed, [helpCommand, ...expectedFlow(command)]);
    });
  }
}

test("model picker awaits the advisory before creating a native local chat", async () => {
  const { promise, resolve } = Promise.withResolvers();
  const { commands, events, warnings, executed } = registerCommands({
    newLocalChat: true,
    warningResult: promise,
  });

  const opening = commands.get("vrata.openModelPicker")();
  try {
    await new Promise(setImmediate);
    assert.deepEqual(events, [["extension", CHAT_EXTENSION], ["warning"]]);
    assertAdvisory(warnings);
    assert.deepEqual(executed, [], "native chat waits for advisory dismissal");
  } finally {
    resolve();
    await opening;
  }

  assert.deepEqual(executed, expectedFlow("vrata.openModelPicker", true));
});
