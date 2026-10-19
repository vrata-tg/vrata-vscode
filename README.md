# Vrata VS Code provider spike

Extension repository for
[ai-billing-gateway #335](https://github.com/v-lebedev/ai-billing-gateway/issues/335).
The package lives at this repository's root. Follow-up work is tracked in the
gateway repository: [onboarding #336](https://github.com/v-lebedev/ai-billing-gateway/issues/336),
[server API #337](https://github.com/v-lebedev/ai-billing-gateway/issues/337),
[catalog #338](https://github.com/v-lebedev/ai-billing-gateway/issues/338) and
[transport #339](https://github.com/v-lebedev/ai-billing-gateway/issues/339).

Imported from `ai-billing-gateway` commit
`ddf80125859bb606a6a35fdae425461a21baccee`, directory
`prototypes/vscode-provider`; this repository is now the canonical code location.

Development-only provider for the built-in **local Agent** in stable VS Code
1.138.0. Uses the stable Language Model Chat Provider API and one Chat
Completions adapter for `gpt-5.6-terra` and `claude-sonnet-5`. VS Code owns tools,
permissions, history, file edits and terminal execution. No custom agent loop.

This is a reproducible developer probe, not the installable MVP. The two model
IDs and 60,000 input / 4,096 output token caps are probe settings, not a catalog
or verified model maxima. Token estimation (UTF-8 bytes / 3) is approximate and
has no billing authority. Text and text tool results only; images, opaque
reasoning and other part types fail explicitly. No retries. Registration is
restricted to development/test extension hosts. SecretStorage and production
onboarding belong to #336; dynamic metadata to #337/#338.

## Offline checks (no credentials or paid calls)

```sh
npm ci
npm test
```

The transport tests use a local HTTP server, including fragmented streaming,
interleaved tool calls, cancellation, HTTP errors and incomplete streams. CI
runs these checks, then packages the extension as a VSIX and uploads it as the
`vrata-provider-spike-vsix` artifact. Download it from **Actions → CI → run →
Artifacts**. CI runs on pushes to `main`, pull requests, and manual dispatch.
The fixture is intentionally broken;
its test becomes green only after the agent fixes it.

To build the same package locally after `npm ci`, run `npm run package`.
It produces `vrata-provider-spike-<version>.vsix`. This remains a development-only
probe: installing the VSIX does not enable the provider in a normal extension host.

For a real stable extension-host check, use isolated empty profile/extension
directories and the absolute path to this package:

```sh
code --user-data-dir /tmp/vrata-host-profile \
  --extensions-dir /tmp/vrata-host-extensions \
  --extensionDevelopmentPath "$PWD" \
  --extensionTestsPath "$PWD/test/host.cjs"
```

This test starts its own loopback fake gateway and never reads live credentials.
It checks provider discovery, signed-out GitHub state, real VS Code tool-part
serialization and a parameterless tool request. No proposed API flags.

## Release a new version

Open **Actions → Release → Run workflow**, select **main**, and enter the next
stable version without `v`, for example `0.0.2`. The workflow updates
`package.json` and `package-lock.json`, runs the offline tests, builds the VSIX,
then commits the version, pushes an annotated `v0.0.2` tag, and publishes a
GitHub Release with generated release notes and the VSIX attached. No Marketplace
token or other custom secret is needed; it uses the repository's `GITHUB_TOKEN`.

The version must be greater than the current version. Releases run sequentially.
If publication fails after the tag was pushed, rerun with the same version: the
workflow builds from the existing tag and resumes the draft release. A published
release is left unchanged. If `main` advances during the checks, the atomic push
fails without updating the remote branch or creating the tag; start a new run
with the same version to test the latest `main`.

Repository rules must allow GitHub Actions to push release commits to `main` and
create `v*` tags, and allow `contents: write` for `GITHUB_TOKEN`. A rule requiring
pull requests for every change to `main` will block this workflow unless the
release bot is allowed to bypass it.

Releases distribute the development-only probe through GitHub Releases; they do
not publish to the VS Code Marketplace or enable it in a normal extension host.

## Live smoke (explicit opt-in)

Use a dedicated test account/key with an explicitly agreed **server-enforced**
wallet/quota budget (the reference run used at most 50 RUB). Never use a master
key. Keep live credentials outside the repository, settings, command arguments
and logs. Supply `VRATA_SPIKE_KEY` through the launching process environment
from a protected secret source. The extension reads it once at activation;
restart the development host to change it. Environment handling is only for
this developer probe; it is not the MVP credential-storage design.

Set `VRATA_SPIKE_ENDPOINT` to the full endpoint. Reference staging:
`https://llm-billing-staging.ai.vladimirlebe.dev/v1/chat/completions`.
Canonical production address is `https://api.vrata.tg/v1/chat/completions`;
production was not exercised by this probe.

1. Copy `fixture/` to a disposable folder. Verify `node sum.test.js` fails.
2. Launch stable Code with fresh `--user-data-dir`, `--extensions-dir`,
   `--extensionDevelopmentPath` and the disposable folder as the workspace.
   Do not pass `--extensionTestsPath` for live work.
3. Grant trust only to that fixture through Workspace Trust. Do not disable
   trust or override corporate BYOK policies. Stay signed out of GitHub.
4. Set `chat.byokUtilityModelDefault` to `mainAgent` in **user** settings.
   Utility requests (e.g. titles) can also incur gateway charges. The selected
   agent model does not normally control these unless configured.
5. In local Agent mode choose `gpt-5.6-terra (spike)` from **Vrata Spike**.
   Ask: “Read sum.js and sum.test.js. Fix sum.js, run node sum.test.js in the
   terminal, and report the result. Do not change tests.” Approve that terminal
   command through VS Code. Check the actual file, unchanged test and all three
   assertions independently. Keep the edit.
6. Restore the broken fixture and repeat in a **new chat** with
   `claude-sonnet-5 (spike)`. Do not reuse the previous conversation's results.
7. Ask for a long text response, press Stop while text is streaming, and inspect
   sanitized request/accounting evidence: one cancelled request, no automatic
   retry, no lingering hold. Explicitly continue in the same chat and verify a
   new successful request. Repeat for each family.
8. Record versions, HTTP statuses, stream completion, tool calls/results,
   independent test results, accounting totals and every failed attempt. Revoke
   the disposable key and verify all reservations settle.

Before the provider run, test the same fixture through the built-in **Custom
Endpoint** in a separate clean profile. Use Chat Completions for OpenAI. In
1.138.0 that provider adds `n: 1`, which the current gateway's Chat → Messages
converter rejects; use its Messages API option for the Anthropic baseline.
Our minimal provider omits `n`, and supplies an empty object schema when a
VS Code tool has no input parameters.

The Linux/Xvfb reference host ran as root with Electron's `--no-sandbox`,
`--disable-gpu`, `--disable-dev-shm-usage` flags. These are container launch
constraints, not proposed extension APIs. Normal desktop runs should use their
usual sandbox. Windows, macOS, Remote, WSL, Web and Agent Host sessions are not
validated here.

Decision, API inventory, evidence and limitations:
[report in vrata-docs](https://github.com/v-lebedev/vrata-docs/blob/main/reports/2026-09-23/vscode-335/report.md).
