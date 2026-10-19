const assert = require("node:assert/strict");
const http = require("node:http");
const vscode = require("vscode");
exports.run = async () => {
  if (process.env.VRATA_HOST_VERSION) {
    assert.equal(vscode.version, process.env.VRATA_HOST_VERSION);
  }
  const extension = vscode.extensions.getExtension("vrata.vrata-ai");
  assert.ok(extension, "Install the VSIX first");
  await extension.activate();
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await vscode.lm.selectChatModels({ vendor: "vrata" }), []);
  }
  const commands = await vscode.commands.getCommands();
  for (const id of [
    "manage",
    "setApiKey",
    "removeApiKey",
    "refreshModels",

    "copyDiagnostics",
    "getApiKey",
    "openWalkthrough",
    "showLogs",
  ]) {
    assert.ok(commands.includes(`vrata.${id}`));
  }
  await vscode.commands.executeCommand("vrata.showLogs");
  assert.equal(
    extension.packageJSON.contributes.languageModelChatProviders[0]
      .managementCommand,
    "vrata.manage",
  );
  const { secrets } = await vscode.extensions
    .getExtension("vrata-test.vrata-host-tests")
    .activate();
  const { Credentials, SECRET_KEY } = require(
    `${extension.extensionPath}/dist/credentials`,
  );
  const { GatewayClient } = require(`${extension.extensionPath}/dist/gateway`);
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    assert.equal(req.headers.authorization, "Bearer synthetic-host-key");
    res.end(
      req.headers["anthropic-version"]
        ? '{"data":[]}'
        : '{"data":[{"id":"synthetic-catalog"}]}',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new GatewayClient((_url, options) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/models`, options),
  );
  const credentials = new Credentials(secrets, client, () => {});
  try {
    await credentials.reload();
    if (process.env.VRATA_HOST_PHASE === "write") {
      assert.equal(credentials.connected, false, "Use a clean profile");
      await credentials.replace("  synthetic-host-key  ");
      assert.equal(await secrets.get(SECRET_KEY), "synthetic-host-key");
    } else {
      assert.equal(process.env.VRATA_HOST_PHASE, "read");
      assert.equal(
        credentials.connected,
        true,
        "Secret must survive a host restart",
      );
      await credentials.loadCatalog();
      assert.deepEqual(credentials.catalog, [{ id: "synthetic-catalog" }]);
      await credentials.remove();
      assert.equal(await secrets.get(SECRET_KEY), undefined);
      assert.equal(credentials.connected, false);
    }
    assert.ok(
      calls.every(
        (call) => call.method === "GET" && call.path === "/v1/models",
      ),
    );
    assert.equal(calls.length, 2);
    assert.equal(
      await vscode.authentication.getSession("github", ["user:email"], {
        createIfNone: false,
      }),
      undefined,
    );
    const usagePart = await require("./host-usage.cjs").run(
      extension.extensionPath,
    );
    return {
      vscode: vscode.version,
      phase: process.env.VRATA_HOST_PHASE,
      installed_provider: true,
      secret_storage: true,
      readonly_requests: calls.length,
      github_session: false,
      usage_data_part: usagePart,
      node: process.versions.node,
      utility_setting_available:
        vscode.workspace
          .getConfiguration("chat")
          .inspect("byokUtilityModelDefault")?.defaultValue !== undefined,
    };
  } finally {
    credentials.dispose();
    server.closeAllConnections();
    server.close();
  }
};
