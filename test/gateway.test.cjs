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
