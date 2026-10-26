const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rubles, accountTooltip } = require("../dist/account");
const { diagnosticReport } = require("../dist/diagnostics");
const { requestError } = require("../dist/request-errors");
const { TransportError } = require("../dist/transport");
const { CredentialError } = require("../dist/gateway");

test("balance and quota stay separate, including zero and reserve", () => {
  const tooltip = accountTooltip({
    balance: {
      paid_available: "1000000",
      promo_available: "250000",
      reserved: "500000",
      spendable: "1250000",
    },
    quota: { limit: "2000000", remaining: "0" },
  });
  assert.match(tooltip, /На счёте доступно: 1,25 ₽/);
  assert.match(tooltip, /В резерве под текущие запросы: 0,5 ₽/);
  assert.match(tooltip, /Остаток лимита ключа: 0 ₽/);
  assert.equal(rubles("0"), "0 ₽");
});

test("unset key quota is omitted from the account tooltip", () => {
  const tooltip = accountTooltip({
    balance: {
      paid_available: "0",
      promo_available: "0",
      reserved: "0",
      spendable: "0",
    },
    quota: { limit: null, remaining: null },
  });
  assert.doesNotMatch(tooltip, /лимит ключа/i);
});

test("request errors map to actions without upstream details", () => {
  assert.equal(
    requestError(new TransportError("insufficient_balance", 402)).action
      .command,
    "vrata.getApiKey",
  );
  assert.equal(
    requestError(new TransportError("rate_limit", 429)).action,
    undefined,
  );
  assert.equal(
    requestError(new TransportError("key_limit", 429)).action.command,
    "vrata.getApiKey",
  );
  assert.equal(
    requestError(new CredentialError("no session")).action.command,
    "vrata.setApiKey",
  );
});

test("diagnostic report includes only approved fields", () => {
  const report = diagnosticReport({
    editorVersion: "1.104.0",
    extensionVersion: "0.1.6",
    modelId: "claude-fable-5",
    code: "stream_error",
    requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    prompt: "private prompt",
    key: "private key",
  });
  assert.match(report, /Модель: claude-fable-5/);
  assert.match(report, /Код: stream_error/);
  assert.doesNotMatch(report, /private|prompt|key/);
  assert.doesNotMatch(
    diagnosticReport({
      editorVersion: "1.104.0",
      extensionVersion: "0.1.6",
      modelId: "/home/user/file",
    }),
    /home\/user/,
  );
});
