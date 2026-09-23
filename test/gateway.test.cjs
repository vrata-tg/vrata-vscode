const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { GatewayClient, API_ORIGIN } = require("../dist/gateway");
const { Credentials } = require("../dist/credentials");

test("real HTTP chain validates with GET only; zero balance and empty catalog are valid", async (t) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    const key = req.headers.authorization;
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
  assert.equal(calls.length, 5);
  assert.ok(
    calls.every((call) => call.method === "GET" && call.path === "/v1/models"),
  );
});

test("network errors are sanitized and a cancelled request does not start fetch", async () => {
  const client = new GatewayClient(async () => {
    throw Error("secret credential");
  });
  await assert.rejects(
    client.models("key", new AbortController().signal),
    (error) => !error.message.includes("secret"),
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

test("network diagnostics preserve nested cause codes without exposing credentials", async () => {
  const secret = "synthetic-sensitive-key";
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "UND_ERR_CONNECT_TIMEOUT"]) {
    const logs = [];
    const client = new GatewayClient(async () => {
      throw new TypeError(`fetch failed ${secret}`, {
        cause: new AggregateError([
          Object.assign(new Error(`Authorization: Bearer ${secret}`), { code }),
        ]),
      });
    }, (message) => logs.push(message));
    await assert.rejects(client.models(secret, new AbortController().signal), (error) => {
      assert.ok(error.message.includes(code));
      assert.ok(!error.message.includes(secret));
      return true;
    });
    assert.ok(logs.some((line) => line.includes(code)));
    assert.ok(logs.some((line) => line.includes("GET https://api.vrata.tg/v1/models")));
    assert.ok(!logs.join("\n").includes(secret));
    assert.ok(!logs.join("\n").includes("Authorization"));
  }
});

test("HTTP, timeout, JSON and redirect failures have distinct safe diagnostics", async () => {
  const cases = [
    [async () => new Response("private upstream body", { status: 401 }), /HTTP 401/],
    [async () => new Response("private upstream body", { status: 403 }), /HTTP 403/],
    [async () => new Response("private upstream body", { status: 429 }), /HTTP 429/],
    [async () => new Response("private upstream body", { status: 503 }), /HTTP 503/],
    [async () => new Response("private upstream body"), /INVALID_JSON/],
    [async () => new Response('{"wrong":[]}'), /INVALID_CATALOG/],
    [async () => { throw new DOMException("private upstream body", "TimeoutError"); }, /TIMEOUT/],
    [async () => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); }, /REDIRECT/],
  ];
  for (const [request, expected] of cases) {
    const logs = [];
    const client = new GatewayClient(request, (line) => logs.push(line));
    await assert.rejects(client.models("synthetic-key", new AbortController().signal), expected);
    assert.match(logs.join("\n"), expected);
    assert.doesNotMatch(logs.join("\n"), /private upstream body|synthetic-key/);
  }
});

test("unknown and cyclic causes stay bounded and do not leak raw error fields", async () => {
  const error = Object.assign(new Error("synthetic-secret"), { code: "synthetic-secret" });
  error.cause = error;
  const logs = [];
  const client = new GatewayClient(async () => { throw error; }, (line) => logs.push(line));
  await assert.rejects(client.models("synthetic-secret", new AbortController().signal), /NETWORK_ERROR/);
  assert.doesNotMatch(logs.join("\n"), /synthetic-secret/);
});
