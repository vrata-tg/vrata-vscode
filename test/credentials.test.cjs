const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  Credentials,
  CredentialOperationCancelled,
  SECRET_KEY,
} = require("../dist/credentials");
const { AccountError } = require("../dist/gateway");

function fixture(initial) {
  let now = 0;
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
    account: async () => ({
      checked_at: "2026-09-25T00:00:00Z",
      balance: {
        paid_available: "0",
        promo_available: "0",
        reserved: "0",
        spendable: "0",
      },
      quota: { limit: null, remaining: null },
    }),
  };
  const changes = [];
  const sessionChanges = [];
  const credentials = new Credentials(
    secrets,
    client,
    (sessionChanged) => {
      changes.push(credentials.connected);
      sessionChanges.push(sessionChanged);
    },
    () => now,
  );
  return {
    credentials,
    secrets,
    values,
    reads,
    changes,
    sessionChanges,
    client,
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

test("same-key replacement flags a new session, data updates and self reload do not", async () => {
  const f = fixture("same");
  await f.credentials.reload();
  await f.credentials.loadCatalog();
  await f.credentials.loadAccount();
  assert.deepEqual(f.sessionChanges, [true, undefined, undefined]);
  await f.credentials.replace("same");
  assert.equal(f.credentials.account, undefined);
  await f.credentials.reload();
  assert.deepEqual(f.sessionChanges, [true, undefined, undefined, true]);
  await f.credentials.remove();
  assert.deepEqual(f.sessionChanges, [true, undefined, undefined, true, true]);
});

test("late account reply cannot populate a new session with the same key", async () => {
  const f = fixture("same");
  await f.credentials.reload();
  const account = await f.client.account();
  let complete, signal;
  f.client.account = (_key, requestSignal) => {
    signal = requestSignal;
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const old = assert.rejects(
    f.credentials.loadAccount(),
    CredentialOperationCancelled,
  );
  await f.credentials.replace("same");
  assert.equal(signal.aborted, true);
  complete(account);
  await old;
  assert.equal(f.credentials.account, undefined);
  assert.deepEqual(f.sessionChanges, [true, true]);
  f.client.account = async () => account;
  await f.credentials.loadAccount();
  assert.equal(f.credentials.account, account);
});

test("account refresh coalesces, keeps stale value, and isolates replacement keys", async () => {
  const f = fixture();
  await f.credentials.reload();
  await f.credentials.replace("old");
  let resolve;
  let reads = 0;
  f.client.account = async () => {
    reads++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const first = f.credentials.loadAccount();
  const same = f.credentials.loadAccount();
  assert.equal(reads, 1);
  resolve({
    checked_at: "2026-09-25T00:00:00Z",
    balance: {
      paid_available: "0",
      promo_available: "0",
      reserved: "0",
      spendable: "0",
    },
    quota: { limit: null, remaining: null },
  });
  await Promise.all([first, same]);
  assert.equal(f.credentials.account.balance.spendable, "0");
  f.client.account = async () => {
    throw new Error("offline");
  };
  await assert.rejects(f.credentials.loadAccount());
  assert.equal(f.credentials.accountUnavailable, false);
  await f.credentials.replace("new");
  assert.equal(f.credentials.account, undefined);
  f.client.account = async () => {
    throw new AccountError(401);
  };
  await assert.rejects(f.credentials.loadAccount());
  assert.equal(f.credentials.accountInvalid, true);
  assert.deepEqual(f.sessionChanges, [
    true,
    undefined,
    undefined,
    true,
    undefined,
  ]);
});

test("trim, validate read-only, persist and restore arbitrary-format key", async () => {
  const f = fixture();
  await f.credentials.reload();
  assert.equal(f.credentials.connected, false);
  await f.credentials.replace("  arbitrary key  ");
  assert.equal(f.values.get(SECRET_KEY), "arbitrary key");
  assert.deepEqual(f.reads, ["arbitrary key"]);
  assert.deepEqual(f.credentials.catalog, [{ id: "arbitrary key" }]);
  const restarted = new Credentials(f.secrets, f.client, () => {});
  await restarted.reload();
  assert.equal(restarted.connected, true);
  await restarted.loadCatalog();
  assert.deepEqual(restarted.catalog, f.credentials.catalog);
});

test("empty, invalid, revoked and failed storage preserve previous session", async () => {
  const f = fixture("old");
  await f.credentials.reload();
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
  assert.deepEqual(f.sessionChanges, [true, undefined]);
});

test("replacement aborts old requests, rejects late responses", async () => {
  const f = fixture("old");
  await f.credentials.reload();
  let complete, signal;
  const old = f.credentials.run(async (session) => {
    signal = session.signal;
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
    assert.equal(session.key, "new");
  });
  assert.deepEqual(f.credentials.catalog, [{ id: "new" }]);
});

test("deletion wins over pending validation and never revokes server key", async () => {
  const f = fixture("old");
  await f.credentials.reload();
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
  await f.credentials.reload();
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
  assert.deepEqual(f.sessionChanges, [true, true, true]);
});

test("late old catalog cannot overwrite the replacement account", async () => {
  const f = fixture("old");
  await f.credentials.reload();
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
  await f.credentials.reload();
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
  await f.credentials.reload();
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
  await f.credentials.reload();
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
  f.client.models = async (key) => {
    f.reads.push(key);
    return [];
  };
  await f.credentials.replace("new");
  await Promise.all([f.credentials.loadCatalog(), f.credentials.loadCatalog()]);
  await f.credentials.loadCatalog();
  assert.deepEqual(f.reads, ["new"]);
  assert.deepEqual(f.credentials.catalog, []);
});

test("restored sessions share loading and back off after a failed request", async () => {
  const f = fixture("saved");
  await f.credentials.reload();
  let reject, resolve;
  f.client.models = (key) => {
    f.reads.push(key);
    return new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
  };
  const first = f.credentials.loadCatalog();
  const second = f.credentials.loadCatalog();
  const failed = Promise.allSettled([first, second]);
  assert.equal(
    f.reads.length,
    1,
    "concurrent discovery must share one HTTP request",
  );
  reject(new Error("temporary failure"));
  assert.ok((await failed).every((result) => result.status === "rejected"));
  assert.equal(f.credentials.catalogUnavailable, true);
  await f.credentials.loadCatalog();
  assert.equal(
    f.reads.length,
    1,
    "silent discovery must respect the retry delay",
  );
  const retry = f.credentials.loadCatalog(true);
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

test("TTL refresh marks only the same key's old catalog stale after failure", async () => {
  const f = fixture();
  await f.credentials.replace("first");
  assert.equal(f.credentials.catalogStale, false);
  f.advance(Credentials.catalogTtlMs);
  f.client.models = async () => {
    throw Error("offline");
  };
  await assert.rejects(f.credentials.loadCatalog(), /offline/);
  assert.equal(f.credentials.catalogStale, true);
  assert.deepEqual(f.credentials.catalog, [{ id: "first" }]);
  await f.credentials.loadCatalog();
  assert.deepEqual(f.reads, ["first"]);
  f.advance(Credentials.catalogRetryMs);
  f.client.models = async (key) => {
    f.reads.push(key);
    return [{ id: `${key}-updated` }];
  };
  await f.credentials.loadCatalog();
  assert.equal(f.credentials.catalogStale, false);
  assert.deepEqual(f.credentials.catalog, [{ id: "first-updated" }]);
  await f.credentials.replace("second");
  assert.deepEqual(f.credentials.catalog, [{ id: "second-updated" }]);
  assert.equal(f.credentials.catalogStale, false);
  assert.deepEqual(f.sessionChanges, [true, undefined, undefined, true]);
});

test("disposal during deletion does not notify disposed subscribers", async () => {
  const f = fixture("old");
  await f.credentials.reload();
  let finishDelete;
  f.secrets.delete = () =>
    new Promise((resolve) => {
      finishDelete = resolve;
    });
  const removal = f.credentials.remove();
  await new Promise(setImmediate);
  f.credentials.dispose();
  const changeCount = f.changes.length;
  finishDelete();
  await assert.rejects(removal, CredentialOperationCancelled);
  assert.equal(f.changes.length, changeCount);
  assert.equal(f.credentials.connected, false);
});

test("disposal cancels a queued deletion before touching SecretStorage", async () => {
  const f = fixture("old");
  await f.credentials.reload();
  let finishRead;
  f.secrets.get = () =>
    new Promise((resolve) => {
      finishRead = resolve;
    });
  const reload = f.credentials.reload();
  await new Promise(setImmediate);
  const removal = f.credentials.remove();
  f.credentials.dispose();
  finishRead("old");
  await reload;
  await assert.rejects(removal, CredentialOperationCancelled);
  assert.equal(f.values.get(SECRET_KEY), "old");
  assert.deepEqual(f.changes, [true]);
});
