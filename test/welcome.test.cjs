const { test } = require("node:test");
const assert = require("node:assert/strict");
const { modelPickerTabsEnabled } = require("../dist/welcome");

function configuration(value) {
  return {
    get(setting) {
      assert.equal(setting, "experimentalModelPicker");
      return value;
    },
  };
}

test("uses the effective model picker experiment before the default changed", () => {
  assert.equal(modelPickerTabsEnabled("1.141.0", configuration(true)), true);
  assert.equal(modelPickerTabsEnabled("1.141.2", configuration(false)), false);
});

test("uses the tabbed picker after it became the default", () => {
  assert.equal(modelPickerTabsEnabled("1.142.0", configuration(false)), true);
  assert.equal(modelPickerTabsEnabled("1.143.0", configuration(false)), true);
});
