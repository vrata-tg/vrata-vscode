# Vrata VS Code

## Development

Before development, fetch `origin`, update the working branch from its upstream,
and synchronize it with current `origin/main` as described in the development
skill's working-tree checklist. Start new branches from current `origin/main`.
Preserve local edits; do not use a reset or force push to synchronize.

Use Node.js 22 and `npm ci`. Read `package.json` for the commands and
[.agents/DEVELOPMENT.md](.agents/DEVELOPMENT.md) for host-test prerequisites. Run `npm run check` and `npm run package` before shipping.
Use F5 to launch the extension with the fixture workspace and TypeScript watch.

The development workflow is adapted from the main `ai-billing-gateway`
repository. Read [.agents/skills/vrata-vscode-dev/SKILL.md](.agents/skills/vrata-vscode-dev/SKILL.md)
for implementation, planning, review, simplification and delivery. It owns the
sequence; this file owns extension invariants. Read only the selected stage's
package. [.agents/README.md](.agents/README.md) lists the vendored packages and
maps their tools to the available client; [.agents/PROMPTS.md](.agents/PROMPTS.md)
provides direct entry prompts.

## Boundaries

- Keep stable VS Code APIs compatible with `engines.vscode`; pin `@types/vscode`
  to the minimum supported version. No proposed APIs or replacement chat UI.
- Store API keys only in SecretStorage. Keep the gateway origin fixed. Validation
  uses read-only GET; do not add retries or redirects to paid requests.
- Preserve session cancellation, serialized storage mutations and rejection of
  late results. Failed replacement must preserve the previous connection.
- Log original exceptions once at entry points and redact all keys known to the
  operation. Keep server details and credentials out of notifications.
- Discovery stays silent in the background. Do not advertise guessed model limits
  or capabilities while the metadata contract is unfinished.
- Use synthetic credentials and loopback HTTP in tests. Keep real credentials,
  generated `dist/`, dependencies and VSIX files out of git.
- Use the pinned official OpenAI and Anthropic SDKs for model transport. Disable
  SDK retries, redirects and logging. Bundle runtime dependencies and their license
  notices into the VSIX; exclude development files.

## Versioning

- Treat `package.json` `version` as the single source of truth for the extension
  version. Keep the root and `packages[""].version` values in `package-lock.json`,
  the current VSIX filename in `README.md`, and the release tag `v<version>` in
  sync. Never reuse an existing version or release tag.
- Derive the HTTP identity from that same value: `src/user-agent.ts` must build
  exactly `vrata-vscode/<package.json.version>`. All gateway and model transport
  requests must use the shared `USER_AGENT`; do not hardcode a version or fall
  back to the runtime default `node` User-Agent.
- A release version bump must update `package.json`, `package-lock.json` and the
  current VSIX reference in `README.md`, then run `npm run check` and
  `npm run package`. Tests must derive the expected User-Agent from
  `package.json` and verify it on every outbound transport family.
- Publish the commit, tag and VSIX with the same version. Verify that the remote
  branch and tag resolve to the release commit and that the release asset name
  is `vrata-ai-<version>.vsix`.

## Delivery

Always finish implementation tasks by committing, pushing a feature branch and
opening or updating its pull request against `main`, without asking for another
confirmation. Do not stop at local changes. Include the PR URL and verification
results in the final response. Never push agent changes directly to `main`.

Review the whole PR diff and run the relevant host compatibility checks when
changing activation, the manifest, packaging or SecretStorage. Report which
checks actually ran and any platform limitations. Keep user edits intact and
update the existing PR when requested; do not merge or publish to Marketplace
without an explicit request.

Save and commit investigation notes, reports and durable findings in
https://github.com/v-lebedev/vrata-docs, following that repository's AGENTS.md.
Keep operational development instructions here.
