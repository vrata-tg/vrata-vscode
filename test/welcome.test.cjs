const { test } = require("node:test");
const assert = require("node:assert/strict");
const { modelPickerTabsEnabled } = require("../dist/welcome");

function configuration(available, value) {
  return {
    inspect(setting) {
      assert.equal(setting, "experimentalModelPicker");
      return available ? { defaultValue: false } : undefined;
    },
    get(setting) {
      assert.equal(setting, "experimentalModelPicker");
      return value;
    },
  };
}

test("uses the effective model picker experiment when VS Code exposes it", () => {
  assert.equal(
    modelPickerTabsEnabled("1.141.0", configuration(true, true)),
    true,
  );
  assert.equal(
    modelPickerTabsEnabled("1.141.2", configuration(true, false)),
    false,
  );
});

test("falls back to the tabbed picker default after the experiment setting is removed", () => {
  assert.equal(modelPickerTabsEnabled("1.135.0", configuration(false)), false);
  assert.equal(modelPickerTabsEnabled("1.142.0", configuration(false)), true);
});
