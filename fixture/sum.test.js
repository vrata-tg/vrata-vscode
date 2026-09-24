const assert = require("node:assert/strict");
const { sum } = require("./sum");
assert.equal(sum([2, 3, 8]), 13);
assert.equal(sum([]), 0);
assert.equal(sum([-2, 5]), 3);
console.log("3 assertions passed");
