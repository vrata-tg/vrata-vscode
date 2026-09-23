const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Credentials, SECRET_KEY } = require("../dist/credentials");

function fixture(initial) {
  const values = new Map(initial ? [[SECRET_KEY, initial]] : []);
  const secrets = {
    get: async (name) => values.get(name),
    store: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => {
      values.delete(name);
    },
  };
  const reads = [];
  const client = {
    models: async (key) => {
      reads.push(key);
      if (key === "invalid" || key === "revoked") throw new Error("denied");
      return [{ id: key }];
    },
  };
  const changes = [];
  const credentials = new Credentials(secrets, client, () =>
    changes.push(credentials.connected),
  );
  return { credentials, secrets, values, reads, changes, client };
}

test("trim, validate read-only, persist and restore arbitrary-format key", async () => {
  const f = fixture();
  await f.credentials.initialize();
  assert.equal(f.credentials.connected, false);
  await f.credentials.replace("  arbitrary key  ");
  assert.equal(f.values.get(SECRET_KEY), "arbitrary key");
  assert.deepEqual(f.reads, ["arbitrary key"]);
  assert.deepEqual(f.credentials.catalog, [{ id: "arbitrary key" }]);
  const restarted = new Credentials(f.secrets, f.client, () => {});
  await restarted.initialize();
  assert.equal(restarted.connected, true);
  await restarted.loadCatalog();
  assert.deepEqual(restarted.catalog, f.credentials.catalog);
});

test("empty, invalid, revoked and failed storage preserve previous session", async () => {
  const f = fixture("old");
  await f.credentials.initialize();
  await f.credentials.loadCatalog();
  for (const value of ["  ", "invalid", "revoked"]) {
    await assert.rejects(f.credentials.replace(value));
    assert.equal(f.values.get(SECRET_KEY), "old");
    assert.deepEqual(f.credentials.catalog, [{ id: "old" }]);
  }
  f.secrets.store = async () => {
    throw Error("storage failed");
  };
  await assert.rejects(f.credentials.replace("new"));
  assert.equal(f.values.get(SECRET_KEY), "old");
  assert.deepEqual(f.credentials.catalog, [{ id: "old" }]);
});

test("replacement aborts old requests, clears account cache and rejects late responses", async () => {
  const f = fixture("old");
  await f.credentials.initialize();
  let complete, signal;
  const old = f.credentials.run(async (session) => {
    signal = session.signal;
    session.cache.set("balance", "old balance");
    await new Promise((resolve) => {
      complete = resolve;
    });
    return "old result";
  });
  await f.credentials.replace("new");
  assert.equal(signal.aborted, true);
  complete();
  await assert.rejects(old);
  await f.credentials.run(async (session) => {
    assert.equal(session.cache.size, 0);
    assert.equal(session.key, "new");
  });
  assert.deepEqual(f.credentials.catalog, [{ id: "new" }]);
});

test("deletion wins over pending validation and never revokes server key", async () => {
  const f = fixture("old");
  await f.credentials.initialize();
  let complete;
  f.client.models = async () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const replacement = f.credentials.replace("new");
  await f.credentials.remove();
  complete([]);
  await assert.rejects(replacement);
  assert.equal(f.credentials.connected, false);
  assert.equal(f.values.has(SECRET_KEY), false);
  assert.deepEqual(f.credentials.catalog, []);
  await assert.rejects(
    f.credentials.run(async () => assert.fail("must not request")),
  );
});

test("external SecretStorage changes invalidate the current account", async () => {
  const f = fixture("old");
  await f.credentials.initialize();
  let signal;
  await f.credentials.run(async (session) => {
    signal = session.signal;
  });
  await f.secrets.store(SECRET_KEY, "other window");
  await f.credentials.reload();
  assert.equal(signal.aborted, true);
  await f.credentials.run(async (session) =>
    assert.equal(session.key, "other window"),
  );
  await f.secrets.delete(SECRET_KEY);
  await f.credentials.reload();
  assert.equal(f.credentials.connected, false);
});

test("late old catalog cannot overwrite the replacement account", async () => {
  const f = fixture("old");
  await f.credentials.initialize();
  let complete;
  f.client.models = async (key) =>
    key === "old"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : [{ id: key }];
  const refresh = f.credentials.loadCatalog();
  await f.credentials.replace("new");
  complete([{ id: "old" }]);
  await assert.rejects(refresh);
  assert.deepEqual(f.credentials.catalog, [{ id: "new" }]);
});

test("latest validation wins even if an aborted request completes late", async () => {
  const f = fixture("old");
  await f.credentials.initialize();
  let complete;
  f.client.models = async (key) =>
    key === "slow"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : [{ id: key }];
  const slow = f.credentials.replace("slow");
  await f.credentials.replace("fast");
  complete([{ id: "slow" }]);
  await assert.rejects(slow);
  assert.equal(f.values.get(SECRET_KEY), "fast");
  assert.deepEqual(f.credentials.catalog, [{ id: "fast" }]);
});

test("failed deletion preserves the current working session", async () => {
  const f = fixture("old");
  await f.credentials.initialize();
  f.secrets.delete = async () => {
    throw Error("storage unavailable");
  };
  await assert.rejects(f.credentials.remove());
  assert.equal(f.values.get(SECRET_KEY), "old");
  await f.credentials.run(async (session) => {
    assert.equal(session.key, "old");
    assert.equal(session.signal.aborted, false);
  });
});

test("delete during a pending store must not report replacement success", async () => {
  const f = fixture("old");
  await f.credentials.initialize();
  let finishStore, enteredStore;
  const started = new Promise((resolve) => {
    enteredStore = resolve;
  });
  f.secrets.store = async (key, value) => {
    enteredStore();
    await new Promise((resolve) => {
      finishStore = resolve;
    });
    f.values.set(key, value);
  };
  const replacement = f.credentials.replace("new");
  await started;
  const removal = f.credentials.remove();
  finishStore();
  await assert.rejects(replacement);
  await removal;
  assert.equal(f.values.size, 0);
  assert.equal(f.credentials.connected, false);
});

test("discovery reuses a validated empty catalog without checking the key again", async () => {
  const f = fixture();
  f.client.models = async (key) => { f.reads.push(key); return []; };
  await f.credentials.replace("new");
  await Promise.all([f.credentials.loadCatalog(), f.credentials.loadCatalog()]);
  await f.credentials.loadCatalog();
  assert.deepEqual(f.reads, ["new"]);
  assert.deepEqual(f.credentials.catalog, []);
});

test("restored sessions share catalog loading and retry after a failed request", async () => {
  const f = fixture("saved");
  await f.credentials.initialize();
  let reject, resolve;
  f.client.models = (key) => {
    f.reads.push(key);
    return new Promise((yes, no) => { resolve = yes; reject = no; });
  };
  const first = f.credentials.loadCatalog();
  const second = f.credentials.loadCatalog();
  const failed = Promise.allSettled([first, second]);
  assert.equal(f.reads.length, 1, "concurrent discovery must share one HTTP request");
  reject(new Error("temporary failure"));
  assert.ok((await failed).every((result) => result.status === "rejected"));
  const retry = f.credentials.loadCatalog();
  resolve([]);
  await retry;
  await f.credentials.loadCatalog();
  assert.equal(f.reads.length, 2);
  await f.secrets.store(SECRET_KEY, "external");
  await f.credentials.reload();
  const changed = f.credentials.loadCatalog();
  resolve([{ id: "external model" }]);
  await changed;
  assert.deepEqual(f.reads, ["saved", "saved", "external"]);
  assert.deepEqual(f.credentials.catalog, [{ id: "external model" }]);
});
