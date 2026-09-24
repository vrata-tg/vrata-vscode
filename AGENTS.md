# Vrata VS Code

## Development

Use Node.js 22 and `npm ci`. Read `package.json` for the commands and README for
host-test prerequisites. Run `npm run check` and `npm run package` before shipping.
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
- Keep runtime dependencies empty. Exclude development files from the VSIX.

## Delivery

Review the whole PR diff and run the relevant host compatibility checks when
changing activation, the manifest, packaging or SecretStorage. Report which
checks actually ran and any platform limitations. Keep user edits intact and
update the existing PR when requested; do not merge or publish to Marketplace
without an explicit request.

Save and commit investigation notes, reports and durable findings in
https://github.com/v-lebedev/vrata-docs, following that repository's AGENTS.md.
Keep operational development instructions here.
