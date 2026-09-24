---
name: vrata-vscode-dev
description: Implement, debug and verify changes in the Vrata VS Code extension. Use for native onboarding, SecretStorage, model discovery, gateway transport, diagnostics, packaging or CI changes in vrata-vscode.
---

# Develop Vrata VS Code

1. Read root `AGENTS.md`, `package.json` and the relevant README section. Check
   `git status` and the current PR branch; preserve existing changes.
2. Locate the smallest boundary involved:
   - `src/extension.ts`: activation, native UI commands and provider adapters.
   - `src/credentials.ts`: storage queue, validation attempts, session and catalog.
   - `src/gateway.ts`: fixed-origin read-only key validation.
   - `src/transport.ts`: streaming text and tool calls, cancellation and cleanup.
   - `src/diagnostics.ts`: original error formatting and exact-key redaction.
3. For a defect, reproduce it with the existing tests or add a focused regression.
   Run `npm run build` before a direct `node --test test/<name>.test.cjs` invocation:
   tests load `dist/`, not TypeScript source. Use loopback servers and synthetic keys.
4. Implement the change at that boundary. Preserve the root invariants. Keep
   security checks explicit; avoid speculative abstractions for future issues.
5. Run `npm run format`, inspect the diff, then `npm run check` and
   `npm run package`. Use `npx --no-install vsce ls --no-dependencies` to inspect
   package contents when packaging rules or development files change.
6. For activation, storage or compatibility changes, follow README's Linux host
   test procedure. Use a fresh result directory and the built VSIX. Never use
   `--extensionTestsPath` to claim restart persistence: it uses in-memory storage.
   CI exercises the versions listed in `.github/workflows/ci.yml`.
7. Summarize the behavior, evidence and remaining limits. Commit/push only within
   the user's requested scope. Put investigation reports in `vrata-docs`.
