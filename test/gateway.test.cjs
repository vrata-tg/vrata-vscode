const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  GatewayClient,
  API_ORIGIN,
  STAGING_API_ORIGIN,
} = require("../dist/gateway");
const { Credentials } = require("../dist/credentials");
const { formatError } = require("../dist/diagnostics");
const userAgent = `vrata-vscode/${require("../package.json").version}`;

test("real HTTP chain validates with GET only; zero balance and empty catalog are valid", async (t) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    const key = req.headers.authorization;
    assert.equal(req.headers["user-agent"], userAgent);
    if (key === "Bearer invalid" || key === "Bearer revoked") {
      res
        .writeHead(401)
        .end(JSON.stringify({ error: { message: "sensitive upstream body" } }));
    } else if (key === "Bearer redirect") {
      res.writeHead(302, { Location: "/leak" }).end();
    } else if (key === "Bearer malformed") {
      res.end('{"wrong":[]}');
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [] }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const client = new GatewayClient((url, options) => {
    assert.equal(url, `${API_ORIGIN}/v1/models`);
    assert.equal(options.redirect, "error");
    return fetch(
      `http://127.0.0.1:${server.address().port}/v1/models`,
      options,
    );
  });
  let stored;
  const credentials = new Credentials(
    {
      get: async () => stored,
      store: async (_name, key) => {
        stored = key;
      },
      delete: async () => {
        stored = undefined;
      },
    },
    client,
    () => {},
  );
  await credentials.initialize();
  await credentials.replace("zero-balance");
  assert.equal(credentials.connected, true);
  assert.deepEqual(credentials.catalog, []);
  for (const key of ["invalid", "revoked", "redirect", "malformed"]) {
    await assert.rejects(credentials.replace(key), (error) => {
      assert.ok(!error.message.includes("sensitive"));
      assert.ok(!error.message.includes(key));
      return true;
    });
    assert.equal(stored, "zero-balance");
  }
  await credentials.remove();
  assert.equal(calls.length, 6);
  assert.ok(
    calls.every((call) => call.method === "GET" && call.path === "/v1/models"),
  );
});

test("production and staging origins are explicit and separate", async () => {
  const calls = [];
  const create = (origin) =>
    new GatewayClient(
      async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ data: [] }));
      },
      () => {},
      origin,
    );
  await create(API_ORIGIN).models("key", new AbortController().signal);
  await create(STAGING_API_ORIGIN).models("key", new AbortController().signal);
  assert.deepEqual(calls, [
    API_ORIGIN + "/v1/models",
    API_ORIGIN + "/v1/models",
    STAGING_API_ORIGIN + "/v1/models",
    STAGING_API_ORIGIN + "/v1/models",
  ]);
});

test("network errors propagate unchanged and a cancelled request does not start fetch", async () => {
  const failure = Error("secret credential");
  const client = new GatewayClient(async () => {
    throw failure;
  });
  await assert.rejects(
    client.models("key", new AbortController().signal),
    (error) => error === failure,
  );
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const cancelled = new GatewayClient(async () => {
    requests++;
    return new Response('{"data":[]}');
  });
  await assert.rejects(cancelled.models("key", controller.signal));
  assert.equal(requests, 0);
});

test("account accepts zero balance and rejects malformed amounts", async () => {
  const account = {
    checked_at: "2026-09-25T00:00:00Z",
    balance: {
      currency: "RUB",
      unit: "coin_atoms",
      paid_available: "0",
      promo_available: "0",
      reserved: "0",
      spendable: "0",
    },
    quota: {
      currency: "RUB",
      unit: "coin_atoms",
      limit: null,
      remaining: null,
    },
  };
  let value = account;
  const client = new GatewayClient(async (url, options) => {
    assert.equal(url, `${API_ORIGIN}/v1/account`);
    assert.equal(options.method, "GET");
    assert.equal(options.headers["User-Agent"], userAgent);
    return new Response(JSON.stringify(value));
  });
  assert.equal(
    (await client.account("fixture", new AbortController().signal)).balance
      .spendable,
    "0",
  );
  value = { ...account, balance: { ...account.balance, spendable: "1.50" } };
  await assert.rejects(
    client.account("fixture", new AbortController().signal),
    { message: "INVALID_ACCOUNT" },
  );
});

test("raw diagnostics preserve unknown errors, stacks and nested causes while masking the key", async () => {
  for (const secret of ["synthetic-sensitive-key", "key'with\\slash"]) {
    const inner = Object.assign(
      new Error(`proxy negotiation failed: ${secret}`),
      {
        code: "NEW_TRANSPORT_CODE",
        detail: { credential: secret, stage: "handshake" },
      },
    );
    const failure = new TypeError("fetch failed", {
      cause: new AggregateError([inner], "connection attempts"),
    });
    const logs = [];
    const client = new GatewayClient(
      async () => {
        throw failure;
      },
      (line) => logs.push(line),
    );
    await assert.rejects(
      client.models(secret, new AbortController().signal),
      (error) => error === failure,
    );
    assert.doesNotMatch(logs.join("\n"), /fetch failed|NEW_TRANSPORT_CODE/);
    const output = formatError(failure, secret);
    assert.match(output, /TypeError: fetch failed/);
    assert.match(output, /connection attempts/);
    assert.match(output, /proxy negotiation failed/);
    assert.match(output, /NEW_TRANSPORT_CODE/);
    assert.match(output, /handshake/);
    assert.match(output, /gateway.test.cjs/);
    assert.match(output, /\[REDACTED\]/);
    assert.ok(!output.includes(secret));
    assert.ok(
      !output.includes(require("node:util").inspect(secret).slice(1, -1)),
    );
  }
});

test("diagnostics mask credentials inside mixed-quote string contexts", () => {
  const prefix = "double\" single' backtick` key=";
  for (const key of ["key'with\\slash", "key'\"`with\\slash", "plain-key"]) {
    const error = { detail: prefix + key, code: "UNKNOWN_FAILURE" };
    assert.equal(
      formatError(error, key),
      formatError({ detail: prefix + "[REDACTED]", code: "UNKNOWN_FAILURE" }),
    );
  }
});

test("HTTP status remains visible and parser/transport exceptions reach the caller unchanged", async () => {
  const cases = [
    [
      async () =>
        new Response("upstream body", {
          status: 401,
          statusText: "synthetic-key",
        }),
      /HTTP 401/,
    ],
    [async () => new Response("upstream body", { status: 503 }), /HTTP 503/],
    [async () => new Response("not json"), /SyntaxError/],
    [
      async () => {
        throw new DOMException("operation expired", "TimeoutError");
      },
      /TimeoutError\]: operation expired/,
    ],
    [
      async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("unexpected redirect"),
        });
      },
      /unexpected redirect/,
    ],
  ];
  for (const [request, expected] of cases) {
    const logs = [];
    const client = new GatewayClient(request, (line) => logs.push(line));
    await assert.rejects(
      client.models("synthetic-key", new AbortController().signal),
      (error) => {
        assert.match(formatError(error), expected);
        return true;
      },
    );
    assert.doesNotMatch(logs.join("\n"), /synthetic-key/);
  }
});

test("raw diagnostics support cyclic errors and non-Error throws", async () => {
  const failure = Object.assign(new Error("unknown original failure"), {
    code: "FUTURE_ERROR",
  });
  failure.cause = failure;
  for (const thrown of [
    failure,
    { reason: "plain object failure" },
    "plain string failure",
  ]) {
    const logs = [];
    const client = new GatewayClient(
      async () => {
        throw thrown;
      },
      (line) => logs.push(line),
    );
    await assert.rejects(
      client.models("synthetic-key", new AbortController().signal),
      (error) => error === thrown,
    );
    assert.match(
      formatError(thrown),
      /unknown original failure|plain object failure|plain string failure/,
    );
    assert.doesNotMatch(
      logs.join("\n"),
      /unknown original failure|plain object failure|plain string failure/,
    );
  }
});
